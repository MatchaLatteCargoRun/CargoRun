'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function sourceBetween(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source range ${start} -> ${end}`);
  return html.slice(from, to);
}

test('phone and tablet widths use the isolated operational information architecture', () => {
  assert.match(html, /function isMobileUI\(\)\{return window\.matchMedia&&window\.matchMedia\('\(max-width:1024px\)'\)\.matches\}/);
  assert.match(html, /@media\(max-width:1024px\)\{[\s\S]*\.desktop-nav,\.topbar-account[\s\S]*\.mobile-bottom-nav\{display:grid\}/);
  assert.match(html, /\.shell\{width:min\(820px,100%\)/);
});

test('mobile home contains only the four operational module tiles', () => {
  const source = sourceBetween('function mobileHome(', 'function mobileFlightsHub(');
  for (const module of ['imports', 'exports', 'offloads', 'priority']) {
    assert.match(source, new RegExp(`tile\\('${module}'`));
    assert.match(source, new RegExp(`data-mobile-module="\\$\\{kind\\}"`));
  }
  assert.doesNotMatch(source, /showUploadFlightData|openScreen\('history'\)|openScreen\('supervisor'\)|showScan/);
  assert.doesNotMatch(source, /mobile-module-icon|HOME_ICON_PATH|<img/);
  assert.match(source, /mobileModuleArtwork\(kind\)/);
  assert.match(source, /im\.reduce\(\(n,f\)=>n\+counts\(f,'imports'\)\.done,0\)/);
  assert.match(source, /ex\.reduce\(\(n,f\)=>n\+counts\(f,'exports'\)\.done,0\)/);
  assert.match(source, /onclick="openScreen\('\$\{screen\}'\$\{type\?`,'\$\{type\}'`:''\}\)"/);
  assert.match(html, /\.mobile-module-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /\.mobile-module-art\{position:absolute[\s\S]*height:61%[\s\S]*overflow:hidden[\s\S]*mask-image:linear-gradient/);
  assert.match(html, /\.mobile-module-art-image\{position:absolute[\s\S]*top:50%[\s\S]*width:112%[\s\S]*height:auto[\s\S]*transform:translate\(-50%,-54%\)/);
  assert.match(html, /@media\(min-width:701px\) and \(max-width:1024px\)\{[\s\S]*\.mobile-module-art-image\{top:50%;width:100%\}/);
  assert.match(html, /\.mobile-module-copy\{position:relative;z-index:1/);
});

test('mobile Home uses the same four exact approved assets as bottom navigation', () => {
  const context = vm.createContext({});
  vm.runInContext(sourceBetween('const MOBILE_NAV_ART=', 'function mobileHome('), context);
  const expected = {
    imports: 'assets/mobile-art/rider_on_descending_airplane_icon.png',
    exports: 'assets/mobile-art/white_airplane_rider_takeoff_icon.png',
    offloads: 'assets/mobile-art/white_parachute_cargo_icon.png',
    priority: 'assets/mobile-art/priority_courier_in_motion.png'
  };
  for (const [kind, asset] of Object.entries(expected)) {
    const artwork = context.mobileModuleArtwork(kind);
    const navArtwork = context.mobileNavArtwork(kind);
    assert.match(artwork, new RegExp(`^<span class="mobile-module-art artwork-${kind}" data-module-art="${kind}"`));
    assert.ok(artwork.includes(`src="${asset}"`));
    assert.ok(navArtwork.includes(`src="${asset}"`));
    assert.match(artwork, /<img class="mobile-module-art-image"[\s\S]*width="1254" height="1254" alt="" draggable="false"/);
    assert.doesNotMatch(artwork, /<svg/);
    const bytes = fs.readFileSync(path.resolve(__dirname, '..', asset));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), 1254);
    assert.equal(bytes.readUInt32BE(20), 1254);
  }
  assert.doesNotMatch(html, /cargo_imports_dashboard_card|exports_dashboard_card|offloads_21_active_retrieval_work|priority_courier_cargo_card/);
  assert.doesNotMatch(html, /mobileAircraftRiderShapes|mobileAircraftMotionLines|mobileOffloadShapes|mobilePriorityRunnerShapes|mobileArtworkScene|mobileArtworkSvg/);
});

test('mobile bottom navigation is limited to Home and four operational areas', () => {
  const source = sourceBetween('function mobileBottomNav(', 'function fowSampleXml(');
  assert.match(source, /item\('home','Home',home,'home'\)/);
  assert.match(source, /item\('imports','Imports',imports,'flights','imports'\)/);
  assert.match(source, /item\('exports','Exports',exports,'flights','exports'\)/);
  assert.match(source, /item\('offloads','Offloads',off,'offloads'\)/);
  assert.match(source, /item\('priority','Priority',priority,'priority'\)/);
  assert.doesNotMatch(source, /More|History|Scan|Supervisor|Admin|↙|↗|◇/);
  assert.match(source, /data-mobile-nav="\$\{kind\}"/);
  assert.match(source, /aria-current="\$\{active\?'page':'false'\}"/);
  assert.match(source, /mobileNavArtwork\(kind\)/);
  assert.match(html, /\.mobile-nav-art\{display:block;width:28px;height:28px;object-fit:contain/);
  assert.match(html, /\.mobile-nav-btn:not\(\.active\) \.mobile-nav-art\{opacity:\.58\}/);
  assert.match(source, /<span class="mobile-nav-icon">\$\{mobileNavArtwork\(kind\)\}<\/span>/);
  assert.doesNotMatch(source, /kind==='home'\?'home'/);
  assert.doesNotMatch(html, /\.mobile-nav-btn\.active \.mobile-nav-icon\.home/);
});

test('bottom navigation uses the four dedicated approved assets and keeps Home as a house', () => {
  const context = vm.createContext({});
  vm.runInContext(sourceBetween('const MOBILE_NAV_ART=', 'function mobileHome('), context);
  const home = context.mobileNavArtwork('home');
  assert.match(home, /nav-art-home[\s\S]*data-nav-art="home"[\s\S]*<path/);
  assert.doesNotMatch(home, /<img/);
  const expected = {
    imports: 'assets/mobile-art/rider_on_descending_airplane_icon.png',
    exports: 'assets/mobile-art/white_airplane_rider_takeoff_icon.png',
    offloads: 'assets/mobile-art/white_parachute_cargo_icon.png',
    priority: 'assets/mobile-art/priority_courier_in_motion.png'
  };
  for (const [kind, asset] of Object.entries(expected)) {
    const artwork = context.mobileNavArtwork(kind);
    assert.match(artwork, new RegExp(`^<img class="mobile-nav-art nav-art-${kind}" data-nav-art="${kind}"`));
    assert.ok(artwork.includes(`src="${asset}"`));
    assert.match(artwork, /width="1254" height="1254" alt="" aria-hidden="true" draggable="false"/);
    assert.doesNotMatch(artwork, /<svg/);
    const bytes = fs.readFileSync(path.resolve(__dirname, '..', asset));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), 1254);
    assert.equal(bytes.readUInt32BE(20), 1254);
  }
});

test('mobile flight cards show export ETD and tidy import priority state', () => {
  const context = vm.createContext({
    counts: () => ({ done: 2, total: 4 }), pct: () => 50,
    flightBoardState: () => ({ cls: 'clear', level: 'green', label: 'Loading' }),
    handlingCounts: () => ({ intact: 0, breakdown: 0 }),
    flightPriorityTags: flight => flight.priorityTags || [],
    flightBoardFlightMeta: () => ({ route: 'MEL → HKG', date: '20 Sep 2026' }),
    exportDepartureMs: flight => flight.departure || 0,
    fmtTime: value => value === 123 ? '21:48' : '—',
    airlineBadge: () => '<badge />', manifestStateBadge: () => '',
    priorityBadges: () => '', esc: value => String(value ?? '')
  });
  vm.runInContext(sourceBetween('function mobileFlightCard(', 'function mobileHome('), context);
  const exportWithEtd = context.mobileFlightCard({ azureFlightId: '501', flight: 'CX0998', departure: 123 }, 'exports');
  assert.match(exportWithEtd, />ETD 21:48<\/span>/);
  assert.doesNotMatch(exportWithEtd, />Loading<\/span>/i);
  const exportWithoutEtd = context.mobileFlightCard({ azureFlightId: '502', flight: 'CX0999' }, 'exports');
  assert.match(exportWithoutEtd, /mobile-flight-status neutral">ETD —<\/span>/);
  const priorityImport = context.mobileFlightCard({ azureFlightId: '601', flight: 'CX0163', priorityTags: [{ level: 'critical' }] }, 'imports');
  assert.match(priorityImport, /mobile-flight-status red">PRIORITY<\/span>/);
  const standardImport = context.mobileFlightCard({ azureFlightId: '602', flight: 'CX0164' }, 'imports');
  assert.match(standardImport, /mobile-flight-status green">ACTIVE<\/span>/);
});

test('mobile flight list exposes route, operating date, counts, and exact FlightId', () => {
  const source = sourceBetween('function mobileFlightCard(', 'function mobileHome(');
  assert.match(source, /flightBoardFlightMeta\(f,type\)/);
  assert.match(source, /mobile-flight-route/);
  assert.match(source, /mobile-flight-date/);
  assert.match(source, /outstanding/);
  assert.match(source, /data-flight-id="\$\{esc\(f\.azureFlightId\|\|''\)\}"/);
  assert.match(source, /selectDesktopFlightByStableId\('\$\{type\}','\$\{esc\(f\.azureFlightId\|\|''\)\}'\)/);
});

test('mobile detail resolves duplicate visible flight numbers by authoritative FlightId', () => {
  const state = { imports: [
    { id: 'duplicate', azureFlightId: '101', flight: 'CX0163', flightDate: '15 Sep 2026', originAirport: 'HKG', ulds: [], closed: false },
    { id: 'duplicate', azureFlightId: '102', flight: 'CX0163', flightDate: '14 Sep 2026', originAirport: 'HKG', ulds: [], closed: false }
  ] };
  const context = vm.createContext({
    state,
    FLIGHTAWARE_ENABLED: false,
    stableOperationalId: value => /^[1-9]\d*$/.test(String(value || '')) ? String(value) : '',
    findFlightByStableId: (type, id) => state[type].find(flight => String(flight.azureFlightId) === String(id)) || null,
    counts: () => ({ done: 0, total: 0 }), pct: () => 0,
    airlineMeta: () => ({ name: 'Cathay Pacific' }), flightBoardState: () => ({ level: 'green', label: 'On time' }),
    expectedUldsForFlight: () => [], importSummaryForFlight: () => ({ expected: 0, received: 0, outstanding: 0 }),
    handlingCounts: () => ({ intact: 0, breakdown: 0 }),
    flightBoardFlightMeta: flight => ({ route: 'HKG → MEL', date: flight.flightDate }),
    airlineBadge: () => '<badge />', manifestStateBadge: () => '', manifestFinalNote: () => '', exportDepartureMs: () => 0,
    mobileArrivalPanel: () => '<arrival />', mobileUldCard: () => '', flightOffloadsSection: () => '',
    esc: value => String(value ?? '')
  });
  vm.runInContext(sourceBetween('function mobileFlightDetail(', 'function operationalOffloadRequestedAt('), context);
  const rendered = context.mobileFlightDetail('imports', 'duplicate', '102');
  assert.match(rendered, /data-selected-flight-id="102"/);
  assert.match(rendered, /14 Sep 2026/);
  assert.doesNotMatch(rendered, /15 Sep 2026/);
  assert.doesNotMatch(rendered, /Sync arrival/);
  assert.match(rendered, /Set In Block/);
});

test('mobile Import offers separate ULD and ELD actions while Export has no manual add action', () => {
  const source = sourceBetween('function mobileFlightDetail(', 'function operationalOffloadRequestedAt(');
  assert.match(source, /data-mobile-add-uld/);
  assert.match(source, /data-mobile-add-eld/);
  assert.match(source, /showAddImportUld\('\$\{esc\(f\.azureFlightId\|\|''\)\}',true\)/);
  assert.match(source, /\$\{isImport\?`<div class="mobile-add-actions">[\s\S]*`:''\}/);
  const dialog = sourceBetween('function showAddImportUld(', 'async function addImportUld(');
  assert.match(dialog, /defaultIsEld=false/);
  assert.match(dialog, /\$\{eld\?'checked':''\}/);
});

test('mobile ULD actions retain exact FlightId and UldId', () => {
  const source = sourceBetween('function mobileUldCard(', 'function mobileFlightDetail(');
  assert.match(source, /data-flight-id="\$\{esc\(f\.azureFlightId\|\|''\)\}" data-uld-id="\$\{esc\(u\.azureUldId\|\|''\)\}"/);
  assert.match(source, /showConfirmULD\('\$\{type\}','\$\{f\.azureFlightId\|\|''\}','\$\{u\.azureUldId\|\|''\}'\)/);
});

test('Offload and Priority use flight-group list screens before actionable detail', () => {
  const source = sourceBetween('function mobileOffloadGroupKey(', 'function historyActorKey(');
  assert.match(source, /flight-\$\{flightId\}/);
  assert.match(source, /openScreen\('offloads','detail','\$\{esc\(group\.key\)\}'\)/);
  assert.match(source, /handleOffload\('\$\{esc\(id\|\|''\)\}'\)/);
  assert.match(source, /openScreen\('priority','detail','\$\{esc\(group\.key\)\}'\)/);
  assert.match(source, /selectDesktopFlightByStableId\('imports','\$\{esc\(x\.flightId\)\}'\)/);
});

test('desktop renderers remain separate from the mobile-only overhaul', () => {
  const desktop = sourceBetween('function desktopFlightSelector(', 'function flights(type)');
  assert.doesNotMatch(desktop, /mobile-module|mobile-work-group|mobile-add-actions/);
  assert.match(html, /function flights\(type\)\{if\(isMobileUI\(\)\)return mobileFlightsByType\(type\);return desktopFlightWorkspace\(type\)\}/);
});
