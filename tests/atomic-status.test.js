'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const {sqlHarness,loadHandler,call}=require('./helpers/operational-harness');

test('ULD update is conditional, atomic, and records one authoritative audit and movement', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 } });
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: 7, expectedCurrentStatus: 'ARRIVED', nextStatus: 'TRANSIT' });
  assert.equal(response.status, 200);
  assert.equal(h.state.uld.CurrentStatus, 'TRANSIT');
  assert.equal(h.state.uld.IdentityVerified, 1);
  assert.equal(h.state.movements.length, 1);
  assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.audits[0].ActorDisplayName, 'Concurrency Tester');
  assert.equal(h.state.audits[0].OccurredAtUtc, '2026-09-17T00:00:00.000Z');
  assert.equal(h.state.commits, 1);
});

test('ULD first acceptance records verification through the authoritative audit', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'UNARRIVED', IdentityVerified: 0 } });
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: 7, expectedCurrentStatus: 'UNARRIVED', nextStatus: 'ARRIVED' });
  assert.equal(response.status, 200);
  assert.equal(h.state.uld.IdentityVerified, 1);
  assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.audits[0].Action, 'ULD accepted');
});

test('Import Confirm Received succeeds by stable UldId with trigger-compatible atomic audit', async () => {
  const duplicate = { UldId: 72, FlightId: 202, FlightNumber: 'CX178', UldNumber: 'AKE12345CX', CurrentStatus: 'TRANSIT', IdentityVerified: 1, Direction: 'IMPORT' };
  const h = sqlHarness({
    uld: { UldId: 71, FlightId: 201, FlightNumber: 'CX178', UldNumber: 'AKE12345CX', CurrentStatus: 'TRANSIT', IdentityVerified: 1, Direction: 'IMPORT' },
    otherUlds: [duplicate],
    auditInsertTrigger: true
  });
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: 71, expectedCurrentStatus: 'TRANSIT', nextStatus: 'RECEIVED' });
  assert.equal(response.status, 200);
  assert.equal(h.state.uld.CurrentStatus, 'RECEIVED');
  assert.equal(h.state.uld.IdentityVerified, 1);
  assert.equal(h.state.otherUlds[0].CurrentStatus, 'TRANSIT');
  assert.equal(h.state.otherUlds[0].IdentityVerified, 1);
  assert.deepEqual(h.state.audits.map(event => [event.Action, event.FromStatus, event.ToStatus]), [
    ['Status changed', 'TRANSIT', 'RECEIVED']
  ]);
  assert.equal(h.state.commits, 1);
  assert.equal(h.state.rollbacks, 0);
});

test('Export Transit to At Aircraft succeeds by stable UldId with trigger-compatible atomic audit', async () => {
  const duplicate = { UldId: 82, FlightId: 302, FlightNumber: 'QF93', UldNumber: 'PMC48921R7', CurrentStatus: 'TRANSIT', IdentityVerified: 1, Direction: 'EXPORT' };
  const h = sqlHarness({
    uld: { UldId: 81, FlightId: 301, FlightNumber: 'QF93', UldNumber: 'PMC48921R7', CurrentStatus: 'TRANSIT', IdentityVerified: 1, Direction: 'EXPORT' },
    otherUlds: [duplicate],
    auditInsertTrigger: true
  });
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: 81, expectedCurrentStatus: 'TRANSIT', nextStatus: 'AT_AIRCRAFT' });
  assert.equal(response.status, 200);
  assert.equal(h.state.uld.CurrentStatus, 'AT_AIRCRAFT');
  assert.equal(h.state.uld.IdentityVerified, 1);
  assert.equal(h.state.otherUlds[0].CurrentStatus, 'TRANSIT');
  assert.equal(h.state.otherUlds[0].IdentityVerified, 1);
  assert.deepEqual(h.state.audits.map(event => [event.Action, event.FromStatus, event.ToStatus]), [
    ['Status changed', 'TRANSIT', 'AT_AIRCRAFT']
  ]);
  assert.equal(h.state.commits, 1);
  assert.equal(h.state.rollbacks, 0);
});

