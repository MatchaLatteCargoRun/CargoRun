'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const authorization = require('../api/shared/operational-authorization');

function sourceBetween(startText, endText) {
  const start = html.indexOf(startText);
  const end = html.indexOf(endText, start);
  assert.notEqual(start, -1, `missing ${startText}`);
  assert.notEqual(end, -1, `missing ${endText}`);
  return html.slice(start, end);
}

const stationStateSource = sourceBetween('let cargoRunAccess=', 'function deferOperational(');
const sessionSource = sourceBetween('async function loadCargoRunSession()', 'function hasCargoRunCapability(');
const switchSource = sourceBetween('async function switchCargoRunStation(', 'function refreshHistoryOnEntry(');
const urlSource = sourceBetween('function selectedStationApiUrl(', 'function apiField(');
const bootSource = sourceBetween('async function bootCargoRun()', 'bootCargoRun();');
const openScreenSource = sourceBetween('function openScreen(', 'function activeFlights(');
const mobileHomeSource = sourceBetween('function mobileHome()', 'function mobileFlightsHub()');

const MEL = {
  stationId: '1', stationCode: 'MEL', displayName: 'Melbourne',
  timeZoneId: 'Australia/Melbourne', capabilities: ['MOVE_ULD', 'VIEW_FLIGHTS', 'VIEW_HISTORY', 'VIEW_FLIGHT_STATEMENT']
};
const AKL = {
  stationId: '2', stationCode: 'AKL', displayName: 'Auckland',
  timeZoneId: 'Pacific/Auckland', capabilities: ['VIEW_FLIGHTS']
};

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function createStationContext() {
  const context = vm.createContext({ console: { error() {} }, URLSearchParams, Set, Map });
  vm.runInContext(stationStateSource, context);
  return context;
}

function setAccess(context, stations, selected = '') {
  vm.runInContext(
    `cargoRunAccess=${JSON.stringify({ status: 'provisioned', stations: stations.map(station => station.stationCode), stationMetadata: stations, capabilities: [...new Set(stations.flatMap(station => station.capabilities))], error: '', code: '' })};selectedStationId=${JSON.stringify(selected)}`,
    context
  );
}

function value(context, expression) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
}

function createSessionContext(session) {
  const context = createStationContext();
  const events = [];
  Object.assign(context, {
    state: { sessionUser: { name: 'Signed in user', employeeId: 'user-1' } },
    centralSyncScheduler: { stop() { events.push('stop'); } },
    purgeCargoRunOperationalState() {
      events.push('purge');
      vm.runInContext("operationalSessionGeneration++;selectedStationId='';state.imports=[];state.exports=[];state.flightCatalog=[];state.offloads=[];state.completedOffloads=[];state.completedExports=[];state.completedImports=[];state.history=[]", context);
    },
    render() { events.push('render'); },
    hideDataLoader() {},
    async synchronizeSelectedStation(station) {
      events.push(`sync:${station.stationCode}`);
      return true;
    },
    fetch: async () => response(200, session)
  });
  vm.runInContext(sessionSource, context);
  return { context, events };
}

function deferred() {
  let resolve;
  const promise = new Promise(onResolve => { resolve = onResolve; });
  return { promise, resolve };
}

function createSwitchContext(sync) {
  const context = createStationContext();
  const events = [];
  context.operationalRows = ['OLD'];
  Object.assign(context, {
    centralSyncScheduler: {
      stop() { events.push('stop'); },
      async start() { events.push(`start:${vm.runInContext('selectedStationCode()', context)}`); return true; }
    },
    clearCargoRunOperationalMemory() {
      events.push('purge');
      context.operationalRows = [];
      vm.runInContext("operationalSessionGeneration++;selectedStationId=''", context);
    },
    render() { events.push(`render:${vm.runInContext('selectedStationCode()', context)}`); },
    showDataLoader() { events.push('loader'); },
    hideDataLoader() { events.push('hide'); },
    syncCentralData: options => sync(context, events, options)
  });
  vm.runInContext(switchSource, context);
  return { context, events };
}

