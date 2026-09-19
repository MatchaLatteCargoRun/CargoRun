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

test('desktop lookup normalizes zero-padded flight numbers and limits default results to three Melbourne dates', () => {
  const start = html.indexOf('function normalizeFlightLookup(');
  const end = html.indexOf('function flightLookupResultRow(', start);
  const context = vm.createContext({
    state: { flightCatalog: [
      { flightId: '1', flightNumber: 'CX0178', operatingDate: '2026-09-19', direction: 'EXPORT', flightStatus: 'ACTIVE' },
      { flightId: '2', flightNumber: 'CX178', operatingDate: '2026-09-18', direction: 'EXPORT', flightStatus: 'CLOSED' },
      { flightId: '3', flightNumber: 'CX0178', operatingDate: '2026-09-17', direction: 'IMPORT', flightStatus: 'FINALISED' },
      { flightId: '4', flightNumber: 'CX178', operatingDate: '2026-09-16', direction: 'EXPORT', flightStatus: 'CLOSED' }
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
  assert.deepEqual(Array.from(context.flightLookupMatches('CX178', true, now), x => x.flightId), ['1', '2', '3', '4']);
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
