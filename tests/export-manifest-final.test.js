'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  ManifestFinalError,
  normalizeManifestItems,
  reconcileManifest,
  manifestHash
} = require('../api/shared/export-manifest-final');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations', 'export-manifest-final.sql'), 'utf8');
const preflight = fs.readFileSync(path.join(root, 'migrations', 'export-manifest-final-preflight.sql'), 'utf8');
const verify = fs.readFileSync(path.join(root, 'migrations', 'export-manifest-final-verify.sql'), 'utf8');

test('final manifest normalizes canonical ULD identity and rejects duplicate formatting variants', () => {
  const rows = normalizeManifestItems([
    { uldNumber: ' ake-00123-cx ', shcs: ['mal', 'MAL'] },
    { uldNumber: 'PMC48921R7' }
  ]);
  assert.deepEqual(rows.map(row => row.uldNumber), ['AKE00123CX', 'PMC48921R7']);
  assert.deepEqual(rows[0].shcs, ['MAL']);
  assert.throws(
    () => normalizeManifestItems([{ uldNumber: 'AKE 12345 CX' }, { uldNumber: 'AKE-12345-CX' }]),
    error => error instanceof ManifestFinalError && error.code === 'FINAL_MANIFEST_DUPLICATE_ULD'
  );
});

test('reconciliation retains stable rows and classifies matched, added, and excluded without mutation', () => {
  const existing = [
    { UldId: 1, UldNumber: 'AKE-11111-CX', CurrentStatus: 'AT_AIRCRAFT', IdentityVerified: 1 },
    { UldId: 2, UldNumber: 'AKE22222CX', CurrentStatus: 'TRANSIT', IdentityVerified: 1 }
  ];
  const before = structuredClone(existing);
  const items = normalizeManifestItems([{ uldNumber: 'AKE11111CX' }, { uldNumber: 'PMC33333CX' }]);
  const result = reconcileManifest(existing, items);
  assert.deepEqual(result.matched.map(row => row.row.UldId), [1]);
  assert.deepEqual(result.added.map(row => row.item.uldNumber), ['PMC33333CX']);
  assert.deepEqual(result.excluded.map(row => row.row.UldId), [2]);
  assert.deepEqual(existing, before);
});

test('all matched FOW ULDs preserve every operational status and identity flag', () => {
  const existing = [
    { UldId: 1, UldNumber: 'AKE11111CX', CurrentStatus: 'WAREHOUSE', IdentityVerified: 0 },
    { UldId: 2, UldNumber: 'AKE22222CX', CurrentStatus: 'TRANSIT', IdentityVerified: 1 },
    { UldId: 3, UldNumber: 'PMC33333CX', CurrentStatus: 'AT_AIRCRAFT', IdentityVerified: 1 }
  ];
  const before = structuredClone(existing);
  const result = reconcileManifest(existing, normalizeManifestItems(existing.map(row => ({
    uldNumber: row.UldNumber
  }))));
  assert.equal(result.matched.length, 3);
  assert.equal(result.added.length, 0);
  assert.equal(result.excluded.length, 0);
  assert.deepEqual(existing, before);
});

test('legacy canonical collisions fail closed and manifest hashes are deterministic', () => {
  const items = normalizeManifestItems([{ uldNumber: 'AKE12345CX' }]);
  assert.throws(
    () => reconcileManifest([
      { UldId: 1, UldNumber: 'AKE12345CX' },
      { UldId: 2, UldNumber: 'AKE-12345-CX' }
    ], items),
    error => error.code === 'FINAL_MANIFEST_ULD_IDENTITY_CONFLICT' && error.status === 409
  );
  assert.equal(manifestHash(items), manifestHash(normalizeManifestItems([{ uldNumber: 'ake-12345-cx' }])));
  assert.match(manifestHash(items), /^[a-f0-9]{64}$/);
});

test('migration persists one immutable FINAL and exact FlightId plus UldId membership', () => {
  assert.match(migration, /CREATE TABLE dbo\.ExportManifestFinals/);
  assert.match(migration, /CREATE TABLE dbo\.ExportManifestFinalUlds/);
  assert.match(migration, /UQ_ExportManifestFinals_Flight UNIQUE \(FlightId\)/);
  assert.match(migration, /FOREIGN KEY \(FlightId,UldId\)[\s\S]*REFERENCES dbo\.ULDs\(FlightId,UldId\)/);
  assert.match(migration, /INSTEAD OF UPDATE, DELETE/g);
  assert.match(migration, /TR_ExportManifestFinalUlds_InsertGuard/);
  assert.match(migration, /MembershipCount>f\.FinalUldCount/);
  assert.doesNotMatch(migration, /ON DELETE CASCADE/i);
  assert.match(preflight, /MISSING_UNIQUE_ULD_OWNERSHIP_KEY/);
  assert.match(preflight, /FINAL_TABLE_ALREADY_PRESENT/);
  assert.match(verify, /HAVING COUNT\(m\.UldId\)<>f\.FinalUldCount/);
  assert.match(verify, /COUNT_BIG\(\*\) AS RecordCount/);
  assert.doesNotMatch(verify, /\bRowCount\b/i);
});

