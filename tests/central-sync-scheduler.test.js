'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  CADENCE_MS,
  BACKOFF_MS,
  cadenceFor,
  createCentralSyncScheduler
} = require('../central-sync-scheduler');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function makeHarness({ screen = 'flights', active = 1, visible = true, outcomes = [] } = {}) {
  let timerId = 0;
  const timers = new Map();
  const calls = [];
  const state = { screen, active, visible };
  const scheduler = createCentralSyncScheduler({
    sync: async options => {
      calls.push(options);
      const outcome = outcomes.length ? outcomes.shift() : true;
      if (outcome instanceof Error) throw outcome;
      return await outcome;
    },
    canRun: () => true,
    isVisible: () => state.visible,
    getCadence: () => cadenceFor(state.screen, state.active),
    setTimer(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); }
  });
  return { scheduler, state, timers, calls };
}

test('screen cadence policy matches the approved operational, Home and dashboard intervals', () => {
  for (const screen of ['flights', 'flight', 'mobileflights', 'offloads', 'priority']) {
    assert.equal(cadenceFor(screen, 1), 10000, screen);
  }
  assert.equal(cadenceFor('home', 1), 20000);
  assert.equal(cadenceFor('more', 1), 20000);
  assert.equal(cadenceFor('flightboard', 1), 15000);
  assert.equal(cadenceFor('supervisor', 1), 15000);
  assert.equal(cadenceFor('machfow', 1), 15000);
  assert.deepEqual(CADENCE_MS, { operational: 10000, home: 20000, dashboard: 15000, idle: 120000 });
});

test('known zero-active-flight state overrides normal screens with a 120-second cadence', () => {
  for (const screen of ['home', 'flights', 'flightboard', 'supervisor', 'offloads']) {
    assert.equal(cadenceFor(screen, 0), 120000, screen);
  }
});

test('History and Admin never receive a continuous polling cadence', () => {
  assert.equal(cadenceFor('history', 10), null);
  assert.equal(cadenceFor('admin', 10), null);
});

test('hidden tabs cancel the timer and returning visible performs exactly one immediate refresh', async () => {
  const h = makeHarness();
  await h.scheduler.start();
  assert.equal(h.timers.size, 1);
  h.state.visible = false;
  assert.equal(await h.scheduler.handleVisibilityChange(), false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.length, 0);
  h.state.visible = true;
  assert.equal(await h.scheduler.handleVisibilityChange(), true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].reason, 'visibility');
  assert.equal(h.timers.size, 1);
});

test('rescheduling and navigation replace the existing timer instead of accumulating timers', async () => {
  const h = makeHarness({ screen: 'flights' });
  await h.scheduler.start();
  assert.equal([...h.timers.values()][0].delay, 10000);
  h.state.screen = 'home';
  h.scheduler.reschedule();
  h.scheduler.reschedule();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 20000);
  h.state.screen = 'supervisor';
  h.scheduler.reschedule();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 15000);
});

test('active-to-idle and idle-to-active changes alter the next cadence without another probe', async () => {
  const h = makeHarness({ active: 4 });
  await h.scheduler.start();
  assert.equal(h.scheduler.inspect().nextDelay, 10000);
  h.state.active = 0;
  h.scheduler.reschedule();
  assert.equal(h.scheduler.inspect().nextDelay, 120000);
  assert.equal([...h.timers.values()][0].delay, 120000);
  h.state.active = 2;
  h.scheduler.reschedule();
  assert.equal([...h.timers.values()][0].delay, 10000);
  assert.equal(h.calls.length, 0);
});

test('one central sync runs at a time and scheduled requests do not overlap it', async () => {
  const gate = deferred();
  const h = makeHarness({ outcomes: [gate.promise] });
  const first = h.scheduler.request({ automatic: true, reason: 'scheduled' });
  const second = h.scheduler.request({ automatic: true, reason: 'scheduled' });
  assert.strictEqual(first, second);
  assert.equal(h.calls.length, 1);
  assert.equal(h.scheduler.inspect().inFlight, true);
  assert.equal(h.scheduler.inspect().queued, false);
  gate.resolve(true);
  assert.equal(await first, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.scheduler.inspect().inFlight, false);
});

test('visibility resumes during a sync coalesce into one immediate non-overlapping follow-up', async () => {
  const gate = deferred();
  let activeSyncs = 0;
  let maximumActiveSyncs = 0;
  let callCount = 0;
  let visible = true;
  const scheduler = createCentralSyncScheduler({
    sync: async options => {
      callCount++;
      activeSyncs++;
      maximumActiveSyncs = Math.max(maximumActiveSyncs, activeSyncs);
      try {
        if (callCount === 1) await gate.promise;
        return true;
      } finally {
        activeSyncs--;
      }
    },
    isVisible: () => visible,
    getCadence: () => CADENCE_MS.operational,
    setTimer: () => 1,
    clearTimer: () => {}
  });

  await scheduler.start();
  const first = scheduler.request({ automatic: true, reason: 'scheduled' });
  visible = false;
  assert.equal(await scheduler.handleVisibilityChange(), false);
  visible = true;
  const resumedOnce = scheduler.handleVisibilityChange();
  const resumedTwice = scheduler.handleVisibilityChange();

  assert.strictEqual(first, resumedOnce);
  assert.strictEqual(first, resumedTwice);
  assert.equal(callCount, 1);
  assert.equal(scheduler.inspect().queued, true);
  gate.resolve();
  assert.equal(await first, true);
  assert.equal(callCount, 2);
  assert.equal(maximumActiveSyncs, 1);
  assert.equal(scheduler.inspect().queued, false);
});

