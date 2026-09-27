'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { insertAuditEvent } = require('../api/shared/audit');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('migrations/audit-events-flight-ownership.sql');
const preflight = read('migrations/audit-events-flight-ownership-preflight.sql');
const verify = read('migrations/audit-events-flight-ownership-verify.sql');
const diagnostic = read('migrations/audit-events-flight-ownership-diagnostic.sql');
const canonicalCandidateBlock = source => {
  const begin = '-- CANONICAL AUDIT OWNERSHIP CANDIDATE MODEL BEGIN';
  const end = '-- CANONICAL AUDIT OWNERSHIP CANDIDATE MODEL END';
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start);
  assert.ok(start >= 0 && finish > start, 'canonical candidate block markers');
  return source.slice(start, finish + end.length).replace(/\r\n/g, '\n');
};

function auditHarness(columns) {
  const state = { statements: [], inserts: [] };
  class Request {
    constructor(transaction) { this.transaction = transaction; this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(text) {
      const sqlText = String(text).replace(/\s+/g, ' ').trim();
      state.statements.push(sqlText);
      if (sqlText.includes('FROM INFORMATION_SCHEMA.COLUMNS')) {
        return { recordset: columns.map(COLUMN_NAME => ({ COLUMN_NAME, IS_NULLABLE: 'YES' })) };
      }
      if (sqlText.startsWith('INSERT INTO dbo.AuditEvents')) {
        state.inserts.push({ text: sqlText, values: { ...this.values } });
        return { recordset: [], rowsAffected: [1] };
      }
      throw new Error(`Unexpected SQL: ${sqlText}`);
    }
  }
  const type = value => value;
  return { state, transaction: {}, sql: { Request, BigInt: 'bigint', NVarChar: type, MAX: 'max' } };
}

const auditColumns = [
  'AuditEventId', 'EventType', 'Action', 'EntityType', 'EntityId', 'FlightId',
  'OccurredAtUtc', 'ActorDisplayName', 'ActorReference', 'DetailsJson'
];

test('shared audit writer persists an exact validated FlightId and global events keep NULL', async () => {
  const operational = auditHarness(auditColumns);
  await insertAuditEvent(operational.transaction, operational.sql, {
    type: 'ULD', action: 'Status changed', actorDisplayName: 'Operator',
    entityType: 'ULD', entityId: '9', flightId: '101', uldId: '9',
    details: { flightId: '202', note: 'caller metadata cannot replace ownership' }
  });
  assert.equal(operational.state.inserts.length, 1);
  assert.match(operational.state.inserts[0].text, /\[FlightId\][\s\S]*@AuditFlightId/);
  assert.equal(operational.state.inserts[0].values.AuditFlightId, '101');
  assert.equal(JSON.parse(operational.state.inserts[0].values.AuditDetailsJson).flightId, '101');

  const global = auditHarness(auditColumns);
  await insertAuditEvent(global.transaction, global.sql, {
    type: 'Admin', action: 'Configuration reviewed', actorDisplayName: 'Administrator',
    entityType: 'Configuration', entityId: 'airlines'
  });
  assert.equal(global.state.inserts[0].values.AuditFlightId, null);
  assert.equal(JSON.parse(global.state.inserts[0].values.AuditDetailsJson).flightId, null);
});

test('shared audit writer rejects invalid or silently unpersistable Flight ownership', async () => {
  for (const value of ['0', '-1', '1.5', '9223372036854775808', Number.MAX_SAFE_INTEGER + 1]) {
    const h = auditHarness(auditColumns);
    await assert.rejects(
      insertAuditEvent(h.transaction, h.sql, { action: 'Mutation', actorDisplayName: 'Operator', flightId: value }),
      /safe SQL bigint/
    );
    assert.equal(h.state.inserts.length, 0);
  }

  const missing = auditHarness(auditColumns.filter(column => column !== 'FlightId'));
  await assert.rejects(
    insertAuditEvent(missing.transaction, missing.sql, {
      action: 'Mutation', actorDisplayName: 'Operator', flightId: '101'
    }),
    /cannot store authoritative FlightId/
  );
  assert.equal(missing.state.inserts.length, 0);

  const unowned = auditHarness(auditColumns);
  await assert.rejects(
    insertAuditEvent(unowned.transaction, unowned.sql, {
      action: 'Mutation', actorDisplayName: 'Operator', entityType: 'ULD', uldId: '9'
    }),
    /require authoritative FlightId/
  );
  assert.equal(unowned.state.inserts.length, 0);
});

test('migration is additive, transactional, idempotent, and changes only FlightId ownership', () => {
  assert.match(migration, /BEGIN TRY[\s\S]*BEGIN TRANSACTION[\s\S]*sp_getapplock[\s\S]*COMMIT TRANSACTION/);
  assert.match(migration, /IF @FlightColumnPresent=0[\s\S]*ALTER TABLE dbo\.AuditEvents ADD FlightId bigint NULL/);
  assert.match(migration, /UPDATE audit SET FlightId=resolved\.FlightId/);
  assert.match(migration, /COUNT\(DISTINCT CandidateFlightId\)>1[\s\S]*IF @Ambiguous>0 THROW 51613/);
  assert.ok(migration.indexOf('IF @Ambiguous>0 THROW 51613') < migration.indexOf('UPDATE audit SET FlightId'));
  assert.match(migration, /WITH CHECK[\s\S]*FK_AuditEvents_Flights_FlightId[\s\S]*REFERENCES dbo\.Flights\(FlightId\)/);
  assert.match(migration, /CREATE INDEX IX_AuditEvents_Flight_OccurredAtUtc[\s\S]*\(FlightId,OccurredAtUtc DESC\)/);
  assert.doesNotMatch(migration, /ON DELETE CASCADE|ON UPDATE CASCADE/i);
  assert.doesNotMatch(migration, /UPDATE\s+dbo\.AuditEvents\s+SET\s+(?!FlightId)/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+dbo\.AuditEvents|DROP\s+COLUMN|ALTER\s+COLUMN/i);
});

test('backfill SQL uses only stable exact identifiers and preserves legacy orphan Offloads', () => {
  for (const source of ['EntityId', "OwnershipKey='flightId'", "OwnershipKey='uldId'", "OwnershipKey='offloadId'", 'UldId', 'OffloadId']) {
    assert.match(migration, new RegExp(source.replace(/[.$]/g, '\\$&')));
  }
  assert.match(migration, /ExactUld[\s\S]*GROUP BY UldId HAVING COUNT_BIG\(\*\)=1/);
  assert.match(migration, /ExactOffload[\s\S]*GROUP BY OffloadId HAVING COUNT_BIG\(\*\)=1/);
  assert.match(migration, /ExactOffload[\s\S]*MIN\(FlightId\) IS NOT NULL/);
  for (const forbidden of ['FlightNumber', 'OriginAirport', 'DestinationAirport', 'ActorDisplayName']) {
    const candidateSection = canonicalCandidateBlock(migration);
    assert.doesNotMatch(candidateSection, new RegExp(forbidden));
  }
});

test('preflight, verifier, and production diagnostic are read-only and produce a final decision', () => {
  for (const sql of [preflight, verify, diagnostic]) {
    assert.match(sql, /CHECK_NAME/);
    assert.match(sql, /FINAL_DECISION/);
    assert.match(sql, /PROCEED/);
    assert.match(sql, /STOP/);
    assert.doesNotMatch(sql, /\b(?:ALTER|DROP|TRUNCATE|MERGE)\s+(?:TABLE\s+)?dbo\./i);
    assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+dbo\./i);
  }
  for (const name of [
    'TOTAL_AUDIT_EVENTS', 'ALREADY_OWNED', 'BACKFILL_FROM_FLIGHT',
    'BACKFILL_FROM_ULD', 'BACKFILL_FROM_OFFLOAD', 'REMAINING_NULL_GLOBAL',
    'REMAINING_NULL_UNPROVABLE', 'LEGACY_ORPHAN_OFFLOAD_AUDIT', 'AMBIGUOUS',
    'INVALID_REFERENCE'
  ]) assert.match(diagnostic, new RegExp(name));
  for (const sql of [migration, preflight]) {
    for (const name of [
      'TOTAL_AUDIT_EVENTS', 'ALREADY_OWNED', 'BACKFILL_FROM_FLIGHT',
      'BACKFILL_FROM_ULD', 'BACKFILL_FROM_OFFLOAD', 'REMAINING_NULL_GLOBAL',
      'REMAINING_NULL_UNPROVABLE', 'LEGACY_ORPHAN_OFFLOAD_AUDIT', 'AMBIGUOUS',
      'INVALID_REFERENCE'
    ]) assert.match(sql, new RegExp(name));
  }
});

