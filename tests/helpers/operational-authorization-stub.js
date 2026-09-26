'use strict';

const actual = require('../../api/shared/operational-authorization');
const stationMetadata = [
  { stationId: '1', stationCode: 'MEL', displayName: 'Melbourne', timeZoneId: 'Australia/Melbourne' },
  { stationId: '2', stationCode: 'SYD', displayName: 'Sydney', timeZoneId: 'Australia/Sydney' },
  { stationId: '3', stationCode: 'BNE', displayName: 'Brisbane', timeZoneId: 'Australia/Brisbane' },
  { stationId: '4', stationCode: 'HKG', displayName: 'Hong Kong', timeZoneId: 'Asia/Hong_Kong' },
  { stationId: '5', stationCode: 'SIN', displayName: 'Singapore', timeZoneId: 'Asia/Singapore' },
  { stationId: '6', stationCode: 'DXB', displayName: 'Dubai', timeZoneId: 'Asia/Dubai' },
  { stationId: '7', stationCode: 'KUL', displayName: 'Kuala Lumpur', timeZoneId: 'Asia/Kuala_Lumpur' },
  { stationId: '8', stationCode: 'AKL', displayName: 'Auckland', timeZoneId: 'Pacific/Auckland' }
];
const stations = stationMetadata.map(station => station.stationCode);
const access = capabilities => ({
  actorReference: 'test-user',
  provisioned: true,
  stations,
  stationMetadata,
  capabilities,
  globalCapabilities: [],
  capabilitiesByStation: Object.fromEntries(stations.map(station => [station, capabilities]))
});

const requireOperationalCapability = async (_executor, _sql, actor, flight, requiredCapability) => {
  const stationId = String(flight?.StationId || 1);
  const stationCode = String(
    String(flight?.Direction || '').toUpperCase() === 'IMPORT'
      ? flight?.DestinationAirport || 'MEL'
      : flight?.OriginAirport || 'MEL'
  ).toUpperCase();
  const metadata = stationMetadata.find(station => station.stationCode === stationCode)
    || stationMetadata.find(station => station.stationId === stationId);
  return {
    actorReference: actor.reference,
    stationId,
    stationCode,
    displayName: metadata?.displayName || stationCode,
    timeZoneId: metadata?.timeZoneId || null,
    requiredCapability,
    capabilities: [requiredCapability]
  };
};

const requireOperationalEntityCapability = async (executor, sql, actor, flight, requiredCapability) => {
  if (!flight) throw actual.operationalEntityUnavailable();
  return requireOperationalCapability(executor, sql, actor, flight, requiredCapability);
};

module.exports = {
  ...actual,
  resolveActorAccess: async () => access(['VIEW_FLIGHTS', 'VIEW_HISTORY', 'VIEW_FLIGHT_STATEMENT', 'VIEW_SUPERVISOR']),
  requireOperationalStations: async (_executor, _sql, _actor, requiredCapability) => ({
    ...access([requiredCapability]), requiredCapability
  }),
  requireAnyOperationalCapability: async (_executor, _sql, _actor, requiredCapabilities) => ({
    ...access(requiredCapabilities), requiredCapability: requiredCapabilities[0]
  }),
  requireOperationalCapability,
  requireOperationalEntityCapability
};
