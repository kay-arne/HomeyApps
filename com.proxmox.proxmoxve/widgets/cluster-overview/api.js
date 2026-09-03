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
    try {
      // Not skipCache/refreshCache: reuses the cluster device's normal response cache, so
      // widget polling doesn't add extra load on top of the app's own regular polling.
      const res = await device._executeApiCallWithFallback('/api2/json/cluster/resources');
      if (Array.isArray(res?.data)) {
        const seen = new Set();
        result.storages = res.data
          .filter((r) => r.type === 'storage' && r.status === 'available' && r.maxdisk > 0)
          .filter((r) => (seen.has(r.storage) ? false : seen.add(r.storage)))
          .map((r) => ({
            id: r.storage,
            usedPct: Math.round((r.disk / r.maxdisk) * 1000) / 10,
            usedBytes: r.disk,
            totalBytes: r.maxdisk,
          }))
          .sort((a, b) => b.usedPct - a.usedPct);
      }
    } catch (e) {
      // Leave result.storages empty
    }

    return result;
  },
};
