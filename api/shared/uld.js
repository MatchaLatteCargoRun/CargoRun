'use strict';

// Empty output means invalid/missing input. Callers must reject it on writes.
// Do not coerce, truncate, strip other punctuation, or parse the serial as a number.
function normalizeUldNumber(value) {
  return typeof value === 'string'
    ? value.trim().toUpperCase().replace(/[\s-]/g, '')
    : '';
}

module.exports = { normalizeUldNumber };
