'use strict';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const HOUR_MS = 60 * 60 * 1000;
const formatterCache = new Map();

class StationTimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StationTimeError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StationTimeError(code, message);
}

function utcMillis(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(hour, minute, second, millisecond);
  return value.getTime();
}

function parseLocalDate(value) {
  if (typeof value !== 'string') fail('LOCAL_DATE_INVALID', 'The station-local date is invalid');
  const match = DATE_PATTERN.exec(value);
  if (!match) fail('LOCAL_DATE_INVALID', 'The station-local date must use YYYY-MM-DD');
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const date = new Date(utcMillis(parts.year, parts.month, parts.day));
  if (date.getUTCFullYear() !== parts.year || date.getUTCMonth() + 1 !== parts.month || date.getUTCDate() !== parts.day) {
    fail('LOCAL_DATE_INVALID', 'The station-local date is invalid');
  }
  return parts;
}

function parseLocalTime(value) {
  if (typeof value !== 'string') fail('LOCAL_TIME_INVALID', 'The station-local time is invalid');
  const match = TIME_PATTERN.exec(value);
  if (!match) fail('LOCAL_TIME_INVALID', 'The station-local time must use HH:mm or HH:mm:ss');
  const parts = { hour: Number(match[1]), minute: Number(match[2]), second: Number(match[3] || 0) };
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    fail('LOCAL_TIME_INVALID', 'The station-local time is invalid');
  }
  parts.value = `${match[1]}:${match[2]}${match[3] === undefined ? '' : `:${match[3]}`}`;
  return parts;
}

function parseInstant(value) {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (!Number.isFinite(milliseconds)) fail('INSTANT_INVALID', 'The UTC instant is invalid');
    return new Date(milliseconds);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INSTANT_INVALID', 'The UTC instant is invalid');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) fail('INSTANT_INVALID', 'The UTC instant is invalid');
    return date;
  }
  if (typeof value !== 'string') fail('INSTANT_INVALID', 'The UTC instant is invalid');
  const match = INSTANT_PATTERN.exec(value);
  if (!match) fail('INSTANT_INVALID', 'The UTC instant must include an explicit offset');
  const parts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]),
    millisecond: Number((match[7] || '').padEnd(3, '0') || 0)
  };
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59 || offsetHour > 23 || offsetMinute > 59) {
    fail('INSTANT_INVALID', 'The UTC instant is invalid');
  }
  const localMilliseconds = utcMillis(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  const check = new Date(localMilliseconds);
  if (check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month || check.getUTCDate() !== parts.day
      || check.getUTCHours() !== parts.hour || check.getUTCMinutes() !== parts.minute || check.getUTCSeconds() !== parts.second) {
    fail('INSTANT_INVALID', 'The UTC instant is invalid');
  }
  const direction = match[9] === '-' ? -1 : 1;
  const offsetMilliseconds = direction * ((offsetHour * 60) + offsetMinute) * 60 * 1000;
  const instant = new Date(localMilliseconds - offsetMilliseconds);
  if (Number.isNaN(instant.getTime())) fail('INSTANT_INVALID', 'The UTC instant is invalid');
  return instant;
}

function normalizeTimeZone(timeZoneId) {
  if (typeof timeZoneId !== 'string' || !timeZoneId || timeZoneId !== timeZoneId.trim()) {
    fail('TIME_ZONE_INVALID', 'The station timezone is invalid');
  }
  if (/^[+-]\d{2}:\d{2}$/.test(timeZoneId) || /^Etc\/GMT(?:[+-]\d{1,2})?$/i.test(timeZoneId)) {
    fail('TIME_ZONE_INVALID', 'A named IANA station timezone is required');
  }
  try {
    const canonical = new Intl.DateTimeFormat('en-GB', { timeZone: timeZoneId }).resolvedOptions().timeZone;
    if (/^[+-]\d{2}:\d{2}$/.test(canonical)) fail('TIME_ZONE_INVALID', 'A named IANA station timezone is required');
    return canonical;
  } catch {
    return fail('TIME_ZONE_INVALID', 'The station timezone is invalid');
  }
}

function stationFormatter(timeZoneId) {
  let formatter = formatterCache.get(timeZoneId);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
      timeZone: timeZoneId,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZoneName: 'longOffset'
    });
    formatterCache.set(timeZoneId, formatter);
  }
  return formatter;
}

function offsetFromName(value) {
  if (value === 'GMT' || value === 'UTC') return { minutes: 0, value: '+00:00' };
  const match = /^(?:GMT|UTC)([+-])(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) fail('TIME_ZONE_INVALID', 'The station timezone offset is unavailable');
  const minutes = (Number(match[2]) * 60) + Number(match[3] || 0);
  return {
    minutes: match[1] === '-' ? -minutes : minutes,
    value: `${match[1]}${match[2]}:${match[3] || '00'}`
  };
}

function localParts(instant, timeZoneId) {
  const values = {};
  for (const part of stationFormatter(timeZoneId).formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  const offset = offsetFromName(values.timeZoneName);
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
    offsetMinutes: offset.minutes, offset: offset.value
  };
}

