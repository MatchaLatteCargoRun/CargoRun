'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flightHelpers = require('../api/shared/flight');
const { insertAuditEvent } = require('../api/shared/audit');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const flightsSource = fs.readFileSync(path.join(root, 'api', 'flights', 'index.js'), 'utf8');
const principal = Buffer.from(JSON.stringify({
  userRoles: ['authenticated'],
  userDetails: 'Trusted Operator',
  userId: 'operator-object-id',
  identityProvider: 'aad'
})).toString('base64');

function response(recordset = [], rowsAffected = []) {
  return { recordset, recordsets: [recordset], rowsAffected };
}

function auditColumns() {
  return [
    'AuditEventId', 'EventType', 'Action', 'EntityType', 'EntityId', 'FlightNumber',
    'FromStatus', 'ToStatus', 'OccurredAtUtc', 'ActorDisplayName', 'ActorReference',
    'Detail', 'DetailsJson'
  ].map(COLUMN_NAME => ({
    COLUMN_NAME,
    IS_NULLABLE: COLUMN_NAME === 'Action' || COLUMN_NAME === 'ActorDisplayName' ? 'NO' : 'YES',
    COLUMN_DEFAULT: null,
    IS_IDENTITY: COLUMN_NAME === 'AuditEventId' ? 1 : 0
  }));
}

function loadHandler(file, sql, replacements = {}) {
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'api', file, 'index.js'), 'utf8'),
    {
      module,
      exports: module.exports,
      Buffer,
      URLSearchParams,
      process: { env: { DATABASE_CONNECTION_STRING: 'test-only' } },
      require(name) {
        if (name === 'mssql') return sql;
        if (Object.hasOwn(replacements, name)) return replacements[name];
        if (name === '../shared/flight') return flightHelpers;
        if (name === '../shared/audit') return { insertAuditEvent };
        return require(name);
      }
    },
    { filename: `${file}/index.js` }
  );
  return module.exports;
}

async function invoke(handler, method, body) {
  const context = { log: Object.assign(() => {}, { error() {}, warn() {} }) };
  await handler(context, {
    method,
    body,
    query: {},
    headers: { 'x-ms-client-principal': principal }
  });
  return {
    status: context.res.status,
    body: JSON.parse(context.res.body),
    headers: context.res.headers
  };
}

function lifecycleHarness(initialFlights, { failAudit = false } = {}) {
  const state = {
    flights: structuredClone(initialFlights),
    audits: [],
    calls: [],
    commits: 0,
    rollbacks: 0,
    connections: 0
  };

  class Transaction {
    constructor() { this.snapshot = null; }
    async begin() {
      this.active = true;
      this.snapshot = {
        flights: structuredClone(state.flights),
        audits: structuredClone(state.audits)
      };
    }
    async commit() { this.active = false; state.commits++; }
    async rollback() {
      state.flights = this.snapshot.flights;
      state.audits = this.snapshot.audits;
      this.active = false;
      state.rollbacks++;
    }
  }

  class Request {
    constructor(transaction) { this.transaction = transaction; this.parameters = {}; }
    input(name, _type, value) { this.parameters[name] = value; return this; }
    async query(text) {
      const query = String(text).replace(/\s+/g, ' ').trim();
      const parameters = { ...this.parameters };
      state.calls.push({ query, parameters, transactional: Boolean(this.transaction?.active) });

      if (query.includes('sys.sp_getapplock')) {
        assert.equal(this.transaction?.active, true);
        return response([{ LockResult: 0 }]);
      }
      if (query.includes('FROM INFORMATION_SCHEMA.COLUMNS') && parameters.AuditTableName === 'AuditEvents') {
        return response(auditColumns());
      }
      if (query.startsWith('INSERT INTO dbo.AuditEvents')) {
        assert.equal(this.transaction?.active, true);
        if (failAudit) throw new Error('forced audit failure');
        state.audits.push(parameters);
        return response();
      }
      if (query.startsWith('SELECT FlightId,FlightNumber,CONVERT(char(10),OperatingDate,23)')) {
        const flight = state.flights.find(row => String(row.FlightId) === String(parameters.FlightId));
        return response(flight ? [{
          FlightId: flight.FlightId,
          FlightNumber: flight.FlightNumber,
          OperatingDateIso: flight.OperatingDate,
          Direction: flight.Direction
        }] : []);
      }
      if (query.includes('WITH (UPDLOCK,HOLDLOCK)')) {
        const flight = state.flights.find(row => String(row.FlightId) === String(parameters.LockedFlightId));
        return response(flight ? [{ ...flight }] : []);
      }
      if (query.startsWith("UPDATE dbo.Flights SET FlightStatus='CLOSED'")) {
        const flight = state.flights.find(row => String(row.FlightId) === String(parameters.CloseFlightId));
        if (!flight || String(flight.FlightStatus).toUpperCase() !== 'ACTIVE') return response();
        flight.FlightStatus = 'CLOSED';
        return response([{
          FlightId: flight.FlightId,
          FlightNumber: flight.FlightNumber,
          FlightStatus: flight.FlightStatus
        }], [1]);
      }
      if (query.startsWith('SELECT FlightStatus FROM dbo.Flights')) {
        const flight = state.flights.find(row => String(row.FlightId) === String(parameters.LatestFlightId));
        return response(flight ? [{ FlightStatus: flight.FlightStatus }] : []);
      }
      throw new Error(`Unexpected lifecycle SQL: ${query}`);
    }
  }

  class ConnectionPool {
    async connect() { state.connections++; return this; }
    request() { return new Request(); }
    async close() {}
  }

  const sql = {
    ConnectionPool,
    Transaction,
    Request,
    BigInt: 'bigint',
    DateTime2: 'datetime2',
    NVarChar: value => `nvarchar(${value})`,
    MAX: 'max'
  };
  const handler = loadHandler('flights', sql);
  return { state, handler };
}

