'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, sha256, amendmentEnvelope } = require('../api/shared/completion-amendments');

test('canonical JSON sorts object keys recursively while preserving array order', () => {
  const left = { z: 1, a: { y: true, x: ['second', 'first'] }, nullable: null };
  const right = { nullable: null, a: { x: ['second', 'first'], y: true }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalJson(left), '{"a":{"x":["second","first"],"y":true},"nullable":null,"z":1}');
});

test('V1 hash is over exact stored bytes and changes after parse/reserialize', () => {
  const raw = '{ "flight": "CX178", "ulds": ["AKE12345CX"] }';
  assert.equal(sha256(raw), crypto.createHash('sha256').update(raw, 'utf8').digest('hex'));
  assert.notEqual(sha256(raw), sha256(JSON.stringify(JSON.parse(raw))));
});

test('amendment hash envelope excludes RecordHash and is deterministic', () => {
  const row = {
    ExportCompletionRecordId: '30', FlightId: '1', VersionNumber: 2,
    PreviousHash: 'a'.repeat(64), RecordHash: 'ignored', VerificationId: 'verify', OperationId: 'operation',
    Action: 'OFFLOAD_REQUESTED', PreviousStatus: null, ResultingStatus: 'REQUESTED', Reason: null,
    RelatedOffloadId: '90', RelatedUldId: '7',
    ActorProvider: 'aad', ActorReference: 'actor', ActorDisplayName: 'Operator', OccurredAtIso: '2026-09-18T01:02:03.004Z'
  };
  const snapshot = { ulds: ['AKE12345CX'], offloads: { records: [{ status: 'REQUESTED' }] } };
  const first = sha256(canonicalJson(amendmentEnvelope(row, snapshot)));
  row.RecordHash = 'different ignored value';
  assert.equal(sha256(canonicalJson(amendmentEnvelope(row, snapshot))), first);
});

test('migration provides immutable versioned storage with stable identity and action status metadata', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'export-completion-amendments.sql'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, '..', 'api', 'shared', 'completion-amendments.js'), 'utf8');
  assert.match(sql, /CREATE TABLE dbo\.ExportCompletionAmendments/);
  assert.match(sql, /PreviousStatus nvarchar\(30\) NULL/);
  assert.match(sql, /ResultingStatus nvarchar\(30\) NOT NULL/);
  assert.match(sql, /CK_ExportCompletionAmendments_OffloadTransition/);
  assert.match(sql, /UQ_ExportCompletionRecords_Flight\s+UNIQUE NONCLUSTERED \(FlightId\)/);
  assert.match(sql, /UNIQUE \(ExportCompletionRecordId,VersionNumber\)/);
  assert.match(sql, /FOREIGN KEY \(FlightId,RelatedOffloadId\)/);
  assert.match(sql, /FOREIGN KEY \(FlightId,RelatedUldId\)/);
  assert.match(sql, /INSTEAD OF UPDATE, DELETE/);
  assert.match(helper, /INSERT INTO dbo\.ExportCompletionAmendments/);
  assert.doesNotMatch(helper, /INSERT INTO dbo\.AuditEvents/);
});
