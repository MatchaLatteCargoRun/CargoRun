'use strict';

const crypto = require('crypto');
const { normalizeUldNumber } = require('./uld');

class ManifestFinalError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'ManifestFinalError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function clean(value, max) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  if (!result) return null;
  return max ? result.slice(0, max) : result;
}

function cleanUpper(value, max) {
  const result = clean(value, max);
  return result ? result.toUpperCase() : null;
}

function normalizeManifestItems(items) {
  if (!Array.isArray(items) || !items.length) {
    throw new ManifestFinalError('FINAL_MANIFEST_EMPTY', 'At least one final export ULD is required');
  }

  const seen = new Set();
  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ManifestFinalError('FINAL_MANIFEST_INVALID_ULD', `Final manifest row ${index + 1} is invalid`);
    }
    const uldNumber = normalizeUldNumber(item.uldNumber ?? item.num);
    if (!uldNumber || uldNumber.length > 20) {
      throw new ManifestFinalError('FINAL_MANIFEST_INVALID_ULD', `Final manifest row ${index + 1} requires a ULD number of at most 20 characters after normalization`);
    }
    if (seen.has(uldNumber)) {
      throw new ManifestFinalError('FINAL_MANIFEST_DUPLICATE_ULD', `Duplicate ULD in final manifest: ${uldNumber}`);
    }
    seen.add(uldNumber);

    const weightValue = item.weightKg ?? item.weight;
    const weightKg = weightValue === null || weightValue === undefined || weightValue === ''
      ? null : Number(weightValue);
    if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 0)) {
      throw new ManifestFinalError('FINAL_MANIFEST_INVALID_WEIGHT', `${uldNumber}: invalid weightKg`);
    }
    const handlingType = cleanUpper(item.handlingType, 20);
    if (handlingType && !['INTACT', 'BREAKDOWN'].includes(handlingType)) {
      throw new ManifestFinalError('FINAL_MANIFEST_INVALID_HANDLING', `${uldNumber}: handlingType must be INTACT or BREAKDOWN`);
    }

    return {
      ordinal: index + 1,
      uldNumber,
      handlingType,
      weightKg,
      remarks: clean(item.remarks, 500),
      priorityText: clean(item.priorityText ?? item.priority, 100),
      shcs: [...new Set((Array.isArray(item.shcs) ? item.shcs : [])
        .map(code => cleanUpper(code, 10)).filter(Boolean))]
    };
  });
}

function reconcileManifest(existingRows, normalizedItems) {
  const byNumber = new Map();
  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    const key = normalizeUldNumber(row?.UldNumber);
    if (!key) continue;
    const matches = byNumber.get(key) || [];
    matches.push(row);
    byNumber.set(key, matches);
  }
  const collisions = [...byNumber.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([uldNumber, rows]) => ({
      uldNumber,
      uldIds: rows.map(row => String(row.UldId))
    }));
  if (collisions.length) {
    throw new ManifestFinalError(
      'FINAL_MANIFEST_ULD_IDENTITY_CONFLICT',
      'Multiple existing ULDs on this flight have the same canonical number',
      409,
      { collisions }
    );
  }

  const finalNumbers = new Set(normalizedItems.map(item => item.uldNumber));
  const matched = [];
  const added = [];
  for (const item of normalizedItems) {
    const row = byNumber.get(item.uldNumber)?.[0] || null;
    if (row) matched.push({ item, row });
    else added.push({ item });
  }
  const excluded = (Array.isArray(existingRows) ? existingRows : [])
    .filter(row => !finalNumbers.has(normalizeUldNumber(row?.UldNumber)))
    .map(row => ({ row, uldNumber: normalizeUldNumber(row?.UldNumber) || String(row?.UldNumber || '') }));

  return { matched, added, excluded };
}

function manifestHash(items) {
  const stable = items.map(item => ({
    ordinal: item.ordinal,
    uldNumber: item.uldNumber,
    handlingType: item.handlingType,
    weightKg: item.weightKg,
    remarks: item.remarks,
    priorityText: item.priorityText,
    shcs: item.shcs
  }));
  return crypto.createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex');
}

function publicReconciliation(flight, items, reconciliation) {
  return {
    flight: {
      flightId: String(flight.FlightId),
      flightNumber: flight.FlightNumber,
      operatingDate: flight.OperatingDateIso || flight.OperatingDate,
      flightStatus: flight.FlightStatus
    },
    finalUldCount: items.length,
    previouslyExpectedCount: reconciliation.matched.length + reconciliation.excluded.length,
    matchedCount: reconciliation.matched.length,
    addedCount: reconciliation.added.length,
    excludedCount: reconciliation.excluded.length,
    matched: reconciliation.matched.map(({ item, row }) => ({
      uldId: String(row.UldId),
      uldNumber: item.uldNumber,
      currentStatus: row.CurrentStatus,
      identityVerified: row.IdentityVerified
    })),
    added: reconciliation.added.map(({ item }) => ({ uldNumber: item.uldNumber })),
    excluded: reconciliation.excluded.map(({ row, uldNumber }) => ({
      uldId: String(row.UldId),
      uldNumber,
      currentStatus: row.CurrentStatus,
      identityVerified: row.IdentityVerified
    }))
  };
}

module.exports = {
  ManifestFinalError,
  normalizeManifestItems,
  reconcileManifest,
  manifestHash,
  publicReconciliation
};
