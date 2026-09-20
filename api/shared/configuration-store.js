'use strict';

const REQUIRED_CONFIGURATION_TABLES = Object.freeze([
  'CargoRunStations', 'CargoRunAirlines', 'CargoRunAirlineStations', 'CargoRunAirlineProfiles',
  'CargoRunShcs', 'CargoRunShcVersions', 'CargoRunShcGroups',
  'CargoRunShcGroupVersions', 'CargoRunShcGroupMappings',
  'CargoRunPriorityRules', 'CargoRunSlaRules', 'CargoRunMailRules',
  'CargoRunDocumentRules', 'CargoRunLocations', 'CargoRunAdminMessages', 'CargoRunCapabilities',
  'CargoRunRoles', 'CargoRunRoleCapabilities', 'CargoRunUserRoleAssignments',
  'CargoRunConfigurationAudit'
]);
const DECISION_SEQUENCE_TABLES = Object.freeze([
  'CargoRunAirlineProfiles', 'CargoRunShcGroupVersions', 'CargoRunShcGroupMappings',
  'CargoRunPriorityRules', 'CargoRunSlaRules', 'CargoRunMailRules'
]);

class ConfigurationStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConfigurationStoreError';
    this.code = code;
    this.details = details;
  }
}

let cache = null;
const DEFAULT_CACHE_TTL_MS = 60000;

async function assertConfigurationSchema(request) {
  const result = await request.query(`
    SELECT tableObject.name,columnObject.name AS ColumnName
    FROM sys.tables tableObject
    LEFT JOIN sys.columns columnObject
      ON columnObject.object_id=tableObject.object_id AND columnObject.name=N'DecisionSequence'
    WHERE schema_id = SCHEMA_ID(N'dbo')
      AND tableObject.name LIKE N'CargoRun%';
  `);
  const present = new Set((result.recordset || []).map(row => String(row.name)));
  const missing = REQUIRED_CONFIGURATION_TABLES.filter(name => !present.has(name));
  const missingDecisionSequence = DECISION_SEQUENCE_TABLES.filter(name => !(result.recordset || []).some(row => String(row.name) === name && row.ColumnName === 'DecisionSequence'));
  if (missing.length || missingDecisionSequence.length) {
    throw new ConfigurationStoreError(
      'ADMIN_CONFIGURATION_SCHEMA_NOT_READY',
      'CargoRun Admin configuration schema is not installed',
      { missingTables: missing, missingDecisionSequence }
    );
  }
}

