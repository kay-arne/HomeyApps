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
];

class FortiApDevice extends NetworkDeviceBase {

  async onInit() {
    this._poeChecked = false;
    await this._migrateCapabilities();
    await super.onInit();
  }

  /** Devices paired before the per-band/throughput capabilities existed don't have them yet - add them in place. */
  async _migrateCapabilities() {
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
    // doesn't show a permanently empty Energy field.
    if (!this._poeChecked) {
      this._poeChecked = true;
      if (!poePort && this.hasCapability('measure_power')) {
        await this.removeCapability('measure_power').catch((err) => this.error(err));
      }
    }

    const radios = apRadioSummary(ap);

    return {
      connected: ap.connected,
      capabilities: {
        measure_power: poePort ? poePort.poeWatts : undefined,
        ap_client_count: ap.clientCount,
        ap_clients_2ghz: radios.clients2ghz,
        ap_clients_5ghz: radios.clients5ghz,
        ap_clients_6ghz: radios.clients6ghz,
        ap_throughput_rx: radios.throughputRxMbps,
        ap_throughput_tx: radios.throughputTxMbps,
      },
    };
  }

  _powerCapabilityId() {
    return 'measure_power';
  }
}

module.exports = FortiApDevice;
