'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ConfigurationError,
  scopeRank,
  resolveScoped,
  resolveAirlineConfig,
  resolveShcGroups,
  resolvePriorityRules,
  resolveSlaRule,
  resolveMailRules,
  resolveDocumentRules,
  validateRuleSet,
  resolveCapabilities,
  authorizeCapability
} = require('../api/shared/configuration');
const { validateConfigurationInput, insertConfigurationAudit } = require('../api/shared/configuration-admin');
const { REQUIRED_CONFIGURATION_TABLES, loadCachedConfiguration, invalidateConfigurationCache } = require('../api/shared/configuration-store');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations', 'admin-configuration.sql'), 'utf8');
const preflight = fs.readFileSync(path.join(root, 'migrations', 'admin-configuration-preflight.sql'), 'utf8');
const verify = fs.readFileSync(path.join(root, 'migrations', 'admin-configuration-verify.sql'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'migrations', 'admin-bootstrap-user.sql'), 'utf8');
const bootstrapVerify = fs.readFileSync(path.join(root, 'migrations', 'admin-bootstrap-user-verify.sql'), 'utf8');
const foundation = fs.readFileSync(path.join(root, 'docs', 'admin-configuration-foundation.md'), 'utf8');
const adminFunctionDirectory = path.join(root, 'api', 'configuration-admin');
const adminApi = fs.readFileSync(path.join(adminFunctionDirectory, 'index.js'), 'utf8');
const adminFunction = JSON.parse(fs.readFileSync(path.join(adminFunctionDirectory, 'function.json'), 'utf8'));

const context = { airlineCode: 'CX', stationCode: 'MEL', operatingDate: '2026-09-19', direction: 'IMPORT' };
const row = (extra = {}) => ({ EffectiveFrom: '2020-01-01', EffectiveTo: null, ...extra });

test('scope precedence is Global then Station then Airline then Airline+Station', () => {
  assert.equal(scopeRank(row(), context), 0);
  assert.equal(scopeRank(row({ StationCode: 'MEL' }), context), 1);
  assert.equal(scopeRank(row({ AirlineCode: 'CX' }), context), 2);
  assert.equal(scopeRank(row({ AirlineCode: 'CX', StationCode: 'MEL' }), context), 3);
  assert.equal(scopeRank(row({ AirlineCode: 'UA' }), context), -1);
});

test('scoped resolution chooses the deterministic most-specific decision', () => {
  const rows = [
    row({ RuleId: 1, Value: 'global' }),
    row({ RuleId: 2, StationCode: 'MEL', Value: 'station' }),
    row({ RuleId: 3, AirlineCode: 'CX', Value: 'airline' }),
    row({ RuleId: 4, AirlineCode: 'CX', StationCode: 'MEL', Value: 'airline-station' })
  ];
  assert.equal(resolveScoped(rows, context).Value, 'airline-station');
  assert.equal(resolveScoped(rows, { ...context, stationCode: 'SYD' }).Value, 'airline');
  assert.equal(resolveScoped(rows, { ...context, airlineCode: 'QR' }).Value, 'station');
});

test('effective dates retain historical interpretation and use exclusive EffectiveTo', () => {
  const rules = [
    row({ RuleId: 1, RuleKey: 'TEST', EffectiveFrom: '2026-01-01', EffectiveTo: '2026-11-01', TargetMinutes: 60 }),
    row({ RuleId: 2, RuleKey: 'TEST', EffectiveFrom: '2026-11-01', TargetMinutes: 45 })
  ];
  assert.equal(resolveScoped(rules, { ...context, operatingDate: '2026-09-19' }).TargetMinutes, 60);
  assert.equal(resolveScoped(rules, { ...context, operatingDate: '2026-11-01' }).TargetMinutes, 45);
});

test('same-scope same-date ambiguity fails closed', () => {
  assert.throws(() => resolveScoped([
    row({ RuleId: 1, AirlineCode: 'CX' }), row({ RuleId: 2, AirlineCode: 'CX' })
  ], context), error => error instanceof ConfigurationError && error.code === 'CONFIGURATION_AMBIGUOUS');
});