function flight(FlightId, FlightStatus = 'ACTIVE', OperatingDate = '2026-09-25', Direction = 'IMPORT') {
  return { FlightId, FlightNumber: 'CX0163', OperatingDate, Direction, FlightStatus };
}

test('generic flight lifecycle rejects finalisation, reversal, same-state, and arbitrary transitions before mutation', async () => {
  const attempts = [
    ['ACTIVE', 'FINALISED', 'ACTIVE'],
    ['ACTIVE', 'FINALIZED', 'ACTIVE'],
    ['CLOSED', 'FINALISED', 'CLOSED'],
    ['FINALISED', 'ACTIVE', 'FINALISED'],
    ['FINALISED', 'CLOSED', 'FINALISED'],
    ['ACTIVE', 'DEPARTED', 'ACTIVE'],
    ['ACTIVE', 'ACTIVE', 'ACTIVE'],
    ['CLOSED', 'ACTIVE', 'CLOSED']
  ];

  for (const [expectedStatus, nextStatus, actualStatus] of attempts) {
    const harness = lifecycleHarness([flight(101, actualStatus)]);
    const result = await invoke(harness.handler, 'PATCH', {
      flightId: '101', expectedStatus, nextStatus
    });
    assert.equal(result.status, 400, `${expectedStatus} -> ${nextStatus}`);
    assert.equal(result.body.code, 'INVALID_FLIGHT_TRANSITION');
    assert.equal(harness.state.flights[0].FlightStatus, actualStatus);
    assert.equal(harness.state.audits.length, 0);
    assert.equal(harness.state.commits, 0);
  }
});