test('migration, preflight, diagnostic and verifier use one copy-identical candidate model', () => {
  const expected = canonicalCandidateBlock(migration);
  for (const source of [preflight, diagnostic, verify]) assert.equal(canonicalCandidateBlock(source), expected);
  assert.match(expected, /CROSS APPLY OPENJSON/);
  assert.doesNotMatch(expected, /JSON_VALUE/);
  assert.match(expected, /HAVING COUNT_BIG\(\*\)>1/);
  assert.match(expected, /@HasPhysicalUld=1[\s\S]*@HasEntity=1[\s\S]*SingleJsonUld/);
  assert.match(expected, /@HasPhysicalOffload=1[\s\S]*@HasEntity=1[\s\S]*SingleJsonOffload/);
  assert.match(expected, /LEN\(normalized\.IdText\)<=19[\s\S]*NOT LIKE N?'%\[\^0-9\]%'.*parsed\.IdValue>0/);
  assert.match(expected, /LEFT JOIN dbo\.Flights flight ON flight\.FlightId=claim\.CandidateFlightId WHERE flight\.FlightId IS NULL/);
  assert.match(expected, /ORDER BY claim\.EvidencePriority,claim\.EvidenceType/);
  assert.doesNotMatch(expected, /MIN\(EvidenceType\)/);
});

