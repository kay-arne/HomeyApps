'use strict';

const { resolveWidgetDevice } = require('../../lib/widgetHelpers');

module.exports = {
  // Pure capability reads - no Proxmox API call, this just reflects the node device's
  // already-polled state.
  async getStatus({ homey, query }) {
    const device = await resolveWidgetDevice(homey, 'proxmox-node', query.deviceId);

    return {
      name: device.getName(),
      available: device.getAvailable(),
      offline: device.getCapabilityValue('alarm_node_status'),
      cpuPerc: device.getCapabilityValue('measure_cpu_usage_perc'),
      memPerc: device.getCapabilityValue('measure_memory_usage_perc'),
      diskPerc: device.getCapabilityValue('measure_disk_usage_perc'),
      vmCount: device.getCapabilityValue('measure_vm_count'),
      lxcCount: device.getCapabilityValue('measure_lxc_count'),
    };
  },
};
