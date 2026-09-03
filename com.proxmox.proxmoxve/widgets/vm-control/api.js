'use strict';

const { resolveWidgetDevice } = require('../../lib/widgetHelpers');

module.exports = {
  async getStatus({ homey, query }) {
    const device = await resolveWidgetDevice(homey, 'proxmox-vm', query.deviceId);
    const { vmid, type, serverId } = device.getData();

    // measure_network_in/out are cumulative GB rounded to 2 decimals - too coarse to derive a
    // meaningful rate from at a 15s widget-refresh cadence. Pull the raw cumulative byte counters
    // instead (already cached from the last poll, so this doesn't add an extra live API call) and
    // let the frontend compute bytes/sec from the delta between refreshes.
    let netInBytes = null;
    let netOutBytes = null;
    const cluster = homey.drivers.getDriver('proxmox-cluster').getDevice({ id: serverId });
    if (cluster && cluster.getAvailable()) {
      try {
        const res = await cluster._executeApiCallWithFallback('/api2/json/cluster/resources');
        const resource = res?.data?.find((r) => Number(r.vmid) === Number(vmid) && r.type === type);
        if (resource) {
          netInBytes = resource.netin || 0;
          netOutBytes = resource.netout || 0;
        }
      } catch (e) {
        // Leave netInBytes/netOutBytes null - the network sparkline just skips this sample
      }
    }

    return {
      name: device.getName(),
      available: device.getAvailable(),
      running: device.getCapabilityValue('onoff'),
      cpuPerc: device.getCapabilityValue('measure_cpu_usage_perc'),
      memPerc: device.getCapabilityValue('measure_memory_usage_perc'),
      netInBytes,
      netOutBytes,
    };
  },

  async setState({ homey, query, body }) {
    const device = await resolveWidgetDevice(homey, 'proxmox-vm', query.deviceId);
    const { vmid, type, serverId } = device.getData();

    const cluster = homey.drivers.getDriver('proxmox-cluster').getDevice({ id: serverId });
    if (!cluster) throw new Error('Cluster device not found');

    await cluster._runVmAction(vmid, type, body.action === 'start' ? 'start' : 'shutdown');
    return { ok: true };
  },
};
