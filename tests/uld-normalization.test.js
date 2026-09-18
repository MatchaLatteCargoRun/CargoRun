'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeUldNumber } = require('../api/shared/uld');
const flightHelpers = require('../api/shared/flight');
const { insertAuditEvent } = require('../api/shared/audit');
const fixtures = require('./uld-fixtures.json');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Exercise the actual inline functions without booting the app or mocking a DOM.
function frontend() {
  const context = vm.createContext({ state: { history: [] }, azureDateOnly: value => String(value || '').slice(0, 10) });
  const start = html.indexOf('function normalizeULD(');
  const end = html.indexOf('function firstStatus(', start);
  vm.runInContext(html.slice(start, end), context);
  for (const name of ['findWarehouseDepartureTime', 'findAtAircraftTime']) {
    const line = html.split(/\r?\n/).find(x => x.startsWith(`function ${name}(`));
    vm.runInContext(line, context);
  }
  const offloadStart = html.indexOf('function azureOffloadToUi(');
  const offloadEnd = html.indexOf('async function syncAzureOffloads(', offloadStart);
  vm.runInContext(html.slice(offloadStart, offloadEnd), context);
  return context;
}

for (const [input, expected] of fixtures) {
  test(`backend/browser parity and idempotence: ${JSON.stringify(input)}`, () => {
    const browser = frontend();
    assert.equal(normalizeUldNumber(input), expected);
    assert.equal(browser.normalizeULD(input), expected);
    assert.equal(normalizeUldNumber(normalizeUldNumber(input)), expected);
    assert.equal(browser.normalizeULD(browser.normalizeULD(input)), expected);
  });
}

test('undefined rejected; long strings preserved, never truncated by normalizers', () => {
  const browser = frontend();
  assert.equal(normalizeUldNumber(undefined), '');
  assert.equal(browser.normalizeULD(undefined), '');
  const long = 'AKE' + '0'.repeat(100) + '/CX';
  assert.equal(normalizeUldNumber(long), long);
  assert.equal(browser.normalizeULD(long), long);
});

test('active identity prefers IDs and refuses conflicting IDs or empty numbers', () => {
  const browser = frontend();
  assert.equal(browser.sameActiveUld({ azureUldId: 1, num: 'OLD' }, { UldId: '1', UldNumber: 'NEW' }), true);
  assert.equal(browser.sameActiveUld({ azureUldId: 1, num: 'AKE12345CX' }, { UldId: 2, UldNumber: 'AKE-12345-CX' }), false);
  assert.equal(browser.sameActiveUld({ num: 'AKE 12345 CX' }, { UldId: 2, UldNumber: 'AKE12345CX' }), true);
  assert.equal(browser.sameActiveUld({}, {}), false);
  assert.equal(browser.sameUldNumber('AKE/12345/CX', 'AKE12345CX'), false);
  const cached = [{ num: 'AKE12345CX' }, { azureUldId: 7, num: 'AKE-12345-CX' }];
  assert.equal(browser.findActiveUld(cached, { UldId: 7, UldNumber: 'AKE12345CX' }), cached[1]);
  assert.equal(browser.findActiveUld(cached, { num: 'AKE12345CX' }), null);
  assert.equal(browser.findActiveUld([cached[1]], { UldId: 8, UldNumber: 'AKE12345CX' }), null);
});

test('serial convenience remains separate; active timestamps stay within selected flight', () => {
  const browser = frontend();
  assert.equal(browser.matchesULDInput('AKE00123CX', '00123'), true);
  assert.equal(browser.matchesULDInput('AKE00123CX', '123'), false);
  assert.equal(browser.matchesULDInput('AKE12345CX', 'AKE/12345/CX'), false);
  const first = { flight: 'CX0178', ulds: [{ azureUldId: 1, num: 'AKE12345CX', departedWarehouseAt: 10, atAircraftAt: 20 }] };
  const second = { flight: 'CX0178', ulds: [{ azureUldId: 2, num: 'AKE-12345-CX', departedWarehouseAt: 30, atAircraftAt: 40 }] };
  assert.equal(browser.findWarehouseDepartureTime(first, { num: 'ake 12345 cx' }), 10);
  assert.equal(browser.findWarehouseDepartureTime(second, { num: 'ake12345cx' }), 30);
  assert.equal(browser.findAtAircraftTime(second, { azureUldId: 2, num: 'ake12345cx' }), 40);
  assert.equal(browser.findWarehouseDepartureTime(first, { azureUldId: 2, num: 'AKE12345CX' }), null);
});

