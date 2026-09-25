'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {sqlHarness, loadHandler, call} = require('./helpers/operational-harness');
const {canonicalJson,sha256,amendmentEnvelope}=require('../api/shared/completion-amendments');
const root = path.resolve(__dirname, '..');
const body = {flightId:'1',uldId:'7',uldNumber:'ake-12345-cx',parkingBay:'F25'};
const flight = (overrides={}) => ({FlightId:'1',FlightNumber:'CX178',Direction:'EXPORT',FlightStatus:'ACTIVE',OperatingDate:'2026-09-16',CreatedAtUtc:'2026-09-16T00:00:00.000Z',...overrides});
const setup = (options={}) => {const h=sqlHarness({liveSchema:true,flights:[flight()],...options});return {...h,handler:loadHandler('api/offloads/index.js',h.sql)}};
const baseCompletion=(overrides={})=>{const SnapshotJson=overrides.SnapshotJson||'{"flight":"CX178","ulds":["AKE-12345-CX"]}';return {CompletionId:'30',FlightId:'1',VerificationId:'v1-verify',SnapshotJson,RecordHash:sha256(SnapshotJson),...overrides}}

test('selector includes historical CLOSED/finalised exports and excludes imports/unsupported statuses', async()=>{
 const h=setup({flights:[
  flight(),flight({FlightId:'2',CreatedAtUtc:'2026-09-15T23:59:59.999Z'}),
  flight({FlightId:'3',Direction:'IMPORT'}),flight({FlightId:'4',FlightStatus:'CLOSED',OperatingDate:'2025-01-01',CreatedAtUtc:'2024-12-31T00:00:00Z'}),
  flight({FlightId:'5',FlightStatus:'FINALISED'}),flight({FlightId:'6',FlightStatus:'FINALIZED'}),
  flight({FlightId:'7',FlightStatus:'CANCELLED'})
 ]});
 const r=await call(h.handler,'GET',null,{eligibleFlights:'true'});
 assert.equal(r.status,200);
 assert.deepEqual(r.body.flights.map(f=>[f.flightId,f.flightStatus]),[['1','ACTIVE'],['2','ACTIVE'],['4','CLOSED'],['5','FINALISED'],['6','FINALIZED']]);
 assert.equal(r.body.flights.find(f=>f.flightId==='4').operatingDate,'2025-01-01');
 const q=h.state.queries.find(x=>Object.hasOwn(x.p,'SelectedFlightId')).q;
 assert.match(q,/f\.Direction = 'EXPORT'\s+AND f\.FlightStatus IN \('ACTIVE','CLOSED','FINALISED','FINALIZED'\)/);
 assert.doesNotMatch(q,/DATEADD|SYSUTCDATETIME|EstimatedDeparture|ScheduledDeparture/);
});

