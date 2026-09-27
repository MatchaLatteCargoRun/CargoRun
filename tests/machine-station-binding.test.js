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
  integrationId: 'mel-mach-primary',
  stationId: '1',
  credential: 'mel-machine-secret-value',
  enabled: true
};

function clientPrincipal(overrides = {}) {
  return Buffer.from(JSON.stringify({
    identityProvider: 'aad',
    userId: 'human-user-id',
    userDetails: 'Human Operator',
    userRoles: ['anonymous', 'authenticated'],
    ...overrides
  })).toString('base64');
}

function fetchHeaders(values) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    get: name => normalized[name.toLowerCase()] ?? null,
    has: name => Object.hasOwn(normalized, name.toLowerCase())
  };
}

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
      integrationId: 'mel-mach-primary',
      stationId: '1'
    }
  );
});

test('dedicated machine header remains authoritative when SWA supplies Authorization', () => {
  const auth = machineAuth({
    headers: {
      'x-cargorun-mach-key': mel.credential,
      authorization: 'Bearer azure-static-web-apps-platform-token'
    }
  }, environment([mel]));
  assert.equal(auth.credentialPresented, true);
  assert.equal(auth.ambiguous, false);
  assert.equal(auth.ok, true);
  assert.equal(auth.mode, 'header');
  assert.equal(auth.integrationId, 'mel-mach-primary');
  assert.equal(auth.stationId, '1');
});

test('Headers.get shape resolves the dedicated machine header', () => {
  const auth = machineAuth({
    headers: fetchHeaders({ 'X-CargoRun-MACH-Key': mel.credential })
  }, environment([mel]));
  assert.equal(auth.ok, true);
  assert.equal(auth.integrationId, 'mel-mach-primary');
  assert.equal(auth.stationId, '1');
});

test('Authorization, body credentials, and cookies never become machine identity', () => {
  for (const req of [
    { headers: { authorization: `Bearer ${mel.credential}` } },
    { headers: { cookie: `machKey=${mel.credential}` } },
    { headers: {}, body: { key: mel.credential, credential: mel.credential } }
  ]) {
    const auth = machineAuth(req, environment([mel]));
    assert.equal(auth.credentialPresented, false);
    assert.equal(auth.ok, false);
    assert.equal(auth.mode, null);
    assert.equal(auth.integrationId, null);
    assert.equal(auth.stationId, null);
  }
});

test('unknown, disabled, and unbound machine credentials fail closed', () => {
  const disabled = { ...mel, enabled: false };
  assert.equal(machineAuth(
    { headers: { 'x-cargorun-mach-key': disabled.credential } },
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

test('dedicated machine credential conflicts only with a genuine authenticated human principal', () => {
  const env = environment([mel]);
  const machineAndPlatformAuthorization = machineAuth({
    headers: {
      'x-cargorun-mach-key': mel.credential,
      authorization: 'Bearer unrelated-platform-value'
    }
  }, env);
  assert.equal(machineAndPlatformAuthorization.ambiguous, false);
  assert.equal(machineAndPlatformAuthorization.ok, true);

  const machineAndHuman = machineAuth({
    headers: {
      'x-cargorun-mach-key': mel.credential,
      'x-ms-client-principal': clientPrincipal()
    }
  }, env);
  assert.equal(machineAndHuman.ambiguous, true);
  assert.equal(machineAndHuman.ok, false);

  const machineAndAnonymousPrincipal = machineAuth({
    headers: {
      'x-cargorun-mach-key': mel.credential,
      'x-ms-client-principal': clientPrincipal({ userId: '', userRoles: ['anonymous'] })
    }
  }, env);
  assert.equal(machineAndAnonymousPrincipal.ambiguous, false);
  assert.equal(machineAndAnonymousPrincipal.ok, true);
});

test('query credentials are rejected and cannot combine with headers', () => {
  const env = environment([mel]);
  const queryOnly = machineAuth({ query: { key: mel.credential }, headers: {} }, env);
  assert.equal(queryOnly.credentialPresented, true);
  assert.equal(queryOnly.ambiguous, true);
  assert.equal(queryOnly.ok, false);
  const combined = machineAuth({
    query: { key: mel.credential },
    headers: { 'x-cargorun-mach-key': mel.credential }
  }, env);
  assert.equal(combined.ambiguous, true);
  assert.equal(combined.ok, false);
});

test('wrong, duplicate, comma-combined, blank, and malformed custom headers are rejected', () => {
  const env = environment([mel]);
  for (const headers of [
    {
      'x-cargorun-mach-key': 'wrong-machine-secret-value',
      authorization: 'Bearer azure-static-web-apps-platform-token'
    },
    { 'x-cargorun-mach-key': [mel.credential, mel.credential] },
    { 'x-cargorun-mach-key': `${mel.credential},${mel.credential}` },
    { 'x-cargorun-mach-key': '' },
    { 'x-cargorun-mach-key': ' malformed machine secret ' }
  ]) {
    const auth = machineAuth({ headers }, env);
    assert.equal(auth.credentialPresented, true);
    assert.equal(auth.ok, false);
    assert.equal(auth.integrationId, null);
    assert.equal(auth.stationId, null);
  }
});

test('machine authentication results never return credentials or binding lists', () => {
  const response = machineAuth({ headers: { 'x-cargorun-mach-key': mel.credential } }, environment([mel]));
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /mel-machine-secret-value/);
  assert.equal(Object.hasOwn(response, 'bindings'), false);
  assert.equal(Object.hasOwn(response, 'credential'), false);
});
