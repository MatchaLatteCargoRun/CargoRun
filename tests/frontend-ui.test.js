'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
  assert.match(html, /route\.screen==='home'\?'':desktopNav\(\)/);
});

test('desktop Home is lookup-first and keeps upload and operational routes', () => {
  assert.match(html, /id="desktopFlightLookup"/);
  assert.match(html, /id="desktopUldLookup"/);
  assert.match(html, /runDesktopFlightLookup\(\)/);
  assert.match(html, /runDesktopUldLookup\(\)/);
  assert.match(html, /showUploadFlightData\(\)/);
  assert.match(html, /openScreen\('offloads'\)/);
  assert.match(html, /function homeGreetingName\([^)]*\).*name\.includes\('@'\)/);
  assert.match(html, /Welcome, \$\{esc\(homeGreetingName\(u\)\)\}/);
});

test('desktop ULD rows preserve DHL and strong handling and priority tokens', () => {
  assert.match(html, /function isDhlUnit\(u\)/);
  assert.match(html, /uld-flag dhl">DHL EXPRESS/);
  assert.match(html, /desktopHandlingInfo\(u,isImport,f\)/);
  assert.match(html, /uld-flag \\?\$\{handling\.toLowerCase\(\)\}/);
  assert.match(html, /\.ops-table \.uld-flag\.intact\{/);
  assert.match(html, /\.ops-table \.uld-flag\.breakdown\{/);
  assert.match(html, /desktopPriorityInfo\(f,u,type\)/);
  assert.match(html, /priorityBadges\(priorityTagsFor\(f,u,type\)\)/);
});

test('desktop Import table avoids duplicated status and keeps acceptance timing', () => {
  assert.match(html, /<th>Handling \/ weight<\/th><th>Priority \/ SHC<\/th><th>\$\{isImport\?'Acceptance timing':'Movement evidence'\}<\/th><th>Action<\/th>/);
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
  assert.match(html, /const f=findFlightByStableId\(type,flightId\)/);
  assert.match(html, /data-selected-flight-id="\$\{esc\(f\.azureFlightId\|\|''\)\}"/);
});

test('ULD workspace actions retain exact FlightId and UldId', () => {
  assert.match(html, /data-uld-id="\$\{esc\(u\.azureUldId\|\|''\)\}"/);
  assert.match(html, /showConfirmULD\('\$\{type\}','\$\{f\.azureFlightId\|\|''\}','\$\{u\.azureUldId\|\|''\}'\)/);
  assert.doesNotMatch(html, /showConfirmULD\([^)]*,\s*i\s*\)/);
});

test('desktop flight route survives reorder by retaining FlightId and fails closed when stale', () => {
  assert.match(html, /route=\{screen,type,id:selected\?\.id\|\|id,flightId:selected\?stableOperationalId\(selected\.azureFlightId\):null\}/);
  assert.match(html, /rows\.find\(f=>String\(f\.azureFlightId\)===String\(stableFlightId\)\)\|\|null/);
  assert.match(html, /The selected flight is no longer active\. Select another exact flight\./);
  assert.match(html, /flightDetail\(route\.type,route\.id,route\.flightId\)/);
});

test('mobile route renderers and bottom navigation remain in place', () => {
  assert.match(html, /function mobileHome\(/);
  assert.match(html, /function mobileFlightsByType\(/);
  assert.match(html, /function mobileFlightDetail\(/);
  assert.match(html, /isMobileUI\(\)\?mobileBottomNav\(\):''/);
});
