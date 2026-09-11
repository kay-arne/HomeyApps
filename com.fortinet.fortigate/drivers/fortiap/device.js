'use strict';

const NetworkDeviceBase = require('../../lib/NetworkDeviceBase');
const {
  mapAP, findApPoePort, apRadioSummary,
} = require('../../lib/mapping');

const NEW_CAPABILITIES = [
  'ap_clients_2ghz',
  'ap_clients_5ghz',
  'ap_clients_6ghz',
  'ap_throughput_rx',
  'ap_throughput_tx',
  'ap_poe_watts',
  'ap_poe_class',
];

class FortiApDevice extends NetworkDeviceBase {

  async onInit() {
    this._poeChecked = false;
    await this._migrateCapabilities();
    await super.onInit();
  }

  /**
   * Devices paired before the per-band/throughput/PoE-watts capabilities
   * existed don't have them yet - add them in place. Also swaps the old
   * `measure_power` for `ap_poe_watts`: an AP's own PoE draw shouldn't count
   * toward Homey's home Energy total, since anyone tracking a switch's real
   * consumption via a smart socket on its power input would then see that
   * same draw counted twice (once via the socket, once via this AP).
   */
  async _migrateCapabilities() {
    if (this.hasCapability('measure_power')) {
      await this.removeCapability('measure_power').catch((err) => this.error(err));
    }
    for (const capabilityId of NEW_CAPABILITIES) {
      if (!this.hasCapability(capabilityId)) {
        await this.addCapability(capabilityId).catch((err) => this.error(err));
      }
    }
  }

  async _fetchState(client) {
    const [rawAPs, rawSwitches] = await Promise.all([
      client.getManagedAPs(),
      // Non-fatal: if switch-controller access fails (missing permission, or
      // this FortiGate simply has no managed FortiSwitches), the AP's own
      // connectivity/client-count must still update - it just can't be
      // correlated to a PoE port for power measurement.
      client.getManagedSwitches().catch((err) => {
        this.error('Could not fetch managed switches for PoE correlation:', err.message);
        return [];
      }),
    ]);

    const myId = this.getData().id;
    const raw = rawAPs.find((r) => String(mapAP(r).serial) === String(myId));
    if (!raw) return { found: false };

    const ap = mapAP(raw);
    this._lastRaw = ap;

    const poePort = findApPoePort(ap, rawSwitches);
    this._poePort = poePort;

    // We only find out whether this AP's power can be measured once we've
    // actually seen a managed-switch response - drop the capability if it
    // turns out we can never resolve a wattage for it, so the device tile
    // doesn't show a permanently empty field.
    if (!this._poeChecked) {
      this._poeChecked = true;
      if (!poePort && this.hasCapability('ap_poe_watts')) {
        await this.removeCapability('ap_poe_watts').catch((err) => this.error(err));
      }
    }

    const radios = apRadioSummary(ap);

    return {
      connected: ap.connected,
      capabilities: {
        // Not `measure_power`: see _migrateCapabilities() for why this
        // shouldn't count toward Homey's home Energy total.
        ap_poe_watts: poePort ? poePort.poeWatts : undefined,
        ap_client_count: ap.clientCount,
        ap_clients_2ghz: radios.clients2ghz,
        ap_clients_5ghz: radios.clients5ghz,
        ap_clients_6ghz: radios.clients6ghz,
        ap_throughput_rx: radios.throughputRxMbps,
        ap_throughput_tx: radios.throughputTxMbps,
        // Unlike ap_poe_watts, this comes straight from the AP itself (its
        // own negotiated PoE class) - works with any power source, not just
        // a FortiSwitch.
        ap_poe_class: ap.poeClass,
      },
    };
  }

  _powerCapabilityId() {
    return 'ap_poe_watts';
  }
}

module.exports = FortiApDevice;
