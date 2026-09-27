'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  StationTimeError,
  normalizeTimeZone,
  stationDateKey,
  formatInstantInStation,
  utcBoundsForStationDate,
  resolveStationLocalDateTime
} = require('../api/shared/station-time');

const MEL = 'Australia/Melbourne';
const AKL = 'Pacific/Auckland';

test('one UTC instant can belong to different MEL and AKL service dates', () => {
  const instant = '2026-01-01T11:30:00Z';
  assert.equal(stationDateKey(instant, MEL), '2026-01-01');
  assert.equal(stationDateKey(instant, AKL), '2026-01-02');
});

test('formatInstantInStation returns deterministic structured station data and accurate offsets', () => {
  assert.deepEqual(formatInstantInStation('2026-01-01T01:30:45Z', MEL), {
    dateKey: '2026-01-01', localDate: '01/01/2026', localTime: '12:30',
    localDateTime: '01/01/2026 12:30', timeZoneId: MEL, offset: '+11:00'
  });
  assert.equal(formatInstantInStation('2026-07-01T02:30:45Z', MEL, { includeSeconds: true }).offset, '+10:00');
  assert.equal(formatInstantInStation('2026-01-01T01:30:45Z', AKL).offset, '+13:00');
  assert.equal(formatInstantInStation('2026-07-01T02:30:45Z', AKL).offset, '+12:00');
  assert.equal(formatInstantInStation('2026-07-01T02:30:45Z', MEL, { includeSeconds: true }).localTime, '12:30:45');
});

test('MEL DST start rejects the gap and produces a 23-hour station day', () => {
  assert.deepEqual(resolveStationLocalDateTime('2026-10-04', '02:30', MEL), {
    status: 'NONEXISTENT', candidates: [], timeZoneId: MEL, localDate: '2026-10-04', localTime: '02:30'
  });
  assert.deepEqual(utcBoundsForStationDate('2026-10-04', MEL), {
    startUtc: '2026-10-03T14:00:00.000Z', endUtc: '2026-10-04T13:00:00.000Z', durationHours: 23
  });
});

test('MEL DST end exposes both candidates and resolves only explicit choices', () => {
  const result = resolveStationLocalDateTime('2026-04-05', '02:30', MEL);
  assert.equal(result.status, 'AMBIGUOUS');
  assert.deepEqual(result.candidates, [
    { instantUtc: '2026-04-04T15:30:00.000Z', offset: '+11:00', disambiguation: 'EARLIER' },
    { instantUtc: '2026-04-04T16:30:00.000Z', offset: '+10:00', disambiguation: 'LATER' }
  ]);
  assert.deepEqual(resolveStationLocalDateTime('2026-04-05', '02:30', MEL, 'EARLIER'), {
    status: 'RESOLVED', instantUtc: result.candidates[0].instantUtc, offset: '+11:00',
    timeZoneId: MEL, localDate: '2026-04-05', localTime: '02:30', disambiguation: 'EARLIER'
  });
  assert.equal(resolveStationLocalDateTime('2026-04-05', '02:30', MEL, 'later').instantUtc, result.candidates[1].instantUtc);
  assert.equal(utcBoundsForStationDate('2026-04-05', MEL).durationHours, 25);
});

test('AKL DST start rejects the gap and produces a 23-hour station day', () => {
  assert.equal(resolveStationLocalDateTime('2026-09-27', '02:30', AKL).status, 'NONEXISTENT');
  assert.deepEqual(utcBoundsForStationDate('2026-09-27', AKL), {
    startUtc: '2026-09-26T12:00:00.000Z', endUtc: '2026-09-27T11:00:00.000Z', durationHours: 23
  });
});

test('AKL DST end exposes two candidates and produces a 25-hour station day', () => {
  const result = resolveStationLocalDateTime('2026-04-05', '02:30', AKL);
  assert.equal(result.status, 'AMBIGUOUS');
  assert.deepEqual(result.candidates, [
    { instantUtc: '2026-04-04T13:30:00.000Z', offset: '+13:00', disambiguation: 'EARLIER' },
    { instantUtc: '2026-04-04T14:30:00.000Z', offset: '+12:00', disambiguation: 'LATER' }
  ]);
  assert.notEqual(result.candidates[0].instantUtc, result.candidates[1].instantUtc);
  assert.equal(resolveStationLocalDateTime('2026-04-05', '02:30', AKL, 'LATER').instantUtc, result.candidates[1].instantUtc);
  assert.equal(utcBoundsForStationDate('2026-04-05', AKL).durationHours, 25);
});

