'use strict';

const Homey = require('homey');
const fetch = require('node-fetch'); // Ensure node-fetch@2 is installed
const https = require('https');

// Represents the paired Proxmox Cluster connection device
module.exports = class ProxmoxClusterDevice extends Homey.Device {
  updateIntervalId = null; // Stores the ID for the polling timer

  // === LIFECYCLE METHODS ===

  async onInit() {
    this.log(`Initializing: ${this.getName()}`);
    try {
      this.registerFlowHandlers();
      const connectionOK = await this.testApiConnection();
      if (connectionOK) {
        await this.updateClusterStatus();
        this.startPolling();
      }
    } catch (error) {
      this.error(`Initialization Error for [${this.getName()}]:`, error);
    }
  }

  async onAdded() {
    this.log(`Device added: ${this.getName()}`);
    this.homey.setTimeout(async () => {
         await this.updateClusterStatus().catch(this.error);
    }, 2000);
  }

  async onSettings({ newSettings, changedKeys }) {
     this.log(`Settings updated for: ${this.getName()}`);
     try {
       const connectionOK = await this.testApiConnection(newSettings);
       if (connectionOK) {
          await this.updateClusterStatus();
          if (changedKeys.includes('poll_interval_cluster')) {
             this.log('Polling interval changed, restarting polling.');
             const newIntervalMinutes = parseFloat(newSettings.poll_interval_cluster);
             this.startPolling(isNaN(newIntervalMinutes) ? null : newIntervalMinutes);
          } else {
             this.startPolling();
          }
       } else {
          this.stopPolling();
       }
     } catch (error) {
        this.error(`Error processing settings update for [${this.getName()}]:`, error);
     }
  }

  async onRenamed(name) {
    this.log(`Device renamed: ${this.getName()} to ${name}`);
  }

  async onDeleted() {
    this.log(`Device deleted: ${this.getName()}`);
    this.stopPolling();
  }

  // === POLLING LOGIC ===

  startPolling(intervalMinutesSetting = null) {
    this.stopPolling();
    const pollIntervalMinutes = intervalMinutesSetting ?? parseFloat(this.getSetting('poll_interval_cluster') || '15');
    this.log(`Setting polling interval to ${pollIntervalMinutes} minutes.`);
    if (isNaN(pollIntervalMinutes) || pollIntervalMinutes <= 0) {
      this.log(`Polling disabled (interval <= 0).`);
      return;
    }
    const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
    this.log(`Starting cluster status polling every ${pollIntervalMinutes} minutes for [${this.getName()}]`);
    this.updateIntervalId = setInterval(async () => {
      this.log(`Polling trigger for cluster status [${this.getName()}]`);
      await this.updateClusterStatus().catch(error => {
          this.error('Error during scheduled cluster status update:', error);
      });
    }, pollIntervalMs);
  }

  stopPolling() {
    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
      this.log(`Stopped cluster status polling for [${this.getName()}]`);
    }
  }

  // === API COMMUNICATION HELPERS ===

  _getApiCredentials() {
    const hostname = this.getSetting('hostname');
    const username = this.getSetting('username');
    const tokenId = this.getSetting('api_token_id');
    const tokenSecret = this.getSetting('api_token_secret');
    if (!hostname || !username || !tokenId || !tokenSecret) {
        this.log(`[Warning] API Credentials incomplete for [${this.getName()}].`);
        return null;
    }
    return { hostname, username, tokenId, tokenSecret };
  }

  _getFetchOptions(credentials, method = 'GET', timeout = 15000) {
    if (!credentials) return null;
    const authorizationHeader = `PVEAPIToken=${credentials.username}!${credentials.tokenId}=${credentials.tokenSecret}`;
    return {
        method: method,
        headers: { 'Authorization': authorizationHeader, 'Accept': 'application/json' },
        agent: new https.Agent({ rejectUnauthorized: false }), // Allow self-signed certs
        timeout: timeout
    };
  }

  // Generic helper to perform API calls, handles POST body
  async _doApiCall(urlPath, options = {}) {
    const credentials = this._getApiCredentials();
    if (!credentials) throw new Error('API credentials unavailable.');

    const url = `https://${credentials.hostname}:8006${urlPath}`;
    const defaultOptions = this._getFetchOptions(credentials, options.method, options.timeout);
    if (!defaultOptions) throw new Error('Could not create fetch options.');

    const fetchOptions = { ...defaultOptions, ...options, headers: {...defaultOptions.headers, ...options.headers} };
    fetchOptions.method = options.method || defaultOptions.method;

    // Handle POST body (URL-encoded form data)
    if (fetchOptions.method === 'POST' && options.body) {
        fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        fetchOptions.body = options.body;
    } else {
         delete fetchOptions.body;
    }

    this.log(`API Call: ${fetchOptions.method} ${url}`);
    if (fetchOptions.body) this.log(`   Body: ${fetchOptions.body}`); // Log body if present

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
        let errorBody = `(Status: ${response.status} ${response.statusText})`;
        try { errorBody = await response.text(); } catch(e) {}
        this.error(`API Error for [${this.getName()}]: ${response.status} ${response.statusText}. Body: ${errorBody.substring(0, 200)}`);
        throw new Error(`API Error: ${response.status}`);
    }
     const text = await response.text();
     try { return JSON.parse(text); } catch(e) { return text || null; } // Return text or null if response was empty
  }

  // Helper to update capability value, adding capability if it doesn't exist
  async _updateCapability(capabilityId, value) {
     try {
         if (!this.hasCapability(capabilityId)) {
             this.log(`Adding capability '${capabilityId}' to [${this.getName()}]`);
             await this.addCapability(capabilityId);
         }
         if (this.getCapabilityValue(capabilityId) !== value) {
              await this.setCapabilityValue(capabilityId, value);
              this.log(`Capability '${capabilityId}' updated to ${value} for [${this.getName()}]`);
         }
     } catch (error) {
         this.error(`Error setting capability '${capabilityId}' for [${this.getName()}]:`, error);
     }
  }

  // Helper function to find the current node for a given VM/LXC
  async _findTargetNode(vmType, vmId) {
      this.log(`Finding current node for ${vmType}/${vmId}...`);
      const resourcesData = await this._doApiCall('/api2/json/cluster/resources');
      if (Array.isArray(resourcesData?.data)) {
          const resource = resourcesData.data.find(r => r.vmid === vmId && r.type === vmType);
          if (resource && resource.node) {
              this.log(`Found ${vmType}/${vmId} on node: ${resource.node}`);
              return resource.node;
          }
      }
      throw new Error(`Could not find current node for ${vmType}/${vmId}.`);
  }

  // === DEVICE SPECIFIC METHODS ===

  // Tests API connection by fetching the version endpoint
  async testApiConnection(settings = null) {
    const deviceName = this.getName();
    this.log(`Testing API connection for [${deviceName}]...`);
    const tempCredentials = settings
        ? { hostname: settings.hostname, username: settings.username, tokenId: settings.api_token_id, tokenSecret: settings.api_token_secret }
        : this._getApiCredentials();

    if (!tempCredentials || !tempCredentials.hostname || !tempCredentials.username || !tempCredentials.tokenId || !tempCredentials.tokenSecret) {
        this.log(`[Warning] API Test Failed for [${deviceName}]: Settings incomplete.`);
        await this.setUnavailable('Settings incomplete').catch(this.error);
        return false;
    }

    const url = `https://${tempCredentials.hostname}:8006/api2/json/version`;
    const authorizationHeader = `PVEAPIToken=${tempCredentials.username}!${tempCredentials.tokenId}=${tempCredentials.tokenSecret}`;
    const fetchOptions = {
      method: 'GET',
      headers: { 'Authorization': authorizationHeader, 'Accept': 'application/json' },
      agent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10000
    };

    try {
      const response = await fetch(url, fetchOptions);
      if (response.ok) {
        const data = await response.json();
        this.log(`API Connection OK for [${deviceName}]. Version: ${data?.data?.version}`);
        await this.setAvailable(); return true;
      } else {
        this.error(`API Connection Test Failed for [${deviceName}]: ${response.status} ${response.statusText}`);
        await this.setUnavailable(`API Error: ${response.status}`).catch(this.error); return false;
      }
    } catch (error) {
      this.error(`API Connection Test Fetch Error for [${deviceName}]: ${error.message}`);
      await this.setUnavailable(`Network Error: ${error.code || error.message}`).catch(this.error); return false;
    }
  }

  // Fetches cluster resource overview and updates related capabilities
  async updateClusterStatus() {
    const deviceName = this.getName();
    this.log(`Updating cluster status capabilities for [${deviceName}]...`);
    try {
      const resourcesData = await this._doApiCall('/api2/json/cluster/resources');

      let nodeCount = 0, activeVmCount = 0, activeLxcCount = 0;
      if (Array.isArray(resourcesData?.data)) {
        resourcesData.data.forEach(r => {
          if (r.type === 'node' && r.status === 'online') nodeCount++;
          else if (r.type === 'qemu' && r.status === 'running') activeVmCount++;
          else if (r.type === 'lxc' && r.status === 'running') activeLxcCount++;
        });
      }
      await this._updateCapability('measure_node_count', nodeCount);
      await this._updateCapability('measure_vm_count', activeVmCount);
      // Ensure 'measure_lxc_count' capability is defined and declared
      await this._updateCapability('measure_lxc_count', activeLxcCount);

      await this.setAvailable();
    } catch (error) {
      this.error(`Failed to update cluster status for [${deviceName}]:`, error.message);
      // Optionally set unavailable on status update failure
    }
  }

  // === FLOW CARD HANDLERS ===

  registerFlowHandlers() {
    this.log(`Registering device flow cards for [${this.getName()}]`);
    try {
      // Register Start VM/LXC Card
      const startVmAction = this.homey.flow.getActionCard('start_vm');
      if (startVmAction) {
        startVmAction.registerRunListener(this.onFlowActionStartVm.bind(this));
        const startArg = startVmAction.getArgument('target_vm');
        if (startArg) startArg.registerAutocompleteListener(this.onFlowArgumentAutocomplete.bind(this));
        else this.error(`Missing argument 'target_vm' on card 'start_vm'`);
        this.log(`- Listeners for start_vm registered.`);
      } else { this.error('Could not find flow action card: start_vm'); }

      // Register Stop VM/LXC Card
      const stopVmAction = this.homey.flow.getActionCard('stop_vm');
      if (stopVmAction) {
        stopVmAction.registerRunListener(this.onFlowActionStopVm.bind(this));
        const stopArg = stopVmAction.getArgument('target_vm');
        if (stopArg) stopArg.registerAutocompleteListener(this.onFlowArgumentAutocomplete.bind(this));
        else this.error(`Missing argument 'target_vm' on card 'stop_vm'`);
        this.log(`- Listeners for stop_vm registered.`);
      } else { this.error('Could not find flow action card: stop_vm'); }

      // Register Shutdown VM/LXC Card
      const shutdownVmAction = this.homey.flow.getActionCard('shutdown_vm');
      if (shutdownVmAction) {
        shutdownVmAction.registerRunListener(this.onFlowActionShutdownVm.bind(this));
        const shutdownArg = shutdownVmAction.getArgument('target_vm');
        if (shutdownArg) shutdownArg.registerAutocompleteListener(this.onFlowArgumentAutocomplete.bind(this));
        else this.error(`Missing argument 'target_vm' on card 'shutdown_vm'`);
        this.log(`- Listeners for shutdown_vm registered.`);
      } else { this.error('Could not find flow action card: shutdown_vm'); }

      // Register Is Running Condition Card
      const isRunningCondition = this.homey.flow.getConditionCard('vm_is_running');
      if (isRunningCondition) {
        isRunningCondition.registerRunListener(this.onFlowConditionIsRunning.bind(this));
        const isRunningArg = isRunningCondition.getArgument('target_vm');
        if (isRunningArg) isRunningArg.registerAutocompleteListener(this.onFlowArgumentAutocomplete.bind(this));
        else this.error(`Missing argument 'target_vm' on card 'vm_is_running'`);
        this.log(`- Listeners for vm_is_running registered.`);
      } else { this.error('Could not find flow condition card: vm_is_running'); }

    } catch (error) {
         this.error('CRITICAL ERROR during Flow registration:', error);
    }
  }

  // Autocomplete handler - fetches VMs/LXCs
  async onFlowArgumentAutocomplete(query, args) {
    this.log(`Autocomplete query: "${query}"`);
    const results = [];
    try {
      const resourcesData = await this._doApiCall('/api2/json/cluster/resources');
      if (Array.isArray(resourcesData?.data)) {
        resourcesData.data
          .filter(r => (r.type === 'qemu' || r.type === 'lxc') && (query === '' || r.name?.toLowerCase().includes(query.toLowerCase()) || r.vmid?.toString().includes(query)))
          .forEach(r => {
            const resourceName = r.name || `Unnamed ${r.type}`;
            results.push({
              name: `${resourceName} (${r.type} ${r.vmid})`, // Node name removed from display
              id: { vmid: r.vmid, type: r.type, name: resourceName } // Store vmid, type, and name
            });
          });
      }
    } catch (error) { this.error(`Autocomplete API error:`, error.message); }
    this.log(`Returning ${results.length} autocomplete results.`);
    return results;
  }

  // --- Flow Run/Condition Listeners ---

  // Generic handler for start/stop/shutdown actions
  async _handleVmAction(args, action) {
    const deviceName = this.getName();
    // Extract data from the selected autocomplete object
    const selectedTarget = args.target_vm;
    const vmId = selectedTarget?.id?.vmid;
    const vmType = selectedTarget?.id?.type;
    const storedName = selectedTarget?.id?.name;

    this.log(`Flow action ${action} triggered on [${deviceName}] for target: ${vmType}/${vmId}`);
    if (!vmId || !vmType || (vmType !== 'qemu' && vmType !== 'lxc')) {
      throw new Error('Invalid target data selected in Flow.');
    }

    try {
      const targetNode = await this._findTargetNode(vmType, vmId); // Find current node
      const apiPath = `/api2/json/nodes/${targetNode}/${vmType}/${vmId}/status/${action}`;
      const options = {
          method: 'POST',
          timeout: (action === 'shutdown' ? 30000 : 15000) // Longer timeout for shutdown
      };

      // Add body specifically for the 'stop' action to overrule shutdown
      if (action === 'stop') {
          options.body = 'overrule-shutdown=1';
      }

      this.log(`Attempting ${options.method} to ${apiPath}` + (options.body ? ` with body ${options.body}` : ''));
      const result = await this._doApiCall(apiPath, options);
      this.log(`${action} command result for ${vmType}/${vmId}:`, result);
      return true; // Success

    } catch (error) {
      this.error(`Failed to ${action} ${vmType}/${vmId} (Stored Name: ${storedName}):`, error.message);
      throw new Error(this.homey.__(`error.${action}_failed`) || `Failed to ${action} ${vmType}/${vmId}`);
    }
  }

  // Specific run listeners calling the generic handler
  async onFlowActionStartVm(args, state) { return this._handleVmAction(args, 'start'); }
  async onFlowActionStopVm(args, state) { return this._handleVmAction(args, 'stop'); }
  async onFlowActionShutdownVm(args, state) { return this._handleVmAction(args, 'shutdown'); }

  // Run listener for VM/LXC Is Running Condition
  async onFlowConditionIsRunning(args, state) {
    const selectedTarget = args.target_vm; // Object { name: "...", id: { vmid, type, name } }
    const vmId = selectedTarget?.id?.vmid;
    const vmType = selectedTarget?.id?.type;

    this.log(`Flow condition vm_is_running checking target: ${vmType}/${vmId}`);
    if (!vmId || !vmType || (vmType !== 'qemu' && vmType !== 'lxc')) {
      throw new Error('Invalid target data selected in Flow.');
    }

    try {
      const targetNode = await this._findTargetNode(vmType, vmId); // Find current node
      const apiPath = `/api2/json/nodes/${targetNode}/${vmType}/${vmId}/status/current`;
      const statusData = await this._doApiCall(apiPath); // Use GET (default)
      const isRunning = statusData?.data?.status === 'running';
      this.log(`Status check result for ${vmType}/${vmId}: ${isRunning}`);
      return isRunning; // Return true or false

    } catch (error) {
      this.error(`Status check failed for ${vmType}/${vmId}:`, error.message);
      // Throwing an error in a condition is treated as 'false' by Homey
      throw new Error(this.homey.__('error.status_check_failed') || `Failed to check status for ${vmType}/${vmId}`);
    }
  }

} // End of class ProxmoxClusterDevice
