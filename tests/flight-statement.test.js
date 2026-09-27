'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { sqlHarness, loadHandler, call } = require('./helpers/operational-harness');
const { canonicalJson, sha256, amendmentEnvelope } = require('../api/shared/completion-amendments');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function baseCompletion(overrides = {}) {
  const snapshot = overrides.snapshot || { flight: 'CX0998', flightId: '1', ulds: [{ num: 'AKE12345CX' }] };
  const SnapshotJson = overrides.SnapshotJson || JSON.stringify(snapshot);
  return {
    CompletionId: '30', FlightId: '1', VerificationId: 'v1-verification',
    FinalisedAtIso: '2026-09-18T08:13:00.000Z', FinalisedByObjectId: 'operator-1',
    FinalisedByDisplayName: 'Finaliser', SnapshotJson, RecordHash: sha256(SnapshotJson), ...overrides
  };
}

function amendment(previousHash, versionNumber, status, overrides = {}) {
  const snapshot = {
    flight: 'CX0998', flightId: '1', ulds: [{ num: 'AKE12345CX' }],
    offloads: { capturedAtUtc: `2026-09-18T08:1${versionNumber}:00.000Z`, source: 'dbo.Offloads', records: [{
      offloadId: '17', flightId: '1', uldId: '7', uldNumber: 'AKE90999CX', parkingBay: 'F25', status,
      requestedAtUtc: '2026-09-18T08:14:00.000Z', requestedByDisplayName: 'Planner',
      collectedAtUtc: versionNumber >= 3 ? '2026-09-18T08:14:30.000Z' : null,
      collectedByDisplayName: versionNumber >= 3 ? 'Runner One' : null,
      deliveredAtUtc: versionNumber >= 4 ? '2026-09-18T08:15:00.000Z' : null,
      deliveredByDisplayName: versionNumber >= 4 ? 'Runner Two' : null,
      deliveredLocation: versionNumber >= 4 ? 'Cool Room 4' : null,
      requestInstruction: 'Keep chilled', completionNote: versionNumber >= 4 ? 'Delivered intact' : null
    }] }
  };
  const action = ({ REQUESTED: 'OFFLOAD_REQUESTED', TRANSIT: 'OFFLOAD_TRANSIT', COMPLETE: 'OFFLOAD_COMPLETE' })[status];
  const row = {
    AmendmentId: String(versionNumber - 1), CompletionId: '30', FlightId: '1', VersionNumber: versionNumber,
    PreviousHash: previousHash, VerificationId: `v${versionNumber}-verification`, OperationId: `operation-${versionNumber}`,
    Action: action, PreviousStatus: versionNumber === 2 ? null : versionNumber === 3 ? 'REQUESTED' : 'TRANSIT',
    ResultingStatus: status, Reason: null, RelatedOffloadId: '17', RelatedUldId: '7', ActorProvider: 'aad',
    ActorReference: `operator-${versionNumber}`, ActorDisplayName: `Operator ${versionNumber}`,
    OccurredAtIso: `2026-09-18T08:1${versionNumber}:00.000Z`, SnapshotJson: canonicalJson(snapshot), ...overrides
  };
  row.RecordHash = sha256(canonicalJson(amendmentEnvelope(row, snapshot)));
  return row;
}

function chain() {
  const base = baseCompletion();
  const v2 = amendment(base.RecordHash, 2, 'REQUESTED');
  const v3 = amendment(v2.RecordHash, 3, 'TRANSIT');
  const v4 = amendment(v3.RecordHash, 4, 'COMPLETE');
  return { base, amendments: [v2, v3, v4] };
}

function apiSetup(options = {}) {
  const h = sqlHarness({
    flights: [{ FlightId: '1', FlightNumber: 'CX0998', OperatingDate: '2026-09-18', Direction: 'EXPORT', FlightStatus: 'FINALISED' }],
    ...options
  });
  return { ...h, handler: loadHandler('api/flight-statement/index.js', h.sql) };
}

test('finalised flight with only V1 returns one immutable Flight Statement version', async () => {
  const base = baseCompletion();
  const h = apiSetup({ completions: [base] });
  const before = structuredClone(h.state);
  const response = await call(h.handler, 'GET', null, { flightId: '1' });
  assert.equal(response.status, 200);
  assert.equal(response.body.completionId, '30');
  assert.equal(response.body.latestVersion, 1);
  assert.equal(response.body.selectedVersion.versionNumber, 1);
  assert.deepEqual(response.body.selectedVersion.snapshot, JSON.parse(base.SnapshotJson));
  assert.equal(response.body.selectedVersion.snapshot.offloads, undefined);
  assert.deepEqual(h.state.completions, before.completions);
  assert.equal(h.state.queries.some(entry => /\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(entry.q)), false);
});