test('server capability resolution isolates MEL grants from AKL', () => {
  const access = {
    stationMetadata: [MEL, AKL],
    capabilitiesByStation: { MEL: ['MOVE_ULD', 'VIEW_FLIGHTS'], AKL: ['VIEW_FLIGHTS'] },
    capabilities: ['MOVE_ULD', 'VIEW_FLIGHTS']
  };
  assert.deepEqual(authorization.capabilitiesForStation(access, '1'), ['MOVE_ULD', 'VIEW_FLIGHTS']);
  assert.deepEqual(authorization.capabilitiesForStation(access, '2'), ['VIEW_FLIGHTS']);
  assert.throws(() => authorization.capabilitiesForStation(access, '999'), { code: 'STATION_ACCESS_DENIED' });
});

test('one server-authorized station is auto-selected with its timezone', async () => {
  const { context } = createSessionContext({
    ok: true, authenticated: true, provisioned: true, stations: ['MEL'], stationMetadata: [MEL], capabilities: MEL.capabilities
  });
  assert.equal(await context.loadCargoRunSession(), true);
  assert.equal(vm.runInContext('selectedStationId', context), '1');
  assert.equal(context.selectedStationCode(), 'MEL');
  assert.equal(context.selectedStationTimeZone(), 'Australia/Melbourne');
});

test('two authorized stations require explicit selection and render server metadata', async () => {
  const { context } = createSessionContext({
    ok: true, authenticated: true, provisioned: true, stations: ['MEL', 'AKL'], stationMetadata: [MEL, AKL], capabilities: ['MOVE_ULD', 'VIEW_FLIGHTS']
  });
  assert.equal(await context.loadCargoRunSession(), true);
  assert.equal(vm.runInContext('selectedStationId', context), '');
  assert.equal(context.selectedStation(), null);
  Object.assign(context, { CARGORUN_MASCOT: '/mascot.png', esc: input => String(input) });
  vm.runInContext(sourceBetween('function stationSelectionScreen()', 'let actionLoaderDepth='), context);
  const picker = context.stationSelectionScreen();
  assert.match(picker, /MEL — Melbourne/);
  assert.match(picker, /AKL — Auckland/);
  assert.match(picker, /Pacific\/Auckland/);
});

test('multi-station startup dismisses the access loader before awaiting selection', async () => {
  const context = createStationContext();
  const events = [];
  Object.assign(context, {
    render() { events.push('render'); },
    showDataLoader() { events.push('show'); },
    hideDataLoader() { events.push('hide'); },
    async loadEntraIdentity() {
      vm.runInContext('operationalSessionGeneration++', context);
      return true;
    },
    async loadCargoRunSession() {
      setAccess(context, [MEL, AKL]);
      vm.runInContext('operationalSessionGeneration++', context);
      return true;
    },
    async switchCargoRunStation() { events.push('switch'); return true; }
  });
  vm.runInContext(bootSource, context);
  await context.bootCargoRun();
  assert.equal(events.includes('switch'), false);
  assert.equal(events.at(-1), 'hide');
});

test('zero operational stations fail closed even when aggregate access is provisioned', async () => {
  const { context } = createSessionContext({
    ok: true, authenticated: true, provisioned: true, stations: [], stationMetadata: [], capabilities: ['VIEW_ADMIN_AUDIT']
  });
  assert.equal(await context.loadCargoRunSession(), false);
  assert.equal(value(context, 'cargoRunAccess').status, 'unprovisioned');
  assert.equal(value(context, 'cargoRunAccess').code, 'STATION_ACCESS_REQUIRED');
  assert.equal(context.operationalSessionIsCurrent(vm.runInContext('operationalSessionGeneration', context)), false);
});

test('invalid station selection is rejected without mutation or synchronization', async () => {
  const { context, events } = createSwitchContext(async () => { events.push('sync'); return true; });
  setAccess(context, [MEL, AKL], '1');
  const generation = vm.runInContext('operationalSessionGeneration', context);
  assert.equal(await context.switchCargoRunStation('999'), false);
  assert.equal(vm.runInContext('selectedStationId', context), '1');
  assert.equal(vm.runInContext('operationalSessionGeneration', context), generation);
  assert.deepEqual(context.operationalRows, ['OLD']);
  assert.deepEqual(events, []);
});

