'use strict';

const { randomUUID } = require('node:crypto');
const { ConfigurationError, resolvePriorityRules, resolveSlaRule, resolveMailRules, FALLBACK_SLAS } = require('./configuration');
const { validateMutationInput, requiredCapabilityForOperation, insertConfigurationAudit } = require('./configuration-admin');

class ConfigurationMutationError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'ConfigurationMutationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function rows(result) { return result?.recordset || []; }
function one(result) { return rows(result)[0] || null; }
function normaliseOperation(value) { return String(value || '').trim().toLowerCase(); }
function dateKey(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function resolveActorCapabilities(executor, sql, actorReference, stationCode = null) {
  const result = await new sql.Request(executor)
    .input('AuthorizationActorReference', sql.NVarChar(150), actorReference)
    .input('AuthorizationStationCode', sql.VarChar(3), stationCode || null)
    .query(`
      WITH AssignmentDecisions AS (
        SELECT assignment.RoleId,assignment.StationId,assignment.AssignmentAction,
          ROW_NUMBER() OVER (
            PARTITION BY assignment.RoleId
            ORDER BY CASE WHEN assignment.StationId IS NULL THEN 0 ELSE 1 END DESC,
              assignment.EffectiveFrom DESC,assignment.UserRoleVersionId DESC
          ) AS DecisionRank
        FROM dbo.CargoRunUserRoleAssignments assignment
        LEFT JOIN dbo.CargoRunStations station ON station.StationId=assignment.StationId
        WHERE assignment.ActorReference=@AuthorizationActorReference
          AND assignment.EffectiveFrom<=CONVERT(date,SYSUTCDATETIME())
          AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>CONVERT(date,SYSUTCDATETIME()))
          AND (assignment.StationId IS NULL OR station.StationCode=@AuthorizationStationCode)
      ), EffectiveRoles AS (
        SELECT DISTINCT RoleId FROM AssignmentDecisions
        WHERE DecisionRank=1 AND AssignmentAction='GRANT'
      ), CapabilityDecisions AS (
        SELECT rc.RoleId,rc.CapabilityId,rc.CapabilityAction,
          ROW_NUMBER() OVER (
            PARTITION BY rc.RoleId,rc.CapabilityId
            ORDER BY rc.EffectiveFrom DESC,rc.RoleCapabilityVersionId DESC
          ) AS DecisionRank
        FROM dbo.CargoRunRoleCapabilities rc
        JOIN EffectiveRoles role ON role.RoleId=rc.RoleId
        WHERE rc.EffectiveFrom<=CONVERT(date,SYSUTCDATETIME())
          AND (rc.EffectiveTo IS NULL OR rc.EffectiveTo>CONVERT(date,SYSUTCDATETIME()))
      )
      SELECT DISTINCT capability.CapabilityCode
      FROM CapabilityDecisions decision
      JOIN dbo.CargoRunCapabilities capability ON capability.CapabilityId=decision.CapabilityId
      JOIN dbo.CargoRunRoles role ON role.RoleId=decision.RoleId
      WHERE decision.DecisionRank=1 AND decision.CapabilityAction='GRANT'
        AND capability.IsEnabled=1 AND role.IsEnabled=1
      ORDER BY capability.CapabilityCode;
    `);
  return rows(result).map(row => String(row.CapabilityCode || '').toUpperCase()).filter(Boolean);
}

async function requireMutationCapability(transaction, sql, actorReference, stationCode, capability) {
  const capabilities = await resolveActorCapabilities(transaction, sql, actorReference, stationCode);
  if (!capabilities.includes(capability)) {
    throw new ConfigurationMutationError('ADMIN_CAPABILITY_REQUIRED', `The ${capability} capability is required`, 403, { requiredCapability: capability });
  }
  return capabilities;
}

async function acquireConfigurationLock(transaction, sql, operation) {
  const resource = `CargoRun:Configuration:${normaliseOperation(operation)}`;
  const result = await new sql.Request(transaction)
    .input('ConfigurationLockResource', sql.NVarChar(255), resource)
    .query(`
      DECLARE @LockResult int;
      EXEC @LockResult=sys.sp_getapplock
        @Resource=@ConfigurationLockResource,
        @LockMode='Exclusive',
        @LockOwner='Transaction',
        @LockTimeout=10000;
      SELECT @LockResult AS LockResult;
    `);
  const lockResult = Number(one(result)?.LockResult);
  if (!Number.isInteger(lockResult) || lockResult < 0) {
    throw new ConfigurationMutationError('CONFIGURATION_LOCK_FAILED', 'Configuration is being changed by another administrator; retry after refreshing', 409, { lockResult });
  }
  return resource;
}

async function resolveScopeIds(transaction, sql, value) {
  let airlineId = null;
  let stationId = null;
  if (value.airlineCode) {
    const result = await new sql.Request(transaction).input('ScopeAirlineCode', sql.VarChar(3), value.airlineCode)
      .query(`SELECT AirlineId FROM dbo.CargoRunAirlines WITH (UPDLOCK,HOLDLOCK) WHERE AirlineCode=@ScopeAirlineCode;`);
    if (rows(result).length !== 1) throw new ConfigurationMutationError('CONFIGURATION_AIRLINE_NOT_FOUND', `Airline ${value.airlineCode} does not exist`, 400);
    airlineId = one(result).AirlineId;
  }
  if (value.stationCode) {
    const result = await new sql.Request(transaction).input('ScopeStationCode', sql.VarChar(3), value.stationCode)
      .query(`SELECT StationId FROM dbo.CargoRunStations WITH (UPDLOCK,HOLDLOCK) WHERE StationCode=@ScopeStationCode AND IsEnabled=1;`);
    if (rows(result).length !== 1) throw new ConfigurationMutationError('CONFIGURATION_STATION_NOT_FOUND', `Station ${value.stationCode} does not exist or is disabled`, 400);
    stationId = one(result).StationId;
  }
  return { airlineId, stationId };
}

function addPeriod(request, sql, value) {
  return request.input('EffectiveFrom', sql.Date, value.effectiveFrom).input('EffectiveTo', sql.Date, value.effectiveTo);
}
function addScope(request, sql, scope) {
  return request.input('AirlineId', sql.BigInt, scope.airlineId).input('StationId', sql.BigInt, scope.stationId);
}
function duplicateVersion() {
  throw new ConfigurationMutationError('CONFIGURATION_VERSION_CONFLICT', 'A version already exists for this identity, scope, and effective date', 409);
}

async function writeAirline(transaction, sql, value, actor) {
  let airlineResult = await new sql.Request(transaction).input('AirlineCode', sql.VarChar(3), value.airlineCode)
    .query(`SELECT AirlineId FROM dbo.CargoRunAirlines WITH (UPDLOCK,HOLDLOCK) WHERE AirlineCode=@AirlineCode;`);
  let airlineId = one(airlineResult)?.AirlineId;
  let createdIdentity = false;
  if (!airlineId) {
    airlineResult = await new sql.Request(transaction)
      .input('AirlineCode', sql.VarChar(3), value.airlineCode)
      .input('ActorReference', sql.NVarChar(150), actor.reference)
      .query(`INSERT dbo.CargoRunAirlines(AirlineCode,CreatedByReference) OUTPUT INSERTED.AirlineId VALUES(@AirlineCode,@ActorReference);`);
    airlineId = one(airlineResult).AirlineId;
    createdIdentity = true;
  }
  const scope = await resolveScopeIds(transaction, sql, { stationCode: value.stationCode });
  const existing = await addPeriod(new sql.Request(transaction), sql, value)
    .input('AirlineId', sql.BigInt, airlineId).input('StationId', sql.BigInt, scope.stationId)
    .query(`
      SELECT TOP (1) ProfileVersionId,DisplayName,BadgeColour,BrightBadge,IsEnabled,OperationalNotes,EffectiveFrom,EffectiveTo
      FROM dbo.CargoRunAirlineProfiles WITH (UPDLOCK,HOLDLOCK)
      WHERE AirlineId=@AirlineId AND StationScopeKey=ISNULL(@StationId,0) AND EffectiveFrom<=@EffectiveFrom
      ORDER BY EffectiveFrom DESC,ProfileVersionId DESC;
    `);
  const oldValue = one(existing);
  if (oldValue && dateKey(oldValue.EffectiveFrom) === value.effectiveFrom) duplicateVersion();
  const inserted = await addPeriod(new sql.Request(transaction), sql, value)
    .input('AirlineId', sql.BigInt, airlineId).input('StationId', sql.BigInt, scope.stationId)
    .input('DisplayName', sql.NVarChar(100), value.displayName).input('BadgeColour', sql.VarChar(7), value.badgeColour)
    .input('BrightBadge', sql.Bit, value.brightBadge).input('IsEnabled', sql.Bit, value.isEnabled)
    .input('OperationalNotes', sql.NVarChar(1000), value.operationalNotes).input('ActorReference', sql.NVarChar(150), actor.reference)
    .query(`
      INSERT dbo.CargoRunAirlineProfiles
        (AirlineId,StationId,DisplayName,BadgeColour,BrightBadge,IsEnabled,OperationalNotes,EffectiveFrom,EffectiveTo,CreatedByReference)
      OUTPUT INSERTED.ProfileVersionId
      VALUES(@AirlineId,@StationId,@DisplayName,@BadgeColour,@BrightBadge,@IsEnabled,@OperationalNotes,@EffectiveFrom,@EffectiveTo,@ActorReference);
    `);
  return { operation: createdIdentity ? 'AIRLINE_PROFILE_CREATED' : 'AIRLINE_PROFILE_CHANGED', entityType: 'AIRLINE_PROFILE', entityId: String(one(inserted).ProfileVersionId), oldValue, newValue: value };
}

async function writeShcGroup(transaction, sql, value, actor) {
  let groupResult = await new sql.Request(transaction).input('GroupKey', sql.VarChar(40), value.groupKey)
    .query(`SELECT ShcGroupId FROM dbo.CargoRunShcGroups WITH (UPDLOCK,HOLDLOCK) WHERE GroupKey=@GroupKey;`);
  let groupId = one(groupResult)?.ShcGroupId;
  let createdIdentity = false;
  if (!groupId) {
    groupResult = await new sql.Request(transaction).input('GroupKey', sql.VarChar(40), value.groupKey)
      .input('ActorReference', sql.NVarChar(150), actor.reference)
      .query(`INSERT dbo.CargoRunShcGroups(GroupKey,CreatedByReference) OUTPUT INSERTED.ShcGroupId VALUES(@GroupKey,@ActorReference);`);
    groupId = one(groupResult).ShcGroupId;
    createdIdentity = true;
  }
  const existing = await addPeriod(new sql.Request(transaction), sql, value).input('ShcGroupId', sql.BigInt, groupId).query(`
    SELECT TOP (1) GroupVersionId,DisplayToken,DisplayName,Description,DisplayOrder,VisualClass,IsEnabled,EffectiveFrom,EffectiveTo
    FROM dbo.CargoRunShcGroupVersions WITH (UPDLOCK,HOLDLOCK)
    WHERE ShcGroupId=@ShcGroupId AND EffectiveFrom<=@EffectiveFrom ORDER BY EffectiveFrom DESC,GroupVersionId DESC;
  `);
  const oldValue = one(existing);
  if (oldValue && dateKey(oldValue.EffectiveFrom) === value.effectiveFrom) duplicateVersion();
  const inserted = await addPeriod(new sql.Request(transaction), sql, value).input('ShcGroupId', sql.BigInt, groupId)
    .input('DisplayToken', sql.NVarChar(20), value.displayToken).input('DisplayName', sql.NVarChar(100), value.displayName)
    .input('Description', sql.NVarChar(500), value.description).input('DisplayOrder', sql.Int, value.displayOrder)
    .input('VisualClass', sql.VarChar(30), value.visualClass).input('IsEnabled', sql.Bit, value.isEnabled)
    .input('ActorReference', sql.NVarChar(150), actor.reference).query(`
      INSERT dbo.CargoRunShcGroupVersions
        (ShcGroupId,DisplayToken,DisplayName,Description,DisplayOrder,VisualClass,IsEnabled,EffectiveFrom,EffectiveTo,CreatedByReference)
      OUTPUT INSERTED.GroupVersionId
      VALUES(@ShcGroupId,@DisplayToken,@DisplayName,@Description,@DisplayOrder,@VisualClass,@IsEnabled,@EffectiveFrom,@EffectiveTo,@ActorReference);
    `);
  return { operation: createdIdentity ? 'SHC_GROUP_CREATED' : 'SHC_GROUP_CHANGED', entityType: 'SHC_GROUP', entityId: String(one(inserted).GroupVersionId), oldValue, newValue: value };
}

async function groupIdFor(transaction, sql, groupKey) {
  const result = await new sql.Request(transaction).input('GroupKey', sql.VarChar(40), groupKey)
    .query(`SELECT ShcGroupId FROM dbo.CargoRunShcGroups WITH (UPDLOCK,HOLDLOCK) WHERE GroupKey=@GroupKey;`);
  if (rows(result).length !== 1) throw new ConfigurationMutationError('CONFIGURATION_GROUP_NOT_FOUND', `SHC group ${groupKey} does not exist`, 400);
  return one(result).ShcGroupId;
}

async function assertSlaReference(transaction, sql, ruleKey, scope, effectiveFrom) {
  if (!ruleKey || FALLBACK_SLAS[ruleKey]) return;
  const result = await addPeriod(addScope(new sql.Request(transaction), sql, scope), sql, { effectiveFrom, effectiveTo: null })
    .input('SlaRuleKeyReference', sql.VarChar(50), ruleKey).query(`
      SELECT TOP (1) SlaRuleId
      FROM dbo.CargoRunSlaRules WITH (UPDLOCK,HOLDLOCK)
      WHERE RuleKey=@SlaRuleKeyReference AND IsEnabled=1
        AND EffectiveFrom<=@EffectiveFrom AND (EffectiveTo IS NULL OR EffectiveTo>@EffectiveFrom)
        AND (AirlineId IS NULL OR AirlineId=@AirlineId)
        AND (StationId IS NULL OR StationId=@StationId)
      ORDER BY CASE WHEN AirlineId IS NULL THEN 0 ELSE 2 END
        + CASE WHEN StationId IS NULL THEN 0 ELSE 1 END DESC,
        EffectiveFrom DESC,SlaRuleId DESC;
    `);
  if (!rows(result).length) throw new ConfigurationMutationError('CONFIGURATION_SLA_NOT_FOUND', `SLA rule ${ruleKey} is not effective for this scope and date`, 400);
}

async function writeMappings(transaction, sql, value, actor) {
  const scope = await resolveScopeIds(transaction, sql, value);
  const groupId = await groupIdFor(transaction, sql, value.groupKey);
  const events = [];
  for (const shcCode of value.shcCodes) {
    const shcResult = await new sql.Request(transaction).input('ShcCode', sql.VarChar(10), shcCode)
      .input('CarrierAirlineId', sql.BigInt, scope.airlineId).query(`
        SELECT ShcId,CarrierAirlineId FROM dbo.CargoRunShcs WITH (UPDLOCK,HOLDLOCK)
        WHERE ShcCode=@ShcCode AND (CarrierAirlineId=@CarrierAirlineId OR CarrierAirlineId IS NULL)
        ORDER BY CASE WHEN CarrierAirlineId=@CarrierAirlineId THEN 0 ELSE 1 END;
      `);
    let selected = rows(shcResult)[0];
    if (!selected) {
      const created = await new sql.Request(transaction).input('ShcCode', sql.VarChar(10), shcCode)
        .input('ActorReference', sql.NVarChar(150), actor.reference).query(`
          INSERT dbo.CargoRunShcs(ShcCode,CarrierAirlineId,CreatedByReference)
          OUTPUT INSERTED.ShcId,INSERTED.CarrierAirlineId
          VALUES(@ShcCode,NULL,@ActorReference);
        `);
      selected = one(created);
      const version = await addPeriod(new sql.Request(transaction), sql, value).input('ShcId', sql.BigInt, selected.ShcId)
        .input('ActorReference', sql.NVarChar(150), actor.reference).query(`
          INSERT dbo.CargoRunShcVersions(ShcId,Description,StandardIndicator,IsEnabled,EffectiveFrom,EffectiveTo,CreatedByReference)
          OUTPUT INSERTED.ShcVersionId
          VALUES(@ShcId,N'Observed operational SHC',N'UNKNOWN',1,@EffectiveFrom,@EffectiveTo,@ActorReference);
        `);
      events.push({ operation: 'SHC_MASTER_CREATED', entityType: 'SHC', entityId: String(one(version).ShcVersionId), oldValue: null, newValue: { shcCode, standardIndicator: 'UNKNOWN', effectiveFrom: value.effectiveFrom, effectiveTo: value.effectiveTo } });
    }
    if (rows(shcResult).length > 1 && String(rows(shcResult)[0].CarrierAirlineId || '') === String(rows(shcResult)[1].CarrierAirlineId || '')) {
      throw new ConfigurationMutationError('CONFIGURATION_SHC_AMBIGUOUS', `SHC ${shcCode} has ambiguous master identities`, 409);
    }
    const oldResult = await addPeriod(addScope(new sql.Request(transaction), sql, scope), sql, value)
      .input('ShcId', sql.BigInt, selected.ShcId).input('ShcGroupId', sql.BigInt, groupId).query(`
        SELECT TOP (1) MappingId,MappingAction,EffectiveFrom,EffectiveTo
        FROM dbo.CargoRunShcGroupMappings WITH (UPDLOCK,HOLDLOCK)
        WHERE ShcId=@ShcId AND ShcGroupId=@ShcGroupId
          AND AirlineScopeKey=ISNULL(@AirlineId,0) AND StationScopeKey=ISNULL(@StationId,0)
          AND EffectiveFrom<=@EffectiveFrom
        ORDER BY EffectiveFrom DESC,MappingId DESC;
      `);
    const oldValue = one(oldResult);
    if (oldValue && dateKey(oldValue.EffectiveFrom) === value.effectiveFrom) duplicateVersion();
    const inserted = await addPeriod(addScope(new sql.Request(transaction), sql, scope), sql, value)
      .input('ShcId', sql.BigInt, selected.ShcId).input('ShcGroupId', sql.BigInt, groupId)
      .input('MappingAction', sql.VarChar(10), value.mappingAction).input('ActorReference', sql.NVarChar(150), actor.reference)
      .query(`
        INSERT dbo.CargoRunShcGroupMappings
          (ShcId,ShcGroupId,AirlineId,StationId,MappingAction,EffectiveFrom,EffectiveTo,CreatedByReference)
        OUTPUT INSERTED.MappingId
        VALUES(@ShcId,@ShcGroupId,@AirlineId,@StationId,@MappingAction,@EffectiveFrom,@EffectiveTo,@ActorReference);
      `);
    events.push({ operation: value.mappingAction === 'INCLUDE' ? 'SHC_MAPPING_GRANTED' : 'SHC_MAPPING_REVOKED', entityType: 'SHC_MAPPING', entityId: String(one(inserted).MappingId), oldValue, newValue: { ...value, shcCodes: [shcCode] } });
  }
  return events;
}

async function writePriority(transaction, sql, value, actor) {
  const scope = await resolveScopeIds(transaction, sql, value);
  const groupId = await groupIdFor(transaction, sql, value.groupKey);
  await assertSlaReference(transaction, sql, value.slaRuleKeyOverride, scope, value.effectiveFrom);
  const existing = await addPeriod(addScope(new sql.Request(transaction), sql, scope), sql, value).input('ShcGroupId', sql.BigInt, groupId).query(`
    SELECT TOP (1) PriorityRuleId,PriorityLevel,CountsAsPriority,SupervisorAttention,EscalationEnabled,SlaRuleKeyOverride,EffectiveFrom,EffectiveTo
    FROM dbo.CargoRunPriorityRules WITH (UPDLOCK,HOLDLOCK)
    WHERE ShcGroupId=@ShcGroupId AND AirlineScopeKey=ISNULL(@AirlineId,0) AND StationScopeKey=ISNULL(@StationId,0)
      AND EffectiveFrom<=@EffectiveFrom ORDER BY EffectiveFrom DESC,PriorityRuleId DESC;
  `);
  const oldValue = one(existing);
  if (oldValue && dateKey(oldValue.EffectiveFrom) === value.effectiveFrom) duplicateVersion();
  const inserted = await addPeriod(addScope(new sql.Request(transaction), sql, scope), sql, value).input('ShcGroupId', sql.BigInt, groupId)
    .input('PriorityLevel', sql.VarChar(12), value.priorityLevel).input('CountsAsPriority', sql.Bit, value.countsAsPriority)
    .input('SupervisorAttention', sql.Bit, value.supervisorAttention).input('EscalationEnabled', sql.Bit, value.escalationEnabled)
    .input('SlaRuleKeyOverride', sql.VarChar(50), value.slaRuleKeyOverride).input('ActorReference', sql.NVarChar(150), actor.reference)
    .query(`
      INSERT dbo.CargoRunPriorityRules
        (ShcGroupId,AirlineId,StationId,PriorityLevel,CountsAsPriority,SupervisorAttention,EscalationEnabled,SlaRuleKeyOverride,EffectiveFrom,EffectiveTo,CreatedByReference)
      OUTPUT INSERTED.PriorityRuleId
      VALUES(@ShcGroupId,@AirlineId,@StationId,@PriorityLevel,@CountsAsPriority,@SupervisorAttention,@EscalationEnabled,@SlaRuleKeyOverride,@EffectiveFrom,@EffectiveTo,@ActorReference);
    `);
  return { operation: 'PRIORITY_RULE_CHANGED', entityType: 'PRIORITY_RULE', entityId: String(one(inserted).PriorityRuleId), oldValue, newValue: value };
}

async function writeSla(transaction, sql, value, actor) {
  const scope = await resolveScopeIds(transaction, sql, value);
  const existing = await addPeriod(addScope(new sql.Request(transaction), sql, scope), sql, value).input('RuleKey', sql.VarChar(50), value.ruleKey).query(`
    SELECT TOP (1) SlaRuleId,Direction,StartEvent,TargetEvent,TargetMinutes,WarningMinutes,BreachMinutes,IsEnabled,ApplicabilityNotes,EffectiveFrom,EffectiveTo
    FROM dbo.CargoRunSlaRules WITH (UPDLOCK,HOLDLOCK)
    WHERE RuleKey=@RuleKey AND AirlineScopeKey=ISNULL(@AirlineId,0) AND StationScopeKey=ISNULL(@StationId,0)
      AND EffectiveFrom<=@EffectiveFrom ORDER BY EffectiveFrom DESC,SlaRuleId DESC;
  `);
  const oldValue = one(existing);
  if (oldValue && dateKey(oldValue.EffectiveFrom) === value.effectiveFrom) duplicateVersion();
  const inserted = await addPeriod(addScope(new sql.Request(transaction), sql, scope), sql, value).input('RuleKey', sql.VarChar(50), value.ruleKey)
    .input('Direction', sql.VarChar(10), value.direction).input('StartEvent', sql.VarChar(50), value.startEvent)
    .input('TargetEvent', sql.VarChar(50), value.targetEvent).input('TargetMinutes', sql.Int, value.targetMinutes)
    .input('WarningMinutes', sql.Int, value.warningMinutes).input('BreachMinutes', sql.Int, value.breachMinutes)
    .input('IsEnabled', sql.Bit, value.isEnabled).input('ApplicabilityNotes', sql.NVarChar(500), value.applicabilityNotes)
    .input('ActorReference', sql.NVarChar(150), actor.reference).query(`
      INSERT dbo.CargoRunSlaRules
        (RuleKey,AirlineId,StationId,Direction,StartEvent,TargetEvent,TargetMinutes,WarningMinutes,BreachMinutes,IsEnabled,ApplicabilityNotes,EffectiveFrom,EffectiveTo,CreatedByReference)
      OUTPUT INSERTED.SlaRuleId
      VALUES(@RuleKey,@AirlineId,@StationId,@Direction,@StartEvent,@TargetEvent,@TargetMinutes,@WarningMinutes,@BreachMinutes,@IsEnabled,@ApplicabilityNotes,@EffectiveFrom,@EffectiveTo,@ActorReference);
    `);
  return { operation: 'SLA_RULE_CHANGED', entityType: 'SLA_RULE', entityId: String(one(inserted).SlaRuleId), oldValue, newValue: value };
}

async function writeMail(transaction, sql, value, actor) {
  const scope = await resolveScopeIds(transaction, sql, value);
  if (value.slaEnabled) await assertSlaReference(transaction, sql, value.slaRuleKey, scope, value.effectiveFrom);
  const existing = await addPeriod(addScope(new sql.Request(transaction), sql, scope), sql, value).query(`
    SELECT TOP (1) MailRuleId,MailHandlingRequired,MailScanRequired,SlaEnabled,SlaRuleKey,ReminderEnabled,EscalationEnabled,OperationalInstructions,EffectiveFrom,EffectiveTo
    FROM dbo.CargoRunMailRules WITH (UPDLOCK,HOLDLOCK)
    WHERE AirlineScopeKey=ISNULL(@AirlineId,0) AND StationScopeKey=ISNULL(@StationId,0)
      AND EffectiveFrom<=@EffectiveFrom ORDER BY EffectiveFrom DESC,MailRuleId DESC;
  `);
  const oldValue = one(existing);
  if (oldValue && dateKey(oldValue.EffectiveFrom) === value.effectiveFrom) duplicateVersion();
  const inserted = await addPeriod(addScope(new sql.Request(transaction), sql, scope), sql, value)
    .input('MailHandlingRequired', sql.Bit, value.mailHandlingRequired).input('MailScanRequired', sql.Bit, value.mailScanRequired)
    .input('SlaEnabled', sql.Bit, value.slaEnabled).input('SlaRuleKey', sql.VarChar(50), value.slaRuleKey)
    .input('ReminderEnabled', sql.Bit, value.reminderEnabled).input('EscalationEnabled', sql.Bit, value.escalationEnabled)
    .input('OperationalInstructions', sql.NVarChar(1000), value.operationalInstructions).input('ActorReference', sql.NVarChar(150), actor.reference)
    .query(`
      INSERT dbo.CargoRunMailRules
        (AirlineId,StationId,MailHandlingRequired,MailScanRequired,SlaEnabled,SlaRuleKey,ReminderEnabled,EscalationEnabled,OperationalInstructions,EffectiveFrom,EffectiveTo,CreatedByReference)
      OUTPUT INSERTED.MailRuleId
      VALUES(@AirlineId,@StationId,@MailHandlingRequired,@MailScanRequired,@SlaEnabled,@SlaRuleKey,@ReminderEnabled,@EscalationEnabled,@OperationalInstructions,@EffectiveFrom,@EffectiveTo,@ActorReference);
    `);
  return { operation: 'MAIL_RULE_CHANGED', entityType: 'MAIL_RULE', entityId: String(one(inserted).MailRuleId), oldValue, newValue: value };
}

const WRITERS = Object.freeze({
  'airlines': writeAirline,
  'shc-groups': writeShcGroup,
  'shc-mappings': writeMappings,
  'priority-rules': writePriority,
  'sla-rules': writeSla,
  'mail-rules': writeMail
});

async function executeConfigurationMutation(pool, sql, operation, input, actor) {
  const key = normaliseOperation(operation);
  const capability = requiredCapabilityForOperation(key);
  const writer = WRITERS[key];
  if (!capability || !writer) throw new ConfigurationMutationError('CONFIGURATION_OPERATION_UNSUPPORTED', 'Unsupported configuration operation', 404);
  const value = validateMutationInput(key, input);
  let transaction;
  try {
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    await requireMutationCapability(transaction, sql, actor.reference, value.stationCode, capability);
    await acquireConfigurationLock(transaction, sql, key);
    const written = await writer(transaction, sql, value, actor);
    const events = Array.isArray(written) ? written : [written];
    const correlationId = randomUUID();
    for (const event of events) {
      await insertConfigurationAudit(transaction, sql, { ...event, effectiveFrom: value.effectiveFrom, actorReference: actor.reference, actorDisplayName: actor.displayName, correlationId });
    }
    await transaction.commit();
    transaction = null;
    return { operation: key, capability, count: events.length, correlationId, records: events.map(event => ({ entityType: event.entityType, entityId: event.entityId })) };
  } catch (error) {
    if (transaction) { try { await transaction.rollback(); } catch {} }
    if (error instanceof ConfigurationMutationError || error instanceof ConfigurationError) throw error;
    if ([2601, 2627].includes(Number(error?.number))) throw new ConfigurationMutationError('CONFIGURATION_VERSION_CONFLICT', 'A concurrent configuration version already exists; refresh before retrying', 409);
    throw error;
  }
}

function lowerResult(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.charAt(0).toLowerCase() + key.slice(1), value]));
}
function compareRule(configured, fallback, fields) {
  if (!configured || configured.source !== 'configured') return { status: 'FALLBACK', differences: [] };
  const differences = fields.filter(field => String(configured[field] ?? configured[field.charAt(0).toUpperCase() + field.slice(1)] ?? '') !== String(fallback?.[field] ?? ''));
  return { status: differences.length ? 'DIFFERENCE' : 'MATCH', differences };
}
function buildConfigurationPreview(snapshot, input) {
  const kind = String(input?.kind || '').toUpperCase();
  const context = {
    airlineCode: String(input?.airlineCode || '').trim().toUpperCase(),
    stationCode: String(input?.stationCode || '').trim().toUpperCase(),
    operatingDate: String(input?.operatingDate || '').slice(0, 10),
    direction: String(input?.direction || '').trim().toUpperCase()
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(context.operatingDate)) throw new ConfigurationMutationError('CONFIGURATION_DATE_REQUIRED', 'Operating date is required', 400);
  if (kind === 'SHC') {
    context.rawShcs = Array.isArray(input.rawShcs) ? input.rawShcs : String(input.rawShcs || '').split(/[\s,]+/);
    return { kind, context, result: resolvePriorityRules(snapshot, context) };
  }
  if (kind === 'SLA') {
    const ruleKey = String(input.ruleKey || '').trim().toUpperCase();
    const resolved = resolveSlaRule(snapshot, context, ruleKey);
    const fallback = FALLBACK_SLAS[ruleKey] || null;
    const base = input.startAtUtc ? Date.parse(input.startAtUtc) : NaN;
    const minutes = Number(resolved?.TargetMinutes ?? resolved?.targetMinutes);
    return { kind, context, ruleKey, resolved: lowerResult(resolved), targetAtUtc: Number.isFinite(base) && Number.isFinite(minutes) ? new Date(base + minutes * 60000).toISOString() : null, comparison: compareRule(resolved, fallback, ['direction', 'startEvent', 'targetEvent', 'targetMinutes', 'warningMinutes', 'breachMinutes']) };
  }
  if (kind === 'MAIL') {
    const resolved = resolveMailRules(snapshot, context);
    const fallback = resolveMailRules({}, context);
    const slaRuleKey = String(resolved?.SlaRuleKey ?? resolved?.slaRuleKey ?? '').toUpperCase();
    const sla = slaRuleKey ? resolveSlaRule(snapshot, context, slaRuleKey) : null;
    return { kind, context, resolved: lowerResult(resolved), sla: lowerResult(sla), comparison: compareRule(resolved, fallback, ['mailHandlingRequired', 'mailScanRequired', 'slaEnabled', 'slaRuleKey', 'reminderEnabled', 'escalationEnabled']) };
  }
  throw new ConfigurationMutationError('CONFIGURATION_PREVIEW_UNSUPPORTED', 'Preview kind must be SHC, SLA, or MAIL', 400);
}

module.exports = {
  ConfigurationMutationError,
  normaliseOperation,
  resolveActorCapabilities,
  requireMutationCapability,
  acquireConfigurationLock,
  executeConfigurationMutation,
  buildConfigurationPreview
};
