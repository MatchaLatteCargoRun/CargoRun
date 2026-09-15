const sql = require('mssql');

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
  try {
    const cs = process.env.DATABASE_CONNECTION_STRING;
    if (!cs) { sendJson(context,503,{ok:false,error:'DATABASE_CONNECTION_STRING is not configured'}); return; }
    const actor = getActor(req);
    if (!actor) { sendJson(context,401,{ok:false,error:'Microsoft Entra sign-in is required'}); return; }
    const uldId = String(req.body?.uldId || '').trim();
    if (!/^\d+$/.test(uldId)) { sendJson(context,400,{ok:false,error:'uldId is required'}); return; }
    pool = await new sql.ConnectionPool(cs).connect();

    const update = await pool.request()
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
      sendJson(context,200,{ok:true,alreadyScanned:false,uld:update.recordset[0]});
      return;
    }

    const existing = await pool.request().input('UldId2',sql.BigInt,uldId).query(`
      SELECT UldId,UldNumber,MailScannedAtUtc,MailScannedByDisplayName,MailScannedByReference
      FROM dbo.ULDs WHERE UldId=@UldId2;
    `);
    if (!existing.recordset.length) { sendJson(context,404,{ok:false,error:'ULD not found'}); return; }
    sendJson(context,200,{ok:true,alreadyScanned:!!existing.recordset[0].MailScannedAtUtc,uld:existing.recordset[0]});
  } catch (err) {
    context.log.error('Mail scan API failed', err);
    sendJson(context,500,{ok:false,error:'Mail scan API failed',detail:err.message});
  } finally {
    try { await pool?.close(); } catch {}
  }
};
