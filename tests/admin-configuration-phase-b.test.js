'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateMutationInput,
  requiredCapabilityForOperation
} = require('../api/shared/configuration-admin');
const {
  ConfigurationMutationError,
  executeConfigurationMutation,
  buildConfigurationPreview
} = require('../api/shared/configuration-mutations');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const apiSource = fs.readFileSync(path.join(root, 'api', 'configuration-admin', 'index.js'), 'utf8');
const mutationSource = fs.readFileSync(path.join(root, 'api', 'shared', 'configuration-mutations.js'), 'utf8');
const adminHelperSource = fs.readFileSync(path.join(root, 'api', 'shared', 'configuration-admin.js'), 'utf8');
const functionJson = JSON.parse(fs.readFileSync(path.join(root, 'api', 'configuration-admin', 'function.json'), 'utf8'));
const principal = value => Buffer.from(JSON.stringify(value)).toString('base64');

function adminHarness({ capabilities = ['EDIT_AIRLINE_RULES'], lockResult = 0, oldProfile = null, auditFailure = false, airlineExists = true } = {}) {
  const state = { commits: 0, rollbacks: 0, insertedAirlines: [], insertedProfiles: [], audits: [], queries: [] };
  class Transaction {
    constructor() { this.pendingAirlines = []; this.pendingProfiles = []; this.pendingAudits = []; }
    async begin() { this.begun = true; }
    async commit() { state.commits++; state.insertedAirlines.push(...this.pendingAirlines); state.insertedProfiles.push(...this.pendingProfiles); state.audits.push(...this.pendingAudits); }
    async rollback() { state.rollbacks++; this.pendingAirlines = []; this.pendingProfiles = []; this.pendingAudits = []; }
  }
  class Request {
    constructor(executor) { this.executor = executor; this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(query) {
      const q = String(query); state.queries.push({ q, values: { ...this.values } });
      if (q.includes('WITH AssignmentDecisions')) return { recordset: capabilities.map(CapabilityCode => ({ CapabilityCode })) };
      if (q.includes('sys.sp_getapplock')) return { recordset: [{ LockResult: lockResult }] };
      if (q.includes('FROM dbo.CargoRunAirlines') && q.includes('AirlineCode=@AirlineCode')) return { recordset: airlineExists ? [{ AirlineId: 10 }] : [] };
      if (q.includes('INSERT dbo.CargoRunAirlines')) {
        this.executor.pendingAirlines.push({ ...this.values });
        return { recordset: [{ AirlineId: 10 }] };
      }
      if (q.includes('FROM dbo.CargoRunAirlineProfiles')) return { recordset: oldProfile ? [oldProfile] : [] };
      if (q.includes('INSERT dbo.CargoRunAirlineProfiles')) {
        this.executor.pendingProfiles.push({ ...this.values });
        return { recordset: [{ ProfileVersionId: 91 }] };
      }
      if (q.includes('INSERT dbo.CargoRunConfigurationAudit')) {
        if (auditFailure) throw new Error('audit unavailable');
        this.executor.pendingAudits.push({ ...this.values });
        return { recordset: [{ ConfigurationAuditId: 501 }] };
      }
      throw new Error(`Unexpected SQL in test: ${q.slice(0, 100)}`);
    }
  }
  const type = size => size;
  const sql = {
    Transaction, Request, BigInt: 'bigint', Int: 'int', Bit: 'bit', Date: 'date', UniqueIdentifier: 'guid',
    VarChar: type, NVarChar: type, MAX: -1
  };
  return { sql, pool: {}, state };
}

const airlineInput = {
  airlineCode: 'CX', displayName: 'Cathay Pacific', badgeColour: '#006564',
  brightBadge: false, isEnabled: true, operationalNotes: 'Cargo profile',
  effectiveFrom: '2026-09-21', effectiveTo: ''
};

test('Phase B operation capabilities are explicit and do not accept arbitrary tables', () => {
  assert.equal(requiredCapabilityForOperation('airlines'), 'EDIT_AIRLINE_RULES');
  assert.equal(requiredCapabilityForOperation('shc-mappings'), 'EDIT_SHC_RULES');
  assert.equal(requiredCapabilityForOperation('priority-rules'), 'EDIT_SHC_RULES');
  assert.equal(requiredCapabilityForOperation('sla-rules'), 'EDIT_SLA_RULES');
  assert.equal(requiredCapabilityForOperation('mail-rules'), 'EDIT_AIRLINE_RULES');
  assert.equal(requiredCapabilityForOperation('CargoRunUsers'), null);
});

test('airline versions validate immutable code, colour and effective period server-side', () => {
  assert.equal(validateMutationInput('airlines', airlineInput).badgeColour, '#006564');
  assert.throws(() => validateMutationInput('airlines', { ...airlineInput, airlineCode: 'C/X' }), error => error.code === 'CONFIGURATION_CODE_INVALID');
  assert.throws(() => validateMutationInput('airlines', { ...airlineInput, badgeColour: 'blue' }), error => error.code === 'CONFIGURATION_COLOUR_INVALID');
  assert.throws(() => validateMutationInput('airlines', { ...airlineInput, effectiveTo: '2026-09-20' }), error => error.code === 'CONFIGURATION_EFFECTIVE_RANGE_INVALID');
});

test('group, priority and mail inputs retain the Phase A schema contract', () => {
  const group = validateMutationInput('shc-groups', { groupKey: 'cold_chain', displayToken: 'TEMP', displayName: 'Cold Chain', description: 'Temperature control', displayOrder: 25, visualClass: 'temp', isEnabled: true, effectiveFrom: '2026-09-21' });
  assert.equal(group.groupKey, 'COLD_CHAIN');
  const priority = validateMutationInput('priority-rules', { groupKey: 'COLD_CHAIN', priorityLevel: 'high', countsAsPriority: true, supervisorAttention: true, escalationEnabled: false, effectiveFrom: '2026-09-21' });
  assert.equal(priority.priorityLevel, 'HIGH');
  const mail = validateMutationInput('mail-rules', { airlineCode: 'cx', stationCode: 'mel', mailHandlingRequired: true, mailScanRequired: true, slaEnabled: true, slaRuleKey: 'mail_scan', reminderEnabled: true, escalationEnabled: true, effectiveFrom: '2026-09-21' });
  assert.equal(mail.slaRuleKey, 'MAIL_SCAN');
  assert.throws(() => validateMutationInput('mail-rules', { ...mail, slaRuleKey: '', effectiveFrom: '2026-09-21' }), error => error.code === 'CONFIGURATION_MAIL_SLA_REQUIRED');
});

test('SLA validation requires event definitions and safe positive ordering', () => {
  const valid = { ruleKey: 'WAREHOUSE_RETURN', direction: 'IMPORT', startEvent: 'IN_BLOCK', targetEvent: 'WAREHOUSE', targetMinutes: 45, warningMinutes: 40, breachMinutes: 45, isEnabled: true, effectiveFrom: '2026-09-21' };
  assert.equal(validateMutationInput('sla-rules', valid).targetMinutes, 45);
  assert.throws(() => validateMutationInput('sla-rules', { ...valid, targetMinutes: 0 }), error => error.code === 'CONFIGURATION_MINUTES_INVALID');
  assert.throws(() => validateMutationInput('sla-rules', { ...valid, breachMinutes: 30 }), error => error.code === 'CONFIGURATION_SLA_ORDER_INVALID');
  assert.throws(() => validateMutationInput('sla-rules', { ...valid, startEvent: 'WHATEVER' }), error => error.code === 'CONFIGURATION_EVENT_INVALID');
});

test('bulk SHC validation keeps many-to-many selections and explicit INCLUDE or EXCLUDE decisions', () => {
  const value = validateMutationInput('shc-mappings', { shcCodes: ['pil', 'COL', 'PIL'], groupKey: 'temp', mappingAction: 'INCLUDE', airlineCode: 'cx', stationCode: 'mel', effectiveFrom: '2026-10-01' });
  assert.deepEqual(value.shcCodes, ['PIL', 'COL']);
  assert.equal(value.groupKey, 'TEMP');
  assert.equal(value.airlineCode, 'CX');
  assert.throws(() => validateMutationInput('shc-mappings', { shcCodes: [], groupKey: 'TEMP', effectiveFrom: '2026-10-01' }), error => error.code === 'CONFIGURATION_SHC_SELECTION_INVALID');
});

test('authenticated non-admin mutation receives 403 and writes nothing', async () => {
  const h = adminHarness({ capabilities: [] });
  await assert.rejects(executeConfigurationMutation(h.pool, h.sql, 'airlines', airlineInput, { reference: 'normal-user', displayName: 'Normal User' }), error => error instanceof ConfigurationMutationError && error.status === 403);
  assert.equal(h.state.commits, 0);
  assert.equal(h.state.rollbacks, 1);
  assert.equal(h.state.insertedProfiles.length, 0);
  assert.equal(h.state.audits.length, 0);
});

test('missing trusted SWA principal is rejected before any database connection', async () => {
  const handler = require('../api/configuration-admin');
  const context = { log: { error() {} } };
  await handler(context, { method: 'POST', params: { operation: 'airlines' }, headers: {}, body: airlineInput });
  assert.equal(context.res.status, 401);
  assert.match(context.res.body, /Microsoft Entra sign-in is required/);
});

test('authenticated non-admin GET remains readable but reports Admin mutations disabled', async () => {
  const sql = require('../api/node_modules/mssql');
  const originalPool = sql.ConnectionPool;
  const originalRequest = sql.Request;
  class Pool {
    constructor() { this.config = { server: 'phase-b-test', database: 'phase-b-test' }; }
    async connect() { return this; }
    async close() {}
    request() { return { query: async query => {
      if (String(query).includes('FROM sys.tables')) {
        const { REQUIRED_CONFIGURATION_TABLES } = require('../api/shared/configuration-store');
        return { recordset: REQUIRED_CONFIGURATION_TABLES.map(name => ({ name })) };
      }
      if (String(query).includes('SELECT s.StationId')) return { recordsets: Array.from({ length: 12 }, () => []) };
      if (String(query).includes('WITH AssignmentDecisions')) return { recordset: [] };
      throw new Error(`Unexpected GET SQL: ${String(query).slice(0, 80)}`);
    } }; }
  }
  class Request {
    constructor(pool) { this.pool = pool; }
    input() { return this; }
    async query(query) { return this.pool.request().query(query); }
  }
  sql.ConnectionPool = Pool;
  sql.Request = Request;
  const originalConnectionString = process.env.DATABASE_CONNECTION_STRING;
  process.env.DATABASE_CONNECTION_STRING = 'phase-b-test';
  try {
    const handler = require('../api/configuration-admin');
    const errors = [];
    const context = { log: { error(...values) { errors.push(values); } } };
    await handler(context, { method: 'GET', params: {}, headers: { 'x-ms-client-principal': principal({ userId: 'ordinary-user', userDetails: 'Ordinary User', userRoles: ['authenticated'] }) } });
    const body = JSON.parse(context.res.body);
    assert.equal(context.res.status, 200, errors[0]?.[1]?.stack || errors[0]?.[1]?.message);
    assert.equal(body.authorization.adminMutationsEnabled, false);
    assert.deepEqual(body.authorization.capabilities, []);
    assert.equal(body.authorization.enforcement, 'LEGACY_OPERATIONAL_AUTHORIZATION');
  } finally {
    sql.ConnectionPool = originalPool;
    sql.Request = originalRequest;
    if (originalConnectionString === undefined) delete process.env.DATABASE_CONNECTION_STRING;
    else process.env.DATABASE_CONNECTION_STRING = originalConnectionString;
  }
});

test('authorized airline mutation appends profile and audit atomically with stable actor userId', async () => {
  const h = adminHarness({ oldProfile: { ProfileVersionId: 1, EffectiveFrom: new Date('2020-01-01T00:00:00Z'), DisplayName: 'Cathay Pacific' } });
  const result = await executeConfigurationMutation(h.pool, h.sql, 'airlines', { ...airlineInput, actorReference: 'spoofed-browser-role' }, { reference: 'swa-stable-user-id', displayName: 'Admin User' });
  assert.equal(result.capability, 'EDIT_AIRLINE_RULES');
  assert.equal(h.state.commits, 1);
  assert.equal(h.state.rollbacks, 0);
  assert.equal(h.state.insertedProfiles.length, 1);
  assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.insertedProfiles[0].ActorReference, 'swa-stable-user-id');
  assert.equal(h.state.audits[0].ConfigurationActorReference, 'swa-stable-user-id');
  assert.notEqual(h.state.audits[0].ConfigurationActorReference, 'spoofed-browser-role');
  assert.match(h.state.audits[0].ConfigurationOldValueJson, /Cathay Pacific/);
  assert.match(h.state.audits[0].ConfigurationNewValueJson, /Cargo profile/);
});

