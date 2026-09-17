'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeUldNumber } = require('../api/shared/uld');

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
      throw new Error(`Unexpected require: ${name}`);
    }
  });
  vm.runInContext(source, context, { filename });
  return module.exports;
}

function sqlHarness({ uld, offload } = {}) {
  const state = {
    uld: uld ? structuredClone(uld) : null,
    offload: offload ? structuredClone(offload) : null,
    movements: [], commits: 0, rollbacks: 0,
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
    ]
  };

  class Transaction {
    async begin() { this.active = true; this.snapshot = structuredClone({ uld: state.uld, offload: state.offload, movements: state.movements }); }
    async commit() { this.active = false; state.commits++; }
    async rollback() {
      if (this.active) {
        state.uld = this.snapshot.uld; state.offload = this.snapshot.offload; state.movements = this.snapshot.movements;
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
        const table = p.TableName || Object.entries(p).find(([k]) => k.startsWith('TableName_'))?.[1];
        return result((columns[table] || []).map(COLUMN_NAME => ({ COLUMN_NAME, IS_NULLABLE: 'YES', IS_IDENTITY: COLUMN_NAME.endsWith('Id') ? 1 : 0 })));
      }
      if (q.includes('FROM dbo.ULDs u INNER JOIN dbo.Flights')) {
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
      if (q.includes('SELECT CurrentStatus FROM dbo.ULDs')) return result(state.uld ? [{ CurrentStatus: state.uld.CurrentStatus }] : []);
      if (q.includes('SELECT * FROM dbo.ULDs')) return result(state.uld ? [{ ...state.uld }] : []);

      if (q.startsWith('SELECT * FROM dbo.Offloads WHERE')) {
        const id = p.OffloadId ?? p.LatestOffloadId;
        return result(state.offload && String(state.offload.OffloadId) === String(id) ? [{ ...state.offload }] : []);
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
    BigInt: 'bigint', DateTime2: n => `datetime2(${n})`
  };
  return { sql, state };
}

async function call(handler, method, body) {
  const context = { log: { error() {}, warn() {} } };
  await handler(context, { method, body, headers: { 'x-ms-client-principal': principal } });
  return { status: context.res.status, body: JSON.parse(context.res.body) };
}

test('ULD update is conditional, atomic, and records one movement', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 } });
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: 7, expectedCurrentStatus: 'ARRIVED', nextStatus: 'TRANSIT' });
  assert.equal(response.status, 200);
  assert.equal(h.state.uld.CurrentStatus, 'TRANSIT');
  assert.equal(h.state.uld.IdentityVerified, 1);
  assert.equal(h.state.movements.length, 1);
  assert.equal(h.state.commits, 1);
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
});

test('missing ULD ID does not mutate', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 } });
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: 999, expectedCurrentStatus: 'ARRIVED', nextStatus: 'TRANSIT' });
  assert.equal(response.status, 404);
  assert.equal(h.state.uld.CurrentStatus, 'ARRIVED');
  assert.equal(h.state.movements.length, 0);
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
});

test('canonical ULD status function exposes the unchanged public route', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'api/uld-status/function.json'), 'utf8'));
  const trigger = config.bindings.find(binding => binding.type === 'httpTrigger');
  assert.equal(trigger.route, 'uld-status');
  assert.deepEqual(Array.from(trigger.methods), ['post']);
  const source = fs.readFileSync(path.join(root, 'api/uld-status/index.js'), 'utf8');
  assert.match(source, /WHERE UldId = @UldId\s+AND CurrentStatus = @ExpectedStatus/);
});