test('ULD race returns STALE_STATUS and rolls back status, verification, and movement', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 } });
  h.state.raceUldStatus = 'TRANSIT';
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: 7, expectedCurrentStatus: 'ARRIVED', nextStatus: 'TRANSIT' });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'STALE_STATUS');
  assert.equal(h.state.uld.CurrentStatus, 'TRANSIT');
  assert.equal(h.state.uld.IdentityVerified, 0);
  assert.equal(h.state.movements.length, 0);
  assert.equal(h.state.audits.length, 0);
  assert.equal(h.state.rollbacks, 1);
});

test('two ULD requests expecting ARRIVED produce one transition', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 } });
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const first = await call(handler, 'POST', { uldId: 7, expectedCurrentStatus: 'ARRIVED', nextStatus: 'TRANSIT' });
  const second = await call(handler, 'POST', { uldId: 7, expectedCurrentStatus: 'ARRIVED', nextStatus: 'TRANSIT' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(h.state.movements.length, 1);
  assert.equal(h.state.audits.length, 1);
});

test('export WAREHOUSE transition succeeds once and stale race has no side effects', async () => {
  const h = sqlHarness({ uld: { UldId: 8, FlightId: 2, UldNumber: 'PMC48921R7', CurrentStatus: 'WAREHOUSE', IdentityVerified: 0, Direction: 'EXPORT' } });
  h.state.raceUldStatus = 'TRANSIT';
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const stale = await call(handler, 'POST', { uldId: 8, expectedCurrentStatus: 'WAREHOUSE', nextStatus: 'TRANSIT' });
  assert.equal(stale.status, 409);
  assert.equal(h.state.uld.CurrentStatus, 'TRANSIT');
  assert.equal(h.state.uld.IdentityVerified, 0);
  assert.equal(h.state.movements.length, 0);
  assert.equal(h.state.audits.length, 0);
});

test('missing ULD ID does not mutate', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 } });
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: 999, expectedCurrentStatus: 'ARRIVED', nextStatus: 'TRANSIT' });
  assert.equal(response.status, 404);
  assert.equal(h.state.uld.CurrentStatus, 'ARRIVED');
  assert.equal(h.state.movements.length, 0);
  assert.equal(h.state.audits.length, 0);
});

test('offload collection and completion each succeed once, then reject stale repeats', async () => {
  const h = sqlHarness({ offload: { OffloadId: 90, FlightId: 1, FlightNumber: 'CX178', UldNumber: 'AKE12345CX', ParkingBay: 'F25', Status: 'REQUESTED' } });
  const handler = loadHandler('api/offloads/index.js', h.sql);
  const collected = await call(handler, 'PATCH', { offloadId: 90, expectedCurrentStatus: 'REQUESTED', nextStatus: 'TRANSIT' });
  const collectAgain = await call(handler, 'PATCH', { offloadId: 90, expectedCurrentStatus: 'REQUESTED', nextStatus: 'TRANSIT' });
  const completed = await call(handler, 'PATCH', { offloadId: 90, expectedCurrentStatus: 'TRANSIT', nextStatus: 'COMPLETE', deliveredLocation: 'Cool Room 4' });
  const completeAgain = await call(handler, 'PATCH', { offloadId: 90, expectedCurrentStatus: 'TRANSIT', nextStatus: 'COMPLETE', deliveredLocation: 'Cool Room 4' });
  assert.deepEqual([collected.status, collectAgain.status, completed.status, completeAgain.status], [200, 409, 200, 409]);
  assert.equal(collectAgain.body.code, 'STALE_STATUS');
  assert.equal(completeAgain.body.code, 'STALE_STATUS');
  assert.equal(h.state.offload.Status, 'COMPLETE');
  assert.deepEqual(h.state.audits.map(event => [event.Action, event.FromStatus, event.ToStatus]), [
    ['Offload collected', 'REQUESTED', 'TRANSIT'],
    ['Offload delivered', 'TRANSIT', 'COMPLETE']
  ]);
});

test('offload request creates exactly one authoritative server audit', async () => {
  const h = sqlHarness();
  const handler = loadHandler('api/offloads/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: '7', uldNumber: 'AKE12345CX', flightId: 1, flightNumber: 'CX178', operatingDate: '2026-09-17', parkingBay: 'F25' });
  assert.equal(response.status, 201);
  assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.audits[0].Action, 'Offload requested');
  assert.equal(h.state.audits[0].ActorDisplayName, 'Concurrency Tester');
});

