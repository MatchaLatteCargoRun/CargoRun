'use strict';

const crypto = require('crypto');
const { normalizeStationId } = require('./station');
const { authenticatedActor } = require('./operational-authorization');

const MACHINE_BINDINGS_SETTING = 'MACH_FOW_MACHINE_BINDINGS';
const MACHINE_HEADER = 'x-cargorun-mach-key';

function secureEqual(left, right) {
  try {
    const leftDigest = crypto.createHash('sha256').update(String(left ?? ''), 'utf8').digest();
    const rightDigest = crypto.createHash('sha256').update(String(right ?? ''), 'utf8').digest();
    return crypto.timingSafeEqual(leftDigest, rightDigest);
  } catch {
    return false;
  }
}

function headerInput(req, name) {
  const headers = req?.headers || {};
  let raw;
  let present = false;
  if (typeof headers.get === 'function') {
    raw = headers.get(name);
    present = typeof headers.has === 'function'
      ? headers.has(name)
      : raw !== null && raw !== undefined;
  } else {
    for (const candidate of [name, name.toLowerCase(), name.toUpperCase()]) {
      if (Object.prototype.hasOwnProperty.call(headers, candidate)) {
        raw = headers[candidate];
        present = true;
        break;
      }
    }
  }
  if (!present) {
    return { present: false, ambiguous: false, value: '' };
  }
  if (Array.isArray(raw)) {
    const value = raw.length === 1 ? String(raw[0]) : '';
    return {
      present: true,
      ambiguous: raw.length !== 1 || value.includes(','),
      value
    };
  }
  const value = raw === null || raw === undefined ? '' : String(raw);
  return { present: true, ambiguous: value.includes(','), value };
}

function hasAuthenticatedHumanPrincipal(req) {
  try {
    authenticatedActor(req);
    return true;
  } catch {
    return false;
  }
}

function readMachineBindingConfiguration(env = process.env) {
  const raw = String(env?.[MACHINE_BINDINGS_SETTING] || '').trim();
  if (!raw) return { status: 'missing', bindings: [] };

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) {
      return { status: 'invalid', bindings: [] };
    }

    const integrationIds = new Set();
    const credentialDigests = new Set();
    const bindings = [];

    for (const item of parsed) {
      if (!item || Array.isArray(item) || typeof item !== 'object') {
        return { status: 'invalid', bindings: [] };
      }
      const integrationId = String(item.integrationId || '').trim();
      const credential = typeof item.credential === 'string' ? item.credential : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(integrationId)) {
        return { status: 'invalid', bindings: [] };
      }
      if (
        credential.length < 16 ||
        credential.length > 512 ||
        credential !== credential.trim() ||
        /[\s,\x00-\x1f\x7f]/.test(credential) ||
        typeof item.enabled !== 'boolean'
      ) {
        return { status: 'invalid', bindings: [] };
      }

      let stationId;
      try {
        stationId = normalizeStationId(item.stationId);
      } catch {
        return { status: 'invalid', bindings: [] };
      }

      const normalizedIntegrationId = integrationId.toUpperCase();
      const credentialDigest = crypto.createHash('sha256').update(credential, 'utf8').digest('hex');
      if (integrationIds.has(normalizedIntegrationId) || credentialDigests.has(credentialDigest)) {
        return { status: 'invalid', bindings: [] };
      }
      integrationIds.add(normalizedIntegrationId);
      credentialDigests.add(credentialDigest);
      bindings.push({ integrationId, stationId, credential, enabled: item.enabled });
    }

    return { status: 'ready', bindings };
  } catch {
    return { status: 'invalid', bindings: [] };
  }
}

function machineAuth(req, env = process.env) {
  const configuration = readMachineBindingConfiguration(env);
  const direct = headerInput(req, MACHINE_HEADER);
  const queryPresent = Object.prototype.hasOwnProperty.call(req?.query || {}, 'key');
  const credentialPresented = direct.present || queryPresent;
  const ambiguous = direct.ambiguous || queryPresent ||
    (direct.present && hasAuthenticatedHumanPrincipal(req));
  let supplied = '';
  let mode = null;

  if (!ambiguous && direct.present) {
    supplied = direct.value;
    mode = 'header';
  }

  if (!credentialPresented) {
    return {
      configured: configuration.status === 'ready',
      configurationStatus: configuration.status,
      credentialPresented: false,
      ambiguous: false,
      ok: false,
      mode: null,
      integrationId: null,
      stationId: null
    };
  }

  if (ambiguous || configuration.status !== 'ready' || !supplied) {
    return {
      configured: configuration.status === 'ready',
      configurationStatus: configuration.status,
      credentialPresented: true,
      ambiguous,
      ok: false,
      mode,
      integrationId: null,
      stationId: null
    };
  }

  const matches = configuration.bindings.filter(binding => secureEqual(binding.credential, supplied));
  const binding = matches.length === 1 && matches[0].enabled ? matches[0] : null;
  return {
    configured: true,
    configurationStatus: 'ready',
    credentialPresented: true,
    ambiguous: false,
    ok: Boolean(binding),
    mode,
    integrationId: binding?.integrationId || null,
    stationId: binding?.stationId || null
  };
}

module.exports = {
  MACHINE_BINDINGS_SETTING,
  MACHINE_HEADER,
  secureEqual,
  readMachineBindingConfiguration,
  machineAuth
};
