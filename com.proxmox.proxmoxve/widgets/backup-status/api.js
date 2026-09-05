'use strict';

const { resolveWidgetDevice } = require('../../lib/widgetHelpers');

module.exports = {
  async getSummary({ homey, query }) {
    const device = await resolveWidgetDevice(homey, 'proxmox-cluster', query.deviceId);

    return {
      name: device.getName(),
      available: device.getAvailable(),
      guests: device.getAvailable() ? await device.getBackupSnapshotSummary() : [],
    };
  },
};