test('offload request attaches to the explicitly selected flight instance, never the newest matching number', async () => {
  const h = sqlHarness({ flights: [
    { FlightId: 100, FlightNumber: 'CX0178', OperatingDate: '2026-09-17', FlightStatus: 'ACTIVE' },
    { FlightId: 110, FlightNumber: 'CX178', OperatingDate: '2026-09-18', FlightStatus: 'ACTIVE' }
  ] });
  const handler = loadHandler('api/offloads/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: '7', uldNumber: 'PMC48921R7', flightId: 100, flightNumber: 'CX178', operatingDate: '2026-09-17', parkingBay: 'F25' });
  assert.equal(response.status, 201);
  assert.equal(h.state.offload.FlightId, '100');
  assert.equal(h.state.offload.FlightNumber, 'CX0178');
  assert.equal(response.body.offload.operatingDate, '2026-09-17');
  assert.equal(h.state.queries.some(call => /TOP 1|ORDER BY OperatingDate DESC/.test(call.q)), false);
});

test('invalid FlightId and mismatched flight context fail closed without insert or success audit', async () => {
  const h = sqlHarness({ flights: [{ FlightId: 100, FlightNumber: 'CX178', OperatingDate: '2026-09-17', FlightStatus: 'ACTIVE' }] });
  const handler = loadHandler('api/offloads/index.js', h.sql);
  const missing = await call(handler, 'POST', { uldId: '7', uldNumber: 'AKE12345CX', flightId: 999, flightNumber: 'CX178', operatingDate: '2026-09-17', parkingBay: 'F25' });
  const wrongNumber = await call(handler, 'POST', { uldId: '7', uldNumber: 'AKE12345CX', flightId: 100, flightNumber: 'QF11', operatingDate: '2026-09-17', parkingBay: 'F25' });
  const wrongDate = await call(handler, 'POST', { uldId: '7', uldNumber: 'AKE12345CX', flightId: 100, flightNumber: 'CX178', operatingDate: '2026-09-18', parkingBay: 'F25' });
  h.state.flights[0].FlightStatus = 'CANCELLED';
  const inactive = await call(handler, 'POST', { uldId: '7', uldNumber: 'AKE12345CX', flightId: 100, flightNumber: 'CX178', operatingDate: '2026-09-17', parkingBay: 'F25' });
  assert.deepEqual([missing.status, wrongNumber.status, wrongDate.status, inactive.status], [404, 409, 409, 409]);
  assert.equal(wrongNumber.body.code, 'FLIGHT_CONTEXT_MISMATCH');
  assert.equal(inactive.body.code, 'FLIGHT_NOT_ELIGIBLE');
  assert.equal(h.state.offload, null);
  assert.equal(h.state.audits.length, 0);
});

test('offload GET returns operating date from the flight linked by FlightId', async () => {
  const h = sqlHarness({
    offload: { OffloadId: 90, FlightId: 100, FlightNumber: 'CX178', UldNumber: 'AKE12345CX', ParkingBay: 'F25', Status: 'REQUESTED' },
    flights: [
      { FlightId: 100, StationId: 1, FlightNumber: 'CX178', OperatingDate: '2026-09-17', FlightStatus: 'ACTIVE' },
      { FlightId: 110, StationId: 2, FlightNumber: 'CX178', OperatingDate: '2026-09-18', FlightStatus: 'ACTIVE' }
    ]
  });
  const handler = loadHandler('api/offloads/index.js', h.sql);
  const response = await call(handler, 'GET', null, { stationId: '1' });
  assert.equal(response.status, 200);
  assert.equal(response.body.offloads[0].flightId, 100);
  assert.equal(response.body.offloads[0].operatingDate, '2026-09-17');
});

test('required audit failure rolls back offload creation', async () => {
  const h = sqlHarness();
  h.state.failAudit = true;
  const handler = loadHandler('api/offloads/index.js', h.sql);
  const response = await call(handler, 'POST', { uldId: '7', uldNumber: 'AKE12345CX', flightId: 1, flightNumber: 'CX178', operatingDate: '2026-09-17', parkingBay: 'F25' });
  assert.equal(response.status, 500);
  assert.equal(h.state.offload, null);
  assert.equal(h.state.audits.length, 0);
  assert.equal(h.state.commits, 0);
  assert.equal(h.state.rollbacks, 1);
});

test('mail scan writes one authoritative audit and an idempotent retry writes none', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, FlightNumber: 'CX178', UldNumber: 'AKE12345CX', CurrentStatus: 'RECEIVED' } });
  const handler = loadHandler('api/mail-scan/index.js', h.sql);
  const first = await call(handler, 'POST', { uldId: 7 });
  const retry = await call(handler, 'POST', { uldId: 7 });
  assert.equal(first.status, 200);
  assert.equal(first.body.alreadyScanned, false);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.alreadyScanned, true);
  assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.audits[0].Action, 'Bulk mail scanned');
});

