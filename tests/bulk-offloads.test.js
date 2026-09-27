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
  assert.deepEqual(response.body.blockedUlds.map(row => ({
    uldId: row.UldId, status: row.ExistingOffloadStatus, offloadId: row.ExistingOffloadId
  })), [
    { uldId: '7', status: 'REQUESTED', offloadId: '40' },
    { uldId: '8', status: 'TRANSIT', offloadId: '41' },
    { uldId: '9', status: 'COMPLETE', offloadId: '42' },
    { uldId: '10', status: 'COMPLETE', offloadId: '43' }
  ]);
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
    'offFlightId', 'offFlightContext', 'offSelectAll', 'offUldCandidates', 'offBlockedUlds',
    'offRequestMessage', 'offBay', 'offInstruction', 'offSubmit'
  ]) elements[id] = { value: '', disabled: false, innerHTML: '', textContent: '', checked: false, indeterminate: false };
  elements.modal = { classList: { contains: () => true } };
  const requests = [], notices = [], loaders = [];
  const cargoRunAccess = { status: 'provisioned' };
  const operationalSessionGeneration = 1;
  let modalMarkup = '';
  const context = vm.createContext({
    document: { getElementById: id => elements[id] || null },
    modal: markup => { modalMarkup = markup; }, modalHead: () => '', esc: value => String(value ?? ''),
    azureDisplayDate: value => String(value || ''),
    stableOperationalId: value => /^[1-9]\d*$/.test(String(value ?? '').trim()) ? String(value).trim() : '',
    encodeURIComponent,
    selectedStationApiUrl: (path, parameters = {}) => {
      const query = new URLSearchParams({ ...parameters, stationId: '1' });
      return `${path}?${query.toString()}`;
    },
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    toast: message => notices.push(message),
    showActionLoader: (title, detail) => loaders.push({ title, detail }), hideActionLoader() {},
    closeModal() {}, openScreen() {}, syncAzureOffloads: async () => true,
    canUseStationAction: () => true,
    cargoRunAccess,
    operationalSessionGeneration,
    operationalSessionIsCurrent: generation =>
      generation === operationalSessionGeneration && cargoRunAccess.status === 'provisioned'
  });
  const start = html.indexOf('let offloadRequestSession=');
  const end = html.indexOf('function handleOffload(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(html.slice(start, end), context);
  const respond = (index, body, status = 200) => requests[index].resolve({
    ok: status < 400, status, json: async () => body
  });
  return { context, elements, requests, notices, loaders, respond, get modalMarkup() { return modalMarkup; } };
}
async function openRequestUi(h, flights = [{
  flightId: '1', flightNumber: 'CX178', operatingDate: '2026-09-17', flightStatus: 'CLOSED'
}]) {
  const pending = h.context.showRequestOffload();
  h.respond(0, { ok: true, flights });
  await pending;
  h.elements.offFlightId.value = flights[0]?.flightId || '';
}
async function loadCandidates(h, rows, blocked = []) {
  const pending = h.context.loadOffloadUlds();
  h.respond(h.requests.length - 1, {
    ok: true,
    ulds: rows.map(row => ({ ...row, FlightId: h.elements.offFlightId.value })),
    blockedUlds: blocked.map(row => ({ ...row, FlightId: h.elements.offFlightId.value }))
  });
  await pending;
}

test('Request Offload is one multi-select workflow with bounded responsive native checkboxes', async () => {
  const h = frontendHarness();
  await openRequestUi(h);
  assert.match(html, /modalHead\('Request Offload'\)/);
  assert.match(h.modalMarkup, /Select All Eligible/);
  assert.match(h.modalMarkup, /id="offSelectAll" type="checkbox"/);
  assert.doesNotMatch(html, /Offload All Eligible/);
  await loadCandidates(h, ulds(20));
  assert.equal((h.elements.offUldCandidates.innerHTML.match(/type="checkbox"/g) || []).length, 20);
  assert.equal(h.elements.offSubmit.textContent, 'Create Offloads');
  assert.equal(h.elements.offSubmit.disabled, true);
  assert.match(html, /\.bulk-offload-list\{[^}]*max-height:310px[^}]*overflow:auto/);
  assert.match(html, /@media\(max-width:700px\)[\s\S]*\.bulk-offload-list\{grid-template-columns:1fr/);
});

