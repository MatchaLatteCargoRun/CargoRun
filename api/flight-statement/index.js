'use strict';

const sql = require('mssql');
const { CompletionAmendmentError, verifyCompletionEvidence } = require('../shared/completion-amendments');
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

function operationalId(value) {
  const id = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(id) && BigInt(id) <= 9223372036854775807n ? id : null;
}

function requestedVersion(value) {
  if (value == null || String(value).trim() === '') return null;
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 1 ? version : NaN;
}

function actionLabel(action, versionNumber) {
  if (versionNumber === 1) return 'Original finalisation';
  return ({
    OFFLOAD_REQUESTED: 'Offload requested',
    OFFLOAD_TRANSIT: 'Offload collected',
    OFFLOAD_COMPLETE: 'Offload completed'
  })[String(action || '').toUpperCase()] || String(action || 'Amendment').replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
}

function versionMetadata(entry, base) {
  const row = entry.row;
  if (entry.versionNumber === 1) {
    return {
      versionNumber: 1,
      amendmentId: null,
      action: 'ORIGINAL_FINALISATION',
      label: 'Original finalisation',
      previousStatus: null,
      resultingStatus: null,
      reason: null,
      relatedOffloadId: null,
      relatedUldId: null,
      actorDisplayName: base.FinalisedByDisplayName || '',
      actorReference: base.FinalisedByObjectId || '',
      occurredAtUtc: base.FinalisedAtIso,
      verificationId: String(base.VerificationId || ''),
      recordHash: entry.recordHash
    };
  }
  return {
    versionNumber: entry.versionNumber,
    amendmentId: String(row.AmendmentId),
    action: row.Action,
    label: actionLabel(row.Action, entry.versionNumber),
    previousStatus: row.PreviousStatus,
    resultingStatus: row.ResultingStatus,
    reason: row.Reason,
    relatedOffloadId: row.RelatedOffloadId == null ? null : String(row.RelatedOffloadId),
    relatedUldId: row.RelatedUldId == null ? null : String(row.RelatedUldId),
    actorDisplayName: row.ActorDisplayName || '',
    actorReference: row.ActorReference || '',
    occurredAtUtc: row.OccurredAtIso,
    verificationId: String(row.VerificationId || ''),
    recordHash: entry.recordHash
  };
}

