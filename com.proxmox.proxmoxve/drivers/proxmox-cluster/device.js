'use strict';

const Homey = require('homey');
const fetch = require('node-fetch'); // Ensure node-fetch@2 is installed
const https = require('https');

// Represents the paired Proxmox Cluster connection device
module.exports = class ProxmoxClusterDevice extends Homey.Device {
  updateIntervalId = null; // Stores the ID for the polling timer for this instance

  // === LIFECYCLE METHODS ===

  async onInit() {
    this.log(`Initializing: ${this.getName()} (Homey ID: ${this.getData().id})`);
    try {
      await this.updateStatusAndConnection();
      this.startPolling(); // Start polling, it will manage connection state
    } catch (error) {
      this.error(`Initialization Error for [${this.getName()}]:`, error);
      await this.setUnavailable(error.message || 'Initialization failed').catch(this.error);
      // Ensure capabilities reflect failed state on init error
      Promise.all([
        this._updateCapability('alarm_connection_fallback', false),
        this._updateCapability('status_connected_host', this.getSetting('hostname') || 'Unknown')
      ]).catch(this.error);
    }
  }

  async onAdded() {
    this.log(`Device added: ${this.getName()}`);
    // Perform an initial status update shortly after adding
    this.homey.setTimeout(async () => {
         await this.updateStatusAndConnection().catch(this.error);
    }, 2000);
   }

  async onSettings({ newSettings, changedKeys }) {
     this.log(`Settings updated for: ${this.getName()}`);
     try {
       let connectionOK = false;
       // If primary hostname changes, reset fallback state immediately
       if (changedKeys.includes('hostname')) {
           this.log('Primary hostname changed, resetting connection state.');
           // No need to store last_successful_host anymore
           await this._updateCapability('alarm_connection_fallback', false);
           await this._updateCapability('status_connected_host', newSettings.hostname);
           connectionOK = await this.testApiConnection(newSettings); // Test only new primary
       } else {
           // For other setting changes, perform a full status update which includes connection check & fallback
           await this.updateStatusAndConnection();
           connectionOK = this.getAvailable(); // Check availability after update attempt
       }

       // Restart polling if interval changed AND connection is currently OK
       if (connectionOK && changedKeys.includes('poll_interval_cluster')) {
          this.log('Polling interval changed, restarting polling.');
          const newIntervalMinutes = parseFloat(newSettings.poll_interval_cluster);
          this.startPolling(isNaN(newIntervalMinutes) ? null : newIntervalMinutes);
       } else if (connectionOK) {
          // Ensure polling is running if connection is OK but interval didn't change
          this.startPolling();
       } else {
          this.stopPolling(); // Stop polling if connection failed
       }
     } catch (error) {
        this.error(`Error processing settings update for [${this.getName()}]:`, error);
     }
   }

   async onRenamed(name) { this.log(`Device renamed: ${this.getName()} to ${name}`); }
   async onDeleted() { this.log(`Device deleted: ${this.getName()}`); this.stopPolling(); }

  // === POLLING LOGIC ===

  startPolling(intervalMinutesSetting = null) {
    this.stopPolling();
    const pollIntervalMinutes = intervalMinutesSetting ?? parseFloat(this.getSetting('poll_interval_cluster') || '15'); // Default 15 min
    this.log(`Setting polling interval to ${pollIntervalMinutes} minutes for [${this.getName()}]`);
    if (isNaN(pollIntervalMinutes) || pollIntervalMinutes <= 0) {
      this.log(`Polling disabled for [${this.getName()}] (interval <= 0).`);
      return;
    }
    const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
    this.log(`Starting cluster status polling every ${pollIntervalMinutes} minutes for [${this.getName()}]`);
    this.updateIntervalId = setInterval(async () => {
      this.log(`Polling trigger for cluster status [${this.getName()}]`);
      // Polling trigger calls the central update function
      await this.updateStatusAndConnection().catch(error => {
          this.error(`Error during scheduled poll check for [${this.getName()}]:`, error);
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
        // Use inline translation for error
        throw new Error(JSON.stringify({ en: 'API credentials incomplete.', nl: 'API gegevens incompleet.' }));
    }
    return { hostname, username, tokenId, tokenSecret, deviceName: this.getName() };
  }

  _getFetchOptions(credentials, hostToUse, method = 'GET', timeout = 15000) {
    if (!credentials) throw new Error('Credentials object missing for fetch options.');
    const authorizationHeader = `PVEAPIToken=${credentials.username}!${credentials.tokenId}=${credentials.tokenSecret}`;
    return {
        method: method,
        headers: { 'Authorization': authorizationHeader, 'Accept': 'application/json' },
        agent: new https.Agent({ rejectUnauthorized: false }), // Allow self-signed certs
        timeout: timeout
    };
  }

  // Performs a SINGLE API call attempt to a SPECIFIC host
  async _doApiCall(hostToTry, urlPath, options = {}) {
    let initialCredentials;
    try { initialCredentials = this._getApiCredentials(); }
    catch (error) { throw error; } // Re-throw credential error

    const url = `https://${hostToTry}:8006${urlPath}`;
    const fetchOptionsConfig = this._getFetchOptions(initialCredentials, hostToTry, options.method, options.timeout);
    if (!fetchOptionsConfig) throw new Error('Could not create fetch options.'); // Internal error

    const fetchOptions = { ...fetchOptionsConfig, ...options, headers: {...fetchOptionsConfig.headers, ...options.headers} };
    fetchOptions.method = options.method || fetchOptionsConfig.method;
    if (fetchOptions.method === 'POST' && options.body) {
        fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        fetchOptions.body = options.body;
     } else { delete fetchOptions.body; }

    this.log(`API Call Attempt: ${fetchOptions.method} ${url}`);
    const response = await fetch(url, fetchOptions); // Throws on network error

    if (!response.ok) {
        let errorBody = `(Status: ${response.status} ${response.statusText})`; try { errorBody = await response.text(); } catch(e) {}
        this.error(`API Error via ${hostToTry}: ${response.status}. Body: ${errorBody.substring(0, 200)}`);
        // Throw specific error for API issues, include status
        const apiError = new Error(JSON.stringify({ en: `API Error: ${response.status}`, nl: `API Fout: ${response.status}` }));
        apiError.statusCode = response.status;
        throw apiError;
    }
    this.log(`API call successful via ${hostToTry}`);
    const text = await response.text();
    try { return JSON.parse(text); } catch(e) { return text || null; }
  }

  // Executes an API call, trying primary host first, then fallbacks if necessary
  async _executeApiCallWithFallback(urlPath, options = {}) {
      let credentials;
      try { credentials = this._getApiCredentials(); }
      catch (error) { await this.setUnavailable({ en: error.message, nl: error.message }); throw error; }

      const primaryHost = credentials.hostname;
      let lastError = null;

      // 1. Try Primary Host
      this.log(`Attempting API call via PRIMARY host: ${primaryHost}`);
      try {
          const result = await this._doApiCall(primaryHost, urlPath, options);
          // Success on primary
          await this._updateCapability('alarm_connection_fallback', false);
          await this._updateCapability('status_connected_host', primaryHost);
          if (!this.getAvailable()) await this.setAvailable();
          return result; // Return successful result
      } catch (error) {
          this.error(`Primary host attempt failed for ${urlPath}: ${error.message}`);
          lastError = error;
          const isNetworkError = error.code || error.type === 'request-timeout' || !(error.message.startsWith('API Error:'));
          if (!isNetworkError) {
              // If it's an API error (like 401), don't try fallbacks. Mark unavailable.
              this.log('API error on primary host, not attempting fallbacks.');
              await this.setUnavailable({ en: `API error on primary host: ${error.message}`, nl: `API fout op primaire host: ${error.message}` }).catch(this.error);
              await this._updateCapability('alarm_connection_fallback', false);
              await this._updateCapability('status_connected_host', primaryHost);
              throw error; // Re-throw API error
          }
          this.log('Primary host failed with network error, attempting fallbacks...');
      }

      // 2. Try Fallback IPs
      const onlineNodeIps = await this.getStoreValue('online_node_ips') || [];
      const fallbacksToTry = onlineNodeIps.filter(ip => ip !== primaryHost); // Exclude primary

      if (fallbacksToTry.length === 0) {
          this.log('No fallback IPs available.');
          const finalErrorMsg = { en: `Primary connection failed and no fallbacks available. Last error: ${lastError?.message}`, nl: `Primaire verbinding mislukt en geen fallbacks beschikbaar. Laatste fout: ${lastError?.message}` };
          await this.setUnavailable(finalErrorMsg).catch(this.error);
          await this._updateCapability('alarm_connection_fallback', false);
          await this._updateCapability('status_connected_host', primaryHost);
          throw lastError || new Error(JSON.stringify(finalErrorMsg));
      }

      for (const fallbackIp of fallbacksToTry) {
          this.log(`Attempting API call via FALLBACK IP: ${fallbackIp}`);
          try {
              const result = await this._doApiCall(fallbackIp, urlPath, options);
              // Success on fallback
              await this._updateCapability('alarm_connection_fallback', true);
              await this._updateCapability('status_connected_host', fallbackIp);
              if (!this.getAvailable()) await this.setAvailable();
              return result; // Return successful result from fallback
          } catch (error) {
              this.error(`Fallback attempt via ${fallbackIp} failed: ${error.message}`);
              lastError = error;
              const isNetworkError = error.code || error.type === 'request-timeout' || !(error.message.startsWith('API Error:'));
              if (!isNetworkError) {
                  this.log('API error on fallback host, stopping fallback attempts.');
                  break; // Stop trying fallbacks on API error
              }
              // Continue to next fallback IP if network error
          }
      }

      // If loop finishes without success
      this.log(`All fallback attempts failed. Last error: ${lastError?.message}`);
      const finalErrorMsgAll = { en: `All connection attempts failed. Last error: ${lastError?.message}`, nl: `Alle verbindingspogingen mislukt. Laatste fout: ${lastError?.message}` };
      await this.setUnavailable(finalErrorMsgAll).catch(this.error);
      await this._updateCapability('alarm_connection_fallback', false); // Reset fallback status
      await this._updateCapability('status_connected_host', primaryHost); // Show primary host
      throw lastError || new Error(JSON.stringify(finalErrorMsgAll));
  }

  // Helper to update capability value on THIS device instance
  async _updateCapability(capabilityId, value) {
     try {
         const forceUpdate = ['alarm_connection_fallback', 'status_connected_host'].includes(capabilityId);
         if (!this.hasCapability(capabilityId)) {
             this.log(`Adding capability '${capabilityId}' to [${this.getName()}]`);
             await this.addCapability(capabilityId);
             await this.setCapabilityValue(capabilityId, value);
             this.log(`Capability '${capabilityId}' initialized to ${value} for [${this.getName()}]`);
         } else if (forceUpdate || this.getCapabilityValue(capabilityId) !== value) {
              await this.setCapabilityValue(capabilityId, value);
              this.log(`Capability '${capabilityId}' updated to ${value} for [${this.getName()}]` + (forceUpdate ? ' (forced)' : ''));
         }
     } catch (error) { this.error(`Error setting capability '${capabilityId}':`, error); }
  }

  // Helper function to find the current node NAME for a given VM/LXC
  async _findTargetNode(vmType, vmId) {
      this.log(`Finding current node NAME for ${vmType}/${vmId} via [${this.getName()}]...`);
      try {
          // Use fallback-aware call
          const resourcesData = await this._executeApiCallWithFallback('/api2/json/cluster/resources');
          if (Array.isArray(resourcesData?.data)) {
              const resource = resourcesData.data.find(r => r.vmid === vmId && r.type === vmType);
              if (resource?.node) return resource.node;
           }
          throw new Error(`Resource ${vmType}/${vmId} not found in cluster resources.`);
      } catch (error) {
          this.error(`Could not find node for ${vmType}/${vmId}:`, error.message);
          // Re-throw a more specific error using inline translation
          throw new Error(JSON.stringify({ en: `Could not find node for ${vmType}/${vmId}.`, nl: `Kon node niet vinden voor ${vmType}/${vmId}.` }));
      }
  }

  // === DEVICE SPECIFIC METHODS ===

  // Tests API connection ONLY using primary host (or new settings host)
  async testApiConnection(settings = null) {
    const deviceName = this.getName();
    this.log(`Testing PRIMARY API connection for [${deviceName}]...`);
    let tempCredentials;
    try {
        tempCredentials = settings
            ? { hostname: settings.hostname, username: settings.username, tokenId: settings.api_token_id, tokenSecret: settings.api_token_secret }
            : this._getApiCredentials(); // Can throw if incomplete
        if (!tempCredentials || !tempCredentials.hostname /*... etc */) {
            throw new Error(JSON.stringify({ en: 'Settings incomplete.', nl: 'Instellingen incompleet.' }));
        }
    } catch (error) {
         this.log(`[Warning] API Test Failed for [${deviceName}]: ${error.message}`);
         await this.setUnavailable({ en: error.message, nl: error.message }).catch(this.error);
         await this._updateCapability('alarm_connection_fallback', false);
         await this._updateCapability('status_connected_host', this.getSetting('hostname') || 'Unknown');
         return false;
    }

    const hostToTest = tempCredentials.hostname;

    try {
        // Use the simple _doApiCall to test ONLY this specific host
        const data = await this._doApiCall(hostToTest, '/api2/json/version', { method: 'GET', timeout: 10000 });
        this.log(`Primary API Connection OK for [${deviceName}] via ${hostToTest}. Version: ${data?.data?.version}`);
        // Don't set available or update caps here, let updateStatusAndConnection handle it
        return true;
    } catch (error) {
        this.error(`Primary API Connection Test Failed for [${deviceName}] via ${hostToTest}: ${error.message}`);
        return false; // Indicate failure
    }
  }

  // Fetches cluster status and updates related capabilities for THIS device
  async updateStatusAndConnection(newSettings = null) {
    const deviceName = this.getName();
    this.log(`Updating status and connection for [${deviceName}]...`);
    try {
      // If new settings are provided, test the primary connection with them first
      if (newSettings) {
          await this.testApiConnection(newSettings);
      }

      // Always attempt to fetch cluster status using the fallback-aware helper
      const clusterStatusData = await this._executeApiCallWithFallback('/api2/json/cluster/status');

      let nodeCount = 0;
      const onlineNodeIps = [];
      if (Array.isArray(clusterStatusData?.data)) {
        clusterStatusData.data.forEach(item => {
          if (item.type === 'node' && item.online === 1) {
            nodeCount++;
            if (item.ip) onlineNodeIps.push(item.ip);
          }
        });
      }
      await this.setStoreValue('online_node_ips', onlineNodeIps);
      this.log(`Stored online node IPs: ${onlineNodeIps.join(', ')}`);

      // Fetch resources separately for VM/LXC counts using the fallback-aware helper
      const resourcesData = await this._executeApiCallWithFallback('/api2/json/cluster/resources');
      let activeVmCount = 0, activeLxcCount = 0;
       if (Array.isArray(resourcesData?.data)) {
          resourcesData.data.forEach(r => {
              if (r.type === 'qemu' && r.status === 'running') activeVmCount++;
              else if (r.type === 'lxc' && r.status === 'running') activeLxcCount++;
          });
       }

      await this._updateCapability('measure_node_count', nodeCount);
      await this._updateCapability('measure_vm_count', activeVmCount);
      await this._updateCapability('measure_lxc_count', activeLxcCount);
      // Fallback status, connected host, and availability are updated within _executeApiCallWithFallback

    } catch (error) {
      this.error(`Failed to update status and connection for [${deviceName}]:`, error.message);
      // setUnavailable and fallback status are handled within _executeApiCallWithFallback on final failure
    }
    return this.getAvailable(); // Return current availability status
  }


  // === FLOW CARD HANDLERS ===
  // These are now registered and handled by the Driver in driver.js
  // We add the methods here that the driver handlers will call

  // Autocomplete logic - called by driver's autocomplete handler
  async getAutocompleteResults(query) {
    const deviceName = this.getName();
    this.log(`Handling autocomplete request for [${deviceName}], Query: "${query}"`);
    const results = [];
    try {
      // Use this device's credentials via the fallback-aware helper
      const resourcesData = await this._executeApiCallWithFallback('/api2/json/cluster/resources');
      if (Array.isArray(resourcesData?.data)) {
        resourcesData.data
          .filter(r => (r.type === 'qemu' || r.type === 'lxc') && (query === '' || r.name?.toLowerCase().includes(query.toLowerCase()) || r.vmid?.toString().includes(query)))
          .forEach(r => {
            const resourceName = r.name || `Unnamed ${r.type}`;
            results.push({
              name: `${resourceName} (${r.type} ${r.vmid})`,
              id: { vmid: r.vmid, type: r.type, name: resourceName } // Store vmid, type, and name
            });
          });
      }
    } catch (error) { this.error(`Autocomplete API error for [${deviceName}]:`, error.message); }
    this.log(`Returning ${results.length} autocomplete results for [${deviceName}].`);
    return results;
  }

  // Executes a VM/LXC power action - called by driver's run listener handler
  async executeVmAction(args, action) {
    const deviceName = this.getName();
    const selectedTarget = args.target_vm; // Comes from the Flow card argument
    const vmId = selectedTarget?.id?.vmid;
    const vmType = selectedTarget?.id?.type;

    if (!vmId || !vmType || (vmType !== 'qemu' && vmType !== 'lxc')) {
      throw new Error(JSON.stringify({ en: 'Invalid target data selected in Flow.', nl: 'Ongeldig doel geselecteerd in Flow.' }));
    }
    const targetDesc = `${vmType}/${vmId}`;

    this.log(`Executing action '${action}' on [${deviceName}] for target: ${targetDesc}`);
    try {
      // Use 'this' context to find the node via this cluster's API (handles fallback)
      const targetNode = await this._findTargetNode(vmType, vmId);
      const apiPath = `/api2/json/nodes/${targetNode}/${vmType}/${vmId}/status/${action}`;
      const options = {
          method: 'POST',
          timeout: (action === 'shutdown' ? 30000 : 15000)
      };
      if (action === 'stop') { options.body = 'overrule-shutdown=1'; }

      this.log(`Attempting ${options.method} to ${apiPath} via [${deviceName}]`);
      // Use fallback-aware call for the action itself
      const result = await this._executeApiCallWithFallback(apiPath, options);
      this.log(`${action} command result for ${targetDesc}:`, result);
      // No return needed, error is thrown on failure

    } catch (error) {
      this.error(`Failed to ${action} ${targetDesc} via [${deviceName}]:`, error.message);
      // Re-throw user-friendly error
      throw new Error(JSON.stringify({ en: `Failed to ${action} ${targetDesc}`, nl: `${action.charAt(0).toUpperCase() + action.slice(1)}en van ${targetDesc} mislukt` }));
    }
  }

  // Checks the status for the VM/LXC Is Running Condition - called by driver's run listener handler
  async checkVmStatus(args) {
    const deviceName = this.getName();
    const selectedTarget = args.target_vm;
    const vmId = selectedTarget?.id?.vmid;
    const vmType = selectedTarget?.id?.type;

    if (!vmId || !vmType || (vmType !== 'qemu' && vmType !== 'lxc')) {
      throw new Error(JSON.stringify({ en: 'Invalid target data selected in Flow.', nl: 'Ongeldig doel geselecteerd in Flow.' }));
    }
    const targetDesc = `${vmType}/${vmId}`;

    this.log(`Checking status for target: ${targetDesc} via [${deviceName}]`);
    try {
      // Use fallback-aware call to find node and get status
      const targetNode = await this._findTargetNode(vmType, vmId);
      const apiPath = `/api2/json/nodes/${targetNode}/${vmType}/${vmId}/status/current`;
      const statusData = await this._executeApiCallWithFallback(apiPath); // Use GET (default)
      const isRunning = statusData?.data?.status === 'running';
      this.log(`Status check result for ${targetDesc}: ${isRunning}`);
      return isRunning; // Return true or false to the driver handler

    } catch (error) {
      this.error(`Status check failed for ${targetDesc} via [${deviceName}]:`, error.message);
      // Re-throw user-friendly error
      throw new Error(JSON.stringify({ en: `Failed to check status for ${targetDesc}`, nl: `Kon status niet controleren voor ${targetDesc}` }));
    }
  }

} // End of class ProxmoxClusterDevice
