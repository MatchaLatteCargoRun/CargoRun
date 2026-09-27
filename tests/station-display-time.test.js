'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function sourceBetween(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source range ${start} -> ${end}`);
  return html.slice(from, to);
}

function functionLine(name) {
  const start = html.indexOf(`function ${name}(`), end = html.indexOf('\n', start);
  assert.ok(start >= 0 && end > start, `${name} should exist`);
  return html.slice(start, end);
}

function formatterSource() {
  return [
    sourceBetween('function validStationTimeZoneId(', 'function normalizeAuthorizedStations('),
    functionLine('stationDateKeyForTimeZone')
  ].join('\n');
}

function formatterHarness() {
  const context = vm.createContext({ Intl, Date, Number, Object });
  vm.runInContext(formatterSource(), context);
  return context;
}

test('explicit station formatters render MEL and AKL on their own calendar dates', () => {
  const h = formatterHarness();
  const instant = '2026-01-01T11:30:00.000Z';

  assert.equal(h.stationDateKeyForTimeZone(instant, 'Australia/Melbourne'), '2026-01-01');
  assert.equal(h.stationDateKeyForTimeZone(instant, 'Pacific/Auckland'), '2026-01-02');
  assert.equal(h.formatStationDateTime(instant, 'Australia/Melbourne'), '01 Jan 2026 22:30 AEDT');
  assert.equal(h.formatStationDateTime(instant, 'Pacific/Auckland'), '02 Jan 2026 00:30 NZDT');
  assert.equal(h.formatStationDate(instant, 'Australia/Melbourne'), '01 Jan 2026');
  assert.equal(h.formatStationDate(instant, 'Pacific/Auckland'), '02 Jan 2026');
});

test('explicit station display output is independent of the browser or process timezone', () => {
  const script = `${formatterSource()}\nprocess.stdout.write(JSON.stringify({
    mel:formatStationDateTime('2026-01-01T11:30:00.000Z','Australia/Melbourne'),
    akl:formatStationDateTime('2026-01-01T11:30:00.000Z','Pacific/Auckland'),
    aklDate:stationDateKeyForTimeZone('2026-01-01T11:30:00.000Z','Pacific/Auckland')
  }));`;
  const outputs = ['UTC', 'Australia/Melbourne', 'Pacific/Auckland', 'America/Los_Angeles'].map(timeZone => {
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', env: { ...process.env, TZ: timeZone }
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  });

  assert.equal(new Set(outputs).size, 1);
  assert.deepEqual(JSON.parse(outputs[0]), {
    mel: '01 Jan 2026 22:30 AEDT',
    akl: '02 Jan 2026 00:30 NZDT',
    aklDate: '2026-01-02'
  });
});

test('DST repeated wall clocks remain distinguishable by timezone abbreviation', () => {
  const h = formatterHarness();
  const first = h.formatStationDateTime('2026-04-04T15:30:00.000Z', 'Australia/Melbourne');
  const second = h.formatStationDateTime('2026-04-04T16:30:00.000Z', 'Australia/Melbourne');

  assert.equal(first, '05 Apr 2026 02:30 AEDT');
  assert.equal(second, '05 Apr 2026 02:30 AEST');
  assert.notEqual(first, second);
});

test('missing, invalid, fixed-offset and unzoned inputs fail closed without a hidden fallback', () => {
  const h = formatterHarness();
  const instant = '2026-01-01T11:30:00.000Z';

  for (const timeZoneId of ['', null, 'Australia/Melbourne ', '+11:00', 'Etc/GMT-11', 'Invalid/Zone']) {
    assert.equal(h.formatStationDateTime(instant, timeZoneId), '\u2014');
    assert.equal(h.stationDateKeyForTimeZone(instant, timeZoneId), '');
  }
  assert.equal(h.formatStationDateTime('2026-01-01T11:30:00', 'Australia/Melbourne'), '\u2014');
  assert.equal(h.stationDateKeyForTimeZone('2026-01-01T11:30:00', 'Australia/Melbourne'), '');

  for (const name of ['fmtTime', 'fmtDateTime']) {
    const source = functionLine(name);
    assert.match(source, /selectedStationTimeZone\(\)/);
    assert.doesNotMatch(source, /Australia\/Melbourne|toLocale|new Date/);
  }
});
