'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const preflightPath = path.join(root, 'migrations', 'multi-station-foundation-preflight.sql');
const sql = fs.readFileSync(preflightPath, 'utf8');

function executableSql(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');
}

test('multi-station preflight is read-only and creates no competing station master', () => {
  const executable = executableSql(sql);
  assert.doesNotMatch(executable, /^\s*(?:ALTER|CREATE\s+TABLE|DROP|TRUNCATE|INSERT|UPDATE|DELETE|MERGE)\b/im);
  assert.doesNotMatch(executable, /\b(?:ALTER|CREATE\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE|INSERT\s+INTO|UPDATE\s+dbo\.|DELETE\s+FROM|MERGE\s+dbo\.)\b/i);
  assert.doesNotMatch(sql, /CREATE\s+TABLE\s+(?:dbo\.)?(?!#)CargoRunStations/i);
  assert.match(sql, /CargoRunStations[^\r\n]*AUTHORITATIVE_STATION_MASTER|AUTHORITATIVE_STATION_MASTER[^\r\n]*CargoRunStations/i);
});

test('multi-station preflight inventories live schema and target StationId columns', () => {
  for (const catalog of ['sys.tables', 'sys.columns', 'sys.indexes', 'sys.foreign_keys', 'sys.check_constraints', 'sys.triggers', 'sys.default_constraints']) {
    assert.match(sql, new RegExp(catalog.replace('.', '\\.'), 'i'));
  }
  assert.match(sql, /COL_LENGTH\(N'dbo\.Flights',N'StationId'\)/i);
  assert.match(sql, /COL_LENGTH\(N'dbo\.IncomingMachMessages',N'StationId'\)/i);
  assert.match(sql, /MISSING_REQUIRED_SCHEMA/i);
  assert.match(sql, /STATION_MASTER_INVALID/i);
});

test('multi-station preflight keeps route-only ownership ambiguous and corroborates MACH evidence', () => {
  assert.match(sql, /SAFE_MEL_CANDIDATE/);
  assert.match(sql, /AMBIGUOUS/);
  assert.match(sql, /CONTRADICTORY/);
  assert.match(sql, /Route is MEL-consistent but lacks independent database corroboration/);
  assert.match(sql, /MachMelCount>0/);
  assert.match(sql, /MachRouteConflictCount>0/);
  assert.match(sql, /Matched MACH segment contradicts the flight route/);
  assert.match(sql, /MACH_STATION_CONFLICT/);
  assert.match(sql, /UNMATCHED_MACH_MESSAGE/);
  assert.match(sql, /DocumentCorID/);
});

test('multi-station preflight detects canonical collisions without claiming unsafe SQL parity', () => {
  assert.match(sql, /api\/shared\/flight\.js/);
  assert.match(sql, /OperatingDate,NormalizedFlightNumber/);
  assert.match(sql, /CANONICAL_IDENTITY_COLLISION/);
  assert.match(sql, /APPLICATION_ASSISTED_NORMALIZATION_REQUIRED/);
  assert.match(sql, /SqlParityGuaranteed/);
  assert.match(sql, /LEN\(numericPart\.NumericSegment\)<=15/);
  assert.doesNotMatch(sql, /UNIQUE\s*\(\s*StationId\s*,\s*OperatingDate/i);
});

test('multi-station preflight checks child and historical ownership and emits a fail-closed decision', () => {
  for (const table of [
    'ULDs', 'Offloads', 'ImportCompletionRecords', 'ExportCompletionRecords',
    'ExportCompletionAmendments', 'ExportManifestFinals', 'ExportManifestFinalUlds',
    'MachFowShipments', 'AuditEvents'
  ]) {
    assert.match(sql, new RegExp(`dbo\\.${table}`));
  }
  assert.match(sql, /ORPHAN_CHILD/);
  assert.match(sql, /AUDIT_WITHOUT_FLIGHT/);
  assert.match(sql, /CLOSED.*FINALISED.*FINALIZED/s);
  assert.match(sql, /LEGACY_ROW_WOULD_BE_INACCESSIBLE_UNTIL_BACKFILLED/);
  assert.match(sql, /WHEN EXISTS \(SELECT 1 FROM Findings WHERE Severity=N''STOP''\) THEN N''STOP'' ELSE N''PROCEED''/);
});
