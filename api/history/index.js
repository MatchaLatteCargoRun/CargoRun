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
    const json = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function getActor(req) {
  const principal = getClientPrincipal(req);
  if (!principal) return null;
  const roles = Array.isArray(principal.userRoles) ? principal.userRoles : [];
  if (!roles.includes('authenticated')) return null;
  return {
    displayName: String(principal.userDetails || 'Authenticated user').slice(0, 150),
    reference: String(principal.userId || '').slice(0, 150),
    roles,
    identityProvider: principal.identityProvider || 'aad'
  };
}
function sendJson(context, status, body, headers = {}) {
  context.res = {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    },
    body: JSON.stringify(body)
  };
}
function clean(value, max = 500) { if (value === null || value === undefined) return null; const s = String(value).trim(); return s ? s.slice(0, max) : null; }
function pick(columns, candidates) { const map = new Map(columns.map(c => [String(c.COLUMN_NAME).toLowerCase(), c.COLUMN_NAME])); for (const x of candidates) { const hit = map.get(String(x).toLowerCase()); if (hit) return hit; } return null; }
function q(name) { return `[${String(name).replace(/]/g, ']]')}]`; }
async function columnsFor(request, tableName) {
  const r = await request.input('TableName', sql.NVarChar(128), tableName).query(`
    SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, DATA_TYPE,
      COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA)+'.'+QUOTENAME(TABLE_NAME)), COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@TableName;
  `);
  return r.recordset || [];
}
function normalize(row, columns) {
  const get = names => { const c = pick(columns, names); return c ? row[c] : null; };
  let details = {};
  const rawJson = get(['DetailsJson', 'DetailJson', 'MetadataJson']);
  if (rawJson) { try { details = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson; } catch {} }
  return {
    id: String(get(['AuditEventId', 'EventId', 'Id']) ?? ''),
    ts: get(['OccurredAtUtc', 'OccurredAt', 'CreatedAtUtc']),
    type: get(['EventType', 'Type']) || details.type || 'Activity',
    action: get(['Action', 'EventAction']) || details.action || 'Activity',
    user: get(['ActorDisplayName', 'UserDisplayName', 'ActorName']) || details.user || '',
    actorReference: String(get(['ActorObjectId', 'ActorId', 'ActorReference']) || details.actorReference || ''),
    entityType: get(['EntityType']) || details.entityType || '',
    entityId: String(get(['EntityId']) || details.entityId || ''),
    flight: get(['FlightNumber', 'Flight']) || details.flight || '',
    uld: get(['UldNumber', 'ULDNumber', 'Uld']) || details.uld || '',
    from: get(['FromStatus']) || details.from || '',
    to: get(['ToStatus']) || details.to || '',
    detail: get(['Detail', 'Description']) || details.detail || ''
  };
}

module.exports = async function(context, req) {
  let pool;
  try {
    // POST remains registered only so callers receive a deterministic method
    // response. Authoritative events are written by operational transactions.
    if (String(req?.method || '').toUpperCase() !== 'GET') {
      sendJson(context, 405, { ok: false, error: 'Method not allowed' }, { Allow: 'GET' });
      return;
    }
    const connectionString = process.env.DATABASE_CONNECTION_STRING;
    if (!connectionString) { sendJson(context,503,{ok:false,error:'DATABASE_CONNECTION_STRING is not configured'}); return; }
    const actor = getActor(req);
    if (!actor) { sendJson(context,401,{ok:false,error:'Microsoft Entra sign-in is required'}); return; }
    pool = await new sql.ConnectionPool(connectionString).connect();
    const columns = await columnsFor(pool.request(),'AuditEvents');
    if (!columns.length) { sendJson(context,500,{ok:false,error:'dbo.AuditEvents table was not found'}); return; }
    const idCol = pick(columns,['AuditEventId','EventId','Id']);
    const timeCol = pick(columns,['OccurredAtUtc','OccurredAt','CreatedAtUtc']);

    const order = timeCol ? `${q(timeCol)} DESC` : idCol ? `${q(idCol)} DESC` : '(SELECT NULL)';
    const requestedLimit = Math.max(1, Math.min(5000, Number(req.query?.limit || 3000) || 3000));
    const startUtc = clean(req.query?.startUtc, 50);
    const endUtc = clean(req.query?.endUtc, 50);
    const request = pool.request().input('Limit', sql.Int, requestedLimit);
    let where = '';
    if (timeCol && startUtc && endUtc) {
      request.input('StartUtc', sql.DateTime2, new Date(startUtc)).input('EndUtc', sql.DateTime2, new Date(endUtc));
      where = `WHERE ${q(timeCol)} >= @StartUtc AND ${q(timeCol)} < @EndUtc`;
    }
    const r = await request.query(`SELECT TOP (@Limit) * FROM dbo.AuditEvents ${where} ORDER BY ${order};`);
    sendJson(context,200,{ok:true,count:r.recordset.length,events:r.recordset.map(x=>normalize(x,columns))});
  } catch(err) {
    context.log.error('History API failed',err); sendJson(context,500,{ok:false,error:'History API failed',detail:err.message});
  } finally { try{await pool?.close();}catch{} }
};
