const sql = require('mssql');
const crypto = require('crypto');
const { insertAuditEvent } = require('../shared/audit');
const { acquireFlightIdentityLock } = require('../shared/flight');
const { buildCompletionSnapshot, CompletionSnapshotError } = require('../shared/completion-snapshot');
const {
  applyFlightStatementEvidence,
  loadFlightStatementEvidence
} = require('../shared/flight-statement-evidence');

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
  const reference = String(principal.userId || '').trim().slice(0, 150);
  if (!roles.includes('authenticated') || !reference) return null;
  return {
    displayName: String(principal.userDetails || 'Authenticated user').slice(0, 150),
    reference,
    roles,
    identityProvider: principal.identityProvider || 'aad'
  };
}
function sendJson(context,status,body){context.res={status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},body:JSON.stringify(body)}}
function clean(v,max=150){if(v===null||v===undefined)return null;const s=String(v).trim();return s?s.slice(0,max):null}
function pick(columns,candidates){const m=new Map(columns.map(c=>[String(c.COLUMN_NAME).toLowerCase(),c.COLUMN_NAME]));for(const x of candidates){const h=m.get(String(x).toLowerCase());if(h)return h}return null}
function q(n){return `[${String(n).replace(/]/g,']]')}]`}
async function columnsFor(request,tableName){const r=await request.input('TableName',sql.NVarChar(128),tableName).query(`SELECT COLUMN_NAME,IS_NULLABLE,COLUMN_DEFAULT,DATA_TYPE,COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA)+'.'+QUOTENAME(TABLE_NAME)),COLUMN_NAME,'IsIdentity') AS IS_IDENTITY FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@TableName;`);return r.recordset||[]}
function normalize(row,columns,flightNumber){const get=names=>{const c=pick(columns,names);return c?row[c]:null};let snapshot={};const raw=get(['SnapshotJson','Snapshot','DetailsJson']);if(raw){try{snapshot=typeof raw==='string'?JSON.parse(raw):raw}catch{}}return{id:String(get(['CompletionId','ExportCompletionRecordId','CompletionRecordId','Id'])??get(['VerificationId'])??''),flightId:get(['FlightId']),flight:flightNumber||snapshot.flight||'',flightDate:snapshot.flightDate||'',finalizedBy:get(['FinalisedByDisplayName','FinalizedByDisplayName','FinalisedByName','FinalizedByName'])||snapshot.finalizedBy||'',finalizedById:get(['FinalisedByObjectId','FinalizedByObjectId','FinalisedById','FinalizedById'])||snapshot.finalizedById||'',finalizedAt:get(['FinalisedAtUtc','FinalizedAtUtc','FinalisedAt','FinalizedAt'])||snapshot.finalizedAt||null,verificationId:String(get(['VerificationId'])??snapshot.verificationId??''),recordHash:get(['RecordHash','Hash'])||'',ulds:Array.isArray(snapshot.ulds)?snapshot.ulds:[]}}
module.exports=async function(context,req){let pool,tx;try{const cs=process.env.DATABASE_CONNECTION_STRING;if(!cs){sendJson(context,503,{ok:false,error:'DATABASE_CONNECTION_STRING is not configured'});return}const identity=getActor(req);if(!identity){sendJson(context,401,{ok:false,error:'Microsoft Entra sign-in is required'});return}pool=await new sql.ConnectionPool(cs).connect();const columns=await columnsFor(pool.request(),'ExportCompletionRecords');if(!columns.length){sendJson(context,500,{ok:false,error:'dbo.ExportCompletionRecords table was not found'});return}
if(req.method==='GET'){const flightIdCol=pick(columns,['FlightId']);const timeCol=pick(columns,['FinalisedAtUtc','FinalizedAtUtc','FinalisedAt','FinalizedAt']);const order=timeCol?`e.${q(timeCol)} DESC`:'e.'+q(pick(columns,['CompletionId','ExportCompletionRecordId','CompletionRecordId','Id'])||columns[0].COLUMN_NAME)+' DESC';const join=flightIdCol?`LEFT JOIN dbo.Flights f ON f.FlightId=e.${q(flightIdCol)}`:'';const selectFlight=flightIdCol?', f.FlightNumber AS __FlightNumber':'';const r=await pool.request().query(`SELECT e.*${selectFlight} FROM dbo.ExportCompletionRecords e ${join} ORDER BY ${order};`);sendJson(context,200,{ok:true,count:r.recordset.length,records:r.recordset.map(x=>normalize(x,columns,x.__FlightNumber))});return}
const b=req.body||{};const flightId=String(b.flightId||'').trim();if(!/^\d+$/.test(flightId)){sendJson(context,400,{ok:false,error:'flightId is required'});return}const actor=identity.displayName;const actorId=identity.reference;tx=new sql.Transaction(pool);await tx.begin();const f=await new sql.Request(tx).input('FlightId',sql.BigInt,flightId).query(`SELECT FlightId,FlightNumber,OperatingDate,CONVERT(char(10),OperatingDate,23) AS OperatingDateIso,Direction,AirlineCode,OriginAirport,DestinationAirport,FlightStatus FROM dbo.Flights WHERE FlightId=@FlightId;`);if(!f.recordset.length){await tx.rollback();tx=null;sendJson(context,404,{ok:false,error:'Flight not found'});return}const flight=f.recordset[0];if(String(flight.Direction||'').toUpperCase()!=='EXPORT'){await tx.rollback();tx=null;sendJson(context,400,{ok:false,error:'Only export flights can be finalised'});return}await acquireFlightIdentityLock(tx,sql,flight.OperatingDateIso,flight.FlightNumber);const pending=await new sql.Request(tx).input('FlightId2',sql.BigInt,flightId).query(`SELECT COUNT(*) AS Pending FROM dbo.ULDs u LEFT JOIN dbo.ExportManifestFinals mf ON mf.FlightId=u.FlightId LEFT JOIN dbo.ExportManifestFinalUlds m ON m.FinalManifestId=mf.FinalManifestId AND m.FlightId=u.FlightId AND m.UldId=u.UldId WHERE u.FlightId=@FlightId2 AND (mf.FinalManifestId IS NULL OR m.UldId IS NOT NULL) AND UPPER(REPLACE(u.CurrentStatus,' ','_'))<>'AT_AIRCRAFT';`);if(Number(pending.recordset[0].Pending)>0){await tx.rollback();tx=null;sendJson(context,409,{ok:false,error:'All expected export ULDs must be AT_AIRCRAFT before finalising'});return}const flightIdCol=pick(columns,['FlightId']);if(flightIdCol){const existing=await new sql.Request(tx).input('FlightId3',sql.BigInt,flightId).query(`SELECT TOP 1 * FROM dbo.ExportCompletionRecords WHERE ${q(flightIdCol)}=@FlightId3;`);if(existing.recordset.length){await tx.rollback();tx=null;sendJson(context,409,{ok:false,error:'Export completion record already exists',record:normalize(existing.recordset[0],columns,flight.FlightNumber)});return}}
const authored=await buildCompletionSnapshot(tx,sql,{direction:'EXPORT',flightId,flight,actor:identity});const statementEvidence=await loadFlightStatementEvidence(tx,sql,flightId);const snapshot=applyFlightStatementEvidence(authored.snapshot,statementEvidence);const snapshotJson=JSON.stringify(snapshot);const hash=crypto.createHash('sha256').update(snapshotJson).digest('hex');const request=new sql.Request(tx).input('FlightId',sql.BigInt,flightId).input('Actor',sql.NVarChar(150),actor).input('ActorId',sql.NVarChar(150),actorId).input('FinalisedAtUtc',sql.DateTime2(3),authored.completionTimeUtc).input('SnapshotJson',sql.NVarChar(sql.MAX),snapshotJson).input('RecordHash',sql.NVarChar(128),hash);const names=[];const values=[];const add=(cands,expr)=>{const c=pick(columns,cands);if(c&&!names.includes(c)){names.push(c);values.push(expr)}};add(['FlightId'],'@FlightId');add(['VerificationId'],'NEWID()');add(['FinalisedAtUtc','FinalizedAtUtc','FinalisedAt','FinalizedAt'],'@FinalisedAtUtc');add(['FinalisedByDisplayName','FinalizedByDisplayName','FinalisedByName','FinalizedByName'],'@Actor');add(['FinalisedByObjectId','FinalizedByObjectId','FinalisedById','FinalizedById'],'@ActorId');add(['SnapshotJson','Snapshot','DetailsJson'],'@SnapshotJson');add(['RecordHash','Hash'],'@RecordHash');const mapped=new Set(names.map(x=>x.toLowerCase()));const requiredUnknown=columns.filter(c=>c.IS_NULLABLE==='NO'&&!c.COLUMN_DEFAULT&&Number(c.IS_IDENTITY)!==1&&!mapped.has(String(c.COLUMN_NAME).toLowerCase()));if(requiredUnknown.length){await tx.rollback();tx=null;sendJson(context,500,{ok:false,error:`ExportCompletionRecords has unmapped required columns: ${requiredUnknown.map(c=>c.COLUMN_NAME).join(', ')}`});return}const inserted=await request.query(`INSERT INTO dbo.ExportCompletionRecords (${names.map(q).join(',')}) OUTPUT INSERTED.* VALUES (${values.join(',')});`);await new sql.Request(tx).input('FlightId4',sql.BigInt,flightId).query(`UPDATE dbo.Flights SET FlightStatus='FINALISED' WHERE FlightId=@FlightId4;`);const auditRecord=normalize(inserted.recordset[0],columns,flight.FlightNumber);await insertAuditEvent(tx,sql,{type:'Flight',action:'Export finalised',actorDisplayName:actor,actorReference:actorId,entityType:'Flight',entityId:flightId,flightId,flightNumber:flight.FlightNumber,fromStatus:flight.FlightStatus,toStatus:'FINALISED',detail:`Export finalised • Record ${auditRecord.verificationId}`,details:{completionRecordId:auditRecord.id,verificationId:auditRecord.verificationId}});await tx.commit();tx=null;const rec=normalize(inserted.recordset[0],columns,flight.FlightNumber);rec.recordHash=hash;sendJson(context,201,{ok:true,record:rec});}catch(err){if(tx){try{await tx.rollback()}catch{}}if(err instanceof CompletionSnapshotError){sendJson(context,err.status,{ok:false,code:err.code,error:err.message});return}context.log.error('Export completion API failed',err);sendJson(context,500,{ok:false,error:'Export completion API failed',detail:err.message})}finally{try{await pool?.close()}catch{}}};
