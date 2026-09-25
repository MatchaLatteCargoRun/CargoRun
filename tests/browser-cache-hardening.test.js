'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function sourceBetween(startText, endText) {
  const start = html.indexOf(startText);
  const end = html.indexOf(endText, start);
  assert.notEqual(start, -1, `missing ${startText}`);
  assert.notEqual(end, -1, `missing ${endText}`);
  return html.slice(start, end);
}

function storageMock(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    api: {
      get length() { return values.size; },
      key(index) { return [...values.keys()][index] ?? null; },
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { writes.push([key, String(value)]); values.set(key, String(value)); },
      removeItem(key) { values.delete(key); }
    }
  };
}

function createStateContext(cachedState = null) {
  const storage = storageMock(cachedState ? { 'cargorun-state': JSON.stringify(cachedState) } : {});
  const modal = {
    innerHTML: '<strong>OLD OPERATIONAL MODAL</strong>',
    classList: { remove() {} },
    replaceChildren() { this.innerHTML = ''; }
  };
  const context = vm.createContext({
    localStorage: storage.api,
    structuredClone,
    console: { error() {} },
    document: { getElementById: id => id === 'modal' ? modal : null },
    setTimeout,
    clearTimeout,
    render() {},
    location: { protocol: 'https:', href: '' },
    centralSyncScheduler: { stop() {}, request: async () => true },
    fetch: async () => { throw new Error('fetch not configured'); }
  });
  const stateSource = sourceBetween('const CARGORUN_STATE_VERSION=', '/* =========================================================');
  vm.runInContext(`${stateSource}\nvar offloadRequestSession=null;var pendingFlightUpload=null;var pendingFinalConfirmation=null;`, context);
  return { context, storage, modal };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function provision(context) {
  vm.runInContext("cargoRunAccess={status:'provisioned',stations:['MEL'],capabilities:['VIEW_FLIGHTS']}", context);
}

function readJson(context, expression) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
}