test('Flight Summary GET returns only exact FlightId offloads in deterministic order without mutation',async()=>{
 const h=setup({flights:[flight({FlightStatus:'CLOSED'}),flight({FlightId:'2',OperatingDate:'2026-09-18',FlightStatus:'FINALISED'})]});
 h.state.extraOffloads.push(
  {OffloadId:'12',FlightId:'1',UldId:'7',UldNumber:'AKE12345CX',OffloadStatus:'COMPLETE',RequestedAtUtc:'2026-09-17T02:00:00Z',DeliveredAtUtc:'2026-09-17T03:00:00Z',DeliveredByDisplayName:'Runner Two'},
  {OffloadId:'10',FlightId:'1',UldId:'8',UldNumber:'PMC48921R7',OffloadStatus:'REQUESTED',RequestedAtUtc:'2026-09-17T01:00:00Z',RequestedByDisplayName:'Planner'},
  {OffloadId:'11',FlightId:'1',UldId:'9',UldNumber:'AKE00001CX',OffloadStatus:'TRANSIT',RequestedAtUtc:'2026-09-17T01:00:00Z'},
  {OffloadId:'20',FlightId:'2',UldId:'18',UldNumber:'AKE12345CX',OffloadStatus:'REQUESTED',RequestedAtUtc:'2026-09-17T00:00:00Z'}
 );
 const before=structuredClone({offload:h.state.offload,extraOffloads:h.state.extraOffloads,flights:h.state.flights,audits:h.state.audits});
 const r=await call(h.handler,'GET',null,{flightId:'1'});
 assert.equal(r.status,200);assert.equal(r.body.flight.flightId,'1');assert.equal(r.body.flight.flightStatus,'CLOSED');
 assert.deepEqual(r.body.offloads.map(o=>o.offloadId),['10','11','12']);
 assert.deepEqual(r.body.offloads.map(o=>o.flightId),['1','1','1']);
 assert.equal(r.body.offloads.some(o=>o.offloadId==='20'),false);
 assert.deepEqual({offload:h.state.offload,extraOffloads:h.state.extraOffloads,flights:h.state.flights,audits:h.state.audits},before);
 const scoped=h.state.queries.find(x=>Object.hasOwn(x.p,'SummaryFlightId'));
 assert.equal(scoped.p.SummaryFlightId,'1');assert.match(scoped.q,/WHERE o\.\[FlightId\] = @SummaryFlightId/);
 assert.match(scoped.q,/ORDER BY CASE WHEN o\.\[RequestedAtUtc\] IS NULL THEN 1 ELSE 0 END, o\.\[RequestedAtUtc\] ASC, o\.\[OffloadId\] ASC/);assert.doesNotMatch(scoped.q,/INSERT|UPDATE|DELETE/);
});

test('Flight Summary GET handles no offloads and rejects invalid or unknown FlightId',async()=>{
 const h=setup({flights:[flight({FlightStatus:'FINALIZED'})]});
 const empty=await call(h.handler,'GET',null,{flightId:'1'});assert.equal(empty.status,200);assert.equal(empty.body.count,0);assert.deepEqual(empty.body.offloads,[]);
 assert.equal((await call(h.handler,'GET',null,{flightId:'CX178'})).status,400);
 assert.equal((await call(h.handler,'GET',null,{flightId:'999'})).status,404);
});

for(const status of ['ACTIVE','CLOSED','FINALISED','FINALIZED'])test(status+' historical export without completion accepts its owned ULD without changing lifecycle',async()=>{
 const h=setup({flights:[flight({FlightStatus:status,OperatingDate:'2025-01-01',CreatedAtUtc:'2024-12-31T00:00:00Z'})]});
 const before=structuredClone(h.state.flights);
 const r=await call(h.handler,'POST',body);
 assert.equal(r.status,201);assert.deepEqual(h.state.flights,before);
 assert.equal(h.state.queries.some(x=>/UPDATE dbo.Flights|INSERT INTO dbo.ExportCompletionRecords/.test(x.q)),false);
 const audit=JSON.parse(h.state.audits[0].DetailsJson);
 assert.equal(audit.flightId,'1');assert.equal(audit.uldId,'7');assert.equal(String(audit.offloadId),'90');
 assert.equal(audit.flightStatusAtRequest,status);assert.match(h.state.audits[0].Detail,new RegExp('Flight '+status));
});