test('one raw SHC can resolve into several configured groups', () => {
  const snapshot = {
    shcMappings: ['PHARMA', 'TEMP', 'HIGH_PRIORITY'].map((GroupKey, index) => row({ MappingId: index + 1, ShcCode: 'PIL', GroupKey, AirlineCode: 'CX', MappingAction: 'INCLUDE' })),
    shcGroupVersions: ['PHARMA', 'TEMP', 'HIGH_PRIORITY'].map((GroupKey, index) => row({ GroupVersionId: index + 1, GroupKey, DisplayName: GroupKey, DisplayToken: GroupKey, DisplayOrder: index + 1 }))
  };
  const result = resolveShcGroups(snapshot, { ...context, rawShcs: ['PIL'] });
  assert.deepEqual(result.groups.map(group => group.groupKey), ['PHARMA', 'TEMP', 'HIGH_PRIORITY']);
  assert.deepEqual(result.unassignedShcs, []);
});

test('mapping EXCLUDE overrides inherited include without deleting raw SHC', () => {
  const snapshot = { shcMappings: [
    row({ MappingId: 1, ShcCode: 'AVI', GroupKey: 'LIVE', MappingAction: 'INCLUDE' }),
    row({ MappingId: 2, ShcCode: 'AVI', GroupKey: 'LIVE', AirlineCode: 'CX', StationCode: 'MEL', MappingAction: 'EXCLUDE' })
  ] };
  const result = resolveShcGroups(snapshot, { ...context, rawShcs: ['AVI'] });
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.unassignedShcs, []);
});

test('unassigned SHCs are surfaced without guessing or crashing', () => {
  const result = resolveShcGroups({}, { ...context, rawShcs: ['XYZ'] });
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.unassignedShcs, ['XYZ']);
});

test('current SHC grouping and airline badge behavior remain exact fallbacks', () => {
  assert.equal(resolveAirlineConfig({}, context).badgeColour, '#006564');
  assert.deepEqual(resolveShcGroups({}, { ...context, rawShcs: ['AVI', 'PIL', 'COL', 'MAL'] }).groups.map(group => group.groupKey), ['LIVE', 'TEMP', 'PHARMA', 'MAIL']);
  assert.equal(resolveAirlineConfig({}, { ...context, airlineCode: 'ZZ' }).badgeColour, '#365f76');
});

test('grouped priority resolution supports ranked configured levels', () => {
  const snapshot = {
    shcMappings: [row({ MappingId: 1, ShcCode: 'PIL', GroupKey: 'PHARMA', MappingAction: 'INCLUDE' })],
    priorityRules: [row({ RuleId: 1, GroupKey: 'PHARMA', AirlineCode: 'CX', PriorityLevel: 'HIGH' })]
  };
  const result = resolvePriorityRules(snapshot, { ...context, rawShcs: ['PIL'] });
  assert.equal(result.priorityLevel, 2);
  assert.equal(result.groups[0].priorityLevel, 'HIGH');
});

test('SLA, mail and document rules resolve configured values then current fallback', () => {
  assert.equal(resolveSlaRule({}, context, 'IMPORT_ACCEPTANCE_STANDARD').warningMinutes, 20);
  assert.equal(resolveSlaRule({ slaRules: [row({ RuleId: 8, RuleKey: 'IMPORT_ACCEPTANCE_STANDARD', AirlineCode: 'CX', WarningMinutes: 15 })] }, context, 'IMPORT_ACCEPTANCE_STANDARD').WarningMinutes, 15);
  assert.equal(resolveMailRules({}, context).mailScanRequired, true);
  assert.equal(resolveMailRules({}, { ...context, airlineCode: 'QR' }).mailScanRequired, false);
  assert.equal(resolveDocumentRules({}, context, 'UWS').source, 'fallback');
  assert.equal(resolveDocumentRules({ documentRules: [row({ RuleId: 9, DocumentType: 'UWS', Direction: 'IMPORT', IsSupported: true })] }, context, 'UWS').IsSupported, true);
});

test('invalid dates and duplicate effective versions are rejected', () => {
  assert.throws(() => validateRuleSet([row({ EffectiveTo: '2019-01-01' })], () => 'X'), /EffectiveTo/);
  assert.throws(() => validateRuleSet([row({ RuleId: 1 }), row({ RuleId: 2 })], () => 'X'), error => error.code === 'CONFIGURATION_DUPLICATE_VERSION');
});

