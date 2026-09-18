SET NOCOUNT ON;

SELECT
    N'DATABASE_IDENTITY' AS Section,
    DB_NAME() AS DatabaseName,
    CONVERT(nvarchar(256), SERVERPROPERTY('ServerName')) AS ServerName,
    SYSUTCDATETIME() AS ReadAtUtc,
    SUSER_SNAME() AS LoginName,
    USER_NAME() AS DatabaseUser;

;WITH RequiredTables AS (
    SELECT TableName
    FROM (VALUES
        (N'Flights'),
        (N'ULDs'),
        (N'Offloads'),
        (N'ExportCompletionRecords'),
        (N'AuditEvents'),
        (N'ExportCompletionAmendments')
    ) v(TableName)
)
SELECT
    N'TABLE_EXISTENCE' AS Section,
    TableName,
    CASE WHEN OBJECT_ID(N'dbo.' + QUOTENAME(TableName), N'U') IS NULL
         THEN 0 ELSE 1 END AS TableExists,
    OBJECT_ID(N'dbo.' + QUOTENAME(TableName), N'U') AS ObjectId,
    CASE WHEN TableName = N'Offloads'
         THEN CASE WHEN COL_LENGTH(N'dbo.Offloads', N'UldId') IS NULL
                   THEN 0 ELSE 1 END
         ELSE NULL END AS OffloadsUldIdExists
FROM RequiredTables
ORDER BY TableName;

SELECT
    N'CURRENT_COLUMNS' AS Section,
    s.name AS SchemaName,
    t.name AS TableName,
    c.column_id AS ColumnId,
    c.name AS ColumnName,
    TYPE_NAME(c.user_type_id) AS DataType,
    c.max_length AS MaximumLengthBytes,
    c.precision,
    c.scale,
    c.is_nullable,
    c.is_identity,
    c.is_computed,
    dc.name AS DefaultConstraint,
    dc.definition AS DefaultDefinition
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
LEFT JOIN sys.default_constraints dc
  ON dc.parent_object_id = c.object_id
 AND dc.parent_column_id = c.column_id
WHERE s.name = N'dbo'
  AND t.name IN (
      N'Flights',
      N'ULDs',
      N'Offloads',
      N'ExportCompletionRecords',
      N'AuditEvents',
      N'ExportCompletionAmendments'
  )
ORDER BY t.name, c.column_id;

;WITH RequiredColumns AS (
    SELECT TableName, ColumnName, RequiredType
    FROM (VALUES
        (N'Flights', N'FlightId', N'bigint'),
        (N'Flights', N'Direction', NULL),
        (N'Flights', N'FlightStatus', NULL),

        (N'ULDs', N'UldId', N'bigint'),
        (N'ULDs', N'FlightId', N'bigint'),
        (N'ULDs', N'UldNumber', NULL),

        (N'Offloads', N'OffloadId', N'bigint'),
        (N'Offloads', N'FlightId', N'bigint'),
        (N'Offloads', N'UldId', N'bigint'),
        (N'Offloads', N'UldNumber', NULL),
        (N'Offloads', N'OffloadStatus', NULL),

        (N'ExportCompletionRecords', N'ExportCompletionRecordId', N'bigint'),
        (N'ExportCompletionRecords', N'FlightId', N'bigint'),
        (N'ExportCompletionRecords', N'VerificationId', NULL),
        (N'ExportCompletionRecords', N'SnapshotJson', NULL),
        (N'ExportCompletionRecords', N'RecordHash', NULL)
    ) v(TableName, ColumnName, RequiredType)
)
SELECT
    N'REQUIRED_COLUMN_COMPATIBILITY' AS Section,
    r.TableName,
    r.ColumnName,
    r.RequiredType,
    TYPE_NAME(c.user_type_id) AS ActualType,
    c.max_length AS ActualMaximumLengthBytes,
    c.is_nullable,
    CASE
      WHEN c.column_id IS NULL THEN N'STOP_MISSING'
      WHEN r.RequiredType IS NOT NULL
       AND TYPE_NAME(c.user_type_id) <> r.RequiredType THEN N'STOP_WRONG_TYPE'
      ELSE N'PASS'
    END AS Result
