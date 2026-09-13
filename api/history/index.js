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
function sendJson(context, status, body) {
  context.res = { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
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
    const connectionString = process.env.DATABASE_CONNECTION_STRING;
    if (!connectionString) { sendJson(context,503,{ok:false,error:'DATABASE_CONNECTION_STRING is not configured'}); return; }
    const actor = getActor(req);
    if (!actor) { sendJson(context,401,{ok:false,error:'Microsoft Entra sign-in is required'}); return; }
    pool = await new sql.ConnectionPool(connectionString).connect();
    const columns = await columnsFor(pool.request(),'AuditEvents');
    if (!columns.length) { sendJson(context,500,{ok:false,error:'dbo.AuditEvents table was not found'}); return; }
    const idCol = pick(columns,['AuditEventId','EventId','Id']);
    const timeCol = pick(columns,['OccurredAtUtc','OccurredAt','CreatedAtUtc']);

    if (req.method === 'GET') {
      const order = timeCol ? `${q(timeCol)} DESC` : idCol ? `${q(idCol)} DESC` : '(SELECT NULL)';
      const r = await pool.request().query(`SELECT TOP 500 * FROM dbo.AuditEvents ORDER BY ${order};`);
      sendJson(context,200,{ok:true,count:r.recordset.length,events:r.recordset.map(x=>normalize(x,columns))});
      return;
    }

    const b = req.body || {};
    const payload = {
      type: clean(b.type,50) || 'Activity', action: clean(b.action,150) || 'Activity', user: actor.displayName,
      actorReference: actor.reference, flight: clean(b.flight,20), uld: clean(b.uld,30), from: clean(b.from,40), to: clean(b.to,40),
      detail: clean(b.detail,1000), entityType: clean(b.entityType,50), entityId: clean(b.entityId,100), details: b.details || null
    };
    const detailsJson = JSON.stringify({ type:payload.type, action:payload.action, user:payload.user, flight:payload.flight, uld:payload.uld, from:payload.from, to:payload.to, detail:payload.detail, ...(payload.details||{}) });
    const request = pool.request()
      .input('EventType',sql.NVarChar(50),payload.type).input('Action',sql.NVarChar(150),payload.action)
      .input('ActorDisplayName',sql.NVarChar(150),payload.user).input('ActorReference',sql.NVarChar(150),payload.actorReference)
      .input('FlightNumber',sql.NVarChar(20),payload.flight).input('UldNumber',sql.NVarChar(30),payload.uld)
      .input('FromStatus',sql.NVarChar(40),payload.from).input('ToStatus',sql.NVarChar(40),payload.to)
      .input('Detail',sql.NVarChar(1000),payload.detail).input('EntityType',sql.NVarChar(50),payload.entityType)
      .input('EntityId',sql.NVarChar(100),payload.entityId).input('DetailsJson',sql.NVarChar(sql.MAX),detailsJson);
    const names=[]; const values=[];
    const add=(cands,expr)=>{const c=pick(columns,cands); if(c&&!names.includes(c)){names.push(c);values.push(expr);}};
    add(['EventType','Type'],'@EventType'); add(['Action','EventAction'],'@Action'); add(['EntityType'],'@EntityType'); add(['EntityId'],'@EntityId');
    add(['FlightNumber','Flight'],'@FlightNumber'); add(['UldNumber','ULDNumber','Uld'],'@UldNumber'); add(['FromStatus'],'@FromStatus'); add(['ToStatus'],'@ToStatus');
    add(['OccurredAtUtc','OccurredAt','CreatedAtUtc'],'SYSUTCDATETIME()'); add(['ActorDisplayName','UserDisplayName','ActorName'],'@ActorDisplayName');
    add(['ActorObjectId','ActorId','ActorReference'],'@ActorReference'); add(['Detail','Description'],'@Detail'); add(['DetailsJson','DetailJson','MetadataJson'],'@DetailsJson');
    const mapped=new Set(names.map(x=>x.toLowerCase()));
    const requiredUnknown=columns.filter(c=>c.IS_NULLABLE==='NO'&&!c.COLUMN_DEFAULT&&Number(c.IS_IDENTITY)!==1&&!mapped.has(String(c.COLUMN_NAME).toLowerCase()));
    if(requiredUnknown.length){sendJson(context,500,{ok:false,error:`AuditEvents schema has unmapped required columns: ${requiredUnknown.map(c=>c.COLUMN_NAME).join(', ')}`});return;}
    const r=await request.query(`INSERT INTO dbo.AuditEvents (${names.map(q).join(',')}) OUTPUT INSERTED.* VALUES (${values.join(',')});`);
    sendJson(context,201,{ok:true,event:normalize(r.recordset[0],columns)});
  } catch(err) {
    context.log.error('History API failed',err); sendJson(context,500,{ok:false,error:'History API failed',detail:err.message});
  } finally { try{await pool?.close();}catch{} }
};
