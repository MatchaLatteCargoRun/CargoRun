const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function between(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.notEqual(from, -1, start);
  assert.notEqual(to, -1, end);
  return html.slice(from, to);
}

function line(name) {
  const match = html.match(new RegExp(`function ${name}\\([^\\n]+`));
  assert.ok(match, name);
  return match[0];
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const controls = Object.create(null);
  const requests = [];
  const responses = [];
  const modals = [];
  const toasts = [];
  const events = [];
  const loaders = [];
  let currentModal = null;
  const station = { stationId: '1', stationCode: 'MEL', displayName: 'Melbourne', timeZoneId: 'Australia/Melbourne' };
  const akl = { stationId: '8', stationCode: 'AKL', displayName: 'Auckland', timeZoneId: 'Pacific/Auckland' };
  const imports = [
    { id: 'import-1', azureFlightId: '101', flight: 'CX163', ...station, flightStatus: {} },
    { id: 'shared-import', azureFlightId: '202', flight: 'QF93', ...station, flightStatus: {} }
  ];
  const exports = [
    { id: 'export-1', azureFlightId: '202', flight: 'QF93', flightDate: '05 Apr 2026', operatingDate: '2026-04-05', ...station, flightStatus: {} },
    { id: 'export-2', azureFlightId: '203', flight: 'QF94', flightDate: '05 Apr 2026', operatingDate: '2026-04-05', ...station, flightStatus: {} }
  ];
  const context = {
    Intl, Date, console: { error() {}, warn() {}, log() {} },
    operationalSessionGeneration: 4,
    timingEditorGeneration: 0,
    timingRequestGeneration: 0,
    timingEditorState: null,
    state: { imports, exports },
    document: { getElementById: id => controls[id] || null },
    canUseStationAction: () => true,
    operationalSessionIsCurrent: generation => generation === context.operationalSessionGeneration,
    selectedStation: () => station,
    authorizedStationById: stationId => String(stationId) === '8' ? akl : String(stationId) === '1' ? station : null,
    selectedStationDateKey: () => '2026-04-05',
    flightOperatingDateKey: () => '2026-04-05',
    exportDepartureMs: flight => flight.flightStatus.estimatedDeparture ? Date.parse(flight.flightStatus.estimatedDeparture) : null,
    modalHead: title => `<h2>${title}</h2>`,
    modal: value => {
      currentModal = value;
      modals.push(value);
      for (const id of ['manualInBlockDate', 'manualInBlockTime', 'exportEtdDate', 'exportEtdTime']) {
        const match = value.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`));
        if (match) controls[id] = { value: match[1] };
      }
    },
    closeModal: () => { context.api?.invalidateTimingEditor(); currentModal = null; },
    showActionLoader: () => {},
    hideActionLoader: () => loaders.push('hidden'),
    currentUser: () => ({ name: 'Operator' }),
    save: () => {},
    render: () => {},
    toast: value => toasts.push(value),
    logEvent: (...args) => events.push(args),
    fmtDateTime: value => `DATE:${value}`,
    fmtTime: value => `TIME:${value}`,
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      const next = await Promise.resolve(responses.shift() || { status: 200, body: { ok: true } });
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
    }
  };
  const source = [
    between('function validStationTimeZoneId(', 'function normalizeAuthorizedStations('),
    between('function exactFlightStation(', 'function stationDateKeyForTimeZone('),
    line('validHistoryDateKey'),
    between('function showSetInBlock(', 'function showFlightStatusSettings('),
    between('function showSetExportEtd(', 'function showConfirmBulkMailScan('),
    ';globalThis.api={stationLocalInputParts,stationLocalInput,showSetInBlock,saveManualInBlock,showSetExportEtd,saveExportEtd,timingEditorInputChanged,invalidateTimingEditor,currentTimingEditor};'
  ].join('\n');
  vm.runInNewContext(source, context);
  return { api: context.api, controls, requests, responses, modals, toasts, events, loaders, imports, exports,
    currentModal: () => currentModal, closeModal: context.closeModal,
    switchSession: () => { context.operationalSessionGeneration++; context.api.invalidateTimingEditor(); currentModal = null; } };
}

test('station-local defaults use the explicit IANA zone across the date boundary', () => {
  const { api } = harness();
  assert.deepEqual(
    { ...api.stationLocalInputParts('2026-01-01T11:30:00.000Z', 'Australia/Melbourne') },
    { localDate: '2026-01-01', localTime: '22:30' }
  );
  assert.deepEqual(
    { ...api.stationLocalInputParts('2026-01-01T11:30:00.000Z', 'Pacific/Auckland') },
    { localDate: '2026-01-02', localTime: '00:30' }
  );
});

test('station-local input defaults are independent of the browser process timezone', () => {
  const source = `${between('function validStationTimeZoneId(', 'function normalizeAuthorizedStations(')}\n${line('validHistoryDateKey')}\nprocess.stdout.write(JSON.stringify({mel:stationLocalInputParts('2026-01-01T11:30:00.000Z','Australia/Melbourne'),akl:stationLocalInputParts('2026-01-01T11:30:00.000Z','Pacific/Auckland')}));`;
  const results = ['UTC', 'Australia/Melbourne', 'Pacific/Auckland', 'America/Los_Angeles'].map(TZ => {
    const run = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', env: { ...process.env, TZ } });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  });
  assert.equal(new Set(results).size, 1);
  assert.deepEqual(JSON.parse(results[0]), {
    mel: { localDate: '2026-01-01', localTime: '22:30' },
    akl: { localDate: '2026-01-02', localTime: '00:30' }
  });
});

test('exact AKL Flight ownership drives modal defaults and success display while MEL remains selected', async () => {
  const h = harness();
  Object.assign(h.exports[0], {
    stationId: '8', stationCode: 'AKL', displayName: 'Auckland', timeZoneId: 'Pacific/Auckland',
    flightStatus: { estimatedDeparture: '2026-01-01T11:30:00.000Z' }
  });
  assert.equal(h.api.showSetExportEtd('export-1'), true);
  assert.match(h.modals.at(-1), /Flight station: <strong>AKL<\/strong>/);
  assert.match(h.modals.at(-1), /Pacific\/Auckland/);
  assert.match(h.modals.at(-1), /id="exportEtdDate" type="date" value="2026-01-02"/);
  assert.match(h.modals.at(-1), /id="exportEtdTime" type="time" step="60" value="00:30"/);
  h.controls.exportEtdDate = { value: '2026-01-02' };
  h.controls.exportEtdTime = { value: '00:30' };
  h.responses.push({ status: 200, body: {
    ok: true,
    flight: { EstimatedDepartureUtc: '2026-01-01T11:30:00.000Z' },
    stationTimeResolution: { stationId: '8', stationCode: 'AKL', timeZoneId: 'Pacific/Auckland' }
  } });
  assert.equal(await h.api.saveExportEtd('export-1'), true);
  assert.equal(h.exports[0].timeZoneId, 'Pacific/Auckland');
  assert.match(h.events.at(-1)[2].detail, /02 Jan 2026 00:30 NZDT/);
});

test('ETD sends local date and time without browser-produced UTC', async () => {
  const h = harness();
  assert.equal(h.api.showSetExportEtd('export-1'), true);
  h.controls.exportEtdDate = { value: '2026-10-01' };
  h.controls.exportEtdTime = { value: '18:30' };
  assert.equal(h.api.timingEditorInputChanged('ETD', 'export-1'), true);
  h.responses.push({ status: 200, body: { ok: true, flight: { EstimatedDepartureUtc: '2026-10-01T08:30:00.000Z' }, stationTimeResolution: { stationId: '1', stationCode: 'MEL', timeZoneId: 'Australia/Melbourne' } } });

  assert.equal(await h.api.saveExportEtd('export-1'), true);
  assert.deepEqual(h.requests[0].body, {
    flightId: '202',
    estimatedDepartureLocal: { localDate: '2026-10-01', localTime: '18:30' }
  });
  assert.equal(h.exports[0].flightStatus.estimatedDeparture, '2026-10-01T08:30:00.000Z');
  assert.equal(Object.hasOwn(h.requests[0].body, 'estimatedDepartureUtc'), false);
});

test('ambiguous ETD requires an explicit occurrence and resubmits only the choice', async () => {
  const h = harness();
  assert.equal(h.api.showSetExportEtd('export-1'), true);
  h.controls.exportEtdDate = { value: '2026-04-05' };
  h.controls.exportEtdTime = { value: '02:30' };
  assert.equal(h.api.timingEditorInputChanged('ETD', 'export-1'), true);
  h.responses.push({ status: 409, body: { ok: false, code: 'LOCAL_TIME_AMBIGUOUS', candidates: [
    { disambiguation: 'EARLIER', label: '02:30 AEDT — earlier occurrence' },
    { disambiguation: 'LATER', label: '02:30 AEST — later occurrence' }
  ] } });

  assert.equal(await h.api.saveExportEtd('export-1'), false);
  assert.match(h.modals.at(-1), /02:30 occurs twice|local time occurs twice/i);
  assert.match(h.modals.at(-1), /02:30 AEDT — earlier occurrence/);
  assert.match(h.modals.at(-1), /saveExportEtd\('export-1','LATER',\d+\)/);

  h.responses.push({ status: 200, body: { ok: true, flight: { EstimatedDepartureUtc: '2026-04-04T16:30:00.000Z' }, stationTimeResolution: { stationId: '1', stationCode: 'MEL', timeZoneId: 'Australia/Melbourne' } } });
  assert.equal(await h.api.saveExportEtd('export-1', 'LATER', h.api.currentTimingEditor().editorGeneration), true);
  assert.deepEqual(h.requests[1].body.estimatedDepartureLocal, {
    localDate: '2026-04-05', localTime: '02:30', disambiguation: 'LATER'
  });
  assert.equal(Object.hasOwn(h.requests[1].body.estimatedDepartureLocal, 'instantUtc'), false);
});

test('a mismatched server station-time result fails closed before local state changes', async () => {
  const h = harness();
  assert.equal(h.api.showSetExportEtd('export-1'), true);
  h.controls.exportEtdDate = { value: '2026-10-01' };
  h.controls.exportEtdTime = { value: '18:30' };
  assert.equal(h.api.timingEditorInputChanged('ETD', 'export-1'), true);
  h.responses.push({ status: 200, body: {
    ok: true,
    flight: { EstimatedDepartureUtc: '2026-10-01T05:30:00.000Z' },
    stationTimeResolution: { stationId: '8', stationCode: 'AKL', timeZoneId: 'Pacific/Auckland' }
  } });

  assert.equal(await h.api.saveExportEtd('export-1'), false);
  assert.equal(h.exports[0].flightStatus.estimatedDeparture, undefined);
  assert.equal(h.events.length, 0);
  assert.match(h.toasts.at(-1), /station-time result/);
});

test('nonexistent In Block time stays in the modal and does not mutate the flight', async () => {
  const h = harness();
  assert.equal(h.api.showSetInBlock('import-1', { localDate: '2026-10-04', localTime: '02:30' }), true);
  h.controls.manualInBlockDate = { value: '2026-10-04' };
  h.controls.manualInBlockTime = { value: '02:30' };
  h.responses.push({ status: 409, body: { ok: false, code: 'LOCAL_TIME_NONEXISTENT' } });

  assert.equal(await h.api.saveManualInBlock('import-1'), false);
  assert.deepEqual(h.requests[0].body, {
    flightId: '101',
    inBlockLocal: { localDate: '2026-10-04', localTime: '02:30' }
  });
  assert.match(h.modals.at(-1), /does not exist because the clocks move forward/i);
  assert.equal(h.imports[0].flightStatus.inBlockAt, undefined);
  assert.equal(h.events.length, 0);
});

test('local controls validate before network use and are separate date and time inputs', async () => {
  const h = harness();
  h.api.showSetInBlock('import-1', { localDate: '2026-01-02', localTime: '00:15' });
  assert.match(h.modals.at(-1), /id="manualInBlockDate" type="date"/);
  assert.match(h.modals.at(-1), /id="manualInBlockTime" type="time"/);
  assert.doesNotMatch(h.modals.at(-1), /datetime-local/);
  assert.match(h.modals.at(-1), /verify this exact FlightId on the server and use its stored station timezone/);

  h.controls.manualInBlockDate = { value: '2026-02-30' };
  h.controls.manualInBlockTime = { value: '24:01' };
  assert.equal(await h.api.saveManualInBlock('import-1'), false);
  assert.equal(h.requests.length, 0);
  assert.match(h.modals.at(-1), /Enter a valid local date/);
});

test('delayed Flight A ETD success cannot close or alter the Flight B ETD editor', async () => {
  const h = harness();
  h.api.showSetExportEtd('export-1', { localDate: '2026-10-01', localTime: '18:30' });
  const response = deferred();
  h.responses.push(response.promise);
  const pending = h.api.saveExportEtd('export-1');
  assert.equal(h.requests.length, 1);

  h.api.showSetExportEtd('export-2', { localDate: '2026-10-01', localTime: '19:30' });
  const flightBModal = h.currentModal();
  response.resolve({ status: 200, body: { ok: true, flight: { EstimatedDepartureUtc: '2026-10-01T08:30:00.000Z' }, stationTimeResolution: { stationId: '1', stationCode: 'MEL', timeZoneId: 'Australia/Melbourne' } } });

  assert.equal(await pending, false);
  assert.equal(h.currentModal(), flightBModal);
  assert.match(flightBModal, /QF94/);
  assert.equal(h.exports[0].flightStatus.estimatedDeparture, undefined);
  assert.equal(h.exports[1].flightStatus.estimatedDeparture, undefined);
  assert.equal(h.events.length, 0);
  assert.equal(h.toasts.length, 0);
});

test('delayed Flight A ambiguity cannot replace Flight B or carry fold state across flights', async () => {
  const h = harness();
  h.api.showSetExportEtd('export-1', { localDate: '2026-04-05', localTime: '02:30' });
  const response = deferred();
  h.responses.push(response.promise);
  const pending = h.api.saveExportEtd('export-1');

  h.api.showSetExportEtd('export-2', { localDate: '2026-04-05', localTime: '03:30' });
  const flightBModal = h.currentModal();
  response.resolve({ status: 409, body: { ok: false, code: 'LOCAL_TIME_AMBIGUOUS', candidates: [
    { disambiguation: 'EARLIER', label: 'old earlier' }, { disambiguation: 'LATER', label: 'old later' }
  ] } });

  assert.equal(await pending, false);
  assert.equal(h.currentModal(), flightBModal);
  assert.doesNotMatch(flightBModal, /old earlier|old later|occurs twice/i);
  assert.equal(h.api.currentTimingEditor().flightId, '203');
  assert.equal(h.api.currentTimingEditor().fold, null);
});

test('closing a pending In Block editor prevents its response from reopening UI', async () => {
  const h = harness();
  h.api.showSetInBlock('import-1', { localDate: '2026-10-01', localTime: '18:30' });
  const response = deferred();
  h.responses.push(response.promise);
  const pending = h.api.saveManualInBlock('import-1');
  h.closeModal();
  response.resolve({ status: 409, body: { ok: false, code: 'LOCAL_TIME_AMBIGUOUS', candidates: [] } });

  assert.equal(await pending, false);
  assert.equal(h.currentModal(), null);
  assert.equal(h.api.currentTimingEditor(), null);
  assert.equal(h.events.length, 0);
  assert.equal(h.toasts.length, 0);
});

test('a pending ETD response cannot affect an In Block editor for the same FlightId', async () => {
  const h = harness();
  h.api.showSetExportEtd('export-1', { localDate: '2026-10-01', localTime: '18:30' });
  const response = deferred();
  h.responses.push(response.promise);
  const pending = h.api.saveExportEtd('export-1');

  h.api.showSetInBlock('shared-import', { localDate: '2026-10-01', localTime: '18:45' });
  const inBlockModal = h.currentModal();
  response.resolve({ status: 500, body: { ok: false, error: 'old ETD failure' } });

  assert.equal(await pending, false);
  assert.equal(h.currentModal(), inBlockModal);
  assert.equal(h.api.currentTimingEditor().kind, 'IN_BLOCK');
  assert.equal(h.api.currentTimingEditor().flightId, '202');
  assert.doesNotMatch(inBlockModal, /old ETD failure/);
  assert.equal(h.toasts.length, 0);
});

async function showEtdFold(h) {
  h.api.showSetExportEtd('export-1', { localDate: '2026-04-05', localTime: '02:30' });
  h.responses.push({ status: 409, body: { ok: false, code: 'LOCAL_TIME_AMBIGUOUS', candidates: [
    { disambiguation: 'EARLIER', label: '02:30 earlier' }, { disambiguation: 'LATER', label: '02:30 later' }
  ] } });
  assert.equal(await h.api.saveExportEtd('export-1'), false);
  assert.ok(h.api.currentTimingEditor().fold);
}

test('changing local time clears the bound ambiguity prompt and candidates', async () => {
  const h = harness();
  await showEtdFold(h);
  h.controls.exportEtdTime.value = '03:30';
  assert.equal(h.api.timingEditorInputChanged('ETD', 'export-1'), true);
  assert.equal(h.api.currentTimingEditor().fold, null);
  assert.match(h.currentModal(), /value="03:30"/);
  assert.doesNotMatch(h.currentModal(), /02:30 earlier|02:30 later|occurs twice/i);
});

test('changing local date clears the bound ambiguity prompt and candidates', async () => {
  const h = harness();
  await showEtdFold(h);
  h.controls.exportEtdDate.value = '2026-04-06';
  assert.equal(h.api.timingEditorInputChanged('ETD', 'export-1'), true);
  assert.equal(h.api.currentTimingEditor().fold, null);
  assert.match(h.currentModal(), /value="2026-04-06"/);
  assert.doesNotMatch(h.currentModal(), /02:30 earlier|02:30 later|occurs twice/i);
});

test('opening another Flight clears the prior Flight fold state', async () => {
  const h = harness();
  await showEtdFold(h);
  h.api.showSetExportEtd('export-2', { localDate: '2026-04-05', localTime: '03:30' });
  assert.equal(h.api.currentTimingEditor().flightId, '203');
  assert.equal(h.api.currentTimingEditor().fold, null);
  assert.match(h.currentModal(), /QF94/);
  assert.doesNotMatch(h.currentModal(), /02:30 earlier|02:30 later|occurs twice/i);
});

test('an old fold action cannot submit after the input has been modified', async () => {
  const h = harness();
  await showEtdFold(h);
  const oldEditorGeneration = h.api.currentTimingEditor().editorGeneration;
  const requestCount = h.requests.length;
  h.controls.exportEtdTime.value = '03:30';

  assert.equal(await h.api.saveExportEtd('export-1', 'LATER', oldEditorGeneration), false);
  assert.equal(h.requests.length, requestCount);
  assert.equal(h.api.currentTimingEditor().fold, null);
  assert.match(h.currentModal(), /value="03:30"/);
  assert.doesNotMatch(h.currentModal(), /02:30 earlier|02:30 later|occurs twice/i);
});

test('editing while a request is pending makes its old ambiguity response inert', async () => {
  const h = harness();
  h.api.showSetExportEtd('export-1', { localDate: '2026-04-05', localTime: '02:30' });
  const response = deferred();
  h.responses.push(response.promise);
  const pending = h.api.saveExportEtd('export-1');
  h.controls.exportEtdTime.value = '03:30';
  h.api.timingEditorInputChanged('ETD', 'export-1');
  const editedModal = h.currentModal();
  response.resolve({ status: 409, body: { ok: false, code: 'LOCAL_TIME_AMBIGUOUS', candidates: [
    { disambiguation: 'EARLIER', label: 'stale earlier' }, { disambiguation: 'LATER', label: 'stale later' }
  ] } });

  assert.equal(await pending, false);
  assert.equal(h.currentModal(), editedModal);
  assert.match(editedModal, /value="03:30"/);
  assert.doesNotMatch(editedModal, /stale earlier|stale later|occurs twice/i);
  assert.equal(h.api.currentTimingEditor().fold, null);
});

test('a stale server error cannot replace the current editor or show a toast', async () => {
  const h = harness();
  h.api.showSetExportEtd('export-1', { localDate: '2026-10-01', localTime: '18:30' });
  const response = deferred();
  h.responses.push(response.promise);
  const pending = h.api.saveExportEtd('export-1');
  h.api.showSetExportEtd('export-2', { localDate: '2026-10-01', localTime: '19:30' });
  const current = h.currentModal();
  response.resolve({ status: 500, body: { ok: false, error: 'stale failure' } });

  assert.equal(await pending, false);
  assert.equal(h.currentModal(), current);
  assert.equal(h.toasts.length, 0);
  assert.doesNotMatch(current, /stale failure/);
});

test('a station session switch keeps an old timing response inert', async () => {
  const h = harness();
  h.api.showSetExportEtd('export-1', { localDate: '2026-10-01', localTime: '18:30' });
  const response = deferred();
  h.responses.push(response.promise);
  const pending = h.api.saveExportEtd('export-1');
  h.switchSession();
  response.resolve({ status: 200, body: { ok: true, flight: { EstimatedDepartureUtc: '2026-10-01T08:30:00.000Z' }, stationTimeResolution: { stationId: '1', stationCode: 'MEL', timeZoneId: 'Australia/Melbourne' } } });

  assert.equal(await pending, false);
  assert.equal(h.currentModal(), null);
  assert.equal(h.exports[0].flightStatus.estimatedDeparture, undefined);
  assert.equal(h.events.length, 0);
  assert.equal(h.toasts.length, 0);
});

test('frontend source has no browser timezone conversion in operator time writes', () => {
  const inBlock = between('async function saveManualInBlock(', 'function showFlightStatusSettings(');
  const etd = between('async function saveExportEtd(', 'function showConfirmBulkMailScan(');
  for (const source of [inBlock, etd]) {
    assert.doesNotMatch(source, /getTimezoneOffset|toISOString\(|new Date\(`\$\{date\}|toLocaleString\(/);
  }
  assert.match(inBlock, /inBlockLocal/);
  assert.match(etd, /estimatedDepartureLocal/);
  assert.match(line('modal'), /preserveTimingEditor=false.*invalidateTimingEditor/);
  assert.match(line('closeModal'), /invalidateTimingEditor/);
});
