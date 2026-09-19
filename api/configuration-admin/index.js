'use strict';

const sql = require('mssql');
const { loadCachedConfiguration, ConfigurationStoreError } = require('../shared/configuration-store');

function getHeader(req, name) {
  const headers = req?.headers || {};
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || null;
}
function authenticatedActor(req) {
  try {
    const raw = getHeader(req, 'x-ms-client-principal');
    if (!raw) return null;
    const principal = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    const roles = Array.isArray(principal.userRoles) ? principal.userRoles : [];
    if (!roles.includes('authenticated')) return null;
    return { reference: String(principal.userId || ''), displayName: String(principal.userDetails || 'Authenticated user') };
  } catch { return null; }
}
function sendJson(context, status, body) {
  context.res = { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

module.exports = async function adminConfig(context, req) {
  let pool;
  try {
    if (req.method !== 'GET') { sendJson(context, 405, { ok: false, error: 'Admin configuration is read-only in Phase A' }); return; }
    const actor = authenticatedActor(req);
    if (!actor) { sendJson(context, 401, { ok: false, error: 'Microsoft Entra sign-in is required' }); return; }
    const connectionString = process.env.DATABASE_CONNECTION_STRING;
    if (!connectionString) { sendJson(context, 503, { ok: false, error: 'DATABASE_CONNECTION_STRING is not configured' }); return; }
    pool = await new sql.ConnectionPool(connectionString).connect();
    const snapshot = await loadCachedConfiguration(pool);
    sendJson(context, 200, {
      ok: true,
      mode: 'READ_ONLY_PHASE_A',
      authorization: {
        enforcement: 'LEGACY_OPERATIONAL_AUTHORIZATION',
        adminMutationsEnabled: false,
        reason: 'Capability assignments must be bootstrapped and verified before server-side enforcement is enabled.'
      },
      actor: { displayName: actor.displayName },
      configuration: snapshot
    });
  } catch (error) {
    if (error instanceof ConfigurationStoreError) {
      sendJson(context, 503, { ok: false, code: error.code, error: error.message, ...error.details, mode: 'SCHEMA_PENDING' });
      return;
    }
    context.log.error('Admin configuration read failed', error);
    sendJson(context, 500, { ok: false, error: 'Admin configuration could not be loaded' });
  } finally { try { await pool?.close(); } catch {} }
};
