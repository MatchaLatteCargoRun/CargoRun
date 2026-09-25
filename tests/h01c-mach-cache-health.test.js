'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const principal = Buffer.from(JSON.stringify({
  userRoles: ['authenticated'],
  userDetails: 'MEL Operator',
  userId: 'stable-mel-user'
})).toString('base64');

function authorizationError(code) {
  const error = new Error('The authenticated user is not authorized for this operation at the selected station');
  error.operationalAuthorization = true;
  error.status = 403;
  error.code = code;
  return error;
}

function machXml(documentCorId = 'H01C-TEST') {
  return '<FSUMessage>' +
    `<DocumentCorID>${documentCorId}</DocumentCorID>` +
    '<MessageType>FSU</MessageType><StatusCode>FOW</StatusCode>' +
    '<StsCar>CX</StsCar><StsCarNum>178</StsCarNum>' +
    '<StsDatt>17 SEP 2026</StsDatt><StsApt>MEL</StsApt>' +
    '<StsSegDep>MEL</StsSegDep><StsSegArr>HKG</StsSegArr>' +
    '<FSUMessageULDList><ULDTyp>AKE</ULDTyp><ULDSrl>12345</ULDSrl>' +
    '<ULDOwnr>CX</ULDOwnr></FSUMessageULDList></FSUMessage>';
}

function machHarness({ candidates = [], duplicate = null, allowedStations = ['MEL'] } = {}) {
  const events = [];
  const queries = [];

  class Request {
    constructor(executor) {
      this.executor = executor;
      this.values = {};
    }

    input(name, _type, value) {
      this.values[name] = value;
      return this;
    }

    async query(query) {
      const text = String(query).replace(/\s+/g, ' ').trim();
      queries.push({ text, values: { ...this.values } });

      if (text.includes('FROM dbo.Flights WHERE OperatingDate=@AuthorizationOperatingDate')) {
        events.push('flight-candidate-query');
        return { recordset: candidates };
      }
      if (text.includes('FROM dbo.IncomingMachMessages m')) {
        events.push('duplicate-query');
        return { recordset: duplicate ? [duplicate] : [] };
      }
      if (text.includes('FROM dbo.MachFowShipments')) {
        events.push('duplicate-uld-query');
        return { recordset: [{ UldNumber: 'AKE99999CX' }] };
      }

      throw new Error(`Unexpected SQL in H-01C MACH harness: ${text}`);
    }
  }

  class ConnectionPool {
    async connect() { return this; }
    request() { return new Request(this); }
    async close() {}
  }

  class Transaction {
    async begin() {}
    async rollback() {}
  }

  const type = size => size;
  const sql = {
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
    UniqueIdentifier: 'uniqueidentifier',
    MAX: -1
  };

  const authorization = {
    authenticatedActor: () => ({ displayName: 'MEL Operator', reference: 'stable-mel-user' }),
    requireOperationalStations: async () => { throw new Error('not used'); },
    bindStationParameters: () => { throw new Error('not used'); },
    flightStationPredicate: () => { throw new Error('not used'); },
    requireOperationalCapability: async (_executor, _sql, _actor, flight) => {
      const direction = String(flight?.Direction || '').toUpperCase();
      const station = String(
        direction === 'IMPORT' ? flight?.DestinationAirport : flight?.OriginAirport
      ).toUpperCase();
      events.push(`authorize:${station || 'UNKNOWN'}`);
      if (!allowedStations.includes(station)) {
        throw authorizationError('STATION_ACCESS_DENIED');
      }
      return { stationCode: station, requiredCapability: 'UPLOAD_FLIGHT_DATA' };
    },
    sendOperationalAuthorizationError: (context, error, sendJson) => {
      if (!error?.operationalAuthorization) return false;
      sendJson(context, error.status, {
        ok: false,
        code: error.code,
        error: error.message
      });
      return true;
    }
  };

  const filename = path.join(root, 'api', 'mach-fow', 'index.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    Buffer,
    console,
    process: { env: { DATABASE_CONNECTION_STRING: 'test-only' } },
    require(name) {
      if (name === 'mssql') return sql;
      if (name === '../shared/operational-authorization') return authorization;
      if (name.startsWith('../shared/')) return require(path.resolve(path.dirname(filename), name));
      return require(name);
    }
  }, { filename });

  async function invoke(documentCorId = 'H01C-TEST') {
    const context = { log: Object.assign(() => {}, { error() {}, warn() {} }) };
    await module.exports(context, {
      method: 'POST',
      body: { xml: machXml(documentCorId) },
      query: {},
      headers: { 'x-ms-client-principal': principal }
    });
    return {
      status: context.res.status,
      headers: context.res.headers,
      body: JSON.parse(context.res.body)
    };
  }

  return { events, queries, invoke };
}

