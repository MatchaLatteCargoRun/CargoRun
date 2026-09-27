'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const flightHelpers = require('../api/shared/flight');
const actualAuthorization = require('../api/shared/operational-authorization');
const stationHelpers = require('../api/shared/station');
const stationLocalInput = require('../api/shared/station-local-input');
const {
  StationTimeError,
  formatInstantInStation,
  resolveStationLocalDateTime
} = require('../api/shared/station-time');

const root = path.resolve(__dirname, '..');
const MEL = 'Australia/Melbourne';
const AKL = 'Pacific/Auckland';

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const principal = Buffer.from(JSON.stringify({
  userRoles: ['authenticated'], userDetails: 'Station Time Tester', userId: 'station-time-tester'
})).toString('base64');

function apiHarness({ stationId = '8', authorized = true, direction = 'EXPORT', flightStatus = 'ACTIVE' } = {}) {
  const zones = { '1': { stationCode: 'MEL', timeZoneId: MEL }, '8': { stationCode: 'AKL', timeZoneId: AKL } };
  const owner = zones[String(stationId)];
  const state = {
    flight: {
      FlightId: '901', StationId: String(stationId), FlightNumber: 'CX901', Direction: direction,
      OriginAirport: direction === 'IMPORT' ? 'HKG' : 'MEL', DestinationAirport: direction === 'IMPORT' ? 'MEL' : 'HKG',
      FlightStatus: flightStatus, ScheduledDepartureUtc: '2026-09-30T20:00:00.000Z',
      EstimatedDepartureUtc: '2026-09-30T21:00:00.000Z', InBlockAtUtc: '2026-09-30T22:00:00.000Z'
    },
    updateCount: 0, commits: 0, rollbacks: 0, audits: [], calls: []
  };
  class Transaction {
    async begin() { this.active = true; }
    async commit() { this.active = false; state.commits++; }
    async rollback() { this.active = false; state.rollbacks++; }
  }
  class Request {
    constructor(transaction) { this.transaction = transaction; this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(text) {
      const query = text.replace(/\s+/g, ' ').trim();
      state.calls.push({ query, values: { ...this.values }, transaction: Boolean(this.transaction?.active) });
      if (Object.hasOwn(this.values, 'AuthorizationFlightId')) {
        return { recordset: String(this.values.AuthorizationFlightId) === state.flight.FlightId ? [{ ...state.flight }] : [] };
      }
      if (query.startsWith('UPDATE dbo.Flights SET EstimatedDepartureUtc=')) {
        state.updateCount++;
        if (this.values.EstimatedDepartureUtc) state.flight.EstimatedDepartureUtc = this.values.EstimatedDepartureUtc.toISOString();
        if (this.values.InBlockAtUtc) state.flight.InBlockAtUtc = this.values.InBlockAtUtc.toISOString();
        return { recordset: [{ ...state.flight }], rowsAffected: [1] };
      }
      throw new Error(`Unhandled SQL: ${query}`);
    }
  }
  class ConnectionPool {
    async connect() { return this; }
    request() { return new Request(); }
    async close() {}
  }
  const sql = {
    ConnectionPool, Transaction, Request, BigInt: 'bigint', DateTime2: 'datetime2',
    Date: 'date', NVarChar: () => 'nvarchar', VarChar: () => 'varchar'
  };
  const authorization = {
    authenticatedActor: () => ({ displayName: 'Station Time Tester', reference: 'station-time-tester' }),
    requireOperationalStations: async () => ({ stations: ['MEL', 'AKL'] }),
    resolveActorAccess: async () => ({ stations: ['MEL', 'AKL'] }),
    authorizeRequestedStation: () => ({ stationId: '1', stationCode: 'MEL', timeZoneId: MEL }),
    requireOperationalCapability: async () => ({}),
    requireOperationalEntityCapability: async (_executor, _sql, _identity, flight, requiredCapability) => {
      if (!authorized || !flight) {
        const error = new Error('Operational entity unavailable');
        error.status = 404;
        error.code = 'OPERATIONAL_ENTITY_NOT_AVAILABLE';
        throw error;
      }
      return {
        stationId: String(flight.StationId), stationCode: owner.stationCode,
        displayName: owner.stationCode === 'AKL' ? 'Auckland' : 'Melbourne',
        timeZoneId: owner.timeZoneId, requiredCapability
      };
    },
    sendOperationalAuthorizationError: (context, error, sendJson) => {
      if (!error?.status) return false;
      sendJson(context, error.status, { ok: false, code: error.code, error: 'Operational entity unavailable' });
      return true;
    }
  };
  const filename = path.join(root, 'api/flights/index.js');
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, Buffer, console,
    process: { env: { DATABASE_CONNECTION_STRING: 'test-only' } },
    require(name) {
      if (name === 'mssql') return sql;
      if (name === '../shared/flight') return flightHelpers;
      if (name === '../shared/audit') return { insertAuditEvent: async (_executor, _sql, event) => state.audits.push(event) };
      if (name === '../shared/operational-authorization') return authorization;
      if (name === '../shared/station') return stationHelpers;
      if (name === '../shared/station-local-input') return stationLocalInput;
      throw new Error(`Unexpected require: ${name}`);
    }
  });
  vm.runInContext(read('api/flights/index.js'), context, { filename });
  return { handler: module.exports, state };
}

