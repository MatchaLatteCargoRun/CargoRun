'use strict';

class ConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigurationError';
    this.code = code;
  }
}

const SCOPE_PRECEDENCE = Object.freeze({ GLOBAL: 0, STATION: 1, AIRLINE: 2, AIRLINE_STATION: 3 });
const PRIORITY_LEVELS = Object.freeze({ NORMAL: 0, PRIORITY: 1, HIGH: 2, CRITICAL: 3 });

const FALLBACK_AIRLINES = Object.freeze({
  CX: { airlineCode: 'CX', displayName: 'Cathay Pacific', badgeColour: '#006564', brightBadge: false },
  UA: { airlineCode: 'UA', displayName: 'United Airlines', badgeColour: '#0033A0', brightBadge: false },
  MH: { airlineCode: 'MH', displayName: 'Malaysia Airlines', badgeColour: '#002B5C', brightBadge: false },
  QR: { airlineCode: 'QR', displayName: 'Qatar Airways', badgeColour: '#662046', brightBadge: false },
  TG: { airlineCode: 'TG', displayName: 'Thai Airways', badgeColour: '#370E62', brightBadge: false },
  BI: { airlineCode: 'BI', displayName: 'Royal Brunei', badgeColour: '#FFE600', brightBadge: true },
  GA: { airlineCode: 'GA', displayName: 'Garuda Indonesia', badgeColour: '#202D5C', brightBadge: false },
  VN: { airlineCode: 'VN', displayName: 'Vietnam Airlines', badgeColour: '#005E80', brightBadge: false },
  AI: { airlineCode: 'AI', displayName: 'Air India', badgeColour: '#DA0E29', brightBadge: false },
  JQ: { airlineCode: 'JQ', displayName: 'Jetstar', badgeColour: '#E65C00', brightBadge: false }
});

const FALLBACK_GROUPS = Object.freeze({
  LIVE: { groupKey: 'LIVE', displayToken: 'AVI', displayName: 'Live Animals', displayOrder: 10, priorityLevel: 'CRITICAL', supervisorAttention: true, visualClass: 'critical' },
  TEMP: { groupKey: 'TEMP', displayToken: 'TEMP', displayName: 'Temperature Controlled', displayOrder: 20, priorityLevel: 'PRIORITY', supervisorAttention: true, visualClass: 'temp' },
  PHARMA: { groupKey: 'PHARMA', displayToken: 'PHARMA', displayName: 'Pharma', displayOrder: 30, priorityLevel: 'PRIORITY', supervisorAttention: true, visualClass: 'temp' },
  MAIL: { groupKey: 'MAIL', displayToken: 'MAIL', displayName: 'Priority Mail', displayOrder: 40, priorityLevel: 'PRIORITY', supervisorAttention: true, visualClass: 'mail' },
  AOG: { groupKey: 'AOG', displayToken: 'AOG', displayName: 'Aircraft on Ground', displayOrder: 50, priorityLevel: 'CRITICAL', supervisorAttention: true, visualClass: 'critical' },
  VALUABLE: { groupKey: 'VALUABLE', displayToken: 'VAL', displayName: 'Valuable Cargo', displayOrder: 60, priorityLevel: 'PRIORITY', supervisorAttention: true, visualClass: '' },
  HUM: { groupKey: 'HUM', displayToken: 'HUM', displayName: 'Human Remains', displayOrder: 70, priorityLevel: 'PRIORITY', supervisorAttention: true, visualClass: '' },
  DGR: { groupKey: 'DGR', displayToken: 'DGR', displayName: 'Dangerous Goods', displayOrder: 80, priorityLevel: 'PRIORITY', supervisorAttention: true, visualClass: 'critical' }
});

const FALLBACK_SHC_GROUPS = Object.freeze({
  AVI: ['LIVE'], COL: ['TEMP'], CRT: ['TEMP'], FRO: ['TEMP'], EAT: ['TEMP'],
  PEF: ['TEMP'], PER: ['TEMP'], ICE: ['TEMP'], PIL: ['PHARMA'], AOG: ['AOG'],
  VAL: ['VALUABLE'], AVP: ['VALUABLE'], AVC: ['VALUABLE'], GOL: ['VALUABLE'],
  HUM: ['HUM'], DGR: ['DGR']
});

