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
    imports: [{ id: 'import-1', flight: 'CX0163', flightDate: '15 Sep 2026', closed: false, flightStatus: {} }]
  };
  const context = vm.createContext({
    state,
    seed: state,
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
      canUseFlightStatusApi: () => true,
      setTimeout(callback, delay) {
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
      `const FLIGHTAWARE_ENABLED=${enabled}; const p={type:'imports'}; const flight={id:'import-1'};\n${uploadGate}`,
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

test('flight-status handler blocks unmarked requests and retains enabled alternate lookup', async () => {
  assert.match(handlerSource, /aeroapi\.flightaware\.com\/aeroapi\/flights/);
  assert.match(handlerSource, /function alternates\(ident\)/);
  assert.equal(fs.existsSync(path.join(root, 'api', 'flight-status', 'function.json')), true);

  const handler = require('../api/flight-status');
  const previousFetch = global.fetch;
  const previousKey = process.env.FLIGHTAWARE_API_KEY;
  const requests = [];
  process.env.FLIGHTAWARE_API_KEY = 'test-key';
  global.fetch = async url => {
    requests.push(String(url));
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
  };

  try {
    const disabledContext = { log: { error() {} } };
    await handler(disabledContext, { query: { flight: 'CX0163' }, headers: {} });
    assert.equal(disabledContext.res.status, 503);
    assert.equal(JSON.parse(disabledContext.res.body).code, 'FLIGHTAWARE_DISABLED');
    assert.equal(requests.length, 0);

    const enabledContext = { log: { error() {} } };
    await handler(enabledContext, {
      query: { flight: 'CX0163', arrivalAirport: 'MEL', date: '2026-09-15' },
      headers: { 'x-cargorun-flightaware-enabled': 'true' }
    });
    assert.equal(enabledContext.res.status, 200);
    assert.equal(requests.length, 2);
    assert.match(requests[0], /\/CX0163\?/);
    assert.match(requests[1], /\/CX163\?/);
    assert.equal(JSON.parse(enabledContext.res.body).matchedFlight, 'CX163');
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.FLIGHTAWARE_API_KEY;
    else process.env.FLIGHTAWARE_API_KEY = previousKey;
  }
});
