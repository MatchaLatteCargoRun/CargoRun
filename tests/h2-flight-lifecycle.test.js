'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const authorization = require('../api/shared/operational-authorization');
const flightHelpers = require('../api/shared/flight');
const snapshotHelpers = require('../api/shared/completion-snapshot');
const audit = require('../api/shared/audit');
const stations = [
  { StationId: 1, StationCode: 'MEL', DisplayName: 'Melbourne', TimeZoneId: 'Australia/Melbourne', IsEnabled: 1 },
  { StationId: 2, StationCode: 'AKL', DisplayName: 'Auckland', TimeZoneId: 'Pacific/Auckland', IsEnabled: 1 }
];
const capabilities = ['MOVE_ULD', 'SCAN_ULD', 'FINALISE_FLIGHT'];
const principal = Buffer.from(JSON.stringify({ userId: 'h2-test-user', userDetails: 'Synthetic operator', userRoles: ['authenticated'] })).toString('base64');
const res = (recordset = [], rowsAffected = []) => ({ recordset, recordsets: [recordset], rowsAffected });

// Transaction/application-lock simulation, not SQL Server. Production handlers,
// station authorization, audit insertion and lifecycle helpers execute unchanged.
// Existing completion tests separately exercise full authoritative snapshots.
function harness({ station = stations[0], direction = 'EXPORT', status = 'ACTIVE', allowed = [1, 2] } = {}) {
  const state = {
    flight: { FlightId: 101, StationId: station.StationId, FlightNumber: 'CX178',
      OperatingDate: '2026-10-10', OperatingDateIso: '2026-10-10', Direction: direction,
      OriginAirport: direction === 'EXPORT' ? station.StationCode : 'HKG',
      DestinationAirport: direction === 'EXPORT' ? 'HKG' : station.StationCode,
      FlightStatus: status, AirlineCode: 'CX' },
    uld: { UldId: 701, FlightId: 101, UldNumber: 'AKE12345CX', CurrentStatus: 'TRANSIT', IdentityVerified: 1 },
    audits: [], movements: [], completions: [], writes: 0, commits: 0, rollbacks: 0,
    calls: [], lockResult: 0, failAudit: false, failCas: false, onLock: null, onChildRead: null,
    activeLocks: 0, maxLocks: 0
  };
  const tails = new Map(), holds = [];
  const image = () => structuredClone({ flight: state.flight, uld: state.uld, audits: state.audits, movements: state.movements, completions: state.completions });
  class Transaction {
    async begin() { this.active = true; }
    async commit() { this.active = false; state.commits++; this.release?.(); }
    async rollback() {
      if (!this.active) return;
      if (this.before) Object.assign(state, this.before);
      this.active = false; state.rollbacks++; this.release?.();
    }
  }
  class Request {
    constructor(tx) { this.tx = tx; this.parameters = {}; }
    input(name, type, value) { this.parameters[name] = value; return this; }
    async query(source) {
      const q = source.replace(/\s+/g, ' ').trim(), p = this.parameters;
      state.calls.push({ q, p: { ...p }, tx: !!this.tx?.active });
      if (q.includes('WITH AuthorizationScopes AS')) return res(stations.filter(s => allowed.includes(s.StationId)).flatMap(s => capabilities.map(CapabilityCode => ({ ...s, CapabilityCode }))));
      if (q.includes('WITH AssignmentDecisions AS')) return res(allowed.includes(stations.find(s => s.StationCode === p.AuthorizationStationCode)?.StationId) ? capabilities.map(CapabilityCode => ({ CapabilityCode })) : []);
      if (q.includes('FROM dbo.CargoRunStations WHERE StationId=@ResolvedStationId')) return res(stations.filter(s => String(s.StationId) === String(p.ResolvedStationId)));
      if (q.includes('sys.sp_getapplock')) {
        assert.ok(this.tx?.active);
        if (state.lockResult !== 0) return res([{ LockResult: state.lockResult }]);
        const key = p.FlightIdentityLockResource;
        const previous = tails.get(key) || Promise.resolve(); let unlock;
        const next = new Promise(resolve => { unlock = resolve; }); tails.set(key, previous.then(() => next));
        await previous; state.activeLocks++; state.maxLocks = Math.max(state.maxLocks, state.activeLocks);
        this.tx.release = () => { state.activeLocks--; unlock(); };
        const hold = holds.shift(); if (hold) { hold.acquired(); await hold.wait; }
        state.onLock?.(state); state.onLock = null;
        this.tx.before = image();
        return res([{ LockResult: 0 }]);
      }
      if (q.includes('FROM INFORMATION_SCHEMA.COLUMNS')) {
        const table = p.TableName || p.AuditTableName || Object.entries(p).find(([k]) => k.startsWith('TableName_'))?.[1];
        const cols = table === 'ULDs' ? ['UldId','IdentityVerified'] : table === 'UldMovements' ? [] :
          table === 'AuditEvents' ? ['AuditEventId','Action','ActorDisplayName','FlightId','FromStatus','ToStatus','Detail','DetailsJson'] :
          ['CompletionId','FlightId','VerificationId','FinalisedAtUtc','FinalisedByDisplayName','FinalisedByObjectId','SnapshotJson','RecordHash'];
        return res(cols.map(COLUMN_NAME => ({ COLUMN_NAME, IS_NULLABLE: 'YES', IS_IDENTITY: COLUMN_NAME === 'CompletionId' || COLUMN_NAME === 'AuditEventId' ? 1 : 0 })));
      }
      if (q.includes('FROM dbo.ULDs u') && q.includes('JOIN dbo.Flights f')) {
        const id = p.UldId ?? p.AuthorizationUldId ?? p.AuditUldId;
        return res(state.uld && state.flight && String(state.uld.UldId) === String(id) && state.uld.FlightId === state.flight.FlightId ? [{ ...state.flight, ...state.uld }] : []);
      }
      if (q.startsWith('SELECT') && q.includes('FROM dbo.Flights')) {
        const id = p.FlightId ?? p.InitialFlightId ?? p.LockedFlightId;
        return res(state.flight && String(id) === String(state.flight.FlightId) ? [{ ...state.flight }] : []);
      }
      if (q.startsWith('SELECT COUNT(*) AS Pending')) {
        const terminal = direction === 'EXPORT' ? 'AT_AIRCRAFT' : 'RECEIVED';
        return res([{ Pending: state.uld?.CurrentStatus === terminal ? 0 : 1 }]);
      }
      if (q.startsWith('SELECT') && q.includes('FROM dbo.ULDs')) {
        if (p.LockedUldId) { state.onChildRead?.(state); state.onChildRead = null; }
        const id = p.LockedUldId ?? p.UpdatedUldId ?? p.UldId2 ?? p.LatestUldId;
        return res(state.uld && (!id || String(id) === String(state.uld.UldId)) && (!p.LockedUldFlightId || String(state.uld.FlightId) === String(p.LockedUldFlightId)) ? [{ ...state.uld }] : []);
      }
      if (q.startsWith('SELECT') && /FROM dbo.(Export|Import)CompletionRecords/.test(q)) return res(structuredClone(state.completions));
      if (q.startsWith('DECLARE @Now') && q.includes('UPDATE dbo.ULDs')) {
        state.writes++;
        if (state.uld.CurrentStatus !== p.ExpectedStatus) return res([], [0]);
        state.uld.CurrentStatus = p.NextStatus; state.uld.IdentityVerified = 1;
        return res([{ OccurredAtUtc: '2026-10-10T01:00:00Z' }], [1]);
      }
      if (q.startsWith('UPDATE dbo.ULDs SET MailScannedAtUtc')) {
        if (state.uld.MailScannedAtUtc) return res([], [0]);
        state.writes++; Object.assign(state.uld, { MailScannedAtUtc: '2026-10-10T01:00:00Z', MailScannedByDisplayName: p.DisplayName, MailScannedByReference: p.Reference });
        return res([{ ...state.uld }], [1]);
      }
      if (/^INSERT INTO dbo.(Export|Import)CompletionRecords/.test(q)) {
        state.writes++;
        const row = { CompletionId: 801, FlightId: p.FlightId, SnapshotJson: p.SnapshotJson, RecordHash: p.RecordHash, VerificationId: 'synthetic-v1' };
        state.completions.push(row); return res([row], [1]);
      }
      if (q.startsWith("UPDATE dbo.Flights SET FlightStatus='FINALISED'")) {
        if (state.failCas) return res([], [0]);
        if (q.includes("AND UPPER") && state.flight.FlightStatus !== 'ACTIVE') return res([], [0]);
        state.writes++; state.flight.FlightStatus = 'FINALISED'; return res([], [1]);
      }
      if (q.startsWith('INSERT INTO dbo.AuditEvents')) {
        if (state.failAudit) throw Error('synthetic audit failure');
        state.writes++; state.audits.push({ ...p }); return res([], [1]);
      }
      throw Error('Unhandled synthetic SQL: ' + q);
    }
  }
  class ConnectionPool { async connect() { return this; } request() { return new Request(); } async close() {} }
  const sql = { ConnectionPool, Transaction, Request, BigInt: 'bigint', Int: 'int', MAX: 'max', NVarChar: () => 'nvarchar', VarChar: () => 'varchar', DateTime2: () => 'datetime2' };
  function load(endpoint) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'api', endpoint, 'index.js'), 'utf8'), {
      module, exports: module.exports, Buffer, process: { env: { DATABASE_CONNECTION_STRING: 'synthetic-only' } },
      require(name) {
        if (name === 'mssql') return sql;
        if (name === '../shared/flight') return flightHelpers;
        if (name === '../shared/audit') return audit;
        if (name === '../shared/operational-authorization') return authorization;
        if (name === '../shared/completion-snapshot') return { ...snapshotHelpers, buildCompletionSnapshot: async (_tx, _sql, opts) => ({ completionTimeUtc: new Date('2026-10-10T01:00:00Z'), snapshot: { flightId: String(opts.flightId), ulds: [{ ...state.uld }] } }) };
        if (name === '../shared/flight-statement-evidence') return { loadFlightStatementEvidence: async () => ({ retained: true }), applyFlightStatementEvidence: (s,e) => ({ ...s, evidence: e }) };
        return require(name);
      }
    }); return module.exports;
  }
  return { state, image, async call(endpoint, body) {
    const context = { log: Object.assign(() => {}, { error(...args) { state.error = args[1]?.message; }, warn() {} }) };
    await load(endpoint)(context, { method: 'POST', body, headers: { 'x-ms-client-principal': principal } });
    return { status: context.res.status, body: JSON.parse(context.res.body) };
  }, hold() { let acquired, release; const h = { acquired: new Promise(r => { acquired = r; }), release: () => release() }; holds.push({ acquired, wait: new Promise(r => { release = r; }) }); return h; } };
}
const operations = [
  ['uld-status', { uldId: 701, expectedCurrentStatus: 'TRANSIT', nextStatus: 'AT_AIRCRAFT' }],
  ['mail-scan', { uldId: 701 }],
  ['export-completions', { flightId: 101 }]
];
for (const station of stations) {
  for (const [endpoint, body] of operations) {
    for (const status of ['CLOSED', 'FINALISED', 'FINALIZED', null, 'UNKNOWN']) {
      test('H2 ' + station.StationCode + ' ' + endpoint + ' denies ' + status + ' with no persistent writes', async () => {
        const h = harness({ station, status }); h.state.uld.CurrentStatus = endpoint === 'export-completions' ? 'AT_AIRCRAFT' : 'TRANSIT';
        const before = h.image(), r = await h.call(endpoint, body);
        assert.equal(r.status, 409, h.state.error); assert.equal(r.body.code, 'FLIGHT_NOT_ACTIVE');
        assert.deepEqual(h.image(), before); assert.equal(h.state.writes, 0); assert.equal(h.state.commits, 0);
      });
    }
    test('H2 ' + station.StationCode + ' ACTIVE ' + endpoint + ' succeeds under parent lock', async () => {
      const h = harness({ station }); if (endpoint === 'export-completions') h.state.uld.CurrentStatus = 'AT_AIRCRAFT';
      const r = await h.call(endpoint, body); assert.equal(r.status, endpoint === 'export-completions' ? 201 : 200, h.state.error);
      assert.equal(h.state.audits.length, 1); assert.equal(h.state.commits, 1);
      const app = h.state.calls.findIndex(c => c.q.includes('sp_getapplock'));
      const parent = h.state.calls.findIndex(c => c.q.includes('FROM dbo.Flights WITH (UPDLOCK,HOLDLOCK)'));
      const child = h.state.calls.findIndex(c => /^(INSERT|UPDATE|DECLARE @Now)/.test(c.q));
      assert.ok(app >= 0 && app < parent && parent < child);
      assert.ok(h.state.calls.slice(parent, child + 1).every(c => c.tx));
      assert.match(h.state.calls[app].p.FlightIdentityLockResource, new RegExp('^CargoRun:Flight:v2:' + station.StationId + ':'));
    });
    test('H2 ' + station.StationCode + ' ' + endpoint + ' rechecks status after waiting', async () => {
      const h = harness({ station }); h.state.onLock = s => { s.flight.FlightStatus = 'CLOSED'; };
      const r = await h.call(endpoint, body); assert.equal(r.status, 409); assert.equal(h.state.writes, 0); assert.equal(h.state.flight.FlightStatus, 'CLOSED');
    });
    test('H2 ' + station.StationCode + ' ' + endpoint + ' audit failure rolls back every mutation', async () => {
      const h = harness({ station }); if (endpoint === 'export-completions') h.state.uld.CurrentStatus = 'AT_AIRCRAFT'; h.state.failAudit = true;
      const before = h.image(), r = await h.call(endpoint, body); assert.equal(r.status, 500, h.state.error);
      assert.deepEqual(h.image(), before); assert.equal(h.state.commits, 0); assert.equal(h.state.rollbacks, 1);
    });
    test('H2 forged station cannot authorize ' + station.StationCode + ' ' + endpoint, async () => {
      const h = harness({ station, allowed: [station.StationId === 1 ? 2 : 1] });
      const before = h.image(), r = await h.call(endpoint, { ...body, stationId: station.StationId === 1 ? 2 : 1, stationCode: 'MEL' });
      assert.ok([403,404].includes(r.status), h.state.error); assert.equal(h.state.writes, 0); assert.deepEqual(h.image(), before);
    });
  }
  test('H2 ' + station.StationCode + ' completion retry preserves V1 bytes and audit', async () => {
    const h = harness({ station }); h.state.uld.CurrentStatus = 'AT_AIRCRAFT';
    assert.equal((await h.call('export-completions', { flightId: 101 })).status, 201);
    const before = h.image(), v1 = h.state.completions[0];
    assert.equal(crypto.createHash('sha256').update(v1.SnapshotJson).digest('hex'), v1.RecordHash);
    assert.equal((await h.call('export-completions', { flightId: 101 })).status, 409);
    assert.deepEqual(h.image(), before);
  });
  test('H2 ' + station.StationCode + ' export lifecycle CAS failure rolls back V1', async () => {
    const h = harness({ station }); h.state.uld.CurrentStatus = 'AT_AIRCRAFT'; h.state.failCas = true;
    const before = h.image(), r = await h.call('export-completions', { flightId: 101 });
    assert.equal(r.status,409); assert.equal(r.body.code,'EXPORT_FINALISATION_CONFLICT'); assert.deepEqual(h.image(),before);
  });
  for (const endpoint of ['uld-status', 'mail-scan']) {
    for (const direction of ['IMPORT', 'EXPORT']) {
      const body = endpoint === 'uld-status' ? { uldId: 701, expectedCurrentStatus: 'TRANSIT', nextStatus: direction === 'IMPORT' ? 'RECEIVED' : 'AT_AIRCRAFT' } : { uldId: 701 };
      test('H2 ' + station.StationCode + ' ' + direction + ' finalizer wins race against ' + endpoint, async () => {
        const h = harness({ station, direction }); if (endpoint === 'mail-scan' || direction === 'EXPORT') h.state.uld.CurrentStatus = direction === 'IMPORT' ? 'RECEIVED' : 'AT_AIRCRAFT';
        const hold = h.hold(); const done = h.call(direction.toLowerCase()+'-completions', { flightId:101, exceptionReason:'Synthetic late ULD' }); await hold.acquired;
        let settled = false; const update = h.call(endpoint,body).then(r => { settled = true; return r; });
        await new Promise(r => setImmediate(r)); assert.equal(settled,false,'update must wait for finalisation'); hold.release();
        const [a,b] = await Promise.all([done,update]); assert.equal(a.status,201,h.state.error); assert.equal(b.status,409); assert.equal(b.body.code,'FLIGHT_NOT_ACTIVE');
        assert.equal(h.state.completions.length,1); assert.equal(h.state.audits.length,1); assert.equal(h.state.maxLocks,1); assert.equal(h.state.uld.MailScannedAtUtc,undefined);
      });
      test('H2 ' + station.StationCode + ' ' + direction + ' ' + endpoint + ' wins race and is captured before finalization', async () => {
        const h = harness({ station, direction }); if(endpoint==='mail-scan')h.state.uld.CurrentStatus=direction==='IMPORT'?'RECEIVED':'AT_AIRCRAFT';
        const hold=h.hold(),update=h.call(endpoint,body); await hold.acquired;
        let settled=false; const done=h.call(direction.toLowerCase()+'-completions',{flightId:101}).then(r=>{settled=true;return r;});
        await new Promise(r=>setImmediate(r)); assert.equal(settled,false);hold.release();
        const [a,b]=await Promise.all([update,done]);assert.equal(a.status,200,h.state.error);assert.equal(b.status,201,h.state.error);
        const captured=JSON.parse(h.state.completions[0].SnapshotJson).ulds[0];
        assert.equal(captured.CurrentStatus,direction==='IMPORT'?'RECEIVED':'AT_AIRCRAFT');if(endpoint==='mail-scan')assert.equal(captured.MailScannedAtUtc,h.state.uld.MailScannedAtUtc);
        assert.equal(h.state.audits.length,2);assert.equal(h.state.maxLocks,1);
      });
    }
  }
}
for (const [endpoint, body] of operations) {
  test('H2 ' + endpoint + ' lock failure writes nothing', async () => { const h=harness();h.state.lockResult=-1;const before=h.image();assert.equal((await h.call(endpoint,body)).status,500);assert.equal(h.state.writes,0);assert.deepEqual(h.image(),before); });
  test('H2 ' + endpoint + ' rejects changed parent identity', async () => { const h=harness();h.state.onLock=s=>{s.flight.OperatingDateIso='2026-10-11';};const r=await h.call(endpoint,body);assert.equal(r.status,409);assert.equal(r.body.code,'FLIGHT_IDENTITY_CHANGED');assert.equal(h.state.writes,0); });
}
for(const endpoint of ['uld-status','mail-scan'])test('H2 '+endpoint+' rejects changed ULD parent',async()=>{const h=harness();h.state.onChildRead=s=>{s.uld.FlightId=999;};const r=await h.call(endpoint,operations.find(x=>x[0]===endpoint)[1]);assert.equal(r.status,409);assert.equal(r.body.code,'ULD_FLIGHT_CHANGED');assert.equal(h.state.writes,0);});

