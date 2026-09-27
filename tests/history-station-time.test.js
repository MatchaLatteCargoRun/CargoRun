'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const authorization = require('../api/shared/operational-authorization');
const { loadHandler, call } = require('./helpers/operational-harness');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const historySource = fs.readFileSync(path.join(root, 'api/history/index.js'), 'utf8');

const stations = [
  { stationId: '1', stationCode: 'MEL', displayName: 'Melbourne', timeZoneId: 'Australia/Melbourne' },
  { stationId: '2', stationCode: 'AKL', displayName: 'Auckland', timeZoneId: 'Pacific/Auckland' }
];

function authorizationFixture({ denyAkl = false } = {}) {
  const capabilitiesByStation = {
    MEL: ['VIEW_HISTORY'],
    AKL: denyAkl ? [] : ['VIEW_HISTORY']
  };
  return {
    ...authorization,
    resolveActorAccess: async () => ({
      actorReference: 'history-station-time-reader',
      provisioned: true,
      stations: stations.map(station => station.stationCode),
      stationMetadata: stations,
      capabilities: ['VIEW_HISTORY'],
      globalCapabilities: [],
      capabilitiesByStation
    })
  };
}

function historyHarness(events = []) {
  const columns = ['AuditEventId', 'FlightId', 'EntityId', 'FlightNumber', 'EventType', 'Action', 'OccurredAtUtc'];
  const state = { queries: [] };

  class Request {
    constructor() { this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(source) {
      const text = String(source).replace(/\s+/g, ' ').trim();
      state.queries.push({ text, values: { ...this.values } });
      if (text.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return { recordset: columns.map(COLUMN_NAME => ({ COLUMN_NAME })) };
      }
      if (text.includes('SELECT TOP (@Limit) audit.*')) {
        const start = this.values.StartUtc.getTime();
        const end = this.values.EndUtc.getTime();
        return {
          recordset: events.filter(event => String(event.StationId) === String(this.values.StationId)
            && new Date(event.OccurredAtUtc).getTime() >= start
            && new Date(event.OccurredAtUtc).getTime() < end)
        };
      }
      throw new Error(`Unexpected History SQL: ${text}`);
    }
  }

  class ConnectionPool {
    async connect() { return this; }
    request() { return new Request(); }
    async close() {}
  }

  const type = size => size;
  return {
    sql: { ConnectionPool, NVarChar: type, VarChar: type, BigInt: 'bigint', Int: 'int', DateTime2: 'datetime2' },
    state
  };
}

function selectQuery(state) {
  return state.queries.find(entry => entry.text.includes('SELECT TOP (@Limit) audit.*'));
}

test('History derives normal, DST-short, and DST-long UTC bounds from authoritative station timezones', async () => {
  const cases = [
    ['1', '2026-07-15', '2026-07-14T14:00:00.000Z', '2026-07-15T14:00:00.000Z'],
    ['1', '2026-10-04', '2026-10-03T14:00:00.000Z', '2026-10-04T13:00:00.000Z'],
    ['1', '2026-04-05', '2026-04-04T13:00:00.000Z', '2026-04-05T14:00:00.000Z'],
    ['2', '2026-07-15', '2026-07-14T12:00:00.000Z', '2026-07-15T12:00:00.000Z'],
    ['2', '2026-09-27', '2026-09-26T12:00:00.000Z', '2026-09-27T11:00:00.000Z'],
    ['2', '2026-04-05', '2026-04-04T11:00:00.000Z', '2026-04-05T12:00:00.000Z']
  ];

  for (const [stationId, operatingDate, startUtc, endUtc] of cases) {
    const harness = historyHarness();
    const handler = loadHandler('api/history/index.js', harness.sql, authorizationFixture());
    const response = await call(handler, 'GET', null, { stationId, operatingDate });
    assert.equal(response.status, 200, `${stationId} ${operatingDate}`);
    const query = selectQuery(harness.state);
    assert.equal(query.values.StartUtc.toISOString(), startUtc, `${stationId} ${operatingDate} start`);
    assert.equal(query.values.EndUtc.toISOString(), endUtc, `${stationId} ${operatingDate} end`);
    assert.match(query.text, /audit\.\[OccurredAtUtc\] >= @StartUtc/);
    assert.match(query.text, /audit\.\[OccurredAtUtc\] < @EndUtc/);
  }
});

test('the same UTC instant belongs to different selected-station History dates without crossing station ownership', async () => {
  const instant = '2026-01-01T11:30:00.000Z';
  const events = [
    { AuditEventId: 1, FlightId: 101, EntityId: '101', FlightNumber: 'MEL101', EventType: 'Flight', Action: 'MEL event', OccurredAtUtc: instant, StationId: 1 },
    { AuditEventId: 2, FlightId: 202, EntityId: '202', FlightNumber: 'AKL202', EventType: 'Flight', Action: 'AKL event', OccurredAtUtc: instant, StationId: 2 }
  ];

  const melHarness = historyHarness(events);
  const mel = await call(loadHandler('api/history/index.js', melHarness.sql, authorizationFixture()), 'GET', null, {
    stationId: '1', operatingDate: '2026-01-01'
  });
  assert.deepEqual(mel.body.events.map(event => event.entityId), ['101']);

  const aklHarness = historyHarness(events);
  const akl = await call(loadHandler('api/history/index.js', aklHarness.sql, authorizationFixture()), 'GET', null, {
    stationId: '2', operatingDate: '2026-01-02'
  });
  assert.deepEqual(akl.body.events.map(event => event.entityId), ['202']);

  const wrongDayHarness = historyHarness(events);
  const wrongDay = await call(loadHandler('api/history/index.js', wrongDayHarness.sql, authorizationFixture()), 'GET', null, {
    stationId: '2', operatingDate: '2026-01-01'
  });
  assert.deepEqual(wrongDay.body.events, []);
});

test('legacy client UTC parameters cannot override server-derived History bounds', async () => {
  const harness = historyHarness();
  const response = await call(loadHandler('api/history/index.js', harness.sql, authorizationFixture()), 'GET', null, {
    stationId: '1', operatingDate: '2026-10-04',
    startUtc: '1999-01-01T00:00:00.000Z', endUtc: '2099-01-01T00:00:00.000Z'
  });
  assert.equal(response.status, 200);
  const query = selectQuery(harness.state);
  assert.equal(query.values.StartUtc.toISOString(), '2026-10-03T14:00:00.000Z');
  assert.equal(query.values.EndUtc.toISOString(), '2026-10-04T13:00:00.000Z');
  assert.doesNotMatch(historySource, /req\.query\?\.(?:startUtc|endUtc)/);
});

test('unauthorized station access fails before date validation or History data access', async () => {
  const harness = historyHarness();
  const response = await call(loadHandler('api/history/index.js', harness.sql, authorizationFixture({ denyAkl: true })), 'GET', null, {
    stationId: '2', operatingDate: '2026-02-30'
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'STATION_ACCESS_DENIED');
  assert.equal(harness.state.queries.length, 0);
});

function functionLine(name) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf('\n', start);
  assert.ok(start >= 0 && end > start, `${name} should exist`);
  return html.slice(start, end);
}

function sourceBetween(startText, endText) {
  const start = html.indexOf(startText);
  const end = html.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `${startText} source range should exist`);
  return html.slice(start, end);
}

