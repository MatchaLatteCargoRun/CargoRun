'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {sqlHarness, loadHandler, call} = require('./helpers/operational-harness');
const root = path.resolve(__dirname, '..');
const body = {flightId:'1',uldId:'7',uldNumber:'ake-12345-cx',parkingBay:'F25'};
const flight = (overrides={}) => ({FlightId:'1',FlightNumber:'CX178',Direction:'EXPORT',FlightStatus:'ACTIVE',OperatingDate:'2026-09-16',CreatedAtUtc:'2026-09-16T00:00:00.000Z',...overrides});
const setup = (options={}) => {const h=sqlHarness({liveSchema:true,flights:[flight()],...options});return {...h,handler:loadHandler('api/offloads/index.js',h.sql)}};

test('selector includes exact 24h boundary, excludes import/inactive/old and prefers recent reason', async()=>{
 const h=setup({flights:[
  flight(),flight({FlightId:'2',CreatedAtUtc:'2026-09-15T23:59:59.999Z'}),
  flight({FlightId:'3',Direction:'IMPORT'}),flight({FlightId:'4',FlightStatus:'CLOSED'}),
  flight({FlightId:'5',FlightStatus:'FINALISED'}),
  flight({FlightId:'6',OperatingDate:'2026-09-17',CreatedAtUtc:'2026-01-01T00:00:00Z'}),
  flight({FlightId:'7',OperatingDate:'2026-09-17'})
 ]});
 const r=await call(h.handler,'GET',null,{eligibleFlights:'true'});
 assert.equal(r.status,200);
 assert.deepEqual(r.body.flights.map(f=>[f.flightId,f.inclusionReason]),[['1','RECENTLY_CREATED'],['6','OPERATING_TODAY'],['7','RECENTLY_CREATED']]);
 const q=h.state.queries.find(x=>x.q.includes('DECLARE @ServerNowUtc')).q;
 assert.equal((q.match(/SYSUTCDATETIME\(\)/g)||[]).length,1);
 assert.match(q,/AT TIME ZONE 'UTC' AT TIME ZONE 'AUS Eastern Standard Time'/);
 assert.match(q,/Direction = 'EXPORT' AND FlightStatus = 'ACTIVE' AND \(CreatedAtUtc >= DATEADD\(hour,-24,@ServerNowUtc\) OR OperatingDate = @CurrentMelbourneDate\)/);
 assert.doesNotMatch(q,/EstimatedDeparture|ScheduledDeparture/);
});

test('Melbourne date fallback crosses UTC day and follows daylight saving', async()=>{
 const h=setup({flights:[flight({OperatingDate:'2026-01-18',CreatedAtUtc:'2026-01-01T00:00:00Z'})]});
 h.state.now='2026-01-17T13:30:00Z';
 const r=await call(h.handler,'GET',null,{eligibleFlights:'true'});
 assert.equal(r.body.flights.length,1);assert.equal(r.body.flights[0].inclusionReason,'OPERATING_TODAY');
});

test('live-schema POST persists exact IDs and canonical database ULD and writes one audit',async()=>{
 const h=setup();const r=await call(h.handler,'POST',body);
 assert.equal(r.status,201);assert.equal(h.state.offload.UldId,'7');assert.equal(h.state.offload.FlightId,'1');
 assert.equal(h.state.offload.UldNumber,'AKE12345CX');assert.equal(h.state.offload.OffloadStatus,'REQUESTED');assert.equal(h.state.offload.Bay,'F25');
 assert.equal(h.state.audits.length,1);
 const reads=h.state.queries.filter(x=>x.q.includes('WITH (UPDLOCK, HOLDLOCK)'));
 assert.equal(reads.length,3);
});