test('ownership preflight false-green matrix is represented by fail-closed metadata gates', () => {
  const checks = [
    ['missing AuditEvents', /MISSING_AUDIT_EVENTS/],
    ['missing Flights', /MISSING_FLIGHTS/],
    ['missing ULDs', /ULD_OWNERSHIP_SOURCE_UNAVAILABLE/],
    ['missing Offloads', /OFFLOAD_OWNERSHIP_SOURCE_UNAVAILABLE/],
    ['wrong or computed AuditEvent FlightId', /system_type_id=127[\s\S]*is_nullable=1[\s\S]*is_computed=0/],
    ['FlightId default', /default_constraints[\s\S]*d\.object_id IS NULL/],
    ['invalid target', /INVALID_REFERENCE/],
    ['duplicate JSON', /DUPLICATE_JSON_OWNERSHIP_KEY/],
    ['conflicting FK topology', /@TouchingFkCount<>@CompatibleFkCount/],
    ['disabled FK', /fk\.is_disabled=0/],
    ['untrusted FK', /fk\.is_not_trusted=0/],
    ['composite FK', /COUNT_BIG\(\*\)[\s\S]*constraint_object_id=fk\.object_id\)=1/],
    ['cascade FK', /delete_referential_action=0 AND fk\.update_referential_action=0/],
    ['incompatible named index', /INCOMPATIBLE_HISTORY_INDEX_NAME/],
    ['INSERT trigger', /INSERT_TRIGGER_REQUIRES_REVIEW/],
    ['UPDATE trigger', /UPDATE_TRIGGER_BLOCKS_BACKFILL/]
  ];
  for (const [name, pattern] of checks) assert.match(preflight, pattern, name);
  assert.match(preflight, /IF @CandidateModelReady=1/);
  assert.ok(preflight.indexOf("IF @AuditObjectId IS NULL INSERT @Findings") < preflight.indexOf('CANONICAL AUDIT OWNERSHIP CANDIDATE MODEL BEGIN'));
});