const FALLBACK_SLAS = Object.freeze({
  IMPORT_ACCEPTANCE_STANDARD: { ruleKey: 'IMPORT_ACCEPTANCE_STANDARD', direction: 'IMPORT', startEvent: 'IN_BLOCK', targetEvent: 'ULD_ACCEPTED', targetMinutes: 30, warningMinutes: 20, breachMinutes: 30 },
  IMPORT_ACCEPTANCE_PRIORITY: { ruleKey: 'IMPORT_ACCEPTANCE_PRIORITY', direction: 'IMPORT', startEvent: 'IN_BLOCK', targetEvent: 'ULD_ACCEPTED', targetMinutes: 20, warningMinutes: 10, breachMinutes: 20 },
  EXPORT_AT_AIRCRAFT: { ruleKey: 'EXPORT_AT_AIRCRAFT', direction: 'EXPORT', startEvent: 'ESTIMATED_DEPARTURE', targetEvent: 'ULD_AT_AIRCRAFT', targetMinutes: -60, warningMinutes: -90, breachMinutes: -60 },
  MAIL_SCAN: { ruleKey: 'MAIL_SCAN', direction: 'IMPORT', startEvent: 'IN_BLOCK', targetEvent: 'MAIL_SCANNED', targetMinutes: 180, warningMinutes: 120, breachMinutes: 180 },
  OFFLOAD_AGE: { ruleKey: 'OFFLOAD_AGE', direction: 'EXPORT', startEvent: 'OFFLOAD_REQUESTED', targetEvent: 'OFFLOAD_COMPLETED', targetMinutes: 10, warningMinutes: 10, breachMinutes: 10 }
});

const FALLBACK_MAIL_AIRLINES = new Set(['CX', 'UA']);

function text(value) { return String(value ?? '').trim().toUpperCase(); }
function dateKey(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}
function contextDate(context) {
  const key = dateKey(context?.operatingDate || context?.effectiveAt);
  if (!key) throw new ConfigurationError('CONFIGURATION_DATE_REQUIRED', 'A valid operating date is required for rule resolution');
  return key;
}
function isEffective(row, operatingDate) {
  const from = dateKey(row.EffectiveFrom ?? row.effectiveFrom);
  const to = dateKey(row.EffectiveTo ?? row.effectiveTo);
  return !!from && from <= operatingDate && (!to || operatingDate < to);
}
function scopeRank(row, context) {
  const rowAirline = text(row.AirlineCode ?? row.airlineCode);
  const rowStation = text(row.StationCode ?? row.stationCode);
  const airline = text(context?.airlineCode);
  const station = text(context?.stationCode);
  if (rowAirline && rowAirline !== airline) return -1;
  if (rowStation && rowStation !== station) return -1;
  if (rowAirline && rowStation) return SCOPE_PRECEDENCE.AIRLINE_STATION;
  if (rowAirline) return SCOPE_PRECEDENCE.AIRLINE;
  if (rowStation) return SCOPE_PRECEDENCE.STATION;
  return SCOPE_PRECEDENCE.GLOBAL;
}
function rowId(row) {
  return String(row.RuleId ?? row.MappingId ?? row.ProfileVersionId ?? row.GroupVersionId ?? row.id ?? '');
}
function compareCandidates(a, b, context) {
  const rank = scopeRank(b, context) - scopeRank(a, context);
  if (rank) return rank;
  const from = dateKey(b.EffectiveFrom ?? b.effectiveFrom).localeCompare(dateKey(a.EffectiveFrom ?? a.effectiveFrom));
  if (from) return from;
  return rowId(b).localeCompare(rowId(a), undefined, { numeric: true });
}
function resolveScoped(rows, context, predicate = () => true) {
  const when = contextDate(context);
  const candidates = (rows || []).filter(row => predicate(row) && isEffective(row, when) && scopeRank(row, context) >= 0).sort((a, b) => compareCandidates(a, b, context));
  if (!candidates.length) return null;
  const first = candidates[0];
  const tied = candidates.filter(row => scopeRank(row, context) === scopeRank(first, context) && dateKey(row.EffectiveFrom ?? row.effectiveFrom) === dateKey(first.EffectiveFrom ?? first.effectiveFrom));
  if (tied.length > 1) throw new ConfigurationError('CONFIGURATION_AMBIGUOUS', 'More than one rule has the same scope and effective start date');
  return first;
}

function resolveAirlineConfig(snapshot, context) {
  const airlineCode = text(context?.airlineCode);
  const configured = resolveScoped(snapshot?.airlineProfiles, context, row => text(row.AirlineCode ?? row.airlineCode) === airlineCode);
  if (configured) return { ...configured, source: 'configured' };
  return { ...(FALLBACK_AIRLINES[airlineCode] || { airlineCode, displayName: airlineCode || 'Unknown airline', badgeColour: '#365f76', brightBadge: false }), source: 'fallback' };
}

