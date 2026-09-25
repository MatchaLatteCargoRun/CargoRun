const sql = require('mssql');
const crypto = require('crypto');
const { insertAuditEvent } = require('../shared/audit');
const { buildCompletionSnapshot, CompletionSnapshotError } = require('../shared/completion-snapshot');

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
  const principal = getClientPrincipal(req);
  if (!principal) return null;
  const roles = Array.isArray(principal.userRoles) ? principal.userRoles : [];
  if (!roles.includes('authenticated')) return null;
  const reference=String(principal.userId||'').trim().slice(0,150);if(!reference)return null;return {
    displayName: String(principal.userDetails || 'Authenticated user').slice(0,150),
    reference
  };
}
function sendJson(context,status,body){context.res={status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},body:JSON.stringify(body)}}
function clean(v,max=500){if(v===null||v===undefined)return null;const s=String(v).trim();return s?s.slice(0,max):null}
function pick(columns,candidates){const m=new Map(columns.map(c=>[String(c.COLUMN_NAME).toLowerCase(),c.COLUMN_NAME]));for(const x of candidates){const h=m.get(String(x).toLowerCase());if(h)return h}return null}
function q(n){return `[${String(n).replace(/]/g,']]')}]`}
async function columnsFor(request,tableName){const r=await request.input('TableName',sql.NVarChar(128),tableName).query(`SELECT COLUMN_NAME,IS_NULLABLE,COLUMN_DEFAULT,DATA_TYPE,COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA)+'.'+QUOTENAME(TABLE_NAME)),COLUMN_NAME,'IsIdentity') AS IS_IDENTITY FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@TableName;`);return r.recordset||[]}
function normalize(row,columns,flightNumber){const get=names=>{const c=pick(columns,names);return c?row[c]:null};let snapshot={};const raw=get(['SnapshotJson','Snapshot','DetailsJson']);if(raw){try{snapshot=typeof raw==='string'?JSON.parse(raw):raw}catch{}}return{id:String(get(['ImportCompletionRecordId','CompletionRecordId','Id'])??get(['VerificationId'])??''),flightId:get(['FlightId']),flight:flightNumber||snapshot.flight||'',flightDate:snapshot.flightDate||'',originAirport:snapshot.originAirport||'',destinationAirport:snapshot.destinationAirport||'',finalizedBy:get(['FinalisedByDisplayName','FinalizedByDisplayName','FinalisedByName','FinalizedByName'])||snapshot.finalizedBy||'',finalizedById:get(['FinalisedByObjectId','FinalizedByObjectId','FinalisedById','FinalizedById'])||snapshot.finalizedById||'',finalizedAt:get(['FinalisedAtUtc','FinalizedAtUtc','FinalisedAt','FinalizedAt'])||snapshot.finalizedAt||null,verificationId:String(get(['VerificationId'])??snapshot.verificationId??''),recordHash:get(['RecordHash','Hash'])||'',exceptionReason:get(['ExceptionReason','CompletionReason','Reason'])||snapshot.exceptionReason||'',summary:snapshot.summary||{},ulds:Array.isArray(snapshot.ulds)?snapshot.ulds:[]}}

