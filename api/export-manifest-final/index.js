'use strict';

const sql = require('mssql');
const { acquireFlightIdentityLock } = require('../shared/flight');
const { insertAuditEvent } = require('../shared/audit');
const {
  ManifestFinalError,
  normalizeManifestItems,
  reconcileManifest,
  manifestHash,
  publicReconciliation
} = require('../shared/export-manifest-final');
const {
  authenticatedActor,
  requireOperationalCapability,
  sendOperationalAuthorizationError
} = require('../shared/operational-authorization');

function sendJson(context, status, body) {
  context.res = {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function getHeader(req, name) {
  const headers = req?.headers || {};
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || null;
}

function getActor(req) {
  try {
    const raw = getHeader(req, 'x-ms-client-principal');
    if (!raw) return null;
    const principal = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    const roles = Array.isArray(principal.userRoles) ? principal.userRoles : [];
    if (!roles.includes('authenticated')) return null;
    return {
      displayName: String(principal.userDetails || 'Authenticated user').slice(0, 150),
      reference: String(principal.userId || '').slice(0, 150)
    };
  } catch {
    return null;
  }
}

function operationalId(value) {
  const id = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(id) && BigInt(id) <= 9223372036854775807n ? id : null;
}

async function loadFlight(request, flightId, locked = false) {
  const hint = locked ? ' WITH (UPDLOCK, HOLDLOCK)' : '';
  const result = await request
    .input(locked ? 'LockedFlightId' : 'SelectedFlightId', sql.BigInt, flightId)
    .query(`SELECT FlightId,FlightNumber,CONVERT(char(10),OperatingDate,23) AS OperatingDateIso,
        OperatingDate,Direction,OriginAirport,DestinationAirport,FlightStatus
      FROM dbo.Flights${hint}
      WHERE FlightId=@${locked ? 'LockedFlightId' : 'SelectedFlightId'};`);
  return result.recordset?.[0] || null;
}

async function loadUlds(request, flightId, locked = false) {
  const hint = locked ? ' WITH (UPDLOCK, HOLDLOCK)' : '';
  const result = await request
    .input(locked ? 'LockedUldFlightId' : 'PreviewUldFlightId', sql.BigInt, flightId)
    .query(`SELECT UldId,FlightId,UldNumber,CurrentStatus,IdentityVerified
      FROM dbo.ULDs${hint}
      WHERE FlightId=@${locked ? 'LockedUldFlightId' : 'PreviewUldFlightId'};`);
  return result.recordset || [];
}

function validateFlight(flight) {
  if (!flight) throw new ManifestFinalError('FLIGHT_NOT_FOUND', 'Flight not found', 404);
  if (String(flight.Direction || '').toUpperCase() !== 'EXPORT') {
    throw new ManifestFinalError('FINAL_MANIFEST_NOT_EXPORT', 'Only export flights can be marked FINAL', 409);
  }
  if (String(flight.FlightStatus || 'ACTIVE').toUpperCase() !== 'ACTIVE') {
    throw new ManifestFinalError('FINAL_MANIFEST_FLIGHT_INACTIVE', 'Only an active export flight can be marked FINAL', 409);
  }
}

async function getFinal(request, flightId, locked = false) {
  const hint = locked ? ' WITH (UPDLOCK, HOLDLOCK)' : '';
  const parameter = locked ? 'LockedFinalFlightId' : 'FinalFlightId';
  const result = await request.input(parameter, sql.BigInt, flightId).query(`
    SELECT FinalManifestId,FlightId,ConfirmedAtUtc,ConfirmedByObjectId,
      ConfirmedByDisplayName,SourceFileName,ManifestHash,FinalUldCount,
      MatchedCount,AddedCount,ExcludedCount
    FROM dbo.ExportManifestFinals${hint}
    WHERE FlightId=@${parameter};
  `);
  return result.recordset?.[0] || null;
}

function finalResponse(row) {
  return row ? {
    finalManifestId: String(row.FinalManifestId),
    flightId: String(row.FlightId),
    confirmedAtUtc: row.ConfirmedAtUtc,
    confirmedByObjectId: row.ConfirmedByObjectId || '',
    confirmedByDisplayName: row.ConfirmedByDisplayName || '',
    sourceFileName: row.SourceFileName || '',
    manifestHash: row.ManifestHash,
    finalUldCount: Number(row.FinalUldCount),
    matchedCount: Number(row.MatchedCount),
    addedCount: Number(row.AddedCount),
    excludedCount: Number(row.ExcludedCount)
  } : null;
}

module.exports = async function exportManifestFinal(context, req) {
  let pool;
  let transaction;
  try {
    if (!process.env.DATABASE_CONNECTION_STRING) {
      sendJson(context, 503, { ok: false, error: 'DATABASE_CONNECTION_STRING is not configured' });
      return;
    }
    const actor = authenticatedActor(req);

    const flightId = operationalId(req.method === 'GET' ? req.query?.flightId : req.body?.flightId);
    if (!flightId) {
      sendJson(context, 400, { ok: false, code: 'INVALID_FLIGHT_ID', error: 'A valid flightId is required' });
      return;
    }
    pool = await new sql.ConnectionPool(process.env.DATABASE_CONNECTION_STRING).connect();

    if (req.method === 'GET') {
      const flight = await loadFlight(pool.request(), flightId);
      if (!flight) {
        sendJson(context, 404, { ok: false, code: 'FLIGHT_NOT_FOUND', error: 'Flight not found' });
        return;
      }
      await requireOperationalCapability(pool, sql, actor, flight, 'VIEW_FLIGHTS');
      const final = await getFinal(pool.request(), flightId);
      sendJson(context, 200, { ok: true, flightId, isFinal: Boolean(final), manifestFinal: finalResponse(final) });
      return;
    }

    const action = String(req.body?.action || 'PREVIEW').trim().toUpperCase();
    if (!['PREVIEW', 'CONFIRM'].includes(action)) {
      sendJson(context, 400, { ok: false, code: 'INVALID_FINAL_ACTION', error: 'action must be PREVIEW or CONFIRM' });
      return;
    }
    const items = normalizeManifestItems(req.body?.ulds);
    const sourceFileName = req.body?.sourceFileName
      ? String(req.body.sourceFileName).trim().slice(0, 260) : null;

    if (action === 'PREVIEW') {
      const flight = await loadFlight(pool.request(), flightId);
      if (!flight) {
        sendJson(context, 404, { ok: false, code: 'FLIGHT_NOT_FOUND', error: 'Flight not found' });
        return;
      }
      await requireOperationalCapability(pool, sql, actor, flight, 'CONFIRM_EXPORT_FINAL');
      validateFlight(flight);
      const currentFinal = await getFinal(pool.request(), flightId);
      if (currentFinal) {
        throw new ManifestFinalError('EXPORT_MANIFEST_ALREADY_FINAL', 'This flight is FINAL.', 409, { manifestFinal: finalResponse(currentFinal) });
      }
      const reconciliation = reconcileManifest(await loadUlds(pool.request(), flightId), items);
      sendJson(context, 200, { ok: true, reconciliation: publicReconciliation(flight, items, reconciliation) });
      return;
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const initialFlight = await loadFlight(new sql.Request(transaction), flightId);
    validateFlight(initialFlight);
    await acquireFlightIdentityLock(
      transaction,
      sql,
      initialFlight.OperatingDateIso || initialFlight.OperatingDate,
      initialFlight.FlightNumber
    );
    const flight = await loadFlight(new sql.Request(transaction), flightId, true);
    validateFlight(flight);
    await requireOperationalCapability(transaction, sql, actor, flight, 'CONFIRM_EXPORT_FINAL');
    const currentFinal = await getFinal(new sql.Request(transaction), flightId, true);
    if (currentFinal) {
      await transaction.rollback();
      transaction = null;
      sendJson(context, 409, {
        ok: false,
        code: 'EXPORT_MANIFEST_ALREADY_FINAL',
        error: 'This flight is FINAL.',
        manifestFinal: finalResponse(currentFinal)
      });
      return;
    }

    const existingRows = await loadUlds(new sql.Request(transaction), flightId, true);
    const reconciliation = reconcileManifest(existingRows, items);
    const members = new Map(reconciliation.matched.map(({ item, row }) => [item.uldNumber, row]));

    for (const { item } of reconciliation.added) {
      const inserted = await new sql.Request(transaction)
        .input('AddedFlightId', sql.BigInt, flightId)
        .input('AddedUldNumber', sql.NVarChar(20), item.uldNumber)
        .input('AddedHandlingType', sql.VarChar(20), item.handlingType)
        .input('AddedWeightKg', sql.Decimal(10, 1), item.weightKg)
        .input('AddedRemarks', sql.NVarChar(500), item.remarks)
        .input('AddedPriorityText', sql.NVarChar(100), item.priorityText)
        .query(`INSERT INTO dbo.ULDs
          (FlightId,UldNumber,HandlingType,WeightKg,Remarks,PriorityText,CurrentStatus,IdentityVerified,SourceType)
          OUTPUT INSERTED.UldId,INSERTED.FlightId,INSERTED.UldNumber,INSERTED.CurrentStatus,INSERTED.IdentityVerified
          VALUES(@AddedFlightId,@AddedUldNumber,@AddedHandlingType,@AddedWeightKg,@AddedRemarks,
            @AddedPriorityText,'WAREHOUSE',0,'EXPORT_FINAL_XLSX');`);
      const row = inserted.recordset[0];
      members.set(item.uldNumber, row);
      for (const code of item.shcs) {
        await new sql.Request(transaction)
          .input('AddedShcUldId', sql.BigInt, row.UldId)
          .input('AddedShcCode', sql.NVarChar(10), code)
          .query(`INSERT INTO dbo.UldSpecialHandlingCodes(UldId,Code)
            VALUES(@AddedShcUldId,@AddedShcCode);`);
      }
    }

    const finalInsert = await new sql.Request(transaction)
      .input('ManifestFlightId', sql.BigInt, flightId)
      .input('ConfirmedByObjectId', sql.NVarChar(150), actor.reference || null)
      .input('ConfirmedByDisplayName', sql.NVarChar(150), actor.displayName)
      .input('SourceFileName', sql.NVarChar(260), sourceFileName)
      .input('ManifestHash', sql.Char(64), manifestHash(items))
      .input('FinalUldCount', sql.Int, items.length)
      .input('MatchedCount', sql.Int, reconciliation.matched.length)
      .input('AddedCount', sql.Int, reconciliation.added.length)
      .input('ExcludedCount', sql.Int, reconciliation.excluded.length)
      .query(`INSERT INTO dbo.ExportManifestFinals
        (FlightId,ConfirmedByObjectId,ConfirmedByDisplayName,SourceFileName,ManifestHash,
         FinalUldCount,MatchedCount,AddedCount,ExcludedCount)
        OUTPUT INSERTED.*
        VALUES(@ManifestFlightId,@ConfirmedByObjectId,@ConfirmedByDisplayName,@SourceFileName,
          @ManifestHash,@FinalUldCount,@MatchedCount,@AddedCount,@ExcludedCount);`);
    const manifestFinal = finalInsert.recordset[0];

    for (const item of items) {
      const member = members.get(item.uldNumber);
      await new sql.Request(transaction)
        .input('MemberFinalManifestId', sql.BigInt, manifestFinal.FinalManifestId)
        .input('MemberFlightId', sql.BigInt, flightId)
        .input('MemberUldId', sql.BigInt, member.UldId)
        .input('MemberUldNumber', sql.NVarChar(20), item.uldNumber)
        .input('MemberOrdinal', sql.Int, item.ordinal)
        .query(`INSERT INTO dbo.ExportManifestFinalUlds
          (FinalManifestId,FlightId,UldId,UldNumber,ManifestOrdinal)
          VALUES(@MemberFinalManifestId,@MemberFlightId,@MemberUldId,@MemberUldNumber,@MemberOrdinal);`);
    }

    await insertAuditEvent(transaction, sql, {
      type: 'Flight',
      action: 'EXPORT_MANIFEST_FINAL_CONFIRMED',
      actorDisplayName: actor.displayName,
      actorReference: actor.reference,
      entityType: 'Flight',
      entityId: flightId,
      flightId,
      flightNumber: flight.FlightNumber,
      detail: `FINAL manifest confirmed: ${items.length} ULDs, ${reconciliation.matched.length} matched, ${reconciliation.added.length} added, ${reconciliation.excluded.length} not on final`,
      details: {
        finalManifestId: String(manifestFinal.FinalManifestId),
        operatingDate: flight.OperatingDateIso,
        finalUldCount: items.length,
        matchedCount: reconciliation.matched.length,
        addedCount: reconciliation.added.length,
        excludedCount: reconciliation.excluded.length,
        manifestHash: manifestFinal.ManifestHash,
        sourceFileName
      }
    });

    await transaction.commit();
    transaction = null;
    sendJson(context, 201, {
      ok: true,
      manifestFinal: finalResponse(manifestFinal),
      reconciliation: publicReconciliation(flight, items, reconciliation)
    });
  } catch (error) {
    if (transaction) {
      try { await transaction.rollback(); } catch {}
    }
    if (sendOperationalAuthorizationError(context, error, sendJson)) return;
    if (error instanceof ManifestFinalError) {
      sendJson(context, error.status, {
        ok: false,
        code: error.code,
        error: error.message,
        ...(error.collisions ? { collisions: error.collisions } : {}),
        ...(error.manifestFinal ? { manifestFinal: error.manifestFinal } : {})
      });
      return;
    }
    context.log.error('Export manifest FINAL failed', error);
    sendJson(context, 500, { ok: false, code: 'EXPORT_MANIFEST_FINAL_FAILED', error: 'Export manifest FINAL failed' });
  } finally {
    try { await pool?.close(); } catch {}
  }
};