function fallbackGroupsForCode(code, context) {
  const keys = [...(FALLBACK_SHC_GROUPS[code] || [])];
  if (['MAL', 'MAIL'].includes(code) && FALLBACK_MAIL_AIRLINES.has(text(context?.airlineCode))) keys.push('MAIL');
  return keys;
}
function groupDefinition(snapshot, groupKey, context) {
  const configured = resolveScoped(snapshot?.shcGroupVersions, context, row => text(row.GroupKey ?? row.groupKey) === groupKey);
  return configured ? { ...configured, groupKey, source: 'configured' } : FALLBACK_GROUPS[groupKey] ? { ...FALLBACK_GROUPS[groupKey], source: 'fallback' } : null;
}
function resolveShcGroups(snapshot, context) {
  const rawShcs = [...new Set((context?.rawShcs || []).map(text).filter(Boolean))];
  const resolved = new Map();
  const unassignedShcs = [];
  for (const shc of rawShcs) {
    const applicable = (snapshot?.shcMappings || []).filter(row => text(row.ShcCode ?? row.shcCode) === shc && isEffective(row, contextDate(context)) && scopeRank(row, context) >= 0);
    const fallbackKeys = fallbackGroupsForCode(shc, context);
    const groupKeys = new Set([...fallbackKeys, ...applicable.map(row => text(row.GroupKey ?? row.groupKey)).filter(Boolean)]);
    let hadDecision = false;
    for (const groupKey of groupKeys) {
      const decision = resolveScoped(applicable, context, row => text(row.GroupKey ?? row.groupKey) === groupKey);
      if (!decision) {
        if (fallbackKeys.includes(groupKey)) resolved.set(groupKey, groupDefinition(snapshot, groupKey, context));
        continue;
      }
      hadDecision = true;
      if (text((decision.MappingAction ?? decision.mappingAction) || 'INCLUDE') === 'INCLUDE') resolved.set(groupKey, groupDefinition(snapshot, groupKey, context));
      else resolved.delete(groupKey);
    }
    if (!hadDecision && fallbackKeys.length === 0) unassignedShcs.push(shc);
  }
  return { groups: [...resolved.values()].filter(Boolean).sort((a, b) => Number(a.DisplayOrder ?? a.displayOrder ?? 999) - Number(b.DisplayOrder ?? b.displayOrder ?? 999) || String(a.groupKey).localeCompare(String(b.groupKey))), unassignedShcs };
}

function resolvePriorityRules(snapshot, context) {
  const shc = resolveShcGroups(snapshot, context);
  const groups = shc.groups.map(group => {
    const groupKey = text(group.GroupKey ?? group.groupKey);
    const configured = resolveScoped(snapshot?.priorityRules, context, row => text(row.GroupKey ?? row.groupKey) === groupKey);
    const priorityLevel = text(configured?.PriorityLevel ?? configured?.priorityLevel ?? group.PriorityLevel ?? group.priorityLevel ?? 'NORMAL');
    if (!(priorityLevel in PRIORITY_LEVELS)) throw new ConfigurationError('CONFIGURATION_PRIORITY_LEVEL_INVALID', `Unsupported priority level ${priorityLevel}`);
    return { ...group, ...(configured || {}), groupKey, priorityLevel, priorityRank: PRIORITY_LEVELS[priorityLevel], source: configured ? 'configured' : group.source };
  });
  return { groups, priorityLevel: groups.reduce((level, group) => Math.max(level, group.priorityRank), 0), unassignedShcs: shc.unassignedShcs };
}

function resolveSlaRule(snapshot, context, ruleKey) {
  const key = text(ruleKey);
  const configured = resolveScoped(snapshot?.slaRules, context, row => text(row.RuleKey ?? row.ruleKey) === key);
  return configured ? { ...configured, source: 'configured' } : FALLBACK_SLAS[key] ? { ...FALLBACK_SLAS[key], source: 'fallback' } : null;
}
function resolveMailRules(snapshot, context) {
  const configured = resolveScoped(snapshot?.mailRules, context);
  if (configured) return { ...configured, source: 'configured' };
  const required = FALLBACK_MAIL_AIRLINES.has(text(context?.airlineCode));
  return { mailHandlingRequired: required, mailScanRequired: required, slaEnabled: required, slaRuleKey: required ? 'MAIL_SCAN' : null, reminderEnabled: required, escalationEnabled: required, instructions: '', source: 'fallback' };
}
function resolveDocumentRules(snapshot, context, documentType) {
  const type = text(documentType);
  const configured = resolveScoped(snapshot?.documentRules, context, row => text(row.DocumentType ?? row.documentType) === type && (!row.Direction && !row.direction || text(row.Direction ?? row.direction) === text(context?.direction)));
  return configured ? { ...configured, source: 'configured' } : { documentType: type, configured: false, source: 'fallback' };
}

