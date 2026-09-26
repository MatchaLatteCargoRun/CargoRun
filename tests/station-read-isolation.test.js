'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const authorization = require('../api/shared/operational-authorization');
const { loadHandler, call } = require('./helpers/operational-harness');

const root = path.resolve(__dirname, '..');
const allCapabilities = ['VIEW_FLIGHTS', 'VIEW_HISTORY', 'VIEW_FLIGHT_STATEMENT', 'VIEW_SUPERVISOR'];

function accessFixture({ limitedAkl = false } = {}) {
  return {
    actorReference: 'station-reader',
    provisioned: true,
    stations: ['AKL', 'MEL'],
    stationMetadata: [
      { stationId: '1', stationCode: 'MEL', displayName: 'Melbourne', timeZoneId: 'Australia/Melbourne' },
      { stationId: '2', stationCode: 'AKL', displayName: 'Auckland', timeZoneId: 'Pacific/Auckland' }
    ],
    capabilities: allCapabilities,
    globalCapabilities: [],
    capabilitiesByStation: {
      MEL: allCapabilities,
      AKL: limitedAkl ? ['VIEW_FLIGHTS'] : allCapabilities
    }
  };
}

function authorizationFixture(options) {
  const access = accessFixture(options);
  return {
    ...authorization,
    resolveActorAccess: async () => access,
    requireOperationalStations: async (_executor, _sql, _actor, requiredCapability) => ({
      ...access, requiredCapability
    })
  };
}

