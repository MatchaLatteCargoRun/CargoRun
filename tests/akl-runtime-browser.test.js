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

test('global control-plane session opens Admin without operational access or synchronization', async () => {
  const { context, events } = createSessionContext({
    ok: true, authenticated: true, provisioned: true, stations: [], stationMetadata: [], capabilities: ['VIEW_ADMIN_AUDIT']
  });
  vm.runInContext(sourceBetween('function hasCargoRunCapability(', 'function accessGateScreen('), context);
  assert.equal(await context.loadCargoRunSession(), true);
  assert.equal(value(context, 'cargoRunAccess').status, 'provisioned');
  assert.equal(value(context, 'route').screen, 'admin');
  assert.equal(context.selectedStation(), null);
  const generation = vm.runInContext('operationalSessionGeneration', context);
  assert.equal(context.operationalSessionIsCurrent(generation), false);
  assert.equal(context.adminSessionIsCurrent(generation), true);
  assert.equal(events.some(event => event.startsWith('sync:')), false);
  const requests = [];
  context.fetch = async url => { requests.push(url); return response(200, { ok: true, configuration: { stations: [] } }); };
  vm.runInContext(sourceBetween('async function loadAdminConfiguration()', 'function adminSectionTools('), context);
  await context.loadAdminConfiguration();
  assert.deepEqual(requests, ['/api/configuration-control']);
  assert.equal(value(context, 'adminConfigState').status, 'ready');
  vm.runInContext('operationalSessionGeneration++', context);
  assert.equal(context.adminSessionIsCurrent(generation), false, 'stale Admin responses still fail closed');
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


test('late ADMIN response cannot restore a prior actor or station scope', async () => {
  const { context } = createSessionContext({
    ok: true, authenticated: true, provisioned: true, userId: 'admin-a',
    stations: [], stationMetadata: [], capabilities: ['VIEW_ADMIN_AUDIT']
  });
  vm.runInContext(sourceBetween('function hasCargoRunCapability(', 'function accessGateScreen('), context);
  assert.equal(await context.loadCargoRunSession(), true);
  vm.runInContext(sourceBetween('async function loadAdminConfiguration()', 'function adminSectionTools('), context);
  let resolveRequest;
  context.fetch = () => new Promise(resolve => { resolveRequest = resolve; });
  const pending = context.loadAdminConfiguration();
  vm.runInContext("operationalSessionGeneration++;cargoRunAccess={status:'unprovisioned',stations:[],stationMetadata:[],capabilities:[],error:'',code:''};adminConfigState={status:'idle',configuration:null}", context);
  resolveRequest(response(200, { ok: true, configuration: { marker: 'old-scope' } }));
  await pending;
  assert.equal(value(context, 'adminConfigState').status, 'idle');
  assert.equal(value(context, 'adminConfigState').configuration, null);
});