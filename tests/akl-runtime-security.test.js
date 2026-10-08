'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveCapabilities } = require('../api/shared/configuration');
const { CONTROL_PLANE_CAPABILITIES, isControlPlaneCapability } = require('../api/shared/capability-scope');
const authorization = require('../api/shared/operational-authorization');
const { resolveActorCapabilities, requireMutationCapability } = require('../api/shared/configuration-mutations');
const { loadHandler, call } = require('./helpers/operational-harness');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const operations = ['VIEW_FLIGHTS','MOVE_ULD','SCAN_ULD','VIEW_PRIORITY','REQUEST_OFFLOAD',
  'COLLECT_OFFLOAD','COMPLETE_OFFLOAD','SET_IN_BLOCK','SET_ETD','UPLOAD_FLIGHT_DATA',
  'CONFIRM_EXPORT_FINAL','FINALISE_FLIGHT','VIEW_FLIGHT_STATEMENT','VIEW_HISTORY','EXPORT_HISTORY','VIEW_SUPERVISOR'];
const admin = { reference: 'reviewed-admin', displayName: 'Admin' };
const date = '2026-09-27';
const mel = { StationId: '17', StationCode: 'MEL', DisplayName: 'Melbourne', TimeZoneId: 'Australia/Melbourne', IsEnabled: 1 };
const akl = { StationId: '42', StationCode: 'AKL', DisplayName: 'Auckland', TimeZoneId: 'Pacific/Auckland', IsEnabled: 1 };
const grant = (RoleId, StationCode, extra = {}) => ({
  UserRoleVersionId: 1, ActorReference: admin.reference, RoleId, StationCode,
  AssignmentAction: 'GRANT', EffectiveFrom: '2026-01-01', ...extra
});
function snapshot(assignments = [grant(1, null)]) {
  return {
    userRoleAssignments: assignments,
    // Deliberately use the OLD mixed ADMIN role to exercise defense in depth.
    roleCapabilities: [
      ...[...CONTROL_PLANE_CAPABILITIES, ...operations].map((CapabilityCode, index) => ({
        RoleId: 1, CapabilityCode, CapabilityAction: 'GRANT', EffectiveFrom: '2026-01-01', RoleCapabilityVersionId: index + 1
      })),
      ...operations.map((CapabilityCode, index) => ({
        RoleId: 2, CapabilityCode, CapabilityAction: 'GRANT', EffectiveFrom: '2026-01-01', RoleCapabilityVersionId: index + 30
      }))
    ]
  };
}

test('global mixed ADMIN yields only the complete six control-plane capabilities at every station', () => {
  for (const station of ['', 'MEL', 'AKL', 'FORGED']) {
    assert.deepEqual(resolveCapabilities(snapshot(), admin.reference, date, station), [...CONTROL_PLANE_CAPABILITIES].sort());
  }
  for (const capability of operations) assert.equal(isControlPlaneCapability(capability), false);
  assert.equal(isControlPlaneCapability('FUTURE_UNREVIEWED_CAPABILITY'), false);
});

test('explicit MEL operations survive while adding AKL creates no new operational authority', () => {
  const config = snapshot([grant(1, null), grant(2, 'MEL')]);
  assert.deepEqual(resolveCapabilities(config, admin.reference, date, 'MEL'),
    [...CONTROL_PLANE_CAPABILITIES, ...operations].sort());
  for (const station of ['AKL', 'SYD', '']) {
    assert.deepEqual(resolveCapabilities(config, admin.reference, date, station), [...CONTROL_PLANE_CAPABILITIES].sort());
  }
  assert.deepEqual(resolveCapabilities(config, 'another-actor', date, 'MEL'), []);
  config.userRoleAssignments.push(grant(2, 'AKL', { UserRoleVersionId: 3 }));
  assert.deepEqual(resolveCapabilities(config, admin.reference, date, 'AKL'),
    [...CONTROL_PLANE_CAPABILITIES, ...operations].sort());
});

test('global operational role, explicit revoke, future grant, and expired grant remain denied', () => {
  const config = snapshot([
    grant(1, null), grant(2, null), grant(2, 'MEL'),
    grant(2, 'MEL', { UserRoleVersionId: 4, EffectiveFrom: '2026-09-26', AssignmentAction: 'REVOKE' }),
    grant(2, 'AKL', { UserRoleVersionId: 5, EffectiveFrom: '2026-10-01' }),
    grant(2, 'SYD', { UserRoleVersionId: 6, EffectiveTo: '2026-09-01' })
  ]);
  for (const station of ['', 'MEL', 'AKL', 'SYD']) {
    assert.deepEqual(resolveCapabilities(config, admin.reference, date, station), [...CONTROL_PLANE_CAPABILITIES].sort());
  }
});