test('verifier rejects extra FK topology, incompatible named index, triggers and provable NULLs', () => {
  assert.match(verify, /@CompatibleFkCount<>1 OR @TouchingFkCount<>1/);
  assert.match(verify, /@IntendedFkNameConflict=1/);
  assert.match(verify, /INCOMPATIBLE_HISTORY_INDEX_NAME/);
  assert.match(verify, /INSERT_TRIGGER_REQUIRES_REVIEW/);
  assert.match(verify, /UPDATE_TRIGGER_REQUIRES_REVIEW/);
  assert.match(verify, /PROVABLE_AUDIT_OWNERSHIP_MISSING/);
  assert.match(verify, /INVALID_AUDIT_FLIGHT_REFERENCE/);
  assert.match(verify, /DUPLICATE_JSON_OWNERSHIP_KEY/);
});

test('migration gates triggers and contradictions before update and reports success only after COMMIT', () => {
  const update = migration.indexOf('UPDATE audit SET FlightId=resolved.FlightId');
  assert.ok(migration.indexOf("type_desc=N'INSERT'") < update);
  assert.ok(migration.indexOf("type_desc=N'UPDATE'") < update);
  assert.ok(migration.indexOf('IF @DuplicateJsonOwnership>0 THROW') < update);
  assert.ok(migration.indexOf('IF @InvalidCandidateReference>0 THROW') < update);
  assert.ok(migration.indexOf('IF @Ambiguous>0 THROW') < update);
  assert.ok(migration.lastIndexOf('COMMIT TRANSACTION') < migration.lastIndexOf("N'FINAL_DECISION',N'PROCEED'"));
});

test('deployment gates stop when AuditEvents FlightId is missing or incompatible', () => {
  const foundationPreflight = read('migrations/multi-station-foundation-preflight.sql');
  const foundationVerify = read('migrations/multi-station-foundation-verify.sql');
  assert.match(foundationPreflight, /AUDIT_HISTORY_OWNERSHIP_UNAVAILABLE[\s\S]*AuditEvents\.FlightId/);
  assert.match(foundationVerify, /AuditEvents',N'FlightId'/);
  assert.match(foundationVerify, /INVALID_AUDIT_FLIGHT_OWNERSHIP_SCHEMA/);
  assert.match(foundationVerify, /INVALID_AUDIT_FLIGHT_FK/);
  assert.match(foundationVerify, /MISSING_AUDIT_HISTORY_INDEX/);
  assert.match(foundationVerify, /@AuditFlightFkTouching<>1 OR @AuditFlightFkCompatible<>1/);
  assert.match(foundationVerify, /@AuditFlightFkNameConflict=1/);
  assert.match(foundationVerify, /INVALID_AUDIT_HISTORY_INDEX_NAME/);
  assert.match(foundationVerify, /AUDIT_INSERT_TRIGGER_REQUIRES_REVIEW/);
  assert.match(foundationVerify, /AUDIT_UPDATE_TRIGGER_REQUIRES_REVIEW/);
  assert.match(foundationPreflight, /AUDIT_HISTORY_FK_TOPOLOGY/);
  assert.match(foundationPreflight, /FK_AuditEvents_Flights_FlightId/);
  assert.match(foundationPreflight, /AUDIT_HISTORY_INDEX_NAME_CONFLICT/);
  assert.match(foundationPreflight, /AUDIT_INSERT_TRIGGER_REQUIRES_REVIEW/);
  assert.match(foundationPreflight, /AUDIT_UPDATE_TRIGGER_REQUIRES_REVIEW/);
});

test('every production shared-audit call supplies server-resolved flightId', () => {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.js') && full !== path.join(root, 'api', 'shared', 'audit.js')) files.push(full);
    }
  };
  visit(path.join(root, 'api'));
  let calls = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    let offset = 0;
    while ((offset = source.indexOf('insertAuditEvent(', offset)) >= 0) {
      const close = source.indexOf('});', offset);
      assert.notEqual(close, -1, file);
      assert.match(source.slice(offset, close + 3), /\bflightId\s*[:,]/, file);
      calls++;
      offset = close + 3;
    }
  }
  assert.equal(calls, 12);
});

