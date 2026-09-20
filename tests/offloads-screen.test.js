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

function offload(id, status = 'Requested', overrides = {}) {
  return {
    azureOffloadId: String(id), flightId: '25', uldId: String(1000 + id),
    flight: `CX${String(id).padStart(4, '0')}`, operatingDate: '2026-09-19',
    uld: `AKE${String(id).padStart(5, '0')}CX`, bay: `D${id}`, status,
    requestedAtKnown: Date.parse(`2026-09-19T08:${String(id % 60).padStart(2, '0')}:00Z`),
    requestedBy: 'Planner', requestInstruction: '', collectedAt: 0, collectedBy: '',
    completedAt: 0, deliveredBy: '', location: '', completionNote: '', ...overrides
  };
}

function harness() {
  const modals = [];
  const context = vm.createContext({
    state: { offloads: [], completedOffloads: [] },
    Date, console, selectedOffloadId: '',
    toMs: value => value ? new Date(value).getTime() : 0,
    ageMinutes: value => Math.max(0, Math.floor((Date.now() - value) / 60000)),
    stableOperationalId: value => /^\d+$/.test(String(value ?? '').trim()) && String(value).trim() !== '0' ? String(value).trim() : '',
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    slug: value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    azureDisplayDate: value => String(value || ''),
    fmtDateTime: value => value ? new Date(value).toISOString() : '—',
    isMobileUI: () => false,
    render() {}, toast() {}, closeModal() {},
    modal: value => modals.push(value), modalHead: value => `<h2>${value}</h2>`
  });
  vm.runInContext("let offloadQueueFilter='Active';", context);
  vm.runInContext(sourceBetween('function operationalOffloadRequestedAt(', 'function mobilePriorityScreen('), context);
  vm.runInContext(sourceBetween('function offloads()', 'function supervisorDashboard('), context);
  vm.runInContext(sourceBetween('function findOperationalOffloadById(', 'function focusSelectedOffload('), context);
  return { context, modals };
}

test('long operational text is constrained in queue previews and wraps only in detail view', () => {
  const h = harness(), instruction = `Move ${'very-long-unbroken-instruction'.repeat(30)} <secure>`;
  h.context.state.offloads = [offload(1, 'Requested', { requestInstruction: instruction })];
  const queue = h.context.offloads();
  assert.match(queue, /class="offload-preview"/);
  assert.match(queue, /&lt;secure&gt;/);
  assert.match(html, /\.offload-preview\{[^}]*white-space:nowrap;[^}]*overflow:hidden;[^}]*text-overflow:ellipsis/);
  assert.match(html, /\.offload-detail-text\{[^}]*overflow-wrap:anywhere;word-break:break-word/);
  h.context.showOffloadDetails('1');
  assert.match(h.modals[0], /offload-detail-text/);
  assert.match(h.modals[0], /&lt;secure&gt;/);
});

test('active queue renders one, seven, and twenty compact rows without large instruction cards', () => {
  const h = harness();
  for (const count of [1, 7, 20]) {
    h.context.state.offloads = Array.from({ length: count }, (_, i) => offload(i + 1));
    const rendered = h.context.offloads();
    assert.equal((rendered.match(/class="offload-row /g) || []).length, count);
    assert.doesNotMatch(rendered, /offload-instruction/);
  }
});

test('Active, Completed, and All filters use existing statuses and display counts', () => {
  const h = harness();
  h.context.state.offloads = [offload(1, 'Requested'), offload(2, 'Transit')];
  h.context.state.completedOffloads = [offload(3, 'Complete')];
  assert.deepEqual(Array.from(h.context.filteredOperationalOffloads(), o => o.status), ['Requested', 'Transit']);
  assert.match(h.context.offloadFilterControls(), /Active<span>2<\/span>/);
  assert.match(h.context.offloadFilterControls(), /Completed<span>1<\/span>/);
  h.context.setOffloadQueueFilter('Completed');
  assert.deepEqual(Array.from(h.context.filteredOperationalOffloads(), o => o.status), ['Complete']);
  assert.match(h.context.offloads(), /AKE00003CX/);
  assert.doesNotMatch(h.context.offloads(), /AKE00001CX/);
  h.context.setOffloadQueueFilter('All');
  assert.equal(h.context.filteredOperationalOffloads().length, 3);
});

test('operational ordering is requested time ascending with OffloadId as tie-breaker', () => {
  const h = harness(), same = Date.parse('2026-09-19T08:00:00Z');
  h.context.state.offloads = [
    offload(12, 'Requested', { requestedAtKnown: Date.parse('2026-09-19T08:01:00Z') }),
    offload(11, 'Transit', { requestedAtKnown: same }),
    offload(10, 'Requested', { requestedAtKnown: same })
  ];
  assert.deepEqual(Array.from(h.context.filteredOperationalOffloads(), o => o.azureOffloadId), ['10', '11', '12']);
});

test('mobile queue groups by exact FlightId then exposes stable-ID actions in detail', () => {
  const h = harness();
  h.context.state.offloads = [offload(90, 'Requested', { uld: 'AKE90999CX', flight: 'CX0998', bay: 'D20', requestInstruction: 'Collect from cold room' })];
  const list = h.context.mobileOffloads();
  assert.match(list, /mobile-work-group-card mobile-offload-card/);
  assert.match(list, /data-flight-id="25"/);
  assert.match(list, /openScreen\('offloads','detail','flight-25'\)/);
  assert.match(list, /CX0998/);
  const detail = h.context.mobileOffloads('flight-25');
  assert.match(detail, /AKE90999CX/);
  assert.match(detail, /CX0998 • Bay D20/);
  assert.match(detail, />Requested</);
  assert.match(detail, />Collect<\/button>/);
  assert.match(detail, /handleOffload\('90'\)/);
  assert.match(detail, /showOffloadDetails\('90'\)/);
  assert.match(html, /\.mobile-offload-preview\{[^}]*-webkit-line-clamp:2;[^}]*overflow:hidden/);
});

test('detail modal shows optional completion evidence and stable identifiers', () => {
  const h = harness();
  h.context.state.completedOffloads = [offload(7, 'Complete', {
    collectedAt: Date.parse('2026-09-19T08:10:00Z'), collectedBy: 'Runner One',
    completedAt: Date.parse('2026-09-19T08:20:00Z'), deliveredBy: 'Runner Two',
    location: 'Cool Room 4', completionNote: 'Delivered intact'
  })];
  h.context.showOffloadDetails('7');
  assert.match(h.modals[0], /Offload #7/);
  assert.match(h.modals[0], /ULD ID 1007/);
  assert.match(h.modals[0], /Runner One/);
  assert.match(h.modals[0], /Runner Two/);
  assert.match(h.modals[0], /Cool Room 4/);
  assert.match(h.modals[0], /Delivered intact/);
  assert.doesNotMatch(h.modals[0], />Collect<|>Complete<\/button>/);
});

test('operational actions remain stable OffloadId based and Flight Statement stays separate', () => {
  const operational = sourceBetween('function operationalOffloadRequestedAt(', 'function mobilePriorityScreen(') + sourceBetween('function offloads()', 'function supervisorDashboard(');
  const statement = sourceBetween('function compareStatementOffloads(', 'function remoteAuditToUi(');
  assert.match(operational, /handleOffload\('\$\{esc\(id\|\|''\)\}'\)/);
  assert.doesNotMatch(operational, /statementSnapshotOffloads|flightStatementBody|flightStatementHtml/);
  assert.match(statement, /statementSnapshotOffloads/);
  assert.doesNotMatch(statement, /filteredOperationalOffloads|offloadQueueFilter|showOffloadDetails/);
});