test('historical timestamp recovery uses canonical comparison without rewriting evidence', () => {
  const browser = frontend();
  const historicalNumber = 'AKE-12345-CX';
  const departure = { flight: 'CX0178', uld: historicalNumber, from: 'Warehouse', to: 'Transit', ts: 1000 };
  const aircraft = { flight: 'CX0178', uld: historicalNumber, from: 'Transit', to: 'At Aircraft', ts: 2000 };
  browser.state.history = [departure, aircraft];
  const active = { azureUldId: 7, num: 'AKE12345CX' };
  const flight = { flight: 'CX0178', ulds: [active] };
  assert.equal(browser.findWarehouseDepartureTime(flight, active), 1000);
  assert.equal(browser.findAtAircraftTime(flight, active), 2000);
  assert.equal(departure.uld, historicalNumber);
  assert.equal(aircraft.uld, historicalNumber);
  assert.equal(departure.ts, 1000);
  assert.equal(aircraft.ts, 2000);
});

test('missing historical movement timestamp remains unknown', () => {
  const browser = frontend();
  browser.state.history = [{ flight: 'CX0178', uld: 'AKE/12345/CX', to: 'At Aircraft', ts: 2000 }];
  const active = { azureUldId: 7, num: 'AKE12345CX' };
  const flight = { flight: 'CX0178', ulds: [active] };
  assert.equal(browser.findWarehouseDepartureTime(flight, active), null);
  assert.equal(browser.findAtAircraftTime(flight, active), null);
});

test('completed offload keeps stored formatting while canonical comparison remains available', () => {
  const browser = frontend();
  Object.assign(browser, {
    azureStatusToUi: () => 'Complete',
    toMs: value => value == null ? null : Number(value)
  });
  const stored = 'AKE-12345-CX';
  const mapped = browser.azureOffloadToUi({ offloadId: 1, uldNumber: stored, status: 'COMPLETE' });
  assert.equal(mapped.uld, stored);
  assert.equal(browser.sameUldNumber(mapped.uld, 'AKE12345CX'), true);
});

test('serial extraction ignores punctuation without changing canonical identity', () => {
  const browser = frontend();
  assert.equal(browser.uldSerial('PMC48921R7'), '48921');
  assert.equal(browser.uldSerial('PMC48921CX'), '48921');
  assert.equal(browser.uldSerial('AKE12345CX'), '12345');
  assert.equal(browser.uldSerial('AKE12/345CX'), '12345');
  assert.equal(browser.uldSerial('AKE/12345/CX'), '12345');
  assert.equal(browser.uldSerial('AKE-12345-CX'), '12345');
  assert.equal(browser.matchesULDInput('PMC48921R7', 'PMC48921R7'), true);
  assert.equal(browser.matchesULDInput('PMC48921R7', '48921'), true);
  assert.equal(browser.matchesULDInput('PMC48921R7', '489217'), false);
  assert.equal(browser.normalizeULD('PMC48921R7'), 'PMC48921R7');
  assert.equal(browser.normalizeULD('AKE/12345/CX'), 'AKE/12345/CX');
  assert.notEqual(browser.normalizeULD('AKE/12345/CX'), browser.normalizeULD('AKE12345CX'));
});

test('Excel parsing canonicalizes identifiers without merging duplicate rows', () => {
  const browser = frontend();
  vm.runInContext(html.slice(html.indexOf('function xlsxSplitShcs('), html.indexOf('async function parseCargoRunWorkbook(')), browser);
  const result = browser.parseCargoRunRows([
    ['Import ULD List (CX0178 17-Sep-2026)'],
    ['ULD NUMBER / BULK'], ['ake 00123-cx'], ['AKE00123CX'], ['AKE/12345/CX']
  ]);
  assert.deepEqual(Array.from(result.ulds, u => u.num), ['AKE00123CX', 'AKE00123CX', 'AKE/12345/CX']);
});