test('completion-backed CLOSED and FINALISED flights append V2 and preserve V1 bytes',async()=>{
 for(const status of ['CLOSED','FINALISED']){
  const record=baseCompletion();
  const h=setup({flights:[flight({FlightStatus:status})],completions:[record]});
  const before=structuredClone({flights:h.state.flights,completions:h.state.completions});
  const r=await call(h.handler,'POST',body);
  assert.equal(r.status,201);assert.equal(r.body.amendment.versionNumber,2);assert.equal(h.state.amendments.length,1);
  assert.equal(h.state.amendments[0].CompletionId,record.CompletionId);
  assert.equal(h.state.queries.find(x=>Object.hasOwn(x.p,'CompletionBaseId')).p.CompletionBaseId,record.CompletionId);
  assert.equal(h.state.amendments[0].PreviousHash,record.RecordHash);assert.equal(h.state.amendments[0].Action,'OFFLOAD_REQUESTED');
  assert.equal(h.state.amendments[0].PreviousStatus,null);assert.equal(h.state.amendments[0].ResultingStatus,'REQUESTED');
  assert.equal(h.state.amendments[0].RelatedOffloadId,String(r.body.offload.offloadId));assert.equal(h.state.amendments[0].RelatedUldId,'7');
  assert.equal(JSON.parse(h.state.amendments[0].SnapshotJson).ulds[0],'AKE-12345-CX');
  assert.deepEqual(h.state.flights,before.flights);assert.deepEqual(h.state.completions,before.completions);
  assert.equal(h.state.audits.length,1);assert.equal(JSON.parse(h.state.audits[0].DetailsJson).amendment.versionNumber,2);
  const retry=await call(h.handler,'POST',body);
  assert.equal(retry.body.code,'OFFLOAD_EXISTS');assert.equal(h.state.amendments.length,1);assert.equal(h.state.audits.length,1);
 }
});

test('completion evidence is checked only for exact FlightId and missing amendment schema fails closed',async()=>{
 const h=setup({flights:[flight({FlightStatus:'CLOSED'})],completions:[{FlightId:'2',SnapshotJson:'other dated flight',RecordHash:'unchanged'}],amendmentSchema:false});
 assert.equal((await call(h.handler,'POST',body)).status,201);
 const missing=setup({flights:[flight({FlightStatus:'CLOSED'})],completions:[baseCompletion()],amendmentSchema:false});
 assert.equal((await call(missing.handler,'POST',body)).body.code,'OFFLOAD_AMENDMENT_SCHEMA_NOT_READY');
 assert.equal(missing.state.offload,null);assert.equal(missing.state.audits.length,0);
});

test('offload lifecycle appends V3/V4 with a verified hash chain and stale retry adds nothing',async()=>{
 const base=baseCompletion();const h=setup({flights:[flight({FlightStatus:'CLOSED'})],completions:[base]});
 const created=await call(h.handler,'POST',body);assert.equal(created.body.amendment.versionNumber,2);
 const v1Before=structuredClone(h.state.completions[0]);
 const transit=await call(h.handler,'PATCH',{offloadId:String(created.body.offload.offloadId),expectedCurrentStatus:'REQUESTED',nextStatus:'TRANSIT'});
 assert.equal(transit.status,200);assert.equal(transit.body.amendment.versionNumber,3);
 assert.equal(h.state.amendments[1].PreviousStatus,'REQUESTED');assert.equal(h.state.amendments[1].ResultingStatus,'TRANSIT');
 assert.equal(h.state.amendments[1].PreviousHash,h.state.amendments[0].RecordHash);
 const v3Envelope=amendmentEnvelope(h.state.amendments[1],JSON.parse(h.state.amendments[1].SnapshotJson));
 assert.equal(sha256(canonicalJson(v3Envelope)),h.state.amendments[1].RecordHash);
 const beforeRetry=structuredClone({amendments:h.state.amendments,audits:h.state.audits});
 const stale=await call(h.handler,'PATCH',{offloadId:String(created.body.offload.offloadId),expectedCurrentStatus:'REQUESTED',nextStatus:'TRANSIT'});
 assert.equal(stale.body.code,'STALE_STATUS');assert.deepEqual(h.state.amendments,beforeRetry.amendments);assert.deepEqual(h.state.audits,beforeRetry.audits);
 const complete=await call(h.handler,'PATCH',{offloadId:String(created.body.offload.offloadId),expectedCurrentStatus:'TRANSIT',nextStatus:'COMPLETE',deliveredLocation:'Cool Room 4',completionNote:'Delivered'});
 assert.equal(complete.body.amendment.versionNumber,4);assert.equal(h.state.amendments[2].PreviousHash,h.state.amendments[1].RecordHash);
 assert.equal(h.state.amendments[2].PreviousStatus,'TRANSIT');assert.equal(h.state.amendments[2].ResultingStatus,'COMPLETE');
 assert.deepEqual(h.state.completions[0],v1Before);assert.equal(h.state.flights[0].FlightStatus,'CLOSED');
 const lockIndex=h.state.queries.findIndex(x=>Object.hasOwn(x.p,'AmendmentMutationFlightId'));
 const updateIndex=h.state.queries.findIndex((x,index)=>index>lockIndex&&x.q.startsWith('UPDATE dbo.Offloads'));
 assert.ok(lockIndex>=0&&updateIndex>lockIndex,'flight lock must precede operational status mutation');
});

