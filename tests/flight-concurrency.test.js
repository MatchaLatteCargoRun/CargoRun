'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flightHelpers = require('../api/shared/flight');
const { normalizeUldNumber } = require('../api/shared/uld');

const root = path.resolve(__dirname, '..');
const principal = Buffer.from(JSON.stringify({
  userRoles: ['authenticated'],
  userDetails: 'Test user',
  userId: 'test-user'
})).toString('base64');

function result(recordset = []) {
  return { recordset };
}

function harness(initialFlights = []) {
  const state = {
    flights: structuredClone(initialFlights),
    ulds: [],
    messages: [],
    links: [],
    uploads: [],
    calls: [],
    commits: 0,
    rollbacks: 0,
    failAfterFlight: false,
    lockResult: 0,
    lockError: null
  };
  const lockTails = new Map();

  async function acquire(tx, resource) {
    const previous = lockTails.get(resource) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    lockTails.set(resource, previous.then(() => current));
    await previous;
    tx.releaseLock = () => {
      release();
      if (lockTails.get(resource) === current) lockTails.delete(resource);
    };
  }

  class Transaction {
    constructor() { this.id = Symbol('tx'); }
    async begin() { this.active = true; }
    async commit() {
      this.active = false;
      for (const collection of [state.flights, state.ulds, state.messages, state.links, state.uploads]) {
        for (const row of collection) delete row.__tx;
      }
      state.commits++;
      this.releaseLock?.();
    }
    async rollback() {
      for (const name of ['flights', 'ulds', 'messages', 'links', 'uploads']) {
        state[name] = state[name].filter(row => row.__tx !== this.id);
      }
      this.active = false;
      state.rollbacks++;
      this.releaseLock?.();
    }
  }

  class Request {
    constructor(tx) { this.tx = tx; this.values = {}; }
    input(name, type, value) { this.values[name] = value; return this; }
    async query(text) {
      const q = text.replace(/\s+/g, ' ').trim();
      const p = this.values;
      state.calls.push({ q, p: { ...p }, inTransaction: Boolean(this.tx?.active) });

      if (q.includes('sys.sp_getapplock')) {
        assert.ok(this.tx?.active, 'flight identity lock must be transaction-owned');
        if (state.lockError) throw state.lockError;
        if (state.lockResult !== 0 && state.lockResult !== 1) {
          return result([{ LockResult: state.lockResult }]);
        }
        await acquire(this.tx, p.FlightIdentityLockResource);
        return result([{ LockResult: state.lockResult }]);
      }
      if (q.includes('FROM dbo.IncomingMachMessages')) {
        return result(state.messages.filter(row => row.DocumentCorID === p.DocumentCorID));
      }
      if (q.startsWith('INSERT INTO dbo.IncomingMachMessages')) {
        const row = { ...p, MachMessageId: state.messages.length + 1, __tx: this.tx.id };
        state.messages.push(row);
        return result([row]);
      }
      if (q.startsWith('DELETE FROM dbo.IncomingMachMessages')) {
        state.messages = state.messages.filter(row => row.DocumentCorID !== p.DocumentCorID);
        return result();
      }
      if (q.startsWith('UPDATE dbo.IncomingMachMessages')) {
        const row = state.messages.find(item => item.MachMessageId === p.MachMessageId);
        if (row) Object.assign(row, { MatchedFlightId: p.FlightId, ProcessingStatus: 'PROCESSED' });
        return result();
      }
      if (q.includes('FROM dbo.Flights')) {
        return result(state.flights.filter(row =>
          !p.OperatingDate ||
          String(row.OperatingDate) === String(p.OperatingDate)
        ));
      }
      if (q.startsWith('INSERT INTO dbo.Flights')) {
        const row = {
          ...p,
          FlightId: state.flights.length + 1,
          FlightStatus: 'ACTIVE',
          __tx: this.tx.id
        };
        state.flights.push(row);
        return result([row]);
      }
      if (q.startsWith('INSERT INTO dbo.FlightUploads')) {
        if (state.failAfterFlight) throw new Error('forced upload failure');
        state.uploads.push({ ...p, __tx: this.tx.id });
        return result();
      }
      if (q.includes('FROM dbo.ULDs')) {
        return result(state.ulds.filter(row => String(row.FlightId) === String(p.FlightId)));
      }
      if (q.startsWith('INSERT INTO dbo.ULDs')) {
        const row = {
          ...p,
          UldId: state.ulds.length + 1,
          CurrentStatus: p.CurrentStatus || 'WAREHOUSE',
          IdentityVerified: 0,
          __tx: this.tx.id
        };
        state.ulds.push(row);
        return result([row]);
      }
      if (q.startsWith('UPDATE dbo.ULDs') || q.startsWith('INSERT INTO dbo.UldSpecialHandlingCodes')) {
        return result();
      }
      if (q.includes('FROM dbo.MachFowShipments')) {
        return result(state.links.filter(row => row.MachMessageId === p.MachMessageId));
      }
      if (q.startsWith('INSERT INTO dbo.MachFowShipments')) {
        state.links.push({ ...p, __tx: this.tx.id });
        return result();
      }
      throw new Error('Unexpected SQL: ' + q);
    }
  }

  class ConnectionPool {
    async connect() { return this; }
    request() { return new Request(); }
    async close() {}
  }

  const sql = {
    ConnectionPool,
    Transaction,
    Request,
    NVarChar: () => 'nvarchar',
    VarChar: () => 'varchar',
    Decimal: () => 'decimal',
    BigInt: 'bigint',
    Int: 'int',
    Bit: 'bit',
    Date: 'date',
    DateTime2: 'datetime2',
    MAX: 'max'
  };

  function load(endpoint) {
    const module = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(path.join(root, 'api', endpoint, 'index.js'), 'utf8'),
      {
        module,
        exports: module.exports,
        Buffer,
        process: { env: { DATABASE_CONNECTION_STRING: 'test-only' } },
        require: name => name === 'mssql'
          ? sql
          : name === '../shared/flight'
            ? flightHelpers
            : name === '../shared/uld'
              ? { normalizeUldNumber }
              : require(name)
      },
      { filename: endpoint + '/index.js' }
    );
    return module.exports;
  }

  async function call(endpoint, body) {
    const context = { log: Object.assign(() => {}, { error() {}, warn() {} }) };
    await load(endpoint)(context, {
      method: 'POST',
      body,
      headers: { 'x-ms-client-principal': principal }
    });
    return { status: context.res.status, body: JSON.parse(context.res.body) };
  }

  return { state, call };
}