module.exports = async function flightStatement(context, req) {
  let pool;
  try {
    const actor = authenticatedActor(req);
    if (!process.env.DATABASE_CONNECTION_STRING) {
      sendJson(context, 503, { ok: false, error: 'DATABASE_CONNECTION_STRING is not configured' });
      return;
    }

    const flightId = operationalId(req.query?.flightId);
    const completionId = req.query?.completionId == null || req.query.completionId === ''
      ? null : operationalId(req.query.completionId);
    const version = requestedVersion(req.query?.version);
    if (!flightId || (req.query?.completionId && !completionId) || Number.isNaN(version)) {
      sendJson(context, 400, { ok: false, code: 'INVALID_STATEMENT_IDENTITY', error: 'Valid flightId, completionId and version identifiers are required' });
      return;
    }

    pool = await new sql.ConnectionPool(process.env.DATABASE_CONNECTION_STRING).connect();
    const flightResult = await pool.request()
      .input('StatementFlightId', sql.BigInt, flightId)
      .query(`SELECT CONVERT(varchar(20),FlightId) AS FlightId, FlightNumber,
          CONVERT(char(10),OperatingDate,23) AS OperatingDate, Direction,
          OriginAirport,DestinationAirport,FlightStatus
        FROM dbo.Flights WHERE FlightId=@StatementFlightId;`);
    if (flightResult.recordset.length !== 1) {
      sendJson(context, 404, { ok: false, code: 'FLIGHT_NOT_FOUND', error: 'Flight not found' });
      return;
    }
    const flight = flightResult.recordset[0];
    await requireOperationalCapability(pool, sql, actor, flight, 'VIEW_FLIGHT_STATEMENT');
    if (String(flight.Direction || '').toUpperCase() !== 'EXPORT') {
      sendJson(context, 409, { ok: false, code: 'STATEMENT_NOT_EXPORT', error: 'Flight Statement is available only for export flights' });
      return;
    }

    const schema = await pool.request().query(`SELECT
      OBJECT_ID(N'dbo.ExportCompletionRecords',N'U') AS BaseObjectId,
      OBJECT_ID(N'dbo.ExportCompletionAmendments',N'U') AS AmendmentObjectId;`);
    if (!schema.recordset[0]?.BaseObjectId || !schema.recordset[0]?.AmendmentObjectId) {
      sendJson(context, 503, { ok: false, code: 'FLIGHT_STATEMENT_UNAVAILABLE', error: 'Flight Statement evidence storage is unavailable' });
      return;
    }

    const baseResult = await pool.request()
      .input('StatementBaseFlightId', sql.BigInt, flightId)
      .query(`SELECT CONVERT(varchar(20),CompletionId) AS CompletionId,
          CONVERT(varchar(20),FlightId) AS FlightId,
          CONVERT(nvarchar(100),VerificationId) AS VerificationId,
          CONVERT(varchar(33),FinalisedAtUtc,126)+'Z' AS FinalisedAtIso,
          FinalisedByObjectId, FinalisedByDisplayName, SnapshotJson, RecordHash
        FROM dbo.ExportCompletionRecords WHERE FlightId=@StatementBaseFlightId;`);
    if (!baseResult.recordset.length) {
      sendJson(context, 404, { ok: false, code: 'COMPLETION_NOT_FOUND', error: 'This flight has no export completion record' });
      return;
    }
    if (baseResult.recordset.length !== 1) {
      sendJson(context, 409, { ok: false, code: 'COMPLETION_EVIDENCE_INVALID', error: 'Multiple export completion records exist for this flight' });
      return;
    }
    const base = baseResult.recordset[0];
    if (completionId && completionId !== String(base.CompletionId)) {
      sendJson(context, 409, { ok: false, code: 'STATEMENT_IDENTITY_MISMATCH', error: 'CompletionId does not belong to the selected FlightId' });
      return;
    }

    const amendmentsResult = await pool.request()
      .input('StatementCompletionId', sql.BigInt, base.CompletionId)
      .query(`SELECT CONVERT(varchar(20),AmendmentId) AS AmendmentId,
          CONVERT(varchar(20),CompletionId) AS CompletionId,
          CONVERT(varchar(20),FlightId) AS FlightId, VersionNumber, PreviousHash, RecordHash,
          CONVERT(nvarchar(100),VerificationId) AS VerificationId, OperationId, Action,
          PreviousStatus, ResultingStatus, Reason,
          CONVERT(varchar(20),RelatedOffloadId) AS RelatedOffloadId,
          CONVERT(varchar(20),RelatedUldId) AS RelatedUldId,
          ActorProvider, ActorReference, ActorDisplayName,
          CONVERT(varchar(33),OccurredAtUtc,126)+'Z' AS OccurredAtIso, SnapshotJson
        FROM dbo.ExportCompletionAmendments
        WHERE CompletionId=@StatementCompletionId ORDER BY VersionNumber ASC;`);

    const evidence = verifyCompletionEvidence(base, amendmentsResult.recordset, flightId);
    const selected = version == null
      ? evidence.versions[evidence.versions.length - 1]
      : evidence.versions.find(item => item.versionNumber === version);
    if (!selected) {
      sendJson(context, 404, { ok: false, code: 'STATEMENT_VERSION_NOT_FOUND', error: `Flight Statement V${version} was not found` });
      return;
    }
    const versions = evidence.versions.map(item => versionMetadata(item, base));
    const selectedMetadata = versions.find(item => item.versionNumber === selected.versionNumber);

    sendJson(context, 200, {
      ok: true,
      flight: {
        flightId: String(flight.FlightId),
        flightNumber: flight.FlightNumber,
        operatingDate: flight.OperatingDate,
        direction: flight.Direction,
        flightStatus: flight.FlightStatus
      },
      completionId: String(base.CompletionId),
      originalFinalisation: {
        finalizedAtUtc: base.FinalisedAtIso,
        finalizedByDisplayName: base.FinalisedByDisplayName || '',
        finalizedByObjectId: base.FinalisedByObjectId || '',
        verificationId: String(base.VerificationId || ''),
        recordHash: String(base.RecordHash || '').toLowerCase()
      },
      latestVersion: evidence.versions.length,
      versions,
      selectedVersion: { ...selectedMetadata, snapshot: selected.snapshot }
    });
  } catch (error) {
    if (sendOperationalAuthorizationError(context, error, sendJson)) return;
    if (error instanceof CompletionAmendmentError) {
      sendJson(context, error.status || 409, { ok: false, code: error.code, error: error.message });
      return;
    }
    context.log.error('Flight Statement API failed', error);
    sendJson(context, 500, { ok: false, code: 'FLIGHT_STATEMENT_FAILED', error: 'Flight Statement could not be loaded' });
  } finally {
    try { await pool?.close(); } catch {}
  }
};