test('V2-V4 defaults to latest and exact version selection returns each immutable snapshot', async () => {
  const evidence = chain();
  const h = apiSetup({ completions: [evidence.base], amendments: evidence.amendments });
  const latest = await call(h.handler, 'GET', null, { flightId: '1', completionId: '30' });
  assert.equal(latest.status, 200);
  assert.equal(latest.body.selectedVersion.versionNumber, 4);
  assert.equal(latest.body.selectedVersion.snapshot.offloads.records[0].status, 'COMPLETE');
  assert.deepEqual(latest.body.versions.map(v => v.versionNumber), [1, 2, 3, 4]);
  for (const [version, status] of [[1, undefined], [2, 'REQUESTED'], [3, 'TRANSIT'], [4, 'COMPLETE']]) {
    const response = await call(h.handler, 'GET', null, { flightId: '1', completionId: '30', version: String(version) });
    assert.equal(response.status, 200);
    assert.equal(response.body.selectedVersion.versionNumber, version);
    assert.equal(response.body.selectedVersion.snapshot.offloads?.records[0]?.status, status);
  }
});

test('exact FlightId and CompletionId prevent same-number historical evidence leakage', async () => {
  const first = baseCompletion();
  const second = baseCompletion({ CompletionId: '31', FlightId: '2', snapshot: { flight: 'CX0998', flightId: '2', ulds: [{ num: 'PMC22222CX' }] } });
  const h = apiSetup({
    flights: [
      { FlightId: '1', FlightNumber: 'CX0998', OperatingDate: '2026-09-18', Direction: 'EXPORT', FlightStatus: 'FINALISED' },
      { FlightId: '2', FlightNumber: 'CX0998', OperatingDate: '2026-09-19', Direction: 'EXPORT', FlightStatus: 'FINALISED' }
    ],
    completions: [first, second]
  });
  const exact = await call(h.handler, 'GET', null, { flightId: '1', completionId: '30' });
  assert.equal(exact.status, 200);
  assert.equal(exact.body.flight.operatingDate, '2026-09-18');
  assert.equal(exact.body.selectedVersion.snapshot.ulds[0].num, 'AKE12345CX');
  const mismatch = await call(h.handler, 'GET', null, { flightId: '1', completionId: '31' });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, 'STATEMENT_IDENTITY_MISMATCH');
});