test('Admin input validation rejects unsafe codes, dates and SLA ranges server-side', () => {
  assert.deepEqual(validateConfigurationInput('AIRLINE', { airlineCode: 'cx', effectiveFrom: '2026-09-19' }), { airlineCode: 'CX', effectiveFrom: '2026-09-19', effectiveTo: null });
  assert.throws(() => validateConfigurationInput('SHC', { shcCode: 'A/V', effectiveFrom: '2026-09-19' }), error => error.code === 'CONFIGURATION_CODE_INVALID');
  assert.throws(() => validateConfigurationInput('SLA', { ruleKey: 'MAIL_SCAN', targetMinutes: 99999, warningMinutes: 1, breachMinutes: 2, effectiveFrom: '2026-09-19' }), error => error.code === 'CONFIGURATION_MINUTES_INVALID');
});

test('configuration audit requires the mutation transaction and stable authenticated actor', async () => {
  await assert.rejects(insertConfigurationAudit(null, {}, {}), error => error.code === 'CONFIGURATION_TRANSACTION_REQUIRED');
  const values = {};
  class Request {
    input(name, _type, value) { values[name] = value; return this; }
    async query(sqlText) { values.sql = sqlText; return { recordset: [{ ConfigurationAuditId: 1 }] }; }
  }
  const sql = { Request, VarChar: size => `varchar:${size}`, NVarChar: size => `nvarchar:${size}`, Date: 'date', UniqueIdentifier: 'guid', MAX: -1 };
  const audit = await insertConfigurationAudit({}, sql, { operation: 'SHC_GROUP_MAPPING_CHANGED', entityType: 'SHC_MAPPING', entityId: '42', effectiveFrom: '2026-09-19', oldValue: { groups: ['TEMP'] }, newValue: { groups: ['TEMP', 'PHARMA'] }, actorReference: 'entra-object-id', actorDisplayName: 'Admin User' });
  assert.equal(audit.ConfigurationAuditId, 1);
  assert.equal(values.ConfigurationActorReference, 'entra-object-id');
  assert.match(values.ConfigurationOldValueJson, /TEMP/);
  assert.match(values.sql, /INSERT dbo\.CargoRunConfigurationAudit/);
});

test('capabilities honor effective grant and revoke events without changing legacy access', () => {
  const snapshot = {
    userRoleAssignments: [row({ UserRoleVersionId: 1, ActorReference: 'user-1', RoleId: 10, AssignmentAction: 'GRANT' })],
    roleCapabilities: [
      row({ RoleCapabilityVersionId: 1, RoleId: 10, CapabilityCode: 'MOVE_ULD', CapabilityAction: 'GRANT' }),
      row({ RoleCapabilityVersionId: 2, RoleId: 10, CapabilityCode: 'MOVE_ULD', CapabilityAction: 'REVOKE', EffectiveFrom: '2027-01-01' }),
      row({ RoleCapabilityVersionId: 3, RoleId: 10, CapabilityCode: 'VIEW_FLIGHTS', CapabilityAction: 'GRANT' })
    ]
  };
  assert.deepEqual(resolveCapabilities(snapshot, 'user-1', '2026-09-19'), ['MOVE_ULD', 'VIEW_FLIGHTS']);
  assert.deepEqual(resolveCapabilities(snapshot, 'user-1', '2027-02-01'), ['VIEW_FLIGHTS']);
  snapshot.userRoleAssignments.push(row({ UserRoleVersionId: 2, ActorReference: 'user-1', RoleId: 10, StationCode: 'MEL', AssignmentAction: 'REVOKE' }));
  assert.deepEqual(resolveCapabilities(snapshot, 'user-1', '2026-09-19', 'MEL'), []);
  assert.deepEqual(resolveCapabilities(snapshot, 'user-1', '2026-09-19', 'SYD'), ['MOVE_ULD', 'VIEW_FLIGHTS']);
  assert.deepEqual(authorizeCapability({ enforcementMode: 'LEGACY', capabilities: [], requiredCapability: 'MOVE_ULD' }), { allowed: true, mode: 'LEGACY', wouldDeny: true });
  assert.equal(authorizeCapability({ enforcementMode: 'ENFORCED', capabilities: [], requiredCapability: 'MOVE_ULD' }).allowed, false);
});

test('configuration store uses one bounded snapshot query and avoids per-row N+1 reads', async () => {
  invalidateConfigurationCache();
  let queries = 0;
  const pool = {
    config: { server: 'test-server', database: 'test-db' },
    request() { return { query: async sqlText => {
      queries++;
      if (/FROM sys\.tables/.test(sqlText)) return { recordset: REQUIRED_CONFIGURATION_TABLES.map(name => ({ name })) };
      return { recordsets: Array.from({ length: 12 }, () => []) };
    } }; }
  };
  const first = await loadCachedConfiguration(pool, { ttlMs: 60000 });
  const second = await loadCachedConfiguration(pool, { ttlMs: 60000 });
  assert.equal(first, second);
  assert.equal(queries, 2, 'one schema assertion and one batched configuration query');
  invalidateConfigurationCache();
});

