'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function between(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return html.slice(from, to);
}
const stations = [
  { stationId: '1', stationCode: 'MEL', displayName: 'Melbourne', timeZoneId: 'Australia/Melbourne' },
  { stationId: '2', stationCode: 'AKL', displayName: 'Auckland', timeZoneId: 'Pacific/Auckland' }
].map(s => ({ ...s, capabilities: ['UPLOAD_FLIGHT_DATA', 'CONFIRM_EXPORT_FINAL'] }));
function page(selected = 'AKL', instant = '2026-10-10T13:30:00Z') {
  const requests = [], effects = [], notices = [], textarea = { value: '<synthetic-FOW/>' };
  class Clock extends Date { static now() { return Date.parse(instant); } }
  const context = vm.createContext({
    Date: Clock, Intl, Set, Map, console: { error() {} },
    document: { getElementById: id => id === 'machFowXml' ? textarea : null },
    state: { exports: [] }, pendingFlightUpload: null,
    toast: message => notices.push(message),
    showActionLoader() {}, hideActionLoader() {},
    logEvent: () => effects.push('log'), currentUser: () => ({name:'Synthetic user'}),
    syncCentralData: async () => effects.push('sync'),
    loadMachFowRecent: async () => effects.push('messages'),
    openScreen: () => effects.push('screen'), save: () => effects.push('save'), closeModal() {},
    deferOperational: () => effects.push('deferred'),
    stableOperationalId: value => /^[1-9]\d*$/.test(String(value)) ? String(value) : '',
    cargoRunUwsDraft: () => ({ flight: 'CX134', sourceFile: 'synthetic.xlsx' }),
    findFlightByStableId: () => context.state.exports[0],
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); requests.push({url,method:options.method,body});
      return {ok:true,json:async()=>({ok:true,duplicate:true,document:{},exactMatch:{flightId:'81'}})};
    }
  });
  vm.runInContext(between('let cargoRunAccess=', 'function deferOperational('), context);
  vm.runInContext(between('function validHistoryDateKey(', 'function previousHistoryDateKey('), context);
  vm.runInContext('cargoRunAccess=' + JSON.stringify({status:'provisioned',stationMetadata:stations}) + ';selectedStationId=' + JSON.stringify(stations.find(s=>s.stationCode===selected).stationId), context);
  vm.runInContext(between('function fowSampleXml(){', 'async function loadMachFowRecent('), context);
  vm.runInContext(between('async function processMachFow(){', 'function machFowScreen('), context);
  vm.runInContext(between('async function parseExportUwsWorkbook(', 'async function parseCargoRunWorkbook('), context);
  vm.runInContext(between('async function reviewExportUwsUpload(', 'async function createUploadedFlight('), context);
  return {context, requests, effects, notices, textarea};
}
function generation(p) { return vm.runInContext('operationalSessionGeneration', p.context); }
function switchSelection(p) {
  // A completed session/station switch invalidates pending requests. The actual
  // purge/switch functions are covered by the existing session/cache suites.
  vm.runInContext('operationalSessionGeneration++;selectedStationId="1";pendingFlightUpload=null;', p.context);
}
for (const station of stations) {
  test('H1 browser sends captured '+station.stationCode+' station for FOW and both UWS actions', async () => {
    const p=page(station.stationCode), workbook={sheets:[]};
    p.context.state.exports=[{azureFlightId:'81'}];
    await p.context.processMachFow();
    const draft=await p.context.parseExportUwsWorkbook(workbook,'synthetic.xlsx',generation(p));
    await p.context.reviewExportUwsUpload(draft);
    assert.equal(p.requests.length,3);
    assert.deepEqual(p.requests.map(r=>r.body.stationId),Array(3).fill(station.stationId));
    assert.deepEqual(p.requests.map(r=>r.url),['/api/mach-fow','/api/manifest-upload','/api/manifest-upload']);
    assert.ok(p.requests.every(r=>r.method==='POST'));
    assert.equal(p.requests[0].body.xml,p.textarea.value,'never rewrite the submitted document');
    assert.deepEqual(p.requests[1].body.workbook,workbook);
    assert.deepEqual(p.requests[2].body.workbook,workbook);
    assert.equal(draft._stationId,station.stationId);
    assert.equal(p.notices.some(t=>/does not match|could not/.test(t)),false);
  });
}
for (const kind of ['FOW','PARSE_EXPORT_UWS','REVIEW_EXPORT_UWS']) {
  test('H1 '+kind+' captures AKL before await and ignores a late reply after switching to MEL',async()=>{
    const p=page(),draft={_stationId:'2',_workbook:{sheets:[]},exactFlightId:'81',flight:'CX134'};
    let finish;
    p.context.fetch=async(url,options)=>{
      p.requests.push({url,body:JSON.parse(options.body)});
      return new Promise(resolve=>{finish=resolve;});
    };
    const pending=kind==='FOW'?p.context.processMachFow():kind==='PARSE_EXPORT_UWS'
      ?p.context.parseExportUwsWorkbook(draft._workbook,'synthetic.xlsx',generation(p)):p.context.reviewExportUwsUpload(draft);
    switchSelection(p);
    finish({ok:true,json:async()=>({ok:true,duplicate:true,document:{},exactMatch:{flightId:'81'}})});
    await pending;
    assert.equal(p.requests[0].body.stationId,'2');
    assert.deepEqual(p.effects,[]);assert.deepEqual(p.notices,[]);
    assert.equal(p.context.state.exports.length,0);
  });
  test('H1 '+kind+' rejected response cannot display success or update operational UI',async()=>{
    const p=page(),draft={_stationId:'2',_workbook:{sheets:[]},exactFlightId:'81'};
    p.context.fetch=async()=>({ok:false,status:422,json:async()=>({ok:false,code:'DOCUMENT_STATION_MISMATCH',error:'Document station MEL does not match selected station AKL. No changes were made.'})});
    if(kind==='PARSE_EXPORT_UWS')await assert.rejects(p.context.parseExportUwsWorkbook(draft._workbook,'synthetic.xlsx',generation(p)),/does not match selected station AKL/);
    else {
      await (kind==='FOW'?p.context.processMachFow():p.context.reviewExportUwsUpload(draft));
      assert.match(p.notices[0],/does not match selected station AKL/);
    }
    assert.deepEqual(p.effects,[]);
  });
}
test('H1 UWS draft from another station or without station provenance cannot submit a review',async()=>{
  const p=page('MEL');
  for(const id of [undefined,'2'])await p.context.reviewExportUwsUpload({_stationId:id,_workbook:{},exactFlightId:'81'});
  assert.equal(p.requests.length,0);assert.equal(p.notices.length,2);
});
const localCases = [
  ['2026-10-10T12:30:00Z','10-Oct-2026','2330','11-Oct-2026','0130'],
  ['2026-10-10T13:30:00Z','11-Oct-2026','0030','11-Oct-2026','0230'],
  // Melbourne spring gap / autumn repeated hour; Auckland spring gap / autumn repeated hour.
  ['2026-10-03T15:59:00Z','04-Oct-2026','0159','04-Oct-2026','0459'],
  ['2026-10-03T16:00:00Z','04-Oct-2026','0300','04-Oct-2026','0500'],
  ['2026-09-26T13:59:00Z','26-Sep-2026','2359','27-Sep-2026','0159'],
  ['2026-09-26T14:00:00Z','27-Sep-2026','0000','27-Sep-2026','0300'],
  ['2026-04-04T13:59:00Z','05-Apr-2026','0059','05-Apr-2026','0259'],
  ['2026-04-04T14:00:00Z','05-Apr-2026','0100','05-Apr-2026','0200'],
  ['2026-04-04T14:59:00Z','05-Apr-2026','0159','05-Apr-2026','0259'],
  ['2026-04-04T15:00:00Z','05-Apr-2026','0200','05-Apr-2026','0300'],
  ['2026-04-04T16:00:00Z','05-Apr-2026','0200','05-Apr-2026','0400']
];
for(const [instant,melDate,melTime,aklDate,aklTime] of localCases){
  test('H1 sample uses station local date/time at '+instant,()=>{
    for(const [port,date,time] of [['MEL',melDate,melTime],['AKL',aklDate,aklTime]]){
      const xml=page(port,instant).context.fowSampleXml();
      for(const tag of ['OrigApt','StsSegDep','StsApt'])assert.ok(xml.includes('<'+tag+'>'+port+'</'+tag+'>'));
      assert.ok(xml.includes('<StsDatt>'+date+'</StsDatt>'),port+' date');
      assert.ok(xml.includes('<StsTime>'+time+'</StsTime>'),port+' time');
    }
  });
}
test('H1 sample refuses missing selected station or invalid timezone',()=>{
  const p=page();
  vm.runInContext('selectedStationId=""',p.context);
  assert.throws(()=>p.context.fowSampleXml(),/valid timezone/);
  vm.runInContext('selectedStationId="2";cargoRunAccess.stationMetadata[1].timeZoneId="Invalid/Timezone"',p.context);
  assert.throws(()=>p.context.fowSampleXml(),/valid timezone/);
});
