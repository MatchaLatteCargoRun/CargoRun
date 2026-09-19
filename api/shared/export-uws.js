'use strict';

const { normalizeFlightNumber } = require('./flight');
const { normalizeUldNumber } = require('./uld');

const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 2500;
const MAX_COLUMNS_PER_ROW = 120;

class ExportUwsError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'ExportUwsError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function upper(value) {
  return text(value).replace(/\s+/g, ' ').toUpperCase();
}

function normalizeWorkbook(workbook) {
  if (!workbook || typeof workbook !== 'object' || Array.isArray(workbook)) {
    throw new ExportUwsError('INVALID_WORKBOOK', 'Workbook data is required');
  }
  if (!Array.isArray(workbook.sheets) || !workbook.sheets.length) {
    throw new ExportUwsError('INVALID_WORKBOOK', 'The workbook has no worksheets');
  }
  if (workbook.sheets.length > MAX_SHEETS) {
    throw new ExportUwsError('WORKBOOK_TOO_LARGE', `The workbook exceeds ${MAX_SHEETS} worksheets`);
  }

  return {
    sheets: workbook.sheets.map((sheet, sheetIndex) => {
      const rows = Array.isArray(sheet?.rows) ? sheet.rows : null;
      if (!rows) throw new ExportUwsError('INVALID_WORKBOOK', `Worksheet ${sheetIndex + 1} has no rows`);
      if (rows.length > MAX_ROWS_PER_SHEET) {
        throw new ExportUwsError('WORKBOOK_TOO_LARGE', `Worksheet ${sheetIndex + 1} exceeds ${MAX_ROWS_PER_SHEET} rows`);
      }
      return {
        name: text(sheet?.name) || `Sheet ${sheetIndex + 1}`,
        rows: rows.map((row, rowIndex) => {
          if (!Array.isArray(row)) {
            throw new ExportUwsError('INVALID_WORKBOOK', `Worksheet ${sheetIndex + 1}, row ${rowIndex + 1} is invalid`);
          }
          if (row.length > MAX_COLUMNS_PER_ROW) {
            throw new ExportUwsError('WORKBOOK_TOO_LARGE', `Worksheet ${sheetIndex + 1}, row ${rowIndex + 1} exceeds ${MAX_COLUMNS_PER_ROW} columns`);
          }
          return row.map(value => {
            if (value === null || value === undefined) return '';
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
            return String(value);
          });
        })
      };
    })
  };
}

function rowHeaders(row) {
  return (Array.isArray(row) ? row : []).map(upper);
}

function hasHeader(row, name) {
  return rowHeaders(row).includes(name);
}

function hasUwsUldHeader(row) {
  const headers = rowHeaders(row);
  return headers.includes('NUMBER') &&
    headers.includes('UNLOAD STATION') &&
    headers.includes('PCS') &&
    headers.includes('GROSS WEIGHT');
}

function hasStandardUldHeader(row) {
  return rowHeaders(row).some(value => value === 'ULD NUMBER' || value === 'ULD NUMBER / BULK');
}

function detectWorkbookType(workbook) {
  const normalized = normalizeWorkbook(workbook);
  let uwsMarker = false;
  let uwsSection = false;
  let uwsHeader = false;
  let importTitle = false;
  let exportTitle = false;
  let standardHeader = false;

  for (const sheet of normalized.sheets) {
    for (const row of sheet.rows) {
      const values = rowHeaders(row);
      const joined = values.join(' | ');
      if (joined.includes('ULD/BULK LOAD WEIGHT STATEMENT')) uwsMarker = true;
      if (joined.includes('UNIT LOAD DEVICES(ULD)')) uwsSection = true;
      if (hasUwsUldHeader(row)) uwsHeader = true;
      if (/IMPORT\s+ULD\s+(LIST|SUMMARY)/.test(joined)) importTitle = true;
      if (/EXPORT\s+(UNIT|ULD)\s+LIST/.test(joined)) exportTitle = true;
      if (hasStandardUldHeader(row)) standardHeader = true;
    }
  }

  const matches = [];
  if (uwsMarker && uwsSection && uwsHeader) matches.push('EXPORT_UWS');
  if (importTitle && standardHeader) matches.push('IMPORT_ULD_SUMMARY');
  if (exportTitle && standardHeader) matches.push('EXPORT_UNIT_LIST');

  if (matches.length > 1) {
    throw new ExportUwsError('AMBIGUOUS_DOCUMENT_TYPE', 'Workbook structure matches more than one CargoRun document type');
  }
  if (!matches.length) {
    throw new ExportUwsError('UNSUPPORTED_DOCUMENT_TYPE', 'CargoRun could not identify a supported workbook from its structure');
  }
  return matches[0];
}

