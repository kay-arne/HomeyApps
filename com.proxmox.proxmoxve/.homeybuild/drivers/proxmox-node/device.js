'use strict';

const Homey = require('homey');

// Represents an individual paired Proxmox Node device
module.exports = class ProxmoxNodeDevice extends Homey.Device {

  // === LIFECYCLE METHODS ===

  async onInit() {
    const nodeName = this.getName();
    this.activeTimeouts = new Set();
    this.updateIntervalId = null;

    this.log(`Initializing node: ${nodeName}`);

    try {
      if (!this.getData().serverId) {
        throw new Error('serverId is missing. Please re-pair.');
      }

      if (!this.hasCapability('measure_vm_count')) await this.addCapability('measure_vm_count');
      if (!this.hasCapability('measure_lxc_count')) await this.addCapability('measure_lxc_count');

      await this.updateNodeStatus();
      this.startPolling();
    } catch (error) {
      this.error('Init Error:', error);
      await this._updateCapability('alarm_node_status', true).catch(this.error);
    }
  }

  async onAdded() {
    this.log(`Node added: ${this.getName()}`);
    this._createManagedTimeout(() => this.updateNodeStatus().catch(this.error), 2000);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval_node')) {
      this.startPolling(newSettings.poll_interval_node);
    }
  }

  async onRenamed(name) {
    this.log(`Renamed to ${name}`);
  }

  async onDeleted() {
    this.log(`Deleted: ${this.getName()}`);
    this.stopPolling();
    this._clearAllTimeouts();
  }

  // === POLLING LOGIC ===

  startPolling(interval = null) {
    this.stopPolling();
    const val = interval !== null ? interval : this.getSetting('poll_interval_node');
    // Ensure 0 is handled correctly and default to 1 (matching app.json)
    const effectiveVal = (val !== null && val !== undefined && val !== '') ? val : '1';

    const pollIntervalMinutes = parseFloat(effectiveVal);
    if (isNaN(pollIntervalMinutes) || pollIntervalMinutes <= 0) return;

    const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
    this.updateIntervalId = this.homey.setInterval(() => {
      this.updateNodeStatus().catch(this.error);
    }, pollIntervalMs);
  }

  stopPolling() {
    if (this.updateIntervalId) {
      this.homey.clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
    }
  }

  // === API HELPER ===

  async _getClusterDevice() {
    const serverId = this.getData()?.serverId;
    if (!serverId) throw new Error('No serverId');

    const clusterDevice = await this.homey.drivers.getDriver('proxmox-cluster').getDevice({ id: serverId });
    if (!clusterDevice || !clusterDevice.getAvailable()) {
      throw new Error('Cluster unavailable');
    }
    return clusterDevice;
  }

  // === NODE STATUS & ACTION ===

  async updateNodeStatus(options = {}) {
    const nodeName = this.getData().id;
    try {
      const cluster = await this._getClusterDevice();

      const [statusRes, resourcesRes] = await Promise.all([
        cluster._executeApiCallWithFallback(`/api2/json/nodes/${nodeName}/status`, { ...options, refreshCache: true }),
        cluster._executeApiCallWithFallback('/api2/json/cluster/resources', { ...options, refreshCache: true }),
      ]);

      if (statusRes?.data) {
        const d = statusRes.data;

        // Mem
        const memPerc = d.memory?.total > 0 ? parseFloat(((d.memory.used / d.memory.total) * 100).toFixed(1)) : 0;
        await this._updateCapability('measure_memory_usage_perc', memPerc);

        // CPU
        const cpuPerc = parseFloat((d.cpu * 100).toFixed(1));
        await this._updateCapability('measure_cpu_usage_perc', cpuPerc);

        // Status
        await this._updateCapability('alarm_node_status', false);

        if (!this.getAvailable()) await this.setAvailable();

      } else {
        throw new Error('Invalid response from node status');
      }

      // Update VM/LXC Counts
      if (resourcesRes?.data) {
        const activeResources = resourcesRes.data.filter((r) => r.node === nodeName && r.status === 'running');
        const vmCount = activeResources.filter((r) => r.type === 'qemu').length;
        const lxcCount = activeResources.filter((r) => r.type === 'lxc').length;

        await this._updateCapability('measure_vm_count', vmCount);
        await this._updateCapability('measure_lxc_count', lxcCount);
      }

    } catch (error) {
      this.error(`Status update failed for [${nodeName}]:`, error.message);
      await this._updateCapability('alarm_node_status', true);
      // We do NOT set unavailable here, to keep previous stats visible, but alarm is on.
    }
  }

  async triggerPowerAction(action) {
    const nodeName = this.getData().id;
    this.log(`Action ${action} on node ${nodeName}`);

    try {
      const cluster = await this._getClusterDevice();
      const endpoint = `/api2/json/nodes/${nodeName}/status`;

      await cluster._executeApiCallWithFallback(endpoint, {
        method: 'POST',
        body: `command=${action}`,
        timeout: (action === 'shutdown' ? 60000 : 15000),
      });

      this._createManagedTimeout(() => this.updateNodeStatus().catch(this.error), 2000);
    } catch (error) {
      throw new Error(`Failed to ${action} ${nodeName}: ${error.message}`);
    }
  }

  // === HELPERS ===

  async _updateCapability(id, value) {
    if (!this.hasCapability(id)) return;
    if (this.getCapabilityValue(id) !== value || id === 'alarm_node_status') {
      await this.setCapabilityValue(id, value).catch((e) => this.error(e));
    }
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

};
