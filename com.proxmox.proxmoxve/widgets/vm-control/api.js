'use strict';

const { resolveWidgetDevice } = require('../../lib/widgetHelpers');

module.exports = {
  async getStates({ homey, query }) {
    const ids = (query.deviceIds || '').split(',').filter(Boolean);

    return Promise.all(ids.map(async (id) => {
      try {
        const device = await resolveWidgetDevice(homey, 'proxmox-vm', id);
        return {
          id,
          name: device.getName(),
          available: device.getAvailable(),
          running: device.getCapabilityValue('onoff'),
          cpuPerc: device.getCapabilityValue('measure_cpu_usage_perc'),
          memPerc: device.getCapabilityValue('measure_memory_usage_perc'),
        };
      } catch (e) {
        return {
          id, name: 'Unknown', available: false, error: e.message,
        };
      }
    }));
  },

  async setState({ homey, params, body }) {
    const device = await resolveWidgetDevice(homey, 'proxmox-vm', params.id);
    const { vmid, type, serverId } = device.getData();

    const cluster = homey.drivers.getDriver('proxmox-cluster').getDevice({ id: serverId });
    if (!cluster) throw new Error('Cluster device not found');

    await cluster._runVmAction(vmid, type, body.action === 'start' ? 'start' : 'shutdown');
    return { ok: true };
  },
};
