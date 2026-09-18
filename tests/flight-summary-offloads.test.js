'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function sourceBetween(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source range ${start} -> ${end}`);
  return html.slice(from, to);
}

function harness() {
  const requests = [];
  const state = {offloads: [], completedOffloads: []};
  const context = vm.createContext({
    state,
    stableOperationalId(value) {
      const id = String(value ?? '').trim();
      return /^[1-9]\d*$/.test(id) ? id : '';
    },
    toMs(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      const parsed = value ? Date.parse(value) : NaN;
      return Number.isFinite(parsed) ? parsed : null;
    },
    esc: value => String(value ?? ''),
    slug: value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    azureStatusToUi: value => ({REQUESTED:'Requested',TRANSIT:'Transit',COMPLETE:'Complete'}[String(value).toUpperCase()] || String(value)),
    fmtDateTime: value => new Date(value).toISOString(),
    azureDisplayDate: value => String(value || ''),
    azureOffloadToUi: value => ({
      azureOffloadId: String(value.offloadId), flightId: String(value.flightId), uldId: value.uldId == null ? null : String(value.uldId),
      uld: value.uldNumber, bay: value.parkingBay, status: ({REQUESTED:'Requested',TRANSIT:'Transit',COMPLETE:'Complete'}[value.status] || value.status),
      requestedAtKnown: value.requestedAtUtc ? Date.parse(value.requestedAtUtc) : null, requestedBy: value.requestedByDisplayName || '',
      collectedAt: value.collectedAtUtc ? Date.parse(value.collectedAtUtc) : null, collectedBy: value.collectedByDisplayName || '',
      completedAt: value.deliveredAtUtc ? Date.parse(value.deliveredAtUtc) : null, deliveredBy: value.deliveredByDisplayName || '',
      location: value.deliveredLocation || '', requestInstruction: value.requestInstruction || '', completionNote: value.completionNote || ''
    }),
    fetch: async (url, options) => { requests.push({url, options}); return {ok:true,status:200,json:async()=>({ok:true,flight:{flightId:'25',flightNumber:'CX163',operatingDate:'2026-09-18',flightStatus:'CLOSED'},offloads:[]})}; },
    encodeURIComponent,
    showActionLoader() {}, hideActionLoader() {}, modal() {}, modalHead: value => value, toast() {}, closeModal() {},
    window: {open: () => null}, document: {}, setTimeout() {}, console
  });
  vm.runInContext(sourceBetween('function compareFlightSummaryOffloads(', 'function remoteAuditToUi('), context);
  return {context, state, requests};
}

function offload(overrides={}) {
  return {
    azureOffloadId:'10', flightId:'25', uldId:'7', uld:'AKE12345CX', bay:'F25', status:'Requested',
    requestedAtKnown:Date.parse('2026-09-18T01:00:00Z'), requestedBy:'Planner', collectedAt:null, collectedBy:'',
    completedAt:null, deliveredBy:'', location:'', requestInstruction:'Keep chilled', completionNote:'', ...overrides
  };
}

test('flight with no offloads renders the required empty state',()=>{
  const h=harness();
  assert.match(h.context.flightOffloadsSection('25',[]),/OFFLOADS/);
  assert.match(h.context.flightOffloadsSection('25',[]),/No offloads recorded for this flight\./);
});

test('requested and completed offloads render available operational fields',()=>{
  const h=harness();
  const requested=offload();
  const complete=offload({azureOffloadId:'11',uldId:'8',uld:'PMC48921R7',status:'Complete',requestedAtKnown:Date.parse('2026-09-18T02:00:00Z'),collectedAt:Date.parse('2026-09-18T02:10:00Z'),collectedBy:'Runner One',completedAt:Date.parse('2026-09-18T02:20:00Z'),deliveredBy:'Runner Two',location:'Cool Room 4',completionNote:'Delivered intact'});
  const rendered=h.context.flightOffloadsSection('25',[complete,requested]);
  assert.ok(rendered.indexOf('AKE12345CX')<rendered.indexOf('PMC48921R7'));
  for(const expected of ['Offload #10','ULD ID 7','F25','Requested','Planner','Keep chilled','Complete','Runner One','Runner Two','Cool Room 4','Delivered intact'])assert.match(rendered,new RegExp(expected));
});

test('requested timestamp then OffloadId determines stable order',()=>{
  const h=harness(),same=Date.parse('2026-09-18T01:00:00Z');
  const rows=[offload({azureOffloadId:'12',uld:'ULD12',requestedAtKnown:same}),offload({azureOffloadId:'11',uld:'ULD11',requestedAtKnown:same}),offload({azureOffloadId:'20',uld:'ULD20',requestedAtKnown:null})];
  assert.deepEqual(Array.from(h.context.offloadsForFlightSummary('25',rows),o=>o.azureOffloadId),['11','12','20']);
});

test('exact FlightId filtering prevents same ULD on another flight from leaking',()=>{
  const h=harness();
  const rows=[offload(),offload({azureOffloadId:'20',flightId:'26',uldId:'17',uld:'AKE12345CX'})];
  const selected=h.context.offloadsForFlightSummary('25',rows);
  assert.equal(selected.length,1);assert.equal(selected[0].azureOffloadId,'10');
});

test('missing optional fields do not break rendering',()=>{
  const h=harness();
  assert.doesNotThrow(()=>h.context.flightOffloadsSection('25',[offload({uldId:null,bay:'',requestedAtKnown:null,requestedBy:'',requestInstruction:'',completionNote:''})]));
  assert.match(h.context.flightOffloadsSection('25',[offload({uldId:null,bay:'',requestedAtKnown:null})]),/Bay \/ location[\s\S]*—/);
});

test('live summary load is an exact read-only FlightId request',async()=>{
  const h=harness();
  const summary=await h.context.loadFlightSummary('25');
  assert.equal(summary.flight.flightStatus,'CLOSED');
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/api/offloads?flightId=25');
  assert.equal(h.requests[0].options.method,undefined);
  await assert.rejects(()=>h.context.loadFlightSummary('CX163'),/valid FlightId/);
});

test('ACTIVE, CLOSED and FINALISED lifecycle labels render without changing data',()=>{
  const h=harness();
  for(const flightStatus of ['ACTIVE','CLOSED','FINALISED','FINALIZED']){
    const summary={flight:{flightId:'25',flightNumber:'CX163',operatingDate:'2026-09-18',flightStatus},offloads:[offload()]};
    const before=structuredClone(summary);
    assert.match(h.context.currentFlightSummaryBody(summary),new RegExp(flightStatus));
    assert.deepEqual(summary,before);
  }
});

test('print summary contains OFFLOADS while immutable V1 print stays snapshot-only',()=>{
  const h=harness();
  const printed=h.context.flightSummaryHtml({flight:{flightId:'25',flightNumber:'CX163',operatingDate:'2026-09-18',flightStatus:'FINALISED'},offloads:[offload()]});
  assert.match(printed,/OFFLOADS/);assert.match(printed,/AKE12345CX/);assert.match(printed,/current operational summary/i);
  const immutableSource=sourceBetween('function completionRecordHtml(', 'function downloadCompletedExport(');
  assert.doesNotMatch(immutableSource,/flightOffloadsSection|loadFlightSummary|state\.offloads/);
  assert.match(html,/immutable V1 completion record/);
  assert.match(html,/showFlightSummary\('\$\{r\.flightId\}'\)/);
});

