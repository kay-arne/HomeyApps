'use strict';

const { resolveWidgetDevice } = require('../../lib/widgetHelpers');

module.exports = {
  async getStatus({ homey, query }) {
    const device = await resolveWidgetDevice(homey, 'proxmox-cluster', query.deviceId);

    return {
      name: device.getName(),
      available: device.getAvailable(),
      nodes: device.getAvailable() ? await device.getNodesStatus() : [],
    };
  },
};
