'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { normalizeUldNumber } = require('../api/shared/uld');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sourceBetween = (start, end) => {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return html.slice(from, to);
};
const stations = [
  { StationId: '1', StationCode: 'MEL', DisplayName: 'Melbourne', TimeZoneId: 'Australia/Melbourne', IsEnabled: 1 },
  { StationId: '2', StationCode: 'AKL', DisplayName: 'Auckland', TimeZoneId: 'Pacific/Auckland', IsEnabled: 1 }
];
const supervisor = [
  'VIEW_FLIGHTS', 'MOVE_ULD', 'SCAN_ULD', 'VIEW_PRIORITY', 'REQUEST_OFFLOAD',
  'COLLECT_OFFLOAD', 'COMPLETE_OFFLOAD', 'SET_IN_BLOCK', 'SET_ETD',
  'UPLOAD_FLIGHT_DATA', 'VIEW_FLIGHT_STATEMENT', 'CONFIRM_EXPORT_FINAL',
  'FINALISE_FLIGHT', 'VIEW_HISTORY', 'EXPORT_HISTORY', 'VIEW_SUPERVISOR'
];

// Only the database driver is simulated. The HTTP handler, authorization,
// station resolver, route validation and flight lock helper are the real code.
// Query fixtures represent effective SUPERVISOR grants, not a SQL execution.
function apiHarness(allowed = ['MEL', 'AKL'], capabilities = supervisor) {
  const state = { writes: [], committed: [], commits: 0, rollbacks: 0, calls: [] };
  class Transaction {
    async begin() { this.active = true; this.pending = []; }
    async commit() {
      assert.equal(this.active, true);
      state.committed.push(...this.pending); state.commits++; this.active = false;
    }
    async rollback() { this.pending = []; this.active = false; state.rollbacks++; }
  }
  class Request {
    constructor(tx) { this.tx = tx; this.params = {}; }
    input(name, _type, value) { this.params[name] = value; return this; }
    async query(text) {
      const q = text.replace(/\s+/g, ' ').trim(), p = this.params;
      state.calls.push(q);
      const result = recordset => ({ recordset });
      if (q.includes('WITH AuthorizationScopes AS')) {
        assert.equal(p.OperationalAccessActorReference, 'synthetic-pilot');
        return result(stations.filter(s => allowed.includes(s.StationCode))
          .flatMap(s => capabilities.map(CapabilityCode => ({ ...s, CapabilityCode }))));
      }
      if (q.includes('FROM dbo.CargoRunStations WHERE StationId=@ResolvedStationId')) {
        return result(stations.filter(s => s.StationId === String(p.ResolvedStationId)));
      }
      if (q.includes('sys.sp_getapplock')) return result([{ LockResult: 0 }]);
      if (/FROM dbo\.Flights WHERE StationId\s*=\s*@StationId/.test(q)) return result([]);
      const match = /^INSERT INTO dbo\.(Flights|FlightUploads|ULDs|UldSpecialHandlingCodes)\b/.exec(q);
      if (match) {
        assert.equal(this.tx?.active, true, 'all writes require a transaction');
        const row = { table: match[1], ...p };
        state.writes.push(row); this.tx.pending.push(row);
        if (match[1] === 'Flights') return result([{ ...p, FlightId: 101 }]);
        if (match[1] === 'ULDs') return result([{ ...p, UldId: 201, CurrentStatus: 'UNARRIVED' }]);
        return result([]);
      }
      throw new Error('Unexpected SQL in synthetic driver: ' + q);
    }
  }
  const scalar = () => 'synthetic-type';
  const sql = { Request, Transaction, ConnectionPool: class {
    async connect() { return this; }
    async close() {}
  }, NVarChar: scalar, VarChar: scalar, Decimal: scalar, BigInt: scalar, Date: scalar, Int: scalar };
  const filename = path.join(root, 'api/manifest-upload/index.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer,
    process: { env: { DATABASE_CONNECTION_STRING: 'synthetic-only-no-network' } },
    require: name => name === 'mssql' ? sql : localRequire(name)
  }, { filename });
  async function call(body) {
    const errors = [];
    const context = { log: { error: (...args) => errors.push(args) } };
    await module.exports(context, { method: 'POST', body, headers: {
      'x-ms-client-principal': Buffer.from(JSON.stringify({
        userId: 'synthetic-pilot', userDetails: 'Synthetic pilot', userRoles: ['authenticated']
      })).toString('base64')
    } });
    assert.deepEqual(errors, [], 'no unexpected handler failure');
    return { status: context.res.status, body: JSON.parse(context.res.body) };
  }
  return { state, call };
}