test('migration is additive, normalized, immutable and leaves protected rules outside configuration', () => {
  for (const name of ['CargoRunAirlineProfiles','CargoRunShcGroupMappings','CargoRunSlaRules','CargoRunMailRules','CargoRunDocumentRules','CargoRunCapabilities','CargoRunRoles','CargoRunUserRoleAssignments','CargoRunAdminMessages','CargoRunConfigurationAudit']) assert.match(migration, new RegExp(`CREATE TABLE dbo\\.${name}`));
  assert.match(migration, /UQ_CargoRunShcGroupMappings_Version UNIQUE\(ShcId,ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom\)/);
  assert.match(migration, /TR_CargoRunConfigurationAudit_Immutable/);
  assert.match(migration, /TR_CargoRunRules_Immutable/);
  assert.doesNotMatch(migration, /ON DELETE CASCADE/i);
  for (const protectedName of ['UldNormalizationRule','OffloadUniquenessRule','FinalMembershipRule','PhysicalStatusRule']) assert.doesNotMatch(migration, new RegExp(protectedName, 'i'));
});

test('preflight is read-only and verification covers constraints, triggers, seed data and Admin bootstrap', () => {
  assert.doesNotMatch(preflight, /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/im);
  assert.match(preflight, /CONFIGURATION_OBJECT_ALREADY_EXISTS/);
  assert.match(preflight, /MISSING_FLIGHT_ID_UNIQUE_KEY/);
  assert.match(verify, /DISABLED_OR_UNTRUSTED_CONSTRAINT/);
  assert.match(verify, /DISABLED_TRIGGER/);
  assert.match(verify, /ROLE_ASSIGNMENT_WITHOUT_ADMIN/);
  assert.match(verify, /RoleCode='ADMIN'/);
  assert.match(verify, /ROW_NUMBER\(\) OVER/);
  assert.doesNotMatch(verify, /\bRowCount\b/i);
});

test('Admin bootstrap requires one stable SWA userId and grants the complete capability catalog', () => {
  const expectedCapabilities = [
    'VIEW_FLIGHTS','MOVE_ULD','SCAN_ULD','VIEW_PRIORITY','REQUEST_OFFLOAD','COLLECT_OFFLOAD',
    'COMPLETE_OFFLOAD','SET_IN_BLOCK','SET_ETD','UPLOAD_FLIGHT_DATA','CONFIRM_EXPORT_FINAL',
    'FINALISE_FLIGHT','VIEW_FLIGHT_STATEMENT','VIEW_HISTORY','EXPORT_HISTORY','VIEW_SUPERVISOR',
    'PUBLISH_MESSAGES','EDIT_AIRLINE_RULES','EDIT_SLA_RULES','EDIT_SHC_RULES','MANAGE_USERS',
    'VIEW_ADMIN_AUDIT'
  ];
  assert.match(bootstrap, /__REPLACE_WITH_AZURE_SWA_USER_ID__/);
  assert.match(bootstrap, /clientPrincipal\.userId/);
  assert.match(bootstrap, /appears to be an email address/);
  assert.doesNotMatch(bootstrap, /@[a-z0-9.-]+\.[a-z]{2,}/i);
  for (const capability of expectedCapabilities) {
    assert.match(migration, new RegExp(`\\('${capability}'`));
    assert.match(bootstrap, new RegExp(`\\('${capability}'\\)`));
  }
});

