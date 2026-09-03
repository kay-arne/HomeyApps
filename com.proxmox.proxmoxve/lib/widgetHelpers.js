'use strict';

// Widgets pick a device via a custom "autocomplete" setting (registered in app.js), not
// Homey's native "devices" picker - so the value coming back here is our own device's pairing
// data.id, exactly what Driver#getDevice() already resolves against everywhere else in this
// app. No Homey Web API / homey:manager:api permission needed.
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
