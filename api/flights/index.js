const sql = require('mssql');
const { acquireFlightIdentityLock, findFlightsByIdentity } = require('../shared/flight');
const { insertAuditEvent } = require('../shared/audit');
const {
  authenticatedActor,
  requireOperationalCapability,
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
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
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

function clean(value) {
  return value === null || value === undefined
    ? null
    : String(value).trim().toUpperCase();
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

    const identity = authenticatedActor(req);

    pool = await new sql.ConnectionPool(connectionString).connect();

    if (req.method === 'GET') {
      const result = await pool.request().query(`SELECT f.FlightId,f.FlightNumber,f.OperatingDate,f.Direction,f.AirlineCode,f.OriginAirport,f.DestinationAirport,f.FlightStatus,f.ScheduledArrivalUtc,f.EstimatedArrivalUtc,f.LandedAtUtc,f.InBlockAtUtc,f.ScheduledDepartureUtc,f.EstimatedDepartureUtc,f.SourceType,f.CreatedAtUtc,
        mf.FinalManifestId AS ExportFinalManifestId,
        mf.ConfirmedAtUtc AS ExportFinalConfirmedAtUtc,
        mf.ConfirmedByDisplayName AS ExportFinalConfirmedByDisplayName,
        mf.FinalUldCount AS ExportFinalUldCount,
        mf.MatchedCount AS ExportFinalMatchedCount,
        mf.AddedCount AS ExportFinalAddedCount,
        mf.ExcludedCount AS ExportFinalExcludedCount
        FROM dbo.Flights f
        LEFT JOIN dbo.ExportManifestFinals mf ON mf.FlightId=f.FlightId
        ORDER BY f.OperatingDate DESC,f.FlightNumber ASC;`);
      sendJson(context, 200, { ok: true, count: result.recordset.length, flights: result.recordset });
      return;
    }

    const body = req.body || {};

    if (req.method === 'PATCH') {
      const flightId = String(body.flightId || '').trim();
      if (!/^\d+$/.test(flightId)) {
        sendJson(context, 400, { ok: false, error: 'flightId is required' });
        return;
      }

      const hasScheduledDeparture = Object.prototype.hasOwnProperty.call(body, 'scheduledDepartureUtc');
      const hasEstimatedDeparture = Object.prototype.hasOwnProperty.call(body, 'estimatedDepartureUtc');
      const hasInBlock = Object.prototype.hasOwnProperty.call(body, 'inBlockAtUtc');
      if (hasScheduledDeparture || hasEstimatedDeparture || hasInBlock) {
        const scheduledRaw = body.scheduledDepartureUtc;
        const estimatedRaw = body.estimatedDepartureUtc;
        const inBlockRaw = body.inBlockAtUtc;
        const scheduled = scheduledRaw ? new Date(scheduledRaw) : null;
        const estimated = estimatedRaw ? new Date(estimatedRaw) : null;
        const inBlock = inBlockRaw ? new Date(inBlockRaw) : null;
        if (scheduledRaw && Number.isNaN(scheduled.getTime())) {
          sendJson(context, 400, { ok: false, error: 'scheduledDepartureUtc is invalid' });
          return;
        }
        if (estimatedRaw && Number.isNaN(estimated.getTime())) {
          sendJson(context, 400, { ok: false, error: 'estimatedDepartureUtc is invalid' });
          return;
        }
        if (inBlockRaw && Number.isNaN(inBlock.getTime())) {
          sendJson(context, 400, { ok: false, error: 'inBlockAtUtc is invalid' });
          return;
        }

        transaction = new sql.Transaction(pool);
        await transaction.begin();
        const selected = await new sql.Request(transaction)
          .input('AuthorizationFlightId', sql.BigInt, flightId)
          .query(`SELECT FlightId,FlightNumber,Direction,OriginAirport,DestinationAirport
            FROM dbo.Flights WITH (UPDLOCK,HOLDLOCK) WHERE FlightId=@AuthorizationFlightId;`);
        if (!selected.recordset.length) {
          await transaction.rollback();
          transaction = null;
          sendJson(context, 404, { ok: false, error: 'Flight not found' });
          return;
        }
        const authorizationFlight = selected.recordset[0];
        if (hasInBlock) {
          await requireOperationalCapability(transaction, sql, identity, authorizationFlight, 'SET_IN_BLOCK');
        }
        if (hasScheduledDeparture || hasEstimatedDeparture) {
          await requireOperationalCapability(transaction, sql, identity, authorizationFlight, 'SET_ETD');
        }
        const result = await new sql.Request(transaction)
          .input('FlightId', sql.BigInt, flightId)
          .input('ScheduledDepartureUtc', sql.DateTime2, scheduled)
          .input('EstimatedDepartureUtc', sql.DateTime2, estimated)
          .input('InBlockAtUtc', sql.DateTime2, inBlock)
          .query(`UPDATE dbo.Flights SET ScheduledDepartureUtc=COALESCE(@ScheduledDepartureUtc,ScheduledDepartureUtc),EstimatedDepartureUtc=COALESCE(@EstimatedDepartureUtc,EstimatedDepartureUtc),InBlockAtUtc=COALESCE(@InBlockAtUtc,InBlockAtUtc) OUTPUT INSERTED.FlightId,INSERTED.FlightNumber,INSERTED.ScheduledDepartureUtc,INSERTED.EstimatedDepartureUtc,INSERTED.InBlockAtUtc WHERE FlightId=@FlightId;`);
        if (!result.recordset.length) {
          await transaction.rollback();
          transaction = null;
          sendJson(context, 404, { ok: false, error: 'Flight not found' });
          return;
        }
        const flight = result.recordset[0];
        const action = inBlockRaw
          ? 'In block set manually'
          : estimatedRaw
            ? 'Export ETD set'
            : 'Flight timing updated';
        const timestamp = inBlockRaw || estimatedRaw || scheduledRaw;
        await insertAuditEvent(transaction, sql, {
          type: 'Flight',
          action,
          actorDisplayName: identity.displayName,
          actorReference: identity.reference,
          entityType: 'Flight',
          entityId: flight.FlightId,
          flightId: flight.FlightId,
          flightNumber: flight.FlightNumber,
          detail: `${action}: ${timestamp}`
        });
        await transaction.commit();
        transaction = null;
        sendJson(context, 200, { ok: true, flight: result.recordset[0] });
        return;
      }

      const expectedStatus = clean(body.expectedStatus);
      const nextStatus = clean(body.nextStatus);
      if (expectedStatus !== 'ACTIVE' || nextStatus !== 'CLOSED') {
        sendJson(context, 400, {
          ok: false,
          error: 'Generic flight lifecycle changes only support ACTIVE to CLOSED',
          code: 'INVALID_FLIGHT_TRANSITION'
        });
        return;
      }
      transaction = new sql.Transaction(pool);
      await transaction.begin();

      const selected = await new sql.Request(transaction)
        .input('FlightId', sql.BigInt, flightId)
        .query(`SELECT FlightId,FlightNumber,CONVERT(char(10),OperatingDate,23) AS OperatingDateIso,
          Direction,OriginAirport,DestinationAirport FROM dbo.Flights WHERE FlightId=@FlightId;`);
      if (!selected.recordset.length) {
        await transaction.rollback();
        transaction = null;
        sendJson(context, 404, { ok: false, error: 'Flight not found' });
        return;
      }

      const selectedFlight = selected.recordset[0];
      await acquireFlightIdentityLock(
        transaction,
        sql,
        selectedFlight.OperatingDateIso,
        selectedFlight.FlightNumber
      );

      const current = await new sql.Request(transaction)
        .input('LockedFlightId', sql.BigInt, flightId)
        .query(`SELECT FlightId,FlightNumber,Direction,OriginAirport,DestinationAirport,FlightStatus
          FROM dbo.Flights WITH (UPDLOCK,HOLDLOCK) WHERE FlightId=@LockedFlightId;`);
      if (!current.recordset.length) {
        await transaction.rollback();
        transaction = null;
        sendJson(context, 404, { ok: false, error: 'Flight not found' });
        return;
      }
      const currentFlight = current.recordset[0];
      if (clean(currentFlight.Direction) !== 'IMPORT') {
        await transaction.rollback();
        transaction = null;
        sendJson(context, 400, {
          ok: false,
          error: 'Manual close is only supported for import flights',
          code: 'INVALID_FLIGHT_TRANSITION'
        });
        return;
      }
      await requireOperationalCapability(transaction, sql, identity, currentFlight, 'FINALISE_FLIGHT');
      const currentStatus = clean(currentFlight.FlightStatus);
      if (currentStatus !== 'ACTIVE') {
        await transaction.rollback();
        transaction = null;
        sendJson(context, 409, {
          ok: false,
          error: 'Flight status changed on another device',
          code: 'STALE_FLIGHT_STATUS',
          currentStatus: currentFlight.FlightStatus || null
        });
        return;
      }

      const result = await new sql.Request(transaction)
        .input('CloseFlightId', sql.BigInt, flightId)
        .query(`UPDATE dbo.Flights SET FlightStatus='CLOSED' OUTPUT INSERTED.FlightId,INSERTED.FlightNumber,INSERTED.FlightStatus WHERE FlightId=@CloseFlightId AND UPPER(FlightStatus)='ACTIVE';`);
      if (!result.recordset.length) {
        const latest = await new sql.Request(transaction)
          .input('LatestFlightId', sql.BigInt, flightId)
          .query(`SELECT FlightStatus FROM dbo.Flights WHERE FlightId=@LatestFlightId;`);
        await transaction.rollback();
        transaction = null;
        sendJson(context, 409, {
          ok: false,
          error: 'Flight status changed on another device',
          code: 'STALE_FLIGHT_STATUS',
          currentStatus: latest.recordset?.[0]?.FlightStatus || null
        });
        return;
      }
      const flight = result.recordset[0];
      await insertAuditEvent(transaction, sql, {
        type: 'Flight',
        action: 'Flight manually closed',
        actorDisplayName: identity.displayName,
        actorReference: identity.reference,
        entityType: 'Flight',
        entityId: flight.FlightId,
        flightId: flight.FlightId,
        flightNumber: flight.FlightNumber,
        fromStatus: 'ACTIVE',
        toStatus: 'CLOSED',
        detail: 'Manual close authorized by server capability'
      });
      await transaction.commit();
      transaction = null;
      sendJson(context, 200, { ok: true, flight: result.recordset[0] });
      return;
    }

    const flightNumber = clean(body.flightNumber);
    const direction = clean(body.direction);
    const airlineCode = clean(body.airlineCode);
    const originAirport = clean(body.originAirport);
    const destinationAirport = clean(body.destinationAirport);
    const operatingDate = String(body.operatingDate || '').trim();

    if (!flightNumber) {
      sendJson(context, 400, { ok: false, error: 'flightNumber is required' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(operatingDate)) {
      sendJson(context, 400, { ok: false, error: 'operatingDate must be YYYY-MM-DD' });
      return;
    }
    if (!['IMPORT', 'EXPORT'].includes(direction)) {
      sendJson(context, 400, { ok: false, error: 'direction must be IMPORT or EXPORT' });
      return;
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();
    await acquireFlightIdentityLock(transaction, sql, operatingDate, flightNumber);
    await requireOperationalCapability(transaction, sql, identity, {
      Direction: direction,
      OriginAirport: originAirport,
      DestinationAirport: destinationAirport
    }, 'UPLOAD_FLIGHT_DATA');

    const candidates = await new sql.Request(transaction)
      .input('OperatingDate', sql.Date, operatingDate)
      .query(`SELECT FlightId, FlightNumber FROM dbo.Flights WHERE OperatingDate=@OperatingDate;`);
    const existing = findFlightsByIdentity(candidates.recordset, flightNumber);

    if (existing.length > 1) {
      await transaction.rollback();
      transaction = null;
      sendJson(context, 409, {
        ok: false,
        error: 'Multiple flights have the same canonical identity',
        code: 'FLIGHT_IDENTITY_CONFLICT',
        flightIds: existing.map(flight => flight.FlightId)
      });
      return;
    }

    if (existing.length === 1) {
      await transaction.rollback();
      transaction = null;
      sendJson(context, 409, {
        ok: false,
        error: 'Flight already exists',
        flightId: existing[0].FlightId
      });
      return;
    }

    const result = await new sql.Request(transaction)
      .input('FlightNumber', sql.NVarChar(12), flightNumber)
      .input('OperatingDate', sql.Date, operatingDate)
      .input('Direction', sql.VarChar(6), direction)
      .input('AirlineCode', sql.NVarChar(3), airlineCode)
      .input('OriginAirport', sql.NVarChar(4), originAirport)
      .input('DestinationAirport', sql.NVarChar(4), destinationAirport)
      .input('SourceType', sql.NVarChar(50), 'CARGORUN_UI')
      .input('CreatedByDisplayName', sql.NVarChar(150), identity.displayName)
      .query(`INSERT INTO dbo.Flights(FlightNumber,OperatingDate,Direction,AirlineCode,OriginAirport,DestinationAirport,SourceType,CreatedByDisplayName) OUTPUT INSERTED.FlightId,INSERTED.FlightNumber,INSERTED.OperatingDate,INSERTED.Direction,INSERTED.CreatedAtUtc VALUES(@FlightNumber,@OperatingDate,@Direction,@AirlineCode,@OriginAirport,@DestinationAirport,@SourceType,@CreatedByDisplayName);`);

    await transaction.commit();
    transaction = null;
    sendJson(context, 201, { ok: true, flight: result.recordset[0] });
  } catch (err) {
    if (transaction) {
      try { await transaction.rollback(); } catch {}
    }
    if (sendOperationalAuthorizationError(context, err, sendJson)) return;
    context.log.error('Flights API failed', err);
    sendJson(context, 500, { ok: false, error: 'Flights API failed' });
  } finally {
    try { await pool?.close(); } catch {}
  }
};
