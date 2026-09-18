-- READ ONLY. Run after export-completion-amendments.sql in an isolated rehearsal.
SET NOCOUNT ON;

SELECT c.column_id,c.name AS ColumnName,TYPE_NAME(c.user_type_id) AS DataType,
  c.max_length,c.is_nullable,c.is_identity,dc.name AS DefaultConstraint
FROM sys.columns c
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id=c.object_id
  AND dc.parent_column_id=c.column_id
WHERE c.object_id=OBJECT_ID(N'dbo.ExportCompletionAmendments',N'U')
ORDER BY c.column_id;

SELECT o.type_desc,o.name,
  COALESCE(fk.is_disabled,cc.is_disabled,0) AS is_disabled,
  COALESCE(fk.is_not_trusted,cc.is_not_trusted,0) AS is_not_trusted
FROM sys.objects o
LEFT JOIN sys.foreign_keys fk ON fk.object_id=o.object_id
LEFT JOIN sys.check_constraints cc ON cc.object_id=o.object_id
WHERE o.parent_object_id=OBJECT_ID(N'dbo.ExportCompletionAmendments',N'U')
  AND o.type IN ('F','C','PK','UQ')
ORDER BY o.type_desc,o.name;

SELECT i.name,i.is_unique,i.is_primary_key,i.is_disabled,
  STRING_AGG(CONVERT(nvarchar(max),c.name),N',') WITHIN GROUP (ORDER BY ic.key_ordinal) AS KeyColumns
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>0
JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
WHERE i.object_id=OBJECT_ID(N'dbo.ExportCompletionAmendments',N'U')
GROUP BY i.name,i.is_unique,i.is_primary_key,i.is_disabled
ORDER BY i.name;

SELECT name,is_disabled,OBJECT_DEFINITION(object_id) AS TriggerDefinition
FROM sys.triggers
WHERE parent_id=OBJECT_ID(N'dbo.ExportCompletionAmendments',N'U');

-- Every result set below must be empty.
SELECT FlightId,COUNT_BIG(*) AS BaseRecordCount
FROM dbo.ExportCompletionRecords
GROUP BY FlightId HAVING FlightId IS NULL OR COUNT_BIG(*)<>1;

SELECT ExportCompletionRecordId,VersionNumber,COUNT_BIG(*) AS DuplicateCount
FROM dbo.ExportCompletionAmendments
GROUP BY ExportCompletionRecordId,VersionNumber HAVING COUNT_BIG(*)>1;

WITH Versions AS (
  SELECT a.*,
    ROW_NUMBER() OVER (PARTITION BY a.ExportCompletionRecordId ORDER BY a.VersionNumber) + 1 AS ExpectedVersion,
    LAG(a.RecordHash) OVER (PARTITION BY a.ExportCompletionRecordId ORDER BY a.VersionNumber) AS PriorAmendmentHash
  FROM dbo.ExportCompletionAmendments a
)
SELECT v.AmendmentId,v.ExportCompletionRecordId,v.FlightId,v.VersionNumber,
  v.ExpectedVersion,v.PreviousHash,
  COALESCE(v.PriorAmendmentHash,b.RecordHash) AS ExpectedPreviousHash
FROM Versions v
JOIN dbo.ExportCompletionRecords b ON b.ExportCompletionRecordId=v.ExportCompletionRecordId
WHERE v.VersionNumber<>v.ExpectedVersion
   OR v.FlightId<>b.FlightId
   OR LOWER(v.PreviousHash)<>LOWER(COALESCE(v.PriorAmendmentHash,b.RecordHash));

SELECT a.AmendmentId
FROM dbo.ExportCompletionAmendments a
LEFT JOIN dbo.ExportCompletionRecords b
  ON b.ExportCompletionRecordId=a.ExportCompletionRecordId AND b.FlightId=a.FlightId
LEFT JOIN dbo.Offloads o ON o.OffloadId=a.RelatedOffloadId AND o.FlightId=a.FlightId
LEFT JOIN dbo.ULDs u ON u.UldId=a.RelatedUldId AND u.FlightId=a.FlightId
WHERE b.ExportCompletionRecordId IS NULL
   OR (a.RelatedOffloadId IS NOT NULL AND o.OffloadId IS NULL)
   OR (a.RelatedUldId IS NOT NULL AND u.UldId IS NULL);
