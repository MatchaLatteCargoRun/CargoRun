const sql = require('mssql');
const {
  authenticatedActor,
  requireOperationalStations,
  requireOperationalEntityCapability,
  sendOperationalAuthorizationError
} = require('../shared/operational-authorization');

const FLIGHTAWARE_ENABLED =
  String(process.env.FLIGHTAWARE_ENABLED || '').trim().toLowerCase() === 'true';

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return new Date(value > 1e12 ? value : value * 1000).toISOString();

  if (/^\d+$/.test(String(value))) {
    const n = Number(value);
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function airportCode(obj) {
  return String(obj?.code_iata || obj?.code || obj?.code_icao || '').toUpperCase();
}

function normaliseIdent(ident) {
  return String(ident || '').toUpperCase().replace(/\s+/g, '');
}

function alternates(ident) {
  const raw = normaliseIdent(ident);
  const out = [raw];

  const m = raw.match(/^([A-Z0-9]{2,3})0+(\d+[A-Z]?)$/);
  if (m) out.push(m[1] + m[2]);

  return [...new Set(out)];
}

function sendJson(context, status, payload, extraHeaders = {}) {
  context.res = {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
      'Cache-Control': 'private, no-store'
    },
    body: JSON.stringify(payload)
  };
}

module.exports = async function (context, req) {
  let operationalPool;
  try {
    const query = req?.query || {};
    if (String(query.dbhealth || '') === '1') {
  let pool;

  try {
    const connectionString = process.env.DATABASE_CONNECTION_STRING;

    if (!connectionString) {
      sendJson(context, 503, {
        ok: false,
        status: 'unavailable'
      });
      return;
    }

    pool = await sql.connect(connectionString);

    await pool.request().query('SELECT 1 AS DatabaseReachable;');

    sendJson(context, 200, {
      ok: true,
      status: 'healthy'
    });

    return;

  } catch (err) {
    context.log.error('Database health check failed', err);

      sendJson(context, 503, {
        ok: false,
        status: 'unhealthy'
    });

    return;

  } finally {
    try {
      await pool?.close();
    } catch {}
  }
}

    if (String(query.health || '') === '1') {
      sendJson(
        context,
        200,
        {
          ok: true,
          status: 'healthy'
        }
      );
      return;
    }

    if (!FLIGHTAWARE_ENABLED) {
      sendJson(
        context,
        503,
        {
          ok: false,
          code: 'FLIGHTAWARE_DISABLED',
          error: 'Live flight tracking is disabled.'
        }
      );
      return;
    }

    const actor = authenticatedActor(req);
    const flightId = String(query.flightId || '').trim();
    if (!/^[1-9]\d*$/.test(flightId)) {
      sendJson(context, 400, { ok: false, code: 'INVALID_FLIGHT_ID', error: 'A valid flightId is required' });
      return;
    }
    const connectionString = process.env.DATABASE_CONNECTION_STRING;
    if (!connectionString) {
      sendJson(context, 503, { ok: false, code: 'AUTHORIZATION_CONFIGURATION_UNAVAILABLE', error: 'Operational authorization could not be resolved' });
      return;
    }
    operationalPool = await new sql.ConnectionPool(connectionString).connect();
    await requireOperationalStations(operationalPool, sql, actor, 'VIEW_FLIGHTS');
    const flightResult = await operationalPool.request()
      .input('FlightStatusFlightId', sql.BigInt, flightId)
      .query(`SELECT FlightId,StationId,FlightNumber,CONVERT(char(10),OperatingDate,23) AS OperatingDate,
        Direction,OriginAirport,DestinationAirport
        FROM dbo.Flights WHERE FlightId=@FlightStatusFlightId;`);
    const selectedFlight = flightResult.recordset.length === 1 ? flightResult.recordset[0] : null;
    await requireOperationalEntityCapability(operationalPool, sql, actor, selectedFlight, 'VIEW_FLIGHTS');

    const apiKey = process.env.FLIGHTAWARE_API_KEY;
    const flight = normaliseIdent(selectedFlight.FlightNumber);
    const airport = String(selectedFlight.DestinationAirport || '').toUpperCase();
    const date = String(selectedFlight.OperatingDate || '').trim();

    if (!apiKey) {
      sendJson(context, 503, {
        ok: false,
        code: 'SERVICE_UNAVAILABLE',
        error: 'Live flight tracking is unavailable.'
      });
      return;
    }

    let lastError = null;

    for (const ident of alternates(flight)) {
      try {
        const url = new URL(
          `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}`
        );

        if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
          const start = new Date(`${date}T00:00:00Z`);
          start.setUTCDate(start.getUTCDate() - 1);

          const end = new Date(`${date}T23:59:59Z`);
          end.setUTCDate(end.getUTCDate() + 1);

          url.searchParams.set('start', start.toISOString());
          url.searchParams.set('end', end.toISOString());
        }

        const response = await fetch(url, {
          headers: {
            'x-apikey': apiKey,
            Accept: 'application/json'
          }
        });

        const body = await response.json().catch(() => ({}));

        if (!response.ok) {
          lastError =
            body?.title ||
            body?.detail ||
            `FlightAware returned ${response.status}`;
          continue;
        }

        let flights = Array.isArray(body.flights) ? body.flights : [];

        const atAirport = flights.filter(f => {
          const code = airportCode(f.destination);
          return !code || code === airport || (airport === 'MEL' && code === 'YMML');
        });

        if (atAirport.length) flights = atAirport;
        if (!flights.length) continue;

        const target = date
          ? Date.parse(`${date}T12:00:00Z`)
          : Date.now();

        flights.sort(
          (a, b) =>
            Math.abs(
              (Date.parse(
                a.scheduled_in ||
                a.scheduled_on ||
                a.estimated_in ||
                a.estimated_on ||
                ''
              ) || target) - target
            ) -
            Math.abs(
              (Date.parse(
                b.scheduled_in ||
                b.scheduled_on ||
                b.estimated_in ||
                b.estimated_on ||
                ''
              ) || target) - target
            )
        );

        const f = flights[0];

        sendJson(
          context,
          200,
          {
            provider: 'FlightAware AeroAPI',
            matchedFlight: f.ident_iata || f.ident || ident,
            status: f.status || '',
            scheduledArrival: toIso(f.scheduled_in || f.scheduled_on),
            estimatedArrival: toIso(f.estimated_in || f.estimated_on),
            landedAt: toIso(f.actual_on),
            inBlockAt: toIso(f.actual_in),
            destination: airportCode(f.destination) || airport
          },
          { 'Cache-Control': 'private, no-store' }
        );

        return;
      } catch (err) {
        lastError = err?.message || String(err);
      }
    }

    sendJson(context, 404, {
      error: lastError || `No matching ${flight} arrival found for ${airport}`
    });
  } catch (err) {
    if (sendOperationalAuthorizationError(context, err, sendJson)) return;
    context.log.error('CargoRun flight-status API failed', err);

    sendJson(context, 500, {
      error: 'CargoRun flight-status API failed'
    });
  } finally {
    try { await operationalPool?.close(); } catch {}
  }
};