test('Admin bootstrap is transactional, concurrency-safe, idempotent and audited', () => {
  assert.match(bootstrap, /SET XACT_ABORT ON/);
  assert.match(bootstrap, /BEGIN TRANSACTION[\s\S]*sp_getapplock[\s\S]*@LockOwner='Transaction'/);
  assert.match(bootstrap, /IF @LockResult<0[\s\S]*THROW 51404/);
  assert.match(bootstrap, /WITH \(UPDLOCK,HOLDLOCK\)/);
  assert.match(bootstrap, /WHERE RoleCode='ADMIN'/);
  assert.match(bootstrap, /currentDecision\.CapabilityAction IS NULL OR currentDecision\.CapabilityAction='REVOKE'/);
  assert.match(bootstrap, /IF NOT EXISTS \([\s\S]*INSERT dbo\.CargoRunUserRoleAssignments/);
  assert.match(bootstrap, /COUNT_BIG\(DISTINCT currentAssignments\.ActorReference\)[\s\S]*<>1/);
  assert.match(bootstrap, /INSERT dbo\.CargoRunConfigurationAudit/);
  assert.match(bootstrap, /@BootstrapActorReference[\s\S]*ORIGINAL_LOGIN\(\)/);
  assert.match(bootstrap, /'ADMIN_BOOTSTRAPPED'[\s\S]*@BootstrapActorReference,@BootstrapActorDisplayName/);
  assert.match(bootstrap, /COMMIT TRANSACTION/);
  assert.match(bootstrap, /ROLLBACK TRANSACTION/);
});

test('Admin bootstrap verification is read-only, resolves effective decisions and leaves enforcement disabled', () => {
  assert.doesNotMatch(bootstrapVerify, /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/im);
  assert.match(bootstrapVerify, /LEGACY_OPERATIONAL_AUTHORIZATION/);
  assert.match(bootstrapVerify, /CapabilityEnforcementEnabled/);
  assert.match(bootstrapVerify, /CONVERT\(bit,0\)/);
  assert.match(bootstrapVerify, /EFFECTIVE_ADMIN_COUNT/);
  assert.match(bootstrapVerify, /HasManageUsers/);
  assert.match(bootstrapVerify, /HasViewAdminAudit/);
  assert.match(bootstrapVerify, /ADMIN_CAPABILITY_MISSING/);
  assert.match(bootstrapVerify, /ROW_NUMBER\(\) OVER/);
});

test('Admin Centre is a read-only shell and exposes no browser-only security claim', () => {
  assert.match(html, /openScreen\('admin','airlines'\)/);
  for (const label of ['Airlines','SHC Groups','SLA & Escalations','Mail Rules','Document / Intake','Messaging Centre','Employees & Permissions','Stations','Configuration Audit']) assert.match(html, new RegExp(label.replace(/[&]/g, '&')));
  assert.match(html, /fetch\('\/api\/admin-config',[\s\S]*method !== 'GET'|fetch\('\/api\/admin-config'/);
  assert.match(html, /No Admin mutation API is exposed/);
  const start = html.indexOf('async function loadAdminConfiguration(');
  const end = html.indexOf('const HOME_ICON_PATH', start);
  assert.doesNotMatch(html.slice(start, end), /method:\s*'(POST|PATCH|PUT|DELETE)'/);
});

test('Admin API is authenticated and GET-only with no configuration mutation surface', () => {
  const trigger = adminFunction.bindings.find(binding => binding.type === 'httpTrigger');
  assert.deepEqual(trigger.methods, ['get']);
  assert.equal(trigger.authLevel, 'anonymous', 'Static Web Apps authenticates the route before the handler validates x-ms-client-principal');
  assert.match(adminApi, /roles\.includes\('authenticated'\)/);
  assert.match(adminApi, /req\.method !== 'GET'/);
  assert.doesNotMatch(adminApi, /\b(INSERT|UPDATE|DELETE|MERGE)\s+(INTO\s+)?dbo\.CargoRun/i);
  assert.doesNotMatch(adminApi, /userRoleAssignments|roleCapabilities|ConfigurationAudit/);
});

test('Admin frontend and function expose the same deployable public route under Node 22', () => {
  const trigger = adminFunction.bindings.find(binding => binding.type === 'httpTrigger');
  assert.match(html, /fetch\('\/api\/admin-config'/);
  assert.equal(trigger.route, 'admin-config');
  assert.equal(path.basename(adminFunctionDirectory), 'configuration-admin');
  assert.doesNotMatch(path.basename(adminFunctionDirectory), /^admin/i, 'Azure reserves function names beginning with admin');
  assert.equal(fs.existsSync(path.join(root, 'api', 'admin-config')), false);
  assert.equal(typeof require('../api/configuration-admin'), 'function');
});

test('foundation inventory keeps FINAL, FOW, stable identity and evidence protections in code', () => {
  for (const phrase of ['Protected integrity','Never an Admin setting','Historical snapshots are not rewritten','no POST, PATCH, PUT, or DELETE Admin route']) assert.match(foundation, new RegExp(phrase));
});
