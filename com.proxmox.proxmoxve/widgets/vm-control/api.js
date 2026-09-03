'use strict';

const { resolveWidgetDevice, getCapabilityValue } = require('../../lib/widgetHelpers');

module.exports = {
  async getStates({ homey, query }) {
    const ids = (query.deviceIds || '').split(',').filter(Boolean);

    return Promise.all(ids.map(async (id) => {
      try {
        const device = await resolveWidgetDevice(homey, id);
        return {
          id,
          name: device.name,
          available: device.available !== false,
          running: getCapabilityValue(device, 'onoff'),
          cpuPerc: getCapabilityValue(device, 'measure_cpu_usage_perc'),
          memPerc: getCapabilityValue(device, 'measure_memory_usage_perc'),
        };
      } catch (e) {
        return {
          id, name: 'Unknown', available: false, error: e.message,
        };
      }
    }));
  },

  async setState({ homey, params, body }) {
    const device = await resolveWidgetDevice(homey, params.id);

    // Goes through the Web API, same as tapping the device's tile in the Homey app - this
    // triggers ProxmoxVmDevice's own registerCapabilityListener('onoff', ...), which already
    // handles calling the cluster device's start/shutdown action.
    await device.setCapabilityValue({
      capabilityId: 'onoff',
      value: body.action === 'start',
    });

    return { ok: true };
  },
};