const manual = (flightNumber = 'CX0178', operatingDate = '2026-09-17') => ({
  flightNumber,
  operatingDate,
  direction: 'EXPORT',
  airlineCode: 'CX',
  originAirport: 'MEL',
  destinationAirport: 'HKG'
});

const upload = (flightNumber = 'CX0178', operatingDate = '2026-09-17', serial = '12345') => ({
  flight: {
    flightNumber,
    operatingDate,
    direction: 'EXPORT',
    airlineCode: 'CX',
    originAirport: 'MEL',
    destinationAirport: 'HKG',
    sourceFileName: 'test.xlsx'
  },
  ulds: [{ uldNumber: `AKE${serial}CX` }]
});

function fow(document, serials = ['12345'], date = '17 SEP 2026') {
  const ulds = serials.map(serial =>
    `<FSUMessageULDList><ULDTyp>AKE</ULDTyp><ULDSrl>${serial}</ULDSrl><ULDOwnr>CX</ULDOwnr></FSUMessageULDList>`
  ).join('');
  return {
    xml: `<FSUMessage><DocumentCorID>${document}</DocumentCorID><MessageType>FSU</MessageType><StatusCode>FOW</StatusCode><StsCar>CX</StsCar><StsCarNum>178</StsCarNum><StsDatt>${date}</StsDatt><StsApt>MEL</StsApt><StsSegDep>MEL</StsSegDep><StsSegArr>HKG</StsSegArr><DocPrfx>160</DocPrfx><DocNum>11111111</DocNum>${ulds}</FSUMessage>`
  };
}

test('flight normalization preserves the established FOW identity rule', () => {
  for (const value of ['CX178', 'cx0178', ' CX 00178 ']) {
    assert.equal(flightHelpers.normalizeFlightNumber(value), 'CX178');
  }
  assert.equal(flightHelpers.normalizeFlightNumber('CX0178A'), 'CX178A');
  assert.notEqual(
    flightHelpers.flightIdentityLockResource('2026-09-17', 'CX178'),
    flightHelpers.flightIdentityLockResource('2026-09-18', 'CX178')
  );
});

