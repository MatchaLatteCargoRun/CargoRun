'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'mascot-loader.js'), 'utf8');

function componentHarness() {
  let nextFrame = 1;
  const frames = new Map(), cancelled = [], documentListeners = new Map(), windowListeners = new Map(), motionListeners = [];
  const motion = {
    matches: false,
    addEventListener(type, listener) { if (type === 'change') motionListeners.push(listener); }
  };
  const document = {
    hidden: false,
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    }
  };
  const window = {
    devicePixelRatio: 1,
    matchMedia: () => motion,
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { cancelled.push(id); frames.delete(id); },
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(listener);
    }
  };
  class Image {
    set src(value) { this.value = value; queueMicrotask(() => this.onload()); }
  }
  const calls = { drawImage: [], translate: [], clearRect: 0 };
  const context2d = {
    setTransform() {},
    clearRect() { calls.clearRect++; },
    translate(x, y) { calls.translate.push([x, y]); },
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, arc() {},
    drawImage(...args) { calls.drawImage.push(args); },
    fillStyle: ''
  };
  const canvas = {
    width: 600, height: 620, clientWidth: 180,
    getContext: () => context2d,
    getBoundingClientRect: () => ({ width: 180 })
  };
  const context = vm.createContext({ window, document, Image, console, queueMicrotask, Promise, Math, Set, Object, TypeError, Error });
  vm.runInContext(source, context);
  return { api: window.CargoRunMascotLoader, canvas, calls, frames, cancelled, document, documentListeners, windowListeners, motion, motionListeners };
}

async function assetsReady() {
  await new Promise(resolve => setImmediate(resolve));
}

test('approved canvas mascot replaces both generic action and startup spinner artwork', () => {
  assert.match(html, /<canvas id="cargoLoaderMascot"[^>]*aria-hidden="true"/);
  assert.match(html, /<canvas id="actionLoaderMascot"[^>]*aria-hidden="true"/);
  assert.match(html, /<script src="\/mascot-loader\.js"><\/script>/);
  assert.doesNotMatch(html, /<img id="(?:cargo|action)LoaderMascot"/);
  assert.doesNotMatch(html, /cargoRunnerSpot|cargoSpeedSpot|cargoDot/);
});

