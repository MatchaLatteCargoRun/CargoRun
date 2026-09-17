'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeUldNumber } = require('../api/shared/uld');
const { normalizeFlightNumber } = require('../api/shared/flight');
const { insertAuditEvent } = require('../api/shared/audit');

const root = path.resolve(__dirname, '..');
const principal = Buffer.from(JSON.stringify({
  userDetails: 'Concurrency Tester', userId: 'test-user', userRoles: ['authenticated']
})).toString('base64');

function loadHandler(relativePath, sqlMock) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, Buffer,
    process: { env: { DATABASE_CONNECTION_STRING: 'test-only' } },
    console,
    require(name) {
      if (name === 'mssql') return sqlMock;
      if (name === '../shared/uld') return { normalizeUldNumber };
      if (name === '../shared/flight') return { normalizeFlightNumber };
      if (name === '../shared/audit') return { insertAuditEvent };
      throw new Error(`Unexpected require: ${name}`);
    }
  });
  vm.runInContext(source, context, { filename });
  return module.exports;
}

function sqlHarness({ uld, offload, flights } = {}) {
  const state = {
    uld: uld ? structuredClone(uld) : null,
    offload: offload ? structuredClone(offload) : null,
    flights: structuredClone(flights || [{ FlightId: 1, FlightNumber: 'CX178', OperatingDate: '2026-09-17', FlightStatus: 'ACTIVE' }]),
    movements: [], audits: [], commits: 0, rollbacks: 0, failAudit: false,
    raceUldStatus: null, raceOffloadStatus: null, queries: []
  };

  const columns = {
    ULDs: [
      'UldId', 'FlightId', 'UldNumber', 'CurrentStatus', 'IdentityVerified',
      'AcceptedAtUtc', 'AcceptedByDisplayName', 'AcceptedByObjectId',
      'WarehouseDepartedAtUtc', 'WarehouseDepartedByDisplayName', 'WarehouseDepartedByObjectId'
    ],
    UldMovements: ['UldMovementId', 'UldId', 'FromStatus', 'ToStatus', 'OccurredAtUtc', 'ActorDisplayName', 'ActorObjectId', 'Source', 'Notes'],
    Offloads: [
      'OffloadId', 'FlightId', 'FlightNumber', 'UldNumber', 'ParkingBay', 'Status',
      'CollectedAtUtc', 'CollectedByDisplayName', 'CollectedByObjectId',
      'DeliveredAtUtc', 'DeliveredByDisplayName', 'DeliveredByObjectId', 'DeliveredLocation', 'CompletionNote'
    ],
    AuditEvents: ['AuditEventId', 'EventType', 'Action', 'EntityType', 'EntityId', 'FlightNumber', 'UldNumber', 'FromStatus', 'ToStatus', 'OccurredAtUtc', 'ActorDisplayName', 'ActorReference', 'Detail', 'DetailsJson']
  };

  class Transaction {
    async begin() { this.active = true; this.snapshot = structuredClone({ uld: state.uld, offload: state.offload, movements: state.movements, audits: state.audits }); }
    async commit() { this.active = false; state.commits++; }
    async rollback() {
      if (this.active) {
        state.uld = this.snapshot.uld; state.offload = this.snapshot.offload; state.movements = this.snapshot.movements; state.audits = this.snapshot.audits;
        this.active = false; state.rollbacks++;
      }
    }
  }

  class Request {
    constructor(transaction) { this.transaction = transaction; this.values = {}; this.parameters = {}; }
    input(name, type, value) { this.values[name] = value; this.parameters[name] = { value }; return this; }
    async query(text) {
      const q = String(text).replace(/\s+/g, ' ').trim();
      const p = this.values;
      state.queries.push({ q, p: { ...p } });
      const result = (recordset = [], rowsAffected = []) => ({ recordset, recordsets: [recordset], rowsAffected });

      if (q.includes('FROM INFORMATION_SCHEMA.COLUMNS')) {
        const table = p.TableName || p.AuditTableName || Object.entries(p).find(([k]) => k.startsWith('TableName_'))?.[1];
        return result((columns[table] || []).map(COLUMN_NAME => ({ COLUMN_NAME, IS_NULLABLE: 'YES', IS_IDENTITY: COLUMN_NAME.endsWith('Id') ? 1 : 0 })));
      }
      if (q.includes('FROM dbo.ULDs u INNER JOIN dbo.Flights')) {
        if (p.AuditUldId) return result(state.uld ? [{ ...state.uld, FlightNumber: state.uld.FlightNumber || 'CX178' }] : []);
        return result(state.uld && String(state.uld.UldId) === String(p.UldId)
          ? [{ ...state.uld, Direction: state.uld.Direction || 'IMPORT', FlightNumber: state.uld.FlightNumber || 'CX178' }]
          : []);
      }
      if (q.startsWith('DECLARE @Now') && q.includes('UPDATE dbo.ULDs')) {
        assert.match(q, /WHERE UldId = @UldId AND CurrentStatus = @ExpectedStatus/);
        if (state.raceUldStatus) {
          state.uld.CurrentStatus = state.raceUldStatus;
          if (this.transaction?.snapshot?.uld) this.transaction.snapshot.uld.CurrentStatus = state.raceUldStatus;
          state.raceUldStatus = null;
        }
        const matched = state.uld && String(state.uld.UldId) === String(p.UldId) && state.uld.CurrentStatus === p.ExpectedStatus;
        if (matched) {
          state.uld.CurrentStatus = p.NextStatus;
          state.uld.IdentityVerified = 1;
          return result([{ OccurredAtUtc: '2026-09-17T00:00:00.000Z' }], [1]);
        }
        return result([{ OccurredAtUtc: '2026-09-17T00:00:00.000Z' }], [0]);
      }
      if (q.startsWith('INSERT INTO dbo.UldMovements')) { state.movements.push({ from: p.MoveFromStatus, to: p.MoveToStatus }); return result([], [1]); }
      if (q.startsWith('INSERT INTO dbo.AuditEvents')) {
        if (state.failAudit) throw new Error('forced audit failure');
        const row = { Action: p.AuditAction, ActorDisplayName: p.AuditActorDisplayName, FromStatus: p.AuditFromStatus, ToStatus: p.AuditToStatus, OccurredAtUtc: '2026-09-17T00:00:00.000Z' };
        state.audits.push(row); return result([row], [1]);
      }
      if (q.includes('SELECT CurrentStatus FROM dbo.ULDs')) return result(state.uld ? [{ CurrentStatus: state.uld.CurrentStatus }] : []);
      if (q.includes('SELECT * FROM dbo.ULDs')) return result(state.uld ? [{ ...state.uld }] : []);
      if (q.startsWith('UPDATE dbo.ULDs SET MailScannedAtUtc')) {
        if (!state.uld || String(state.uld.UldId) !== String(p.UldId) || state.uld.MailScannedAtUtc) return result([]);
        Object.assign(state.uld, { MailScannedAtUtc: '2026-09-17T01:00:00.000Z', MailScannedByDisplayName: p.DisplayName, MailScannedByReference: p.Reference });
        return result([{ ...state.uld }], [1]);
      }
      if (q.includes('FROM dbo.ULDs WHERE UldId=@UldId2')) return result(state.uld ? [{ ...state.uld }] : []);

      if (q.startsWith('SELECT * FROM dbo.Offloads WHERE')) {
        const id = p.OffloadId ?? p.LatestOffloadId;
        return result(state.offload && String(state.offload.OffloadId) === String(id) ? [{ ...state.offload }] : []);
      }
      if (q.includes('FROM dbo.Flights WITH (UPDLOCK, HOLDLOCK)')) return result(state.flights.filter(f => String(f.FlightId) === String(p.SelectedFlightId)));
      if (q.startsWith('SELECT o.*') && q.includes('LEFT JOIN dbo.Flights')) {
        if (!state.offload) return result([]);
        const flight = state.flights.find(f => String(f.FlightId) === String(state.offload.FlightId));
        return result([{ ...state.offload, __FlightOperatingDate: flight?.OperatingDate || null }]);
      }
      if (q.startsWith('INSERT INTO dbo.Offloads')) {
        state.offload = { OffloadId: 90, FlightId: p.FlightId, FlightNumber: p.FlightNumber, UldNumber: p.UldNumber, ParkingBay: p.ParkingBay, Status: p.Status };
        return result([{ ...state.offload }], [1]);
      }
      if (q.startsWith('UPDATE dbo.Offloads')) {
        assert.match(q, /WHERE \[OffloadId\] = @OffloadId AND \[Status\] = @ExpectedStatus/);
        if (state.raceOffloadStatus) {
          state.offload.Status = state.raceOffloadStatus;
          if (this.transaction?.snapshot?.offload) this.transaction.snapshot.offload.Status = state.raceOffloadStatus;
          state.raceOffloadStatus = null;
        }
        const matched = state.offload && String(state.offload.OffloadId) === String(p.OffloadId) && state.offload.Status === p.ExpectedStatus;
        if (!matched) return result([], [0]);
        state.offload.Status = p.NextStatus;
        if (p.NextStatus === 'COMPLETE') state.offload.DeliveredLocation = p.DeliveredLocation;
        return result([{ ...state.offload }], [1]);
      }
      if (q.includes('AS CurrentStatus FROM dbo.Offloads')) return result(state.offload ? [{ CurrentStatus: state.offload.Status }] : []);
      throw new Error(`Unhandled SQL: ${q}`);
    }
  }

  class ConnectionPool {
    async connect() { return this; }
    request() { return new Request(); }
    async close() {}
  }

  const sql = {
    ConnectionPool, Transaction, Request,
    NVarChar: n => `nvarchar(${n})`, VarChar: n => `varchar(${n})`,
    BigInt: 'bigint', DateTime2: n => `datetime2(${n})`, MAX: 'max'
  };
  return { sql, state };
}

