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
        status: 'unavailable'
      });
      return;
    }

    pool = await sql.connect(connectionString);

    await pool.request().query('SELECT 1 AS DatabaseReachable;');

    sendJson(context, 200, {
      ok: true,
      status: 'healthy'
    });

  } catch (err) {
    context.log.error('Database health check failed', err);

    sendJson(context, 503, {
      ok: false,
      status: 'unhealthy'
    });

  } finally {
    try {
      await pool?.close();
    } catch {}
  }
};
