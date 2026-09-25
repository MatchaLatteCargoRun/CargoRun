const sql = require('mssql');
const { normalizeUldNumber } = require('../shared/uld');
const {
  acquireFlightIdentityLock,
  findFlightsByIdentity
} = require('../shared/flight');
const { insertAuditEvent } = require('../shared/audit');
const {
  ManifestFinalError,
  normalizeManifestItems,
  reconcileManifest,
  publicReconciliation
} = require('../shared/export-manifest-final');
const {
  ExportUwsError,
  parseExportUws,
  matchExportUwsFlight
} = require('../shared/export-uws');
const {
  authenticatedActor,
  requireOperationalCapability,
  sendOperationalAuthorizationError
} = require('../shared/operational-authorization');

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

function clean(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim().toUpperCase();
}

function getHeader(req, name) {
  const headers = req?.headers || {};
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || null;
}

function getClientPrincipal(req) {
  try {
    const raw = getHeader(req, 'x-ms-client-principal');
    if (!raw) return null;
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
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
    reference: String(principal.userId || '').slice(0, 150)
  };
}

async function loadUwsFlight(request, parsed, locked = false) {
  const hint = locked ? ' WITH (UPDLOCK,HOLDLOCK)' : '';
  const parameter = locked ? 'LockedUwsOperatingDate' : 'UwsOperatingDate';
  const result = await request
    .input(parameter, sql.Date, parsed.operatingDate)
    .query(`SELECT FlightId,FlightNumber,CONVERT(char(10),OperatingDate,23) AS OperatingDateIso,
        Direction,FlightStatus,OriginAirport,DestinationAirport
      FROM dbo.Flights${hint}
      WHERE OperatingDate=@${parameter};`);
  return matchExportUwsFlight(result.recordset, parsed);
}

async function ensureUwsBuildOpen(request, flightId, locked = false) {
  const hint = locked ? ' WITH (UPDLOCK,HOLDLOCK)' : '';
  const parameter = locked ? 'LockedUwsFinalFlightId' : 'UwsFinalFlightId';
  const result = await request
    .input(parameter, sql.BigInt, flightId)
    .query(`SELECT FinalManifestId FROM dbo.ExportManifestFinals${hint} WHERE FlightId=@${parameter};`);
  if (result.recordset.length) {
    throw new ExportUwsError(
      'EXPORT_MANIFEST_ALREADY_FINAL',
      "FLIGHT IS FINAL. This flight's final build is locked. No changes have been made.",
      409
    );
  }
}

async function loadUwsOperationalRows(request, flightId, locked = false) {
  const hint = locked ? ' WITH (UPDLOCK,HOLDLOCK)' : '';
  const parameter = locked ? 'LockedUwsUldFlightId' : 'UwsUldFlightId';
  const result = await request
    .input(parameter, sql.BigInt, flightId)
    .query(`SELECT UldId,FlightId,UldNumber,CurrentStatus,IdentityVerified
      FROM dbo.ULDs${hint} WHERE FlightId=@${parameter};`);
  return result.recordset || [];
}

function uwsManifestItems(parsed) {
  return normalizeManifestItems(parsed.ulds.map(item => ({
    uldNumber: item.uldNumber,
    weightKg: item.grossWeightKg,
    remarks: item.remarks,
    priorityText: item.priorityText,
    shcs: item.shcs
  })));
}

