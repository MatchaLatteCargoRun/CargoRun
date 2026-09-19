-- READ ONLY. Live compatibility check before export-manifest-final.sql.
SET NOCOUNT ON;

SELECT DB_NAME() AS DatabaseName,USER_NAME() AS DatabaseUser,SYSUTCDATETIME() AS CheckedAtUtc;

SELECT RequiredObject,
  CASE WHEN OBJECT_ID(RequiredObject,N'U') IS NULL THEN 0 ELSE 1 END AS ExistsFlag
FROM (VALUES
  (N'dbo.Flights'),
  (N'dbo.ULDs'),
  (N'dbo.AuditEvents')
) required(RequiredObject);

SELECT OBJECT_ID(N'dbo.ExportManifestFinals',N'U') AS ExportManifestFinalsObjectId,
  OBJECT_ID(N'dbo.ExportManifestFinalUlds',N'U') AS ExportManifestFinalUldsObjectId;

SELECT t.name AS TableName,c.column_id,c.name AS ColumnName,TYPE_NAME(c.user_type_id) AS DataType,
  c.max_length,c.is_nullable,c.is_identity
FROM sys.tables t
JOIN sys.columns c ON c.object_id=t.object_id
WHERE t.object_id IN (OBJECT_ID(N'dbo.Flights',N'U'),OBJECT_ID(N'dbo.ULDs',N'U'),OBJECT_ID(N'dbo.AuditEvents',N'U'))
ORDER BY t.name,c.column_id;

SELECT i.name AS IndexName,i.is_unique,i.is_primary_key,
  STRING_AGG(CONVERT(nvarchar(max),c.name),N',') WITHIN GROUP (ORDER BY ic.key_ordinal) AS KeyColumns
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>0
JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
WHERE i.object_id=OBJECT_ID(N'dbo.ULDs',N'U')
GROUP BY i.name,i.is_unique,i.is_primary_key
ORDER BY i.name;

-- Every STOP result must be zero before migration.
SELECT N'MISSING_REQUIRED_TABLE' AS StopCondition,COUNT_BIG(*) AS StopCount
FROM (VALUES (N'dbo.Flights'),(N'dbo.ULDs'),(N'dbo.AuditEvents')) required(ObjectName)
WHERE OBJECT_ID(ObjectName,N'U') IS NULL
UNION ALL
SELECT N'FINAL_TABLE_ALREADY_PRESENT',
  CASE WHEN OBJECT_ID(N'dbo.ExportManifestFinals',N'U') IS NOT NULL
         OR OBJECT_ID(N'dbo.ExportManifestFinalUlds',N'U') IS NOT NULL THEN 1 ELSE 0 END
UNION ALL
SELECT N'MISSING_REQUIRED_IDENTITY_COLUMN',COUNT_BIG(*)
FROM (VALUES
  (N'dbo.Flights',N'FlightId'),
  (N'dbo.ULDs',N'FlightId'),
  (N'dbo.ULDs',N'UldId'),
  (N'dbo.ULDs',N'UldNumber')
) required(TableName,ColumnName)
WHERE COL_LENGTH(TableName,ColumnName) IS NULL
UNION ALL
SELECT N'INCOMPATIBLE_IDENTITY_COLUMN_TYPE',COUNT_BIG(*)
FROM (VALUES
  (OBJECT_ID(N'dbo.Flights',N'U'),N'FlightId'),
  (OBJECT_ID(N'dbo.ULDs',N'U'),N'FlightId'),
  (OBJECT_ID(N'dbo.ULDs',N'U'),N'UldId')
) required(ObjectId,ColumnName)
JOIN sys.columns c ON c.object_id=required.ObjectId AND c.name=required.ColumnName
WHERE TYPE_NAME(c.user_type_id)<>N'bigint'
UNION ALL
SELECT N'MISSING_UNIQUE_ULD_OWNERSHIP_KEY',
  CASE WHEN EXISTS (
    SELECT 1 FROM sys.indexes i
    JOIN sys.index_columns a ON a.object_id=i.object_id AND a.index_id=i.index_id AND a.key_ordinal=1
    JOIN sys.columns ca ON ca.object_id=a.object_id AND ca.column_id=a.column_id
    JOIN sys.index_columns b ON b.object_id=i.object_id AND b.index_id=i.index_id AND b.key_ordinal=2
    JOIN sys.columns cb ON cb.object_id=b.object_id AND cb.column_id=b.column_id
    WHERE i.object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND i.is_unique=1
      AND i.is_disabled=0 AND i.is_hypothetical=0 AND i.has_filter=0
      AND ca.name=N'FlightId' AND cb.name=N'UldId'
      AND NOT EXISTS (SELECT 1 FROM sys.index_columns x
        WHERE x.object_id=i.object_id AND x.index_id=i.index_id AND x.key_ordinal>2)
  ) THEN 0 ELSE 1 END;
