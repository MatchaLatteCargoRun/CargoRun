'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const actualAuthorization = require('../api/shared/operational-authorization');
const flightHelpers = require('../api/shared/flight');
const { normalizeUldNumber } = require('../api/shared/uld');
const { insertAuditEvent } = require('../api/shared/audit');
const completionAmendments = require('../api/shared/completion-amendments');
const completionSnapshot = require('../api/shared/completion-snapshot');
const flightStatementEvidence = require('../api/shared/flight-statement-evidence');
const offloadEligibility = require('../api/shared/offload-eligibility');
const exportManifestFinal = require('../api/shared/export-manifest-final');
const exportUws = require('../api/shared/export-uws');
const stationHelpers = require('./helpers/station-stub');
const { sqlHarness, loadHandler: loadOperationalHandler, call } = require('./helpers/operational-harness');

const root = path.resolve(__dirname, '..');
const principal = Buffer.from(JSON.stringify({
  userId: 'confidentiality-test-user',
  userDetails: 'Confidentiality Tester',
  userRoles: ['authenticated'],
  identityProvider: 'aad'
})).toString('base64');

function authorizationError(code) {
  return new actualAuthorization.OperationalAuthorizationError(
    code,
    code === 'STATION_ACCESS_DENIED'
      ? 'The operational station could not be authorized'
      : 'The authenticated user is not authorized for this operation at an enabled station',
    403
  );
}

function stationAuthorization(stations, options = {}) {
  const allowed = new Set(stations);
  const state = { capabilityChecks: [], stationChecks: [] };
  const requireOperationalCapability = async (_executor, _sql, actor, flight, capability) => {
    state.capabilityChecks.push({ flight, capability });
    if (options.denyExact || options.unprovisioned) {
      throw authorizationError(options.unprovisioned ? 'CAPABILITY_REQUIRED' : 'STATION_ACCESS_DENIED');
    }
    const stationCode = actualAuthorization.stationForFlight(flight);
    if (!allowed.has(stationCode)) throw authorizationError('STATION_ACCESS_DENIED');
    return { actorReference: actor.reference, stationCode, requiredCapability: capability };
  };
  return {
    state,
    module: {
      ...actualAuthorization,
      requireOperationalStations: async (_executor, _sql, _actor, capability) => {
        state.stationChecks.push(capability);
        if (options.unprovisioned) throw authorizationError('CAPABILITY_REQUIRED');
        return { stations: [...allowed], requiredCapability: capability };
      },
      requireOperationalCapability,
      requireOperationalEntityCapability: async (executor, sql, actor, flight, capability) => {
        if (!flight) throw actualAuthorization.operationalEntityUnavailable();
        try {
          return await requireOperationalCapability(executor, sql, actor, flight, capability);
        } catch (error) {
          if (error?.status === 403) throw actualAuthorization.operationalEntityUnavailable();
          throw error;
        }
      }
    }
  };
}

function loadHandler(relativePath, sqlMock, authorization) {
  const filename = path.join(root, relativePath);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    Buffer,
    URLSearchParams,
    console,
    process: { env: { DATABASE_CONNECTION_STRING: 'test-only' } },
    require(name) {
      if (name === 'mssql') return sqlMock;
      if (name === '../shared/operational-authorization') return authorization;
      if (name === '../shared/flight') return flightHelpers;
      if (name === '../shared/document-cor-id') return require('../api/shared/document-cor-id');
      if (name === '../shared/uld') return { normalizeUldNumber };
      if (name === '../shared/audit') return { insertAuditEvent };
      if (name === '../shared/completion-amendments') return completionAmendments;
      if (name === '../shared/completion-snapshot') return completionSnapshot;
      if (name === '../shared/flight-statement-evidence') return flightStatementEvidence;
      if (name === '../shared/offload-eligibility') return offloadEligibility;
      if (name === '../shared/export-manifest-final') return exportManifestFinal;
      if (name === '../shared/export-uws') return exportUws;
      if (name === '../shared/station') return stationHelpers;
      return require(name);
    }
  }, { filename });
  return module.exports;
}

async function invoke(handler, method, body, query = {}) {
  const context = { log: Object.assign(() => {}, { error() {}, warn() {} }) };
  await handler(context, {
    method,
    body,
    query,
    headers: { 'x-ms-client-principal': principal }
  });
  return { status: context.res.status, body: JSON.parse(context.res.body) };
}

