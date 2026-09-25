'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ExportUwsError,
  detectWorkbookType,
  parseExportUws,
  matchExportUwsFlight
} = require('../api/shared/export-uws');
const { normalizeManifestItems, reconcileManifest } = require('../api/shared/export-manifest-final');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const uploadApi = fs.readFileSync(path.join(root, 'api', 'manifest-upload', 'index.js'), 'utf8');

function row(size, values) {
  const result = Array(size).fill('');
  for (const [index, value] of Object.entries(values)) result[Number(index)] = value;
  return result;
}

function uwsWorkbook(overrides = {}) {
  const flight = overrides.flight || 'CX0134';
  const date = overrides.date || '19-Sep-2026';
  const station = overrides.station || 'MEL';
  const destination = overrides.destination || 'HKG';
  const rows = [
    row(30, { 1: 'CX', 5: 'ULD/BULK LOAD WEIGHT STATEMENT' }),
    row(30, { 16: 'All weights in Kilogram' }),
    row(30, { 1: 'STATION', 5: 'FLIGHT NO', 14: 'REGISTRATION', 24: 'DATE' }),
    row(30, { 1: station, 5: flight, 14: 'BLRN', 24: date }),
    row(30, { 1: 'UNIT LOAD DEVICES(ULD)' }),
    row(30, { 1: 'T', 2: 'Number', 4: 'Unload Station', 5: 'Pcs', 7: 'Tare Weight', 9: 'Net Weight', 11: 'Gross Weight', 14: 'Contour Code', 21: 'Priority', 25: 'SHC', 27: 'Remarks' }),
    row(30, { 1: 1, 2: 'PMC97525R7', 4: destination, 5: 165, 7: 120, 9: 4400, 11: 4520, 14: 'A2', 25: 'BUP,COL,EAW,PER,SPX' }),
    row(30, { 1: 2, 2: 'AKE47186CX', 4: destination, 5: 1, 7: 86, 9: 1384, 11: 1470, 25: 'BUP,COL,EAP,ICE,PER,SPX', 27: 'DRY ICE 30 KG CLASS 9' }),
    row(30, { 1: 'ULD TOTAL', 5: 166, 11: 5990 }),
    row(30, { 1: 'T', 2: 'Trolley/Barrow ID', 3: 'Unload Station', 6: 'Pcs', 8: 'Weight', 12: 'AWB', 20: 'Priority', 23: 'SHC', 26: 'Remarks' }),
    row(30, { 1: 'BULK LOAD CARGO' }),
    row(30, { 1: 1, 3: destination, 6: 7, 8: 20, 12: '160-10290873', 23: 'EAW,SPX', 26: 'Loose cargo' }),
    row(30, { 1: 'BULK CARGO TOTAL', 6: 7, 8: 20 })
  ];
  return { sheets: [{ name: overrides.sheetName || 'UWS', rows }] };
}

test('structural detector preserves Import ULD Summary and existing Export Unit List', () => {
  const importWorkbook = { sheets: [{ name: 'Sheet1', rows: [
    ['Import ULD Summary (CX0163 19 Sep 2026)'],
    ['ULD Number', 'ULD Type', 'Manifest Weight']
  ] }] };
  const exportWorkbook = { sheets: [{ name: 'Sheet1', rows: [
    ['Export Unit List', 'Flight Number: CX0134', 'Date: 19 Sep 2026'],
    ['ULD Number', 'Gross Weight', 'SHC']
  ] }] };
  assert.equal(detectWorkbookType(importWorkbook), 'IMPORT_ULD_SUMMARY');
  assert.equal(detectWorkbookType(exportWorkbook), 'EXPORT_UNIT_LIST');
});

test('MACH Export UWS is detected from workbook structure without a filename', () => {
  assert.equal(detectWorkbookType(uwsWorkbook()), 'EXPORT_UWS');
  assert.equal(parseExportUws(uwsWorkbook(), { sourceFileName: 'anything.xlsx' }).documentType, 'EXPORT_UWS');
});

test('Export UWS parser returns rich ULD data, raw SHCs, dry ice, and separate bulk cargo', () => {
  const parsed = parseExportUws(uwsWorkbook(), { sourceFileName: 'UWSTemp3Report.xlsx' });
  assert.equal(parsed.flightNumber, 'CX0134');
  assert.equal(parsed.canonicalFlightNumber, 'CX134');
  assert.equal(parsed.operatingDate, '2026-09-19');
  assert.equal(parsed.station, 'MEL');
  assert.equal(parsed.destination, 'HKG');
  assert.equal(parsed.ulds.length, 2);
  assert.deepEqual(parsed.ulds[1], {
    uldNumber: 'AKE47186CX', destination: 'HKG', pieces: 1,
    tareWeightKg: 86, netWeightKg: 1384, grossWeightKg: 1470,
    contour: null, priorityText: null,
    shcs: ['BUP', 'COL', 'EAP', 'ICE', 'PER', 'SPX'],
    remarks: 'DRY ICE 30 KG CLASS 9', dryIceText: 'DRY ICE 30 KG CLASS 9'
  });
  assert.deepEqual(parsed.bulk, [{
    destination: 'HKG', pieces: 7, weightKg: 20, awb: '160-10290873',
    priorityText: null, shcs: ['EAW', 'SPX'], remarks: 'Loose cargo'
  }]);
  assert.equal(parsed.sourceMetadata.bulkRowCount, 1);
});

