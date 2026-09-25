'use strict';

const { normalizeUldNumber } = require('./uld');

class CompletionSnapshotError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'CompletionSnapshotError';
    this.code = code;
    this.status = status;
  }
}

function value(row, candidates) {
  for (const candidate of candidates) {
    if (row && row[candidate] !== undefined && row[candidate] !== null) return row[candidate];
  }
  return null;
}

function text(input) {
  return input === null || input === undefined ? '' : String(input);
}

function prefer(primary, fallback) {
  return primary === null || primary === undefined || primary === '' ? fallback : primary;
}

function pick(columns, candidates) {
  const lookup = new Map(columns.map(column => [String(column.COLUMN_NAME).toLowerCase(), column.COLUMN_NAME]));
  for (const candidate of candidates) {
    const found = lookup.get(String(candidate).toLowerCase());
    if (found) return found;
  }
  return null;
}

function quoteName(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

function nullableNumber(input) {
  if (input === null || input === undefined || input === '') return null;
  const number = Number(input);
  return Number.isFinite(number) ? number : null;
}

function timestamp(input) {
  if (input === null || input === undefined || input === '') return null;
  const time = input instanceof Date ? input.getTime() : Date.parse(input);
  return Number.isFinite(time) ? time : null;
}

function isoDate(input) {
  if (input === null || input === undefined || input === '') return '';
  if (input instanceof Date) return input.toISOString().slice(0, 10);
  const raw = String(input);
  const match = raw.match(/^\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const parsed = new Date(input);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
}

function statusLabel(direction, input) {
  const status = String(input || '').trim().toUpperCase().replace(/\s+/g, '_');
  const labels = direction === 'IMPORT'
    ? { UNARRIVED: 'Unarrived', ARRIVED: 'Arrived', TRANSIT: 'Transit', RECEIVED: 'Received' }
    : { WAREHOUSE: 'Warehouse', TRANSIT: 'Transit', AT_AIRCRAFT: 'At Aircraft' };
  return labels[status] || text(input);
}

function shcs(row) {
  const raw = row?.SHCs;
  const values = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return [...new Set(values.map(code => String(code).trim().toUpperCase()).filter(Boolean))].sort();
}

const TEMP_SHCS = new Set(['COL', 'CRT', 'FRO', 'EAT', 'PEF', 'PER', 'ICE']);
const VALUABLE_SHCS = new Set(['VAL', 'AVP', 'AVC', 'GOL']);

function priorityTags(flight, row) {
  const codes = new Set(shcs(row));
  const tags = [];
  const add = key => { if (!tags.includes(key)) tags.push(key); };
  if (codes.has('AVI')) add('LIVE');
  if ([...TEMP_SHCS].some(code => codes.has(code))) add('TEMP');
  if (codes.has('PIL')) add('PHARMA');
  if (codes.has('AOG')) add('AOG');
  if ([...VALUABLE_SHCS].some(code => codes.has(code))) add('VALUABLE');
  if (codes.has('HUM')) add('HUM');
  if (codes.has('DGR')) add('DGR');
  const airline = String(flight?.AirlineCode || '').trim().toUpperCase() ||
    (String(flight?.FlightNumber || '').toUpperCase().match(/^[A-Z0-9]{2,3}/)?.[0] || '').replace(/\d/g, '');
  const handlingText = [row?.Remarks, row?.PriorityText, row?.HandlingType]
    .filter(item => typeof item === 'string' && item.trim()).join(' ').toUpperCase();
  if (['CX', 'UA'].includes(airline) && (codes.has('MAL') || codes.has('MAIL') || /\bMAIL\b/.test(handlingText))) add('MAIL');
  return tags;
}

function canonicalIdentity(rows) {
  const seen = new Map();
  for (const row of rows) {
    const number = normalizeUldNumber(row.UldNumber);
    const uldId = String(row.__UldIdText ?? row.UldId ?? '');
    if (!number || !uldId) {
      throw new CompletionSnapshotError('COMPLETION_ULD_IDENTITY_INVALID', 'Authoritative ULD identity is incomplete');
    }
    if (seen.has(number)) {
      throw new CompletionSnapshotError(
        'COMPLETION_ULD_IDENTITY_CONFLICT',
        `Multiple ULDs on this flight have the normalized identity ${number}`
      );
    }
    seen.set(number, uldId);
  }
}

function validateOperationalState(direction, rows) {
  const permittedStatuses = direction === 'IMPORT'
    ? new Set(['UNARRIVED', 'ARRIVED', 'TRANSIT', 'RECEIVED'])
    : new Set(['WAREHOUSE', 'TRANSIT', 'AT_AIRCRAFT']);
  for (const row of rows) {
    const status = String(row.CurrentStatus || '').trim().toUpperCase().replace(/\s+/g, '_');
    if (!permittedStatuses.has(status) || row.IdentityVerified === null || row.IdentityVerified === undefined) {
      throw new CompletionSnapshotError(
        'COMPLETION_ULD_STATE_INVALID',
        `Authoritative ULD state is incomplete for ${normalizeUldNumber(row.UldNumber) || 'an unknown ULD'}`
      );
    }
  }
}

function commonUld(direction, flight, row) {
  return {
    uldId: String(row.__UldIdText ?? row.UldId),
    num: normalizeUldNumber(row.UldNumber),
    shcs: shcs(row),
    status: statusLabel(direction, row.CurrentStatus),
    identityVerified: row.IdentityVerified === true || row.IdentityVerified === 1,
    handlingType: text(row.HandlingType).trim().toUpperCase(),
    weight: nullableNumber(row.WeightKg),
    remarks: text(row.Remarks),
    priority: text(row.PriorityText),
    priorityTags: priorityTags(flight, row)
  };
}

function importUld(flight, row) {
  return {
    ...commonUld('IMPORT', flight, row),
    isOperatorAdded: row.IsOperatorAdded === true || row.IsOperatorAdded === 1,
    isEmptyLoadDevice: row.IsEmptyLoadDevice === true || row.IsEmptyLoadDevice === 1,
    operatorAddedAt: timestamp(row.OperatorAddedAtUtc),
    operatorAddedBy: text(row.OperatorAddedByDisplayName),
    operatorAddedByReference: text(row.OperatorAddedByReference),
    operatorAddNote: text(row.OperatorAddNote),
    acceptedAt: timestamp(prefer(value(row, ['AcceptedAtUtc', 'AcceptedAt']), row.__AcceptedAudit?.occurredAt)),
    acceptedBy: text(prefer(value(row, ['AcceptedByDisplayName', 'AcceptedByName']), row.__AcceptedAudit?.actorDisplayName)),
    acceptedById: text(prefer(value(row, ['AcceptedByObjectId', 'AcceptedById']), row.__AcceptedAudit?.actorReference)),
    receivedAt: timestamp(prefer(value(row, ['ReceivedAtUtc', 'ReceivedAt']), row.__ReceivedAudit?.occurredAt)),
    receivedBy: text(prefer(value(row, ['ReceivedByDisplayName', 'ReceivedByName']), row.__ReceivedAudit?.actorDisplayName)),
    receivedById: text(prefer(value(row, ['ReceivedByObjectId', 'ReceivedById']), row.__ReceivedAudit?.actorReference))
  };
}

function exportUld(flight, row, hasFinal) {
  return {
    ...commonUld('EXPORT', flight, row),
    isFinalManifestMember: hasFinal ? true : null,
    manifestDisposition: hasFinal ? 'FINAL' : '',
    departedWarehouseAt: timestamp(prefer(value(row, ['WarehouseDepartedAtUtc', 'WarehouseDepartedAt', 'DepartedWarehouseAtUtc']), row.__WarehouseDepartureAudit?.occurredAt)),
    departedWarehouseBy: text(prefer(value(row, ['WarehouseDepartedByDisplayName', 'WarehouseDepartedByName', 'DepartedWarehouseByDisplayName']), row.__WarehouseDepartureAudit?.actorDisplayName)),
    departedWarehouseById: text(prefer(value(row, ['WarehouseDepartedByObjectId', 'WarehouseDepartedById', 'DepartedWarehouseByObjectId']), row.__WarehouseDepartureAudit?.actorReference)),
    atAircraftAt: timestamp(prefer(value(row, ['AtAircraftAtUtc', 'AtAircraftAt']), row.__AtAircraftAudit?.occurredAt)),
    deliveredBy: text(prefer(value(row, ['AtAircraftByDisplayName', 'AtAircraftByName', 'DeliveredByDisplayName']), row.__AtAircraftAudit?.actorDisplayName)),
    deliveredById: text(prefer(value(row, ['AtAircraftByObjectId', 'AtAircraftById', 'DeliveredByObjectId']), row.__AtAircraftAudit?.actorReference))
  };
}

function importSummary(rows) {
  const operatorAdded = rows.filter(row => row.isOperatorAdded);
  const received = rows.filter(row => row.status === 'Received');
  const priority = {};
  let priorityUlds = 0;
  for (const row of rows) {
    if (row.priorityTags.length) priorityUlds++;
    for (const tag of row.priorityTags) priority[tag] = (priority[tag] || 0) + 1;
  }
  const acceptedTimes = rows.map(row => row.acceptedAt).filter(Number.isFinite);
  const receivedTimes = rows.map(row => row.receivedAt).filter(Number.isFinite);
  return {
    expected: rows.length - operatorAdded.length,
    tracked: rows.length,
    received: received.length,
    outstanding: rows.length - received.length,
    intact: rows.filter(row => row.handlingType === 'INTACT').length,
    breakdown: rows.filter(row => row.handlingType === 'BREAKDOWN').length,
    priorityUlds,
    operatorAdded: operatorAdded.length,
    eld: rows.filter(row => row.isEmptyLoadDevice).length,
    firstAccepted: acceptedTimes.length ? Math.min(...acceptedTimes) : null,
    lastReceived: receivedTimes.length ? Math.max(...receivedTimes) : null,
    priority
  };
}

function validateFinalMembership(manifest, rows) {
  if (!manifest) return;
  const expected = Number(manifest.FinalUldCount);
  if (!Number.isSafeInteger(expected) || expected < 0 || rows.length !== expected) {
    throw new CompletionSnapshotError('EXPORT_FINAL_MEMBERSHIP_INVALID', 'Export FINAL membership count is inconsistent');
  }
  rows.forEach((row, index) => {
    if (Number(row.ManifestOrdinal) !== index + 1 ||
        normalizeUldNumber(row.FinalUldNumber) !== normalizeUldNumber(row.UldNumber)) {
      throw new CompletionSnapshotError('EXPORT_FINAL_MEMBERSHIP_INVALID', 'Export FINAL ordered membership is inconsistent');
    }
  });
}

async function loadAuditMovementEvidence(transaction, sql, flightId) {
  const columnsResult = await new sql.Request(transaction)
    .input('CompletionAuditTableName', sql.NVarChar(128), 'AuditEvents')
    .query(`SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@CompletionAuditTableName;`);
  const columns = columnsResult.recordset || [];
  const entityId = pick(columns, ['EntityId']);
  const entityType = pick(columns, ['EntityType']);
  const fromStatus = pick(columns, ['FromStatus']);
  const toStatus = pick(columns, ['ToStatus']);
  const occurredAt = pick(columns, ['OccurredAtUtc', 'OccurredAt', 'CreatedAtUtc']);
  const actorDisplayName = pick(columns, ['ActorDisplayName', 'UserDisplayName', 'ActorName']);
  const actorReference = pick(columns, ['ActorObjectId', 'ActorId', 'ActorReference']);
  const eventId = pick(columns, ['AuditEventId', 'EventId', 'Id']);
  if (!entityId || !fromStatus || !toStatus || !occurredAt) return new Map();

  const result = await new sql.Request(transaction)
    .input('CompletionAuditFlightId', sql.BigInt, flightId)
    .query(`SELECT CONVERT(varchar(20),u.UldId) AS __UldIdText,
        a.${quoteName(fromStatus)} AS FromStatus,
        a.${quoteName(toStatus)} AS ToStatus,
        a.${quoteName(occurredAt)} AS OccurredAtUtc,
        ${actorDisplayName ? `a.${quoteName(actorDisplayName)}` : 'NULL'} AS ActorDisplayName,
        ${actorReference ? `a.${quoteName(actorReference)}` : 'NULL'} AS ActorReference
      FROM dbo.AuditEvents a
      JOIN dbo.ULDs u ON TRY_CONVERT(bigint,a.${quoteName(entityId)})=u.UldId
      WHERE u.FlightId=@CompletionAuditFlightId
        ${entityType ? `AND UPPER(LTRIM(RTRIM(a.${quoteName(entityType)})))='ULD'` : ''}
      ORDER BY a.${quoteName(occurredAt)} DESC${eventId ? `,a.${quoteName(eventId)} DESC` : ''};`);

  const facts = new Map();
  for (const row of result.recordset || []) {
    const uldId = String(row.__UldIdText || '');
    if (!uldId) continue;
    const from = String(row.FromStatus || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    const to = String(row.ToStatus || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    const evidence = {
      occurredAt: row.OccurredAtUtc,
      actorDisplayName: row.ActorDisplayName,
      actorReference: row.ActorReference
    };
    const uldFacts = facts.get(uldId) || {};
    if (to === 'ARRIVED' && !uldFacts.accepted) uldFacts.accepted = evidence;
    if (to === 'RECEIVED' && !uldFacts.received) uldFacts.received = evidence;
    if (from === 'WAREHOUSE' && to === 'TRANSIT' && !uldFacts.warehouseDeparture) {
      uldFacts.warehouseDeparture = evidence;
    }
    if (to === 'AT_AIRCRAFT' && !uldFacts.atAircraft) uldFacts.atAircraft = evidence;
    facts.set(uldId, uldFacts);
  }
  return facts;
}

function applyAuditMovementEvidence(rows, facts) {
  return rows.map(row => {
    const uldFacts = facts.get(String(row.__UldIdText ?? row.UldId ?? '')) || {};
    return {
      ...row,
      __AcceptedAudit: uldFacts.accepted,
      __ReceivedAudit: uldFacts.received,
      __WarehouseDepartureAudit: uldFacts.warehouseDeparture,
      __AtAircraftAudit: uldFacts.atAircraft
    };
  });
}

async function loadAuthoritativeUlds(transaction, sql, flightId, direction) {
  let manifest = null;
  if (direction === 'EXPORT') {
    const finalResult = await new sql.Request(transaction)
      .input('CompletionFinalFlightId', sql.BigInt, flightId)
      .query(`SELECT FinalManifestId,FinalUldCount
        FROM dbo.ExportManifestFinals
        WHERE FlightId=@CompletionFinalFlightId;`);
    if (finalResult.recordset.length > 1) {
      throw new CompletionSnapshotError('EXPORT_FINAL_MEMBERSHIP_INVALID', 'Multiple Export FINAL records exist for this flight');
    }
    manifest = finalResult.recordset[0] || null;
  }

  const request = new sql.Request(transaction).input('CompletionUldFlightId', sql.BigInt, flightId);
  const result = manifest
    ? await request.input('CompletionFinalId', sql.BigInt, manifest.FinalManifestId).query(`SELECT u.*,
        CONVERT(varchar(20),u.UldId) AS __UldIdText,
        m.UldNumber AS FinalUldNumber,m.ManifestOrdinal,
        (SELECT STRING_AGG(s.Code,',') FROM dbo.UldSpecialHandlingCodes s WHERE s.UldId=u.UldId) AS SHCs
      FROM dbo.ExportManifestFinalUlds m
      JOIN dbo.ULDs u ON u.FlightId=m.FlightId AND u.UldId=m.UldId
      WHERE m.FinalManifestId=@CompletionFinalId AND m.FlightId=@CompletionUldFlightId
      ORDER BY m.ManifestOrdinal;`)
    : await request.query(`SELECT u.*,
        CONVERT(varchar(20),u.UldId) AS __UldIdText,
        (SELECT STRING_AGG(s.Code,',') FROM dbo.UldSpecialHandlingCodes s WHERE s.UldId=u.UldId) AS SHCs
      FROM dbo.ULDs u
      WHERE u.FlightId=@CompletionUldFlightId
      ORDER BY u.UldNumber,u.UldId;`);
  const rows = result.recordset || [];
  canonicalIdentity(rows);
  validateOperationalState(direction, rows);
  validateFinalMembership(manifest, rows);
  const auditFacts = await loadAuditMovementEvidence(transaction, sql, flightId);
  return { manifest, rows: applyAuditMovementEvidence(rows, auditFacts) };
}

async function serverCompletionTime(transaction, sql) {
  const result = await new sql.Request(transaction).query(`DECLARE @CompletionTimeUtc datetime2(3)=SYSUTCDATETIME();
    SELECT @CompletionTimeUtc AS CompletionTimeUtc,
      CONVERT(varchar(33),@CompletionTimeUtc,126)+'Z' AS CompletionTimeIso;`);
  const row = result.recordset?.[0];
  if (!row?.CompletionTimeUtc || !row?.CompletionTimeIso) {
    throw new CompletionSnapshotError('COMPLETION_TIME_UNAVAILABLE', 'Server completion time could not be established', 500);
  }
  return row;
}

async function buildCompletionSnapshot(transaction, sql, options) {
  const direction = String(options.direction || '').toUpperCase();
  if (!['IMPORT', 'EXPORT'].includes(direction)) {
    throw new CompletionSnapshotError('COMPLETION_DIRECTION_INVALID', 'Completion direction is invalid', 500);
  }
  const { manifest, rows } = await loadAuthoritativeUlds(transaction, sql, options.flightId, direction);
  const completed = await serverCompletionTime(transaction, sql);
  const flight = options.flight;
  const base = {
    flight: text(flight.FlightNumber),
    flightId: String(flight.FlightId),
    flightDate: isoDate(flight.OperatingDateIso || flight.OperatingDate),
    originAirport: text(flight.OriginAirport),
    destinationAirport: text(flight.DestinationAirport),
    direction,
    flightStatus: text(flight.FlightStatus),
    finalizedBy: options.actor.displayName,
    finalizedById: options.actor.reference,
    finalizedAt: completed.CompletionTimeIso
  };
  if (direction === 'IMPORT') {
    const ulds = rows.map(row => importUld(flight, row));
    return {
      snapshot: { ...base, exceptionReason: options.exceptionReason || null, summary: importSummary(ulds), ulds },
      completionTimeUtc: completed.CompletionTimeUtc
    };
  }
  return {
    snapshot: { ...base, ulds: rows.map(row => exportUld(flight, row, Boolean(manifest))) },
    completionTimeUtc: completed.CompletionTimeUtc
  };
}

module.exports = {
  CompletionSnapshotError,
  buildCompletionSnapshot,
  canonicalIdentity,
  validateOperationalState,
  validateFinalMembership,
  priorityTags,
  statusLabel
};
