const sql = require('mssql');
const { normalizeUldNumber } = require('../shared/uld');
const { normalizeFlightNumber } = require('../shared/flight');
const { insertAuditEvent } = require('../shared/audit');
const { appendOffloadAmendmentIfRequired, CompletionAmendmentError } = require('../shared/completion-amendments');


function getHeader(req, name) {
  const headers = req?.headers || {};
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || null;
}

function getClientPrincipal(req) {
  try {
    const raw = getHeader(req, 'x-ms-client-principal');
    if (!raw) return null;
    const json = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function getActor(req) {
  const principal = getClientPrincipal(req);
  if (!principal) return null;
  const roles = Array.isArray(principal.userRoles) ? principal.userRoles : [];
  if (!roles.includes('authenticated')) return null;
  return {
    displayName: String(principal.userDetails || 'Authenticated user').slice(0, 150),
    reference: String(principal.userId || '').slice(0, 150),
    roles,
    identityProvider: principal.identityProvider || 'aad'
  };
}
function sendJson(context, status, body) {
  context.res = {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function clean(value, max = 150) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function canonical(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function operationalId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const id = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(id) && BigInt(id) <= 9223372036854775807n ? id : null;
}

// Historical export flights remain eligible without changing their lifecycle.
const offloadFlightStatuses = ['ACTIVE', 'CLOSED', 'FINALISED', 'FINALIZED'];
async function selectOffloadFlights(request, flightId = null, lockForUpdate = false) {
  return request.input('SelectedFlightId', sql.BigInt, flightId).query(`
    SELECT CONVERT(varchar(20), FlightId) AS FlightId, FlightNumber,
      CONVERT(char(10), OperatingDate, 23) AS OperatingDate,
      CreatedAtUtc, Direction, FlightStatus
    FROM dbo.Flights ${flightId && lockForUpdate ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}
    WHERE ${flightId ? 'FlightId = @SelectedFlightId' : `Direction = 'EXPORT'
      AND FlightStatus IN (${offloadFlightStatuses.map(status => `'${status}'`).join(',')})`}
    ${flightId ? '' : 'ORDER BY OperatingDate DESC, dbo.Flights.FlightId DESC'};
  `);
}

function pick(columns, candidates) {
  const map = new Map(columns.map(c => [String(c.COLUMN_NAME).toLowerCase(), c.COLUMN_NAME]));
  for (const candidate of candidates) {
    const hit = map.get(String(candidate).toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function q(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

async function columnsFor(request, tableName) {
  const result = await request
    .input('TableName', sql.NVarChar(128), tableName)
    .query(`
      SELECT
        COLUMN_NAME,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        DATA_TYPE,
        COLUMNPROPERTY(
          OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)),
          COLUMN_NAME,
          'IsIdentity'
        ) AS IS_IDENTITY
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo'
        AND TABLE_NAME = @TableName;
    `);
  return result.recordset || [];
}

function normalize(row, columns) {
  const get = candidates => {
    const col = pick(columns, candidates);
    return col ? row[col] : null;
  };
  return {
    offloadId: row.__OffloadIdText ?? get(['OffloadId', 'Id']),
    flightId: row.__FlightIdText ?? get(['FlightId']),
    uldId: row.__UldIdText ?? get(['UldId']),
    flightNumber: get(['FlightNumber', 'Flight']),
    operatingDate: row.__FlightOperatingDate ?? null,
    uldNumber: get(['UldNumber', 'ULDNumber', 'Uld']),
    parkingBay: get(['ParkingBay', 'Bay']),
    status: canonical(get(['Status', 'OffloadStatus'])),
    requestedAtUtc: get(['RequestedAtUtc', 'RequestedAt', 'CreatedAtUtc']),
    requestedByDisplayName: get(['RequestedByDisplayName', 'RequestedByName']),
    collectedAtUtc: get(['CollectedAtUtc', 'CollectedAt']),
    collectedByDisplayName: get(['CollectedByDisplayName', 'CollectedByName']),
    deliveredAtUtc: get(['DeliveredAtUtc', 'DeliveredAt', 'CompletedAtUtc', 'CompletedAt']),
    deliveredByDisplayName: get(['DeliveredByDisplayName', 'DeliveredByName', 'CompletedByDisplayName']),
    deliveredLocation: get(['DeliveredLocation', 'Location']),
    requestInstruction: get(['RequestInstruction', 'RequestedInstruction', 'RequestNote', 'HandlingInstruction']),
    completionNote: get(['CompletionNote', 'DeliveryNote', 'ExceptionNote'])
  };
}

module.exports = async function (context, req) {
  let pool;
  let transaction;

  try {
    const connectionString = process.env.DATABASE_CONNECTION_STRING;
    if (!connectionString) {
      sendJson(context, 503, { ok: false, error: 'DATABASE_CONNECTION_STRING is not configured' });
      return;
    }

    const identity = getActor(req);
    if (!identity) {
      sendJson(context, 401, { ok: false, error: 'Microsoft Entra sign-in is required' });
      return;
    }

    pool = await new sql.ConnectionPool(connectionString).connect();
    const columns = await columnsFor(pool.request(), 'Offloads');
    if (!columns.length) {
      sendJson(context, 500, { ok: false, error: 'dbo.Offloads table was not found' });
      return;
    }

    const idCol = pick(columns, ['OffloadId', 'Id']);
    const statusCol = pick(columns, ['Status', 'OffloadStatus']);
    const flightIdCol = pick(columns, ['FlightId']);
    if (!idCol || !statusCol) {
      sendJson(context, 500, { ok: false, error: 'Offloads schema is missing an ID or status column' });
      return;
    }

    if (req.method === 'GET') {
      if (req.query?.eligibleFlights === 'true') {
        const result = await selectOffloadFlights(pool.request());
        const flights = result.recordset.map(f => ({
          flightId: String(f.FlightId), flightNumber: f.FlightNumber,
          operatingDate: f.OperatingDate, createdAtUtc: f.CreatedAtUtc,
          direction: f.Direction, flightStatus: f.FlightStatus
        }));
        sendJson(context, 200, { ok: true, flights });
        return;
      }
      if (req.query?.flightId !== undefined) {
        const requestedFlightId = operationalId(req.query.flightId);
        if (!requestedFlightId) {
          sendJson(context, 400, { ok: false, error: 'A valid flightId is required' });
          return;
        }
        if (!flightIdCol) {
          sendJson(context, 503, { ok: false, code: 'OFFLOAD_SCHEMA_NOT_READY', error: 'Offload FlightId is unavailable' });
          return;
        }

        const flightResult = await selectOffloadFlights(pool.request(), requestedFlightId, false);
        if (flightResult.recordset.length !== 1) {
          sendJson(context, 404, { ok: false, error: 'Flight not found' });
          return;
        }

        const uldIdCol = pick(columns, ['UldId']);
        const requestedAtCol = pick(columns, ['RequestedAtUtc', 'RequestedAt', 'CreatedAtUtc']);
        const identityColumns = `CONVERT(varchar(20), o.${q(idCol)}) AS __OffloadIdText,
          CONVERT(varchar(20), o.${q(flightIdCol)}) AS __FlightIdText${uldIdCol
            ? `, CONVERT(varchar(20), o.${q(uldIdCol)}) AS __UldIdText`
            : ', CAST(NULL AS varchar(20)) AS __UldIdText'}`;
        const orderBy = requestedAtCol
          ? `CASE WHEN o.${q(requestedAtCol)} IS NULL THEN 1 ELSE 0 END, o.${q(requestedAtCol)} ASC, o.${q(idCol)} ASC`
          : `o.${q(idCol)} ASC`;
        const result = await pool.request()
          .input('SummaryFlightId', sql.BigInt, requestedFlightId)
          .query(`
            SELECT o.*, ${identityColumns}, CONVERT(char(10), f.OperatingDate, 23) AS __FlightOperatingDate
            FROM dbo.Offloads AS o
            INNER JOIN dbo.Flights AS f ON f.FlightId = o.${q(flightIdCol)}
            WHERE o.${q(flightIdCol)} = @SummaryFlightId
            ORDER BY ${orderBy};
          `);
        const selectedFlight = flightResult.recordset[0];
        sendJson(context, 200, {
          ok: true,
          flight: {
            flightId: String(selectedFlight.FlightId),
            flightNumber: selectedFlight.FlightNumber,
            operatingDate: selectedFlight.OperatingDate,
            direction: selectedFlight.Direction,
            flightStatus: selectedFlight.FlightStatus
          },
          count: result.recordset.length,
          offloads: result.recordset.map(row => normalize(row, columns))
        });
        return;
      }
      const result = flightIdCol
        ? await pool.request().query(`
            SELECT o.*, CONVERT(char(10), f.OperatingDate, 23) AS __FlightOperatingDate
            FROM dbo.Offloads AS o
            LEFT JOIN dbo.Flights AS f ON f.FlightId = o.${q(flightIdCol)}
            ORDER BY o.${q(idCol)} DESC;
          `)
        : await pool.request().query(`
            SELECT o.*, CAST(NULL AS char(10)) AS __FlightOperatingDate
            FROM dbo.Offloads AS o
            ORDER BY o.${q(idCol)} DESC;
          `);
      const offloads = result.recordset.map(r => normalize(r, columns));
      sendJson(context, 200, { ok: true, count: offloads.length, offloads });
      return;
    }

    const body = req.body || {};
    const actorDisplayName = identity.displayName;
    const actorReference = identity.reference;

    if (req.method === 'POST') {
      let uldNumber = normalizeUldNumber(body.uldNumber);
      const requestedFlightId = operationalId(body.flightId);
      const requestedUldId = operationalId(body.uldId);
      const requestedFlightNumber = clean(body.flightNumber, 12)?.toUpperCase() || null;
      const requestedOperatingDate = body.operatingDate === null || body.operatingDate === undefined
        ? null
        : String(body.operatingDate).trim();
      const parkingBay = clean(body.parkingBay, 21)?.toUpperCase();
      const requestInstruction = clean(body.requestInstruction, 300);

      if (!uldNumber || !requestedFlightId || !requestedUldId || !parkingBay || parkingBay.length > 20) {
        sendJson(context, 400, { ok: false, error: 'Valid flightId, uldId, uldNumber and parkingBay (at most 20 characters) are required' });
        return;
      }

      if (requestedOperatingDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedOperatingDate)) {
        sendJson(context, 400, { ok: false, error: 'operatingDate must use YYYY-MM-DD' });
        return;
      }

      if (!flightIdCol || !pick(columns, ['UldId'])) {
        sendJson(context, 503, { ok: false, code: 'OFFLOAD_SCHEMA_NOT_READY', error: 'Offload creation requires the Phase B identity migration' });
        return;
      }

      if (uldNumber.length > 20) {
        sendJson(context, 400, { ok: false, error: 'uldNumber exceeds 20 characters after normalization' });
        return;
      }

      transaction = new sql.Transaction(pool);
      await transaction.begin();

      const flightResult = await selectOffloadFlights(new sql.Request(transaction), requestedFlightId, true);
      const selectedFlight = flightResult.recordset?.[0] || null;
      if (!selectedFlight) {
        await transaction.rollback(); transaction = null;
        sendJson(context, 404, { ok: false, error: 'Selected flight was not found' });
        return;
      }

      const flightId = selectedFlight.FlightId;
      const flightNumber = clean(selectedFlight.FlightNumber, 12)?.toUpperCase();
      const operatingDate = clean(selectedFlight.OperatingDate, 10);
      const flightStatusAtRequest = canonical(selectedFlight.FlightStatus);
      if (selectedFlight.Direction !== 'EXPORT' || !offloadFlightStatuses.includes(flightStatusAtRequest)) {
        await transaction.rollback(); transaction = null;
        sendJson(context, 409, { ok: false, code: 'FLIGHT_NOT_ELIGIBLE', error: 'Select an ACTIVE, CLOSED or FINALISED export flight' });
        return;
      }
      const contextMismatch =
        (requestedFlightNumber && normalizeFlightNumber(requestedFlightNumber) !== normalizeFlightNumber(flightNumber)) ||
        (requestedOperatingDate && requestedOperatingDate !== operatingDate);
      if (!flightNumber || contextMismatch) {
        await transaction.rollback(); transaction = null;
        sendJson(context, 409, { ok: false, error: 'Selected flight no longer matches the requested flight context', code: 'FLIGHT_CONTEXT_MISMATCH' });
        return;
      }

      // Lock the whole flight ULD range to detect canonical legacy collisions.
      const ulds = await new sql.Request(transaction)
        .input('FlightId', sql.BigInt, flightId)
        .query(`SELECT CONVERT(varchar(20), UldId) AS UldId, UldNumber
          FROM dbo.ULDs WITH (UPDLOCK, HOLDLOCK) WHERE FlightId = @FlightId;`);
      const selectedUld = ulds.recordset.find(u => String(u.UldId) === requestedUldId);
      const canonicalMatches = ulds.recordset.filter(u => normalizeUldNumber(u.UldNumber) === uldNumber);
      if (!selectedUld || normalizeUldNumber(selectedUld.UldNumber) !== uldNumber || canonicalMatches.length !== 1) {
        await transaction.rollback(); transaction = null;
        sendJson(context, 409, { ok: false, code: 'ULD_CONTEXT_MISMATCH', error: 'Selected ULD does not uniquely match this flight and number; review again' });
        return;
      }
      uldNumber = normalizeUldNumber(selectedUld.UldNumber);

      const active = await new sql.Request(transaction)
        .input('FlightId', sql.BigInt, flightId)
        .query(`SELECT CONVERT(varchar(20), ${q(idCol)}) AS OffloadId,
            CONVERT(varchar(20), UldId) AS UldId, UldNumber
          FROM dbo.Offloads WITH (UPDLOCK, HOLDLOCK)
          WHERE ${q(flightIdCol)} = @FlightId AND ${q(statusCol)} IN ('REQUESTED','TRANSIT');`);
      const duplicates = active.recordset.filter(o => String(o.UldId) === requestedUldId || normalizeUldNumber(o.UldNumber) === uldNumber);
      if (duplicates.length) {
        const conflict = duplicates.length !== 1 ||
          (duplicates[0].UldId != null && String(duplicates[0].UldId) !== requestedUldId) ||
          normalizeUldNumber(duplicates[0].UldNumber) !== uldNumber;
        await transaction.rollback(); transaction = null;
        sendJson(context, 409, conflict
          ? { ok: false, code: 'OFFLOAD_IDENTITY_CONFLICT', error: 'Conflicting active offload identities require review' }
          : { ok: false, code: 'ACTIVE_OFFLOAD_EXISTS', error: 'An active offload already exists', offloadId: String(duplicates[0].OffloadId) });
        return;
      }

      const request = new sql.Request(transaction)
        .input('FlightId', sql.BigInt, flightId)
        .input('UldId', sql.BigInt, requestedUldId)
        .input('FlightNumber', sql.NVarChar(12), flightNumber)
        .input('UldNumber', sql.NVarChar(20), uldNumber)
        .input('ParkingBay', sql.NVarChar(20), parkingBay)
        .input('RequestInstruction', sql.NVarChar(300), requestInstruction)
        .input('Status', sql.VarChar(20), 'REQUESTED')
        .input('ActorDisplayName', sql.NVarChar(150), actorDisplayName)
        .input('ActorReference', sql.NVarChar(150), actorReference);

      const names = [];
      const values = [];
      const add = (candidates, expression) => {
        const col = pick(columns, candidates);
        if (!col || names.includes(col)) return;
        names.push(col);
        values.push(expression);
      };

      add(['FlightId'], '@FlightId');
      add(['UldId'], '@UldId');
      add(['FlightNumber', 'Flight'], '@FlightNumber');
      add(['UldNumber', 'ULDNumber', 'Uld'], '@UldNumber');
      add(['ParkingBay', 'Bay'], '@ParkingBay');
      add(['Status', 'OffloadStatus'], '@Status');
      add(['RequestedAtUtc', 'RequestedAt', 'CreatedAtUtc'], 'SYSUTCDATETIME()');
      add(['RequestedByDisplayName', 'RequestedByName'], '@ActorDisplayName');
      add(['RequestedByObjectId', 'RequestedById', 'RequestedByReference'], '@ActorReference');
      add(['RequestInstruction', 'RequestedInstruction', 'RequestNote', 'HandlingInstruction'], '@RequestInstruction');

      const mapped = new Set(names.map(n => n.toLowerCase()));
      const requiredUnknown = columns.filter(c =>
        c.IS_NULLABLE === 'NO' &&
        !c.COLUMN_DEFAULT &&
        Number(c.IS_IDENTITY) !== 1 &&
        !mapped.has(String(c.COLUMN_NAME).toLowerCase())
      );
      if (requiredUnknown.length) {
        await transaction.rollback();
        transaction = null;
        sendJson(context, 500, {
          ok: false,
          error: `Offloads schema has unmapped required columns: ${requiredUnknown.map(c => c.COLUMN_NAME).join(', ')}`
        });
        return;
      }

      const insert = await request.query(`
        INSERT INTO dbo.Offloads (${names.map(q).join(', ')})
        OUTPUT INSERTED.*
        VALUES (${values.join(', ')});
      `);

      const created = normalize(insert.recordset[0], columns);
      created.operatingDate = operatingDate;
      const amendment = await appendOffloadAmendmentIfRequired(transaction, sql, {
        flightId,
        offloadId: created.offloadId,
        uldId: requestedUldId,
        action: 'OFFLOAD_REQUESTED',
        previousStatus: null,
        resultingStatus: 'REQUESTED',
        reason: requestInstruction,
        actorProvider: identity.identityProvider,
        actorReference,
        actorDisplayName,
        flightStatus: flightStatusAtRequest,
        offloadColumns: columns
      });
      await insertAuditEvent(transaction, sql, {
        type: 'Offload',
        action: 'Offload requested',
        actorDisplayName,
        actorReference,
        entityType: 'Offload',
        entityId: created.offloadId,
        offloadId: created.offloadId,
        flightId,
        uldId: requestedUldId,
        flightNumber: created.flightNumber || flightNumber,
        uldNumber: created.uldNumber || uldNumber,
        toStatus: 'REQUESTED',
        detail: `Requested from bay ${created.parkingBay || parkingBay} • Flight ${flightStatusAtRequest}${requestInstruction ? ` • Instruction: ${requestInstruction}` : ''}`,
        details: { flightStatusAtRequest, operatingDate, amendment }
      });

      await transaction.commit();
      transaction = null;

      sendJson(context, 201, { ok: true, offload: created, amendment });
      return;
    }

    // PATCH
    const offloadId = String(body.offloadId || '').trim();
    const expectedCurrentStatus = canonical(body.expectedCurrentStatus);
    const nextStatus = canonical(body.nextStatus);
    const deliveredLocation = clean(body.deliveredLocation, 150);
    const completionNote = clean(body.completionNote, 300);

    if (!/^\d+$/.test(offloadId)) {
      sendJson(context, 400, { ok: false, error: 'offloadId is required' });
      return;
    }

    if (!expectedCurrentStatus) {
      sendJson(context, 400, { ok: false, error: 'expectedCurrentStatus is required' });
      return;
    }

    const sequence = ['REQUESTED', 'TRANSIT', 'COMPLETE'];
    if (!sequence.includes(nextStatus)) {
      sendJson(context, 400, { ok: false, error: 'nextStatus must be TRANSIT or COMPLETE' });
      return;
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();

    const currentResult = await new sql.Request(transaction)
      .input('OffloadId', sql.BigInt, offloadId)
      .query(`SELECT * FROM dbo.Offloads WHERE ${q(idCol)} = @OffloadId;`);

    if (!currentResult.recordset.length) {
      await transaction.rollback(); transaction = null;
      sendJson(context, 404, { ok: false, error: 'Offload not found' });
      return;
    }

    const current = normalize(currentResult.recordset[0], columns);
    if (expectedCurrentStatus && expectedCurrentStatus !== current.status) {
      await transaction.rollback(); transaction = null;
      sendJson(context, 409, { ok: false, error: 'Offload status changed; refresh and review again', code: 'STALE_STATUS', currentStatus: current.status });
      return;
    }

    const currentIndex = sequence.indexOf(current.status);
    const legalNext = currentIndex >= 0 ? sequence[currentIndex + 1] : null;
    if (nextStatus !== legalNext) {
      await transaction.rollback(); transaction = null;
      sendJson(context, 409, { ok: false, error: `Invalid transition ${current.status} → ${nextStatus}`, expectedNext: legalNext });
      return;
    }

    if (nextStatus === 'COMPLETE' && !deliveredLocation) {
      await transaction.rollback(); transaction = null;
      sendJson(context, 400, { ok: false, error: 'deliveredLocation is required to complete an offload' });
      return;
    }

    // Serialize every stable-identity transition for a flight before changing
    // the offload row. Historical amendment writers use the same flight lock,
    // preventing two different offloads from taking locks in opposite order.
    let amendmentFlightStatus = null;
    const amendmentFlightId = operationalId(current.flightId);
    if (amendmentFlightId) {
      const amendmentFlight = await new sql.Request(transaction)
        .input('AmendmentMutationFlightId', sql.BigInt, amendmentFlightId)
        .query(`SELECT FlightStatus FROM dbo.Flights WITH (UPDLOCK, HOLDLOCK)
          WHERE FlightId=@AmendmentMutationFlightId;`);
      if (amendmentFlight.recordset.length !== 1) {
        throw new CompletionAmendmentError('COMPLETION_EVIDENCE_INVALID', 'Offload flight identity is missing or ambiguous');
      }
      amendmentFlightStatus = amendmentFlight.recordset[0].FlightStatus;
    }

    const request = new sql.Request(transaction)
      .input('OffloadId', sql.BigInt, offloadId)
      .input('ExpectedStatus', sql.VarChar(20), expectedCurrentStatus)
      .input('NextStatus', sql.VarChar(20), nextStatus)
      .input('ActorDisplayName', sql.NVarChar(150), actorDisplayName)
      .input('ActorReference', sql.NVarChar(150), actorReference)
      .input('DeliveredLocation', sql.NVarChar(150), deliveredLocation)
      .input('CompletionNote', sql.NVarChar(300), completionNote);

    const sets = [`${q(statusCol)} = @NextStatus`];
    const addSet = (candidates, expression) => {
      const col = pick(columns, candidates);
      if (col) sets.push(`${q(col)} = ${expression}`);
    };

    if (nextStatus === 'TRANSIT') {
      addSet(['CollectedAtUtc', 'CollectedAt'], 'SYSUTCDATETIME()');
      addSet(['CollectedByDisplayName', 'CollectedByName'], '@ActorDisplayName');
      addSet(['CollectedByObjectId', 'CollectedById', 'CollectedByReference'], '@ActorReference');
    }

    if (nextStatus === 'COMPLETE') {
      addSet(['DeliveredAtUtc', 'DeliveredAt', 'CompletedAtUtc', 'CompletedAt'], 'SYSUTCDATETIME()');
      addSet(['DeliveredByDisplayName', 'DeliveredByName', 'CompletedByDisplayName'], '@ActorDisplayName');
      addSet(['DeliveredByObjectId', 'DeliveredById', 'CompletedByObjectId'], '@ActorReference');
      addSet(['DeliveredLocation', 'Location'], '@DeliveredLocation');
      addSet(['CompletionNote', 'DeliveryNote', 'ExceptionNote'], '@CompletionNote');
    }

    const updated = await request.query(`
      UPDATE dbo.Offloads
      SET ${sets.join(', ')}
      OUTPUT INSERTED.*
      WHERE ${q(idCol)} = @OffloadId
        AND ${q(statusCol)} = @ExpectedStatus;
    `);

    const affectedRows = Number(updated.rowsAffected?.[0] ?? updated.recordset?.length ?? 0);
    if (affectedRows !== 1 || updated.recordset.length !== 1) {
      const latest = affectedRows === 0
        ? await new sql.Request(transaction)
          .input('LatestOffloadId', sql.BigInt, offloadId)
          .query(`SELECT ${q(statusCol)} AS CurrentStatus FROM dbo.Offloads WHERE ${q(idCol)} = @LatestOffloadId;`)
        : null;
      await transaction.rollback(); transaction = null;

      if (affectedRows === 0) {
        sendJson(context, 409, {
          ok: false,
          error: 'Offload status changed; refresh and review again',
          code: 'STALE_STATUS',
          currentStatus: latest?.recordset?.[0]?.CurrentStatus || null
        });
        return;
      }

      sendJson(context, 500, {
        ok: false,
        error: 'Offload status update affected an unexpected number of rows',
        code: 'STATUS_UPDATE_INVARIANT'
      });
      return;
    }

    const changed = normalize(updated.recordset[0], columns);
    const amendment = await appendOffloadAmendmentIfRequired(transaction, sql, {
      flightId: changed.flightId,
      offloadId: changed.offloadId,
      uldId: changed.uldId,
      action: nextStatus === 'TRANSIT' ? 'OFFLOAD_TRANSIT' : 'OFFLOAD_COMPLETE',
      previousStatus: current.status,
      resultingStatus: nextStatus,
      reason: nextStatus === 'COMPLETE' ? completionNote : null,
      actorProvider: identity.identityProvider,
      actorReference,
      actorDisplayName,
      flightStatus: amendmentFlightStatus,
      offloadColumns: columns
    });
    await insertAuditEvent(transaction, sql, {
      type: 'Offload',
      action: nextStatus === 'TRANSIT' ? 'Offload collected' : 'Offload delivered',
      actorDisplayName,
      actorReference,
      entityType: 'Offload',
      entityId: changed.offloadId,
      offloadId: changed.offloadId,
      flightId: changed.flightId,
      uldId: changed.uldId,
      flightNumber: changed.flightNumber,
      uldNumber: changed.uldNumber,
      fromStatus: current.status,
      toStatus: nextStatus,
      detail: nextStatus === 'TRANSIT'
        ? `Collected from bay ${changed.parkingBay || current.parkingBay}${changed.requestInstruction ? ` • ${changed.requestInstruction}` : ''}`
        : `Delivered to ${changed.deliveredLocation || deliveredLocation}${completionNote ? ` • Note: ${completionNote}` : ''}`,
      details: { amendment }
    });

    await transaction.commit(); transaction = null;
    sendJson(context, 200, { ok: true, offload: changed, amendment });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch {} }
    if (err instanceof CompletionAmendmentError) {
      sendJson(context, err.status, { ok: false, code: err.code, error: err.message });
      return;
    }
    // Last defence if a competing writer bypassed the flight-lock protocol.
    // Only translate this specific index violation; other SQL errors fail closed.
    if (req.method === 'POST' && [2601, 2627].includes(err.number) &&
        String(err.message).includes('UX_Offloads_ActiveFlightUld')) {
      try {
        const existing = await pool.request()
          .input('ConflictFlightId', sql.BigInt, operationalId(req.body?.flightId))
          .input('ConflictUldId', sql.BigInt, operationalId(req.body?.uldId))
          .query(`SELECT CONVERT(varchar(20), OffloadId) AS OffloadId
            FROM dbo.Offloads WHERE FlightId = @ConflictFlightId AND UldId = @ConflictUldId
              AND OffloadStatus IN ('REQUESTED','TRANSIT');`);
        sendJson(context, 409, existing.recordset.length === 1
          ? { ok: false, code: 'ACTIVE_OFFLOAD_EXISTS', error: 'An active offload already exists', offloadId: existing.recordset[0].OffloadId }
          : { ok: false, code: 'OFFLOAD_IDENTITY_CONFLICT', error: 'Offload state changed; refresh and review again' });
        return;
      } catch (lookupError) { context.log.error('Offload conflict lookup failed', lookupError); }
    }
    context.log.error('Offloads API failed', err);
    sendJson(context, 500, { ok: false, error: 'Offloads API failed', detail: err.message });
  } finally {
    try { await pool?.close(); } catch {}
  }
};
