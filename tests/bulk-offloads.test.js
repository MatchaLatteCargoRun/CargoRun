'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { sqlHarness, loadHandler, call } = require('./helpers/operational-harness');
const { sha256, verifyCompletionEvidence } = require('../api/shared/completion-amendments');
const { acquireOffloadFlightLock, offloadFlightLockResource } = require('../api/shared/offload-eligibility');

const flight = (overrides = {}) => ({
  FlightId: '1', FlightNumber: 'CX178', Direction: 'EXPORT',
  FlightStatus: 'ACTIVE', OperatingDate: '2026-09-17',
  CreatedAtUtc: '2026-09-17T00:00:00.000Z', ...overrides
});
const ulds = count => Array.from({ length: count }, (_, index) => ({
  FlightId: '1', UldId: String(index + 7),
  UldNumber: `AKE${String(index + 12345).padStart(5, '0')}CX`,
  CurrentStatus: index % 2 ? 'TRANSIT' : 'AT_AIRCRAFT'
}));
const payload = (uldIds, overrides = {}) => ({
  action: 'BULK_CREATE', flightId: '1', uldIds,
  parkingBay: 'F25', requestInstruction: 'Move to Cool Room 4', ...overrides
});
const baseCompletion = () => {
  const SnapshotJson = '{"flight":"CX178","flightId":"1","ulds":[]}';
  return {
    CompletionId: '30', FlightId: '1', VerificationId: 'v1',
    FinalisedAtIso: '2026-09-17T00:00:00.000Z',
    FinalisedByObjectId: 'finaliser-id', FinalisedByDisplayName: 'Finaliser',
    SnapshotJson, RecordHash: sha256(SnapshotJson)
  };
};
function setup(options = {}) {
  const harness = sqlHarness({ liveSchema: true, flights: [flight()], offloadUlds: ulds(7), ...options });
  return { ...harness, handler: loadHandler('api/offloads/index.js', harness.sql) };
}
function allOffloads(state) {
  return [state.offload, ...state.extraOffloads].filter(Boolean);
}

test('bulk lock uses exact FlightId with transaction ownership and rejects failed acquisition', async () => {
  assert.equal(offloadFlightLockResource(7), 'CargoRun:OffloadFlight:7');
  let query = '', values = {};
  class Request {
    input(name, type, value) { values[name] = value; return this; }
    async query(text) { query = text; return { recordset: [{ LockResult: -1 }] }; }
  }
  const sql = { Request, NVarChar: () => 'nvarchar' };
  await assert.rejects(acquireOffloadFlightLock({}, sql, '7'), /Could not lock offload flight/);
  assert.equal(values.OffloadFlightLockResource, 'CargoRun:OffloadFlight:7');
  assert.match(query, /@LockOwner = 'Transaction'/);
  assert.match(query, /@LockMode = 'Exclusive'/);
});

test('bulk creates one or seven independent REQUESTED rows with unique stable identities and shared fields', async () => {
  for (const count of [1, 7]) {
    const h = setup({ offloadUlds: ulds(count) });
    const ids = ulds(count).map(row => row.UldId);
    const response = await call(h.handler, 'POST', payload(ids));
    assert.equal(response.status, 201);
    assert.equal(response.body.count, count);
    assert.equal(response.body.message, `${count} offload${count === 1 ? '' : 's'} requested`);
    const rows = allOffloads(h.state).sort((a, b) => Number(a.OffloadId) - Number(b.OffloadId));
    assert.equal(rows.length, count);
    assert.equal(new Set(rows.map(row => String(row.OffloadId))).size, count);
    assert.deepEqual(rows.map(row => String(row.FlightId)), Array(count).fill('1'));
    assert.deepEqual(rows.map(row => String(row.UldId)), ids);
    assert.deepEqual(rows.map(row => row.Bay), Array(count).fill('F25'));
    assert.deepEqual(rows.map(row => row.RequestInstruction), Array(count).fill('Move to Cool Room 4'));
    assert.deepEqual(rows.map(row => row.OffloadStatus), Array(count).fill('REQUESTED'));
    assert.equal(h.state.audits.length, count);
    assert.equal(h.state.commits, 1);
    const lockIndex = h.state.queries.findIndex(entry => entry.q.includes('sys.sp_getapplock'));
    const flightIndex = h.state.queries.findIndex(entry => Object.hasOwn(entry.p, 'SelectedFlightId'));
    const insertIndex = h.state.queries.findIndex(entry => entry.q.startsWith('INSERT INTO dbo.Offloads'));
    assert.ok(lockIndex >= 0 && flightIndex > lockIndex && insertIndex > flightIndex);
  }
});