function realAuthorizationDenialHarness() {
  const state = { rollbacks: 0, commits: 0, calls: [] };
  const flight = {
    FlightId: '901', StationId: '8', FlightNumber: 'CX901', Direction: 'EXPORT',
    OriginAirport: 'MEL', DestinationAirport: 'HKG', FlightStatus: 'CLOSED'
  };
  const stations = {
    '1': { StationId: '1', StationCode: 'MEL', DisplayName: 'Melbourne', TimeZoneId: MEL, IsEnabled: 1 },
    '8': { StationId: '8', StationCode: 'AKL', DisplayName: 'Auckland', TimeZoneId: AKL, IsEnabled: 1 }
  };
  class Transaction {
    async begin() { this.active = true; }
    async commit() { this.active = false; state.commits++; }
    async rollback() { this.active = false; state.rollbacks++; }
  }
  class Request {
    constructor(executor) { this.executor = executor; this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(text) {
      const query = String(text).replace(/\s+/g, ' ').trim();
      state.calls.push({ query, values: { ...this.values } });
      if (Object.hasOwn(this.values, 'OperationalAccessActorReference')) {
        return { recordset: [{ ...stations['1'], CapabilityCode: 'SET_ETD' }] };
      }
      if (Object.hasOwn(this.values, 'AuthorizationFlightId')) {
        return { recordset: String(this.values.AuthorizationFlightId) === flight.FlightId ? [{ ...flight }] : [] };
      }
      if (Object.hasOwn(this.values, 'ResolvedStationId')) {
        const station = stations[String(this.values.ResolvedStationId)];
        return { recordset: station ? [{ ...station }] : [] };
      }
      if (Object.hasOwn(this.values, 'AuthorizationActorReference')) {
        assert.equal(this.values.AuthorizationStationCode, 'AKL');
        return { recordset: [] };
      }
      throw new Error(`Unhandled real-authorization SQL: ${query}`);
    }
  }
  class ConnectionPool {
    async connect() { return this; }
    request() { return new Request(this); }
    async close() {}
  }
  const type = () => 'type';
  const sql = {
    ConnectionPool, Transaction, Request, BigInt: 'bigint', DateTime2: type,
    Date: 'date', NVarChar: type, VarChar: type
  };
  const filename = path.join(root, 'api/flights/index.js');
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, Buffer, console,
    process: { env: { DATABASE_CONNECTION_STRING: 'test-only' } },
    require(name) {
      if (name === 'mssql') return sql;
      if (name === '../shared/flight') return flightHelpers;
      if (name === '../shared/audit') return { insertAuditEvent: async () => { throw new Error('audit must not run'); } };
      if (name === '../shared/operational-authorization') return actualAuthorization;
      if (name === '../shared/station') return stationHelpers;
      if (name === '../shared/station-local-input') return stationLocalInput;
      throw new Error(`Unexpected require: ${name}`);
    }
  });
  vm.runInContext(read('api/flights/index.js'), context, { filename });
  return { handler: module.exports, state };
}

