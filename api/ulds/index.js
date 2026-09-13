const sql = require('mssql');

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

    /* =========================
       GET /api/ulds?flightId=1
       ========================= */
    if (req.method === 'GET') {
      const flightId = String(req.query?.flightId || '').trim();

      if (!flightId) {
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
            u.UldId,
            u.FlightId,
            u.UldNumber,
            u.HandlingType,
            u.WeightKg,
            u.CurrentStatus,
            u.Remarks,
            u.PriorityText,
            u.CreatedAtUtc,
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
        ulds: result.recordset
      });

      return;
    }

    /* =========================
       POST /api/ulds
       ========================= */

    const body = req.body || {};

    const flightId = String(body.flightId || '').trim();
    const uldNumber = clean(body.uldNumber);
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

    if (!flightId) {
      sendJson(context, 400, {
        ok: false,
        error: 'flightId is required'
      });
      return;
    }

    if (!uldNumber) {
      sendJson(context, 400, {
        ok: false,
        error: 'uldNumber is required'
      });
      return;
    }

    if (
      handlingType &&
      !['INTACT', 'BREAKDOWN'].includes(handlingType)
    ) {
      sendJson(context, 400, {
        ok: false,
        error: 'handlingType must be INTACT or BREAKDOWN'
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

    const direction = flightResult.recordset[0].Direction;

    const currentStatus =
      direction === 'EXPORT'
        ? 'WAREHOUSE'
        : 'UNARRIVED';

    const existing = await pool.request()
      .input('FlightId', sql.BigInt, flightId)
      .input('UldNumber', sql.NVarChar(20), uldNumber)
      .query(`
        SELECT UldId
        FROM dbo.ULDs
        WHERE FlightId = @FlightId
          AND UldNumber = @UldNumber;
      `);

    if (existing.recordset.length) {
      sendJson(context, 409, {
        ok: false,
        error: 'ULD already exists on this flight',
        uldId: existing.recordset[0].UldId
      });
      return;
    }

    const transaction = new sql.Transaction(pool);

    await transaction.begin();

    try {
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
            INSERT INTO dbo.UldSpecialHandlingCodes
              (UldId, Code)
            VALUES
              (@UldId, @Code);
          `);
      }

      await transaction.commit();

      sendJson(context, 201, {
        ok: true,
        uld: {
          ...uld,
          shcs
        }
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
    try {
      await pool?.close();
    } catch {}
  }
};