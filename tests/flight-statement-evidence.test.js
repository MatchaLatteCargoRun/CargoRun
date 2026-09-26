'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('../api/shared/completion-amendments');
const {
  uldNumbersFromRawXml,
  buildFlightStatementEvidence,
  applyFlightStatementEvidence,
  loadFlightStatementEvidence
} = require('../api/shared/flight-statement-evidence');

const finalRow = {
  FinalManifestId: '81', ConfirmedAtIso: '2026-09-19T08:51:00.000Z',
  ConfirmedByObjectId: 'aad-operator-1', ConfirmedByDisplayName: 'maxwelljohnfuller@gmail.com',
  FinalUldCount: 4, MatchedCount: 3, AddedCount: 1, ExcludedCount: 2,
  ManifestHash: 'a'.repeat(64), SourceFileName: 'QR0905.xlsx'
};

function rawUld(type, serial, owner) {
  return `<FSUMessage><FSUMessageULDList><ULDTyp>${type}</ULDTyp><ULDSrl>${serial}</ULDSrl><ULDOwnr>${owner}</ULDOwnr></FSUMessageULDList></FSUMessage>`;
}

const fowRows = [
  {
    MachMessageId: '103', DocumentCorID: 'DOC-POST', ReceivedAtIso: '2026-09-19T08:55:00.000Z',
    EventLocalIso: '2026-09-19T18:54:00', ProcessingStatus: 'PROCESSED_POST_FINAL',
    RawXml: rawUld('PMC', '77777', 'QR'), UldNumber: null
  },
  {
    MachMessageId: '101', DocumentCorID: 'DOC-PRE', ReceivedAtIso: '2026-09-19T08:12:00.000Z',
    EventLocalIso: '2026-09-19T18:10:00', ProcessingStatus: 'PROCESSED',
    RawXml: rawUld('PMC', '73805', 'QR'), UldNumber: 'PMC73805QR'
  },
  {
    MachMessageId: '102', DocumentCorID: 'DOC-PRE-2', ReceivedAtIso: '2026-09-19T08:14:00.000Z',
    ProcessingStatus: 'PROCESSED', RawXml: rawUld('PMC', '99999', 'QR'), UldNumber: 'PMC99999QR'
  }
];

test('raw MACH evidence yields canonical ULD numbers without changing canonical identity rules', () => {
  assert.deepEqual(uldNumbersFromRawXml(rawUld('ake', '12-345', 'cx')), ['AKE12345CX']);
});

test('authoritative FINAL metadata and every exact-flight FOW form one deterministic timeline', () => {
  const evidence = buildFlightStatementEvidence(finalRow, fowRows);
  assert.deepEqual(evidence.exportManifestFinal, {
    status: 'FINAL', finalManifestId: '81', confirmedAtUtc: '2026-09-19T08:51:00.000Z',
    confirmedByObjectId: 'aad-operator-1', confirmedByDisplayName: 'maxwelljohnfuller@gmail.com',
    finalUldCount: 4,
    reconciliation: { matchedCount: 3, addedCount: 1, excludedCount: 2 },
    manifestHash: 'a'.repeat(64), sourceFileName: 'QR0905.xlsx'
  });
  assert.deepEqual(evidence.fowTimeline.events.map(event => event.eventType), [
    'FOW_RECEIVED', 'FOW_RECEIVED', 'EXPORT_MANIFEST_FINAL_CONFIRMED', 'FOW_RECEIVED'
  ]);
  assert.deepEqual(evidence.fowTimeline.events.map(event => event.occurredAtUtc), [
    '2026-09-19T08:12:00.000Z', '2026-09-19T08:14:00.000Z',
    '2026-09-19T08:51:00.000Z', '2026-09-19T08:55:00.000Z'
  ]);
});

test('post-FINAL FOW is retained as ignored evidence and never changes snapshot ULD membership or status', () => {
  const original = {
    flight: 'QR0905', flightId: '25',
    ulds: [{ num: 'PMC73805QR', status: 'At Aircraft', isFinalManifestMember: true }]
  };
  const before = structuredClone(original);
  const snapshot = applyFlightStatementEvidence(original, buildFlightStatementEvidence(finalRow, fowRows));
  const ignored = snapshot.fowTimeline.events.find(event => event.ignoredAfterFinal);
  assert.deepEqual(ignored.uldNumbers, ['PMC77777QR']);
  assert.equal(ignored.manifestChanged, false);
  assert.equal(ignored.operationalStatusChanged, false);
  assert.deepEqual(snapshot.ulds, before.ulds);
  assert.equal(snapshot.ulds.some(uld => uld.num === 'PMC77777QR'), false);
  assert.deepEqual(original, before);
});

