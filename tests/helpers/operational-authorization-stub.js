'use strict';

const actual = require('../../api/shared/operational-authorization');

module.exports = {
  ...actual,
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
