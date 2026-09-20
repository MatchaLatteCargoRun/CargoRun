'use strict';

const { ConfigurationError } = require('./configuration');

const PRIORITY_LEVELS = new Set(['NORMAL', 'PRIORITY', 'HIGH', 'CRITICAL']);
const DIRECTIONS = new Set(['IMPORT', 'EXPORT']);
const SLA_EVENTS = new Set([
  'SCHEDULED_ARRIVAL', 'ESTIMATED_ARRIVAL', 'LANDED', 'IN_BLOCK',
  'ULD_ACCEPTED', 'ULD_RECEIVED', 'WAREHOUSE', 'MAIL_SCANNED',
  'SCHEDULED_DEPARTURE', 'ESTIMATED_DEPARTURE', 'ULD_AT_AIRCRAFT',
  'OFFLOAD_REQUESTED', 'OFFLOAD_COLLECTED', 'OFFLOAD_COMPLETED'
]);

function requiredText(value, field, max) {
  const clean = String(value ?? '').trim();
  if (!clean) throw new ConfigurationError('CONFIGURATION_VALUE_REQUIRED', `${field} is required`);
  if (clean.length > max) throw new ConfigurationError('CONFIGURATION_VALUE_TOO_LONG', `${field} exceeds ${max} characters`);
  return clean;
}
function validateCode(value, field, pattern, max) {
  const clean = requiredText(value, field, max).toUpperCase();
  if (!pattern.test(clean)) throw new ConfigurationError('CONFIGURATION_CODE_INVALID', `${field} is invalid`);
  return clean;
}
function validateEffectivePeriod(effectiveFrom, effectiveTo) {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  const from = String(effectiveFrom || '');
  const to = effectiveTo == null || effectiveTo === '' ? null : String(effectiveTo);
  if (!pattern.test(from) || (to && !pattern.test(to)) || (to && to <= from)) throw new ConfigurationError('CONFIGURATION_EFFECTIVE_RANGE_INVALID', 'Effective dates are invalid');
  return { effectiveFrom: from, effectiveTo: to };
}
function validateMinutes(value, field) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < -1440 || minutes > 10080) throw new ConfigurationError('CONFIGURATION_MINUTES_INVALID', `${field} must be a whole number from -1440 to 10080`);
  return minutes;
}
function optionalText(value, field, max) {
  const clean = String(value ?? '').trim();
  if (clean.length > max) throw new ConfigurationError('CONFIGURATION_VALUE_TOO_LONG', `${field} exceeds ${max} characters`);
  return clean || null;
}
function booleanValue(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}
function optionalCode(value, field, pattern, max) {
  const clean = String(value ?? '').trim();
  return clean ? validateCode(clean, field, pattern, max) : null;
}
function validateScope(input) {
  return {
    airlineCode: optionalCode(input.airlineCode, 'AirlineCode', /^[A-Z0-9]{2,3}$/, 3),
    stationCode: optionalCode(input.stationCode, 'StationCode', /^[A-Z]{3}$/, 3)
  };
}
function validateHexColour(value) {
  const colour = requiredText(value, 'BadgeColour', 7).toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(colour)) throw new ConfigurationError('CONFIGURATION_COLOUR_INVALID', 'BadgeColour must be a six-digit hex colour');
  return colour;
}
function validateGroupColour(value) {
  const colour = requiredText(value, 'DisplayColour', 7).toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(colour)) throw new ConfigurationError('CONFIGURATION_COLOUR_INVALID', 'DisplayColour must be a six-digit hex colour');
  return colour;
}
function groupTextColour(background) {
  const colour = validateGroupColour(background);
  const values = [1, 3, 5].map(offset => parseInt(colour.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
  return luminance > 0.179 ? '#000000' : '#FFFFFF';
}
const LEGACY_GROUP_COLOURS = Object.freeze({ critical: '#8A3442', temp: '#176B79', mail: '#245F7A' });
function resolveGroupColour(value) {
  const clean = String(value || '').trim();
  return /^#[0-9A-F]{6}$/i.test(clean) ? clean.toUpperCase() : (LEGACY_GROUP_COLOURS[clean.toLowerCase()] || '#365F76');
}
function validateIntent(value) {
  const intent = String(value || 'UPDATE').trim().toUpperCase();
  if (!['CREATE', 'UPDATE', 'DELETE'].includes(intent)) throw new ConfigurationError('CONFIGURATION_INTENT_INVALID', 'Intent must be CREATE, UPDATE, or DELETE');
  return intent;
}
function validateShcCodes(value, field, allowEmpty = false) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const codes = [...new Set(source.filter(Boolean).map(code => validateCode(code, field, /^[A-Z0-9]{2,10}$/, 10)))];
  if ((!allowEmpty && !codes.length) || codes.length > 500) throw new ConfigurationError('CONFIGURATION_SHC_SELECTION_INVALID', `Select ${allowEmpty ? 'up to' : 'between 1 and'} 500 SHCs`);
  return codes;
}
function validatePositiveMinutes(value, field) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10080) throw new ConfigurationError('CONFIGURATION_MINUTES_INVALID', `${field} must be a whole number from 0 to 10080`);
  return minutes;
}
function validateSlaEvent(value, field) {
  const event = validateCode(value, field, /^[A-Z0-9_]{2,50}$/, 50);
  if (!SLA_EVENTS.has(event)) throw new ConfigurationError('CONFIGURATION_EVENT_INVALID', `${field} is not a supported CargoRun event`);
  return event;
}

