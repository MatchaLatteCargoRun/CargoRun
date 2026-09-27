'use strict';

const { authorizeCapability } = require('./configuration');
const { resolveActorCapabilities } = require('./configuration-mutations');
const {
  LEGACY_NULL_STATION_COMPATIBILITY_ENABLED,
  StationResolutionError,
  legacyRouteStationCode,
  normalizeStationRecord,
  resolveFlightStation
} = require('./station');

class OperationalAuthorizationError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = 'OperationalAuthorizationError';
    this.code = code;
    this.status = status;
  }
}

function getHeader(req, name) {
  const headers = req?.headers || {};
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || null;
}

function authenticatedActor(req) {
  const raw = getHeader(req, 'x-ms-client-principal');
  if (!raw) {
    throw new OperationalAuthorizationError(
      'AUTHENTICATION_REQUIRED',
      'Microsoft Entra sign-in is required',
      401
    );
  }

  let principal;
  try {
    principal = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new OperationalAuthorizationError(
      'AUTHENTICATION_REQUIRED',
      'Microsoft Entra sign-in is required',
      401
    );
  }

  const roles = Array.isArray(principal.userRoles) ? principal.userRoles : [];
  if (!roles.includes('authenticated')) {
    throw new OperationalAuthorizationError(
      'AUTHENTICATION_REQUIRED',
      'Microsoft Entra sign-in is required',
      401
    );
  }

  const reference = String(principal.userId || '').trim();
  if (!reference) {
    throw new OperationalAuthorizationError(
      'STABLE_IDENTITY_REQUIRED',
      'A stable authenticated user identity is required',
      401
    );
  }
  if (reference.length > 150) {
    throw new OperationalAuthorizationError(
      'STABLE_IDENTITY_REQUIRED',
      'A stable authenticated user identity is required',
      401
    );
  }

  return {
    displayName: String(principal.userDetails || 'Authenticated user').slice(0, 150),
    reference,
    roles,
    identityProvider: principal.identityProvider || 'aad'
  };
}

function stationForFlight(flight) {
  try {
    return legacyRouteStationCode(flight);
  } catch {
    throw new OperationalAuthorizationError(
      'STATION_ACCESS_DENIED',
      'The operational station could not be authorized',
      403
    );
  }
}

function normalizeCapability(value) {
  return String(value || '').trim().toUpperCase();
}

function actorReference(actor) {
  const reference = String(actor?.reference || '').trim();
  if (!reference || reference.length > 150) {
    throw new OperationalAuthorizationError(
      'STABLE_IDENTITY_REQUIRED',
      'A stable authenticated user identity is required',
      401
    );
  }
  return reference;
}

