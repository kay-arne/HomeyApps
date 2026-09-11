'use strict';

const Homey = require('homey');

class FortiGateApp extends Homey.App {
  async onInit() {
    this.log('FortiGate app starting…');

    // Flow cards shared by more than one driver are registered once, here.
    this.homey.flow.getConditionCard('is_online')
      .registerRunListener(async ({ device }) => Boolean(device.getAvailable()));

    this.homey.flow.getActionCard('refresh_data')
      .registerRunListener(async ({ device }) => {
        if (typeof device.refreshNow === 'function') await device.refreshNow();
      });

    this.homey.flow.getActionCard('power_cycle_poe')
      .registerRunListener(async ({ device }) => {
        if (typeof device.powerCyclePoe !== 'function') {
          throw new Error('This device does not support power cycling via PoE.');
        }
        await device.powerCyclePoe();
      });

    // Trigger cards are kept on the app instance so device.js / api.js can fire them
    // via `this.homey.app.triggerXxx(...)` without re-fetching the card each time.
    // All 5 trigger cards here have a "device" argument (see driver_id filters in
    // their .homeycompose/flow/triggers/*.json), so they must come from
    // getDeviceTriggerCard() - its FlowCardTriggerDevice.trigger(device, tokens,
    // state) is a different class/signature than plain getTriggerCard()'s
    // FlowCardTrigger.trigger(tokens, state), which has no device parameter at
    // all (passing a device there silently misfires it as the tokens argument).
    this.triggerNetworkDeviceOffline = this.homey.flow.getDeviceTriggerCard('network_device_offline');
    this.triggerNetworkDeviceOnline = this.homey.flow.getDeviceTriggerCard('network_device_online');
    this.triggerSecurityEvent = this.homey.flow.getDeviceTriggerCard('security_event');

    // power_above/power_below carry a user-configured "threshold" argument, so every
    // poll simply triggers the card and this run listener decides - per flow-card
    // instance - whether *this* threshold was just crossed (edge-triggered, using the
    // previous/current values passed in as trigger state, so it won't fire on every
    // poll while already above/below the mark).
    this.triggerPowerAbove = this.homey.flow.getDeviceTriggerCard('power_above');
    this.triggerPowerAbove.registerRunListener(async (args, state) => (
      state.current > args.threshold && state.previous <= args.threshold
    ));

    this.triggerPowerBelow = this.homey.flow.getDeviceTriggerCard('power_below');
    this.triggerPowerBelow.registerRunListener(async (args, state) => (
      state.current < args.threshold && state.previous >= args.threshold
    ));

    this.log('FortiGate app started');
  }

  /** Find a paired FortiGate bridge device whose webhook secret matches. Used by api.js. */
  findFortiGateDeviceBySecret(secret) {
    if (!secret) return undefined;
    const driver = this.homey.drivers.getDriver('fortigate');
    return driver.getDevices().find((d) => d.getStoreValue('webhookSecret') === secret);
  }

  /** Find a paired FortiSwitch/FortiAP device by its stable data.id (serial). Used by api.js. */
  findNetworkDeviceById(id) {
    if (!id) return undefined;
    for (const driverId of ['fortiswitch', 'fortiap']) {
      const driver = this.homey.drivers.getDriver(driverId);
      const found = driver.getDevices().find((d) => d.getData().id === id);
      if (found) return found;
    }
    return undefined;
  }
}

module.exports = FortiGateApp;
