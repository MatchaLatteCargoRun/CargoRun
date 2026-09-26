'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const handlerSource = fs.readFileSync(path.join(root, 'api', 'flight-status', 'index.js'), 'utf8');

function sourceBetween(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source range ${start} -> ${end}`);
  return html.slice(from, to);
}

function arrivalHarness(enabled) {
  const requests = [];
  const messages = [];
  const state = {
    settings: {
      flightStatus: {
        endpoint: '/api/flight-status', arrivalAirport: 'MEL', pollMinutes: 2,
        landingGraceMinutes: 10, standardWarnMinutes: 20, standardLateMinutes: 30,
        priorityWarnMinutes: 10, priorityLateMinutes: 20
      }
    },
    imports: [{ id: 'import-1', azureFlightId: '101', flight: 'CX0163', flightDate: '15 Sep 2026', closed: false, flightStatus: {} }]
  };
  const context = vm.createContext({
    state,
    seed: state,
    cargoRunAccess: { status: 'provisioned' },
    operationalSessionGeneration: 0,
    operationalSessionIsCurrent: generation => generation === 0,
    location: { protocol: 'https:' },
    URLSearchParams,
    Date,
    Number,
    String,
    Math,
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          provider: 'FlightAware AeroAPI', status: 'En Route',
          matchedFlight: 'CX163', estimatedArrival: '2026-09-15T10:00:00Z'
        })
      };
    },
    activeFlights: type => state[type].filter(flight => !flight.closed),
    stableOperationalId: value => /^[1-9]\d*$/.test(String(value || '')) ? String(value) : null,
    logEvent() {},
    save() {},
    render() {},
    toast(message) { messages.push(message); },
    fmtDateTime: value => String(value)
  });
  vm.runInContext(
    `const FLIGHTAWARE_ENABLED=${enabled};\n` +
      sourceBetween('function flightStatusSettings()', 'function toneClass('),
    context
  );
  return { context, requests, messages };
}

test('one FlightAware feature flag defaults off', () => {
  assert.equal((html.match(/\bconst FLIGHTAWARE_ENABLED=/g) || []).length, 1);
  assert.match(html, /const FLIGHTAWARE_ENABLED=false;/);
  assert.match(html, /Live tracking disabled/);
  assert.match(html, /No FlightAware requests will be made\./);
});

test('disabled arrival sync entry points are silent and never request the endpoint', async () => {
  const { context, requests, messages } = arrivalHarness(false);
  assert.equal(await context.syncFlightArrivalById('import-1', false), false);
  assert.equal(await context.syncAllFlightArrivals(false), false);
  assert.equal(context.canUseFlightStatusApi(), false);
  assert.deepEqual(requests, []);
  assert.deepEqual(messages, []);
});

test('enabling the one flag restores individual and all-flight request paths', async () => {
  const individual = arrivalHarness(true);
  assert.equal(await individual.context.syncFlightArrivalById('import-1', true), true);
  assert.equal(individual.requests.length, 1);
  assert.match(individual.requests[0].url, /^\/api\/flight-status\?/);
  assert.equal(individual.requests[0].options.headers['X-CargoRun-FlightAware-Enabled'], 'true');

  const all = arrivalHarness(true);
  assert.equal(await all.context.syncAllFlightArrivals(true), true);
  assert.equal(all.requests.length, 1);
});

test('automatic FlightAware interval is not registered while disabled', () => {
  const start = html.lastIndexOf('if(FLIGHTAWARE_ENABLED){');
  const end = html.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start);
  const intervalSource = html.slice(start, end + 2);
  assert.match(intervalSource, /setInterval[\s\S]*syncAllFlightArrivals\(true\)/);

  for (const [enabled, expected] of [[false, 0], [true, 1]]) {
    let registrations = 0;
    const context = vm.createContext({
      setInterval(callback, delay) {
        registrations++;
        assert.equal(typeof callback, 'function');
        assert.equal(delay, 120000);
      },
      document: { visibilityState: 'visible' },
      canUseFlightStatusApi: () => true,
      syncAllFlightArrivals() {},
      flightStatusSettings: () => ({ pollMinutes: 2 }),
      Math,
      Number
    });
    vm.runInContext(`const FLIGHTAWARE_ENABLED=${enabled};\n${intervalSource}`, context);
    assert.equal(registrations, expected);
  }
});

test('post-manifest-upload refresh is gated by the same feature flag', () => {
  const match = html.match(/    if \(\r?\n      FLIGHTAWARE_ENABLED &&[\s\S]*?\r?\n    \}/);
  assert.ok(match);
  const uploadGate = match[0];
  assert.match(uploadGate, /syncFlightArrivalById/);

  for (const [enabled, expected] of [[false, 0], [true, 1]]) {
    let refreshes = 0;
    const context = vm.createContext({
      cargoRunAccess: { status: 'provisioned' },
      operationalSessionGeneration: 0,
      operationalSessionIsCurrent: generation => generation === 0,
      canUseFlightStatusApi: () => true,
      deferOperational(generation, callback, delay) {
        assert.equal(generation, 0);
        assert.equal(delay, 250);
        callback();
      },
      syncFlightArrivalById(id, quiet) {
        assert.equal(id, 'import-1');
        assert.equal(quiet, true);
        refreshes++;
      }
    });
    vm.runInContext(
      `const FLIGHTAWARE_ENABLED=${enabled}; const operationalSessionGeneration=0; const generation=operationalSessionGeneration; const p={type:'imports'}; const flight={id:'import-1'};\n${uploadGate}`,
      context
    );
    assert.equal(refreshes, expected);
  }
});

test('disabled UI hides FlightAware controls while normal Import actions remain', () => {
  const functionStart = html.indexOf('function desktopFlightActions(');
  const functionEnd = html.indexOf('\n', functionStart);
  const actionsSource = html.slice(functionStart, functionEnd);

  function render(enabled) {
    const context = vm.createContext({
      FLIGHTAWARE_ENABLED: enabled,
      expectedUldsForFlight: flight => flight.ulds,
      esc: value => String(value ?? ''),
      exportDepartureMs: () => 0
    });
    vm.runInContext(actionsSource, context);
    return context.desktopFlightActions('imports', {
      id: 'import-1', azureFlightId: '101', ulds: [{ status: 'Unarrived' }]
    });
  }

  const disabled = render(false);
  assert.doesNotMatch(disabled, /Sync arrival/);
  assert.match(disabled, /Add ULD/);
  assert.match(disabled, /Set In Block/);
  assert.match(disabled, /Finalise \/ Exception/);

  const enabled = render(true);
  assert.match(enabled, /Sync arrival/);
  assert.match(html, /FLIGHTAWARE_ENABLED\?`[^\r\n]*syncAllFlightArrivals\(false\)[^\r\n]*Sync Arrivals/);
});

