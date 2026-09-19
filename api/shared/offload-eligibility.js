'use strict';

const { normalizeUldNumber } = require('./uld');

function operationalId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const id = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(id) && BigInt(id) <= 9223372036854775807n ? id : null;
}

function offloadFlightLockResource(flightId) {
  const id = operationalId(flightId);
  if (!id) throw new Error('A valid FlightId is required for the offload lock');
  return `CargoRun:OffloadFlight:${id}`;
}

async function acquireOffloadFlightLock(transaction, sql, flightId) {
  const resource = offloadFlightLockResource(flightId);
  const result = await new sql.Request(transaction)
    .input('OffloadFlightLockResource', sql.NVarChar(255), resource)
    .query(`
      DECLARE @LockResult int;
      EXEC @LockResult = sys.sp_getapplock
        @Resource = @OffloadFlightLockResource,
        @LockMode = 'Exclusive',
        @LockOwner = 'Transaction',
        @LockTimeout = 15000;
      SELECT @LockResult AS LockResult;
    `);
  const lockResult = result.recordset?.[0]?.LockResult;
  if (!Number.isInteger(lockResult) || (lockResult !== 0 && lockResult !== 1)) {
    throw new Error(`Could not lock offload flight (${String(lockResult)})`);
  }
  return resource;
}

function evaluateOffloadEligibility(uldRows, offloadRows) {
  const ulds = Array.isArray(uldRows) ? uldRows : [];
  const offloads = Array.isArray(offloadRows) ? offloadRows : [];
  const canonicalCounts = new Map();
  for (const row of ulds) {
    const canonical = normalizeUldNumber(row?.UldNumber);
    if (canonical) canonicalCounts.set(canonical, (canonicalCounts.get(canonical) || 0) + 1);
  }

  return ulds.map(row => {
    const uldId = operationalId(row?.UldId);
    const uldNumber = normalizeUldNumber(row?.UldNumber);
    if (!uldId || !uldNumber) {
      return { uldId, uldNumber, currentStatus: row?.CurrentStatus || null, eligible: false, code: 'ULD_IDENTITY_INVALID', existingOffloadId: null };
    }
    if (canonicalCounts.get(uldNumber) !== 1) {
      return { uldId, uldNumber, currentStatus: row?.CurrentStatus || null, eligible: false, code: 'ULD_IDENTITY_CONFLICT', existingOffloadId: null };
    }

    const matches = offloads.filter(offload => {
      const existingUldId = operationalId(offload?.UldId);
      const existingNumber = normalizeUldNumber(offload?.UldNumber);
      return existingUldId === uldId || (!!existingNumber && existingNumber === uldNumber);
    });
    if (matches.length) {
      const exact = matches.length === 1 &&
        (!operationalId(matches[0]?.UldId) || operationalId(matches[0]?.UldId) === uldId) &&
        normalizeUldNumber(matches[0]?.UldNumber) === uldNumber;
      return {
        uldId, uldNumber, currentStatus: row?.CurrentStatus || null, eligible: false,
        code: exact ? 'OFFLOAD_EXISTS' : 'OFFLOAD_IDENTITY_CONFLICT',
        existingOffloadId: exact ? operationalId(matches[0]?.OffloadId) : null,
        existingOffloadStatus: exact ? (matches[0]?.OffloadStatus || matches[0]?.Status || null) : null
      };
    }
    return { uldId, uldNumber, currentStatus: row?.CurrentStatus || null, eligible: true, code: null, existingOffloadId: null };
  });
}

module.exports = {
  operationalId,
  offloadFlightLockResource,
  acquireOffloadFlightLock,
  evaluateOffloadEligibility
};