FROM RequiredColumns r
LEFT JOIN sys.tables t
  ON t.schema_id = SCHEMA_ID(N'dbo')
 AND t.name = r.TableName
LEFT JOIN sys.columns c
  ON c.object_id = t.object_id
 AND c.name = r.ColumnName
ORDER BY r.TableName, r.ColumnName;

;WITH PlannedNames AS (
    SELECT ObjectName, IntendedParent
    FROM (VALUES
        (N'UQ_ExportCompletionRecords_Flight', N'dbo.ExportCompletionRecords'),
        (N'UQ_ExportCompletionRecords_Flight_Record', N'dbo.ExportCompletionRecords'),
        (N'UQ_Offloads_Flight_Offload', N'dbo.Offloads'),
        (N'PK_ExportCompletionAmendments', N'dbo.ExportCompletionAmendments'),
        (N'DF_ExportCompletionAmendments_CreatedAtUtc', N'dbo.ExportCompletionAmendments'),
        (N'CK_ExportCompletionAmendments_Version', N'dbo.ExportCompletionAmendments'),
        (N'CK_ExportCompletionAmendments_PreviousHash', N'dbo.ExportCompletionAmendments'),
        (N'CK_ExportCompletionAmendments_RecordHash', N'dbo.ExportCompletionAmendments'),
        (N'CK_ExportCompletionAmendments_SnapshotJson', N'dbo.ExportCompletionAmendments'),
        (N'CK_ExportCompletionAmendments_OffloadTransition', N'dbo.ExportCompletionAmendments'),
        (N'UQ_ExportCompletionAmendments_BaseVersion', N'dbo.ExportCompletionAmendments'),
        (N'UQ_ExportCompletionAmendments_FlightVersion', N'dbo.ExportCompletionAmendments'),
        (N'UQ_ExportCompletionAmendments_Verification', N'dbo.ExportCompletionAmendments'),
        (N'UQ_ExportCompletionAmendments_Operation', N'dbo.ExportCompletionAmendments'),
        (N'FK_ExportCompletionAmendments_BaseFlight', N'dbo.ExportCompletionAmendments'),
        (N'FK_ExportCompletionAmendments_FlightOffload', N'dbo.ExportCompletionAmendments'),
        (N'FK_ExportCompletionAmendments_FlightUld', N'dbo.ExportCompletionAmendments'),
        (N'TR_ExportCompletionAmendments_Immutable', N'dbo.ExportCompletionAmendments')
    ) v(ObjectName, IntendedParent)
)
SELECT
    N'STOP_PLANNED_OBJECT_NAME_COLLISION' AS Section,
    p.ObjectName,
    p.IntendedParent,
    o.type_desc AS ExistingObjectType,
    SCHEMA_NAME(o.schema_id) AS ExistingSchema,
    OBJECT_SCHEMA_NAME(o.parent_object_id) + N'.' +
      OBJECT_NAME(o.parent_object_id) AS ExistingParent
FROM PlannedNames p
JOIN sys.objects o
  ON o.schema_id = SCHEMA_ID(N'dbo')
 AND o.name = p.ObjectName
ORDER BY p.ObjectName;

SELECT
    N'CONSTRAINTS' AS Section,
    OBJECT_SCHEMA_NAME(o.parent_object_id) AS SchemaName,
    OBJECT_NAME(o.parent_object_id) AS TableName,
    o.type_desc AS ConstraintType,
    o.name AS ConstraintName,
    COALESCE(cc.definition, dc.definition, OBJECT_DEFINITION(o.object_id)) AS Definition,
    COALESCE(cc.is_disabled, fk.is_disabled, 0) AS IsDisabled,
    COALESCE(cc.is_not_trusted, fk.is_not_trusted, 0) AS IsNotTrusted
FROM sys.objects o
LEFT JOIN sys.check_constraints cc ON cc.object_id = o.object_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = o.object_id
LEFT JOIN sys.foreign_keys fk ON fk.object_id = o.object_id
WHERE o.parent_object_id IN (
    OBJECT_ID(N'dbo.Flights', N'U'),
    OBJECT_ID(N'dbo.ULDs', N'U'),
    OBJECT_ID(N'dbo.Offloads', N'U'),
    OBJECT_ID(N'dbo.ExportCompletionRecords', N'U'),
    OBJECT_ID(N'dbo.AuditEvents', N'U'),
    OBJECT_ID(N'dbo.ExportCompletionAmendments', N'U')
)
AND o.type IN (N'C', N'D', N'F', N'PK', N'UQ')
ORDER BY TableName, ConstraintType, ConstraintName;