async function loadConfigurationSnapshot(pool) {
  await assertConfigurationSchema(pool.request());
  const result = await pool.request().query(`
    SELECT s.StationId,s.StationCode,s.DisplayName,s.TimeZoneId,s.IsEnabled
    FROM dbo.CargoRunStations s ORDER BY s.StationCode;

    SELECT a.AirlineId,a.AirlineCode,p.ProfileVersionId,p.DecisionSequence,s.StationCode,
      p.DisplayName,p.BadgeColour,p.BrightBadge,p.IsEnabled,p.OperationalNotes,
      p.EffectiveFrom,p.EffectiveTo,p.CreatedAtUtc,p.CreatedByReference
    FROM dbo.CargoRunAirlines a
    JOIN dbo.CargoRunAirlineProfiles p ON p.AirlineId=a.AirlineId
    LEFT JOIN dbo.CargoRunStations s ON s.StationId=p.StationId
    ORDER BY a.AirlineCode,p.EffectiveFrom,p.DecisionSequence,p.ProfileVersionId;

    SELECT x.AirlineStationVersionId,a.AirlineCode,s.StationCode,x.AssignmentAction,
      x.EffectiveFrom,x.EffectiveTo,x.CreatedAtUtc,x.CreatedByReference
    FROM dbo.CargoRunAirlineStations x
    JOIN dbo.CargoRunAirlines a ON a.AirlineId=x.AirlineId
    JOIN dbo.CargoRunStations s ON s.StationId=x.StationId
    ORDER BY a.AirlineCode,s.StationCode,x.EffectiveFrom;

    SELECT sh.ShcId,sh.ShcCode,a.AirlineCode,v.ShcVersionId,v.Description,
      v.StandardIndicator,v.IsEnabled,v.EffectiveFrom,v.EffectiveTo
    FROM dbo.CargoRunShcs sh
    LEFT JOIN dbo.CargoRunAirlines a ON a.AirlineId=sh.CarrierAirlineId
    JOIN dbo.CargoRunShcVersions v ON v.ShcId=sh.ShcId
    ORDER BY sh.ShcCode,v.EffectiveFrom,v.ShcVersionId;

    SELECT g.ShcGroupId,g.GroupKey,v.GroupVersionId,v.DecisionSequence,v.DisplayToken,v.DisplayName,
      v.Description,v.DisplayOrder,v.VisualClass,v.IsEnabled,v.EffectiveFrom,v.EffectiveTo
    FROM dbo.CargoRunShcGroups g
    JOIN dbo.CargoRunShcGroupVersions v ON v.ShcGroupId=g.ShcGroupId
    ORDER BY v.DisplayOrder,g.GroupKey,v.EffectiveFrom,v.DecisionSequence,v.GroupVersionId;

    SELECT m.MappingId,m.DecisionSequence,sh.ShcCode,g.GroupKey,a.AirlineCode,s.StationCode,
      m.MappingAction,m.EffectiveFrom,m.EffectiveTo,m.CreatedAtUtc,m.CreatedByReference
    FROM dbo.CargoRunShcGroupMappings m
    JOIN dbo.CargoRunShcs sh ON sh.ShcId=m.ShcId
    JOIN dbo.CargoRunShcGroups g ON g.ShcGroupId=m.ShcGroupId
    LEFT JOIN dbo.CargoRunAirlines a ON a.AirlineId=m.AirlineId
    LEFT JOIN dbo.CargoRunStations s ON s.StationId=m.StationId
    ORDER BY sh.ShcCode,g.GroupKey,m.EffectiveFrom,m.DecisionSequence,m.MappingId;

    SELECT r.PriorityRuleId AS RuleId,r.DecisionSequence,g.GroupKey,a.AirlineCode,s.StationCode,
      r.PriorityLevel,r.CountsAsPriority,r.SupervisorAttention,r.EscalationEnabled,
      r.SlaRuleKeyOverride,r.EffectiveFrom,r.EffectiveTo,r.CreatedAtUtc,r.CreatedByReference
    FROM dbo.CargoRunPriorityRules r
    JOIN dbo.CargoRunShcGroups g ON g.ShcGroupId=r.ShcGroupId
    LEFT JOIN dbo.CargoRunAirlines a ON a.AirlineId=r.AirlineId
    LEFT JOIN dbo.CargoRunStations s ON s.StationId=r.StationId
    ORDER BY g.GroupKey,r.EffectiveFrom,r.DecisionSequence,r.PriorityRuleId;

    SELECT r.SlaRuleId AS RuleId,r.DecisionSequence,r.RuleKey,a.AirlineCode,s.StationCode,r.Direction,
      r.StartEvent,r.TargetEvent,r.TargetMinutes,r.WarningMinutes,r.BreachMinutes,
      r.IsEnabled,r.ApplicabilityNotes,r.EffectiveFrom,r.EffectiveTo,r.CreatedAtUtc,r.CreatedByReference
    FROM dbo.CargoRunSlaRules r
    LEFT JOIN dbo.CargoRunAirlines a ON a.AirlineId=r.AirlineId
    LEFT JOIN dbo.CargoRunStations s ON s.StationId=r.StationId
    ORDER BY r.RuleKey,r.EffectiveFrom,r.DecisionSequence,r.SlaRuleId;

    SELECT r.MailRuleId AS RuleId,r.DecisionSequence,a.AirlineCode,s.StationCode,r.MailHandlingRequired,
      r.MailScanRequired,r.SlaEnabled,r.SlaRuleKey,r.ReminderEnabled,r.EscalationEnabled,
      r.OperationalInstructions AS Instructions,r.EffectiveFrom,r.EffectiveTo,r.CreatedAtUtc,r.CreatedByReference
    FROM dbo.CargoRunMailRules r
    LEFT JOIN dbo.CargoRunAirlines a ON a.AirlineId=r.AirlineId
    LEFT JOIN dbo.CargoRunStations s ON s.StationId=r.StationId
    ORDER BY r.EffectiveFrom,r.DecisionSequence,r.MailRuleId;

    SELECT r.DocumentRuleId AS RuleId,a.AirlineCode,s.StationCode,r.Direction,r.DocumentType,
      r.IsSupported,r.IsRequired,r.BulkPieceConfirmationEnabled,r.OperationalInstructions,
      r.EffectiveFrom,r.EffectiveTo,r.CreatedAtUtc,r.CreatedByReference
    FROM dbo.CargoRunDocumentRules r
    LEFT JOIN dbo.CargoRunAirlines a ON a.AirlineId=r.AirlineId
    LEFT JOIN dbo.CargoRunStations s ON s.StationId=r.StationId
    ORDER BY r.DocumentType,r.EffectiveFrom,r.DocumentRuleId;

    SELECT l.LocationId,s.StationCode,l.LocationCode,l.DisplayName,l.IsEnabled
    FROM dbo.CargoRunLocations l
    JOIN dbo.CargoRunStations s ON s.StationId=l.StationId
    ORDER BY s.StationCode,l.LocationCode;

    SELECT MessageId,MessageSeriesId,VersionNumber,Title,MessageBody,Severity,
      AudienceType,AudienceReference,StartsAtUtc,ExpiresAtUtc,MessageAction,
      CreatedAtUtc,CreatedByDisplayName,CreatedByReference
    FROM dbo.CargoRunAdminMessages
    ORDER BY CreatedAtUtc DESC,MessageId DESC;
  `);
  const sets = result.recordsets || [];
  return {
    loadedAtUtc: new Date().toISOString(),
    stations: sets[0] || [], airlineProfiles: sets[1] || [], airlineStations: sets[2] || [], shcs: sets[3] || [],
    shcGroupVersions: sets[4] || [], shcMappings: sets[5] || [], priorityRules: sets[6] || [],
    slaRules: sets[7] || [], mailRules: sets[8] || [], documentRules: sets[9] || [],
    locations: sets[10] || [], messages: sets[11] || []
  };
}

async function loadCachedConfiguration(pool, options = {}) {
  const ttlMs = Math.max(1000, Math.min(300000, Number(options.ttlMs) || DEFAULT_CACHE_TTL_MS));
  const now = Date.now();
  const cacheKey = `${pool?.config?.server || ''}|${pool?.config?.database || ''}`;
  if (cache && cache.key === cacheKey && now - cache.loadedAt < ttlMs) return cache.snapshot;
  const snapshot = await loadConfigurationSnapshot(pool);
  cache = { key: cacheKey, loadedAt: now, snapshot };
  return snapshot;
}

function invalidateConfigurationCache() { cache = null; }

module.exports = {
  REQUIRED_CONFIGURATION_TABLES,
  DECISION_SEQUENCE_TABLES,
  ConfigurationStoreError,
  assertConfigurationSchema,
  loadConfigurationSnapshot,
  loadCachedConfiguration,
  invalidateConfigurationCache
};