function installSessionFunction(context) {
  vm.runInContext(sourceBetween('async function loadCargoRunSession()', 'function hasCargoRunCapability('), context);
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const cachedOperationalState = {
  stateVersion: 7,
  sessionUser: { name: 'Previous User', employeeId: 'previous-user' },
  imports: [{ flight: 'OLD100', ulds: [{ num: 'AKE11111XX' }] }],
  exports: [{ flight: 'OLD200', ulds: [{ num: 'AKE22222XX' }] }],
  flightCatalog: [{ flightId: '99', flightNumber: 'OLD100' }],
  offloads: [{ azureOffloadId: '77', uld: 'AKE33333XX' }],
  completedOffloads: [{ azureOffloadId: '76', uld: 'AKE44444XX' }],
  completedExports: [{ verificationId: 'old-export-evidence' }],
  completedImports: [{ verificationId: 'old-import-evidence' }],
  history: [{ action: 'OLD HISTORY EVIDENCE' }]
};

test('legacy cached flights are purged and cannot hydrate before session authorization', () => {
  const { context, storage } = createStateContext(cachedOperationalState);
  assert.equal(storage.values.has('cargorun-state'), false);
  assert.deepEqual(readJson(context, 'state.imports'), []);
  assert.deepEqual(readJson(context, 'state.exports'), []);
  assert.deepEqual(readJson(context, 'state.flightCatalog'), []);
});

test('legacy cached ULD and offload rows never enter startup memory', () => {
  const { context } = createStateContext(cachedOperationalState);
  assert.deepEqual(readJson(context, 'state.imports.flatMap(f=>f.ulds||[])'), []);
  assert.deepEqual(readJson(context, 'state.exports.flatMap(f=>f.ulds||[])'), []);
  assert.deepEqual(readJson(context, 'state.offloads'), []);
  assert.deepEqual(readJson(context, 'state.completedOffloads'), []);
});

test('legacy History and completion evidence never enter startup memory', () => {
  const { context } = createStateContext(cachedOperationalState);
  assert.deepEqual(readJson(context, 'state.history'), []);
  assert.deepEqual(readJson(context, 'state.completedExports'), []);
  assert.deepEqual(readJson(context, 'state.completedImports'), []);
});

test('provisioned false purges legacy cache and all in-memory operational rows', async () => {
  const { context, storage } = createStateContext();
  installSessionFunction(context);
  storage.values.set('cargorun-state', JSON.stringify(cachedOperationalState));
  vm.runInContext("state.imports=[{flight:'VISIBLE-BEFORE-CHECK'}];state.history=[{action:'OLD'}]", context);
  context.fetch = async () => response(200, { ok: true, authenticated: true, provisioned: false, userId: 'user-b', displayName: 'User B', stations: [], capabilities: [] });
  assert.equal(await context.loadCargoRunSession(), false);
  assert.equal(storage.values.has('cargorun-state'), false);
  assert.deepEqual(readJson(context, 'state.imports'), []);
  assert.deepEqual(readJson(context, 'state.history'), []);
  assert.equal(readJson(context, 'cargoRunAccess').status, 'unprovisioned');
});

test('authorization configuration 503 purges legacy cache and operational state', async () => {
  const { context, storage } = createStateContext();
  installSessionFunction(context);
  storage.values.set('cargorun-state', JSON.stringify(cachedOperationalState));
  vm.runInContext("state.offloads=[{uld:'OLD'}];state.completedExports=[{verificationId:'OLD'}]", context);
  context.fetch = async () => response(503, { ok: false, code: 'AUTHORIZATION_CONFIGURATION_UNAVAILABLE', error: 'Operational authorization could not be resolved' });
  assert.equal(await context.loadCargoRunSession(), false);
  assert.equal(storage.values.has('cargorun-state'), false);
  assert.deepEqual(readJson(context, 'state.offloads'), []);
  assert.deepEqual(readJson(context, 'state.completedExports'), []);
  assert.equal(readJson(context, 'cargoRunAccess').status, 'error');
});

test('sign-out synchronously purges legacy cache and operational memory before redirect', () => {
  const { context, storage } = createStateContext();
  storage.values.set('cargorun-state', JSON.stringify(cachedOperationalState));
  vm.runInContext("state.imports=[{flight:'OLD'}];state.history=[{action:'OLD'}]", context);
  vm.runInContext(sourceBetween('function signOutCargoRun()', 'function pct('), context);
  context.signOutCargoRun();
  assert.equal(storage.values.has('cargorun-state'), false);
  assert.deepEqual(readJson(context, 'state.imports'), []);
  assert.deepEqual(readJson(context, 'state.history'), []);
  assert.equal(context.location.href, '/.auth/logout?post_logout_redirect_uri=/signed-out.html');
});

test('a server user change clears the previous user operational rows', async () => {
  const { context } = createStateContext();
  installSessionFunction(context);
  const sessionA = { ok: true, authenticated: true, provisioned: true, userId: 'user-a', displayName: 'User A', stations: ['MEL'], capabilities: ['VIEW_FLIGHTS'] };
  context.fetch = async () => response(200, sessionA);
  assert.equal(await context.loadCargoRunSession(), true);
  vm.runInContext("state.imports=[{flight:'USER-A-FLIGHT'}];state.history=[{action:'USER-A-HISTORY'}]", context);

  let resolveStaleSession;
  context.fetch = () => new Promise(resolve => { resolveStaleSession = resolve; });
  const staleSession = context.loadCargoRunSession();
  const sessionB = { ...sessionA, userId: 'user-b', displayName: 'User B' };
  context.fetch = async () => response(200, sessionB);
  assert.equal(await context.loadCargoRunSession(), true);
  resolveStaleSession(response(200, sessionA));
  assert.equal(await staleSession, false);
  assert.deepEqual(readJson(context, 'state.imports'), []);
  assert.deepEqual(readJson(context, 'state.history'), []);
  assert.equal(readJson(context, 'state.sessionUser').employeeId, 'user-b');
  assert.equal(readJson(context, 'cargoRunAccess').status, 'provisioned');
});

test('station or capability changes clear data from the previous authorization scope', async () => {
  const { context } = createStateContext();
  installSessionFunction(context);
  let session = { ok: true, authenticated: true, provisioned: true, userId: 'same-user', stations: ['MEL'], capabilities: ['VIEW_FLIGHTS', 'VIEW_HISTORY'] };
  context.fetch = async () => response(200, session);
  assert.equal(await context.loadCargoRunSession(), true);
  vm.runInContext("state.exports=[{flight:'MEL-ONLY'}];state.completedImports=[{verificationId:'MEL-EVIDENCE'}]", context);
  session = { ...session, stations: ['SYD'], capabilities: ['VIEW_FLIGHTS'] };
  assert.equal(await context.loadCargoRunSession(), true);
  assert.deepEqual(readJson(context, 'state.exports'), []);
  assert.deepEqual(readJson(context, 'state.completedImports'), []);
  assert.deepEqual(readJson(context, 'cargoRunAccess.stations'), ['SYD']);
  assert.deepEqual(readJson(context, 'cargoRunAccess.capabilities'), ['VIEW_FLIGHTS']);
});

test('no state or preference is persisted and purge clears transient operational UI state', () => {
  const { context, storage, modal } = createStateContext();
  vm.runInContext("state.imports=[{flight:'OLD'}];route={screen:'flight',flightId:'123'};desktopLookupSession={kind:'uld',query:'AKE12345XX'};desktopUldLookupCache.set('123',Promise.resolve([]));machFowRecent=[{flightId:'123'}];adminConfigState={status:'ready',configuration:{secret:'old'}};adminSection='audit';adminShcFilters={search:'OLD-SHC',group:'OLD-GROUP',airline:'XX',unassignedOnly:true};adminAuditFilters={date:'2026-09-25',user:'Previous User',entity:'Flight',airline:'XX',operation:'UPDATE'};offloadRequestSession={flights:[{flightId:'123'}]};pendingFlightUpload={flight:'OLD'};pendingFinalConfirmation={flightId:'123'};save();purgeCargoRunOperationalState({preserveIdentity:false})", context);
  assert.deepEqual(storage.writes, []);
  assert.doesNotMatch(html, /localStorage\.(?:getItem|setItem)\(/);
  assert.deepEqual(readJson(context, 'route'), { screen: 'home', type: null, id: null });
  assert.deepEqual(readJson(context, 'desktopLookupSession'), { kind: '', query: '' });
  assert.deepEqual(readJson(context, 'machFowRecent'), []);
  assert.equal(readJson(context, 'adminConfigState').configuration, null);
  assert.equal(readJson(context, 'adminSection'), 'airlines');
  assert.deepEqual(readJson(context, 'adminShcFilters'), { search: '', group: '', airline: '', unassignedOnly: false });
  assert.deepEqual(readJson(context, 'adminAuditFilters'), { date: '', user: '', entity: '', airline: '', operation: '' });
  assert.equal(modal.innerHTML, '');
});

test('provisioned startup waits for session and then loads only fresh authorized server data', async () => {
  const events = [];
  const state = { imports: [], exports: [], offloads: [], history: [], completedExports: [], completedImports: [] };
  const context = vm.createContext({
    state,
    operationalSessionGeneration: 0,
    cargoRunAccess: { status: 'provisioned' },
    operationalSessionIsCurrent(generation) { return generation === context.operationalSessionGeneration && context.cargoRunAccess.status === 'provisioned'; },
    render() { events.push(['render', state.imports.map(row => row.flight)]); },
    showDataLoader() { events.push(['loader']); },
    hideDataLoader() { events.push(['hide']); },
    updateDataLoader() { events.push(['update']); },
    currentStationCode: () => 'MEL',
    loadEntraIdentity: async () => { events.push(['identity']); return true; },
    loadCargoRunSession: async () => { events.push(['session']); return true; },
    syncCentralData: async () => { events.push(['sync']); state.imports = [{ flight: 'FRESH100' }]; return true; },
    centralSyncScheduler: { start: async () => { events.push(['start']); } }
  });
  vm.runInContext(sourceBetween('async function bootCargoRun()', '\nbootCargoRun();'), context);
  await context.bootCargoRun();
  const names = events.map(event => event[0]);
  assert.ok(names.indexOf('session') < names.indexOf('sync'));
  assert.ok(names.indexOf('sync') < names.indexOf('start'));
  assert.equal(names.filter(name => name === 'loader').length, 2);
  assert.ok(names.lastIndexOf('loader') > names.indexOf('session'));
  assert.deepEqual(state.imports, [{ flight: 'FRESH100' }]);
  assert.deepEqual(events[0], ['render', []]);
});

test('a stale flight summary response cannot reopen operational UI or hide the replacement loader', async () => {
  const { context } = createStateContext();
  const pending = deferred();
  const events = [];
  let loaderVisible = false;
  provision(context);
  Object.assign(context, {
    stableOperationalId: value => String(value || ''),
    loadFlightSummary: () => pending.promise,
    showActionLoader: () => { loaderVisible = true; },
    hideActionLoader: () => { loaderVisible = false; },
    modal: () => events.push('modal'),
    toast: () => events.push('toast'),
    console: { error: () => events.push('error') }
  });
  vm.runInContext(sourceBetween('async function showFlightSummary(', 'function flightSummaryHtml('), context);

  const stale = context.showFlightSummary('101');
  vm.runInContext('purgeCargoRunOperationalState({preserveIdentity:false})', context);
  context.showActionLoader('replacement');
  pending.resolve({ flight: { flightId: '101', flightNumber: 'OLD101', flightStatus: 'ACTIVE' }, offloads: [] });
  await stale;

  assert.deepEqual(events, []);
  assert.equal(loaderVisible, true);
});

test('a stale import completion cannot repopulate evidence or clear replacement UI state', async () => {
  const { context } = createStateContext();
  const pending = deferred();
  const events = [];
  let loaderVisible = false;
  provision(context);
  Object.assign(context, {
    importSummaryForFlight: () => ({ outstanding: 0 }),
    currentUser: () => ({ name: 'User A', employeeId: 'user-a' }),
    showActionLoader: () => { loaderVisible = true; },
    hideActionLoader: () => { loaderVisible = false; },
    fetch: () => pending.promise,
    closeModal: () => events.push('close'),
    toast: () => events.push('toast'),
    console: { error: () => events.push('error') }
  });
  vm.runInContext("state.imports=[{id:'old-import',azureFlightId:'501',flight:'OLD501'}]", context);
  vm.runInContext(sourceBetween('async function finalizeImport(', 'function normaliseImportRecord('), context);

  const stale = context.finalizeImport('old-import');
  vm.runInContext("purgeCargoRunOperationalState({preserveIdentity:false});state.completedImports=[{verificationId:'USER-B'}]", context);
  context.showActionLoader('replacement');
  pending.resolve(response(200, { ok: true, record: { verificationId: 'USER-A' } }));
  await stale;

  assert.deepEqual(readJson(context, 'state.completedImports'), [{ verificationId: 'USER-B' }]);
  assert.deepEqual(events, []);
  assert.equal(loaderVisible, true);
});

test('a stale MACH FOW response cannot replace new-session data or clear its loading flag', async () => {
  const { context } = createStateContext();
  const pending = deferred();
  const events = [];
  provision(context);
  Object.assign(context, {
    fetch: () => pending.promise,
    toast: () => events.push('toast'),
    render: () => events.push('render'),
    console: { error: () => events.push('error') }
  });
  vm.runInContext(sourceBetween('async function loadMachFowRecent(', 'async function processMachFow('), context);

  const stale = context.loadMachFowRecent(false);
  vm.runInContext("purgeCargoRunOperationalState({preserveIdentity:false});machFowRecent=[{messageId:'USER-B'}];machFowReceiver={station:'B'};machFowLoading=true;route={screen:'machfow'}", context);
  pending.resolve(response(200, { ok: true, messages: [{ messageId: 'USER-A' }], receiver: { station: 'A' } }));
  await stale;

  assert.deepEqual(readJson(context, 'machFowRecent'), [{ messageId: 'USER-B' }]);
  assert.deepEqual(readJson(context, 'machFowReceiver'), { station: 'B' });
  assert.equal(readJson(context, 'machFowLoading'), true);
  assert.deepEqual(events, []);
});

test('a stale admin response cannot replace the new authorization scope configuration', async () => {
  const { context } = createStateContext();
  const pending = deferred();
  const events = [];
  provision(context);
  Object.assign(context, {
    fetch: () => pending.promise,
    render: () => events.push('render')
  });
  vm.runInContext(sourceBetween('async function loadAdminConfiguration()', 'function adminSectionTools('), context);

  const stale = context.loadAdminConfiguration();
  vm.runInContext("purgeCargoRunOperationalState({preserveIdentity:false});adminConfigState={status:'ready',configuration:{scope:'USER-B'},authorization:null,actor:null,access:null,audit:null,error:'',code:''};route={screen:'admin'}", context);
  pending.resolve(response(200, { ok: true, configuration: { scope: 'USER-A' } }));
  await stale;

  assert.equal(readJson(context, 'adminConfigState').configuration.scope, 'USER-B');
  assert.deepEqual(events, []);
});

test('a stale workbook parse cannot restore a previous-session upload', async () => {
  const { context, modal } = createStateContext();
  const pending = deferred();
  const box = { className: '', innerHTML: '', textContent: '' };
  const button = { disabled: false, textContent: '' };
  provision(context);
  context.document.getElementById = id => id === 'uploadPreview' ? box : id === 'createFlightBtn' ? button : id === 'modal' ? modal : null;
  Object.assign(context, {
    esc: value => String(value || ''),
    parseCargoRunWorkbook: () => pending.promise
  });
  vm.runInContext(sourceBetween('async function handleFlightWorkbook(', 'function cargoRunApiDate('), context);

  const stale = context.handleFlightWorkbook({ target: { files: [{ name: 'user-a.xlsx' }] } });
  vm.runInContext("purgeCargoRunOperationalState({preserveIdentity:false});pendingFlightUpload={flight:'USER-B'}", context);
  box.className = 'replacement';
  box.innerHTML = 'USER-B';
  button.disabled = false;
  pending.resolve({ type: 'imports', flight: 'OLD501', ulds: [], sourceFile: 'user-a.xlsx' });
  await stale;

  assert.deepEqual(readJson(context, 'pendingFlightUpload'), { flight: 'USER-B' });
  assert.equal(box.className, 'replacement');
  assert.equal(box.innerHTML, 'USER-B');
  assert.equal(button.disabled, false);
});

test('a workbook read invalidated by reprovisioning never submits its bytes to manifest parsing', async () => {
  const { context } = createStateContext();
  const read = deferred();
  let manifestFetches = 0;
  provision(context);
  Object.assign(context, {
    readCargoRunWorkbook: () => read.promise,
    detectCargoRunWorkbook: () => 'EXPORT_UWS',
    fetch: async () => { manifestFetches++; return response(200, { ok: true }); }
  });
  vm.runInContext(sourceBetween('async function parseExportUwsWorkbook(', 'async function handleFlightWorkbook('), context);
  const generation = vm.runInContext('operationalSessionGeneration', context);

  const stale = context.parseCargoRunWorkbook({ name: 'user-a.xlsx' }, generation);
  vm.runInContext('purgeCargoRunOperationalState({preserveIdentity:false})', context);
  provision(context);
  read.resolve({ sheets: [] });
  assert.equal(await stale, null);
  assert.equal(manifestFetches, 0);
});

test('purge blanks and closes auxiliary windows containing operational reports', () => {
  const { context } = createStateContext();
  const writes = [];
  const reportWindow = {
    closed: false,
    document: {
      open() {},
      write(value) { writes.push(value); },
      close() {}
    },
    close() { this.closed = true; }
  };
  provision(context);
  context.window = { open: () => reportWindow };

  vm.runInContext('openOperationalReportWindow(operationalSessionGeneration)', context);
  vm.runInContext('purgeCargoRunOperationalState({preserveIdentity:false})', context);

  assert.equal(reportWindow.closed, true);
  assert.equal(writes.at(-1), '<!doctype html><title>CargoRun</title>');
});

test('deferred operational callbacks and old lookup promises are generation-bound', async () => {
  const { context } = createStateContext();
  provision(context);
  context.deferredHits = 0;
  vm.runInContext('deferOperational(operationalSessionGeneration,()=>deferredHits++,5);purgeCargoRunOperationalState({preserveIdentity:false})', context);
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(context.deferredHits, 0);
  assert.match(html, /desktopUldLookupCache\.get\(id\)===pending/);
});

test('stale startup sync cannot start scheduling or hide a replacement-session loader', async () => {
  const sync = deferred();
  const syncStarted = deferred();
  const events = [];
  let loaderVisible = false;
  const context = vm.createContext({
    operationalSessionGeneration: 0,
    cargoRunAccess: { status: 'provisioned' },
    operationalSessionIsCurrent(generation) { return generation === context.operationalSessionGeneration && context.cargoRunAccess.status === 'provisioned'; },
    render() { events.push('render'); },
    showDataLoader() { loaderVisible = true; events.push('show'); },
    hideDataLoader() { loaderVisible = false; events.push('hide'); },
    currentStationCode: () => 'MEL',
    loadEntraIdentity: async () => true,
    loadCargoRunSession: async () => true,
    syncCentralData: () => { syncStarted.resolve(); return sync.promise; },
    centralSyncScheduler: { start: async () => { events.push('start'); } }
  });
  vm.runInContext(sourceBetween('async function bootCargoRun()', '\nbootCargoRun();'), context);

  const stale = context.bootCargoRun();
  await syncStarted.promise;
  context.operationalSessionGeneration++;
  context.showDataLoader('replacement');
  sync.resolve(true);
  await stale;

  assert.equal(events.includes('start'), false);
  assert.equal(loaderVisible, true);
});