function flightStatusHarness({ env = {}, fetchImpl } = {}) {
  const operationalAuthorization = require('./helpers/operational-authorization-stub');
  const state = {
    authorizationCalls: [],
    connectionCount: 0,
    flightLookups: [],
    upstreamRequests: []
  };

  class Request {
    constructor() { this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(query) {
      state.flightLookups.push({ query: String(query), values: { ...this.values } });
      return { recordset: [{
        FlightId: '101', StationId: '1', FlightNumber: 'CX0163', OperatingDate: '2026-09-15',
        Direction: 'IMPORT', OriginAirport: 'HKG', DestinationAirport: 'MEL'
      }] };
    }
  }
  class ConnectionPool {
    async connect() { state.connectionCount++; return this; }
    request() { return new Request(); }
    async close() {}
  }
  const sqlMock = { ConnectionPool, Request, BigInt: 'bigint' };
  const authorizationMock = {
    ...operationalAuthorization,
    async requireOperationalStations(...args) {
      state.authorizationCalls.push('stations');
      return operationalAuthorization.requireOperationalStations(...args);
    },
    async requireOperationalEntityCapability(...args) {
      state.authorizationCalls.push('entity');
      return operationalAuthorization.requireOperationalEntityCapability(...args);
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(handlerSource, {
    module, exports: module.exports, Buffer, URL, Date, console,
    async fetch(...args) {
      state.upstreamRequests.push(String(args[0]));
      if (!fetchImpl) throw new Error('unexpected FlightAware request');
      return fetchImpl(...args);
    },
    process: { version: process.version, env: { ...env } },
    require(name) {
      if (name === 'mssql') return sqlMock;
      if (name === '../shared/operational-authorization') return authorizationMock;
      return require(name);
    }
  }, { filename: path.join(root, 'api', 'flight-status', 'index.js') });

  return {
    state,
    async invoke(req) {
      const context = { log: { error() {} } };
      await module.exports(context, req);
      return { ...context.res, body: JSON.parse(context.res.body) };
    }
  };
}

test('flight-status OFF cannot be overridden by header, query, or body input and makes zero upstream calls', async () => {
  assert.match(handlerSource, /aeroapi\.flightaware\.com\/aeroapi\/flights/);
  assert.match(handlerSource, /function alternates\(ident\)/);
  assert.match(handlerSource, /process\.env\.FLIGHTAWARE_ENABLED/);
  assert.doesNotMatch(handlerSource, /x-cargorun-flightaware-enabled/i);
  assert.equal(fs.existsSync(path.join(root, 'api', 'flight-status', 'function.json')), true);

  const harness = flightStatusHarness({
    env: {
      DATABASE_CONNECTION_STRING: 'test-only',
      FLIGHTAWARE_API_KEY: 'test-key'
    }
  });
  const spoofedRequests = [
    {
      query: { flightId: '101' },
      headers: { 'x-cargorun-flightaware-enabled': 'true' }
    },
    {
      query: { flightId: '101', flightawareEnabled: 'true', FLIGHTAWARE_ENABLED: 'true' },
      headers: {}
    },
    {
      query: { flightId: '101' },
      headers: {},
      body: { flightawareEnabled: true, FLIGHTAWARE_ENABLED: 'true' }
    }
  ];

  for (const req of spoofedRequests) {
    const response = await harness.invoke(req);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'FLIGHTAWARE_DISABLED');
  }

  assert.equal(harness.state.connectionCount, 0);
  assert.deepEqual(harness.state.authorizationCalls, []);
  assert.deepEqual(harness.state.flightLookups, []);
  assert.deepEqual(harness.state.upstreamRequests, []);
});

test('server-enabled flight-status fixture retains authorization and alternate lookup path', async () => {
  const harness = flightStatusHarness({
    env: {
      DATABASE_CONNECTION_STRING: 'test-only',
      FLIGHTAWARE_ENABLED: 'true',
      FLIGHTAWARE_API_KEY: 'test-key'
    },
    fetchImpl: async url => {
      const alternate = String(url).includes('/CX163?');
      return {
        ok: true,
        status: 200,
        json: async () => ({ flights: alternate ? [{
          ident_iata: 'CX163', status: 'En Route',
          destination: { code_iata: 'MEL' },
          scheduled_in: '2026-09-15T10:00:00Z'
        }] : [] })
      };
    }
  });
  const response = await harness.invoke({
    query: {
      flightId: '101', flight: 'QF999', arrivalAirport: 'SYD', date: '1990-01-01',
      flightawareEnabled: 'false'
    },
    headers: {
      'x-cargorun-flightaware-enabled': 'false',
      'x-ms-client-principal': Buffer.from(JSON.stringify({
        userId: 'flight-reader', userDetails: 'Flight Reader', userRoles: ['authenticated']
      })).toString('base64')
    },
    body: { FLIGHTAWARE_ENABLED: false }
  });

  assert.equal(response.status, 200);
  assert.equal(harness.state.connectionCount, 1);
  assert.deepEqual(harness.state.authorizationCalls, ['stations', 'entity']);
  assert.equal(harness.state.flightLookups.length, 1);
  assert.equal(harness.state.flightLookups[0].values.FlightStatusFlightId, '101');
  assert.equal(harness.state.upstreamRequests.length, 2);
  assert.match(harness.state.upstreamRequests[0], /\/CX0163\?/);
  assert.match(harness.state.upstreamRequests[1], /\/CX163\?/);
  assert.equal(response.body.matchedFlight, 'CX163');
});