async function call(handler, method, body) {
  const context = { log: { error() {}, warn() {} } };
  await handler(context, { method, body, headers: { 'x-ms-client-principal': principal } });
  return { status: context.res.status, body: JSON.parse(context.res.body) };
}

test('ULD update is conditional, atomic, and records one authoritative audit and movement', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 } });
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: 7, expectedCurrentStatus: 'ARRIVED', nextStatus: 'TRANSIT' });
  assert.equal(response.status, 200);
  assert.equal(h.state.uld.CurrentStatus, 'TRANSIT');
  assert.equal(h.state.uld.IdentityVerified, 1);
  assert.equal(h.state.movements.length, 1);
  assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.audits[0].ActorDisplayName, 'Concurrency Tester');
  assert.equal(h.state.audits[0].OccurredAtUtc, '2026-09-17T00:00:00.000Z');
  assert.equal(h.state.commits, 1);
});

test('ULD first acceptance records verification through the authoritative audit', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'UNARRIVED', IdentityVerified: 0 } });
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: 7, expectedCurrentStatus: 'UNARRIVED', nextStatus: 'ARRIVED' });
  assert.equal(response.status, 200);
  assert.equal(h.state.uld.IdentityVerified, 1);
  assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.audits[0].Action, 'ULD accepted');
});