test('bulk creates only explicitly selected UldIds and requires the shared instruction', async () => {
  const h = setup({ offloadUlds: ulds(3) });
  const response = await call(h.handler, 'POST', payload(['7', '9']));
  assert.equal(response.status, 201);
  assert.deepEqual(allOffloads(h.state).map(row => String(row.UldId)).sort(), ['7', '9']);
  const missing = setup({ offloadUlds: ulds(1) });
  const rejected = await call(missing.handler, 'POST', payload(['7'], { requestInstruction: '' }));
  assert.equal(rejected.status, 400);
  assert.equal(missing.state.offload, null);
});

test('shared preview excludes REQUESTED, TRANSIT, COMPLETE, and legacy canonical offload evidence', async () => {
  const rows = ulds(5);
  const h = setup({ offloadUlds: rows, offload: {
    OffloadId: '40', FlightId: '1', UldId: '7', UldNumber: rows[0].UldNumber, OffloadStatus: 'REQUESTED'
  } });
  h.state.extraOffloads.push(
    { OffloadId: '41', FlightId: '1', UldId: '8', UldNumber: rows[1].UldNumber, OffloadStatus: 'TRANSIT' },
    { OffloadId: '42', FlightId: '1', UldId: '9', UldNumber: rows[2].UldNumber, OffloadStatus: 'COMPLETE' },
    { OffloadId: '43', FlightId: '1', UldId: null, UldNumber: rows[3].UldNumber.replace('AKE', 'AKE-'), OffloadStatus: 'COMPLETE' }
  );
  const response = await call(h.handler, 'GET', null, { eligibleUlds: 'true', flightId: '1' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.ulds.map(row => row.UldId), ['11']);
  assert.equal(response.body.flight.flightId, '1');
});

test('stale preview conflict reports the exact ULD and rolls back the entire batch', async () => {
  const rows = ulds(3);
  const h = setup({ offloadUlds: rows });
  const preview = await call(h.handler, 'GET', null, { eligibleUlds: 'true', flightId: '1' });
  assert.equal(preview.body.count, 3);
  h.state.extraOffloads.push({
    OffloadId: '55', FlightId: '1', UldId: '8',
    UldNumber: rows[1].UldNumber, OffloadStatus: 'COMPLETE'
  });
  const before = structuredClone(h.state.extraOffloads);
  const response = await call(h.handler, 'POST', payload(['7', '8', '9']));
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'BULK_OFFLOAD_CONFLICT');
  assert.deepEqual(response.body.failures, [{
    uldId: '8', uldNumber: rows[1].UldNumber,
    code: 'OFFLOAD_EXISTS', existingOffloadId: '55'
  }]);
  assert.equal(h.state.offload, null);
  assert.deepEqual(h.state.extraOffloads, before);
  assert.equal(h.state.audits.length, 0);
  assert.equal(h.state.amendments.length, 0);
});

