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

function stableOperationalId(value) {
  const id = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(id) ? id : '';
}

function boardHarness() {
  const state = {
    imports: [
      { id: 'same-local', azureFlightId: 101, flight: 'CX0163', flightDate: '15 Sep 2026', closed: false, flightStatus: { estimatedArrival: 300 }, ulds: [{ status: 'Unarrived', priority: true }] },
      { id: 'same-local', azureFlightId: 102, flight: 'CX0163', flightDate: '14 Sep 2026', closed: false, flightStatus: { inBlockAt: 100 }, ulds: [{ status: 'Received' }] }
    ],
    exports: [
      { id: 'export-201', azureFlightId: 201, flight: 'MH0148', flightDate: '15 Sep 2026', closed: false, flightStatus: { estimatedDeparture: 200 }, ulds: [{ status: 'Warehouse' }] },
      { id: 'export-202', azureFlightId: 202, flight: 'UA0061', flightDate: '15 Sep 2026', closed: false, flightStatus: {}, ulds: [] }
    ],
    offloads: [{ flightId: 201 }],
    completedOffloads: []
  };
  const catalog = new Map([
    ['101', { originAirport: 'HKG', operatingDate: '2026-09-15' }],
    ['102', { originAirport: 'HKG', operatingDate: '2026-09-14' }],
    ['201', { destinationAirport: 'KUL', operatingDate: '2026-09-15' }],
    ['202', { destinationAirport: 'SFO', operatingDate: '2026-09-15' }]
  ]);
  const context = vm.createContext({
    state,
    FLIGHTAWARE_ENABLED: false,
    Number,
    Math,
    String,
    activeFlights: type => state[type].filter(f => !f.closed),
    stableOperationalId,
    selectedStationCode: () => 'MEL',
    catalogFlightById: id => catalog.get(String(id)) || null,
    azureDisplayDate: value => String(value || ''),
    toMs: value => Number(value) || null,
    fmtTime: value => `T${value}`,
    counts: (f, type) => ({ done: f.ulds.filter(u => u.status === (type === 'imports' ? 'Received' : 'At Aircraft')).length, total: f.ulds.length }),
    expectedUldsForFlight: f => f.ulds,
    manifestStateBadge: () => '<manifest-state />',
    flightAcceptanceSummary: () => ({ late: 0, warn: 0 }),
    uldPriorityClass: (_f, u) => u.priority ? 'priority' : 'standard',
    priorityTagsFor: (_f, u) => u.priority ? [{ key: 'MAIL', label: 'MAIL', level: 'priority' }] : [],
    flightPriorityTags: (f, type) => f.ulds.flatMap(u => context.priorityTagsFor(f, u, type)),
    allOperationalOffloads: () => [...state.offloads, ...state.completedOffloads],
    airlineBadge: flight => `<badge>${flight}</badge>`,
    priorityBadges: tags => tags.map(tag => `<chip>${tag.label}</chip>`).join(''),
    esc: value => String(value ?? ''),
    isMobileUI: () => false,
    mobileFlightsHub: () => '<mobile />'
  });
  vm.runInContext(sourceBetween('function flightBoardState(', 'function priorityCargoItems('), context);
  return { context, state };
}

test('Flight Board renders balanced Import and Export columns with exact FlightId navigation', () => {
  const { context } = boardHarness();
  const rendered = context.liveFlightBoard();
  assert.match(rendered, /data-flight-board-column="imports"/);
  assert.match(rendered, /data-flight-board-column="exports"/);
  assert.match(rendered, /data-flight-id="101"[^>]+selectDesktopFlightByStableId\('imports','101'\)/);
  assert.match(rendered, /data-flight-id="102"[^>]+selectDesktopFlightByStableId\('imports','102'\)/);
  assert.match(rendered, /data-flight-id="201"[^>]+selectDesktopFlightByStableId\('exports','201'\)/);
  assert.match(rendered, /CX0163[\s\S]*15 Sep 2026/);
  assert.match(rendered, /CX0163[\s\S]*14 Sep 2026/);
  assert.match(rendered, /HKG → MEL/);
  assert.match(rendered, /MEL → KUL/);
  assert.doesNotMatch(rendered, /undefined|null|NaN/i);
});

test('Flight Board sorts landed imports first and exports by nearest available departure', () => {
  const { context } = boardHarness();
  assert.deepEqual(Array.from(context.flightBoardRows('imports'), row => String(row.f.azureFlightId)), ['102', '101']);
  assert.deepEqual(Array.from(context.flightBoardRows('exports'), row => String(row.f.azureFlightId)), ['201', '202']);
  assert.equal(context.flightBoardTiming(context.state.exports[1], 'exports').value, 'Time unavailable');
});

