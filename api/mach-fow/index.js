const sql = require('mssql');
const crypto = require('crypto');

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

   DocumentCorID is still used to stop the exact same MACH
   message being processed twice.
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

function normalizeUldNumber(value) {
  if (!value) {
    return null;
  }

  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '');
}


function xmlText(xml, tag) {
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
        .trim()
    : '';
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


function flightKey(value) {
  const s = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');

  const m = s.match(
    /^([A-Z0-9]{2,3}?)(\d+)([A-Z]?)$/
  );

  if (!m) {
    return s;
  }

  return (
    `${m[1]}` +
    `${String(Number(m[2]))}` +
    `${m[3] || ''}`
  );
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
  if (
    !operatingDate ||
    !/^\d{4}$/.test(
      String(time || '')
    )
  ) {
    return null;
  }

  const t = String(time);

  return (
    `${operatingDate}T` +
    `${t.slice(0, 2)}:` +
    `${t.slice(2, 4)}:00`
  );
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

   This protects against MACH sending the exact same
   DocumentCorID again.

   This is DIFFERENT from ULD deduplication.
   ============================================================ */

async function existingMessage(
  pool,
  documentCorId
) {
  const r = await pool
    .request()
    .input(
      'DocumentCorID',
      sql.NVarChar(100),
      documentCorId
    )
    .query(`
      SELECT TOP 1
        m.*,
        f.FlightNumber AS MatchedFlightNumber

      FROM dbo.IncomingMachMessages m

      LEFT JOIN dbo.Flights f
        ON f.FlightId =
           m.MatchedFlightId

      WHERE
        m.DocumentCorID =
        @DocumentCorID;
    `);

  if (!r.recordset.length) {
    return null;
  }

  const row = r.recordset[0];

  const links = await pool
    .request()
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


/* ============================================================
   MAIN FUNCTION
   ============================================================ */

module.exports = async function(
  context,
  req
) {

  let pool;
  let tx;

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
            'DATABASE_CONNECTION_STRING is not configured'
        }
      );

      return;
    }


    const actor =
      actorFromRequest(req);

    const machine =
      machineAuth(req);


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

      const r =
        await pool
          .request()
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
              m.EventLocalDateTime,
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

              ) AS UldNumbers

            FROM dbo.IncomingMachMessages m

            LEFT JOIN dbo.Flights f
              ON f.FlightId =
                 m.MatchedFlightId

            ORDER BY
              m.ReceivedAtUtc DESC,
              m.MachMessageId DESC;
          `);


      const stats =
        await pool
          .request()
          .query(`
            SELECT

              SUM(
                CASE
                  WHEN
                    SourceType =
                    'MACH_FOW_LIVE'
                  THEN 1
                  ELSE 0
                END
              ) AS LiveMessageCount,

              MAX(
                CASE
                  WHEN
                    SourceType =
                    'MACH_FOW_LIVE'
                  THEN ReceivedAtUtc
                END
              ) AS LastLiveReceivedAtUtc

            FROM dbo.IncomingMachMessages;
          `);


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

    const documentCorId =
      clean(
        xmlText(
          xml,
          'DocumentCorID'
        ),
        100
      );


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


    const origin =
      clean(
        xmlText(
          xml,
          'StsSegDep'
        ) ||
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


    const station =
      clean(
        xmlText(
          xml,
          'StsApt'
        ) ||
        origin,
        4
      )?.toUpperCase();


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

    if (!documentCorId) {
      sendJson(
        context,
        422,
        {
          ok: false,
          error:
            'DocumentCorID is required'
        }
      );

      return;
    }


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


    if (
      (station || origin) !==
      'MEL'
    ) {
      sendJson(
        context,
        422,
        {
          ok: false,
          error:
            `Step 6A is MEL-only. ` +
            `Message station is ${
              station ||
              origin ||
              'unknown'
            }`
        }
      );

      return;
    }


    if (!ulds.length) {
      sendJson(
        context,
        422,
        {
          ok: false,
          error:
            'FOW does not contain a usable ULD identifier'
        }
      );

      return;
    }


    /* ========================================================
       DUPLICATE LAYER 1
       SAME DocumentCorID

       Exact same MACH message = ignore.
       ======================================================== */

    const duplicate =
      await existingMessage(
        pool,
        documentCorId
      );


    if (duplicate) {

      sendJson(
        context,
        200,
        {
          ok: true,

          duplicate: true,

          duplicateType:
            'DOCUMENT',

          messageId:
            duplicate.row
              .MachMessageId,

          flightId:
            duplicate.row
              .MatchedFlightId,

          flightNumber:
            duplicate.row
              .MatchedFlightNumber ||
            duplicate.row
              .FlightNumber,

          operatingDate:
            duplicate.row
              .OperatingDate,

          ulds:
            duplicate.ulds,

          processingStatus:
            duplicate.row
              .ProcessingStatus,

          sourceType:
            duplicate.row
              .SourceType,

          live:
            String(
              duplicate.row
                .SourceType ||
              ''
            ).toUpperCase() ===
            'MACH_FOW_LIVE'
        }
      );

      return;
    }


    const requestedFlight =
      padFlight(
        carrier,
        carrierNum
      );


    /* ========================================================
       START TRANSACTION
       ======================================================== */

    tx =
      new sql.Transaction(pool);

    await tx.begin();


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
            ? new Date(
                eventLocal + 'Z'
              )
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

        .query(`
          INSERT INTO dbo.IncomingMachMessages
          (
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

        .query(`
          SELECT
            FlightId,
            FlightNumber,
            FlightStatus

          FROM dbo.Flights

          WHERE
            OperatingDate =
            @OperatingDate

            AND
            UPPER(Direction) =
            'EXPORT';
        `);


    let flight =
      candidates.recordset.find(
        x =>
          flightKey(
            x.FlightNumber
          ) ===
          flightKey(
            requestedFlight
          )
      ) || null;


    let createdFlight =
      false;


    /* --------------------------------------------------------
       EXISTING FINALISED FLIGHT
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


      await pool
        .request()

        .input(
          'DocumentCorID',
          sql.NVarChar(100),
          documentCorId
        )

        .query(`
          DELETE
          FROM dbo.IncomingMachMessages

          WHERE
            DocumentCorID =
            @DocumentCorID;
        `)
        .catch(() => {});


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
            origin || 'MEL'
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

          .query(`
            INSERT INTO dbo.Flights
            (
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

          .input(
            'UldNumber',
            sql.NVarChar(30),
            normalizedUld
          )

          .query(`
            SELECT TOP 1

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
              @FlightId

              AND
              UPPER(
                REPLACE(
                  REPLACE(
                    UldNumber,
                    ' ',
                    ''
                  ),
                  '-',
                  ''
                )
              ) =
              @UldNumber;
          `);


      let uld =
        er.recordset[0] ||
        null;


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

        const documentCorId =
          clean(
            xmlText(
              extractRawXml(req),
              'DocumentCorID'
            ),
            100
          );


        const dup =
          await existingMessage(
            pool,
            documentCorId
          );


        if (dup) {

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

      } catch {}
    }


    sendJson(
      context,
      500,
      {
        ok: false,

        error:
          'MACH FOW intake failed',

        detail:
          err.message
      }
    );

  } finally {

    try {
      await pool?.close();
    } catch {}

  }
};