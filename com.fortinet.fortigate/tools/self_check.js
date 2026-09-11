#!/usr/bin/env node
'use strict';

/**
 * Lightweight structural check that doesn't require network access or a
 * running Homey. It approximates what `homey app build` + `homey app
 * validate` catch structurally: every driver's declared images/pair views
 * exist on disk, and module `require()`s resolve.
 *
 * Note: driver.js/device.js will still fail to `require()` cleanly here
 * with "Class extends value undefined is not a constructor" even in a
 * fully correct app - `Homey.Device`/`Homey.Driver` are only populated
 * when the Homey CLI's own runtime loads the app (`homey app run`), not
 * under a plain `node`/`require()`. Treat that specific error as expected
 * noise from this script, not a real defect; `homey app build`/`validate`
 * (see README) is the authoritative check.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let errors = 0;

function fail(msg) {
  console.error(`✗ ${msg}`);
  errors += 1;
}
function ok(msg) {
  console.log(`✓ ${msg}`);
}

function checkFileExists(rel) {
  const p = path.join(root, rel.replace(/^\//, ''));
  if (!fs.existsSync(p)) fail(`missing file: ${rel}`);
  else ok(`found ${rel}`);
}

// app.json images
const appJson = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose/app.json'), 'utf8'));
Object.values(appJson.images).forEach(checkFileExists);

const driversDir = path.join(root, 'drivers');
const driverIds = fs.readdirSync(driversDir)
  .filter((id) => !id.startsWith('.') && fs.statSync(path.join(driversDir, id)).isDirectory());

for (const id of driverIds) {
  const dir = path.join(driversDir, id);
  const composePath = path.join(dir, 'driver.compose.json');
  if (!fs.existsSync(composePath)) { fail(`${id}: missing driver.compose.json`); continue; }
  const compose = JSON.parse(fs.readFileSync(composePath, 'utf8'));
  if (compose.id !== id) fail(`${id}: driver.compose.json id "${compose.id}" != folder name`);

  Object.values(compose.images || {}).forEach(checkFileExists);

  for (const step of compose.pair || []) {
    if (step.template) continue; // built-in template, no local html file needed
    checkFileExists(`drivers/${id}/pair/${step.id}.html`);
  }

  for (const file of ['driver.js', 'device.js']) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) { fail(`${id}: missing ${file}`); continue; }
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      require(p);
      ok(`${id}/${file} requires cleanly`);
    } catch (err) {
      fail(`${id}/${file} threw on require(): ${err.message}`);
    }
  }
}

// Flow card id uniqueness across triggers/conditions/actions
for (const kind of ['triggers', 'conditions', 'actions']) {
  const dir = path.join(root, '.homeycompose/flow', kind);
  if (!fs.existsSync(dir)) continue;
  const ids = fs.readdirSync(dir).map((f) => f.replace(/\.json$/, ''));
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) fail(`${kind}: duplicate flow card ids ${dupes.join(', ')}`);
  else ok(`${kind}: ${ids.length} flow card(s), no duplicate ids (${ids.join(', ')})`);
}

// api.js routes referenced in app.json all have a matching exported function
const api = require(path.join(root, 'api.js'));
for (const key of Object.keys(appJson.api || {})) {
  if (typeof api[key] !== 'function') fail(`app.json api."${key}" has no matching export in api.js`);
  else ok(`api.js exports "${key}"`);
}

console.log(errors ? `\n${errors} problem(s) found.` : '\nAll structural checks passed.');
process.exit(errors ? 1 : 0);
