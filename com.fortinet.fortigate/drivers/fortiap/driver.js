'use strict';

const Homey = require('homey');
const { mapAP } = require('../../lib/mapping');

class FortiApDriver extends Homey.Driver {

  async onInit() {
    this.log('FortiAP driver initialised');
  }

  onPair(session) {
    session.setHandler('list_fortigates', async () => {
      const driver = this.homey.drivers.getDriver('fortigate');
      return driver.getDevices().map((d) => ({ id: d.getData().id, name: d.getName() }));
    });

    session.setHandler('select_fortigate', async ({ id }) => {
      this._pairingFortiGateId = id;
      return true;
    });

    // Overriding onPair() replaces the SDK's default wiring of the built-in
    // "list_devices" pair template to onPairListDevices() - it has to be
    // registered explicitly here too.
    session.setHandler('list_devices', async () => this.onPairListDevices());
  }

  async onPairListDevices() {
    const fortigateDriver = this.homey.drivers.getDriver('fortigate');
    const fortigates = fortigateDriver.getDevices();
    const fortigate = (this._pairingFortiGateId && fortigates.find((d) => d.getData().id === this._pairingFortiGateId))
      || fortigates[0];

    if (!fortigate) {
      throw new Error('Add a FortiGate device first, then pair FortiAPs.');
    }

    try {
      const rawAPs = await fortigate.getClient().getManagedAPs();

      return rawAPs
        .map(mapAP)
        .filter((ap) => ap.serial)
        .map((ap) => ({
          name: ap.name,
          data: { id: String(ap.serial) },
          store: { fortigateId: fortigate.getData().id },
          capabilities: [
            'ap_client_count',
            'ap_clients_2ghz',
            'ap_clients_5ghz',
            'ap_clients_6ghz',
            'ap_throughput_rx',
            'ap_throughput_tx',
            'ap_poe_watts',
            'ap_poe_class',
          ],
          settings: { pollInterval: 60 },
        }));
    } catch (err) {
      this.error('onPairListDevices failed:', err);
      throw err;
    }
  }
}

module.exports = FortiApDriver;