function strictStableId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/^ +| +$/g, '');
  if (!/^[0-9]+$/.test(text) || text.length > 19) return null;
  const parsed = BigInt(text);
  return parsed > 0n && parsed <= 9223372036854775807n ? parsed.toString() : null;
}

function resolveOwnership({ events, flights, ulds, offloads }) {
  const flightIds = new Set(flights.map(row => strictStableId(row.id)).filter(Boolean));
  const exact = rows => {
    const grouped = new Map();
    for (const row of rows) {
      const key = strictStableId(row.id);
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
    return new Map([...grouped].filter(([, rowsForId]) => rowsForId.length === 1 && rowsForId[0].flightId != null)
      .map(([id, rowsForId]) => [id, strictStableId(rowsForId[0].flightId)]));
  };
  const uldMap = exact(ulds);
  const offloadMap = exact(offloads);
  return events.map(event => {
    const claims = [];
    const jsonGroups = new Map();
    for (const [key, value, type = 2] of event.detailsEntries || []) {
      if (!['flightId', 'uldId', 'offloadId'].includes(key)) continue;
      if (!jsonGroups.has(key)) jsonGroups.set(key, []);
      jsonGroups.get(key).push({ value, type });
    }
    const duplicateJson = [...jsonGroups.values()].some(values => values.length > 1);
    const singleJsonId = key => {
      const values = jsonGroups.get(key) || [];
      return values.length === 1 && [1, 2].includes(values[0].type) ? strictStableId(values[0].value) : null;
    };
    const addFlight = (value, source, priority) => {
      const id = strictStableId(value);
      if (id) claims.push({ id, source, priority });
    };
    addFlight(event.flightId, 'ALREADY_OWNED', 0);
    if (String(event.entityType || '').trim().toUpperCase() === 'FLIGHT') addFlight(event.entityId, 'BACKFILL_FROM_FLIGHT', 10);
    addFlight(singleJsonId('flightId'), 'BACKFILL_FROM_FLIGHT', 11);
    const uldIds = [strictStableId(event.uldId)];
    if (String(event.entityType || '').trim().toUpperCase() === 'ULD') uldIds.push(strictStableId(event.entityId));
    uldIds.push(singleJsonId('uldId'));
    for (const id of uldIds.filter(Boolean)) addFlight(uldMap.get(id), 'BACKFILL_FROM_ULD', 20);
    const offloadIds = [strictStableId(event.offloadId)];
    if (String(event.entityType || '').trim().toUpperCase() === 'OFFLOAD') offloadIds.push(strictStableId(event.entityId));
    offloadIds.push(singleJsonId('offloadId'));
    for (const id of offloadIds.filter(Boolean)) addFlight(offloadMap.get(id), 'BACKFILL_FROM_OFFLOAD', 30);
    const candidates = new Set(claims.map(claim => claim.id));
    const invalidReference = [...candidates].some(id => !flightIds.has(id));
    const ambiguous = candidates.size > 1;
    const chosen = [...claims].sort((a, b) => a.priority - b.priority || a.source.localeCompare(b.source))[0];
    return {
      ...event,
      resolved: !duplicateJson && !invalidReference && !ambiguous && candidates.size === 1 ? [...candidates][0] : null,
      source: chosen?.source || null,
      ambiguous,
      duplicateJson,
      invalidReference
    };
  });
}

test('canonical fixture model emits every exact source independently and is idempotent', () => {
  const fixture = {
    flights: [
      { id: '101', station: 'MEL', number: 'CX123', date: '2026-10-01' },
      { id: '202', station: 'AKL', number: 'CX123', date: '2026-10-01' }
    ],
    ulds: [{ id: '11', flightId: '101', number: 'AKE12345CX' }, { id: '22', flightId: '202', number: 'AKE12345CX' }],
    offloads: [{ id: '31', flightId: '101' }, { id: '32', flightId: null }, { id: '33', flightId: '202' }],
    events: [
      { id: 'a', flightId: '101' },
      { id: 'b', entityType: 'ULD', entityId: '11' },
      { id: 'c', entityType: 'Offload', entityId: '31' },
      { id: 'd', entityType: 'Flight', entityId: '202' },
      { id: 'e', entityType: 'Offload', entityId: '32' },
      { id: 'f', entityType: 'Unknown', entityId: 'CX123' },
      { id: 'g', flightId: '101', detailsEntries: [['flightId', '202']] },
      { id: 'h', entityType: 'ULD', entityId: '22' },
      { id: 'i', uldId: '11', entityType: 'ULD', entityId: '22' },
      { id: 'j', offloadId: '31', entityType: 'OFFLOAD', entityId: '33' },
      { id: 'k', uldId: '11', detailsEntries: [['uldId', '11']] },
      { id: 'l', uldId: '11', detailsEntries: [['uldId', '22']] },
      { id: 'm', detailsEntries: [['flightId', '101'], ['flightId', '101']] },
      { id: 'n', detailsEntries: [['uldId', '11'], ['uldId', '22']] },
      { id: 'o', detailsEntries: [['offloadId', '31'], ['offloadId', '33']] },
      { id: 'p', entityType: 'Flight', entityId: '999' },
      { id: 'q', flightId: '101', entityType: 'ULD', entityId: '11' }
    ]
  };
  const first = resolveOwnership(fixture);
  assert.deepEqual(first.map(row => [row.id, row.resolved, row.ambiguous, row.duplicateJson, row.invalidReference]), [
    ['a', '101', false, false, false], ['b', '101', false, false, false],
    ['c', '101', false, false, false], ['d', '202', false, false, false],
    ['e', null, false, false, false], ['f', null, false, false, false],
    ['g', null, true, false, false], ['h', '202', false, false, false],
    ['i', null, true, false, false], ['j', null, true, false, false],
    ['k', '101', false, false, false], ['l', null, true, false, false],
    ['m', null, false, true, false], ['n', null, false, true, false],
    ['o', null, false, true, false], ['p', null, false, false, true],
    ['q', '101', false, false, false]
  ]);
  const rerun = resolveOwnership({ ...fixture, events: first.map(row => ({ ...row, flightId: row.flightId || row.resolved })) });
  assert.deepEqual(rerun.map(row => [row.id, row.resolved, row.ambiguous]), first.map(row => [row.id, row.resolved, row.ambiguous]));
  assert.equal(first.find(row => row.id === 'q').source, 'ALREADY_OWNED');
});

test('stable ownership text accepts only positive decimal SQL bigint values with outer spaces', () => {
  for (const value of ['1', ' 1 ', '9223372036854775807', '0001']) assert.ok(strictStableId(value));
  for (const value of ['', '0', '-1', '+1', '1.0', '1e2', '1 2', '\t1', '9223372036854775808']) assert.equal(strictStableId(value), null);
});

test('History remains an exact FlightId station join and excludes NULL/global events', () => {
  const history = read('api/history/index.js');
  assert.match(history, /INNER JOIN dbo\.Flights flight ON flight\.FlightId=audit\.\$\{q\(flightIdCol\)\}/);
  assert.match(history, /flight\.StationId=@StationId/);
  assert.doesNotMatch(history, /FlightNumber[^\n]+@StationId|EntityId[^\n]+@StationId|Actor[^\n]+@StationId/);
});
