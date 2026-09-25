'use strict';

const actual = require('../../api/shared/operational-authorization');
const stations = ['MEL', 'SYD', 'BNE', 'HKG', 'SIN', 'DXB', 'KUL'];
const access = capabilities => ({
  actorReference: 'test-user',
  provisioned: true,
  stations,
  capabilities,
  globalCapabilities: [],
  capabilitiesByStation: Object.fromEntries(stations.map(station => [station, capabilities]))
});

module.exports = {
  ...actual,
  resolveActorAccess: async () => access(['VIEW_FLIGHTS', 'VIEW_HISTORY', 'VIEW_FLIGHT_STATEMENT', 'VIEW_SUPERVISOR']),
  requireOperationalStations: async (_executor, _sql, _actor, requiredCapability) => ({
    ...access([requiredCapability]), requiredCapability
  }),
  requireAnyOperationalCapability: async (_executor, _sql, _actor, requiredCapabilities) => ({
    ...access(requiredCapabilities), requiredCapability: requiredCapabilities[0]
  }),
  requireOperationalCapability: async (_executor, _sql, actor, flight, requiredCapability) => ({
    actorReference: actor.reference,
    stationCode: String(
      String(flight?.Direction || '').toUpperCase() === 'IMPORT'
        ? flight?.DestinationAirport || 'MEL'
        : flight?.OriginAirport || 'MEL'
    ).toUpperCase(),
    requiredCapability,
    capabilities: [requiredCapability]
  })
};
