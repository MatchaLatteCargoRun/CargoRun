'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

test('airline badges use one centralized CargoRun-owned mapping', () => {
  for (const [code, color] of Object.entries({
    CX: '#006564', UA: '#0033A0', MH: '#002B5C', QR: '#662046',
    TG: '#370E62', BI: '#FFE600', GA: '#202D5C', VN: '#005E80',
    AI: '#DA0E29', JQ: '#E65C00'
  })) {
    assert.match(html, new RegExp(`${code}:\\{name:[^}]+color:'${color}'`));
  }
  assert.match(html, /BI:\{[^}]+bright:true/);
  assert.match(html, /airline-badge \$\{m\.bright\?'bright':''\}/);
});

test('desktop operational navigation exposes real routes and active state', () => {
  for (const label of ['Home', 'Flight Board', 'Imports', 'Exports', 'Priority', 'Offloads', 'Supervisor', 'History']) {
    assert.match(html, new RegExp(`'${label}'`));
  }
  assert.match(html, /aria-label="Primary operations"/);
  assert.match(html, /navIsActive\(screen,type\)\?'active':''/);
  assert.match(html, /<\/div>\$\{desktopNav\(\)\}<div class="topbar-account">/);
  assert.match(html, /class="request-offload-nav" onclick="showRequestOffload\(\)"/);
});

test('desktop Home is lookup-first and keeps upload and operational routes', () => {
  assert.match(html, /id="desktopFlightLookup"/);
  assert.match(html, /id="desktopUldLookup"/);
  assert.match(html, /runDesktopFlightLookup\(\)/);
  assert.match(html, /runDesktopUldLookup\(\)/);
  assert.match(html, /showUploadFlightData\(\)/);
  assert.match(html, /openScreen\('offloads'\)/);
  assert.match(html, /function homeGreetingName\([^)]*\).*name\.includes\('@'\)/);
  assert.match(html, /Welcome\$\{greeting\?`, \$\{esc\(greeting\)\}`:''\}/);
  assert.doesNotMatch(html, /:'User'\}/);
});

test('existing CargoRun Home icon assets remain available and unaffected icons stay referenced', () => {
  const names = ['flight-lookup', 'uld-lookup', 'flight-board', 'priority', 'imports', 'exports', 'offloads', 'supervisor', 'history', 'upload'];
  for (const name of names) {
    const file = path.resolve(__dirname, '..', 'assets', 'home-icons', `icon-${name}.png`);
    assert.equal(fs.existsSync(file), true, `${name} icon should exist`);
    assert.ok(fs.statSync(file).size > 1000, `${name} icon should not be empty`);
    if (!['priority', 'imports', 'exports', 'offloads'].includes(name)) {
      assert.match(html, new RegExp(`icon-${name}\\.png`));
    }
  }
  assert.match(html, /\.home-op-card \.home-card-icon\{width:70px;height:70px\}/);
});

