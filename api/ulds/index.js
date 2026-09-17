const sql = require('mssql');
const { normalizeUldNumber } = require('../shared/uld');

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
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim().toUpperCase();
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
            (
              SELECT STRING_AGG(s.Code, ',')
              FROM dbo.UldSpecialHandlingCodes s
              WHERE s.UldId = u.UldId
            ) AS SHCs
          FROM dbo.ULDs u
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

    const flightId = String(body.flightId || '').trim();
    const uldNumber = normalizeUldNumber(body.uldNumber);
    const handlingType = clean(body.handlingType);
    const remarks = body.remarks ? String(body.remarks).trim() : null;

    const weightKg =
      body.weightKg === null ||
      body.weightKg === undefined ||
      body.weightKg === ''
        ? null
        : Number(body.weightKg);

    const shcs = Array.isArray(body.shcs)
      ? [...new Set(body.shcs.map(clean).filter(Boolean))]
      : [];

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

    if (handlingType && !['INTACT', 'BREAKDOWN'].includes(handlingType)) {
      sendJson(context, 400, {
        ok: false,
        error: 'handlingType must be INTACT or BREAKDOWN'
      });
      return;
    }

    if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 0)) {
      sendJson(context, 400, {
        ok: false,
        error: 'weightKg must be a valid positive number'
      });
      return;
    }

    const flightResult = await pool.request()
      .input('FlightId', sql.BigInt, flightId)
      .query(`
        SELECT FlightId, Direction
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

    const direction = String(flightResult.recordset[0].Direction || '').toUpperCase();
    const currentStatus = direction === 'EXPORT' ? 'WAREHOUSE' : 'UNARRIVED';

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
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
        .input('HandlingType', sql.VarChar(20), handlingType)
        .input('WeightKg', sql.Decimal(10, 1), weightKg)
        .input('Remarks', sql.NVarChar(500), remarks)
        .input('CurrentStatus', sql.VarChar(30), currentStatus)
        .query(`
          INSERT INTO dbo.ULDs
          (
            FlightId,
            UldNumber,
            HandlingType,
            WeightKg,
            Remarks,
            CurrentStatus
          )
          OUTPUT
            INSERTED.UldId,
            INSERTED.FlightId,
            INSERTED.UldNumber,
            INSERTED.HandlingType,
            INSERTED.WeightKg,
            INSERTED.CurrentStatus,
            INSERTED.CreatedAtUtc
          VALUES
          (
            @FlightId,
            @UldNumber,
            @HandlingType,
            @WeightKg,
            @Remarks,
            @CurrentStatus
          );
        `);

      const uld = insertResult.recordset[0];

      for (const code of shcs) {
        await new sql.Request(transaction)
          .input('UldId', sql.BigInt, uld.UldId)
          .input('Code', sql.NVarChar(10), code)
          .query(`
            INSERT INTO dbo.UldSpecialHandlingCodes (UldId, Code)
            VALUES (@UldId, @Code);
          `);
      }

      await transaction.commit();

      sendJson(context, 201, {
        ok: true,
        uld: { ...uld, shcs }
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
