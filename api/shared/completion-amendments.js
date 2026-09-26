'use strict';

const crypto = require('crypto');

class CompletionAmendmentError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'CompletionAmendmentError';
    this.code = code;
    this.status = status;
  }
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
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

function amendmentEnvelope(row, snapshot) {
  return {
    schema: 'CargoRun.ExportCompletionAmendment.v1',
    // Keep the serialized v1 envelope key stable; its value comes from the
    // authoritative dbo.ExportCompletionRecords.CompletionId column.
    exportCompletionRecordId: String(row.CompletionId),
    flightId: String(row.FlightId),
    versionNumber: Number(row.VersionNumber),
    previousHash: String(row.PreviousHash),
    verificationId: String(row.VerificationId),
    operationId: String(row.OperationId),
    action: String(row.Action),
    previousStatus: row.PreviousStatus == null ? null : String(row.PreviousStatus),
    resultingStatus: row.ResultingStatus == null ? null : String(row.ResultingStatus),
    reason: row.Reason == null ? null : String(row.Reason),
    relatedOffloadId: row.RelatedOffloadId == null ? null : String(row.RelatedOffloadId),
    relatedUldId: row.RelatedUldId == null ? null : String(row.RelatedUldId),
    actor: {
      provider: row.ActorProvider == null ? null : String(row.ActorProvider),
      reference: row.ActorReference == null ? null : String(row.ActorReference),
      displayName: String(row.ActorDisplayName)
    },
    occurredAtUtc: String(row.OccurredAtIso || row.OccurredAtUtc),
    snapshot
  };
}

