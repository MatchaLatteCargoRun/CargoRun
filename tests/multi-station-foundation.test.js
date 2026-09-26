'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const station = require('../api/shared/station');
const authorization = require('../api/shared/operational-authorization');
const flight = require('../api/shared/flight');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function sqlHarness({ stationRows = [], capabilities = ['VIEW_FLIGHTS'] } = {}) {
  const state = { queries: [] };
  class Request {
    constructor() { this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(query) {
      const text = String(query);
      state.queries.push({ text, values: { ...this.values } });
      if (text.includes('FROM dbo.CargoRunStations')) return { recordset: stationRows };
      if (text.includes('WITH AssignmentDecisions')) {
        return { recordset: capabilities.map(CapabilityCode => ({ CapabilityCode })) };
      }
      throw new Error(`Unexpected SQL: ${text.slice(0, 100)}`);
    }
  }
  const type = size => size;
  return { sql: { Request, BigInt: 'bigint', VarChar: type, NVarChar: type }, state };
}

const mel = { StationId: 1, StationCode: 'MEL', DisplayName: 'Melbourne', TimeZoneId: 'Australia/Melbourne', IsEnabled: 1 };
const syd = { StationId: 2, StationCode: 'SYD', DisplayName: 'Sydney', TimeZoneId: 'Australia/Sydney', IsEnabled: 1 };
const actor = { reference: 'operator-1', displayName: 'Operator' };

test('Phase 2B migration is transactional, idempotent, operator-confirmed, and preserves route and orphan data', () => {
  const sql = read('migrations/multi-station-foundation.sql');
  assert.match(sql, /BEGIN TRY[\s\S]*BEGIN TRANSACTION[\s\S]*sp_getapplock[\s\S]*COMMIT TRANSACTION/);
  assert.match(sql, /IF COL_LENGTH\(N'dbo\.Flights',N'StationId'\) IS NULL[\s\S]*ALTER TABLE dbo\.Flights ADD StationId bigint NULL/);
  assert.match(sql, /IF COL_LENGTH\(N'dbo\.IncomingMachMessages',N'StationId'\) IS NULL[\s\S]*ALTER TABLE dbo\.IncomingMachMessages ADD StationId bigint NULL/);
  assert.match(sql, /UPDATE dbo\.Flights SET StationId=@MelStationId WHERE StationId IS NULL/);
  assert.match(sql, /UPDATE dbo\.IncomingMachMessages SET StationId=@MelStationId WHERE StationId IS NULL/);
  assert.match(sql, /ExistingNonMelFlights[\s\S]*ExistingNonMelMessages/);
  assert.match(sql, /@HasStatus=1[\s\S]*@OffloadStatusColumn[\s\S]*@NormalizedOffloadStatusExpression[\s\S]*<>N''COMPLETE''/);
  assert.match(sql, /OffloadStatusConflictCount[\s\S]*StatusValue<>normalized\.OffloadStatusValue/);
  assert.match(sql, /CONVERT\(nvarchar\(max\),offload\./);
  assert.doesNotMatch(sql, /CONVERT\(nvarchar\(50\),offload\./);
  assert.match(sql, /THROW 51545,'Active or unclassified orphan Offloads must be resolved before Phase 2B\.'/);
  assert.match(sql, /@MelStationId IS NULL OR @MelStationId<=0/);
  assert.match(sql, /is_hypothetical=0 AND indexObject\.has_filter=0/);
  assert.match(sql, /composite, conflicting, disabled, untrusted, or cascading/i);
  assert.doesNotMatch(sql, /UPDATE\s+dbo\.Flights\s+SET\s+(?:OriginAirport|DestinationAirport|Direction|OperatingDate|FlightNumber|FlightStatus)/i);
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE|MERGE|INSERT\s+INTO)\s+dbo\.Offloads/i);
  for (const table of ['ULDs', 'Offloads', 'ImportCompletionRecords', 'ExportCompletionRecords', 'ExportCompletionAmendments', 'ExportManifestFinals', 'MachFowShipments', 'AuditEvents']) {
    assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+dbo\\.${table}`, 'i'));
  }
});

test('Phase 2B verification reports all required ownership failures and preserves legacy orphan classification', () => {
  const sql = read('migrations/multi-station-foundation-verify.sql');
  for (const finding of [
    'MISSING_REQUIRED_TABLE', 'MISSING_REQUIRED_COLUMN', 'MISSING_REQUIRED_OWNERSHIP_SCHEMA',
    'INVALID_IDENTITY_COLUMN_TYPE', 'NON_UNIQUE_FLIGHT_IDENTITY', 'NON_UNIQUE_MESSAGE_IDENTITY',
    'INVALID_FLIGHT_STATION_FK',
    'INVALID_MESSAGE_STATION_FK', 'NULL_FLIGHT_STATION_ID', 'NULL_MESSAGE_STATION_ID',
    'INVALID_FLIGHT_STATION_REFERENCE', 'INVALID_MESSAGE_STATION_REFERENCE',
    'APPLICATION_ASSISTED_NORMALIZATION_REQUIRED', 'CANONICAL_IDENTITY_COLLISION',
    'CROSS_STATION_MESSAGE_LINK', 'ORPHAN_MACH_MATCHED_FLIGHT',
    'FOW_MESSAGE_OWNERSHIP_CONFLICT', 'LEGACY_ORPHAN_OFFLOAD', 'ACTIVE_ORPHAN_OFFLOAD',
    'OFFLOAD_STATUS_DISAGREEMENT', 'INVALID_OFFLOAD_STATUS_SCHEMA',
    'DOCUMENTCORID_LEGACY_UNIQUE_INDEX', 'DOCUMENTCORID_COLLATION_CONFLICT'
  ]) assert.match(sql, new RegExp(finding));
  assert.match(sql, /LEGACY_ORPHAN_OFFLOAD'' ELSE N''ACTIVE_ORPHAN_OFFLOAD/);
  assert.match(sql, /OffloadStatusColumn[\s\S]*COMPLETE/);
  assert.match(sql, /@OffloadStatusColumn IS NULL[\s\S]*MISSING_REQUIRED_OWNERSHIP_SCHEMA/);
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE|MERGE|ALTER|DROP|TRUNCATE)\s+dbo\./i);
});

test('StationId foreign keys pass only as exact trusted enabled noncascading single-column links', () => {
  const acceptsStationForeignKey = fk => fk.parentTable === 'Flights' && fk.referencedTable === 'CargoRunStations' &&
    fk.enabled && fk.trusted && fk.deleteAction === 'NO_ACTION' && fk.updateAction === 'NO_ACTION' &&
    fk.columns.length === 1 && fk.columns[0].parent === 'StationId' && fk.columns[0].referenced === 'StationId';
  const valid = {
    parentTable: 'Flights', referencedTable: 'CargoRunStations', enabled: true, trusted: true,
    deleteAction: 'NO_ACTION', updateAction: 'NO_ACTION',
    columns: [{ parent: 'StationId', referenced: 'StationId' }]
  };
  assert.equal(acceptsStationForeignKey(valid), true, 'correct one-column FK');
  for (const [name, candidate] of [
    ['composite', { ...valid, columns: [...valid.columns, { parent: 'OtherColumn', referenced: 'OtherColumn' }] }],
    ['wrong target', { ...valid, referencedTable: 'OtherStations' }],
    ['cascade', { ...valid, deleteAction: 'CASCADE' }],
    ['untrusted', { ...valid, trusted: false }],
    ['disabled', { ...valid, enabled: false }]
  ]) assert.equal(acceptsStationForeignKey(candidate), false, name);

  const migration = read('migrations/multi-station-foundation.sql');
  const verify = read('migrations/multi-station-foundation-verify.sql');
  for (const sql of [migration, verify]) {
    assert.match(sql, /SELECT COUNT_BIG\(\*\) FROM sys\.foreign_key_columns allLinks[\s\S]*constraint_object_id=/);
    assert.match(sql, /is_disabled=0 AND (?:foreignKey|fk)\.is_not_trusted=0/);
    assert.match(sql, /delete_referential_action=0 AND (?:foreignKey|fk)\.update_referential_action=0/);
    assert.match(sql, /COL_NAME\(exactLink\.parent_object_id,exactLink\.parent_column_id\)=N'StationId'/);
    assert.match(sql, /COL_NAME\(exactLink\.referenced_object_id,exactLink\.referenced_column_id\)=N'StationId'/);
    assert.match(sql, /COUNT_BIG\(\*\)[\s\S]{0,180}constraint_object_id=[^\r\n]+\)(?:=|<>)1/);
  }
  assert.match(migration, /COUNT_BIG\(\*\)[\s\S]{0,180}constraint_object_id=foreignKey\.object_id\)<>1/);
  assert.match(verify, /COUNT_BIG\(\*\)[\s\S]{0,180}constraint_object_id=fk\.object_id\)<>1/);
});

test('FOW identity metadata rejects coercion, computed or nullable identities, and composite-only uniqueness', () => {
  const nativeBigint = (column, identity) => column?.systemTypeId === 127 && column.userTypeId === 127 &&
    column.maxLength === 8 && column.precision === 19 && column.scale === 0 && !column.computed &&
    (!identity || !column.nullable);
  const exactUnique = (indexes, columnName) => indexes.some(index => index.unique && index.enabled &&
    !index.hypothetical && !index.filtered && index.keys.length === 1 && index.keys[0] === columnName);
  const identityFindings = ({ column, indexes, rows, name }) => {
    const findings = [];
    if (!nativeBigint(column, true)) findings.push('INVALID_IDENTITY_COLUMN_TYPE');
    if (!exactUnique(indexes, name) || new Set(rows).size !== rows.length) {
      findings.push(name === 'FlightId' ? 'NON_UNIQUE_FLIGHT_IDENTITY' : 'NON_UNIQUE_MESSAGE_IDENTITY');
    }
    return findings;
  };
  const bigintIdentity = { systemTypeId: 127, userTypeId: 127, maxLength: 8, precision: 19, scale: 0, nullable: false, computed: false };
  const singleMessageKey = [{ unique: true, enabled: true, hypothetical: false, filtered: false, keys: ['MachMessageId'] }];
  assert.deepEqual(identityFindings({ column: bigintIdentity, indexes: singleMessageKey, rows: [1, 2], name: 'MachMessageId' }), []);
  assert.ok(identityFindings({ column: bigintIdentity, indexes: [], rows: [1, 1], name: 'MachMessageId' }).includes('NON_UNIQUE_MESSAGE_IDENTITY'));
  assert.ok(identityFindings({ column: { ...bigintIdentity, systemTypeId: 167, userTypeId: 167 }, indexes: singleMessageKey, rows: ['1'], name: 'MachMessageId' }).includes('INVALID_IDENTITY_COLUMN_TYPE'));
  assert.ok(identityFindings({ column: { ...bigintIdentity, computed: true }, indexes: singleMessageKey, rows: [1], name: 'MachMessageId' }).includes('INVALID_IDENTITY_COLUMN_TYPE'));
  assert.ok(identityFindings({ column: { ...bigintIdentity, nullable: true }, indexes: singleMessageKey, rows: [1], name: 'MachMessageId' }).includes('INVALID_IDENTITY_COLUMN_TYPE'));
  assert.ok(identityFindings({
    column: bigintIdentity,
    indexes: [{ ...singleMessageKey[0], keys: ['MachMessageId', 'StationId'] }],
    rows: [1], name: 'MachMessageId'
  }).includes('NON_UNIQUE_MESSAGE_IDENTITY'));
  assert.equal(nativeBigint({ ...bigintIdentity, nullable: true }, false), true, 'nullable bigint link is compatible');
  assert.equal(nativeBigint({ ...bigintIdentity, systemTypeId: 167, userTypeId: 167 }, false), false, 'coercible varchar link is rejected');
  assert.equal(nativeBigint({ ...bigintIdentity, computed: true }, false), false, 'computed link is rejected');

  const verify = read('migrations/multi-station-foundation-verify.sql');
  assert.match(verify, /system_type_id=127 AND columnObject\.user_type_id=127/g);
  assert.match(verify, /max_length=8 AND columnObject\.precision=19 AND columnObject\.scale=0/);
  assert.match(verify, /columnObject\.is_nullable=0 AND columnObject\.is_computed=0/);
  assert.match(verify, /identityIndex\.is_unique=1 AND identityIndex\.is_disabled=0/);
  assert.match(verify, /keyColumn\.key_ordinal>0\)=1/);
  assert.match(verify, /keyColumn\.key_ordinal=1[\s\S]*columnObject\.name=N'FlightId'/);
  assert.match(verify, /keyColumn\.key_ordinal=1[\s\S]*columnObject\.name=N'MachMessageId'/);
  assert.match(verify, /GROUP BY FlightId HAVING COUNT_BIG\(\*\)>1/);
  assert.match(verify, /GROUP BY MachMessageId HAVING COUNT_BIG\(\*\)>1/);
  assert.match(verify, /@FlightIdUniqueReady=1 AND @MessageIdUniqueReady=1/);
  assert.match(verify, /@ChildTable<>N'MachFowShipments' OR @FowOwnershipSchemaReady=1/);
});

test('DocumentCorID uses one canonical identity, BIN2 lookup, and database uniqueness', () => {
  const runtime = read('api/mach-fow/index.js');
  const migration = read('migrations/multi-station-foundation.sql');
  const verify = read('migrations/multi-station-foundation-verify.sql');
  assert.match(runtime, /canonicalizeDocumentCorId/);
  assert.match(runtime, /CargoRun:DocumentCorID:v2:/);
  assert.match(runtime, /m\.DocumentCorID COLLATE Latin1_General_100_BIN2[\s\S]*@DocumentCorID COLLATE Latin1_General_100_BIN2/);
  assert.match(runtime, /DocumentIdentityLockResource[\s\S]*@LockOwner = 'Transaction'/);
  assert.ok(runtime.indexOf('await acquireDocumentIdentityLock(tx, documentCorId)') <
    runtime.indexOf('await acquireFlightIdentityLock(tx, sql, operationalStation.stationId'));
  assert.doesNotMatch(runtime, /DELETE\s+FROM\s+dbo\.IncomingMachMessages/i);
  assert.match(migration, /INVALID_DOCUMENTCORID[\s\S]*DOCUMENTCORID_CANONICALIZATION_REQUIRED[\s\S]*DOCUMENTCORID_CANONICAL_COLLISION/);
  assert.ok(migration.indexOf('DOCUMENTCORID_CANONICAL_COLLISION') <
    migration.indexOf('CREATE UNIQUE INDEX UX_IncomingMachMessages_DocumentCorIDCanonical'));
  assert.match(migration, /DocumentCorIDCanonical AS[\s\S]*CONVERT\(nvarchar\(100\),DocumentCorID\)[\s\S]*Latin1_General_100_BIN2[\s\S]*PERSISTED/);
  assert.match(migration, /CHECK \([\s\S]*DATALENGTH\(CONVERT\(nvarchar\(max\),DocumentCorID\)\)>=2[\s\S]*DATALENGTH\(CONVERT\(nvarchar\(max\),DocumentCorID\)\)<=200/);
  assert.match(migration, /DATALENGTH\(CONVERT\(nvarchar\(max\),DocumentCorID\)\)[\s\S]*=DATALENGTH\(LTRIM\(RTRIM\(CONVERT\(nvarchar\(max\),DocumentCorID\)\)\)\)/);
  assert.match(migration, /TRANSLATE\([\s\S]*?ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-[\s\S]*?REPLICATE\(N''A'',37\)[\s\S]*?\)\)=0/);
  assert.match(migration, /ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-[\s\S]*REPLICATE\(N''A'',63\)/);
  assert.match(migration, /SELECT canonical\.CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2 AS CanonicalDocumentCorID[\s\S]*GROUP BY canonical\.CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2/);
  assert.match(migration, /@DocumentCorIdComputedDefinition<>N'convertnvarchar100,documentcoridcollatelatin1_general_100_bin2'/);
  assert.match(migration, /DROP CONSTRAINT CK_IncomingMachMessages_DocumentCorID_Canonical[\s\S]*WITH CHECK ADD CONSTRAINT CK_IncomingMachMessages_DocumentCorID_Canonical/);
  assert.match(migration, /sp_addextendedproperty[\s\S]*CargoRun\.DocumentCorIDCanonicalGuardHash/);
  assert.match(migration, /CREATE UNIQUE INDEX UX_IncomingMachMessages_DocumentCorIDCanonical[\s\S]*DocumentCorIDCanonical/);
  assert.match(migration, /ignore_dup_key=0/);
  assert.match(migration, /Retain a safe enabled, unfiltered, single-column legacy unique key/);
  assert.match(migration, /indexObject\.has_filter=1 OR indexObject\.ignore_dup_key=1[\s\S]*additionalKey\.key_ordinal>1/);
  assert.doesNotMatch(migration, /DROP\s+INDEX\s+UX_IncomingMachMessages_DocumentCorID/i);
  assert.doesNotMatch(migration, /UPDATE\s+dbo\.IncomingMachMessages\s+SET\s+DocumentCorID/i);
  assert.match(verify, /DocumentCorIdUniqueIndexReady[\s\S]*i\.is_unique=1[\s\S]*i\.is_hypothetical=0[\s\S]*i\.has_filter=0/);
  assert.match(verify, /firstColumn\.name=N'DocumentCorIDCanonical'/);
  assert.match(verify, /firstColumn\.collation_name=N'Latin1_General_100_BIN2'/);
  assert.match(verify, /fn_listextendedproperty\(N'CargoRun\.DocumentCorIDCanonicalGuardHash'/);
  assert.match(verify, /@DocumentCorIdCheckDefinitionHash=@DocumentCorIdStoredCheckDefinitionHash/);
  assert.match(verify, /TRANSLATE\([\s\S]*?ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-[\s\S]*?REPLICATE\(N''A'',63\)/);
  assert.match(verify, /CONCAT\(N''Canonical DocumentCorID '',CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2\)[\s\S]*GROUP BY CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2/);
  assert.match(verify, /i\.ignore_dup_key=0/);
  assert.match(verify, /MISSING_DOCUMENTCORID_UNIQUENESS/);
  assert.match(verify, /@DocumentCorIdLegacyUniqueIndexReady[\s\S]*DOCUMENTCORID_LEGACY_UNIQUE_INDEX/);
  assert.match(verify, /@DocumentCorIdUnsafeLinguisticUniqueIndex[\s\S]*DOCUMENTCORID_COLLATION_CONFLICT/);
  assert.match(verify, /@DocumentCorIdCheckReady=1[\s\S]*@DocumentCorIdUniqueIndexReady=1/);
  assert.doesNotMatch(verify, /DOCUMENT_COR_ID_RUNTIME_LOCK/);
});

test('canonical verifier accepts only the exact SQL-safe subset and stops uncertain JavaScript parity', () => {
  const verify = read('migrations/multi-station-foundation-verify.sql');
  const isVerifierParitySafe = (value, operatingDate = '2026-09-26') => {
    if (typeof value !== 'string' || !operatingDate || value.length > 4000) return false;
    if (/[^A-Za-z0-9 \t\n\r]/u.test(value)) return false;
    const compact = value.replace(/[ \t\n\r]+/g, '').toUpperCase();
    const match = compact.match(/^([A-Z0-9]{2,3}?)(\d+)([A-Z]?)$/);
    return Boolean(match && match[2].length <= 15);
  };
  assert.equal(flight.normalizeFlightNumber('CX0178'), 'CX178');
  assert.equal(flight.normalizeFlightNumber('cx0178'), 'CX178');
  assert.equal(flight.normalizeFlightNumber('qi0178'), 'QI178');
  assert.equal(flight.normalizeFlightNumber('CX 0178'), 'CX178');
  assert.equal(flight.normalizeFlightNumber('CX\t0178'), 'CX178');
  assert.equal(flight.normalizeFlightNumber('CX\u00a000178'), 'CX178');
  assert.equal(flight.normalizeFlightNumber('Q\u01310178'), 'QI178');
  assert.equal(flight.normalizeFlightNumber('CX000178A'), 'CX178A');
  assert.equal(flight.normalizeFlightNumber('CX0178Z'), 'CX178Z');
  for (const value of ['CX0178', 'cx0178', 'qi0178', 'CX 0178', 'CX\t0178', 'CX0178Z']) {
    assert.equal(isVerifierParitySafe(value), true, value);
  }
  for (const [value, operatingDate] of [
    ['CX\u00a00178', '2026-09-26'],
    ['Q\u01310178', '2026-09-26'],
    ['CX1234567890123456', '2026-09-26'],
    [null, '2026-09-26'],
    ['', '2026-09-26'],
    ['CX0178', null],
    [`CX${'1'.repeat(3998)}`, '2026-09-26'],
    [`CX${'1'.repeat(4000)}`, '2026-09-26'],
    ['UNSUPPORTED', '2026-09-26'],
    [178, '2026-09-26']
  ]) assert.equal(isVerifierParitySafe(value, operatingDate), false, String(value).slice(0, 30));
  assert.match(verify, /INVALID_FLIGHT_IDENTITY_SCHEMA/);
  assert.match(verify, /system_type_id IN \(167,231\)/);
  assert.match(verify, /system_type_id=40/);
  assert.match(verify, /max_length BETWEEN 1 AND 4000[\s\S]*max_length BETWEEN 2 AND 8000/);
  assert.match(verify, /UPPER\([\s\S]*COLLATE Latin1_General_100_BIN2\)[\s\S]*AS CompactFlightNumber/);
  assert.match(verify, /NCHAR\(9\)[\s\S]*NCHAR\(10\)[\s\S]*NCHAR\(13\)/);
  assert.match(verify, /HasUnsupportedIdentityValue/);
  assert.match(verify, /raw\.OperatingDate IS NULL OR raw\.OriginalFlightNumber IS NULL/);
  assert.match(verify, /NULLIF\(raw\.CompactFlightNumber,N''''\) IS NULL/);
  assert.match(verify, /DATALENGTH\(CONVERT\(nvarchar\(max\),FlightNumber\)\)/);
  assert.match(verify, /LIKE N''%\[\^A-Za-z0-9/);
  assert.match(verify, /PrefixLength IN \(2,3\)/);
  assert.match(verify, /LEFT\(numericPart\.CompactFlightNumber,numericPart\.PrefixLength\)[\s\S]*NOT LIKE N''%\[\^A-Z0-9\]%''/);
  assert.match(verify, /LEN\(numericPart\.NumericSegment\)<=15/);
  assert.match(verify, /SqlParityGuaranteed=0/);
  assert.match(verify, /WHERE SqlParityGuaranteed=1 AND CanonicalFlightNumber IS NOT NULL[\s\S]*GROUP BY StationId,OperatingDate,CanonicalFlightNumber/);
  assert.match(verify, /GROUP BY StationId,OperatingDate,CanonicalFlightNumber/);
  assert.match(verify, /APPLICATION_ASSISTED_NORMALIZATION_REQUIRED/);
  assert.match(verify, /CANONICAL_IDENTITY_COLLISION/);
});

test('FOW verification requires and validates every authoritative ownership link', () => {
  const verify = read('migrations/multi-station-foundation-verify.sql');
  const ownershipConflict = ({ shipment, message, flight }) => !message || message.matchedFlightId == null ||
    shipment.flightId == null || shipment.flightId !== message.matchedFlightId || !flight ||
    message.stationId == null || flight.stationId == null || message.stationId !== flight.stationId;
  const valid = {
    shipment: { machMessageId: 11, flightId: 21 },
    message: { machMessageId: 11, matchedFlightId: 21, stationId: 1 },
    flight: { flightId: 21, stationId: 1 }
  };
  assert.equal(ownershipConflict(valid), false);
  assert.equal(ownershipConflict({ ...valid, message: null }), true);
  assert.equal(ownershipConflict({ ...valid, shipment: { machMessageId: 11, flightId: 22 } }), true);
  assert.equal(ownershipConflict({ ...valid, flight: null }), true);
  assert.equal(ownershipConflict({ ...valid, message: { ...valid.message, stationId: 2 } }), true);
  assert.match(verify, /N'MachFowShipments',N'MachMessageId'/);
  assert.match(verify, /@FowOwnershipSchemaReady=1/);
  assert.match(verify, /LEFT JOIN dbo\.IncomingMachMessages message ON message\.MachMessageId=shipment\.MachMessageId/);
  assert.match(verify, /LEFT JOIN dbo\.Flights flight ON flight\.FlightId=message\.MatchedFlightId/);
  for (const condition of [
    /message\.MachMessageId IS NULL/,
    /message\.MatchedFlightId IS NULL/,
    /shipment\.FlightId<>message\.MatchedFlightId/,
    /flight\.FlightId IS NULL/,
    /message\.StationId<>flight\.StationId/
  ]) assert.match(verify, condition);
  assert.match(verify, /FOW_MESSAGE_OWNERSHIP_CONFLICT/);
  assert.doesNotMatch(verify, /TRY_CONVERT\(bigint,(?:shipment|message)\./);
});

test('required ownership schema is explicit and missing Offload status cannot generate fallback SQL', () => {
  const verify = read('migrations/multi-station-foundation-verify.sql');
  for (const table of ['CargoRunStations', 'Flights', 'IncomingMachMessages', 'Offloads', 'ULDs',
    'ImportCompletionRecords', 'ExportCompletionRecords', 'ExportCompletionAmendments',
    'ExportManifestFinals', 'ExportManifestFinalUlds', 'MachFowShipments']) {
    assert.match(verify, new RegExp(`N'${table}'`), table);
  }
  for (const column of ['Flights.StationId', 'IncomingMachMessages.DocumentCorID',
    'Offloads.OffloadId', 'Offloads.FlightId', 'MachFowShipments.MachMessageId']) {
    const [table, name] = column.split('.');
    assert.match(verify, new RegExp(`N'${table}',N'${name}'`), column);
  }
  assert.match(verify, /@HasStatus=1 THEN N'Status'[\s\S]*@HasOffloadStatus=1 THEN N'OffloadStatus'/);
  assert.match(verify, /system_type_id NOT IN \(167,175,231,239\)/);
  assert.doesNotMatch(verify, /N''''UNKNOWN'''''/);
});

test('active-orphan gate matches runtime Status precedence, rejects disagreement, and never truncates status', () => {
  const migration = read('migrations/multi-station-foundation.sql');
  const verify = read('migrations/multi-station-foundation-verify.sql');
  const normalizeStatus = value => value == null ? null : String(value).trim().toUpperCase();
  const authoritativeStatus = row => Object.hasOwn(row, 'Status') ? row.Status : row.OffloadStatus;
  const dualStatusConflict = row => Object.hasOwn(row, 'Status') && Object.hasOwn(row, 'OffloadStatus') &&
    normalizeStatus(row.Status) !== normalizeStatus(row.OffloadStatus);
  const isBlockingOrphanStatus = value => String(value || '').trim().toUpperCase() !== 'COMPLETE';
  assert.equal(isBlockingOrphanStatus('COMPLETE'), false);
  for (const status of ['REQUESTED', 'TRANSIT', 'COLLECTED', 'UNKNOWN', '', null, `COMPLETE${'X'.repeat(80)}`]) {
    assert.equal(isBlockingOrphanStatus(status), true, String(status));
  }
  assert.equal(authoritativeStatus({ Status: 'COMPLETE' }), 'COMPLETE');
  assert.equal(authoritativeStatus({ OffloadStatus: 'COMPLETE' }), 'COMPLETE');
  assert.equal(authoritativeStatus({ Status: 'REQUESTED', OffloadStatus: 'COMPLETE' }), 'REQUESTED');
  assert.equal(dualStatusConflict({ Status: 'COMPLETE', OffloadStatus: ' complete ' }), false);
  assert.equal(dualStatusConflict({ Status: 'REQUESTED', OffloadStatus: 'COMPLETE' }), true);
  assert.equal(dualStatusConflict({ Status: 'COMPLETE', OffloadStatus: 'TRANSIT' }), true);
  assert.equal(dualStatusConflict({ Status: null, OffloadStatus: '' }), true);
  for (const sql of [migration, verify]) {
    assert.match(sql, /WHEN @HasStatus=1 THEN N'Status'[\s\S]*WHEN @HasOffloadStatus=1 THEN N'OffloadStatus'/);
    assert.match(sql, /CONVERT\(nvarchar\(max\),offload\.\[Status\]\)/);
    assert.match(sql, /CONVERT\(nvarchar\(max\),offload\.\[OffloadStatus\]\)/);
    assert.match(sql, /StatusValue<>normalized\.OffloadStatusValue/);
    assert.doesNotMatch(sql, /CONVERT\(nvarchar\(50\),offload\./);
  }
  assert.match(migration, /@NormalizedOffloadStatusExpression[\s\S]*<>N''COMPLETE''/);
  assert.match(verify, /normalized\.StatusValue=N''COMPLETE''[\s\S]*LEGACY_ORPHAN_OFFLOAD/);
  assert.doesNotMatch(migration, /(?:REQUESTED|TRANSIT|COLLECTED)[\s\S]*THEN[\s\S]*historical/i);
});

test('Phase 2B table variables never use unsupported named constraint grammar', () => {
  for (const file of [
    'migrations/multi-station-foundation.sql',
    'migrations/multi-station-foundation-verify.sql',
    'migrations/multi-station-foundation-preflight.sql',
    'migrations/multi-station-foundation-review-details.sql',
    'migrations/multi-station-flight-review.sql'
  ]) {
    const sql = read(file);
    const declarations = [...sql.matchAll(/DECLARE\s+@\w+\s+table\s*\(([\s\S]*?)\)\s*;/gi)];
    for (const declaration of declarations) {
      assert.doesNotMatch(declaration[1], /\bCONSTRAINT\s+\w+\s+(?:PRIMARY\s+KEY|UNIQUE)\b/i, file);
    }
  }
  assert.match(read('migrations/multi-station-foundation-verify.sql'),
    /DECLARE @RequiredColumns table\([\s\S]*PRIMARY KEY\(TableName,ColumnName\)\)/);
});

test('migration and verifier SQL use safe dynamic execution and verifier remains read-only', () => {
  const migration = read('migrations/multi-station-foundation.sql');
  const verify = read('migrations/multi-station-foundation-verify.sql');
  for (const sql of [migration, verify]) {
    assert.doesNotMatch(sql, /\bEXEC\s*\(/i);
    assert.doesNotMatch(sql, /sp_executesql\s+N?'(?:''|[^'])*'\s*\+/is);
    assert.equal((sql.match(/'/g) || []).length % 2, 0, 'SQL quotes must be balanced');
    const structure = sql
      .replace(/N?'(?:''|[^'])*'/gis, "''")
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\r\n]*/g, '');
    let parenthesisDepth = 0;
    for (const character of structure) {
      if (character === '(') parenthesisDepth += 1;
      if (character === ')') parenthesisDepth -= 1;
      assert.ok(parenthesisDepth >= 0, 'SQL closing parenthesis must have an opener');
    }
    assert.equal(parenthesisDepth, 0, 'SQL parentheses must be balanced outside literals and comments');
  }
  assert.doesNotMatch(verify, /(?:INSERT\s+(?:INTO\s+)?|UPDATE|DELETE\s+FROM|MERGE\s+|ALTER\s+TABLE|DROP\s+|TRUNCATE\s+)dbo\./i);
});

test('MACH station validation rejects contradictory outbound segment evidence', () => {
  const mach = read('api/mach-fow/index.js');
  assert.match(mach, /const segmentDeparture[\s\S]*'StsSegDep'/);
  assert.match(mach, /eventStation && eventStation !== operationalStation\.stationCode/);
  assert.match(mach, /segmentDeparture && segmentDeparture !== operationalStation\.stationCode/);
  assert.match(mach, /destination[\s\S]*DestinationAirport/);
});

test('StationId overrides contradictory route evidence and invalid explicit ownership never falls back', async () => {
  const explicit = sqlHarness({ stationRows: [syd] });
  const resolved = await authorization.requireOperationalCapability(
    {}, explicit.sql, actor,
    { StationId: 2, Direction: 'IMPORT', DestinationAirport: 'MEL' },
    'VIEW_FLIGHTS'
  );
  assert.equal(resolved.stationCode, 'SYD');
  assert.equal(explicit.state.queries[0].values.ResolvedStationId, '2');

  await assert.rejects(
    authorization.requireOperationalCapability(
      {}, sqlHarness({ stationRows: [] }).sql, actor,
      { StationId: 999, Direction: 'IMPORT', DestinationAirport: 'MEL' },
      'VIEW_FLIGHTS'
    ),
    error => error.code === 'STATION_ACCESS_DENIED'
  );
});

test('legacy route compatibility is centralized, applies only to null StationId, and can be disabled', async () => {
  assert.equal(station.LEGACY_NULL_STATION_COMPATIBILITY_ENABLED, true);
  const compatible = sqlHarness({ stationRows: [mel] });
  const resolved = await station.resolveFlightStation(
    {}, compatible.sql,
    { StationId: null, Direction: 'IMPORT', DestinationAirport: 'MEL' }
  );
  assert.equal(resolved.stationCode, 'MEL');
  assert.equal(compatible.state.queries[0].values.ResolvedStationCode, 'MEL');
  await assert.rejects(
    station.resolveFlightStation(
      {}, compatible.sql,
      { StationId: null, Direction: 'IMPORT', DestinationAirport: 'MEL' },
      { compatibilityEnabled: false }
    ),
    error => error.code === 'STATION_UNAVAILABLE'
  );
  const authSource = read('api/shared/operational-authorization.js');
  assert.match(authSource, /StationId IS NULL[\s\S]*Direction/);
  assert.match(authSource, /StationId IS NOT NULL[\s\S]*CargoRunStations/);
});

test('browser station narrowing cannot select a station lacking the required capability', async () => {
  const access = {
    requiredCapability: 'UPLOAD_FLIGHT_DATA',
    stations: ['MEL', 'SYD'],
    stationMetadata: [station.normalizeStationRecord(mel), station.normalizeStationRecord(syd)],
    capabilitiesByStation: { MEL: ['UPLOAD_FLIGHT_DATA'], SYD: ['VIEW_FLIGHTS'] }
  };
  await assert.rejects(
    station.resolveAuthorizedStation({}, sqlHarness({ stationRows: [syd] }).sql, access, 'SYD'),
    error => error.code === 'STATION_ACCESS_DENIED'
  );
  const selected = await station.resolveAuthorizedStation({}, sqlHarness({ stationRows: [mel] }).sql, access, 'MEL');
  assert.equal(selected.stationCode, 'MEL');

  let response;
  assert.equal(authorization.sendOperationalAuthorizationError(
    {},
    new station.StationResolutionError('STATION_ACCESS_DENIED', 'internal station detail'),
    (_context, status, body) => { response = { status, body }; }
  ), true);
  assert.deepEqual(response, {
    status: 403,
    body: {
      ok: false,
      code: 'STATION_ACCESS_DENIED',
      error: 'The authenticated user is not authorized for this operation at the selected station'
    }
  });
});

test('route fields validate the selected station without becoming ownership authority', () => {
  assert.equal(station.routeMatchesStation({ Direction: 'IMPORT', DestinationAirport: 'MEL' }, 'MEL'), true);
  assert.equal(station.routeMatchesStation({ Direction: 'EXPORT', OriginAirport: 'MEL' }, 'MEL'), true);
  assert.equal(station.routeMatchesStation({ Direction: 'IMPORT', DestinationAirport: 'SYD' }, 'MEL'), false);
});

test('station-aware v2 identity locks isolate equal visible identities at different stations', () => {
  assert.equal(flight.normalizeFlightNumber(' CX 00178 '), 'CX178');
  assert.equal(flight.flightIdentityLockResource(1, '2026-09-17', 'CX0178'), 'CargoRun:Flight:v2:1:2026-09-17:CX178');
  assert.notEqual(
    flight.flightIdentityLockResource(1, '2026-09-17', 'CX178'),
    flight.flightIdentityLockResource(2, '2026-09-17', 'CX178')
  );
});

test('all creation and lifecycle paths use StationId and the shared v2 lock', () => {
  const creators = {
    'api/flights/index.js': /INSERT INTO dbo\.Flights\(StationId/,
    'api/manifest-upload/index.js': /INSERT INTO dbo\.Flights[\s\S]*StationId/,
    'api/mach-fow/index.js': /INSERT INTO dbo\.Flights[\s\S]*StationId/
  };
  for (const [file, insertPattern] of Object.entries(creators)) {
    const source = read(file);
    assert.match(source, insertPattern, file);
    assert.match(source, /acquireFlightIdentityLock\([\s\S]{0,180}stationId/i, file);
  }
  const productionApi = fs.readdirSync(path.join(root, 'api'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, 'api', entry.name, 'index.js'))
    .filter(filename => fs.existsSync(filename))
    .map(filename => fs.readFileSync(filename, 'utf8')).join('\n');
  assert.doesNotMatch(productionApi, /UPDATE\s+dbo\.Flights\s+SET\s+StationId/i);
  const manifest = read('api/manifest-upload/index.js');
  assert.match(manifest, /WHERE StationId=@UwsStationId AND OperatingDate/);
  assert.match(manifest, /WHERE StationId = @StationId AND OperatingDate/);
  const mach = read('api/mach-fow/index.js');
  assert.match(mach, /INSERT INTO dbo\.IncomingMachMessages[\s\S]*StationId/);
  assert.match(mach, /MACHINE_STATION_CODE[\s\S]*resolveStationByCode/);
  assert.match(mach, /m\.DocumentCorID COLLATE Latin1_General_100_BIN2[\s\S]*@DocumentCorID COLLATE Latin1_General_100_BIN2/);
  for (const file of ['api/ulds/index.js', 'api/import-completions/index.js', 'api/export-completions/index.js', 'api/export-manifest-final/index.js']) {
    assert.match(read(file), /acquireFlightIdentityLock\([\s\S]{0,180}StationId/i, file);
  }
});

test('list and exact entity authorization inherit explicit flight ownership', () => {
  const source = read('api/shared/operational-authorization.js');
  assert.match(source, /authorizedStation\.StationId=\$\{qualified\}\.StationId/);
  for (const file of ['api/ulds/index.js', 'api/uld-status/index.js', 'api/mail-scan/index.js', 'api/offloads/index.js', 'api/flight-statement/index.js', 'api/flight-status/index.js']) {
    assert.match(read(file), /StationId/, file);
  }
  for (const file of ['api/flights/index.js', 'api/history/index.js', 'api/offloads/index.js', 'api/import-completions/index.js', 'api/export-completions/index.js', 'api/mach-fow/index.js']) {
    assert.match(read(file), /authorizeRequestedStation/, file);
    assert.match(read(file), /StationId=@(?:Selected)?StationId/, file);
  }
});

test('session exposes safe station metadata while preserving legacy station codes', () => {
  const session = read('api/session/index.js');
  const auth = read('api/shared/operational-authorization.js');
  assert.match(session, /stations: access\.stations/);
  assert.match(session, /const stationMetadata = access\.stationMetadata\.map/);
  assert.match(session, /capabilities: capabilitiesForStation\(access, station\.stationId\)/);
  assert.match(session, /stationMetadata,/);
  for (const field of ['StationId', 'StationCode', 'DisplayName', 'TimeZoneId']) assert.match(auth, new RegExp(field));
});

test('station timezone foundation uses station-local service dates and fixed MEL/AKL zones', () => {
  assert.equal(station.STATION_TIME_ZONE_FIXTURES.MEL, 'Australia/Melbourne');
  assert.equal(station.STATION_TIME_ZONE_FIXTURES.AKL, 'Pacific/Auckland');
  assert.equal(station.stationLocalDate('2026-01-01T13:30:00.000Z', 'Australia/Melbourne'), '2026-01-02');
  assert.equal(station.stationLocalDate('2026-01-01T11:30:00.000Z', 'Pacific/Auckland'), '2026-01-02');
  assert.match(read('api/mach-fow/index.js'), /EventLocalDateTime/);
  assert.doesNotMatch(read('api/mach-fow/index.js'), /eventLocal\s*\+\s*['"]Z['"]/);
  assert.match(read('docs/multi-station-timezone-foundation.md'), /does not label them as UTC/);
  assert.doesNotMatch(read('migrations/multi-station-foundation.sql'), /EventLocalDateTime|StsTime/);
});

test('configuration precedence remains Global, Station, Airline, Airline plus Station', () => {
  const coverage = read('tests/admin-configuration.test.js');
  assert.match(coverage, /scope precedence is Global then Station then Airline then Airline\+Station/);
  assert.match(coverage, /most-specific/i);
});
