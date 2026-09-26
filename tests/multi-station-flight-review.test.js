'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const reviewSql = fs.readFileSync(path.join(root, 'migrations', 'multi-station-flight-review.sql'), 'utf8');
const preflightSql = fs.readFileSync(path.join(root, 'migrations', 'multi-station-foundation-preflight.sql'), 'utf8');

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');
}

function withoutSqlStrings(source) {
  return source.replace(/N?'(?:''|[^'])*'/g, "''");
}

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing block markers: ${startMarker} / ${endMarker}`);
  return source.slice(start, end).trim().replace(/\r\n/g, '\n');
}

test('flight review is read-only and emits exactly one dynamic result set', () => {
  const executable = withoutComments(reviewSql);
  assert.doesNotMatch(executable, /\b(?:ALTER|CREATE\s+TABLE|INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/i);
  assert.equal((reviewSql.match(/\bEXEC\s+sys\.sp_executesql\s+@ExecutableSql;/gi) || []).length, 1);
  assert.doesNotMatch(reviewSql, /\bEXEC(?:UTE)?\s*\(/i);
  assert.doesNotMatch(reviewSql, /EXEC(?:UTE)?\s+(?:sys\.)?sp_executesql\s+(?:N?'|@[A-Za-z0-9_]+\s*\+)/i);
  assert.doesNotMatch(withoutSqlStrings(executable), /\bSELECT\b/i);
});

test('flight classifier is copied exactly from the authoritative preflight', () => {
  const start = '-- Optional source fields are selected only when the live columns exist.';
  assert.equal(
    block(reviewSql, start, '-- 12. Canonical identity preflight.'),
    block(preflightSql, start, '-- 10. Flight population inventory.')
  );
  assert.equal(
    block(reviewSql, '-- 12. Canonical identity preflight.', '-- Review-only evidence projections'),
    block(preflightSql, '-- 12. Canonical identity preflight.', 'IF @FlightCoreReady=1')
  );
});

test('one exportable result includes all flight STOP classes and required review columns', () => {
  for (const classification of ['CONTRADICTORY_ROUTE', 'AMBIGUOUS_FLIGHT',
    'CANONICAL_IDENTITY_COLLISION', 'APPLICATION_ASSISTED_NORMALIZATION_REQUIRED']) {
    assert.match(reviewSql, new RegExp(`\\b${classification}\\b`));
  }
  for (const field of ['FlightId', 'FlightNumber', 'OperatingDate', 'Direction', 'OriginAirport',
    'DestinationAirport', 'FlightStatus', 'Classification', 'ClassificationReason',
    'CanonicalFlightNumber', 'CanonicalIdentityKey', 'SourceIndicator', 'CreatedAtUtc']) {
    assert.match(reviewSql, new RegExp(`\\b${field}\\b`));
  }
  assert.match(reviewSql, /OwnershipClassification IN \(N''CONTRADICTORY'',N''AMBIGUOUS''\)/);
  assert.doesNotMatch(reviewSql, /OwnershipClassification<>N''SAFE_MEL_CANDIDATE''/);
  assert.match(reviewSql, /OPERATOR_CONFIRMED_MEL_BACKFILL/);
  assert.match(reviewSql, /collision\.NormalizedFlightNumber IS NOT NULL/);
  assert.match(reviewSql, /ApplicationAssistedNormalizationRequired/);
});

test('MACH and FOW evidence fields are schema-gated', () => {
  for (const gate of [
    "COL_LENGTH(N'dbo.IncomingMachMessages',N'StationAirport')",
    "COL_LENGTH(N'dbo.IncomingMachMessages',N'OriginAirport')",
    "COL_LENGTH(N'dbo.IncomingMachMessages',N'StsSegDep')",
    "COL_LENGTH(N'dbo.IncomingMachMessages',N'SegmentOrigin')",
    "COL_LENGTH(N'dbo.IncomingMachMessages',N'DestinationAirport')",
    "COL_LENGTH(N'dbo.IncomingMachMessages',N'StsSegArr')",
    "COL_LENGTH(N'dbo.IncomingMachMessages',N'SegmentDestination')",
    "COL_LENGTH(N'dbo.IncomingMachMessages',N'DocumentCorID')",
    "COL_LENGTH(N'dbo.IncomingMachMessages',N'MatchedFlightId')",
    "COL_LENGTH(N'dbo.MachFowShipments',N'FlightId')",
    "COL_LENGTH(N'dbo.MachFowShipments',N'MachMessageId')"
  ]) assert.ok(reviewSql.includes(gate), `missing schema gate: ${gate}`);

  for (const field of ['MatchedFlightId', 'FowFlightId', 'MachMessageId', 'DocumentCorID',
    'StationAirport', 'SegmentOrigin', 'SegmentDestination', 'MachSourceType',
    'MachOperatingDate', 'MachObservedAtUtc', 'FowUldId', 'FowUldNumber', 'MawbNumber']) {
    assert.match(reviewSql, new RegExp(`\\b${field}\\b`));
  }
});
