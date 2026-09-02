const assert = require('assert');
const Module = require('module');

// ProxmoxClient requires 'node-fetch' and 'homey' at the top of the file. Neither is
// resolvable in a plain Node test run (node-fetch needs a live network call to matter here,
// and 'homey' only exists inside the actual Homey runtime) - so we intercept both at the
// module-loader level before requiring the file under test.
let fetchImpl = async () => { throw new Error('fetchImpl not set for this test'); };

const originalLoad = Module._load;
Module._load = function intercept(request, parent, isMain) {
  if (request === 'node-fetch') return (...args) => fetchImpl(...args);
  if (request === 'homey') return { __: (key) => key };
  return originalLoad.apply(this, arguments);
};

const ProxmoxClient = require('../lib/ProxmoxClient');

Module._load = originalLoad; // restore immediately, only ProxmoxClient itself needs the mocks

const CREDENTIALS = {
  hostname: 'pve.test.local',
  username: 'homey@pve',
  tokenId: 'mytoken',
  tokenSecret: 'secret-value-123',
};

async function testAuthHeader() {
  console.log('Testing ProxmoxClient auth header...');
  const client = new ProxmoxClient(CREDENTIALS);

  let capturedHeaders = null;
  fetchImpl = async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, text: async () => '{"data":"ok"}' };
  };

  await client.request(null, '/api2/json/version');

  assert.strictEqual(
    capturedHeaders.Authorization,
    'PVEAPIToken=homey@pve!mytoken=secret-value-123',
    'Authorization header should be PVEAPIToken=<user>!<tokenId>=<secret>',
  );
  console.log('Auth header test passed!');
}

async function testTargetHostOverride() {
  console.log('Testing ProxmoxClient target host override...');
  const client = new ProxmoxClient(CREDENTIALS);

  let capturedUrl = null;
  fetchImpl = async (url) => {
    capturedUrl = url;
    return { ok: true, text: async () => '{}' };
  };

  await client.request('10.0.0.5', '/api2/json/version');
  assert.strictEqual(capturedUrl, 'https://10.0.0.5:8006/api2/json/version');

  await client.request(null, '/api2/json/version');
  assert.strictEqual(capturedUrl, `https://${CREDENTIALS.hostname}:8006/api2/json/version`);
  console.log('Target host override test passed!');
}

async function testCustomPort() {
  console.log('Testing ProxmoxClient custom port (reverse proxy setup)...');
  const client = new ProxmoxClient({ ...CREDENTIALS, port: 8443 });

  let capturedUrl = null;
  fetchImpl = async (url) => {
    capturedUrl = url;
    return { ok: true, text: async () => '{}' };
  };

  // Primary (configured) host uses the custom port
  await client.request(null, '/api2/json/version');
  assert.strictEqual(capturedUrl, `https://${CREDENTIALS.hostname}:8443/api2/json/version`);

  // A different (auto-discovered backup/failover) host uses the same custom port - a reverse
  // proxy is typically the single ingress for the whole cluster, including failover targets.
  await client.request('10.0.0.5', '/api2/json/version');
  assert.strictEqual(capturedUrl, 'https://10.0.0.5:8443/api2/json/version');

  // No port configured -> everyone falls back to the standard 8006
  const defaultClient = new ProxmoxClient(CREDENTIALS);
  await defaultClient.request('10.0.0.5', '/api2/json/version');
  assert.strictEqual(capturedUrl, 'https://10.0.0.5:8006/api2/json/version');

  console.log('Custom port test passed!');
}

async function testTimeout() {
  console.log('Testing ProxmoxClient timeout/abort...');
  const client = new ProxmoxClient(CREDENTIALS, { timeout: 100 });

  // Never resolves - the request should reject via the timeout race, not hang forever.
  fetchImpl = () => new Promise(() => {});

  const start = Date.now();
  await assert.rejects(
    client.request(null, '/api2/json/version', { timeout: 100 }),
    (err) => {
      assert.strictEqual(err.code, 'ETIMEDOUT');
      return true;
    },
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `Timeout should fire close to the configured 100ms, took ${elapsed}ms`);
  console.log('Timeout test passed!');
}

async function testErrorStatusCode() {
  console.log('Testing ProxmoxClient non-2xx handling...');
  const client = new ProxmoxClient(CREDENTIALS);

  fetchImpl = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => 'invalid token',
  });

  await assert.rejects(
    client.request(null, '/api2/json/version'),
    (err) => {
      assert.strictEqual(err.statusCode, 401);
      return true;
    },
  );
  console.log('Non-2xx handling test passed!');
}

async function testAgentReuse() {
  console.log('Testing ProxmoxClient https.Agent reuse...');
  const client = new ProxmoxClient(CREDENTIALS);

  const agentA1 = client._createAgent();
  const agentA2 = client._createAgent();
  assert.strictEqual(agentA1, agentA2, 'Same trust setting should reuse one Agent instance (keeps keepAlive pooling effective)');

  client.updateCredentials({ ...CREDENTIALS, allow_self_signed_certs: true });
  const agentB = client._createAgent();
  assert.notStrictEqual(agentA1, agentB, 'Different trust setting should get its own Agent instance');
  assert.strictEqual(agentB.options.rejectUnauthorized, false);
  assert.strictEqual(agentA1.options.rejectUnauthorized, true);

  console.log('Agent reuse test passed!');
}

async function run() {
  try {
    await testAuthHeader();
    await testTargetHostOverride();
    await testCustomPort();
    await testTimeout();
    await testErrorStatusCode();
    await testAgentReuse();
    console.log('All ProxmoxClient tests passed!');
  } catch (e) {
    console.error('Test Failed:', e);
    process.exit(1);
  }
}

run();
