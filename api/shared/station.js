'use strict';

const { normalizeTimeZone } = require('./station-time');

const LEGACY_NULL_STATION_COMPATIBILITY_ENABLED = true;
const MACHINE_STATION_CODE = 'MEL';
const STATION_TIME_ZONE_FIXTURES = Object.freeze({
  MEL: 'Australia/Melbourne',
  AKL: 'Pacific/Auckland'
});

class StationResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StationResolutionError';
    this.code = code;
  }
}

function normalizeStationCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new StationResolutionError('STATION_INVALID', 'The operational station is invalid');
  }
  return code;
}

function normalizeStationId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new StationResolutionError('STATION_INVALID', 'The operational station is invalid');
  }
  const id = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(id) || id.length > 19 || BigInt(id) > 9223372036854775807n) {
    throw new StationResolutionError('STATION_INVALID', 'The operational station is invalid');
  }
  return id;
}

function normalizeStationRecord(row) {
  if (!row || Number(row.IsEnabled) !== 1) {
    throw new StationResolutionError('STATION_UNAVAILABLE', 'The operational station is unavailable');
  }
  const stationId = normalizeStationId(row.StationId);
  const stationCode = normalizeStationCode(row.StationCode);
  const displayName = String(row.DisplayName || '').trim();
  const rawTimeZoneId = String(row.TimeZoneId || '').trim();
  if (!displayName || !rawTimeZoneId) {
    throw new StationResolutionError('STATION_INVALID', 'The operational station is not configured correctly');
  }
  let timeZoneId;
  try {
    timeZoneId = normalizeTimeZone(rawTimeZoneId);
  } catch {
    throw new StationResolutionError('STATION_INVALID', 'The operational station is not configured correctly');
  }
  return { stationId, stationCode, displayName, timeZoneId };
}

async function resolveStationById(executor, sql, stationId) {
  const id = normalizeStationId(stationId);
  const result = await new sql.Request(executor)
    .input('ResolvedStationId', sql.BigInt, id)
    .query(`SELECT StationId,StationCode,DisplayName,TimeZoneId,IsEnabled
      FROM dbo.CargoRunStations WHERE StationId=@ResolvedStationId;`);
  if ((result.recordset || []).length !== 1) {
    throw new StationResolutionError('STATION_UNAVAILABLE', 'The operational station is unavailable');
  }
  return normalizeStationRecord(result.recordset[0]);
}

async function resolveStationByCode(executor, sql, stationCode) {
  const code = normalizeStationCode(stationCode);
  const result = await new sql.Request(executor)
    .input('ResolvedStationCode', sql.VarChar(3), code)
    .query(`SELECT StationId,StationCode,DisplayName,TimeZoneId,IsEnabled
      FROM dbo.CargoRunStations WHERE StationCode=@ResolvedStationCode;`);
  if ((result.recordset || []).length !== 1) {
    throw new StationResolutionError('STATION_UNAVAILABLE', 'The operational station is unavailable');
  }
  return normalizeStationRecord(result.recordset[0]);
}

function legacyRouteStationCode(flight) {
  const direction = String(flight?.Direction ?? flight?.direction ?? '').trim().toUpperCase();
  const value = direction === 'IMPORT'
    ? (flight?.DestinationAirport ?? flight?.destinationAirport)
    : direction === 'EXPORT'
      ? (flight?.OriginAirport ?? flight?.originAirport)
      : '';
  return normalizeStationCode(value);
}

function routeMatchesStation(flight, stationCode) {
  try {
    return legacyRouteStationCode(flight) === normalizeStationCode(stationCode);
  } catch {
    return false;
  }
}

async function resolveFlightStation(executor, sql, flight, options = {}) {
  const compatibilityEnabled = options.compatibilityEnabled ?? LEGACY_NULL_STATION_COMPATIBILITY_ENABLED;
  const stationId = flight?.StationId ?? flight?.stationId ?? null;
  if (stationId !== null && stationId !== undefined && String(stationId).trim() !== '') {
    return resolveStationById(executor, sql, stationId);
  }
  if (!compatibilityEnabled) {
    throw new StationResolutionError('STATION_UNAVAILABLE', 'The operational station is unavailable');
  }
  return resolveStationByCode(executor, sql, legacyRouteStationCode(flight));
}

async function resolveAuthorizedStation(executor, sql, access, requestedStationCode = null) {
  const allowed = Array.isArray(access?.stationMetadata) ? access.stationMetadata : [];
  const requested = String(requestedStationCode || '').trim();
  let station;
  if (requested) {
    const code = normalizeStationCode(requested);
    station = allowed.find(item => item.stationCode === code);
  } else if (allowed.length === 1) {
    station = allowed[0];
  }
  if (!station) {
    throw new StationResolutionError('STATION_ACCESS_DENIED', 'The requested station is not authorized');
  }
  const requiredCapability = String(access?.requiredCapability || '').trim().toUpperCase();
  const stationCapabilities = Array.isArray(access?.capabilitiesByStation?.[station.stationCode])
    ? access.capabilitiesByStation[station.stationCode]
    : [];
  if (requiredCapability && !stationCapabilities.includes(requiredCapability)) {
    throw new StationResolutionError('STATION_ACCESS_DENIED', 'The requested station is not authorized');
  }
  return resolveStationById(executor, sql, station.stationId);
}

function stationLocalDate(instant, timeZoneId) {
  const zone = String(timeZoneId || '').trim();
  if (!zone) throw new StationResolutionError('STATION_INVALID', 'The station timezone is not configured');
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new StationResolutionError('TIME_INVALID', 'The operational time is invalid');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

module.exports = {
  LEGACY_NULL_STATION_COMPATIBILITY_ENABLED,
  MACHINE_STATION_CODE,
  STATION_TIME_ZONE_FIXTURES,
  StationResolutionError,
  normalizeStationCode,
  normalizeStationId,
  normalizeStationRecord,
  resolveStationById,
  resolveStationByCode,
  legacyRouteStationCode,
  routeMatchesStation,
  resolveFlightStation,
  resolveAuthorizedStation,
  stationLocalDate
};
