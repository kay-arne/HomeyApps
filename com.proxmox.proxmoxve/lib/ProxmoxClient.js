'use strict';

const fetch = require('node-fetch');
const https = require('https');

class ProxmoxClient {

  constructor(credentials, options = {}) {
    this._credentials = credentials;
    this._options = options;
    this._validateCredentials(credentials);
  }

  _validateCredentials(credentials) {
    if (!credentials) throw new Error('Credentials are required');
    if (!credentials.hostname) throw new Error('Hostname is required');
    if (!credentials.username) throw new Error('Username is required');
    if (!credentials.tokenId) throw new Error('Token ID is required');
    if (!credentials.tokenSecret) throw new Error('Token Secret is required');
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
    
    return new https.Agent({
      rejectUnauthorized,
      timeout: this._options.timeout || 15000,
      keepAlive: true,
      maxSockets: 5
    });
  }

  async request(host, path, options = {}) {
    // Determine host to use: override provided in options, or default from credentials
    const targetHost = host || this._credentials.hostname;
    const url = `https://${targetHost}:8006${path}`;
    
    const method = options.method || 'GET';
    const timeout = options.timeout || this._options.timeout || 15000;

    const headers = {
      'Authorization': this._getAuthHeader(),
      'Accept': 'application/json',
      'User-Agent': 'Homey-ProxmoxVE/1.0',
      ...options.headers
    };

    const fetchOptions = {
      method,
      headers,
      agent: this._createAgent(),
      timeout
    };

    if (method === 'POST' && options.body) {
      if (typeof options.body === 'object') {
        // If body is object and not form-urlencoded string, assume JSON or form need
        // For Proxmox, usually query string format or www-form-urlencoded
        // Simplest generic approach if not manually formatted:
        // (Existing code used manual body string construction, checking that)
         fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
         fetchOptions.body = options.body; // Expecting string or URLSearchParams
      } else {
         fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
         fetchOptions.body = options.body;
      }
    }

    try {
      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
         let errorBody = `(Status: ${response.status} ${response.statusText})`;
         try { errorBody = await response.text(); } catch (e) {}
         
         // Custom error object to distinguish API errors
         const error = new Error(`API Error ${response.status}: ${errorBody.substring(0, 200)}`);
         error.statusCode = response.status;
         error.responseBody = errorBody;
         throw error;
      }

      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        return text || null; // Return text if not JSON
      }

    } catch (error) {
       // Enrich error for upper layers
       if (error.type === 'request-timeout') {
           error.code = 'ETIMEDOUT';
       }
       throw error;
    }
  }
}

module.exports = ProxmoxClient;