test('ULD race returns STALE_STATUS and rolls back status, verification, and movement', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 } });
  h.state.raceUldStatus = 'TRANSIT';
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: 7, expectedCurrentStatus: 'ARRIVED', nextStatus: 'TRANSIT' });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'STALE_STATUS');
  assert.equal(h.state.uld.CurrentStatus, 'TRANSIT');
  assert.equal(h.state.uld.IdentityVerified, 0);
  assert.equal(h.state.movements.length, 0);
  assert.equal(h.state.audits.length, 0);
  assert.equal(h.state.rollbacks, 1);
});

test('two ULD requests expecting ARRIVED produce one transition', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 } });
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const first = await call(handler, 'POST', { uldId: 7, expectedCurrentStatus: 'ARRIVED', nextStatus: 'TRANSIT' });
  const second = await call(handler, 'POST', { uldId: 7, expectedCurrentStatus: 'ARRIVED', nextStatus: 'TRANSIT' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(h.state.movements.length, 1);
  assert.equal(h.state.audits.length, 1);
});

test('export WAREHOUSE transition succeeds once and stale race has no side effects', async () => {
  const h = sqlHarness({ uld: { UldId: 8, FlightId: 2, UldNumber: 'PMC48921R7', CurrentStatus: 'WAREHOUSE', IdentityVerified: 0, Direction: 'EXPORT' } });
  h.state.raceUldStatus = 'TRANSIT';
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const stale = await call(handler, 'POST', { uldId: 8, expectedCurrentStatus: 'WAREHOUSE', nextStatus: 'TRANSIT' });
  assert.equal(stale.status, 409);
  assert.equal(h.state.uld.CurrentStatus, 'TRANSIT');
  assert.equal(h.state.uld.IdentityVerified, 0);
  assert.equal(h.state.movements.length, 0);
  assert.equal(h.state.audits.length, 0);
});