test('multiple explicit refreshes during a background sync coalesce into one merged follow-up', async () => {
  const gate = deferred();
  const h = makeHarness({ outcomes: [gate.promise, true] });
  const first = h.scheduler.request({ automatic: true, services: ['flights'] });
  const second = h.scheduler.request({ services: ['offloads'] });
  const third = h.scheduler.request({ services: ['history', 'offloads'], includeHistory: true });
  assert.strictEqual(first, second);
  assert.strictEqual(first, third);
  assert.equal(h.calls.length, 1);
  assert.equal(h.scheduler.inspect().queued, true);
  gate.resolve(true);
  assert.equal(await first, true);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].automatic, false);
  assert.deepEqual(h.calls[1].services.sort(), ['history', 'offloads']);
  assert.equal(h.calls[1].includeHistory, true);
});

test('failed sync releases in-flight state and automatic failures follow bounded backoff', async () => {
  const h = makeHarness({ outcomes: [new Error('down'), false, false, false, false, true] });
  await h.scheduler.start();
  for (const expected of BACKOFF_MS) {
    assert.equal(await h.scheduler.request({ automatic: true }), false);
    assert.equal(h.scheduler.inspect().inFlight, false);
    assert.equal(h.scheduler.inspect().nextDelay, expected);
    assert.equal([...h.timers.values()][0].delay, expected);
  }
  assert.equal(await h.scheduler.request({ automatic: true }), false);
  assert.equal(h.scheduler.inspect().nextDelay, 120000);
  assert.equal(await h.scheduler.request({ automatic: true }), true);
  assert.equal(h.scheduler.inspect().consecutiveFailures, 0);
  assert.equal(h.scheduler.inspect().nextDelay, 10000);
});

test('index uses screen-aware service plans and refreshes History only on entry', () => {
  const start = html.indexOf('const CENTRAL_SYNC_SERVICE_NAMES=');
  const end = html.indexOf('function centralActiveFlightCount()', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ route: { screen: 'flights' }, Set });
  vm.runInContext(html.slice(start, end), context);
  assert.deepEqual([...context.centralSyncServices({ screen: 'home' })], ['flights', 'offloads']);
  assert.deepEqual([...context.centralSyncServices({ screen: 'flightboard' })], ['flights', 'offloads']);
  assert.deepEqual([...context.centralSyncServices({ screen: 'supervisor' })], ['flights', 'offloads', 'history', 'exportCompletions', 'importCompletions']);
  assert.deepEqual([...context.centralSyncServices({ screen: 'history' })], ['history', 'exportCompletions', 'importCompletions']);
  assert.deepEqual([...context.centralSyncServices({ screen: 'admin' })], []);
  assert.match(html, /if\(screen==='history'\)void refreshHistoryOnEntry\(\)/);
  assert.match(html, /if\(screen==='admin'\)void loadAdminConfiguration\(\)/);
});

test('startup, visibility and navigation are wired to the one managed scheduler', () => {
  assert.match(html, /central-sync-scheduler\.js/);
  assert.match(html, /syncCentralData\(true,\{automatic:true,full:true,screen:'home',reason:'startup'\}\)/);
  assert.match(html, /await centralSyncScheduler\.start\(\)/);
  assert.match(html, /centralSyncScheduler\.reschedule\(\)/);
  assert.match(html, /centralSyncScheduler\.handleVisibilityChange\(\)/);
  assert.doesNotMatch(html, /setInterval\(\(\)=>\{if\(document\.visibilityState==='visible'&&canUseCargoRunApi\(\)\)syncCentralData/);
  assert.equal((html.match(/createCentralSyncScheduler\(/g) || []).length, 1);
});

test('successful operational mutations keep immediate local or managed server refreshes', () => {
  for (const name of ['advanceULD', 'addImportUld', 'closeFlight', 'createOffloads', 'confirmOffloadTransit', 'completeOffload']) {
    const start = html.indexOf(`function ${name}(`) >= 0 ? html.indexOf(`function ${name}(`) : html.indexOf(`async function ${name}(`);
    const next = html.indexOf('\nfunction ', start + 1);
    const source = html.slice(start, next > start ? next : start + 6000);
    assert.match(source, /syncCentralData\(true,\{services:/, name);
  }
  assert.match(html, /function saveManualInBlock[\s\S]*?save\(\);closeModal\(\);toast\([\s\S]*?render\(\)/);
  assert.match(html, /function saveExportEtd[\s\S]*?save\(\);closeModal\(\);render\(\);toast/);
  assert.match(html, /function confirmBulkMailScanned[\s\S]*?save\(\);closeModal\(\);render\(\);toast/);
  assert.match(html, /finalised centrally`\);await syncCentralData\(true,\{full:true\}\)/);
  assert.match(html, /await syncCentralData\(true,\{services:\['flights'\]\}\);\s*const flight = findFlightByStableId/);
});

test('the Live indicator advances only after the requested central service set succeeds', () => {
  assert.match(html, /lastFlightSuccess:Date\.now\(\),flightCount:remoteFlights\.length/);
  assert.match(html, /\.\.\.\(ok\?\{lastSuccess:now\}:\{\}\)/);
  assert.doesNotMatch(html, /lastSuccess:Date\.now\(\),flightCount:remoteFlights\.length/);
});
