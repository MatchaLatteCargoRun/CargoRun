const sql = require('mssql');
const { insertAuditEvent } = require('../shared/audit');
const {
  authenticatedActor,
  requireOperationalCapability,
  sendOperationalAuthorizationError
} = require('../shared/operational-authorization');


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

function canonicalStatus(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

function cleanText(value, max = 150) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function pick(columns, candidates) {
  const lookup = new Map(columns.map(c => [String(c.COLUMN_NAME).toLowerCase(), c.COLUMN_NAME]));
  for (const name of candidates) {
    const hit = lookup.get(String(name).toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function quoteName(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

async function tableColumns(request, tableName) {
  const result = await request
    .input(`TableName_${tableName}`, sql.NVarChar(128), tableName)
    .query(`
      SELECT
        c.COLUMN_NAME,
        c.IS_NULLABLE,
        c.COLUMN_DEFAULT,
        c.DATA_TYPE,
        COLUMNPROPERTY(
          OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)),
          c.COLUMN_NAME,
          'IsIdentity'
        ) AS IS_IDENTITY
      FROM INFORMATION_SCHEMA.COLUMNS c
      WHERE c.TABLE_SCHEMA = 'dbo'
        AND c.TABLE_NAME = @TableName_${tableName};
    `);
  return result.recordset || [];
}

module.exports = async function (context, req) {
  let pool;
  let transaction;

  try {
    const connectionString = process.env.DATABASE_CONNECTION_STRING;

    if (!connectionString) {
      sendJson(context, 503, {
        ok: false,
        error: 'DATABASE_CONNECTION_STRING is not configured'
      });
      return;
    }

    const actor = authenticatedActor(req);

    const body = req.body || {};
    const uldId = String(body.uldId || '').trim();
    const requestedNext = canonicalStatus(body.nextStatus);
    const expectedCurrent = body.expectedCurrentStatus
      ? canonicalStatus(body.expectedCurrentStatus)
      : null;
    const actorDisplayName = actor.displayName;
    const actorReference = actor.reference;
    const notes = cleanText(body.notes, 500);

    if (!/^\d+$/.test(uldId)) {
      sendJson(context, 400, { ok: false, error: 'uldId is required' });
      return;
    }

    if (!requestedNext) {
      sendJson(context, 400, { ok: false, error: 'nextStatus is required' });
      return;
    }

    if (!expectedCurrent) {
      sendJson(context, 400, { ok: false, error: 'expectedCurrentStatus is required' });
      return;
    }

    pool = await new sql.ConnectionPool(connectionString).connect();
    transaction = new sql.Transaction(pool);
    await transaction.begin();

    const currentResult = await new sql.Request(transaction)
      .input('UldId', sql.BigInt, uldId)
      .query(`
        SELECT
          u.UldId,
          u.FlightId,
          u.UldNumber,
          u.CurrentStatus,
          f.Direction,
          f.OriginAirport,
          f.DestinationAirport,
          f.FlightNumber
        FROM dbo.ULDs u
        INNER JOIN dbo.Flights f
          ON f.FlightId = u.FlightId
        WHERE u.UldId = @UldId;
      `);

    if (!currentResult.recordset.length) {
      await transaction.rollback();
      transaction = null;
      sendJson(context, 404, { ok: false, error: 'ULD not found' });
      return;
    }

    const current = currentResult.recordset[0];
    await requireOperationalCapability(transaction, sql, actor, current, 'MOVE_ULD');
    const direction = canonicalStatus(current.Direction);
    const currentStatus = canonicalStatus(current.CurrentStatus);

    if (expectedCurrent && expectedCurrent !== currentStatus) {
      await transaction.rollback();
      transaction = null;
      sendJson(context, 409, {
        ok: false,
        error: 'ULD status changed; refresh and review again',
        code: 'STALE_STATUS',
        currentStatus
      });
      return;
    }

    const sequences = {
      IMPORT: ['UNARRIVED', 'ARRIVED', 'TRANSIT', 'RECEIVED'],
      EXPORT: ['WAREHOUSE', 'TRANSIT', 'AT_AIRCRAFT']
    };

    const sequence = sequences[direction];
    if (!sequence) {
      await transaction.rollback();
      transaction = null;
      sendJson(context, 400, { ok: false, error: `Unsupported flight direction: ${direction}` });
      return;
    }

    const currentIndex = sequence.indexOf(currentStatus);
    const expectedNext = currentIndex >= 0 ? sequence[currentIndex + 1] : null;

    if (!expectedNext) {
      await transaction.rollback();
      transaction = null;
      sendJson(context, 409, {
        ok: false,
        error: 'ULD is already at its final status',
        currentStatus
      });
      return;
    }

    if (requestedNext !== expectedNext) {
      await transaction.rollback();
      transaction = null;
      sendJson(context, 409, {
        ok: false,
        error: `Invalid transition ${currentStatus} → ${requestedNext}`,
        expectedNext
      });
      return;
    }

    const metadataRequest = new sql.Request(transaction);
    const uldColumns = await tableColumns(metadataRequest, 'ULDs');

    const sets = ['CurrentStatus = @NextStatus'];
    const request = new sql.Request(transaction)
      .input('UldId', sql.BigInt, uldId)
      .input('ExpectedStatus', sql.VarChar(30), expectedCurrent)
      .input('NextStatus', sql.VarChar(30), requestedNext)
      .input('ActorDisplayName', sql.NVarChar(150), actorDisplayName)
      .input('ActorReference', sql.NVarChar(150), actorReference)
      .input('Notes', sql.NVarChar(500), notes);

    const identityCol = pick(uldColumns, ['IdentityVerified']);
    if (identityCol) sets.push(`${quoteName(identityCol)} = 1`);

    const timestampMap = {
      'IMPORT:ARRIVED': {
        time: ['AcceptedAtUtc', 'AcceptedAt'],
        user: ['AcceptedByDisplayName', 'AcceptedByName'],
        userId: ['AcceptedByObjectId', 'AcceptedById']
      },
      'IMPORT:RECEIVED': {
        time: ['ReceivedAtUtc', 'ReceivedAt'],
        user: ['ReceivedByDisplayName', 'ReceivedByName'],
        userId: ['ReceivedByObjectId', 'ReceivedById']
      },
      'EXPORT:TRANSIT': {
        time: ['WarehouseDepartedAtUtc', 'WarehouseDepartedAt', 'DepartedWarehouseAtUtc'],
        user: ['WarehouseDepartedByDisplayName', 'WarehouseDepartedByName', 'DepartedWarehouseByDisplayName'],
        userId: ['WarehouseDepartedByObjectId', 'WarehouseDepartedById', 'DepartedWarehouseByObjectId']
      },
      'EXPORT:AT_AIRCRAFT': {
        time: ['AtAircraftAtUtc', 'AtAircraftAt'],
        user: ['AtAircraftByDisplayName', 'AtAircraftByName', 'DeliveredByDisplayName'],
        userId: ['AtAircraftByObjectId', 'AtAircraftById', 'DeliveredByObjectId']
      }
    };

    const stamp = timestampMap[`${direction}:${requestedNext}`];
    if (stamp) {
      const timeCol = pick(uldColumns, stamp.time);
      const userCol = pick(uldColumns, stamp.user);
      const userIdCol = pick(uldColumns, stamp.userId || []);
      if (timeCol) sets.push(`${quoteName(timeCol)} = @Now`);
      if (userCol) sets.push(`${quoteName(userCol)} = @ActorDisplayName`);
      if (userIdCol) sets.push(`${quoteName(userIdCol)} = @ActorReference`);
    }

    const updateSql = `
      DECLARE @Now DATETIME2(3) = SYSUTCDATETIME();

      UPDATE dbo.ULDs
      SET ${sets.join(',\n          ')}
      WHERE UldId = @UldId
        AND CurrentStatus = @ExpectedStatus;

      SELECT @Now AS OccurredAtUtc;
    `;

    const updateResult = await request.query(updateSql);
    const affectedRows = Number(updateResult.rowsAffected?.[0] || 0);

    if (affectedRows !== 1) {
      const latest = affectedRows === 0
        ? await new sql.Request(transaction)
          .input('LatestUldId', sql.BigInt, uldId)
          .query('SELECT CurrentStatus FROM dbo.ULDs WHERE UldId = @LatestUldId;')
        : null;
      await transaction.rollback();
      transaction = null;

      if (affectedRows === 0) {
        sendJson(context, 409, {
          ok: false,
          error: 'ULD status changed; refresh and review again',
          code: 'STALE_STATUS',
          currentStatus: latest?.recordset?.[0]?.CurrentStatus || null
        });
        return;
      }

      sendJson(context, 500, {
        ok: false,
        error: 'ULD status update affected an unexpected number of rows',
        code: 'STATUS_UPDATE_INVARIANT'
      });
      return;
    }

    const occurredAtUtc = updateResult.recordset?.[0]?.OccurredAtUtc || new Date().toISOString();

    const firstAcceptance = currentIndex === 0;
    await insertAuditEvent(transaction, sql, {
      type: 'ULD',
      action: firstAcceptance ? 'ULD accepted' : 'Status changed',
      actorDisplayName,
      actorReference,
      entityType: 'ULD',
      entityId: current.UldId,
      flightId: current.FlightId,
      flightNumber: current.FlightNumber,
      uldId: current.UldId,
      uldNumber: current.UldNumber,
      fromStatus: currentStatus,
      toStatus: requestedNext,
      detail: firstAcceptance
        ? 'Identity verified on first acceptance'
        : `ULD moved to ${requestedNext}`,
      details: { direction, source: 'CARGORUN_API' }
    });

    let movementLogged = false;
    let movementWarning = null;

    try {
      const movementColumns = await tableColumns(new sql.Request(transaction), 'UldMovements');

      if (movementColumns.length) {
        const mapped = [];
        const params = [];

        const add = (candidates, parameter, value, type) => {
          const col = pick(movementColumns, candidates);
          if (!col) return;
          mapped.push(col);
          params.push(`@${parameter}`);
          if (!request.parameters?.[parameter]) request.input(parameter, type, value);
        };

        add(['UldId'], 'MoveUldId', uldId, sql.BigInt);
        add(['FromStatus'], 'MoveFromStatus', currentStatus, sql.VarChar(30));
        add(['ToStatus'], 'MoveToStatus', requestedNext, sql.VarChar(30));
        add(['OccurredAtUtc', 'OccurredAt'], 'MoveOccurredAt', occurredAtUtc, sql.DateTime2(3));
        add(['ActorDisplayName', 'ActorName'], 'MoveActorName', actorDisplayName, sql.NVarChar(150));
        add(['ActorObjectId', 'ActorId', 'ActorReference'], 'MoveActorReference', actorReference, sql.NVarChar(150));
        add(['Source', 'SourceType'], 'MoveSource', 'CARGORUN_UI', sql.NVarChar(50));
        add(['Notes', 'Detail'], 'MoveNotes', notes || `CargoRun status change by ${actorDisplayName}`, sql.NVarChar(500));

        const known = new Set(mapped.map(x => x.toLowerCase()));
        const requiredUnknown = movementColumns.filter(c =>
          c.IS_NULLABLE === 'NO' &&
          !c.COLUMN_DEFAULT &&
          Number(c.IS_IDENTITY) !== 1 &&
          !known.has(String(c.COLUMN_NAME).toLowerCase())
        );

        if (!requiredUnknown.length && mapped.length) {
          await request.query(`
            INSERT INTO dbo.UldMovements
              (${mapped.map(quoteName).join(', ')})
            VALUES
              (${params.join(', ')});
          `);
          movementLogged = true;
        } else if (requiredUnknown.length) {
          movementWarning = `Movement trail skipped because required columns were not recognised: ${requiredUnknown.map(x => x.COLUMN_NAME).join(', ')}`;
        }
      }
    } catch (movementErr) {
      movementWarning = movementErr.message;
      context.log.warn('ULD movement trail was not written', movementErr);
    }

    const updated = await new sql.Request(transaction)
      .input('UpdatedUldId', sql.BigInt, uldId)
      .query(`
        SELECT *
        FROM dbo.ULDs
        WHERE UldId = @UpdatedUldId;
      `);

    await transaction.commit();
    transaction = null;

    sendJson(context, 200, {
      ok: true,
      flightId: current.FlightId,
      flightNumber: current.FlightNumber,
      uldId: current.UldId,
      uldNumber: current.UldNumber,
      direction,
      previousStatus: currentStatus,
      currentStatus: requestedNext,
      occurredAtUtc,
      actorDisplayName,
      actorReference,
      movementLogged,
      movementWarning,
      uld: updated.recordset[0]
    });

  } catch (err) {
    if (transaction) {
      try { await transaction.rollback(); } catch {}
    }

    if (sendOperationalAuthorizationError(context, err, sendJson)) return;
    context.log.error('ULD status API failed', err);
    sendJson(context, 500, {
      ok: false,
      error: 'ULD status update failed',
      detail: err.message
    });

  } finally {
    try { await pool?.close(); } catch {}
  }
};