test('human MACH/FOW authorizes the proposed authoritative station before searching flights', async () => {
  const harness = machHarness({ allowedStations: [] });
  const response = await harness.invoke();

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'STATION_ACCESS_DENIED');
  assert.deepEqual(harness.events, ['authorize:MEL']);
  assert.equal(harness.queries.length, 0);
  assert.equal(Object.hasOwn(response.body, 'flightIds'), false);
});

test('human MACH/FOW hides ambiguous wrong-station candidates before returning identifiers', async () => {
  const harness = machHarness({
    candidates: [
      {
        FlightId: 901,
        FlightNumber: 'CX0178',
        Direction: 'EXPORT',
        OriginAirport: 'MEL',
        DestinationAirport: 'HKG'
      },
      {
        FlightId: 902,
        FlightNumber: 'CX178',
        Direction: 'EXPORT',
        OriginAirport: 'SYD',
        DestinationAirport: 'HKG'
      }
    ]
  });
  const response = await harness.invoke();

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'STATION_ACCESS_DENIED');
  assert.deepEqual(harness.events, [
    'authorize:MEL',
    'flight-candidate-query',
    'authorize:MEL',
    'authorize:SYD'
  ]);
  assert.equal(Object.hasOwn(response.body, 'flightIds'), false);
  assert.doesNotMatch(JSON.stringify(response.body), /901|902|SYD|CX0?178/);
});

test('human MACH/FOW returns same-station conflict metadata only after every candidate is authorized', async () => {
  const harness = machHarness({
    candidates: [
      {
        FlightId: 701,
        FlightNumber: 'CX0178',
        Direction: 'EXPORT',
        OriginAirport: 'MEL',
        DestinationAirport: 'HKG'
      },
      {
        FlightId: 702,
        FlightNumber: 'CX178',
        Direction: 'EXPORT',
        OriginAirport: 'MEL',
        DestinationAirport: 'HKG'
      }
    ]
  });
  const response = await harness.invoke();

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'FLIGHT_IDENTITY_CONFLICT');
  assert.deepEqual(Array.from(response.body.flightIds), [701, 702]);
  assert.deepEqual(harness.events, [
    'authorize:MEL',
    'flight-candidate-query',
    'authorize:MEL',
    'authorize:MEL'
  ]);
});

test('human MACH/FOW reauthorizes stored duplicate-message metadata at its matched station', async () => {
  const harness = machHarness({
    duplicate: {
      MachMessageId: 77,
      DocumentCorID: 'CROSS-STATION-DUPLICATE',
      MatchedFlightId: 902,
      MatchedFlightNumber: 'CX0178',
      MatchedFlightDirection: 'EXPORT',
      MatchedFlightOriginAirport: 'SYD',
      MatchedFlightDestinationAirport: 'HKG',
      FlightNumber: 'CX0178',
      OriginAirport: 'SYD',
      DestinationAirport: 'HKG',
      ProcessingStatus: 'PROCESSED',
      SourceType: 'MACH_FOW_SIMULATOR'
    }
  });
  const response = await harness.invoke('CROSS-STATION-DUPLICATE');

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'STATION_ACCESS_DENIED');
  assert.deepEqual(harness.events, [
    'authorize:MEL',
    'flight-candidate-query',
    'duplicate-query',
    'duplicate-uld-query',
    'authorize:SYD'
  ]);
  for (const property of ['flightId', 'flightNumber', 'ulds', 'processingStatus', 'sourceType']) {
    assert.equal(Object.hasOwn(response.body, property), false, property);
  }
  assert.doesNotMatch(JSON.stringify(response.body), /902|AKE99999CX|PROCESSED|SYD/);
});

function loadFlightStatus(env, { flight = null, fetchImpl } = {}) {
  class Request {
    constructor() { this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query() { return { recordset: flight ? [flight] : [] }; }
  }
  class ConnectionPool {
    async connect() { return this; }
    request() { return new Request(); }
    async close() {}
  }
  const sql = { ConnectionPool, BigInt: 'bigint' };
  const authorization = {
    authenticatedActor: () => ({ reference: 'flight-reader' }),
    requireOperationalStations: async () => ({ stations: ['MEL'], requiredCapability: 'VIEW_FLIGHTS' }),
    requireOperationalCapability: async () => ({ stationCode: 'MEL' }),
    requireOperationalEntityCapability: async (_executor, _sql, _actor, selectedFlight) => {
      if (!selectedFlight) {
        const error = new Error('The selected operational record is unavailable');
        error.status = 404;
        error.code = 'OPERATIONAL_ENTITY_NOT_AVAILABLE';
        throw error;
      }
      return { stationCode: 'MEL' };
    },
    sendOperationalAuthorizationError: () => false
  };
  const filename = path.join(root, 'api', 'flight-status', 'index.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    Buffer,
    URL,
    Date,
    console,
    fetch: fetchImpl || (async () => { throw new Error('fetch should not run'); }),
    process: { version: 'v99.88.77-secret-runtime', env },
    require(name) {
      if (name === 'mssql') return sql;
      if (name === '../shared/operational-authorization') return authorization;
      return require(name);
    }
  }, { filename });
  return module.exports;
}

