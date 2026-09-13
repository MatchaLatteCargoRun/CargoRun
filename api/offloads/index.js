const sql = require('mssql');


function getHeader(req, name) {
  const headers = req?.headers || {};
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || null;
}

function getClientPrincipal(req) {
  try {
    const raw = getHeader(req, 'x-ms-client-principal');
    if (!raw) return null;
    const json = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function getActor(req) {
  const principal = getClientPrincipal(req);
  if (!principal) return null;
  const roles = Array.isArray(principal.userRoles) ? principal.userRoles : [];
  if (!roles.includes('authenticated')) return null;
  return {
    displayName: String(principal.userDetails || 'Authenticated user').slice(0, 150),
    reference: String(principal.userId || '').slice(0, 150),
    roles,
    identityProvider: principal.identityProvider || 'aad'
  };
}
function sendJson(context, status, body) {
  context.res = {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function clean(value, max = 150) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function canonical(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function pick(columns, candidates) {
  const map = new Map(columns.map(c => [String(c.COLUMN_NAME).toLowerCase(), c.COLUMN_NAME]));
  for (const candidate of candidates) {
    const hit = map.get(String(candidate).toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function q(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

async function columnsFor(request, tableName) {
  const result = await request
    .input('TableName', sql.NVarChar(128), tableName)
    .query(`
      SELECT
        COLUMN_NAME,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        DATA_TYPE,
        COLUMNPROPERTY(
          OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)),
          COLUMN_NAME,
          'IsIdentity'
        ) AS IS_IDENTITY
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo'
        AND TABLE_NAME = @TableName;
    `);
  return result.recordset || [];
}

function normalize(row, columns) {
  const get = candidates => {
    const col = pick(columns, candidates);
    return col ? row[col] : null;
  };
  return {
    offloadId: get(['OffloadId', 'Id']),
    flightId: get(['FlightId']),
    flightNumber: get(['FlightNumber', 'Flight']),
    uldNumber: get(['UldNumber', 'ULDNumber', 'Uld']),
    parkingBay: get(['ParkingBay', 'Bay']),
    status: canonical(get(['Status', 'OffloadStatus'])),
    requestedAtUtc: get(['RequestedAtUtc', 'RequestedAt', 'CreatedAtUtc']),
    requestedByDisplayName: get(['RequestedByDisplayName', 'RequestedByName']),
    collectedAtUtc: get(['CollectedAtUtc', 'CollectedAt']),
    collectedByDisplayName: get(['CollectedByDisplayName', 'CollectedByName']),
    deliveredAtUtc: get(['DeliveredAtUtc', 'DeliveredAt', 'CompletedAtUtc', 'CompletedAt']),
    deliveredByDisplayName: get(['DeliveredByDisplayName', 'DeliveredByName', 'CompletedByDisplayName']),
    deliveredLocation: get(['DeliveredLocation', 'Location'])
  };
}

module.exports = async function (context, req) {
  let pool;
  let transaction;

  try {
    const connectionString = process.env.DATABASE_CONNECTION_STRING;
    if (!connectionString) {
      sendJson(context, 503, { ok: false, error: 'DATABASE_CONNECTION_STRING is not configured' });
      return;
    }

    const identity = getActor(req);
    if (!identity) {
      sendJson(context, 401, { ok: false, error: 'Microsoft Entra sign-in is required' });
      return;
    }

    pool = await new sql.ConnectionPool(connectionString).connect();
    const columns = await columnsFor(pool.request(), 'Offloads');
    if (!columns.length) {
      sendJson(context, 500, { ok: false, error: 'dbo.Offloads table was not found' });
      return;
    }

    const idCol = pick(columns, ['OffloadId', 'Id']);
    const statusCol = pick(columns, ['Status', 'OffloadStatus']);
    if (!idCol || !statusCol) {
      sendJson(context, 500, { ok: false, error: 'Offloads schema is missing an ID or status column' });
      return;
    }

    if (req.method === 'GET') {
      const result = await pool.request().query(`SELECT * FROM dbo.Offloads ORDER BY ${q(idCol)} DESC;`);
      const offloads = result.recordset.map(r => normalize(r, columns));
      sendJson(context, 200, { ok: true, count: offloads.length, offloads });
      return;
    }

    const body = req.body || {};
    const actorDisplayName = identity.displayName;
    const actorReference = identity.reference;

    if (req.method === 'POST') {
      const uldNumber = clean(body.uldNumber, 20)?.toUpperCase();
      const flightNumber = clean(body.flightNumber, 12)?.toUpperCase();
      const parkingBay = clean(body.parkingBay, 30)?.toUpperCase();

      if (!uldNumber || !flightNumber || !parkingBay) {
        sendJson(context, 400, { ok: false, error: 'uldNumber, flightNumber and parkingBay are required' });
        return;
      }

      let flightId = null;
      try {
        const f = await pool.request()
          .input('FlightNumber', sql.NVarChar(12), flightNumber)
          .query(`
            SELECT TOP 1 FlightId
            FROM dbo.Flights
            WHERE FlightNumber = @FlightNumber
            ORDER BY OperatingDate DESC, FlightId DESC;
          `);
        flightId = f.recordset?.[0]?.FlightId ?? null;
      } catch {}

      const request = pool.request()
        .input('FlightId', sql.BigInt, flightId)
        .input('FlightNumber', sql.NVarChar(12), flightNumber)
        .input('UldNumber', sql.NVarChar(20), uldNumber)
        .input('ParkingBay', sql.NVarChar(30), parkingBay)
        .input('Status', sql.VarChar(20), 'REQUESTED')
        .input('ActorDisplayName', sql.NVarChar(150), actorDisplayName)
        .input('ActorReference', sql.NVarChar(150), actorReference);

      const names = [];
      const values = [];
      const add = (candidates, expression) => {
        const col = pick(columns, candidates);
        if (!col || names.includes(col)) return;
        names.push(col);
        values.push(expression);
      };

      add(['FlightId'], '@FlightId');
      add(['FlightNumber', 'Flight'], '@FlightNumber');
      add(['UldNumber', 'ULDNumber', 'Uld'], '@UldNumber');
      add(['ParkingBay', 'Bay'], '@ParkingBay');
      add(['Status', 'OffloadStatus'], '@Status');
      add(['RequestedAtUtc', 'RequestedAt', 'CreatedAtUtc'], 'SYSUTCDATETIME()');
      add(['RequestedByDisplayName', 'RequestedByName'], '@ActorDisplayName');
      add(['RequestedByObjectId', 'RequestedById', 'RequestedByReference'], '@ActorReference');

      const mapped = new Set(names.map(n => n.toLowerCase()));
      const requiredUnknown = columns.filter(c =>
        c.IS_NULLABLE === 'NO' &&
        !c.COLUMN_DEFAULT &&
        Number(c.IS_IDENTITY) !== 1 &&
        !mapped.has(String(c.COLUMN_NAME).toLowerCase())
      );
      if (requiredUnknown.length) {
        sendJson(context, 500, {
          ok: false,
          error: `Offloads schema has unmapped required columns: ${requiredUnknown.map(c => c.COLUMN_NAME).join(', ')}`
        });
        return;
      }

      const insert = await request.query(`
        INSERT INTO dbo.Offloads (${names.map(q).join(', ')})
        OUTPUT INSERTED.*
        VALUES (${values.join(', ')});
      `);

      sendJson(context, 201, { ok: true, offload: normalize(insert.recordset[0], columns) });
      return;
    }

    // PATCH
    const offloadId = String(body.offloadId || '').trim();
    const expectedCurrentStatus = canonical(body.expectedCurrentStatus);
    const nextStatus = canonical(body.nextStatus);
    const deliveredLocation = clean(body.deliveredLocation, 150);

    if (!/^\d+$/.test(offloadId)) {
      sendJson(context, 400, { ok: false, error: 'offloadId is required' });
      return;
    }

    const sequence = ['REQUESTED', 'TRANSIT', 'COMPLETE'];
    if (!sequence.includes(nextStatus)) {
      sendJson(context, 400, { ok: false, error: 'nextStatus must be TRANSIT or COMPLETE' });
      return;
    }

    transaction = new sql.Transaction(pool);
    await transaction.begin();

    const currentResult = await new sql.Request(transaction)
      .input('OffloadId', sql.BigInt, offloadId)
      .query(`SELECT * FROM dbo.Offloads WHERE ${q(idCol)} = @OffloadId;`);

    if (!currentResult.recordset.length) {
      await transaction.rollback(); transaction = null;
      sendJson(context, 404, { ok: false, error: 'Offload not found' });
      return;
    }

    const current = normalize(currentResult.recordset[0], columns);
    if (expectedCurrentStatus && expectedCurrentStatus !== current.status) {
      await transaction.rollback(); transaction = null;
      sendJson(context, 409, { ok: false, error: 'Offload changed on another device', currentStatus: current.status });
      return;
    }

    const currentIndex = sequence.indexOf(current.status);
    const legalNext = currentIndex >= 0 ? sequence[currentIndex + 1] : null;
    if (nextStatus !== legalNext) {
      await transaction.rollback(); transaction = null;
      sendJson(context, 409, { ok: false, error: `Invalid transition ${current.status} → ${nextStatus}`, expectedNext: legalNext });
      return;
    }

    if (nextStatus === 'COMPLETE' && !deliveredLocation) {
      await transaction.rollback(); transaction = null;
      sendJson(context, 400, { ok: false, error: 'deliveredLocation is required to complete an offload' });
      return;
    }

    const request = new sql.Request(transaction)
      .input('OffloadId', sql.BigInt, offloadId)
      .input('NextStatus', sql.VarChar(20), nextStatus)
      .input('ActorDisplayName', sql.NVarChar(150), actorDisplayName)
      .input('ActorReference', sql.NVarChar(150), actorReference)
      .input('DeliveredLocation', sql.NVarChar(150), deliveredLocation);

    const sets = [`${q(statusCol)} = @NextStatus`];
    const addSet = (candidates, expression) => {
      const col = pick(columns, candidates);
      if (col) sets.push(`${q(col)} = ${expression}`);
    };

    if (nextStatus === 'TRANSIT') {
      addSet(['CollectedAtUtc', 'CollectedAt'], 'SYSUTCDATETIME()');
      addSet(['CollectedByDisplayName', 'CollectedByName'], '@ActorDisplayName');
      addSet(['CollectedByObjectId', 'CollectedById', 'CollectedByReference'], '@ActorReference');
    }

    if (nextStatus === 'COMPLETE') {
      addSet(['DeliveredAtUtc', 'DeliveredAt', 'CompletedAtUtc', 'CompletedAt'], 'SYSUTCDATETIME()');
      addSet(['DeliveredByDisplayName', 'DeliveredByName', 'CompletedByDisplayName'], '@ActorDisplayName');
      addSet(['DeliveredByObjectId', 'DeliveredById', 'CompletedByObjectId'], '@ActorReference');
      addSet(['DeliveredLocation', 'Location'], '@DeliveredLocation');
    }

    const updated = await request.query(`
      UPDATE dbo.Offloads
      SET ${sets.join(', ')}
      OUTPUT INSERTED.*
      WHERE ${q(idCol)} = @OffloadId;
    `);

    await transaction.commit(); transaction = null;
    sendJson(context, 200, { ok: true, offload: normalize(updated.recordset[0], columns) });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch {} }
    context.log.error('Offloads API failed', err);
    sendJson(context, 500, { ok: false, error: 'Offloads API failed', detail: err.message });
  } finally {
    try { await pool?.close(); } catch {}
  }
};
