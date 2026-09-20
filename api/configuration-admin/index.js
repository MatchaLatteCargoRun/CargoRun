'use strict';

const sql = require('mssql');
const { ConfigurationError } = require('../shared/configuration');
const { loadCachedConfiguration, ConfigurationStoreError, invalidateConfigurationCache } = require('../shared/configuration-store');
const {
  ConfigurationMutationError,
  normaliseOperation,
  resolveActorCapabilities,
  executeConfigurationMutation,
  buildConfigurationPreview
} = require('../shared/configuration-mutations');

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
    const reference = String(principal.userId || '').trim();
    if (!roles.includes('authenticated') || !reference) return null;
    return { reference, displayName: String(principal.userDetails || 'Authenticated user').trim() || 'Authenticated user' };
  } catch { return null; }
}
function sendJson(context, status, body) {
  context.res = { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
function operationFromRequest(req) {
  return normaliseOperation(req?.params?.operation || req?.query?.operation || '');
}

async function loadAccessMetadata(pool, sqlModule, actorReference, capabilities) {
  if (!capabilities.includes('MANAGE_USERS')) return null;
  const freshCapabilities = await resolveActorCapabilities(pool, sqlModule, actorReference, null);
  if (!freshCapabilities.includes('MANAGE_USERS')) return null;
  const result = await pool.request().query(`
    SELECT RoleId,RoleCode,DisplayName,Description,IsEnabled FROM dbo.CargoRunRoles ORDER BY RoleCode;
    SELECT CapabilityId,CapabilityCode,DisplayName,Description,IsEnabled FROM dbo.CargoRunCapabilities ORDER BY CapabilityCode;
    WITH Decisions AS (
      SELECT assignment.UserRoleVersionId,assignment.ActorReference,assignment.ActorDisplayName,
        role.RoleCode,station.StationCode,assignment.AssignmentAction,assignment.EffectiveFrom,assignment.EffectiveTo,
        ROW_NUMBER() OVER (
          PARTITION BY assignment.ActorReference,assignment.RoleId,assignment.StationScopeKey
          ORDER BY assignment.EffectiveFrom DESC,assignment.UserRoleVersionId DESC
        ) AS DecisionRank
      FROM dbo.CargoRunUserRoleAssignments assignment
      JOIN dbo.CargoRunRoles role ON role.RoleId=assignment.RoleId
      LEFT JOIN dbo.CargoRunStations station ON station.StationId=assignment.StationId
      WHERE assignment.EffectiveFrom<=CONVERT(date,SYSUTCDATETIME())
        AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>CONVERT(date,SYSUTCDATETIME()))
    )
    SELECT UserRoleVersionId,ActorReference,ActorDisplayName,RoleCode,StationCode,AssignmentAction,EffectiveFrom,EffectiveTo
    FROM Decisions WHERE DecisionRank=1 ORDER BY ActorDisplayName,ActorReference,RoleCode,StationCode;
  `);
  const sets = result.recordsets || [];
  return { roles: sets[0] || [], capabilities: sets[1] || [], assignments: sets[2] || [] };
}

async function loadAudit(pool, sqlModule, actorReference, capabilities) {
  if (!capabilities.includes('VIEW_ADMIN_AUDIT')) return null;
  const freshCapabilities = await resolveActorCapabilities(pool, sqlModule, actorReference, null);
  if (!freshCapabilities.includes('VIEW_ADMIN_AUDIT')) return null;
  const result = await pool.request().query(`
    SELECT TOP (500) ConfigurationAuditId,Operation,EntityType,EntityId,EffectiveFrom,
      OldValueJson,NewValueJson,ActorReference,ActorDisplayName,OccurredAtUtc,CorrelationId
    FROM dbo.CargoRunConfigurationAudit
    ORDER BY OccurredAtUtc DESC,ConfigurationAuditId DESC;
  `);
  return result.recordset || [];
}

module.exports = async function configurationControl(context, req) {
  let pool;
  try {
    const actor = authenticatedActor(req);
    if (!actor) { sendJson(context, 401, { ok: false, error: 'Microsoft Entra sign-in is required' }); return; }
    const method = String(req.method || 'GET').toUpperCase();
    const operation = operationFromRequest(req);
    if (!['GET', 'POST'].includes(method)) { sendJson(context, 405, { ok: false, error: 'Only GET and explicit POST operations are supported' }); return; }
    if (method === 'GET' && operation) { sendJson(context, 404, { ok: false, error: 'Unknown configuration read operation' }); return; }
    if (method === 'POST' && !operation) { sendJson(context, 404, { ok: false, error: 'An explicit configuration operation is required' }); return; }

    const connectionString = process.env.DATABASE_CONNECTION_STRING;
    if (!connectionString) { sendJson(context, 503, { ok: false, error: 'DATABASE_CONNECTION_STRING is not configured' }); return; }
    pool = await new sql.ConnectionPool(connectionString).connect();

    if (method === 'GET') {
      const [snapshot, capabilities] = await Promise.all([
        loadCachedConfiguration(pool),
        resolveActorCapabilities(pool, sql, actor.reference, null)
      ]);
      const [access, audit] = await Promise.all([
        loadAccessMetadata(pool, sql, actor.reference, capabilities),
        loadAudit(pool, sql, actor.reference, capabilities)
      ]);
      sendJson(context, 200, {
        ok: true,
        mode: 'AUTHORIZED_ADMIN_CONFIGURATION',
        authorization: {
          enforcement: 'LEGACY_OPERATIONAL_AUTHORIZATION',
          adminMutationAuthorization: 'AUTHORIZED_BY_ADMIN_CAPABILITY',
          adminMutationsEnabled: capabilities.some(capability => ['EDIT_AIRLINE_RULES', 'EDIT_SHC_RULES', 'EDIT_SLA_RULES'].includes(capability)),
          capabilities
        },
        actor: { reference: actor.reference, displayName: actor.displayName },
        configuration: snapshot,
        access,
        audit
      });
      return;
    }

    if (operation === 'preview') {
      const snapshot = await loadCachedConfiguration(pool);
      sendJson(context, 200, { ok: true, preview: buildConfigurationPreview(snapshot, req.body || {}) });
      return;
    }

    const result = await executeConfigurationMutation(pool, sql, operation, req.body || {}, actor);
    invalidateConfigurationCache();
    sendJson(context, 201, {
      ok: true,
      mode: 'AUTHORIZED_ADMIN_CONFIGURATION',
      authorization: { enforcement: 'LEGACY_OPERATIONAL_AUTHORIZATION', adminMutationAuthorization: 'AUTHORIZED_BY_ADMIN_CAPABILITY' },
      ...result
    });
  } catch (error) {
    if (error instanceof ConfigurationStoreError) {
      sendJson(context, 503, { ok: false, code: error.code, error: error.message, ...error.details, mode: 'SCHEMA_PENDING' });
      return;
    }
    if (error instanceof ConfigurationMutationError || error instanceof ConfigurationError) {
      sendJson(context, Number(error.status) || 400, { ok: false, code: error.code, error: error.message, ...(error.details || {}) });
      return;
    }
    context.log.error('Admin configuration request failed', error);
    sendJson(context, 500, { ok: false, error: 'Admin configuration request failed' });
  } finally { try { await pool?.close(); } catch {} }
};

module.exports.authenticatedActor = authenticatedActor;
module.exports.operationFromRequest = operationFromRequest;