test('browser History date and clock helpers use explicit selected-station IANA time', () => {
  const context = vm.createContext({ Intl, Date, Number });
  vm.runInContext([
    sourceBetween('function validStationTimeZoneId(', 'function normalizeAuthorizedStations('),
    functionLine('stationDateKeyForTimeZone'),
    'let selectedZone="Australia/Melbourne";',
    'function selectedStationTimeZone(){return selectedZone}',
    functionLine('historyDateKey'),
    functionLine('historyTime')
  ].join('\n'), context);

  const instant = '2026-01-01T11:30:00.000Z';
  assert.equal(context.historyDateKey(instant), '2026-01-01');
  vm.runInContext('selectedZone="Pacific/Auckland"', context);
  assert.equal(context.historyDateKey(instant), '2026-01-02');

  vm.runInContext('selectedZone="Australia/Melbourne"', context);
  const earlier = context.historyTime('2026-04-04T15:30:00.000Z');
  const later = context.historyTime('2026-04-04T16:30:00.000Z');
  assert.notEqual(earlier, later);
  assert.match(earlier, /02:30/);
  assert.match(later, /02:30/);
});

test('browser station date output is independent of the Node process timezone', () => {
  const source = `${sourceBetween('function validStationTimeZoneId(', 'function normalizeAuthorizedStations(')}\n${functionLine('stationDateKeyForTimeZone')}`;
  const script = `${source}\nprocess.stdout.write(stationDateKeyForTimeZone('2026-01-01T11:30:00.000Z','Pacific/Auckland'));`;
  const outputs = ['UTC', 'Australia/Melbourne', 'Pacific/Auckland', 'America/Los_Angeles'].map(timeZone => {
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', env: { ...process.env, TZ: timeZone }
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  });
  assert.deepEqual(outputs, ['2026-01-02', '2026-01-02', '2026-01-02', '2026-01-02']);
});

test('official History clients send operatingDate and never construct authoritative UTC day bounds', () => {
  assert.match(html, /selectedStationApiUrl\('\/api\/history',\{operatingDate\}\)/);
  assert.match(html, /selectedStationApiUrl\('\/api\/history',\{operatingDate:key,limit:5000\}\)/);
  assert.doesNotMatch(html, /function dayBoundsUtc\(/);
  assert.doesNotMatch(html, /selectedStationApiUrl\('\/api\/history'[^\n]*(?:startUtc|endUtc)/);
});

test('History CSV stays formula-safe and clearly scopes UTC timestamps to station and date', () => {
  const download = functionLine('downloadHistory');
  assert.match(download, /OccurredAtUtc/);
  assert.match(download, /Station/);
  assert.match(download, /OperatingDate/);
  assert.match(download, /historyEventsForSelectedDate\(\)/);
  assert.match(download, /map\(historyCsvCell\)/);
});
