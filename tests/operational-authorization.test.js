'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const actualAuthorization = require('../api/shared/operational-authorization');
const { loadHandler: loadOperationalHandler, sqlHarness, call } = require('./helpers/operational-harness');

const root = path.resolve(__dirname, '..');
const principal = value => Buffer.from(JSON.stringify(value)).toString('base64');
const authenticatedPrincipal = principal({
  userId: 'stable-user-id',
  userDetails: 'Station Operator',
  userRoles: ['authenticated'],
  identityProvider: 'aad'
});

function requestWithPrincipal(value) {
  return { headers: value ? { 'x-ms-client-principal': value } : {} };
}

function authorizationSql({ stationRows = [{ StationId: 1 }], capabilities = [], stationFailure = null, capabilityFailure = null } = {}) {
  const state = { queries: [] };
  class Request {
    constructor(executor) { this.executor = executor; this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(query) {
      const text = String(query);
      state.queries.push({ text, values: { ...this.values } });
      if (text.includes('FROM dbo.CargoRunStations')) {
        if (stationFailure) throw stationFailure;
        return { recordset: stationRows };
      }
      if (text.includes('WITH AssignmentDecisions')) {
        if (capabilityFailure) throw capabilityFailure;
        return { recordset: capabilities.map(CapabilityCode => ({ CapabilityCode })) };
      }
      throw new Error(`Unexpected authorization SQL: ${text.slice(0, 120)}`);
    }
  }
  const type = size => size;
  return { sql: { Request, VarChar: type, NVarChar: type }, state };
}

test('stable SWA identity is required and browser identity fields cannot substitute for it', () => {
  assert.throws(
    () => actualAuthorization.authenticatedActor(requestWithPrincipal(null)),
    error => error.status === 401 && error.code === 'AUTHENTICATION_REQUIRED'
  );
  assert.throws(
    () => actualAuthorization.authenticatedActor(requestWithPrincipal(principal({ userId: 'user', userRoles: ['anonymous'] }))),
    error => error.status === 401 && error.code === 'AUTHENTICATION_REQUIRED'
  );
  assert.throws(
    () => actualAuthorization.authenticatedActor(requestWithPrincipal(principal({ userId: '   ', userRoles: ['authenticated'] }))),
    error => error.status === 401 && error.code === 'STABLE_IDENTITY_REQUIRED'
  );
  assert.throws(
    () => actualAuthorization.authenticatedActor(requestWithPrincipal(principal({ userId: 'x'.repeat(151), userRoles: ['authenticated'] }))),
    error => error.status === 401 && error.code === 'STABLE_IDENTITY_REQUIRED'
  );
  assert.equal(
    actualAuthorization.authenticatedActor(requestWithPrincipal(authenticatedPrincipal)).reference,
    'stable-user-id'
  );
});

test('authoritative flight direction selects Import destination and Export origin station', () => {
  assert.equal(actualAuthorization.stationForFlight({ Direction: 'IMPORT', OriginAirport: 'HKG', DestinationAirport: 'MEL' }), 'MEL');
  assert.equal(actualAuthorization.stationForFlight({ Direction: 'EXPORT', OriginAirport: 'SYD', DestinationAirport: 'HKG' }), 'SYD');
  for (const flight of [
    { Direction: 'IMPORT', DestinationAirport: '' },
    { Direction: 'TRANSFER', OriginAirport: 'MEL', DestinationAirport: 'SYD' },
    { Direction: 'EXPORT', OriginAirport: 'M3L' }
  ]) {
    assert.throws(() => actualAuthorization.stationForFlight(flight), error => error.status === 403 && error.code === 'STATION_ACCESS_DENIED');
  }
});

test('server-resolved capability and station grant an authorized MEL operation', async () => {
  const harness = authorizationSql({ capabilities: ['MOVE_ULD'] });
  const actor = actualAuthorization.authenticatedActor(requestWithPrincipal(authenticatedPrincipal));
  const result = await actualAuthorization.requireOperationalCapability(
    {}, harness.sql, actor,
    { Direction: 'IMPORT', OriginAirport: 'HKG', DestinationAirport: 'MEL' },
    'MOVE_ULD'
  );
  assert.equal(result.stationCode, 'MEL');
  assert.equal(result.requiredCapability, 'MOVE_ULD');
  assert.deepEqual(result.capabilities, ['MOVE_ULD']);
  assert.equal(harness.state.queries[1].values.AuthorizationActorReference, 'stable-user-id');
  assert.equal(harness.state.queries[1].values.AuthorizationStationCode, 'MEL');
});

test('missing capability, wrong station, and unavailable configuration fail closed', async () => {
  const actor = actualAuthorization.authenticatedActor(requestWithPrincipal(authenticatedPrincipal));
  await assert.rejects(
    actualAuthorization.requireOperationalCapability(
      {}, authorizationSql({ capabilities: [] }).sql, actor,
      { Direction: 'EXPORT', OriginAirport: 'SYD', DestinationAirport: 'HKG' }, 'MOVE_ULD'
    ),
    error => error.status === 403 && error.code === 'CAPABILITY_REQUIRED'
  );
  await assert.rejects(
    actualAuthorization.requireOperationalCapability(
      {}, authorizationSql({ stationRows: [] }).sql, actor,
      { Direction: 'EXPORT', OriginAirport: 'SYD', DestinationAirport: 'HKG' }, 'MOVE_ULD'
    ),
    error => error.status === 403 && error.code === 'STATION_ACCESS_DENIED'
  );
  await assert.rejects(
    actualAuthorization.requireOperationalCapability(
      {}, authorizationSql({ stationFailure: new Error('schema unavailable') }).sql, actor,
      { Direction: 'IMPORT', DestinationAirport: 'MEL' }, 'MOVE_ULD'
    ),
    error => error.status === 503 && error.code === 'AUTHORIZATION_CONFIGURATION_UNAVAILABLE'
  );
  await assert.rejects(
    actualAuthorization.requireOperationalCapability(
      {}, authorizationSql({ capabilityFailure: new Error('decision unavailable') }).sql, actor,
      { Direction: 'IMPORT', DestinationAirport: 'MEL' }, 'MOVE_ULD'
    ),
    error => error.status === 503 && error.code === 'AUTHORIZATION_CONFIGURATION_UNAVAILABLE'
  );
});

const deniedAuthorization = {
  ...actualAuthorization,
  requireOperationalCapability: async () => {
    throw new actualAuthorization.OperationalAuthorizationError(
      'CAPABILITY_REQUIRED',
      'The authenticated user is not authorized for this operation at the selected station',
      403
    );
  }
};

test('direct ULD status, mail scan, and offload API calls are denied before state or audit writes', async () => {
  const statusHarness = sqlHarness({
    uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 }
  });
  const statusHandler = loadOperationalHandler('api/uld-status/index.js', statusHarness.sql, deniedAuthorization);
  const statusResponse = await call(statusHandler, 'POST', {
    uldId: '7', expectedCurrentStatus: 'ARRIVED', nextStatus: 'RECEIVED'
  });
  assert.equal(statusResponse.status, 403);
  assert.equal(statusResponse.body.code, 'CAPABILITY_REQUIRED');
  assert.equal(statusHarness.state.uld.CurrentStatus, 'ARRIVED');
  assert.equal(statusHarness.state.movements.length, 0);
  assert.equal(statusHarness.state.audits.length, 0);

  const mailHarness = sqlHarness({
    uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'RECEIVED', IdentityVerified: 1 }
  });
  const mailHandler = loadOperationalHandler('api/mail-scan/index.js', mailHarness.sql, deniedAuthorization);
  const mailResponse = await call(mailHandler, 'POST', { uldId: '7' });
  assert.equal(mailResponse.status, 403);
  assert.equal(mailHarness.state.uld.MailScannedAtUtc, undefined);
  assert.equal(mailHarness.state.audits.length, 0);

  const offloadHarness = sqlHarness({
    flights: [{
      FlightId: 1, FlightNumber: 'CX178', OperatingDate: '2026-09-17', Direction: 'EXPORT',
      OriginAirport: 'MEL', DestinationAirport: 'HKG', FlightStatus: 'ACTIVE'
    }]
  });
  const offloadHandler = loadOperationalHandler('api/offloads/index.js', offloadHarness.sql, deniedAuthorization);
  const offloadResponse = await call(offloadHandler, 'POST', {
    flightId: '1', flightNumber: 'CX178', operatingDate: '2026-09-17',
    uldId: '7', uldNumber: 'AKE12345CX', parkingBay: 'F25'
  });
  assert.equal(offloadResponse.status, 403);
  assert.equal(offloadHarness.state.offload, null);
  assert.equal(offloadHarness.state.audits.length, 0);
});

