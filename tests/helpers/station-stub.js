'use strict';

const actual = require('../../api/shared/station');
const codes = ['MEL', 'SYD', 'BNE', 'HKG', 'SIN', 'DXB', 'KUL', 'AKL'];

function record(code) {
  const stationCode = String(code || 'MEL').toUpperCase();
  const index = codes.indexOf(stationCode);
  return {
    stationId: String((index < 0 ? codes.length : index) + 1),
    stationCode,
    displayName: stationCode,
    timeZoneId: stationCode === 'AKL' ? 'Pacific/Auckland' : 'Australia/Melbourne'
  };
}

module.exports = {
  ...actual,
  resolveAuthorizedStation: async (_executor, _sql, access, requested) => record(requested || access?.stations?.[0]),
  resolveStationByCode: async (_executor, _sql, code) => record(code)
};