test('normal midnight, noon, and end-of-day wall clocks resolve uniquely in MEL and AKL', () => {
  for (const zone of [MEL, AKL]) {
    for (const time of ['00:00', '12:00', '23:59', '12:34:56']) {
      const result = resolveStationLocalDateTime('2026-07-15', time, zone);
      assert.equal(result.status, 'UNIQUE', `${zone} ${time}`);
      assert.equal(stationDateKey(result.instantUtc, zone), '2026-07-15', `${zone} ${time}`);
    }
  }
  assert.equal(utcBoundsForStationDate('2026-07-15', MEL).durationHours, 24);
  assert.equal(utcBoundsForStationDate('2026-07-15', AKL).durationHours, 24);
});

test('station conversion crosses midnight independently for MEL and AKL', () => {
  const instant = '2026-01-01T11:30:00.000Z';
  assert.equal(formatInstantInStation(instant, MEL).localDateTime, '01/01/2026 22:30');
  assert.equal(formatInstantInStation(instant, AKL).localDateTime, '02/01/2026 00:30');
});

test('results do not depend on the Node process timezone', () => {
  const modulePath = path.resolve(__dirname, '../api/shared/station-time.js');
  const script = `const t=require(${JSON.stringify(modulePath)});process.stdout.write(JSON.stringify({date:t.stationDateKey('2026-01-01T11:30:00Z','Pacific/Auckland'),bounds:t.utcBoundsForStationDate('2026-04-05','Australia/Melbourne'),fold:t.resolveStationLocalDateTime('2026-04-05','02:30','Pacific/Auckland')}));`;
  const outputs = ['UTC', MEL, AKL, 'America/Los_Angeles'].map(timeZone => {
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', env: { ...process.env, TZ: timeZone }
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  });
  assert.equal(new Set(outputs).size, 1);
});

test('strict validation rejects malformed dates, times, zones, instants, and options', () => {
  const invalidDates = ['2026-02-30', '2026-13-01', '2026-00-01', '', null, undefined, 20260101];
  for (const value of invalidDates) {
    assert.throws(() => resolveStationLocalDateTime(value, '12:00', MEL), StationTimeError);
  }
  const invalidTimes = ['25:00', '24:00', '12:60', '12:30:60', '2:30', '', null, undefined, 1230];
  for (const value of invalidTimes) {
    assert.throws(() => resolveStationLocalDateTime('2026-01-01', value, MEL), StationTimeError);
  }
  for (const value of ['', ' ', '+10:00', 'Etc/GMT-10', 'Mars/Olympus_Mons', null, undefined, 10]) {
    assert.throws(() => stationDateKey('2026-01-01T00:00:00Z', value), StationTimeError);
  }
  for (const value of ['', '2026-02-30T00:00:00Z', '2026-01-01', '2026-01-01T00:00:00', null, undefined, NaN]) {
    assert.throws(() => stationDateKey(value, MEL), StationTimeError);
  }
  assert.throws(() => resolveStationLocalDateTime('2026-04-05', '02:30', MEL, 'COMPATIBLE'), StationTimeError);
  assert.throws(() => formatInstantInStation('2026-01-01T00:00:00Z', MEL, { includeSeconds: 'yes' }), StationTimeError);
});

test('timezone validation preserves named IANA zones and rejects blank, invalid, and fixed-offset forms', () => {
  for (const value of [MEL, AKL, 'UTC', 'America/Los_Angeles']) {
    assert.equal(normalizeTimeZone(value), value);
  }
  for (const value of ['', ' ', 'Mars/Olympus', '+10:00', '-04:30', 'Etc/GMT', 'Etc/GMT+4', null, undefined]) {
    assert.throws(() => normalizeTimeZone(value), StationTimeError, String(value));
  }
});