test('upload response links canonical server number to formatted pending ULD', async () => {
  const browser = frontend();
  const pending = { type: 'exports', flight: 'CX0178', flightDate: '2026-09-17', ulds: [{ num: 'ake 00123-cx', shcs: [] }] };
  let payload;
  Object.assign(browser, {
    pendingFlightUpload: pending, state: { exports: [] },
    document: { getElementById: () => null }, cargoRunApiDate: value => value,
    fetch: async (url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, json: async () => ({ flight: { FlightId: 1 }, ulds: [{ UldId: 7, UldNumber: 'AKE00123CX' }] }) };
    },
    handlingCounts: () => ({}), currentUser: () => ({ name: 'Test' }),
    logEvent() {}, save() {}, closeModal() {}, toast() {}, openScreen() {}
  });
  const start = html.indexOf('async function createUploadedFlight(');
  vm.runInContext(html.slice(start, html.indexOf('function render()', start)), browser);
  await browser.createUploadedFlight();
  assert.equal(payload.ulds[0].uldNumber, 'AKE00123CX');
  assert.equal(browser.state.exports[0].ulds[0].azureUldId, 7);
});

// Small SQL stand-in: execute the real HTTP handlers with in-memory query results.
// It verifies transaction/locking use, not SQL Server's lock implementation.
function apiHarness(initialRows = []) {
  const state = { rows: structuredClone(initialRows), messages: [], links: [], audits: [], calls: [], commits: 0, rollbacks: 0 };
  const flights = [1, 2].map(FlightId => ({ FlightId, FlightNumber: 'CX0178', OperatingDate: '2026-09-17', FlightStatus: 'ACTIVE', Direction: 'EXPORT', InclusionReason: 'OPERATING_TODAY' }));
  class Transaction {
    async begin() { this.active = true; this.snapshot = structuredClone({ rows: state.rows, messages: state.messages, links: state.links, audits: state.audits }); }
    async commit() { assert.equal(this.active, true); this.active = false; state.commits++; }
    async rollback() { assert.equal(this.active, true); Object.assign(state, this.snapshot); this.active = false; state.rollbacks++; }
  }
  class Request {
    constructor(tx) { this.tx = tx; this.values = {}; }
    input(name, type, value) { this.values[name] = value; return this; }
    async query(text) {
      const q = text.replace(/\s+/g, ' ').trim(), p = this.values;
      state.calls.push({ q, p: { ...p }, inTransaction: !!this.tx?.active });
      const result = recordset => ({ recordset });
      if (q.includes('sys.sp_getapplock')) return result([{ LockResult: 0 }]);
      if (q.includes('FROM INFORMATION_SCHEMA.COLUMNS')) {
        if (p.AuditTableName === 'AuditEvents') return result(['AuditEventId','EventType','Action','EntityType','EntityId','FlightNumber','UldNumber','FromStatus','ToStatus','OccurredAtUtc','ActorDisplayName','ActorReference','Detail','DetailsJson'].map(COLUMN_NAME => ({ COLUMN_NAME, IS_NULLABLE: 'YES' })));
        return result(['OffloadId', 'FlightId', 'UldId', 'FlightNumber', 'UldNumber', 'ParkingBay', 'Status'].map(COLUMN_NAME => ({ COLUMN_NAME, IS_NULLABLE: 'YES' })));
      }
      if (q.includes('FROM dbo.IncomingMachMessages')) return result(state.messages.filter(x => x.DocumentCorID === p.DocumentCorID));
      if (q.includes('FROM dbo.MachFowShipments')) return result(state.links.filter(x => x.MachMessageId === p.MachMessageId));
      if (q.startsWith('INSERT INTO dbo.IncomingMachMessages')) {
        const row = { ...p, MachMessageId: state.messages.length + 1 }; state.messages.push(row); return result([row]);
      }
      if (q.startsWith('UPDATE dbo.IncomingMachMessages')) {
        Object.assign(state.messages.find(x => x.MachMessageId === p.MachMessageId), { MatchedFlightId: p.FlightId, ProcessingStatus: 'PROCESSED' }); return result([]);
      }
      if (q.includes('FROM dbo.Flights')) {
        if (q.startsWith('SELECT FlightId, FlightNumber FROM dbo.Flights')) return result([]); // Manifest creates a new flight.
        const flightId = p.SelectedFlightId ?? p.FlightId;
        return result(flightId ? flights.filter(x => String(x.FlightId) === String(flightId)) : [flights[0]]);
      }
      if (q.startsWith('INSERT INTO dbo.Flights')) return result([{ ...p, FlightId: 3 }]);
      if (q.startsWith('INSERT INTO dbo.FlightUploads') || q.startsWith('INSERT INTO dbo.UldSpecialHandlingCodes')) return result([]);
      if (q.includes('FROM dbo.ULDs')) {
        assert.ok(this.tx?.active, 'ULD identity lookup must be inside the transaction');
        assert.match(q, /UPDLOCK/); assert.match(q, /HOLDLOCK/);
        return result(state.rows.filter(x => String(x.FlightId) === String(p.FlightId)));
      }
      if (q.startsWith('INSERT INTO dbo.ULDs')) {
        assert.ok(this.tx?.active);
        const row = { ...p, UldId: 100 + state.rows.length, CurrentStatus: p.CurrentStatus || 'WAREHOUSE', IdentityVerified: 0 };
        state.rows.push(row); return result([row]);
      }
      if (q.startsWith('UPDATE dbo.ULDs')) {
        assert.doesNotMatch(q, /SET[\s\S]*(CurrentStatus|IdentityVerified)\s*=/i);
        const row = state.rows.find(x => x.UldId === p.UldId);
        row.SourceType ??= p.SourceType; row.MachDocumentCorId ??= p.MachDocumentCorId; return result([]);
      }
      if (q.startsWith('INSERT INTO dbo.MachFowShipments')) { state.links.push({ ...p }); return result([]); }
      if (q.startsWith('INSERT INTO dbo.AuditEvents')) { const row = { ...p, AuditEventId: state.audits.length + 1 }; state.audits.push(row); return result([row]); }
      if (q.includes('FROM dbo.Offloads WITH')) return result([]);
      if (q.startsWith('INSERT INTO dbo.Offloads')) return result([{ ...p, OffloadId: 1 }]);
      throw new Error('Unexpected SQL in test: ' + q);
    }
  }
  class ConnectionPool { async connect() { return this; } request() { return new Request(); } async close() {} }
  const sql = { ConnectionPool, Transaction, Request, NVarChar: n => n, VarChar: n => n, Decimal: () => 'decimal', BigInt: 'bigint', Int: 'int', Bit: 'bit', Date: 'date', DateTime2: 'datetime', MAX: 'max' };
  async function call(endpoint, body) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'api', endpoint, 'index.js'), 'utf8'), {
      module, exports: module.exports, Buffer, process: { env: { DATABASE_CONNECTION_STRING: 'test-only' } },
      require: name => name === 'mssql'
        ? sql
        : name === '../shared/uld'
          ? { normalizeUldNumber }
          : name === '../shared/flight'
            ? flightHelpers
            : name === '../shared/audit'
              ? { insertAuditEvent }
            : name === '../shared/completion-amendments'
              ? require('../api/shared/completion-amendments')
            : require(name)
    }, { filename: endpoint + '/index.js' });
    const log = Object.assign(() => {}, { error() {}, warn() {} });
    const context = { log };
    const principal = Buffer.from(JSON.stringify({ userRoles: ['authenticated'], userDetails: 'Test user', userId: 'test-user' })).toString('base64');
    await module.exports(context, { method: 'POST', body, headers: { 'x-ms-client-principal': principal } });
    return { status: context.res.status, body: JSON.parse(context.res.body) };
  }
  return { state, call };
}

