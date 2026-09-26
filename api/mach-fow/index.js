const sql = require('mssql');
const { normalizeUldNumber } = require('../shared/uld');
const {
  acquireFlightIdentityLock,
  findFlightsByIdentity
} = require('../shared/flight');
const {
  canonicalizeDocumentCorId,
  DocumentCorIdValidationError
} = require('../shared/document-cor-id');
const crypto = require('crypto');
const { insertAuditEvent } = require('../shared/audit');
const {
  authenticatedActor,
  requireOperationalStations,
  resolveActorAccess,
  authorizeRequestedStation,
  requireOperationalCapability,
  sendOperationalAuthorizationError
} = require('../shared/operational-authorization');
const {
  MACHINE_STATION_CODE,
  resolveAuthorizedStation,
  resolveStationByCode
} = require('../shared/station');

/* ============================================================
   CargoRun MACH FOW Receiver

   OPERATIONAL RULE:
   ------------------------------------------------------------
   CargoRun works at ULD level, NOT AWB level.

   ONE FlightId + ONE normalised ULD number
   = ONE operational CargoRun ULD.

   Different:
   - DocumentCorID
   - AWB / MAWB
   - FOW message

   DO NOT create another operational ULD if the same ULD
   already exists on the same flight.

   DocumentCorID is canonical uppercase ASCII (letters, digits
   and hyphens, at most 100 characters) and globally identifies
   a MACH message. Raw XML retains the original evidence.
   ============================================================ */


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


function getHeader(req, name) {
  const h = req?.headers || {};

  if (typeof h.get === 'function') {
    return h.get(name);
  }

  return (
    h[name] ||
    h[name.toLowerCase()] ||
    h[name.toUpperCase()] ||
    null
  );
}


function secureEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));

  if (!aa.length || aa.length !== bb.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}


function machineAuth(req) {
  const expected = String(
    process.env.MACH_FOW_INGEST_TOKEN || ''
  ).trim();

  if (!expected) {
    return {
      configured: false,
      ok: false,
      mode: null
    };
  }

  let supplied = '';
  let mode = null;

  const direct = String(
    getHeader(req, 'x-cargorun-mach-key') || ''
  ).trim();

  if (direct) {
    supplied = direct;
    mode = 'header';
  }

  if (!supplied) {
    const auth = String(
      getHeader(req, 'authorization') || ''
    ).trim();

    const m = auth.match(/^Bearer\s+(.+)$/i);

    if (m) {
      supplied = m[1].trim();
      mode = 'bearer';
    }
  }

  if (
    !supplied &&
    String(
      process.env.MACH_FOW_ALLOW_QUERY_TOKEN || ''
    ).toLowerCase() === 'true'
  ) {
    const q = String(req?.query?.key || '').trim();

    if (q) {
      supplied = q;
      mode = 'query';
    }
  }

  return {
    configured: true,
    ok: secureEqual(expected, supplied),
    mode: mode || null
  };
}


function actorFromRequest(req) {
  try {
    const raw = getHeader(
      req,
      'x-ms-client-principal'
    );

    if (!raw) {
      return null;
    }

    const p = JSON.parse(
      Buffer.from(raw, 'base64').toString('utf8')
    );

    const roles = Array.isArray(p.userRoles)
      ? p.userRoles
      : [];

    if (!roles.includes('authenticated')) {
      return null;
    }

    return {
      displayName: String(
        p.userDetails || 'Authenticated user'
      ).slice(0, 150),

      reference: String(
        p.userId || ''
      ).slice(0, 150)
    };

  } catch {
    return null;
  }
}


function clean(v, max = 200) {
  if (v === null || v === undefined) {
    return null;
  }

  const s = String(v).trim();

  return s
    ? s.slice(0, max)
    : null;
}


/* ============================================================
   NORMALISE ULD

   These all become the same value:

   AKE 12345 CX
   AKE-12345-CX
   ake12345cx
   AKE12345CX

   => AKE12345CX
   ============================================================ */

function xmlRawText(xml, tag) {
  const re = new RegExp(
    `<(?:(?:\\w+):)?${tag}\\b[^>]*>` +
    `([\\s\\S]*?)` +
    `<\\/(?:(?:\\w+):)?${tag}>`,
    'i'
  );

  const m = String(xml || '').match(re);

  return m
    ? String(m[1])
        .replace(
          /<!\[CDATA\[([\s\S]*?)\]\]>/g,
          '$1'
        )
        .replace(/<[^>]+>/g, '')
    : '';
}


function xmlText(xml, tag) {
  return xmlRawText(xml, tag).trim();
}


function xmlBlocks(xml, tag) {
  const re = new RegExp(
    `<(?:(?:\\w+):)?${tag}\\b[^>]*>` +
    `([\\s\\S]*?)` +
    `<\\/(?:(?:\\w+):)?${tag}>`,
    'gi'
  );

  const out = [];

  let m;

  while (
    (m = re.exec(String(xml || ''))) !== null
  ) {
    out.push(m[1]);
  }

  return out;
}


function padFlight(carrier, num) {
  const c = String(carrier || '')
    .trim()
    .toUpperCase();

  const n = String(num || '')
    .trim()
    .toUpperCase();

  if (/^\d+$/.test(n)) {
    return c + n.padStart(4, '0');
  }

  return c + n;
}


function parseOperatingDate(xml) {
  const direct = xmlText(
    xml,
    'StsDatt'
  );

  const months = {
    JAN: 1,
    FEB: 2,
    MAR: 3,
    APR: 4,
    MAY: 5,
    JUN: 6,
    JUL: 7,
    AUG: 8,
    SEP: 9,
    OCT: 10,
    NOV: 11,
    DEC: 12
  };

  let m = direct.match(
    /^(\d{1,2})[-\s]([A-Z]{3})[-\s](\d{4})$/i
  );

  if (m) {
    const mon =
      months[m[2].toUpperCase()];

    if (mon) {
      return (
        `${m[3]}-` +
        `${String(mon).padStart(2, '0')}-` +
        `${String(Number(m[1])).padStart(2, '0')}`
      );
    }
  }

  const day = Number(
    xmlText(xml, 'StsDay')
  );

  const mon =
    months[
      String(
        xmlText(xml, 'StsMonth')
      ).toUpperCase()
    ];

  const year = Number(
    xmlText(xml, 'StsYear')
  );

  if (day && mon && year) {
    return (
      `${year}-` +
      `${String(mon).padStart(2, '0')}-` +
      `${String(day).padStart(2, '0')}`
    );
  }

  return null;
}