test('station capability helper changes with the selected station', () => {
  const context = createStationContext();
  setAccess(context, [MEL, AKL], '1');
  assert.equal(context.selectedStationHasCapability('MOVE_ULD'), true);
  vm.runInContext("selectedStationId='2'", context);
  assert.equal(context.selectedStationHasCapability('MOVE_ULD'), false);
  assert.equal(context.selectedStationTimeZone(), 'Pacific/Auckland');
});

test('browser station date keys use the selected IANA timezone instead of the process timezone', () => {
  const context = createStationContext();
  setAccess(context, [MEL, AKL], '1');
  const instant = '2026-01-01T11:30:00.000Z';
  assert.equal(context.selectedStationDateKey(instant), '2026-01-01');
  vm.runInContext("selectedStationId='2'", context);
  assert.equal(context.selectedStationDateKey(instant), '2026-01-02');
});

test('station switching resets History to today in the newly selected station', async () => {
  const { context } = createSwitchContext(async () => true);
  vm.runInContext("Date.now=()=>Date.parse('2026-01-01T11:30:00.000Z')", context);
  setAccess(context, [MEL, AKL], '1');
  assert.equal(await context.switchCargoRunStation('1'), true);
  assert.equal(vm.runInContext('historyOperatingDate', context), '2026-01-01');
  assert.equal(await context.switchCargoRunStation('2'), true);
  assert.equal(vm.runInContext('historyOperatingDate', context), '2026-01-02');
});

test('valid switch stops, purges, selects, synchronizes, then starts scheduling', async () => {
  const { context, events } = createSwitchContext(async ctx => {
    events.push(`sync:${vm.runInContext('selectedStationCode()', ctx)}`);
    assert.deepEqual(ctx.operationalRows, []);
    return true;
  });
  setAccess(context, [MEL, AKL], '1');
  assert.equal(await context.switchCargoRunStation('2'), true);
  assert.deepEqual(events, ['stop', 'purge', 'render:AKL', 'loader', 'sync:AKL', 'render:AKL', 'start:AKL', 'hide']);
  assert.equal(context.selectedStationTimeZone(), 'Pacific/Auckland');
});

test('failed station synchronization is visible, retryable, and never starts the scheduler early', async () => {
  let attempts = 0;
  const { context, events } = createSwitchContext(async () => {
    attempts++;
    events.push(`sync-attempt:${attempts}`);
    return attempts === 2;
  });
  setAccess(context, [MEL, AKL], '1');
  assert.equal(await context.switchCargoRunStation('2'), false);
  assert.deepEqual(value(context, 'selectedStationSync'), {
    status: 'ERROR', stationId: '2', error: 'Unable to load station operations.'
  });
  assert.equal(events.some(event => event.startsWith('start:')), false);

  Object.assign(context, { CARGORUN_MASCOT: '/mascot.png', esc: input => String(input) });
  vm.runInContext(sourceBetween('function stationSyncErrorScreen()', 'function stationSelectionScreen()'), context);
  const errorScreen = context.stationSyncErrorScreen();
  assert.match(errorScreen, /Unable to load Auckland operations/);
  assert.match(errorScreen, /retrySelectedStationSync\(\)/);
  assert.doesNotMatch(errorScreen, /sync-attempt|Error:/);

  assert.equal(await context.retrySelectedStationSync(), true);
  assert.equal(attempts, 2);
  assert.equal(events.filter(event => event === 'start:AKL').length, 1);
  assert.deepEqual(value(context, 'selectedStationSync'), { status: 'READY', stationId: '2', error: '' });
});

test('repeated station synchronization failures do not start timers or expose stale rows', async () => {
  const { context, events } = createSwitchContext(async () => false);
  setAccess(context, [MEL, AKL], '1');
  assert.equal(await context.switchCargoRunStation('2'), false);
  context.operationalRows.push('SHOULD-BE-PURGED');
  assert.equal(await context.retrySelectedStationSync(), false);
  assert.deepEqual(context.operationalRows, []);
  assert.equal(events.some(event => event.startsWith('start:')), false);
  assert.equal(events.filter(event => event === 'purge').length, 2);
});

