'use strict';

const https = require('https');
const { URL } = require('url');

/**
 * Thin client for the FortiOS REST API (monitor + a couple of cmdb calls).
 *
 * Auth: a FortiGate "REST API Admin" with an API token, sent as
 *   Authorization: Bearer <token>
 * Because the token is a bearer token (not a browser session cookie), no
 * CSRF token is required, unlike username/password + cookie based auth.
 *
 * FortiGate's management HTTPS interface almost always uses a self-signed
 * (or private CA) certificate, so `insecure: true` (skip TLS verification)
 * is offered here and is opt-in from the pairing screen. Prefer installing
 * a proper certificate on the FortiGate, or at least understand the risk,
 * before enabling it on an internet-reachable FortiGate.
 */
class FortiGateAPI {
  /**
   * @param {object} opts
   * @param {string} opts.host       IP or hostname of the FortiGate, no scheme, no port (e.g. "192.168.1.1")
   * @param {number} [opts.port]     HTTPS admin port, default 443
   * @param {string} opts.token      REST API token
   * @param {string} [opts.vdom]     VDOM name, if VDOMs are enabled. Omit for "root"/no VDOMs.
   * @param {boolean} [opts.insecure] Skip TLS certificate verification (self-signed certs)
   * @param {number} [opts.timeout]  Request timeout in ms, default 10000
   * @param {(...args:any[])=>void} [opts.log] logger, defaults to console.log
   */
  constructor({ host, port = 443, token, vdom, insecure = false, timeout = 10000, log }) {
    if (!host) throw new Error('FortiGateAPI: host is required');
    if (!token) throw new Error('FortiGateAPI: token is required');
    this.host = host;
    this.port = port;
    this.token = token;
    this.vdom = vdom;
    this.insecure = insecure;
    this.timeout = timeout;
    this.log = log || (() => {});
  }

  /**
   * Low level request helper.
   * @param {string} method GET | PUT | POST
   * @param {string} path   e.g. "/api/v2/monitor/system/status"
   * @param {object} [query] extra query string params
   * @param {object} [body]  JSON body for PUT/POST
   */
  request(method, path, query = {}, body = undefined) {
    return new Promise((resolve, reject) => {
      const url = new URL(`https://${this.host}:${this.port}${path}`);
      if (this.vdom) url.searchParams.set('vdom', this.vdom);
      for (const [k, v] of Object.entries(query || {})) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
      }

      const payload = body !== undefined ? JSON.stringify(body) : undefined;

      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || this.port,
          path: `${url.pathname}${url.search}`,
          method,
          rejectUnauthorized: !this.insecure,
          timeout: this.timeout,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            let parsed;
            try {
              parsed = data ? JSON.parse(data) : {};
            } catch (err) {
              return reject(new Error(`FortiGateAPI: invalid JSON response from ${path} (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
            }
            if (res.statusCode && res.statusCode >= 400) {
              // FortiOS's own top-level "status" field is just "success"/"error" -
              // not useful on its own - so lead with the real HTTP status and only
              // append a detail field if it says something more specific than that.
              const detail = parsed && (parsed.cli_error || parsed.error || parsed.message);
              const hint = res.statusCode === 403
                ? ' (permission denied - check the REST API admin profile has read access to this section, see README)'
                : '';
              const msg = `HTTP ${res.statusCode}${detail ? `: ${detail}` : ''}${hint}`;
              const err = new Error(`FortiGateAPI: ${method} ${path} failed: ${msg}`);
              err.statusCode = res.statusCode;
              err.body = parsed;
              return reject(err);
            }
            resolve(parsed);
          });
        }
      );

      req.on('timeout', () => req.destroy(new Error(`FortiGateAPI: timeout calling ${path}`)));
      req.on('error', (err) => reject(err));
      if (payload) req.write(payload);
      req.end();
    });
  }

  get(path, query) { return this.request('GET', path, query); }
  put(path, body, query) { return this.request('PUT', path, query, body); }
  post(path, body, query) { return this.request('POST', path, query, body); }

  /** Basic reachability + identity check, also used to validate the token during pairing. */
  async getSystemStatus() {
    const res = await this.get('/api/v2/monitor/system/status');
    return res && res.results ? res.results : res;
  }

  /**
   * Raw system/interface monitor results (array): per-interface link, role
   * (wan/lan/dmz/...) and byte counters. Some FortiOS versions return
   * `results` as an array, others as an object map keyed by interface name
   * (like switch-controller's port-stats) - both are normalised to an array
   * here, with the map key injected as `name` if the entry doesn't already
   * have one.
   */
  async getInterfaces() {
    try {
      const res = await this.get('/api/v2/monitor/system/interface');
      const results = res && res.results;
      if (Array.isArray(results)) return results;
      if (results && typeof results === 'object') {
        // The map key is the authoritative interface name - applied last so
        // it wins over any (potentially stale/differently-cased) name field
        // the entry itself might also carry.
        return Object.entries(results).map(([name, entry]) => (
          entry && typeof entry === 'object' ? { ...entry, name } : { name }
        ));
      }
      return [];
    } catch (err) {
      if (err.statusCode === 404) return [];
      throw err;
    }
  }

  /**
   * Raw managed-switch monitor results (array). See lib/mapping.js for field
   * extraction. A 404 is tolerated as "no switches" (rather than a hard
   * pairing failure) since it can mean this FortiGate genuinely has no
   * switch-controller feature - but if you have FortiSwitches and still see
   * this, the path itself may be wrong for your firmware; run
   * `node tools/inspect.js <host> <token> switches --insecure` to check.
   */
  async getManagedSwitches() {
    try {
      const res = await this.get('/api/v2/monitor/switch-controller/managed-switch/status');
      return Array.isArray(res && res.results) ? res.results : [];
    } catch (err) {
      if (err.statusCode === 404) return [];
      throw err;
    }
  }

  /** Raw switch-controller port-stats monitor results (array): per-switch, per-port cumulative tx/rx byte counters. */
  async getSwitchPortStats() {
    try {
      const res = await this.get('/api/v2/monitor/switch-controller/managed-switch/port-stats');
      return Array.isArray(res && res.results) ? res.results : [];
    } catch (err) {
      if (err.statusCode === 404) return [];
      throw err;
    }
  }

  /** Raw managed_ap monitor results (array). A 404 means no WiFi controller feature available. */
  async getManagedAPs() {
    try {
      const res = await this.get('/api/v2/monitor/wifi/managed_ap');
      return Array.isArray(res && res.results) ? res.results : [];
    } catch (err) {
      if (err.statusCode === 404) return [];
      throw err;
    }
  }

  /** Raw wifi client list (array), used to correlate/count clients per AP as a fallback. */
  async getWifiClients() {
    const res = await this.get('/api/v2/monitor/wifi/client');
    return Array.isArray(res && res.results) ? res.results : [];
  }

  /**
   * Enable/disable a PoE port on a managed switch (used for the "power cycle via PoE" action).
   * Uses the CMDB endpoint for switch-controller managed-switch port config.
   * Requires the REST API admin profile to have write access to switch-controller.
   * @param {string} switchId  the switch's "switch-id" / serial
   * @param {string} portName  e.g. "port3"
   * @param {boolean} enabled
   */
  async setPoePortEnabled(switchId, portName, enabled) {
    const body = {
      ports: [
        {
          'port-name': portName,
          'poe-status': enabled ? 'enable' : 'disable',
        },
      ],
    };
    return this.put(`/api/v2/cmdb/switch-controller/managed-switch/${encodeURIComponent(switchId)}`, body);
  }
}

module.exports = FortiGateAPI;