test('broken V2 chain blocks progression and rolls back the status mutation',async()=>{
 const h=setup({flights:[flight({FlightStatus:'CLOSED'})],completions:[baseCompletion()]});
 const created=await call(h.handler,'POST',body);assert.equal(created.status,201);
 h.state.amendments[0].PreviousHash='f'.repeat(64);
 const before=structuredClone({offload:h.state.offload,amendments:h.state.amendments,audits:h.state.audits});
 const transit=await call(h.handler,'PATCH',{offloadId:String(created.body.offload.offloadId),expectedCurrentStatus:'REQUESTED',nextStatus:'TRANSIT'});
 assert.equal(transit.status,409);assert.equal(transit.body.code,'COMPLETION_EVIDENCE_INVALID');
 assert.deepEqual(h.state.offload,before.offload);assert.deepEqual(h.state.amendments,before.amendments);assert.deepEqual(h.state.audits,before.audits);
});

test('invalid or multiple V1 completion evidence blocks creation without repair',async()=>{
 for(const completions of [[baseCompletion({RecordHash:'0'.repeat(64)})],[baseCompletion(),baseCompletion({CompletionId:'31'})]]){
  const h=setup({flights:[flight({FlightStatus:'CLOSED'})],completions});const before=structuredClone(completions);
  const r=await call(h.handler,'POST',body);assert.equal(r.body.code,'COMPLETION_EVIDENCE_INVALID');
  assert.equal(h.state.offload,null);assert.equal(h.state.amendments.length,0);assert.equal(h.state.audits.length,0);assert.deepEqual(h.state.completions,before);
 }
});

test('simultaneous historical offloads allocate unique sequential amendment versions',async()=>{
 const h=setup({flights:[flight({FlightStatus:'CLOSED'})],completions:[baseCompletion()],offloadUlds:[
  {FlightId:'1',UldId:'7',UldNumber:'AKE12345CX'},{FlightId:'1',UldId:'8',UldNumber:'PMC48921CX'}]});
 const second={...body,uldId:'8',uldNumber:'PMC48921CX'};
 const results=await Promise.all([call(h.handler,'POST',body),call(h.handler,'POST',second)]);
 assert.deepEqual(results.map(r=>r.status),[201,201]);assert.deepEqual(h.state.amendments.map(a=>a.VersionNumber),[2,3]);
 assert.equal(h.state.amendments[1].PreviousHash,h.state.amendments[0].RecordHash);
 assert.equal(new Set(h.state.amendments.map(a=>a.OperationId)).size,2);assert.equal(h.state.audits.length,2);
});

