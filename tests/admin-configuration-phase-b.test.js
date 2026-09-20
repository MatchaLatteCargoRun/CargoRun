'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  validateMutationInput,
  requiredCapabilityForOperation,
  validateGroupColour,
  groupTextColour,
  resolveGroupColour
} = require('../api/shared/configuration-admin');
const { resolveAirlineConfig } = require('../api/shared/configuration');
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
const sameDayMigration = fs.readFileSync(path.join(root, 'migrations', 'admin-same-day-decisions.sql'), 'utf8');
const sameDayPreflight = fs.readFileSync(path.join(root, 'migrations', 'admin-same-day-decisions-preflight.sql'), 'utf8');
const sameDayVerify = fs.readFileSync(path.join(root, 'migrations', 'admin-same-day-decisions-verify.sql'), 'utf8');
const principal = value => Buffer.from(JSON.stringify(value)).toString('base64');

function adminHarness({ capabilities = ['EDIT_AIRLINE_RULES'], lockResult = 0, oldProfile = null, oldGroup = null, auditFailure = false, airlineExists = true, profileInsertError = null } = {}) {
  const state = { commits: 0, rollbacks: 0, insertedAirlines: [], insertedProfiles: [], insertedGroupVersions: [], audits: [], queries: [] };
  let currentProfile = oldProfile;
  let currentGroup = oldGroup;
  class Transaction {
    constructor() { this.pendingAirlines = []; this.pendingProfiles = []; this.pendingGroupVersions = []; this.pendingAudits = []; }
    async begin() { this.begun = true; }
    async commit() { state.commits++; state.insertedAirlines.push(...this.pendingAirlines); state.insertedProfiles.push(...this.pendingProfiles); state.insertedGroupVersions.push(...this.pendingGroupVersions); state.audits.push(...this.pendingAudits); if (this.pendingProfiles.length) currentProfile = { ProfileVersionId: 90 + state.insertedProfiles.length, ...this.pendingProfiles.at(-1) }; if (this.pendingGroupVersions.length) currentGroup = { GroupVersionId: 190 + state.insertedGroupVersions.length, ...this.pendingGroupVersions.at(-1) }; }
    async rollback() { state.rollbacks++; this.pendingAirlines = []; this.pendingProfiles = []; this.pendingGroupVersions = []; this.pendingAudits = []; }
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
      if (q.includes('FROM dbo.CargoRunAirlineProfiles')) return { recordset: currentProfile ? [currentProfile] : [] };
      if (q.includes('INSERT dbo.CargoRunAirlineProfiles')) {
        if (profileInsertError) throw profileInsertError;
        this.executor.pendingProfiles.push({ ...this.values });
        return { recordset: [{ ProfileVersionId: 91 + state.insertedProfiles.length + this.executor.pendingProfiles.length - 1 }] };
      }
      if (q.includes('FROM dbo.CargoRunShcGroups') && q.includes('GroupKey=@GroupKey')) return { recordset: [{ ShcGroupId: 20 }] };
      if (q.includes('FROM dbo.CargoRunShcGroupVersions')) return { recordset: currentGroup ? [currentGroup] : [] };
      if (q.includes('INSERT dbo.CargoRunShcGroupVersions')) {
        this.executor.pendingGroupVersions.push({ ...this.values });
        return { recordset: [{ GroupVersionId: 191 + state.insertedGroupVersions.length + this.executor.pendingGroupVersions.length - 1 }] };
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
  assert.equal(requiredCapabilityForOperation('shc-group-settings'), 'EDIT_SHC_RULES');
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
  const group = validateMutationInput('shc-groups', { intent: 'CREATE', groupKey: 'cold_chain', displayToken: 'TEMP', displayName: 'Cold Chain', description: 'Temperature control', displayOrder: 25, displayColour: '#176B79', isEnabled: true, effectiveFrom: '2026-09-21' });
  assert.equal(group.groupKey, 'COLD_CHAIN');
  assert.equal(group.visualClass, '#176B79');
  const priority = validateMutationInput('priority-rules', { groupKey: 'COLD_CHAIN', priorityLevel: 'high', countsAsPriority: true, supervisorAttention: true, escalationEnabled: false, effectiveFrom: '2026-09-21' });
  assert.equal(priority.priorityLevel, 'HIGH');
  const mail = validateMutationInput('mail-rules', { airlineCode: 'cx', stationCode: 'mel', mailHandlingRequired: true, mailScanRequired: true, slaEnabled: true, slaRuleKey: 'mail_scan', reminderEnabled: true, escalationEnabled: true, effectiveFrom: '2026-09-21' });
  assert.equal(mail.slaRuleKey, 'MAIL_SCAN');
  assert.throws(() => validateMutationInput('mail-rules', { ...mail, slaRuleKey: '', effectiveFrom: '2026-09-21' }), error => error.code === 'CONFIGURATION_MAIL_SLA_REQUIRED');
});

test('priority edits can move scope without silently creating an unrelated rule', () => {
  const value = validateMutationInput('priority-rules', { intent: 'UPDATE', groupKey: 'PHARMA', previousGroupKey: 'temp', airlineCode: 'ua', previousAirlineCode: 'cx', stationCode: 'syd', previousStationCode: 'mel', priorityLevel: 'HIGH', countsAsPriority: true, supervisorAttention: true, escalationEnabled: true, effectiveFrom: '2026-09-21' });
  assert.deepEqual({ group: value.previousGroupKey, airline: value.previousAirlineCode, station: value.previousStationCode }, { group: 'TEMP', airline: 'CX', station: 'MEL' });
  assert.match(mutationSource, /const moved = value\.intent === 'UPDATE'/);
  assert.match(mutationSource, /intent: 'DELETE'[\s\S]*intent: 'CREATE'/);
  assert.match(mutationSource, /requireMutationCapability\(transaction, sql, actor\.reference, value\.previousStationCode/);
  assert.match(html, /previousGroupKey:adminEditSource\?\.GroupKey/);
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

test('normal settings intents are server validated and delete creates inactive successor values', () => {
  const deletedAirline = validateMutationInput('airlines', { ...airlineInput, intent: 'DELETE' });
  assert.equal(deletedAirline.isEnabled, false);
  const deletedPriority = validateMutationInput('priority-rules', { intent: 'DELETE', groupKey: 'TEMP', priorityLevel: 'HIGH', countsAsPriority: true, supervisorAttention: true, escalationEnabled: true, effectiveFrom: '2026-09-21' });
  assert.deepEqual({ level: deletedPriority.priorityLevel, priority: deletedPriority.countsAsPriority, supervisor: deletedPriority.supervisorAttention }, { level: 'NORMAL', priority: false, supervisor: false });
  const deletedMail = validateMutationInput('mail-rules', { intent: 'DELETE', slaEnabled: true, effectiveFrom: '2026-09-21' });
  assert.equal(deletedMail.slaEnabled, false);
  assert.throws(() => validateMutationInput('airlines', { ...airlineInput, intent: 'DESTROY' }), error => error.code === 'CONFIGURATION_INTENT_INVALID');
});

test('SHC group colours are strict hex with readable foreground and legacy fallback mapping', () => {
  assert.equal(validateGroupColour('#c98a00'), '#C98A00');
  assert.equal(groupTextColour('#FFFFFF'), '#000000');
  assert.equal(groupTextColour('#063F61'), '#FFFFFF');
  assert.equal(resolveGroupColour('temp'), '#176B79');
  assert.equal(resolveGroupColour(null), '#365F76');
  assert.throws(() => validateGroupColour('temp'), error => error.code === 'CONFIGURATION_COLOUR_INVALID');
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
        const { REQUIRED_CONFIGURATION_TABLES, DECISION_SEQUENCE_TABLES } = require('../api/shared/configuration-store');
        return { recordset: REQUIRED_CONFIGURATION_TABLES.map(name => ({ name, ColumnName: DECISION_SEQUENCE_TABLES.includes(name) ? 'DecisionSequence' : null })) };
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
  const result = await executeConfigurationMutation(h.pool, h.sql, 'airlines', { ...airlineInput, intent: 'CREATE', airlineCode: 'NZ', displayName: 'Air New Zealand' }, { reference: 'admin-id', displayName: 'Admin User' });
  assert.equal(result.count, 1);
  assert.equal(h.state.insertedAirlines.length, 1);
  assert.equal(h.state.insertedProfiles.length, 1);
  assert.equal(h.state.audits.length, 1);
  assert.equal(h.state.audits[0].ConfigurationOperation, 'AIRLINE_CREATED');
});

test('delete requires the same server capability and appends one audited successor', async () => {
  const denied = adminHarness({ capabilities: [], oldProfile: { ProfileVersionId: 1, EffectiveFrom: new Date('2020-01-01T00:00:00Z') } });
  await assert.rejects(executeConfigurationMutation(denied.pool, denied.sql, 'airlines', { ...airlineInput, intent: 'DELETE' }, { reference: 'ordinary-user', displayName: 'User' }), error => error.status === 403);
  assert.equal(denied.state.insertedProfiles.length, 0);
  const allowed = adminHarness({ oldProfile: { ProfileVersionId: 3, DecisionSequence: 3, EffectiveFrom: new Date('2026-09-21T00:00:00Z'), IsEnabled: true } });
  await executeConfigurationMutation(allowed.pool, allowed.sql, 'airlines', { ...airlineInput, intent: 'DELETE' }, { reference: 'admin-id', displayName: 'Admin' });
  assert.equal(allowed.state.insertedProfiles[0].IsEnabled, false);
  assert.equal(allowed.state.insertedProfiles[0].DecisionSequence, 4);
  assert.equal(allowed.state.audits[0].ConfigurationOperation, 'AIRLINE_DISABLED');
});

test('audit failure rolls back the configuration version', async () => {
  const h = adminHarness({ auditFailure: true, oldProfile: { ProfileVersionId: 1, EffectiveFrom: new Date('2020-01-01T00:00:00Z') } });
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

test('repeated same-day airline edits append deterministic decisions with complete audit evidence', async () => {
  const h = adminHarness({ oldProfile: { ProfileVersionId: 8, DecisionSequence: 1, EffectiveFrom: new Date('2026-09-21T00:00:00Z'), DisplayName: 'Cathay Pacific', BadgeColour: '#AAAAAA', IsEnabled: true } });
  await executeConfigurationMutation(h.pool, h.sql, 'airlines', { ...airlineInput, displayName: 'Cathay Updated', badgeColour: '#BBBBBB' }, { reference: 'admin-id', displayName: 'Admin User' });
  await executeConfigurationMutation(h.pool, h.sql, 'airlines', { ...airlineInput, displayName: 'Cathay Final', badgeColour: '#CCCCCC' }, { reference: 'admin-id', displayName: 'Admin User' });
  assert.deepEqual(h.state.insertedProfiles.map(row => row.DecisionSequence), [2, 3]);
  assert.equal(h.state.commits, 2);
  assert.equal(h.state.rollbacks, 0);
  assert.equal(h.state.audits.length, 2);
  assert.match(h.state.audits[0].ConfigurationOldValueJson, /#AAAAAA/);
  assert.match(h.state.audits[0].ConfigurationNewValueJson, /#BBBBBB/);
  assert.match(h.state.audits[1].ConfigurationOldValueJson, /#BBBBBB/);
  assert.match(h.state.audits[1].ConfigurationNewValueJson, /#CCCCCC/);
  const resolved = resolveAirlineConfig({ airlineProfiles: [
    { AirlineCode: 'CX', ProfileVersionId: 8, DecisionSequence: 1, EffectiveFrom: '2026-09-21', BadgeColour: '#AAAAAA', IsEnabled: true },
    { AirlineCode: 'CX', ProfileVersionId: 91, DecisionSequence: 2, EffectiveFrom: '2026-09-21', BadgeColour: '#BBBBBB', IsEnabled: true },
    { AirlineCode: 'CX', ProfileVersionId: 92, DecisionSequence: 3, EffectiveFrom: '2026-09-21', BadgeColour: '#CCCCCC', IsEnabled: true }
  ] }, { airlineCode: 'CX', operatingDate: '2026-09-21' });
  assert.equal(resolved.BadgeColour, '#CCCCCC');
});

test('same-day SHC group colour edit appends a shadow decision and audits old and new colours', async () => {
  const h = adminHarness({
    capabilities: ['EDIT_SHC_RULES'],
    oldGroup: { GroupVersionId: 7, DecisionSequence: 1, EffectiveFrom: new Date('2026-09-21T00:00:00Z'), VisualClass: '#176B79', DisplayName: 'Temperature' }
  });
  await executeConfigurationMutation(h.pool, h.sql, 'shc-groups', {
    intent: 'UPDATE', groupKey: 'TEMP', displayToken: 'TEMP', displayName: 'Temperature',
    description: 'Temperature controlled', displayOrder: 20, displayColour: '#225577',
    isEnabled: true, effectiveFrom: '2026-09-21', effectiveTo: ''
  }, { reference: 'admin-id', displayName: 'Admin User' });
  assert.equal(h.state.insertedGroupVersions[0].DecisionSequence, 2);
  assert.equal(h.state.insertedGroupVersions[0].VisualClass, '#225577');
  assert.equal(h.state.audits[0].ConfigurationOperation, 'SHC_GROUP_COLOUR_CHANGED');
  assert.match(h.state.audits[0].ConfigurationOldValueJson, /#176B79/);
  assert.match(h.state.audits[0].ConfigurationNewValueJson, /#225577/);
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

test('SHC group membership preview uses the shared scoped resolver and exposes colour mode', () => {
  const base = { EffectiveFrom: '2020-01-01', EffectiveTo: null };
  const snapshot = {
    shcs: [{ ShcCode: 'PIL', Description: 'Pharmaceutical' }, { ShcCode: 'COL', Description: 'Cool goods' }],
    shcGroupVersions: [{ ...base, GroupVersionId: 1, GroupKey: 'TEMP', DisplayToken: 'TEMP', DisplayName: 'Temperature', DisplayOrder: 1, VisualClass: 'temp', IsEnabled: true }],
    shcMappings: [
      { ...base, MappingId: 1, ShcCode: 'PIL', GroupKey: 'TEMP', MappingAction: 'INCLUDE' },
      { ...base, MappingId: 2, ShcCode: 'PIL', GroupKey: 'TEMP', AirlineCode: 'CX', StationCode: 'MEL', MappingAction: 'EXCLUDE' },
      { ...base, MappingId: 3, ShcCode: 'COL', GroupKey: 'TEMP', AirlineCode: 'CX', StationCode: 'MEL', MappingAction: 'INCLUDE' }
    ]
  };
  const preview = buildConfigurationPreview(snapshot, { kind: 'SHC_GROUP_MEMBERSHIP', groupKey: 'TEMP', airlineCode: 'CX', stationCode: 'MEL', operatingDate: '2026-09-20' });
  assert.deepEqual(preview.choices.filter(item => item.assigned).map(item => item.shcCode), ['COL']);
  assert.equal(preview.scope, 'AIRLINE_STATION');
  assert.deepEqual(preview.colour, { background: '#176B79', foreground: '#FFFFFF', mode: 'LEGACY_FALLBACK' });
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
  for (const operation of ['airlines', 'shc-group-settings', 'shc-mappings', 'priority-rules', 'sla-rules', 'mail-rules']) assert.match(html, new RegExp(`adminQueueMutation\\('${operation}'`));
  assert.match(html, /fetch\('\/api\/configuration-control\/preview'/);
  assert.doesNotMatch(apiSource, /req\.body\.(role|capabilities|actorReference)/);
  assert.match(apiSource, /LEGACY_OPERATIONAL_AUTHORIZATION/);
  assert.match(apiSource, /AUTHORIZED_BY_ADMIN_CAPABILITY/);
  assert.match(apiSource, /invalidateConfigurationCache\(\)/);
  assert.match(html, /Admin configuration is available on desktop/);
  assert.match(html, /READ ONLY — enforcement not enabled/);
  assert.match(html, /function adminEffectiveFields\(editing=false\)\{[\s\S]*editing\?adminToday\(\):adminDefaultEffectiveDate\(\)[\s\S]*adminEffectiveTo[^>]*value=""/);
});

test('Admin UI hides version mechanics and exposes normal CRUD plus authoritative group membership controls', () => {
  assert.doesNotMatch(html, /New (?:Rule )?Version|Version created/i);
  for (const label of ['New Rule', 'Edit', 'Save Changes', 'Delete Rule', 'New Group', 'Disable Group', 'Select all filtered']) assert.match(html, new RegExp(label));
  assert.match(html, /kind:'SHC_GROUP_MEMBERSHIP'/);
  assert.match(html, /expectedShcCodes/);
  assert.match(html, /selectedShcCodes/);
  assert.match(mutationSource, /CONFIGURATION_MEMBERSHIP_STALE/);
  assert.match(mutationSource, /SHC_MAPPING_ADDED/);
  assert.match(mutationSource, /SHC_MAPPING_REMOVED/);
  assert.match(mutationSource, /CargoRun:Configuration:\$\{key\.startsWith\('shc-'\) \? 'shc'/);
  assert.match(html, /Operational CargoRun token colours remain on the reviewed fallback/);
  assert.match(html, /function adminAuditLabel\(row\)/);
  assert.match(html, /SHC_GROUP_COLOUR_CHANGED/);
  assert.doesNotMatch(html, /<strong>\$\{esc\(row\.Operation\)\}<\/strong><small>\$\{esc\(row\.EntityType\)\} • \$\{esc\(row\.EntityId\)\}/);
});

test('same-day decision migration defers new-column references and preserves transactional safety', () => {
  const tables = [
    'CargoRunAirlineProfiles', 'CargoRunShcGroupVersions', 'CargoRunShcGroupMappings',
    'CargoRunPriorityRules', 'CargoRunSlaRules', 'CargoRunMailRules'
  ];
  for (const table of tables) {
    assert.match(sameDayMigration, new RegExp(`${table}[\\s\\S]{0,400}UQ_${table}_Version`));
    assert.match(sameDayVerify, new RegExp(table));
    assert.match(sameDayPreflight, new RegExp(table));
  }
  assert.match(sameDayMigration, /BEGIN TRY[\s\S]*BEGIN TRANSACTION[\s\S]*sp_getapplock/);
  assert.match(sameDayMigration, /@LockOwner='Transaction'/);
  assert.match(sameDayMigration, /IF @LockResult<0 THROW 51410/);
  assert.match(sameDayMigration, /SET @Sql=N'ALTER TABLE dbo\.'\+QUOTENAME\(@TableName\)[\s\S]*ADD DecisionSequence int NOT NULL/);
  assert.match(sameDayMigration, /EXEC sys\.sp_executesql @Sql;[\s\S]*DROP CONSTRAINT[\s\S]*EXEC sys\.sp_executesql @Sql;[\s\S]*UNIQUE\('/);
  assert.match(sameDayMigration, /BEGIN CATCH[\s\S]*ROLLBACK TRANSACTION[\s\S]*THROW/);
  assert.doesNotMatch(sameDayMigration, /ALTER TABLE dbo\.CargoRun\w+ ADD CONSTRAINT[^;]*DecisionSequence/i,
    'a static replacement constraint would reintroduce SQL Server new-column batch binding');
  assert.match(sameDayPreflight, /CLEAN_PRE_MIGRATION/);
  assert.match(sameDayPreflight, /CLEAN_MIGRATED/);
  assert.match(sameDayPreflight, /PARTIAL_OR_INCOMPATIBLE/);
  assert.match(sameDayPreflight, /PARTIAL_DECISION_SEQUENCE_INSTALL/);
  assert.match(sameDayVerify, /OBSOLETE_SAME_DAY_UNIQUENESS/);
  assert.match(sameDayVerify, /DISABLED_OR_UNTRUSTED_FOREIGN_KEY/);
  assert.match(sameDayVerify, /This is the final result set/);
  assert.match(mutationSource, /ORDER BY EffectiveFrom DESC,DecisionSequence DESC,ProfileVersionId DESC/);
  assert.match(mutationSource, /nextDecisionSequence\(oldValue, value\.effectiveFrom\)/);
  assert.doesNotMatch(mutationSource, /A version already exists for this identity, scope, and effective date/);
});

test('same-day sequence allocation occurs behind the transaction-owned family lock', () => {
  const begin = mutationSource.indexOf('await transaction.begin()');
  const lock = mutationSource.indexOf('await acquireConfigurationLock(transaction, sql, key)');
  const writer = mutationSource.indexOf('await writer(transaction, sql, value, actor)');
  assert.ok(begin >= 0 && begin < lock && lock < writer);
  assert.match(mutationSource, /CargoRun:Configuration:\$\{key\.startsWith\('shc-'\) \? 'shc' : key\}/);
  assert.match(mutationSource, /WITH \(UPDLOCK,HOLDLOCK\)[\s\S]*ORDER BY EffectiveFrom DESC,DecisionSequence DESC/);
  assert.match(mutationSource, /if \(!oldValue \|\| dateKey\(oldValue\.EffectiveFrom\) !== effectiveFrom\) return 1;[\s\S]*return current \+ 1/);
});

test('a duplicate sequence race fails closed and rolls back without audit evidence', async () => {
  const conflict = Object.assign(new Error('duplicate unique key'), { number: 2627 });
  const h = adminHarness({
    oldProfile: { ProfileVersionId: 8, DecisionSequence: 2, EffectiveFrom: new Date('2026-09-21T00:00:00Z') },
    profileInsertError: conflict
  });
  await assert.rejects(
    executeConfigurationMutation(h.pool, h.sql, 'airlines', airlineInput, { reference: 'admin-id', displayName: 'Admin User' }),
    error => error.code === 'CONFIGURATION_VERSION_CONFLICT' && error.status === 409
  );
  assert.equal(h.state.commits, 0);
  assert.equal(h.state.rollbacks, 1);
  assert.equal(h.state.insertedProfiles.length, 0);
  assert.equal(h.state.audits.length, 0);
});

test('SHC Admin render path initializes authoritative mapping state and supports assigned filters', () => {
  const line = name => html.split(/\r?\n/).find(value => value.startsWith(`function ${name}`) || value.startsWith(`async function ${name}`));
  const context = vm.createContext({
    state: { imports: [], exports: [] },
    adminShcFilters: { search: '', group: '', airline: '', unassignedOnly: false },
    adminToday: () => '2026-09-21',
    esc: value => String(value ?? ''),
    adminOptions: () => '',
    adminTable: (_headers, rows) => rows.join(''),
    Set, Map, String, Number
  });
  for (const name of ['adminLatestRows', 'adminOperationalShcs', 'adminCurrentMappings']) vm.runInContext(line(name), context);
  const masterLine = html.split(/\r?\n/).find(value => value.includes('function adminShcMaster(c)'));
  vm.runInContext(masterLine.slice(masterLine.indexOf('function adminShcMaster(c)')), context);
  context.configuration = {
    shcs: [
      { ShcCode: 'COL', Description: 'Cool goods', IsEnabled: true },
      { ShcCode: 'PIL', Description: 'Pharmaceutical', IsEnabled: true }
    ],
    shcMappings: [
      { MappingId: 1, DecisionSequence: 1, ShcCode: 'COL', GroupKey: 'TEMP', MappingAction: 'INCLUDE', EffectiveFrom: '2020-01-01' },
      { MappingId: 2, DecisionSequence: 1, ShcCode: 'PIL', GroupKey: 'PHARMA', MappingAction: 'INCLUDE', EffectiveFrom: '2026-09-21' },
      { MappingId: 3, DecisionSequence: 2, ShcCode: 'PIL', GroupKey: 'PHARMA', MappingAction: 'EXCLUDE', EffectiveFrom: '2026-09-21' }
    ],
    shcGroupVersions: [], airlineProfiles: []
  };
  const rendered = vm.runInContext('adminShcMaster(configuration)', context);
  assert.match(rendered, /COL[\s\S]*TEMP/);
  assert.match(rendered, /PIL[\s\S]*UNASSIGNED/);
  vm.runInContext('adminShcFilters.unassignedOnly=true', context);
  const unassigned = vm.runInContext('adminShcMaster(configuration)', context);
  assert.doesNotMatch(unassigned, /COL/);
  assert.match(unassigned, /PIL/);
});