function supervisorHarness() {
  const imports = [{ id: 'local-11', azureFlightId: 11, flight: 'CX0105', flightDate: '15 Sep 2026', ulds: [{ status: 'Unarrived', priority: true }] }];
  const exports = [{ id: 'local-22', azureFlightId: 22, flight: 'MH0148', flightDate: '15 Sep 2026', ulds: [{ status: 'Warehouse' }] }];
  const activeOffload = { azureOffloadId: 31, flightId: 22, flight: 'MH0148', uld: 'AKE12345CX', bay: 'D20', status: 'Requested', requestedAtKnown: 1 };
  const context = vm.createContext({
    FLIGHTAWARE_ENABLED: false,
    Number,
    Math,
    String,
    Date,
    selectedStation: () => ({
      stationId: '1',
      stationCode: 'MEL',
      displayName: 'Melbourne',
      timeZoneId: 'Australia/Melbourne'
    }),
    selectedStationTimeZone: () => 'Australia/Melbourne',
    selectedStationDateKey: () => '2026-09-15',
    allOperationalOffloads: () => [activeOffload],
    todayDateKey: () => '2026-09-15',
    localDateKey: () => '2026-09-15',
    operationalOffloadRequestedAt: o => o.requestedAtKnown || 0,
    ageMinutes: () => 12,
    supervisorAlerts: () => [{ level: 'red', title: 'CX0105 • AKE99999CX', detail: 'ULD still unarrived', action: "selectDesktopFlightByStableId('imports','11')", age: '12m' }],
    exportSlaSummary: () => ({ rows: [{ f: exports[0], s: { level: 'red', label: 'HIGH PRIORITY', detail: 'Aircraft SLA overdue', etd: 500 } }] }),
    supervisorMailSummary: () => ({ rows: [{ f: imports[0], u: { num: 'AKE99999CX', azureUldId: 41 }, s: { level: 'amber', label: 'DUE SOON', detail: '30m remaining', scanned: null, deadline: 600, inBlock: 100 } }] }),
    fmtTime: value => `T${value}`,
    stableOperationalId,
    esc: value => String(value ?? ''),
    activeFlights: type => type === 'imports' ? imports : exports,
    counts: (f, type) => ({ done: f.ulds.filter(u => u.status === (type === 'imports' ? 'Received' : 'At Aircraft')).length, total: f.ulds.length }),
    flightBoardPriorityCount: f => f.ulds.filter(u => u.priority).length,
    flightBoardOffloadCount: f => String(f.azureFlightId) === '22' ? 1 : 0,
    flightBoardTiming: (_f, type) => ({ rank: 0, ts: type === 'imports' ? 100 : 200, label: type === 'imports' ? 'ETA' : 'ETD', value: type === 'imports' ? '10:00' : '12:00' }),
    flightBoardFlightMeta: (_f, type) => ({ route: type === 'imports' ? 'HKG → MEL' : 'MEL → KUL', date: '15 Sep 2026' }),
    airlineBadge: flight => `<badge>${flight}</badge>`,
    manifestStateBadge: () => '<manifest-state />',
    priorityCargoItems: () => [{ flightId: '11', flight: 'CX0105', uld: 'AKE99999CX', status: 'Unarrived', tags: [{ label: 'MAIL' }] }],
    compareOperationalOffloads: () => 0,
    recentEvents: () => [{ ts: 700, action: 'ULD received', type: 'ULD', flight: 'CX0105', uld: 'AKE99999CX', user: 'Operator' }],
    eventDescription: event => `${event.flight} • ${event.uld}`,
    priorityBadges: tags => tags.map(tag => `<chip>${tag.label}</chip>`).join(''),
    isMobileUI: () => false,
    mobileSupervisorDashboard: () => '<mobile />'
  });
  vm.runInContext(sourceBetween('function supervisorActiveOffloads(', 'function historyScreen('), context);
  return context;
}

test('Supervisor renders attention first, exact flight links, offload overview and recent activity', () => {
  const context = supervisorHarness();
  const rendered = context.supervisorDashboard();
  const attention = rendered.indexOf('data-supervisor-section="attention"');
  const workload = rendered.indexOf('data-supervisor-section="workload"');
  const offloads = rendered.indexOf('data-supervisor-section="offloads"');
  const priority = rendered.indexOf('data-supervisor-section="priority"');
  const activity = rendered.indexOf('data-supervisor-section="activity"');
  assert.ok(attention >= 0 && attention < workload && workload < offloads && offloads < priority && priority < activity);
  assert.match(rendered, /data-flight-id="11"[^>]+selectDesktopFlightByStableId\('imports','11'\)/);
  assert.match(rendered, /data-flight-id="22"[^>]+selectDesktopFlightByStableId\('exports','22'\)/);
  assert.match(rendered, /showConfirmBulkMailScan\('11','AKE99999CX','41'\)/);
  assert.match(rendered, /data-offload-id="31"/);
  assert.match(rendered, /showOffloadDetails\('31'\)/);
  assert.match(rendered, /ULD received/);
  assert.doesNotMatch(rendered, /undefined|null|NaN/i);
});

test('desktop refresh hides disabled FlightAware controls and preserves operational controls', () => {
  const source = sourceBetween('function supervisorActiveOffloads(', 'function historyScreen(');
  for (const control of ["openScreen('machfow')", 'toggleSupervisorWallboard()', 'showConfirmBulkMailScan']) {
    assert.ok(source.includes(control), `${control} should remain accessible`);
  }
  assert.match(source, /FLIGHTAWARE_ENABLED\?`<button class="secondary" onclick="showFlightStatusSettings\(\)">Arrival Settings<\/button><button class="secondary" onclick="syncAllFlightArrivals\(false\)">Sync Arrivals<\/button>`:''/);
  assert.doesNotMatch(boardHarness().context.flightBoardScreen(), /Arrival Settings|Sync Arrivals/);
  assert.doesNotMatch(supervisorHarness().supervisorDashboard(), /Arrival Settings|Sync Arrivals/);
  assert.match(source, /stableOperationalId\(o\.azureOffloadId\)/);
  assert.match(source, /showOffloadDetails\('\$\{esc\(id\)\}'\)/);
  assert.match(html, /function handleOffload\(offloadId\)\{const o=findOffloadById\(offloadId\)/);
});