function timingLifecycleRaceHarness() {
  const state = {
    flight: {
      FlightId: '901', StationId: '1', FlightNumber: 'CX901', OperatingDate: '2026-10-01',
      OperatingDateIso: '2026-10-01', Direction: 'IMPORT', OriginAirport: 'HKG',
      DestinationAirport: 'MEL', FlightStatus: 'ACTIVE', ScheduledDepartureUtc: null,
      EstimatedDepartureUtc: null, InBlockAtUtc: null
    },
    rowLockAttempts: 0, rowLockHolds: [], timingUpdates: 0, commits: 0, rollbacks: 0
  };
  let rowLockTail = Promise.resolve();

  async function acquireRowLock(transaction) {
    state.rowLockAttempts++;
    const previous = rowLockTail;
    let release;
    const current = new Promise(resolve => { release = resolve; });
    rowLockTail = previous.then(() => current);
    await previous;
    const hold = state.rowLockHolds.shift();
    if (hold) {
      hold.markAcquired();
      await hold.waitForRelease;
    }
    transaction.releaseLocks ??= [];
    transaction.releaseLocks.push(release);
  }

  class Transaction {
    async begin() { this.active = true; }
    async commit() {
      this.active = false;
      state.commits++;
      for (const release of this.releaseLocks || []) release();
    }
    async rollback() {
      this.active = false;
      state.rollbacks++;
      for (const release of this.releaseLocks || []) release();
    }
  }
  class Request {
    constructor(transaction) { this.transaction = transaction; this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(text) {
      const query = String(text).replace(/\s+/g, ' ').trim();
      if (query.includes('sys.sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
      if (query.startsWith("UPDATE dbo.Flights SET FlightStatus='CLOSED'")) {
        if (state.flight.FlightStatus !== 'ACTIVE') return { recordset: [], rowsAffected: [0] };
        state.flight.FlightStatus = 'CLOSED';
        return { recordset: [{ ...state.flight }], rowsAffected: [1] };
      }
      if (query.startsWith('UPDATE dbo.Flights SET EstimatedDepartureUtc=')) {
        state.timingUpdates++;
        if (this.values.InBlockAtUtc) state.flight.InBlockAtUtc = this.values.InBlockAtUtc.toISOString();
        return { recordset: [{ ...state.flight }], rowsAffected: [1] };
      }
      if (query.includes('FROM dbo.Flights')) {
        const locked = /WITH \(UPDLOCK,HOLDLOCK\)/.test(query);
        if (locked) await acquireRowLock(this.transaction);
        const requestedId = this.values.AuthorizationFlightId ?? this.values.LockedFlightId ??
          this.values.LatestFlightId ?? this.values.FlightId;
        return { recordset: String(requestedId) === state.flight.FlightId ? [{ ...state.flight }] : [] };
      }
      throw new Error(`Unhandled timing/lifecycle race SQL: ${query}`);
    }
  }
  class ConnectionPool {
    async connect() { return this; }
    request() { return new Request(); }
    async close() {}
  }
  const type = () => 'type';
  const sql = {
    ConnectionPool, Transaction, Request, BigInt: 'bigint', DateTime2: type,
    Date: 'date', NVarChar: type, VarChar: type
  };
  const authorization = {
    authenticatedActor: actualAuthorization.authenticatedActor,
    requireOperationalStations: async () => ({ stations: ['MEL'] }),
    resolveActorAccess: async () => ({ stations: ['MEL'] }),
    authorizeRequestedStation: () => ({ stationId: '1', stationCode: 'MEL', timeZoneId: MEL }),
    requireOperationalCapability: async () => ({ stationId: '1', stationCode: 'MEL', timeZoneId: MEL }),
    requireOperationalEntityCapability: async (_executor, _sql, _identity, flight, requiredCapability) => {
      if (!flight) throw actualAuthorization.operationalEntityUnavailable();
      return { stationId: '1', stationCode: 'MEL', displayName: 'Melbourne', timeZoneId: MEL, requiredCapability };
    },
    sendOperationalAuthorizationError: actualAuthorization.sendOperationalAuthorizationError
  };
  const filename = path.join(root, 'api/flights/index.js');
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, Buffer, console,
    process: { env: { DATABASE_CONNECTION_STRING: 'test-only' } },
    require(name) {
      if (name === 'mssql') return sql;
      if (name === '../shared/flight') return flightHelpers;
      if (name === '../shared/audit') return { insertAuditEvent: async () => {} };
      if (name === '../shared/operational-authorization') return authorization;
      if (name === '../shared/station') return stationHelpers;
      if (name === '../shared/station-local-input') return stationLocalInput;
      throw new Error(`Unexpected require: ${name}`);
    }
  });
  vm.runInContext(read('api/flights/index.js'), context, { filename });

  async function call(body) {
    const requestContext = { log: { error() {}, warn() {} } };
    await module.exports(requestContext, {
      method: 'PATCH', body, headers: { 'x-ms-client-principal': principal }
    });
    return { status: requestContext.res.status, body: JSON.parse(requestContext.res.body) };
  }
  function holdNextRowLock() {
    let markAcquired;
    let release;
    const acquired = new Promise(resolve => { markAcquired = resolve; });
    const waitForRelease = new Promise(resolve => { release = resolve; });
    state.rowLockHolds.push({ markAcquired, waitForRelease });
    return { acquired, release };
  }
  return { call, holdNextRowLock, state };
}

async function callApi(harness, body) {
  const context = { log: { error() {}, warn() {} } };
  await harness.handler(context, {
    method: 'PATCH', body,
    headers: { 'x-ms-client-principal': principal }
  });
  return { status: context.res.status, body: JSON.parse(context.res.body) };
}

test('station-local flight times resolve ordinary MEL and AKL wall clocks to stable UTC instants', () => {
  assert.deepEqual(resolveStationLocalDateTime('2026-10-01', '18:30', MEL), {
    status: 'UNIQUE',
    instantUtc: '2026-10-01T08:30:00.000Z',
    offset: '+10:00',
    timeZoneId: MEL,
    localDate: '2026-10-01',
    localTime: '18:30'
  });
  assert.deepEqual(resolveStationLocalDateTime('2026-10-01', '18:30', AKL), {
    status: 'UNIQUE',
    instantUtc: '2026-10-01T05:30:00.000Z',
    offset: '+13:00',
    timeZoneId: AKL,
    localDate: '2026-10-01',
    localTime: '18:30'
  });
});

test('station-local flight times reject the MEL and AKL spring-forward gaps', () => {
  for (const [zone, date] of [[MEL, '2026-10-04'], [AKL, '2026-09-27']]) {
    assert.deepEqual(resolveStationLocalDateTime(date, '02:30', zone), {
      status: 'NONEXISTENT', candidates: [], timeZoneId: zone, localDate: date, localTime: '02:30'
    });
  }
});

test('station-local flight times reject fold choices for unique MEL and AKL times', () => {
  for (const zone of [MEL, AKL]) {
    for (const disambiguation of ['EARLIER', 'LATER']) {
      assert.throws(
        () => resolveStationLocalDateTime('2026-10-01', '18:30', zone, disambiguation),
        error => error instanceof StationTimeError && error.code === 'DISAMBIGUATION_INVALID'
      );
    }
  }
});

test('station-local flight-time gaps remain nonexistent when a fold choice is supplied', () => {
  for (const [zone, date] of [[MEL, '2026-10-04'], [AKL, '2026-09-27']]) {
    for (const disambiguation of ['EARLIER', 'LATER']) {
      assert.equal(resolveStationLocalDateTime(date, '02:30', zone, disambiguation).status, 'NONEXISTENT');
    }
  }
});

test('station-local flight times require and honor explicit MEL and AKL fold choices', () => {
  const expected = new Map([
    [MEL, ['2026-04-04T15:30:00.000Z', '2026-04-04T16:30:00.000Z']],
    [AKL, ['2026-04-04T13:30:00.000Z', '2026-04-04T14:30:00.000Z']]
  ]);
  for (const zone of [MEL, AKL]) {
    const ambiguous = resolveStationLocalDateTime('2026-04-05', '02:30', zone);
    assert.equal(ambiguous.status, 'AMBIGUOUS');
    assert.deepEqual(ambiguous.candidates.map(candidate => candidate.instantUtc), expected.get(zone));
    const earlier = resolveStationLocalDateTime('2026-04-05', '02:30', zone, 'EARLIER');
    const later = resolveStationLocalDateTime('2026-04-05', '02:30', zone, 'LATER');
    assert.equal(earlier.instantUtc, expected.get(zone)[0]);
    assert.equal(later.instantUtc, expected.get(zone)[1]);
    assert.notEqual(earlier.instantUtc, later.instantUtc);
  }
});

test('station-local flight times preserve an explicit next-day event date across midnight', () => {
  const operatingDate = '2026-10-01';
  const localEventDate = '2026-10-02';
  const mel = resolveStationLocalDateTime(localEventDate, '00:15', MEL);
  const akl = resolveStationLocalDateTime(localEventDate, '00:15', AKL);
  assert.equal(mel.instantUtc, '2026-10-01T14:15:00.000Z');
  assert.equal(akl.instantUtc, '2026-10-01T11:15:00.000Z');
  assert.notEqual(localEventDate, operatingDate);
  assert.equal(formatInstantInStation(mel.instantUtc, MEL).dateKey, localEventDate);
  assert.equal(formatInstantInStation(akl.instantUtc, AKL).dateKey, localEventDate);
});

test('station-local input validation rejects malformed date, time, and disambiguation without guessing', () => {
  const invalid = [
    () => resolveStationLocalDateTime('04/05/2026', '02:30', MEL),
    () => resolveStationLocalDateTime('2026-02-30', '02:30', MEL),
    () => resolveStationLocalDateTime('2026-04-05', '2:30', MEL),
    () => resolveStationLocalDateTime('2026-04-05', '24:00', MEL),
    () => resolveStationLocalDateTime('2026-04-05', '02:30', MEL, 'COMPATIBLE')
  ];
  for (const operation of invalid) assert.throws(operation, StationTimeError);
});

test('station-local ETD and In Block resolution is independent of the Node process timezone', () => {
  const modulePath = path.join(root, 'api/shared/station-time.js');
  const script = `const {resolveStationLocalDateTime:r}=require(${JSON.stringify(modulePath)});process.stdout.write(JSON.stringify({mel:r('2026-04-05','02:30','Australia/Melbourne','LATER'),akl:r('2026-10-02','00:15','Pacific/Auckland')}));`;
  const outputs = ['UTC', MEL, AKL, 'America/Los_Angeles'].map(timeZone => {
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', env: { ...process.env, TZ: timeZone }
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  });
  assert.equal(new Set(outputs).size, 1);
});

test('flights API stores ordinary MEL and AKL ETD and In Block inputs as authoritative UTC', async () => {
  const cases = [
    ['1', MEL, '2026-10-01T08:30:00.000Z'],
    ['8', AKL, '2026-10-01T05:30:00.000Z']
  ];
  for (const [stationId, timeZoneId, instantUtc] of cases) {
    const etdHarness = apiHarness({ stationId });
    const etd = await callApi(etdHarness, {
      flightId: '901', estimatedDepartureLocal: { localDate: '2026-10-01', localTime: '18:30', disambiguation: null }
    });
    assert.equal(etd.status, 200);
    assert.equal(etd.body.flight.EstimatedDepartureUtc, instantUtc);
    assert.equal(etd.body.stationTimeResolution.timeZoneId, timeZoneId);
    assert.equal(etd.body.stationTimeResolution.estimatedDepartureUtc, instantUtc);
    assert.equal(etdHarness.state.updateCount, 1);
    assert.equal(etdHarness.state.commits, 1);

    const inBlockHarness = apiHarness({ stationId, direction: 'IMPORT' });
    const inBlock = await callApi(inBlockHarness, {
      flightId: '901', inBlockLocal: { localDate: '2026-10-01', localTime: '18:30' }
    });
    assert.equal(inBlock.status, 200);
    assert.equal(inBlock.body.flight.InBlockAtUtc, instantUtc);
    assert.equal(inBlock.body.stationTimeResolution.inBlockAtUtc, instantUtc);
  }
});

test('flights API rejects unique-time EARLIER and LATER choices without mutation, audit, or commit', async () => {
  for (const stationId of ['1', '8']) {
    for (const disambiguation of ['EARLIER', 'LATER']) {
      const harness = apiHarness({ stationId });
      const response = await callApi(harness, {
        flightId: '901', estimatedDepartureLocal: { localDate: '2026-10-01', localTime: '18:30', disambiguation }
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'LOCAL_TIME_DISAMBIGUATION_INVALID');
      assert.equal(harness.state.updateCount, 0);
      assert.equal(harness.state.audits.length, 0);
      assert.equal(harness.state.commits, 0);
      assert.equal(harness.state.rollbacks, 1);
    }
  }
});

test('flights API rejects MEL and AKL DST gaps without any update or commit', async () => {
  for (const [stationId, localDate, timeZoneId] of [
    ['1', '2026-10-04', MEL], ['8', '2026-09-27', AKL]
  ]) {
    const harness = apiHarness({ stationId, direction: 'IMPORT' });
    const response = await callApi(harness, {
      flightId: '901', inBlockLocal: { localDate, localTime: '02:30' }
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.code, 'LOCAL_TIME_NONEXISTENT');
    assert.equal(response.body.timeZoneId, timeZoneId);
    assert.equal(harness.state.updateCount, 0);
    assert.equal(harness.state.commits, 0);
    assert.equal(harness.state.rollbacks, 1);
  }
});

test('flights API rejects gaps even when EARLIER or LATER is supplied', async () => {
  for (const [stationId, localDate] of [['1', '2026-10-04'], ['8', '2026-09-27']]) {
    for (const disambiguation of ['EARLIER', 'LATER']) {
      const harness = apiHarness({ stationId, direction: 'IMPORT' });
      const response = await callApi(harness, {
        flightId: '901', inBlockLocal: { localDate, localTime: '02:30', disambiguation }
      });
      assert.equal(response.status, 422);
      assert.equal(response.body.code, 'LOCAL_TIME_NONEXISTENT');
      assert.equal(harness.state.updateCount, 0);
      assert.equal(harness.state.audits.length, 0);
      assert.equal(harness.state.commits, 0);
      assert.equal(harness.state.rollbacks, 1);
    }
  }
});

test('flights API returns safe MEL and AKL fold choices and does not mutate before selection', async () => {
  for (const [stationId, timeZoneId] of [['1', MEL], ['8', AKL]]) {
    const harness = apiHarness({ stationId });
    const response = await callApi(harness, {
      flightId: '901', estimatedDepartureLocal: { localDate: '2026-04-05', localTime: '02:30' }
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'LOCAL_TIME_AMBIGUOUS');
    assert.equal(response.body.timeZoneId, timeZoneId);
    assert.deepEqual(response.body.candidates.map(candidate => candidate.disambiguation), ['EARLIER', 'LATER']);
    assert.notEqual(response.body.candidates[0].instantUtc, response.body.candidates[1].instantUtc);
    for (const candidate of response.body.candidates) {
      assert.match(candidate.offset, /^[+-]\d{2}:\d{2}$/);
      assert.ok(candidate.timeZoneName);
      assert.ok(candidate.label);
      assert.doesNotMatch(candidate.label, /â€”/);
    }
    assert.equal(harness.state.updateCount, 0);
    assert.equal(harness.state.commits, 0);
    assert.equal(harness.state.rollbacks, 1);
  }
});

test('flights API reruns MEL and AKL fold resolution for explicit EARLIER and LATER choices', async () => {
  const expected = {
    '1': ['2026-04-04T15:30:00.000Z', '2026-04-04T16:30:00.000Z'],
    '8': ['2026-04-04T13:30:00.000Z', '2026-04-04T14:30:00.000Z']
  };
  for (const stationId of ['1', '8']) {
    for (const [index, disambiguation] of ['EARLIER', 'LATER'].entries()) {
      const harness = apiHarness({ stationId });
      const response = await callApi(harness, {
        flightId: '901', estimatedDepartureLocal: {
          localDate: '2026-04-05', localTime: '02:30', disambiguation,
          candidateUtc: '2000-01-01T00:00:00.000Z'
        }
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.flight.EstimatedDepartureUtc, expected[stationId][index]);
      assert.equal(response.body.stationTimeResolution.estimatedDepartureUtc, expected[stationId][index]);
      assert.equal(harness.state.updateCount, 1);
    }
  }
});

test('flights API validates the explicit local contract and never treats blank values as an instant', async () => {
  const cases = [
    [{ localDate: '04/05/2026', localTime: '02:30' }, 'LOCAL_DATE_INVALID'],
    [{ localDate: '2026-04-05', localTime: '2:30' }, 'LOCAL_TIME_INVALID'],
    [{ localDate: '2026-04-05', localTime: '02:30', disambiguation: 'COMPATIBLE' }, 'LOCAL_TIME_DISAMBIGUATION_INVALID'],
    [null, 'LOCAL_DATE_INVALID'],
    [{ localDate: '', localTime: '' }, 'LOCAL_DATE_INVALID']
  ];
  for (const [estimatedDepartureLocal, code] of cases) {
    const harness = apiHarness({ stationId: '1' });
    const response = await callApi(harness, { flightId: '901', estimatedDepartureLocal });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, code);
    assert.equal(harness.state.updateCount, 0);
    assert.equal(harness.state.commits, 0);
  }
});

test('flights API rejects browser-generated manual UTC fields only after exact-entity authorization', async () => {
  const allowed = apiHarness({ stationId: '8' });
  const legacy = await callApi(allowed, {
    flightId: '901', stationId: '1', estimatedDepartureUtc: '2026-10-01T08:30:00.000Z'
  });
  assert.equal(legacy.status, 400);
  assert.equal(legacy.body.code, 'LOCAL_TIME_INPUT_REQUIRED');
  assert.equal(allowed.state.updateCount, 0);

  const denied = apiHarness({ stationId: '8', authorized: false });
  const denial = await callApi(denied, {
    flightId: '901', stationId: '1', estimatedDepartureUtc: '2026-10-01T08:30:00.000Z'
  });
  assert.equal(denial.status, 404);
  assert.equal(denial.body.code, 'OPERATIONAL_ENTITY_NOT_AVAILABLE');
  assert.doesNotMatch(JSON.stringify(denial.body), /AKL|Auckland|Pacific\/Auckland/);
  assert.equal(denied.state.updateCount, 0);
});

test('real authorization helper masks a cross-station timing target before validation or write', async () => {
  const harness = realAuthorizationDenialHarness();
  const response = await callApi(harness, {
    flightId: '901', stationId: '1', selectedStationCode: 'MEL',
    estimatedDepartureLocal: { localDate: '2026-10-04', localTime: '02:30' }
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'OPERATIONAL_ENTITY_NOT_AVAILABLE');
  assert.doesNotMatch(JSON.stringify(response.body), /AKL|Auckland|Pacific\/Auckland|CLOSED|daylight|02:30/);
  assert.equal(harness.state.commits, 0);
  assert.equal(harness.state.rollbacks, 1);
  assert.equal(harness.state.calls.some(call => /^UPDATE\b/i.test(call.query)), false);
});

test('exact AKL flight ownership overrides selected MEL and MEL-looking route fields', async () => {
  const harness = apiHarness({ stationId: '8' });
  const response = await callApi(harness, {
    flightId: '901', stationId: '1', selectedStationCode: 'MEL',
    estimatedDepartureLocal: { localDate: '2026-10-01', localTime: '18:30' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.stationTimeResolution.stationCode, 'AKL');
  assert.equal(response.body.stationTimeResolution.timeZoneId, AKL);
  assert.equal(response.body.flight.EstimatedDepartureUtc, '2026-10-01T05:30:00.000Z');
});

test('next-day In Block input is not forced back to Flight OperatingDate', async () => {
  const harness = apiHarness({ stationId: '8', direction: 'IMPORT' });
  harness.state.flight.OperatingDate = '2026-10-01';
  const response = await callApi(harness, {
    flightId: '901', inBlockLocal: { localDate: '2026-10-02', localTime: '00:15' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.flight.InBlockAtUtc, '2026-10-01T11:15:00.000Z');
});

test('updating one local field does not rewrite historical UTC flight timestamps', async () => {
  const harness = apiHarness({ stationId: '8' });
  const historicalScheduled = harness.state.flight.ScheduledDepartureUtc;
  const historicalInBlock = harness.state.flight.InBlockAtUtc;
  const response = await callApi(harness, {
    flightId: '901', estimatedDepartureLocal: { localDate: '2026-10-01', localTime: '18:30' }
  });
  assert.equal(response.status, 200);
  assert.equal(harness.state.flight.ScheduledDepartureUtc, historicalScheduled);
  assert.equal(harness.state.flight.InBlockAtUtc, historicalInBlock);
});

test('ungated absolute scheduled departure is rejected after exact authorization', async () => {
  const harness = apiHarness({ stationId: '8' });
  const historicalScheduled = harness.state.flight.ScheduledDepartureUtc;
  const response = await callApi(harness, {
    flightId: '901', scheduledDepartureUtc: '2026-10-01T08:30:00.000Z'
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'LOCAL_TIME_INPUT_REQUIRED');
  assert.equal(harness.state.flight.ScheduledDepartureUtc, historicalScheduled);
  assert.equal(harness.state.updateCount, 0);
  assert.equal(harness.state.commits, 0);
});

test('flight timing lifecycle rejects ETD on imports, In Block on exports, and mixed changes', async () => {
  const importEtd = apiHarness({ stationId: '1', direction: 'IMPORT' });
  const importResponse = await callApi(importEtd, {
    flightId: '901', estimatedDepartureLocal: { localDate: '2026-10-01', localTime: '18:30' }
  });
  assert.equal(importResponse.status, 409);
  assert.equal(importResponse.body.code, 'FLIGHT_TIMING_NOT_ALLOWED');
  assert.equal(importEtd.state.updateCount, 0);

  const exportInBlock = apiHarness({ stationId: '1', direction: 'EXPORT' });
  const exportResponse = await callApi(exportInBlock, {
    flightId: '901', inBlockLocal: { localDate: '2026-10-01', localTime: '18:30' }
  });
  assert.equal(exportResponse.status, 409);
  assert.equal(exportResponse.body.code, 'FLIGHT_TIMING_NOT_ALLOWED');
  assert.equal(exportInBlock.state.updateCount, 0);

  const mixed = apiHarness({ stationId: '1', direction: 'IMPORT' });
  const mixedResponse = await callApi(mixed, {
    flightId: '901',
    estimatedDepartureLocal: { localDate: '2026-10-01', localTime: '18:30' },
    inBlockLocal: { localDate: '2026-10-01', localTime: '18:30' }
  });
  assert.equal(mixedResponse.status, 400);
  assert.equal(mixedResponse.body.code, 'FLIGHT_TIMING_INPUT_INVALID');
  assert.equal(mixed.state.updateCount, 0);
});

test('locked current lifecycle state rejects timing changes before mutation', async () => {
  const harness = apiHarness({ stationId: '8', flightStatus: 'CLOSED' });
  const response = await callApi(harness, {
    flightId: '901', estimatedDepartureLocal: { localDate: '2026-10-01', localTime: '18:30' }
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'FLIGHT_TIMING_NOT_ALLOWED');
  assert.equal(harness.state.updateCount, 0);
  assert.equal(harness.state.commits, 0);
  const ownershipRead = harness.state.calls.find(call => call.values.AuthorizationFlightId === '901');
  assert.ok(ownershipRead);
  assert.equal(ownershipRead.transaction, true);
  assert.match(ownershipRead.query, /WITH \(UPDLOCK,HOLDLOCK\)/);
});

test('a concurrent close commits before a waiting timing mutation rechecks lifecycle', async () => {
  const harness = timingLifecycleRaceHarness();
  const hold = harness.holdNextRowLock();
  const closing = harness.call({
    flightId: '901', expectedStatus: 'ACTIVE', nextStatus: 'CLOSED'
  });
  await hold.acquired;

  let timingSettled = false;
  const timing = harness.call({
    flightId: '901', inBlockLocal: { localDate: '2026-10-02', localTime: '00:15' }
  }).finally(() => { timingSettled = true; });
  while (harness.state.rowLockAttempts < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(timingSettled, false);

  hold.release();
  const [closed, rejected] = await Promise.all([closing, timing]);
  assert.equal(closed.status, 200);
  assert.equal(closed.body.flight.FlightStatus, 'CLOSED');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'FLIGHT_TIMING_NOT_ALLOWED');
  assert.equal(harness.state.flight.FlightStatus, 'CLOSED');
  assert.equal(harness.state.timingUpdates, 0);
  assert.equal(harness.state.commits, 1);
  assert.equal(harness.state.rollbacks, 1);
});

test('frontend sends local calendar fields and offers server-provided fold choices without browser conversion', () => {
  const html = read('index.html');
  const inBlock = html.slice(html.indexOf('function showSetInBlock('), html.indexOf('function showFlightStatusSettings('));
  const etd = html.slice(html.indexOf('function showSetExportEtd('), html.indexOf('function showConfirmBulkMailScan('));
  for (const source of [inBlock, etd]) {
    assert.match(source, /type="date"/);
    assert.match(source, /type="time"/);
    assert.match(source, /LOCAL_TIME_NONEXISTENT/);
    assert.match(source, /LOCAL_TIME_AMBIGUOUS/);
    assert.match(source, /'EARLIER'/);
    assert.match(source, /'LATER'/);
    assert.doesNotMatch(source, /getTimezoneOffset|new Date\(`\$\{date\}T|toLocaleString/);
  }
  assert.match(inBlock, /JSON\.stringify\(\{flightId:f\.azureFlightId,inBlockLocal\}\)/);
  assert.doesNotMatch(inBlock, /inBlockAtUtc\}\)/);
  assert.match(etd, /JSON\.stringify\(\{flightId:f\.azureFlightId,estimatedDepartureLocal\}\)/);
  assert.doesNotMatch(etd, /estimatedDepartureUtc:local\.toISOString/);
});

test('manual Flight creation has no ETD or In Block input and keeps its authorized requested station', () => {
  const source = read('api/flights/index.js');
  const create = source.slice(source.indexOf('const flightNumber = clean(body.flightNumber)'), source.indexOf('} catch (err)'));
  assert.match(create, /resolveAuthorizedStation\(/);
  assert.match(create, /INSERT INTO dbo\.Flights\(StationId,FlightNumber,OperatingDate,Direction/);
  assert.doesNotMatch(create, /EstimatedDeparture|InBlock|ScheduledDeparture/);
});

test('historical UTC flight values remain absolute instants and are not double converted', () => {
  const storedUtc = '2026-10-01T13:15:00.000Z';
  assert.equal(formatInstantInStation(storedUtc, MEL).localDateTime, '01/10/2026 23:15');
  assert.equal(formatInstantInStation(storedUtc, AKL).localDateTime, '02/10/2026 02:15');
  assert.equal(new Date(storedUtc).toISOString(), storedUtc);
});

test('MACH FOW StsTime remains local source evidence outside the flight-time conversion contract', () => {
  const source = read('api/mach-fow/index.js');
  assert.match(source, /EventLocalDateTime/);
  assert.match(source, /function parseEventLocal\(/);
  assert.match(source, /function preserveLocalWallClock\(/);
  assert.doesNotMatch(source, /resolveStationLocalDateTime/);
});
