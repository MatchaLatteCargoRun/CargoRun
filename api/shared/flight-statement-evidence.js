'use strict';

const { normalizeUldNumber } = require('./uld');

function xmlText(xml, tag) {
  const match = String(xml || '').match(new RegExp(
    `<(?:(?:\\w+):)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${tag}>`,
    'i'
  ));
  return match
    ? String(match[1]).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim()
    : '';
}

function xmlBlocks(xml, tag) {
  const expression = new RegExp(
    `<(?:(?:\\w+):)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${tag}>`,
    'gi'
  );
  const blocks = [];
  let match;
  while ((match = expression.exec(String(xml || ''))) !== null) blocks.push(match[1]);
  return blocks;
}

function uldNumbersFromRawXml(xml) {
  const numbers = [];
  for (const block of xmlBlocks(xml, 'FSUMessageULDList')) {
    const type = xmlText(block, 'ULDTyp');
    const serial = xmlText(block, 'ULDSrl');
    const owner = xmlText(block, 'ULDOwnr');
    const number = type && serial && owner ? normalizeUldNumber(`${type}${serial}${owner}`) : null;
    if (number) numbers.push(number);
  }
  return [...new Set(numbers)].sort();
}

function text(value) {
  return value == null ? null : String(value);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventTime(event) {
  return String(event.occurredAtUtc || '');
}

function stableEventKey(event) {
  return event.eventType === 'EXPORT_MANIFEST_FINAL_CONFIRMED'
    ? `FINAL:${event.finalManifestId || ''}`
    : `FOW:${event.documentCorId || ''}:${event.machMessageId || ''}`;
}

function compareTimelineEvents(left, right) {
  return eventTime(left).localeCompare(eventTime(right)) || stableEventKey(left).localeCompare(stableEventKey(right));
}

function finalEvidence(row) {
  if (!row) return null;
  return {
    status: 'FINAL',
    finalManifestId: text(row.FinalManifestId),
    confirmedAtUtc: text(row.ConfirmedAtIso || row.ConfirmedAtUtc),
    confirmedByObjectId: text(row.ConfirmedByObjectId),
    confirmedByDisplayName: text(row.ConfirmedByDisplayName) || '',
    finalUldCount: number(row.FinalUldCount),
    reconciliation: {
      matchedCount: number(row.MatchedCount),
      addedCount: number(row.AddedCount),
      excludedCount: number(row.ExcludedCount)
    },
    manifestHash: text(row.ManifestHash),
    sourceFileName: text(row.SourceFileName)
  };
}

function fowEvents(rows) {
  const messages = new Map();
  for (const row of rows || []) {
    const machMessageId = text(row.MachMessageId);
    if (!machMessageId) continue;
    let message = messages.get(machMessageId);
    if (!message) {
      const ignored = String(row.ProcessingStatus || '').toUpperCase() === 'PROCESSED_POST_FINAL';
      message = {
        eventType: 'FOW_RECEIVED',
        machMessageId,
        documentCorId: text(row.DocumentCorID),
        occurredAtUtc: text(row.ReceivedAtIso || row.ReceivedAtUtc),
        messageLocalDateTime: text(row.EventLocalIso || row.EventLocalDateTime),
        processingStatus: text(row.ProcessingStatus),
        receivedAfterFinal: ignored,
        ignoredAfterFinal: ignored,
        manifestChanged: ignored ? false : null,
        operationalStatusChanged: ignored ? false : null,
        uldNumbers: [],
        _rawXml: row.RawXml || ''
      };
      messages.set(machMessageId, message);
    }
    const linked = normalizeUldNumber(row.UldNumber);
    if (linked) message.uldNumbers.push(linked);
  }

  return [...messages.values()].map(message => {
    const uldNumbers = [...new Set([
      ...message.uldNumbers,
      ...uldNumbersFromRawXml(message._rawXml)
    ])].sort();
    const { _rawXml, ...evidence } = message;
    return { ...evidence, uldNumbers };
  });
}

function buildFlightStatementEvidence(manifestRow, messageRows) {
  const exportManifestFinal = finalEvidence(manifestRow);
  const events = fowEvents(messageRows);
  if (exportManifestFinal) {
    events.push({
      eventType: 'EXPORT_MANIFEST_FINAL_CONFIRMED',
      finalManifestId: exportManifestFinal.finalManifestId,
      occurredAtUtc: exportManifestFinal.confirmedAtUtc,
      confirmedByObjectId: exportManifestFinal.confirmedByObjectId,
      confirmedByDisplayName: exportManifestFinal.confirmedByDisplayName,
      finalUldCount: exportManifestFinal.finalUldCount
    });
  }
  events.sort(compareTimelineEvents);
  return {
    exportManifestFinal,
    fowTimeline: events.length ? {
      source: 'dbo.IncomingMachMessages + dbo.MachFowShipments',
      events
    } : null
  };
}

function applyFlightStatementEvidence(snapshot, evidence) {
  const result = { ...(snapshot || {}) };
  delete result.exportManifestFinal;
  delete result.fowTimeline;
  if (evidence?.exportManifestFinal) result.exportManifestFinal = evidence.exportManifestFinal;
  if (evidence?.fowTimeline) result.fowTimeline = evidence.fowTimeline;
  return result;
}

async function loadFlightStatementEvidence(transaction, sql, flightId) {
  const manifestResult = await new sql.Request(transaction)
    .input('EvidenceManifestFlightId', sql.BigInt, flightId)
    .query(`SELECT CONVERT(varchar(20),FinalManifestId) AS FinalManifestId,
        CONVERT(varchar(33),ConfirmedAtUtc,126)+'Z' AS ConfirmedAtIso,
        ConfirmedByObjectId,ConfirmedByDisplayName,FinalUldCount,
        MatchedCount,AddedCount,ExcludedCount,ManifestHash,SourceFileName
      FROM dbo.ExportManifestFinals WITH (HOLDLOCK)
      WHERE FlightId=@EvidenceManifestFlightId;`);

  const messagesResult = await new sql.Request(transaction)
    .input('EvidenceFowFlightId', sql.BigInt, flightId)
    .query(`SELECT CONVERT(varchar(20),m.MachMessageId) AS MachMessageId,
        m.DocumentCorID,
        CONVERT(varchar(33),m.ReceivedAtUtc,126)+'Z' AS ReceivedAtIso,
        CASE WHEN m.EventLocalDateTime IS NULL THEN NULL
          ELSE CONVERT(varchar(33),m.EventLocalDateTime,126) END AS EventLocalIso,
        m.ProcessingStatus,m.RawXml,s.UldNumber
      FROM dbo.IncomingMachMessages m WITH (HOLDLOCK)
      LEFT JOIN dbo.MachFowShipments s WITH (HOLDLOCK)
        ON s.MachMessageId=m.MachMessageId AND s.FlightId=m.MatchedFlightId
      WHERE m.MatchedFlightId=@EvidenceFowFlightId
      ORDER BY m.ReceivedAtUtc,m.MachMessageId,s.UldNumber;`);

  return buildFlightStatementEvidence(manifestResult.recordset[0] || null, messagesResult.recordset || []);
}

module.exports = {
  uldNumbersFromRawXml,
  compareTimelineEvents,
  buildFlightStatementEvidence,
  applyFlightStatementEvidence,
  loadFlightStatementEvidence
};
