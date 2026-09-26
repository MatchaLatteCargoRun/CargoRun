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

function uld(azureUldId, num, status = 'Arrived') {
  return { azureUldId, num, status };
}

function flight(id, azureFlightId, number, date, ulds, closed = false) {
  return { id, azureFlightId, flight: number, flightDate: date, ulds, closed };
}

function harness() {
  const notices = [];
  const routes = [];
  const modals = [];
  const focused = [];
  const elements = { scanUld: { value: '' } };
  const state = { imports: [], exports: [], offloads: [] };
  const selectDesktopFlightByStableId = (type, flightId) => {
    const stableId = String(flightId ?? '').trim();
    const selected = (state[type] || []).find(item => String(item.azureFlightId ?? '') === stableId);
    if (!selected) return false;
    routes.push(['flight', type, stableId]);
    return true;
  };
  const context = vm.createContext({
    state,
    document: { getElementById: id => elements[id] || null, querySelector: selector => ({ scrollIntoView() {}, focus() { focused.push(selector); } }) },
    toast: message => notices.push(message),
    closeModal() {},
    openScreen: (...args) => routes.push(args),
    selectDesktopFlightByStableId,
    modal: value => modals.push(value),
    modalHead: value => `<h2>${value}</h2>`,
    esc: value => String(value),
    azureDisplayDate: value => String(value || ''),
    flightOperatingDateKey: value => value.flightDate || '',
    console
  });
  context.activeFlights = type => context.state[type].filter(item => !item.closed);
  vm.runInContext(sourceBetween('function normalizeULD(', 'function firstStatus('), context);
  vm.runInContext(sourceBetween('function doQuickScan(', 'let pendingFlightUpload'), context);
  return { context, state, notices, routes, modals, elements, focused };
}

test('exact full ULD scan selects its one canonical match', () => {
  const h = harness();
  h.state.imports = [flight('local-1', 50, 'CX178', '2026-09-17', [
    uld(10, 'PMC48921R7'),
    uld(11, 'PMC48921CX')
  ])];
  const candidates = h.context.quickScanCandidates(' pmc-48921-r7 ');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].uldId, '10');
  h.elements.scanUld.value = 'PMC48921R7';
  h.context.doQuickScan();
  assert.deepEqual(h.routes, [['flight', 'imports', '50']]);
});

test('serial-only scan selects normally when exactly one item matches', () => {
  const h = harness();
  h.state.exports = [flight('local-2', 60, 'QF11', '2026-09-17', [uld(20, 'AKE12345CX', 'Warehouse')])];
  h.elements.scanUld.value = '12345';
  h.context.doQuickScan();
  assert.deepEqual(h.routes, [['flight', 'exports', '60']]);
  assert.equal(h.modals.length, 0);
});

test('offload scan resolves the selected operation by stable OffloadId', () => {
  const h = harness();
  h.state.offloads = [
    { azureOffloadId: 90, uld: 'AKE12345CX', flight: 'CX178', status: 'Requested' }
  ];
  const candidate = h.context.quickScanCandidates('12345')[0];
  h.state.offloads.unshift({ azureOffloadId: 91, uld: 'AKE99999CX', flight: 'QF11', status: 'Transit' });
  const opened = h.context.selectQuickScanCandidate(candidate.kind, candidate.type, candidate.flightId, candidate.uldId, candidate.offloadId);
  assert.equal(opened, true);
  assert.deepEqual(h.routes, [['offloads']]);
  assert.deepEqual(h.notices, ['Opened offload AKE12345CX']);
  assert.equal(h.context.selectedOffloadId, '90');
  assert.deepEqual(h.focused, ['[data-offload-id="90"]']);
});

test('same offload ULD and flight on different operating dates renders distinguishable choices', () => {
  const h = harness();
  h.state.offloads = [
    { azureOffloadId: 90, flightId: 100, uld: 'AKE12345CX', flight: 'CX178', operatingDate: '2026-09-17', status: 'Requested' },
    { azureOffloadId: 91, flightId: 110, uld: 'AKE12345CX', flight: 'CX178', operatingDate: '2026-09-18', status: 'Requested' }
  ];
  h.elements.scanUld.value = '12345';
  h.context.doQuickScan();
  assert.equal(h.routes.length, 0);
  assert.match(h.modals[0], /CX178.*2026-09-17.*OFFLOAD.*Requested/s);
  assert.match(h.modals[0], /CX178.*2026-09-18.*OFFLOAD.*Requested/s);
});