for(const [label,changes,flightChanges] of [
 ['missing UldId',{uldId:undefined},{}],['invented UldId',{uldId:'999'},{}],
 ['mismatched number',{uldNumber:'AKE99999CX'},{}],['unsafe numeric ID',{uldId:9007199254740992},{}],
 ['import',{}, {Direction:'IMPORT'}],['closed',{}, {FlightStatus:'CLOSED'}],
 ['finalised',{}, {FlightStatus:'FINALISED'}],['expired',{}, {CreatedAtUtc:'2026-09-15T23:59:59.999Z'}]
])test('POST rejects '+label+' without mutation/audit',async()=>{
 const h=setup({flights:[flight(flightChanges)]});const r=await call(h.handler,'POST',{...body,...changes});
 assert.ok([400,409].includes(r.status));assert.equal(h.state.offload,null);assert.equal(h.state.audits.length,0);
});

test('wrong-flight UldId and multiple canonical ULD identities fail closed',async()=>{
 for(const rows of [
  [{FlightId:'2',UldId:'7',UldNumber:'AKE12345CX'}],
  [{FlightId:'1',UldId:'7',UldNumber:'AKE12345CX'},{FlightId:'1',UldId:'8',UldNumber:'AKE-12345-CX'}]
 ]){const h=setup({offloadUlds:rows});const r=await call(h.handler,'POST',body);assert.equal(r.status,409);assert.equal(h.state.audits.length,0)}
});

test('active exact/legacy duplicate returns stable existing OffloadId; corrupt matches require review',async()=>{
 for(const uldId of [null,'7']){
  const h=setup({offload:{OffloadId:'40',FlightId:'1',UldId:uldId,UldNumber:'AKE 12345 CX',OffloadStatus:'TRANSIT'}});
  const r=await call(h.handler,'POST',body);assert.equal(r.status,409);assert.equal(r.body.code,'ACTIVE_OFFLOAD_EXISTS');assert.equal(r.body.offloadId,'40');assert.equal(h.state.audits.length,0);
 }
 const h=setup({offload:{OffloadId:'40',FlightId:'1',UldId:null,UldNumber:'AKE12345CX',OffloadStatus:'REQUESTED'}});
 h.state.extraOffloads.push({...h.state.offload,OffloadId:'41'});
 const r=await call(h.handler,'POST',body);assert.equal(r.body.code,'OFFLOAD_IDENTITY_CONFLICT');assert.equal(r.body.offloadId,undefined);
});