test('desktop Home replaces only four card icons with the canonical CargoRun artwork', () => {
  const context = vm.createContext({ HOME_ICON_PATH: '/assets/home-icons/' });
  const artStart = html.indexOf('const MOBILE_NAV_ART=');
  const artEnd = html.indexOf('function mobileHome(', artStart);
  vm.runInContext(html.slice(artStart, artEnd), context);
  const iconStart = html.indexOf('function homeIcon(');
  const iconEnd = html.indexOf('function homeGreetingName(', iconStart);
  vm.runInContext(html.slice(iconStart, iconEnd), context);
  const expected = {
    imports: 'assets/mobile-art/rider_on_descending_airplane_icon.png',
    exports: 'assets/mobile-art/white_airplane_rider_takeoff_icon.png',
    offloads: 'assets/mobile-art/white_parachute_cargo_icon.png',
    priority: 'assets/mobile-art/priority_courier_in_motion.png'
  };
  for (const [kind, asset] of Object.entries(expected)) {
    const rendered = context.homeIcon(kind);
    assert.match(rendered, new RegExp(`class="home-card-icon desktop-home-art desktop-home-art-${kind}"`));
    assert.ok(rendered.includes(`src="${asset}"`));
    assert.match(rendered, /width="1254" height="1254" alt="" draggable="false"/);
    assert.match(html, new RegExp(`homeCard\\('${kind}'`));
  }
  assert.match(html, /\.home-op-card\{display:grid;grid-template-columns:78px minmax\(0,1fr\) auto;align-items:center;gap:17px;min-height:118px;padding:17px 20px/);
  assert.match(html, /\.desktop-home-art\{display:flex[\s\S]*box-sizing:border-box[\s\S]*border:1px solid/);
  assert.match(html, /\.desktop-home-art img\{display:block;width:100%;height:100%;object-fit:contain\}/);
  assert.match(context.homeIcon('icon-flight-board.png'), /^<img class="home-card-icon" src="\/assets\/home-icons\/icon-flight-board\.png"/);
});

test('desktop ULD rows preserve DHL and strong handling and priority tokens', () => {
  assert.match(html, /function isDhlUnit\(u\)/);
  assert.match(html, /uld-flag dhl">DHL EXPRESS/);
  assert.match(html, /desktopHandlingInfo\(u,isImport,f\)/);
  assert.match(html, /uld-flag \\?\$\{handling\.toLowerCase\(\)\}/);
  assert.match(html, /\.ops-table \.uld-flag\.intact\{/);
  assert.match(html, /\.ops-table \.uld-flag\.breakdown\{/);
  assert.match(html, /desktopPriorityInfo\(f,u,type\)/);
  assert.match(html, /function desktopPriorityTokens\(f,u,type\)/);
  assert.match(html, /tokens\.length\?priorityBadges\(tokens\)/);
  assert.doesNotMatch(html, /function desktopPriorityInfo[^\n]+<div class="shcs">/);
});

test('desktop Import table avoids duplicated status and keeps acceptance timing', () => {
  assert.match(html, /<th>Handling \/ weight<\/th><th>Priority handling<\/th><th>\$\{isImport\?'Acceptance timing':'Movement evidence'\}<\/th><th>Action<\/th>/);
  assert.match(html, /if\(type==='imports'\)return acceptanceBadge\(f,u\)/);
  assert.doesNotMatch(html, /<th>ULD<\/th><th>Status<\/th>/);
  assert.match(html, /Accepted \$\{s\.minutes\}m after arrival/);
});

test('Request Offload is visible on the queue and selected Export workspace', () => {
  assert.match(html, /<h1>Offloads<\/h1>[\s\S]*showRequestOffload\(\)">Request Offload/);
  assert.match(html, /data-flight-id="\$\{esc\(f\.azureFlightId\|\|''\)\}" onclick="showRequestOffload\('\$\{esc\(f\.azureFlightId\|\|''\)\}'\)">Request Offload/);
  assert.match(html, /async function showRequestOffload\(preselectedFlightId=''\)/);
  assert.match(html, /stableOperationalId\(preselectedFlightId\)/);
});

test('Import and Export split selectors carry and resolve exact FlightId', () => {
  assert.match(html, /class="ops-split"/);
  assert.match(html, /data-flight-selector="\$\{type\}" data-flight-id="\$\{esc\(f\.azureFlightId\|\|''\)\}"/);
  assert.match(html, /selectDesktopFlightByStableId\('\$\{type\}','\$\{esc\(f\.azureFlightId\|\|''\)\}'\)/);
  assert.match(html, /const id=stableOperationalId\(flightId\),f=findFlightByStableId\(type,id\)/);
  assert.match(html, /data-selected-flight-id="\$\{esc\(f\.azureFlightId\|\|''\)\}"/);
  const start = html.indexOf('function desktopFlightSelector(');
  const end = html.indexOf('function desktopFlightActions(', start);
  const selectorSource = html.slice(start, end);
  assert.doesNotMatch(selectorSource, /<input/);
  assert.doesNotMatch(selectorSource, /filterDesktopFlights/);
});

test('ULD workspace actions retain exact FlightId and UldId', () => {
  assert.match(html, /data-uld-id="\$\{esc\(u\.azureUldId\|\|''\)\}"/);
  assert.match(html, /showConfirmULD\('\$\{type\}','\$\{f\.azureFlightId\|\|''\}','\$\{u\.azureUldId\|\|''\}'\)/);
  assert.doesNotMatch(html, /showConfirmULD\([^)]*,\s*i\s*\)/);
});

test('desktop ULD rows hide internal ULD IDs and show priority marker only for grouped priority cargo', () => {
  const start = html.indexOf('function desktopUldPriorityMarker(');
  const end = html.indexOf('function flights(type)', start);
  const source = html.slice(start, end);
  assert.match(source, /class="uld-priority-marker"/);
  assert.match(source, /icon-priority\.png/);
  assert.match(source, /tokens\.length\?/);
  assert.match(source, /desktopPriorityInfo\(f,u,type\)/);
  assert.doesNotMatch(source, /ULD ID \$\{esc\(u\.azureUldId/);
  assert.match(html, /\.uld-priority-marker\{[^}]*font-size:8px/);
});

test('duplicate-number desktop flights retain exact FlightId through route and detail selection', () => {
  const state = { imports: [
    { id: 'duplicate-local-id', azureFlightId: '101', flight: 'CX0163', flightDate: '15 Sep 2026', ulds: [], closed: false },
    { id: 'duplicate-local-id', azureFlightId: '102', flight: 'CX0163', flightDate: '14 Sep 2026', ulds: [], closed: false }
  ] };
  const context = vm.createContext({
    state,
    route: {},
    stableOperationalId: value => /^[1-9]\d*$/.test(String(value || '')) ? String(value) : '',
    window: { scrollTo() {} },
    canOpenCargoRunScreen: () => true,
    centralSyncScheduler: { reschedule() {} },
    refreshHistoryOnEntry() {},
    render() {},
    toast() {},
    activeFlights: type => state[type].filter(flight => !flight.closed),
    desktopFlightSelector: () => '',
    desktopFlightDetailPanel: (_type, flight) => `<detail data-flight-id="${flight.azureFlightId}">${flight.flightDate}</detail>`
  });
  const findStart = html.indexOf('function findFlightByStableId(');
  vm.runInContext(html.slice(findStart, html.indexOf('function findUldById(', findStart)), context);
  const openStart = html.indexOf('function openScreen(');
  vm.runInContext(html.slice(openStart, html.indexOf('\n', openStart)), context);
  const selectStart = html.indexOf('function selectDesktopFlightByStableId(');
  vm.runInContext(html.slice(selectStart, html.indexOf('\n', selectStart)), context);
  const workspaceStart = html.indexOf('function desktopFlightWorkspace(');
  vm.runInContext(html.slice(workspaceStart, html.indexOf('\n', workspaceStart)), context);

  assert.equal(context.selectDesktopFlightByStableId('imports', '102'), true);
  assert.equal(context.route.flightId, '102');
  assert.equal(context.route.id, 'duplicate-local-id');
  const rendered = context.desktopFlightWorkspace('imports', context.route.id, context.route.flightId);
  assert.match(rendered, /data-flight-id="102">14 Sep 2026/);
  assert.doesNotMatch(rendered, /15 Sep 2026/);

  assert.match(html, /route=\{screen,type,id:selected\?\.id\|\|id,flightId\}/);
  assert.match(html, /rows\.find\(f=>String\(f\.azureFlightId\)===String\(stableFlightId\)\)\|\|null/);
  assert.match(html, /The selected flight is no longer active\. Select another exact flight\./);
  assert.match(html, /flightDetail\(route\.type,route\.id,route\.flightId\)/);
  assert.match(html, /id:`az-\$\{type==='imports'\?'imp':'exp'\}-\$\{apiFlight\.FlightId\}`/);
  assert.match(html, /if\(localFlight\.azureFlightId!=null\)return String\(localFlight\.azureFlightId\)===String\(apiFlight\.FlightId\)/);
});

test('mobile route renderers and bottom navigation remain in place', () => {
  assert.match(html, /function mobileHome\(/);
  assert.match(html, /function mobileFlightsByType\(/);
  assert.match(html, /function mobileFlightDetail\(/);
  assert.match(html, /isMobileUI\(\)\?mobileBottomNav\(\):''/);
});

test('desktop lookup normalizes zero-padded flight numbers and limits default results to three Melbourne dates', () => {
  const start = html.indexOf('function normalizeFlightLookup(');
  const end = html.indexOf('function flightLookupResultRow(', start);
  const context = vm.createContext({
    state: { flightCatalog: [
      { flightId: '1', flightNumber: 'CX0178', operatingDate: '2026-09-19', direction: 'EXPORT', flightStatus: 'ACTIVE' },
      { flightId: '2', flightNumber: 'CX178', operatingDate: '2026-09-18', direction: 'EXPORT', flightStatus: 'CLOSED' },
      { flightId: '3', flightNumber: 'CX0178', operatingDate: '2026-09-17', direction: 'IMPORT', flightStatus: 'FINALISED' },
      { flightId: '4', flightNumber: 'CX178', operatingDate: '2026-09-16', direction: 'EXPORT', flightStatus: 'CLOSED' },
      { flightId: '5', flightNumber: 'CX105', operatingDate: '2026-09-10', direction: 'EXPORT', flightStatus: 'CLOSED' },
      { flightId: '6', flightNumber: 'MH147', operatingDate: '2026-09-19', direction: 'IMPORT', flightStatus: 'ACTIVE' },
      { flightId: '7', flightNumber: 'CX998', operatingDate: '2026-08-01', direction: 'EXPORT', flightStatus: 'CLOSED' }
    ] },
    Intl,
    Date,
    stableOperationalId: value => /^[1-9]\d*$/.test(String(value || '')) ? String(value) : '',
    flightDateISO: () => ''
  });
  vm.runInContext(html.slice(start, end), context);
  const now = Date.parse('2026-09-19T02:00:00Z');
  assert.equal(context.normalizeFlightLookup('CX0178'), 'CX178');
  assert.equal(context.normalizeFlightLookup('cx 178'), 'CX178');
  assert.deepEqual(Array.from(context.flightLookupMatches('CX0178', false, now), x => x.flightId), ['1', '2', '3']);
  assert.deepEqual(Array.from(context.flightLookupMatches('CX', '3', now), x => x.flightId), ['1', '2', '3']);
  assert.deepEqual(Array.from(context.flightLookupMatches('CX', '14', now), x => x.flightId), ['1', '2', '3', '4', '5']);
  assert.deepEqual(Array.from(context.flightLookupMatches('CX178', true, now), x => x.flightId), ['1', '2', '3', '4']);
  assert.deepEqual(Array.from(context.flightLookupMatches('CX', 'all', now), x => x.flightId), ['1', '2', '3', '4', '5', '7']);
});

test('ULD lookup supports serial containment while retaining canonical full-code matching', () => {
  const start = html.indexOf('function uldMatchesLookup(');
  const end = html.indexOf('async function uldLookupMatches(', start);
  const context = vm.createContext({
    normalizeULD: value => typeof value === 'string' ? value.trim().toUpperCase().replace(/[\s-]/g, '') : '',
    uldSerial: value => {
      const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
      return normalized.length > 5 ? (normalized.slice(3, -2).match(/\d/g) || []).join('') : '';
    }
  });
  vm.runInContext(html.slice(start, end), context);
  assert.equal(context.uldMatchesLookup('AKE12345CX', '12345'), true);
  assert.equal(context.uldMatchesLookup('AKE9912345CX', '12345'), true);
  assert.equal(context.uldMatchesLookup('AKE-12345-CX', 'ake 12345 cx'), true);
  assert.equal(context.uldMatchesLookup('AKE/12345/CX', 'AKE12345CX'), false);
});

test('lookup result actions and shift report retain stable identity and statement styling', () => {
  assert.match(html, /data-flight-id="\$\{esc\(flightId\)\}" data-uld-id="\$\{esc\(match\.uldId\)\}"/);
  assert.match(html, /openUldLookupResult\('\$\{esc\(flightId\)\}','\$\{esc\(match\.uldId\)\}'\)/);
  assert.match(html, /rows\.find\(row=>stableOperationalId\(row\.UldId\)===uid\)/);
  assert.match(html, /class="shift-document"/);
  assert.match(html, /CargoRun MEL Shift Report/);
  assert.match(html, /Print \/ Save PDF/);
});

test('priority rendering groups SHCs and suppresses invalid display values', () => {
  const start = html.indexOf('const PRIORITY_TAG_META=');
  const end = html.indexOf('function flightBoardState(', start);
  const context = vm.createContext({ Set, esc: value => String(value ?? '') });
  vm.runInContext(html.slice(start, end), context);
  const tags = context.priorityTagsFor(
    { flight: 'CX178' },
    { shcs: ['COL', 'ICE', 'PER', 'AVI', 'VAL', 'DGR', 'PIL', 'AOG', 'HUM', 'MAL', undefined, null, {}] },
    'imports'
  );
  assert.deepEqual(Array.from(tags, tag => tag.label), ['AVI', 'TEMP', 'PHARMA', 'AOG', 'VAL', 'HUM', 'DGR', 'MAIL']);
  assert.equal(Array.from(tags, tag => tag.label).filter(label => label === 'TEMP').length, 1);
  assert.doesNotMatch(context.priorityBadges(tags), /undefined|null|\[object Object\]/i);
  assert.match(html, /\.ops-table \.uld-flag\.intact,\.ops-table \.uld-flag\.breakdown\{box-shadow:none!important\}/);
});

test('History exposes completed-flight and stable actor filters', () => {
  const start = html.indexOf('function historyActorKey(');
  const end = html.indexOf('function completionsForDate(', start);
  const context = vm.createContext({
    state: { history: [
      { ts: 3, type: 'ULD', user: 'Alex', actorReference: 'actor-1' },
      { ts: 2, type: 'Offload', user: 'Alex', actorReference: 'actor-2' },
      { ts: 1, type: 'Flight', user: 'CargoRun', actorReference: '' }
    ] },
    historySearch: '',
    historyFilter: 'All',
    historyUserFilter: 'All'
  });
  vm.runInContext(html.slice(start, end), context);
  assert.deepEqual(Array.from(context.historyUsers(), user => user.key), ['id:actor-1', 'id:actor-2']);
  context.historyUserFilter = 'id:actor-2';
  assert.deepEqual(Array.from(context.historyFilteredEvents(), event => event.type), ['Offload']);
  context.historyFilter = 'Completed Flights';
  assert.equal(context.historyFilteredEvents().length, 0);
  assert.match(html, /\['All','Completed Flights','ULD','Offload','Flight','Upload','FFM','Mail'\]/);
  assert.match(html, /setHistoryUserFilter\(this\.value\)/);
  assert.match(html, /actorReference:String\(e\.actorReference\|\|''\)/);
});

test('History API exposes stable actor and entity references through read-only access', () => {
  const api = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'history', 'index.js'), 'utf8');
  assert.match(api, /actorReference: String\(get\(\['ActorObjectId', 'ActorId', 'ActorReference'\]\)/);
  assert.match(api, /entityType: get\(\['EntityType'\]\)/);
  assert.match(api, /entityId: String\(get\(\['EntityId'\]\)/);
  assert.match(api, /toUpperCase\(\) !== 'GET'/);
  assert.match(api, /sendJson\(context, 405/);
  assert.doesNotMatch(api, /INSERT\s+INTO\s+dbo\.AuditEvents/i);
});

test('Shift Report renders imports, exports, offloads, users and exceptions in order', () => {
  const start = html.indexOf('function shiftReportBody(');
  const end = html.indexOf('function shiftReportDocument(', start);
  const source = html.slice(start, end);
  const labels = ['<strong>IMPORTS</strong>', '<strong>EXPORTS</strong>', '<strong>OFFLOADS</strong>', '<strong>PRIORITY / EXCEPTIONS</strong>', '<strong>OPERATOR ACTIVITY</strong>'];
  let previous = -1;
  for (const label of labels) {
    const index = source.indexOf(label);
    assert.ok(index > previous, `${label} should follow the previous report section`);
    previous = index;
  }
  assert.match(source, /Offload #\$\{esc\(o\.offloadId\)\}/);
  assert.match(source, /<th>Flight<\/th><th>ULD<\/th><th>Bay<\/th><th>Requested<\/th><th>Collected<\/th><th>Completed<\/th><th>Status<\/th><th>Elapsed<\/th>/);
});