test('manual creation canonicalizes, scopes by FlightId and rejects legacy duplicates', async () => {
  const legacy = { FlightId: 1, UldId: 7, UldNumber: 'ake\t00123-cx', CurrentStatus: 'TRANSIT', IdentityVerified: 1 };
  const api = apiHarness([legacy]);
  const duplicate = await api.call('ulds', { flightId: 1, uldNumber: 'AKE 00123 CX' });
  assert.equal(duplicate.status, 409); assert.equal(duplicate.body.uldId, 7);
  assert.deepEqual(api.state.rows, [legacy]);
  const created = await api.call('ulds', { flightId: 2, uldNumber: 'ake-00123-cx' });
  assert.equal(created.status, 201); assert.equal(created.body.uld.UldNumber, 'AKE00123CX');
  assert.equal(created.body.uld.CurrentStatus, 'WAREHOUSE');
  assert.equal(api.state.commits, 1);
});

test('manual creation refuses multiple canonical legacy matches without writing', async () => {
  const rows = [{ FlightId: 1, UldId: 7, UldNumber: 'AKE12345CX' }, { FlightId: 1, UldId: 8, UldNumber: 'AKE-12345-CX' }];
  const api = apiHarness(rows);
  const response = await api.call('ulds', { flightId: 1, uldNumber: 'ake 12345 cx' });
  assert.equal(response.status, 409); assert.deepEqual(response.body.conflictingUldIds, [7, 8]);
  assert.deepEqual(api.state.rows, rows); assert.equal(api.state.commits, 0);
});