async function resolveActorAccess(executor, sql, actor) {
  const reference = actorReference(actor);
  let result;
  try {
    result = await new sql.Request(executor)
      .input('OperationalAccessActorReference', sql.NVarChar(150), reference)
      .query(`
        WITH AuthorizationScopes AS (
          SELECT StationId,StationCode,DisplayName,TimeZoneId
          FROM dbo.CargoRunStations
          WHERE IsEnabled=1
          UNION ALL
          SELECT CAST(NULL AS bigint),CAST(NULL AS varchar(3)),CAST(NULL AS nvarchar(100)),CAST(NULL AS nvarchar(100))
        ), AssignmentDecisions AS (
          SELECT scope.StationId,scope.StationCode,scope.DisplayName,scope.TimeZoneId,
            assignment.RoleId,assignment.AssignmentAction,
            ROW_NUMBER() OVER (
              PARTITION BY scope.StationCode,assignment.RoleId
              ORDER BY CASE WHEN assignment.StationId IS NULL THEN 0 ELSE 1 END DESC,
                assignment.EffectiveFrom DESC,assignment.UserRoleVersionId DESC
            ) AS DecisionRank
          FROM AuthorizationScopes scope
          JOIN dbo.CargoRunUserRoleAssignments assignment
            ON assignment.ActorReference=@OperationalAccessActorReference
           AND ((scope.StationId IS NULL AND assignment.StationId IS NULL)
             OR (scope.StationId IS NOT NULL AND (assignment.StationId IS NULL OR assignment.StationId=scope.StationId)))
          WHERE assignment.EffectiveFrom<=CONVERT(date,SYSUTCDATETIME())
            AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>CONVERT(date,SYSUTCDATETIME()))
        ), EffectiveRoles AS (
          SELECT StationId,StationCode,DisplayName,TimeZoneId,RoleId
          FROM AssignmentDecisions
          WHERE DecisionRank=1 AND AssignmentAction='GRANT'
        ), CapabilityDecisions AS (
          SELECT role.StationId,role.StationCode,role.DisplayName,role.TimeZoneId,
            decision.RoleId,decision.CapabilityId,decision.CapabilityAction,
            ROW_NUMBER() OVER (
              PARTITION BY role.StationCode,decision.RoleId,decision.CapabilityId
              ORDER BY decision.EffectiveFrom DESC,decision.RoleCapabilityVersionId DESC
            ) AS DecisionRank
          FROM EffectiveRoles role
          JOIN dbo.CargoRunRoleCapabilities decision ON decision.RoleId=role.RoleId
          WHERE decision.EffectiveFrom<=CONVERT(date,SYSUTCDATETIME())
            AND (decision.EffectiveTo IS NULL OR decision.EffectiveTo>CONVERT(date,SYSUTCDATETIME()))
        )
        SELECT DISTINCT decision.StationId,decision.StationCode,decision.DisplayName,decision.TimeZoneId,
          capability.CapabilityCode
        FROM CapabilityDecisions decision
        JOIN dbo.CargoRunCapabilities capability ON capability.CapabilityId=decision.CapabilityId
        JOIN dbo.CargoRunRoles role ON role.RoleId=decision.RoleId
        WHERE decision.DecisionRank=1 AND decision.CapabilityAction='GRANT'
          AND capability.IsEnabled=1 AND role.IsEnabled=1
        ORDER BY decision.StationCode,capability.CapabilityCode;
      `);
  } catch {
    throw new OperationalAuthorizationError(
      'AUTHORIZATION_CONFIGURATION_UNAVAILABLE',
      'Operational authorization could not be resolved',
      503
    );
  }

  const capabilitiesByStation = {};
  const globalCapabilities = [];
  const capabilities = new Set();
  const stationMetadataByCode = new Map();
  for (const row of result.recordset || []) {
    const capability = normalizeCapability(row.CapabilityCode);
    if (!capability) continue;
    capabilities.add(capability);
    const stationCode = String(row.StationCode || '').trim().toUpperCase();
    if (!stationCode) {
      globalCapabilities.push(capability);
      continue;
    }
    if (!/^[A-Z]{3}$/.test(stationCode)) {
      throw new OperationalAuthorizationError(
        'AUTHORIZATION_CONFIGURATION_INVALID',
        'Operational authorization is not configured correctly',
        503
      );
    }
    let station;
    try {
      station = normalizeStationRecord({ ...row, IsEnabled: 1 });
    } catch {
      throw new OperationalAuthorizationError(
        'AUTHORIZATION_CONFIGURATION_INVALID',
        'Operational authorization is not configured correctly',
        503
      );
    }
    const existingStation = stationMetadataByCode.get(stationCode);
    if (existingStation && existingStation.stationId !== station.stationId) {
      throw new OperationalAuthorizationError(
        'AUTHORIZATION_CONFIGURATION_INVALID',
        'Operational authorization is not configured correctly',
        503
      );
    }
    stationMetadataByCode.set(stationCode, station);
    if (!capabilitiesByStation[stationCode]) capabilitiesByStation[stationCode] = [];
    capabilitiesByStation[stationCode].push(capability);
  }

  for (const stationCode of Object.keys(capabilitiesByStation)) {
    capabilitiesByStation[stationCode] = [...new Set(capabilitiesByStation[stationCode])].sort();
  }

  return {
    actorReference: reference,
    provisioned: capabilities.size > 0,
    stations: Object.keys(capabilitiesByStation).sort(),
    stationMetadata: [...stationMetadataByCode.values()].sort((left, right) =>
      left.stationCode.localeCompare(right.stationCode)
    ),
    capabilities: [...capabilities].sort(),
    globalCapabilities: [...new Set(globalCapabilities)].sort(),
    capabilitiesByStation
  };
}

async function requireOperationalStations(executor, sql, actor, requiredCapability) {
  const capability = normalizeCapability(requiredCapability);
  if (!capability) {
    throw new OperationalAuthorizationError(
      'AUTHORIZATION_CONFIGURATION_INVALID',
      'Operational authorization is not configured for this action',
      503
    );
  }
  const access = await resolveActorAccess(executor, sql, actor);
  const stations = access.stations.filter(stationCode =>
    access.capabilitiesByStation[stationCode].includes(capability)
  );
  if (!stations.length) {
    throw new OperationalAuthorizationError(
      'CAPABILITY_REQUIRED',
      'The authenticated user is not authorized for this operation at an enabled station',
      403
    );
  }
  return { ...access, stations, requiredCapability: capability };
}

async function requireAnyOperationalCapability(executor, sql, actor, requiredCapabilities) {
  const required = [...new Set((requiredCapabilities || []).map(normalizeCapability).filter(Boolean))];
  if (!required.length) {
    throw new OperationalAuthorizationError(
      'AUTHORIZATION_CONFIGURATION_INVALID',
      'Operational authorization is not configured for this action',
      503
    );
  }
  const access = await resolveActorAccess(executor, sql, actor);
  const matchedCapability = required.find(capability => access.capabilities.includes(capability));
  if (!matchedCapability) {
    throw new OperationalAuthorizationError(
      'CAPABILITY_REQUIRED',
      'The authenticated user is not authorized for this operation',
      403
    );
  }
  return { ...access, requiredCapability: matchedCapability };
}

