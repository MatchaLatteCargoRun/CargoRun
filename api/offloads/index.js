const sql = require('mssql');
const { normalizeUldNumber } = require('../shared/uld');
const { normalizeFlightNumber } = require('../shared/flight');
const { insertAuditEvent } = require('../shared/audit');
const { appendOffloadAmendmentIfRequired, CompletionAmendmentError } = require('../shared/completion-amendments');
const { operationalId, acquireOffloadFlightLock, evaluateOffloadEligibility } = require('../shared/offload-eligibility');
const {
  authenticatedActor,
  requireOperationalStations,
  resolveActorAccess,
  authorizeRequestedStation,
  operationalEntityUnavailable,
  requireOperationalEntityCapability,
  sendOperationalAuthorizationError
} = require('../shared/operational-authorization');


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

// Historical export flights remain eligible without changing their lifecycle.
const offloadFlightStatuses = ['ACTIVE', 'CLOSED', 'FINALISED', 'FINALIZED'];
async function selectOffloadFlights(request, flightId = null, lockForUpdate = false, selectedStationId = null) {
  request.input('SelectedFlightId', sql.BigInt, flightId);
  if (!flightId && selectedStationId) request.input('SelectedStationId', sql.BigInt, selectedStationId);
  const stationFilter = !flightId && selectedStationId ? ' AND f.StationId=@SelectedStationId' : '';
  return request.query(`
    SELECT CONVERT(varchar(20), f.FlightId) AS FlightId, f.StationId, f.FlightNumber,
      CONVERT(char(10), f.OperatingDate, 23) AS OperatingDate,
      f.CreatedAtUtc, f.Direction,f.OriginAirport,f.DestinationAirport, f.FlightStatus
    FROM dbo.Flights f ${flightId && lockForUpdate ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}
    WHERE ${flightId ? 'f.FlightId = @SelectedFlightId' : `f.Direction = 'EXPORT'
      AND f.FlightStatus IN (${offloadFlightStatuses.map(status => `'${status}'`).join(',')})${stationFilter}`}
    ${flightId ? '' : 'ORDER BY f.OperatingDate DESC, f.FlightId DESC'};
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

async function loadOffloadEligibility(requestSource, flightId, columns, lockForUpdate = false) {
  const idCol = pick(columns, ['OffloadId', 'Id']);
  const flightIdCol = pick(columns, ['FlightId']);
  const uldIdCol = pick(columns, ['UldId']);
  const statusCol = pick(columns, ['Status', 'OffloadStatus']);
  if (!idCol || !flightIdCol || !uldIdCol) throw new Error('Offload identity schema is unavailable');
  const lock = lockForUpdate ? 'WITH (UPDLOCK, HOLDLOCK)' : '';
  const makeRequest = () => typeof requestSource.request === 'function'
    ? requestSource.request()
    : new sql.Request(requestSource);
  const ulds = await makeRequest()
    .input('EligibilityFlightId', sql.BigInt, flightId)
    .query(`SELECT CONVERT(varchar(20), UldId) AS UldId, UldNumber, CurrentStatus
      FROM dbo.ULDs ${lock} WHERE FlightId = @EligibilityFlightId;`);
  const offloads = await makeRequest()
    .input('EligibilityFlightId', sql.BigInt, flightId)
    .query(`SELECT CONVERT(varchar(20), ${q(idCol)}) AS OffloadId,
      CONVERT(varchar(20), ${q(uldIdCol)}) AS UldId, UldNumber,
      ${statusCol ? `${q(statusCol)} AS OffloadStatus` : 'CAST(NULL AS varchar(30)) AS OffloadStatus'}
    FROM dbo.Offloads ${lock} WHERE ${q(flightIdCol)} = @EligibilityFlightId;`);
  return evaluateOffloadEligibility(ulds.recordset, offloads.recordset);
}

function offloadInsertPlan(columns) {
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
  const mapped = new Set(names.map(name => name.toLowerCase()));
  const requiredUnknown = columns.filter(column =>
    column.IS_NULLABLE === 'NO' && !column.COLUMN_DEFAULT && Number(column.IS_IDENTITY) !== 1 &&
    !mapped.has(String(column.COLUMN_NAME).toLowerCase())
  );
  return { names, values, requiredUnknown };
}

async function insertOffloadRow(transaction, columns, values) {
  const plan = offloadInsertPlan(columns);
  if (plan.requiredUnknown.length) {
    throw new Error(`Offloads schema has unmapped required columns: ${plan.requiredUnknown.map(c => c.COLUMN_NAME).join(', ')}`);
  }
  const request = new sql.Request(transaction)
    .input('FlightId', sql.BigInt, values.flightId)
    .input('UldId', sql.BigInt, values.uldId)
    .input('FlightNumber', sql.NVarChar(12), values.flightNumber)
    .input('UldNumber', sql.NVarChar(20), values.uldNumber)
    .input('ParkingBay', sql.NVarChar(20), values.parkingBay)
    .input('RequestInstruction', sql.NVarChar(300), values.requestInstruction)
    .input('Status', sql.VarChar(20), 'REQUESTED')
    .input('ActorDisplayName', sql.NVarChar(150), values.actorDisplayName)
    .input('ActorReference', sql.NVarChar(150), values.actorReference);
  const inserted = await request.query(`INSERT INTO dbo.Offloads (${plan.names.map(q).join(', ')})
    OUTPUT INSERTED.* VALUES (${plan.values.join(', ')});`);
  return normalize(inserted.recordset[0], columns);
}

module.exports = async function (context, req) {
  let pool;
  let transaction;

  try {
    const connectionString = process.env.DATABASE_CONNECTION_STRING;
    if (!connectionString) {
      sendJson(context, 503, {
        ok: false,
        code: 'SERVICE_CONFIGURATION_UNAVAILABLE',
        error: 'Service configuration is unavailable'
      });
      return;
    }

    const identity = authenticatedActor(req);

    pool = await new sql.ConnectionPool(connectionString).connect();
    const method = String(req.method || '').toUpperCase();
    const body = req.body || {};
    let broadAccess = null;
    if (method === 'GET') {
      const broadCollectionRead = req.query?.eligibleFlights === 'true' ||
        (req.query?.eligibleUlds !== 'true' && req.query?.flightId === undefined);
      if (broadCollectionRead) {
        const access = await resolveActorAccess(pool, sql, identity);
        broadAccess = {
          ...access,
          requestedStation: authorizeRequestedStation({
            userAccess: access,
            stationId: req.query?.stationId,
            requiredCapability: 'VIEW_FLIGHTS'
          })
        };
      } else {
        broadAccess = await requireOperationalStations(pool, sql, identity, 'VIEW_FLIGHTS');
      }
    } else if (method === 'POST') {
      broadAccess = await requireOperationalStations(pool, sql, identity, 'REQUEST_OFFLOAD');
    } else if (method === 'PATCH') {
      const requestedOffloadId = String(body.offloadId || '').trim();
      const requestedExpectedStatus = canonical(body.expectedCurrentStatus);
      const requestedNextStatus = canonical(body.nextStatus);
      if (!/^\d+$/.test(requestedOffloadId)) {
        sendJson(context, 400, { ok: false, error: 'offloadId is required' });
        return;
      }
      if (!requestedExpectedStatus) {
        sendJson(context, 400, { ok: false, error: 'expectedCurrentStatus is required' });
        return;
      }
      if (!['REQUESTED', 'TRANSIT', 'COMPLETE'].includes(requestedNextStatus)) {
        sendJson(context, 400, { ok: false, error: 'nextStatus must be TRANSIT or COMPLETE' });
        return;
      }
      broadAccess = await requireOperationalStations(
        pool,
        sql,
        identity,
        requestedNextStatus === 'TRANSIT' ? 'COLLECT_OFFLOAD' : 'COMPLETE_OFFLOAD'
      );
    } else {
      sendJson(context, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    const columns = await columnsFor(pool.request(), 'Offloads');
    if (!columns.length) {
      sendJson(context, 503, {
        ok: false,
        code: 'OFFLOAD_SCHEMA_NOT_READY',
        error: 'Operational data is unavailable'
      });
      return;
    }

    const idCol = pick(columns, ['OffloadId', 'Id']);
    const statusCol = pick(columns, ['Status', 'OffloadStatus']);
    const flightIdCol = pick(columns, ['FlightId']);
    if (!idCol || !statusCol) {
      sendJson(context, 503, {
        ok: false,
        code: 'OFFLOAD_SCHEMA_NOT_READY',
        error: 'Operational data is unavailable'
      });
      return;
    }

    if (method === 'GET') {
      const access = broadAccess;
      if (req.query?.eligibleFlights === 'true') {
        const result = await selectOffloadFlights(pool.request(), null, false, access.requestedStation.stationId);
        const flights = result.recordset.map(f => ({
          flightId: String(f.FlightId), flightNumber: f.FlightNumber,
          operatingDate: f.OperatingDate, createdAtUtc: f.CreatedAtUtc,
          direction: f.Direction, flightStatus: f.FlightStatus
        }));
        sendJson(context, 200, { ok: true, flights });
        return;
      }
      if (req.query?.eligibleUlds === 'true') {
        const requestedFlightId = operationalId(req.query.flightId);
        if (!requestedFlightId) {
          sendJson(context, 400, { ok: false, error: 'A valid flightId is required' });
          return;
        }
        if (!flightIdCol || !pick(columns, ['UldId'])) {
          sendJson(context, 503, { ok: false, code: 'OFFLOAD_SCHEMA_NOT_READY', error: 'Operational data is unavailable' });
          return;
        }
        const flightResult = await selectOffloadFlights(pool.request(), requestedFlightId, false);
        const selectedFlight = flightResult.recordset?.[0] || null;
        const owningStation = await requireOperationalEntityCapability(
          pool, sql, identity, selectedFlight, 'VIEW_FLIGHTS'
        );
        const flightStatus = canonical(selectedFlight?.FlightStatus);
        if (selectedFlight.Direction !== 'EXPORT' || !offloadFlightStatuses.includes(flightStatus)) {
          sendJson(context, 409, { ok: false, code: 'FLIGHT_NOT_ELIGIBLE', error: 'Select an ACTIVE, CLOSED or FINALISED export flight' });
          return;
        }
        const eligibility = await loadOffloadEligibility(pool, requestedFlightId, columns, false);
        const ulds = eligibility.filter(item => item.eligible).map(item => ({
          FlightId: requestedFlightId, UldId: item.uldId,
          UldNumber: item.uldNumber, CurrentStatus: item.currentStatus
        }));
        const blockedUlds = eligibility.filter(item => !item.eligible).map(item => ({
          FlightId: requestedFlightId, UldId: item.uldId,
          UldNumber: item.uldNumber, CurrentStatus: item.currentStatus,
          ReasonCode: item.code, ExistingOffloadId: item.existingOffloadId,
          ExistingOffloadStatus: item.existingOffloadStatus || null
        }));
        sendJson(context, 200, {
          ok: true,
          flight: {
            flightId: String(selectedFlight.FlightId), flightNumber: selectedFlight.FlightNumber,
            stationId: String(owningStation.stationId), stationCode: owningStation.stationCode,
            displayName: owningStation.displayName, timeZoneId: owningStation.timeZoneId,
            operatingDate: selectedFlight.OperatingDate, direction: selectedFlight.Direction,
            flightStatus: selectedFlight.FlightStatus
          },
          count: ulds.length,
          ulds,
          blockedUlds
        });
        return;
      }
      if (req.query?.flightId !== undefined) {
        const requestedFlightId = operationalId(req.query.flightId);
        if (!requestedFlightId) {
          sendJson(context, 400, { ok: false, error: 'A valid flightId is required' });
          return;
        }
        if (!flightIdCol) {
          sendJson(context, 503, { ok: false, code: 'OFFLOAD_SCHEMA_NOT_READY', error: 'Operational data is unavailable' });
          return;
        }

        const flightResult = await selectOffloadFlights(pool.request(), requestedFlightId, false);
        const selectedFlight = flightResult.recordset.length === 1 ? flightResult.recordset[0] : null;
        const owningStation = await requireOperationalEntityCapability(
          pool, sql, identity, selectedFlight, 'VIEW_FLIGHTS'
        );

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
        sendJson(context, 200, {
          ok: true,
          flight: {
            flightId: String(selectedFlight.FlightId),
            stationId: String(owningStation.stationId),
            stationCode: owningStation.stationCode,
            displayName: owningStation.displayName,
            timeZoneId: owningStation.timeZoneId,
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
      if (!flightIdCol) {
        sendJson(context, 503, { ok: false, code: 'OFFLOAD_SCHEMA_NOT_READY', error: 'Operational data is unavailable' });
        return;
      }
      const listRequest = pool.request()
        .input('StationId', sql.BigInt, access.requestedStation.stationId);
      const result = await listRequest.query(`
            SELECT o.*, CONVERT(char(10), f.OperatingDate, 23) AS __FlightOperatingDate
            FROM dbo.Offloads AS o
            INNER JOIN dbo.Flights AS f ON f.FlightId = o.${q(flightIdCol)}
            WHERE f.StationId=@StationId
            ORDER BY o.${q(idCol)} DESC;
          `);
      const offloads = result.recordset.map(r => normalize(r, columns));
      sendJson(context, 200, { ok: true, count: offloads.length, offloads });
      return;
    }

    const actorDisplayName = identity.displayName;
    const actorReference = identity.reference;

    if (method === 'POST') {
      const isBulk = String(body.action || '').toUpperCase() === 'BULK_CREATE';
      const requestedFlightId = operationalId(body.flightId);
      const requestedFlightNumber = clean(body.flightNumber, 12)?.toUpperCase() || null;
      const requestedOperatingDate = body.operatingDate === null || body.operatingDate === undefined
        ? null
        : String(body.operatingDate).trim();
      const parkingBay = clean(body.parkingBay, 21)?.toUpperCase();
      const requestInstruction = clean(body.requestInstruction, 300);
      const requestedUldIds = isBulk
        ? (Array.isArray(body.uldIds) ? body.uldIds.map(operationalId) : [])
        : [operationalId(body.uldId)];
      const requestedUldNumber = isBulk ? null : normalizeUldNumber(body.uldNumber);

      if (!requestedFlightId || !parkingBay || parkingBay.length > 20 || !requestedUldIds.length ||
          requestedUldIds.some(id => !id) || new Set(requestedUldIds).size !== requestedUldIds.length ||
          requestedUldIds.length > 100 || (!isBulk && !requestedUldNumber) || (isBulk && !requestInstruction)) {
        sendJson(context, 400, { ok: false, error: 'Valid flightId, unique uldIds and parkingBay (at most 20 characters) are required; bulk requests also require an instruction' });
        return;
      }
      if (requestedOperatingDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedOperatingDate)) {
        sendJson(context, 400, { ok: false, error: 'operatingDate must use YYYY-MM-DD' });
        return;
      }
      if (!flightIdCol || !pick(columns, ['UldId'])) {
        sendJson(context, 503, { ok: false, code: 'OFFLOAD_SCHEMA_NOT_READY', error: 'Operational data is unavailable' });
        return;
      }
      if (requestedUldNumber && requestedUldNumber.length > 20) {
        sendJson(context, 400, { ok: false, error: 'uldNumber exceeds 20 characters after normalization' });
        return;
      }
      const insertPlan = offloadInsertPlan(columns);
      if (insertPlan.requiredUnknown.length) {
        sendJson(context, 503, { ok: false, code: 'OFFLOAD_SCHEMA_NOT_READY', error: 'Operational data is unavailable' });
        return;
      }

      transaction = new sql.Transaction(pool);
      await transaction.begin();
      await acquireOffloadFlightLock(transaction, sql, requestedFlightId);

      const flightResult = await selectOffloadFlights(new sql.Request(transaction), requestedFlightId, true);
      const selectedFlight = flightResult.recordset?.[0] || null;
      await requireOperationalEntityCapability(transaction, sql, identity, selectedFlight, 'REQUEST_OFFLOAD');

      const flightId = String(selectedFlight.FlightId);
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

      const eligibility = await loadOffloadEligibility(transaction, flightId, columns, true);
      const eligibilityById = new Map(eligibility.map(item => [item.uldId, item]));
      const selected = requestedUldIds.map(uldId => eligibilityById.get(uldId) || {
        uldId, uldNumber: null, eligible: false, code: 'ULD_NOT_FOUND', existingOffloadId: null
      });
      if (!isBulk && selected[0]?.uldNumber !== requestedUldNumber) {
        selected[0] = { ...selected[0], eligible: false, code: 'ULD_CONTEXT_MISMATCH', existingOffloadId: null };
      }
      const failures = selected.filter(item => !item.eligible).map(item => ({
        uldId: item.uldId, uldNumber: item.uldNumber,
        code: item.code || 'ULD_NOT_ELIGIBLE', existingOffloadId: item.existingOffloadId || null
      }));
      if (failures.length) {
        await transaction.rollback(); transaction = null;
        if (isBulk) {
          sendJson(context, 409, {
            ok: false, code: 'BULK_OFFLOAD_CONFLICT',
            error: 'One or more ULDs already have an offload or are no longer eligible. No new requests were created.',
            failures
          });
        } else {
          const failure = failures[0];
          sendJson(context, 409, failure.code === 'OFFLOAD_EXISTS'
            ? { ok: false, code: 'OFFLOAD_EXISTS', error: 'An offload already exists for this flight and ULD', offloadId: failure.existingOffloadId }
            : { ok: false, code: failure.code, error: 'Selected ULD is not eligible for a new offload; review again' });
        }
        return;
      }

      const createdOffloads = [];
      const amendments = [];
      for (let index = 0; index < selected.length; index += 1) {
        const candidate = selected[index];
        const created = await insertOffloadRow(transaction, columns, {
          flightId, uldId: candidate.uldId, flightNumber, uldNumber: candidate.uldNumber,
          parkingBay, requestInstruction, actorDisplayName, actorReference
        });
        created.operatingDate = operatingDate;
        const amendment = await appendOffloadAmendmentIfRequired(transaction, sql, {
          flightId,
          offloadId: created.offloadId,
          uldId: candidate.uldId,
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
          uldId: candidate.uldId,
          flightNumber: created.flightNumber || flightNumber,
          uldNumber: created.uldNumber || candidate.uldNumber,
          toStatus: 'REQUESTED',
          detail: `Requested from bay ${created.parkingBay || parkingBay} • Flight ${flightStatusAtRequest}${requestInstruction ? ` • Instruction: ${requestInstruction}` : ''}`,
          details: { flightStatusAtRequest, operatingDate, amendment, bulkCount: isBulk ? selected.length : null, bulkIndex: isBulk ? index + 1 : null }
        });
        createdOffloads.push(created);
        amendments.push(amendment);
      }

      await transaction.commit();
      transaction = null;
      if (isBulk) {
        sendJson(context, 201, {
          ok: true, count: createdOffloads.length, offloads: createdOffloads,
          amendments, message: `${createdOffloads.length} offload${createdOffloads.length === 1 ? '' : 's'} requested`
        });
      } else {
        sendJson(context, 201, { ok: true, offload: createdOffloads[0], amendment: amendments[0] });
      }
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

    const requiredTransitionCapability = nextStatus === 'TRANSIT'
      ? 'COLLECT_OFFLOAD'
      : 'COMPLETE_OFFLOAD';

    transaction = new sql.Transaction(pool);
    await transaction.begin();

    const currentResult = await new sql.Request(transaction)
      .input('OffloadId', sql.BigInt, offloadId)
      .query(`SELECT * FROM dbo.Offloads WHERE ${q(idCol)} = @OffloadId;`);

    if (!currentResult.recordset.length) {
      throw operationalEntityUnavailable();
    }

    const current = normalize(currentResult.recordset[0], columns);
    // Resolve the stored parent identity and authorize it before returning any
    // status, transition, route or ULD-derived response.
    let amendmentFlightStatus = null;
    const amendmentFlightId = operationalId(current.flightId);
    if (amendmentFlightId) {
      const amendmentFlight = await new sql.Request(transaction)
        .input('AmendmentMutationFlightId', sql.BigInt, amendmentFlightId)
        .query(`SELECT StationId,FlightStatus,Direction,OriginAirport,DestinationAirport
          FROM dbo.Flights WITH (UPDLOCK, HOLDLOCK)
          WHERE FlightId=@AmendmentMutationFlightId;`);
      const authorizationFlight = amendmentFlight.recordset.length === 1
        ? amendmentFlight.recordset[0]
        : null;
      await requireOperationalEntityCapability(
        transaction,
        sql,
        identity,
        authorizationFlight,
        requiredTransitionCapability
      );
      amendmentFlightStatus = authorizationFlight.FlightStatus;
    } else {
      throw operationalEntityUnavailable();
    }

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
    if (sendOperationalAuthorizationError(context, err, sendJson)) return;
    if (err instanceof CompletionAmendmentError) {
      sendJson(context, err.status, { ok: false, code: err.code, error: err.message });
      return;
    }
    // Last defence if a competing writer bypassed the flight-lock protocol.
    // Only translate this specific index violation; other SQL errors fail closed.
    if (req.method === 'POST' && [2601, 2627].includes(err.number) &&
        String(err.message).includes('UX_Offloads_ActiveFlightUld')) {
      try {
        const isBulk = String(req.body?.action || '').toUpperCase() === 'BULK_CREATE';
        const selectedIds = isBulk && Array.isArray(req.body?.uldIds)
          ? req.body.uldIds.map(operationalId).filter(Boolean)
          : [operationalId(req.body?.uldId)].filter(Boolean);
        const existing = await pool.request()
          .input('ConflictFlightId', sql.BigInt, operationalId(req.body?.flightId))
          .query(`SELECT CONVERT(varchar(20), OffloadId) AS OffloadId,
              CONVERT(varchar(20), UldId) AS UldId
            FROM dbo.Offloads WHERE FlightId = @ConflictFlightId;`);
        const conflicts = existing.recordset.filter(row => selectedIds.includes(String(row.UldId)));
        sendJson(context, 409, isBulk
          ? {
              ok: false, code: 'BULK_OFFLOAD_CONFLICT',
              error: 'One or more ULDs already have an offload. No new requests were created.',
              failures: conflicts.map(row => ({ uldId: String(row.UldId), code: 'OFFLOAD_EXISTS', existingOffloadId: String(row.OffloadId) }))
            }
          : conflicts.length === 1
            ? { ok: false, code: 'OFFLOAD_EXISTS', error: 'An offload already exists for this flight and ULD', offloadId: String(conflicts[0].OffloadId) }
            : { ok: false, code: 'OFFLOAD_IDENTITY_CONFLICT', error: 'Offload state changed; refresh and review again' });
        return;
      } catch (lookupError) { context.log.error('Offload conflict lookup failed', lookupError); }
    }
    context.log.error('Offloads API failed', err);
    sendJson(context, 500, { ok: false, error: 'Offloads API failed' });
  } finally {
    try { await pool?.close(); } catch {}
  }
};