test('missing ULD ID does not mutate', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 } });
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: 999, expectedCurrentStatus: 'ARRIVED', nextStatus: 'TRANSIT' });
  assert.equal(response.status, 404);
  assert.equal(h.state.uld.CurrentStatus, 'ARRIVED');
  assert.equal(h.state.movements.length, 0);
  assert.equal(h.state.audits.length, 0);
});

test('offload collection and completion each succeed once, then reject stale repeats', async () => {
  const h = sqlHarness({ offload: { OffloadId: 90, FlightId: 1, FlightNumber: 'CX178', UldNumber: 'AKE12345CX', ParkingBay: 'F25', Status: 'REQUESTED' } });
  const handler = loadHandler('api/offloads/index.js', h.sql);
  const collected = await call(handler, 'PATCH', { offloadId: 90, expectedCurrentStatus: 'REQUESTED', nextStatus: 'TRANSIT' });
  const collectAgain = await call(handler, 'PATCH', { offloadId: 90, expectedCurrentStatus: 'REQUESTED', nextStatus: 'TRANSIT' });
  const completed = await call(handler, 'PATCH', { offloadId: 90, expectedCurrentStatus: 'TRANSIT', nextStatus: 'COMPLETE', deliveredLocation: 'Cool Room 4' });
  const completeAgain = await call(handler, 'PATCH', { offloadId: 90, expectedCurrentStatus: 'TRANSIT', nextStatus: 'COMPLETE', deliveredLocation: 'Cool Room 4' });
  assert.deepEqual([collected.status, collectAgain.status, completed.status, completeAgain.status], [200, 409, 200, 409]);
  assert.equal(collectAgain.body.code, 'STALE_STATUS');
  assert.equal(completeAgain.body.code, 'STALE_STATUS');
  assert.equal(h.state.offload.Status, 'COMPLETE');
  assert.deepEqual(h.state.audits.map(event => [event.Action, event.FromStatus, event.ToStatus]), [
    ['Offload collected', 'REQUESTED', 'TRANSIT'],
    ['Offload delivered', 'TRANSIT', 'COMPLETE']
  ]);
});

test('offload request creates exactly one authoritative server audit', async () => {
  const h = sqlHarness();
  const handler = loadHandler('api/offloads/index.js', h.sql);
  const response = await call(handler, 'POST', { uldNumber: 'AKE12345CX', flightId: 1, flightNumber: 'CX178', operatingDate: '2026-09-17', parkingBay: 'F25' });
  assert.equal(response.status, 201);
  assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.audits[0].Action, 'Offload requested');
  assert.equal(h.state.audits[0].ActorDisplayName, 'Concurrency Tester');
});