test('new airline identity and first profile commit in the same audited transaction', async () => {
  const h = adminHarness({ airlineExists: false });
  const result = await executeConfigurationMutation(h.pool, h.sql, 'airlines', { ...airlineInput, airlineCode: 'NZ', displayName: 'Air New Zealand' }, { reference: 'admin-id', displayName: 'Admin User' });
  assert.equal(result.count, 1);
  assert.equal(h.state.insertedAirlines.length, 1);
  assert.equal(h.state.insertedProfiles.length, 1);
  assert.equal(h.state.audits.length, 1);
  assert.match(h.state.audits[0].ConfigurationOperation, /AIRLINE_PROFILE_CREATED/);
});

test('audit failure rolls back the configuration version', async () => {
  const h = adminHarness({ auditFailure: true });
  await assert.rejects(executeConfigurationMutation(h.pool, h.sql, 'airlines', airlineInput, { reference: 'admin-id', displayName: 'Admin User' }), /audit unavailable/);
  assert.equal(h.state.commits, 0);
  assert.equal(h.state.rollbacks, 1);
  assert.equal(h.state.insertedProfiles.length, 0);
  assert.equal(h.state.audits.length, 0);
});

test('failed transaction-owned application lock aborts before configuration writes', async () => {
  const h = adminHarness({ lockResult: -1 });
  await assert.rejects(executeConfigurationMutation(h.pool, h.sql, 'airlines', airlineInput, { reference: 'admin-id', displayName: 'Admin User' }), error => error.code === 'CONFIGURATION_LOCK_FAILED');
  assert.equal(h.state.rollbacks, 1);
  assert.equal(h.state.insertedProfiles.length, 0);
  const lockSql = h.state.queries.find(entry => entry.q.includes('sp_getapplock')).q;
  assert.match(lockSql, /@LockOwner='Transaction'/);
});

