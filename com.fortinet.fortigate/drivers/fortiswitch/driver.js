'use strict';

const Homey = require('homey');
const { mapSwitch } = require('../../lib/mapping');

class FortiSwitchDriver extends Homey.Driver {

  async onInit() {
    this.log('FortiSwitch driver initialised');
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
      throw new Error('Add a FortiGate device first, then pair FortiSwitches.');
    }

    try {
      const rawSwitches = await fortigate.getClient().getManagedSwitches();

      return rawSwitches
        .map(mapSwitch)
        .filter((sw) => sw.id)
        .map((sw) => ({
          name: sw.name,
          data: { id: String(sw.id) },
          store: { fortigateId: fortigate.getData().id },
          capabilities: [
            'switch_poe_watts',
            'switch_ports_online',
            'switch_ports_total',
            'switch_poe_ports_active',
            'switch_poe_ports_total',
            'switch_throughput_rx',
            'switch_throughput_tx',
          ],
          settings: { pollInterval: 60 },
        }));
    } catch (err) {
      this.error('onPairListDevices failed:', err);
      throw err;
    }
  }
}

module.exports = FortiSwitchDriver;
