'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { machineAuth } = require('../api/shared/machine-station-binding');

test('MEL machine identity remains MEL when a request claims AKL', () => {
  const credential = 'isolated-mel-machine-credential';
  const env = { MACH_FOW_MACHINE_BINDINGS: JSON.stringify([
    { integrationId: 'mel-fow', stationId: '1', credential, enabled: true }
  ]) };
  for (const query of [
    { stationId: '2' },
    { stationCode: 'AKL', originAirport: 'AKL', destinationAirport: 'AKL' }
  ]) {
    const result = machineAuth({
      method: 'POST', headers: { 'x-cargorun-mach-key': credential }, query
    }, env);
    assert.equal(result.ok, true);
    assert.equal(result.stationId, '1');
    assert.equal(result.integrationId, 'mel-fow');
  }
  const denied = machineAuth({
    method: 'POST', headers: { 'x-cargorun-mach-key': 'unbound-akl-credential' },
    query: { stationId: '2' }
  }, env);
  assert.equal(denied.ok, false);
  assert.equal(denied.stationId, null);
});

test('MACH/FOW intake resolves machine station from binding before flight ownership checks', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'mach-fow', 'index.js'), 'utf8');
  assert.match(source, /machineAuth\(req, process\.env\)/);
  assert.match(source, /operationalStation = await resolveStationById\(pool, sql, machine\.stationId\)/);
  assert.match(source, /StationId=@AuthorizationStationId/);
  assert.match(source, /acquireFlightIdentityLock\(tx, sql, operationalStation\.stationId/);
});