test('otherwise identical offload choices always display their stable OffloadIds', () => {
  const h = harness();
  h.state.offloads = [
    { azureOffloadId: 90, flightId: 100, uld: 'AKE12345CX', flight: 'CX178', operatingDate: '2026-09-17', status: 'Requested' },
    { azureOffloadId: 91, flightId: 100, uld: 'AKE12345CX', flight: 'CX178', operatingDate: '2026-09-17', status: 'Requested' }
  ];
  h.elements.scanUld.value = '12345';
  h.context.doQuickScan();
  assert.match(h.modals[0], /Offload #90/);
  assert.match(h.modals[0], /Offload #91/);
});

test('legacy offload without operating date displays its unique OffloadId fallback', () => {
  const h = harness();
  h.state.offloads = [
    { azureOffloadId: 90, uld: 'AKE12345CX', flight: 'CX178', status: 'Requested' },
    { azureOffloadId: 91, uld: 'AKE12345CX', flight: 'CX178', status: 'Requested' }
  ];
  h.elements.scanUld.value = '12345';
  h.context.doQuickScan();
  assert.match(h.modals[0], /Offload #90/);
  assert.match(h.modals[0], /Offload #91/);
});

test('selected offload remains tied to OffloadId through polling reorder and fails closed if removed', () => {
  const h = harness();
  h.state.offloads = [
    { azureOffloadId: 90, uld: 'AKE12345CX', flight: 'CX178', status: 'Requested' },
    { azureOffloadId: 91, uld: 'AKE12345CX', flight: 'CX178', status: 'Requested' }
  ];
  assert.equal(h.context.selectQuickScanCandidate('offload', '', '', '', '90'), true);
  h.state.offloads.reverse();
  assert.equal(h.context.focusSelectedOffload(), true);
  assert.equal(h.context.selectedOffloadId, '90');
  h.state.offloads = h.state.offloads.filter(o => o.azureOffloadId !== 90);
  assert.equal(h.context.focusSelectedOffload(), false);
  assert.equal(h.context.selectedOffloadId, '');
  assert.match(h.notices.at(-1), /Selected offload changed/);
});

test('same serial on two flights requires operator selection', () => {
  const h = harness();
  h.state.imports = [flight('local-1', 50, 'CX178', '2026-09-17', [uld(10, 'PMC48921R7')])];
  h.state.exports = [flight('local-2', 60, 'QF11', '2026-09-18', [uld(20, 'PMC48921R7', 'Warehouse')])];
  h.elements.scanUld.value = '48921';
  h.context.doQuickScan();
  assert.equal(h.routes.length, 0);
  assert.equal(h.modals.length, 1);
  assert.match(h.modals[0], /2<\/strong> active items match/);
  assert.match(h.modals[0], /CX178.*2026-09-17.*IMPORT.*Arrived/s);
  assert.match(h.modals[0], /QF11.*2026-09-18.*EXPORT.*Warehouse/s);
});

test('same serial with different owner codes never silently selects', () => {
  const h = harness();
  h.state.imports = [flight('local-1', 50, 'CX178', '2026-09-17', [
    uld(10, 'PMC48921R7'),
    uld(11, 'PMC48921CX')
  ])];
  const candidates = h.context.quickScanCandidates('48921');
  assert.deepEqual(Array.from(candidates, item => item.uld), ['PMC48921R7', 'PMC48921CX']);
  h.elements.scanUld.value = '48921';
  h.context.doQuickScan();
  assert.equal(h.routes.length, 0);
  assert.match(h.modals[0], /PMC48921R7/);
  assert.match(h.modals[0], /PMC48921CX/);
});

test('chosen candidate re-resolves by FlightId and UldId after polling reorder', () => {
  const h = harness();
  const first = flight('local-1', 50, 'CX178', '2026-09-17', [uld(10, 'PMC48921R7')]);
  const selected = flight('local-2', 60, 'QF11', '2026-09-18', [uld(20, 'PMC48921CX', 'Warehouse')]);
  h.state.imports = [first];
  h.state.exports = [selected];
  const candidate = h.context.quickScanCandidates('48921').find(item => item.uldId === '20');
  assert.ok(candidate);

  h.state.imports = [flight('new-local-1', 50, 'CX178', '2026-09-17', [uld(99, 'AKE99999CX'), uld(10, 'PMC48921R7')])];
  h.state.exports = [flight('new-local-2', 60, 'QF11', '2026-09-18', [uld(21, 'AKE00001CX'), uld(20, 'PMC48921CX', 'Warehouse')])];
  const opened = h.context.selectQuickScanCandidate(candidate.kind, candidate.type, candidate.flightId, candidate.uldId, candidate.offloadId);
  assert.equal(opened, true);
  assert.deepEqual(h.routes, [['flight', 'exports', '60']]);
});

test('stale stable IDs fail closed instead of redirecting to a matching serial', () => {
  const h = harness();
  h.state.imports = [flight('local-1', 50, 'CX178', '2026-09-17', [uld(10, 'PMC48921R7')])];
  const candidate = h.context.quickScanCandidates('48921')[0];
  h.state.imports = [flight('replacement', 51, 'CX179', '2026-09-17', [uld(11, 'PMC48921R7')])];
  const opened = h.context.selectQuickScanCandidate(candidate.kind, candidate.type, candidate.flightId, candidate.uldId, candidate.offloadId);
  assert.equal(opened, false);
  assert.equal(h.routes.length, 0);
  assert.deepEqual(h.notices, ['ULD changed; scan again.']);
});

test('zero matches preserves the existing not-found behavior', () => {
  const h = harness();
  h.state.imports = [flight('local-1', 50, 'CX178', '2026-09-17', [uld(10, 'AKE12345CX')])];
  h.elements.scanUld.value = '99999';
  h.context.doQuickScan();
  assert.equal(h.routes.length, 0);
  assert.equal(h.modals.length, 0);
  assert.deepEqual(h.notices, ['No active import, export or offload matched that ULD']);
});

test('duplicate exact full ULD identities also require explicit selection', () => {
  const h = harness();
  h.state.imports = [flight('local-1', 50, 'CX178', '2026-09-17', [uld(10, 'AKE12345CX')])];
  h.state.exports = [flight('local-2', 60, 'QF11', '2026-09-18', [uld(20, 'AKE-12345-CX', 'Warehouse')])];
  h.elements.scanUld.value = 'AKE 12345 CX';
  h.context.doQuickScan();
  assert.equal(h.routes.length, 0);
  assert.match(h.modals[0], /2<\/strong> active items match/);
});

test('offload request UI uses server eligibility and stable multi-select ULD identities', () => {
  assert.match(html, /id="offFlightId"/);
  assert.match(html, /id="offUldCandidates"/);
  assert.doesNotMatch(html, /id="offUld"/);
  assert.match(html, /selectedStationApiUrl\('\/api\/offloads',\{eligibleFlights:true\}\)/);
  assert.match(html, /JSON\.stringify\(\{action:'BULK_CREATE',flightId,uldIds,/);
});
