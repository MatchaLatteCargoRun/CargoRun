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

function flightIdentityLockResource(operatingDate, flightNumber) {
  return `CargoRun:Flight:${String(operatingDate || '').trim()}:${normalizeFlightNumber(flightNumber)}`;
}

async function acquireFlightIdentityLock(transaction, sql, operatingDate, flightNumber) {
  const resource = flightIdentityLockResource(operatingDate, flightNumber);
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

module.exports = {
  normalizeFlightNumber,
  flightIdentityLockResource,
  acquireFlightIdentityLock,
  findFlightsByIdentity
};
