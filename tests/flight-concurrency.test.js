'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flightHelpers = require('../api/shared/flight');
const { normalizeUldNumber } = require('../api/shared/uld');
const { insertAuditEvent } = require('../api/shared/audit');
const documentCorIdHelpers = require('../api/shared/document-cor-id');
const machineStationBinding = require('../api/shared/machine-station-binding');
const operationalAuthorization = require('./helpers/operational-authorization-stub');
const realOperationalAuthorization = require('../api/shared/operational-authorization');
const realStation = require('../api/shared/station');
const h1Stations = [
  { StationId: '1', StationCode: 'MEL', DisplayName: 'Melbourne', TimeZoneId: 'Australia/Melbourne', IsEnabled: 1 },
  { StationId: '2', StationCode: 'AKL', DisplayName: 'Auckland', TimeZoneId: 'Pacific/Auckland', IsEnabled: 1 }
];
const stationLocalInput = require('../api/shared/station-local-input');

const root = path.resolve(__dirname, '..');
const principal = Buffer.from(JSON.stringify({
  userRoles: ['authenticated'],
  userDetails: 'Test user',
  userId: 'test-user'
})).toString('base64');

function result(recordset = [], rowsAffected = []) {
  return { recordset, rowsAffected };
}

function binaryDocumentCorIdEquals(left, right) {
  const leftBytes = Buffer.from(String(left ?? ''), 'utf16le');
  const rightBytes = Buffer.from(String(right ?? ''), 'utf16le');
  return leftBytes.length === rightBytes.length && leftBytes.equals(rightBytes);
}

