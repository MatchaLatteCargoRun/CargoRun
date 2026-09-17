-- READ ONLY. Run after the reviewed migration, before resuming new creation.
SELECT c.name, TYPE_NAME(c.user_type_id) AS DataType, c.is_nullable,
       OBJECT_DEFINITION(c.default_object_id) AS DefaultDefinition
FROM sys.columns c WHERE c.object_id=OBJECT_ID(N'dbo.Offloads') AND c.name=N'UldId';

SELECT name, definition, is_disabled, is_not_trusted
FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.Offloads');

SELECT fk.name, fk.is_disabled, fk.is_not_trusted,
       OBJECT_NAME(fk.referenced_object_id) AS ReferencedTable,
       pc.name AS ChildColumn, rc.name AS ParentColumn, fc.constraint_column_id
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=fk.object_id
JOIN sys.columns pc ON pc.object_id=fc.parent_object_id AND pc.column_id=fc.parent_column_id
JOIN sys.columns rc ON rc.object_id=fc.referenced_object_id AND rc.column_id=fc.referenced_column_id
WHERE fk.parent_object_id=OBJECT_ID(N'dbo.Offloads')
ORDER BY fk.name, fc.constraint_column_id;

SELECT OBJECT_NAME(i.object_id) AS TableName,i.name,i.is_unique,i.is_disabled,
       i.has_filter,i.filter_definition,ic.key_ordinal,ic.is_included_column,c.name AS ColumnName
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
WHERE i.object_id IN (OBJECT_ID(N'dbo.ULDs'),OBJECT_ID(N'dbo.Offloads'))
ORDER BY TableName,i.name,ic.key_ordinal;

SELECT OffloadId,FlightId,UldId,UldNumber,OffloadStatus
FROM dbo.Offloads WHERE OffloadId IN (1,2,3,4,5,6,7,8,9,10,11,12)
ORDER BY OffloadId;

-- All three following result sets should be empty.
SELECT OffloadId FROM dbo.Offloads
WHERE UldId IS NULL AND OffloadId NOT IN (1,2,3,4,5,6,7,8,9,10,11,12);
SELECT o.OffloadId,o.FlightId,o.UldId FROM dbo.Offloads o
LEFT JOIN dbo.ULDs u ON u.FlightId=o.FlightId AND u.UldId=o.UldId
WHERE o.UldId IS NOT NULL AND u.UldId IS NULL;
SELECT FlightId,UldId,COUNT_BIG(*) AS ActiveCount FROM dbo.Offloads
WHERE FlightId IS NOT NULL AND UldId IS NOT NULL AND OffloadStatus IN ('REQUESTED','TRANSIT')
GROUP BY FlightId,UldId HAVING COUNT_BIG(*)>1;