test('selected-station screens and mobile Home tiles are capability isolated', () => {
  const context = createStationContext();
  setAccess(context, [AKL], '2');
  Object.assign(context, {
    route: { screen: 'home', type: null, id: null },
    window: { scrollTo() {} },
    centralSyncScheduler: { stop() {}, reschedule() {} },
    render() {}, refreshHistoryOnEntry() {},
    canOpenAdmin: () => false,
    activeFlights: () => [], priorityCargoItems: () => [{ id: 'priority' }],
    operationalOffloadCounts: () => ({ Active: 1 }), counts: () => ({ done: 0 }),
    currentUser: () => ({ name: 'Auckland Operator' }), currentStationCode: () => 'AKL',
    syncLabel: () => 'Live', mobileModuleArtwork: () => '', esc: input => String(input), Date
  });
  vm.runInContext(openScreenSource, context);
  assert.equal(context.openScreen('priority'), false);
  assert.equal(context.openScreen('supervisor'), false);
  assert.equal(context.openScreen('history'), false);
  assert.equal(context.openScreen('admin'), false);
  assert.equal(value(context, 'route').screen, 'home');
  assert.equal(context.openScreen('flightboard'), true);
  assert.equal(value(context, 'route').screen, 'flightboard');

  vm.runInContext(mobileHomeSource, context);
  const home = context.mobileHome();
  assert.match(home, /data-mobile-module="imports"/);
  assert.match(home, /data-mobile-module="exports"/);
  assert.match(home, /data-mobile-module="offloads"/);
  assert.doesNotMatch(home, /data-mobile-module="priority"/);
});

test('action capability map covers all privileged station mutations and direct handlers fail closed', () => {
  const requiredActions = [
    'moveUld', 'scanUld', 'requestOffload', 'collectOffload', 'completeOffload', 'setInBlock',
    'setEtd', 'uploadFlightData', 'confirmExportFinal', 'finaliseFlight', 'viewFlightStatement', 'exportHistory'
  ];
  const context = createStationContext();
  setAccess(context, [AKL], '2');
  for (const action of requiredActions) assert.equal(context.canUseStationAction(action), false, action);
  for (const handler of ['showConfirmULD', 'showScan', 'showRequestOffload', 'showSetInBlock', 'showSetExportEtd',
    'showConfirmBulkMailScan', 'showUploadFlightData', 'processMachFow', 'previewFinalManifest', 'showFinalizeExport', 'showFinalizeImport',
    'showCloseFlight', 'showFlightSummary', 'downloadHistory']) {
    assert.match(html, new RegExp(`function ${handler}\\([^)]*\\)\\s*\\{\\s*if\\s*\\(!canUseStationAction\\(`), handler);
  }
});

test('authorization contraction purges and resynchronizes the retained or replacement station', async () => {
  const initial = {
    ok: true, authenticated: true, provisioned: true, userId: 'user-1', displayName: 'Operator',
    stations: ['MEL', 'AKL'], stationMetadata: [MEL, AKL], capabilities: [...MEL.capabilities]
  };
  const { context, events } = createSessionContext(initial);
  assert.equal(await context.loadCargoRunSession(), true);
  vm.runInContext("selectedStationId='2';state.imports=[{flight:'AKL-OLD'}]", context);
  events.length = 0;
  const melOnly = { ...initial, stations: ['MEL'], stationMetadata: [MEL] };
  context.fetch = async () => response(200, melOnly);
  assert.equal(await context.loadCargoRunSession(), true);
  assert.equal(context.selectedStationCode(), 'MEL');
  assert.deepEqual(value(context, 'state.imports'), []);
  assert.deepEqual(events, ['stop', 'purge', 'render', 'sync:MEL']);
});