function identitySql(flights) {
  const state = { queries: [], commits: 0, rollbacks: 0 };

  class Transaction {
    async begin() { this.active = true; }
    async commit() { this.active = false; state.commits += 1; }
    async rollback() {
      if (this.active) {
        this.active = false;
        state.rollbacks += 1;
      }
    }
  }

  class Request {
    constructor(executor) { this.executor = executor; this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(query) {
      const text = String(query).replace(/\s+/g, ' ').trim();
      state.queries.push({ text, values: { ...this.values } });
      const result = (recordset = [], rowsAffected = []) => ({ recordset, rowsAffected });
      if (text.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return result([{ COLUMN_NAME: 'FlightId', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, IS_IDENTITY: 0 }]);
      }
      if (text.includes('sys.sp_getapplock')) return result([{ LockResult: 0 }]);
      if (text.includes('FROM dbo.Flights')) {
        const exactId = this.values.InitialFlightId ?? this.values.LockedFlightId ??
          this.values.FlightId ?? this.values.SelectedFlightId;
        if (exactId !== undefined) {
          return result(flights.filter(flight => String(flight.FlightId) === String(exactId)));
        }
        const operatingDate = this.values.OperatingDate ?? this.values.UwsOperatingDate ??
          this.values.LockedUwsOperatingDate;
        return result(flights.filter(flight => !operatingDate ||
          String(flight.OperatingDateIso || flight.OperatingDate).slice(0, 10) === String(operatingDate)));
      }
      if (text.includes('FROM dbo.ExportManifestFinals')) return result([]);
      throw new Error(`Unexpected confidentiality SQL: ${text}`);
    }
  }

  class ConnectionPool {
    async connect() { return this; }
    request() { return new Request(this); }
    async close() {}
  }

  const type = size => size;
  return {
    state,
    sql: {
      ConnectionPool,
      Transaction,
      Request,
      BigInt: 'bigint',
      Int: 'int',
      Bit: 'bit',
      Date: 'date',
      DateTime2: type,
      VarChar: type,
      NVarChar: type,
      Decimal: type,
      Char: type,
      UniqueIdentifier: 'uniqueidentifier',
      MAX: -1
    }
  };
}

function flight(overrides = {}) {
  return {
    FlightId: 71,
    FlightNumber: 'CX178',
    OperatingDate: '2026-09-17',
    OperatingDateIso: '2026-09-17',
    Direction: 'EXPORT',
    OriginAirport: 'MEL',
    DestinationAirport: 'HKG',
    FlightStatus: 'ACTIVE',
    ...overrides
  };
}

function creationBody(route) {
  const proposed = {
    flightNumber: 'CX0178',
    operatingDate: '2026-09-17',
    direction: 'EXPORT',
    airlineCode: 'CX',
    originAirport: 'MEL',
    destinationAirport: 'HKG'
  };
  return route === 'api/flights/index.js'
    ? proposed
    : { flight: { ...proposed, sourceFileName: 'manifest.xlsx' }, ulds: [{ uldNumber: 'AKE12345CX' }] };
}

function row(size, values) {
  const result = Array(size).fill('');
  for (const [index, value] of Object.entries(values)) result[Number(index)] = value;
  return result;
}

function uwsWorkbook() {
  return { sheets: [{ name: 'UWS', rows: [
    row(30, { 1: 'CX', 5: 'ULD/BULK LOAD WEIGHT STATEMENT' }),
    row(30, { 1: 'STATION', 5: 'FLIGHT NO', 24: 'DATE' }),
    row(30, { 1: 'MEL', 5: 'CX0134', 24: '19-Sep-2026' }),
    row(30, { 1: 'UNIT LOAD DEVICES(ULD)' }),
    row(30, { 2: 'Number', 4: 'Unload Station', 5: 'Pcs', 11: 'Gross Weight' }),
    row(30, { 2: 'AKE47186CX', 4: 'HKG', 5: 1, 11: 1470 })
  ] }] };
}

test('offload stale status is disclosed only after broad capability and exact stored-flight authorization', async () => {
  const offload = {
    OffloadId: '90', FlightId: '71', UldId: '7', UldNumber: 'AKE12345CX', Status: 'TRANSIT'
  };
  const denied = stationAuthorization(['MEL'], { denyExact: true });
  const harness = sqlHarness({ flights: [flight()], offload });
  const response = await call(
    loadOperationalHandler('api/offloads/index.js', harness.sql, denied.module),
    'PATCH',
    { offloadId: '90', expectedCurrentStatus: 'REQUESTED', nextStatus: 'COMPLETE', deliveredLocation: 'Cool room' }
  );
  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'OPERATIONAL_ENTITY_NOT_AVAILABLE');
  assert.equal(Object.hasOwn(response.body, 'currentStatus'), false);
  assert.equal(Object.hasOwn(response.body, 'expectedNext'), false);
  assert.equal(harness.state.offload.Status, 'TRANSIT');
  assert.deepEqual(denied.state.stationChecks, ['COMPLETE_OFFLOAD']);
  assert.equal(denied.state.capabilityChecks[0].capability, 'COMPLETE_OFFLOAD');

  const unprovisioned = stationAuthorization([], { unprovisioned: true });
  const secondHarness = sqlHarness({ flights: [flight()], offload });
  const secondResponse = await call(
    loadOperationalHandler('api/offloads/index.js', secondHarness.sql, unprovisioned.module),
    'PATCH',
    { offloadId: '90', expectedCurrentStatus: 'REQUESTED', nextStatus: 'TRANSIT' }
  );
  assert.equal(secondResponse.status, 403);
  assert.equal(secondResponse.body.code, 'CAPABILITY_REQUIRED');
  assert.equal(secondHarness.state.queries.some(entry => entry.q.startsWith('SELECT * FROM dbo.Offloads')), false);
});

