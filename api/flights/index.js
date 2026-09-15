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
function sendJson(context,status,body){context.res={status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},body:JSON.stringify(body)}}
function clean(value){return value===null||value===undefined?null:String(value).trim().toUpperCase()}
module.exports=async function(context,req){let pool;try{const cs=process.env.DATABASE_CONNECTION_STRING;if(!cs){sendJson(context,503,{ok:false,error:'DATABASE_CONNECTION_STRING is not configured'});return}const identity=getActor(req);if(!identity){sendJson(context,401,{ok:false,error:'Microsoft Entra sign-in is required'});return}pool=await new sql.ConnectionPool(cs).connect();
if(req.method==='GET'){const result=await pool.request().query(`SELECT FlightId,FlightNumber,OperatingDate,Direction,AirlineCode,OriginAirport,DestinationAirport,FlightStatus,ScheduledArrivalUtc,EstimatedArrivalUtc,LandedAtUtc,InBlockAtUtc,ScheduledDepartureUtc,EstimatedDepartureUtc,CreatedAtUtc FROM dbo.Flights ORDER BY OperatingDate DESC,FlightNumber ASC;`);sendJson(context,200,{ok:true,count:result.recordset.length,flights:result.recordset});return}
const body=req.body||{};
if(req.method==='PATCH'){const flightId=String(body.flightId||'').trim();if(!/^\d+$/.test(flightId)){sendJson(context,400,{ok:false,error:'flightId is required'});return}
if(Object.prototype.hasOwnProperty.call(body,'scheduledDepartureUtc')||Object.prototype.hasOwnProperty.call(body,'estimatedDepartureUtc')){
  const scheduledRaw=body.scheduledDepartureUtc,estimatedRaw=body.estimatedDepartureUtc;
  const scheduled=scheduledRaw?new Date(scheduledRaw):null,estimated=estimatedRaw?new Date(estimatedRaw):null;
  if(scheduledRaw&&Number.isNaN(scheduled.getTime())){sendJson(context,400,{ok:false,error:'scheduledDepartureUtc is invalid'});return}
  if(estimatedRaw&&Number.isNaN(estimated.getTime())){sendJson(context,400,{ok:false,error:'estimatedDepartureUtc is invalid'});return}
  const r=await pool.request()
    .input('FlightId',sql.BigInt,flightId)
    .input('ScheduledDepartureUtc',sql.DateTime2,scheduled)
    .input('EstimatedDepartureUtc',sql.DateTime2,estimated)
    .query(`UPDATE dbo.Flights SET ScheduledDepartureUtc=COALESCE(@ScheduledDepartureUtc,ScheduledDepartureUtc),EstimatedDepartureUtc=COALESCE(@EstimatedDepartureUtc,EstimatedDepartureUtc) OUTPUT INSERTED.FlightId,INSERTED.FlightNumber,INSERTED.ScheduledDepartureUtc,INSERTED.EstimatedDepartureUtc WHERE FlightId=@FlightId;`);
  if(!r.recordset.length){sendJson(context,404,{ok:false,error:'Flight not found'});return}
  sendJson(context,200,{ok:true,flight:r.recordset[0]});return;
}
const expectedStatus=clean(body.expectedStatus||'ACTIVE'),nextStatus=clean(body.nextStatus);if(!['CLOSED','FINALISED','FINALIZED'].includes(nextStatus)){sendJson(context,400,{ok:false,error:'nextStatus must be CLOSED or FINALISED'});return}const r=await pool.request().input('FlightId',sql.BigInt,flightId).input('ExpectedStatus',sql.NVarChar(30),expectedStatus).input('NextStatus',sql.NVarChar(30),nextStatus).query(`UPDATE dbo.Flights SET FlightStatus=@NextStatus OUTPUT INSERTED.FlightId,INSERTED.FlightNumber,INSERTED.FlightStatus WHERE FlightId=@FlightId AND UPPER(FlightStatus)=@ExpectedStatus;`);if(!r.recordset.length){const cur=await pool.request().input('FlightId2',sql.BigInt,flightId).query(`SELECT FlightStatus FROM dbo.Flights WHERE FlightId=@FlightId2;`);sendJson(context,409,{ok:false,error:'Flight status changed on another device',currentStatus:cur.recordset?.[0]?.FlightStatus||null});return}sendJson(context,200,{ok:true,flight:r.recordset[0]});return}
const flightNumber=clean(body.flightNumber),direction=clean(body.direction),airlineCode=clean(body.airlineCode),originAirport=clean(body.originAirport),destinationAirport=clean(body.destinationAirport),operatingDate=String(body.operatingDate||'').trim();if(!flightNumber){sendJson(context,400,{ok:false,error:'flightNumber is required'});return}if(!/^\d{4}-\d{2}-\d{2}$/.test(operatingDate)){sendJson(context,400,{ok:false,error:'operatingDate must be YYYY-MM-DD'});return}if(!['IMPORT','EXPORT'].includes(direction)){sendJson(context,400,{ok:false,error:'direction must be IMPORT or EXPORT'});return}const existing=await pool.request().input('FlightNumber',sql.NVarChar(12),flightNumber).input('OperatingDate',sql.Date,operatingDate).input('Direction',sql.VarChar(6),direction).query(`SELECT FlightId FROM dbo.Flights WHERE FlightNumber=@FlightNumber AND OperatingDate=@OperatingDate AND Direction=@Direction;`);if(existing.recordset.length){sendJson(context,409,{ok:false,error:'Flight already exists',flightId:existing.recordset[0].FlightId});return}const result=await pool.request().input('FlightNumber',sql.NVarChar(12),flightNumber).input('OperatingDate',sql.Date,operatingDate).input('Direction',sql.VarChar(6),direction).input('AirlineCode',sql.NVarChar(3),airlineCode).input('OriginAirport',sql.NVarChar(4),originAirport).input('DestinationAirport',sql.NVarChar(4),destinationAirport).input('SourceType',sql.NVarChar(50),'CARGORUN_UI').input('CreatedByDisplayName',sql.NVarChar(150),identity.displayName).query(`INSERT INTO dbo.Flights(FlightNumber,OperatingDate,Direction,AirlineCode,OriginAirport,DestinationAirport,SourceType,CreatedByDisplayName) OUTPUT INSERTED.FlightId,INSERTED.FlightNumber,INSERTED.OperatingDate,INSERTED.Direction,INSERTED.CreatedAtUtc VALUES(@FlightNumber,@OperatingDate,@Direction,@AirlineCode,@OriginAirport,@DestinationAirport,@SourceType,@CreatedByDisplayName);`);sendJson(context,201,{ok:true,flight:result.recordset[0]});}catch(err){context.log.error('Flights API failed',err);sendJson(context,500,{ok:false,error:'Flights API failed',detail:err.message})}finally{try{await pool?.close()}catch{}}};
