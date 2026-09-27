'use strict';

const {
  StationTimeError,
  resolveStationLocalDateTime
} = require('./station-time');

class StationLocalInputError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'StationLocalInputError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function localInputError(error) {
  if (!(error instanceof StationTimeError)) return error;
  const code = error.code === 'DISAMBIGUATION_INVALID'
    ? 'LOCAL_TIME_DISAMBIGUATION_INVALID'
    : error.code;
  return new StationLocalInputError(code, error.message);
}

function candidateName(instantUtc, timeZoneId) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: timeZoneId,
    timeZoneName: 'short'
  }).formatToParts(new Date(instantUtc));
  return parts.find(part => part.type === 'timeZoneName')?.value || timeZoneId;
}

function safeCandidates(result) {
  return result.candidates.map(candidate => ({
    disambiguation: candidate.disambiguation,
    instantUtc: candidate.instantUtc,
    localTime: result.localTime,
    offset: candidate.offset,
    timeZoneName: candidateName(candidate.instantUtc, result.timeZoneId),
    label: `${result.localTime} ${candidateName(candidate.instantUtc, result.timeZoneId)} (${candidate.offset}) - ${candidate.disambiguation.toLowerCase()} occurrence`
  }));
}

function resolveStationLocalInput(input, timeZoneId) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (value.disambiguation !== undefined && value.disambiguation !== null
      && value.disambiguation !== 'EARLIER' && value.disambiguation !== 'LATER') {
    throw new StationLocalInputError(
      'LOCAL_TIME_DISAMBIGUATION_INVALID',
      'The DST disambiguation must be EARLIER or LATER'
    );
  }
  let result;
  try {
    result = resolveStationLocalDateTime(
      value.localDate,
      value.localTime,
      timeZoneId,
      value.disambiguation
    );
  } catch (error) {
    throw localInputError(error);
  }

  if (result.status === 'NONEXISTENT') {
    throw new StationLocalInputError(
      'LOCAL_TIME_NONEXISTENT',
      'The selected local time does not exist because of a daylight-saving transition',
      422,
      { localDate: result.localDate, localTime: result.localTime, timeZoneId: result.timeZoneId }
    );
  }
  if (result.status === 'AMBIGUOUS') {
    throw new StationLocalInputError(
      'LOCAL_TIME_AMBIGUOUS',
      'The selected local time occurs twice. Choose the intended occurrence',
      409,
      {
        localDate: result.localDate,
        localTime: result.localTime,
        timeZoneId: result.timeZoneId,
        candidates: safeCandidates(result)
      }
    );
  }

  return {
    instant: new Date(result.instantUtc),
    instantUtc: result.instantUtc,
    localDate: result.localDate,
    localTime: result.localTime,
    timeZoneId: result.timeZoneId,
    offset: result.offset,
    disambiguation: result.disambiguation || null
  };
}

function sendStationLocalInputError(context, error, sendJson) {
  if (!(error instanceof StationLocalInputError)) return false;
  sendJson(context, error.status, {
    ok: false,
    code: error.code,
    error: error.message,
    ...(error.details || {})
  });
  return true;
}

module.exports = {
  StationLocalInputError,
  resolveStationLocalInput,
  sendStationLocalInputError
};
