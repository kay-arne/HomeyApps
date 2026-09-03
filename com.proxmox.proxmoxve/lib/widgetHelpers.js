'use strict';

// Widgets select devices via the frontend's Homey.getDeviceIds(), which returns Homey's
// platform-wide device IDs - confirmed on a real Homey to be a UUID completely unrelated to
// this app's own pairing `data.id` (the ID space Driver#getDevice() matches against, and what
// this app uses internally, e.g. ProxmoxNodeDevice storing its parent's `data.id` as
// `serverId`). The Homey Web API operates in that same platform-wide ID space, so widgets use
// it instead of homey.drivers. It's set up once in app.js's onInit as `homey.app.homeyApi`
// (via HomeyAPI.createAppAPI, requires the `homey:manager:api` permission).

// Resolves a widget-selected device ID into a Web API Device object (has `.capabilitiesObj`
// for reads and `.setCapabilityValue()` for writes - the latter runs through this app's own
// registerCapabilityListener, same as a tap in the Homey app).
async function resolveWidgetDevice(homey, deviceId) {
  if (!deviceId) throw new Error('No device selected for this widget.');

  const { homeyApi } = homey.app;
  if (!homeyApi) throw new Error('Homey API not available. Please restart the app.');

  try {
    const device = await homeyApi.devices.getDevice({ id: deviceId });
    if (device) return device;
  } catch (e) {
    // Fall through to the full-list lookup below.
  }

  // getDevices() returns an object keyed by device ID - a safe fallback regardless of whether
  // getDevice({id}) exists as a named method on this Web API version.
  const devices = await homeyApi.devices.getDevices();
  const device = devices[deviceId];
  if (!device) throw new Error('Selected device not found. Please reselect it in the widget settings.');
  return device;
}

function getCapabilityValue(device, capabilityId) {
  return device.capabilitiesObj?.[capabilityId]?.value ?? null;
}

// Best-effort bridge from a Web API device to this app's own internal Device instance, needed
// only for app-internal methods that aren't exposed as capabilities (e.g. the cluster device's
// _executeApiCallWithFallback, used for storage-pool data). The Web API doesn't expose the
// pairing `data` object, so there's no exact match available - this matches by name, falls back
// to "the only device of this driver" when there's just one (the common case), and gives up
// (returns null) rather than guessing wrong when several same-named or ambiguous devices exist.
function findInternalDevice(homey, driverId, webApiDevice) {
  const devices = homey.drivers.getDriver(driverId).getDevices();
  const byName = devices.find((d) => d.getName() === webApiDevice.name);
  if (byName) return byName;
  return devices.length === 1 ? devices[0] : null;
}

module.exports = { resolveWidgetDevice, getCapabilityValue, findInternalDevice };
