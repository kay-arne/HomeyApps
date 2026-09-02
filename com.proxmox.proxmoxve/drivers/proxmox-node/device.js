'use strict';

const Homey = require('homey');

// Represents an individual paired Proxmox Node device
module.exports = class ProxmoxNodeDevice extends Homey.Device {

  // === LIFECYCLE METHODS ===

  async onInit() {
    this.log(`Initializing node: ${this.getName()}`);
    this.activeTimeouts = new Set();
    this.updateIntervalId = null;
    this._triggerCards = new Map();

    await this._initializeWithRetry();
  }

  async _initializeWithRetry() {
    const { serverId } = this.getData();
    if (!serverId) throw new Error('serverId is missing. Please re-pair.');

    // Proactive Check: Is cluster ready?
    // We do this to avoid throwing an Error which looks like a crash.
    try {
      const cluster = await this.homey.drivers.getDriver('proxmox-cluster').getDevice({ id: serverId });
      if (!cluster || !cluster.hostManager) {
        this.log(`Cluster device [${serverId}] not ready yet. Waiting...`);
        this._createManagedTimeout(() => this._initializeWithRetry(), 5000);
        return;
      }
    } catch (e) {
      // Driver or device not found yet
      this.log('Cluster driver/device not ready. Waiting...');
      this._createManagedTimeout(() => this._initializeWithRetry(), 5000);
      return;
    }

    try {
      if (!this.hasCapability('measure_vm_count')) await this.addCapability('measure_vm_count');
      if (!this.hasCapability('measure_lxc_count')) await this.addCapability('measure_lxc_count');

      // Attempt to fetch first status update
      await this.updateNodeStatus();

      // If successful, start periodic polling
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
    if (Number.isNaN(pollIntervalMinutes) || pollIntervalMinutes <= 0) return;

    const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
    // Jitter avoids every node device (and the cluster device) polling in lockstep,
    // which would otherwise fire simultaneous, non-deduplicated cluster/resources calls.
    const jitter = Math.random() * 30000;

    this.updateIntervalId = this.homey.setInterval(() => {
      this.updateNodeStatus().catch(this.error);
    }, pollIntervalMs);

    this._createManagedTimeout(() => this.updateNodeStatus().catch(this.error), jitter);
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
        this._fireThresholdTrigger('memory_usage_above', memPerc);

        // CPU
        const cpuPerc = parseFloat((d.cpu * 100).toFixed(1));
        await this._updateCapability('measure_cpu_usage_perc', cpuPerc);
        this._fireThresholdTrigger('cpu_usage_above', cpuPerc);

        // Disk (root filesystem)
        if (d.rootfs?.total > 0) {
          const diskPerc = parseFloat(((d.rootfs.used / d.rootfs.total) * 100).toFixed(1));
          await this._updateCapability('measure_disk_usage_perc', diskPerc);
        }

        // Status
        await this._updateCapabilityWithTrigger('alarm_node_status', false, 'node_offline', 'node_online');

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
      await this._updateCapabilityWithTrigger('alarm_node_status', true, 'node_offline', 'node_online');
      // We do NOT set unavailable here, to keep previous stats visible, but alarm is on.
    }
  }

  // Value-comparison triggers fire on every update; the runListener (registered in driver.js)
  // filters by each flow's configured threshold. Repeat-firing while sustained above threshold
  // is expected Homey convention for this kind of card.
  _fireThresholdTrigger(triggerId, value) {
    this._getTriggerCard(triggerId)?.trigger(this, { value }, { value }).catch(this.error);
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

  // Proxmox's own node power endpoint only accepts "reboot"/"shutdown" - there's no API-level
  // "force stop" for the host itself (that would need IPMI/PDU hardware, out of scope here).
  // So "force stop" is repurposed to what actually is a valid, useful force action at the node
  // level: immediately killing every running VM/Container on this node.
  async forceStopAllVms() {
    const nodeName = this.getData().id;
    const cluster = await this._getClusterDevice();

    const res = await cluster._executeApiCallWithFallback('/api2/json/cluster/resources', { skipCache: true });
    const targets = (res?.data || []).filter(
      (r) => r.node === nodeName && r.status === 'running' && (r.type === 'qemu' || r.type === 'lxc'),
    );

    if (targets.length === 0) {
      this.log(`No running VMs/Containers to force-stop on node ${nodeName}`);
      return;
    }

    this.log(`Force-stopping ${targets.length} VM(s)/Container(s) on node ${nodeName}`);
    const results = await Promise.allSettled(
      targets.map((r) => cluster._runVmAction(r.vmid, r.type, 'stop')),
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      throw new Error(`Failed to force-stop ${failed.length}/${targets.length} VM(s)/Container(s) on ${nodeName}: ${failed[0].reason?.message}`);
    }

    this._createManagedTimeout(() => this.updateNodeStatus().catch(this.error), 2000);
  }

  // === HELPERS ===

  async _updateCapability(id, value) {
    if (!this.hasCapability(id)) return;
    if (this.getCapabilityValue(id) !== value || id === 'alarm_node_status') {
      await this.setCapabilityValue(id, value).catch((e) => this.error(e));
    }
  }

  // Like _updateCapability, but fires a device trigger card on an actual transition.
  // The first observation (capability still unset) does not fire either trigger.
  async _updateCapabilityWithTrigger(id, value, trueTriggerId, falseTriggerId) {
    if (!this.hasCapability(id)) return;
    const previous = this.getCapabilityValue(id);
    await this._updateCapability(id, value);
    if (previous === value || previous === null) return;

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
