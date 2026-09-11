'use strict';

const Homey = require('homey');
const FortiGateAPI = require('../../lib/FortiGateAPI');
const { sumInterfaceBytes } = require('../../lib/mapping');

const DEFAULT_POLL_SECONDS = 60;

const NEW_CAPABILITIES = ['gateway_throughput_wan_rx', 'gateway_throughput_wan_tx'];

class FortiGateDevice extends Homey.Device {

  async onInit() {
    await this._migrateCapabilities();
    this._buildClient();
    await this._poll(); // establish availability immediately
    this._schedulePoll();
    this.log(`FortiGate device ${this.getName()} initialised`);
  }

  /** Devices paired before the WAN throughput capabilities existed don't have them yet - add them in place. */
  async _migrateCapabilities() {
    for (const capabilityId of NEW_CAPABILITIES) {
      if (!this.hasCapability(capabilityId)) {
        await this.addCapability(capabilityId).catch((err) => this.error(err));
      }
    }
  }

  /**
   * @param {object} [settings] Settings to build the client from. Defaults
   * to this.getSettings() - but onSettings() must pass its own `newSettings`
   * argument explicitly instead of relying on that default, since
   * getSettings() is not guaranteed to reflect the new values yet at the
   * point onSettings() runs.
   */
  _buildClient(settings) {
    const s = settings || this.getSettings();
    this.api = new FortiGateAPI({
      host: s.host,
      port: s.port || 443,
      token: s.token,
      vdom: s.vdom || undefined,
      insecure: Boolean(s.insecure),
      log: this.log.bind(this),
    });
  }

  /**
   * Used by fortiswitch/fortiap devices/drivers to reach this FortiGate's API.
   * Builds the client lazily if this device's own onInit() hasn't run yet -
   * Homey initialises devices/drivers concurrently, so a FortiSwitch/FortiAP
   * can start polling before its paired FortiGate device has finished onInit().
   */
  getClient() {
    if (!this.api) this._buildClient();
    return this.api;
  }

  _schedulePoll() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    const seconds = Number(this.getSetting('pollInterval')) || DEFAULT_POLL_SECONDS;
    this._pollTimer = this.homey.setInterval(() => this._poll().catch((err) => this.error(err)), seconds * 1000);
  }

  async _poll() {
    try {
      await this.api.getSystemStatus();
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('FortiGate unreachable:', err.message);
      await this.setUnavailable(err.message).catch(() => {});
      return;
    }

    await this._pollWanThroughput();
  }

  /**
   * Non-fatal: WAN throughput is a bonus, the gateway's own availability
   * above must not depend on it. Skipped entirely if no WAN interface names
   * are configured in settings.
   */
  async _pollWanThroughput() {
    const namesRaw = this.getSetting('wanInterfaces');
    const names = String(namesRaw || '').split(',').map((n) => n.trim()).filter(Boolean);
    if (!names.length) return;

    let rawInterfaces;
    try {
      rawInterfaces = await this.api.getInterfaces();
    } catch (err) {
      this.error('Could not fetch interfaces for WAN throughput:', err.message);
      return;
    }

    const { txBytes, rxBytes } = sumInterfaceBytes(rawInterfaces, names);
    const now = Date.now();
    const prev = this._lastWanBytes;
    this._lastWanBytes = { txBytes, rxBytes, time: now };

    if (!prev || txBytes === undefined || rxBytes === undefined
      || prev.txBytes === undefined || prev.rxBytes === undefined) {
      return;
    }

    const dtSeconds = (now - prev.time) / 1000;
    const txDelta = txBytes - prev.txBytes;
    const rxDelta = rxBytes - prev.rxBytes;
    if (dtSeconds <= 0 || txDelta < 0 || rxDelta < 0) return;

    const txMbps = (txDelta * 8) / dtSeconds / 1e6;
    const rxMbps = (rxDelta * 8) / dtSeconds / 1e6;
    await this.setCapabilityValue('gateway_throughput_wan_tx', txMbps).catch((err) => this.error(err));
    await this.setCapabilityValue('gateway_throughput_wan_rx', rxMbps).catch((err) => this.error(err));
  }

  /** Called by the shared "refresh_data" flow action. */
  async refreshNow() {
    await this._poll();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some((k) => ['host', 'port', 'vdom', 'token', 'insecure'].includes(k))) {
      this._buildClient(newSettings);
    }
    if (changedKeys.includes('pollInterval')) {
      this._schedulePoll();
    }
    if (changedKeys.includes('wanInterfaces')) {
      // The interface set changed - discard the previous byte-counter
      // sample so we don't compute one bogus delta against a different set.
      this._lastWanBytes = undefined;
    }
  }

  async onDeleted() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
  }
}

module.exports = FortiGateDevice;