const manifest = ulds => ({ flight: { flightNumber: 'CX0178', operatingDate: '2026-09-17', direction: 'EXPORT' }, ulds });
test('manifest rejects formatting duplicates and canonicalizes accepted writes', async () => {
  const api = apiHarness();
  assert.equal((await api.call('manifest-upload', manifest([{ uldNumber: 'AKE12345CX' }, { uldNumber: 'ake-12345-cx' }]))).status, 400);
  assert.equal(api.state.rows.length, 0);
  const created = await api.call('manifest-upload', manifest([{ uldNumber: 'ake\u00a000123-cx' }]));
  assert.equal(created.status, 201); assert.equal(created.body.ulds[0].UldNumber, 'AKE00123CX');
});

for (const value of ['', ' - \t\n', null, 12345, {}, ['AKE12345CX'], 'A'.repeat(21)]) {
  test(`write endpoints reject invalid/overlength ULD: ${JSON.stringify(value)}`, async () => {
    const api = apiHarness();
    assert.equal((await api.call('ulds', { flightId: 1, uldNumber: value })).status, 400);
    assert.equal((await api.call('manifest-upload', manifest([{ uldNumber: value }]))).status, 400);
    assert.equal((await api.call('offloads', { uldNumber: value, flightNumber: 'CX0178', parkingBay: 'F25' })).status, 400);
    assert.equal(api.state.calls.some(x => /^(INSERT|UPDATE)/.test(x.q)), false);
  });
}

test('new offloads normalize a selected real ULD without stripping punctuation', async () => {
  const api = apiHarness([{ FlightId: 1, UldId: 7, UldNumber: 'AKE/00123/CX' }]);
  for (let i = 0; i < 1; i++) {
    const response = await api.call('offloads', { uldId:'7', uldNumber: ' ake-/00123/cx ', flightId: 1, flightNumber: 'CX0178', operatingDate: '2026-09-17', parkingBay: 'F25' });
    assert.equal(response.status, 201); assert.equal(response.body.offload.uldNumber, 'AKE/00123/CX');
  }
  assert.equal(api.state.calls.filter(x => x.q.startsWith('INSERT INTO dbo.Offloads')).length, 1);
});