function validateRuleSet(rows, naturalKey) {
  const seen = new Set();
  for (const row of rows || []) {
    const from = dateKey(row.EffectiveFrom ?? row.effectiveFrom);
    const to = dateKey(row.EffectiveTo ?? row.effectiveTo);
    if (!from || (to && to <= from)) throw new ConfigurationError('CONFIGURATION_EFFECTIVE_RANGE_INVALID', 'EffectiveTo must be later than EffectiveFrom');
    const key = [naturalKey(row), text(row.AirlineCode ?? row.airlineCode) || '*', text(row.StationCode ?? row.stationCode) || '*', from].join('|');
    if (seen.has(key)) throw new ConfigurationError('CONFIGURATION_DUPLICATE_VERSION', `Duplicate rule version ${key}`);
    seen.add(key);
  }
  return true;
}

function latestEffectiveEvents(rows, effectiveAt, keyOf) {
  const chosen = new Map();
  for (const row of (rows || []).filter(item => isEffective(item, effectiveAt))) {
    const key = keyOf(row);
    const existing = chosen.get(key);
    const from = dateKey(row.EffectiveFrom ?? row.effectiveFrom);
    const existingFrom = existing ? dateKey(existing.EffectiveFrom ?? existing.effectiveFrom) : '';
    if (!existing || from > existingFrom) chosen.set(key, row);
    else if (from === existingFrom && rowId(row) !== rowId(existing)) throw new ConfigurationError('CONFIGURATION_AMBIGUOUS', `More than one authorization event applies to ${key}`);
  }
  return [...chosen.values()];
}
function resolveCapabilities(snapshot, actorReference, effectiveAt, stationCode = '') {
  const reference = String(actorReference ?? '').trim();
  if (!reference) return [];
  const context = { operatingDate: effectiveAt };
  const when = contextDate(context);
  const assignments = (snapshot?.userRoleAssignments || []).filter(row => String(row.ActorReference ?? row.actorReference) === reference && isEffective(row, when) && (!text(row.StationCode ?? row.stationCode) || text(row.StationCode ?? row.stationCode) === text(stationCode)));
  const roleKeys = [...new Set(assignments.map(row => String(row.RoleId ?? row.roleId)))];
  const activeAssignments = roleKeys.map(roleId => {
    const candidates = assignments.filter(row => String(row.RoleId ?? row.roleId) === roleId).sort((a, b) => {
      const scope = Number(!!text(b.StationCode ?? b.stationCode)) - Number(!!text(a.StationCode ?? a.stationCode));
      return scope || dateKey(b.EffectiveFrom ?? b.effectiveFrom).localeCompare(dateKey(a.EffectiveFrom ?? a.effectiveFrom)) || rowId(b).localeCompare(rowId(a), undefined, { numeric: true });
    });
    if (candidates.length > 1 && !!text(candidates[0].StationCode ?? candidates[0].stationCode) === !!text(candidates[1].StationCode ?? candidates[1].stationCode) && dateKey(candidates[0].EffectiveFrom ?? candidates[0].effectiveFrom) === dateKey(candidates[1].EffectiveFrom ?? candidates[1].effectiveFrom)) throw new ConfigurationError('CONFIGURATION_AMBIGUOUS', `More than one user role event applies to ${roleId}`);
    return candidates[0];
  }).filter(row => text((row.AssignmentAction ?? row.assignmentAction) || 'GRANT') === 'GRANT');
  const roleIds = new Set(activeAssignments.map(row => String(row.RoleId ?? row.roleId)));
  const decisions = latestEffectiveEvents((snapshot?.roleCapabilities || []).filter(row => roleIds.has(String(row.RoleId ?? row.roleId))), when, row => `${row.RoleId ?? row.roleId}|${text(row.CapabilityCode ?? row.capabilityCode)}`);
  return [...new Set(decisions.filter(row => text((row.CapabilityAction ?? row.capabilityAction) || 'GRANT') === 'GRANT').map(row => text(row.CapabilityCode ?? row.capabilityCode)).filter(Boolean))].sort();
}
function authorizeCapability({ enforcementMode = 'LEGACY', capabilities = [], requiredCapability }) {
  const mode = text(enforcementMode || 'LEGACY');
  const allowedByCapability = new Set(capabilities.map(text)).has(text(requiredCapability));
  if (mode === 'ENFORCED') return { allowed: allowedByCapability, mode, wouldDeny: !allowedByCapability };
  return { allowed: true, mode: mode === 'AUDIT' ? 'AUDIT' : 'LEGACY', wouldDeny: !allowedByCapability };
}

module.exports = {
  ConfigurationError, SCOPE_PRECEDENCE, PRIORITY_LEVELS, FALLBACK_AIRLINES, FALLBACK_GROUPS,
  FALLBACK_SHC_GROUPS, FALLBACK_SLAS, isEffective, scopeRank, resolveScoped,
  resolveAirlineConfig, resolveShcGroups, resolvePriorityRules, resolveSlaRule,
  resolveMailRules, resolveDocumentRules, validateRuleSet, resolveCapabilities,
  authorizeCapability
};