test('offload request attaches to the explicitly selected flight instance, never the newest matching number', async () => {
  const h = sqlHarness({ flights: [
    { FlightId: 100, FlightNumber: 'CX0178', OperatingDate: '2026-09-17', FlightStatus: 'ACTIVE' },
    { FlightId: 110, FlightNumber: 'CX178', OperatingDate: '2026-09-18', FlightStatus: 'ACTIVE' }
  ] });
  const handler = loadHandler('api/offloads/index.js', h.sql);
  const response = await call(handler, 'POST', { uldNumber: 'PMC48921R7', flightId: 100, flightNumber: 'CX178', operatingDate: '2026-09-17', parkingBay: 'F25' });
  assert.equal(response.status, 201);
  assert.equal(h.state.offload.FlightId, 100);
  assert.equal(h.state.offload.FlightNumber, 'CX0178');
  assert.equal(response.body.offload.operatingDate, '2026-09-17');
  assert.equal(h.state.queries.some(call => /TOP 1|ORDER BY OperatingDate DESC/.test(call.q)), false);
});

test('invalid FlightId and mismatched flight context fail closed without insert or success audit', async () => {
  const h = sqlHarness({ flights: [{ FlightId: 100, FlightNumber: 'CX178', OperatingDate: '2026-09-17', FlightStatus: 'ACTIVE' }] });
  const handler = loadHandler('api/offloads/index.js', h.sql);
  const missing = await call(handler, 'POST', { uldNumber: 'AKE12345CX', flightId: 999, flightNumber: 'CX178', operatingDate: '2026-09-17', parkingBay: 'F25' });
  const wrongNumber = await call(handler, 'POST', { uldNumber: 'AKE12345CX', flightId: 100, flightNumber: 'QF11', operatingDate: '2026-09-17', parkingBay: 'F25' });
  const wrongDate = await call(handler, 'POST', { uldNumber: 'AKE12345CX', flightId: 100, flightNumber: 'CX178', operatingDate: '2026-09-18', parkingBay: 'F25' });
  h.state.flights[0].FlightStatus = 'CLOSED';
  const inactive = await call(handler, 'POST', { uldNumber: 'AKE12345CX', flightId: 100, flightNumber: 'CX178', operatingDate: '2026-09-17', parkingBay: 'F25' });
  assert.deepEqual([missing.status, wrongNumber.status, wrongDate.status, inactive.status], [404, 409, 409, 409]);
  assert.equal(wrongNumber.body.code, 'FLIGHT_CONTEXT_MISMATCH');
  assert.equal(inactive.body.code, 'FLIGHT_NOT_ACTIVE');
  assert.equal(h.state.offload, null);
  assert.equal(h.state.audits.length, 0);
});

test('offload GET returns operating date from the flight linked by FlightId', async () => {
  const h = sqlHarness({
    offload: { OffloadId: 90, FlightId: 100, FlightNumber: 'CX178', UldNumber: 'AKE12345CX', ParkingBay: 'F25', Status: 'REQUESTED' },
    flights: [
      { FlightId: 100, FlightNumber: 'CX178', OperatingDate: '2026-09-17', FlightStatus: 'ACTIVE' },
      { FlightId: 110, FlightNumber: 'CX178', OperatingDate: '2026-09-18', FlightStatus: 'ACTIVE' }
    ]
  });
  const handler = loadHandler('api/offloads/index.js', h.sql);
  const response = await call(handler, 'GET');
  assert.equal(response.status, 200);
  assert.equal(response.body.offloads[0].flightId, 100);
  assert.equal(response.body.offloads[0].operatingDate, '2026-09-17');
});

test('required audit failure rolls back offload creation', async () => {
  const h = sqlHarness();
  h.state.failAudit = true;
  const handler = loadHandler('api/offloads/index.js', h.sql);
  const response = await call(handler, 'POST', { uldNumber: 'AKE12345CX', flightId: 1, flightNumber: 'CX178', operatingDate: '2026-09-17', parkingBay: 'F25' });
  assert.equal(response.status, 500);
  assert.equal(h.state.offload, null);
  assert.equal(h.state.audits.length, 0);
  assert.equal(h.state.commits, 0);
  assert.equal(h.state.rollbacks, 1);
});