for (const station of stations) {
  for (const endpoint of ['uld-status','mail-scan']) for (const status of ['CLOSED','FINALISED']) {
    test('H2 '+station.StationCode+' IMPORT '+endpoint+' denies '+status,async()=>{
      const h=harness({station,direction:'IMPORT',status});const before=h.image();
      const r=await h.call(endpoint,{uldId:701,expectedCurrentStatus:'TRANSIT',nextStatus:'RECEIVED'});
      assert.equal(r.status,409);assert.equal(r.body.code,'FLIGHT_NOT_ACTIVE');assert.equal(h.state.writes,0);assert.deepEqual(h.image(),before);
    });
  }
  test('H2 '+station.StationCode+' ACTIVE mail retry adds no audit',async()=>{
    const h=harness({station});assert.equal((await h.call('mail-scan',{uldId:701})).status,200);const before=h.image();
    const retry=await h.call('mail-scan',{uldId:701});assert.equal(retry.status,200);assert.equal(retry.body.alreadyScanned,true);assert.deepEqual(h.image(),before);
  });
  test('H2 '+station.StationCode+' ACTIVE flight with existing V1 cannot rewrite completion',async()=>{
    const h=harness({station});h.state.uld.CurrentStatus='AT_AIRCRAFT';h.state.completions.push({CompletionId:801,FlightId:101,SnapshotJson:'{"retained":true}',RecordHash:'preserved'});
    const before=h.image();assert.equal((await h.call('export-completions',{flightId:101})).status,409);assert.equal(h.state.writes,0);assert.deepEqual(h.image(),before);
  });
}
for(const [endpoint,body] of operations)test('H2 '+endpoint+' re-authorizes ownership after lock wait',async()=>{
 const h=harness({allowed:[1]});h.state.onLock=s=>{s.flight.StationId=2;s.flight.OriginAirport='AKL';};
 const r=await h.call(endpoint,body);assert.equal(r.status,404);assert.equal(h.state.writes,0);assert.equal(h.state.audits.length,0);
});
