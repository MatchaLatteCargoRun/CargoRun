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

test('unified renderer keeps V1 original and renders V2-V4 offload state from selected snapshots', () => {
  const h = frontendHarness();
  const v1 = h.context.flightStatementBody(statementModel(1), true);
  assert.match(v1, /CargoRun Flight Statement/);
  assert.doesNotMatch(v1, /OFFLOADS|AKE90999CX|LIVE-OFFLOAD/);
  for (const [version, expected] of [[2, 'Requested'], [3, 'Transit'], [4, 'Complete']]) {
    const rendered = h.context.flightStatementBody(statementModel(version), true);
    assert.match(rendered, /OFFLOADS/);
    assert.match(rendered, /AKE90999CX/);
    assert.match(rendered, new RegExp(expected));
  }
});

test('version selector and print use exact FlightId, CompletionId and selected version', async () => {
  const h = frontendHarness(), model = statementModel(3);
  h.context.fetch = async (url, options) => ({ ok: true, status: 200, json: async () => model });
  const loaded = await h.context.loadFlightStatement('1', '30', '3');
  assert.equal(loaded.selectedVersion.versionNumber, 3);
  assert.match(h.context.flightStatementBody(model, true), /changeFlightStatementVersion\('1','30',this\.value\)/);
  const printable = h.context.flightStatementHtml(model);
  assert.match(printable, /Flight Statement/);
  assert.match(printable, /Version 3/);
  assert.match(printable, /AKE90999CX/);
  const v4Print = h.context.flightStatementHtml(statementModel(4));
  assert.match(v4Print, /Version 4 • Amended/);
  assert.match(v4Print, /Original finalisation/);
  assert.match(v4Print, /Latest amendment/);
  const v1Print = h.context.flightStatementHtml(statementModel(1));
  assert.match(v1Print, /Version 1 • Original/);
  assert.doesNotMatch(v1Print, /AKE90999CX|LIVE-OFFLOAD|Amended/);
});

test('view and print implementation remains read-only', () => {
  const source = sourceBetween('async function loadFlightStatement(', 'function remoteAuditToUi(');
  assert.match(source, /method:'GET'/);
  assert.doesNotMatch(source, /method:'(?:POST|PATCH|PUT|DELETE)'|\/api\/offloads/);
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'api', 'flight-statement', 'function.json'), 'utf8'));
  assert.deepEqual(config.bindings.find(binding => binding.type === 'httpTrigger').methods, ['get']);
});
