'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function sourceBetween(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source range ${start} -> ${end}`);
  return html.slice(from, to);
}

function harness() {
  const calls = [];
  const notices = [];
  const elements = {
    confirmUld: { value: '11111' },
    offConfirm: { value: '11111' },
    offLocation: { value: 'Cool Room 4' },
    offCompletionNote: { value: '' }
  };
  const context = vm.createContext({
    state: { imports: [], exports: [], offloads: [], history: [] },
    IMPORT_STATUSES: ['Unarrived', 'Arrived', 'Transit', 'Received'],
    EXPORT_STATUSES: ['Warehouse', 'Transit', 'At Aircraft'],
    document: { getElementById: id => elements[id] || null },
    console: { error() {}, log() {}, warn() {} },
    Date,
    setTimeout,
    clearTimeout,
    toast: message => notices.push(message),
    modal() {}, modalHead: value => value, esc: value => String(value),
    isIdentityVerified: (type, u) => !!u.identityVerified,
    isMachFowExpected: () => false,
    canUseCargoRunApi: () => true,
    currentUser: () => ({ name: 'Tester', employeeId: 'test-id' }),
    uiStatusToAzure: value => String(value).toUpperCase().replaceAll(' ', '_'),
    showActionLoader() {}, hideActionLoader() {}, logEvent() {}, save() {}, closeModal() {}, render() {},
    syncAzureFlights: async () => {}, syncAzureOffloads: async () => {},
    hasMachFow: () => false, fmtDateTime: value => String(value), toMs: value => value,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, occurredAtUtc: 1000 }) };
    }
  });
  vm.runInContext(sourceBetween('function normalizeULD(', 'function firstStatus('), context);
  vm.runInContext(sourceBetween('function showConfirmULD(', 'function findWarehouseDepartureTime('), context);
  vm.runInContext(sourceBetween('function handleOffload(', 'function showScan('), context);
  return { context, calls, notices, elements };
}

function flight(ulds) {
  return { id: 'local-flight', azureFlightId: 50, flight: 'CX178', ulds };
}

test('ULD confirmation follows UldId after reorder and insertion', async () => {
  const h = harness();
  const selected = { azureUldId: 10, num: 'AKE11111CX', status: 'Arrived', identityVerified: true };
  h.context.state.imports = [flight([selected])];
  h.context.showConfirmULD('imports', '50', '10');
  h.context.state.imports[0].ulds = [
    { azureUldId: 11, num: 'AKE11111ZZ', status: 'Arrived', identityVerified: true },
    selected
  ];
  await h.context.advanceULD('imports', '50', '10', 'Arrived', 'Transit', false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.uldId, 10);
  assert.equal(h.context.state.imports[0].ulds[0].status, 'Arrived');
  assert.equal(selected.status, 'Transit');
});

test('missing, stale, and conflicting ULD targets abort without API mutation', async () => {
  const h = harness();
  const selected = { azureUldId: 10, num: 'AKE11111CX', status: 'Arrived', identityVerified: true };
  h.context.state.imports = [flight([selected])];
  h.context.state.imports[0].ulds = [];
  await h.context.advanceULD('imports', '50', '10', 'Arrived', 'Transit', false);
  h.context.state.imports[0].ulds = [{ ...selected, status: 'Transit' }];
  await h.context.advanceULD('imports', '50', '10', 'Arrived', 'Transit', false);
  h.context.state.imports[0].ulds = [{ ...selected }, { ...selected, num: 'AKE-11111-CX' }];
  await h.context.advanceULD('imports', '50', '10', 'Arrived', 'Transit', false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices.filter(x => x === 'ULD changed; review again.').length, 3);
});