test('same-scope same-effective-date airline version fails closed', async () => {
  const h = adminHarness({ oldProfile: { ProfileVersionId: 8, EffectiveFrom: new Date('2026-09-21T00:00:00Z') } });
  await assert.rejects(executeConfigurationMutation(h.pool, h.sql, 'airlines', airlineInput, { reference: 'admin-id', displayName: 'Admin User' }), error => error.code === 'CONFIGURATION_VERSION_CONFLICT' && error.status === 409);
  assert.equal(h.state.rollbacks, 1);
  assert.equal(h.state.insertedProfiles.length, 0);
});

test('shared resolver preview covers many-to-many priority, SLA simulation and mail shadow parity', () => {
  const base = { EffectiveFrom: '2020-01-01', EffectiveTo: null };
  const snapshot = {
    shcMappings: [
      { ...base, MappingId: 1, ShcCode: 'PIL', GroupKey: 'PHARMA', MappingAction: 'INCLUDE' },
      { ...base, MappingId: 2, ShcCode: 'PIL', GroupKey: 'TEMP', MappingAction: 'INCLUDE' }
    ],
    shcGroupVersions: [
      { ...base, GroupVersionId: 1, GroupKey: 'PHARMA', DisplayName: 'Pharma', DisplayOrder: 10 },
      { ...base, GroupVersionId: 2, GroupKey: 'TEMP', DisplayName: 'Temperature', DisplayOrder: 20 }
    ],
    priorityRules: [{ ...base, RuleId: 1, GroupKey: 'PHARMA', PriorityLevel: 'HIGH' }],
    slaRules: [{ ...base, RuleId: 2, RuleKey: 'MAIL_SCAN', Direction: 'IMPORT', StartEvent: 'IN_BLOCK', TargetEvent: 'MAIL_SCANNED', TargetMinutes: 180, WarningMinutes: 120, BreachMinutes: 180 }],
    mailRules: [{ ...base, RuleId: 3, AirlineCode: 'CX', MailHandlingRequired: true, MailScanRequired: true, SlaEnabled: true, SlaRuleKey: 'MAIL_SCAN', ReminderEnabled: true, EscalationEnabled: true }]
  };
  const context = { airlineCode: 'CX', stationCode: 'MEL', operatingDate: '2026-09-20' };
  const shc = buildConfigurationPreview(snapshot, { kind: 'SHC', ...context, rawShcs: ['PIL', 'XYZ'] });
  assert.deepEqual(shc.result.groups.map(group => group.groupKey), ['PHARMA', 'TEMP']);
  assert.deepEqual(shc.result.unassignedShcs, ['XYZ']);
  assert.equal(shc.result.priorityLevel, 2);
  const sla = buildConfigurationPreview(snapshot, { kind: 'SLA', ...context, direction: 'IMPORT', ruleKey: 'MAIL_SCAN', startAtUtc: '2026-09-20T18:00:00Z' });
  assert.equal(sla.targetAtUtc, '2026-09-20T21:00:00.000Z');
  assert.equal(sla.comparison.status, 'MATCH');
  const mail = buildConfigurationPreview(snapshot, { kind: 'MAIL', ...context });
  assert.equal(mail.comparison.status, 'MATCH');
  assert.equal(mail.sla.targetMinutes, 180);
});