function earlyDenialSql({ direction = 'IMPORT', flightRows = null } = {}) {
  const flight = {
    FlightId: 41, FlightNumber: 'CX0178', OperatingDate: new Date('2026-09-17T00:00:00Z'),
    OperatingDateIso: '2026-09-17', Direction: direction,
    OriginAirport: direction === 'EXPORT' ? 'MEL' : 'HKG',
    DestinationAirport: direction === 'IMPORT' ? 'MEL' : 'HKG',
    AirlineCode: 'CX', FlightStatus: 'ACTIVE'
  };
  const state = { queries: [], commits: 0, rollbacks: 0 };
  class Transaction {
    async begin() { this.active = true; }
    async commit() { this.active = false; state.commits++; }
    async rollback() { if (this.active) { this.active = false; state.rollbacks++; } }
  }
  class Request {
    constructor(executor) { this.executor = executor; this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(query) {
      const text = String(query).replace(/\s+/g, ' ').trim();
      state.queries.push({ text, values: { ...this.values } });
      if (text.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return { recordset: [{ COLUMN_NAME: 'FlightId', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, IS_IDENTITY: 0 }] };
      }
      if (text.includes('sys.sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
      if (text.includes('FROM dbo.Flights')) {
        if (Object.hasOwn(this.values, 'OperatingDate')) return { recordset: flightRows || [] };
        return { recordset: flightRows || [{ ...flight }] };
      }
      throw new Error(`Unexpected pre-authorization SQL: ${text}`);
    }
  }
  class ConnectionPool {
    async connect() { return this; }
    request() { return new Request(this); }
    async close() {}
  }
  const type = size => size;
  return {
    sql: {
      ConnectionPool, Transaction, Request,
      BigInt: 'bigint', Int: 'int', Bit: 'bit', Date: 'date', DateTime2: type,
      VarChar: type, NVarChar: type, UniqueIdentifier: 'uniqueidentifier', MAX: -1
    },
    state
  };
}

function loadHandler(relativePath, sqlMock, authorization = deniedAuthorization) {
  const filename = path.join(root, relativePath);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, URLSearchParams, console,
    process: { env: { DATABASE_CONNECTION_STRING: 'test-only' } },
    require(name) {
      if (name === 'mssql') return sqlMock;
      if (name === '../shared/operational-authorization') return authorization;
      if (name.startsWith('../shared/')) return require(path.resolve(path.dirname(filename), name));
      return require(name);
    }
  }, { filename });
  return module.exports;
}

async function invoke(handler, method, body) {
  const context = { log: Object.assign(() => {}, { error() {}, warn() {} }) };
  await handler(context, {
    method, body, query: {},
    headers: { 'x-ms-client-principal': authenticatedPrincipal }
  });
  return { status: context.res.status, body: JSON.parse(context.res.body) };
}

test('Add ULD and manual close direct calls require server capability before their first write', async () => {
  const addHarness = earlyDenialSql({ direction: 'IMPORT' });
  const addResponse = await invoke(
    loadHandler('api/ulds/index.js', addHarness.sql),
    'POST',
    { flightId: '41', uldNumber: 'AKE12345CX' }
  );
  assert.equal(addResponse.status, 403);
  assert.equal(addResponse.body.code, 'CAPABILITY_REQUIRED');
  assert.equal(addHarness.state.queries.some(entry => /\b(INSERT|UPDATE|DELETE)\b/i.test(entry.text)), false);

  const closeHarness = earlyDenialSql({ direction: 'IMPORT' });
  const closeResponse = await invoke(
    loadHandler('api/flights/index.js', closeHarness.sql),
    'PATCH',
    { flightId: '41', expectedStatus: 'ACTIVE', nextStatus: 'CLOSED', passcode: '1234' }
  );
  assert.equal(closeResponse.status, 403);
  assert.equal(closeResponse.body.code, 'CAPABILITY_REQUIRED');
  assert.equal(closeHarness.state.queries.some(entry => /\b(INSERT|UPDATE|DELETE)\b/i.test(entry.text)), false);
});

test('Import finalisation, Export finalisation, and Export FINAL direct calls authorize before writes', async () => {
  const cases = [
    ['api/import-completions/index.js', 'IMPORT', { flightId: '41' }],
    ['api/export-completions/index.js', 'EXPORT', { flightId: '41' }],
    ['api/export-manifest-final/index.js', 'EXPORT', {
      action: 'CONFIRM', flightId: '41', sourceFileName: 'FINAL.xlsx', ulds: [{ uldNumber: 'AKE12345CX' }]
    }]
  ];
  for (const [route, direction, body] of cases) {
    const harness = earlyDenialSql({ direction });
    const response = await invoke(loadHandler(route, harness.sql), 'POST', body);
    assert.equal(response.status, 403, route);
    assert.equal(response.body.code, 'CAPABILITY_REQUIRED', route);
    assert.equal(harness.state.queries.some(entry => /\b(INSERT|UPDATE|DELETE)\b/i.test(entry.text)), false, route);
    assert.equal(harness.state.commits, 0, route);
  }
});

test('manifest create direct call requires UPLOAD_FLIGHT_DATA before inserting flight or upload rows', async () => {
  const harness = earlyDenialSql({ direction: 'EXPORT', flightRows: [] });
  const response = await invoke(loadHandler('api/manifest-upload/index.js', harness.sql), 'POST', {
    flight: {
      flightNumber: 'CX0178', operatingDate: '2026-09-17', direction: 'EXPORT',
      airlineCode: 'CX', originAirport: 'MEL', destinationAirport: 'HKG', sourceFileName: 'manifest.xlsx'
    },
    ulds: [{ uldNumber: 'AKE12345CX' }]
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'CAPABILITY_REQUIRED');
  assert.equal(harness.state.queries.some(entry => /\b(INSERT|UPDATE|DELETE)\b/i.test(entry.text)), false);
});

test('human MACH/FOW direct call needs UPLOAD_FLIGHT_DATA while valid machine token remains accepted', async () => {
  const humanHarness = earlyDenialSql({ direction: 'EXPORT' });
  const humanResponse = await invoke(loadHandler('api/mach-fow/index.js', humanHarness.sql), 'POST', {
    xml: '<FSUMessage><DocumentCorID>AUTH-TEST</DocumentCorID><MessageType>FSU</MessageType>' +
      '<StatusCode>FOW</StatusCode><StsCar>CX</StsCar><StsCarNum>178</StsCarNum>' +
      '<StsDatt>17 SEP 2026</StsDatt><StsApt>MEL</StsApt><StsSegDep>MEL</StsSegDep>' +
      '<StsSegArr>HKG</StsSegArr><FSUMessageULDList><ULDTyp>AKE</ULDTyp>' +
      '<ULDSrl>12345</ULDSrl><ULDOwnr>CX</ULDOwnr></FSUMessageULDList></FSUMessage>'
  });
  assert.equal(humanResponse.status, 403);
  assert.equal(humanResponse.body.code, 'CAPABILITY_REQUIRED');
  assert.equal(humanHarness.state.queries.some(entry => /\b(INSERT|UPDATE|DELETE)\b/i.test(entry.text)), false);

  const filename = path.join(root, 'api/mach-fow/index.js');
  const module = { exports: {} };
  vm.runInNewContext(
    `${fs.readFileSync(filename, 'utf8')}\nmodule.exports.__machineAuth = machineAuth;`,
    {
      module, exports: module.exports, Buffer, console,
      process: { env: { MACH_FOW_INGEST_TOKEN: 'machine-secret' } },
      require(name) {
        if (name === 'mssql') return {};
        if (name.startsWith('../shared/')) return require(path.resolve(path.dirname(filename), name));
        return require(name);
      }
    },
    { filename }
  );
  assert.equal(module.exports.__machineAuth({ headers: { 'x-cargorun-mach-key': 'machine-secret' } }).ok, true);
  assert.equal(module.exports.__machineAuth({ headers: { authorization: 'Bearer machine-secret' } }).ok, true);
  assert.equal(module.exports.__machineAuth({ headers: { 'x-cargorun-mach-key': 'wrong' } }).ok, false);
});

test('every operational mutation has an explicit capability check before its write statement', () => {
  const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  const checks = [
    ['api/flights/index.js', "'SET_IN_BLOCK'", 'UPDATE dbo.Flights SET ScheduledDepartureUtc'],
    ['api/flights/index.js', "'SET_ETD'", 'UPDATE dbo.Flights SET ScheduledDepartureUtc'],
    ['api/flights/index.js', "'FINALISE_FLIGHT'", "UPDATE dbo.Flights SET FlightStatus='CLOSED'"],
    ['api/flights/index.js', "'UPLOAD_FLIGHT_DATA'", 'INSERT INTO dbo.Flights'],
    ['api/ulds/index.js', "'MOVE_ULD'", 'INSERT INTO dbo.ULDs'],
    ['api/uld-status/index.js', "'MOVE_ULD'", 'UPDATE dbo.ULDs'],
    ['api/mail-scan/index.js', "'SCAN_ULD'", 'SET MailScannedAtUtc'],
    ['api/offloads/index.js', "'REQUEST_OFFLOAD'", 'const created = await insertOffloadRow'],
    ['api/offloads/index.js', "'COLLECT_OFFLOAD'", 'UPDATE dbo.Offloads'],
    ['api/offloads/index.js', "'COMPLETE_OFFLOAD'", 'UPDATE dbo.Offloads'],
    ['api/import-completions/index.js', "'FINALISE_FLIGHT'", 'INSERT INTO dbo.ImportCompletionRecords'],
    ['api/export-completions/index.js', "'FINALISE_FLIGHT'", 'INSERT INTO dbo.ExportCompletionRecords'],
    ['api/export-manifest-final/index.js', "'CONFIRM_EXPORT_FINAL'", 'INSERT INTO dbo.ExportManifestFinals'],
    ['api/manifest-upload/index.js', "'CONFIRM_EXPORT_FINAL'", 'INSERT INTO dbo.FlightUploads'],
    ['api/manifest-upload/index.js', "'UPLOAD_FLIGHT_DATA'", 'INSERT INTO dbo.Flights'],
    ['api/mach-fow/index.js', "'UPLOAD_FLIGHT_DATA'", 'INSERT INTO dbo.IncomingMachMessages']
  ];
  for (const [file, capability, write] of checks) {
    const text = source(file);
    assert.notEqual(text.indexOf(capability), -1, `${file} lacks ${capability}`);
    assert.notEqual(text.indexOf(write), -1, `${file} lacks expected write ${write}`);
    assert.ok(text.indexOf(capability) < text.indexOf(write), `${file} must authorize ${capability} before ${write}`);
  }
});

test('exact entity identity and machine-versus-human FOW authorization remain explicit', () => {
  const uldStatus = fs.readFileSync(path.join(root, 'api/uld-status/index.js'), 'utf8');
  const mailScan = fs.readFileSync(path.join(root, 'api/mail-scan/index.js'), 'utf8');
  const offloads = fs.readFileSync(path.join(root, 'api/offloads/index.js'), 'utf8');
  const mach = fs.readFileSync(path.join(root, 'api/mach-fow/index.js'), 'utf8');
  assert.match(uldStatus, /WHERE u\.UldId\s*=\s*@UldId/);
  assert.match(mailScan, /WHERE u\.UldId=@AuthorizationUldId/);
  assert.match(offloads, /amendmentFlightId = operationalId\(current\.flightId\)/);
  assert.match(mach, /if \(!live\)[\s\S]*requireOperationalCapability[\s\S]*'UPLOAD_FLIGHT_DATA'/);
  assert.match(mach, /const live\s*=\s*Boolean\(machine\.ok\)/);
  assert.match(mach, /secureEqual\(expected, supplied\)/);
  assert.match(mach, /MACH_FOW_INGEST_TOKEN/);
});

test('browser PIN is no longer security and audit wording describes server capability', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const flights = fs.readFileSync(path.join(root, 'api/flights/index.js'), 'utf8');
  assert.doesNotMatch(html, /closePin|Incorrect passcode|placeholder="1234"|Closed with supervisor passcode/);
  assert.doesNotMatch(flights, /1234|supervisor passcode/i);
  assert.match(html, /server-side flight finalisation permission/);
  assert.match(flights, /Manual close authorized by server capability/);
});

test('rollout artifacts require station-scoped stable identities and preserve explicit Admin authorization', () => {
  const roles = fs.readFileSync(path.join(root, 'migrations/operational-authorization-roles.sql'), 'utf8');
  const user = fs.readFileSync(path.join(root, 'migrations/operational-authorization-user.sql'), 'utf8');
  const verify = fs.readFileSync(path.join(root, 'migrations/operational-authorization-verify.sql'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'api/shared/configuration-mutations.js'), 'utf8');
  assert.match(roles, /BEGIN TRANSACTION/);
  assert.match(roles, /OPERATIONS/);
  assert.match(roles, /SUPERVISOR/);
  assert.match(user, /REPLACE_WITH_SWA_USER_ID/);
  assert.match(user, /REPLACE_WITH_STATION/);
  assert.match(user, /CapabilityCode='MANAGE_USERS'/);
  assert.match(user, /ROW_NUMBER\(\) OVER/);
  assert.doesNotMatch(user, /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  assert.match(verify, /GLOBAL_OPERATIONAL_ASSIGNMENT/);
  assert.match(verify, /NO_OPERATIONAL_ASSIGNMENTS/);
  assert.match(admin, /authorizeCapability\(\{ enforcementMode: 'ENFORCED'/);
});