test('UWS conflicting repeated context and ambiguous document signatures fail closed', () => {
  const conflicting = uwsWorkbook();
  conflicting.sheets[0].rows.push(row(30, { 1: 'STATION', 5: 'FLIGHT NO', 24: 'DATE' }));
  conflicting.sheets[0].rows.push(row(30, { 1: 'MEL', 5: 'TG0462', 24: '19-Sep-2026' }));
  assert.throws(() => parseExportUws(conflicting), error => error instanceof ExportUwsError && error.code === 'UWS_CONFLICTING_CONTEXT');

  const ambiguous = uwsWorkbook();
  ambiguous.sheets[0].rows.push(['Export Unit List', 'ULD Number']);
  assert.throws(() => detectWorkbookType(ambiguous), error => error.code === 'AMBIGUOUS_DOCUMENT_TYPE');
});

test('exact flight matching uses canonical number, operating date, direction, and station', () => {
  const parsed = parseExportUws(uwsWorkbook());
  const rows = [
    { FlightId: 81, FlightNumber: 'CX0134', OperatingDateIso: '2026-09-18', Direction: 'EXPORT', FlightStatus: 'ACTIVE', OriginAirport: 'MEL', DestinationAirport: 'HKG' },
    { FlightId: 82, FlightNumber: 'CX134', OperatingDateIso: '2026-09-19', Direction: 'EXPORT', FlightStatus: 'ACTIVE', OriginAirport: 'MEL', DestinationAirport: 'HKG' }
  ];
  assert.equal(matchExportUwsFlight(rows, parsed).FlightId, 82);
  assert.throws(
    () => matchExportUwsFlight([...rows, { ...rows[1], FlightId: 83 }], parsed),
    error => error.code === 'UWS_FLIGHT_IDENTITY_CONFLICT'
  );
  assert.throws(
    () => matchExportUwsFlight([{ ...rows[1], Direction: 'IMPORT' }], parsed),
    error => error.code === 'UWS_DIRECTION_MISMATCH'
  );
  assert.throws(
    () => matchExportUwsFlight([{ ...rows[1], OriginAirport: 'BNE' }], parsed),
    error => error.code === 'UWS_STATION_MISMATCH'
  );
});

test('UWS reconciliation preserves progressed operational truth and classifies additions/exclusions', () => {
  const parsed = parseExportUws(uwsWorkbook());
  const existing = [
    { UldId: 7, UldNumber: 'PMC97525R7', CurrentStatus: 'AT_AIRCRAFT', IdentityVerified: 1 },
    { UldId: 8, UldNumber: 'AKE99999CX', CurrentStatus: 'TRANSIT', IdentityVerified: 1 }
  ];
  const before = structuredClone(existing);
  const items = normalizeManifestItems(parsed.ulds.map(item => ({ uldNumber: item.uldNumber, weightKg: item.grossWeightKg, remarks: item.remarks, shcs: item.shcs })));
  const result = reconcileManifest(existing, items);
  assert.deepEqual(result.matched.map(item => item.row.UldId), [7]);
  assert.deepEqual(result.added.map(item => item.item.uldNumber), ['AKE47186CX']);
  assert.deepEqual(result.excluded.map(item => item.row.UldId), [8]);
  assert.deepEqual(existing, before);
});

test('manual UWS Intake stays a preview until explicit FINAL confirmation', () => {
  assert.match(html, /action:\s*'PARSE_EXPORT_UWS'/);
  assert.match(html, /action:\s*'REVIEW_EXPORT_UWS'/);
  assert.match(html, /btn\.textContent = 'Review FINAL'/);
  assert.match(html, /deferOperational\(generation,\(\)\s*=>\s*previewFinalManifest\(reviewedFlightId\),\s*50\)/);
  assert.doesNotMatch(html, /setTimeout\(\(\)\s*=>\s*previewFinalManifest\(reviewedFlightId\)/);
  assert.match(html, /function confirmFinalManifest[\s\S]*action:\s*'CONFIRM'/);
  assert.doesNotMatch(uploadApi, /UPDATE dbo\.ULDs/i);
  assert.doesNotMatch(uploadApi, /INSERT INTO dbo\.ExportManifestFinals/i);
  assert.doesNotMatch(uploadApi, /UPDATE dbo\.Flights SET FlightStatus/i);
});

test('UWS review records source metadata and stable identity without persisting optional bulk fields', () => {
  assert.match(uploadApi, /UwsUploadType[\s\S]*'EXPORT_UWS'/);
  assert.match(uploadApi, /action:\s*'EXPORT_UWS_REVIEWED'/);
  assert.match(uploadApi, /matchedFlightId:\s*String\(matchedFlight\.FlightId\)/);
  assert.match(uploadApi, /bulkRowCount:\s*parsed\.bulk\.length/);
  assert.doesNotMatch(uploadApi, /INSERT INTO dbo\.(?:Bulk|ExportUws)/i);
});

test('frontend renders UWS values with safe fallbacks and keeps grouped priority handling', () => {
  assert.match(html, /match\.flightStatus \|\| 'ACTIVE'/);
  assert.match(html, /parsed\.destination \|\| \(parsed\.destinations \|\| \[\]\)\.join/);
  assert.match(html, /priorityTagsFor\(uploadFlight, u, parsed\.type\)/);
  assert.doesNotMatch(html, /esc\(match\.flightStatus\)/);
});

test('shared parser is independent of HTTP and browser DOM APIs', () => {
  const source = fs.readFileSync(path.join(root, 'api', 'shared', 'export-uws.js'), 'utf8');
  assert.equal(typeof parseExportUws, 'function');
  assert.doesNotMatch(source, /\bdocument\.|\bwindow\b|\bfetch\b|\bFileReader\b/);
  assert.doesNotMatch(source, /manifest-upload\/index/);
});

module.exports = { uwsWorkbook };