test('mutation SQL is append-only across every editable Phase B table', () => {
  for (const table of ['CargoRunAirlineProfiles', 'CargoRunShcGroupVersions', 'CargoRunShcGroupMappings', 'CargoRunPriorityRules', 'CargoRunSlaRules', 'CargoRunMailRules']) {
    assert.match(mutationSource, new RegExp(`INSERT dbo\\.${table}`));
    assert.doesNotMatch(mutationSource, new RegExp(`(?:UPDATE|DELETE\\s+FROM) dbo\\.${table}`, 'i'));
  }
  assert.match(adminHelperSource, /INSERT dbo\.CargoRunConfigurationAudit/);
  assert.match(mutationSource, /@LockOwner='Transaction'/);
  assert.match(mutationSource, /PARTITION BY assignment\.RoleId[\s\S]*CASE WHEN assignment\.StationId IS NULL THEN 0 ELSE 1 END DESC/);
});

test('Phase B route and desktop UI expose only explicit operations while legacy operational authorization stays unchanged', () => {
  const trigger = functionJson.bindings.find(binding => binding.type === 'httpTrigger');
  assert.deepEqual(trigger.methods, ['get', 'post']);
  assert.equal(trigger.route, 'configuration-control/{operation?}');
  assert.match(html, /fetch\(`\/api\/configuration-control\/\$\{encodeURIComponent\(pending\.operation\)\}`/);
  for (const operation of ['airlines', 'shc-groups', 'shc-mappings', 'priority-rules', 'sla-rules', 'mail-rules']) assert.match(html, new RegExp(`adminQueueMutation\\('${operation}'`));
  assert.match(html, /fetch\('\/api\/configuration-control\/preview'/);
  assert.doesNotMatch(apiSource, /req\.body\.(role|capabilities|actorReference)/);
  assert.match(apiSource, /LEGACY_OPERATIONAL_AUTHORIZATION/);
  assert.match(apiSource, /AUTHORIZED_BY_ADMIN_CAPABILITY/);
  assert.match(apiSource, /invalidateConfigurationCache\(\)/);
  assert.match(html, /Admin configuration is available on desktop/);
  assert.match(html, /READ ONLY — enforcement not enabled/);
  assert.match(html, /function adminEffectiveFields\(\)\{[\s\S]*adminDefaultEffectiveDate\(\)[\s\S]*adminEffectiveTo[^>]*value=""/);
});