test('frontend derives FINAL expected counts from membership and keeps NOT ON FINAL visible', () => {
  const context = vm.createContext({});
  const source = html.slice(
    html.indexOf('function expectedUldsForFlight('),
    html.indexOf('function allShcs(', html.indexOf('function expectedUldsForFlight('))
  );
  vm.runInContext(source, context);
  const flight = {
    exportManifestFinal: { finalManifestId: '9' },
    ulds: [
      { num: 'AKE11111CX', status: 'At Aircraft', isFinalManifestMember: true },
      { num: 'AKE22222CX', status: 'Warehouse', isFinalManifestMember: false }
    ]
  };
  assert.deepEqual({ ...context.counts(flight, 'exports') }, { done: 1, total: 1 });
  assert.equal(context.expectedUldsForFlight(flight, 'exports')[0].num, 'AKE11111CX');
  assert.equal(context.expectedUldsForFlight(flight, 'imports').length, 2);
});

test('FINAL UI uses exact FlightId, deliberate preview/confirm, and all required operational surfaces', () => {
  assert.match(html, /previewFinalManifest\(flightId\)/);
  assert.match(html, /confirmFinalManifest\(flightId\)/);
  assert.match(html, /action: 'PREVIEW',[\s\S]*flightId: stableFlightId/);
  assert.match(html, /action: 'CONFIRM',[\s\S]*flightId: stableFlightId/);
  assert.match(html, /data-flight-id="\$\{esc\(stableFlightId\)\}"/);
  assert.match(html, /function manifestStateBadge[\s\S]*BUILD OPEN[\s\S]*FINAL/);
  assert.match(html, /function flightBoardCard[\s\S]*manifestStateBadge\(f\)/);
  assert.match(html, /function exportsUrgencySummary[\s\S]*expectedUldsForFlight\(f,'exports'\)/);
  assert.match(html, /function desktopFlightSelector[\s\S]*manifestStateBadge\(f\)/);
  assert.match(html, /function desktopFlightDetailPanel[\s\S]*manifestStateBadge\(f\)/);
  assert.match(html, /function supervisorWorkloadRow[\s\S]*type==='exports'\?manifestStateBadge\(f\)/);
  assert.match(html, /finalExports=exports\.filter\(f=>f\.exportManifestFinal\)\.length/);
  assert.match(html, /NOT ON FINAL/);
});

test('server writes FINAL atomically without updating existing operational ULD rows', () => {
  const api = fs.readFileSync(path.join(root, 'api', 'export-manifest-final', 'index.js'), 'utf8');
  assert.match(api, /await transaction\.begin\(\)/);
  assert.match(api, /acquireFlightIdentityLock/);
  assert.match(api, /INSERT INTO dbo\.ExportManifestFinals/);
  assert.match(api, /INSERT INTO dbo\.ExportManifestFinalUlds/);
  assert.match(api, /EXPORT_MANIFEST_FINAL_CONFIRMED/);
  assert.match(api, /await transaction\.commit\(\)/);
  assert.doesNotMatch(api, /UPDATE dbo\.ULDs/i);
});

test('post-FINAL writers fail closed or retain FOW evidence without changing membership', () => {
  const fow = fs.readFileSync(path.join(root, 'api', 'mach-fow', 'index.js'), 'utf8');
  const upload = fs.readFileSync(path.join(root, 'api', 'manifest-upload', 'index.js'), 'utf8');
  const ulds = fs.readFileSync(path.join(root, 'api', 'ulds', 'index.js'), 'utf8');
  assert.match(fow, /PROCESSED_POST_FINAL/);
  assert.match(fow, /POST_FINAL_FOW_IGNORED/);
  assert.match(fow, /ignoredPostFinal: true/);
  assert.match(upload, /EXPORT_MANIFEST_ALREADY_FINAL/);
  assert.match(ulds, /EXPORT_MANIFEST_ALREADY_FINAL/);
  assert.match(ulds, /CONVERT\(char\(10\),OperatingDate,23\) AS OperatingDateIso/);
  assert.match(ulds, /selectedFlight\.OperatingDateIso \|\| selectedFlight\.OperatingDate/);
});

test('operational flight finalisation stays separate and uses FINAL membership only for readiness', () => {
  const completion = fs.readFileSync(path.join(root, 'api', 'export-completions', 'index.js'), 'utf8');
  assert.match(completion, /LEFT JOIN dbo\.ExportManifestFinals mf/);
  assert.match(completion, /mf\.FinalManifestId IS NULL OR m\.UldId IS NOT NULL/);
  assert.match(completion, /INSERT INTO dbo\.ExportCompletionRecords/);
  assert.match(completion, /UPDATE dbo\.Flights SET FlightStatus='FINALISED'/);
  assert.doesNotMatch(completion, /UPDATE dbo\.ExportManifestFinals/);
  assert.match(html, /const expected=expectedUldsForFlight\(f,'exports'\);if\(!expected\.length\|\|!expected\.every/);
  assert.match(completion, /buildCompletionSnapshot\(tx,sql,\{direction:'EXPORT',flightId,flight,actor:identity\}\)/);
  assert.match(html, /body:JSON\.stringify\(\{flightId:f\.azureFlightId\}\)/);
  assert.doesNotMatch(html, /body:JSON\.stringify\(\{flightId:f\.azureFlightId,finalizedBy:/);
  assert.match(html, /activeExp\.forEach\(f=>\{const expected=expectedUldsForFlight\(f,'exports'\)/);
});