test('new snapshot evidence and V1 hash are deterministic across unordered FOW query rows', () => {
  const left = applyFlightStatementEvidence({ flight: 'QR0905', flightId: '25', ulds: [] }, buildFlightStatementEvidence(finalRow, fowRows));
  const right = applyFlightStatementEvidence({ flight: 'QR0905', flightId: '25', ulds: [] }, buildFlightStatementEvidence(finalRow, [...fowRows].reverse()));
  assert.equal(JSON.stringify(left), JSON.stringify(right));
  assert.equal(sha256(JSON.stringify(left)), sha256(JSON.stringify(right)));
});

test('flight without FINAL or FOW evidence remains clean and client evidence cannot be spoofed', () => {
  const snapshot = applyFlightStatementEvidence({
    flight: 'QR0905', ulds: [],
    exportManifestFinal: { status: 'FINAL', finalUldCount: 999 },
    fowTimeline: { events: [{ eventType: 'CLIENT_VALUE' }] }
  }, buildFlightStatementEvidence(null, []));
  assert.equal(snapshot.exportManifestFinal, undefined);
  assert.equal(snapshot.fowTimeline, undefined);
});

test('flight without FOW messages retains only the authoritative FINAL confirmation timeline event', () => {
  const evidence = buildFlightStatementEvidence(finalRow, []);
  assert.equal(evidence.fowTimeline.events.length, 1);
  assert.equal(evidence.fowTimeline.events[0].eventType, 'EXPORT_MANIFEST_FINAL_CONFIRMED');
  assert.equal(evidence.fowTimeline.events[0].occurredAtUtc, finalRow.ConfirmedAtIso);
});

test('completion capture queries FOW evidence only by exact FlightId and does not mutate source tables', () => {
  const root = path.resolve(__dirname, '..');
  const helper = fs.readFileSync(path.join(root, 'api', 'shared', 'flight-statement-evidence.js'), 'utf8');
  const completion = fs.readFileSync(path.join(root, 'api', 'export-completions', 'index.js'), 'utf8');
  assert.match(helper, /WHERE m\.MatchedFlightId=@EvidenceFowFlightId/);
  assert.doesNotMatch(helper, /WHERE m\.FlightNumber|UPDATE dbo\.(?:IncomingMachMessages|MachFowShipments|ExportManifestFinals)/i);
  assert.match(completion, /loadFlightStatementEvidence\(tx,sql,flightId\)/);
  assert.match(completion, /acquireFlightIdentityLock\(tx,sql,flightAuthorization\.stationId,flight\.OperatingDateIso,flight\.FlightNumber\)/);
});

test('same visible flight number on another date cannot leak FOW evidence across FlightId', async () => {
  const messages = [
    { FlightId: '25', MachMessageId: '101', DocumentCorID: 'RIGHT-DATE', ReceivedAtIso: '2026-09-19T08:12:00.000Z', ProcessingStatus: 'PROCESSED', RawXml: rawUld('PMC', '73805', 'QR') },
    { FlightId: '26', MachMessageId: '201', DocumentCorID: 'WRONG-DATE', ReceivedAtIso: '2026-09-20T08:12:00.000Z', ProcessingStatus: 'PROCESSED', RawXml: rawUld('PMC', '99999', 'QR') }
  ];
  class Request {
    constructor() { this.values = {}; }
    input(name, type, value) { this.values[name] = value; return this; }
    async query(query) {
      if (query.includes('FROM dbo.ExportManifestFinals')) return { recordset: [finalRow] };
      return { recordset: messages.filter(row => String(row.FlightId) === String(this.values.EvidenceFowFlightId)) };
    }
  }
  const sql = { Request, BigInt: Symbol('BigInt') };
  const evidence = await loadFlightStatementEvidence({}, sql, '25');
  const documents = evidence.fowTimeline.events.map(event => event.documentCorId).filter(Boolean);
  assert.deepEqual(documents, ['RIGHT-DATE']);
  assert.equal(JSON.stringify(evidence).includes('WRONG-DATE'), false);
});
