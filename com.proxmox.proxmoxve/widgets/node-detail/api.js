'use strict';

const { resolveWidgetDevice, getCapabilityValue } = require('../../lib/widgetHelpers');

module.exports = {
  // Pure capability reads via the Web API - no Proxmox API call, this just reflects the node
  // device's already-polled state.
  async getStatus({ homey, query }) {
    const device = await resolveWidgetDevice(homey, query.deviceId);

    return {
      name: device.name,
      available: device.available !== false,
      offline: getCapabilityValue(device, 'alarm_node_status'),
      cpuPerc: getCapabilityValue(device, 'measure_cpu_usage_perc'),
      memPerc: getCapabilityValue(device, 'measure_memory_usage_perc'),
      diskPerc: getCapabilityValue(device, 'measure_disk_usage_perc'),
      vmCount: getCapabilityValue(device, 'measure_vm_count'),
      lxcCount: getCapabilityValue(device, 'measure_lxc_count'),
    };
  },
};
