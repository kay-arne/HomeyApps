'use strict';

const NetworkDeviceBase = require('../../lib/NetworkDeviceBase');
const {
  mapSwitch, switchTotalPoeWatts, switchPortCounts, mapSwitchPortStats, switchTotalBytes,
} = require('../../lib/mapping');

const NEW_CAPABILITIES = [
  'switch_poe_watts',
  'switch_ports_online',
  'switch_ports_total',
  'switch_poe_ports_active',
  'switch_poe_ports_total',
  'switch_throughput_rx',
  'switch_throughput_tx',
];

class FortiSwitchDevice extends NetworkDeviceBase {

  async onInit() {
    await this._migrateCapabilities();
    await super.onInit();
  }

  /** Devices paired before switch_poe_watts etc. existed still have the old measure_power capability - swap it out. */
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
    const [rawList, rawPortStats] = await Promise.all([
      client.getManagedSwitches(),
      // Non-fatal: port-stats is only needed for throughput, everything
      // else about this switch should still update if it's unavailable.
      client.getSwitchPortStats().catch((err) => {
        this.error('Could not fetch port stats for throughput:', err.message);
        return [];
      }),
    ]);

    const myId = this.getData().id;
    const raw = rawList.find((r) => String(mapSwitch(r).id) === String(myId));
    if (!raw) return { found: false };

    const sw = mapSwitch(raw);
    this._lastRaw = sw; // used by powerCyclePoe() to find a PoE-capable port
    const counts = switchPortCounts(sw);

    const statsRaw = rawPortStats.find((r) => String(mapSwitchPortStats(r).id) === String(myId));
    const throughput = statsRaw ? this._computeThroughput(mapSwitchPortStats(statsRaw)) : {};

    return {
      connected: sw.connected,
      capabilities: {
        // Not `measure_power`: this is the total PoE the switch is
        // *delivering* to other devices, not its own draw from the wall -
        // counting it toward Homey's Energy total would double-count
        // against any paired FortiAP that's powered by this switch.
        switch_poe_watts: switchTotalPoeWatts(sw),
        switch_ports_online: counts.portsOnline,
        switch_ports_total: counts.portsTotal,
        switch_poe_ports_active: counts.poePortsActive,
        switch_poe_ports_total: counts.poePortsTotal,
        switch_throughput_rx: throughput.rxMbps,
        switch_throughput_tx: throughput.txMbps,
      },
    };
  }

  /**
   * port-stats only gives cumulative byte counters, not a rate - derive
   * Mbps by diffing against the previous poll's counters over the actual
   * elapsed wall-clock time (not the configured poll interval, which can
   * drift or be changed). Returns {} until a second sample is available,
   * or if the counters went backwards (a switch reboot/counter reset).
   */
  _computeThroughput(mappedPortStats) {
    const { txBytes, rxBytes } = switchTotalBytes(mappedPortStats);
    const now = Date.now();
    const prev = this._lastByteCounts;
    this._lastByteCounts = { txBytes, rxBytes, time: now };

    if (!prev || txBytes === undefined || rxBytes === undefined
      || prev.txBytes === undefined || prev.rxBytes === undefined) {
      return {};
    }

    const dtSeconds = (now - prev.time) / 1000;
    const txDelta = txBytes - prev.txBytes;
    const rxDelta = rxBytes - prev.rxBytes;
    if (dtSeconds <= 0 || txDelta < 0 || rxDelta < 0) return {};

    return {
      txMbps: (txDelta * 8) / dtSeconds / 1e6,
      rxMbps: (rxDelta * 8) / dtSeconds / 1e6,
    };
  }

  _powerCapabilityId() {
    return 'switch_poe_watts';
  }

  /** "Power cycle via PoE" flow action: toggles the first PoE-enabled port off then on. */
  async powerCyclePoe() {
    const fortigate = this.getFortiGate();
    if (!fortigate) throw new Error('The FortiGate this switch was paired through is not available.');

    const port = this._lastRaw && this._lastRaw.ports.find((p) => p.poeEnabled);
    if (!port) {
      throw new Error('No PoE-enabled port was found on this switch to power cycle. If this switch has PoE ports, try again after the next poll, or check MAPPING.md.');
    }

    const client = fortigate.getClient();
    const switchId = this.getData().id;
    await client.setPoePortEnabled(switchId, port.name, false);
    await new Promise((resolve) => this.homey.setTimeout(resolve, 5000));
    await client.setPoePortEnabled(switchId, port.name, true);
  }
}

module.exports = FortiSwitchDevice;
