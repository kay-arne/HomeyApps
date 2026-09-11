'use strict';

const Homey = require('homey');

const DEFAULT_POLL_SECONDS = 60;

/**
 * Shared behaviour for the FortiSwitch and FortiAP devices: they don't talk
 * to the FortiGate directly (they have no credentials of their own), they
 * borrow the API client from the paired FortiGate bridge device, poll it on
 * an interval, and raise the same online/offline + power threshold flow
 * triggers. Driver-specific device.js files extend this and implement
 * `_fetchState()`.
 */
class NetworkDeviceBase extends Homey.Device {

  async onInit() {
    this._lastWatts = undefined;
    this._online = undefined; // unknown until first poll
    await this._poll();
    this._schedulePoll();
  }

  /** The paired FortiGate device this device was discovered through. */
  getFortiGate() {
    const id = this.getStoreValue('fortigateId');
    const driver = this.homey.drivers.getDriver('fortigate');
    return driver.getDevices().find((d) => d.getData().id === id);
  }

  _schedulePoll() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    const seconds = Number(this.getSetting('pollInterval')) || DEFAULT_POLL_SECONDS;
    this._pollTimer = this.homey.setInterval(() => this._poll().catch((err) => this.error(err)), seconds * 1000);
  }

  /** Called by the shared "refresh_data" flow action. */
  async refreshNow() {
    await this._poll();
  }

  async _poll() {
    const fortigate = this.getFortiGate();
    if (!fortigate) {
      await this.setUnavailable('The FortiGate this device was paired through is no longer available.').catch(() => {});
      return;
    }
    if (!fortigate.getAvailable()) {
      // Don't flap this device's own state just because the bridge is briefly unreachable.
      return;
    }

    let state;
    try {
      state = await this._fetchState(fortigate.getClient());
    } catch (err) {
      this.error('Poll failed:', err.message);
      return;
    }

    if (!state || state.found === false) {
      await this._setConnectivity(false, 'not reported by FortiGate');
      return;
    }

    await this._setConnectivity(state.connected !== false, 'reported disconnected by FortiGate');

    // Subclasses return whatever capability values they have via
    // `capabilities: { capabilityId: value }` in their _fetchState() result -
    // any value that's undefined, or a capability the device doesn't have
    // (e.g. an AP that never resolved a PoE port), is simply skipped.
    const capabilities = state.capabilities || {};
    for (const [capabilityId, value] of Object.entries(capabilities)) {
      if (value === undefined || !this.hasCapability(capabilityId)) continue;
      await this.setCapabilityValue(capabilityId, value).catch((err) => this.error(err));
    }

    const powerCapabilityId = this._powerCapabilityId();
    if (powerCapabilityId && typeof capabilities[powerCapabilityId] === 'number') {
      await this._checkPowerThresholds(capabilities[powerCapabilityId]);
    }
  }

  /**
   * Capability id whose value drives the power_above/power_below Flow
   * triggers for this device. Override in a subclass; return undefined (the
   * default) to skip threshold checks entirely.
   */
  _powerCapabilityId() {
    return undefined;
  }

  async _checkPowerThresholds(watts) {
    // Defensive: never hand a non-number to a Flow trigger's numeric token.
    if (typeof watts !== 'number' || !Number.isFinite(watts)) return;
    const prev = this._lastWatts;
    this._lastWatts = watts;
    if (prev === undefined) return; // no previous sample yet, nothing to cross
    const app = this.homey.app;
    const state = { previous: prev, current: watts };
    await app.triggerPowerAbove.trigger(this, { power: watts }, state).catch((err) => this.error(err));
    await app.triggerPowerBelow.trigger(this, { power: watts }, state).catch((err) => this.error(err));
  }

  /** Also used by api.js when a FortiGate Automation webhook reports a disconnect/reconnect. */
  async setConnectivity(online, reason) {
    return this._setConnectivity(online, reason);
  }

  async _setConnectivity(online, reason) {
    const wasOnline = this._online;
    this._online = online;

    if (online) {
      if (this.getAvailable() !== true) await this.setAvailable().catch(() => {});
    } else {
      await this.setUnavailable(reason).catch(() => {});
    }

    if (wasOnline === undefined) return; // first observation, don't fire a transition trigger
    if (wasOnline === online) return; // no change

    const app = this.homey.app;
    const tokens = { name: this.getName(), reason: reason || '' };
    if (online) {
      await app.triggerNetworkDeviceOnline.trigger(this, { name: this.getName() }).catch((err) => this.error(err));
    } else {
      await app.triggerNetworkDeviceOffline.trigger(this, tokens).catch((err) => this.error(err));
    }
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('pollInterval')) this._schedulePoll();
  }

  async onDeleted() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
  }
}

module.exports = NetworkDeviceBase;