function parseSnapshot(raw, label) {
  if (typeof raw !== 'string' || !raw.length) {
    throw new CompletionAmendmentError('COMPLETION_EVIDENCE_INVALID', `${label} SnapshotJson is missing`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root is not an object');
    return parsed;
  } catch {
    throw new CompletionAmendmentError('COMPLETION_EVIDENCE_INVALID', `${label} SnapshotJson is invalid`);
  }
}

function verifyCompletionEvidence(base, amendments, flightId) {
  if (!base || String(base.FlightId) !== String(flightId)) {
    throw new CompletionAmendmentError('COMPLETION_EVIDENCE_INVALID', 'Export completion FlightId association is invalid');
  }

  const baseSnapshot = parseSnapshot(base.SnapshotJson, 'Export completion V1');
  const baseHash = String(base.RecordHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(baseHash) || sha256(base.SnapshotJson) !== baseHash) {
    throw new CompletionAmendmentError('COMPLETION_EVIDENCE_INVALID', 'Export completion V1 hash verification failed');
  }

  const versions = [{ versionNumber: 1, row: base, snapshot: baseSnapshot, recordHash: baseHash }];
  let previousSnapshot = baseSnapshot;
  let previousHash = baseHash;
  let versionNumber = 2;
  for (const amendment of amendments || []) {
    const actualVersion = Number(amendment.VersionNumber);
    if (!Number.isSafeInteger(actualVersion) || actualVersion !== versionNumber ||
        String(amendment.CompletionId) !== String(base.CompletionId) ||
        String(amendment.FlightId) !== String(flightId) ||
        String(amendment.PreviousHash || '').toLowerCase() !== previousHash) {
      throw new CompletionAmendmentError('COMPLETION_EVIDENCE_INVALID', `Export completion V${versionNumber} chain association is invalid`);
    }
    const snapshot = parseSnapshot(amendment.SnapshotJson, `Export completion V${actualVersion}`);
    const recordHash = String(amendment.RecordHash || '').toLowerCase();
    const calculated = sha256(canonicalJson(amendmentEnvelope(amendment, snapshot)));
    if (!/^[a-f0-9]{64}$/.test(recordHash) || calculated !== recordHash) {
      throw new CompletionAmendmentError('COMPLETION_EVIDENCE_INVALID', `Export completion V${actualVersion} hash verification failed`);
    }
    versions.push({ versionNumber: actualVersion, row: amendment, snapshot, recordHash });
    previousSnapshot = snapshot;
    previousHash = recordHash;
    versionNumber++;
  }

  return { versions, latestSnapshot: previousSnapshot, latestHash: previousHash, nextVersionNumber: versionNumber };
}

function selectExpression(column, alias, conversion = null) {
  if (!column) return `NULL AS ${quoteName(alias)}`;
  return conversion
    ? `${conversion.replace('{column}', quoteName(column))} AS ${quoteName(alias)}`
    : `${quoteName(column)} AS ${quoteName(alias)}`;
}

async function appendOffloadAmendmentIfRequired(transaction, sql, options) {
  if (!transaction) throw new Error('Completion amendment requires a transaction');
  if (options.flightId == null) return null;
  if (String(options.flightStatus || '').trim().toUpperCase() === 'ACTIVE') return null;

  const flightResult = await new sql.Request(transaction)
    .input('AmendmentFlightId', sql.BigInt, options.flightId)
    .query(`SELECT CONVERT(varchar(20), FlightId) AS FlightId, StationId, Direction, FlightStatus
      FROM dbo.Flights WITH (UPDLOCK, HOLDLOCK) WHERE FlightId=@AmendmentFlightId;`);
  if (flightResult.recordset.length !== 1) {
    throw new CompletionAmendmentError('COMPLETION_EVIDENCE_INVALID', 'Amendment flight identity is missing or ambiguous');
  }
  const flight = flightResult.recordset[0];
  const status = String(flight.FlightStatus || '').trim().toUpperCase();
  if (String(flight.Direction || '').trim().toUpperCase() !== 'EXPORT') {
    throw new CompletionAmendmentError('COMPLETION_EVIDENCE_INVALID', 'Amendments require an export flight');
  }
  if (!['CLOSED', 'FINALISED', 'FINALIZED'].includes(status)) return null;

  const schema = await new sql.Request(transaction).query(`SELECT
      OBJECT_ID(N'dbo.ExportCompletionRecords',N'U') AS BaseObjectId,
      OBJECT_ID(N'dbo.ExportCompletionAmendments',N'U') AS AmendmentObjectId;`);
  if (!schema.recordset[0]?.BaseObjectId) return null;

  const baseResult = await new sql.Request(transaction)
    .input('AmendmentBaseFlightId', sql.BigInt, options.flightId)
    .query(`SELECT CONVERT(varchar(20), CompletionId) AS CompletionId,
        CONVERT(varchar(20), FlightId) AS FlightId, CONVERT(nvarchar(100), VerificationId) AS VerificationId,
        SnapshotJson, RecordHash
      FROM dbo.ExportCompletionRecords WITH (UPDLOCK, HOLDLOCK)
      WHERE FlightId=@AmendmentBaseFlightId;`);
  if (!baseResult.recordset.length) return null;
  if (baseResult.recordset.length !== 1) {
    throw new CompletionAmendmentError('COMPLETION_EVIDENCE_INVALID', 'Multiple export completion records exist for this flight');
  }
  if (!schema.recordset[0]?.AmendmentObjectId) {
    throw new CompletionAmendmentError('OFFLOAD_AMENDMENT_SCHEMA_NOT_READY', 'Export completion amendment schema is not ready', 503);
  }
  const base = baseResult.recordset[0];

  const amendmentsResult = await new sql.Request(transaction)
    .input('AmendmentBaseId', sql.BigInt, base.CompletionId)
    .query(`SELECT CONVERT(varchar(20), AmendmentId) AS AmendmentId,
        CONVERT(varchar(20), CompletionId) AS CompletionId,
        CONVERT(varchar(20), FlightId) AS FlightId, VersionNumber, PreviousHash, RecordHash,
        VerificationId, OperationId, Action, PreviousStatus, ResultingStatus, Reason,
        CONVERT(varchar(20), RelatedOffloadId) AS RelatedOffloadId,
        CONVERT(varchar(20), RelatedUldId) AS RelatedUldId,
        ActorProvider, ActorReference, ActorDisplayName,
        CONVERT(varchar(33),OccurredAtUtc,126)+'Z' AS OccurredAtIso, SnapshotJson
      FROM dbo.ExportCompletionAmendments WITH (UPDLOCK, HOLDLOCK)
      WHERE CompletionId=@AmendmentBaseId ORDER BY VersionNumber ASC;`);

  const evidence = verifyCompletionEvidence(base, amendmentsResult.recordset, options.flightId);
  let previousSnapshot = evidence.latestSnapshot;
  let previousHash = evidence.latestHash;
  let versionNumber = evidence.nextVersionNumber;

  const columns = options.offloadColumns || [];
  const id = pick(columns, ['OffloadId', 'Id']);
  const flightId = pick(columns, ['FlightId']);
  const uldId = pick(columns, ['UldId']);
  const statusColumn = pick(columns, ['OffloadStatus', 'Status']);
  if (!id || !flightId || !uldId || !statusColumn) {
    throw new CompletionAmendmentError('OFFLOAD_AMENDMENT_SCHEMA_NOT_READY', 'Offload identity columns are unavailable for amendment evidence', 503);
  }
  const evidenceFields = [
    [id, 'offloadId', 'CONVERT(varchar(20),{column})'],
    [flightId, 'flightId', 'CONVERT(varchar(20),{column})'],
    [uldId, 'uldId', 'CONVERT(varchar(20),{column})'],
    [pick(columns, ['FlightNumber', 'Flight']), 'flightNumber'],
    [pick(columns, ['UldNumber', 'ULDNumber', 'Uld']), 'uldNumber'],
    [pick(columns, ['ParkingBay', 'Bay']), 'parkingBay'],
    [statusColumn, 'status'],
    [pick(columns, ['RequestedAtUtc', 'RequestedAt', 'CreatedAtUtc']), 'requestedAtUtc', "CONVERT(varchar(33),{column},126)+'Z'"],
    [pick(columns, ['RequestedByDisplayName', 'RequestedByName']), 'requestedByDisplayName'],
    [pick(columns, ['CollectedAtUtc', 'CollectedAt']), 'collectedAtUtc', "CONVERT(varchar(33),{column},126)+'Z'"],
    [pick(columns, ['CollectedByDisplayName', 'CollectedByName']), 'collectedByDisplayName'],
    [pick(columns, ['DeliveredAtUtc', 'DeliveredAt', 'CompletedAtUtc', 'CompletedAt']), 'deliveredAtUtc', "CONVERT(varchar(33),{column},126)+'Z'"],
    [pick(columns, ['DeliveredByDisplayName', 'DeliveredByName', 'CompletedByDisplayName']), 'deliveredByDisplayName'],
    [pick(columns, ['DeliveredLocation', 'Location']), 'deliveredLocation'],
    [pick(columns, ['RequestInstruction', 'RequestedInstruction', 'RequestNote', 'HandlingInstruction']), 'requestInstruction'],
    [pick(columns, ['CompletionNote', 'DeliveryNote', 'ExceptionNote']), 'completionNote']
  ];
  const offloadsResult = await new sql.Request(transaction)
    .input('EvidenceFlightId', sql.BigInt, options.flightId)
    .query(`SELECT ${evidenceFields.map(field => selectExpression(...field)).join(', ')}
      FROM dbo.Offloads WITH (UPDLOCK, HOLDLOCK) WHERE ${quoteName(flightId)}=@EvidenceFlightId
      ORDER BY ${quoteName(id)};`);

  const occurred = await new sql.Request(transaction).query(`DECLARE @OccurredAtUtc datetime2(3)=SYSUTCDATETIME();
    SELECT @OccurredAtUtc AS OccurredAtUtc, CONVERT(varchar(33),@OccurredAtUtc,126)+'Z' AS OccurredAtIso;`);
  const occurredAtUtc = occurred.recordset[0].OccurredAtUtc;
  const occurredAtIso = occurred.recordset[0].OccurredAtIso;
  const operationId = crypto.randomUUID();
  const verificationId = crypto.randomUUID();
  const snapshot = {
    ...previousSnapshot,
    offloads: {
      capturedAtUtc: occurredAtIso,
      source: 'dbo.Offloads',
      records: offloadsResult.recordset
    }
  };
  const row = {
    CompletionId: String(base.CompletionId),
    FlightId: String(options.flightId),
    VersionNumber: versionNumber,
    PreviousHash: previousHash,
    VerificationId: verificationId,
    OperationId: operationId,
    Action: options.action,
    PreviousStatus: options.previousStatus || null,
    ResultingStatus: options.resultingStatus || null,
    Reason: options.reason || null,
    RelatedOffloadId: options.offloadId == null ? null : String(options.offloadId),
    RelatedUldId: options.uldId == null ? null : String(options.uldId),
    ActorProvider: options.actorProvider || null,
    ActorReference: options.actorReference || null,
    ActorDisplayName: options.actorDisplayName,
    OccurredAtIso: occurredAtIso
  };
  const snapshotJson = canonicalJson(snapshot);
  const recordHash = sha256(canonicalJson(amendmentEnvelope(row, snapshot)));
  const inserted = await new sql.Request(transaction)
    .input('CompletionBaseId', sql.BigInt, base.CompletionId)
    .input('CompletionFlightId', sql.BigInt, options.flightId)
    .input('CompletionVersion', sql.Int, versionNumber)
    .input('CompletionPreviousHash', sql.NVarChar(128), previousHash)
    .input('CompletionRecordHash', sql.NVarChar(128), recordHash)
    .input('CompletionVerificationId', sql.NVarChar(100), verificationId)
    .input('CompletionOperationId', sql.NVarChar(100), operationId)
    .input('CompletionAction', sql.NVarChar(150), options.action)
    .input('CompletionPreviousStatus', sql.NVarChar(30), options.previousStatus || null)
    .input('CompletionResultingStatus', sql.NVarChar(30), options.resultingStatus || null)
    .input('CompletionReason', sql.NVarChar(1000), options.reason || null)
    .input('CompletionOffloadId', sql.BigInt, options.offloadId)
    .input('CompletionUldId', sql.BigInt, options.uldId)
    .input('CompletionActorProvider', sql.NVarChar(100), options.actorProvider || null)
    .input('CompletionActorReference', sql.NVarChar(150), options.actorReference || null)
    .input('CompletionActorDisplayName', sql.NVarChar(150), options.actorDisplayName)
    .input('CompletionOccurredAtUtc', sql.DateTime2(3), occurredAtUtc)
    .input('CompletionSnapshotJson', sql.NVarChar(sql.MAX), snapshotJson)
    .query(`INSERT INTO dbo.ExportCompletionAmendments
      (CompletionId,FlightId,VersionNumber,PreviousHash,RecordHash,VerificationId,OperationId,
       Action,PreviousStatus,ResultingStatus,Reason,RelatedOffloadId,RelatedUldId,ActorProvider,ActorReference,
       ActorDisplayName,OccurredAtUtc,SnapshotJson)
      OUTPUT CONVERT(varchar(20),INSERTED.AmendmentId) AS AmendmentId
      VALUES (@CompletionBaseId,@CompletionFlightId,@CompletionVersion,@CompletionPreviousHash,@CompletionRecordHash,
       @CompletionVerificationId,@CompletionOperationId,@CompletionAction,@CompletionPreviousStatus,
       @CompletionResultingStatus,@CompletionReason,@CompletionOffloadId,@CompletionUldId,@CompletionActorProvider,
       @CompletionActorReference,@CompletionActorDisplayName,@CompletionOccurredAtUtc,@CompletionSnapshotJson);`);

  return {
    versionNumber,
    amendmentId: String(inserted.recordset[0].AmendmentId),
    verificationId,
    recordHash
  };
}

module.exports = {
  canonicalJson,
  sha256,
  amendmentEnvelope,
  verifyCompletionEvidence,
  CompletionAmendmentError,
  appendOffloadAmendmentIfRequired
};
