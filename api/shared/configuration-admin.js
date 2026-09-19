'use strict';

const { ConfigurationError } = require('./configuration');

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
  insertConfigurationAudit
};
