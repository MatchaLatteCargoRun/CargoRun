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
    CompletionId: '30', FlightId: '1', VersionNumber: 2,
    PreviousHash: 'a'.repeat(64), RecordHash: 'ignored', VerificationId: 'verify', OperationId: 'operation',
    Action: 'OFFLOAD_REQUESTED', PreviousStatus: null, ResultingStatus: 'REQUESTED', Reason: null,
    RelatedOffloadId: '90', RelatedUldId: '7',
    ActorProvider: 'aad', ActorReference: 'actor', ActorDisplayName: 'Operator', OccurredAtIso: '2026-09-18T01:02:03.004Z'
  };
  const snapshot = { ulds: ['AKE12345CX'], offloads: { records: [{ status: 'REQUESTED' }] } };
  const first = sha256(canonicalJson(amendmentEnvelope(row, snapshot)));
  assert.equal(amendmentEnvelope(row,snapshot).exportCompletionRecordId,'30');
  row.RecordHash = 'different ignored value';
  assert.equal(sha256(canonicalJson(amendmentEnvelope(row, snapshot))), first);
});

test('V2 amendment verification preserves immutable FINAL and FOW evidence from V1', () => {
  const v1Snapshot = {
    flight: 'QR0905', flightId: '25', ulds: [],
    exportManifestFinal: {
      status: 'FINAL', finalManifestId: '81', confirmedAtUtc: '2026-09-19T08:51:00.000Z',
      confirmedByDisplayName: 'Final Operator', finalUldCount: 4
    },
    fowTimeline: { events: [{ eventType: 'FOW_RECEIVED', documentCorId: 'DOC-1', occurredAtUtc: '2026-09-19T08:12:00.000Z' }] }
  };
  const v1Json = JSON.stringify(v1Snapshot);
  const base = { CompletionId: '30', FlightId: '25', SnapshotJson: v1Json, RecordHash: sha256(v1Json) };
  const v2Snapshot = { ...v1Snapshot, offloads: { records: [{ offloadId: '9', status: 'REQUESTED' }] } };
  const amendment = {
    CompletionId: '30', FlightId: '25', VersionNumber: 2, PreviousHash: base.RecordHash,
    VerificationId: 'verify-2', OperationId: 'operation-2', Action: 'OFFLOAD_REQUESTED',
    PreviousStatus: null, ResultingStatus: 'REQUESTED', Reason: null,
    RelatedOffloadId: '9', RelatedUldId: '77', ActorProvider: 'aad',
    ActorReference: 'operator-2', ActorDisplayName: 'Operator Two',
    OccurredAtIso: '2026-09-19T09:00:00.000Z', SnapshotJson: canonicalJson(v2Snapshot)
  };
  amendment.RecordHash = sha256(canonicalJson(amendmentEnvelope(amendment, v2Snapshot)));
  const { verifyCompletionEvidence } = require('../api/shared/completion-amendments');
  const evidence = verifyCompletionEvidence(base, [amendment], '25');
  assert.deepEqual(evidence.latestSnapshot.exportManifestFinal, v1Snapshot.exportManifestFinal);
  assert.deepEqual(evidence.latestSnapshot.fowTimeline, v1Snapshot.fowTimeline);
});

test('migration provides immutable versioned storage with stable identity and action status metadata', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'export-completion-amendments.sql'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, '..', 'api', 'shared', 'completion-amendments.js'), 'utf8');
  assert.match(sql, /CREATE TABLE dbo\.ExportCompletionAmendments/);
  assert.match(sql, /PreviousStatus nvarchar\(30\) NULL/);
  assert.match(sql, /ResultingStatus nvarchar\(30\) NOT NULL/);
  assert.match(sql, /CK_ExportCompletionAmendments_OffloadTransition/);
  assert.match(sql, /UQ_ExportCompletionRecords_Flight\s+UNIQUE NONCLUSTERED \(FlightId\)/);
  assert.match(sql, /CompletionId bigint NOT NULL/);
  assert.match(sql, /UNIQUE \(CompletionId,VersionNumber\)/);
  assert.match(sql, /FOREIGN KEY \(FlightId,CompletionId\)\s+REFERENCES dbo\.ExportCompletionRecords\(FlightId,CompletionId\)/);
  assert.doesNotMatch(sql, /ExportCompletionRecordId/);
  assert.match(sql, /FOREIGN KEY \(FlightId,RelatedOffloadId\)/);
  assert.match(sql, /FOREIGN KEY \(FlightId,RelatedUldId\)/);
  assert.doesNotMatch(sql,/ON DELETE CASCADE/i);
  assert.match(sql, /INSTEAD OF UPDATE, DELETE/);
  assert.match(helper, /INSERT INTO dbo\.ExportCompletionAmendments/);
  assert.doesNotMatch(helper, /INSERT INTO dbo\.AuditEvents/);
  assert.match(helper, /FROM dbo\.ExportCompletionRecords WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(helper, /CONVERT\(varchar\(20\), CompletionId\) AS CompletionId/);
  assert.match(helper, /\.input\('CompletionBaseId', sql\.BigInt, base\.CompletionId\)/);
});

test('live preflight extracts V1 evidence by authoritative CompletionId',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'..','migrations','live-amendment-preflight.sql'),'utf8');
  const runner=fs.readFileSync(path.join(__dirname,'..','scripts','run-live-amendment-preflight.ps1'),'utf8');
  const api=fs.readFileSync(path.join(__dirname,'..','api','export-completions','index.js'),'utf8');
  assert.match(sql,/COL_LENGTH\(N'dbo\.ExportCompletionRecords', N'CompletionId'\) IS NOT NULL/);
  assert.match(sql,/CONVERT\(varchar\(20\), CompletionId\) AS CompletionId/);
  assert.match(sql,/SnapshotJson AS SnapshotJsonForOfflineVerification/);
  assert.doesNotMatch(sql,/ExportCompletionRecordId/);
  assert.match(runner,/UTF8Encoding\]::new\(\$false, \$true\)/);
  assert.match(runner,/SHA256\]::Create\(\)/);
  assert.match(runner,/\$row\.Remove\('SnapshotJsonForOfflineVerification'\)/);
  assert.match(runner,/CompletionId = \$row\['CompletionId'\]/);
  assert.match(api,/get\(\['CompletionId','ExportCompletionRecordId','CompletionRecordId','Id'\]\)/);
});
