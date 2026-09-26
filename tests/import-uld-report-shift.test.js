'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function sourceBetween(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source range ${start} -> ${end}`);
  return html.slice(from, to);
}

function reportHarness() {
  const stationState = {
    current: {
      stationId: '1', stationCode: 'MEL', displayName: 'Melbourne',
      timeZoneId: 'Australia/Melbourne'
    }
  };
  const context = vm.createContext({
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]),
    fmtDateTime: value => value ? new Date(value).toISOString() : '—',
    fmtTime: value => value ? new Date(value).toISOString().slice(11, 16) : '—',
    validStationTimeZoneId: value => ['Australia/Melbourne', 'Pacific/Auckland'].includes(value) ? value : null,
    exactFlightStation: value => {
      const stationId = String(value?.stationId || '');
      const stationCode = String(value?.stationCode || '');
      const displayName = String(value?.displayName || '');
      const timeZoneId = ['Australia/Melbourne', 'Pacific/Auckland'].includes(value?.timeZoneId) ? value.timeZoneId : null;
      return /^[1-9]\d*$/.test(stationId) && /^[A-Z]{3}$/.test(stationCode) && displayName && timeZoneId
        ? { stationId, stationCode, displayName, timeZoneId }
        : null;
    },
    formatStationDateTime: (value, timeZoneId) => value && timeZoneId ? `${timeZoneId}:${new Date(value).toISOString()}` : 'unavailable',
    formatStationTime: (value, timeZoneId) => value && timeZoneId ? `${timeZoneId}:${new Date(value).toISOString().slice(11, 16)}` : 'unavailable',
    airlineMeta: () => ({ code: 'CX', name: 'Cathay Pacific', color: '#0d557b' }),
    stableOperationalId: value => /^[1-9]\d*$/.test(String(value ?? '')) ? String(value) : '',
    toMs: value => value ? Date.parse(value) : null,
    normalizeULD: value => typeof value === 'string' ? value.trim().toUpperCase().replace(/[\s-]/g, '') : '',
    currentUser: () => ({ name: 'Shift Lead' }),
    currentStationCode: () => stationState.current?.stationCode || null,
    selectedStation: () => stationState.current,
    setSelectedStation: station => { stationState.current = station; },
    dateKeyLabel: key => key,
    historyDateKeyLabel: key => key,
    Date
  });
  vm.runInContext(sourceBetween('function validStationTimeZoneId(', 'function normalizeAuthorizedStations('), context);
  vm.runInContext(sourceBetween('function remoteImportCompletionToUi(', 'async function syncAzureImportCompletions('), context);
  vm.runInContext(sourceBetween('function normaliseImportRecord(', 'function downloadCompletedImport('), context);
  vm.runInContext(sourceBetween('function formatTripMinutes(', 'function tripMetricsFromEvents('), context);
  vm.runInContext(sourceBetween('function buildShiftSummary(', 'async function showShiftReport('), context);
  return context;
}