test('mail scan writes one authoritative audit and an idempotent retry writes none', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, FlightNumber: 'CX178', UldNumber: 'AKE12345CX', CurrentStatus: 'RECEIVED' } });
  const handler = loadHandler('api/mail-scan/index.js', h.sql);
  const first = await call(handler, 'POST', { uldId: 7 });
  const retry = await call(handler, 'POST', { uldId: 7 });
  assert.equal(first.status, 200);
  assert.equal(first.body.alreadyScanned, false);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.alreadyScanned, true);
  assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.audits[0].Action, 'Bulk mail scanned');
});

test('offload race and wrong ID do not mutate another request', async () => {
  const h = sqlHarness({ offload: { OffloadId: 90, FlightId: 1, FlightNumber: 'CX178', UldNumber: 'AKE12345CX', ParkingBay: 'F25', Status: 'REQUESTED' } });
  const handler = loadHandler('api/offloads/index.js', h.sql);
  h.state.raceOffloadStatus = 'TRANSIT';
  const raced = await call(handler, 'PATCH', { offloadId: 90, expectedCurrentStatus: 'REQUESTED', nextStatus: 'TRANSIT' });
  const missing = await call(handler, 'PATCH', { offloadId: 91, expectedCurrentStatus: 'REQUESTED', nextStatus: 'TRANSIT' });
  assert.equal(raced.status, 409);
  assert.equal(raced.body.code, 'STALE_STATUS');
  assert.equal(missing.status, 404);
  assert.equal(h.state.offload.OffloadId, 90);
  assert.equal(h.state.offload.Status, 'TRANSIT');
  assert.equal(h.state.audits.length, 0);
});

test('required audit failure rolls back the successful ULD mutation', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 } });
  h.state.failAudit = true;
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', {
    uldId: 7,
    expectedCurrentStatus: 'ARRIVED',
    nextStatus: 'TRANSIT',
    actorDisplayName: 'Untrusted Browser Name'
  });
  assert.equal(response.status, 500);
  assert.equal(h.state.uld.CurrentStatus, 'ARRIVED');
  assert.equal(h.state.uld.IdentityVerified, 0);
  assert.equal(h.state.audits.length, 0);
  assert.equal(h.state.movements.length, 0);
  assert.equal(h.state.rollbacks, 1);
});

test('frontend operational feedback does not POST a duplicate browser audit', () => {
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = source.indexOf('function logEvent(');
  const end = source.indexOf('function clearLocalCargoRunCache(', start);
  const logEventSource = source.slice(start, end);
  assert.doesNotMatch(logEventSource, /\/api\/history/);
  assert.doesNotMatch(source, /function postAuditEvent/);
});

test('operational mutation handlers write required audits before commit', () => {
  for (const relativePath of [
    'api/uld-status/index.js',
    'api/offloads/index.js',
    'api/mail-scan/index.js',
    'api/flights/index.js',
    'api/import-completions/index.js',
    'api/export-completions/index.js'
  ]) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.match(source, /await insertAuditEvent\(/, relativePath);
  }
  const frontend = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(frontend, /body:JSON\.stringify\(\{flightId:f\.azureFlightId,inBlockAtUtc\}\)/);
});

test('canonical ULD status function exposes the unchanged public route', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'api/uld-status/function.json'), 'utf8'));
  const trigger = config.bindings.find(binding => binding.type === 'httpTrigger');
  assert.equal(trigger.route, 'uld-status');
  assert.deepEqual(Array.from(trigger.methods), ['post']);
  const source = fs.readFileSync(path.join(root, 'api/uld-status/index.js'), 'utf8');
  assert.match(source, /WHERE UldId = @UldId\s+AND CurrentStatus = @ExpectedStatus/);
});
