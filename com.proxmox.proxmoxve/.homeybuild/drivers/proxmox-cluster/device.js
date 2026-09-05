'use strict';

const Homey = require('homey');
const ProxmoxClient = require('../../lib/ProxmoxClient');
const HostManager = require('../../lib/HostManager');

// Represents the paired Proxmox Cluster connection device
module.exports = class ProxmoxClusterDevice extends Homey.Device {

  // === LIFECYCLE METHODS ===

  async onInit() {
    this.log(this.homey.__('driver.initializing', { s: this.getName() }));

    this.requestCache = new Map();
    this.pendingRequests = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes cache TTL
    this.activeTimeouts = new Set();
    this._vmStateCache = new Map(); // `${type}-${vmid}` => last known isRunning, for start/stop trigger edges
    this._vmNodeCache = new Map(); // `${type}-${vmid}` => { node, ts }, short TTL to coalesce action bursts
    this._vmNodeCacheTtl = 15000;
    this._triggerCards = new Map();

    // Initialize Helpers
    this.hostManager = new HostManager(this.log.bind(this));
    this.proxmoxClient = new ProxmoxClient(this._getCredentialsFromSettings(), { timeout: 15000 });

    try {
      this._initializeHostManager();

      // Test connection
      if (this.hasSettings()) {
        this.log(this.homey.__('driver.testing_connection'));
        const connectionTest = await this.testApiConnection();
        this.log(this.homey.__('driver.connection_test_result', { s: connectionTest }));
      }

      await this.updateStatusAndConnection();
      this.startPolling();
      this.startHealthMonitoring();
    } catch (error) {
      this.error(this.homey.__('driver.initialization_error'), error);
      await this.setUnavailable(error.message || this.homey.__('error.initialization_failed')).catch(this.error);
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
      port: Number(s.port) || 8006,
      username: s.username,
      tokenId: s.api_token_id,
      tokenSecret: s.api_token_secret,
      allow_self_signed_certs: s.allow_self_signed_certs || false,
    };
  }

  async onAdded() {
    this.log(`Device added: ${this.getName()}`);
    this._createManagedTimeout(() => this.updateStatusAndConnection().catch(this.error), 2000);
  }

  async onSettings({ newSettings, changedKeys }) {
    this.log(this.homey.__('driver.settings_updated'));

    // Update Client Credentials
    this.proxmoxClient.updateCredentials(this._getCredentialsFromSettings(newSettings));

    if (changedKeys.includes('hostname')) {
      this.log(this.homey.__('driver.primary_hostname_changed'));
      // Reset Host Manager Primary
      this.hostManager.setPrimaryHost(newSettings.hostname);

      await this._updateCapability('alarm_connection_fallback', false);
      await this._updateCapability('status_connected_host', newSettings.hostname);

      const connectionOK = await this.testApiConnection(newSettings);
      if (!connectionOK) {
        // Throwing here rejects the settings save and shows the message in the Homey UI,
        // instead of silently accepting a hostname that can't actually be reached.
        throw new Error(this.homey.__('driver.settings_connection_failed'));
      }
    } else {
      await this.updateStatusAndConnection().catch(this.error);
    }

    if (changedKeys.includes('poll_interval_cluster')) {
      this.startPolling(newSettings.poll_interval_cluster);
    }
  }

  async onRenamed(name) {
    this.log(this.homey.__('driver.renamed', { s: name }));
  }

  async onDeleted() {
    this.log(this.homey.__('driver.deleted', { s: this.getName() }));
    this.stopPolling();
    this.stopHealthMonitoring();
    this._clearAllTimeouts();
  }

  // === POLLING LOGIC ===

  startPolling(interval = null) {
    this.stopPolling();
    const val = interval !== null ? interval : this.getSetting('poll_interval_cluster');
    // Ensure 0 is handled correctly
    const effectiveVal = (val !== null && val !== undefined && val !== '') ? val : '5';

    const pollIntervalMinutes = parseFloat(effectiveVal);
    if (Number.isNaN(pollIntervalMinutes) || pollIntervalMinutes <= 0) return;

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
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0 && s !== this.hostManager.primaryHost);
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
        .filter((n) => n.type === 'node' && n.online === 1 && n.ip)
        .map((n) => n.ip);

      // --- AUTO-SAVE BACKUP HOSTS ---
      // Update the list of backup hosts settings if it differs from what we found
      // ensuring we have the latest IPs for next boot if primary is down.
      const currentBackupSettings = this._getBackupHostsFromSettings();
      const newBackupHosts = onlineNodes.filter((ip) => ip !== this.hostManager.primaryHost && ip !== this.getSetting('hostname'));

      // Simple equality check to avoid thrashing settings
      const sortedCurrent = [...currentBackupSettings].sort().join(',');
      const sortedNew = [...newBackupHosts].sort().join(',');

      if (sortedCurrent !== sortedNew) {
        this.log(this.homey.__('driver.updating_backup_hosts', { s: sortedNew }));
        await this.setSettings({ backup_hosts: sortedNew }).catch((e) => this.error(this.homey.__('driver.failed_update_backup_hosts'), e));
      }
      // Feed newly discovered hosts into the live HostManager immediately, so failover
      // doesn't have to wait for a device restart to pick them up from settings.
      for (const ip of newBackupHosts) this.hostManager.registerHost(ip);
      // -----------------------------

      // 2. Select a subset of nodes to ping to verify connectivity/latency
      // Instead of pinging ALL, ping:
      // - Primary (always)
      // - Preferred (if different)
      // - One random backup node (to keep "available hosts" fresh without storming)

      const nodesToPing = new Set([this.hostManager.primaryHost]);
      if (this.hostManager.preferredHost) nodesToPing.add(this.hostManager.preferredHost);

      // Add one random other online node
      const otherNodes = onlineNodes.filter((ip) => !nodesToPing.has(ip));
      if (otherNodes.length > 0) {
        nodesToPing.add(otherNodes[Math.floor(Math.random() * otherNodes.length)]);
      }

      // Execute Pings (in parallel - sequential awaits would let unreachable hosts stack up their timeouts)
      await Promise.all(Array.from(nodesToPing).map(async (host) => {
        const start = Date.now();
        try {
          // Use Client directly to target specific host
          await this.proxmoxClient.request(host, '/api2/json/version', { timeout: 5000 });
          this.hostManager.updateHostStatus(host, true, Date.now() - start);
        } catch (err) {
          this.hostManager.updateHostStatus(host, false);
        }
      }));

      this.hostManager.cleanup();

    } catch (error) {
      // If we can't even get cluster status, everything might be down
      this.log(this.homey.__('driver.health_check_failed'));
    }
  }

  // === API CALLING & FALLBACK ===

  // Public method for Driver/Node-Device to use
  async _executeApiCallWithFallback(urlPath, options = {}) {
    // 1. Cache Check (GET only)
    const isGet = (options.method || 'GET') === 'GET';
    const cacheKey = `${urlPath}:${JSON.stringify(options)}`;

    // Skip reading the TTL cache if skipCache OR refreshCache is true, but still join an
    // already in-flight request for the same key - concurrent refreshCache callers (e.g.
    // several node devices polling cluster/resources around the same time) should share
    // one request rather than each firing their own.
    if (isGet && !options.skipCache) {
      if (!options.refreshCache) {
        const cached = this._getCachedResponse(cacheKey);
        if (cached) return cached;
      }

      if (this.pendingRequests.has(cacheKey)) {
        return this.pendingRequests.get(cacheKey);
      }
    }

    const requestPromise = (async () => {
      // Guard against race condition where NodeDevice calls this before ClusterDevice.onInit() completes
      if (!this.hostManager) throw new Error('Cluster device not fully initialized.');

      const hosts = this.hostManager.getOrderedHostList();
      if (hosts.length === 0) throw new Error('No available hosts.');

      let lastError = null;
      const startTime = Date.now();
      const deadline = options.timeout ? (startTime + options.timeout) : null;

      for (const host of hosts) {
        // Enforce total deadline
        let currentTimeout = options.timeout;

        if (deadline) {
          const remaining = deadline - Date.now();
          if (remaining <= 50) { // Safety margin
            // Deadline exceeded before we could try this host
            break;
          }
          currentTimeout = remaining;
        }

        try {
          // Clone options to avoid mutating original, override timeout
          const reqOptions = { ...options, timeout: currentTimeout };
          const result = await this.proxmoxClient.request(host, urlPath, reqOptions);

          // Success
          this.hostManager.updateHostStatus(host, true, 0);
          await this._updateConnectionCapabilities(host, false);

          return result;
        } catch (error) {
          this.error(this.homey.__('driver.api_fail_via', { s: host, s2: error.message }));
          this.hostManager.updateHostStatus(host, false);
          lastError = error;

          // If API error (401/403/404), do not failover - it's a logic/auth error
          if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
            throw error;
          }
          // Else (Network/5xx/Timeout), try next host
        }
      }

      // If we are already in fallback mode, avoid flapping the UI with "Unavailable"
      // unless it's a critical logic error. Stale data is better than a flashing error.
      if (!this.getCapabilityValue('alarm_connection_fallback')) {
        const msg = lastError ? lastError.message : 'Connection failed (Timeout)';
        await this.setUnavailable(this.homey.__('driver.connection_failed_fallback', { s: msg })).catch(this.error);
      } else {
        this.error(this.homey.__('driver.connection_failed_fallback_active', { s: lastError?.message }));
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
      this.error(this.homey.__('driver.connection_test_failed_ex'), e);
      return false;
    }
  }

  async updateStatusAndConnection() {
    try {
      // Use refreshCache: true to ensure we fetch fresh data on every poll,
      // but also update the cache so other consumers get semi-fresh data.
      // Fetched in parallel - these are two independent endpoints.
      const [statusData, resourcesData] = await Promise.all([
        this._executeApiCallWithFallback('/api2/json/cluster/status', { refreshCache: true }),
        this._executeApiCallWithFallback('/api2/json/cluster/resources', { refreshCache: true }),
      ]);

      // Process Node Count + Quorum
      let nodeCount = 0;
      let quorate = null;
      if (Array.isArray(statusData?.data)) {
        nodeCount = statusData.data.filter((n) => n.type === 'node' && n.online === 1).length;
        const clusterInfo = statusData.data.find((n) => n.type === 'cluster');
        if (clusterInfo) quorate = !!clusterInfo.quorate;
      }

      // Process VM/LXC Count + per-VM start/stop trigger detection
      let vmCount = 0;
      let lxcCount = 0;
      if (Array.isArray(resourcesData?.data)) {
        const resources = resourcesData.data.filter((r) => r.type === 'qemu' || r.type === 'lxc');
        for (const r of resources) {
          const isRunning = r.status === 'running';
          if (isRunning) {
            if (r.type === 'qemu') vmCount++;
            if (r.type === 'lxc') lxcCount++;
          }
          this._detectVmStateChange(r, isRunning);
        }
      }

      // Update Capabilities
      await this._updateCapability('measure_node_count', nodeCount);
      await this._updateCapability('measure_vm_count', vmCount);
      await this._updateCapability('measure_lxc_count', lxcCount);
      if (quorate !== null) await this._updateCapabilityWithTrigger('alarm_cluster_quorum_lost', !quorate, 'cluster_quorum_lost', 'cluster_quorum_restored');

      if (!this.getAvailable()) await this.setAvailable();

    } catch (error) {
      this.error(this.homey.__('driver.update_status_failed'), error);
    }
  }

  // Fires vm_started/vm_stopped triggers on an actual running-state transition.
  // Skipped on the first observation of a given VM (no previous state to compare against),
  // so app restarts don't spam "started" for everything that's already running.
  _detectVmStateChange(resource, isRunning) {
    const key = `${resource.type}-${resource.vmid}`;
    const previous = this._vmStateCache.get(key);
    this._vmStateCache.set(key, isRunning);

    if (previous === undefined || previous === isRunning) return;

    const triggerId = isRunning ? 'vm_started' : 'vm_stopped';
    const tokens = { name: resource.name || `${resource.type} ${resource.vmid}`, vmid: resource.vmid };
    const state = { vmid: resource.vmid, type: resource.type };
    this._getTriggerCard(triggerId)?.trigger(this, tokens, state).catch(this.error);
  }

  async _updateConnectionCapabilities(currentHost, isFallback) {
    const isUsingFallback = (currentHost !== this.hostManager.primaryHost);
    await this._updateCapabilityWithTrigger('alarm_connection_fallback', isUsingFallback, 'fallback_engaged', 'fallback_restored');
    await this._updateCapability('status_connected_host', currentHost);
  }

  // === HELPER METHODS ===

  async _updateCapability(id, value) {
    if (!this.hasCapability(id)) return;
    if (this.getCapabilityValue(id) !== value) {
      await this.setCapabilityValue(id, value).catch((e) => this.error(this.homey.__('driver.failed_to_set_capability', { s: id }), e));
    }
  }

  // Like _updateCapability, but fires a device trigger card on an actual transition.
  // trueTriggerId fires when the value becomes true, falseTriggerId when it becomes false.
  // The very first observation (capability still unset) does not fire either trigger.
  async _updateCapabilityWithTrigger(id, value, trueTriggerId, falseTriggerId) {
    if (!this.hasCapability(id)) return;
    const previous = this.getCapabilityValue(id);
    if (previous === value) return;

    await this._updateCapability(id, value);
    if (previous === null) return; // first observation since init/pairing - not a real transition

    const triggerId = value ? trueTriggerId : falseTriggerId;
    this._getTriggerCard(triggerId)?.trigger(this).catch(this.error);
  }

  _getTriggerCard(id) {
    if (!this._triggerCards.has(id)) {
      try {
        this._triggerCards.set(id, this.homey.flow.getDeviceTriggerCard(id));
      } catch (e) {
        this.error(`Trigger card not found: ${id}`, e);
        this._triggerCards.set(id, null);
      }
    }
    return this._triggerCards.get(id);
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
    this.activeTimeouts.forEach((id) => this.homey.clearTimeout(id));
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
          .filter((r) => (r.type === 'qemu' || r.type === 'lxc')
            && (r.vmid.toString().includes(q) || (r.name && r.name.toLowerCase().includes(q))))
          .forEach((r) => {
            results.push({
              name: `${r.name || 'Unknown'} (${r.type} ${r.vmid})`,
              id: { vmid: r.vmid, type: r.type, name: r.name },
            });
          });
      }
    } catch (e) {
      this.error(this.homey.__('driver.autocomplete_failed'), e);
    }
    return results;
  }

  async executeVmAction(args, action) {
    const { vmid, type } = args.target_vm.id;
    if (!vmid || !type) throw new Error(this.homey.__('error.invalid_target'));
    return this._runVmAction(vmid, type, action);
  }

  // Shared by the target_vm-based flow actions and the proxmox-vm driver's onoff listener.
  async _runVmAction(vmid, type, action) {
    this.log(this.homey.__('driver.action_log', { s: action, s2: type, s3: vmid }));

    const node = await this._findNodeForVm(vmid, type);
    const endpoint = `/api2/json/nodes/${node}/${type}/${vmid}/status/${action}`;

    // Custom body for stop (force)
    const body = (action === 'stop') ? 'overrule-shutdown=1' : null; // Client handles string/object conversion

    await this._executeApiCallWithFallback(endpoint, { method: 'POST', body });
  }

  async migrateVm(args) {
    const { vmid, type } = args.target_vm.id;
    const targetNode = args.target_node?.id;
    if (!vmid || !type) throw new Error(this.homey.__('error.invalid_target'));
    if (!targetNode) throw new Error(this.homey.__('error.invalid_node_target'));

    this.log(this.homey.__('driver.migrate_log', { s: type, s2: vmid, s3: targetNode }));

    const currentNode = await this._findNodeForVm(vmid, type);
    const endpoint = `/api2/json/nodes/${currentNode}/${type}/${vmid}/migrate`;

    await this._executeApiCallWithFallback(endpoint, { method: 'POST', body: `target=${encodeURIComponent(targetNode)}` });
  }

  async checkVmStatus(args) {
    const { vmid, type } = args.target_vm.id;
    if (!vmid || !type) throw new Error(this.homey.__('error.invalid_target'));

    const node = await this._findNodeForVm(vmid, type, { skipShortCache: true });
    const endpoint = `/api2/json/nodes/${node}/${type}/${vmid}/status/current`;

    const res = await this._executeApiCallWithFallback(endpoint, { skipCache: true });
    return res?.data?.status === 'running';
  }

  async getNodeAutocompleteResults(query) {
    const results = [];
    try {
      const res = await this._executeApiCallWithFallback('/api2/json/cluster/status');
      if (Array.isArray(res?.data)) {
        const q = (query || '').toLowerCase();
        res.data
          .filter((n) => n.type === 'node' && n.online === 1 && n.name.toLowerCase().includes(q))
          .forEach((n) => results.push({ name: n.name, id: n.name }));
      }
    } catch (e) {
      this.error(this.homey.__('driver.autocomplete_failed'), e);
    }
    return results;
  }

  // === SNAPSHOTS ===

  async createSnapshot(args) {
    const { vmid, type } = args.target_vm.id;
    const snapname = args.snapshot_name;
    if (!vmid || !type) throw new Error(this.homey.__('error.invalid_target'));
    if (!snapname) throw new Error(this.homey.__('error.invalid_snapshot_name'));

    this.log(this.homey.__('driver.snapshot_log', { s: type, s2: vmid, s3: snapname }));

    const node = await this._findNodeForVm(vmid, type);
    const endpoint = `/api2/json/nodes/${node}/${type}/${vmid}/snapshot`;

    const params = new URLSearchParams({ snapname });
    if (args.description) params.set('description', args.description);

    await this._executeApiCallWithFallback(endpoint, { method: 'POST', body: params.toString() });
  }

  async rollbackSnapshot(args) {
    const { vmid, type } = args.target_vm.id;
    const snapname = args.snapshot?.id;
    if (!vmid || !type) throw new Error(this.homey.__('error.invalid_target'));
    if (!snapname) throw new Error(this.homey.__('error.invalid_snapshot_name'));

    this.log(this.homey.__('driver.rollback_log', { s: type, s2: vmid, s3: snapname }));

    const node = await this._findNodeForVm(vmid, type);
    const endpoint = `/api2/json/nodes/${node}/${type}/${vmid}/snapshot/${encodeURIComponent(snapname)}/rollback`;

    await this._executeApiCallWithFallback(endpoint, { method: 'POST' });
  }

  // Depends on target_vm already being selected in the same flow card, same pattern as
  // migrate_vm's target_node - returns no results until it is.
  async getSnapshotAutocompleteResults(query, args) {
    const results = [];
    const vmTarget = args?.target_vm?.id;
    if (!vmTarget?.vmid || !vmTarget?.type) return results;

    try {
      const node = await this._findNodeForVm(vmTarget.vmid, vmTarget.type);
      const endpoint = `/api2/json/nodes/${node}/${vmTarget.type}/${vmTarget.vmid}/snapshot`;
      const res = await this._executeApiCallWithFallback(endpoint);
      if (Array.isArray(res?.data)) {
        const q = (query || '').toLowerCase();
        res.data
          .filter((s) => s.name !== 'current' && s.name.toLowerCase().includes(q))
          .forEach((s) => results.push({ name: s.description ? `${s.name} (${s.description})` : s.name, id: s.name }));
      }
    } catch (e) {
      this.error(this.homey.__('driver.autocomplete_failed'), e);
    }
    return results;
  }

  // === BACKUP ===

  async triggerBackup(args) {
    const { vmid, type } = args.target_vm.id;
    const storage = args.target_storage?.id;
    if (!vmid || !type) throw new Error(this.homey.__('error.invalid_target'));
    if (!storage) throw new Error(this.homey.__('error.invalid_storage_target'));

    this.log(this.homey.__('driver.backup_log', { s: type, s2: vmid, s3: storage }));

    const node = await this._findNodeForVm(vmid, type);
    const endpoint = `/api2/json/nodes/${node}/vzdump`;
    const params = new URLSearchParams({ vmid: String(vmid), storage });

    // Backups can legitimately take a long time on large disks - use a generous timeout so a
    // slow backup doesn't get treated as a failed request (the task itself keeps running on
    // Proxmox regardless; this only affects how long Homey waits for this API call to return).
    await this._executeApiCallWithFallback(endpoint, { method: 'POST', body: params.toString(), timeout: 60000 });
  }

  async getStorageAutocompleteResults(query) {
    const q = (query || '').toLowerCase();
    try {
      const storages = await this._getStoragePools();
      return storages
        .filter((s) => s.id.toLowerCase().includes(q))
        .map((s) => ({ name: s.id, id: s.id }));
    } catch (e) {
      this.error(this.homey.__('driver.autocomplete_failed'), e);
      return [];
    }
  }

  // Shared by getStorageAutocompleteResults() above and the Cluster Overview widget
  // (widgets/cluster-overview/api.js), which shows per-datastore usage bars.
  async _getStoragePools() {
    const res = await this._executeApiCallWithFallback('/api2/json/cluster/resources');
    const seen = new Set();
    return (res?.data || [])
      .filter((r) => r.type === 'storage' && r.status === 'available' && r.maxdisk > 0)
      .filter((r) => (seen.has(r.storage) ? false : seen.add(r.storage)))
      .map((r) => ({
        id: r.storage,
        usedPct: Math.round((r.disk / r.maxdisk) * 1000) / 10,
        usedBytes: r.disk,
        totalBytes: r.maxdisk,
      }))
      .sort((a, b) => b.usedPct - a.usedPct);
  }

  // === OPERATIONAL STATUS WIDGETS (widgets/vm-control, widgets/node-status) ===

  // Cluster-wide live list of every VM/Container's running state, for widgets/vm-control - a
  // single cluster/resources call (already cached/shared with every other cluster-scoped read),
  // no need for the guest to be paired as its own Homey device.
  async getGuestsStatus() {
    const res = await this._executeApiCallWithFallback('/api2/json/cluster/resources');
    return (res?.data || [])
      .filter((r) => r.type === 'qemu' || r.type === 'lxc')
      .map((r) => ({
        vmid: r.vmid,
        type: r.type,
        name: r.name || `${r.type} ${r.vmid}`,
        running: r.status === 'running',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Cluster-wide live node status, for widgets/node-status - CPU/Memory come straight from
  // cluster/resources for type 'node' (one call, no per-node /status requests). Disk usage isn't
  // available there for nodes (only for storage/qemu/lxc), and isn't included here to keep this
  // to a single API call - it's already visible on the Node device's own tile.
  async getNodesStatus() {
    const res = await this._executeApiCallWithFallback('/api2/json/cluster/resources');
    const resources = res?.data || [];
    const nodes = resources.filter((r) => r.type === 'node');
    const guests = resources.filter((r) => r.type === 'qemu' || r.type === 'lxc');

    return nodes
      .map((n) => ({
        name: n.node,
        online: n.status === 'online',
        cpuPerc: n.status === 'online' ? parseFloat(((n.cpu || 0) * 100).toFixed(1)) : null,
        memPerc: n.status === 'online' && n.maxmem > 0 ? parseFloat(((n.mem / n.maxmem) * 100).toFixed(1)) : null,
        vmCount: guests.filter((g) => g.node === n.node && g.type === 'qemu' && g.status === 'running').length,
        lxcCount: guests.filter((g) => g.node === n.node && g.type === 'lxc' && g.status === 'running').length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // === BACKUP & SNAPSHOT STATUS (widgets/backup-status) ===

  // Cluster-wide summary of every VM/Container's most recent snapshot and backup task.
  // /cluster/tasks covers backup status for the whole cluster in one call; snapshots have no
  // cluster-wide list endpoint, so that part is one call per guest - each individually covered
  // by the existing 5-minute response cache in _executeApiCallWithFallback() (no refreshCache/
  // skipCache here), so repeated widget polls don't re-fetch on every 15s tick.
  async getBackupSnapshotSummary() {
    const res = await this._executeApiCallWithFallback('/api2/json/cluster/resources');
    const guests = (res?.data || []).filter((r) => r.type === 'qemu' || r.type === 'lxc');

    let tasks = [];
    try {
      const taskRes = await this._executeApiCallWithFallback('/api2/json/cluster/tasks');
      tasks = Array.isArray(taskRes?.data) ? taskRes.data : [];
    } catch (e) {
      // Backup status shows as unknown below; snapshots still work independently.
    }

    const latestBackupByVmid = new Map();
    for (const t of tasks) {
      if (t.type !== 'vzdump') continue;
      const vmid = Number(t.id);
      if (!vmid) continue;
      const existing = latestBackupByVmid.get(vmid);
      if (!existing || t.starttime > existing.starttime) latestBackupByVmid.set(vmid, t);
    }

    const summaries = await Promise.all(guests.map(async (g) => {
      let lastSnapshot = null;
      try {
        const snapEndpoint = `/api2/json/nodes/${g.node}/${g.type}/${g.vmid}/snapshot`;
        const snapRes = await this._executeApiCallWithFallback(snapEndpoint);
        const snaps = (snapRes?.data || []).filter((s) => s.name !== 'current' && s.snaptime);
        if (snaps.length) {
          snaps.sort((a, b) => b.snaptime - a.snaptime);
          lastSnapshot = { name: snaps[0].name, snaptime: snaps[0].snaptime };
        }
      } catch (e) {
        // Leave lastSnapshot null rather than failing the whole summary
      }

      const task = latestBackupByVmid.get(Number(g.vmid));
      let lastBackup = null;
      if (task) {
        let status = 'failed';
        if (!task.endtime) status = 'running';
        else if (task.status === 'OK') status = 'ok';
        lastBackup = { status, time: task.endtime || task.starttime };
      }

      return {
        name: g.name || `${g.type} ${g.vmid}`,
        vmid: g.vmid,
        type: g.type,
        lastSnapshot,
        lastBackup,
      };
    }));

    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async _findNodeForVm(vmid, type, { skipShortCache = false } = {}) {
    const key = `${type}-${vmid}`;

    // Short-TTL cache so a burst of flow actions (e.g. a scene stopping several VMs)
    // shares one resources lookup instead of each firing its own.
    if (!skipShortCache) {
      const cached = this._vmNodeCache.get(key);
      if (cached && (Date.now() - cached.ts) < this._vmNodeCacheTtl) return cached.node;
    }

    // Skip the long-TTL response cache here to handle migrations correctly - flow runs
    // are user-triggered, so safety (fresh data) beats the small extra cost.
    const res = await this._executeApiCallWithFallback('/api2/json/cluster/resources', { skipCache: true });
    // Numeric coercion, not string equality: vmid can arrive as a string (flow argument) or number (API response)
    const target = res?.data?.find((r) => Number(r.vmid) === Number(vmid) && r.type === type);
    if (!target || !target.node) throw new Error(this.homey.__('error.vm_not_found', { s: vmid }));

    this._vmNodeCache.set(key, { node: target.node, ts: Date.now() });
    return target.node;
  }

};