function parseEventLocal(
  operatingDate,
  time
) {
  const t = String(time || '');

  if (
    !operatingDate ||
    !/^(?:[01]\d|2[0-3])[0-5]\d$/.test(t)
  ) {
    return null;
  }

  return (
    `${operatingDate}T` +
    `${t.slice(0, 2)}:` +
    `${t.slice(2, 4)}:00`
  );
}

// SQL datetime2 carries no offset. Preserve the MACH wall-clock digits without
// claiming that StsTime is UTC; station-zone conversion requires a future schema
// that can retain both the raw local value and the derived UTC instant.
function preserveLocalWallClock(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  return new Date(Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6])
  ));
}


/* ============================================================
   PARSE ULDs

   AWB IS DELIBERATELY NOT PART OF THE ULD IDENTITY.

   Duplicate ULD numbers inside the same XML message are
   collapsed here before database processing.
   ============================================================ */

function parseUlds(xml) {
  const blocks = xmlBlocks(
    xml,
    'FSUMessageULDList'
  );

  const list = [];

  for (const block of blocks) {

    const type = xmlText(
      block,
      'ULDTyp'
    ).toUpperCase();

    const serial = xmlText(
      block,
      'ULDSrl'
    ).toUpperCase();

    const owner = xmlText(
      block,
      'ULDOwnr'
    ).toUpperCase();

    if (
      type &&
      serial &&
      owner
    ) {
      const number =
        normalizeUldNumber(
          `${type}${serial}${owner}`
        );

      list.push({
        type,
        serial,
        owner,
        number
      });
    }
  }

  /*
     Remove duplicate ULDs from the same FOW message.
  */

  return [
    ...new Map(
      list.map(
        x => [x.number, x]
      )
    ).values()
  ];
}


function extractRawXml(req) {
  if (
    typeof req.body === 'string'
  ) {
    return req.body.trim();
  }

  if (
    req.body &&
    typeof req.body.xml === 'string'
  ) {
    return req.body.xml.trim();
  }

  if (
    typeof req.rawBody === 'string'
  ) {
    return req.rawBody.trim();
  }

  return '';
}


/* ============================================================
   EXACT MESSAGE DUPLICATE CHECK

   This protects against MACH sending the same canonical
   DocumentCorID again.

   This is DIFFERENT from ULD deduplication.
   ============================================================ */

function requestFor(executor) {
  return typeof executor.request === 'function'
    ? executor.request()
    : new sql.Request(executor);
}

async function existingMessage(
  executor,
  documentCorId
) {
  const canonicalDocumentCorId = canonicalizeDocumentCorId(documentCorId);
  const r = await requestFor(executor)
    .input(
      'DocumentCorID',
      sql.NVarChar(100),
      canonicalDocumentCorId
    )
    .query(`
      SELECT TOP 1
        m.*,
        f.FlightNumber AS MatchedFlightNumber,
        f.StationId AS MatchedFlightStationId,
        f.Direction AS MatchedFlightDirection,
        f.OriginAirport AS MatchedFlightOriginAirport,
        f.DestinationAirport AS MatchedFlightDestinationAirport

      FROM dbo.IncomingMachMessages m

      LEFT JOIN dbo.Flights f
        ON f.FlightId =
           m.MatchedFlightId

      WHERE
        m.DocumentCorID COLLATE Latin1_General_100_BIN2 =
        @DocumentCorID COLLATE Latin1_General_100_BIN2;
    `);

  if (!r.recordset.length) {
    return null;
  }

  const row = r.recordset[0];

  const links = await requestFor(executor)
    .input(
      'MachMessageId',
      sql.BigInt,
      row.MachMessageId
    )
    .query(`
      SELECT UldNumber

      FROM dbo.MachFowShipments

      WHERE
        MachMessageId =
        @MachMessageId

      ORDER BY UldNumber;
    `);

  return {
    row,
    ulds:
      links.recordset.map(
        x => x.UldNumber
      )
  };
}

async function existingMessageIdentity(executor, documentCorId) {
  const canonicalDocumentCorId = canonicalizeDocumentCorId(documentCorId);
  const result = await requestFor(executor)
    .input('DocumentCorID', sql.NVarChar(100), canonicalDocumentCorId)
    .query(`SELECT TOP (1) m.MachMessageId,m.StationId,m.MatchedFlightId,
        f.StationId AS MatchedFlightStationId
      FROM dbo.IncomingMachMessages m
      LEFT JOIN dbo.Flights f ON f.FlightId=m.MatchedFlightId
      WHERE m.DocumentCorID COLLATE Latin1_General_100_BIN2
        = @DocumentCorID COLLATE Latin1_General_100_BIN2;`);
  return result.recordset[0] || null;
}

function documentIdentityLockResource(documentCorId) {
  return `CargoRun:DocumentCorID:v2:${canonicalizeDocumentCorId(documentCorId)}`;
}

async function acquireDocumentIdentityLock(transaction, documentCorId) {
  const resource = documentIdentityLockResource(documentCorId);
  const result = await new sql.Request(transaction)
    .input('DocumentIdentityLockResource', sql.NVarChar(255), resource)
    .query(`
      DECLARE @LockResult int;
      EXEC @LockResult = sys.sp_getapplock
        @Resource = @DocumentIdentityLockResource,
        @LockMode = 'Exclusive',
        @LockOwner = 'Transaction',
        @LockTimeout = 15000;
      SELECT @LockResult AS LockResult;
    `);
  const lockResult = result.recordset?.[0]?.LockResult;
  if (
    typeof lockResult !== 'number' ||
    !Number.isFinite(lockResult) ||
    !Number.isInteger(lockResult) ||
    (lockResult !== 0 && lockResult !== 1)
  ) {
    throw new Error(`Could not lock MACH document identity (${String(lockResult)})`);
  }
  return resource;
}


/* ============================================================
   MAIN FUNCTION
   ============================================================ */

