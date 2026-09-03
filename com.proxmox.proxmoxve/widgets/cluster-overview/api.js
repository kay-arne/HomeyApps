'use strict';

const { resolveWidgetDevice } = require('../../lib/widgetHelpers');

module.exports = {
  async getStatus({ homey, query }) {
    const device = await resolveWidgetDevice(homey, 'proxmox-cluster', query.deviceId);

    const result = {
      name: device.getName(),
      available: device.getAvailable(),
      nodeCount: device.getCapabilityValue('measure_node_count'),
      vmCount: device.getCapabilityValue('measure_vm_count'),
      lxcCount: device.getCapabilityValue('measure_lxc_count'),
      connectedHost: device.getCapabilityValue('status_connected_host'),
      isFallback: device.getCapabilityValue('alarm_connection_fallback'),
      quorumLost: device.getCapabilityValue('alarm_cluster_quorum_lost'),
      storages: [],
    };

    // Storage usage is a bonus on top of the core status - don't fail the whole widget if
    // this part errors (e.g. cluster momentarily unreachable but capability values are cached).
    // Not skipCache/refreshCache internally: reuses the cluster device's normal response cache,
    // so widget polling doesn't add extra load on top of the app's own regular polling.
    try {
      result.storages = await device._getStoragePools();
    } catch (e) {
      // Leave result.storages empty
    }

    return result;
  },
};