SELECT
    N'FOREIGN_KEY_COLUMNS' AS Section,
    fk.name AS ForeignKeyName,
    OBJECT_SCHEMA_NAME(fk.parent_object_id) AS ChildSchema,
    OBJECT_NAME(fk.parent_object_id) AS ChildTable,
    pc.name AS ChildColumn,
    OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS ParentSchema,
    OBJECT_NAME(fk.referenced_object_id) AS ParentTable,
    rc.name AS ParentColumn,
    fkc.constraint_column_id AS ColumnPosition,
    fk.is_disabled,
    fk.is_not_trusted,
    fk.delete_referential_action_desc,
    fk.update_referential_action_desc
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc
  ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns pc
  ON pc.object_id = fkc.parent_object_id
 AND pc.column_id = fkc.parent_column_id
JOIN sys.columns rc
  ON rc.object_id = fkc.referenced_object_id
 AND rc.column_id = fkc.referenced_column_id
WHERE fk.parent_object_id IN (
    OBJECT_ID(N'dbo.ULDs', N'U'),
    OBJECT_ID(N'dbo.Offloads', N'U'),
    OBJECT_ID(N'dbo.ExportCompletionRecords', N'U'),
    OBJECT_ID(N'dbo.ExportCompletionAmendments', N'U')
)
ORDER BY ChildTable, ForeignKeyName, ColumnPosition;

SELECT
    N'INDEXES' AS Section,
    OBJECT_SCHEMA_NAME(i.object_id) AS SchemaName,
    OBJECT_NAME(i.object_id) AS TableName,
    i.name AS IndexName,
    i.type_desc AS IndexType,
    i.is_unique,
    i.is_primary_key,
    i.is_unique_constraint,
    i.is_disabled,
    i.is_hypothetical,
    i.has_filter,
    i.filter_definition,
    ic.key_ordinal,
    ic.is_included_column,
    c.name AS ColumnName
FROM sys.indexes i
LEFT JOIN sys.index_columns ic
  ON ic.object_id = i.object_id
 AND ic.index_id = i.index_id
LEFT JOIN sys.columns c
  ON c.object_id = ic.object_id
 AND c.column_id = ic.column_id
WHERE i.object_id IN (
    OBJECT_ID(N'dbo.Flights', N'U'),
    OBJECT_ID(N'dbo.ULDs', N'U'),
    OBJECT_ID(N'dbo.Offloads', N'U'),
    OBJECT_ID(N'dbo.ExportCompletionRecords', N'U'),
    OBJECT_ID(N'dbo.ExportCompletionAmendments', N'U')
)
AND i.index_id > 0
ORDER BY TableName, IndexName, ic.key_ordinal, ic.index_column_id;

SELECT
    N'TRIGGERS' AS Section,
    OBJECT_SCHEMA_NAME(tr.parent_id) AS SchemaName,
    OBJECT_NAME(tr.parent_id) AS TableName,
    tr.name AS TriggerName,
    tr.is_disabled,
    tr.is_instead_of_trigger,
    OBJECT_DEFINITION(tr.object_id) AS TriggerDefinition
FROM sys.triggers tr
WHERE tr.parent_id IN (
    OBJECT_ID(N'dbo.Flights', N'U'),
    OBJECT_ID(N'dbo.ULDs', N'U'),
    OBJECT_ID(N'dbo.Offloads', N'U'),
    OBJECT_ID(N'dbo.ExportCompletionRecords', N'U'),
    OBJECT_ID(N'dbo.AuditEvents', N'U'),
    OBJECT_ID(N'dbo.ExportCompletionAmendments', N'U')
)
ORDER BY TableName, TriggerName;

SELECT
    N'MIGRATION_STATIC_READINESS' AS Section,
    CheckName,
    Result
