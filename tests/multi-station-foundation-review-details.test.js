'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const detailSql = fs.readFileSync(path.join(root, 'migrations', 'multi-station-foundation-review-details.sql'), 'utf8');
const preflightSql = fs.readFileSync(path.join(root, 'migrations', 'multi-station-foundation-preflight.sql'), 'utf8');

function executableSql(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');
}

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing block markers: ${startMarker} / ${endMarker}`);
  return source.slice(start, end).trim().replace(/\r\n/g, '\n');
}

test('review detail extractor is read-only and returns exactly two dynamic result sets', () => {
  const executable = executableSql(detailSql);
  assert.doesNotMatch(executable, /^\s*(?:ALTER|CREATE\s+TABLE|DROP|TRUNCATE|INSERT|UPDATE|DELETE|MERGE)\b/im);
  assert.doesNotMatch(executable, /\b(?:ALTER|CREATE\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE|INSERT\s+INTO|UPDATE\s+dbo\.|DELETE\s+FROM|MERGE\s+dbo\.)\b/i);
  assert.equal((detailSql.match(/\bEXEC\s+sys\.sp_executesql\s+@ExecutableSql;/gi) || []).length, 2);
  assert.doesNotMatch(detailSql, /\bEXEC(?:UTE)?\s*\(/i);
  assert.doesNotMatch(detailSql, /EXEC(?:UTE)?\s+(?:sys\.)?sp_executesql\s+(?:N?'|@[A-Za-z0-9_]+\s*\+)/i);
});

test('flight classifier is copied exactly from the authoritative preflight', () => {
  const start = '-- Optional source fields are selected only when the live columns exist.';
  assert.equal(
    block(detailSql, start, '-- 12. Canonical identity preflight.'),
    block(preflightSql, start, '-- 10. Flight population inventory.')
  );
  assert.equal(
    block(detailSql, '-- 12. Canonical identity preflight.', '-- Review-only evidence projections'),
    block(preflightSql, '-- 12. Canonical identity preflight.', 'IF @FlightCoreReady=1')
  );
});

test('first result includes every flight-level STOP class and available MACH/FOW evidence', () => {
  assert.match(detailSql, /CONTRADICTORY_ROUTE/);
  assert.match(detailSql, /AMBIGUOUS_FLIGHT/);
  assert.match(detailSql, /CANONICAL_IDENTITY_COLLISION/);
  assert.match(detailSql, /APPLICATION_ASSISTED_NORMALIZATION_REQUIRED/);
  for (const field of ['FlightId', 'FlightNumber', 'OperatingDate', 'Direction', 'OriginAirport',
    'DestinationAirport', 'FlightStatus', 'DocumentCorID', 'StationAirport', 'SegmentOrigin',
    'SegmentDestination', 'MachMessageId', 'FowUldId', 'MawbNumber']) {
    assert.match(detailSql, new RegExp(`\\b${field}\\b`));
  }
  assert.match(detailSql, /OwnershipClassification IN \(N''CONTRADICTORY'',N''AMBIGUOUS''\)/);
  assert.doesNotMatch(detailSql, /OwnershipClassification<>N''SAFE_MEL_CANDIDATE''/);
});

test('second result uses the preflight orphan predicate and gates optional Offloads columns', () => {
  assert.match(detailSql, /FROM dbo\.Offloads offload\s+LEFT JOIN dbo\.Flights flight ON flight\.FlightId=offload\.FlightId\s+WHERE offload\.FlightId IS NULL OR flight\.FlightId IS NULL/s);
  assert.match(detailSql, /NULL_FLIGHT_ID/);
  assert.match(detailSql, /NONEXISTENT_FLIGHT_ID/);
  assert.match(detailSql, /COL_LENGTH\(N'dbo\.Offloads',N'OffloadId'\)/);
  assert.match(detailSql, /COL_LENGTH\(N'dbo\.Offloads',N'RequestedAtUtc'\)/);
  assert.match(detailSql, /COL_LENGTH\(N'dbo\.Offloads',N'CollectedAtUtc'\)/);
  assert.match(detailSql, /COL_LENGTH\(N'dbo\.Offloads',N'CompletedAtUtc'\)/);
});