function excelDate(number) {
  if (!Number.isFinite(number) || number < 1 || number > 100000) return null;
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.floor(number) * 86400000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

const MONTHS = new Map([
  ['JAN', '01'], ['FEB', '02'], ['MAR', '03'], ['APR', '04'], ['MAY', '05'], ['JUN', '06'],
  ['JUL', '07'], ['AUG', '08'], ['SEP', '09'], ['OCT', '10'], ['NOV', '11'], ['DEC', '12']
]);

function parseOperatingDate(value) {
  if (typeof value === 'number') return excelDate(value);
  const raw = text(value);
  if (!raw) return null;
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return raw;
  match = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  match = raw.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})$/);
  if (match) {
    const month = MONTHS.get(match[2].slice(0, 3).toUpperCase());
    if (month) return `${match[3]}-${month}-${match[1].padStart(2, '0')}`;
  }
  return null;
}

function findFollowingValue(rows, rowIndex, columnIndex) {
  for (let offset = 1; offset <= 3 && rowIndex + offset < rows.length; offset++) {
    const sameColumn = text(rows[rowIndex + offset]?.[columnIndex]);
    if (sameColumn) return rows[rowIndex + offset][columnIndex];
  }
  for (let offset = 1; offset <= 3; offset++) {
    const sameRow = text(rows[rowIndex]?.[columnIndex + offset]);
    if (sameRow) return rows[rowIndex][columnIndex + offset];
  }
  return null;
}

function collectLabelValues(workbook, labels) {
  const values = [];
  for (const sheet of workbook.sheets) {
    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex++) {
      const row = sheet.rows[rowIndex];
      for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
        if (!labels.includes(upper(row[columnIndex]))) continue;
        const value = findFollowingValue(sheet.rows, rowIndex, columnIndex);
        if (text(value)) values.push(value);
      }
    }
  }
  return values;
}

function oneConsistentValue(values, normalizer, label) {
  const normalized = values.map(normalizer).filter(Boolean);
  const unique = [...new Set(normalized)];
  if (!unique.length) throw new ExportUwsError('UWS_REQUIRED_FIELD_MISSING', `${label} was not found in the UWS`);
  if (unique.length > 1) {
    throw new ExportUwsError('UWS_CONFLICTING_CONTEXT', `The UWS contains conflicting ${label} values`, 409, { values: unique });
  }
  return unique[0];
}