test('offload race and wrong ID do not mutate another request', async () => {
  const h = sqlHarness({ offload: { OffloadId: 90, FlightId: 1, FlightNumber: 'CX178', UldNumber: 'AKE12345CX', ParkingBay: 'F25', Status: 'REQUESTED' } });
  const handler = loadHandler('api/offloads/index.js', h.sql);
  h.state.raceOffloadStatus = 'TRANSIT';
  const raced = await call(handler, 'PATCH', { offloadId: 90, expectedCurrentStatus: 'REQUESTED', nextStatus: 'TRANSIT' });
  const missing = await call(handler, 'PATCH', { offloadId: 91, expectedCurrentStatus: 'REQUESTED', nextStatus: 'TRANSIT' });
  assert.equal(raced.status, 409);
  assert.equal(raced.body.code, 'STALE_STATUS');
  assert.equal(missing.status, 404);
  assert.equal(h.state.offload.OffloadId, 90);
  assert.equal(h.state.offload.Status, 'TRANSIT');
  assert.equal(h.state.audits.length, 0);
});

test('required audit failure rolls back the successful ULD mutation', async () => {
  const h = sqlHarness({ uld: { UldId: 7, FlightId: 1, UldNumber: 'AKE12345CX', CurrentStatus: 'ARRIVED', IdentityVerified: 0 } });
  h.state.failAudit = true;
  const handler = loadHandler('api/uld-status/index.js', h.sql);
  const response = await call(handler, 'POST', {
    uldId: 7,
    expectedCurrentStatus: 'ARRIVED',
    nextStatus: 'TRANSIT',
    actorDisplayName: 'Untrusted Browser Name'
  });
  assert.equal(response.status, 500);
  assert.equal(h.state.uld.CurrentStatus, 'ARRIVED');
  assert.equal(h.state.uld.IdentityVerified, 0);
  assert.equal(h.state.audits.length, 0);
  assert.equal(h.state.movements.length, 0);
  assert.equal(h.state.rollbacks, 1);
});

test('frontend operational feedback does not POST a duplicate browser audit', () => {
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const start = source.indexOf('function logEvent(');
  const end = source.indexOf('function clearLocalCargoRunCache(', start);
  const logEventSource = source.slice(start, end);
  assert.doesNotMatch(logEventSource, /\/api\/history/);
  assert.doesNotMatch(source, /function postAuditEvent/);
});

test('operational mutation handlers write required audits before commit', () => {
  for (const relativePath of [
    'api/uld-status/index.js',
    'api/offloads/index.js',
    'api/mail-scan/index.js',
    'api/flights/index.js',
    'api/import-completions/index.js',
    'api/export-completions/index.js'
  ]) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.match(source, /await insertAuditEvent\(/, relativePath);
  }
  const frontend = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(frontend, /body:JSON\.stringify\(\{flightId:f\.azureFlightId,inBlockAtUtc\}\)/);
});

test('canonical ULD status function exposes the unchanged public route', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'api/uld-status/function.json'), 'utf8'));
  const trigger = config.bindings.find(binding => binding.type === 'httpTrigger');
  assert.equal(trigger.route, 'uld-status');
  assert.deepEqual(Array.from(trigger.methods), ['post']);
  const source = fs.readFileSync(path.join(root, 'api/uld-status/index.js'), 'utf8');
  assert.match(source, /WHERE UldId = @UldId\s+AND CurrentStatus = @ExpectedStatus/);
});
