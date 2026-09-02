'use strict';

const Homey = require('homey');

// Represents an individual paired Proxmox VM/Container device.
// Mirrors the proxmox-node device's "delegate everything through the parent cluster
// device" pattern, so it benefits from the same failover/caching for free.
module.exports = class ProxmoxVmDevice extends Homey.Device {

  // === LIFECYCLE METHODS ===

  async onInit() {
    this.log(`Initializing VM/Container: ${this.getName()}`);
    this.activeTimeouts = new Set();
    this.updateIntervalId = null;
    this._settingOnoffFromPoll = false;

    this.registerCapabilityListener('onoff', this._onCapabilityOnoff.bind(this));

    await this._initializeWithRetry();
  }

  async _initializeWithRetry() {
    const { serverId } = this.getData();
    if (!serverId) throw new Error('serverId is missing. Please re-pair.');

    try {
      const cluster = await this.homey.drivers.getDriver('proxmox-cluster').getDevice({ id: serverId });
      if (!cluster || !cluster.hostManager) {
        this.log(`Cluster device [${serverId}] not ready yet. Waiting...`);
        this._createManagedTimeout(() => this._initializeWithRetry(), 5000);
        return;
      }
    } catch (e) {
      this.log('Cluster driver/device not ready. Waiting...');
      this._createManagedTimeout(() => this._initializeWithRetry(), 5000);
      return;
    }

    try {
      await this.updateVmStatus();
      this.startPolling();
    } catch (error) {
      this.error('Init Error:', error);
    }
  }

  async onAdded() {
    this._createManagedTimeout(() => this.updateVmStatus().catch(this.error), 2000);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval_vm')) {
      this.startPolling(newSettings.poll_interval_vm);
    }
  }

  async onDeleted() {
    this.log(`Deleted: ${this.getName()}`);
    this.stopPolling();
    this._clearAllTimeouts();
  }

  // === POLLING LOGIC ===

  startPolling(interval = null) {
    this.stopPolling();
    const val = interval !== null ? interval : this.getSetting('poll_interval_vm');
    const effectiveVal = (val !== null && val !== undefined && val !== '') ? val : '1';

    const pollIntervalMinutes = parseFloat(effectiveVal);
    if (Number.isNaN(pollIntervalMinutes) || pollIntervalMinutes <= 0) return;

    const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
    const jitter = Math.random() * 30000;

    this.updateIntervalId = this.homey.setInterval(() => {
      this.updateVmStatus().catch(this.error);
    }, pollIntervalMs);

    this._createManagedTimeout(() => this.updateVmStatus().catch(this.error), jitter);
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

  // === STATUS & ACTION ===

  async updateVmStatus() {
    const { vmid, type } = this.getData();
    try {
      const cluster = await this._getClusterDevice();
      const res = await cluster._executeApiCallWithFallback('/api2/json/cluster/resources', { refreshCache: true });
      const resource = res?.data?.find((r) => Number(r.vmid) === Number(vmid) && r.type === type);

      if (!resource) {
        // VM/Container no longer visible in the cluster (deleted, or cluster unreachable but cached data still had it)
        return;
      }

      const isRunning = resource.status === 'running';

      // Avoid re-triggering our own onoff listener while reflecting polled state
      this._settingOnoffFromPoll = true;
      await this._updateCapability('onoff', isRunning);
      this._settingOnoffFromPoll = false;

      if (isRunning) {
        const cpuPerc = parseFloat(((resource.cpu || 0) * 100).toFixed(1));
        await this._updateCapability('measure_cpu_usage_perc', cpuPerc);

        const memPerc = resource.maxmem > 0 ? parseFloat(((resource.mem / resource.maxmem) * 100).toFixed(1)) : 0;
        await this._updateCapability('measure_memory_usage_perc', memPerc);
      }

      if (!this.getAvailable()) await this.setAvailable();
    } catch (error) {
      this.error(`Status update failed for [${this.getName()}]:`, error.message);
    }
  }

  async _onCapabilityOnoff(value) {
    if (this._settingOnoffFromPoll) return;

    const { vmid, type } = this.getData();
    const cluster = await this._getClusterDevice();
    await cluster._runVmAction(vmid, type, value ? 'start' : 'shutdown');

    this._createManagedTimeout(() => this.updateVmStatus().catch(this.error), 2000);
  }

  // === HELPERS ===

  async _updateCapability(id, value) {
    if (!this.hasCapability(id)) return;
    if (this.getCapabilityValue(id) !== value) {
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
