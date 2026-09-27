'use strict';

const sql = require('mssql');
const {
  authenticatedActor,
  resolveActorAccess,
  sendOperationalAuthorizationError
} = require('../shared/operational-authorization');

function sendJson(context, status, body) {
  context.res = {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

module.exports = async function session(context, req) {
  let pool;
  try {
    if (String(req?.method || 'GET').toUpperCase() !== 'GET') {
      sendJson(context, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    const actor = authenticatedActor(req);
    const connectionString = process.env.DATABASE_CONNECTION_STRING;
    if (!connectionString) {
      sendJson(context, 503, {
        ok: false,
        code: 'AUTHORIZATION_CONFIGURATION_UNAVAILABLE',
        error: 'Operational authorization could not be resolved'
      });
      return;
    }
    pool = await new sql.ConnectionPool(connectionString).connect();
    const access = await resolveActorAccess(pool, sql, actor);
    sendJson(context, 200, {
      ok: true,
      authenticated: true,
      provisioned: access.provisioned,
      userId: actor.reference,
      displayName: actor.displayName,
      stations: access.stations,
      stationMetadata: access.stationMetadata,
      capabilities: access.capabilities
    });
  } catch (error) {
    if (sendOperationalAuthorizationError(context, error, sendJson)) return;
    context.log.error('CargoRun session authorization failed', error);
    sendJson(context, 503, {
      ok: false,
      code: 'AUTHORIZATION_CONFIGURATION_UNAVAILABLE',
      error: 'Operational authorization could not be resolved'
    });
  } finally {
    try { await pool?.close(); } catch {}
  }
};