test('authorization replacement starts one scheduler only after the fresh station sync succeeds', async () => {
  const context = createStationContext();
  const events = [];
  setAccess(context, [MEL, AKL], '2');
  Object.assign(context, {
    state: { sessionUser: { name: 'Operator', employeeId: 'user-1' }, imports: [{ flight: 'AKL-OLD' }] },
    centralSyncScheduler: {
      stop() { events.push('stop'); },
      async start() { events.push(`start:${vm.runInContext('selectedStationCode()', context)}`); return true; }
    },
    purgeCargoRunOperationalState() {
      events.push('purge');
      vm.runInContext("operationalSessionGeneration++;selectedStationId='';state.imports=[]", context);
    },
    clearCargoRunOperationalMemory() {
      events.push('unexpected-second-purge');
      vm.runInContext("operationalSessionGeneration++;selectedStationId='';state.imports=[]", context);
    },
    render() { events.push(`render:${vm.runInContext('selectedStationCode()', context)}`); },
    showDataLoader() { events.push('loader'); }, hideDataLoader() { events.push('hide'); },
    async syncCentralData() { events.push(`sync:${vm.runInContext('selectedStationCode()', context)}`); return true; },
    fetch: async () => response(200, {
      ok: true, authenticated: true, provisioned: true, userId: 'user-1', displayName: 'Operator',
      stations: ['MEL'], stationMetadata: [MEL], capabilities: MEL.capabilities
    })
  });
  vm.runInContext(`${switchSource}\n${sessionSource}`, context);
  assert.equal(await context.loadCargoRunSession(), true);
  assert.equal(context.selectedStationCode(), 'MEL');
  assert.deepEqual(value(context, 'state.imports'), []);
  assert.equal(events.filter(event => event === 'start:MEL').length, 1);
  assert.ok(events.indexOf('sync:MEL') < events.indexOf('start:MEL'));
  assert.equal(events.includes('unexpected-second-purge'), false);
});

test('capability contraction on the current station purges and resynchronizes while unchanged context does not', async () => {
  const initial = {
    ok: true, authenticated: true, provisioned: true, userId: 'user-1', displayName: 'Operator',
    stations: ['MEL'], stationMetadata: [MEL], capabilities: MEL.capabilities
  };
  const { context, events } = createSessionContext(initial);
  assert.equal(await context.loadCargoRunSession(), true);
  events.length = 0;
  assert.equal(await context.loadCargoRunSession(), true);
  assert.deepEqual(events, ['render']);

  const restrictedMel = { ...MEL, capabilities: ['VIEW_FLIGHTS'] };
  context.fetch = async () => response(200, { ...initial, stationMetadata: [restrictedMel], capabilities: ['VIEW_FLIGHTS'] });
  vm.runInContext("state.history=[{action:'OLD'}]", context);
  events.length = 0;
  assert.equal(await context.loadCargoRunSession(), true);
  assert.deepEqual(value(context, 'state.history'), []);
  assert.deepEqual(events, ['stop', 'purge', 'render', 'sync:MEL']);
});

test('removed selected station with several grants returns to the picker without synchronization', async () => {
  const SYD = { stationId: '3', stationCode: 'SYD', displayName: 'Sydney', timeZoneId: 'Australia/Sydney', capabilities: ['VIEW_FLIGHTS'] };
  const initial = { ok: true, authenticated: true, provisioned: true, userId: 'user-1', stations: ['MEL', 'AKL', 'SYD'], stationMetadata: [MEL, AKL, SYD], capabilities: ['VIEW_FLIGHTS'] };
  const { context, events } = createSessionContext(initial);
  await context.loadCargoRunSession();
  vm.runInContext("selectedStationId='2';state.offloads=[{id:'old'}]", context);
  events.length = 0;
  context.fetch = async () => response(200, { ...initial, stations: ['MEL', 'SYD'], stationMetadata: [MEL, SYD] });
  assert.equal(await context.loadCargoRunSession(), true);
  assert.equal(vm.runInContext('selectedStationId', context), '');
  assert.deepEqual(value(context, 'state.offloads'), []);
  assert.deepEqual(events, ['stop', 'purge', 'render']);
});

test('loss of all operational station grants purges data and fails closed', async () => {
  const initial = { ok: true, authenticated: true, provisioned: true, userId: 'user-1', stations: ['MEL'], stationMetadata: [MEL], capabilities: MEL.capabilities };
  const { context, events } = createSessionContext(initial);
  await context.loadCargoRunSession();
  vm.runInContext("state.exports=[{flight:'OLD'}]", context);
  events.length = 0;
  context.fetch = async () => response(200, { ...initial, provisioned: false, stations: [], stationMetadata: [], capabilities: [] });
  assert.equal(await context.loadCargoRunSession(), false);
  assert.equal(value(context, 'cargoRunAccess').status, 'unprovisioned');
  assert.deepEqual(value(context, 'state.exports'), []);
  assert.deepEqual(events, ['stop', 'purge', 'render']);
});

