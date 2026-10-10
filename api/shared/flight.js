'use strict';

function normalizeFlightNumber(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');

  const match = normalized.match(/^([A-Z0-9]{2,3}?)(\d+)([A-Z]?)$/);
  if (!match) return normalized;

  return `${match[1]}${String(Number(match[2]))}${match[3] || ''}`;
}

function flightIdentityLockResource(stationId, operatingDate, flightNumber) {
  const station = String(stationId ?? '').trim();
  if (!/^[1-9]\d*$/.test(station)) throw new Error('A stable StationId is required for flight identity');
  return `CargoRun:Flight:v2:${station}:${String(operatingDate || '').trim()}:${normalizeFlightNumber(flightNumber)}`;
}

async function acquireFlightIdentityLock(transaction, sql, stationId, operatingDate, flightNumber) {
  const resource = flightIdentityLockResource(stationId, operatingDate, flightNumber);
  const result = await new sql.Request(transaction)
    .input('FlightIdentityLockResource', sql.NVarChar(255), resource)
    .query(`
      DECLARE @LockResult int;
      EXEC @LockResult = sys.sp_getapplock
        @Resource = @FlightIdentityLockResource,
        @LockMode = 'Exclusive',
        @LockOwner = 'Transaction',
        @LockTimeout = 15000;
      SELECT @LockResult AS LockResult;
    `);

  const lockResult = result.recordset?.[0]?.LockResult;
  if (
    typeof lockResult !== 'number' ||
    !Number.isFinite(lockResult) ||
    !Number.isInteger(lockResult) ||
    (lockResult !== 0 && lockResult !== 1)
  ) {
    throw new Error(`Could not lock flight identity (${String(lockResult)})`);
  }

  return resource;
}

function findFlightsByIdentity(rows, flightNumber) {
  const key = normalizeFlightNumber(flightNumber);
  return (Array.isArray(rows) ? rows : []).filter(
    row => normalizeFlightNumber(row?.FlightNumber) === key
  );
}

class FlightLifecycleConflict extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FlightLifecycleConflict';
    this.code = code;
  }
}

// Callers authorize the initial identity before taking this lock. All ordinary
// writers use the same order as import finalisation: application lock, parent
// flight row, then child rows. Re-authorize the authoritative row after waiting.
async function lockAuthoritativeFlight(transaction, sql, initialFlight, authorize) {
  const resource = await acquireFlightIdentityLock(transaction, sql,
    initialFlight.StationId, initialFlight.OperatingDateIso, initialFlight.FlightNumber);
  const selected = await new sql.Request(transaction)
    .input('LockedFlightId', sql.BigInt, initialFlight.FlightId)
    .query(`SELECT FlightId,StationId,FlightNumber,OperatingDate,
      CONVERT(char(10),OperatingDate,23) AS OperatingDateIso,
      Direction,AirlineCode,OriginAirport,DestinationAirport,FlightStatus
      FROM dbo.Flights WITH (UPDLOCK,HOLDLOCK) WHERE FlightId=@LockedFlightId;`);
  const flight = selected.recordset.length === 1 ? selected.recordset[0] : null;
  await authorize(flight);
  if (!flight || String(flight.FlightId) !== String(initialFlight.FlightId) ||
      resource !== flightIdentityLockResource(flight.StationId, flight.OperatingDateIso, flight.FlightNumber) ||
      String(flight.Direction).trim().toUpperCase() !== String(initialFlight.Direction).trim().toUpperCase()) {
    throw new FlightLifecycleConflict('FLIGHT_IDENTITY_CHANGED', 'Flight identity changed; refresh and review again');
  }
  return flight;
}

function requireActiveFlight(flight) {
  if (String(flight?.FlightStatus || '').trim().toUpperCase() !== 'ACTIVE') {
    throw new FlightLifecycleConflict('FLIGHT_NOT_ACTIVE', 'This operation requires an ACTIVE flight');
  }
}

module.exports = {
  FlightLifecycleConflict,
  lockAuthoritativeFlight,
  requireActiveFlight,
  normalizeFlightNumber,
  flightIdentityLockResource,
  acquireFlightIdentityLock,
  findFlightsByIdentity
};
