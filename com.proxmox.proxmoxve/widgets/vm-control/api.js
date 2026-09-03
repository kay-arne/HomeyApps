'use strict';

const { resolveWidgetDevice } = require('../../lib/widgetHelpers');

module.exports = {
  async getStatus({ homey, query }) {
    const device = await resolveWidgetDevice(homey, 'proxmox-vm', query.deviceId);

    return {
      name: device.getName(),
      available: device.getAvailable(),
      running: device.getCapabilityValue('onoff'),
      cpuPerc: device.getCapabilityValue('measure_cpu_usage_perc'),
      memPerc: device.getCapabilityValue('measure_memory_usage_perc'),
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
