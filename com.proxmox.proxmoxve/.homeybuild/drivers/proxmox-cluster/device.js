'use strict';

const Homey = require('homey');
const ProxmoxClient = require('../../lib/ProxmoxClient');
const HostManager = require('../../lib/HostManager');

// Represents the paired Proxmox Cluster connection device
module.exports = class ProxmoxClusterDevice extends Homey.Device {

  // === LIFECYCLE METHODS ===

  async onInit() {
    this.log(`Initializing Cluster Device: ${this.getName()}`);

    this.requestCache = new Map();
    this.pendingRequests = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes cache TTL
    this.activeTimeouts = new Set();

    // Initialize Helpers
    this.hostManager = new HostManager(this.log.bind(this));
    this.proxmoxClient = new ProxmoxClient(this._getCredentialsFromSettings(), { timeout: 15000 });

    try {
      this._initializeHostManager();

      // Test connection
      if (this.hasSettings()) {
        this.log('Testing connection...');
        const connectionTest = await this.testApiConnection();
        this.log(`Connection test result: ${connectionTest}`);
      }

      await this.updateStatusAndConnection();
      this.startPolling();
      this.startHealthMonitoring();
    } catch (error) {
      this.error(`Initialization Error:`, error);
      await this.setUnavailable(error.message || 'Initialization failed').catch(this.error);
    }
  }

  hasSettings() {
    const s = this.getSettings();
    return s.hostname && s.username && s.api_token_id && s.api_token_secret;
  }

  _getCredentialsFromSettings(settings = null) {
    const s = settings || this.getSettings();
    return {
      hostname: s.hostname,
      username: s.username,
      tokenId: s.api_token_id,
      tokenSecret: s.api_token_secret,
      allow_self_signed_certs: s.allow_self_signed_certs || false
    };
  }

  async onAdded() {
    this.log(`Device added: ${this.getName()}`);
    this._createManagedTimeout(() => this.updateStatusAndConnection().catch(this.error), 2000);
  }

  async onSettings({ newSettings, changedKeys }) {
    this.log(`Settings updated.`);
    try {
      // Update Client Credentials
      this.proxmoxClient.updateCredentials(this._getCredentialsFromSettings(newSettings));

      let connectionOK = false;

      if (changedKeys.includes('hostname')) {
        this.log('Primary hostname changed.');
        // Reset Host Manager Primary
        this.hostManager.setPrimaryHost(newSettings.hostname);

        await this._updateCapability('alarm_connection_fallback', false);
        await this._updateCapability('status_connected_host', newSettings.hostname);

        connectionOK = await this.testApiConnection(newSettings);
      } else {
        await this.updateStatusAndConnection();
        connectionOK = this.getAvailable();
      }

      if (changedKeys.includes('poll_interval_cluster')) {
        this.startPolling(newSettings.poll_interval_cluster);
      }
    } catch (error) {
      this.error(`Error processing settings update:`, error);
    }
  }

  async onRenamed(name) { this.log(`Renamed to ${name}`); }

  async onDeleted() {
    this.log(`Deleted: ${this.getName()}`);
    this.stopPolling();
    this.stopHealthMonitoring();
    this._clearAllTimeouts();
  }

  // === POLLING LOGIC ===

  startPolling(interval = null) {
    this.stopPolling();
    const val = interval !== null ? interval : this.getSetting('poll_interval_cluster');
    const pollIntervalMinutes = parseFloat(val || '5');
    if (isNaN(pollIntervalMinutes) || pollIntervalMinutes <= 0) return;

    const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
    const jitter = Math.random() * 30000;

    this.updateIntervalId = this.homey.setInterval(() => {
      this.updateStatusAndConnection().catch(this.error);
    }, pollIntervalMs);

    this._createManagedTimeout(() => this.updateStatusAndConnection().catch(this.error), jitter);
  }

  stopPolling() {
    if (this.updateIntervalId) {
      this.homey.clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
    }
  }

  // === HOST MANAGEMENT ===

  _getBackupHostsFromSettings() {
    const raw = this.getSetting('backup_hosts');
    if (!raw) return [];
    return raw.split(',').map(s => s.trim()).filter(s => s.length > 0 && s !== this.hostManager.primaryHost);
  }

  // === HOST MANAGEMENT ===

  _initializeHostManager() {
    const primaryHost = this.getSetting('hostname');
    const backupHosts = this._getBackupHostsFromSettings();
    if (primaryHost) {
      this.hostManager.initialize(primaryHost, backupHosts);
    }
  }

  startHealthMonitoring() {
    this.stopHealthMonitoring();
    // Use a conservative interval to avoid load
    const interval = 60000; // 1 minute

    this.healthCheckIntervalId = this.homey.setInterval(() => {
      this._performHealthCheck().catch(this.error);
    }, interval);
  }

  stopHealthMonitoring() {
    if (this.healthCheckIntervalId) {
      this.homey.clearInterval(this.healthCheckIntervalId);
      this.healthCheckIntervalId = null;
    }
  }

  async _performHealthCheck() {
    // 1. Check Cluster Status via Primary (or Preferred) to detect nodes
    try {
      // We use executeApiCallWithFallback to ensure we get data if primary is down but backup works
      // We do NOT use refreshCache here to avoid storming if health check is frequent, 
      // but health check is mostly about connectivity. 
      // Actually, status needs to be fresh-ish, let's skip cache or refresh?
      // Health check pings specific IPs anyway.
      const statusData = await this._executeApiCallWithFallback('/api2/json/cluster/status', { refreshCache: true });
      if (!Array.isArray(statusData?.data)) return;

      const onlineNodes = statusData.data
        .filter(n => n.type === 'node' && n.online === 1 && n.ip)
        .map(n => n.ip);

      // --- AUTO-SAVE BACKUP HOSTS ---
      // Update the list of backup hosts settings if it differs from what we found
      // ensuring we have the latest IPs for next boot if primary is down.
      const currentBackupSettings = this._getBackupHostsFromSettings();
      const newBackupHosts = onlineNodes.filter(ip => ip !== this.hostManager.primaryHost && ip !== this.getSetting('hostname'));

      // Simple equality check to avoid thrashing settings
      const sortedCurrent = [...currentBackupSettings].sort().join(',');
      const sortedNew = [...newBackupHosts].sort().join(',');

      if (sortedCurrent !== sortedNew) {
        this.log('Updating Backup Hosts settings to:', sortedNew);
        await this.setSettings({ backup_hosts: sortedNew }).catch(e => this.error('Failed to update backup_hosts', e));
        // Note: HostManager will pick this up on restart, or we can feed it live if we wanted to be fancy,
        // but health check already discovers "otherNodes" below anyway.
      }
      // -----------------------------

      // 2. Select a subset of nodes to ping to verify connectivity/latency
      // Instead of pinging ALL, ping:
      // - Primary (always)
      // - Preferred (if different)
      // - One random backup node (to keep "available hosts" fresh without storming)

      const nodesToPing = new Set([this.hostManager.primaryHost]);
      if (this.hostManager.preferredHost) nodesToPing.add(this.hostManager.preferredHost);

      // Add one random other online node
      const otherNodes = onlineNodes.filter(ip => !nodesToPing.has(ip));
      if (otherNodes.length > 0) {
        nodesToPing.add(otherNodes[Math.floor(Math.random() * otherNodes.length)]);
      }

      // Execute Pings
      for (const host of nodesToPing) {
        const start = Date.now();
        try {
          // Use Client directly to target specific host
          await this.proxmoxClient.request(host, '/api2/json/version', { timeout: 5000 });
          this.hostManager.updateHostStatus(host, true, Date.now() - start);
        } catch (err) {
          this.hostManager.updateHostStatus(host, false);
        }
      }

      this.hostManager.cleanup();

    } catch (error) {
      // If we can't even get cluster status, everything might be down
      this.log('Health Check: Failed to get cluster status.');
    }
  }

  // === API CALLING & FALLBACK ===

  // Public method for Driver/Node-Device to use
  async _executeApiCallWithFallback(urlPath, options = {}) {
    // 1. Cache Check (GET only)
    const isGet = (options.method || 'GET') === 'GET';
    const cacheKey = `${urlPath}:${JSON.stringify(options)}`;

    // Skip reading cache if skipCache OR refreshCache is true
    if (isGet && !options.skipCache && !options.refreshCache) {
      const cached = this._getCachedResponse(cacheKey);
      if (cached) return cached;

      if (this.pendingRequests.has(cacheKey)) {
        return this.pendingRequests.get(cacheKey);
      }
    }

    const requestPromise = (async () => {
      const hosts = this.hostManager.getOrderedHostList();
      if (hosts.length === 0) throw new Error('No available hosts.');

      let lastError = null;

      for (const host of hosts) {
        try {
          const result = await this.proxmoxClient.request(host, urlPath, options);

          // Success
          this.hostManager.updateHostStatus(host, true, 0); // Latency not measured here easily without wrapper, assume 0/fast enough or rely on health check
          await this._updateConnectionCapabilities(host, false);

          return result;
        } catch (error) {
          this.error(`API Fail via ${host}: ${error.message}`);
          this.hostManager.updateHostStatus(host, false);
          lastError = error;

          // If API error (401/403/404), do not failover - it's a logic/auth error
          if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
            throw error;
          }
          // Else (Network/5xx), try next host
        }
      }

      // If we are already in fallback mode, avoid flapping the UI with "Unavailable"
      // unless it's a critical logic error. Stale data is better than a flashing error.
      if (!this.getCapabilityValue('alarm_connection_fallback')) {
        await this.setUnavailable(`Connection failed. Last: ${lastError?.message}`).catch(this.error);
      } else {
        this.error(`Connection failed (Fallback active). Keeping device available. Last mismatch: ${lastError?.message}`);
      }

      throw lastError || new Error('Connection failed');
    })();

    if (isGet && !options.skipCache) {
      this.pendingRequests.set(cacheKey, requestPromise);
      try {
        const res = await requestPromise;
        this._setCachedResponse(cacheKey, res);
        return res;
      } finally {
        this.pendingRequests.delete(cacheKey);
      }
    }

    return requestPromise;
  }

  async testApiConnection(settings = null) {
    try {
      // If settings provided, create temporary client
      const client = settings
        ? new ProxmoxClient(this._getCredentialsFromSettings(settings), { timeout: 10000 })
        : this.proxmoxClient;

      await client.request(null, '/api2/json/version');
      return true;
    } catch (e) {
      this.error('Connection Test Failed:', e);
      return false;
    }
  }

  async updateStatusAndConnection() {
    try {
      // Use refreshCache: true to ensure we fetch fresh data on every poll,
      // but also update the cache so other consumers get semi-fresh data.
      const statusData = await this._executeApiCallWithFallback('/api2/json/cluster/status', { refreshCache: true });
      const resourcesData = await this._executeApiCallWithFallback('/api2/json/cluster/resources', { refreshCache: true });

      // Process Node Count
      let nodeCount = 0;
      if (Array.isArray(statusData?.data)) {
        nodeCount = statusData.data.filter(n => n.type === 'node' && n.online === 1).length;
      }

      // Process VM/LXC Count
      let vmCount = 0;
      let lxcCount = 0;
      if (Array.isArray(resourcesData?.data)) {
        resourcesData.data.forEach(r => {
          if (r.status === 'running') {
            if (r.type === 'qemu') vmCount++;
            if (r.type === 'lxc') lxcCount++;
          }
        });
      }

      // Update Capabilities
      await this._updateCapability('measure_node_count', nodeCount);
      await this._updateCapability('measure_vm_count', vmCount);
      await this._updateCapability('measure_lxc_count', lxcCount);

      if (!this.getAvailable()) await this.setAvailable();

    } catch (error) {
      this.error('Update Status Failed:', error);
    }
  }

  async _updateConnectionCapabilities(currentHost, isFallback) {
    const isUsingFallback = (currentHost !== this.hostManager.primaryHost);
    await this._updateCapability('alarm_connection_fallback', isUsingFallback);
    await this._updateCapability('status_connected_host', currentHost);
  }

  // === HELPER METHODS ===

  async _updateCapability(id, value) {
    if (!this.hasCapability(id)) return;
    if (this.getCapabilityValue(id) !== value) {
      await this.setCapabilityValue(id, value).catch(e => this.error(`Failed to set ${id}:`, e));
    }
  }

  _getCachedResponse(key) {
    const entry = this.requestCache.get(key);
    if (entry && Date.now() - entry.ts < this.cacheTimeout) return entry.data;
    return null;
  }

  _setCachedResponse(key, data) {
    this.requestCache.set(key, { data, ts: Date.now() });
  }

  _createManagedTimeout(fn, ms) {
    const id = this.homey.setTimeout(async () => {
      this.activeTimeouts.delete(id);
      await fn();
    }, ms);
    this.activeTimeouts.add(id);
  }

  _clearAllTimeouts() {
    this.activeTimeouts.forEach(id => this.homey.clearTimeout(id));
    this.activeTimeouts.clear();
  }

  // === DRIVER API METHODS (Called by Driver.js) ===

  async getAutocompleteResults(query) {
    const results = [];
    try {
      const res = await this._executeApiCallWithFallback('/api2/json/cluster/resources');
      if (Array.isArray(res?.data)) {
        const q = query.toLowerCase();
        res.data
          .filter(r => (r.type === 'qemu' || r.type === 'lxc') &&
            (r.vmid.toString().includes(q) || (r.name && r.name.toLowerCase().includes(q))))
          .forEach(r => {
            results.push({
              name: `${r.name || 'Unknown'} (${r.type} ${r.vmid})`,
              id: { vmid: r.vmid, type: r.type, name: r.name }
            });
          });
      }
    } catch (e) { this.error('Autocomplete failed', e); }
    return results;
  }

  async executeVmAction(args, action) {
    const { vmid, type } = args.target_vm.id;
    if (!vmid || !type) throw new Error('Invalid Target');

    this.log(`Action ${action} on ${type} ${vmid}`);

    // Find Node for VM
    const node = await this._findNodeForVm(vmid, type);
    const endpoint = `/api2/json/nodes/${node}/${type}/${vmid}/status/${action}`;

    // Custom body for stop (force)
    const body = (action === 'stop') ? 'overrule-shutdown=1' : null; // Client handles string/object conversion

    await this._executeApiCallWithFallback(endpoint, { method: 'POST', body });
  }

  async checkVmStatus(args) {
    const { vmid, type } = args.target_vm.id;
    if (!vmid || !type) throw new Error('Invalid Target');

    const node = await this._findNodeForVm(vmid, type);
    const endpoint = `/api2/json/nodes/${node}/${type}/${vmid}/status/current`;

    const res = await this._executeApiCallWithFallback(endpoint, { skipCache: true });
    return res?.data?.status === 'running';
  }

  async _findNodeForVm(vmid, type) {
    // Also skip cache here to handle migrations correctly? 
    // Resources call is heavy, but if we don't, checkVmStatus might fail if node migrated recently.
    // Given flow runs are user-triggered, safety first.
    const res = await this._executeApiCallWithFallback('/api2/json/cluster/resources', { skipCache: true });
    const target = res?.data?.find(r => r.vmid == vmid && r.type == type); // loose equality just in case of string/int mismatch
    if (!target || !target.node) throw new Error(`VM ${vmid} not found`);
    return target.node;
  }

}