test('missing or broken amendment chain fails closed', async () => {
  const evidence = chain();
  evidence.amendments[1].PreviousHash = '0'.repeat(64);
  const h = apiSetup({ completions: [evidence.base], amendments: evidence.amendments });
  const broken = await call(h.handler, 'GET', null, { flightId: '1' });
  assert.equal(broken.status, 409);
  assert.equal(broken.body.code, 'COMPLETION_EVIDENCE_INVALID');
  const valid = chain();
  const validHarness = apiSetup({ completions: [valid.base], amendments: valid.amendments });
  const missing = await call(validHarness.handler, 'GET', null, { flightId: '1', version: '5' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'STATEMENT_VERSION_NOT_FOUND');
});

function sourceBetween(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source range ${start} -> ${end}`);
  return html.slice(from, to);
}

function frontendHarness() {
  const requests = [];
  const context = vm.createContext({
    state: { offloads: [{ uld: 'LIVE-OFFLOAD-SHOULD-NOT-APPEAR' }], completedOffloads: [] },
    stableOperationalId: value => /^[1-9]\d*$/.test(String(value ?? '')) ? String(value) : '',
    toMs: value => { const parsed = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(parsed) ? parsed : null; },
    esc: value => String(value ?? ''), slug: value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    azureStatusToUi: value => ({ REQUESTED: 'Requested', TRANSIT: 'Transit', COMPLETE: 'Complete' })[String(value).toUpperCase()] || String(value),
    fmtDateTime: value => value ? new Date(value).toISOString() : '—', azureDisplayDate: value => String(value || ''),
    airlineMeta: () => ({ code: 'CX', name: 'Cathay Pacific', color: '#0d557b' }),
    fetch: async (url, options) => { requests.push({ url, options }); throw new Error('not configured'); },
    encodeURIComponent, URL, Blob, Date, console, setTimeout() {}, document: {}, window: { open: () => null },
    showActionLoader() {}, hideActionLoader() {}, modal() {}, modalHead: value => value, toast() {}, closeModal() {}
  });
  vm.runInContext(sourceBetween('function compareFlightSummaryOffloads(', 'function remoteAuditToUi('), context);
  return { context, requests };
}

function statementModel(version = 4) {
  const evidence = chain();
  const snapshots = [JSON.parse(evidence.base.SnapshotJson), ...evidence.amendments.map(row => JSON.parse(row.SnapshotJson))];
  return {
    flight: { flightId: '1', flightNumber: 'CX0998', operatingDate: '2026-09-18', direction: 'EXPORT', flightStatus: 'FINALISED' },
    completionId: '30', latestVersion: 4,
    originalFinalisation: { finalizedAtUtc: evidence.base.FinalisedAtIso, finalizedByDisplayName: 'Finaliser', verificationId: 'v1-verification' },
    versions: [1, 2, 3, 4].map(v => ({ versionNumber: v, amendmentId: v === 1 ? null : String(v - 1), action: v === 1 ? 'ORIGINAL_FINALISATION' : evidence.amendments[v - 2].Action, label: v === 1 ? 'Original finalisation' : ({2:'Offload requested',3:'Offload collected',4:'Offload completed'})[v], occurredAtUtc: v === 1 ? evidence.base.FinalisedAtIso : evidence.amendments[v - 2].OccurredAtIso })),
    selectedVersion: { ...([1, 2, 3, 4].map(v => ({ versionNumber: v, amendmentId: v === 1 ? null : String(v - 1), action: v === 1 ? 'ORIGINAL_FINALISATION' : evidence.amendments[v - 2].Action, label: v === 1 ? 'Original finalisation' : ({2:'Offload requested',3:'Offload collected',4:'Offload completed'})[v], occurredAtUtc: v === 1 ? evidence.base.FinalisedAtIso : evidence.amendments[v - 2].OccurredAtIso })))[version - 1], snapshot: snapshots[version - 1] }
  };
}

function statementOffload(number, overrides = {}) {
  return {
    offloadId: String(number), flightId: '1', uldId: String(100 + number),
    uldNumber: `AKE${String(number).padStart(5, '0')}CX`, parkingBay: `F${number}`,
    status: 'REQUESTED', requestedAtUtc: `2026-09-18T08:${String(number).padStart(2, '0')}:00.000Z`,
    requestedByDisplayName: `Planner ${number}`, collectedAtUtc: null, collectedByDisplayName: null,
    deliveredAtUtc: null, deliveredByDisplayName: null, deliveredLocation: null,
    requestInstruction: null, completionNote: null, ...overrides
  };
}

function statementWithOffloads(records, version = 4) {
  const model = statementModel(version);
  model.selectedVersion.snapshot = {
    ...model.selectedVersion.snapshot,
    offloads: { capturedAtUtc: '2026-09-18T09:00:00.000Z', source: 'dbo.Offloads', records }
  };
  return model;
}

function statementWithVersions(count) {
  const model = statementWithOffloads([statementOffload(1, { status: 'COMPLETE' })]);
  model.latestVersion = count;
  model.versions = Array.from({ length: count }, (_, index) => {
    const versionNumber = index + 1;
    return {
      versionNumber, amendmentId: versionNumber === 1 ? null : String(versionNumber - 1),
      action: versionNumber === 1 ? 'ORIGINAL_FINALISATION' : 'OFFLOAD_COMPLETE',
      label: versionNumber === 1 ? 'Original finalisation' : 'Offload completed',
      relatedUldId: versionNumber === 1 ? null : '101',
      occurredAtUtc: `2026-09-18T${String(7 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`
    };
  });
  model.selectedVersion = { ...model.versions[count - 1], snapshot: model.selectedVersion.snapshot };
  return model;
}

function statementWithFinalEvidence(version = 1) {
  const model = statementModel(version);
  model.selectedVersion.snapshot = {
    ...model.selectedVersion.snapshot,
    exportManifestFinal: {
      status: 'FINAL', finalManifestId: '81', confirmedAtUtc: '2026-09-19T08:51:00.000Z',
      confirmedByObjectId: 'aad-final-operator', confirmedByDisplayName: 'Final Operator', finalUldCount: 4,
      reconciliation: { matchedCount: 3, addedCount: 1, excludedCount: 2 }
    },
    fowTimeline: { source: 'dbo.IncomingMachMessages + dbo.MachFowShipments', events: [
      { eventType: 'FOW_RECEIVED', machMessageId: '101', documentCorId: 'DOC-PRE', occurredAtUtc: '2026-09-19T08:12:00.000Z', messageLocalDateTime: '2026-09-19T18:10:00', uldNumbers: ['PMC73805QR'], ignoredAfterFinal: false },
      { eventType: 'EXPORT_MANIFEST_FINAL_CONFIRMED', finalManifestId: '81', occurredAtUtc: '2026-09-19T08:51:00.000Z', confirmedByDisplayName: 'Final Operator', finalUldCount: 4 },
      { eventType: 'FOW_RECEIVED', machMessageId: '102', documentCorId: 'DOC-POST', occurredAtUtc: '2026-09-19T08:55:00.000Z', uldNumbers: ['PMC77777QR'], ignoredAfterFinal: true, manifestChanged: false, operationalStatusChanged: false }
    ] }
  };
  return model;
}

test('unified renderer keeps V1 original and renders V2-V4 offload state from selected snapshots', () => {
  const h = frontendHarness();
  const v1 = h.context.flightStatementBody(statementModel(1), true);
  assert.match(v1, /CargoRun Export Flight Statement/);
  assert.match(v1, /No offloads recorded in this version\./);
  assert.doesNotMatch(v1, /AKE90999CX|LIVE-OFFLOAD/);
  for (const [version, expected] of [[2, 'Requested'], [3, 'Transit'], [4, 'Complete']]) {
    const rendered = h.context.flightStatementBody(statementModel(version), true);
    assert.match(rendered, /OFFLOADS/);
    assert.match(rendered, /AKE90999CX/);
    assert.match(rendered, new RegExp(expected));
  }
});

test('new immutable statement renders authoritative FINAL metadata and chronological FOW evidence', () => {
  const h = frontendHarness();
  const rendered = h.context.flightStatementBody(statementWithFinalEvidence(), true);
  assert.match(rendered, /FINAL BUILD INFORMATION/);
  assert.match(rendered, /Final Confirmed/);
  assert.match(rendered, /18:51/);
  assert.match(rendered, /Final Operator/);
  assert.match(rendered, /Final ULDs/);
  assert.match(rendered, />4</);
  assert.match(rendered, /FOW TIMELINE/);
  assert.ok(rendered.indexOf('PMC73805QR') < rendered.indexOf('FINAL confirmed'));
  assert.ok(rendered.indexOf('FINAL confirmed') < rendered.indexOf('PMC77777QR'));
  assert.match(rendered, /FOW RECEIVED AFTER FINAL — IGNORED/);
  assert.match(rendered, /DocumentCorID: DOC-POST/);
  assert.doesNotMatch(rendered, /undefined|null/);
});

test('screen, print, and downloaded HTML path use the same selected immutable FINAL and FOW snapshot', () => {
  const h = frontendHarness(), model = statementWithFinalEvidence(4);
  const screen = h.context.flightStatementBody(model, true);
  const printable = h.context.flightStatementHtml(model);
  for (const evidence of ['FINAL BUILD INFORMATION', 'Final Operator', 'PMC73805QR', 'PMC77777QR', 'FOW RECEIVED AFTER FINAL — IGNORED']) {
    assert.match(screen, new RegExp(evidence));
    assert.match(printable, new RegExp(evidence));
  }
});

test('historical snapshot without FINAL or FOW evidence omits both sections cleanly', () => {
  const h = frontendHarness(), rendered = h.context.flightStatementBody(statementModel(1), true);
  assert.doesNotMatch(rendered, /FINAL BUILD INFORMATION|FOW TIMELINE/);
  assert.doesNotMatch(rendered, /undefined|null/);
});

test('compact offload table handles zero and one offload with optional detail', () => {
  const h = frontendHarness();
  const zero = h.context.flightStatementBody(statementWithOffloads([]), true);
  assert.match(zero, /No offloads recorded in this version\./);
  const one = h.context.flightStatementBody(statementWithOffloads([statementOffload(7, {
    requestInstruction: 'Keep chilled', completionNote: 'Delivered intact', deliveredByDisplayName: 'Runner Two'
  })]), true);
  assert.equal((one.match(/class="statement-offload-row"/g) || []).length, 1);
  assert.match(one, /statement-offload-table/);
  assert.match(one, /Keep chilled/);
  assert.match(one, /Delivered intact/);
  assert.match(one, /Offload #7/);
  assert.match(one, /ULD ID 107/);
  assert.doesNotMatch(one, /flight-offload-card/);
});

test('seven mixed-status offloads sort by requested time then OffloadId', () => {
  const h = frontendHarness();
  const records = [
    statementOffload(12, { requestedAtUtc: '2026-09-18T08:02:00Z', status: 'COMPLETE', deliveredAtUtc: '2026-09-18T08:20:00Z' }),
    statementOffload(11, { requestedAtUtc: '2026-09-18T08:01:00Z', status: 'TRANSIT', collectedAtUtc: '2026-09-18T08:10:00Z' }),
    statementOffload(10, { requestedAtUtc: '2026-09-18T08:01:00Z', status: 'REQUESTED' }),
    statementOffload(13), statementOffload(14), statementOffload(15), statementOffload(16)
  ];
  const rendered = h.context.flightStatementBody(statementWithOffloads(records), true);
  assert.equal((rendered.match(/class="statement-offload-row"/g) || []).length, 7);
  assert.ok(rendered.indexOf('AKE00010CX') < rendered.indexOf('AKE00011CX'));
  assert.ok(rendered.indexOf('AKE00011CX') < rendered.indexOf('AKE00012CX'));
  for (const status of ['Requested', 'Transit', 'Complete']) assert.match(rendered, new RegExp(`>${status}<`));
});

test('twenty-plus versions use one selector and a compact vertical history disclosure', () => {
  const h = frontendHarness(), rendered = h.context.flightStatementBody(statementWithVersions(21), true);
  assert.equal((rendered.match(/<option /g) || []).length, 21);
  assert.equal((rendered.match(/class="statement-history-row/g) || []).length, 21);
  assert.match(rendered, /<details class="statement-history-disclosure">/);
  assert.match(rendered, /View version history \(21\)/);
  assert.match(rendered, /changeFlightStatementVersion\('1','30','21'\)/);
});

test('version selector and print use exact FlightId, CompletionId and selected version', async () => {
  const h = frontendHarness(), model = statementModel(3);
  h.context.fetch = async (url, options) => ({ ok: true, status: 200, json: async () => model });
  const loaded = await h.context.loadFlightStatement('1', '30', '3');
  assert.equal(loaded.selectedVersion.versionNumber, 3);
  assert.match(h.context.flightStatementBody(model, true), /changeFlightStatementVersion\('1','30',this\.value\)/);
  const printable = h.context.flightStatementHtml(model);
  assert.match(printable, /Flight Statement/);
  assert.match(printable, /Version V3/);
  assert.match(printable, /AKE90999CX/);
  const v4Print = h.context.flightStatementHtml(statementModel(4));
  assert.match(v4Print, /Version V4 • Amended/);
  assert.match(v4Print, /Original finalisation/);
  assert.match(v4Print, /Latest amendment/);
  const v1Print = h.context.flightStatementHtml(statementModel(1));
  assert.match(v1Print, /Version V1 • Original/);
  assert.doesNotMatch(v1Print, /AKE90999CX|LIVE-OFFLOAD|Amended/);
});

test('printing seven offloads includes every row and compact print notes', () => {
  const h = frontendHarness();
  const records = Array.from({ length: 7 }, (_, index) => statementOffload(index + 1, {
    status: index % 3 === 0 ? 'REQUESTED' : index % 3 === 1 ? 'TRANSIT' : 'COMPLETE',
    requestInstruction: index === 0 ? 'First instruction' : null,
    completionNote: index === 6 ? 'Final completion note' : null
  }));
  const printed = h.context.flightStatementHtml(statementWithOffloads(records));
  for (const row of records) assert.match(printed, new RegExp(row.uldNumber));
  assert.equal((printed.match(/class="statement-offload-row"/g) || []).length, 7);
  assert.match(printed, /statement-print-notes/);
  assert.match(printed, /First instruction/);
  assert.match(printed, /Final completion note/);
  assert.doesNotMatch(printed, /statement-history-list/);
});

test('view and print implementation remains read-only', () => {
  const source = sourceBetween('async function loadFlightStatement(', 'function remoteAuditToUi(');
  assert.match(source, /method:'GET'/);
  assert.doesNotMatch(source, /method:'(?:POST|PATCH|PUT|DELETE)'|\/api\/offloads/);
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'api', 'flight-statement', 'function.json'), 'utf8'));
  assert.deepEqual(config.bindings.find(binding => binding.type === 'httpTrigger').methods, ['get']);
});