FROM (
    SELECT
      N'Required base tables exist' AS CheckName,
      CASE WHEN OBJECT_ID(N'dbo.Flights', N'U') IS NOT NULL
             AND OBJECT_ID(N'dbo.ULDs', N'U') IS NOT NULL
             AND OBJECT_ID(N'dbo.Offloads', N'U') IS NOT NULL
             AND OBJECT_ID(N'dbo.ExportCompletionRecords', N'U') IS NOT NULL
             AND OBJECT_ID(N'dbo.AuditEvents', N'U') IS NOT NULL
           THEN N'PASS' ELSE N'STOP' END AS Result

    UNION ALL

    SELECT
      N'ExportCompletionAmendments does not already exist',
      CASE WHEN OBJECT_ID(N'dbo.ExportCompletionAmendments', N'U') IS NULL
           THEN N'PASS' ELSE N'STOP' END

    UNION ALL

    SELECT
      N'Offloads.UldId exists before amendment migration',
      CASE WHEN COL_LENGTH(N'dbo.Offloads', N'UldId') IS NOT NULL
           THEN N'PASS' ELSE N'STOP' END

    UNION ALL

    SELECT
      N'Required amendment source columns exist',
      CASE WHEN COL_LENGTH(N'dbo.ExportCompletionRecords', N'ExportCompletionRecordId') IS NOT NULL
             AND COL_LENGTH(N'dbo.ExportCompletionRecords', N'FlightId') IS NOT NULL
             AND COL_LENGTH(N'dbo.ExportCompletionRecords', N'VerificationId') IS NOT NULL
             AND COL_LENGTH(N'dbo.ExportCompletionRecords', N'SnapshotJson') IS NOT NULL
             AND COL_LENGTH(N'dbo.ExportCompletionRecords', N'RecordHash') IS NOT NULL
           THEN N'PASS' ELSE N'STOP' END

    UNION ALL

    SELECT
      N'Enabled unfiltered unique ULD ownership key exists',
      CASE WHEN EXISTS (
        SELECT 1
        FROM sys.indexes i
        JOIN sys.index_columns a
          ON a.object_id = i.object_id
         AND a.index_id = i.index_id
         AND a.key_ordinal = 1
        JOIN sys.columns ca
          ON ca.object_id = a.object_id
         AND ca.column_id = a.column_id
        JOIN sys.index_columns b
          ON b.object_id = i.object_id
         AND b.index_id = i.index_id
         AND b.key_ordinal = 2
        JOIN sys.columns cb
          ON cb.object_id = b.object_id
         AND cb.column_id = b.column_id
        WHERE i.object_id = OBJECT_ID(N'dbo.ULDs')
          AND i.is_unique = 1
          AND i.is_disabled = 0
          AND i.is_hypothetical = 0
          AND i.has_filter = 0
          AND ca.name = N'FlightId'
          AND cb.name = N'UldId'
          AND NOT EXISTS (
            SELECT 1
            FROM sys.index_columns x
            WHERE x.object_id = i.object_id
              AND x.index_id = i.index_id
              AND x.key_ordinal > 2
          )
      ) THEN N'PASS' ELSE N'STOP' END
) readiness
ORDER BY CheckName;

IF OBJECT_ID(N'dbo.ULDs', N'U') IS NOT NULL
   AND OBJECT_ID(N'dbo.Flights', N'U') IS NOT NULL
BEGIN
    EXEC sys.sp_executesql N'
      SELECT
          N''STOP_ULD_ORPHAN_FLIGHT'' AS Section,
          u.UldId,
          u.FlightId,
          u.UldNumber
      FROM dbo.ULDs u
      LEFT JOIN dbo.Flights f ON f.FlightId = u.FlightId
      WHERE u.FlightId IS NULL OR f.FlightId IS NULL
      ORDER BY u.UldId;

      SELECT
          N''STOP_ULD_IDENTITY_DUPLICATE'' AS Section,
          FlightId,
          UldId,
          COUNT_BIG(*) AS DuplicateCount
      FROM dbo.ULDs
      GROUP BY FlightId, UldId
      HAVING COUNT_BIG(*) > 1
      ORDER BY FlightId, UldId;
    ';
END
ELSE
BEGIN
    SELECT N'STOP_ULD_CHECK_NOT_RUN' AS Section,
           N'Flights or ULDs table is missing' AS Reason;
END;