function harness(initialFlights = [], harnessOptions = {}) {
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
    documentLockHolds: [],
    activeFlightLocks: 0,
    maxActiveFlightLocks: 0,
    activeDocumentLocks: 0,
    maxActiveDocumentLocks: 0,
    uniqueDocumentConflict: null,
    failAudit: false,
    forceFinaliseCasLoss: false,
    mutateBeforeLockedRead: null
  };
  const lockTails = new Map();

  async function acquire(tx, resource, kind) {
    const previous = lockTails.get(resource) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    lockTails.set(resource, previous.then(() => current));
    await previous;
    if (kind === 'flight') {
      state.activeFlightLocks++;
      state.maxActiveFlightLocks = Math.max(state.maxActiveFlightLocks, state.activeFlightLocks);
    } else {
      state.activeDocumentLocks++;
      state.maxActiveDocumentLocks = Math.max(state.maxActiveDocumentLocks, state.activeDocumentLocks);
    }
    const hold = (kind === 'flight' ? state.lockHolds : state.documentLockHolds).shift();
    if (hold) {
      hold.markAcquired();
      await hold.waitForRelease;
    }
    tx.releaseLocks ??= [];
    tx.releaseLocks.push(() => {
      if (kind === 'flight') state.activeFlightLocks--;
      else state.activeDocumentLocks--;
      release();
    });
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
      for (const release of this.releaseLocks || []) release();
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
      for (const release of this.releaseLocks || []) release();
    }
  }

  class Request {
    constructor(tx) { this.tx = tx; this.values = {}; }
    input(name, type, value) { this.values[name] = value; return this; }
    async query(text) {
      const q = text.replace(/\s+/g, ' ').trim();
      const p = this.values;
      state.calls.push({ q, p: { ...p }, inTransaction: Boolean(this.tx?.active) });

      // H1 uses real authorization/station modules with synthetic effective SQL rows.
      // This driver never opens a database connection or evaluates SQL permissions.
      if (harnessOptions.realAuthorization) {
        const allowed = harnessOptions.allowedStations || ['MEL', 'AKL'];
        const capabilities = harnessOptions.capabilities || ['UPLOAD_FLIGHT_DATA', 'CONFIRM_EXPORT_FINAL'];
        if (q.includes('WITH AuthorizationScopes AS')) {
          assert.equal(p.OperationalAccessActorReference, 'test-user');
          return result(h1Stations.filter(s => allowed.includes(s.StationCode))
            .flatMap(s => capabilities.map(CapabilityCode => ({ ...s, CapabilityCode }))));
        }
        if (q.includes('WITH AssignmentDecisions AS')) {
          assert.equal(p.AuthorizationActorReference, 'test-user');
          return result(allowed.includes(p.AuthorizationStationCode) ? capabilities.map(CapabilityCode => ({ CapabilityCode })) : []);
        }
        if (q.includes('FROM dbo.CargoRunStations WHERE StationId=@ResolvedStationId')) {
          return result(h1Stations.filter(s => s.StationId === String(p.ResolvedStationId)));
        }
        if (q.includes('FROM dbo.CargoRunStations WHERE StationCode=@ResolvedStationCode')) {
          return result(h1Stations.filter(s => s.StationCode === p.ResolvedStationCode));
        }
      }
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
        const resource = p.DocumentIdentityLockResource || p.FlightIdentityLockResource;
        await acquire(this.tx, resource, p.DocumentIdentityLockResource ? 'document' : 'flight');
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
        assert.match(q, /DocumentCorID COLLATE Latin1_General_100_BIN2/);
        return result(state.messages.filter(row =>
          binaryDocumentCorIdEquals(row.DocumentCorID, p.DocumentCorID)
        ));
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
        return result(['AuditEventId','EventType','Action','EntityType','EntityId','FlightId','FlightNumber','UldNumber','FromStatus','ToStatus','OccurredAtUtc','ActorDisplayName','ActorReference','Detail','DetailsJson']
          .map(COLUMN_NAME => ({ COLUMN_NAME, IS_NULLABLE: 'YES' })));
      }
      if (q.startsWith('INSERT INTO dbo.AuditEvents')) {
        if (state.failAudit) throw new Error('forced audit failure');
        const row = { ...p, __tx: this.tx.id };
        state.audits.push(row);
        return result([row]);
      }
      if (q.startsWith('INSERT INTO dbo.IncomingMachMessages')) {
        if (state.uniqueDocumentConflict) {
          state.messages.push({
            ...state.uniqueDocumentConflict,
            DocumentCorID: p.DocumentCorID
          });
          state.uniqueDocumentConflict = null;
          const error = new Error('simulated concurrent unique DocumentCorID conflict');
          error.number = 2601;
          throw error;
        }
        const row = { ...p, MachMessageId: state.messages.length + 1, __tx: this.tx.id };
        state.messages.push(row);
        return result([row]);
      }
      if (q.startsWith('DELETE FROM dbo.IncomingMachMessages')) {
        state.messages = state.messages.filter(row =>
          !binaryDocumentCorIdEquals(row.DocumentCorID, p.DocumentCorID)
        );
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
        const stationId = p.AuthorizationStationId ?? p.LockedAuthorizationStationId ?? p.StationId ??
          p.UwsStationId ?? p.LockedUwsStationId;
        return result(state.flights.filter(row => exactId
          ? String(row.FlightId) === String(exactId)
          : (!operatingDate || String(row.OperatingDate) === String(operatingDate)) &&
            (!stationId || String(row.StationId ?? 1) === String(stationId))
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
        process: { env: {
          DATABASE_CONNECTION_STRING: 'test-only',
          MACH_FOW_MACHINE_BINDINGS: harnessOptions.machineBindings ?? JSON.stringify([
            { integrationId: 'mel-test-feed', stationId: '1', credential: 'test-machine-token', enabled: true },
            { integrationId: 'akl-test-feed', stationId: '8', credential: 'test-akl-machine-token', enabled: true }
          ])
        } },
        require: name => name === 'mssql'
          ? sql
          : name === '../shared/flight'
            ? flightHelpers
            : name === '../shared/document-cor-id'
              ? documentCorIdHelpers
            : name === '../shared/machine-station-binding'
              ? machineStationBinding
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
              : name === '../shared/operational-authorization'
                ? (harnessOptions.realAuthorization ? realOperationalAuthorization : operationalAuthorization)
              : name === '../shared/station'
                ? (harnessOptions.realAuthorization ? realStation : require('./helpers/station-stub'))
              : name === '../shared/station-local-input'
                ? stationLocalInput
              : require(name)
      },
      { filename: endpoint + '/index.js' }
    );
    return module.exports;
  }

  async function call(endpoint, body, options = {}) {
    const context = { log: Object.assign(() => {}, { error() {}, warn() {} }) };
    const machineCredential = options.machine === 'AKL'
      ? 'test-akl-machine-token'
      : options.machine === true
        ? 'test-machine-token'
        : typeof options.machine === 'string'
          ? options.machine
          : null;
    await load(endpoint)(context, {
      method: 'POST',
      body,
      query: options.query || {},
      headers: options.headers || (machineCredential
        ? { 'x-cargorun-mach-key': machineCredential }
        : { 'x-ms-client-principal': principal })
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

  function holdNextDocumentLock() {
    let markAcquired;
    let release;
    const acquired = new Promise(resolve => { markAcquired = resolve; });
    const waitForRelease = new Promise(resolve => { release = resolve; });
    state.documentLockHolds.push({ markAcquired, waitForRelease });
    return { acquired, release };
  }

  return { state, call, holdNextFlightLock, holdNextDocumentLock };
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

function fow(document, serials = ['12345'], date = '17 SEP 2026', options = {}) {
  const ulds = serials.map(serial =>
    `<FSUMessageULDList><ULDTyp>AKE</ULDTyp><ULDSrl>${serial}</ULDSrl><ULDOwnr>CX</ULDOwnr></FSUMessageULDList>`
  ).join('');
  const station = Object.hasOwn(options, 'station') ? options.station : 'MEL';
  const segmentOrigin = Object.hasOwn(options, 'segmentOrigin') ? options.segmentOrigin : 'MEL';
  const destination = Object.hasOwn(options, 'destination') ? options.destination : 'HKG';
  const eventTime = Object.hasOwn(options, 'time') ? options.time : null;
  const stationXml = station ? `<StsApt>${station}</StsApt>` : '';
  const segmentXml = segmentOrigin ? `<StsSegDep>${segmentOrigin}</StsSegDep>` : '';
  const timeXml = eventTime === null ? '' : `<StsTime>${eventTime}</StsTime>`;
  return {
    stationId: options.stationId || '1',
    xml: `<FSUMessage><DocumentCorID>${document}</DocumentCorID><MessageType>FSU</MessageType><StatusCode>FOW</StatusCode><StsCar>CX</StsCar><StsCarNum>178</StsCarNum><StsDatt>${date}</StsDatt>${stationXml}${segmentXml}<StsSegArr>${destination}</StsSegArr>${timeXml}<DocPrfx>160</DocPrfx><DocNum>11111111</DocNum>${ulds}</FSUMessage>`
  };
}

test('flight normalization preserves the established FOW identity rule', () => {
  for (const value of ['CX178', 'cx0178', ' CX 00178 ']) {
    assert.equal(flightHelpers.normalizeFlightNumber(value), 'CX178');
  }
  assert.equal(flightHelpers.normalizeFlightNumber('CX0178A'), 'CX178A');
  assert.notEqual(
    flightHelpers.flightIdentityLockResource('1', '2026-09-17', 'CX178'),
    flightHelpers.flightIdentityLockResource('1', '2026-09-18', 'CX178')
  );
});

test('FOW StsTime accepts valid day boundaries and preserves local wall-clock digits', async () => {
  for (const time of ['0000', '2359']) {
    const api = harness();
    const response = await api.call('mach-fow', fow(`FOW-TIME-${time}`, ['12345'], '17 SEP 2026', { time }));

    assert.equal(response.status, 201, time);
    assert.equal(response.body.eventLocalDateTime, `2026-09-17T${time.slice(0, 2)}:${time.slice(2)}:00`, time);
    assert.equal(api.state.messages.length, 1, time);
    assert.equal(api.state.messages[0].EventLocalDateTime.toISOString(), `2026-09-17T${time.slice(0, 2)}:${time.slice(2)}:00.000Z`, time);
  }
});

test('FOW StsTime rejects out-of-range hours and minutes', async () => {
  for (const time of ['2400', '1260', '9999']) {
    const api = harness();
    const response = await api.call('mach-fow', fow(`FOW-TIME-${time}`, ['12345'], '17 SEP 2026', { time }));

    assert.equal(response.status, 201, time);
    assert.equal(response.body.eventLocalDateTime, null, time);
    assert.equal(api.state.messages.length, 1, time);
    assert.equal(api.state.messages[0].EventLocalDateTime, null, time);
  }
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

test('same-station concurrent duplicate DocumentCorID is globally serialized and processed once', async () => {
  const api = harness();
  const [first, second] = await Promise.all([
    api.call('mach-fow', fow('  global-document-same-station  ')),
    api.call('mach-fow', fow('GLOBAL-DOCUMENT-SAME-STATION'))
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal([first.body, second.body].filter(item => item.duplicate).length, 1);
  assert.equal(api.state.messages.length, 1);
  assert.equal(api.state.maxActiveDocumentLocks, 1);
  assert.equal(api.state.messages[0].DocumentCorID, 'GLOBAL-DOCUMENT-SAME-STATION');
  assert.equal(api.state.calls.filter(call => call.p.DocumentIdentityLockResource ===
    'CargoRun:DocumentCorID:v2:GLOBAL-DOCUMENT-SAME-STATION').length, 2);
});

test('human and machine MACH paths share canonical DocumentCorID storage and lookup', async () => {
  const api = harness();
  const human = await api.call('mach-fow', fow('  shared-machine-human-id  '));
  const machine = await api.call(
    'mach-fow',
    fow('SHARED-MACHINE-HUMAN-ID'),
    { machine: true }
  );

  assert.equal(human.status, 201);
  assert.equal(machine.status, 200);
  assert.equal(machine.body.duplicate, true);
  assert.equal(api.state.messages.length, 1);
  assert.equal(api.state.messages[0].DocumentCorID, 'SHARED-MACHINE-HUMAN-ID');
  assert.match(api.state.messages[0].RawXml, /<DocumentCorID>  shared-machine-human-id  <\/DocumentCorID>/);
  const lookups = api.state.calls.filter(call => call.q.includes('FROM dbo.IncomingMachMessages'));
  assert.ok(lookups.length >= 2);
  for (const lookup of lookups) {
    assert.equal(lookup.p.DocumentCorID, 'SHARED-MACHINE-HUMAN-ID');
    assert.match(lookup.q, /DocumentCorID COLLATE Latin1_General_100_BIN2/);
    assert.match(lookup.q, /@DocumentCorID COLLATE Latin1_General_100_BIN2/);
  }
});

test('human and machine MACH paths reject invalid DocumentCorID values before database work', async () => {
  const invalidValues = [
    '   ',
    'DOC\tID',
    'DOC\u00a0ID',
    '\u00a0DOC-ID',
    'DOC-ID\u2003',
    'DOC-\uff21',
    'stra\u00dfe',
    'A'.repeat(101)
  ];

  for (const machine of [false, true]) {
    for (const value of invalidValues) {
      const api = harness();
      const response = await api.call('mach-fow', fow(value), { machine });
      assert.equal(response.status, 422, `${machine ? 'machine' : 'human'} ${JSON.stringify(value)}`);
      assert.equal(response.body.code, 'INVALID_DOCUMENT_COR_ID');
      assert.equal(
        response.body.error,
        'DocumentCorID must be a string containing 1-100 ASCII letters, digits, or hyphens'
      );
      assert.equal(api.state.calls.length, 0);
      assert.equal(api.state.messages.length, 0);
    }

    const api = harness();
    const withoutDocument = fow('PLACEHOLDER');
    withoutDocument.xml = withoutDocument.xml.replace(
      /<DocumentCorID>[\s\S]*?<\/DocumentCorID>/,
      ''
    );
    const response = await api.call('mach-fow', withoutDocument, { machine });
    assert.equal(response.status, 422);
    assert.equal(response.body.code, 'INVALID_DOCUMENT_COR_ID');
    assert.equal(api.state.calls.length, 0);
  }
});

test('unique-index race fallback reuses canonical lookup and redacts cross-station metadata', async () => {
  const sameStation = harness();
  sameStation.state.uniqueDocumentConflict = {
    MachMessageId: 501,
    StationId: 1,
    MatchedFlightStationId: 1,
    MatchedFlightId: 901,
    MatchedFlightNumber: 'CX0178',
    FlightNumber: 'CX0178',
    OperatingDate: '2026-09-17',
    ProcessingStatus: 'PROCESSED',
    SourceType: 'MACH_FOW_LIVE'
  };
  const duplicate = await sameStation.call(
    'mach-fow',
    fow('  unique-race-id  ')
  );
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(sameStation.state.messages.length, 1);
  assert.equal(sameStation.state.messages[0].DocumentCorID, 'UNIQUE-RACE-ID');
  assert.equal(sameStation.state.rollbacks, 1);

  const crossStation = harness();
  crossStation.state.uniqueDocumentConflict = {
    MachMessageId: 777,
    StationId: 8,
    MatchedFlightStationId: 8,
    MatchedFlightId: 902,
    MatchedFlightNumber: 'NZ0124',
    FlightNumber: 'NZ0124',
    OperatingDate: '2026-09-17',
    ProcessingStatus: 'PROCESSED',
    SourceType: 'MACH_FOW_LIVE',
    UldNumber: 'AKE99999NZ'
  };
  const conflict = await crossStation.call(
    'mach-fow',
    fow('UNIQUE-RACE-CROSS-STATION')
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'DOCUMENT_IDENTITY_CONFLICT');
  assert.deepEqual(Object.keys(conflict.body).sort(), ['code', 'error', 'ok']);
  assert.doesNotMatch(JSON.stringify(conflict.body), /777|902|NZ0124|AKE99999NZ/);
  assert.equal(crossStation.state.messages.length, 1);
  assert.equal(crossStation.state.rollbacks, 1);
});

test('rolled-back DocumentCorID request cannot delete a different-station committed message', async () => {
  const api = harness([{
    FlightId: 9,
    StationId: 1,
    FlightNumber: 'CX0178',
    OperatingDate: '2026-09-17',
    Direction: 'EXPORT',
    FlightStatus: 'FINALISED'
  }]);
  const hold = api.holdNextDocumentLock();
  const rejected = api.call('mach-fow', fow('  global-document-rollback  '));
  await hold.acquired;
  const committed = api.call('mach-fow', fow('GLOBAL-DOCUMENT-ROLLBACK', ['23456'], '17 SEP 2026', {
    stationId: '8',
    station: 'AKL',
    segmentOrigin: 'AKL',
    destination: 'SYD'
  }));
  hold.release();

  const [rejectedResult, committedResult] = await Promise.all([rejected, committed]);
  assert.equal(rejectedResult.status, 409);
  assert.equal(committedResult.status, 201);
  assert.equal(api.state.messages.length, 1);
  assert.equal(api.state.messages[0].DocumentCorID, 'GLOBAL-DOCUMENT-ROLLBACK');
  assert.equal(String(api.state.messages[0].StationId), '8');
  assert.equal(api.state.calls.some(call => /^DELETE FROM dbo\.IncomingMachMessages/i.test(call.q)), false);

  const crossStationDuplicate = await api.call('mach-fow', fow('  global-document-rollback  '));
  assert.equal(crossStationDuplicate.status, 409);
  assert.equal(crossStationDuplicate.body.code, 'DOCUMENT_IDENTITY_CONFLICT');
  assert.deepEqual(Object.keys(crossStationDuplicate.body).sort(), ['code', 'error', 'ok']);
  assert.equal(api.state.messages.length, 1);
});

test('MACH handling station and outbound segment evidence must agree while cargo destination remains non-authoritative', async () => {
  const valid = harness();
  assert.equal((await valid.call('mach-fow', fow('SEGMENT-VALID'))).status, 201);

  const contradictory = harness();
  const rejected = await contradictory.call('mach-fow', fow('SEGMENT-CONTRADICTORY', ['12345'], '17 SEP 2026', {
    station: 'MEL',
    segmentOrigin: 'SYD',
    destination: 'BKK'
  }));
  assert.equal(rejected.status, 422);
  assert.equal(contradictory.state.messages.length, 0);

  const cargoDestination = harness();
  assert.equal((await cargoDestination.call('mach-fow', fow('DESTINATION-NON-AUTHORITY', ['12345'], '17 SEP 2026', {
    station: 'MEL',
    segmentOrigin: 'MEL',
    destination: 'SYD'
  }))).status, 201);
  assert.equal(String(cargoDestination.state.messages[0].StationId), '1');

  const missingOptionalSegment = harness();
  assert.equal((await missingOptionalSegment.call('mach-fow', fow('SEGMENT-OPTIONAL', ['12345'], '17 SEP 2026', {
    station: 'MEL',
    segmentOrigin: null,
    destination: 'BKK'
  }))).status, 201);
});

test('station-bound machine credentials accept only matching handling-station evidence', async () => {
  const api = harness();
  const mel = await api.call('mach-fow', fow('MACHINE-MEL-ACCEPT'), { machine: true });
  assert.equal(mel.status, 201);
  assert.equal(String(api.state.messages[0].StationId), '1');
  assert.equal(api.state.messages[0].ProcessedByReference, 'machine:mel-test-feed');

  const melReject = harness();
  const contradictoryMel = await melReject.call('mach-fow', fow('MACHINE-MEL-REJECT', ['12345'], '17 SEP 2026', {
    station: 'AKL', segmentOrigin: 'AKL', destination: 'SYD'
  }), { machine: true });
  assert.equal(contradictoryMel.status, 422);
  assert.equal(contradictoryMel.body.code, 'MACHINE_STATION_MISMATCH');
  assert.equal(melReject.state.flights.length, 0);
  assert.equal(melReject.state.messages.length, 0);
  assert.equal(melReject.state.ulds.length, 0);

  const akl = harness();
  const acceptedAkl = await akl.call('mach-fow', fow('MACHINE-AKL-ACCEPT', ['12345'], '17 SEP 2026', {
    station: 'AKL', segmentOrigin: 'AKL', destination: 'SYD'
  }), { machine: 'AKL' });
  assert.equal(acceptedAkl.status, 201);
  assert.equal(String(akl.state.messages[0].StationId), '8');
  assert.equal(akl.state.messages[0].ProcessedByReference, 'machine:akl-test-feed');

  const aklReject = harness();
  const contradictoryAkl = await aklReject.call('mach-fow', fow('MACHINE-AKL-REJECT'), { machine: 'AKL' });
  assert.equal(contradictoryAkl.status, 422);
  assert.equal(contradictoryAkl.body.code, 'MACHINE_STATION_MISMATCH');
  assert.equal(aklReject.state.messages.length, 0);
});

test('request station fields cannot redirect a machine-bound message', async () => {
  const mel = harness();
  const melBody = { ...fow('MACHINE-MEL-SPOOF'), stationId: '8', StationId: '8' };
  const melResponse = await mel.call('mach-fow', melBody, {
    machine: true,
    query: { stationId: '8' },
    headers: { 'x-cargorun-mach-key': 'test-machine-token', 'x-station': 'AKL' }
  });
  assert.equal(melResponse.status, 201);
  assert.equal(String(mel.state.messages[0].StationId), '1');

  const akl = harness();
  const aklBody = {
    ...fow('MACHINE-AKL-SPOOF', ['12345'], '17 SEP 2026', {
      station: 'AKL', segmentOrigin: 'AKL', destination: 'SYD'
    }),
    stationId: '1',
    StationId: '1'
  };
  const aklResponse = await akl.call('mach-fow', aklBody, {
    machine: 'AKL',
    query: { stationId: '1' },
    headers: { 'x-cargorun-mach-key': 'test-akl-machine-token', 'x-station': 'MEL' }
  });
  assert.equal(aklResponse.status, 201);
  assert.equal(String(akl.state.messages[0].StationId), '8');
});

test('machine-bound flight identity and lock remain independent by StationId', async () => {
  const api = harness();
  const mel = await api.call('mach-fow', fow('MACHINE-FLIGHT-MEL'), { machine: true });
  const akl = await api.call('mach-fow', fow('MACHINE-FLIGHT-AKL', ['22345'], '17 SEP 2026', {
    station: 'AKL', segmentOrigin: 'AKL', destination: 'SYD'
  }), { machine: 'AKL' });
  assert.deepEqual([mel.status, akl.status], [201, 201]);
  assert.notEqual(mel.body.flightId, akl.body.flightId);
  assert.deepEqual(api.state.flights.map(row => String(row.StationId)).sort(), ['1', '8']);
  const resources = api.state.calls
    .map(call => call.p.FlightIdentityLockResource)
    .filter(Boolean);
  assert.ok(resources.includes('CargoRun:Flight:v2:1:2026-09-17:CX178'));
  assert.ok(resources.includes('CargoRun:Flight:v2:8:2026-09-17:CX178'));
});

test('disabled, unknown, and unbound machine identities fail before mutation', async () => {
  const disabled = harness([], {
    machineBindings: JSON.stringify([
      { integrationId: 'disabled-test-feed', stationId: '1', credential: 'disabled-machine-secret', enabled: false }
    ])
  });
  assert.equal((await disabled.call('mach-fow', fow('MACHINE-DISABLED'), { machine: 'disabled-machine-secret' })).status, 403);

  const unknown = harness();
  assert.equal((await unknown.call('mach-fow', fow('MACHINE-UNKNOWN'), { machine: 'unknown-machine-secret' })).status, 403);

  const unbound = harness([], {
    machineBindings: JSON.stringify([
      { integrationId: 'unbound-test-feed', stationId: null, credential: 'unbound-machine-secret', enabled: true }
    ])
  });
  assert.equal((await unbound.call('mach-fow', fow('MACHINE-UNBOUND'), { machine: 'unbound-machine-secret' })).status, 503);

  const missingStation = harness([], {
    machineBindings: JSON.stringify([
      { integrationId: 'missing-station-feed', stationId: '9', credential: 'missing-station-secret', enabled: true }
    ])
  });
  const missingStationResponse = await missingStation.call('mach-fow', fow('MACHINE-MISSING-STATION'), {
    machine: 'missing-station-secret'
  });
  assert.equal(missingStationResponse.status, 403);
  assert.equal(missingStationResponse.body.code, 'MACHINE_STATION_UNAVAILABLE');

  for (const fixture of [disabled, unknown, unbound, missingStation]) {
    assert.equal(fixture.state.messages.length, 0);
    assert.equal(fixture.state.flights.length, 0);
    assert.equal(fixture.state.ulds.length, 0);
  }
});

test('SWA Authorization does not compete with the dedicated machine header', async () => {
  const api = harness();
  const response = await api.call('mach-fow', fow('MACHINE-SWA-AUTHORIZATION'), {
    headers: {
      'x-cargorun-mach-key': 'test-machine-token',
      authorization: 'Bearer azure-static-web-apps-platform-token'
    }
  });
  assert.equal(response.status, 201);
  assert.equal(api.state.messages.length, 1);
  assert.equal(String(api.state.messages[0].StationId), '1');
  assert.equal(api.state.messages[0].ProcessedByReference, 'machine:mel-test-feed');
});

test('machine duplicate DocumentCorID behavior remains global, idempotent, and confidential', async () => {
  const sameStation = harness();
  const first = await sameStation.call('mach-fow', fow('MACHINE-SAME-STATION-DOC'), { machine: true });
  const retry = await sameStation.call('mach-fow', fow('machine-same-station-doc'), { machine: true });
  assert.deepEqual([first.status, retry.status], [201, 200]);
  assert.equal(retry.body.duplicate, true);
  assert.equal(sameStation.state.messages.length, 1);
  assert.equal(sameStation.state.flights.length, 1);
  assert.equal(sameStation.state.ulds.length, 1);

  const crossStation = harness();
  assert.equal((await crossStation.call('mach-fow', fow('MACHINE-GLOBAL-DOC'), { machine: true })).status, 201);
  const conflict = await crossStation.call('mach-fow', fow('machine-global-doc', ['22345'], '17 SEP 2026', {
    station: 'AKL', segmentOrigin: 'AKL', destination: 'SYD'
  }), { machine: 'AKL' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'DOCUMENT_IDENTITY_CONFLICT');
  assert.deepEqual(Object.keys(conflict.body).sort(), ['code', 'error', 'ok']);
  assert.equal(crossStation.state.messages.length, 1);
  assert.equal(String(crossStation.state.messages[0].StationId), '1');
});

test('machine FOW preserves StsTime and RawXml evidence exactly', async () => {
  const api = harness();
  const payload = fow('MACHINE-RAW-TIME', ['12345'], '17 SEP 2026', { time: '2359' });
  const rawXml = payload.xml;
  const response = await api.call('mach-fow', payload, { machine: true });
  assert.equal(response.status, 201);
  assert.equal(response.body.eventLocalDateTime, '2026-09-17T23:59:00');
  assert.equal(api.state.messages[0].RawXml, rawXml);
  assert.match(api.state.messages[0].RawXml, /<StsTime>2359<\/StsTime>/);
});

test('human MEL and AKL FOW fixtures remain independently station-authorized', async () => {
  const api = harness();
  const mel = await api.call('mach-fow', fow('HUMAN-MEL-FIXTURE'));
  const akl = await api.call('mach-fow', fow('HUMAN-AKL-FIXTURE', ['22345'], '17 SEP 2026', {
    stationId: '8',
    station: 'AKL', segmentOrigin: 'AKL', destination: 'SYD'
  }));
  assert.deepEqual([mel.status, akl.status], [201, 201]);
  assert.deepEqual(api.state.messages.map(row => String(row.StationId)).sort(), ['1', '8']);
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
    .filter(call => call.q.includes('sys.sp_getapplock') && call.p.FlightIdentityLockResource)
    .map(call => call.p.FlightIdentityLockResource);
  assert.deepEqual(resources, [
    'CargoRun:Flight:v2:1:2026-09-17:CX178',
    'CargoRun:Flight:v2:1:2026-09-17:CX178',
    'CargoRun:Flight:v2:1:2026-09-17:CX178'
  ]);
  assert.notEqual(
    flightHelpers.flightIdentityLockResource('1', '2026-09-18', 'CX0178'),
    resources[0]
  );
  assert.notEqual(
    flightHelpers.flightIdentityLockResource('1', '2026-09-17', 'QF0178'),
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
  assert.equal(lockCall.p.FlightIdentityLockResource, 'CargoRun:Flight:v2:1:2026-09-25:CX134');
});

test('Import finalisation response carries the exact owning station display metadata', async () => {
  const api = harness([{ ...importFlight(48, '2026-09-26'), StationId: 8, DestinationAirport: 'AKL' }]);
  const response = await api.call('import-completions', { flightId: '48' });

  assert.equal(response.status, 201);
  assert.deepEqual(
    {
      stationId: response.body.record.stationId,
      stationCode: response.body.record.stationCode,
      displayName: response.body.record.displayName,
      timeZoneId: response.body.record.timeZoneId
    },
    { stationId: '8', stationCode: 'AKL', displayName: 'Auckland', timeZoneId: 'Pacific/Auckland' }
  );
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
  assert.equal(finalLock.p.FlightIdentityLockResource, 'CargoRun:Flight:v2:1:2026-09-17:CX178');
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
    stationId: '1',
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

// H1: exercise the real HTTP, authorization, station and transaction code.
// Only SQL result rows/storage are simulated; IDs deliberately match MEL=1/AKL=2.
function h1Fow(documentStation, selectedStation) {
  return { ...fow('H1-' + documentStation, ['12345'], '19 SEP 2026', {
    station: documentStation, segmentOrigin: documentStation
  }), stationId: selectedStation };
}
function h1Uws(documentStation, selectedStation, action) {
  const body = exportUwsBody(action);
  body.stationId = selectedStation;
  body.workbook.sheets[0].rows[2][1] = documentStation;
  return body;
}
function h1Api(options = {}) {
  return harness(h1Stations.map(s => ({ FlightId: Number(s.StationId) + 80,
    StationId: s.StationId, FlightNumber: 'CX134', OperatingDate: '2026-09-19',
    Direction: 'EXPORT', FlightStatus: 'ACTIVE', OriginAirport: s.StationCode, DestinationAirport: 'HKG'
  })), { realAuthorization: true, ...options });
}
function assertH1NoWrites(api, before) {
  for (const name of ['flights', 'ulds', 'messages', 'links', 'uploads', 'finals', 'finalMembers', 'completions', 'audits', 'shcs']) {
    assert.deepEqual(api.state[name], before[name], name + ' must remain unchanged');
  }
  assert.equal(api.state.calls.filter(({ q }) => /^(INSERT|UPDATE|DELETE|MERGE)\b/i.test(q)).length, 0);
  assert.equal(api.state.commits, 0);
}
for (const [selected, id] of [['MEL', '1'], ['AKL', '2']]) {
  for (const documentStation of ['MEL', 'AKL']) {
    const matches = selected === documentStation;
    test('H1 FOW selected ' + selected + ' document ' + documentStation + (matches ? ' accepted' : ' mismatch denied'), async () => {
      const api = h1Api(), before = structuredClone(api.state);
      const reply = await api.call('mach-fow', h1Fow(documentStation, id));
      assert.equal(reply.status, matches ? 201 : 422, JSON.stringify({reply, writes: api.state.calls.filter(c => /^(INSERT|UPDATE)/.test(c.q)).length}));
      if (!matches) { assert.equal(reply.body.code, 'DOCUMENT_STATION_MISMATCH'); assertH1NoWrites(api, before); }
      else {
        assert.equal(String(api.state.flights.at(-1).StationId), id);
        assert.equal(String(api.state.messages[0].StationId), id);
        assert.equal(api.state.commits, 1);
        const snapshot = ['flights','ulds','messages','links'].map(n => structuredClone(api.state[n]));
        const duplicate = await api.call('mach-fow', h1Fow(documentStation, id));
        assert.equal(duplicate.body.duplicate, true);
        assert.deepEqual(['flights','ulds','messages','links'].map(n => api.state[n]), snapshot);
      }
    });
    for (const action of ['PARSE_EXPORT_UWS', 'REVIEW_EXPORT_UWS']) {
      test('H1 ' + action + ' selected ' + selected + ' document ' + documentStation + (matches ? ' accepted' : ' mismatch denied'), async () => {
        const api = h1Api(), before = structuredClone(api.state);
        const reply = await api.call('manifest-upload', h1Uws(documentStation, id, action));
        assert.equal(reply.status, matches ? 200 : 422, JSON.stringify({reply, uploads: api.state.uploads.length, audits: api.state.audits.length}));
        if (!matches) { assert.equal(reply.body.code, 'DOCUMENT_STATION_MISMATCH'); assertH1NoWrites(api, before); }
        else {
          assert.equal(reply.body.exactMatch.flightId, String(Number(id) + 80));
          if (action === 'PARSE_EXPORT_UWS') assertH1NoWrites(api, before);
          else {
            assert.equal(api.state.uploads.length, 1); assert.equal(api.state.audits.length, 1);
            assert.equal(String(api.state.uploads[0].UwsUploadFlightId), reply.body.exactMatch.flightId);
            assert.equal(String(api.state.audits[0].AuditFlightId), reply.body.exactMatch.flightId);
            assert.deepEqual(api.state.flights, before.flights); assert.deepEqual(api.state.ulds, before.ulds);
          }
        }
      });
    }
  }
}
for (const kind of ['FOW', 'PARSE_EXPORT_UWS', 'REVIEW_EXPORT_UWS']) {
  test('H1 ' + kind + ' rejects missing/forged selection, missing capability and MEL-only AKL access before any write', async () => {
    const cases = [undefined, null, '', '0', '999', 'AKL', ['1'], { stationId: '1' }].map(stationId => ({stationId}));
    cases.push({ stationId: '2', allowedStations: ['MEL'] }, {stationId: '2', capabilities: ['VIEW_FLIGHTS']});
    for (const options of cases) {
      const api = h1Api(options), before = structuredClone(api.state);
      const body = kind === 'FOW' ? h1Fow('AKL', options.stationId) : h1Uws('AKL', options.stationId, kind);
      const reply = await api.call(kind === 'FOW' ? 'mach-fow' : 'manifest-upload', body);
      assert.equal(reply.status, 403, JSON.stringify({options,reply}));
      assertH1NoWrites(api, before);
    }
  });
}
test('H1 FOW missing or conflicting document handling station is denied without writes', async () => {
  for (const evidence of [{station:null, segmentOrigin:null}, {station:'MEL',segmentOrigin:'AKL'}]) {
    const api=h1Api(), before=structuredClone(api.state);
    const reply=await api.call('mach-fow', {...fow('H1-INCONSISTENT',['12345'],'19 SEP 2026',evidence),stationId:'1'});
    assert.equal(reply.status,422);assert.equal(reply.body.code,'DOCUMENT_STATION_MISMATCH');assertH1NoWrites(api,before);
  }
});
test('H1 machine MEL binding ignores forged interactive selection and preserves duplicate handling', async () => {
  const api=h1Api({machineBindings: JSON.stringify([{integrationId:'mel-test-feed',stationId:'1',credential:'test-machine-token',enabled:true}])});
  const body=h1Fow('MEL','2');
  const first=await api.call('mach-fow',body,{machine:true});
  assert.equal(first.status,201);assert.equal(String(api.state.messages[0].StationId),'1');
  assert.equal((await api.call('mach-fow',body,{machine:true})).body.duplicate,true);
  const before=structuredClone(api.state), denied=await api.call('mach-fow',h1Fow('AKL','1'),{machine:true});
  assert.equal(denied.status,422);assert.equal(denied.body.code,'MACHINE_STATION_MISMATCH');
  for(const key of ['flights','ulds','messages','links','audits'])assert.deepEqual(api.state[key],before[key]);
});

test('H1 UWS cannot match a flight owned by AKL using a MEL route label', async () => {
  for (const action of ['PARSE_EXPORT_UWS', 'REVIEW_EXPORT_UWS']) {
    const api = harness([{ FlightId: 88, StationId: '2', FlightNumber: 'CX134',
      OperatingDate: '2026-09-19', Direction: 'EXPORT', FlightStatus: 'ACTIVE',
      OriginAirport: 'MEL', DestinationAirport: 'HKG' }], {realAuthorization: true});
    const before = structuredClone(api.state);
    const reply = await api.call('manifest-upload', h1Uws('MEL', '1', action));
    assert.equal(reply.status, 404); assertH1NoWrites(api, before);
  }
});
test('H1 UWS missing document station cannot write upload or audit evidence', async () => {
  const api = h1Api(), before = structuredClone(api.state);
  const reply = await api.call('manifest-upload', h1Uws('', '1', 'REVIEW_EXPORT_UWS'));
  assert.equal(reply.status, 422); assertH1NoWrites(api, before);
});
