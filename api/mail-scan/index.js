const sql = require('mssql');
const { lockAuthoritativeFlight, requireActiveFlight, FlightLifecycleConflict } = require('../shared/flight');
const { insertAuditEvent } = require('../shared/audit');
const {
  authenticatedActor,
  requireOperationalStations,
  operationalEntityUnavailable,
  requireOperationalEntityCapability,
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
  } catch { return null; }
}
function getActor(req) {
  const p = getClientPrincipal(req);
  if (!p) return null;
  const roles = Array.isArray(p.userRoles) ? p.userRoles : [];
  if (!roles.includes('authenticated')) return null;
  return {
    displayName: String(p.userDetails || 'Authenticated user').slice(0, 150),
    reference: String(p.userId || '').slice(0, 150)
  };
}
function sendJson(context, status, body) {
  context.res = { status, headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}, body: JSON.stringify(body) };
}

module.exports = async function(context, req) {
  let pool;
  let transaction;
  try {
    const cs = process.env.DATABASE_CONNECTION_STRING;
    if (!cs) { sendJson(context,503,{ok:false,error:'Service configuration is unavailable'}); return; }
    const actor = authenticatedActor(req);
    const uldId = String(req.body?.uldId || '').trim();
    if (!/^\d+$/.test(uldId)) { sendJson(context,400,{ok:false,error:'uldId is required'}); return; }
    pool = await new sql.ConnectionPool(cs).connect();
    transaction = new sql.Transaction(pool);
    await transaction.begin();

    await requireOperationalStations(transaction, sql, actor, 'SCAN_ULD');

    const selected = await new sql.Request(transaction)
      .input('AuthorizationUldId', sql.BigInt, uldId)
      .query(`SELECT u.UldId,u.FlightId,f.StationId,f.Direction,f.OriginAirport,f.DestinationAirport,
          f.FlightNumber,CONVERT(char(10),f.OperatingDate,23) AS OperatingDateIso
        FROM dbo.ULDs u
        INNER JOIN dbo.Flights f ON f.FlightId=u.FlightId
        WHERE u.UldId=@AuthorizationUldId;`);
    await requireOperationalEntityCapability(
      transaction,
      sql,
      actor,
      selected.recordset[0] || null,
      'SCAN_ULD'
    );

    const flight = await lockAuthoritativeFlight(transaction, sql, selected.recordset[0],
      locked => requireOperationalEntityCapability(transaction, sql, actor, locked, 'SCAN_ULD'));
    requireActiveFlight(flight);
    const lockedUld = await new sql.Request(transaction)
      .input('LockedUldId', sql.BigInt, uldId)
      .input('LockedUldFlightId', sql.BigInt, flight.FlightId)
      .query(`SELECT UldId,FlightId,UldNumber,MailScannedAtUtc,MailScannedByDisplayName,MailScannedByReference
        FROM dbo.ULDs WITH (UPDLOCK,HOLDLOCK)
        WHERE UldId=@LockedUldId AND FlightId=@LockedUldFlightId;`);
    if (lockedUld.recordset.length !== 1) {
      throw new FlightLifecycleConflict('ULD_FLIGHT_CHANGED', 'ULD flight ownership changed; refresh and review again');
    }

    const update = await new sql.Request(transaction)
      .input('UldId', sql.BigInt, uldId)
      .input('DisplayName', sql.NVarChar(150), actor.displayName)
      .input('Reference', sql.NVarChar(150), actor.reference)
      .query(`
        UPDATE dbo.ULDs
        SET MailScannedAtUtc = SYSUTCDATETIME(),
            MailScannedByDisplayName = @DisplayName,
            MailScannedByReference = @Reference
        OUTPUT INSERTED.UldId, INSERTED.UldNumber, INSERTED.MailScannedAtUtc,
               INSERTED.MailScannedByDisplayName, INSERTED.MailScannedByReference
        WHERE UldId = @UldId AND MailScannedAtUtc IS NULL;
      `);

    if (update.recordset.length) {
      const current = await new sql.Request(transaction)
        .input('AuditUldId', sql.BigInt, uldId)
        .query(`
          SELECT u.UldId, u.UldNumber, u.MailScannedAtUtc,
                 u.MailScannedByDisplayName, u.MailScannedByReference,
                 f.FlightId, f.FlightNumber
          FROM dbo.ULDs u
          INNER JOIN dbo.Flights f ON f.FlightId = u.FlightId
          WHERE u.UldId = @AuditUldId;
        `);
      const scanned = current.recordset[0] || update.recordset[0];
      await insertAuditEvent(transaction, sql, {
        type: 'Mail',
        action: 'Bulk mail scanned',
        actorDisplayName: actor.displayName,
        actorReference: actor.reference,
        entityType: 'ULD',
        entityId: scanned.UldId,
        flightId: scanned.FlightId,
        flightNumber: scanned.FlightNumber,
        uldId: scanned.UldId,
        uldNumber: scanned.UldNumber,
        detail: '3-hour mail SLA scan confirmed'
      });
      await transaction.commit();
      transaction = null;
      sendJson(context,200,{ok:true,alreadyScanned:false,uld:update.recordset[0]});
      return;
    }

    await transaction.rollback();
    transaction = null;

    const existing = lockedUld;
    if (!existing.recordset.length) throw operationalEntityUnavailable();
    sendJson(context,200,{ok:true,alreadyScanned:!!existing.recordset[0].MailScannedAtUtc,uld:existing.recordset[0]});
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch {} }
    if (sendOperationalAuthorizationError(context, err, sendJson)) return;
    if (err instanceof FlightLifecycleConflict) { sendJson(context,409,{ok:false,code:err.code,error:err.message}); return; }
    context.log.error('Mail scan API failed', err);
    sendJson(context,500,{ok:false,error:'Mail scan API failed'});
  } finally {
    try { await pool?.close(); } catch {}
  }
};