test('allowed ACTIVE to CLOSED request detects stale database state and writes nothing', async () => {
  const harness = lifecycleHarness([flight(101, 'FINALISED')]);
  const result = await invoke(harness.handler, 'PATCH', {
    flightId: '101', expectedStatus: 'ACTIVE', nextStatus: 'CLOSED'
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'STALE_FLIGHT_STATUS');
  assert.equal(result.body.currentStatus, 'FINALISED');
  assert.equal(harness.state.flights[0].FlightStatus, 'FINALISED');
  assert.equal(harness.state.audits.length, 0);
  assert.equal(harness.state.rollbacks, 1);
});

test('generic lifecycle cannot close an Export outside its completion workflow', async () => {
  const harness = lifecycleHarness([flight(101, 'ACTIVE', '2026-09-25', 'EXPORT')]);
  const result = await invoke(harness.handler, 'PATCH', {
    flightId: '101', expectedStatus: 'ACTIVE', nextStatus: 'CLOSED'
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'INVALID_FLIGHT_TRANSITION');
  assert.equal(harness.state.flights[0].FlightStatus, 'ACTIVE');
  assert.equal(harness.state.audits.length, 0);
  assert.equal(harness.state.rollbacks, 1);
});

test('ACTIVE to CLOSED uses exact FlightId, canonical lock, and one server-authored audit', async () => {
  const harness = lifecycleHarness([
    flight(101, 'ACTIVE', '2026-09-24'),
    flight(202, 'ACTIVE', '2026-09-25')
  ]);
  const result = await invoke(harness.handler, 'PATCH', {
    flightId: '101',
    expectedStatus: 'ACTIVE',
    nextStatus: 'CLOSED',
    actorDisplayName: 'Forged Browser Actor',
    actorReference: 'forged-id'
  });

  assert.equal(result.status, 200);
  assert.equal(harness.state.flights.find(row => row.FlightId === 101).FlightStatus, 'CLOSED');
  assert.equal(harness.state.flights.find(row => row.FlightId === 202).FlightStatus, 'ACTIVE');
  assert.equal(harness.state.commits, 1);
  assert.equal(harness.state.audits.length, 1);
  assert.equal(harness.state.audits[0].AuditEntityId, '101');
  assert.equal(harness.state.audits[0].AuditActorDisplayName, 'Trusted Operator');
  assert.equal(harness.state.audits[0].AuditActorReference, 'operator-object-id');
  assert.equal(harness.state.audits[0].AuditFromStatus, 'ACTIVE');
  assert.equal(harness.state.audits[0].AuditToStatus, 'CLOSED');

  const lock = harness.state.calls.find(call => call.query.includes('sys.sp_getapplock'));
  assert.equal(lock.parameters.FlightIdentityLockResource, 'CargoRun:Flight:2026-09-24:CX163');
  const lockIndex = harness.state.calls.indexOf(lock);
  const updateIndex = harness.state.calls.findIndex(call => call.query.startsWith("UPDATE dbo.Flights SET FlightStatus='CLOSED'"));
  const auditIndex = harness.state.calls.findIndex(call => call.query.startsWith('INSERT INTO dbo.AuditEvents'));
  assert.ok(lockIndex >= 0 && updateIndex > lockIndex && auditIndex > updateIndex);
});

test('audit failure rolls back the permitted lifecycle transition', async () => {
  const harness = lifecycleHarness([flight(101)], { failAudit: true });
  const result = await invoke(harness.handler, 'PATCH', {
    flightId: '101', expectedStatus: 'ACTIVE', nextStatus: 'CLOSED'
  });

  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { ok: false, error: 'Flights API failed' });
  assert.equal(harness.state.flights[0].FlightStatus, 'ACTIVE');
  assert.equal(harness.state.audits.length, 0);
  assert.equal(harness.state.commits, 0);
  assert.equal(harness.state.rollbacks, 1);
});

test('official UI keeps manual Import close and routes finalisation through completion endpoints', () => {
  const lifecycleCalls = [...html.matchAll(/fetch\('\/api\/flights',[\s\S]{0,500}?expectedStatus:[^}]+}/g)];
  assert.equal(lifecycleCalls.length, 1);
  assert.match(lifecycleCalls[0][0], /expectedStatus:'ACTIVE',nextStatus:'CLOSED'/);
  assert.match(html, /function showCloseFlight\(type,id\)/);
  assert.match(html, /fetch\('\/api\/import-completions'.*method:'POST'.*flightId:f\.azureFlightId/s);
  assert.match(html, /fetch\('\/api\/export-completions'.*method:'POST'.*flightId:f\.azureFlightId/s);
  assert.doesNotMatch(flightsSource, /\['CLOSED',\s*'FINALISED',\s*'FINALIZED'\]/);
  assert.match(flightsSource, /expectedStatus !== 'ACTIVE' \|\| nextStatus !== 'CLOSED'/);
});

function completionColumns(direction) {
  const id = direction === 'IMPORT' ? 'ImportCompletionRecordId' : 'CompletionId';
  const names = [
    id, 'FlightId', 'VerificationId', 'FinalisedAtUtc', 'FinalisedByDisplayName',
    'FinalisedByObjectId', 'SnapshotJson', 'RecordHash'
  ];
  if (direction === 'IMPORT') names.push('ExceptionReason');
  return names.map(COLUMN_NAME => ({
    COLUMN_NAME,
    IS_NULLABLE: COLUMN_NAME === 'ExceptionReason' ? 'YES' : 'NO',
    COLUMN_DEFAULT: null,
    DATA_TYPE: 'nvarchar',
    IS_IDENTITY: COLUMN_NAME === id ? 1 : 0
  }));
}

function completionHarness(direction) {
  const isImport = direction === 'IMPORT';
  const state = {
    flights: [{
      FlightId: 501,
      FlightNumber: isImport ? 'CX0134' : 'CX0998',
      OperatingDate: '2026-09-25',
      OperatingDateIso: '2026-09-25',
      Direction: direction,
      FlightStatus: 'ACTIVE'
    }],
    ulds: [{ FlightId: 501, CurrentStatus: isImport ? 'RECEIVED' : 'AT_AIRCRAFT' }],
    completions: [],
    audits: [],
    calls: [],
    commits: 0,
    rollbacks: 0
  };

  class Transaction {
    async begin() {
      this.active = true;
      this.snapshot = structuredClone({
        flights: state.flights,
        completions: state.completions,
        audits: state.audits
      });
    }
    async commit() { this.active = false; state.commits++; }
    async rollback() {
      state.flights = this.snapshot.flights;
      state.completions = this.snapshot.completions;
      state.audits = this.snapshot.audits;
      this.active = false;
      state.rollbacks++;
    }
  }

  class Request {
    constructor(transaction) { this.transaction = transaction; this.parameters = {}; }
    input(name, _type, value) { this.parameters[name] = value; return this; }
    async query(text) {
      const query = String(text).replace(/\s+/g, ' ').trim();
      const parameters = { ...this.parameters };
      state.calls.push({ query, parameters, transactional: Boolean(this.transaction?.active) });

      if (query.includes('FROM INFORMATION_SCHEMA.COLUMNS')) {
        if (parameters.AuditTableName === 'AuditEvents') return response(auditColumns());
        return response(completionColumns(direction));
      }
      if (query.includes('sys.sp_getapplock')) return response([{ LockResult: 0 }]);
      if (query.startsWith('SELECT FlightId,FlightNumber')) {
        const row = state.flights.find(item => String(item.FlightId) === String(parameters.FlightId));
        return response(row ? [{ ...row }] : []);
      }
      if (query.startsWith('SELECT COUNT(*) AS Pending FROM dbo.ULDs')) {
        const pending = state.ulds.filter(item => String(item.FlightId) === '501' && (
          isImport
            ? String(item.CurrentStatus).toUpperCase() !== 'RECEIVED'
            : String(item.CurrentStatus).toUpperCase() !== 'AT_AIRCRAFT'
        )).length;
        return response([{ Pending: pending }]);
      }
      if (query.startsWith('SELECT TOP 1 * FROM dbo.ImportCompletionRecords') || query.startsWith('SELECT TOP 1 * FROM dbo.ExportCompletionRecords')) {
        return response(state.completions);
      }
      if (query.startsWith('INSERT INTO dbo.ImportCompletionRecords') || query.startsWith('INSERT INTO dbo.ExportCompletionRecords')) {
        const idName = isImport ? 'ImportCompletionRecordId' : 'CompletionId';
        const row = {
          [idName]: 9001,
          FlightId: Number(parameters.FlightId),
          VerificationId: 'verification-9001',
          FinalisedAtUtc: '2026-09-25T01:02:03.000Z',
          FinalisedByDisplayName: parameters.Actor,
          FinalisedByObjectId: parameters.ActorId,
          ExceptionReason: parameters.ExceptionReason || null,
          SnapshotJson: parameters.SnapshotJson,
          RecordHash: parameters.RecordHash
        };
        state.completions.push(row);
        return response([row], [1]);
      }
      if (query.startsWith("UPDATE dbo.Flights SET FlightStatus='FINALISED'")) {
        const id = parameters.FlightId4;
        const row = state.flights.find(item => String(item.FlightId) === String(id));
        if (row) row.FlightStatus = 'FINALISED';
        return response([], row ? [1] : [0]);
      }
      if (query.startsWith('INSERT INTO dbo.AuditEvents')) {
        state.audits.push(parameters);
        return response();
      }
      throw new Error(`Unexpected completion SQL: ${query}`);
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
    BigInt: 'bigint',
    Int: 'int',
    NVarChar: value => `nvarchar(${value})`,
    MAX: 'max'
  };
  const replacements = isImport ? {} : {
    '../shared/flight-statement-evidence': {
      loadFlightStatementEvidence: async () => ({ source: 'existing-evidence' }),
      applyFlightStatementEvidence: snapshot => ({ ...snapshot, evidencePreserved: true })
    }
  };
  const handler = loadHandler(isImport ? 'import-completions' : 'export-completions', sql, replacements);
  return { state, handler };
}

for (const direction of ['IMPORT', 'EXPORT']) {
  test(`${direction} completion still creates evidence, audit, and FINALISED state atomically`, async () => {
    const harness = completionHarness(direction);
    const result = await invoke(harness.handler, 'POST', {
      flightId: '501',
      exceptionReason: '',
      snapshot: { evidenceMarker: `${direction}-evidence`, ulds: [{ num: 'AKE12345CX' }] }
    });

    assert.equal(result.status, 201);
    assert.equal(harness.state.flights[0].FlightStatus, 'FINALISED');
    assert.equal(harness.state.completions.length, 1);
    assert.equal(harness.state.audits.length, 1);
    assert.equal(harness.state.audits[0].AuditAction, `${direction === 'IMPORT' ? 'Import' : 'Export'} finalised`);
    assert.equal(harness.state.audits[0].AuditEntityId, '501');
    assert.equal(harness.state.audits[0].AuditActorReference, 'operator-object-id');
    assert.equal(harness.state.commits, 1);
    assert.equal(harness.state.rollbacks, 0);
    const snapshot = JSON.parse(harness.state.completions[0].SnapshotJson);
    assert.equal(snapshot.evidenceMarker, `${direction}-evidence`);
    if (direction === 'EXPORT') assert.equal(snapshot.evidencePreserved, true);
  });
}
