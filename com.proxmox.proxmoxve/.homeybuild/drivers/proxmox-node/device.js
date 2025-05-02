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
    const serverId = this.getData().serverId;
    this.log(`Initializing node: ${nodeName} (Node ID: ${nodeId}, Cluster ID: ${serverId})`);
    try {
      if (!serverId) {
          throw new Error('serverId is missing in device data. Please re-pair the node.');
      }
      // Flow handlers are registered by the driver
      await this.updateNodeStatus(); // Initial status update (sets availability and alarm status)
      this.startPolling(); // Start periodic updates
    } catch (error) {
      this.error(`Initialization Error for node [${nodeName}]:`, error);
      // Set initial state to offline (alarm on) but keep available if possible
      await this._updateCapability('alarm_node_status', true).catch(this.error); // Set alarm ON
      // Don't set unavailable on init error unless absolutely necessary
      // await this.setUnavailable(error.message || 'Initialization failed').catch(this.error);
    }
  }

  async onAdded() {
    const nodeName = this.getName();
    const nodeId = this.getData().id;
    const serverId = this.getData().serverId;
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
    const pollIntervalMinutes = intervalMinutesSetting ?? parseFloat(this.getSetting('poll_interval_node') || '5'); // Default 5 min
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
          // Get the specific cluster device instance using the retrieved ID
          const clusterDevice = await this.homey.drivers.getDriver('proxmox-cluster').getDevice({ id: serverId });
          // Check if the cluster device itself is available
          if (!clusterDevice.getAvailable()) {
              throw new Error(`Associated cluster device '${clusterDevice.getName()}' is currently unavailable.`);
          }
          return clusterDevice;
      } catch (error) {
          this.error(`Could not retrieve or use cluster device (ID: ${serverId}) for node [${this.getName()}]:`, error);
          // Throw user-friendly error (inline translated)
          throw new Error(JSON.stringify({ en: 'Associated cluster device unavailable.', nl: 'Gekoppeld cluster apparaat niet beschikbaar.' }));
      }
  }

  // === NODE SPECIFIC METHODS ===

  // Fetches current status for this specific node and updates capabilities
  async updateNodeStatus() {
    const nodeName = this.getData().id; // Node name is stored as device ID
    this.log(`Updating status for node [${nodeName}]...`);

    try {
      // Get the cluster device to use its API call method (which handles fallback)
      const clusterDevice = await this._getClusterDevice(); // Throws if cluster unavailable
      const apiPath = `/api2/json/nodes/${nodeName}/status`;

      // Use the cluster device's _executeApiCallWithFallback method
      const nodeStatusData = await clusterDevice._executeApiCallWithFallback(apiPath);

      if (nodeStatusData?.data) {
        const nodeData = nodeStatusData.data;

        // --- Update Standard Capabilities ---
        const memUsed = nodeData.memory?.used || 0;
        const memTotal = nodeData.memory?.total || 1; // Avoid division by zero
        const memoryPerc = (memTotal > 0) ? parseFloat(((memUsed / memTotal) * 100).toFixed(1)) : 0;
        await this._updateCapability('measure_memory_usage_perc', memoryPerc);

        const cpuLoad = nodeData.cpu || 0;
        const cpuPerc = parseFloat((cpuLoad * 100).toFixed(1));
        await this._updateCapability('measure_cpu_usage_perc', cpuPerc);

        // --- Update Node Status Capability (FALSE = Online) ---
        await this._updateCapability('alarm_node_status', false);

        // Mark node as available if status update succeeds
        if (!this.getAvailable()) {
            await this.setAvailable();
            this.log(`Node [${nodeName}] marked as available.`);
        }

      } else {
        // Handle case where API call succeeded but data format is unexpected
        this.warn(`No data received in node status response for [${nodeName}].`);
        // Set status to offline (alarm on)
        await this._updateCapability('alarm_node_status', true);
        // Mark as unavailable because we couldn't parse data
        await this.setUnavailable(JSON.stringify({ en: 'Invalid status response from node.', nl: 'Ongeldig status antwoord van node.' })).catch(this.error);
      }
    } catch (error) {
      this.error(`Failed to update node status for [${nodeName}]:`, error.message);
      // --- Set Node Status Capability to TRUE (Offline/Alarm) on Error ---
      await this._updateCapability('alarm_node_status', true);
      // --- DO NOT set unavailable, let the alarm capability indicate the issue ---
      // await this.setUnavailable(error.message).catch(this.error);
      this.log(`Node [${nodeName}] status update failed, setting alarm status to true.`);
      // Ensure device remains available so capabilities (like the alarm) are shown
      if (!this.getAvailable()) {
          this.warn(`Node [${nodeName}] was unavailable, marking available to show offline alarm status.`);
          await this.setAvailable().catch(this.error);
      }
    }
  }

  // Helper to update capability value on THIS node device instance
  async _updateCapability(capabilityId, value) {
     try {
         // Force update for alarm status capability
         const forceUpdate = (capabilityId === 'alarm_node_status');
         if (!this.hasCapability(capabilityId)) {
             this.log(`Adding capability '${capabilityId}' to node [${this.getName()}]`);
             await this.addCapability(capabilityId);
             await this.setCapabilityValue(capabilityId, value); // Set initial value
         } else if (forceUpdate || this.getCapabilityValue(capabilityId) !== value) {
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
          // API path for node shutdown/stop
          const apiPath = `/api2/json/nodes/${nodeName}/status`;
          const options = {
              method: 'POST',
              body: `command=${action}`, // Send command in body
              timeout: (action === 'shutdown' ? 60000 : 15000) // Longer timeout for shutdown
          };
          this.log(`Attempting ${options.method} to ${apiPath} via cluster [${clusterDevice.getName()}]`);
          // Use the cluster device's API call method (handles fallback)
          const result = await clusterDevice._executeApiCallWithFallback(apiPath, options);
          this.log(`${action} node command result for [${nodeName}]:`, result);
          // Optional: Trigger a status update shortly after action
          this.homey.setTimeout(() => this.updateNodeStatus().catch(this.error), 2000);
      } catch (error) {
          this.error(`Failed to ${action} node [${nodeName}]:`, error.message);
          // Re-throw user-friendly error (inline translated)
          throw new Error(JSON.stringify({
              en: `Failed to ${action} node ${nodeName}`,
              nl: `Kon node ${nodeName} niet ${action === 'shutdown' ? 'uitschakelen' : 'stoppen'}`
          }));
      }
  }

} // End of class ProxmoxNodeDevice
