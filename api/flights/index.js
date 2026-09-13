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
  return value === null || value === undefined
    ? null
    : String(value).trim().toUpperCase();
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
       GET /api/flights
       ========================= */
    if (req.method === 'GET') {
      const result = await pool.request().query(`
        SELECT
          FlightId,
          FlightNumber,
          OperatingDate,
          Direction,
          AirlineCode,
          OriginAirport,
          DestinationAirport,
          FlightStatus,
          ScheduledArrivalUtc,
          EstimatedArrivalUtc,
          LandedAtUtc,
          InBlockAtUtc,
          CreatedAtUtc
        FROM dbo.Flights
        ORDER BY OperatingDate DESC, FlightNumber ASC;
      `);

      sendJson(context, 200, {
        ok: true,
        count: result.recordset.length,
        flights: result.recordset
      });

      return;
    }

    /* =========================
       POST /api/flights
       ========================= */

    const body = req.body || {};

    const flightNumber = clean(body.flightNumber);
    const direction = clean(body.direction);
    const airlineCode = clean(body.airlineCode);
    const originAirport = clean(body.originAirport);
    const destinationAirport = clean(body.destinationAirport);
    const operatingDate = String(body.operatingDate || '').trim();

    if (!flightNumber) {
      sendJson(context, 400, {
        ok: false,
        error: 'flightNumber is required'
      });
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(operatingDate)) {
      sendJson(context, 400, {
        ok: false,
        error: 'operatingDate must be YYYY-MM-DD'
      });
      return;
    }

    if (!['IMPORT', 'EXPORT'].includes(direction)) {
      sendJson(context, 400, {
        ok: false,
        error: 'direction must be IMPORT or EXPORT'
      });
      return;
    }

    const existing = await pool.request()
      .input('FlightNumber', sql.NVarChar(12), flightNumber)
      .input('OperatingDate', sql.Date, operatingDate)
      .input('Direction', sql.VarChar(6), direction)
      .query(`
        SELECT FlightId
        FROM dbo.Flights
        WHERE FlightNumber = @FlightNumber
          AND OperatingDate = @OperatingDate
          AND Direction = @Direction;
      `);

    if (existing.recordset.length > 0) {
      sendJson(context, 409, {
        ok: false,
        error: 'Flight already exists',
        flightId: existing.recordset[0].FlightId
      });
      return;
    }

    const result = await pool.request()
      .input('FlightNumber', sql.NVarChar(12), flightNumber)
      .input('OperatingDate', sql.Date, operatingDate)
      .input('Direction', sql.VarChar(6), direction)
      .input('AirlineCode', sql.NVarChar(3), airlineCode)
      .input('OriginAirport', sql.NVarChar(4), originAirport)
      .input('DestinationAirport', sql.NVarChar(4), destinationAirport)
      .input('SourceType', sql.NVarChar(50), 'API_TEST')
      .input('CreatedByDisplayName', sql.NVarChar(150), 'Prototype Test')
      .query(`
        INSERT INTO dbo.Flights
        (
          FlightNumber,
          OperatingDate,
          Direction,
          AirlineCode,
          OriginAirport,
          DestinationAirport,
          SourceType,
          CreatedByDisplayName
        )
        OUTPUT
          INSERTED.FlightId,
          INSERTED.FlightNumber,
          INSERTED.OperatingDate,
          INSERTED.Direction,
          INSERTED.CreatedAtUtc
        VALUES
        (
          @FlightNumber,
          @OperatingDate,
          @Direction,
          @AirlineCode,
          @OriginAirport,
          @DestinationAirport,
          @SourceType,
          @CreatedByDisplayName
        );
      `);

    sendJson(context, 201, {
      ok: true,
      flight: result.recordset[0]
    });

  } catch (err) {
    context.log.error('Flights API failed', err);

    sendJson(context, 500, {
      ok: false,
      error: 'Flights API failed',
      detail: err.message
    });

  } finally {
    try {
      await pool?.close();
    } catch {}
  }
};