function stationDateKey(instantUtc, timeZoneId) {
  const instant = parseInstant(instantUtc);
  const zone = normalizeTimeZone(timeZoneId);
  const parts = localParts(instant, zone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function formatInstantInStation(instantUtc, timeZoneId, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('FORMAT_OPTIONS_INVALID', 'The station time format options are invalid');
  }
  if (options.includeSeconds !== undefined && typeof options.includeSeconds !== 'boolean') {
    fail('FORMAT_OPTIONS_INVALID', 'includeSeconds must be a boolean');
  }
  const instant = parseInstant(instantUtc);
  const zone = normalizeTimeZone(timeZoneId);
  const parts = localParts(instant, zone);
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  const hour = String(parts.hour).padStart(2, '0');
  const minute = String(parts.minute).padStart(2, '0');
  const second = String(parts.second).padStart(2, '0');
  const localDate = `${day}/${month}/${year}`;
  const localTime = `${hour}:${minute}${options.includeSeconds ? `:${second}` : ''}`;
  return {
    dateKey: `${year}-${month}-${day}`,
    localDate,
    localTime,
    localDateTime: `${localDate} ${localTime}`,
    timeZoneId: zone,
    offset: parts.offset
  };
}

function sameLocalTime(parts, date, time) {
  return parts.year === date.year && parts.month === date.month && parts.day === date.day
    && parts.hour === time.hour && parts.minute === time.minute && parts.second === time.second;
}

function candidateInstants(date, time, timeZoneId) {
  const wallClockUtc = utcMillis(date.year, date.month, date.day, time.hour, time.minute, time.second);
  const offsets = new Set();
  for (let delta = -72; delta <= 72; delta += 6) {
    offsets.add(localParts(new Date(wallClockUtc + (delta * HOUR_MS)), timeZoneId).offsetMinutes);
  }
  const candidates = [];
  for (const offsetMinutes of offsets) {
    const instant = new Date(wallClockUtc - (offsetMinutes * 60 * 1000));
    const parts = localParts(instant, timeZoneId);
    if (sameLocalTime(parts, date, time)) {
      candidates.push({ instant, instantUtc: instant.toISOString(), offset: parts.offset });
    }
  }
  return candidates
    .filter((candidate, index, all) => all.findIndex(item => item.instantUtc === candidate.instantUtc) === index)
    .sort((left, right) => left.instant.getTime() - right.instant.getTime());
}

function normalizeDisambiguation(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('DISAMBIGUATION_INVALID', 'The DST disambiguation is invalid');
  const normalized = value.trim().toUpperCase();
  if (normalized !== 'EARLIER' && normalized !== 'LATER') {
    fail('DISAMBIGUATION_INVALID', 'The DST disambiguation must be EARLIER or LATER');
  }
  return normalized;
}

function resolvedResult(status, candidate, zone, localDate, localTime, disambiguation) {
  return {
    status,
    instantUtc: candidate.instantUtc,
    offset: candidate.offset,
    timeZoneId: zone,
    localDate,
    localTime,
    ...(disambiguation ? { disambiguation } : {})
  };
}

function resolveStationLocalDateTime(localDate, localTime, timeZoneId, disambiguation) {
  const date = parseLocalDate(localDate);
  const time = parseLocalTime(localTime);
  const zone = normalizeTimeZone(timeZoneId);
  const choice = normalizeDisambiguation(disambiguation);
  const candidates = candidateInstants(date, time, zone);
  if (candidates.length === 0) {
    return { status: 'NONEXISTENT', candidates: [], timeZoneId: zone, localDate, localTime: time.value };
  }
  if (candidates.length === 1) {
    return resolvedResult('UNIQUE', candidates[0], zone, localDate, time.value, null);
  }
  if (candidates.length !== 2) {
    fail('LOCAL_TIME_UNSUPPORTED', 'The station-local time has an unsupported number of UTC candidates');
  }
  const decisions = candidates.map((candidate, index) => ({
    instantUtc: candidate.instantUtc,
    offset: candidate.offset,
    disambiguation: index === 0 ? 'EARLIER' : 'LATER'
  }));
  if (!choice) {
    return { status: 'AMBIGUOUS', candidates: decisions, timeZoneId: zone, localDate, localTime: time.value };
  }
  const selected = choice === 'EARLIER' ? candidates[0] : candidates[1];
  return resolvedResult('RESOLVED', selected, zone, localDate, time.value, choice);
}

function nextDateKey(date) {
  const next = new Date(utcMillis(date.year, date.month, date.day) + (24 * HOUR_MS));
  const year = String(next.getUTCFullYear()).padStart(4, '0');
  return `${year}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function utcBoundsForStationDate(localDate, timeZoneId) {
  const date = parseLocalDate(localDate);
  const zone = normalizeTimeZone(timeZoneId);
  const start = resolveStationLocalDateTime(localDate, '00:00:00', zone);
  const end = resolveStationLocalDateTime(nextDateKey(date), '00:00:00', zone);
  if (start.status !== 'UNIQUE' || end.status !== 'UNIQUE') {
    fail('STATION_DATE_BOUNDARY_INVALID', 'The station date does not have unique midnight boundaries');
  }
  const durationHours = (Date.parse(end.instantUtc) - Date.parse(start.instantUtc)) / HOUR_MS;
  return { startUtc: start.instantUtc, endUtc: end.instantUtc, durationHours };
}

module.exports = {
  StationTimeError,
  stationDateKey,
  formatInstantInStation,
  utcBoundsForStationDate,
  resolveStationLocalDateTime
};
