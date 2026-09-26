'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { insertAuditEvent } = require('../api/shared/audit');
const operationalAuthorization = require('./helpers/operational-authorization-stub');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const historySource = fs.readFileSync(path.join(root, 'api/history/index.js'), 'utf8');
const historyConfig = JSON.parse(fs.readFileSync(path.join(root, 'api/history/function.json'), 'utf8'));
const principal = Buffer.from(JSON.stringify({
  userDetails: 'History Reader',
  userId: 'history-reader-id',
  userRoles: ['authenticated']
})).toString('base64');

function sourceBetween(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source range ${start} -> ${end}`);
  return html.slice(from, to);
}

function functionLine(name) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf('\n', start);
  assert.ok(start >= 0 && end > start, `${name} should exist`);
  return html.slice(start, end);
}

function loadHistoryHandler(sqlMock) {
  const module = { exports: {} };
  vm.runInNewContext(historySource, {
    module,
    exports: module.exports,
    Buffer,
    console,
    process: { env: { DATABASE_CONNECTION_STRING: 'test-only' } },
    require(name) {
      if (name === 'mssql') return sqlMock;
      if (name === '../shared/operational-authorization') return operationalAuthorization;
      throw new Error(`Unexpected require: ${name}`);
    }
  }, { filename: path.join(root, 'api/history/index.js') });
  return module.exports;
}

function historySqlHarness() {
  const columns = [
    'AuditEventId', 'OccurredAtUtc', 'EventType', 'Action', 'ActorDisplayName',
    'ActorReference', 'EntityType', 'EntityId', 'FlightNumber', 'UldNumber',
    'FlightId', 'FromStatus', 'ToStatus', 'Detail', 'DetailsJson'
  ];
  const state = { connections: 0, queries: [] };
  const event = {
    AuditEventId: 77,
    OccurredAtUtc: '2026-09-24T23:30:00.000Z',
    EventType: 'ULD',
    Action: 'Status changed',
    ActorDisplayName: 'Operator One',
    ActorReference: 'operator-one-id',
    EntityType: 'ULD',
    EntityId: '7001',
    FlightId: '1001',
    FlightNumber: 'CX134',
    UldNumber: 'AKE12345CX',
    FromStatus: 'ARRIVED',
    ToStatus: 'RECEIVED',
    Detail: 'ULD received',
    DetailsJson: JSON.stringify({ flightId: '1001', uldId: '7001' })
  };

  class Request {
    constructor() { this.parameters = {}; }
    input(name, _type, value) { this.parameters[name] = value; return this; }
    async query(text) {
      const query = String(text);
      state.queries.push({ query, parameters: { ...this.parameters } });
      if (query.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return {
          recordset: columns.map(COLUMN_NAME => ({
            COLUMN_NAME,
            IS_NULLABLE: 'YES',
            COLUMN_DEFAULT: null,
            DATA_TYPE: 'nvarchar',
            IS_IDENTITY: COLUMN_NAME === 'AuditEventId' ? 1 : 0
          }))
        };
      }
      if (query.includes('SELECT TOP (@Limit) audit.*') && query.includes('INNER JOIN dbo.Flights')) {
        return { recordset: [event] };
      }
      throw new Error(`Unexpected History SQL: ${query}`);
    }
  }

  class ConnectionPool {
    async connect() { state.connections += 1; return this; }
    request() { return new Request(); }
    async close() {}
  }

  const sql = {
    ConnectionPool,
    NVarChar: length => `nvarchar(${length})`,
    VarChar: length => `varchar(${length})`,
    Int: 'int',
    DateTime2: 'datetime2'
  };
  return { sql, state };
}

async function callHistory(handler, method, body = null, query = {}) {
  const context = { log: { error() {} } };
  await handler(context, {
    method,
    body,
    query,
    headers: { 'x-ms-client-principal': principal }
  });
  return {
    status: context.res.status,
    headers: context.res.headers,
    body: JSON.parse(context.res.body)
  };
}

function historyFrontendHarness(events) {
  const context = vm.createContext({
    String,
    historySearch: '',
    historyFilter: 'All',
    historyUserFilter: 'All',
    CARGORUN_MASCOT: 'mascot.png',
    isMobileUI: () => false,
    mobileHistoryScreen: () => '<mobile-history />',
    historyFilteredEvents: () => events,
    historyDateKeys: () => ['2026-09-24'],
    historyUsers: () => [],
    visibleCompletionsForDate: () => [],
    dayStats: () => ({ events, actions: events.length, offloads: 0, flights: 1 }),
    historyDayOpen: () => true,
    dateKeyLabel: () => '24 Sep 2026',
    fmtTime: () => '10:30'
  });
  for (const name of ['esc', 'safeClassToken', 'eventDescription']) {
    vm.runInContext(functionLine(name), context);
  }
  vm.runInContext(sourceBetween('function historyScreen(', 'function setHistoryFilter('), context);
  return context;
}

test('GET /api/history remains authenticated, bounded, and returns normalized stable identifiers', async () => {
  const harness = historySqlHarness();
  const handler = loadHistoryHandler(harness.sql);
  const response = await callHistory(handler, 'GET', null, {
    stationId: '1',
    limit: '9000',
    startUtc: '2026-09-24T00:00:00.000Z',
    endUtc: '2026-09-25T00:00:00.000Z'
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.count, 1);
  assert.deepEqual(response.body.events[0], {
    id: '77',
    ts: '2026-09-24T23:30:00.000Z',
    type: 'ULD',
    action: 'Status changed',
    user: 'Operator One',
    actorReference: 'operator-one-id',
    entityType: 'ULD',
    entityId: '7001',
    flight: 'CX134',
    uld: 'AKE12345CX',
    from: 'ARRIVED',
    to: 'RECEIVED',
    detail: 'ULD received'
  });
  const select = harness.state.queries.find(entry => entry.query.includes('SELECT TOP (@Limit)'));
  assert.equal(select.parameters.Limit, 5000);
  assert.equal(select.parameters.StationId, '1');
  assert.ok(Number.isFinite(select.parameters.StartUtc.getTime()));
  assert.ok(Number.isFinite(select.parameters.EndUtc.getTime()));
});

test('POST /api/history rejects every client-authored audit shape before opening SQL', async () => {
  const attempts = [
    { type: 'Flight', action: 'Export finalised', entityType: 'Flight', entityId: '1', to: 'FINALISED' },
    { type: 'ULD', action: 'Status changed', entityType: 'ULD', entityId: '7', from: 'ARRIVED', to: 'RECEIVED' },
    { type: 'Supervisor', action: 'Closed with supervisor passcode', flight: 'CX134' },
    { type: 'CUSTOM_EVENT', action: 'Caller-authored evidence', details: { trusted: false } }
  ];

  for (const body of attempts) {
    const harness = historySqlHarness();
    const handler = loadHistoryHandler(harness.sql);
    const response = await callHistory(handler, 'POST', body);
    assert.equal(response.status, 405);
    assert.equal(response.headers.Allow, 'GET');
    assert.deepEqual(response.body, { ok: false, error: 'Method not allowed' });
    assert.equal(harness.state.connections, 0);
    assert.equal(harness.state.queries.length, 0);
  }
});

test('History route remains readable while its registered POST path is an explicit rejection only', () => {
  const trigger = historyConfig.bindings.find(binding => binding.type === 'httpTrigger');
  assert.equal(trigger.route, 'history');
  assert.deepEqual(Array.from(trigger.methods), ['get', 'post']);
  assert.match(historySource, /toUpperCase\(\) !== 'GET'/);
  assert.match(historySource, /status, 405|sendJson\(context, 405/);
  assert.doesNotMatch(historySource, /INSERT\s+INTO\s+dbo\.AuditEvents/i);
  assert.doesNotMatch(historySource, /OUTPUT\s+INSERTED/i);
});

test('official frontend History callers remain GET-only with no duplicate-audit fallback', () => {
  const occurrences = [...html.matchAll(/\/api\/history/g)];
  assert.equal(occurrences.length, 2);
  for (const occurrence of occurrences) {
    const call = html.slice(Math.max(0, occurrence.index - 30), occurrence.index + 500);
    assert.match(call, /fetch\(/);
    assert.doesNotMatch(call, /method\s*:\s*['"]POST['"]/i);
  }
  assert.doesNotMatch(html, /function postAuditEvent/);
});

test('History class tokens accept only lowercase safe token characters', () => {
  const context = vm.createContext({ String });
  vm.runInContext(functionLine('safeClassToken'), context);
  const examples = new Map([
    ['" onmouseover="alert(1)', 'onmouseover-alert-1'],
    ['<script>alert(1)</script>', 'script-alert-1-script'],
    ['foo bar', 'foo-bar'],
    ['foo/../../bar', 'foo-bar'],
    ['', 'event']
  ]);

  for (const [input, expected] of examples) {
    const token = context.safeClassToken(input);
    assert.equal(token, expected);
    assert.match(token, /^[a-z0-9_-]+$/);
  }
});

test('desktop History renders malicious text as text and keeps EventType inside class context', () => {
  const malicious = {
    ts: Date.now(),
    type: '<script>alert(1)</script>',
    action: '<img src=x onerror=alert(1)>',
    flight: 'CX134</small><script>alert(2)</script>',
    uld: 'AKE12345CX"><svg/onload=alert(3)>',
    from: 'ARRIVED',
    to: 'RECEIVED',
    detail: '</small><script>alert(4)</script>',
    user: '"><img src=x onerror=alert(5)>'
  };
  const rendered = historyFrontendHarness([malicious]).historyScreen();
  const classMatch = rendered.match(/class="event-type ([^"]+)"/);

  assert.ok(classMatch);
  assert.equal(classMatch[1], 'script-alert-1-script');
  assert.match(classMatch[1], /^[a-z0-9_-]+$/);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /<script>|<img src=x|<svg\/onload/i);
});

test('mobile History renders the same untrusted fields as escaped text', () => {
  const events = [{
    ts: Date.now(),
    type: '<script>alert(1)</script>',
    action: '<img src=x onerror=alert(2)>',
    flight: 'CX134<script>alert(3)</script>',
    uld: 'AKE12345CX<svg/onload=alert(4)>',
    from: '<from>',
    to: '<to>',
    detail: '<details>',
    user: '<operator>'
  }];
  const context = vm.createContext({
    String,
    historySearch: '',
    historyFilter: 'All',
    historyUserFilter: 'All',
    historyFilteredEvents: () => events,
    historyDateKeys: () => ['2026-09-24'],
    historyUsers: () => [],
    visibleCompletionsForDate: () => [],
    dayStats: () => ({ events, actions: 1, offloads: 0, flights: 1 }),
    historyDayOpen: () => true,
    dateKeyLabel: () => '24 Sep 2026',
    fmtTime: () => '10:30'
  });
  for (const name of ['esc', 'eventDescription']) vm.runInContext(functionLine(name), context);
  vm.runInContext(sourceBetween('function mobileHistoryScreen(', 'function recordOperatingDateKey('), context);
  const rendered = context.mobileHistoryScreen();

  assert.match(rendered, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(rendered, /CX134&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.match(rendered, /&lt;operator&gt;/);
  assert.doesNotMatch(rendered, /<script>|<img src=x|<svg\/onload/i);
});

test('legitimate History events retain their class and escaped readable content', () => {
  const event = {
    ts: Date.now(), type: 'Offload', action: 'Offload delivered',
    flight: 'CX134', uld: 'AKE12345CX', from: 'Transit', to: 'Complete',
    detail: 'Delivered to Bay <12>', user: 'Operator & Supervisor'
  };
  const rendered = historyFrontendHarness([event]).historyScreen();

  assert.match(rendered, /class="event-type offload">Offload<\/div>/);
  assert.match(rendered, /Offload delivered/);
  assert.match(rendered, /Delivered to Bay &lt;12&gt;/);
  assert.match(rendered, /Operator &amp; Supervisor/);
});

test('History CSV cells neutralize formulas and preserve normal CSV quoting', () => {
  const context = vm.createContext({ String });
  vm.runInContext(functionLine('historyCsvCell'), context);

  for (const formula of ['=cmd(...)', '+SUM(A1:A2)', '-1+1', '@something']) {
    assert.equal(context.historyCsvCell(formula), `"'${formula}"`);
  }
  assert.equal(context.historyCsvCell('Normal value'), '"Normal value"');
  assert.equal(context.historyCsvCell('Quoted "value"'), '"Quoted ""value"""');
  assert.match(functionLine('downloadHistory'), /map\(historyCsvCell\)/);
});

test('shared audit writes remain transaction-required and trigger-compatible', async () => {
  await assert.rejects(
    () => insertAuditEvent(null, {}, { action: 'Should fail' }),
    /requires a transaction/
  );

  const transaction = { id: 'transaction-1' };
  const statements = [];
  class Request {
    constructor(actualTransaction) { assert.equal(actualTransaction, transaction); this.parameters = {}; }
    input(name, _type, value) { this.parameters[name] = value; return this; }
    async query(text) {
      const query = String(text);
      statements.push(query);
      if (query.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return { recordset: [
          { COLUMN_NAME: 'AuditEventId', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, IS_IDENTITY: 1 },
          { COLUMN_NAME: 'EventType', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, IS_IDENTITY: 0 },
          { COLUMN_NAME: 'Action', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, IS_IDENTITY: 0 },
          { COLUMN_NAME: 'ActorDisplayName', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, IS_IDENTITY: 0 },
          { COLUMN_NAME: 'ActorReference', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, IS_IDENTITY: 0 },
          { COLUMN_NAME: 'OccurredAtUtc', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, IS_IDENTITY: 0 }
        ] };
      }
      if (query.includes('INSERT INTO dbo.AuditEvents')) {
        assert.doesNotMatch(query, /\bOUTPUT\s+INSERTED\./i);
        return { recordset: [], rowsAffected: [1] };
      }
      throw new Error(`Unexpected audit SQL: ${query}`);
    }
  }
  const sql = {
    Request,
    NVarChar: length => `nvarchar(${length})`,
    MAX: 'max'
  };

  await insertAuditEvent(transaction, sql, {
    type: 'ULD',
    action: 'Status changed',
    actorDisplayName: 'Operator One',
    actorReference: 'operator-one-id'
  });
  assert.equal(statements.filter(statement => statement.includes('INSERT INTO dbo.AuditEvents')).length, 1);
});