test('concurrent creation serializes behind flight lock and creates one active request/audit',async()=>{
 const h=setup();const results=await Promise.all([call(h.handler,'POST',body),call(h.handler,'POST',body)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(h.state.audits.length,1);assert.equal(h.state.commits,1);
 assert.equal(results.find(r=>r.status===409).body.offloadId,'90');
});

test('COMPLETE history including mismatched Offload 12 stays untouched and permits new request',async()=>{
 const h=setup();h.state.extraOffloads.push({OffloadId:'12',FlightId:'25',UldId:null,UldNumber:'AKE88888CX',OffloadStatus:'COMPLETE'}, {OffloadId:'11',FlightId:'1',UldId:'7',UldNumber:'AKE12345CX',OffloadStatus:'COMPLETE'});
 const before=structuredClone(h.state.extraOffloads);const r=await call(h.handler,'POST',body);
 assert.equal(r.status,201);assert.deepEqual(h.state.extraOffloads,before);
});

test('legacy Offload 9 progresses by ID without flight/ULD inference or eligibility and rejects stale retry',async()=>{
 const h=setup({offload:{OffloadId:'9',FlightId:null,UldId:null,UldNumber:'QKE52521QR',OffloadStatus:'REQUESTED'}});
 const collect={offloadId:'9',expectedCurrentStatus:'REQUESTED',nextStatus:'TRANSIT'};
 assert.equal((await call(h.handler,'PATCH',collect)).status,200);
 assert.equal((await call(h.handler,'PATCH',collect)).body.code,'STALE_STATUS');
 assert.equal((await call(h.handler,'PATCH',{offloadId:'9',expectedCurrentStatus:'TRANSIT',nextStatus:'COMPLETE',deliveredLocation:'Cool Room 4'})).status,200);
 assert.equal(h.state.offload.FlightId,null);assert.equal(h.state.offload.UldId,null);assert.equal(h.state.audits.length,2);
 assert.equal(h.state.queries.some(x=>x.q.includes('FROM dbo.Flights')),false);
});

test('live-schema required audit failure rolls back creation',async()=>{
 const h=setup();h.state.failAudit=true;const r=await call(h.handler,'POST',body);
 assert.equal(r.status,500);assert.equal(h.state.offload,null);assert.equal(h.state.audits.length,0);
});

test('before migration new creation fails closed while old legacy transition still works',async()=>{
 const h=setup({migrated:false,offload:{OffloadId:'9',FlightId:null,UldNumber:'QKE52521QR',OffloadStatus:'REQUESTED'}});
 const r=await call(h.handler,'POST',body);assert.equal(r.status,503);assert.equal(r.body.code,'OFFLOAD_SCHEMA_NOT_READY');
 assert.equal(h.state.audits.length,0);
 assert.equal((await call(h.handler,'PATCH',{offloadId:'9',expectedCurrentStatus:'REQUESTED',nextStatus:'TRANSIT'})).status,200);
 assert.equal(h.state.offload.FlightId,null);assert.equal(h.state.offload.UldId,undefined);
});

test('database active-index violation rolls back and returns exact competing offload',async()=>{
 const h=setup();h.state.uniqueViolation=true;const r=await call(h.handler,'POST',body);
 assert.equal(r.status,409);assert.equal(r.body.offloadId,'91');assert.equal(h.state.offload,null);assert.equal(h.state.audits.length,0);assert.equal(h.state.rollbacks,1);
});

test('one active row with conflicting stored UldId or number requires review',async()=>{
 for(const changes of [{UldId:'8'}, {UldNumber:'AKE99999CX'}]){
  const h=setup({offload:{OffloadId:'40',FlightId:'1',UldId:'7',UldNumber:'AKE12345CX',OffloadStatus:'REQUESTED',...changes}});
  assert.equal((await call(h.handler,'POST',body)).body.code,'OFFLOAD_IDENTITY_CONFLICT');
 }
});

test('ULD GET scopes SQL by selected FlightId and preserves BIGINT IDs as strings',async()=>{
 let query,parameter;
 class Request{input(name,type,value){parameter=value;return this}async query(q){query=q;return {recordset:[{UldId:9007199254740992,FlightId:9007199254740992,__UldIdText:'9007199254740993',__FlightIdText:'9007199254740995',UldNumber:'AKE12345CX'}]}}}
 class Pool{async connect(){return this}request(){return new Request()}async close(){}}
 const handler=loadHandler('api/ulds/index.js',{ConnectionPool:Pool,BigInt:'bigint'});
 const r=await call(handler,'GET',null,{flightId:'9007199254740995'});
 assert.equal(r.status,200);assert.equal(parameter,'9007199254740995');assert.match(query,/WHERE u.FlightId = @FlightId/);
 assert.equal(r.body.ulds[0].UldId,'9007199254740993');assert.equal(r.body.ulds[0].FlightId,'9007199254740995');
});

const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function ui(){
 const elements={};for(const id of ['offFlightId','offUldId','offSubmit','offBay','offInstruction','offRequestMessage'])elements[id]={value:'',disabled:false,innerHTML:'',textContent:''};
 elements.modal={classList:{contains:()=>true}};const requests=[],notices=[],opened=[];
 const context=vm.createContext({document:{getElementById:id=>elements[id]},modal(){},modalHead:()=>'',esc:String,azureDisplayDate:String,
  stableOperationalId:x=>x==null?'':String(x),normalizeULD:s=>s.trim().toUpperCase().replace(/[\s-]/g,''),
  fetch:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve})),toast:x=>notices.push(x),showActionLoader(){},hideActionLoader(){},closeModal(){},openScreen(){},
  syncAzureOffloads:async()=>true,selectQuickScanCandidate:(...args)=>opened.push(args)});
 vm.runInContext(html.slice(html.indexOf('let offloadRequestSession='),html.indexOf('function handleOffload(')),context);
 const respond=(i,data,status=200)=>requests[i].resolve({ok:status<400,status,json:async()=>data});
 return {context,elements,requests,respond,notices,opened};
}
async function startUi(){const h=ui();const pending=h.context.showRequestOffload();h.respond(0,{flights:[{flightId:'1',flightNumber:'CX178',operatingDate:'2026-09-17',inclusionReason:'RECENTLY_CREATED'},{flightId:'2',flightNumber:'TG462',operatingDate:'2026-09-17',inclusionReason:'OPERATING_TODAY'}]});await pending;return h}