test('failed ULD verification never changes identityVerified locally', async () => {
  const h = harness();
  const selected = { azureUldId: 10, num: 'AKE11111CX', status: 'Unarrived', identityVerified: false };
  h.context.state.imports = [flight([selected])];
  let release;
  h.context.fetch = async () => new Promise(resolve => { release = resolve; });
  const pending = h.context.advanceULD('imports', '50', '10', 'Unarrived', 'Arrived', true);
  assert.equal(selected.identityVerified, false);
  release({ ok: false, status: 500, json: async () => ({ error: 'failed' }) });
  await pending;
  assert.equal(selected.identityVerified, false);
  assert.equal(selected.status, 'Unarrived');
});

test('successful ULD verification changes identityVerified only after server success', async () => {
  const h = harness();
  const selected = { azureUldId: 10, num: 'AKE11111CX', status: 'Unarrived', identityVerified: false };
  h.context.state.imports = [flight([selected])];
  let release;
  h.context.fetch = async () => new Promise(resolve => { release = resolve; });
  const pending = h.context.advanceULD('imports', '50', '10', 'Unarrived', 'Arrived', true);
  assert.equal(selected.identityVerified, false);
  release({ ok: true, status: 200, json: async () => ({ ok: true, occurredAtUtc: 1000 }) });
  await pending;
  assert.equal(selected.identityVerified, true);
  assert.equal(selected.status, 'Arrived');
});

test('offload confirmation follows exact OffloadId through insertion and duplicate ULDs', async () => {
  const h = harness();
  const selected = { azureOffloadId: 90, uld: 'AKE11111CX', status: 'Requested', flight: 'CX178', bay: 'F25' };
  h.context.state.offloads = [selected];
  h.context.handleOffload('90');
  h.context.state.offloads.unshift({ azureOffloadId: 91, uld: 'AKE11111CX', status: 'Requested', flight: 'CX178', bay: 'F26' });
  await h.context.confirmOffloadTransit('90', 'Requested');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.offloadId, 90);
});

test('offload completion follows exact OffloadId after reorder', async () => {
  const h = harness();
  const selected = { azureOffloadId: 90, uld: 'AKE11111CX', status: 'Transit', flight: 'CX178', bay: 'F25' };
  h.context.state.offloads = [selected];
  h.context.handleOffload('90');
  h.context.state.offloads.unshift({ azureOffloadId: 91, uld: 'AKE11111CX', status: 'Transit', flight: 'CX178', bay: 'F26' });
  await h.context.completeOffload('90', 'Transit');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.offloadId, 90);
  assert.equal(h.calls[0].body.expectedCurrentStatus, 'TRANSIT');
  assert.equal(h.calls[0].body.nextStatus, 'COMPLETE');
});

test('missing or stale offload aborts without API mutation', async () => {
  const h = harness();
  h.context.state.offloads = [{ azureOffloadId: 90, uld: 'AKE11111CX', status: 'Requested' }];
  h.context.state.offloads = [];
  await h.context.confirmOffloadTransit('90', 'Requested');
  h.context.state.offloads = [{ azureOffloadId: 90, uld: 'AKE11111CX', status: 'Transit' }];
  await h.context.confirmOffloadTransit('90', 'Requested');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.notices, ['Offload changed; review again.', 'Offload changed; review again.']);
});

test('desktop and mobile markup carry stable IDs, and protected workflows stay ID-based', () => {
  assert.doesNotMatch(html, /showConfirmULD\([^\n]*\$\{i\}/);
  assert.doesNotMatch(html, /handleOffload\(\$\{i\}\)/);
  assert.match(html, /showConfirmULD\('\$\{type\}','\$\{f\.azureFlightId\|\|''\}','\$\{u\.azureUldId\|\|''\}'\)/);
  assert.match(html, /handleOffload\('\$\{esc\(id\|\|''\)\}'\)/);
  assert.match(html, /showConfirmBulkMailScan\('\$\{f\.azureFlightId\|\|''\}'.*\$\{u\.azureUldId\|\|''\}/);
  assert.match(html, /fetch\('\/api\/export-completions'.*flightId:f\.azureFlightId/s);
  assert.match(html, /fetch\('\/api\/import-completions'.*flightId:f\.azureFlightId/s);
});