test('session authorization reuses the shared CargoRun loader without a static access-check card', () => {
  const accessGate = html.slice(html.indexOf('function accessGateScreen()'), html.indexOf('let actionLoaderDepth'));
  const boot = html.slice(html.indexOf('async function bootCargoRun()'), html.indexOf('\nbootCargoRun();'));
  assert.match(boot, /showDataLoader\('Checking CargoRun access','Confirming your CargoRun role and station access\.'\)/);
  assert.match(boot, /updateDataLoader\('Loading live operations/);
  assert.match(html, /purgeCargoRunOperationalState\(\{preserveIdentity:true,preserveDataLoader:true\}\)/);
  assert.doesNotMatch(accessGate, /Checking CargoRun access|Confirming your CargoRun role and station access/);
  assert.match(accessGate, /Access not provisioned/);
});

test('loading status keeps meaningful accessible title and detail text', () => {
  assert.match(html, /id="cargoLoader"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="actionLoader"[^>]*role="status"[^>]*aria-live="assertive"/);
  assert.match(html, /id="cargoLoaderTitle"/);
  assert.match(html, /id="cargoLoaderSub"/);
  assert.match(html, /id="actionLoaderTitle"/);
  assert.match(html, /id="actionLoaderSub"/);
  assert.match(html, /LOADER_REVEAL_DELAY_MS=140/);
});

test('animation starts once, cancels on hide, and repeated open close does not duplicate loops', async () => {
  const h = componentHarness();
  const loader = h.api.create(h.canvas);
  await assetsReady();
  assert.equal(h.frames.size, 0);
  loader.show();
  assert.equal(h.frames.size, 1);
  loader.show();
  assert.equal(h.frames.size, 1);
  const firstFrame = [...h.frames.keys()][0];
  loader.hide();
  assert.equal(h.frames.size, 0);
  assert.ok(h.cancelled.includes(firstFrame));
  loader.show();
  assert.equal(h.frames.size, 1);
  loader.hide();
  assert.equal(h.frames.size, 0);
  assert.equal(h.documentListeners.get('visibilitychange').length, 1);
  assert.equal(h.windowListeners.get('resize').length, 1);
});

test('hidden documents pause animation and visible documents resume one loop', async () => {
  const h = componentHarness();
  const loader = h.api.create(h.canvas);
  await assetsReady();
  loader.show();
  assert.equal(h.frames.size, 1);
  h.document.hidden = true;
  h.documentListeners.get('visibilitychange')[0]();
  assert.equal(h.frames.size, 0);
  h.document.hidden = false;
  h.documentListeners.get('visibilitychange')[0]();
  assert.equal(h.frames.size, 1);
  h.windowListeners.get('pagehide')[0]();
  assert.equal(h.frames.size, 0);
  h.windowListeners.get('pageshow')[0]();
  assert.equal(h.frames.size, 1);
});

test('reduced motion renders a static mascot pose without scheduling frames', async () => {
  const h = componentHarness();
  h.motion.matches = true;
  const loader = h.api.create(h.canvas);
  await assetsReady();
  loader.show();
  assert.equal(h.frames.size, 0);
  assert.ok(h.calls.drawImage.length >= 3);
  assert.equal(h.motionListeners.length, 1);
});

test('approved rig is byte-identical and cargo is translated vertically without rotation or skew', () => {
  const rig = source.match(/const rig =\s*(\{.*\});\s*const CYCLE_MS/s);
  assert.ok(rig);
  assert.equal(crypto.createHash('sha256').update(rig[1], 'utf8').digest('hex'), '1b99380581a82bc936d965b7f4e9578cc1b70a41f9920f36f48656759572b1a3');
  assert.match(source, /rigid\('cargo', frame\.cargoBounce\)/);
  assert.match(source, /box\[1\] \+ verticalOffset/);
  assert.doesNotMatch(source, /\.rotate\(|skew/i);
});

test('compact and full loaders constrain canvas width on mobile without horizontal overflow', () => {
  assert.match(html, /\.cargo-loader\{[^}]*overflow-x:hidden/);
  assert.match(html, /\.action-loader\{[^}]*overflow-x:hidden/);
  assert.match(html, /\.mascot-loader-canvas\{[^}]*width:100%;max-width:100%;height:auto;aspect-ratio:1200\/1240/);
  const mobile = html.slice(html.indexOf('@media (max-width:700px)'), html.indexOf('@media (max-width:520px)'));
  assert.match(mobile, /\.cargo-loader-track\{width:min\(174px,56vw\)\}/);
  assert.match(mobile, /\.action-loader-runner\{width:min\(94px,32vw\)\}/);
});

test('multi-select offload action supplies singular and plural loading copy', () => {
  assert.ok(html.includes("showActionLoader(uldIds.length===1?'Creating Offload\\u2026':`Creating ${uldIds.length} Offloads\\u2026`"));
  assert.ok(html.includes("`Validating ULD and ${flight.flightNumber}\\u2026`:`Validating ULDs and ${flight.flightNumber}\\u2026`"));
});
test('meaningful existing workflows use the shared loader while its component has no business calls', () => {
  assert.match(html, /showDataLoader\('Starting CargoRun…','Checking your Microsoft sign-in'\)/);
  assert.match(html, /showDataLoader\('Checking CargoRun access','Confirming your CargoRun role and station access\.'\)/);
  assert.ok(html.includes("showActionLoader(uldIds.length===1?'Creating Offload\\u2026'"));
  assert.match(html, /showActionLoader\('Finalising export…'/);
  assert.match(html, /showActionLoader\('Finalising import…'/);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});
