'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  StationLocalInputError,
  resolveStationLocalInput
} = require('../api/shared/station-local-input');

const MEL = 'Australia/Melbourne';
const AKL = 'Pacific/Auckland';

function capture(input, zone) {
  try {
    return { result: resolveStationLocalInput(input, zone) };
  } catch (error) {
    return { error };
  }
}

test('ordinary station-local inputs resolve to authoritative UTC instants', () => {
  assert.equal(resolveStationLocalInput({ localDate: '2026-10-01', localTime: '18:30' }, MEL).instantUtc, '2026-10-01T08:30:00.000Z');
  assert.equal(resolveStationLocalInput({ localDate: '2026-10-01', localTime: '18:30' }, AKL).instantUtc, '2026-10-01T05:30:00.000Z');
});

test('unique MEL and AKL inputs reject EARLIER and LATER choices', () => {
  for (const zone of [MEL, AKL]) {
    for (const disambiguation of ['EARLIER', 'LATER']) {
      const { error } = capture({ localDate: '2026-10-01', localTime: '18:30', disambiguation }, zone);
      assert.ok(error instanceof StationLocalInputError);
      assert.equal(error.code, 'LOCAL_TIME_DISAMBIGUATION_INVALID');
      assert.equal(error.status, 400);
    }
  }
});

test('MEL and AKL daylight-saving gaps fail without an instant', () => {
  for (const [zone, localDate] of [[MEL, '2026-10-04'], [AKL, '2026-09-27']]) {
    const { error } = capture({ localDate, localTime: '02:30' }, zone);
    assert.ok(error instanceof StationLocalInputError);
    assert.equal(error.code, 'LOCAL_TIME_NONEXISTENT');
    assert.equal(error.status, 422);
    assert.equal(error.details.timeZoneId, zone);
    assert.equal(Object.hasOwn(error.details, 'instantUtc'), false);
  }
});

test('EARLIER or LATER cannot make a daylight-saving gap valid', () => {
  for (const [zone, localDate] of [[MEL, '2026-10-04'], [AKL, '2026-09-27']]) {
    for (const disambiguation of ['EARLIER', 'LATER']) {
      const { error } = capture({ localDate, localTime: '02:30', disambiguation }, zone);
      assert.equal(error.code, 'LOCAL_TIME_NONEXISTENT');
      assert.equal(error.status, 422);
      assert.equal(Object.hasOwn(error.details, 'instantUtc'), false);
    }
  }
});

test('MEL fold requires a choice and resolves its two distinct occurrences', () => {
  const { error } = capture({ localDate: '2026-04-05', localTime: '02:30' }, MEL);
  assert.equal(error.code, 'LOCAL_TIME_AMBIGUOUS');
  assert.equal(error.status, 409);
  assert.deepEqual(error.details.candidates.map(candidate => candidate.disambiguation), ['EARLIER', 'LATER']);
  assert.deepEqual(error.details.candidates.map(candidate => candidate.instantUtc), [
    '2026-04-04T15:30:00.000Z',
    '2026-04-04T16:30:00.000Z'
  ]);
  assert.ok(error.details.candidates.every(candidate => /02:30 .* \([+-]\d{2}:\d{2}\) - (earlier|later) occurrence/.test(candidate.label)));

  const earlier = resolveStationLocalInput({ localDate: '2026-04-05', localTime: '02:30', disambiguation: 'EARLIER' }, MEL);
  const later = resolveStationLocalInput({ localDate: '2026-04-05', localTime: '02:30', disambiguation: 'LATER' }, MEL);
  assert.equal(earlier.instantUtc, error.details.candidates[0].instantUtc);
  assert.equal(later.instantUtc, error.details.candidates[1].instantUtc);
  assert.notEqual(earlier.instantUtc, later.instantUtc);
});

test('AKL fold requires a choice and resolves its two distinct occurrences', () => {
  const { error } = capture({ localDate: '2026-04-05', localTime: '02:30' }, AKL);
  assert.equal(error.code, 'LOCAL_TIME_AMBIGUOUS');
  assert.deepEqual(error.details.candidates.map(candidate => candidate.instantUtc), [
    '2026-04-04T13:30:00.000Z',
    '2026-04-04T14:30:00.000Z'
  ]);
  assert.equal(resolveStationLocalInput({ localDate: '2026-04-05', localTime: '02:30', disambiguation: 'EARLIER' }, AKL).instantUtc, error.details.candidates[0].instantUtc);
  assert.equal(resolveStationLocalInput({ localDate: '2026-04-05', localTime: '02:30', disambiguation: 'LATER' }, AKL).instantUtc, error.details.candidates[1].instantUtc);
});

test('local input parsing and disambiguation are strict', () => {
  for (const [input, code] of [
    [{ localDate: '2026-2-01', localTime: '12:00' }, 'LOCAL_DATE_INVALID'],
    [{ localDate: '2026-02-01', localTime: '2:00' }, 'LOCAL_TIME_INVALID'],
    [{ localDate: '2026-04-05', localTime: '02:30', disambiguation: '' }, 'LOCAL_TIME_DISAMBIGUATION_INVALID'],
    [{ localDate: '2026-04-05', localTime: '02:30', disambiguation: 'earlier' }, 'LOCAL_TIME_DISAMBIGUATION_INVALID'],
    [{ localDate: '2026-04-05', localTime: '02:30', disambiguation: ' LATER ' }, 'LOCAL_TIME_DISAMBIGUATION_INVALID']
  ]) {
    assert.equal(capture(input, MEL).error.code, code);
  }
});

test('client candidate UTC is never authoritative and cross-midnight dates are retained', () => {
  const malicious = resolveStationLocalInput({
    localDate: '2026-04-05',
    localTime: '02:30',
    disambiguation: 'EARLIER',
    instantUtc: '1999-01-01T00:00:00.000Z'
  }, AKL);
  assert.equal(malicious.instantUtc, '2026-04-04T13:30:00.000Z');

  const dayTwo = resolveStationLocalInput({ localDate: '2026-10-02', localTime: '00:15' }, AKL);
  assert.equal(dayTwo.localDate, '2026-10-02');
  assert.equal(dayTwo.instantUtc, '2026-10-01T11:15:00.000Z');
});