function browser(api, selected = 'AKL', type = 'imports') {
  const requests = [], replies = [], notices = [];
  const context = vm.createContext({
    console: { error() {} }, Set, Map, Date,
    state: { imports: [], exports: [] },
    pendingFlightUpload: { type, flight: 'ZZ123', flightDate: '2026-10-08',
      sourceFile: 'synthetic.xlsx', ulds: [{ num: 'AKE12345ZZ', shcs: ['GEN'] }] },
    document: { getElementById: () => null },
    cargoRunApiDate: x => x, normalizeFlightLookup: x => x, normalizeULD: normalizeUldNumber,
    handlingCounts: () => ({}), currentUser: () => ({ name: 'Synthetic pilot' }),
    logEvent() {}, save() {}, closeModal() {}, openScreen() {}, deferOperational() {},
    FLIGHTAWARE_ENABLED: false, toast: text => notices.push(text),
    fetch: async (url, options) => {
      assert.equal(url, '/api/manifest-upload'); assert.equal(options.method, 'POST');
      const payload = JSON.parse(options.body); requests.push(payload);
      const reply = await api.call(payload); replies.push(reply);
      return { ok: reply.status === 201, status: reply.status, json: async () => reply.body };
    }
  });
  vm.runInContext(sourceBetween('let cargoRunAccess=', 'function deferOperational('), context);
  const metadata = stations.map(s => ({ stationId: s.StationId, stationCode: s.StationCode,
    displayName: s.DisplayName, timeZoneId: s.TimeZoneId, capabilities: supervisor }));
  vm.runInContext('cargoRunAccess=' + JSON.stringify({ status: 'provisioned', stationMetadata: metadata })
    + ';selectedStationId=' + JSON.stringify(stations.find(s => s.StationCode === selected).StationId), context);
  vm.runInContext(sourceBetween('async function createUploadedFlight()', 'function finalManifestRequestUlds('), context);
  return { context, requests, replies, notices };
}
function payload(stationCode = 'AKL') {
  return { stationCode, flight: { flightNumber: 'ZZ123', operatingDate: '2026-10-08',
    direction: 'IMPORT', destinationAirport: stationCode }, ulds: [{ uldNumber: 'AKE12345ZZ' }] };
}
function assertNoWrites(api) {
  assert.equal(api.state.writes.length, 0, 'denial must precede every data write');
  assert.equal(api.state.committed.length, 0);
  assert.equal(api.state.commits, 0);
  assert.equal(api.state.rollbacks, 1);
}

test('legacy browser request reproduces exact denial for a dual-station SUPERVISOR before any write', async () => {
  const api = apiHarness(), body = payload('MEL');
  delete body.stationCode;
  const response = await api.call(body);
  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'STATION_ACCESS_DENIED');
  assert.equal(response.body.error, 'The authenticated user is not authorized for this operation at the selected station');
  assertNoWrites(api);
});

for (const [code, id] of [['AKL', '2'], ['MEL', '1']]) {
  for (const type of ['imports', 'exports']) {
    test('real browser/API creates authorized ' + code + ' ' + type + ' in the selected station', async () => {
      const api = apiHarness(), page = browser(api, code, type);
      await page.context.createUploadedFlight();
      assert.equal(page.replies[0].status, 201);
      assert.equal(page.requests[0].stationCode, code);
      assert.equal(page.requests[0].flight[type === 'imports' ? 'destinationAirport' : 'originAirport'], code);
      assert.equal(page.requests[0].flight[type === 'imports' ? 'originAirport' : 'destinationAirport'], null);
      assert.equal(api.state.commits, 1);
      assert.equal(api.state.committed.find(r => r.table === 'Flights').StationId, id);
      assert.deepEqual(api.state.committed.map(r => r.table), ['Flights', 'FlightUploads', 'ULDs', 'UldSpecialHandlingCodes']);
      assert.equal(page.context.state[type][0].azureFlightId, 101);
    });
  }
}
test('MEL-only user cannot forge AKL context or reuse stale browser AKL membership', async () => {
  const api = apiHarness(['MEL']), page = browser(api);
  await page.context.createUploadedFlight();
  assert.equal(page.replies[0].status, 403);
  assert.equal(page.replies[0].body.code, 'STATION_ACCESS_DENIED');
  assert.equal(page.context.state.imports.length, 0);
  assertNoWrites(api);
});
test('manipulating route to AKL while requesting authorized MEL is rejected before writes', async () => {
  const api = apiHarness(['MEL']), body = payload('AKL');
  body.stationCode = 'MEL';
  const response = await api.call(body);
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'FLIGHT_ROUTE_STATION_MISMATCH');
  assertNoWrites(api);
});
test('unknown station and missing upload capability remain denied', async () => {
  for (const [api, body] of [
    [apiHarness(), payload('SYD')],
    [apiHarness(['MEL', 'AKL'], ['VIEW_FLIGHTS']), payload()]
  ]) {
    assert.equal((await api.call(body)).status, 403);
    assertNoWrites(api);
  }
});
test('station switch discards a late successful response from the previous station', async () => {
  const api = apiHarness(), page = browser(api);
  let finish;
  page.context.fetch = async (_url, options) => {
    page.requests.push(JSON.parse(options.body));
    return new Promise(resolve => { finish = resolve; });
  };
  const pending = page.context.createUploadedFlight();
  vm.runInContext('operationalSessionGeneration++;selectedStationId="1";pendingFlightUpload=null;', page.context);
  finish({ ok: true, json: async () => ({ flight: { FlightId: 101 }, ulds: [] }) });
  await pending;
  assert.equal(page.requests[0].stationCode, 'AKL');
  assert.equal(page.context.state.imports.length, 0);
  assert.equal(page.notices.length, 0);
});
test('no selected station never submits an upload', async () => {
  const api = apiHarness(), page = browser(api);
  vm.runInContext('selectedStationId="";', page.context);
  await page.context.createUploadedFlight();
  assert.equal(page.requests.length, 0);
  assert.equal(api.state.writes.length, 0);
});

test('a MEL-only SUPERVISOR still creates in MEL', async () => {
  const api = apiHarness(['MEL']), page = browser(api, 'MEL');
  await page.context.createUploadedFlight();
  assert.equal(page.replies[0].status, 201);
  assert.equal(api.state.committed.find(r => r.table === 'Flights').StationId, '1');
});
test('legacy MEL route also fails for an AKL-only actor before any write', async () => {
  const api = apiHarness(['AKL']), body = payload('MEL');
  delete body.stationCode;
  const response = await api.call(body);
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'FLIGHT_ROUTE_STATION_MISMATCH');
  assertNoWrites(api);
});