function bindStationParameters(request, sql, stationCodes, prefix = 'AuthorizedStation') {
  const codes = [...new Set((stationCodes || []).map(value => String(value).trim().toUpperCase()))];
  if (!codes.length || codes.some(code => !/^[A-Z]{3}$/.test(code))) {
    throw new OperationalAuthorizationError(
      'AUTHORIZATION_CONFIGURATION_INVALID',
      'Operational authorization is not configured correctly',
      503
    );
  }
  return codes.map((code, index) => {
    const name = `${prefix}${index}`;
    request.input(name, sql.VarChar(3), code);
    return `@${name}`;
  });
}

function flightStationPredicate(alias, stationParameters) {
  const qualified = String(alias || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(qualified) || !stationParameters?.length) {
    throw new OperationalAuthorizationError(
      'AUTHORIZATION_CONFIGURATION_INVALID',
      'Operational authorization is not configured correctly',
      503
    );
  }
  const allowed = stationParameters.join(',');
  const legacy = LEGACY_NULL_STATION_COMPATIBILITY_ENABLED
    ? ` OR (${qualified}.StationId IS NULL AND ((UPPER(${qualified}.Direction)='IMPORT' AND UPPER(${qualified}.DestinationAirport) IN (${allowed}))
      OR (UPPER(${qualified}.Direction)='EXPORT' AND UPPER(${qualified}.OriginAirport) IN (${allowed}))))`
    : '';
  return `((${qualified}.StationId IS NOT NULL AND EXISTS (
      SELECT 1 FROM dbo.CargoRunStations authorizedStation
      WHERE authorizedStation.StationId=${qualified}.StationId AND authorizedStation.IsEnabled=1
        AND authorizedStation.StationCode IN (${allowed})
    ))${legacy})`;
}

async function requireOperationalCapability(executor, sql, actor, flight, requiredCapability) {
  const reference = actorReference(actor);

  const capability = normalizeCapability(requiredCapability);
  if (!capability) {
    throw new OperationalAuthorizationError(
      'AUTHORIZATION_CONFIGURATION_INVALID',
      'Operational authorization is not configured for this action',
      503
    );
  }

  let station;
  try {
    station = await resolveFlightStation(executor, sql, flight);
  } catch (error) {
    if (error instanceof StationResolutionError) {
      throw new OperationalAuthorizationError(
        'STATION_ACCESS_DENIED',
        'The operational station could not be authorized',
        403
      );
    }
    throw new OperationalAuthorizationError(
      'AUTHORIZATION_CONFIGURATION_UNAVAILABLE',
      'Operational authorization could not be resolved',
      503
    );
  }
  const stationCode = station.stationCode;

  let capabilities;
  try {
    capabilities = await resolveActorCapabilities(executor, sql, reference, stationCode);
  } catch {
    throw new OperationalAuthorizationError(
      'AUTHORIZATION_CONFIGURATION_UNAVAILABLE',
      'Operational authorization could not be resolved',
      503
    );
  }
  const decision = authorizeCapability({
    enforcementMode: 'ENFORCED',
    capabilities,
    requiredCapability: capability
  });
  if (!decision.allowed) {
    throw new OperationalAuthorizationError(
      'CAPABILITY_REQUIRED',
      'The authenticated user is not authorized for this operation at the selected station',
      403
    );
  }

  return { actorReference: reference, ...station, requiredCapability: capability, capabilities };
}

function operationalEntityUnavailable() {
  return new OperationalAuthorizationError(
    'OPERATIONAL_ENTITY_NOT_AVAILABLE',
    'The selected operational record is unavailable',
    404
  );
}

async function requireOperationalEntityCapability(executor, sql, actor, flight, requiredCapability) {
  if (!flight) throw operationalEntityUnavailable();
  try {
    return await requireOperationalCapability(executor, sql, actor, flight, requiredCapability);
  } catch (error) {
    if (error instanceof OperationalAuthorizationError && error.status === 403) {
      throw operationalEntityUnavailable();
    }
    throw error;
  }
}

function sendOperationalAuthorizationError(context, error, sendJson) {
  if (error instanceof StationResolutionError) {
    const denied = error.code === 'STATION_ACCESS_DENIED' || error.code === 'STATION_INVALID';
    sendJson(context, denied ? 403 : 503, {
      ok: false,
      code: denied ? 'STATION_ACCESS_DENIED' : 'AUTHORIZATION_CONFIGURATION_UNAVAILABLE',
      error: denied
        ? 'The authenticated user is not authorized for this operation at the selected station'
        : 'Operational authorization could not be resolved'
    });
    return true;
  }
  if (!(error instanceof OperationalAuthorizationError)) return false;
  sendJson(context, error.status, { ok: false, code: error.code, error: error.message });
  return true;
}

module.exports = {
  OperationalAuthorizationError,
  LEGACY_NULL_STATION_COMPATIBILITY_ENABLED,
  authenticatedActor,
  stationForFlight,
  resolveActorAccess,
  requireOperationalStations,
  requireAnyOperationalCapability,
  bindStationParameters,
  flightStationPredicate,
  requireOperationalCapability,
  operationalEntityUnavailable,
  requireOperationalEntityCapability,
  sendOperationalAuthorizationError
};