function isolationSqlHarness() {
  const flights = [
    { FlightId: 101, StationId: 1, FlightNumber: 'CX123', OperatingDate: '2026-10-01', Direction: 'EXPORT', OriginAirport: 'MEL', DestinationAirport: 'HKG', FlightStatus: 'ACTIVE' },
    { FlightId: 202, StationId: 2, FlightNumber: 'CX123', OperatingDate: '2026-10-01', Direction: 'EXPORT', OriginAirport: 'AKL', DestinationAirport: 'HKG', FlightStatus: 'ACTIVE' }
  ];
  const offloads = [
    { OffloadId: 301, FlightId: 101, UldId: 401, UldNumber: 'AKE12345CX', Status: 'REQUESTED' },
    { OffloadId: 302, FlightId: 202, UldId: 402, UldNumber: 'AKE12345CX', Status: 'REQUESTED' }
  ];
  const events = [
    { AuditEventId: 501, FlightId: 101, EntityId: '101', FlightNumber: 'CX123', EventType: 'Flight', Action: 'Updated', OccurredAtUtc: '2026-10-01T00:00:00Z' },
    { AuditEventId: 502, FlightId: 202, EntityId: '202', FlightNumber: 'CX123', EventType: 'Flight', Action: 'Updated', OccurredAtUtc: '2026-10-01T00:00:00Z' }
  ];
  const imports = [
    { ImportCompletionRecordId: 601, FlightId: 101, FinalisedAtUtc: '2026-10-01T01:00:00Z' },
    { ImportCompletionRecordId: 602, FlightId: 202, FinalisedAtUtc: '2026-10-01T01:00:00Z' }
  ];
  const exports = [
    { CompletionId: 701, FlightId: 101, FinalisedAtUtc: '2026-10-01T02:00:00Z' },
    { CompletionId: 702, FlightId: 202, FinalisedAtUtc: '2026-10-01T02:00:00Z' }
  ];
  const messages = [
    { MachMessageId: 801, StationId: 1, MatchedFlightId: 101, DocumentCorID: 'MEL-801', FlightNumber: 'CX123', SourceType: 'MACH_FOW_LIVE' },
    { MachMessageId: 802, StationId: 2, MatchedFlightId: 202, DocumentCorID: 'AKL-802', FlightNumber: 'CX123', SourceType: 'MACH_FOW_LIVE' }
  ];
  const schemas = {
    Offloads: ['OffloadId', 'FlightId', 'UldId', 'UldNumber', 'Status'],
    AuditEvents: ['AuditEventId', 'FlightId', 'EntityId', 'FlightNumber', 'EventType', 'Action', 'OccurredAtUtc'],
    ImportCompletionRecords: ['ImportCompletionRecordId', 'FlightId', 'FinalisedAtUtc'],
    ExportCompletionRecords: ['CompletionId', 'FlightId', 'FinalisedAtUtc']
  };
  const state = { queries: [] };
  const stationForFlight = flightId => flights.find(row => String(row.FlightId) === String(flightId))?.StationId;
  const flightNumber = flightId => flights.find(row => String(row.FlightId) === String(flightId))?.FlightNumber;

  class Request {
    constructor() { this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(source) {
      const text = String(source).replace(/\s+/g, ' ').trim();
      const stationId = String(this.values.StationId ?? this.values.SelectedStationId ?? '');
      state.queries.push({ text, values: { ...this.values } });
      if (text.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return { recordset: (schemas[this.values.TableName] || []).map(COLUMN_NAME => ({
          COLUMN_NAME, IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, DATA_TYPE: 'nvarchar', IS_IDENTITY: 0
        })) };
      }
      if (text.includes('LEFT JOIN dbo.ExportManifestFinals')) {
        return { recordset: flights.filter(row => String(row.StationId) === stationId) };
      }
      if (text.includes('CONVERT(varchar(20), f.FlightId) AS FlightId')) {
        return { recordset: flights.filter(row => String(row.StationId) === stationId) };
      }
      if (text.includes('FROM dbo.Offloads AS o') && text.includes('f.StationId=@StationId')) {
        return { recordset: offloads.filter(row => String(stationForFlight(row.FlightId)) === stationId) };
      }
      if (text.includes('SELECT TOP (@Limit) audit.*')) {
        return { recordset: events.filter(row => String(stationForFlight(row.FlightId)) === stationId) };
      }
      if (text.includes('FROM dbo.ImportCompletionRecords i')) {
        return { recordset: imports.filter(row => String(stationForFlight(row.FlightId)) === stationId)
          .map(row => {
            const owner = accessFixture().stationMetadata.find(station => station.stationId === String(stationForFlight(row.FlightId)));
            return { ...row, __FlightNumber: flightNumber(row.FlightId), __StationId: owner.stationId,
              __StationCode: owner.stationCode, __StationDisplayName: owner.displayName, __TimeZoneId: owner.timeZoneId };
          }) };
      }
      if (text.includes('FROM dbo.ExportCompletionRecords e')) {
        return { recordset: exports.filter(row => String(stationForFlight(row.FlightId)) === stationId)
          .map(row => ({ ...row, __FlightNumber: flightNumber(row.FlightId) })) };
      }
      if (text.includes('SELECT TOP 50') && text.includes('FROM dbo.IncomingMachMessages m')) {
        return { recordset: messages.filter(row => String(row.StationId) === stationId && String(stationForFlight(row.MatchedFlightId)) === stationId) };
      }
      if (text.includes('AS LiveMessageCount') && text.includes('FROM dbo.IncomingMachMessages m')) {
        const rows = messages.filter(row => String(row.StationId) === stationId && String(stationForFlight(row.MatchedFlightId)) === stationId);
        return { recordset: [{ LiveMessageCount: rows.length, LastLiveReceivedAtUtc: null }] };
      }
      throw new Error(`Unexpected isolation SQL: ${text.slice(0, 180)}`);
    }
  }
  class ConnectionPool {
    async connect() { return this; }
    request() { return new Request(); }
    async close() {}
  }
  const type = size => size;
  return {
    sql: { ConnectionPool, Request, BigInt: 'bigint', Int: 'int', DateTime2: type, NVarChar: type, VarChar: type, MAX: -1 },
    state
  };
}

function endpointCases() {
  return [
    { name: 'flights', file: 'api/flights/index.js', query: {}, ids: body => body.flights.map(row => String(row.FlightId)) },
    { name: 'offloads', file: 'api/offloads/index.js', query: {}, ids: body => body.offloads.map(row => String(row.flightId)) },
    { name: 'eligible flights', file: 'api/offloads/index.js', query: { eligibleFlights: 'true' }, ids: body => body.flights.map(row => String(row.flightId)) },
    { name: 'history', file: 'api/history/index.js', query: { operatingDate: '2026-10-01' }, ids: body => body.events.map(row => String(row.entityId)) },
    { name: 'import completions', file: 'api/import-completions/index.js', query: {}, ids: body => body.records.map(row => String(row.flightId)) },
    { name: 'export completions', file: 'api/export-completions/index.js', query: {}, ids: body => body.records.map(row => String(row.flightId)) },
    { name: 'human MACH/FOW', file: 'api/mach-fow/index.js', query: {}, ids: body => body.messages.map(row => String(row.MatchedFlightId)) }
  ];
}

test('every broad operational read fails closed for missing, malformed, unauthorized, or misnamed station context', async () => {
  const invalidQueries = [
    {}, { stationId: '' }, { stationId: '0' }, { stationId: '-1' }, { stationId: 'abc' },
    { stationId: '9223372036854775808' }, { stationId: '3' }, { stationId: '4' },
    { station: '1' }, { stationCode: 'MEL' }
  ];
  for (const endpoint of endpointCases()) {
    for (const invalidQuery of invalidQueries) {
      const harness = isolationSqlHarness();
      const handler = loadHandler(endpoint.file, harness.sql, authorizationFixture());
      const response = await call(handler, 'GET', null, { ...endpoint.query, ...invalidQuery });
      assert.equal(response.status, 403, `${endpoint.name}: ${JSON.stringify(invalidQuery)}`);
      assert.equal(response.body.code, 'STATION_ACCESS_DENIED', endpoint.name);
      assert.equal(harness.state.queries.length, 0, `${endpoint.name} queried operational data before station authorization`);
    }
  }
});

test('equal-looking MEL and AKL records stay isolated by authoritative StationId in every broad read', async () => {
  for (const endpoint of endpointCases()) {
    for (const [stationId, expectedFlightId, misleadingRoute] of [['1', '101', 'AKL'], ['2', '202', 'MEL']]) {
      const harness = isolationSqlHarness();
      const handler = loadHandler(endpoint.file, harness.sql, authorizationFixture());
      const response = await call(handler, 'GET', null, {
        ...endpoint.query, stationId, stationCode: misleadingRoute,
        originAirport: misleadingRoute, destinationAirport: misleadingRoute
      });
      assert.equal(response.status, 200, endpoint.name);
      assert.deepEqual(endpoint.ids(response.body), [expectedFlightId], endpoint.name);
      const operationalQueries = harness.state.queries.filter(entry => !entry.text.includes('INFORMATION_SCHEMA.COLUMNS'));
      assert.ok(operationalQueries.length > 0, endpoint.name);
      assert.ok(operationalQueries.every(entry => String(entry.values.StationId ?? entry.values.SelectedStationId) === stationId), endpoint.name);
    }
  }
});

test('Import completion report records carry authoritative owning-station display metadata', async () => {
  const harness = isolationSqlHarness();
  const handler = loadHandler('api/import-completions/index.js', harness.sql, authorizationFixture());
  const response = await call(handler, 'GET', null, { stationId: '2' });
  assert.equal(response.status, 200);
  assert.equal(response.body.records.length, 1);
  assert.deepEqual(
    {
      stationId: response.body.records[0].stationId,
      stationCode: response.body.records[0].stationCode,
      displayName: response.body.records[0].displayName,
      timeZoneId: response.body.records[0].timeZoneId
    },
    { stationId: '2', stationCode: 'AKL', displayName: 'Auckland', timeZoneId: 'Pacific/Auckland' }
  );
});

test('aggregate capabilities cannot authorize a station that lacks the requested capability', async () => {
  const authorizationOverride = authorizationFixture({ limitedAkl: true });
  const flightsHarness = isolationSqlHarness();
  const flights = await call(loadHandler('api/flights/index.js', flightsHarness.sql, authorizationOverride), 'GET', null, { stationId: '2' });
  assert.equal(flights.status, 200);
  assert.deepEqual(flights.body.flights.map(row => String(row.FlightId)), ['202']);

  const deniedHarness = isolationSqlHarness();
  const denied = await call(loadHandler('api/history/index.js', deniedHarness.sql, authorizationOverride), 'GET', null, { stationId: '2' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'STATION_ACCESS_DENIED');
  assert.equal(deniedHarness.state.queries.length, 0);

  const allowedHarness = isolationSqlHarness();
  const allowed = await call(loadHandler('api/history/index.js', allowedHarness.sql, authorizationOverride), 'GET', null, { stationId: '1', operatingDate: '2026-10-01' });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body.events.map(row => row.entityId), ['101']);
});

test('production sources apply exact StationId predicates and preserve exact-entity authorization', () => {
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const contracts = [
    ['api/flights/index.js', /WHERE f\.StationId=@StationId/],
    ['api/offloads/index.js', /WHERE f\.StationId=@StationId/],
    ['api/offloads/index.js', /AND f\.StationId=@SelectedStationId/],
    ['api/history/index.js', /flight\.StationId=@StationId/],
    ['api/import-completions/index.js', /WHERE f\.StationId=@StationId/],
    ['api/export-completions/index.js', /WHERE f\.StationId=@StationId/],
    ['api/mach-fow/index.js', /m\.StationId=@StationId\s+AND f\.StationId=@StationId/]
  ];
  for (const [file, predicate] of contracts) {
    const source = read(file);
    assert.match(source, /authorizeRequestedStation/, file);
    assert.match(source, /req\.query\?\.stationId/, file);
    assert.match(source, predicate, file);
  }
  assert.match(read('api/offloads/index.js'), /requireOperationalEntityCapability/);
  assert.match(read('api/flights/index.js'), /requireOperationalEntityCapability/);
  const mach = read('api/mach-fow/index.js');
  assert.match(mach, /machineAuth\(req\)/);
  assert.equal((mach.match(/x\.FlightId\s*=\s*f\.FlightId/g) || []).length, 2);
});