function uwsResponse(parsed, flight, items, reconciliation) {
  return {
    document: parsed,
    exactMatch: {
      flightId: String(flight.FlightId),
      flightNumber: flight.FlightNumber,
      operatingDate: flight.OperatingDateIso,
      direction: flight.Direction,
      flightStatus: flight.FlightStatus,
      originAirport: flight.OriginAirport,
      destinationAirport: flight.DestinationAirport
    },
    reconciliation: publicReconciliation(flight, items, reconciliation)
  };
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
    const action = clean(body.action) || 'CREATE';

    if (action === 'PARSE_EXPORT_UWS' || action === 'REVIEW_EXPORT_UWS') {
      const sourceFileName = body.sourceFileName
        ? String(body.sourceFileName).trim().slice(0, 260)
        : 'MACH Export UWS.xlsx';
      const parsed = parseExportUws(body.workbook, { sourceFileName });
      const items = uwsManifestItems(parsed);

      pool = await new sql.ConnectionPool(connectionString).connect();

      if (action === 'PARSE_EXPORT_UWS') {
        const matchedFlight = await loadUwsFlight(pool.request(), parsed);
        await requireOperationalCapability(pool, sql, actor, matchedFlight, 'CONFIRM_EXPORT_FINAL');
        await ensureUwsBuildOpen(pool.request(), matchedFlight.FlightId);
        const reconciliation = reconcileManifest(
          await loadUwsOperationalRows(pool.request(), matchedFlight.FlightId),
          items
        );
        sendJson(context, 200, {
          ok: true,
          action,
          ...uwsResponse(parsed, matchedFlight, items, reconciliation)
        });
        return;
      }

      const initialFlight = await loadUwsFlight(pool.request(), parsed);
      transaction = new sql.Transaction(pool);
      await transaction.begin();
      await acquireFlightIdentityLock(
        transaction,
        sql,
        parsed.operatingDate,
        parsed.flightNumber
      );
      const matchedFlight = await loadUwsFlight(new sql.Request(transaction), parsed, true);
      await requireOperationalCapability(transaction, sql, actor, matchedFlight, 'CONFIRM_EXPORT_FINAL');
      if (String(initialFlight.FlightId) !== String(matchedFlight.FlightId)) {
        throw new ExportUwsError('UWS_FLIGHT_CHANGED', 'The matched flight changed while the UWS was being reviewed', 409);
      }
      await ensureUwsBuildOpen(new sql.Request(transaction), matchedFlight.FlightId, true);
      const reconciliation = reconcileManifest(
        await loadUwsOperationalRows(new sql.Request(transaction), matchedFlight.FlightId, true),
        items
      );
      await new sql.Request(transaction)
        .input('UwsUploadFlightId', sql.BigInt, matchedFlight.FlightId)
        .input('UwsFileName', sql.NVarChar(260), sourceFileName)
        .input('UwsUploadType', sql.NVarChar(50), 'EXPORT_UWS')
        .input('UwsUploadedBy', sql.NVarChar(150), actor.displayName)
        .query(`INSERT INTO dbo.FlightUploads
          (FlightId,FileName,UploadType,UploadedByDisplayName)
          VALUES(@UwsUploadFlightId,@UwsFileName,@UwsUploadType,@UwsUploadedBy);`);

      await insertAuditEvent(transaction, sql, {
        type: 'Flight',
        action: 'EXPORT_UWS_REVIEWED',
        actorDisplayName: actor.displayName,
        actorReference: actor.reference,
        entityType: 'Flight',
        entityId: matchedFlight.FlightId,
        flightId: matchedFlight.FlightId,
        flightNumber: matchedFlight.FlightNumber,
        detail: `Export UWS reviewed for FINAL: ${items.length} ULDs and ${parsed.bulk.length} bulk rows`,
        details: {
          documentType: parsed.documentType,
          sourceFileName,
          operatingDate: parsed.operatingDate,
          station: parsed.station,
          matchedFlightId: String(matchedFlight.FlightId),
          uldCount: items.length,
          bulkRowCount: parsed.bulk.length
        }
      });

      await transaction.commit();
      transaction = null;
      sendJson(context, 200, {
        ok: true,
        action,
        reviewedBy: actor.displayName,
        ...uwsResponse(parsed, matchedFlight, items, reconciliation)
      });
      return;
    }

    if (action !== 'CREATE') {
      sendJson(context, 400, { ok: false, error: 'Unsupported manifest upload action' });
      return;
    }

    const flight = body.flight || {};
    const ulds = Array.isArray(body.ulds) ? body.ulds : [];

    const flightNumber = clean(flight.flightNumber);
    const operatingDate = String(flight.operatingDate || '').trim();
    const direction = clean(flight.direction);
    const airlineCode = clean(flight.airlineCode);
    const originAirport = clean(flight.originAirport);
    const destinationAirport = clean(flight.destinationAirport);

    const sourceFileName =
      flight.sourceFileName
        ? String(flight.sourceFileName).trim()
        : 'CargoRun Excel Upload';

    if (!flightNumber) {
      sendJson(context, 400, { ok: false, error: 'flight.flightNumber is required' });
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(operatingDate)) {
      sendJson(context, 400, { ok: false, error: 'flight.operatingDate must be YYYY-MM-DD' });
      return;
    }

    if (!['IMPORT', 'EXPORT'].includes(direction)) {
      sendJson(context, 400, { ok: false, error: 'flight.direction must be IMPORT or EXPORT' });
      return;
    }

    if (!ulds.length) {
      sendJson(context, 400, { ok: false, error: 'At least one ULD is required' });
      return;
    }

    if (ulds.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      sendJson(context, 400, { ok: false, error: 'Every ULD requires an object with uldNumber' });
      return;
    }

    const normalisedUlds = ulds.map(item => ({
      uldNumber: normalizeUldNumber(item.uldNumber),
      handlingType: clean(item.handlingType),
      weightKg:
        item.weightKg === null ||
        item.weightKg === undefined ||
        item.weightKg === ''
          ? null
          : Number(item.weightKg),
      remarks:
        item.remarks === null || item.remarks === undefined
          ? null
          : String(item.remarks).trim(),
      priorityText:
        item.priorityText === null || item.priorityText === undefined
          ? null
          : String(item.priorityText).trim(),
      shcs: Array.isArray(item.shcs)
        ? [...new Set(item.shcs.map(clean).filter(Boolean))]
        : []
    }));

    for (const uld of normalisedUlds) {
      if (!uld.uldNumber || uld.uldNumber.length > 20) {
        sendJson(context, 400, { ok: false, error: 'Every ULD requires a nonempty string uldNumber of at most 20 characters after normalization' });
        return;
      }

      if (uld.handlingType && !['INTACT', 'BREAKDOWN'].includes(uld.handlingType)) {
        sendJson(context, 400, {
          ok: false,
          error: `${uld.uldNumber}: handlingType must be INTACT or BREAKDOWN`
        });
        return;
      }

      if (
        uld.weightKg !== null &&
        (!Number.isFinite(uld.weightKg) || uld.weightKg < 0)
      ) {
        sendJson(context, 400, {
          ok: false,
          error: `${uld.uldNumber}: invalid weightKg`
        });
        return;
      }
    }

    const duplicateCheck = new Set();
    for (const uld of normalisedUlds) {
      if (duplicateCheck.has(uld.uldNumber)) {
        sendJson(context, 400, {
          ok: false,
          error: `Duplicate ULD in upload: ${uld.uldNumber}`
        });
        return;
      }
      duplicateCheck.add(uld.uldNumber);
    }

    pool = await new sql.ConnectionPool(connectionString).connect();
    transaction = new sql.Transaction(pool);
    await transaction.begin();

    await acquireFlightIdentityLock(
      transaction,
      sql,
      operatingDate,
      flightNumber
    );

    const flightCandidates = await new sql.Request(transaction)
      .input('OperatingDate', sql.Date, operatingDate)
      .query(`
        SELECT FlightId, FlightNumber
        FROM dbo.Flights
        WHERE OperatingDate = @OperatingDate;
      `);

    const existingFlights = findFlightsByIdentity(
      flightCandidates.recordset,
      flightNumber
    );

    if (existingFlights.length > 1) {
      await transaction.rollback();
      transaction = null;
      sendJson(context, 409, {
        ok: false,
        error: 'Multiple flights have the same canonical identity',
        code: 'FLIGHT_IDENTITY_CONFLICT',
        flightIds: existingFlights.map(existing => existing.FlightId)
      });
      return;
    }

    if (existingFlights.length === 1) {
      const existingFlightId = existingFlights[0].FlightId;
      if (direction === 'EXPORT') {
        const finalResult = await new sql.Request(transaction)
          .input('ExistingFinalFlightId', sql.BigInt, existingFlightId)
          .query(`SELECT FinalManifestId FROM dbo.ExportManifestFinals WITH (UPDLOCK,HOLDLOCK)
            WHERE FlightId=@ExistingFinalFlightId;`);
        if (finalResult.recordset.length) {
          await transaction.rollback();
          transaction = null;
          sendJson(context, 409, {
            ok: false,
            code: 'EXPORT_MANIFEST_ALREADY_FINAL',
            error: 'This flight is FINAL.',
            flightId: existingFlightId
          });
          return;
        }
      }
      await transaction.rollback();
      transaction = null;
      sendJson(context, 409, {
        ok: false,
        error: 'Flight already exists',
        flightId: existingFlights[0].FlightId
      });
      return;
    }

    await requireOperationalCapability(transaction, sql, actor, {
      Direction: direction,
      OriginAirport: originAirport,
      DestinationAirport: destinationAirport
    }, 'UPLOAD_FLIGHT_DATA');

    const flightResult = await new sql.Request(transaction)
      .input('FlightNumber', sql.NVarChar(12), flightNumber)
      .input('OperatingDate', sql.Date, operatingDate)
      .input('Direction', sql.VarChar(6), direction)
      .input('AirlineCode', sql.NVarChar(3), airlineCode)
      .input('OriginAirport', sql.NVarChar(4), originAirport)
      .input('DestinationAirport', sql.NVarChar(4), destinationAirport)
      .input('SourceFileName', sql.NVarChar(260), sourceFileName)
      .input('SourceType', sql.NVarChar(50), 'CARGORUN_UPLOAD')
      .input('CreatedByDisplayName', sql.NVarChar(150), actor.displayName)
      .query(`
        INSERT INTO dbo.Flights
        (
          FlightNumber,
          OperatingDate,
          Direction,
          AirlineCode,
          OriginAirport,
          DestinationAirport,
          SourceFileName,
          SourceType,
          CreatedByDisplayName
        )
        OUTPUT
          INSERTED.FlightId,
          INSERTED.FlightNumber,
          INSERTED.OperatingDate,
          INSERTED.Direction,
          INSERTED.CreatedAtUtc
        VALUES
        (
          @FlightNumber,
          @OperatingDate,
          @Direction,
          @AirlineCode,
          @OriginAirport,
          @DestinationAirport,
          @SourceFileName,
          @SourceType,
          @CreatedByDisplayName
        );
      `);

    const createdFlight = flightResult.recordset[0];
    const flightId = createdFlight.FlightId;

    await new sql.Request(transaction)
      .input('FlightId', sql.BigInt, flightId)
      .input('FileName', sql.NVarChar(260), sourceFileName)
      .input('UploadType', sql.NVarChar(50), direction)
      .input('UploadedByDisplayName', sql.NVarChar(150), actor.displayName)
      .query(`
        INSERT INTO dbo.FlightUploads
        (
          FlightId,
          FileName,
          UploadType,
          UploadedByDisplayName
        )
        VALUES
        (
          @FlightId,
          @FileName,
          @UploadType,
          @UploadedByDisplayName
        );
      `);

    const startingStatus =
      direction === 'EXPORT'
        ? 'WAREHOUSE'
        : 'UNARRIVED';

    const createdUlds = [];

    for (const item of normalisedUlds) {
      const uldResult = await new sql.Request(transaction)
        .input('FlightId', sql.BigInt, flightId)
        .input('UldNumber', sql.NVarChar(20), item.uldNumber)
        .input('HandlingType', sql.VarChar(20), item.handlingType)
        .input('WeightKg', sql.Decimal(10, 1), item.weightKg)
        .input('Remarks', sql.NVarChar(500), item.remarks)
        .input('PriorityText', sql.NVarChar(100), item.priorityText)
        .input('CurrentStatus', sql.VarChar(30), startingStatus)
        .query(`
          INSERT INTO dbo.ULDs
          (
            FlightId,
            UldNumber,
            HandlingType,
            WeightKg,
            Remarks,
            PriorityText,
            CurrentStatus
          )
          OUTPUT
            INSERTED.UldId,
            INSERTED.UldNumber,
            INSERTED.CurrentStatus
          VALUES
          (
            @FlightId,
            @UldNumber,
            @HandlingType,
            @WeightKg,
            @Remarks,
            @PriorityText,
            @CurrentStatus
          );
        `);

      const createdUld = uldResult.recordset[0];

      for (const code of item.shcs) {
        await new sql.Request(transaction)
          .input('UldId', sql.BigInt, createdUld.UldId)
          .input('Code', sql.NVarChar(10), code)
          .query(`
            INSERT INTO dbo.UldSpecialHandlingCodes (UldId, Code)
            VALUES (@UldId, @Code);
          `);
      }

      createdUlds.push({
        ...createdUld,
        shcs: item.shcs
      });
    }

    await transaction.commit();
    transaction = null;

    sendJson(context, 201, {
      ok: true,
      uploadedBy: actor.displayName,
      flight: createdFlight,
      uldCount: createdUlds.length,
      ulds: createdUlds
    });

  } catch (err) {
    if (transaction) {
      try { await transaction.rollback(); } catch {}
    }

    if (sendOperationalAuthorizationError(context, err, sendJson)) return;
    if (err instanceof ExportUwsError || err instanceof ManifestFinalError) {
      sendJson(context, err.status || 400, {
        ok: false,
        code: err.code,
        error: err.message,
        ...(err.flightIds ? { flightIds: err.flightIds } : {}),
        ...(err.collisions ? { collisions: err.collisions } : {})
      });
      return;
    }

    context.log.error('Manifest upload failed', err);

    sendJson(context, 500, {
      ok: false,
      error: 'Manifest upload failed'
    });

  } finally {
    try { await pool?.close(); } catch {}
  }
};
