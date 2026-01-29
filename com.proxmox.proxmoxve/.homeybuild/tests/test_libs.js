const assert = require('assert');
const HostManager = require('../lib/HostManager');

// Mock Logger
const logger = (...args) => { }; // console.log('LOG:', ...args);

// Check Host Manager Logic
async function testHostManager() {
  console.log('Testing HostManager...');
  const hm = new HostManager(logger);

  // 1. Initialize
  hm.initialize('primary.local', ['backup.local', 'primary.local']);
  assert.strictEqual(hm.primaryHost, 'primary.local');
  assert.strictEqual(hm.preferredHost, 'primary.local');

  // 2. Sorting: Faster host should win if not primary
  // Update backup to be super fast
  hm.updateHostStatus('backup.local', true, 10); // 10ms
  hm.updateHostStatus('primary.local', true, 500); // 500ms

  // Recalculate preference
  // Primary Score: 1000 - 500 - 0 + 50 = 550
  // Backup Score: 1000 - 10 - 0 + 0 = 990
  // Backup should be preferred now
  assert.strictEqual(hm.preferredHost, 'backup.local', 'Backup should be preferred due to speed');

  // 3. Circuit Breaker
  for (let i = 0; i < 3; i++) {
    hm.updateHostStatus('backup.local', false);
  }
  // Backup should now be OPEN (broken)
  // Preferred should revert to Primary (or nothing if primary was also broken, but primary is ok here)
  assert.strictEqual(hm._getCircuitBreakerState('backup.local'), 'open');

  // List should exclude backup
  const list = hm.getOrderedHostList();
  assert.ok(!list.includes('backup.local'), 'Broken host should be excluded');
  assert.ok(list.includes('primary.local'), 'Healthy primary should be included');
  assert.strictEqual(list[0], 'primary.local');

  console.log('HostManager Tests Passed!');
}

async function run() {
  try {
    await testHostManager();
  } catch (e) {
    console.error('Test Failed:', e);
    process.exit(1);
  }
}

run();