test('Add ULD and ELD use exact FlightId on desktop and mobile Import while Export stays protected', () => {
  const actions = sourceBetween('function desktopFlightActions(', 'function desktopFlightWorkspace(');
  assert.match(actions, /data-import-add-uld/);
  assert.match(actions, /showAddImportUld\('\$\{esc\(f\.azureFlightId\|\|''\)\}'\)/);
  assert.match(actions, /isImport\?`<button class="primary" data-import-add-uld/);
  const addFlow = sourceBetween('function showAddImportUld(', 'function importSummaryForFlight(');
  assert.match(addFlow, /normalizeULD\(/);
  assert.match(addFlow, /fetch\('\/api\/ulds'/);
  assert.match(addFlow, /flightId:stableFlightId/);
  assert.match(addFlow, /isEmptyLoadDevice/);
  const mobile = sourceBetween('function mobileFlightDetail(', 'function operationalOffloadRequestedAt(');
  assert.match(mobile, /data-mobile-add-uld data-flight-id="\$\{esc\(f\.azureFlightId\|\|''\)\}"/);
  assert.match(mobile, /showAddImportUld\('\$\{esc\(f\.azureFlightId\|\|''\)\}',true\)/);
  assert.match(mobile, /\$\{isImport\?`<div class="mobile-add-actions">/);
  assert.doesNotMatch(mobile.slice(mobile.indexOf("const lifecycleActions=isImport?") + 32), /showAddImportUld[^`]*Flight Statement/);
  assert.match(addFlow, /defaultIsEld=false/);
  assert.match(addFlow, /\$\{eld\?'checked':''\}/);
  assert.match(html, /\.shell\{width:min\(1680px,100%\)/);
  assert.match(html, /<div class="ops-page-head"><div><h1>History<\/h1><p>Operational evidence and completed flights/);
});

test('Import report retains added and ELD evidence with authoritative summary counts', () => {
  const h = reportHarness();
  const record = h.normaliseImportRecord({
    flightId: '42', flight: 'CX0163', flightDate: '20 Sep 2026', originAirport: 'HKG', destinationAirport: 'MEL',
    stationId: '1', stationCode: 'MEL', displayName: 'Melbourne', timeZoneId: 'Australia/Melbourne',
    finalizedAt: '2026-09-20T03:00:00Z', finalizedBy: 'Shift Lead', verificationId: 'verify-1',
    ulds: [
      { num: 'AKE12345CX', handlingType: 'INTACT', status: 'Received', priorityTags: ['TEMP'], receivedAt: '2026-09-20T02:00:00Z', receivedBy: 'Runner One' },
      { num: 'AKE99999CX', status: 'Unarrived', priorityTags: [], isOperatorAdded: true, isEmptyLoadDevice: true, operatorAddedAt: '2026-09-20T01:00:00Z', operatorAddedBy: 'Planner', operatorAddNote: 'Extra empty' }
    ]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(record.summary)), { expected: 1, tracked: 2, received: 1, outstanding: 1, intact: 1, breakdown: 0, priorityUlds: 1, operatorAdded: 1, eld: 1 });
  const rendered = h.importReportBody(record);
  for (const token of ['CargoRun Import End-of-Flight Report', 'Expected ULDs', 'Outstanding', 'Operator-added', 'AKE99999CX', 'ADDED', 'ELD', 'Added by Planner', 'Extra empty', 'HKG → MEL']) assert.match(rendered, new RegExp(token));
  assert.doesNotMatch(rendered, /undefined|null|NaN|\[object Object\]|piece count/i);
});

test('Import report uses exact owning station timezone and fails closed without valid metadata', () => {
  const h = reportHarness();
  const mapped = h.remoteImportCompletionToUi({
    id: '91', flightId: '42', flight: 'CX0163', stationId: '2', stationCode: 'akl',
    displayName: 'Auckland', timeZoneId: 'Pacific/Auckland', finalizedAt: '2026-01-01T11:30:00Z',
    ulds: [{ num: 'AKE12345CX', status: 'Received', receivedAt: '2026-01-01T11:00:00Z' }]
  });
  assert.equal(mapped.stationCode, 'AKL');
  assert.equal(mapped.timeZoneId, 'Pacific/Auckland');
  const rendered = h.importReportBody(mapped);
  assert.match(rendered, /Station: AKL/);
  assert.match(rendered, /Auckland/);
  assert.match(rendered, /02 Jan 2026 00:30 NZDT/);
  assert.match(rendered, /02 Jan 2026 00:00 NZDT/);
  assert.doesNotMatch(rendered, /Australia\/Melbourne/);

  const unavailable = h.importReportBody({ ...mapped, timeZoneId: 'Invalid/Zone' });
  assert.match(unavailable, /Station metadata unavailable/);
  assert.match(unavailable, /Timezone unavailable/);
  assert.doesNotMatch(unavailable, /NZDT/);
});

test('Import report zero-added and zero-ELD state stays clean', () => {
  const h = reportHarness();
  const rendered = h.importReportBody({ flightId: '7', flight: 'CX0134', finalizedAt: null, ulds: [] });
  assert.match(rendered, /Operator-added<\/span><strong>0/);
  assert.match(rendered, /ELD<\/span><strong>0/);
  assert.match(rendered, /Timestamp unavailable/);
  assert.doesNotMatch(rendered, /undefined|null|NaN|\[object Object\]/);
});

test('Shift Report uses the required section order and completion evidence metrics', () => {
  const h = reportHarness();
  const completions = [
    { type: 'Import', record: { flightId: '11', flight: 'CX0134', flightDate: '20 Sep 2026', finalizedAt: '2026-09-20T03:00:00Z', summary: { expected: 3, received: 2, outstanding: 1, intact: 2, breakdown: 1, priorityUlds: 1, operatorAdded: 1, eld: 1 }, ulds: [] } },
    { type: 'Export', record: { flightId: '12', flight: 'CX0998', flightDate: '20 Sep 2026', finalizedAt: '2026-09-20T04:00:00Z', ulds: [{ status: 'At Aircraft', priorityTags: ['MAIL'] }, { status: 'Warehouse', priorityTags: [] }] } }
  ];
  Object.assign(h, {
    completionsForDate: () => completions,
    allOperationalOffloads: () => [{ azureOffloadId: '71', flightId: '12', flight: 'CX0998', uld: 'AKE12345CX', bay: 'D20', status: 'Complete', requestedAtKnown: Date.parse('2026-09-20T01:00:00Z'), collectedAt: Date.parse('2026-09-20T01:05:00Z'), completedAt: Date.parse('2026-09-20T01:10:00Z'), deliveredBy: 'Runner One' }]
  });
  const events = [
    { ts: Date.parse('2026-09-20T01:00:00Z'), type: 'Offload', action: 'Offload requested', entityType: 'Offload', entityId: '71', flight: 'CX0998', uld: 'AKE12345CX', user: 'Planner', actorReference: 'planner-1', detail: '' },
    { ts: Date.parse('2026-09-20T01:10:00Z'), type: 'Offload', action: 'Offload completed', entityType: 'Offload', entityId: '71', flight: 'CX0998', uld: 'AKE12345CX', user: 'Runner One', actorReference: 'runner-1', detail: '' },
    { ts: Date.parse('2026-09-20T02:00:00Z'), type: 'ULD', action: 'Priority mail scanned', flight: 'CX0134', uld: 'AKE77777CX', user: 'Runner One', actorReference: 'runner-1', detail: 'MAIL priority' },
    { ts: Date.parse('2026-09-20T02:10:00Z'), type: 'Flight', action: 'Import finalised with exception', flight: 'CX0134', user: 'Shift Lead', actorReference: 'lead-1', detail: '1 ULD short' }
  ];
  const summary = h.buildShiftSummary('2026-09-20', events);
  assert.equal(summary.uldsReceived, 2);
  assert.equal(summary.uldsAtAircraft, 1);
  assert.equal(summary.priorityCount, 2);
  const rendered = h.shiftReportDocument(summary);
  const order = ['>IMPORTS<', '>EXPORTS<', '>OFFLOADS<', '>PRIORITY / EXCEPTIONS<', '>OPERATOR ACTIVITY<'].map(label => rendered.indexOf(label));
  assert.ok(order.every(index => index >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(rendered, /CX0134/);
  assert.match(rendered, /CX0998/);
  assert.match(rendered, /AKE12345CX/);
  assert.match(rendered, /Shift Lead/);
  assert.doesNotMatch(rendered, /undefined|null|NaN|\[object Object\]/);
  const printFlow = sourceBetween('async function printShiftReport(', 'function showCloseFlight(');
  assert.match(printFlow, /shiftReportDocument\(summary\)/);
  assert.match(printFlow, /Print \/ Save PDF/);
  assert.doesNotMatch(sourceBetween('function importSummaryForFlight(', 'function showCloseFlight('), /bulk piece|piece count/i);
});

test('Shift Report refreshes MEL and AKL station headings, dates and generated local times', () => {
  const h = reportHarness();
  const generatedAt = Date.parse('2026-01-01T11:30:00.000Z');
  Object.assign(h, { completionsForDate: () => [], allOperationalOffloads: () => [] });

  h.setSelectedStation({
    stationId: '1', stationCode: 'MEL', displayName: 'Melbourne', timeZoneId: 'Australia/Melbourne'
  });
  const mel = h.buildShiftSummary('2026-01-01', []);
  mel.generatedAt = generatedAt;
  const melReport = h.shiftReportDocument(mel);
  assert.match(melReport, /CargoRun Shift Report/);
  assert.match(melReport, /Station: MEL — Melbourne/);
  assert.match(melReport, /Operating Date: 2026-01-01/);
  assert.match(melReport, /Generated 01 Jan 2026 22:30 AEDT/);
  assert.doesNotMatch(melReport, /CargoRun MEL Shift Report/);

  h.setSelectedStation({
    stationId: '8', stationCode: 'AKL', displayName: 'Auckland', timeZoneId: 'Pacific/Auckland'
  });
  const akl = h.buildShiftSummary('2026-01-02', []);
  akl.generatedAt = generatedAt;
  const aklReport = h.shiftReportDocument(akl);
  assert.match(aklReport, /CargoRun Shift Report/);
  assert.match(aklReport, /Station: AKL — Auckland/);
  assert.match(aklReport, /Operating Date: 2026-01-02/);
  assert.match(aklReport, /Generated 02 Jan 2026 00:30 NZDT/);
  assert.doesNotMatch(aklReport, /MEL|Melbourne|Australia\/Melbourne/);

  assert.match(h.shiftReportDocument(mel), /Station: MEL — Melbourne/);
  assert.equal(mel.timeZoneId, 'Australia/Melbourne');
  assert.equal(akl.timeZoneId, 'Pacific/Auckland');
});

test('Shift Report fails closed on invalid timezone metadata and keeps report text HTML-safe', () => {
  const h = reportHarness();
  Object.assign(h, { completionsForDate: () => [], allOperationalOffloads: () => [] });
  h.setSelectedStation({
    stationId: '8', stationCode: 'AKL',
    displayName: 'Auckland <img src=x onerror=alert(1)>', timeZoneId: 'Invalid/Zone'
  });
  const events = [{
    ts: Date.parse('2026-01-01T11:30:00.000Z'), type: 'Flight', flight: 'CX123',
    action: 'Exception <script>alert(1)</script>', detail: 'exception evidence',
    user: 'Operator <b>unsafe</b>', actorReference: 'operator-1'
  }];
  const summary = h.buildShiftSummary('2026-01-02', events);
  summary.generatedAt = Date.parse('2026-01-01T11:30:00.000Z');
  const rendered = h.shiftReportDocument(summary);

  assert.equal(summary.timeZoneId, '');
  assert.match(rendered, /Timezone unavailable/);
  assert.match(rendered, /Generated —/);
  assert.match(rendered, /Auckland &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(rendered, /Exception &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(rendered, /<img|<script|Australia\/Melbourne|\bUTC\b/);
});

test('Import ULD metadata migration is additive, constrained, and deployment-gated', () => {
  const migration = fs.readFileSync(path.join(root, 'migrations', 'import-uld-metadata.sql'), 'utf8');
  const preflight = fs.readFileSync(path.join(root, 'migrations', 'import-uld-metadata-preflight.sql'), 'utf8');
  const verify = fs.readFileSync(path.join(root, 'migrations', 'import-uld-metadata-verify.sql'), 'utf8');
  for (const column of ['IsEmptyLoadDevice', 'IsOperatorAdded', 'OperatorAddedAtUtc', 'OperatorAddedByReference', 'OperatorAddedByDisplayName', 'OperatorAddNote']) {
    assert.match(migration, new RegExp(column));
    assert.match(preflight, new RegExp(column));
    assert.match(verify, new RegExp(column));
  }
  assert.match(migration, /BEGIN TRANSACTION/);
  assert.match(migration, /sp_getapplock/);
  assert.match(migration, /WITH VALUES/);
  assert.match(migration, /CK_ULDs_OperatorAddedEvidence/);
  assert.match(preflight, /OperatorAddedAtUtc',N'datetime2',7,3,1/);
  assert.match(verify, /OperatorAddedAtUtc',N'datetime2',CONVERT\(smallint,7\)/);
  assert.doesNotMatch(migration, /UPDATE\s+dbo\.ULDs|DELETE\s+FROM\s+dbo\.ULDs/i);
});

test('Export Flight Statement implementation remains separate and Add ULD remains absent from Export UI', () => {
  assert.match(html, /function flightStatementBody\(/);
  assert.match(html, /CargoRun Export Flight Statement/);
  const actions = sourceBetween('function desktopFlightActions(', 'function desktopFlightWorkspace(');
  const exportBranch = actions.slice(actions.indexOf(':`'), actions.lastIndexOf('</div>`'));
  assert.doesNotMatch(exportBranch, /showAddImportUld|data-import-add-uld/);
  assert.match(sourceBetween('function statementFowTimeline(', 'function renderFlightStatement('), /FOW TIMELINE/);
});