IF OBJECT_ID(N'dbo.ULDs', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.ULDs', N'UldNumber') IS NOT NULL
   AND COL_LENGTH(N'dbo.ULDs', N'FlightId') IS NOT NULL
BEGIN
    EXEC sys.sp_executesql N'
      ;WITH CanonicalUlds AS (
          SELECT
              u.UldId,
              u.FlightId,
              u.UldNumber,
              f.CanonicalUldNumber
          FROM dbo.ULDs u
          CROSS APPLY (VALUES (
              UPPER(CONVERT(nvarchar(4000), u.UldNumber))
          )) a(s0)
          CROSS APPLY (VALUES (
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                  a.s0, N''-'', N''''), NCHAR(9), N''''), NCHAR(10), N''''),
                  NCHAR(11), N''''), NCHAR(12), N''''), NCHAR(13), N'''')
          )) b(s1)
          CROSS APPLY (VALUES (
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                  b.s1, NCHAR(32), N''''), NCHAR(160), N''''),
                  NCHAR(5760), N''''), NCHAR(8192), N''''), NCHAR(8193), N'''')
          )) c(s2)
          CROSS APPLY (VALUES (
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                  c.s2, NCHAR(8194), N''''), NCHAR(8195), N''''),
                  NCHAR(8196), N''''), NCHAR(8197), N''''), NCHAR(8198), N'''')
          )) d(s3)
          CROSS APPLY (VALUES (
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                  d.s3, NCHAR(8199), N''''), NCHAR(8200), N''''),
                  NCHAR(8201), N''''), NCHAR(8202), N''''), NCHAR(8232), N'''')
          )) e(s4)
          CROSS APPLY (VALUES (
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                  e.s4, NCHAR(8233), N''''), NCHAR(8239), N''''),
                  NCHAR(8287), N''''), NCHAR(12288), N''''), NCHAR(65279), N'''')
          )) f(CanonicalUldNumber)
      )
      SELECT
          N''STOP_CANONICAL_ULD_COLLISION'' AS Section,
          FlightId,
          CanonicalUldNumber,
          COUNT_BIG(*) AS UldCount,
          STRING_AGG(CONVERT(nvarchar(max), UldId), N'','')
              WITHIN GROUP (ORDER BY UldId) AS UldIds,
          STRING_AGG(CONVERT(nvarchar(max), UldNumber), N'' | '')
              WITHIN GROUP (ORDER BY UldId) AS StoredUldNumbers
      FROM CanonicalUlds
      WHERE CanonicalUldNumber <> N''''
      GROUP BY FlightId, CanonicalUldNumber
      HAVING COUNT_BIG(*) > 1
      ORDER BY FlightId, CanonicalUldNumber;

      ;WITH CanonicalUlds AS (
          SELECT
              u.UldId,
              u.FlightId,
              u.UldNumber,
              f.CanonicalUldNumber
          FROM dbo.ULDs u
          CROSS APPLY (VALUES (
              UPPER(CONVERT(nvarchar(4000), u.UldNumber))
          )) a(s0)
          CROSS APPLY (VALUES (
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                  a.s0, N''-'', N''''), NCHAR(9), N''''), NCHAR(10), N''''),
                  NCHAR(11), N''''), NCHAR(12), N''''), NCHAR(13), N'''')
          )) b(s1)
          CROSS APPLY (VALUES (
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                  b.s1, NCHAR(32), N''''), NCHAR(160), N''''),
                  NCHAR(5760), N''''), NCHAR(8192), N''''), NCHAR(8193), N'''')
          )) c(s2)
          CROSS APPLY (VALUES (
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                  c.s2, NCHAR(8194), N''''), NCHAR(8195), N''''),
                  NCHAR(8196), N''''), NCHAR(8197), N''''), NCHAR(8198), N'''')
          )) d(s3)
          CROSS APPLY (VALUES (
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                  d.s3, NCHAR(8199), N''''), NCHAR(8200), N''''),
                  NCHAR(8201), N''''), NCHAR(8202), N''''), NCHAR(8232), N'''')
          )) e(s4)
          CROSS APPLY (VALUES (
              REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                  e.s4, NCHAR(8233), N''''), NCHAR(8239), N''''),
                  NCHAR(8287), N''''), NCHAR(12288), N''''), NCHAR(65279), N'''')
          )) f(CanonicalUldNumber)
      )
      SELECT
          N''STOP_EMPTY_CANONICAL_ULD'' AS Section,
          UldId,
          FlightId,
          UldNumber
      FROM CanonicalUlds
      WHERE CanonicalUldNumber = N''''
      ORDER BY FlightId, UldId;
    ';
END
ELSE
BEGIN
    SELECT N'STOP_CANONICAL_ULD_CHECK_NOT_RUN' AS Section,
           N'ULD identity columns are missing' AS Reason;
END;

IF OBJECT_ID(N'dbo.Offloads', N'U') IS NOT NULL
   AND OBJECT_ID(N'dbo.Flights', N'U') IS NOT NULL
BEGIN
    EXEC sys.sp_executesql N'
      SELECT
          N''OFFLOAD_STATUS_COUNTS'' AS Section,
          OffloadStatus,
          COUNT_BIG(*) AS [RowCount]
      FROM dbo.Offloads
      GROUP BY OffloadStatus
      ORDER BY OffloadStatus;

      SELECT
          N''STOP_UNSUPPORTED_OFFLOAD_STATUS'' AS Section,
          OffloadStatus,
          COUNT_BIG(*) AS [RowCount]
      FROM dbo.Offloads
      WHERE OffloadStatus IS NULL
         OR OffloadStatus NOT IN (''REQUESTED'', ''TRANSIT'', ''COMPLETE'')
      GROUP BY OffloadStatus
      ORDER BY OffloadStatus;

      SELECT
          N''ACTIVE_OFFLOADS'' AS Section,
          OffloadId,
          FlightId,
          UldNumber,
          OffloadStatus
      FROM dbo.Offloads
      WHERE OffloadStatus IN (''REQUESTED'', ''TRANSIT'')
      ORDER BY OffloadId;

      SELECT
          N''STOP_OFFLOAD_ORPHAN_FLIGHT'' AS Section,
          o.OffloadId,
          o.FlightId,
          o.UldNumber,
          o.OffloadStatus
      FROM dbo.Offloads o
      LEFT JOIN dbo.Flights f ON f.FlightId = o.FlightId
      WHERE o.FlightId IS NOT NULL
        AND f.FlightId IS NULL
      ORDER BY o.OffloadId;

      SELECT
          N''PHASE_B_ORIGINAL_MIGRATION_GUARD'' AS Section,
          N''Offload population differs from the original reviewed 12-row baseline''
              AS Reason
      WHERE (SELECT COUNT_BIG(*) FROM dbo.Offloads) <> 12
         OR EXISTS (
              SELECT 1
              FROM dbo.Offloads
              WHERE OffloadId NOT IN (1,2,3,4,5,6,7,8,9,10,11,12)
         )

      UNION ALL

      SELECT
          N''PHASE_B_ORIGINAL_MIGRATION_GUARD'',
          N''One of OffloadIds 1 through 11 now has a FlightId''
      WHERE EXISTS (
          SELECT 1
          FROM dbo.Offloads
          WHERE OffloadId BETWEEN 1 AND 11
            AND FlightId IS NOT NULL
      )

      UNION ALL

      SELECT
          N''PHASE_B_ORIGINAL_MIGRATION_GUARD'',
          N''OffloadId 9 no longer matches its reviewed baseline''
      WHERE NOT EXISTS (
          SELECT 1
          FROM dbo.Offloads
          WHERE OffloadId = 9
            AND FlightId IS NULL
            AND UldNumber = N''QKE52521QR''
            AND OffloadStatus = ''REQUESTED''
      )

      UNION ALL

      SELECT
          N''PHASE_B_ORIGINAL_MIGRATION_GUARD'',
          N''OffloadId 12 no longer matches its reviewed baseline''
      WHERE NOT EXISTS (
          SELECT 1
          FROM dbo.Offloads
          WHERE OffloadId = 12
            AND FlightId = 25
            AND UldNumber = N''AKE88888CX''
            AND OffloadStatus = ''COMPLETE''
      )

      UNION ALL

      SELECT
          N''PHASE_B_ORIGINAL_MIGRATION_GUARD'',
          N''A historical status other than OffloadId 9 is no longer COMPLETE''
      WHERE EXISTS (
          SELECT 1
          FROM dbo.Offloads
          WHERE OffloadId <> 9
            AND (OffloadStatus IS NULL OR OffloadStatus <> ''COMPLETE'')
      );
    ';
END
ELSE
BEGIN
    SELECT N'STOP_OFFLOAD_CHECK_NOT_RUN' AS Section,
           N'Flights or Offloads table is missing' AS Reason;
END;

IF OBJECT_ID(N'dbo.Offloads', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.Offloads', N'UldId') IS NOT NULL
BEGIN
    EXEC sys.sp_executesql N'
      SELECT
          N''LEGACY_NULL_ULDID_OFFLOADS'' AS Section,
          OffloadId,
          FlightId,
          UldId,
          UldNumber,
          OffloadStatus
      FROM dbo.Offloads
      WHERE UldId IS NULL
      ORDER BY OffloadId;

      SELECT
          N''STOP_UNAPPROVED_NULL_ULDID_OFFLOAD'' AS Section,
          OffloadId,
          FlightId,
          UldNumber,
          OffloadStatus
      FROM dbo.Offloads
      WHERE UldId IS NULL
        AND OffloadId NOT IN (1,2,3,4,5,6,7,8,9,10,11,12)
      ORDER BY OffloadId;

      SELECT
          N''STOP_ULDID_WITHOUT_FLIGHTID'' AS Section,
          OffloadId,
          FlightId,
          UldId,
          UldNumber,
          OffloadStatus
      FROM dbo.Offloads
      WHERE UldId IS NOT NULL
        AND FlightId IS NULL
      ORDER BY OffloadId;

      SELECT
          N''STOP_OFFLOAD_ORPHAN_FLIGHT_ULD'' AS Section,
          o.OffloadId,
          o.FlightId,
          o.UldId,
          o.UldNumber,
          o.OffloadStatus
      FROM dbo.Offloads o
      LEFT JOIN dbo.ULDs u
        ON u.FlightId = o.FlightId
       AND u.UldId = o.UldId
      WHERE o.UldId IS NOT NULL
        AND u.UldId IS NULL
      ORDER BY o.OffloadId;

      SELECT
          N''STOP_ACTIVE_OFFLOAD_DUPLICATE'' AS Section,
          FlightId,
          UldId,
          COUNT_BIG(*) AS ActiveCount,
          STRING_AGG(CONVERT(nvarchar(max), OffloadId), N'','')
              WITHIN GROUP (ORDER BY OffloadId) AS OffloadIds
      FROM dbo.Offloads
      WHERE FlightId IS NOT NULL
        AND UldId IS NOT NULL
        AND OffloadStatus IN (''REQUESTED'', ''TRANSIT'')
      GROUP BY FlightId, UldId
      HAVING COUNT_BIG(*) > 1
      ORDER BY FlightId, UldId;

      SELECT
          N''STOP_OFFLOAD_COMPOSITE_IDENTITY_DUPLICATE'' AS Section,
          FlightId,
          OffloadId,
          COUNT_BIG(*) AS DuplicateCount
      FROM dbo.Offloads
      GROUP BY FlightId, OffloadId
      HAVING COUNT_BIG(*) > 1;
    ';
END
ELSE
BEGIN
    SELECT
        N'STOP_AMENDMENT_PREREQUISITE' AS Section,
        N'Offloads.UldId does not exist; export-completion-amendments.sql will fail with 51102'
            AS Reason;
END;

IF OBJECT_ID(N'dbo.ExportCompletionRecords', N'U') IS NOT NULL
   AND OBJECT_ID(N'dbo.Flights', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.ExportCompletionRecords', N'ExportCompletionRecordId') IS NOT NULL
   AND COL_LENGTH(N'dbo.ExportCompletionRecords', N'FlightId') IS NOT NULL
   AND COL_LENGTH(N'dbo.ExportCompletionRecords', N'VerificationId') IS NOT NULL
   AND COL_LENGTH(N'dbo.ExportCompletionRecords', N'SnapshotJson') IS NOT NULL
   AND COL_LENGTH(N'dbo.ExportCompletionRecords', N'RecordHash') IS NOT NULL
BEGIN
    EXEC sys.sp_executesql N'
      SELECT
          N''STOP_DUPLICATE_V1_FLIGHT'' AS Section,
          FlightId,
          COUNT_BIG(*) AS CompletionRecordCount,
          STRING_AGG(
              CONVERT(nvarchar(max), ExportCompletionRecordId),
              N'',''
          ) WITHIN GROUP (ORDER BY ExportCompletionRecordId) AS CompletionRecordIds
      FROM dbo.ExportCompletionRecords
      GROUP BY FlightId
      HAVING FlightId IS NULL OR COUNT_BIG(*) > 1
      ORDER BY FlightId;

      SELECT
          N''STOP_V1_ORPHAN_FLIGHT'' AS Section,
          e.ExportCompletionRecordId,
          e.FlightId
      FROM dbo.ExportCompletionRecords e
      LEFT JOIN dbo.Flights f ON f.FlightId = e.FlightId
      WHERE e.FlightId IS NULL
         OR f.FlightId IS NULL
      ORDER BY e.ExportCompletionRecordId;

      SELECT
          N''STOP_V1_REQUIRED_DATA'' AS Section,
          ExportCompletionRecordId,
          FlightId,
          VerificationId,
          RecordHash,
          CASE
            WHEN ExportCompletionRecordId IS NULL THEN N''ExportCompletionRecordId is NULL''
            WHEN FlightId IS NULL THEN N''FlightId is NULL''
            WHEN VerificationId IS NULL THEN N''VerificationId is NULL''
            WHEN SnapshotJson IS NULL THEN N''SnapshotJson is NULL''
            WHEN LEN(SnapshotJson) = 0 THEN N''SnapshotJson is empty''
            WHEN RecordHash IS NULL THEN N''RecordHash is NULL''
            WHEN LEN(RecordHash) <> 64 THEN N''RecordHash length is not 64''
            WHEN RecordHash COLLATE Latin1_General_100_BIN2
                 LIKE N''%[^0-9A-Fa-f]%'' THEN N''RecordHash is not hexadecimal''
            WHEN ISJSON(SnapshotJson) <> 1 THEN N''SnapshotJson is not valid JSON''
            WHEN LEFT(LTRIM(SnapshotJson), 1) <> N''{'' THEN N''SnapshotJson root is not an object''
          END AS Problem
      FROM dbo.ExportCompletionRecords
      WHERE ExportCompletionRecordId IS NULL
         OR FlightId IS NULL
         OR VerificationId IS NULL
         OR SnapshotJson IS NULL
         OR LEN(SnapshotJson) = 0
         OR RecordHash IS NULL
         OR LEN(RecordHash) <> 64
         OR RecordHash COLLATE Latin1_General_100_BIN2
              LIKE N''%[^0-9A-Fa-f]%''
         OR ISJSON(SnapshotJson) <> 1
         OR LEFT(LTRIM(SnapshotJson), 1) <> N''{''
      ORDER BY ExportCompletionRecordId;

      SELECT
          N''V1_EVIDENCE'' AS Section,
          CONVERT(varchar(20), ExportCompletionRecordId)
              AS ExportCompletionRecordId,
          CONVERT(varchar(20), FlightId) AS FlightId,
          CONVERT(nvarchar(100), VerificationId) AS VerificationId,
          RecordHash,
          DATALENGTH(SnapshotJson) AS SnapshotSqlStorageByteLength,
          LEN(SnapshotJson) AS SnapshotCharacterLength,
          SnapshotJson AS SnapshotJsonForOfflineVerification
      FROM dbo.ExportCompletionRecords
      ORDER BY ExportCompletionRecordId;
    ';
END
ELSE
BEGIN
    SELECT
        N'STOP_V1_CHECK_NOT_RUN' AS Section,
        N'ExportCompletionRecords, Flights, or required V1 columns are missing'
            AS Reason;
END;

IF OBJECT_ID(N'dbo.ExportCompletionAmendments', N'U') IS NOT NULL
BEGIN
    SELECT
        N'STOP_AMENDMENT_TABLE_ALREADY_EXISTS' AS Section,
        OBJECT_ID(N'dbo.ExportCompletionAmendments', N'U') AS ObjectId,
        N'export-completion-amendments.sql will stop with error 51101'
            AS Reason;
END;