test('normal FOW reuses an existing active flight and different dates remain separate', async () => {
  const api = harness([{ FlightId: 41, FlightNumber: 'CX0178', OperatingDate: '2026-09-17', Direction: 'EXPORT', FlightStatus: 'ACTIVE' }]);
  const reused = await api.call('mach-fow', fow('FOW-REUSE'));
  assert.equal(reused.status, 201);
  assert.equal(reused.body.flightId, 41);
  assert.equal(reused.body.createdFlight, false);

  const nextDate = await api.call('flights', manual('CX178', '2026-09-18'));
  assert.equal(nextDate.status, 201);
  assert.equal(api.state.flights.length, 2);
});

test('FOW rejects an existing canonical identity with incompatible direction', async () => {
  const api = harness([{ FlightId: 73, FlightNumber: 'CX178', OperatingDate: '2026-09-17', Direction: 'IMPORT', FlightStatus: 'ACTIVE' }]);
  const response = await api.call('mach-fow', fow('FOW-DIRECTION'));
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'FLIGHT_IDENTITY_CONFLICT');
  assert.deepEqual(Array.from(response.body.flightIds), [73]);
  assert.equal(api.state.flights.length, 1);
  assert.equal(api.state.flights[0].Direction, 'IMPORT');
});

test('every writer rejects multiple legacy rows with an explicit canonical conflict', async () => {
  const legacy = [
    { FlightId: 31, FlightNumber: 'CX0178', OperatingDate: '2026-09-17', Direction: 'EXPORT', FlightStatus: 'ACTIVE' },
    { FlightId: 32, FlightNumber: 'CX178', OperatingDate: '2026-09-17', Direction: 'EXPORT', FlightStatus: 'ACTIVE' }
  ];

  for (const [endpoint, body] of [
    ['flights', manual('CX 00178')],
    ['manifest-upload', upload('cx178')],
    ['mach-fow', fow('FOW-LEGACY-COLLISION')]
  ]) {
    const api = harness(legacy);
    const response = await api.call(endpoint, body);
    assert.equal(response.status, 409, endpoint);
    assert.equal(response.body.code, 'FLIGHT_IDENTITY_CONFLICT', endpoint);
    assert.deepEqual(Array.from(response.body.flightIds), [31, 32], endpoint);
    assert.equal(api.state.flights.length, 2, endpoint);
  }
});

test('concurrent FOW requests create one flight and retain all ULD linkage', async () => {
  const api = harness();
  const [a, b] = await Promise.all([
    api.call('mach-fow', fow('FOW-A', ['12345', '23456'])),
    api.call('mach-fow', fow('FOW-B', ['12345', '34567']))
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 201]);
  assert.equal(api.state.flights.length, 1);
  assert.equal(a.body.flightId, b.body.flightId);
  assert.deepEqual(api.state.ulds.map(row => row.UldNumber).sort(), ['AKE12345CX', 'AKE23456CX', 'AKE34567CX']);
  assert.equal(api.state.links.length, 4);
});

test('manual/manual and upload/upload races create one operational flight', async () => {
  const manualApi = harness();
  const manualResults = await Promise.all([
    manualApi.call('flights', manual('CX0178')),
    manualApi.call('flights', manual('cx178'))
  ]);
  assert.deepEqual(manualResults.map(item => item.status).sort(), [201, 409]);
  assert.equal(manualApi.state.flights.length, 1);

  const uploadApi = harness();
  const uploadResults = await Promise.all([
    uploadApi.call('manifest-upload', upload('CX0178')),
    uploadApi.call('manifest-upload', upload('CX 178', '2026-09-17', '23456'))
  ]);
  assert.deepEqual(uploadResults.map(item => item.status).sort(), [201, 409]);
  assert.equal(uploadApi.state.flights.length, 1);
  assert.equal(uploadApi.state.uploads.length, 1);
});

test('manual/FOW race shares one canonical flight identity', async () => {
  const api = harness();
  const [manualResult, fowResult] = await Promise.all([
    api.call('flights', manual('CX178')),
    api.call('mach-fow', fow('FOW-RACE'))
  ]);
  assert.equal(api.state.flights.length, 1);
  assert.ok([201, 409].includes(manualResult.status));
  assert.equal(fowResult.status, 201);
  assert.equal(fowResult.body.flightId, api.state.flights[0].FlightId);
});

test('inactive FOW identity remains rejected without creating a bypass flight', async () => {
  const api = harness([{ FlightId: 9, FlightNumber: 'CX0178', OperatingDate: '2026-09-17', Direction: 'EXPORT', FlightStatus: 'FINALISED' }]);
  const response = await api.call('mach-fow', fow('FOW-CLOSED'));
  assert.equal(response.status, 409);
  assert.equal(api.state.flights.length, 1);
  assert.equal(api.state.flights[0].FlightStatus, 'FINALISED');
});

