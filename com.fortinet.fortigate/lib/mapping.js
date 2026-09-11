'use strict';

/**
 * FortiOS monitor API field names shift a bit between firmware branches
 * (6.4 / 7.0 / 7.2 / 7.4 / 7.6) and even between switch/AP models. Rather
 * than hard-code one exact schema and silently show 0 W when it doesn't
 * match your firmware, every getter below tries a short list of likely
 * key spellings and falls back gracefully.
 *
 * If a value you expect (e.g. PoE watts) keeps coming back as `null`,
 * run the inspector to see your FortiGate's actual JSON and add the real
 * key to the relevant list below:
 *
 *   node tools/inspect.js <host> <token> switches
 *   node tools/inspect.js <host> <token> aps
 *
 * See MAPPING.md for a full walkthrough.
 */

/** Case/hyphen/underscore-insensitive lookup of the first matching key present on `obj`. */
function pick(obj, candidates) {
  if (!obj || typeof obj !== 'object') return undefined;
  const norm = (s) => String(s).toLowerCase().replace(/[-_ ]/g, '');
  const keys = Object.keys(obj);
  for (const candidate of candidates) {
    const target = norm(candidate);
    const found = keys.find((k) => norm(k) === target);
    if (found !== undefined && obj[found] !== undefined && obj[found] !== null) return obj[found];
  }
  return undefined;
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** A managed-switch entry -> { id, name, connected, osVersion, ports: [...] } */
function mapSwitch(raw) {
  const id = pick(raw, ['switch-id', 'switch_id', 'serial', 'id']);
  const name = pick(raw, ['name', 'switch-name', 'hostname']) || id;
  const stateRaw = pick(raw, ['state', 'status', 'connecting-status', 'connection_state']);
  const connected = typeof stateRaw === 'string'
    ? /connect|online|up|author/i.test(stateRaw) && !/disconnect|offline|down/i.test(stateRaw)
    : undefined;
  const osVersion = pick(raw, ['os-version', 'os_version', 'version']);
  const portsRaw = pick(raw, ['ports', 'port-list', 'poe-detail']) || [];
  const ports = Array.isArray(portsRaw) ? portsRaw.map(mapPort) : [];
  return { id, name, connected, osVersion, ports, raw };
}

/** A single port entry (within a managed-switch) -> { name, linkUp, poeCapable, poeEnabled, poeWatts } */
function mapPort(raw) {
  const name = pick(raw, ['interface', 'port-name', 'port_name', 'name']);

  // "status" at the port level is FortiOS's link status (e.g. "up"/"down"),
  // distinct from the switch-level state/status fields mapSwitch() reads.
  const linkStatusRaw = pick(raw, ['status', 'link-status', 'link_status']);
  const linkUp = typeof linkStatusRaw === 'string'
    ? /up/i.test(linkStatusRaw) && !/down/i.test(linkStatusRaw)
    : undefined;

  const poeCapableRaw = pick(raw, ['poe_capable', 'poe-capable']);
  const poeCapable = typeof poeCapableRaw === 'boolean' ? poeCapableRaw : undefined;

  // power_status is FortiOS's numeric PoE state (0=Disabled, 1=Searching,
  // 2=Delivering power, 3=Test mode, 4=Fault, 5=Other fault, 6=Requires
  // power) per the official monitor API schema - 2 means power is actually
  // being delivered on this port, which is the most reliable "enabled"
  // signal when present. poe_status (a string) is the fallback for
  // firmware/endpoints that don't report power_status.
  const powerStatusRaw = pick(raw, ['power_status', 'power-status']);
  const poeStatusRaw = pick(raw, ['poe-status', 'poe_status']);
  const poeEnabled = powerStatusRaw !== undefined
    ? toNumber(powerStatusRaw) === 2
    : (typeof poeStatusRaw === 'string' ? /enable|up|on/i.test(poeStatusRaw) : undefined);

  const poeWattsRaw = pick(raw, [
    'port_power', 'port-power', 'poe-power', 'poe_power', 'power', 'poe-detected-power', 'detected-power',
    'power-consumption', 'poe-power-consumption', 'poe-consumption',
  ]);
  // FortiOS sometimes reports milliwatts under a "*-mw" style key.
  const poeMilliwattsRaw = pick(raw, ['poe-power-mw', 'power-mw', 'poe_power_mw']);
  let poeWatts = toNumber(poeWattsRaw);
  if (poeWatts === undefined) {
    const mw = toNumber(poeMilliwattsRaw);
    if (mw !== undefined) poeWatts = mw / 1000;
  }
  return { name, linkUp, poeCapable, poeEnabled, poeWatts, raw };
}

/** Sum of all known per-port PoE wattage on a mapped switch. Returns undefined if nothing was found at all. */
function switchTotalPoeWatts(mappedSwitch) {
  const known = mappedSwitch.ports.map((p) => p.poeWatts).filter((w) => w !== undefined);
  if (!known.length) return undefined;
  return known.reduce((a, b) => a + b, 0);
}

/**
 * Port-level summary counters for a mapped switch -> { portsOnline, portsTotal,
 * poePortsActive, poePortsTotal }. poePortsTotal counts ports capable of PoE
 * (regardless of whether anything is currently plugged in); poePortsActive
 * counts ports currently delivering power.
 */
function switchPortCounts(mappedSwitch) {
  const ports = mappedSwitch.ports;
  const portsTotal = ports.length;
  const portsOnline = ports.filter((p) => p.linkUp === true).length;
  const poePortsTotal = ports.filter((p) => p.poeCapable === true).length;
  const poePortsActive = ports.filter((p) => p.poeEnabled === true).length;
  return {
    portsOnline, portsTotal, poePortsActive, poePortsTotal,
  };
}

/**
 * A managed-switch/port-stats entry -> { id, ports: { <portName>: { txBytes, rxBytes } } }.
 * Unlike mapSwitch()'s ports (an array), port-stats reports ports as an
 * object keyed by port name per the official monitor API schema.
 */
function mapSwitchPortStats(raw) {
  const id = pick(raw, ['switch-id', 'switch_id', 'serial', 'id']);
  const portsRaw = pick(raw, ['ports']) || {};
  const ports = {};
  if (portsRaw && typeof portsRaw === 'object') {
    for (const [portName, statsRaw] of Object.entries(portsRaw)) {
      ports[portName] = {
        txBytes: toNumber(pick(statsRaw, ['tx-bytes', 'tx_bytes'])),
        rxBytes: toNumber(pick(statsRaw, ['rx-bytes', 'rx_bytes'])),
      };
    }
  }
  return { id, ports, raw };
}

/** Sum of all ports' cumulative tx/rx byte counters -> { txBytes, rxBytes } (a field is undefined if no port reported it). */
function switchTotalBytes(mappedPortStats) {
  const entries = Object.values(mappedPortStats.ports);
  const tx = entries.map((p) => p.txBytes).filter((v) => v !== undefined);
  const rx = entries.map((p) => p.rxBytes).filter((v) => v !== undefined);
  return {
    txBytes: tx.length ? tx.reduce((a, b) => a + b, 0) : undefined,
    rxBytes: rx.length ? rx.reduce((a, b) => a + b, 0) : undefined,
  };
}

/**
 * A single radio entry (within a managed_ap) -> { radioId, mode, radioType,
 * band, active, clientCount, bandwidthRxBps, bandwidthTxBps }. `active` means
 * mode is "AP" (actually serving an SSID) as opposed to Monitor/Disabled/
 * "Virtual Lan AP"/"Not Exist". `bandwidthRxBps`/`bandwidthTxBps` are
 * FortiOS's own short-term smoothed throughput sample in bytes/sec - already
 * a rate, unlike the switch port-stats counters which are cumulative.
 */
function mapRadio(raw) {
  const radioId = toNumber(pick(raw, ['radio_id', 'radio-id']));
  const mode = pick(raw, ['mode']);
  const active = mode === 'AP';
  const radioType = pick(raw, ['radio_type', 'radio-type']);
  let band;
  if (typeof radioType === 'string') {
    if (/6g/i.test(radioType)) band = '6ghz';
    else if (/5g/i.test(radioType)) band = '5ghz';
    else if (/2g/i.test(radioType)) band = '2ghz';
  }
  const clientCount = toNumber(pick(raw, ['client_count', 'client-count']));
  const bandwidthRxBps = toNumber(pick(raw, ['bandwidth_rx', 'bandwidth-rx']));
  const bandwidthTxBps = toNumber(pick(raw, ['bandwidth_tx', 'bandwidth-tx']));
  return {
    radioId, mode, radioType, band, active, clientCount, bandwidthRxBps, bandwidthTxBps, raw,
  };
}

/** A managed_ap entry -> { serial, name, connected, ip, uplinkSwitchId, uplinkPort, radios, clientCount } */
function mapAP(raw) {
  const serial = pick(raw, ['serial', 'wtp-id', 'wtp_id', 'id']);
  const name = pick(raw, ['name', 'wtp-name', 'hostname']) || serial;
  const stateRaw = pick(raw, ['connection_state', 'connection-state', 'status', 'state']);
  const connected = typeof stateRaw === 'string'
    ? /connect|online|up/i.test(stateRaw) && !/disconnect|offline|down/i.test(stateRaw)
    : undefined;
  const ip = pick(raw, ['local_addr', 'local_ipv4_addr', 'local-ipv4-addr', 'ip', 'ipv4-address']);

  // The most reliable way to find which switch port powers this AP is its
  // LLDP neighbor info (system_name/port_id of the switch it's plugged
  // into) - a mesh/L3-connected AP reports no usable switch-id/port fields
  // directly on the AP object itself (connecting_from can be an IP, not a
  // port name). Older/direct-FortiLink deployments may still expose those
  // fields directly, so they're kept as a fallback.
  const lldpRaw = pick(raw, ['lldp']);
  const lldpEntry = Array.isArray(lldpRaw) ? lldpRaw[0] : undefined;
  const lldpSwitchId = lldpEntry ? pick(lldpEntry, ['system_name', 'system-name']) : undefined;
  const lldpPort = lldpEntry ? pick(lldpEntry, ['port_id', 'port-id']) : undefined;
  const uplinkSwitchId = lldpSwitchId || pick(raw, ['switch-id', 'switch_id', 'board-mac', 'uplink-switch-serial']);
  const uplinkPort = lldpPort || pick(raw, ['connecting-from', 'connecting_from', 'port', 'wtp-port']);

  const radiosRaw = pick(raw, ['radio', 'radios']) || [];
  const radios = Array.isArray(radiosRaw) ? radiosRaw.map(mapRadio) : [];
  const clientCountFromRadios = radios.length
    ? radios.reduce((sum, r) => sum + (r.clientCount || 0), 0)
    : undefined;
  const clientCount = clientCountFromRadios !== undefined
    ? clientCountFromRadios
    : toNumber(pick(raw, ['clients', 'client-count', 'client_count']));

  // The AP reports its own negotiated PoE class directly - unlike the actual
  // wattage (which needs switch-side port correlation, see findApPoePort()),
  // this works for any AP regardless of whether it's powered by a
  // FortiSwitch, a third-party switch, or a plain injector. poe_mode_oper is
  // the currently-active class ("full"/"high"/"auto"); poe_mode (which may
  // carry a "(auto)" suffix, e.g. "full(auto)") is the configured fallback.
  // "invalid" means FortiOS has nothing meaningful to report here.
  const poeModeRaw = pick(raw, ['poe_mode_oper', 'poe-mode-oper']) || pick(raw, ['poe_mode', 'poe-mode']);
  let poeClass;
  if (typeof poeModeRaw === 'string') {
    const word = poeModeRaw.split(/[^a-z]/i)[0];
    if (word && word.toLowerCase() !== 'invalid') {
      poeClass = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
  }

  return {
    serial, name, connected, ip, uplinkSwitchId, uplinkPort, radios, clientCount, poeClass, raw,
  };
}

/**
 * Per-band client + throughput summary for a mapped AP's *active* radios
 * (mode "AP") -> { clients2ghz, clients5ghz, clients6ghz, throughputRxMbps,
 * throughputTxMbps }. Any value is undefined if no active radio reported it
 * (e.g. no 6GHz radio present or enabled).
 */
function apRadioSummary(mappedAP) {
  const activeRadios = mappedAP.radios.filter((r) => r.active);
  const byBand = (band) => activeRadios.filter((r) => r.band === band);
  const sumClients = (band) => {
    const known = byBand(band).map((r) => r.clientCount).filter((v) => v !== undefined);
    return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
  };

  const rxKnown = activeRadios.map((r) => r.bandwidthRxBps).filter((v) => v !== undefined);
  const txKnown = activeRadios.map((r) => r.bandwidthTxBps).filter((v) => v !== undefined);

  return {
    clients2ghz: sumClients('2ghz'),
    clients5ghz: sumClients('5ghz'),
    clients6ghz: sumClients('6ghz'),
    throughputRxMbps: rxKnown.length ? (rxKnown.reduce((a, b) => a + b, 0) * 8) / 1e6 : undefined,
    throughputTxMbps: txKnown.length ? (txKnown.reduce((a, b) => a + b, 0) * 8) / 1e6 : undefined,
  };
}

/**
 * Best-effort correlation of a FortiAP to the PoE port that powers it, using
 * the uplink switch id + port FortiOS reports on the AP entry. Returns the
 * mapped port (with .poeWatts) or undefined if it can't be resolved - which
 * is expected for APs powered by a non-FortiSwitch PoE source or a plain
 * power adapter.
 * @param {object} mappedAP result of mapAP()
 * @param {object[]} rawSwitches raw results from getManagedSwitches()
 */
function findApPoePort(mappedAP, rawSwitches) {
  if (!mappedAP.uplinkSwitchId || !mappedAP.uplinkPort) return undefined;
  const sw = (rawSwitches || []).map(mapSwitch).find((s) => String(s.id) === String(mappedAP.uplinkSwitchId));
  if (!sw) return undefined;
  return sw.ports.find((p) => String(p.name) === String(mappedAP.uplinkPort) && p.poeEnabled);
}

/** A system/interface monitor entry -> { name, linkUp, txBytes, rxBytes }. */
function mapInterface(raw) {
  const name = pick(raw, ['name', 'id']);
  const linkRaw = pick(raw, ['link']);
  const linkUp = typeof linkRaw === 'boolean' ? linkRaw : undefined;
  const txBytes = toNumber(pick(raw, ['tx_bytes', 'tx-bytes']));
  const rxBytes = toNumber(pick(raw, ['rx_bytes', 'rx-bytes']));
  return {
    name, linkUp, txBytes, rxBytes, raw,
  };
}

/**
 * Sum of cumulative tx/rx byte counters across whichever of `rawInterfaces`
 * has a name matching `names` (case-insensitive) -> { txBytes, rxBytes }.
 * `names` is typically a user-configured list of WAN interface names, since
 * FortiOS's monitor API doesn't expose each interface's configured role
 * (wan/lan/dmz) - that's CMDB config, not a live stat. Returns {} if `names`
 * is empty or none matched.
 */
function sumInterfaceBytes(rawInterfaces, names) {
  const wanted = (names || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) return {};

  const matched = (rawInterfaces || [])
    .map(mapInterface)
    .filter((iface) => iface.name && wanted.includes(String(iface.name).toLowerCase()));

  const tx = matched.map((i) => i.txBytes).filter((v) => v !== undefined);
  const rx = matched.map((i) => i.rxBytes).filter((v) => v !== undefined);
  return {
    txBytes: tx.length ? tx.reduce((a, b) => a + b, 0) : undefined,
    rxBytes: rx.length ? rx.reduce((a, b) => a + b, 0) : undefined,
  };
}

module.exports = {
  pick,
  toNumber,
  mapSwitch,
  mapPort,
  switchTotalPoeWatts,
  switchPortCounts,
  mapSwitchPortStats,
  switchTotalBytes,
  mapRadio,
  mapAP,
  apRadioSummary,
  findApPoePort,
  mapInterface,
  sumInterfaceBytes,
};