const MUTATION_CAPABILITIES = Object.freeze({
  'airlines': 'EDIT_AIRLINE_RULES',
  'shc-groups': 'EDIT_SHC_RULES',
  'shc-group-settings': 'EDIT_SHC_RULES',
  'shc-mappings': 'EDIT_SHC_RULES',
  'priority-rules': 'EDIT_SHC_RULES',
  'sla-rules': 'EDIT_SLA_RULES',
  'mail-rules': 'EDIT_AIRLINE_RULES'
});

function requiredCapabilityForOperation(operation) {
  return MUTATION_CAPABILITIES[String(operation || '').toLowerCase()] || null;
}

function validateMutationInput(operation, value) {
  const input = value || {};
  const intent = validateIntent(input.intent);
  const effective = validateEffectivePeriod(input.effectiveFrom, input.effectiveTo);
  const scope = validateScope(input);
  switch (String(operation || '').toLowerCase()) {
    case 'airlines':
      return {
        airlineCode: validateCode(input.airlineCode, 'AirlineCode', /^[A-Z0-9]{2,3}$/, 3),
        stationCode: scope.stationCode,
        displayName: requiredText(input.displayName, 'DisplayName', 100),
        badgeColour: validateHexColour(input.badgeColour),
        brightBadge: booleanValue(input.brightBadge),
        isEnabled: intent === 'DELETE' ? false : booleanValue(input.isEnabled),
        operationalNotes: optionalText(input.operationalNotes, 'OperationalNotes', 1000),
        intent, ...effective
      };
    case 'shc-groups': {
      const displayColour = validateGroupColour(input.displayColour || input.visualClass);
      const displayOrder = Number(input.displayOrder);
      if (!Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > 10000) throw new ConfigurationError('CONFIGURATION_DISPLAY_ORDER_INVALID', 'DisplayOrder must be from 0 to 10000');
      return {
        groupKey: validateCode(input.groupKey, 'GroupKey', /^[A-Z0-9_]{2,40}$/, 40),
        displayToken: requiredText(input.displayToken, 'DisplayToken', 20),
        displayName: requiredText(input.displayName, 'DisplayName', 100),
        description: optionalText(input.description, 'Description', 500),
        displayOrder,
        visualClass: displayColour,
        displayColour,
        textColour: groupTextColour(displayColour),
        isEnabled: intent === 'DELETE' ? false : booleanValue(input.isEnabled),
        intent, ...effective
      };
    }
    case 'shc-group-settings': {
      const group = validateMutationInput('shc-groups', input);
      return {
        ...group, ...scope,
        expectedShcCodes: validateShcCodes(input.expectedShcCodes, 'ExpectedShcCode', true),
        selectedShcCodes: validateShcCodes(input.selectedShcCodes, 'SelectedShcCode', true)
      };
    }
    case 'shc-mappings': {
      const source = Array.isArray(input.shcCodes) ? input.shcCodes : String(input.shcCodes || '').split(/[\s,]+/);
      const shcCodes = [...new Set(source.filter(Boolean).map(code => validateCode(code, 'ShcCode', /^[A-Z0-9]{2,10}$/, 10)))];
      if (!shcCodes.length || shcCodes.length > 200) throw new ConfigurationError('CONFIGURATION_SHC_SELECTION_INVALID', 'Select between 1 and 200 SHCs');
      const mappingAction = validateCode(input.mappingAction || 'INCLUDE', 'MappingAction', /^(INCLUDE|EXCLUDE)$/, 10);
      return { shcCodes, groupKey: validateCode(input.groupKey, 'GroupKey', /^[A-Z0-9_]{2,40}$/, 40), mappingAction, intent, ...scope, ...effective };
    }
    case 'priority-rules': {
      const priorityLevel = validateCode(input.priorityLevel, 'PriorityLevel', /^(NORMAL|PRIORITY|HIGH|CRITICAL)$/, 12);
      if (!PRIORITY_LEVELS.has(priorityLevel)) throw new ConfigurationError('CONFIGURATION_PRIORITY_LEVEL_INVALID', 'PriorityLevel is invalid');
      return {
        groupKey: validateCode(input.groupKey, 'GroupKey', /^[A-Z0-9_]{2,40}$/, 40),
        priorityLevel: intent === 'DELETE' ? 'NORMAL' : priorityLevel,
        countsAsPriority: intent === 'DELETE' ? false : booleanValue(input.countsAsPriority),
        supervisorAttention: intent === 'DELETE' ? false : booleanValue(input.supervisorAttention),
        escalationEnabled: intent === 'DELETE' ? false : booleanValue(input.escalationEnabled),
        slaRuleKeyOverride: intent === 'DELETE' ? null : optionalCode(input.slaRuleKeyOverride, 'SlaRuleKeyOverride', /^[A-Z0-9_]{2,50}$/, 50),
        previousGroupKey: optionalCode(input.previousGroupKey, 'PreviousGroupKey', /^[A-Z0-9_]{2,40}$/, 40),
        previousAirlineCode: optionalCode(input.previousAirlineCode, 'PreviousAirlineCode', /^[A-Z0-9]{2,3}$/, 3),
        previousStationCode: optionalCode(input.previousStationCode, 'PreviousStationCode', /^[A-Z]{3}$/, 3),
        intent, ...scope, ...effective
      };
    }
    case 'sla-rules': {
      const targetMinutes = validatePositiveMinutes(input.targetMinutes, 'TargetMinutes');
      if (targetMinutes <= 0) throw new ConfigurationError('CONFIGURATION_MINUTES_INVALID', 'TargetMinutes must be greater than zero');
      const warningMinutes = validatePositiveMinutes(input.warningMinutes, 'WarningMinutes');
      const breachMinutes = validatePositiveMinutes(input.breachMinutes, 'BreachMinutes');
      if (breachMinutes < warningMinutes) throw new ConfigurationError('CONFIGURATION_SLA_ORDER_INVALID', 'BreachMinutes must be greater than or equal to WarningMinutes');
      const direction = optionalCode(input.direction, 'Direction', /^(IMPORT|EXPORT)$/, 10);
      if (direction && !DIRECTIONS.has(direction)) throw new ConfigurationError('CONFIGURATION_DIRECTION_INVALID', 'Direction must be IMPORT or EXPORT');
      return {
        ruleKey: validateCode(input.ruleKey, 'RuleKey', /^[A-Z0-9_]{2,50}$/, 50),
        direction,
        startEvent: validateSlaEvent(input.startEvent, 'StartEvent'),
        targetEvent: validateSlaEvent(input.targetEvent, 'TargetEvent'),
        targetMinutes, warningMinutes, breachMinutes,
        isEnabled: intent === 'DELETE' ? false : booleanValue(input.isEnabled),
        applicabilityNotes: optionalText(input.applicabilityNotes, 'ApplicabilityNotes', 500),
        intent, ...scope, ...effective
      };
    }
    case 'mail-rules': {
      const slaEnabled = booleanValue(input.slaEnabled);
      const slaRuleKey = optionalCode(input.slaRuleKey, 'SlaRuleKey', /^[A-Z0-9_]{2,50}$/, 50);
      if (intent !== 'DELETE' && slaEnabled && !slaRuleKey) throw new ConfigurationError('CONFIGURATION_MAIL_SLA_REQUIRED', 'SlaRuleKey is required when mail SLA is enabled');
      return {
        mailHandlingRequired: intent === 'DELETE' ? false : booleanValue(input.mailHandlingRequired),
        mailScanRequired: intent === 'DELETE' ? false : booleanValue(input.mailScanRequired),
        slaEnabled: intent === 'DELETE' ? false : slaEnabled, slaRuleKey: intent === 'DELETE' ? null : slaRuleKey,
        reminderEnabled: intent === 'DELETE' ? false : booleanValue(input.reminderEnabled),
        escalationEnabled: intent === 'DELETE' ? false : booleanValue(input.escalationEnabled),
        operationalInstructions: optionalText(input.operationalInstructions, 'OperationalInstructions', 1000),
        intent, ...scope, ...effective
      };
    }
    default:
      throw new ConfigurationError('CONFIGURATION_OPERATION_UNSUPPORTED', `Unsupported configuration operation ${operation}`);
  }
}
function validateConfigurationInput(kind, value) {
  const input = value || {};
  if (kind === 'AIRLINE') return { airlineCode: validateCode(input.airlineCode, 'AirlineCode', /^[A-Z0-9]{2,3}$/, 3), ...validateEffectivePeriod(input.effectiveFrom, input.effectiveTo) };
  if (kind === 'SHC') return { shcCode: validateCode(input.shcCode, 'ShcCode', /^[A-Z0-9]{2,10}$/, 10), ...validateEffectivePeriod(input.effectiveFrom, input.effectiveTo) };
  if (kind === 'GROUP') return { groupKey: validateCode(input.groupKey, 'GroupKey', /^[A-Z0-9_]{2,40}$/, 40), ...validateEffectivePeriod(input.effectiveFrom, input.effectiveTo) };
  if (kind === 'SLA') return {
    ruleKey: validateCode(input.ruleKey, 'RuleKey', /^[A-Z0-9_]{2,50}$/, 50),
    targetMinutes: validateMinutes(input.targetMinutes, 'TargetMinutes'),
    warningMinutes: validateMinutes(input.warningMinutes, 'WarningMinutes'),
    breachMinutes: validateMinutes(input.breachMinutes, 'BreachMinutes'),
    ...validateEffectivePeriod(input.effectiveFrom, input.effectiveTo)
  };
  throw new ConfigurationError('CONFIGURATION_KIND_UNSUPPORTED', `Unsupported configuration kind ${kind}`);
}