test('flight switching clears ULDs and late flight A response cannot populate flight B',async()=>{
 const h=await startUi();h.elements.offFlightId.value='1';const a=h.context.loadOffloadUlds();
 h.elements.offUldId.value='7';h.elements.offFlightId.value='2';const b=h.context.loadOffloadUlds();
 assert.equal(h.elements.offUldId.value,'');assert.equal(h.elements.offSubmit.disabled,true);
 assert.equal(h.requests[1].url,'/api/ulds?flightId=1');assert.equal(h.requests[2].url,'/api/ulds?flightId=2');
 h.respond(2,{ulds:[{FlightId:'2',UldId:'8',UldNumber:'PMC22222TG',CurrentStatus:'TRANSIT'}]});await b;
 h.respond(1,{ulds:[{FlightId:'1',UldId:'7',UldNumber:'AKE12345CX',CurrentStatus:'WAREHOUSE'}]});await a;
 assert.match(h.elements.offUldId.innerHTML,/PMC22222TG/);assert.doesNotMatch(h.elements.offUldId.innerHTML,/AKE12345CX/);
});

test('empty or wrong-flight ULD responses keep submission disabled',async()=>{
 for(const rows of [[],[{FlightId:'2',UldId:'8',UldNumber:'PMC22222TG'}]]){
  const h=await startUi();h.elements.offFlightId.value='1';const p=h.context.loadOffloadUlds();h.respond(1,{ulds:rows});await p;
  assert.equal(h.elements.offSubmit.disabled,true);assert.equal(h.elements.offUldId.disabled,true);
  assert.match(h.elements.offRequestMessage.textContent,rows.length?/does not match/:/No ULDs available/);
 }
});

test('late response from a closed/reopened request cannot populate the new modal',async()=>{
 const h=await startUi();h.elements.offFlightId.value='1';const old=h.context.loadOffloadUlds();
 const reopened=h.context.showRequestOffload();h.respond(2,{flights:[]});await reopened;
 h.respond(1,{ulds:[{FlightId:'1',UldId:'7',UldNumber:'AKE12345CX',CurrentStatus:'WAREHOUSE'}]});await old;
 assert.doesNotMatch(h.elements.offUldId.innerHTML,/AKE12345CX/);
});

test('tampered ULD selector value cannot submit an arbitrary ULD',async()=>{
 const h=await startUi();h.elements.offFlightId.value='1';const p=h.context.loadOffloadUlds();h.respond(1,{ulds:[{FlightId:'1',UldId:'7',UldNumber:'AKE12345CX'}]});await p;
 h.elements.offUldId.value='999';h.elements.offBay.value='F25';await h.context.createOffload();
 assert.equal(h.requests.length,2);assert.match(h.notices[0],/Select a flight/);
});

test('UI submits selected stable IDs and opens exact duplicate OffloadId',async()=>{
 const h=await startUi();h.elements.offFlightId.value='1';const p=h.context.loadOffloadUlds();h.respond(1,{ulds:[{FlightId:'1',UldId:'7',UldNumber:'AKE-12345-CX',CurrentStatus:'AT_AIRCRAFT'}]});await p;
 h.elements.offUldId.value='7';h.elements.offBay.value='F25';const create=h.context.createOffload();
 assert.deepEqual(JSON.parse(h.requests[2].options.body),{flightId:'1',uldId:'7',uldNumber:'AKE12345CX',flightNumber:'CX178',operatingDate:'2026-09-17',parkingBay:'F25',requestInstruction:''});
 h.respond(2,{code:'ACTIVE_OFFLOAD_EXISTS',offloadId:'40'},409);await create;
 assert.deepEqual(h.opened,[['offload','','','','40']]);
 const source=html.slice(html.indexOf('let offloadRequestSession='),html.indexOf('function handleOffload('));
 assert.doesNotMatch(source,/Date\.now|new Date|id="offUld"/);
});
