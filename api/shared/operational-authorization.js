'use strict';

const { authorizeCapability } = require('./configuration');
const { resolveActorCapabilities } = require('./configuration-mutations');

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
  const direction = String(flight?.Direction ?? flight?.direction ?? '').trim().toUpperCase();
  const station = String(direction === 'IMPORT'
    ? (flight?.DestinationAirport ?? flight?.destinationAirport ?? '')
    : direction === 'EXPORT'
      ? (flight?.OriginAirport ?? flight?.originAirport ?? '')
      : '').trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(station)) {
    throw new OperationalAuthorizationError(
      'STATION_ACCESS_DENIED',
      'The operational station could not be authorized',
      403
    );
  }
  return station;
}

async function requireOperationalCapability(executor, sql, actor, flight, requiredCapability) {
  const reference = String(actor?.reference || '').trim();
  if (!reference) {
    throw new OperationalAuthorizationError(
      'STABLE_IDENTITY_REQUIRED',
      'A stable authenticated user identity is required',
      401
    );
  }

  const capability = String(requiredCapability || '').trim().toUpperCase();
  if (!capability) {
    throw new OperationalAuthorizationError(
      'AUTHORIZATION_CONFIGURATION_INVALID',
      'Operational authorization is not configured for this action',
      503
    );
  }

  const stationCode = stationForFlight(flight);
  let stationResult;
  try {
    stationResult = await new sql.Request(executor)
      .input('OperationalAuthorizationStation', sql.VarChar(3), stationCode)
      .query(`SELECT StationId FROM dbo.CargoRunStations
        WHERE StationCode=@OperationalAuthorizationStation AND IsEnabled=1;`);
  } catch {
    throw new OperationalAuthorizationError(
      'AUTHORIZATION_CONFIGURATION_UNAVAILABLE',
      'Operational authorization could not be resolved',
      503
    );
  }
  if ((stationResult.recordset || []).length !== 1) {
    throw new OperationalAuthorizationError(
      'STATION_ACCESS_DENIED',
      'The operational station could not be authorized',
      403
    );
  }

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

  return { actorReference: reference, stationCode, requiredCapability: capability, capabilities };
}

function sendOperationalAuthorizationError(context, error, sendJson) {
  if (!(error instanceof OperationalAuthorizationError)) return false;
  sendJson(context, error.status, { ok: false, code: error.code, error: error.message });
  return true;
}

module.exports = {
  OperationalAuthorizationError,
  authenticatedActor,
  stationForFlight,
  requireOperationalCapability,
  sendOperationalAuthorizationError
};
