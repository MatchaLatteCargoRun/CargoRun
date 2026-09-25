'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flightHelpers = require('../api/shared/flight');
const { normalizeUldNumber } = require('../api/shared/uld');
const { insertAuditEvent } = require('../api/shared/audit');

const root = path.resolve(__dirname, '..');
const principal = Buffer.from(JSON.stringify({
  userRoles: ['authenticated'],
  userDetails: 'Test user',
  userId: 'test-user'
})).toString('base64');

function result(recordset = [], rowsAffected = []) {
  return { recordset, rowsAffected };
}

function harness(initialFlights = []) {
  const state = {
    flights: structuredClone(initialFlights),
    ulds: [],
    messages: [],
    links: [],
    uploads: [],
    finals: [],
    finalMembers: [],
    completions: [],
    audits: [],
    shcs: [],
    calls: [],
    commits: 0,
    rollbacks: 0,
    failAfterFlight: false,
    lockResult: 0,
    lockError: null,
    lockHolds: [],
    activeFlightLocks: 0,
    maxActiveFlightLocks: 0,
    failAudit: false,
    forceFinaliseCasLoss: false,
    mutateBeforeLockedRead: null
  };
  const lockTails = new Map();

  async function acquire(tx, resource) {
    const previous = lockTails.get(resource) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    lockTails.set(resource, previous.then(() => current));
    await previous;
    state.activeFlightLocks++;
    state.maxActiveFlightLocks = Math.max(state.maxActiveFlightLocks, state.activeFlightLocks);
    const hold = state.lockHolds.shift();
    if (hold) {
      hold.markAcquired();
      await hold.waitForRelease;
    }
    tx.releaseLock = () => {
      state.activeFlightLocks--;
      release();
    };
  }

  class Transaction {
    constructor() { this.id = Symbol('tx'); }
    async begin() { this.active = true; }
    async commit() {
      this.active = false;
      for (const collection of [state.flights, state.ulds, state.messages, state.links, state.uploads, state.finals, state.finalMembers, state.completions, state.audits, state.shcs]) {
        for (const row of collection) delete row.__tx;
      }
      for (const row of state.flights) delete row.__previousFlightStatus;
      state.commits++;
      this.releaseLock?.();
    }
    async rollback() {
      for (const row of state.flights) {
        if (row.__tx === this.id && Object.hasOwn(row, '__previousFlightStatus')) {
          row.FlightStatus = row.__previousFlightStatus;
          delete row.__previousFlightStatus;
          delete row.__tx;
        }
      }
      for (const name of ['flights', 'ulds', 'messages', 'links', 'uploads', 'finals', 'finalMembers', 'completions', 'audits', 'shcs']) {
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
        if (state.mutateBeforeLockedRead) {
          const mutate = state.mutateBeforeLockedRead;
          state.mutateBeforeLockedRead = null;
          mutate(state);
        }
        await acquire(this.tx, p.FlightIdentityLockResource);
        return result([{ LockResult: state.lockResult }]);
      }
      if (q.includes('FROM INFORMATION_SCHEMA.COLUMNS') && p.TableName === 'ImportCompletionRecords') {
        return result([
          { COLUMN_NAME: 'ImportCompletionRecordId', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, DATA_TYPE: 'bigint', IS_IDENTITY: 1 },
          { COLUMN_NAME: 'FlightId', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, DATA_TYPE: 'bigint', IS_IDENTITY: 0 },
          { COLUMN_NAME: 'VerificationId', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '(newid())', DATA_TYPE: 'uniqueidentifier', IS_IDENTITY: 0 },
          { COLUMN_NAME: 'FinalisedAtUtc', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, DATA_TYPE: 'datetime2', IS_IDENTITY: 0 },
          { COLUMN_NAME: 'FinalisedByDisplayName', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, DATA_TYPE: 'nvarchar', IS_IDENTITY: 0 },
          { COLUMN_NAME: 'FinalisedByObjectId', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, DATA_TYPE: 'nvarchar', IS_IDENTITY: 0 },
          { COLUMN_NAME: 'ExceptionReason', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, DATA_TYPE: 'nvarchar', IS_IDENTITY: 0 },
          { COLUMN_NAME: 'SnapshotJson', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, DATA_TYPE: 'nvarchar', IS_IDENTITY: 0 },
          { COLUMN_NAME: 'RecordHash', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, DATA_TYPE: 'nvarchar', IS_IDENTITY: 0 }
        ]);
      }
      if (q.includes('FROM dbo.IncomingMachMessages')) {
        return result(state.messages.filter(row => row.DocumentCorID === p.DocumentCorID));
      }
      if (q.includes('FROM dbo.ExportManifestFinals')) {
        const id = p.ManifestFinalFlightId ?? p.ExistingFinalFlightId ?? p.ManualFinalFlightId ?? p.LockedFinalFlightId ?? p.FinalFlightId ?? p.UwsFinalFlightId ?? p.LockedUwsFinalFlightId;
        return result(state.finals.filter(row => String(row.FlightId) === String(id)));
      }
      if (q.startsWith('INSERT INTO dbo.ExportManifestFinals')) {
        const row = {
          FinalManifestId: state.finals.length + 1,
          FlightId: p.ManifestFlightId,
          ConfirmedAtUtc: '2026-09-17T01:00:00.000Z',
          ConfirmedByObjectId: p.ConfirmedByObjectId,
          ConfirmedByDisplayName: p.ConfirmedByDisplayName,
          SourceFileName: p.SourceFileName,
          ManifestHash: p.ManifestHash,
          FinalUldCount: p.FinalUldCount,
          MatchedCount: p.MatchedCount,
          AddedCount: p.AddedCount,
          ExcludedCount: p.ExcludedCount,
          __tx: this.tx.id
        };
        state.finals.push(row);
        return result([row]);
      }
      if (q.startsWith('INSERT INTO dbo.ExportManifestFinalUlds')) {
        state.finalMembers.push({
          FinalManifestId: p.MemberFinalManifestId,
          FlightId: p.MemberFlightId,
          UldId: p.MemberUldId,
          UldNumber: p.MemberUldNumber,
          ManifestOrdinal: p.MemberOrdinal,
          __tx: this.tx.id
        });
        return result();
      }
      if (q.includes('FROM INFORMATION_SCHEMA.COLUMNS') && p.AuditTableName === 'AuditEvents') {
        return result(['AuditEventId','EventType','Action','EntityType','EntityId','FlightNumber','UldNumber','FromStatus','ToStatus','OccurredAtUtc','ActorDisplayName','ActorReference','Detail','DetailsJson']
          .map(COLUMN_NAME => ({ COLUMN_NAME, IS_NULLABLE: 'YES' })));
      }
      if (q.startsWith('INSERT INTO dbo.AuditEvents')) {
        if (state.failAudit) throw new Error('forced audit failure');
        const row = { ...p, __tx: this.tx.id };
        state.audits.push(row);
        return result([row]);
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
        const messageId = p.MachMessageId ?? p.IgnoredMachMessageId;
        const row = state.messages.find(item => item.MachMessageId === messageId);
        if (row) Object.assign(row, {
          MatchedFlightId: p.FlightId ?? p.IgnoredMatchedFlightId,
          ProcessingStatus: p.IgnoredMachMessageId ? 'PROCESSED_POST_FINAL' : 'PROCESSED'
        });
        return result();
      }
      if (q.includes('FROM dbo.Flights')) {
        const exactId = p.SelectedFlightId ?? p.InitialFlightId ?? p.LockedFlightId ?? p.FlightId;
        const operatingDate = p.OperatingDate ?? p.UwsOperatingDate ?? p.LockedUwsOperatingDate;
        return result(state.flights.filter(row => exactId
          ? String(row.FlightId) === String(exactId)
          : (!operatingDate || String(row.OperatingDate) === String(operatingDate))
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
        const id = p.FlightId ?? p.PostFinalFlightId ?? p.LockedUldFlightId ?? p.PendingFlightId ?? p.CompletionUldFlightId ?? p.PreviewUldFlightId ?? p.UwsUldFlightId ?? p.LockedUwsUldFlightId;
        if (q.startsWith('SELECT COUNT(*) AS Pending')) {
          const pending = state.ulds.filter(row => String(row.FlightId) === String(id) && String(row.CurrentStatus || '').toUpperCase().replace(/ /g, '_') !== 'RECEIVED').length;
          return result([{ Pending: pending }]);
        }
        return result(state.ulds.filter(row => String(row.FlightId) === String(id)));
      }
      if (q.startsWith('SELECT TOP (2) * FROM dbo.ImportCompletionRecords')) {
        return result(state.completions.filter(row => String(row.FlightId) === String(p.CompletionFlightId)).slice(0, 2));
      }
      if (q.startsWith('INSERT INTO dbo.ImportCompletionRecords')) {
        const row = {
          ImportCompletionRecordId: state.completions.length + 1,
          FlightId: p.FlightId,
          VerificationId: `verification-${state.completions.length + 1}`,
          FinalisedAtUtc: p.FinalisedAtUtc,
          FinalisedByDisplayName: p.Actor,
          FinalisedByObjectId: p.ActorId,
          ExceptionReason: p.ExceptionReason,
          SnapshotJson: p.SnapshotJson,
          RecordHash: p.RecordHash,
          __tx: this.tx.id
        };
        state.completions.push(row);
        return result([row], [1]);
      }
      if (q.startsWith("UPDATE dbo.Flights SET FlightStatus='FINALISED'")) {
        const row = state.flights.find(item => String(item.FlightId) === String(p.FinaliseFlightId));
        if (state.forceFinaliseCasLoss) {
          if (row) row.FlightStatus = 'CLOSED';
          return result([], [0]);
        }
        if (!row || String(row.FlightStatus || '').trim().toUpperCase() !== 'ACTIVE') return result([], [0]);
        row.__previousFlightStatus = row.FlightStatus;
        row.__tx = this.tx.id;
        row.FlightStatus = 'FINALISED';
        return result([], [1]);
      }
      if (q.startsWith('INSERT INTO dbo.ULDs')) {
        const row = {
          ...p,
          FlightId: p.FlightId ?? p.AddedFlightId,
          UldNumber: p.UldNumber ?? p.AddedUldNumber,
          UldId: state.ulds.length + 1,
          CurrentStatus: p.CurrentStatus || 'WAREHOUSE',
          IdentityVerified: 0,
          __tx: this.tx.id
        };
        state.ulds.push(row);
        return result([row]);
      }
      if (q.startsWith('INSERT INTO dbo.UldSpecialHandlingCodes')) {
        state.shcs.push({ ...p, __tx: this.tx.id });
        return result();
      }
      if (q.startsWith('UPDATE dbo.ULDs')) {
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
    DateTime2: () => 'datetime2',
    Char: () => 'char',
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
              : name === '../shared/audit'
                ? { insertAuditEvent }
              : name === '../shared/completion-snapshot'
                ? {
                    CompletionSnapshotError: class CompletionSnapshotError extends Error {},
                    buildCompletionSnapshot: async (transaction, _sql, options) => ({
                      completionTimeUtc: new Date('2026-09-25T01:02:03.000Z'),
                      snapshot: {
                        flight: options.flight.FlightNumber,
                        flightId: String(options.flightId),
                        direction: 'IMPORT',
                        finalizedBy: options.actor.displayName,
                        finalizedById: options.actor.reference,
                        exceptionReason: options.exceptionReason || null,
                        ulds: state.ulds
                          .filter(row => String(row.FlightId) === String(options.flightId))
                          .map(row => ({ uldId: String(row.UldId), num: row.UldNumber, status: row.CurrentStatus }))
                      }
                    })
                  }
              : name === '../shared/export-manifest-final'
                ? require('../api/shared/export-manifest-final')
              : name === '../shared/export-uws'
                ? require('../api/shared/export-uws')
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

  function holdNextFlightLock() {
    let markAcquired;
    let release;
    const acquired = new Promise(resolve => { markAcquired = resolve; });
    const waitForRelease = new Promise(resolve => { release = resolve; });
    state.lockHolds.push({ markAcquired, waitForRelease });
    return { acquired, release };
  }

  return { state, call, holdNextFlightLock };
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

test('manifest FINAL does not let FOW reopen an operationally finalised flight', async () => {
  const api = harness([{ FlightId: 9, FlightNumber: 'CX0178', OperatingDate: '2026-09-17', Direction: 'EXPORT', FlightStatus: 'FINALISED' }]);
  api.state.finals.push({ FlightId: 9, FinalManifestId: 3 });
  const response = await api.call('mach-fow', fow('FOW-CLOSED-FINAL'));
  assert.equal(response.status, 409);
  assert.equal(api.state.messages.length, 0);
  assert.equal(api.state.audits.length, 0);
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

const importFlight = (flightId = 41, operatingDate = '2026-09-25', status = 'ACTIVE') => ({
  FlightId: flightId,
  FlightNumber: 'CX0134',
  OperatingDate: operatingDate,
  Direction: 'IMPORT',
  FlightStatus: status,
  AirlineCode: 'CX',
  OriginAirport: 'HKG',
  DestinationAirport: 'MEL'
});

test('Import Add ULD first makes finalisation wait and evaluate the committed pending ULD', async () => {
  const api = harness([importFlight()]);
  const hold = api.holdNextFlightLock();
  const adding = api.call('ulds', { flightId: '41', uldNumber: 'AKE12345CX' });
  await hold.acquired;
  const finalising = api.call('import-completions', { flightId: '41' });
  hold.release();

  const [added, finalised] = await Promise.all([adding, finalising]);
  assert.equal(added.status, 201);
  assert.equal(finalised.status, 409);
  assert.equal(finalised.body.code, 'IMPORT_ULDS_PENDING');
  assert.equal(api.state.ulds.length, 1);
  assert.equal(api.state.completions.length, 0);
  assert.equal(api.state.flights[0].FlightStatus, 'ACTIVE');
  assert.equal(api.state.maxActiveFlightLocks, 1);
});

test('Import finalisation first makes Add ULD wait and then reject the FINALISED flight', async () => {
  const api = harness([importFlight()]);
  const hold = api.holdNextFlightLock();
  const finalising = api.call('import-completions', { flightId: '41' });
  await hold.acquired;
  const adding = api.call('ulds', { flightId: '41', uldNumber: 'AKE12345CX' });
  hold.release();

  const [finalised, added] = await Promise.all([finalising, adding]);
  assert.equal(finalised.status, 201);
  assert.equal(added.status, 409);
  assert.equal(added.body.code, 'IMPORT_FLIGHT_NOT_ACTIVE');
  assert.equal(api.state.ulds.length, 0);
  assert.equal(api.state.completions.length, 1);
  assert.equal(api.state.flights[0].FlightStatus, 'FINALISED');
  assert.equal(api.state.maxActiveFlightLocks, 1);
});

test('simultaneous Import finalisers create one completion and one audit', async () => {
  const api = harness([importFlight()]);
  const responses = await Promise.all([
    api.call('import-completions', { flightId: '41' }),
    api.call('import-completions', { flightId: '41' })
  ]);

  assert.deepEqual(responses.map(item => item.status).sort(), [201, 409]);
  assert.equal(responses.find(item => item.status === 409).body.code, 'IMPORT_ALREADY_FINALISED');
  assert.equal(api.state.completions.length, 1);
  assert.equal(api.state.audits.length, 1);
  assert.equal(api.state.flights[0].FlightStatus, 'FINALISED');
  assert.equal(api.state.maxActiveFlightLocks, 1);
});

test('Import finalisation rejects non-active and non-Import flights under the canonical lock', async () => {
  const inactive = harness([importFlight(41, '2026-09-25', 'CLOSED')]);
  const inactiveResult = await inactive.call('import-completions', { flightId: '41' });
  assert.equal(inactiveResult.status, 409);
  assert.equal(inactiveResult.body.code, 'IMPORT_FLIGHT_NOT_ACTIVE');
  assert.equal(inactive.state.completions.length, 0);

  const exported = harness([{ ...importFlight(), Direction: 'EXPORT' }]);
  const exportResult = await exported.call('import-completions', { flightId: '41' });
  assert.equal(exportResult.status, 400);
  assert.equal(exportResult.body.code, 'IMPORT_FLIGHT_REQUIRED');
  assert.equal(exported.state.completions.length, 0);
});

test('Import finalisation detects lifecycle change between identity lookup and locked re-read', async () => {
  const api = harness([importFlight()]);
  api.state.mutateBeforeLockedRead = state => { state.flights[0].FlightStatus = 'CLOSED'; };
  const response = await api.call('import-completions', { flightId: '41' });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'IMPORT_FLIGHT_NOT_ACTIVE');
  assert.equal(api.state.completions.length, 0);
  assert.equal(api.state.audits.length, 0);
});

test('Import finalisation keeps exact FlightId when visible flight numbers repeat', async () => {
  const api = harness([
    importFlight(41, '2026-09-24'),
    importFlight(42, '2026-09-25')
  ]);
  api.state.ulds.push({ FlightId: 42, UldId: 71, UldNumber: 'AKE12345CX', CurrentStatus: 'RECEIVED', IdentityVerified: 1 });
  const response = await api.call('import-completions', { flightId: '42' });

  assert.equal(response.status, 201);
  assert.equal(String(api.state.completions[0].FlightId), '42');
  assert.equal(api.state.flights.find(row => row.FlightId === 41).FlightStatus, 'ACTIVE');
  assert.equal(api.state.flights.find(row => row.FlightId === 42).FlightStatus, 'FINALISED');

  const transactionalSql = api.state.calls.filter(call => call.inTransaction).map(call => call.q);
  const lockIndex = transactionalSql.findIndex(query => query.includes('sys.sp_getapplock'));
  const flightRowIndex = transactionalSql.findIndex(query => query.includes('FROM dbo.Flights WITH (UPDLOCK,HOLDLOCK)'));
  const completionIndex = transactionalSql.findIndex(query => query.includes('FROM dbo.ImportCompletionRecords WITH (UPDLOCK,HOLDLOCK)'));
  const uldRangeIndex = transactionalSql.findIndex(query => query.includes('FROM dbo.ULDs WITH (UPDLOCK,HOLDLOCK)'));
  const insertIndex = transactionalSql.findIndex(query => query.startsWith('INSERT INTO dbo.ImportCompletionRecords'));
  const lifecycleIndex = transactionalSql.findIndex(query => query.startsWith("UPDATE dbo.Flights SET FlightStatus='FINALISED'"));
  const auditIndex = transactionalSql.findIndex(query => query.startsWith('INSERT INTO dbo.AuditEvents'));
  assert.ok(lockIndex < flightRowIndex);
  assert.ok(flightRowIndex < completionIndex);
  assert.ok(completionIndex < uldRangeIndex);
  assert.ok(uldRangeIndex < insertIndex);
  assert.ok(insertIndex < lifecycleIndex);
  assert.ok(lifecycleIndex < auditIndex);
  assert.match(transactionalSql[lifecycleIndex], /FlightId=@FinaliseFlightId AND UPPER\(LTRIM\(RTRIM\(FlightStatus\)\)\)='ACTIVE'/);
  const lockCall = api.state.calls.find(call => call.q.includes('sys.sp_getapplock'));
  assert.equal(lockCall.p.FlightIdentityLockResource, 'CargoRun:Flight:2026-09-25:CX134');
});

test('Import finalisation rolls back completion when lifecycle compare-and-set loses', async () => {
  const api = harness([importFlight()]);
  api.state.forceFinaliseCasLoss = true;
  const response = await api.call('import-completions', { flightId: '41' });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'IMPORT_FINALISATION_CONFLICT');
  assert.equal(api.state.completions.length, 0);
  assert.equal(api.state.audits.length, 0);
  assert.equal(api.state.flights[0].FlightStatus, 'CLOSED');
  assert.equal(api.state.rollbacks, 1);
});

test('Import finalisation audit failure rolls back completion and FINALISED state', async () => {
  const api = harness([importFlight()]);
  api.state.failAudit = true;
  const response = await api.call('import-completions', { flightId: '41' });

  assert.equal(response.status, 500);
  assert.equal(api.state.completions.length, 0);
  assert.equal(api.state.audits.length, 0);
  assert.equal(api.state.flights[0].FlightStatus, 'ACTIVE');
  assert.equal(api.state.rollbacks, 1);
});

const finalManifest = (flightId, ulds) => ({
  action: 'CONFIRM',
  flightId,
  sourceFileName: 'Final Export Unit List.xlsx',
  ulds: ulds.map(uldNumber => ({ uldNumber }))
});

test('FINAL reconciliation preserves operational truth, adds only missing ULDs, and retains exclusions', async () => {
  const api = harness([{ FlightId: 41, FlightNumber: 'CX0178', OperatingDate: '2026-09-17', Direction: 'EXPORT', FlightStatus: 'ACTIVE' }]);
  api.state.ulds.push(
    { FlightId: 41, UldId: 11, UldNumber: 'AKE11111CX', CurrentStatus: 'AT_AIRCRAFT', IdentityVerified: 1 },
    { FlightId: 41, UldId: 12, UldNumber: 'AKE22222CX', CurrentStatus: 'TRANSIT', IdentityVerified: 1 }
  );

  const response = await api.call('export-manifest-final', finalManifest('41', ['ake-11111-cx', 'PMC33333CX']));
  assert.equal(response.status, 201);
  assert.deepEqual(
    {
      final: response.body.reconciliation.finalUldCount,
      matched: response.body.reconciliation.matchedCount,
      added: response.body.reconciliation.addedCount,
      excluded: response.body.reconciliation.excludedCount
    },
    { final: 2, matched: 1, added: 1, excluded: 1 }
  );
  assert.equal(api.state.ulds.find(row => row.UldId === 11).CurrentStatus, 'AT_AIRCRAFT');
  assert.equal(api.state.ulds.find(row => row.UldId === 11).IdentityVerified, 1);
  assert.equal(api.state.ulds.find(row => row.UldId === 12).CurrentStatus, 'TRANSIT');
  assert.equal(api.state.ulds.find(row => row.UldId === 12).IdentityVerified, 1);
  assert.equal(api.state.ulds.find(row => row.UldNumber === 'PMC33333CX').CurrentStatus, 'WAREHOUSE');
  assert.deepEqual(api.state.finalMembers.map(row => row.UldNumber), ['AKE11111CX', 'PMC33333CX']);
  assert.equal(api.state.audits.at(-1).AuditAction, 'EXPORT_MANIFEST_FINAL_CONFIRMED');

  const repeated = await api.call('export-manifest-final', finalManifest('41', ['AKE11111CX', 'PMC33333CX']));
  assert.equal(repeated.status, 409);
  assert.equal(repeated.body.code, 'EXPORT_MANIFEST_ALREADY_FINAL');
  assert.equal(api.state.finals.length, 1);
});

test('post-FINAL FOW remains idempotent evidence and cannot add or reset ULDs', async () => {
  const api = harness([{ FlightId: 41, FlightNumber: 'CX178', OperatingDate: '2026-09-17', Direction: 'EXPORT', FlightStatus: 'ACTIVE' }]);
  api.state.ulds.push({ FlightId: 41, UldId: 11, UldNumber: 'AKE11111CX', CurrentStatus: 'AT_AIRCRAFT', IdentityVerified: 1 });
  assert.equal((await api.call('export-manifest-final', finalManifest('41', ['AKE11111CX']))).status, 201);

  const manualAdd = await api.call('ulds', { flightId: '41', uldNumber: 'AKE99999CX' });
  assert.equal(manualAdd.status, 409);
  assert.equal(manualAdd.body.code, 'EXPORT_MANIFEST_ALREADY_FINAL');
  const repeatedUpload = await api.call('manifest-upload', upload('CX178', '2026-09-17', '99999'));
  assert.equal(repeatedUpload.status, 409);
  assert.equal(repeatedUpload.body.code, 'EXPORT_MANIFEST_ALREADY_FINAL');

  const response = await api.call('mach-fow', fow('FOW-AFTER-FINAL', ['11111', '99999']));
  assert.equal(response.status, 201);
  assert.equal(response.body.ignoredPostFinal, true);
  assert.equal(api.state.ulds.length, 1);
  assert.equal(api.state.ulds[0].CurrentStatus, 'AT_AIRCRAFT');
  assert.equal(api.state.ulds[0].IdentityVerified, 1);
  assert.deepEqual(api.state.finalMembers.map(row => row.UldNumber), ['AKE11111CX']);
  assert.equal(api.state.audits.at(-1).AuditAction, 'POST_FINAL_FOW_IGNORED');

  const duplicate = await api.call('mach-fow', fow('FOW-AFTER-FINAL', ['99999']));
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(api.state.messages.length, 1);
});

test('concurrent FOW and Confirm Final share the flight lock and never leak a non-final ULD into membership', async () => {
  const api = harness([{ FlightId: 41, FlightNumber: 'CX178', OperatingDate: '2026-09-17', Direction: 'EXPORT', FlightStatus: 'ACTIVE' }]);
  api.state.ulds.push({ FlightId: 41, UldId: 11, UldNumber: 'AKE11111CX', CurrentStatus: 'WAREHOUSE', IdentityVerified: 0 });
  const [confirmed, fowResult] = await Promise.all([
    api.call('export-manifest-final', finalManifest('41', ['AKE11111CX', 'PMC33333CX'])),
    api.call('mach-fow', fow('FOW-FINAL-RACE', ['99999']))
  ]);
  assert.equal(confirmed.status, 201);
  assert.equal(fowResult.status, 201);
  assert.deepEqual(api.state.finalMembers.map(row => row.UldNumber), ['AKE11111CX', 'PMC33333CX']);
  assert.equal(api.state.finalMembers.some(row => row.UldNumber === 'AKE99999CX'), false);
  const finalLock = api.state.calls.find(call => call.q.includes('sys.sp_getapplock') && call.p.FlightIdentityLockResource);
  assert.equal(finalLock.p.FlightIdentityLockResource, 'CargoRun:Flight:2026-09-17:CX178');
});

test('FINAL uses exact FlightId when the visible flight number repeats on different dates', async () => {
  const api = harness([
    { FlightId: 41, FlightNumber: 'CX178', OperatingDate: '2026-09-17', Direction: 'EXPORT', FlightStatus: 'ACTIVE' },
    { FlightId: 42, FlightNumber: 'CX0178', OperatingDate: '2026-09-18', Direction: 'EXPORT', FlightStatus: 'ACTIVE' }
  ]);
  api.state.ulds.push(
    { FlightId: 41, UldId: 11, UldNumber: 'AKE11111CX', CurrentStatus: 'WAREHOUSE', IdentityVerified: 0 },
    { FlightId: 42, UldId: 12, UldNumber: 'AKE22222CX', CurrentStatus: 'WAREHOUSE', IdentityVerified: 0 }
  );
  const response = await api.call('export-manifest-final', finalManifest('42', ['AKE22222CX']));
  assert.equal(response.status, 201);
  assert.equal(String(api.state.finals[0].FlightId), '42');
  assert.deepEqual(api.state.finalMembers.map(row => String(row.UldId)), ['12']);
  assert.equal(api.state.ulds.length, 2);
});

function exportUwsBody(action = 'PARSE_EXPORT_UWS') {
  const sparse = (size, values) => {
    const row = Array(size).fill('');
    for (const [index, value] of Object.entries(values)) row[Number(index)] = value;
    return row;
  };
  return {
    action,
    sourceFileName: 'renamed-document.xlsx',
    workbook: { sheets: [{ name: 'Sheet1', rows: [
      sparse(28, { 1: 'CX', 5: 'ULD/BULK LOAD WEIGHT STATEMENT' }),
      sparse(28, { 1: 'STATION', 5: 'FLIGHT NO', 24: 'DATE' }),
      sparse(28, { 1: 'MEL', 5: 'CX0134', 24: '19-Sep-2026' }),
      sparse(28, { 1: 'UNIT LOAD DEVICES(ULD)' }),
      sparse(28, { 2: 'Number', 4: 'Unload Station', 5: 'Pcs', 7: 'Tare Weight', 9: 'Net Weight', 11: 'Gross Weight', 25: 'SHC', 27: 'Remarks' }),
      sparse(28, { 2: 'AKE47186CX', 4: 'HKG', 5: 1, 7: 86, 9: 1384, 11: 1470, 25: 'ICE,PER', 27: 'DRY ICE 30 KG' }),
      sparse(28, { 1: 'ULD TOTAL' })
    ] }] }
  };
}

test('manual UWS parse resolves exact dated FlightId and remains read-only', async () => {
  const api = harness([
    { FlightId: 81, FlightNumber: 'CX0134', OperatingDate: '2026-09-18', Direction: 'EXPORT', FlightStatus: 'ACTIVE', OriginAirport: 'MEL', DestinationAirport: 'HKG' },
    { FlightId: 82, FlightNumber: 'CX134', OperatingDate: '2026-09-19', Direction: 'EXPORT', FlightStatus: 'ACTIVE', OriginAirport: 'MEL', DestinationAirport: 'HKG' }
  ]);
  api.state.ulds.push({ FlightId: 82, UldId: 22, UldNumber: 'AKE47186CX', CurrentStatus: 'AT_AIRCRAFT', IdentityVerified: 1 });
  const before = structuredClone(api.state.ulds);
  const response = await api.call('manifest-upload', exportUwsBody());
  assert.equal(response.status, 200);
  assert.equal(response.body.document.documentType, 'EXPORT_UWS');
  assert.equal(response.body.exactMatch.flightId, '82');
  assert.equal(response.body.reconciliation.matched[0].currentStatus, 'AT_AIRCRAFT');
  assert.deepEqual(api.state.ulds, before);
  assert.equal(api.state.uploads.length, 0);
  assert.equal(api.state.finals.length, 0);
});

test('explicit UWS review records source and audit atomically without confirming FINAL or changing status', async () => {
  const api = harness([
    { FlightId: 82, FlightNumber: 'CX134', OperatingDate: '2026-09-19', Direction: 'EXPORT', FlightStatus: 'ACTIVE', OriginAirport: 'MEL', DestinationAirport: 'HKG' }
  ]);
  api.state.ulds.push({ FlightId: 82, UldId: 22, UldNumber: 'AKE47186CX', CurrentStatus: 'TRANSIT', IdentityVerified: 1 });
  const response = await api.call('manifest-upload', exportUwsBody('REVIEW_EXPORT_UWS'));
  assert.equal(response.status, 200);
  assert.equal(response.body.exactMatch.flightId, '82');
  assert.equal(api.state.uploads.length, 1);
  assert.equal(api.state.uploads[0].UwsUploadType, 'EXPORT_UWS');
  assert.equal(api.state.audits.at(-1).AuditAction, 'EXPORT_UWS_REVIEWED');
  assert.equal(api.state.ulds[0].CurrentStatus, 'TRANSIT');
  assert.equal(api.state.ulds[0].IdentityVerified, 1);
  assert.equal(api.state.finals.length, 0);
  assert.equal(api.state.commits, 1);
});

test('UWS fails closed on duplicate exact flight identity, direction mismatch, and existing FINAL', async () => {
  const duplicate = harness([
    { FlightId: 82, FlightNumber: 'CX134', OperatingDate: '2026-09-19', Direction: 'EXPORT', FlightStatus: 'ACTIVE', OriginAirport: 'MEL', DestinationAirport: 'HKG' },
    { FlightId: 83, FlightNumber: 'CX0134', OperatingDate: '2026-09-19', Direction: 'EXPORT', FlightStatus: 'ACTIVE', OriginAirport: 'MEL', DestinationAirport: 'HKG' }
  ]);
  assert.equal((await duplicate.call('manifest-upload', exportUwsBody())).body.code, 'UWS_FLIGHT_IDENTITY_CONFLICT');
  assert.equal(duplicate.state.uploads.length, 0);

  const wrongDirection = harness([
    { FlightId: 82, FlightNumber: 'CX134', OperatingDate: '2026-09-19', Direction: 'IMPORT', FlightStatus: 'ACTIVE', OriginAirport: 'MEL', DestinationAirport: 'HKG' }
  ]);
  assert.equal((await wrongDirection.call('manifest-upload', exportUwsBody())).body.code, 'UWS_DIRECTION_MISMATCH');

  const final = harness([
    { FlightId: 82, FlightNumber: 'CX134', OperatingDate: '2026-09-19', Direction: 'EXPORT', FlightStatus: 'ACTIVE', OriginAirport: 'MEL', DestinationAirport: 'HKG' }
  ]);
  final.state.finals.push({ FinalManifestId: 9, FlightId: 82 });
  const response = await final.call('manifest-upload', exportUwsBody('REVIEW_EXPORT_UWS'));
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'EXPORT_MANIFEST_ALREADY_FINAL');
  assert.equal(final.state.uploads.length, 0);
  assert.equal(final.state.audits.length, 0);
});