module.exports=async function(context,req){let pool,tx;try{
  const cs=process.env.DATABASE_CONNECTION_STRING;if(!cs){sendJson(context,503,{ok:false,error:'DATABASE_CONNECTION_STRING is not configured'});return}
  const identity=getActor(req);if(!identity){sendJson(context,401,{ok:false,error:'Microsoft Entra sign-in is required'});return}
  pool=await new sql.ConnectionPool(cs).connect();
  const columns=await columnsFor(pool.request(),'ImportCompletionRecords');if(!columns.length){sendJson(context,500,{ok:false,error:'dbo.ImportCompletionRecords table was not found. Run add_import_completion_records.sql first.'});return}

  if(req.method==='GET'){
    const flightIdCol=pick(columns,['FlightId']);
    const timeCol=pick(columns,['FinalisedAtUtc','FinalizedAtUtc','FinalisedAt','FinalizedAt']);
    const idCol=pick(columns,['ImportCompletionRecordId','CompletionRecordId','Id'])||columns[0].COLUMN_NAME;
    const order=timeCol?`i.${q(timeCol)} DESC`:`i.${q(idCol)} DESC`;
    const join=flightIdCol?`LEFT JOIN dbo.Flights f ON f.FlightId=i.${q(flightIdCol)}`:'';
    const selectFlight=flightIdCol?', f.FlightNumber AS __FlightNumber':'';
    const r=await pool.request().query(`SELECT i.*${selectFlight} FROM dbo.ImportCompletionRecords i ${join} ORDER BY ${order};`);
    sendJson(context,200,{ok:true,count:r.recordset.length,records:r.recordset.map(x=>normalize(x,columns,x.__FlightNumber))});return;
  }

  const b=req.body||{};const flightId=String(b.flightId||'').trim();if(!/^\d+$/.test(flightId)){sendJson(context,400,{ok:false,error:'flightId is required'});return}
  const exceptionReason=clean(b.exceptionReason,500);
  tx=new sql.Transaction(pool);await tx.begin();
  const f=await new sql.Request(tx).input('FlightId',sql.BigInt,flightId).query(`SELECT FlightId,FlightNumber,OperatingDate,CONVERT(char(10),OperatingDate,23) AS OperatingDateIso,Direction,AirlineCode,OriginAirport,DestinationAirport,FlightStatus FROM dbo.Flights WHERE FlightId=@FlightId;`);
  if(!f.recordset.length){await tx.rollback();tx=null;sendJson(context,404,{ok:false,error:'Flight not found'});return}
  const flight=f.recordset[0];
  if(String(flight.Direction||'').toUpperCase()!=='IMPORT'){await tx.rollback();tx=null;sendJson(context,400,{ok:false,error:'Only import flights can be finalised here'});return}

  const pending=await new sql.Request(tx).input('FlightId2',sql.BigInt,flightId).query(`SELECT COUNT(*) AS Pending FROM dbo.ULDs WHERE FlightId=@FlightId2 AND UPPER(REPLACE(CurrentStatus,' ','_'))<>'RECEIVED';`);
  const pendingCount=Number(pending.recordset[0]?.Pending||0);
  if(pendingCount>0&&!exceptionReason){await tx.rollback();tx=null;sendJson(context,409,{ok:false,error:`${pendingCount} ULD${pendingCount===1?' is':'s are'} not RECEIVED. Enter an exception reason to finalise incomplete.`});return}

  const flightIdCol=pick(columns,['FlightId']);
  if(flightIdCol){const existing=await new sql.Request(tx).input('FlightId3',sql.BigInt,flightId).query(`SELECT TOP 1 * FROM dbo.ImportCompletionRecords WHERE ${q(flightIdCol)}=@FlightId3;`);if(existing.recordset.length){await tx.rollback();tx=null;sendJson(context,409,{ok:false,error:'Import completion record already exists',record:normalize(existing.recordset[0],columns,flight.FlightNumber)});return}}

  const authored=await buildCompletionSnapshot(tx,sql,{direction:'IMPORT',flightId,flight,actor:identity,exceptionReason});
  const snapshot=authored.snapshot;
  const snapshotJson=JSON.stringify(snapshot);const hash=crypto.createHash('sha256').update(snapshotJson).digest('hex');
  const request=new sql.Request(tx).input('FlightId',sql.BigInt,flightId).input('Actor',sql.NVarChar(150),identity.displayName).input('ActorId',sql.NVarChar(150),identity.reference).input('FinalisedAtUtc',sql.DateTime2(3),authored.completionTimeUtc).input('ExceptionReason',sql.NVarChar(500),exceptionReason).input('SnapshotJson',sql.NVarChar(sql.MAX),snapshotJson).input('RecordHash',sql.NVarChar(128),hash);
  const names=[];const values=[];const add=(cands,expr)=>{const c=pick(columns,cands);if(c&&!names.includes(c)){names.push(c);values.push(expr)}};
  add(['FlightId'],'@FlightId');add(['VerificationId'],'NEWID()');add(['FinalisedAtUtc','FinalizedAtUtc','FinalisedAt','FinalizedAt'],'@FinalisedAtUtc');add(['FinalisedByDisplayName','FinalizedByDisplayName','FinalisedByName','FinalizedByName'],'@Actor');add(['FinalisedByObjectId','FinalizedByObjectId','FinalisedById','FinalizedById'],'@ActorId');add(['ExceptionReason','CompletionReason','Reason'],'@ExceptionReason');add(['SnapshotJson','Snapshot','DetailsJson'],'@SnapshotJson');add(['RecordHash','Hash'],'@RecordHash');
  const mapped=new Set(names.map(x=>x.toLowerCase()));const requiredUnknown=columns.filter(c=>c.IS_NULLABLE==='NO'&&!c.COLUMN_DEFAULT&&Number(c.IS_IDENTITY)!==1&&!mapped.has(String(c.COLUMN_NAME).toLowerCase()));if(requiredUnknown.length){await tx.rollback();tx=null;sendJson(context,500,{ok:false,error:`ImportCompletionRecords has unmapped required columns: ${requiredUnknown.map(c=>c.COLUMN_NAME).join(', ')}`});return}
  const inserted=await request.query(`INSERT INTO dbo.ImportCompletionRecords (${names.map(q).join(',')}) OUTPUT INSERTED.* VALUES (${values.join(',')});`);
  await new sql.Request(tx).input('FlightId4',sql.BigInt,flightId).query(`UPDATE dbo.Flights SET FlightStatus='FINALISED' WHERE FlightId=@FlightId4;`);
  const auditRecord=normalize(inserted.recordset[0],columns,flight.FlightNumber);
  await insertAuditEvent(tx,sql,{type:'Flight',action:'Import finalised',actorDisplayName:identity.displayName,actorReference:identity.reference,entityType:'Flight',entityId:flightId,flightId,flightNumber:flight.FlightNumber,fromStatus:flight.FlightStatus,toStatus:'FINALISED',detail:`Import finalised${exceptionReason?` with exception: ${exceptionReason}`:''} • Record ${auditRecord.verificationId}`,details:{completionRecordId:auditRecord.id,verificationId:auditRecord.verificationId,pendingCount}});
  await tx.commit();tx=null;
  const rec=normalize(inserted.recordset[0],columns,flight.FlightNumber);rec.recordHash=hash;sendJson(context,201,{ok:true,record:rec,pendingCount});
}catch(err){if(tx){try{await tx.rollback()}catch{}}if(err instanceof CompletionSnapshotError){sendJson(context,err.status,{ok:false,code:err.code,error:err.message});return}context.log.error('Import completion API failed',err);sendJson(context,500,{ok:false,error:'Import completion API failed',detail:err.message})}finally{try{await pool?.close()}catch{}}};