test('failure after flight creation rolls back the flight and all upload data', async () => {
  const api = harness();
  api.state.failAfterFlight = true;
  const response = await api.call('manifest-upload', upload());
  assert.equal(response.status, 500);
  assert.equal(api.state.flights.length, 0);
  assert.equal(api.state.uploads.length, 0);
  assert.equal(api.state.ulds.length, 0);
  assert.equal(api.state.rollbacks, 1);
});

test('only application-lock results 0 and 1 allow flight lookup and creation', async () => {
  for (const lockResult of [0, 1]) {
    const api = harness();
    api.state.lockResult = lockResult;
    const response = await api.call('flights', manual());
    assert.equal(response.status, 201, `lock result ${lockResult}`);
    assert.equal(api.state.flights.length, 1);
  }

  for (const lockResult of [-1, -2, -3, -999, null, undefined, '', Number.NaN, 2]) {
    const api = harness();
    api.state.lockResult = lockResult;
    const response = await api.call('flights', manual());
    assert.equal(response.status, 500, `lock result ${String(lockResult)}`);
    assert.equal(api.state.flights.length, 0);
    assert.equal(api.state.rollbacks, 1);
    assert.equal(api.state.calls.some(call => call.q.includes('FROM dbo.Flights')), false);
    assert.equal(api.state.calls.some(call => call.q.startsWith('INSERT INTO dbo.Flights')), false);
  }
});

test('failed lock acquisition rolls back FOW trace data and manifest state', async () => {
  const fowApi = harness();
  fowApi.state.lockResult = -1;
  const fowResponse = await fowApi.call('mach-fow', fow('FOW-LOCK-TIMEOUT'));
  assert.equal(fowResponse.status, 500);
  assert.equal(fowApi.state.messages.length, 0);
  assert.equal(fowApi.state.flights.length, 0);
  assert.equal(fowApi.state.ulds.length, 0);
  assert.equal(fowApi.state.links.length, 0);

  const uploadApi = harness();
  uploadApi.state.lockError = new Error('forced lock SQL exception');
  const uploadResponse = await uploadApi.call('manifest-upload', upload());
  assert.equal(uploadResponse.status, 500);
  assert.equal(uploadApi.state.flights.length, 0);
  assert.equal(uploadApi.state.uploads.length, 0);
  assert.equal(uploadApi.state.ulds.length, 0);
});

test('application-lock SQL exceptions roll back before lookup or creation', async () => {
  const api = harness();
  api.state.lockError = new Error('forced sp_getapplock failure');
  const response = await api.call('flights', manual());
  assert.equal(response.status, 500);
  assert.equal(api.state.rollbacks, 1);
  assert.equal(api.state.flights.length, 0);
  assert.equal(api.state.calls.some(call => call.q.includes('FROM dbo.Flights')), false);
  assert.equal(api.state.calls.some(call => call.q.startsWith('INSERT INTO dbo.Flights')), false);
});

test('all three writers request the exact same canonical lock resource', async () => {
  const existing = [{ FlightId: 41, FlightNumber: 'CX178', OperatingDate: '2026-09-17', Direction: 'EXPORT', FlightStatus: 'ACTIVE' }];
  const api = harness(existing);
  await api.call('flights', manual('CX0178'));
  await api.call('manifest-upload', upload('CX 00178'));
  await api.call('mach-fow', fow('FOW-LOCK-KEY'));
  const resources = api.state.calls
    .filter(call => call.q.includes('sys.sp_getapplock'))
    .map(call => call.p.FlightIdentityLockResource);
  assert.deepEqual(resources, [
    'CargoRun:Flight:2026-09-17:CX178',
    'CargoRun:Flight:2026-09-17:CX178',
    'CargoRun:Flight:2026-09-17:CX178'
  ]);
  assert.notEqual(
    flightHelpers.flightIdentityLockResource('2026-09-18', 'CX0178'),
    resources[0]
  );
  assert.notEqual(
    flightHelpers.flightIdentityLockResource('2026-09-17', 'QF0178'),
    resources[0]
  );
});

test('all flight writers use the shared transaction-owned identity lock', () => {
  for (const file of ['api/flights/index.js', 'api/manifest-upload/index.js', 'api/mach-fow/index.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /acquireFlightIdentityLock/);
  }
  const helper = fs.readFileSync(path.join(root, 'api/shared/flight.js'), 'utf8');
  assert.match(helper, /sys\.sp_getapplock/);
  assert.match(helper, /@LockOwner = 'Transaction'/);
});
