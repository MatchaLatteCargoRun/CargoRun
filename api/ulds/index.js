const sql = require('mssql');
const { normalizeUldNumber } = require('../shared/uld');
const { acquireFlightIdentityLock } = require('../shared/flight');
const { insertAuditEvent } = require('../shared/audit');

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
    const reference = String(principal.userId || '').trim().slice(0, 150);
    if (!reference) return null;
    return {
      displayName: String(principal.userDetails || 'Authenticated user').slice(0, 150),
      reference
    };
  } catch {
    return null;
  }
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

module.exports = async function (context, req) {
  let pool;

  try {
    const connectionString = process.env.DATABASE_CONNECTION_STRING;

    if (!connectionString) {
      sendJson(context, 503, {
        ok: false,
        error: 'DATABASE_CONNECTION_STRING is not configured'
      });
      return;
    }

    pool = await new sql.ConnectionPool(connectionString).connect();

    /* GET /api/ulds?flightId=1 */
    if (req.method === 'GET') {
      const flightId = String(req.query?.flightId || '').trim();

      if (!/^\d+$/.test(flightId)) {
        sendJson(context, 400, {
          ok: false,
          error: 'flightId is required'
        });
        return;
      }

      const result = await pool.request()
        .input('FlightId', sql.BigInt, flightId)
        .query(`
          SELECT
            u.*,
            CONVERT(varchar(20), u.UldId) AS __UldIdText,
            CONVERT(varchar(20), u.FlightId) AS __FlightIdText,
            CONVERT(bit,CASE WHEN mf.FinalManifestId IS NULL THEN 0 ELSE 1 END) AS IsExportManifestFinal,
            CONVERT(bit,CASE WHEN m.UldId IS NULL THEN 0 ELSE 1 END) AS IsFinalManifestMember,
            (
              SELECT STRING_AGG(s.Code, ',')
              FROM dbo.UldSpecialHandlingCodes s
              WHERE s.UldId = u.UldId
            ) AS SHCs
          FROM dbo.ULDs u
          LEFT JOIN dbo.ExportManifestFinals mf ON mf.FlightId=u.FlightId
          LEFT JOIN dbo.ExportManifestFinalUlds m
            ON m.FinalManifestId=mf.FinalManifestId AND m.FlightId=u.FlightId AND m.UldId=u.UldId
          WHERE u.FlightId = @FlightId
          ORDER BY u.UldNumber;
        `);

      sendJson(context, 200, {
        ok: true,
        count: result.recordset.length,
        ulds: result.recordset.map(({ __UldIdText, __FlightIdText, ...row }) => ({
          ...row, UldId: __UldIdText, FlightId: __FlightIdText
        }))
      });

      return;
    }

    /* POST /api/ulds */
    const body = req.body || {};
    const actor = getActor(req);

    if (!actor) {
      sendJson(context, 401, {
        ok: false,
        error: 'Microsoft Entra sign-in is required'
      });
      return;
    }

    const flightId = String(body.flightId || '').trim();
    const uldNumber = normalizeUldNumber(body.uldNumber);
    const isEmptyLoadDevice = body.isEmptyLoadDevice === true;
    const operatorAddNote = body.note ? String(body.note).trim().slice(0, 500) : null;

    if (!/^\d+$/.test(flightId)) {
      sendJson(context, 400, {
        ok: false,
        error: 'flightId is required'
      });
      return;
    }

    if (!uldNumber || uldNumber.length > 20) {
      sendJson(context, 400, {
        ok: false,
        error: 'uldNumber must be a nonempty string of at most 20 characters after normalization'
      });
      return;
    }

    const flightResult = await pool.request()
      .input('FlightId', sql.BigInt, flightId)
      .query(`
        SELECT FlightId,FlightNumber,OperatingDate,
          CONVERT(char(10),OperatingDate,23) AS OperatingDateIso,Direction
        FROM dbo.Flights
        WHERE FlightId = @FlightId;
      `);

    if (!flightResult.recordset.length) {
      sendJson(context, 404, {
        ok: false,
        error: 'Flight not found'
      });
      return;
    }

    const selectedFlight = flightResult.recordset[0];

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      await acquireFlightIdentityLock(
        transaction,
        sql,
        selectedFlight.OperatingDateIso || selectedFlight.OperatingDate,
        selectedFlight.FlightNumber
      );
      const lockedFlight = await new sql.Request(transaction)
        .input('LockedFlightId', sql.BigInt, flightId)
        .query(`SELECT FlightId,FlightNumber,OperatingDate,Direction,FlightStatus
          FROM dbo.Flights WITH (UPDLOCK,HOLDLOCK) WHERE FlightId=@LockedFlightId;`);
      if (!lockedFlight.recordset.length) {
        await transaction.rollback();
        sendJson(context, 404, { ok: false, error: 'Flight not found' });
        return;
      }
      const locked = lockedFlight.recordset[0];
      const direction = String(locked.Direction || '').toUpperCase();
      if (direction === 'EXPORT') {
        const finalResult = await new sql.Request(transaction)
          .input('ManualFinalFlightId', sql.BigInt, flightId)
          .query(`SELECT FinalManifestId FROM dbo.ExportManifestFinals WITH (UPDLOCK,HOLDLOCK)
            WHERE FlightId=@ManualFinalFlightId;`);
        if (finalResult.recordset.length) {
          await transaction.rollback();
          sendJson(context, 409, {
            ok: false,
            code: 'EXPORT_MANIFEST_ALREADY_FINAL',
            error: 'This flight is FINAL.'
          });
          return;
        }
      }
      if (direction !== 'IMPORT') {
        await transaction.rollback();
        sendJson(context, 403, {
          ok: false,
          code: 'IMPORT_ULD_ONLY',
          error: 'Operational ULD creation is available only for Import flights'
        });
        return;
      }
      if (String(locked.FlightStatus || '').toUpperCase() !== 'ACTIVE') {
        await transaction.rollback();
        sendJson(context, 409, {
          ok: false,
          code: 'IMPORT_FLIGHT_NOT_ACTIVE',
          error: 'ULDs can be added only while the Import flight is active'
        });
        return;
      }
      // Keep the flight's ULD range locked through commit, including an empty range.
      // Compare legacy values without rewriting them or duplicating whitespace rules in SQL.
      const candidates = await new sql.Request(transaction)
        .input('FlightId', sql.BigInt, flightId)
        .query(`
          SELECT UldId, UldNumber
          FROM dbo.ULDs WITH (UPDLOCK, HOLDLOCK)
          WHERE FlightId = @FlightId;
        `);
      const matches = candidates.recordset.filter(
        row => normalizeUldNumber(row.UldNumber) === uldNumber
      );
      if (matches.length) {
        await transaction.rollback();
        sendJson(context, 409, matches.length === 1 ? {
          ok: false,
          error: 'ULD already exists on this flight',
          uldId: matches[0].UldId
        } : {
          ok: false,
          error: 'Multiple existing ULDs on this flight have the same normalized number',
          conflictingUldIds: matches.map(row => row.UldId)
        });
        return;
      }

      const insertResult = await new sql.Request(transaction)
        .input('FlightId', sql.BigInt, flightId)
        .input('UldNumber', sql.NVarChar(20), uldNumber)
        .input('IsEmptyLoadDevice', sql.Bit, isEmptyLoadDevice)
        .input('OperatorAddedByReference', sql.NVarChar(150), actor.reference)
        .input('OperatorAddedByDisplayName', sql.NVarChar(150), actor.displayName)
        .input('OperatorAddNote', sql.NVarChar(500), operatorAddNote)
        .query(`
          INSERT INTO dbo.ULDs
          (
            FlightId,
            UldNumber,
            CurrentStatus,
            IsEmptyLoadDevice,
            IsOperatorAdded,
            OperatorAddedAtUtc,
            OperatorAddedByReference,
            OperatorAddedByDisplayName,
            OperatorAddNote
          )
          OUTPUT
            INSERTED.UldId,
            INSERTED.FlightId,
            INSERTED.UldNumber,
            INSERTED.CurrentStatus,
            INSERTED.CreatedAtUtc,
            INSERTED.IsEmptyLoadDevice,
            INSERTED.IsOperatorAdded,
            INSERTED.OperatorAddedAtUtc,
            INSERTED.OperatorAddedByReference,
            INSERTED.OperatorAddedByDisplayName,
            INSERTED.OperatorAddNote
          VALUES
          (
            @FlightId,
            @UldNumber,
            'UNARRIVED',
            @IsEmptyLoadDevice,
            1,
            SYSUTCDATETIME(),
            @OperatorAddedByReference,
            @OperatorAddedByDisplayName,
            @OperatorAddNote
          );
        `);

      const uld = insertResult.recordset[0];

      await insertAuditEvent(transaction, sql, {
        type: 'ULD',
        action: 'IMPORT_ULD_ADDED',
        actorDisplayName: actor.displayName,
        actorReference: actor.reference,
        entityType: 'ULD',
        entityId: uld.UldId,
        flightId,
        flightNumber: locked.FlightNumber,
        uldId: uld.UldId,
        uldNumber,
        fromStatus: null,
        toStatus: 'UNARRIVED',
        detail: `Import ULD added${isEmptyLoadDevice ? ' as ELD' : ''}${operatorAddNote ? `: ${operatorAddNote}` : ''}`,
        details: {
          operation: 'IMPORT_ULD_ADDED',
          normalizedUldNumber: uldNumber,
          isEmptyLoadDevice,
          note: operatorAddNote
        }
      });

      await transaction.commit();

      sendJson(context, 201, {
        ok: true,
        uld: { ...uld, SHCs: '' }
      });

    } catch (err) {
      await transaction.rollback();
      throw err;
    }

  } catch (err) {
    context.log.error('ULD API failed', err);
    sendJson(context, 500, {
      ok: false,
      error: 'ULD API failed',
      detail: err.message
    });

  } finally {
    try { await pool?.close(); } catch {}
  }
};
