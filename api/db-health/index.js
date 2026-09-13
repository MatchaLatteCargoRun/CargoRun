const sql = require('mssql');

function sendJson(context, status, body) {
  context.res = {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

module.exports = async function (context) {
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

    pool = await sql.connect(connectionString);

    const result = await pool.request().query(`
      SELECT
        DB_NAME() AS DatabaseName,
        COUNT(*) AS FlightCount
      FROM dbo.Flights;
    `);

    sendJson(context, 200, {
      ok: true,
      database: result.recordset[0].DatabaseName,
      flightCount: result.recordset[0].FlightCount,
      serverTimeUtc: new Date().toISOString()
    });

  } catch (err) {
    context.log.error('Database health check failed', err);

    sendJson(context, 500, {
      ok: false,
      error: 'Database connection failed',
      detail: err.message
    });

  } finally {
    try {
      await pool?.close();
    } catch {}
  }
};