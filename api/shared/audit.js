'use strict';

function pick(columns, candidates) {
  const lookup = new Map(columns.map(column => [
    String(column.COLUMN_NAME).toLowerCase(),
    column.COLUMN_NAME
  ]));
  for (const candidate of candidates) {
    const found = lookup.get(String(candidate).toLowerCase());
    if (found) return found;
  }
  return null;
}

function quoteName(name) {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

async function auditColumns(transaction, sql) {
  const result = await new sql.Request(transaction)
    .input('AuditTableName', sql.NVarChar(128), 'AuditEvents')
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
        AND TABLE_NAME = @AuditTableName;
    `);
  return result.recordset || [];
}

async function insertAuditEvent(transaction, sql, event) {
  if (!transaction) throw new Error('Authoritative audit requires a transaction');

  const columns = await auditColumns(transaction, sql);
  if (!columns.length) throw new Error('dbo.AuditEvents table was not found');

  const details = {
    type: event.type,
    action: event.action,
    user: event.actorDisplayName,
    flight: event.flightNumber || '',
    uld: event.uldNumber || '',
    from: event.fromStatus || '',
    to: event.toStatus || '',
    detail: event.detail || '',
    flightId: event.flightId ?? null,
    uldId: event.uldId ?? null,
    offloadId: event.offloadId ?? null,
    ...(event.details || {})
  };

  const request = new sql.Request(transaction)
    .input('AuditEventType', sql.NVarChar(50), event.type || 'Activity')
    .input('AuditAction', sql.NVarChar(150), event.action || 'Activity')
    .input('AuditActorDisplayName', sql.NVarChar(150), event.actorDisplayName || null)
    .input('AuditActorReference', sql.NVarChar(150), event.actorReference || null)
    .input('AuditFlightNumber', sql.NVarChar(20), event.flightNumber || null)
    .input('AuditUldNumber', sql.NVarChar(30), event.uldNumber || null)
    .input('AuditFromStatus', sql.NVarChar(40), event.fromStatus || null)
    .input('AuditToStatus', sql.NVarChar(40), event.toStatus || null)
    .input('AuditDetail', sql.NVarChar(1000), event.detail || null)
    .input('AuditEntityType', sql.NVarChar(50), event.entityType || null)
    .input('AuditEntityId', sql.NVarChar(100), event.entityId == null ? null : String(event.entityId))
    .input('AuditDetailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details));

  const names = [];
  const values = [];
  const add = (candidates, expression) => {
    const column = pick(columns, candidates);
    if (!column || names.includes(column)) return;
    names.push(column);
    values.push(expression);
  };

  add(['EventType', 'Type'], '@AuditEventType');
  add(['Action', 'EventAction'], '@AuditAction');
  add(['EntityType'], '@AuditEntityType');
  add(['EntityId'], '@AuditEntityId');
  add(['FlightNumber', 'Flight'], '@AuditFlightNumber');
  add(['UldNumber', 'ULDNumber', 'Uld'], '@AuditUldNumber');
  add(['FromStatus'], '@AuditFromStatus');
  add(['ToStatus'], '@AuditToStatus');
  add(['OccurredAtUtc', 'OccurredAt', 'CreatedAtUtc'], 'SYSUTCDATETIME()');
  add(['ActorDisplayName', 'UserDisplayName', 'ActorName'], '@AuditActorDisplayName');
  add(['ActorObjectId', 'ActorId', 'ActorReference'], '@AuditActorReference');
  add(['Detail', 'Description'], '@AuditDetail');
  add(['DetailsJson', 'DetailJson', 'MetadataJson'], '@AuditDetailsJson');

  if (!pick(columns, ['Action', 'EventAction']) || !pick(columns, ['ActorDisplayName', 'UserDisplayName', 'ActorName'])) {
    throw new Error('AuditEvents schema cannot store an action and authenticated actor');
  }

  const mapped = new Set(names.map(name => name.toLowerCase()));
  const requiredUnknown = columns.filter(column =>
    column.IS_NULLABLE === 'NO' &&
    !column.COLUMN_DEFAULT &&
    Number(column.IS_IDENTITY) !== 1 &&
    !mapped.has(String(column.COLUMN_NAME).toLowerCase())
  );
  if (requiredUnknown.length) {
    throw new Error(`AuditEvents schema has unmapped required columns: ${requiredUnknown.map(column => column.COLUMN_NAME).join(', ')}`);
  }

  const inserted = await request.query(`
    INSERT INTO dbo.AuditEvents (${names.map(quoteName).join(', ')})
    OUTPUT INSERTED.*
    VALUES (${values.join(', ')});
  `);

  return inserted.recordset?.[0] || null;
}

module.exports = { insertAuditEvent };