test('amendment or audit failure rolls back operational mutation and amendment together',async()=>{
 for(const failure of ['failAmendment','failAudit']){
  const h=setup({flights:[flight({FlightStatus:'CLOSED'})],completions:[baseCompletion()]});h.state[failure]=true;
  const r=await call(h.handler,'POST',body);assert.equal(r.status,500);assert.equal(h.state.offload,null);
  assert.equal(h.state.amendments.length,0);assert.equal(h.state.audits.length,0);assert.equal(h.state.rollbacks,1);
 }
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
 ['import',{}, {Direction:'IMPORT'}],['unsupported status',{}, {FlightStatus:'CANCELLED'}]
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

test('permanent exact/legacy duplicate returns stable existing OffloadId; corrupt matches require review',async()=>{
 for(const uldId of [null,'7']){
  const h=setup({offload:{OffloadId:'40',FlightId:'1',UldId:uldId,UldNumber:'AKE 12345 CX',OffloadStatus:'TRANSIT'}});
  const r=await call(h.handler,'POST',body);assert.equal(r.status,409);assert.equal(r.body.code,'OFFLOAD_EXISTS');assert.equal(r.body.offloadId,'40');assert.equal(h.state.audits.length,0);
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

test('closed flight rejects wrong ownership and keeps concurrent duplicates to one request',async()=>{
 const closed=flight({FlightStatus:'CLOSED',OperatingDate:'2025-01-01'});
 const wrong=setup({flights:[closed],offloadUlds:[{FlightId:'2',UldId:'7',UldNumber:'AKE12345CX'}]});
 assert.equal((await call(wrong.handler,'POST',body)).body.code,'ULD_CONTEXT_MISMATCH');
 assert.equal(wrong.state.offload,null);
 const h=setup({flights:[closed]});
 const results=await Promise.all([call(h.handler,'POST',body),call(h.handler,'POST',body)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 assert.equal(results.find(r=>r.status===409).body.offloadId,'90');
 assert.equal(h.state.audits.length,1);assert.equal(h.state.commits,1);assert.equal(h.state.flights[0].FlightStatus,'CLOSED');
 const retry=await call(h.handler,'POST',body);
 assert.equal(retry.body.code,'OFFLOAD_EXISTS');assert.equal(retry.body.offloadId,'90');assert.equal(h.state.audits.length,1);
});

test('same historical flight number on different dates uses exact FlightId and owned UldId',async()=>{
 const h=setup({flights:[flight({FlightId:'2',OperatingDate:'2025-01-02',FlightStatus:'CLOSED'}),flight({FlightId:'1',OperatingDate:'2025-01-01',FlightStatus:'CLOSED'})],
  offloadUlds:[{FlightId:'2',UldId:'8',UldNumber:'AKE12345CX'},{FlightId:'1',UldId:'7',UldNumber:'AKE12345CX'}]});
 const r=await call(h.handler,'POST',{...body,flightNumber:'CX178',operatingDate:'2025-01-01'});
 assert.equal(r.status,201);assert.equal(r.body.offload.flightId,'1');assert.equal(r.body.offload.uldId,'7');
 assert.deepEqual(h.state.flights.map(f=>f.FlightStatus),['CLOSED','CLOSED']);
 const wrongDate=await call(h.handler,'POST',{...body,operatingDate:'2025-01-02'});
 assert.equal(wrongDate.body.code,'FLIGHT_CONTEXT_MISMATCH');
});

test('COMPLETE history permanently blocks a matching ULD while mismatched legacy Offload 12 stays untouched',async()=>{
 const h=setup();h.state.extraOffloads.push({OffloadId:'12',FlightId:'25',UldId:null,UldNumber:'AKE88888CX',OffloadStatus:'COMPLETE'}, {OffloadId:'11',FlightId:'1',UldId:'7',UldNumber:'AKE12345CX',OffloadStatus:'COMPLETE'});
 const before=structuredClone(h.state.extraOffloads);const r=await call(h.handler,'POST',body);
 assert.equal(r.status,409);assert.equal(r.body.code,'OFFLOAD_EXISTS');assert.equal(r.body.offloadId,'11');
 assert.equal(h.state.offload,null);assert.equal(h.state.audits.length,0);assert.deepEqual(h.state.extraOffloads,before);
});

test('legacy Offload 9 without authoritative FlightId fails closed before transition or audit',async()=>{
 const h=setup({offload:{OffloadId:'9',FlightId:null,UldId:null,UldNumber:'QKE52521QR',OffloadStatus:'REQUESTED'}});
 const collect={offloadId:'9',expectedCurrentStatus:'REQUESTED',nextStatus:'TRANSIT'};
 const response=await call(h.handler,'PATCH',collect);
 assert.equal(response.status,404);assert.equal(response.body.code,'OPERATIONAL_ENTITY_NOT_AVAILABLE');
 assert.equal(h.state.offload.OffloadStatus,'REQUESTED');
 assert.equal(h.state.offload.FlightId,null);assert.equal(h.state.offload.UldId,null);assert.equal(h.state.audits.length,0);
 assert.equal(h.state.queries.some(x=>x.q.includes('FROM dbo.Flights')),false);
});

test('live-schema required audit failure rolls back creation',async()=>{
 const h=setup();h.state.failAudit=true;const r=await call(h.handler,'POST',body);
 assert.equal(r.status,500);assert.equal(h.state.offload,null);assert.equal(h.state.audits.length,0);
});

test('before migration both new creation and stationless legacy transition fail closed',async()=>{
 const h=setup({migrated:false,offload:{OffloadId:'9',FlightId:null,UldNumber:'QKE52521QR',OffloadStatus:'REQUESTED'}});
 const r=await call(h.handler,'POST',body);assert.equal(r.status,503);assert.equal(r.body.code,'OFFLOAD_SCHEMA_NOT_READY');
 assert.equal(h.state.audits.length,0);
 const transition=await call(h.handler,'PATCH',{offloadId:'9',expectedCurrentStatus:'REQUESTED',nextStatus:'TRANSIT'});
 assert.equal(transition.status,404);assert.equal(transition.body.code,'OPERATIONAL_ENTITY_NOT_AVAILABLE');
 assert.equal(h.state.offload.OffloadStatus,'REQUESTED');
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
 const elements={};for(const id of ['offFlightId','offFlightContext','offSelectAll','offUldCandidates','offBlockedUlds','offSubmit','offBay','offInstruction','offRequestMessage'])elements[id]={value:'',disabled:false,innerHTML:'',textContent:'',checked:false,indeterminate:false};
 elements.modal={classList:{contains:()=>true}};const requests=[],notices=[],cargoRunAccess={status:'provisioned'},operationalSessionGeneration=1;
 const context=vm.createContext({document:{getElementById:id=>elements[id]},modal(){},modalHead:()=>'',esc:String,azureDisplayDate:String,
  stableOperationalId:x=>/^[1-9]\d*$/.test(String(x??'').trim())?String(x).trim():'',
  fetch:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve})),toast:x=>notices.push(x),showActionLoader(){},hideActionLoader(){},closeModal(){},openScreen(){},syncAzureOffloads:async()=>true,
  cargoRunAccess,operationalSessionGeneration,
  operationalSessionIsCurrent:generation=>generation===operationalSessionGeneration&&cargoRunAccess.status==='provisioned'});
 vm.runInContext(html.slice(html.indexOf('let offloadRequestSession='),html.indexOf('function handleOffload(')),context);
 const respond=(i,data,status=200)=>requests[i].resolve({ok:status<400,status,json:async()=>data});
 return {context,elements,requests,respond,notices};
}
async function startUi(){const h=ui();const pending=h.context.showRequestOffload();h.respond(0,{flights:[{flightId:'1',flightNumber:'CX178',operatingDate:'2026-09-17',flightStatus:'ACTIVE'},{flightId:'2',flightNumber:'CX178',operatingDate:'2026-09-18',flightStatus:'CLOSED'}]});await pending;return h}

test('historical same-number flight choices expose date/status/FlightId and keep exact selection',async()=>{
 const h=await startUi();
 assert.match(h.elements.offFlightId.innerHTML,/CX178.*2026-09-17.*Active.*FlightId 1/);
 assert.match(h.elements.offFlightId.innerHTML,/CX178.*2026-09-18.*Closed.*FlightId 2/);
 h.elements.offFlightId.value='2';const loading=h.context.loadOffloadUlds();
 assert.equal(h.requests[1].url,'/api/offloads?eligibleUlds=true&flightId=2');
 h.respond(1,{ulds:[{FlightId:'2',UldId:'8',UldNumber:'AKE12345CX',CurrentStatus:'AT_AIRCRAFT'}],blockedUlds:[]});await loading;
 h.context.toggleAllEligible(true);h.elements.offBay.value='F25';h.elements.offInstruction.value='Return to terminal';h.context.updateOffloadSubmit();
 const creating=h.context.createOffloads();const payload=JSON.parse(h.requests[2].options.body);
 assert.deepEqual(payload,{action:'BULK_CREATE',flightId:'2',uldIds:['8'],parkingBay:'F25',requestInstruction:'Return to terminal'});
 h.respond(2,{ok:true,count:1},201);await creating;
});

test('flight switching clears stable UldIds and ignores the prior flight response',async()=>{
 const h=await startUi();h.elements.offFlightId.value='1';const first=h.context.loadOffloadUlds();
 h.elements.offFlightId.value='2';const second=h.context.loadOffloadUlds();
 assert.equal(h.elements.offSubmit.disabled,true);
 h.respond(2,{ulds:[{FlightId:'2',UldId:'8',UldNumber:'PMC22222CX'}],blockedUlds:[]});await second;
 h.context.toggleAllEligible(true);
 h.respond(1,{ulds:[{FlightId:'1',UldId:'7',UldNumber:'AKE12345CX'}],blockedUlds:[]});await first;
 assert.match(h.elements.offUldCandidates.innerHTML,/PMC22222CX/);assert.doesNotMatch(h.elements.offUldCandidates.innerHTML,/AKE12345CX/);
 assert.equal(h.elements.offSubmit.textContent,'Create 1 Offload');
});

test('wrong-flight eligibility response and tampered selected UldId cannot submit',async()=>{
 const h=await startUi();h.elements.offFlightId.value='1';let loading=h.context.loadOffloadUlds();
 h.respond(1,{ulds:[{FlightId:'2',UldId:'8',UldNumber:'PMC22222CX'}],blockedUlds:[]});await loading;
 assert.equal(h.elements.offSubmit.disabled,true);assert.match(h.elements.offRequestMessage.textContent,/does not match/);
 h.elements.offFlightId.value='1';loading=h.context.loadOffloadUlds();h.respond(2,{ulds:[{FlightId:'1',UldId:'7',UldNumber:'AKE12345CX'}],blockedUlds:[]});await loading;
 h.context.toggleOffloadUld('999',true);h.elements.offBay.value='F25';h.elements.offInstruction.value='Return';await h.context.createOffloads();
 assert.equal(h.requests.length,3);
});

test('blocked legacy and exact offload evidence is explanatory and never selectable',async()=>{
 const h=await startUi();h.elements.offFlightId.value='1';const loading=h.context.loadOffloadUlds();
 h.respond(1,{ulds:[],blockedUlds:[
  {FlightId:'1',UldId:'7',UldNumber:'AKE12345CX',ReasonCode:'OFFLOAD_EXISTS',ExistingOffloadId:'40',ExistingOffloadStatus:'COMPLETE'},
  {FlightId:'1',UldId:'8',UldNumber:'PMC22222CX',ReasonCode:'OFFLOAD_IDENTITY_CONFLICT'}
 ]});await loading;
 assert.match(h.elements.offBlockedUlds.innerHTML,/AKE12345CX/);assert.match(h.elements.offBlockedUlds.innerHTML,/COMPLETE \/ Offload #40/);
 assert.match(h.elements.offBlockedUlds.innerHTML,/PMC22222CX/);assert.doesNotMatch(h.elements.offBlockedUlds.innerHTML,/type="checkbox"/);
 assert.equal(h.elements.offSubmit.disabled,true);
});