test('audit and amendment failures leave zero rows, audits, and amendments', async () => {
  const audit = setup({ offloadUlds: ulds(3) });
  audit.state.failAudit = true;
  const auditResponse = await call(audit.handler, 'POST', payload(['7', '8', '9']));
  assert.equal(auditResponse.status, 500);
  assert.equal(allOffloads(audit.state).length, 0);
  assert.equal(audit.state.audits.length, 0);
  assert.equal(audit.state.amendments.length, 0);

  const amendment = setup({
    flights: [flight({ FlightStatus: 'CLOSED' })],
    offloadUlds: ulds(3), completions: [baseCompletion()]
  });
  amendment.state.failAmendment = true;
  const amendmentResponse = await call(amendment.handler, 'POST', payload(['7', '8', '9']));
  assert.equal(amendmentResponse.status, 500);
  assert.equal(allOffloads(amendment.state).length, 0);
  assert.equal(amendment.state.audits.length, 0);
  assert.equal(amendment.state.amendments.length, 0);
});

test('concurrent identical bulk requests serialize to one complete batch without duplicate pairs', async () => {
  const h = setup({ offloadUlds: ulds(4) });
  const request = payload(['7', '8', '9', '10']);
  const responses = await Promise.all([
    call(h.handler, 'POST', request),
    call(h.handler, 'POST', request)
  ]);
  assert.deepEqual(responses.map(item => item.status).sort(), [201, 409]);
  assert.equal(responses.find(item => item.status === 409).body.code, 'BULK_OFFLOAD_CONFLICT');
  const rows = allOffloads(h.state);
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(row => `${row.FlightId}|${row.UldId}`)).size, 4);
  assert.equal(h.state.audits.length, 4);
  assert.equal(h.state.commits, 1);
});

test('single and bulk use the same permanent eligibility decision', async () => {
  const row = ulds(1)[0];
  const existing = {
    OffloadId: '60', FlightId: '1', UldId: null,
    UldNumber: row.UldNumber, OffloadStatus: 'COMPLETE'
  };
  const single = setup({ offloadUlds: [row], offload: existing });
  const singleResponse = await call(single.handler, 'POST', {
    flightId: '1', uldId: '7', uldNumber: row.UldNumber, parkingBay: 'F25'
  });
  assert.equal(singleResponse.body.code, 'OFFLOAD_EXISTS');
  assert.equal(singleResponse.body.offloadId, '60');
  const bulk = setup({ offloadUlds: [row], offload: existing });
  const bulkResponse = await call(bulk.handler, 'POST', payload(['7']));
  assert.equal(bulkResponse.body.code, 'BULK_OFFLOAD_CONFLICT');
  assert.equal(bulkResponse.body.failures[0].code, 'OFFLOAD_EXISTS');
  assert.equal(bulkResponse.body.failures[0].existingOffloadId, '60');
});

test('collection and completion remain individual stable-OffloadId transitions', async () => {
  const h = setup({ offloadUlds: ulds(2) });
  const created = await call(h.handler, 'POST', payload(['7', '8']));
  assert.equal(created.status, 201);
  const selectedId = String(created.body.offloads[1].offloadId);
  const collected = await call(h.handler, 'PATCH', {
    offloadId: selectedId, expectedCurrentStatus: 'REQUESTED', nextStatus: 'TRANSIT'
  });
  assert.equal(collected.status, 200);
  assert.equal(String(h.state.offload.OffloadId), selectedId);
  assert.equal(h.state.offload.OffloadStatus, 'TRANSIT');
  const completed = await call(h.handler, 'PATCH', {
    offloadId: selectedId, expectedCurrentStatus: 'TRANSIT', nextStatus: 'COMPLETE',
    deliveredLocation: 'Cool Room 4', completionNote: 'Delivered'
  });
  assert.equal(completed.status, 200);
  assert.equal(h.state.offload.OffloadStatus, 'COMPLETE');
  assert.equal(h.state.extraOffloads[0].OffloadStatus, 'REQUESTED');
});

