'use strict';

// Resolves a widget-selected device ID (from the frontend's Homey.getDeviceIds()) into a
// Device instance. The public SDK docs don't confirm that Homey.getDeviceIds() and
// Driver#getDevice() share the same ID space - getDevice() matches against the device's
// pairing `data` object, which is what this app always sets `data.id` to. This covers the
// most likely case (and the same lookup this app already relies on internally, e.g.
// ProxmoxNodeDevice using its parent's `data.id` as `serverId`) while failing loudly with a
// clear, actionable message instead of silently breaking if that assumption turns out wrong.
async function resolveWidgetDevice(homey, driverId, deviceId) {
  if (!deviceId) throw new Error('No device selected for this widget.');

  const driver = homey.drivers.getDriver(driverId);

  try {
    const device = driver.getDevice({ id: deviceId });
    if (device) return device;
  } catch (e) {
    // getDevice() throws when no match is found - fall through to the manual scan below.
  }

  const device = driver.getDevices().find((d) => d.getData()?.id === deviceId);
  if (!device) throw new Error('Selected device not found. Please reselect it in the widget settings.');
  return device;
}

module.exports = { resolveWidgetDevice };
