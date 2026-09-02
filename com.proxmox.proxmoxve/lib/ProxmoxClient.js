'use strict';

const fetch = require('node-fetch');
const https = require('https');
const Homey = require('homey');

class ProxmoxClient {

  constructor(credentials, options = {}) {
    this._credentials = credentials;
    this._options = options;
    this._validateCredentials(credentials);
    this._agents = new Map(); // rejectUnauthorized => https.Agent (shared, keeps keepAlive pooling effective)
  }

  _validateCredentials(credentials) {
    if (!credentials) throw new Error(`${Homey.__('error.device_context_missing')} (Credentials missing)`);
    if (!credentials.hostname) throw new Error(`${Homey.__('error.device_context_missing')} (Hostname missing)`);
    if (!credentials.username) throw new Error(`${Homey.__('error.device_context_missing')} (Username missing)`);
    if (!credentials.tokenId) throw new Error(`${Homey.__('error.device_context_missing')} (TokenID missing)`);
    if (!credentials.tokenSecret) throw new Error(`${Homey.__('error.device_context_missing')} (TokenSecret missing)`);
  }

  updateCredentials(newCredentials) {
    this._validateCredentials(newCredentials);
    this._credentials = newCredentials;
  }

  getCredentials() {
    return this._credentials;
  }

  _getAuthHeader() {
    return `PVEAPIToken=${this._credentials.username}!${this._credentials.tokenId}=${this._credentials.tokenSecret}`;
  }

  _createAgent() {
    // Respect allow_self_signed_certs option
    // If undefined, default to false (secure by default)
    const rejectUnauthorized = !this._credentials.allow_self_signed_certs;

    // Reuse one Agent per trust setting so `keepAlive` connection pooling actually applies
    // (Node's http.Agent already multiplexes per-host internally, so no need to key by host).
    let agent = this._agents.get(rejectUnauthorized);
    if (!agent) {
      agent = new https.Agent({
        rejectUnauthorized,
        timeout: this._options.timeout || 15000,
        keepAlive: true,
        maxSockets: 5,
      });
      this._agents.set(rejectUnauthorized, agent);
    }
    return agent;
  }

  async request(host, path, options = {}) {
    // Determine host to use: override provided in options, or default from credentials
    const targetHost = host || this._credentials.hostname;

    // The configured port applies to every host we talk to, not just the primary one - a
    // reverse proxy in front of the cluster is typically the single ingress for all access,
    // including failover targets, so backup/failover nodes need the same port too.
    const port = this._credentials.port || 8006;
    const url = `https://${targetHost}:${port}${path}`;

    const method = options.method || 'GET';
    const timeout = options.timeout || this._options.timeout || 15000;

    const controller = new AbortController();
    const headers = {
      Authorization: this._getAuthHeader(),
      Accept: 'application/json',
      'User-Agent': 'Homey-ProxmoxVE/1.0',
      ...options.headers,
    };

    const fetchOptions = {
      method,
      headers,
      agent: this._createAgent(),
      signal: controller.signal,
      // timeout removed here, handled via Promise.race
    };

    if (method === 'POST' && options.body) {
      if (typeof options.body === 'object') {
        fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        fetchOptions.body = options.body;
      } else {
        fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        fetchOptions.body = options.body;
      }
    }

    // Strict Timeout Implementation
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      // eslint-disable-next-line homey-app/global-timers
      timeoutId = setTimeout(() => {
        controller.abort();
        const err = new Error(`Request timed out after ${timeout}ms`);
        err.type = 'request-timeout';
        err.code = 'ETIMEDOUT';
        reject(err);
      }, timeout);
    });

    try {

      const response = await Promise.race([
        fetch(url, fetchOptions),
        timeoutPromise,
      ]);

      // Clear timeout if fetch completes first
      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorBody = `(Status: ${response.status} ${response.statusText})`;
        try {
          errorBody = await response.text();
        } catch (e) { }

        const error = new Error(`API Error ${response.status}: ${errorBody.substring(0, 200)}`);
        error.statusCode = response.status;
        error.responseBody = errorBody;
        throw error;
      }

      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        return text || null;
      }

    } catch (error) {
      clearTimeout(timeoutId); // Ensure cleanup

      if (error.type === 'request-timeout' || error.name === 'AbortError') {
        error.code = 'ETIMEDOUT';
      }
      throw error;
    }
  }
}

module.exports = ProxmoxClient;