test('the same canonical ULD on different exact FlightIds remains independently eligible', async () => {
  const h = setup({
    flights: [flight(), flight({ FlightId: '2', OperatingDate: '2026-09-18' })],
    offloadUlds: [
      { FlightId: '1', UldId: '7', UldNumber: 'AKE12345CX' },
      { FlightId: '2', UldId: '8', UldNumber: 'AKE-12345-CX' }
    ]
  });
  assert.equal((await call(h.handler, 'POST', payload(['7']))).status, 201);
  const second = await call(h.handler, 'POST', payload(['8'], { flightId: '2' }));
  assert.equal(second.status, 201);
  assert.deepEqual(allOffloads(h.state).map(row => `${row.FlightId}|${row.UldId}`).sort(), ['1|7', '2|8']);
});

test('completion-backed bulk uses contiguous immutable versions and the Flight Statement verifies the latest snapshot', async () => {
  const base = baseCompletion();
  const h = setup({
    flights: [flight({ FlightStatus: 'FINALISED' })],
    offloadUlds: ulds(7), completions: [base]
  });
  const beforeV1 = structuredClone(h.state.completions[0]);
  const response = await call(h.handler, 'POST', payload(ulds(7).map(row => row.UldId)));
  assert.equal(response.status, 201);
  assert.deepEqual(h.state.amendments.map(row => row.VersionNumber), [2, 3, 4, 5, 6, 7, 8]);
  const evidence = verifyCompletionEvidence(h.state.completions[0], h.state.amendments, '1');
  assert.equal(evidence.versions.length, 8);
  assert.equal(evidence.versions.at(-1).snapshot.offloads.records.length, 7);
  assert.deepEqual(h.state.completions[0], beforeV1);
  assert.equal(h.state.flights[0].FlightStatus, 'FINALISED');

  const statementHandler = loadHandler('api/flight-statement/index.js', h.sql);
  const statement = await call(statementHandler, 'GET', null, { flightId: '1', completionId: '30' });
  assert.equal(statement.status, 200);
  assert.equal(statement.body.latestVersion, 8);
  assert.equal(statement.body.selectedVersion.snapshot.offloads.records.length, 7);
  assert.deepEqual(
    statement.body.selectedVersion.snapshot.offloads.records.map(row => row.uldId),
    ['7', '8', '9', '10', '11', '12', '13']
  );
});

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
function frontendHarness() {
  const elements = {};
  for (const id of [
    'bulkFlightId', 'bulkFlightContext', 'bulkOffloadCandidates', 'bulkOffloadMessage',
    'bulkOffloadBay', 'bulkOffloadInstruction', 'bulkOffloadSubmit'
  ]) elements[id] = { value: '', disabled: false, innerHTML: '', textContent: '' };
  elements.modal = { classList: { contains: () => true } };
  const requests = [], notices = [];
  const context = vm.createContext({
    document: { getElementById: id => elements[id] || null },
    modal() {}, modalHead: () => '', esc: value => String(value ?? ''),
    azureDisplayDate: value => String(value || ''),
    stableOperationalId: value => /^[1-9]\d*$/.test(String(value ?? '').trim()) ? String(value).trim() : '',
    encodeURIComponent,
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    toast: message => notices.push(message), showActionLoader() {}, hideActionLoader() {},
    closeModal() {}, openScreen() {}, syncAzureOffloads: async () => true
  });
  const start = html.indexOf('let bulkOffloadSession=');
  const end = html.indexOf('function handleOffload(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(html.slice(start, end), context);
  const respond = (index, body, status = 200) => requests[index].resolve({
    ok: status < 400, status, json: async () => body
  });
  return { context, elements, requests, notices, respond };
}
async function openBulkUi(h) {
  const pending = h.context.showBulkOffload();
  h.respond(0, { ok: true, flights: [{
    flightId: '1', flightNumber: 'CX178', operatingDate: '2026-09-17', flightStatus: 'CLOSED'
  }] });
  await pending;
  h.elements.bulkFlightId.value = '1';
}

test('bulk UI preselects eligible ULDs, updates its count, and submits only stable selected IDs', async () => {
  const h = frontendHarness();
  await openBulkUi(h);
  const loading = h.context.loadBulkOffloadUlds();
  assert.equal(h.requests[1].url, '/api/offloads?eligibleUlds=true&flightId=1');
  h.respond(1, { ok: true, ulds: ulds(3).map(row => ({ ...row, FlightId: '1' })) });
  await loading;
  assert.match(h.elements.bulkFlightContext.textContent, /CX178.*2026-09-17.*CLOSED.*FlightId 1/);
  assert.equal((h.elements.bulkOffloadCandidates.innerHTML.match(/type="checkbox"/g) || []).length, 3);
  h.elements.bulkOffloadBay.value = 'f25';
  h.elements.bulkOffloadInstruction.value = 'Move together';
  h.context.updateBulkOffloadSubmit();
  assert.equal(h.elements.bulkOffloadSubmit.textContent, 'Create 3 Offloads');
  h.context.toggleBulkOffloadUld('8', false);
  assert.equal(h.elements.bulkOffloadSubmit.textContent, 'Create 2 Offloads');
  const creating = h.context.createBulkOffloads();
  const sent = JSON.parse(h.requests[2].options.body);
  assert.deepEqual(sent, {
    action: 'BULK_CREATE', flightId: '1', uldIds: ['7', '9'],
    parkingBay: 'F25', requestInstruction: 'Move together'
  });
  h.respond(2, { ok: true, count: 2, message: '2 offloads requested' }, 201);
  await creating;
  assert.ok(h.notices.includes('2 offloads requested'));
});

test('bulk UI shows the exact zero state and stale conflicts refresh all candidates without success', async () => {
  const empty = frontendHarness();
  await openBulkUi(empty);
  const emptyLoad = empty.context.loadBulkOffloadUlds();
  empty.respond(1, { ok: true, ulds: [] });
  await emptyLoad;
  assert.match(empty.elements.bulkOffloadCandidates.innerHTML, /No ULDs on this flight are eligible for a new offload\./);
  assert.equal(empty.elements.bulkOffloadSubmit.disabled, true);

  const h = frontendHarness();
  await openBulkUi(h);
  let loading = h.context.loadBulkOffloadUlds();
  h.respond(1, { ok: true, ulds: ulds(2).map(row => ({ ...row, FlightId: '1' })) });
  await loading;
  h.elements.bulkOffloadBay.value = 'F25';
  h.elements.bulkOffloadInstruction.value = 'Move together';
  h.context.updateBulkOffloadSubmit();
  const creating = h.context.createBulkOffloads();
  h.respond(2, { ok: false, code: 'BULK_OFFLOAD_CONFLICT', failures: [{ uldId: '8', existingOffloadId: '55' }] }, 409);
  while (h.requests.length < 4) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests[3].url, '/api/offloads?eligibleUlds=true&flightId=1');
  h.respond(3, { ok: true, ulds: [{ ...ulds(1)[0], FlightId: '1' }] });
  await creating;
  assert.ok(h.notices.includes('One or more ULDs already have an offload. No new requests were created.'));
  assert.equal(h.elements.bulkOffloadSubmit.textContent, 'Create 1 Offload');
});

test('operational UI offers bulk request only and keeps physical actions individual', () => {
  const source = html.slice(html.indexOf('let bulkOffloadSession='), html.indexOf('function showScan('));
  assert.match(html, /Offload All Eligible/);
  assert.match(source, /action:'BULK_CREATE'/);
  assert.doesNotMatch(html, /Collect All|Complete All/);
  assert.match(source, /uldIds=\[\.\.\.s\.selected\]\.filter/);
  assert.match(html, /confirmOffloadTransit\('\$\{o\.azureOffloadId\}','Requested'\)/);
  assert.match(html, /completeOffload\('\$\{o\.azureOffloadId\}','Transit'\)/);
});