function columnIndex(headers, names) {
  const normalizedNames = names.map(upper);
  return rowHeaders(headers).findIndex(header => normalizedNames.includes(header));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function splitShcs(value) {
  return [...new Set(text(value).toUpperCase().split(/[,\s]+/).map(code => code.trim()).filter(Boolean))];
}

function isSectionBoundary(row) {
  const joined = rowHeaders(row).join(' | ');
  return joined.includes('ULD TOTAL') || joined.includes('BULK TOTAL') || joined.includes('BULK CARGO TOTAL') ||
    joined.includes('GRAND TOTAL') || joined.includes('STATION') || joined.includes('UNIT LOAD DEVICES(ULD)') ||
    hasUwsUldHeader(row) || hasHeader(row, 'TROLLEY/BARROW ID');
}

function parseUldSections(workbook) {
  const ulds = [];
  for (const sheet of workbook.sheets) {
    for (let headerIndex = 0; headerIndex < sheet.rows.length; headerIndex++) {
      const headers = sheet.rows[headerIndex];
      if (!hasUwsUldHeader(headers)) continue;
      const indexes = {
        number: columnIndex(headers, ['NUMBER']),
        destination: columnIndex(headers, ['UNLOAD STATION']),
        pieces: columnIndex(headers, ['PCS']),
        tare: columnIndex(headers, ['TARE WEIGHT']),
        net: columnIndex(headers, ['NET WEIGHT']),
        gross: columnIndex(headers, ['GROSS WEIGHT']),
        contour: columnIndex(headers, ['CONTOUR CODE', 'CONTOUR']),
        priority: columnIndex(headers, ['PRIORITY']),
        shc: columnIndex(headers, ['SHC']),
        remarks: columnIndex(headers, ['REMARKS'])
      };
      for (let rowIndex = headerIndex + 1; rowIndex < sheet.rows.length; rowIndex++) {
        const row = sheet.rows[rowIndex];
        if (isSectionBoundary(row)) break;
        const uldNumber = normalizeUldNumber(row[indexes.number]);
        if (!uldNumber || !/[A-Z]/.test(uldNumber) || !/\d/.test(uldNumber)) continue;
        if (uldNumber.length > 20) {
          throw new ExportUwsError('UWS_INVALID_ULD', `UWS ULD ${uldNumber} exceeds 20 characters`);
        }
        const remarks = indexes.remarks >= 0 ? text(row[indexes.remarks]) : '';
        const shcs = indexes.shc >= 0 ? splitShcs(row[indexes.shc]) : [];
        ulds.push({
          uldNumber,
          destination: indexes.destination >= 0 ? upper(row[indexes.destination]) || null : null,
          pieces: indexes.pieces >= 0 ? numberOrNull(row[indexes.pieces]) : null,
          tareWeightKg: indexes.tare >= 0 ? numberOrNull(row[indexes.tare]) : null,
          netWeightKg: indexes.net >= 0 ? numberOrNull(row[indexes.net]) : null,
          grossWeightKg: indexes.gross >= 0 ? numberOrNull(row[indexes.gross]) : null,
          contour: indexes.contour >= 0 ? text(row[indexes.contour]) || null : null,
          priorityText: indexes.priority >= 0 ? text(row[indexes.priority]) || null : null,
          shcs,
          remarks: remarks || null,
          dryIceText: /DRY\s*ICE/i.test(remarks) || shcs.includes('ICE') ? (remarks || 'ICE') : null
        });
      }
    }
  }
  if (!ulds.length) throw new ExportUwsError('UWS_NO_ULDS', 'No ULD records were found in the UWS');
  const seen = new Set();
  for (const uld of ulds) {
    if (seen.has(uld.uldNumber)) {
      throw new ExportUwsError('UWS_DUPLICATE_ULD', `Duplicate ULD in UWS: ${uld.uldNumber}`);
    }
    seen.add(uld.uldNumber);
  }
  return ulds;
}

function parseBulkSections(workbook) {
  const bulk = [];
  for (const sheet of workbook.sheets) {
    for (let headerIndex = 0; headerIndex < sheet.rows.length; headerIndex++) {
      const headers = sheet.rows[headerIndex];
      if (!hasHeader(headers, 'TROLLEY/BARROW ID') || !hasHeader(headers, 'UNLOAD STATION') || !hasHeader(headers, 'PCS')) continue;
      const indexes = {
        destination: columnIndex(headers, ['UNLOAD STATION']),
        pieces: columnIndex(headers, ['PCS']),
        weight: columnIndex(headers, ['WEIGHT']),
        awb: columnIndex(headers, ['AWB']),
        priority: columnIndex(headers, ['PRIORITY']),
        shc: columnIndex(headers, ['SHC']),
        remarks: columnIndex(headers, ['REMARKS'])
      };
      for (let rowIndex = headerIndex + 1; rowIndex < sheet.rows.length; rowIndex++) {
        const row = sheet.rows[rowIndex];
        const joined = rowHeaders(row).join(' | ');
        if (joined.includes('BULK LOAD CARGO')) continue;
        if (isSectionBoundary(row)) break;
        const destination = indexes.destination >= 0 ? upper(row[indexes.destination]) : '';
        const pieces = indexes.pieces >= 0 ? numberOrNull(row[indexes.pieces]) : null;
        const weightKg = indexes.weight >= 0 ? numberOrNull(row[indexes.weight]) : null;
        const awb = indexes.awb >= 0 ? text(row[indexes.awb]) : '';
        const remarks = indexes.remarks >= 0 ? text(row[indexes.remarks]) : '';
        const shcs = indexes.shc >= 0 ? splitShcs(row[indexes.shc]) : [];
        if (!destination && pieces === null && weightKg === null && !awb && !remarks && !shcs.length) continue;
        bulk.push({
          destination: destination || null,
          pieces,
          weightKg,
          awb: awb || null,
          priorityText: indexes.priority >= 0 ? text(row[indexes.priority]) || null : null,
          shcs,
          remarks: remarks || null
        });
      }
    }
  }
  return bulk;
}

function parseExportUws(workbook, options = {}) {
  const normalized = normalizeWorkbook(workbook);
  const documentType = detectWorkbookType(normalized);
  if (documentType !== 'EXPORT_UWS') {
    throw new ExportUwsError('NOT_EXPORT_UWS', `Workbook is ${documentType}, not EXPORT_UWS`);
  }
  const flightNumber = oneConsistentValue(
    collectLabelValues(normalized, ['FLIGHT NO', 'FLIGHT NUMBER']),
    value => upper(value).replace(/\s+/g, ''),
    'flight number'
  );
  const operatingDate = oneConsistentValue(
    collectLabelValues(normalized, ['DATE', 'OPERATING DATE']),
    parseOperatingDate,
    'operating date'
  );
  const station = oneConsistentValue(
    collectLabelValues(normalized, ['STATION']),
    upper,
    'station'
  );
  const registrations = collectLabelValues(normalized, ['REGISTRATION']).map(upper).filter(Boolean);
  const registration = registrations.length ? [...new Set(registrations)][0] : null;
  const ulds = parseUldSections(normalized);
  const bulk = parseBulkSections(normalized);
  const destinations = [...new Set([...ulds, ...bulk].map(item => item.destination).filter(Boolean))];

  return {
    documentType: 'EXPORT_UWS',
    flightNumber,
    canonicalFlightNumber: normalizeFlightNumber(flightNumber),
    operatingDate,
    station,
    destination: destinations.length === 1 ? destinations[0] : null,
    destinations,
    ulds,
    bulk,
    sourceMetadata: {
      documentType: 'EXPORT_UWS',
      sourceFileName: text(options.sourceFileName) || null,
      sheetNames: normalized.sheets.map(sheet => sheet.name),
      sheetCount: normalized.sheets.length,
      uldRowCount: ulds.length,
      bulkRowCount: bulk.length,
      registration
    }
  };
}

function matchExportUwsFlight(rows, parsed) {
  const candidates = (Array.isArray(rows) ? rows : []).filter(row =>
    normalizeFlightNumber(row?.FlightNumber) === parsed.canonicalFlightNumber &&
    String(row?.OperatingDateIso || row?.OperatingDate || '').slice(0, 10) === parsed.operatingDate
  );
  if (!candidates.length) {
    throw new ExportUwsError('UWS_FLIGHT_NOT_FOUND', 'No CargoRun flight matches the UWS flight number and operating date', 404);
  }
  if (candidates.length > 1) {
    throw new ExportUwsError('UWS_FLIGHT_IDENTITY_CONFLICT', 'Multiple CargoRun flights match the UWS flight number and operating date', 409, {
      flightIds: candidates.map(row => String(row.FlightId))
    });
  }
  const flight = candidates[0];
  if (upper(flight.Direction) !== 'EXPORT') {
    throw new ExportUwsError('UWS_DIRECTION_MISMATCH', 'The matched CargoRun flight is not an export flight', 409);
  }
  const origin = upper(flight.OriginAirport);
  if (!origin) {
    throw new ExportUwsError('UWS_STATION_UNVERIFIED', 'The matched CargoRun flight has no origin station to validate against the UWS', 409);
  }
  if (origin !== parsed.station) {
    throw new ExportUwsError('UWS_STATION_MISMATCH', `UWS station ${parsed.station} does not match CargoRun origin ${origin}`, 409);
  }
  const destination = upper(flight.DestinationAirport);
  if (parsed.destination && destination && destination !== parsed.destination) {
    throw new ExportUwsError('UWS_DESTINATION_MISMATCH', `UWS destination ${parsed.destination} does not match CargoRun destination ${destination}`, 409);
  }
  if (upper(flight.FlightStatus || 'ACTIVE') !== 'ACTIVE') {
    throw new ExportUwsError('UWS_FLIGHT_INACTIVE', 'Only an active BUILD OPEN export flight can review a UWS', 409);
  }
  return flight;
}

module.exports = {
  ExportUwsError,
  detectWorkbookType,
  parseExportUws,
  matchExportUwsFlight,
  parseOperatingDate,
  splitShcs,
  limits: { MAX_SHEETS, MAX_ROWS_PER_SHEET, MAX_COLUMNS_PER_ROW }
};