module.exports = async function(
  context,
  req
) {

  let pool;
  let tx;
  let actor = null;
  let liveRequest = false;
  let operationalStation = null;
  let documentCorId = null;

  try {

    const cs =
      process.env
        .DATABASE_CONNECTION_STRING;

    if (!cs) {
      sendJson(
        context,
        503,
        {
          ok: false,
          error:
            'Service configuration is unavailable'
        }
      );

      return;
    }


    const machine =
      machineAuth(req);

    if (req.method === 'GET' || (req.method === 'POST' && !machine.ok)) {
      try {
        actor = authenticatedActor(req);
      } catch (error) {
        if (sendOperationalAuthorizationError(context, error, sendJson)) return;
        throw error;
      }
    }


    /* --------------------------------------------------------
       SECURITY
       -------------------------------------------------------- */

    if (
      req.method === 'GET' &&
      !actor
    ) {
      sendJson(
        context,
        403,
        {
          ok: false,
          error:
            'Microsoft Entra sign-in is required to view the MACH FOW intake log'
        }
      );

      return;
    }


    if (
      req.method === 'POST' &&
      !actor &&
      !machine.ok
    ) {
      sendJson(
        context,
        403,
        {
          ok: false,
          error:
            machine.configured
              ? 'MACH receiver authentication failed'
              : 'MACH live receiver is not configured'
        }
      );

      return;
    }


    pool =
      await new sql.ConnectionPool(
        cs
      ).connect();


    /* ========================================================
       GET
       ======================================================== */

    if (req.method === 'GET') {

      const access =
        await resolveActorAccess(
          pool,
          sql,
          actor
        );

      const requestedStation = authorizeRequestedStation({
        userAccess: access,
        stationId: req.query?.stationId,
        requiredCapability: 'VIEW_SUPERVISOR'
      });

      const messageRequest =
        pool.request()
          .input('StationId', sql.BigInt, requestedStation.stationId);

      const r =
        await messageRequest
          .query(`
            SELECT TOP 50

              m.MachMessageId,
              m.DocumentCorID,
              m.MessageType,
              m.StatusCode,
              m.SourceType,
              m.RecipientCode,
              m.AirlineCode,

              COALESCE(
                f.FlightNumber,
                m.FlightNumber
              ) AS FlightNumber,

              m.OperatingDate,
              m.OriginAirport,
              m.DestinationAirport,
              m.MawbNumber,
              m.Pieces,
              CONVERT(
                varchar(33),
                m.EventLocalDateTime,
                126
              ) AS EventLocalDateTime,
              m.ReceivedAtUtc,
              m.ProcessedAtUtc,
              m.ProcessingStatus,
              m.CreatedFlight,
              m.ErrorText,

              (
                SELECT COUNT(*)

                FROM dbo.MachFowShipments x

                WHERE
                  x.MachMessageId =
                  m.MachMessageId
                  AND x.FlightId =
                  f.FlightId

              ) AS UldCount,

              (
                SELECT STRING_AGG(
                  x.UldNumber,
                  ', '
                )

                FROM dbo.MachFowShipments x

                WHERE
                  x.MachMessageId =
                  m.MachMessageId
                  AND x.FlightId =
                  f.FlightId

              ) AS UldNumbers

            FROM dbo.IncomingMachMessages m

            INNER JOIN dbo.Flights f
              ON f.FlightId =
                 m.MatchedFlightId

            WHERE
              m.StationId=@StationId
              AND f.StationId=@StationId

            ORDER BY
              m.ReceivedAtUtc DESC,
              m.MachMessageId DESC;
          `);


      const stats =
        await (() => {
          const statsRequest = pool.request();
          statsRequest.input('StationId', sql.BigInt, requestedStation.stationId);
          return statsRequest
          .query(`
            SELECT

              SUM(
                CASE
                  WHEN
                    m.SourceType =
                    'MACH_FOW_LIVE'
                  THEN 1
                  ELSE 0
                END
              ) AS LiveMessageCount,

              MAX(
                CASE
                  WHEN
                    m.SourceType =
                    'MACH_FOW_LIVE'
                  THEN m.ReceivedAtUtc
                END
              ) AS LastLiveReceivedAtUtc

            FROM dbo.IncomingMachMessages m
            INNER JOIN dbo.Flights f ON f.FlightId=m.MatchedFlightId
            WHERE m.StationId=@StationId AND f.StationId=@StationId;
          `);
        })();


      sendJson(
        context,
        200,
        {
          ok: true,

          receiver: {
            configured:
              Boolean(
                process.env
                  .MACH_FOW_INGEST_TOKEN
              ),

            endpoint:
              '/api/mach-fow',

            preferredAuthentication:
              'X-CargoRun-MACH-Key header or Bearer token',

            queryTokenEnabled:
              String(
                process.env
                  .MACH_FOW_ALLOW_QUERY_TOKEN ||
                ''
              ).toLowerCase() ===
              'true',

            liveMessageCount:
              Number(
                stats.recordset?.[0]
                  ?.LiveMessageCount ||
                0
              ),

            lastLiveReceivedAtUtc:
              stats.recordset?.[0]
                ?.LastLiveReceivedAtUtc ||
              null
          },

          messages:
            r.recordset
        }
      );

      return;
    }


    /* ========================================================
       POST
       ======================================================== */

    const xml =
      extractRawXml(req);


    if (
      !xml ||
      !/<(?:\w+:)?FSUMessage\b/i.test(
        xml
      )
    ) {
      sendJson(
        context,
        400,
        {
          ok: false,
          error:
            'Paste a valid FSUMessage XML payload'
        }
      );

      return;
    }


    if (xml.length > 500000) {
      sendJson(
        context,
        413,
        {
          ok: false,
          error:
            'FOW XML is too large'
        }
      );

      return;
    }


    /* --------------------------------------------------------
       PARSE FOW
       -------------------------------------------------------- */

    try {
      documentCorId = canonicalizeDocumentCorId(
        xmlRawText(xml, 'DocumentCorID')
      );
    } catch (error) {
      if (!(error instanceof DocumentCorIdValidationError)) throw error;
      sendJson(context, error.status, {
        ok: false,
        code: error.code,
        error: error.message
      });
      return;
    }


    const messageType =
      clean(
        xmlText(
          xml,
          'MessageType'
        ),
        20
      )?.toUpperCase();


    const statusCode =
      clean(
        xmlText(
          xml,
          'StatusCode'
        ),
        20
      )?.toUpperCase();


    const recipientCode =
      clean(
        xmlText(
          xml,
          'AddressCode'
        ),
        20
      )?.toUpperCase();


    const carrier =
      clean(
        xmlText(
          xml,
          'StsCar'
        ),
        5
      )?.toUpperCase();


    const carrierNum =
      clean(
        xmlText(
          xml,
          'StsCarNum'
        ),
        12
      )?.toUpperCase();


    const operatingDate =
      parseOperatingDate(xml);


    const segmentDeparture =
      clean(
        xmlText(
          xml,
          'StsSegDep'
        ),
        4
      )?.toUpperCase();


    const origin =
      segmentDeparture ||
      clean(
        xmlText(
          xml,
          'OrigApt'
        ),
        4
      )?.toUpperCase();


    const destination =
      clean(
        xmlText(
          xml,
          'StsSegArr'
        ) ||
        xmlText(
          xml,
          'DestApt'
        ),
        4
      )?.toUpperCase();


    const eventStation =
      clean(
        xmlText(
          xml,
          'StsApt'
        ),
        4
      )?.toUpperCase();


    const station =
      eventStation ||
      origin;


    const eventTime =
      clean(
        xmlText(
          xml,
          'StsTime'
        ),
        4
      );


    const eventLocal =
      parseEventLocal(
        operatingDate,
        eventTime
      );


    const docPrefix =
      clean(
        xmlText(
          xml,
          'DocPrfx'
        ),
        4
      );


    const docNum =
      clean(
        xmlText(
          xml,
          'DocNum'
        ),
        20
      );


    const mawb =
      docPrefix && docNum
        ? `${docPrefix}-${docNum}`
        : null;


    const piecesRaw =
      xmlText(
        xml,
        'StsPcs'
      ) ||
      xmlText(
        xml,
        'ConTPPcs'
      );


    const pieces =
      piecesRaw &&
      Number.isFinite(
        Number(piecesRaw)
      )
        ? Number(piecesRaw)
        : null;


    const ulds =
      parseUlds(xml);


    const live =
      Boolean(machine.ok);

    liveRequest = live;


    const source =
      live
        ? 'MACH_FOW_LIVE'
        : 'MACH_FOW_SIMULATOR';


    const processor =
      live
        ? {
            displayName:
              'MACH HTTP Feed',

            reference:
              `machine:${
                machine.mode ||
                'token'
              }`
          }
        : actor;


    /* --------------------------------------------------------
       VALIDATION
       -------------------------------------------------------- */

    if (
      messageType !== 'FSU' ||
      statusCode !== 'FOW'
    ) {
      sendJson(
        context,
        422,
        {
          ok: false,
          error:
            `Step 6A only accepts FSU/FOW messages ` +
            `(received ${
              messageType || '—'
            }/${
              statusCode || '—'
            })`
        }
      );

      return;
    }


    if (
      !carrier ||
      !carrierNum ||
      !operatingDate
    ) {
      sendJson(
        context,
        422,
        {
          ok: false,
          error:
            'FOW must include carrier, flight number and operating date'
        }
      );

      return;
    }


    const access = live
      ? null
      : await requireOperationalStations(pool, sql, actor, 'UPLOAD_FLIGHT_DATA');
    operationalStation = live
      ? await resolveStationByCode(pool, sql, MACHINE_STATION_CODE)
      : await resolveAuthorizedStation(pool, sql, access, station || origin);

    if (
      (eventStation && eventStation !== operationalStation.stationCode) ||
      (segmentDeparture && segmentDeparture !== operationalStation.stationCode) ||
      (!eventStation && origin && origin !== operationalStation.stationCode)
    ) {
      sendJson(
        context,
        422,
        {
          ok: false,
          error:
            `The message station does not match the authorized handling station. ` +
            `Message station is ${
              station ||
              origin ||
              'unknown'
            }`
        }
      );

      return;
    }


    if (!ulds.length || ulds.some(item => !item.number || item.number.length > 30)) {
      sendJson(
        context,
        422,
        {
          ok: false,
          error:
            'FOW must contain nonempty ULD identifiers of at most 30 characters after normalization'
        }
      );

      return;
    }


    /* ========================================================
       DUPLICATE LAYER 1
       SAME DocumentCorID

       Exact same MACH message = ignore.
       ======================================================== */

    const requestedFlight =
      padFlight(
        carrier,
        carrierNum
      );

    if (!live) {
      const authorizationCandidates = await pool.request()
        .input('AuthorizationOperatingDate', sql.Date, operatingDate)
        .input('AuthorizationStationId', sql.BigInt, operationalStation.stationId)
        .query(`SELECT FlightId,StationId,FlightNumber,Direction,OriginAirport,DestinationAirport
          FROM dbo.Flights WHERE StationId=@AuthorizationStationId AND OperatingDate=@AuthorizationOperatingDate;`);
      const authorizationMatches = findFlightsByIdentity(authorizationCandidates.recordset, requestedFlight);

      for (const candidate of authorizationMatches) {
        await requireOperationalCapability(
          pool,
          sql,
          actor,
          candidate,
          'UPLOAD_FLIGHT_DATA'
        );
      }

      if (authorizationMatches.length > 1) {
        sendJson(context, 409, {
          ok: false,
          code: 'FLIGHT_IDENTITY_CONFLICT',
          error: 'Multiple flights have the same canonical identity',
          flightIds: authorizationMatches.map(existing => existing.FlightId)
        });
        return;
      }
      const authorizationFlight = authorizationMatches[0] || { Direction: 'EXPORT' };
      if (authorizationMatches[0] && String(authorizationFlight.Direction || '').toUpperCase() !== 'EXPORT') {
        sendJson(context, 409, {
          ok: false,
          code: 'FLIGHT_IDENTITY_CONFLICT',
          error: 'Flight identity already exists with incompatible direction',
          flightIds: [authorizationFlight.FlightId]
        });
        return;
      }
    }

    /* ========================================================
       START TRANSACTION
       ======================================================== */

    tx =
      new sql.Transaction(pool);

    await tx.begin();

    await acquireDocumentIdentityLock(tx, documentCorId);

    const duplicateIdentity = await existingMessageIdentity(tx, documentCorId);
    if (duplicateIdentity) {
      const duplicateStationId = duplicateIdentity.MatchedFlightStationId || duplicateIdentity.StationId;
      if (String(duplicateStationId || '') !== String(operationalStation.stationId)) {
        await tx.rollback();
        tx = null;
        sendJson(context, 409, {
          ok: false,
          code: 'DOCUMENT_IDENTITY_CONFLICT',
          error: 'The MACH document identity is already assigned to another operation'
        });
        return;
      }

      if (!live) {
        await requireOperationalCapability(
          tx,
          sql,
          actor,
          { StationId: duplicateStationId },
          'UPLOAD_FLIGHT_DATA'
        );
      }

      const duplicate = await existingMessage(tx, documentCorId);
      if (!duplicate) throw new Error('MACH duplicate identity changed during authorization');
      await tx.rollback();
      tx = null;

      sendJson(context, 200, {
        ok: true,
        duplicate: true,
        duplicateType: 'DOCUMENT',
        messageId: duplicate.row.MachMessageId,
        flightId: duplicate.row.MatchedFlightId,
        flightNumber: duplicate.row.MatchedFlightNumber || duplicate.row.FlightNumber,
        operatingDate: duplicate.row.OperatingDate,
        ulds: duplicate.ulds,
        processingStatus: duplicate.row.ProcessingStatus,
        sourceType: duplicate.row.SourceType,
        live: String(duplicate.row.SourceType || '').toUpperCase() === 'MACH_FOW_LIVE'
      });
      return;
    }

    await acquireFlightIdentityLock(tx, sql, operationalStation.stationId, operatingDate, requestedFlight);
    if (!live) {
      const authorizationCandidates = await new sql.Request(tx)
        .input('LockedAuthorizationOperatingDate', sql.Date, operatingDate)
        .input('LockedAuthorizationStationId', sql.BigInt, operationalStation.stationId)
        .query(`SELECT FlightId,StationId,FlightNumber,Direction,OriginAirport,DestinationAirport
          FROM dbo.Flights WHERE StationId=@LockedAuthorizationStationId AND OperatingDate=@LockedAuthorizationOperatingDate;`);
      const authorizationMatches = findFlightsByIdentity(authorizationCandidates.recordset, requestedFlight);

      const flightsToAuthorize =
        authorizationMatches.length
          ? authorizationMatches
          : [{
              StationId: operationalStation.stationId,
              Direction: 'EXPORT',
              OriginAirport:
                origin || station,
              DestinationAirport:
                destination
            }];

      for (const candidate of flightsToAuthorize) {
        await requireOperationalCapability(
          tx,
          sql,
          actor,
          candidate,
          'UPLOAD_FLIGHT_DATA'
        );
      }

      if (authorizationMatches.length > 1) {
        await tx.rollback();
        tx = null;
        sendJson(context, 409, {
          ok: false,
          code: 'FLIGHT_IDENTITY_CONFLICT',
          error: 'Multiple flights have the same canonical identity',
          flightIds: authorizationMatches.map(existing => existing.FlightId)
        });
        return;
      }
    }


    /* --------------------------------------------------------
       STORE INCOMING MACH MESSAGE

       Every NEW DocumentCorID is still logged even when its
       ULD already exists.

       This gives us full MACH traceability.
       -------------------------------------------------------- */

    const msgInsert =
      await new sql.Request(tx)

        .input(
          'DocumentCorID',
          sql.NVarChar(100),
          documentCorId
        )

        .input(
          'MessageType',
          sql.NVarChar(20),
          messageType
        )

        .input(
          'StatusCode',
          sql.NVarChar(20),
          statusCode
        )

        .input(
          'SourceType',
          sql.NVarChar(40),
          source
        )

        .input(
          'RecipientCode',
          sql.NVarChar(20),
          recipientCode
        )

        .input(
          'AirlineCode',
          sql.NVarChar(5),
          carrier
        )

        .input(
          'FlightNumber',
          sql.NVarChar(20),
          requestedFlight
        )

        .input(
          'OperatingDate',
          sql.Date,
          operatingDate
        )

        .input(
          'OriginAirport',
          sql.NVarChar(4),
          origin
        )

        .input(
          'DestinationAirport',
          sql.NVarChar(4),
          destination
        )

        .input(
          'StationAirport',
          sql.NVarChar(4),
          station
        )

        .input(
          'MawbNumber',
          sql.NVarChar(20),
          mawb
        )

        .input(
          'Pieces',
          sql.Int,
          pieces
        )

        .input(
          'EventLocalDateTime',
          sql.DateTime2,
          eventLocal
            ? preserveLocalWallClock(eventLocal)
            : null
        )

        .input(
          'RawXml',
          sql.NVarChar(
            sql.MAX
          ),
          xml
        )

        .input(
          'ProcessedByDisplayName',
          sql.NVarChar(150),
          processor?.displayName ||
          null
        )

        .input(
          'ProcessedByReference',
          sql.NVarChar(150),
          processor?.reference ||
          null
        )

        .input('StationId', sql.BigInt, operationalStation.stationId)

        .query(`
          INSERT INTO dbo.IncomingMachMessages
          (
            StationId,
            DocumentCorID,
            MessageType,
            StatusCode,
            SourceType,
            RecipientCode,
            AirlineCode,
            FlightNumber,
            OperatingDate,
            OriginAirport,
            DestinationAirport,
            StationAirport,
            MawbNumber,
            Pieces,
            EventLocalDateTime,
            RawXml,
            ProcessedByDisplayName,
            ProcessedByReference
          )

          OUTPUT
            INSERTED.MachMessageId

          VALUES
          (
            @StationId,
            @DocumentCorID,
            @MessageType,
            @StatusCode,
            @SourceType,
            @RecipientCode,
            @AirlineCode,
            @FlightNumber,
            @OperatingDate,
            @OriginAirport,
            @DestinationAirport,
            @StationAirport,
            @MawbNumber,
            @Pieces,
            @EventLocalDateTime,
            @RawXml,
            @ProcessedByDisplayName,
            @ProcessedByReference
          );
        `);


    const machMessageId =
      msgInsert.recordset[0]
        .MachMessageId;


    /* ========================================================
       FIND FLIGHT
       ======================================================== */

    const candidates =
      await new sql.Request(tx)

        .input(
          'OperatingDate',
          sql.Date,
          operatingDate
        )

        .input('StationId', sql.BigInt, operationalStation.stationId)

        .query(`
          SELECT
            FlightId,
            StationId,
            FlightNumber,
            Direction,
            FlightStatus

          FROM dbo.Flights

          WHERE
            StationId = @StationId AND OperatingDate =
            @OperatingDate;
        `);


    const matchingFlights =
      findFlightsByIdentity(
        candidates.recordset,
        requestedFlight
      );


    if (matchingFlights.length > 1) {
      await tx.rollback();
      tx = null;
      sendJson(context, 409, {
        ok: false,
        error: 'Multiple flights have the same canonical identity',
        code: 'FLIGHT_IDENTITY_CONFLICT',
        flightIds: matchingFlights.map(existing => existing.FlightId)
      });
      return;
    }


    let flight =
      matchingFlights[0] || null;


    if (
      flight &&
      String(flight.Direction || '').toUpperCase() !== 'EXPORT'
    ) {
      await tx.rollback();
      tx = null;
      sendJson(context, 409, {
        ok: false,
        error: 'Flight identity already exists with incompatible direction',
        code: 'FLIGHT_IDENTITY_CONFLICT',
        flightIds: [flight.FlightId]
      });
      return;
    }


    /* --------------------------------------------------------
       EXISTING FINALISED FLIGHT

       Manifest FINAL does not reopen or weaken the existing
       operational flight lifecycle. Preserve the established
       rejection before applying post-manifest FOW handling.
       -------------------------------------------------------- */

    if (
      flight &&
      String(
        flight.FlightStatus ||
        'ACTIVE'
      ).toUpperCase() !==
      'ACTIVE'
    ) {

      await tx.rollback();

      tx = null;

      sendJson(
        context,
        409,
        {
          ok: false,
          error:
            `${flight.FlightNumber} already exists for ` +
            `${operatingDate} but is ` +
            `${flight.FlightStatus}. ` +
            `CargoRun will not reopen a finalised flight.`
        }
      );

      return;
    }


    /* --------------------------------------------------------
       FINAL EXPORT MANIFEST

       The inbound MACH message remains durable evidence, but a
       final build must not be extended or mutate an existing ULD.
       This check runs under the same flight identity application
       lock used by FINAL confirmation.
       -------------------------------------------------------- */

    if (flight) {
      const finalResult = await new sql.Request(tx)
        .input('ManifestFinalFlightId', sql.BigInt, flight.FlightId)
        .query(`
          SELECT FinalManifestId
          FROM dbo.ExportManifestFinals WITH (UPDLOCK,HOLDLOCK)
          WHERE FlightId=@ManifestFinalFlightId;
        `);

      if (finalResult.recordset.length) {
        const existingResult = await new sql.Request(tx)
          .input('PostFinalFlightId', sql.BigInt, flight.FlightId)
          .query(`
            SELECT UldId,UldNumber,CurrentStatus
            FROM dbo.ULDs WITH (UPDLOCK,HOLDLOCK)
            WHERE FlightId=@PostFinalFlightId;
          `);
        const postFinalProcessed = [];

        for (const item of ulds) {
          const normalizedUld = normalizeUldNumber(item.number);
          if (!normalizedUld) continue;
          const matches = existingResult.recordset.filter(
            row => normalizeUldNumber(row.UldNumber) === normalizedUld
          );
          if (matches.length > 1) {
            await tx.rollback();
            tx = null;
            sendJson(context, 409, {
              ok: false,
              error: 'Multiple existing ULDs on this flight have the same normalized number',
              conflictingUldIds: matches.map(row => row.UldId)
            });
            return;
          }
          const existingUld = matches[0] || null;
          if (existingUld) {
            await new sql.Request(tx)
              .input('PostFinalMachMessageId', sql.BigInt, machMessageId)
              .input('PostFinalFlightLinkId', sql.BigInt, flight.FlightId)
              .input('PostFinalUldId', sql.BigInt, existingUld.UldId)
              .input('PostFinalUldNumber', sql.NVarChar(30), normalizedUld)
              .input('PostFinalMawbNumber', sql.NVarChar(20), mawb)
              .input('PostFinalPieces', sql.Int, pieces)
              .query(`INSERT INTO dbo.MachFowShipments
                (MachMessageId,FlightId,UldId,UldNumber,MawbNumber,Pieces)
                VALUES(@PostFinalMachMessageId,@PostFinalFlightLinkId,@PostFinalUldId,
                  @PostFinalUldNumber,@PostFinalMawbNumber,@PostFinalPieces);`);
          }
          postFinalProcessed.push({
            uldId: existingUld ? existingUld.UldId : null,
            uldNumber: normalizedUld,
            created: false,
            ignoredPostFinal: true,
            currentStatus: existingUld?.CurrentStatus || null
          });
        }

        await new sql.Request(tx)
          .input('IgnoredMachMessageId', sql.BigInt, machMessageId)
          .input('IgnoredMatchedFlightId', sql.BigInt, flight.FlightId)
          .query(`UPDATE dbo.IncomingMachMessages
            SET ProcessingStatus='PROCESSED_POST_FINAL',ProcessedAtUtc=SYSUTCDATETIME(),
              MatchedFlightId=@IgnoredMatchedFlightId,CreatedFlight=0
            WHERE MachMessageId=@IgnoredMachMessageId;`);

        await insertAuditEvent(tx, sql, {
          type: 'MACH FOW',
          action: 'POST_FINAL_FOW_IGNORED',
          actorDisplayName: processor?.displayName || 'MACH Feed',
          actorReference: processor?.reference || null,
          entityType: 'Flight',
          entityId: flight.FlightId,
          flightId: flight.FlightId,
          flightNumber: flight.FlightNumber,
          detail: `Post-FINAL FOW ${documentCorId} retained without changing expected membership`,
          details: {
            documentCorId,
            finalManifestId: String(finalResult.recordset[0].FinalManifestId),
            uldNumbers: postFinalProcessed.map(item => item.uldNumber),
            existingUldCount: postFinalProcessed.filter(item => item.uldId).length,
            ignoredNewUldCount: postFinalProcessed.filter(item => !item.uldId).length
          }
        });

        await tx.commit();
        tx = null;
        sendJson(context, 201, {
          ok: true,
          duplicate: false,
          sourceType: source,
          live,
          messageId: machMessageId,
          flightId: flight.FlightId,
          flightNumber: flight.FlightNumber,
          operatingDate,
          createdFlight: false,
          newUldCount: 0,
          existingUldCount: postFinalProcessed.filter(item => item.uldId).length,
          ignoredPostFinal: true,
          ulds: postFinalProcessed,
          mawb,
          pieces,
          eventLocalDateTime: eventLocal
        });
        return;
      }
    }


    let createdFlight =
      false;

    /* --------------------------------------------------------
       CREATE FLIGHT IF REQUIRED
       -------------------------------------------------------- */

    if (!flight) {

      const fr =
        await new sql.Request(tx)

          .input(
            'FlightNumber',
            sql.NVarChar(20),
            requestedFlight
          )

          .input(
            'OperatingDate',
            sql.Date,
            operatingDate
          )

          .input(
            'Direction',
            sql.VarChar(6),
            'EXPORT'
          )

          .input(
            'AirlineCode',
            sql.NVarChar(5),
            carrier
          )

          .input(
            'OriginAirport',
            sql.NVarChar(4),
            origin || operationalStation.stationCode
          )

          .input(
            'DestinationAirport',
            sql.NVarChar(4),
            destination
          )

          .input(
            'SourceType',
            sql.NVarChar(50),
            source
          )

          .input(
            'CreatedByDisplayName',
            sql.NVarChar(150),
            live
              ? 'MACH FOW Feed'
              : 'MACH FOW Simulator'
          )

          .input('StationId', sql.BigInt, operationalStation.stationId)

          .query(`
            INSERT INTO dbo.Flights
            (
              StationId,
              FlightNumber,
              OperatingDate,
              Direction,
              AirlineCode,
              OriginAirport,
              DestinationAirport,
              SourceType,
              CreatedByDisplayName
            )

            OUTPUT
              INSERTED.FlightId,
              INSERTED.FlightNumber,
              INSERTED.FlightStatus

            VALUES
            (
              @StationId,
              @FlightNumber,
              @OperatingDate,
              @Direction,
              @AirlineCode,
              @OriginAirport,
              @DestinationAirport,
              @SourceType,
              @CreatedByDisplayName
            );
          `);


      flight =
        fr.recordset[0];

      createdFlight =
        true;
    }


    /* ========================================================
       PROCESS ULDs

       THIS IS THE IMPORTANT PART.

       Unique operational identity:

           FlightId + UldNumber

       NOT:

           DocumentCorID + AWB + ULD

       ======================================================== */

    const processed = [];


    for (const item of ulds) {

      const normalizedUld =
        normalizeUldNumber(
          item.number
        );


      if (!normalizedUld) {
        continue;
      }


      /* ------------------------------------------------------
         LOCK + LOOKUP

         UPDLOCK/HOLDLOCK prevents two simultaneous FOW
         messages from both deciding the ULD does not exist.

         The SQL unique index is the final protection.
         ------------------------------------------------------ */

      const er =
        await new sql.Request(tx)

          .input(
            'FlightId',
            sql.BigInt,
            flight.FlightId
          )

          .query(`
            SELECT

              UldId,
              UldNumber,
              CurrentStatus

            FROM dbo.ULDs
            WITH
            (
              UPDLOCK,
              HOLDLOCK
            )

            WHERE
              FlightId =
              @FlightId;
          `);


      const matches = er.recordset.filter(
        row => normalizeUldNumber(row.UldNumber) === normalizedUld
      );
      if (matches.length > 1) {
        await tx.rollback();
        tx = null;
        sendJson(context, 409, {
          ok: false,
          error: 'Multiple existing ULDs on this flight have the same normalized number',
          conflictingUldIds: matches.map(row => row.UldId)
        });
        return;
      }

      let uld = matches[0] || null;


      let created =
        false;


      /* ======================================================
         NEW ULD

         First occurrence of this ULD on this flight.
         ====================================================== */

      if (!uld) {

        const ur =
          await new sql.Request(tx)

            .input(
              'FlightId',
              sql.BigInt,
              flight.FlightId
            )

            .input(
              'UldNumber',
              sql.NVarChar(30),
              normalizedUld
            )

            .input(
              'SourceType',
              sql.NVarChar(40),
              source
            )

            .input(
              'MachDocumentCorId',
              sql.NVarChar(100),
              documentCorId
            )

            .query(`
              INSERT INTO dbo.ULDs
              (
                FlightId,
                UldNumber,
                CurrentStatus,
                IdentityVerified,
                SourceType,
                FowReceivedAtUtc,
                MachDocumentCorId
              )

              OUTPUT
                INSERTED.UldId,
                INSERTED.UldNumber,
                INSERTED.CurrentStatus

              VALUES
              (
                @FlightId,
                @UldNumber,
                'WAREHOUSE',
                0,
                @SourceType,
                SYSUTCDATETIME(),
                @MachDocumentCorId
              );
            `);


        uld =
          ur.recordset[0];

        created =
          true;


        context.log(
          `[CargoRun FOW] NEW ULD ${normalizedUld} ` +
          `created on FlightId ${flight.FlightId}.`
        );

      } else {

        /* ====================================================
           EXISTING ULD

           Different FOW?
           Different DocumentCorID?
           Different AWB?

           DOES NOT MATTER.

           Reuse existing operational ULD.

           IMPORTANT:
           Do NOT reset CurrentStatus.
           Do NOT reset IdentityVerified.
           Do NOT create another ULD.

           Keep original MachDocumentCorId as the first FOW
           that introduced the ULD.
           ==================================================== */

        await new sql.Request(tx)

          .input(
            'UldId',
            sql.BigInt,
            uld.UldId
          )

          .input(
            'SourceType',
            sql.NVarChar(40),
            source
          )

          .input(
            'MachDocumentCorId',
            sql.NVarChar(100),
            documentCorId
          )

          .query(`
            UPDATE dbo.ULDs

            SET
              SourceType =
                COALESCE(
                  SourceType,
                  @SourceType
                ),

              FowReceivedAtUtc =
                COALESCE(
                  FowReceivedAtUtc,
                  SYSUTCDATETIME()
                ),

              MachDocumentCorId =
                COALESCE(
                  MachDocumentCorId,
                  @MachDocumentCorId
                )

            WHERE
              UldId =
              @UldId;
          `);


        context.log(
          `[CargoRun FOW] EXISTING ULD ${normalizedUld} ` +
          `reused on FlightId ${flight.FlightId}. ` +
          `No duplicate operational ULD created.`
        );
      }


      /* ======================================================
         FOW TRACEABILITY

         We still record that THIS MACH message referenced
         this ULD.

         That means we retain the AWB/FOW history without
         creating another operational ULD.
         ====================================================== */

      await new sql.Request(tx)

        .input(
          'MachMessageId',
          sql.BigInt,
          machMessageId
        )

        .input(
          'FlightId',
          sql.BigInt,
          flight.FlightId
        )

        .input(
          'UldId',
          sql.BigInt,
          uld.UldId
        )

        .input(
          'UldNumber',
          sql.NVarChar(30),
          normalizedUld
        )

        .input(
          'MawbNumber',
          sql.NVarChar(20),
          mawb
        )

        .input(
          'Pieces',
          sql.Int,
          pieces
        )

        .query(`
          INSERT INTO dbo.MachFowShipments
          (
            MachMessageId,
            FlightId,
            UldId,
            UldNumber,
            MawbNumber,
            Pieces
          )

          VALUES
          (
            @MachMessageId,
            @FlightId,
            @UldId,
            @UldNumber,
            @MawbNumber,
            @Pieces
          );
        `);


      processed.push({
        uldId:
          uld.UldId,

        uldNumber:
          normalizedUld,

        created,

        duplicateUld:
          !created,

        currentStatus:
          uld.CurrentStatus ||
          'WAREHOUSE'
      });
    }


    /* ========================================================
       MARK MACH MESSAGE PROCESSED
       ======================================================== */

    await new sql.Request(tx)

      .input(
        'MachMessageId',
        sql.BigInt,
        machMessageId
      )

      .input(
        'FlightId',
        sql.BigInt,
        flight.FlightId
      )

      .input(
        'CreatedFlight',
        sql.Bit,
        createdFlight
      )

      .query(`
        UPDATE dbo.IncomingMachMessages

        SET
          ProcessingStatus =
            'PROCESSED',

          ProcessedAtUtc =
            SYSUTCDATETIME(),

          MatchedFlightId =
            @FlightId,

          CreatedFlight =
            @CreatedFlight

        WHERE
          MachMessageId =
          @MachMessageId;
      `);


    await tx.commit();

    tx = null;


    /* --------------------------------------------------------
       RESPONSE
       -------------------------------------------------------- */

    const newUldCount =
      processed.filter(
        x => x.created
      ).length;


    const existingUldCount =
      processed.filter(
        x => !x.created
      ).length;


    sendJson(
      context,
      201,
      {
        ok: true,

        duplicate: false,

        sourceType:
          source,

        live,

        messageId:
          machMessageId,

        flightId:
          flight.FlightId,

        flightNumber:
          flight.FlightNumber,

        operatingDate,

        createdFlight,

        newUldCount,

        existingUldCount,

        ulds:
          processed,

        mawb,

        pieces,

        eventLocalDateTime:
          eventLocal
      }
    );


  } catch (err) {

    try {
      if (tx) {
        await tx.rollback();
      }
    } catch {}

    if (sendOperationalAuthorizationError(context, err, sendJson)) return;


    context.log.error(
      'MACH FOW intake failed',
      err
    );


    /* --------------------------------------------------------
       DocumentCorID race-condition protection

       If two copies of the exact same MACH message arrive
       simultaneously, SQL may reject the second insert.

       Retrieve the already-processed message and return it
       as a normal duplicate.
       -------------------------------------------------------- */

    if (
      err?.number === 2601 ||
      err?.number === 2627
    ) {

      try {

        const duplicateIdentity =
          await existingMessageIdentity(
            pool,
            documentCorId
          );


        if (duplicateIdentity && operationalStation) {

          const duplicateStationId = duplicateIdentity.MatchedFlightStationId || duplicateIdentity.StationId;
          if (String(duplicateStationId || '') !== String(operationalStation.stationId)) {
            sendJson(context, 409, {
              ok: false,
              code: 'DOCUMENT_IDENTITY_CONFLICT',
              error: 'The MACH document identity is already assigned to another operation'
            });
            return;
          }

          if (!liveRequest) {
            await requireOperationalCapability(
              pool,
              sql,
              actor,
              { StationId: duplicateStationId },
              'UPLOAD_FLIGHT_DATA'
            );
          }

          const dup = await existingMessage(pool, documentCorId);
          if (!dup) throw new Error('MACH duplicate identity changed during authorization');

          sendJson(
            context,
            200,
            {
              ok: true,

              duplicate: true,

              duplicateType:
                'DOCUMENT',

              messageId:
                dup.row
                  .MachMessageId,

              flightId:
                dup.row
                  .MatchedFlightId,

              flightNumber:
                dup.row
                  .MatchedFlightNumber ||
                dup.row
                  .FlightNumber,

              ulds:
                dup.ulds,

              processingStatus:
                dup.row
                  .ProcessingStatus,

              sourceType:
                dup.row
                  .SourceType,

              live:
                String(
                  dup.row
                    .SourceType ||
                  ''
                ).toUpperCase() ===
                'MACH_FOW_LIVE'
            }
          );

          return;
        }

      } catch (duplicateError) {
        if (
          sendOperationalAuthorizationError(
            context,
            duplicateError,
            sendJson
          )
        ) {
          return;
        }
      }
    }


    sendJson(
      context,
      500,
      {
        ok: false,

        error:
          'MACH FOW intake failed'
      }
    );

  } finally {

    try {
      await pool?.close();
    } catch {}

  }
};