async function insertConfigurationAudit(transaction, sql, event) {
  if (!transaction) throw new ConfigurationError('CONFIGURATION_TRANSACTION_REQUIRED', 'Configuration audit requires the mutation transaction');
  const actorReference = requiredText(event?.actorReference, 'ActorReference', 150);
  const actorDisplayName = requiredText(event?.actorDisplayName, 'ActorDisplayName', 150);
  const operation = validateCode(event?.operation, 'Operation', /^[A-Z0-9_]{2,60}$/, 60);
  const entityType = validateCode(event?.entityType, 'EntityType', /^[A-Z0-9_]{2,60}$/, 60);
  const entityId = requiredText(event?.entityId, 'EntityId', 150);
  const oldJson = event.oldValue == null ? null : JSON.stringify(event.oldValue);
  const newJson = event.newValue == null ? null : JSON.stringify(event.newValue);
  const result = await new sql.Request(transaction)
    .input('ConfigurationOperation', sql.VarChar(60), operation)
    .input('ConfigurationEntityType', sql.VarChar(60), entityType)
    .input('ConfigurationEntityId', sql.NVarChar(150), entityId)
    .input('ConfigurationEffectiveFrom', sql.Date, event.effectiveFrom || null)
    .input('ConfigurationOldValueJson', sql.NVarChar(sql.MAX), oldJson)
    .input('ConfigurationNewValueJson', sql.NVarChar(sql.MAX), newJson)
    .input('ConfigurationActorReference', sql.NVarChar(150), actorReference)
    .input('ConfigurationActorDisplayName', sql.NVarChar(150), actorDisplayName)
    .input('ConfigurationCorrelationId', sql.UniqueIdentifier, event.correlationId || null)
    .query(`
      INSERT dbo.CargoRunConfigurationAudit
        (Operation,EntityType,EntityId,EffectiveFrom,OldValueJson,NewValueJson,
         ActorReference,ActorDisplayName,CorrelationId)
      OUTPUT INSERTED.ConfigurationAuditId,INSERTED.OccurredAtUtc,INSERTED.CorrelationId
      VALUES
        (@ConfigurationOperation,@ConfigurationEntityType,@ConfigurationEntityId,
         @ConfigurationEffectiveFrom,@ConfigurationOldValueJson,@ConfigurationNewValueJson,
         @ConfigurationActorReference,@ConfigurationActorDisplayName,
         COALESCE(@ConfigurationCorrelationId,NEWID()));
    `);
  return result.recordset?.[0] || null;
}

module.exports = {
  validateConfigurationInput,
  validateEffectivePeriod,
  validateMinutes,
  validateMutationInput,
  validateHexColour,
  validateGroupColour,
  groupTextColour,
  resolveGroupColour,
  requiredCapabilityForOperation,
  SLA_EVENTS,
  insertConfigurationAudit
};