function fow(document, serial = '12 345', awb = '11111111') {
  return `<FSUMessage><DocumentCorID>${document}</DocumentCorID><MessageType>FSU</MessageType><StatusCode>FOW</StatusCode><StsCar>CX</StsCar><StsCarNum>178</StsCarNum><StsDatt>17 SEP 2026</StsDatt><StsApt>MEL</StsApt><StsSegDep>MEL</StsSegDep><StsSegArr>HKG</StsSegArr><DocPrfx>160</DocPrfx><DocNum>${awb}</DocNum><FSUMessageULDList><ULDTyp>ake</ULDTyp><ULDSrl>${serial}</ULDSrl><ULDOwnr>cx</ULDOwnr></FSUMessageULDList></FSUMessage>`;
}

test('FOW reuses legacy ULD, preserves progress/first document and records new AWB linkage', async () => {
  const api = apiHarness([{ FlightId: 1, UldId: 7, UldNumber: 'AKE\t12345-CX', CurrentStatus: 'TRANSIT', IdentityVerified: 1, MachDocumentCorId: 'FIRST' }]);
  const xml = fow('DOC-1');
  const result = await api.call('mach-fow', { xml });
  assert.equal(result.status, 201); assert.equal(result.body.existingUldCount, 1);
  assert.equal(result.body.ulds[0].currentStatus, 'TRANSIT');
  const next = await api.call('mach-fow', { xml: fow('DOC-2', '12-345', '22222222') });
  assert.equal(next.status, 201); assert.equal(api.state.rows.length, 1);
  assert.equal(api.state.rows[0].IdentityVerified, 1); assert.equal(api.state.rows[0].MachDocumentCorId, 'FIRST');
  assert.equal(api.state.rows[0].UldNumber, 'AKE\t12345-CX');
  assert.deepEqual(api.state.links.map(x => x.MawbNumber), ['160-11111111', '160-22222222']);
  assert.equal(api.state.messages[0].RawXml, xml);
  const duplicate = await api.call('mach-fow', { xml });
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicateType, 'DOCUMENT');
  assert.equal(api.state.links.length, 2);
});

test('FOW creates canonical ULD and refuses ambiguous legacy identity', async () => {
  const api = apiHarness();
  const result = await api.call('mach-fow', { xml: fow('NEW', '00-123') });
  assert.equal(result.status, 201); assert.equal(result.body.newUldCount, 1);
  assert.equal(api.state.rows[0].UldNumber, 'AKE00123CX');
  assert.equal(api.state.rows[0].CurrentStatus, 'WAREHOUSE'); assert.equal(api.state.rows[0].IdentityVerified, 0);
  const collision = apiHarness([{ FlightId: 1, UldId: 7, UldNumber: 'AKE12345CX' }, { FlightId: 1, UldId: 8, UldNumber: 'AKE-12345-CX' }]);
  assert.equal((await collision.call('mach-fow', { xml: fow('COLLISION') })).status, 409);
  assert.equal(collision.state.messages.length, 0); assert.equal(collision.state.links.length, 0);
});

test('FOW collapses same-message formatting variants and rejects empty/overlength numbers', async () => {
  const api = apiHarness();
  const extra = '<FSUMessageULDList><ULDTyp>AKE</ULDTyp><ULDSrl>12-345</ULDSrl><ULDOwnr>CX</ULDOwnr></FSUMessageULDList>';
  const response = await api.call('mach-fow', { xml: fow('REPEATED').replace('</FSUMessage>', extra + '</FSUMessage>') });
  assert.equal(response.status, 201); assert.equal(response.body.newUldCount, 1);
  assert.equal(api.state.links.length, 1);
  const empty = fow('EMPTY').replace('<ULDTyp>ake</ULDTyp>', '<ULDTyp>-</ULDTyp>').replace('<ULDSrl>12 345</ULDSrl>', '<ULDSrl>-</ULDSrl>').replace('<ULDOwnr>cx</ULDOwnr>', '<ULDOwnr>-</ULDOwnr>');
  assert.equal((await api.call('mach-fow', { xml: empty })).status, 422);
  assert.equal((await api.call('mach-fow', { xml: fow('LONG', '0'.repeat(31)) })).status, 422);
  assert.equal(api.state.rows.length, 1);
});
