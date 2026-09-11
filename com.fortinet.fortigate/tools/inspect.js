#!/usr/bin/env node
'use strict';

/**
 * Standalone inspector: dumps the raw FortiOS monitor API JSON so you can
 * verify (and if needed adjust) the field names lib/mapping.js looks for.
 * Does not require Homey at all — run it from your own machine.
 *
 * Usage:
 *   node tools/inspect.js <host> <token> <endpoint> [--insecure] [--vdom=root] [--port=443]
 *
 * <endpoint> is one of: status | switches | port-stats | aps | clients | interfaces
 *
 * Example:
 *   node tools/inspect.js 192.168.1.1 ABCDEF123456 switches --insecure
 */

const FortiGateAPI = require('../lib/FortiGateAPI');

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = Object.fromEntries(
    argv.filter((a) => a.startsWith('--')).map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v === undefined ? true : v];
    })
  );
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [host, token, endpoint] = positional;

  if (!host || !token || !endpoint) {
    console.error(__filename.split('/').slice(-2).join('/') + ': missing arguments\n');
    console.error('Usage: node tools/inspect.js <host> <token> <status|switches|port-stats|aps|clients|interfaces> [--insecure] [--vdom=root] [--port=443]');
    process.exit(1);
  }

  const api = new FortiGateAPI({
    host,
    token,
    insecure: Boolean(flags.insecure),
    vdom: flags.vdom,
    port: flags.port ? Number(flags.port) : undefined,
  });

  const map = {
    status: () => api.getSystemStatus(),
    switches: () => api.getManagedSwitches(),
    'port-stats': () => api.getSwitchPortStats(),
    aps: () => api.getManagedAPs(),
    clients: () => api.getWifiClients(),
    interfaces: () => api.getInterfaces(),
  };

  if (!map[endpoint]) {
    console.error(`Unknown endpoint "${endpoint}". Choose one of: ${Object.keys(map).join(', ')}`);
    process.exit(1);
  }

  try {
    const result = await map[endpoint]();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Request failed:', err.message);
    if (!flags.insecure) {
      console.error('\nIf this is a self-signed certificate error, retry with --insecure.');
    }
    process.exit(1);
  }
}

main();
