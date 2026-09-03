'use strict';

const { resolveWidgetDevice, getCapabilityValue, findInternalDevice } = require('../../lib/widgetHelpers');

module.exports = {
  async getStatus({ homey, query }) {
    const device = await resolveWidgetDevice(homey, query.deviceId);

    const result = {
      name: device.name,
      available: device.available !== false,
      nodeCount: getCapabilityValue(device, 'measure_node_count'),
      vmCount: getCapabilityValue(device, 'measure_vm_count'),
      lxcCount: getCapabilityValue(device, 'measure_lxc_count'),
      connectedHost: getCapabilityValue(device, 'status_connected_host'),
      isFallback: getCapabilityValue(device, 'alarm_connection_fallback'),
      quorumLost: getCapabilityValue(device, 'alarm_cluster_quorum_lost'),
      storages: [],
    };

    // Storage usage is a bonus on top of the core status - don't fail the whole widget if
    // this part errors (e.g. no unambiguous internal device match, or cluster momentarily
    // unreachable). Needs the app's own device instance (not just the Web API device) since
    // storage pools aren't exposed as a capability.
    try {
      const internalDevice = findInternalDevice(homey, 'proxmox-cluster', device);
      if (internalDevice) {
        // Not skipCache/refreshCache: reuses the cluster device's normal response cache, so
        // widget polling doesn't add extra load on top of the app's own regular polling.
        const res = await internalDevice._executeApiCallWithFallback('/api2/json/cluster/resources');
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
      }
    } catch (e) {
      // Leave result.storages empty
    }

    return result;
  },
};