async function invoke(handler, query, headers = {}) {
  const context = { log: Object.assign(() => {}, { error() {} }) };
  await handler(context, { method: 'GET', query, headers });
  return {
    status: context.res.status,
    headers: context.res.headers,
    body: JSON.parse(context.res.body)
  };
}

test('flight-status health is generic and every response is private and non-storable', async () => {
  const handler = loadFlightStatus({});
  const health = await invoke(handler, { health: '1' });
  assert.equal(health.status, 200);
  assert.equal(health.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(health.body, { ok: true, status: 'healthy' });
  assert.doesNotMatch(JSON.stringify(health.body), /v99|runtime|flightaware|configured/i);

  const database = await invoke(handler, { dbhealth: '1' });
  assert.equal(database.status, 503);
  assert.equal(database.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(database.body, { ok: false, status: 'unavailable' });
  assert.doesNotMatch(JSON.stringify(database.body), /DATABASE_CONNECTION_STRING|connection/i);
});

test('authorized FlightAware data and unavailable-provider errors are private and non-storable', async () => {
  const flight = {
    FlightId: 101,
    FlightNumber: 'CX0163',
    OperatingDate: '2026-09-15',
    Direction: 'IMPORT',
    OriginAirport: 'HKG',
    DestinationAirport: 'MEL'
  };
  const unavailable = loadFlightStatus({ DATABASE_CONNECTION_STRING: 'test-only' }, { flight });
  const unavailableResponse = await invoke(unavailable, { flightId: '101' }, {
    'x-cargorun-flightaware-enabled': 'true'
  });
  assert.equal(unavailableResponse.status, 503);
  assert.equal(unavailableResponse.headers['Cache-Control'], 'private, no-store');
  assert.equal(unavailableResponse.body.code, 'SERVICE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(unavailableResponse.body), /FLIGHTAWARE_API_KEY|Azure|configured/i);

  const available = loadFlightStatus({
    DATABASE_CONNECTION_STRING: 'test-only',
    FLIGHTAWARE_API_KEY: 'test-key'
  }, {
    flight,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        flights: [{
          ident_iata: 'CX163',
          status: 'En Route',
          destination: { code_iata: 'MEL' },
          scheduled_in: '2026-09-15T10:00:00Z'
        }]
      })
    })
  });
  const availableResponse = await invoke(available, { flightId: '101' }, {
    'x-cargorun-flightaware-enabled': 'true'
  });
  assert.equal(availableResponse.status, 200);
  assert.equal(availableResponse.headers['Cache-Control'], 'private, no-store');
  assert.equal(availableResponse.body.matchedFlight, 'CX163');
});

function loadDbHealth(sql, env) {
  const filename = path.join(root, 'api', 'db-health', 'index.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    console,
    process: { env },
    require(name) {
      if (name === 'mssql') return sql;
      return require(name);
    }
  }, { filename });
  return module.exports;
}

async function invokeDbHealth(handler) {
  const context = { log: Object.assign(() => {}, { error() {} }) };
  await handler(context);
  return {
    status: context.res.status,
    headers: context.res.headers,
    body: JSON.parse(context.res.body)
  };
}

test('database health exposes only generic states and no configuration or schema details', async () => {
  const missing = await invokeDbHealth(loadDbHealth({}, {}));
  assert.equal(missing.status, 503);
  assert.deepEqual(missing.body, { ok: false, status: 'unavailable' });

  const healthy = await invokeDbHealth(loadDbHealth({
    connect: async () => ({
      request: () => ({ query: async () => ({ recordset: [{ DatabaseReachable: 1 }] }) }),
      close: async () => {}
    })
  }, { DATABASE_CONNECTION_STRING: 'test-only' }));
  assert.equal(healthy.status, 200);
  assert.deepEqual(healthy.body, { ok: true, status: 'healthy' });

  const unhealthy = await invokeDbHealth(loadDbHealth({
    connect: async () => { throw new Error('Invalid object name dbo.SecretTable'); }
  }, { DATABASE_CONNECTION_STRING: 'test-only' }));
  assert.equal(unhealthy.status, 503);
  assert.deepEqual(unhealthy.body, { ok: false, status: 'unhealthy' });

  for (const response of [missing, healthy, unhealthy]) {
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /DATABASE_CONNECTION_STRING|dbo\.|table|column|serverTime|databaseReachable/i
    );
  }
});

test('operational API sources contain no public or shared-cache directives', () => {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
    }
  };
  visit(path.join(root, 'api'));

  const sharedCache = /(?:Cache-Control[^\r\n]{0,120})?(?:\bpublic\s*,\s*max-age\b|\bs-maxage\b)/i;
  for (const file of files) {
    assert.doesNotMatch(
      fs.readFileSync(file, 'utf8'),
      sharedCache,
      path.relative(root, file)
    );
  }
});
