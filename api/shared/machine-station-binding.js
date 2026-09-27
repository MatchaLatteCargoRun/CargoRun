'use strict';

const crypto = require('crypto');
const { normalizeStationId } = require('./station');

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
  if (typeof headers.get === 'function') raw = headers.get(name);
  else raw = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (raw === null || raw === undefined || raw === '') {
    return { present: false, ambiguous: false, value: '' };
  }
  if (Array.isArray(raw)) {
    return {
      present: raw.length > 0,
      ambiguous: raw.length !== 1,
      value: raw.length === 1 ? String(raw[0]) : ''
    };
  }
  const value = String(raw);
  return { present: true, ambiguous: value.includes(','), value };
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
  const authorization = headerInput(req, 'authorization');
  const principal = headerInput(req, 'x-ms-client-principal');
  const queryPresent = Object.prototype.hasOwnProperty.call(req?.query || {}, 'key') &&
    req.query.key !== null && req.query.key !== undefined && String(req.query.key) !== '';

  const mechanisms = Number(direct.present) + Number(authorization.present) + Number(queryPresent);
  const credentialPresented = mechanisms > 0;
  let ambiguous = direct.ambiguous || authorization.ambiguous || mechanisms > 1 ||
    (credentialPresented && principal.present);
  let supplied = '';
  let mode = null;

  if (!ambiguous && direct.present) {
    supplied = direct.value;
    mode = 'header';
  } else if (!ambiguous && authorization.present) {
    const match = authorization.value.trim().match(/^Bearer\s+([^\s,]+)$/i);
    if (!match) ambiguous = true;
    else {
      supplied = match[1];
      mode = 'bearer';
    }
  } else if (!ambiguous && queryPresent) {
    ambiguous = true;
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