function sqlFixture(accessRows = [], capabilityRows = []) {
  const state = { queries: [] };
  class Request {
    constructor() { this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(query) {
      state.queries.push({ query, values: { ...this.values } });
      if (query.includes('WITH AuthorizationScopes')) return { recordset: accessRows };
      if (query.includes('WITH AssignmentDecisions')) return { recordset: capabilityRows };
      if (query.includes('FROM dbo.CargoRunStations')) return { recordset: this.values.ResolvedStationId === '42' ? [akl] : [mel] };
      throw new Error('Unexpected query in scope fixture');
    }
  }
  class ConnectionPool {
    async connect() { return this; }
    async close() {}
  }
  return { sql: { Request, ConnectionPool, NVarChar: n => n, VarChar: n => n, BigInt: 'bigint' }, state };
}

test('session excludes global operational rows and control-only station rows from its picker', async () => {
  const fixture = sqlFixture([
    ...CONTROL_PLANE_CAPABILITIES.map(CapabilityCode => ({ StationId: null, StationCode: null, CapabilityCode })),
    { StationId: null, StationCode: null, CapabilityCode: 'VIEW_FLIGHTS' },
    { ...akl, CapabilityCode: 'VIEW_ADMIN_AUDIT' }
  ]);
  const access = await authorization.resolveActorAccess({}, fixture.sql, admin);
  assert.deepEqual(access.stations, []);
  assert.deepEqual(access.capabilities, [...CONTROL_PLANE_CAPABILITIES].sort());
  assert.equal(access.provisioned, true);
  await authorization.requireAnyOperationalCapability({}, fixture.sql, admin, ['MANAGE_USERS']);
  await assert.rejects(authorization.requireOperationalStations({}, fixture.sql, admin, 'VIEW_FLIGHTS'), { code: 'CAPABILITY_REQUIRED' });
  // Source contract: database scope membership cannot be supplied by the browser.
  const query = fixture.state.queries[0].query;
  assert.match(query, /scope.StationId IS NOT NULL AND assignment.StationId=scope.StationId/);
  assert.doesNotMatch(query, /assignment.StationId IS NULL OR assignment.StationId=scope.StationId/);
  assert.match(query, /decision.StationId IS NOT NULL OR capability.CapabilityCode IN/);
});

test('actual session and selected-station gates expose MEL only until an explicit AKL result exists', async () => {
  const rows = [
    ...CONTROL_PLANE_CAPABILITIES.map(CapabilityCode => ({ StationId: null, StationCode: null, CapabilityCode })),
    ...operations.map(CapabilityCode => ({ ...mel, CapabilityCode }))
  ];
  const fixture = sqlFixture(rows);
  const handler = loadHandler('api/session/index.js', fixture.sql, authorization);
  const before = await call(handler, 'GET', {}, { stationId: '42', role: 'ADMIN' });
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.stations, ['MEL']);
  const access = await authorization.resolveActorAccess({}, fixture.sql, admin);
  for (const stationId of ['42', '1', '999', null, 'AKL']) {
    assert.throws(() => authorization.authorizeRequestedStation({ userAccess: access, stationId, requiredCapability: 'VIEW_FLIGHTS' }),
      { code: 'STATION_ACCESS_DENIED' });
  }
  assert.equal(authorization.authorizeRequestedStation({ userAccess: access, stationId: '17', requiredCapability: 'VIEW_FLIGHTS' }).stationCode, 'MEL');
  rows.push(...operations.map(CapabilityCode => ({ ...akl, CapabilityCode })));
  const after = await call(handler, 'GET', {});
  assert.deepEqual(after.body.stations, ['AKL', 'MEL']);
});

test('exact-operation SQL carries assignment ownership while global configuration authorization remains usable', async () => {
  const fixture = sqlFixture([], CONTROL_PLANE_CAPABILITIES.map(CapabilityCode => ({ CapabilityCode })));
  assert.deepEqual((await resolveActorCapabilities({}, fixture.sql, admin.reference, null)).sort(),
    [...CONTROL_PLANE_CAPABILITIES].sort());
  await requireMutationCapability({}, fixture.sql, admin.reference, null, 'EDIT_AIRLINE_RULES');
  await requireMutationCapability({}, fixture.sql, admin.reference, 'AKL', 'EDIT_SLA_RULES');
  await assert.rejects(authorization.requireOperationalEntityCapability({}, fixture.sql, admin,
    { FlightId: '80', StationId: '42', Direction: 'IMPORT', DestinationAirport: 'MEL' }, 'VIEW_FLIGHTS'),
    { code: 'OPERATIONAL_ENTITY_NOT_AVAILABLE' });
  const query = fixture.state.queries.find(item => item.query.includes('WITH AssignmentDecisions')).query;
  assert.match(query, /SELECT RoleId,StationId,StationEnabled FROM AssignmentDecisions/);
  assert.match(query, /decision.StationId IS NOT NULL AND decision.StationEnabled=1/);
  assert.match(query, /assignment.ActorReference=@AuthorizationActorReference/);
});