test('browser rejects malformed or fixed-offset station timezone metadata', async () => {
  for (const timeZoneId of ['', 'Mars/Olympus', '+10:00', 'Etc/GMT-10']) {
    const invalid = { ...MEL, timeZoneId };
    const { context } = createSessionContext({ ok: true, authenticated: true, provisioned: true, userId: 'user-1', stations: ['MEL'], stationMetadata: [invalid], capabilities: MEL.capabilities });
    assert.equal(await context.loadCargoRunSession(), false, timeZoneId);
    assert.equal(value(context, 'cargoRunAccess').status, 'error', timeZoneId);
    assert.equal(context.selectedStation(), null, timeZoneId);
  }
});

test('a stale MEL response cannot start scheduling after an AKL switch', async () => {
  const requests = { MEL: deferred(), AKL: deferred() };
  const { context, events } = createSwitchContext(ctx => {
    const code = vm.runInContext('selectedStationCode()', ctx);
    events.push(`sync:${code}`);
    return requests[code].promise;
  });
  setAccess(context, [MEL, AKL], '1');
  const mel = context.switchCargoRunStation('1');
  const akl = context.switchCargoRunStation('2');
  requests.MEL.resolve(true);
  assert.equal(await mel, false);
  assert.equal(events.includes('start:MEL'), false);
  requests.AKL.resolve(true);
  assert.equal(await akl, true);
  assert.equal(events.filter(event => event.startsWith('start:')).join(','), 'start:AKL');
  assert.equal(context.selectedStationCode(), 'AKL');
});

test('switching MEL to AKL and back reloads clean state each time', async () => {
  const { context, events } = createSwitchContext(async ctx => {
    const code = vm.runInContext('selectedStationCode()', ctx);
    ctx.operationalRows.push(`${code}-FRESH`);
    events.push(`sync:${code}`);
    return true;
  });
  setAccess(context, [MEL, AKL], '1');
  assert.equal(await context.switchCargoRunStation('2'), true);
  assert.deepEqual(context.operationalRows, ['AKL-FRESH']);
  assert.equal(await context.switchCargoRunStation('1'), true);
  assert.deepEqual(context.operationalRows, ['MEL-FRESH']);
  assert.equal(events.filter(event => event === 'purge').length, 2);
});

test('broad reads carry stable stationId while exact entity reads remain exact', () => {
  const context = createStationContext();
  setAccess(context, [MEL], '1');
  vm.runInContext(urlSource, context);
  assert.equal(context.selectedStationApiUrl('/api/flights'), '/api/flights?stationId=1');
  assert.equal(
    context.selectedStationApiUrl('/api/history', { operatingDate: '2026-09-25', limit: 5000 }),
    '/api/history?operatingDate=2026-09-25&limit=5000&stationId=1'
  );
  for (const endpoint of ['/api/flights', '/api/offloads', '/api/history', '/api/export-completions', '/api/import-completions', '/api/mach-fow']) {
    assert.match(html, new RegExp(`selectedStationApiUrl\\('${endpoint.replaceAll('/', '\\/')}'`));
  }
  assert.match(html, /fetch\(`\/api\/ulds\?flightId=\$\{encodeURIComponent\(flightId\)\}`/);
  assert.match(html, /fetch\(`\/api\/offloads\?flightId=\$\{encodeURIComponent\(stableFlightId\)\}`/);
  assert.match(html, /fetch\('\/api\/offloads\?eligibleUlds=true&flightId='/);
});

test('selected station remains memory-only and the single-station header has no picker', () => {
  assert.doesNotMatch(html, /(?:localStorage|sessionStorage|indexedDB|document\.cookie)[^\n;]*selectedStationId/i);
  const context = createStationContext();
  Object.assign(context, { esc: input => String(input) });
  vm.runInContext(sourceBetween('function stationSelector(', 'function header('), context);
  setAccess(context, [MEL], '1');
  assert.doesNotMatch(context.stationSelector(false), /<select/);
  setAccess(context, [MEL, AKL], '2');
  assert.match(context.stationSelector(false), /<select/);
  assert.match(context.stationSelector(false), /AKL — Auckland/);
});