test('flight and manifest creation hide cross-station candidates while preserving authorized duplicate identities', async () => {
  for (const route of ['api/flights/index.js', 'api/manifest-upload/index.js']) {
    const crossStation = identitySql([flight({ OriginAirport: 'SYD' })]);
    const mel = stationAuthorization(['MEL']);
    const denied = await invoke(
      loadHandler(route, crossStation.sql, mel.module),
      'POST',
      creationBody(route)
    );
    assert.equal(denied.status, 409, route);
    assert.equal(denied.body.code, 'FLIGHT_IDENTITY_CONFLICT', route);
    assert.equal(Object.hasOwn(denied.body, 'flightId'), false, route);
    assert.equal(Object.hasOwn(denied.body, 'flightIds'), false, route);
    assert.doesNotMatch(JSON.stringify(denied.body), /SYD|ACTIVE|71/, route);

    const noAccessSql = identitySql([flight({ OriginAirport: 'SYD' })]);
    const noAccess = stationAuthorization([], { unprovisioned: true });
    const unprovisioned = await invoke(
      loadHandler(route, noAccessSql.sql, noAccess.module),
      'POST',
      creationBody(route)
    );
    assert.equal(unprovisioned.status, 403, route);
    assert.equal(unprovisioned.body.code, 'CAPABILITY_REQUIRED', route);
    assert.equal(noAccessSql.state.queries.some(entry => entry.text.includes('FROM dbo.Flights')), false, route);

    const sameStation = identitySql([flight()]);
    const authorized = await invoke(
      loadHandler(route, sameStation.sql, stationAuthorization(['MEL']).module),
      'POST',
      creationBody(route)
    );
    assert.equal(authorized.status, 409, route);
    assert.equal(String(authorized.body.flightId), '71', route);
  }
});

test('UWS matching authorizes every exact dated candidate before emitting match metadata', async () => {
  const uwsFlight = flight({
    FlightId: 82,
    FlightNumber: 'CX134',
    OperatingDate: '2026-09-19',
    OperatingDateIso: '2026-09-19',
    OriginAirport: 'SYD'
  });
  for (const rows of [
    [uwsFlight],
    [flight({ FlightId: 81, FlightNumber: 'CX134', OperatingDate: '2026-09-19', OperatingDateIso: '2026-09-19' }), uwsFlight]
  ]) {
    const harness = identitySql(rows);
    const response = await invoke(
      loadHandler('api/manifest-upload/index.js', harness.sql, stationAuthorization(['MEL']).module),
      'POST',
      { action: 'PARSE_EXPORT_UWS', sourceFileName: 'UWS.xlsx', workbook: uwsWorkbook() }
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'STATION_ACCESS_DENIED');
    assert.equal(Object.hasOwn(response.body, 'flightIds'), false);
    assert.equal(Object.hasOwn(response.body, 'exactMatch'), false);
    assert.doesNotMatch(JSON.stringify(response.body), /SYD|ACTIVE|82/);
    assert.equal(harness.state.queries.some(entry => entry.text.includes('FROM dbo.ExportManifestFinals')), false);
  }
});

test('completion and export FINAL handlers authorize loaded flights before direction or status validation', async () => {
  const incompatible = flight({ Direction: 'TRANSFER', FlightStatus: 'FINALISED' });
  const cases = [
    ['api/import-completions/index.js', { flightId: '71' }],
    ['api/export-completions/index.js', { flightId: '71' }],
    ['api/export-manifest-final/index.js', {
      action: 'CONFIRM', flightId: '71', sourceFileName: 'FINAL.xlsx',
      ulds: [{ uldNumber: 'AKE12345CX' }]
    }]
  ];
  for (const [route, body] of cases) {
    const harness = identitySql([incompatible]);
    const response = await invoke(
      loadHandler(route, harness.sql, stationAuthorization([], { denyExact: true }).module),
      'POST',
      body
    );
    assert.equal(response.status, 404, route);
    assert.equal(response.body.code, 'OPERATIONAL_ENTITY_NOT_AVAILABLE', route);
    assert.doesNotMatch(JSON.stringify(response.body), /TRANSFER|FINALISED|Only import|Only export|active/i, route);
  }
});
