'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const FortiGateAPI = require('../../lib/FortiGateAPI');

class FortiGateDriver extends Homey.Driver {

  async onInit() {
    this.log('FortiGate driver initialised');
  }

  onPair(session) {
    session.setHandler('test_connection', async (data) => {
      if (!data || !data.host || !data.token) {
        throw new Error('Host and API token are required');
      }

      const api = new FortiGateAPI({
        host: data.host,
        port: data.port ? Number(data.port) : undefined,
        token: data.token,
        vdom: data.vdom || undefined,
        insecure: Boolean(data.insecure),
        log: this.log.bind(this),
      });

      const status = await api.getSystemStatus();
      const serial = status && (status.serial || status['serial-number'] || status.serial_number);
      const hostname = (status && (status.hostname || status.name)) || data.host;
      const webhookSecret = crypto.randomBytes(16).toString('hex');

      return {
        name: `FortiGate (${hostname})`,
        data: {
          id: serial || `fgt-${data.host}`,
        },
        store: {
          webhookSecret,
        },
        settings: {
          host: data.host,
          port: data.port ? Number(data.port) : 443,
          vdom: data.vdom || '',
          token: data.token,
          insecure: Boolean(data.insecure),
          pollInterval: 60,
          wanInterfaces: '',
          webhookSecret,
        },
      };
    });
  }
}

module.exports = FortiGateDriver;
