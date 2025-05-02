'use strict';

const Homey = require('homey');
// fetch/https are not needed directly, API calls go via the associated cluster device

// Represents an individual paired Proxmox Node device
module.exports = class ProxmoxNodeDevice extends Homey.Device {
  updateIntervalId = null; // Stores the ID for the polling timer for this instance

  // === LIFECYCLE METHODS ===

  async onInit() {
    const nodeName = this.getName();
    const nodeId = this.getData().id;
    const serverId = this.getData().serverId; // Get serverId from data
    this.log(`Initializing node: ${nodeName} (Node ID: ${nodeId}, Cluster ID: ${serverId})`);
    try {
      if (!serverId) {
          throw new Error('serverId is missing in device data. Please re-pair the node.');
      }
      // Flow handlers are registered by the driver now
      // this.registerFlowHandlers();
      await this.updateNodeStatus(); // Initial status update
      this.startPolling(); // Start periodic updates
    } catch (error) {
      this.error(`Initialization Error for node [${nodeName}]:`, error);
      await this.setUnavailable(error.message || 'Initialization failed').catch(this.error);
    }
  }

  async onAdded() {
    const nodeName = this.getName();
    const nodeId = this.getData().id;
    const serverId = this.getData().serverId; // Get serverId from data
    this.log(`Node device added: ${nodeName} (Node ID: ${nodeId}, Cluster ID: ${serverId})`);
    // Perform an initial status update shortly after adding
    this.homey.setTimeout(async () => {
         await this.updateNodeStatus().catch(this.error);
    }, 2000);
   }

  async onSettings({ newSettings, changedKeys }) {
     this.log(`Node settings updated for: ${this.getName()}. Changed keys: ${changedKeys.join(', ')}`);
     // Restart polling if the interval setting was changed for THIS node
     if (changedKeys.includes('poll_interval_node')) {
        this.log('Node polling interval changed, restarting polling.');
        const newIntervalMinutes = parseFloat(newSettings.poll_interval_node);
        this.startPolling(isNaN(newIntervalMinutes) ? null : newIntervalMinutes);
     }
   }

   async onRenamed(name) { this.log(`Node device renamed: ${this.getName()} to ${name}`); }
   async onDeleted() { this.log(`Node device deleted: ${this.getName()}`); this.stopPolling(); }

  // === POLLING LOGIC ===

  startPolling(intervalMinutesSetting = null) {
    this.stopPolling();
    const pollIntervalMinutes = intervalMinutesSetting ?? parseFloat(this.getSetting('poll_interval_node') || '5');
    if (isNaN(pollIntervalMinutes) || pollIntervalMinutes <= 0) {
      this.log(`Node polling disabled for [${this.getName()}] (interval <= 0).`);
      return;
    }
    const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
    this.log(`Starting node status polling every ${pollIntervalMinutes} minutes for [${this.getName()}]`);
    this.updateIntervalId = setInterval(async () => {
      this.log(`Polling trigger for node [${this.getName()}]`);
      await this.updateNodeStatus().catch(error => {
          this.error(`Error during scheduled node status update for [${this.getName()}]:`, error);
      });
    }, pollIntervalMs);
  }

  stopPolling() {
    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
      this.log(`Stopped node status polling for [${this.getName()}]`);
    }
  }

  // === API HELPER (Gets Associated Cluster Device) ===

  async _getClusterDevice() {
      const serverId = this.getData()?.serverId; // Get serverId from data
      if (!serverId) {
          throw new Error('serverId not found in device data for this node.');
      }
      try {
          return await this.homey.drivers.getDriver('proxmox-cluster').getDevice({ id: serverId });
      } catch (error) {
          this.error(`Could not retrieve cluster device (ID: ${serverId}) for node [${this.getName()}]:`, error);
          throw new Error(JSON.stringify({ en: 'Associated cluster device unavailable.', nl: 'Gekoppeld cluster apparaat niet beschikbaar.' }));
      }
  }

  // === NODE SPECIFIC METHODS ===

  // Fetches current status for this specific node and updates capabilities
  async updateNodeStatus() {
    const nodeName = this.getData().id; // Node name is stored as device ID
    this.log(`Updating status for node [${nodeName}]...`);

    try {
      const clusterDevice = await this._getClusterDevice();
      const apiPath = `/api2/json/nodes/${nodeName}/status`;
      // Use the cluster device's API call method (handles fallback)
      const nodeStatusData = await clusterDevice._executeApiCallWithFallback(apiPath);

      if (nodeStatusData?.data) {
        const nodeData = nodeStatusData.data;
        // Memory %
        const memUsed = nodeData.memory?.used || 0;
        const memTotal = nodeData.memory?.total || 1;
        const memoryPerc = (memTotal > 0) ? parseFloat(((memUsed / memTotal) * 100).toFixed(1)) : 0;
        await this._updateCapability('measure_memory_usage_perc', memoryPerc);
        // CPU %
        const cpuLoad = nodeData.cpu || 0;
        const cpuPerc = parseFloat((cpuLoad * 100).toFixed(1));
        await this._updateCapability('measure_cpu_usage_perc', cpuPerc);

        if (!this.getAvailable()) await this.setAvailable();
      } else {
        this.warn(`No data received in node status response for [${nodeName}].`);
        throw new Error(JSON.stringify({ en: 'Invalid status response from node.', nl: 'Ongeldig status antwoord van node.' }));
      }
    } catch (error) {
      this.error(`Failed to update node status for [${nodeName}]:`, error.message);
      await this.setUnavailable(error.message).catch(this.error);
    }
  }

  // Helper to update capability value on THIS node device instance
  async _updateCapability(capabilityId, value) {
     try {
         if (!this.hasCapability(capabilityId)) {
             this.log(`Adding capability '${capabilityId}' to node [${this.getName()}]`);
             await this.addCapability(capabilityId);
             await this.setCapabilityValue(capabilityId, value);
         } else if (this.getCapabilityValue(capabilityId) !== value) {
              await this.setCapabilityValue(capabilityId, value);
              this.log(`Node Capability '${capabilityId}' updated to ${value} for [${this.getName()}]`);
         }
     } catch (error) {
         this.error(`Error setting node capability '${capabilityId}' for [${this.getName()}]:`, error);
     }
  }

  // === METHOD CALLED BY DRIVER'S FLOW HANDLER ===
  // Executes the power action (shutdown/stop) for this specific node
  async triggerPowerAction(action) {
      const nodeName = this.getData().id;
      this.log(`Executing power action '${action}' for node [${nodeName}]`);
      try {
          const clusterDevice = await this._getClusterDevice();
          // Use the specific API endpoint for node actions
          const apiPath = `/api2/json/nodes/${nodeName}/status`;
          const options = {
              method: 'POST',
              body: `command=${action}`,
              timeout: (action === 'shutdown' ? 60000 : 15000)
          };

          this.log(`Attempting ${options.method} to ${apiPath} via cluster [${clusterDevice.getName()}]`);
          // Use the cluster device's API call method (handles fallback)
          const result = await clusterDevice._executeApiCallWithFallback(apiPath, options);
          this.log(`${action} node command result for [${nodeName}]:`, result);
          // No return needed, error is thrown on failure

      } catch (error) {
          this.error(`Failed to ${action} node [${nodeName}]:`, error.message);
          // Re-throw user-friendly error
          throw new Error(JSON.stringify({
              en: `Failed to ${action} node ${nodeName}`,
              nl: `Kon node ${nodeName} niet ${action === 'shutdown' ? 'uitschakelen' : 'stoppen'}`
          }));
      }
  }

} // End of class ProxmoxNodeDevice
