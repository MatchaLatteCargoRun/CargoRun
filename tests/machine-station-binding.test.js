'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readMachineBindingConfiguration,
  machineAuth
} = require('../api/shared/machine-station-binding');

function environment(bindings) {
  return { MACH_FOW_MACHINE_BINDINGS: JSON.stringify(bindings) };
}

const mel = {
  integrationId: 'mel-machine-test',
  stationId: '1',
  credential: 'mel-machine-secret-value',
  enabled: true
};

test('machine binding configuration resolves one enabled identity to one StationId', () => {
  const env = environment([mel, {
    integrationId: 'akl-machine-test',
    stationId: '8',
    credential: 'akl-machine-secret-value',
    enabled: true
  }]);
  const auth = machineAuth({ headers: { 'x-cargorun-mach-key': mel.credential } }, env);
  assert.deepEqual(
    {
      status: auth.configurationStatus,
      presented: auth.credentialPresented,
      ok: auth.ok,
      integrationId: auth.integrationId,
      stationId: auth.stationId
    },
    {
      status: 'ready',
      presented: true,
      ok: true,
      integrationId: 'mel-machine-test',
      stationId: '1'
    }
  );
});

test('unknown, disabled, and unbound machine credentials fail closed', () => {
  const disabled = { ...mel, enabled: false };
  assert.equal(machineAuth(
    { headers: { authorization: `Bearer ${disabled.credential}` } },
    environment([disabled])
  ).ok, false);
  assert.equal(machineAuth(
    { headers: { 'x-cargorun-mach-key': 'unknown-machine-secret-value' } },
    environment([mel])
  ).ok, false);

  const unbound = readMachineBindingConfiguration(environment([{ ...mel, stationId: '' }]));
  assert.equal(unbound.status, 'invalid');
  assert.equal(machineAuth(
    { headers: { 'x-cargorun-mach-key': mel.credential } },
    environment([{ ...mel, stationId: '' }])
  ).ok, false);
});

test('malformed and ambiguous binding registries fail closed as one unit', () => {
  assert.equal(readMachineBindingConfiguration({ MACH_FOW_MACHINE_BINDINGS: '{' }).status, 'invalid');
  assert.equal(readMachineBindingConfiguration(environment([mel, { ...mel, stationId: '8' }])).status, 'invalid');
  assert.equal(readMachineBindingConfiguration(environment([
    mel,
    { ...mel, integrationId: 'akl-machine-test', stationId: '8' }
  ])).status, 'invalid');
  assert.equal(readMachineBindingConfiguration({ MACH_FOW_INGEST_TOKEN: mel.credential }).status, 'missing');
});

test('multiple credential mechanisms and machine plus human identity are rejected', () => {
  const env = environment([mel]);
  const bothMachine = machineAuth({
    headers: {
      'x-cargorun-mach-key': mel.credential,
      authorization: `Bearer ${mel.credential}`
    }
  }, env);
  assert.equal(bothMachine.credentialPresented, true);
  assert.equal(bothMachine.ambiguous, true);
  assert.equal(bothMachine.ok, false);

  const machineAndHuman = machineAuth({
    headers: {
      'x-cargorun-mach-key': mel.credential,
      'x-ms-client-principal': 'human-principal'
    }
  }, env);
  assert.equal(machineAndHuman.ambiguous, true);
  assert.equal(machineAndHuman.ok, false);
});

test('query credentials are rejected and cannot combine with headers', () => {
  const env = environment([mel]);
  assert.equal(machineAuth({ query: { key: mel.credential }, headers: {} }, env).ok, false);
  assert.equal(machineAuth({
    query: { key: mel.credential },
    headers: { 'x-cargorun-mach-key': mel.credential }
  }, env).ok, false);
});

test('machine authentication results never return credentials or binding lists', () => {
  const response = machineAuth({ headers: { 'x-cargorun-mach-key': mel.credential } }, environment([mel]));
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /mel-machine-secret-value/);
  assert.equal(Object.hasOwn(response, 'bindings'), false);
  assert.equal(Object.hasOwn(response, 'credential'), false);
});
