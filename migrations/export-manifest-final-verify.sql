-- READ ONLY. Run after export-manifest-final.sql in an isolated rehearsal.
SET NOCOUNT ON;

SELECT t.name AS TableName,c.column_id,c.name AS ColumnName,TYPE_NAME(c.user_type_id) AS DataType,
  c.max_length,c.is_nullable,c.is_identity,dc.name AS DefaultConstraint
FROM sys.tables t
JOIN sys.columns c ON c.object_id=t.object_id
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id=c.object_id AND dc.parent_column_id=c.column_id
WHERE t.object_id IN (OBJECT_ID(N'dbo.ExportManifestFinals',N'U'),OBJECT_ID(N'dbo.ExportManifestFinalUlds',N'U'))
ORDER BY t.name,c.column_id;

SELECT OBJECT_NAME(o.parent_object_id) AS TableName,o.type_desc,o.name,
  COALESCE(fk.is_disabled,cc.is_disabled,0) AS is_disabled,
  COALESCE(fk.is_not_trusted,cc.is_not_trusted,0) AS is_not_trusted
FROM sys.objects o
LEFT JOIN sys.foreign_keys fk ON fk.object_id=o.object_id
LEFT JOIN sys.check_constraints cc ON cc.object_id=o.object_id
WHERE o.parent_object_id IN (OBJECT_ID(N'dbo.ExportManifestFinals',N'U'),OBJECT_ID(N'dbo.ExportManifestFinalUlds',N'U'))
  AND o.type IN ('F','C','PK','UQ')
ORDER BY TableName,o.type_desc,o.name;

SELECT OBJECT_NAME(i.object_id) AS TableName,i.name,i.is_unique,i.is_primary_key,i.is_disabled,
  STRING_AGG(CONVERT(nvarchar(max),c.name),N',') WITHIN GROUP (ORDER BY ic.key_ordinal) AS KeyColumns
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>0
JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
WHERE i.object_id IN (OBJECT_ID(N'dbo.ExportManifestFinals',N'U'),OBJECT_ID(N'dbo.ExportManifestFinalUlds',N'U'))
GROUP BY i.object_id,i.name,i.is_unique,i.is_primary_key,i.is_disabled
ORDER BY TableName,i.name;

SELECT OBJECT_NAME(parent_id) AS TableName,name,is_disabled,OBJECT_DEFINITION(object_id) AS TriggerDefinition
FROM sys.triggers
WHERE parent_id IN (OBJECT_ID(N'dbo.ExportManifestFinals',N'U'),OBJECT_ID(N'dbo.ExportManifestFinalUlds',N'U'));

-- Every result set below must be empty.
SELECT FlightId,COUNT_BIG(*) AS FinalCount
FROM dbo.ExportManifestFinals
GROUP BY FlightId HAVING COUNT_BIG(*)<>1;

SELECT f.FinalManifestId,f.FlightId,f.FinalUldCount,COUNT(m.UldId) AS MembershipCount
FROM dbo.ExportManifestFinals f
LEFT JOIN dbo.ExportManifestFinalUlds m ON m.FinalManifestId=f.FinalManifestId AND m.FlightId=f.FlightId
GROUP BY f.FinalManifestId,f.FlightId,f.FinalUldCount
HAVING COUNT(m.UldId)<>f.FinalUldCount;

SELECT m.FinalManifestId,m.FlightId,m.UldId,m.UldNumber
FROM dbo.ExportManifestFinalUlds m
LEFT JOIN dbo.ExportManifestFinals f ON f.FinalManifestId=m.FinalManifestId AND f.FlightId=m.FlightId
LEFT JOIN dbo.ULDs u ON u.FlightId=m.FlightId AND u.UldId=m.UldId
WHERE f.FinalManifestId IS NULL OR u.UldId IS NULL;

SELECT FinalManifestId,MIN(ManifestOrdinal) AS MinOrdinal,MAX(ManifestOrdinal) AS MaxOrdinal,COUNT_BIG(*) AS RecordCount
FROM dbo.ExportManifestFinalUlds
GROUP BY FinalManifestId
HAVING MIN(ManifestOrdinal)<>1 OR MAX(ManifestOrdinal)<>COUNT_BIG(*);