test('Export workspace entry preselects the exact FlightId and loads only its eligible ULDs', async () => {
  const h = frontendHarness();
  const opening = h.context.showRequestOffload('2');
  h.respond(0, { ok: true, flights: [
    { flightId: '1', flightNumber: 'CX178', operatingDate: '2026-09-17', flightStatus: 'ACTIVE' },
    { flightId: '2', flightNumber: 'CX178', operatingDate: '2026-09-18', flightStatus: 'CLOSED' }
  ] });
  while (h.requests.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.elements.offFlightId.value, '2');
  assert.equal(h.requests[1].url, '/api/offloads?eligibleUlds=true&flightId=2');
  h.respond(1, { ok: true, ulds: [{
    FlightId: '2', UldId: '20', UldNumber: 'AKE20000CX', CurrentStatus: 'WAREHOUSE'
  }], blockedUlds: [] });
  await opening;
  assert.match(h.elements.offFlightContext.textContent, /FlightId 2/);
  assert.match(h.elements.offUldCandidates.innerHTML, /AKE20000CX/);
  assert.match(h.elements.offUldCandidates.innerHTML, /ULD ID 20/);
});

test('Select All selects only eligible ULDs, supports indeterminate state, and clears selection', async () => {
  const h = frontendHarness();
  await openRequestUi(h);
  await loadCandidates(h, ulds(7), [{
    UldId: '99', UldNumber: 'AKE99999CX', CurrentStatus: 'WAREHOUSE',
    ReasonCode: 'OFFLOAD_EXISTS', ExistingOffloadId: '21', ExistingOffloadStatus: 'COMPLETE'
  }]);
  assert.match(h.elements.offBlockedUlds.innerHTML, /AKE99999CX/);
  assert.match(h.elements.offBlockedUlds.innerHTML, /COMPLETE \/ Offload #21/);
  assert.doesNotMatch(h.elements.offBlockedUlds.innerHTML, /type="checkbox"/);
  h.context.toggleAllEligible(true);
  assert.equal(h.elements.offSelectAll.checked, true);
  assert.equal(h.elements.offSubmit.textContent, 'Create 7 Offloads');
  h.context.toggleOffloadUld('8', false);
  assert.equal(h.elements.offSelectAll.checked, false);
  assert.equal(h.elements.offSelectAll.indeterminate, true);
  assert.equal(h.elements.offSubmit.textContent, 'Create 6 Offloads');
  h.context.toggleAllEligible(false);
  assert.equal(h.elements.offSelectAll.indeterminate, false);
  assert.equal(h.elements.offSubmit.textContent, 'Create Offloads');
  assert.equal(h.elements.offSubmit.disabled, true);
});

test('one and seven selections use the same atomic bulk request and exact stable IDs', async () => {
  for (const count of [1, 7]) {
    const h = frontendHarness();
    await openRequestUi(h);
    await loadCandidates(h, ulds(count));
    h.context.toggleAllEligible(true);
    h.elements.offBay.value = 'f25';
    h.elements.offInstruction.value = 'Return selected ULDs';
    h.context.updateOffloadSubmit();
    assert.equal(h.elements.offSubmit.textContent, count === 1 ? 'Create 1 Offload' : 'Create 7 Offloads');
    const creating = h.context.createOffloads();
    const sent = JSON.parse(h.requests[2].options.body);
    assert.deepEqual(sent, {
      action: 'BULK_CREATE', flightId: '1',
      uldIds: ulds(count).map(row => String(row.UldId)),
      parkingBay: 'F25', requestInstruction: 'Return selected ULDs'
    });
    assert.deepEqual(h.loaders[0], count === 1
      ? { title: 'Creating Offload\u2026', detail: 'Validating ULD and CX178\u2026' }
      : { title: 'Creating 7 Offloads\u2026', detail: 'Validating ULDs and CX178\u2026' });
    h.respond(2, { ok: true, count }, 201);
    await creating;
    assert.ok(h.notices.includes(`${count} offload${count === 1 ? '' : 's'} created`));
  }
});

test('parking bay and handling instruction are both required', async () => {
  const h = frontendHarness();
  await openRequestUi(h);
  await loadCandidates(h, ulds(1));
  h.context.toggleAllEligible(true);
  h.context.updateOffloadSubmit();
  assert.equal(h.elements.offSubmit.disabled, true);
  h.elements.offBay.value = 'F25';
  h.context.updateOffloadSubmit();
  assert.equal(h.elements.offSubmit.disabled, true);
  h.elements.offInstruction.value = 'Return to terminal';
  h.context.updateOffloadSubmit();
  assert.equal(h.elements.offSubmit.disabled, false);
});

test('flight switching clears selection and ignores a late response from the prior FlightId', async () => {
  const h = frontendHarness();
  await openRequestUi(h, [
    { flightId: '1', flightNumber: 'CX178', operatingDate: '2026-09-17', flightStatus: 'ACTIVE' },
    { flightId: '2', flightNumber: 'CX178', operatingDate: '2026-09-18', flightStatus: 'CLOSED' }
  ]);
  const first = h.context.loadOffloadUlds();
  h.elements.offFlightId.value = '2';
  const second = h.context.loadOffloadUlds();
  assert.equal(h.elements.offSubmit.disabled, true);
  h.respond(2, { ok: true, ulds: [{ ...ulds(1)[0], FlightId: '2', UldId: '20', UldNumber: 'PMC22222CX' }], blockedUlds: [] });
  await second;
  h.context.toggleAllEligible(true);
  h.respond(1, { ok: true, ulds: [{ ...ulds(1)[0], FlightId: '1' }], blockedUlds: [] });
  await first;
  assert.match(h.elements.offUldCandidates.innerHTML, /PMC22222CX/);
  assert.doesNotMatch(h.elements.offUldCandidates.innerHTML, /AKE10000CX/);
  assert.equal(h.elements.offSubmit.textContent, 'Create 1 Offload');
});

test('a stale conflict reports details, creates no UI success, clears selection, and refreshes eligibility', async () => {
  const h = frontendHarness();
  await openRequestUi(h);
  await loadCandidates(h, ulds(2));
  h.context.toggleAllEligible(true);
  h.elements.offBay.value = 'F25';
  h.elements.offInstruction.value = 'Return together';
  h.context.updateOffloadSubmit();
  const creating = h.context.createOffloads();
  h.respond(2, { ok: false, code: 'BULK_OFFLOAD_CONFLICT', failures: [{
    uldId: '8', uldNumber: 'AKE10001CX', code: 'OFFLOAD_EXISTS', existingOffloadId: '55'
  }] }, 409);
  while (h.requests.length < 4) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests[3].url, '/api/offloads?eligibleUlds=true&flightId=1');
  h.respond(3, { ok: true, ulds: [{ ...ulds(1)[0], FlightId: '1' }], blockedUlds: [{
    FlightId: '1', UldId: '8', UldNumber: 'AKE10001CX', ReasonCode: 'OFFLOAD_EXISTS',
    ExistingOffloadId: '55', ExistingOffloadStatus: 'COMPLETE'
  }] });
  await creating;
  assert.match(h.elements.offRequestMessage.textContent, /No offloads were created/);
  assert.match(h.elements.offRequestMessage.textContent, /AKE12346CX.*Offload #55/);
  assert.equal(h.elements.offSubmit.textContent, 'Create Offloads');
  assert.equal(h.elements.offSubmit.disabled, true);
  assert.ok(!h.notices.some(message => /offload(s)? created/.test(message)));
});

test('operational UI keeps Collect and Complete individual and Flight Statement code untouched', () => {
  const source = html.slice(html.indexOf('let offloadRequestSession='), html.indexOf('function showScan('));
  assert.match(source, /action:'BULK_CREATE'/);
  assert.doesNotMatch(html, /Collect All|Complete All/);
  assert.match(source, /confirmOffloadTransit\('\$\{o\.azureOffloadId\}','Requested'\)/);
  assert.match(source, /completeOffload\('\$\{o\.azureOffloadId\}','Transit'\)/);
  assert.match(source, /offloadId:o\.azureOffloadId/);
  assert.doesNotMatch(source, /renderFlightStatement|selectedVersion|CompletionId/);
});
