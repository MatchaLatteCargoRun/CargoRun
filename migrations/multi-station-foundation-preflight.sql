-- READ ONLY. Live-schema and data preflight for the CargoRun multi-station foundation.
-- Run in query/read-only mode. This script deliberately makes no schema or data changes.
SET NOCOUNT ON;

DECLARE @FlightsObjectId int=OBJECT_ID(N'dbo.Flights',N'U');
DECLARE @StationsObjectId int=OBJECT_ID(N'dbo.CargoRunStations',N'U');
DECLARE @MachObjectId int=OBJECT_ID(N'dbo.IncomingMachMessages',N'U');
DECLARE @FowObjectId int=OBJECT_ID(N'dbo.MachFowShipments',N'U');
DECLARE @ExecutableSql nvarchar(max);
DECLARE @FlightIdReady bit=CASE WHEN OBJECT_ID(N'dbo.Flights',N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'FlightId') IS NOT NULL THEN 1 ELSE 0 END;

DECLARE @FlightCoreReady bit=CASE WHEN @FlightsObjectId IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'FlightId') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'FlightNumber') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'OperatingDate') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'Direction') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'FlightStatus') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'OriginAirport') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'DestinationAirport') IS NOT NULL THEN 1 ELSE 0 END;

DECLARE @StationCoreReady bit=CASE WHEN @StationsObjectId IS NOT NULL
  AND COL_LENGTH(N'dbo.CargoRunStations',N'StationId') IS NOT NULL
  AND COL_LENGTH(N'dbo.CargoRunStations',N'StationCode') IS NOT NULL
  AND COL_LENGTH(N'dbo.CargoRunStations',N'DisplayName') IS NOT NULL
  AND COL_LENGTH(N'dbo.CargoRunStations',N'TimeZoneId') IS NOT NULL
  AND COL_LENGTH(N'dbo.CargoRunStations',N'IsEnabled') IS NOT NULL THEN 1 ELSE 0 END;

DECLARE @MachCoreReady bit=CASE WHEN @MachObjectId IS NOT NULL
  AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MachMessageId') IS NOT NULL
  AND COL_LENGTH(N'dbo.IncomingMachMessages',N'DocumentCorID') IS NOT NULL
  AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MatchedFlightId') IS NOT NULL THEN 1 ELSE 0 END;

-- Runtime binds canonical DocumentCorID values as nvarchar(100). The existing
-- evidence column must be a native, noncomputed character column that can hold
-- the full contract before any canonical identity can be enforced.
DECLARE @DocumentCorIdSchemaReady bit=CASE WHEN EXISTS (
  SELECT 1 FROM sys.columns columnObject
  WHERE columnObject.object_id=@MachObjectId
    AND columnObject.name=N'DocumentCorID'
    AND columnObject.user_type_id=columnObject.system_type_id
    AND columnObject.system_type_id IN (167,231)
    AND columnObject.is_computed=0 AND columnObject.collation_name IS NOT NULL
    AND ((columnObject.system_type_id=167 AND (columnObject.max_length=-1 OR columnObject.max_length>=100))
      OR (columnObject.system_type_id=231 AND (columnObject.max_length=-1 OR columnObject.max_length>=200)))
) THEN 1 ELSE 0 END;

-- 1. Database identity. Confirm the operator is connected to the intended database.
SELECT DB_NAME() AS DatabaseName,@@SERVERNAME AS ServerName,
  CONVERT(datetime2(3),SYSUTCDATETIME()) AS ObservedAtUtc,
  N'READ_ONLY_PREFLIGHT' AS ScriptMode;

-- 2. Required table inventory and target-column existence. CargoRunStations is authoritative.
;WITH TargetTables(TableName,Purpose) AS (
  SELECT * FROM (VALUES
    (N'CargoRunStations',N'AUTHORITATIVE_STATION_MASTER'),
    (N'Flights',N'OPERATIONAL_PARENT'),
    (N'ULDs',N'FLIGHT_CHILD'),
    (N'Offloads',N'FLIGHT_CHILD'),
    (N'AuditEvents',N'OPTIONAL_FLIGHT_CHILD'),
    (N'ImportCompletionRecords',N'FLIGHT_CHILD'),
    (N'ExportCompletionRecords',N'FLIGHT_CHILD'),
    (N'ExportCompletionAmendments',N'FLIGHT_CHILD_OR_INHERITED_CHILD'),
    (N'ExportManifestFinals',N'FLIGHT_CHILD'),
    (N'ExportManifestFinalUlds',N'FINAL_MEMBERSHIP'),
    (N'IncomingMachMessages',N'PRE_MATCH_STATION_EVIDENCE'),
    (N'MachFowShipments',N'FLIGHT_AND_MESSAGE_CHILD')
  ) v(TableName,Purpose)
)
SELECT target.TableName,target.Purpose,
  CONVERT(bit,CASE WHEN tableObject.object_id IS NULL THEN 0 ELSE 1 END) AS TableExists,
  CASE WHEN target.TableName=N'Flights'
    THEN CONVERT(bit,CASE WHEN COL_LENGTH(N'dbo.Flights',N'StationId') IS NULL THEN 0 ELSE 1 END)
    WHEN target.TableName=N'IncomingMachMessages'
    THEN CONVERT(bit,CASE WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'StationId') IS NULL THEN 0 ELSE 1 END)
    ELSE NULL END AS TargetStationIdExists
FROM TargetTables target
LEFT JOIN sys.tables tableObject
  ON tableObject.schema_id=SCHEMA_ID(N'dbo') AND tableObject.name=target.TableName
ORDER BY target.TableName;

-- 3. Column, type, nullability, identity, collation and default inventory.
;WITH TargetTables(TableName) AS (
  SELECT TableName FROM (VALUES
    (N'CargoRunStations'),(N'Flights'),(N'ULDs'),(N'Offloads'),(N'AuditEvents'),
    (N'ImportCompletionRecords'),(N'ExportCompletionRecords'),(N'ExportCompletionAmendments'),
    (N'ExportManifestFinals'),(N'ExportManifestFinalUlds'),
    (N'IncomingMachMessages'),(N'MachFowShipments')
  ) v(TableName)
)
SELECT target.TableName,columnObject.column_id,columnObject.name AS ColumnName,
  TYPE_NAME(columnObject.user_type_id) AS DataType,columnObject.max_length,
  columnObject.[precision],columnObject.scale,columnObject.is_nullable,
  columnObject.is_identity,columnObject.collation_name,
  defaultObject.name AS DefaultConstraint,defaultObject.definition AS DefaultDefinition
FROM TargetTables target
JOIN sys.tables tableObject
  ON tableObject.schema_id=SCHEMA_ID(N'dbo') AND tableObject.name=target.TableName
JOIN sys.columns columnObject ON columnObject.object_id=tableObject.object_id
LEFT JOIN sys.default_constraints defaultObject
  ON defaultObject.parent_object_id=columnObject.object_id
 AND defaultObject.parent_column_id=columnObject.column_id
ORDER BY target.TableName,columnObject.column_id;

-- 4. Primary, unique and non-unique index inventory, including key order and included columns.
;WITH TargetTables(TableName) AS (
  SELECT TableName FROM (VALUES
    (N'CargoRunStations'),(N'Flights'),(N'ULDs'),(N'Offloads'),(N'AuditEvents'),
    (N'ImportCompletionRecords'),(N'ExportCompletionRecords'),(N'ExportCompletionAmendments'),
    (N'ExportManifestFinals'),(N'ExportManifestFinalUlds'),
    (N'IncomingMachMessages'),(N'MachFowShipments')
  ) v(TableName)
)
SELECT target.TableName,indexObject.name AS IndexName,indexObject.type_desc,
  indexObject.is_primary_key,indexObject.is_unique,indexObject.is_unique_constraint,
  indexObject.is_disabled,indexObject.has_filter,indexObject.filter_definition,
  indexColumn.key_ordinal,indexColumn.is_descending_key,indexColumn.is_included_column,
  columnObject.name AS ColumnName
FROM TargetTables target
JOIN sys.tables tableObject
  ON tableObject.schema_id=SCHEMA_ID(N'dbo') AND tableObject.name=target.TableName
JOIN sys.indexes indexObject ON indexObject.object_id=tableObject.object_id
LEFT JOIN sys.index_columns indexColumn
  ON indexColumn.object_id=indexObject.object_id AND indexColumn.index_id=indexObject.index_id
LEFT JOIN sys.columns columnObject
  ON columnObject.object_id=indexColumn.object_id AND columnObject.column_id=indexColumn.column_id
WHERE indexObject.index_id>0
ORDER BY target.TableName,indexObject.name,indexColumn.is_included_column,indexColumn.key_ordinal,indexColumn.index_column_id;

-- 5. Key and check constraints. Defaults are included in result set 3.
;WITH TargetTables(TableName) AS (
  SELECT TableName FROM (VALUES
    (N'CargoRunStations'),(N'Flights'),(N'ULDs'),(N'Offloads'),(N'AuditEvents'),
    (N'ImportCompletionRecords'),(N'ExportCompletionRecords'),(N'ExportCompletionAmendments'),
    (N'ExportManifestFinals'),(N'ExportManifestFinalUlds'),
    (N'IncomingMachMessages'),(N'MachFowShipments')
  ) v(TableName)
)
SELECT target.TableName,N'KEY' AS ConstraintCategory,keyObject.type_desc,
  keyObject.name AS ConstraintName,CONVERT(bit,0) AS is_disabled,
  CONVERT(bit,0) AS is_not_trusted,CAST(NULL AS nvarchar(max)) AS Definition
FROM TargetTables target
JOIN sys.tables tableObject
  ON tableObject.schema_id=SCHEMA_ID(N'dbo') AND tableObject.name=target.TableName
JOIN sys.key_constraints keyObject ON keyObject.parent_object_id=tableObject.object_id
UNION ALL
SELECT target.TableName,N'CHECK',N'CHECK_CONSTRAINT',checkObject.name,
  checkObject.is_disabled,checkObject.is_not_trusted,checkObject.definition
FROM TargetTables target
JOIN sys.tables tableObject
  ON tableObject.schema_id=SCHEMA_ID(N'dbo') AND tableObject.name=target.TableName
JOIN sys.check_constraints checkObject ON checkObject.parent_object_id=tableObject.object_id
ORDER BY TableName,ConstraintCategory,ConstraintName;

-- 6. Foreign-key inventory with ordered parent/referenced columns.
;WITH TargetTables(TableName) AS (
  SELECT TableName FROM (VALUES
    (N'CargoRunStations'),(N'Flights'),(N'ULDs'),(N'Offloads'),(N'AuditEvents'),
    (N'ImportCompletionRecords'),(N'ExportCompletionRecords'),(N'ExportCompletionAmendments'),
    (N'ExportManifestFinals'),(N'ExportManifestFinalUlds'),
    (N'IncomingMachMessages'),(N'MachFowShipments')
  ) v(TableName)
)
SELECT target.TableName,foreignKey.name AS ForeignKeyName,foreignKey.is_disabled,
  foreignKey.is_not_trusted,foreignKey.delete_referential_action_desc,
  foreignKey.update_referential_action_desc,foreignColumn.constraint_column_id,
  parentColumn.name AS ParentColumn,OBJECT_SCHEMA_NAME(foreignKey.referenced_object_id) AS ReferencedSchema,
  OBJECT_NAME(foreignKey.referenced_object_id) AS ReferencedTable,referencedColumn.name AS ReferencedColumn
FROM TargetTables target
JOIN sys.tables tableObject
  ON tableObject.schema_id=SCHEMA_ID(N'dbo') AND tableObject.name=target.TableName
JOIN sys.foreign_keys foreignKey ON foreignKey.parent_object_id=tableObject.object_id
JOIN sys.foreign_key_columns foreignColumn ON foreignColumn.constraint_object_id=foreignKey.object_id
JOIN sys.columns parentColumn
  ON parentColumn.object_id=foreignColumn.parent_object_id AND parentColumn.column_id=foreignColumn.parent_column_id
JOIN sys.columns referencedColumn
  ON referencedColumn.object_id=foreignColumn.referenced_object_id AND referencedColumn.column_id=foreignColumn.referenced_column_id
ORDER BY target.TableName,foreignKey.name,foreignColumn.constraint_column_id;

-- 7. Trigger inventory.
;WITH TargetTables(TableName) AS (
  SELECT TableName FROM (VALUES
    (N'CargoRunStations'),(N'Flights'),(N'ULDs'),(N'Offloads'),(N'AuditEvents'),
    (N'ImportCompletionRecords'),(N'ExportCompletionRecords'),(N'ExportCompletionAmendments'),
    (N'ExportManifestFinals'),(N'ExportManifestFinalUlds'),
    (N'IncomingMachMessages'),(N'MachFowShipments')
  ) v(TableName)
)
SELECT target.TableName,triggerObject.name AS TriggerName,triggerObject.is_disabled,
  triggerObject.is_instead_of_trigger,OBJECT_DEFINITION(triggerObject.object_id) AS TriggerDefinition
FROM TargetTables target
JOIN sys.tables tableObject
  ON tableObject.schema_id=SCHEMA_ID(N'dbo') AND tableObject.name=target.TableName
JOIN sys.triggers triggerObject ON triggerObject.parent_id=tableObject.object_id
ORDER BY target.TableName,triggerObject.name;

-- 8. Authoritative station rows. Missing columns are reported without compiling an unsafe direct reference.
IF @StationCoreReady=1
BEGIN
  SET @ExecutableSql=N'
    SELECT StationId,StationCode,DisplayName,TimeZoneId,IsEnabled
    FROM dbo.CargoRunStations
    ORDER BY StationCode,StationId;';
  EXEC sys.sp_executesql @ExecutableSql;
END;
ELSE
  SELECT CAST(NULL AS bigint) AS StationId,CAST(NULL AS varchar(3)) AS StationCode,
    CAST(NULL AS nvarchar(100)) AS DisplayName,CAST(NULL AS nvarchar(100)) AS TimeZoneId,
    CAST(NULL AS bit) AS IsEnabled
  WHERE 1=0;

-- 9. Station-master validation details. Every returned row is a STOP condition.
DECLARE @StationValidationSql nvarchar(max)=N'
  SELECT N''STATION_MASTER_SCHEMA_INVALID'' AS Finding,
    CONCAT(N''Missing or materially different column: '',required.ColumnName) AS Detail
  FROM (VALUES
    (N''StationId'',N''bigint'',CONVERT(bit,0),CONVERT(bit,1),CAST(NULL AS smallint)),
    (N''StationCode'',N''varchar'',CONVERT(bit,0),CONVERT(bit,0),CONVERT(smallint,3)),
    (N''DisplayName'',N''nvarchar'',CONVERT(bit,0),CONVERT(bit,0),CONVERT(smallint,200)),
    (N''TimeZoneId'',N''nvarchar'',CONVERT(bit,0),CONVERT(bit,0),CONVERT(smallint,200)),
    (N''IsEnabled'',N''bit'',CONVERT(bit,0),CONVERT(bit,0),CONVERT(smallint,1)),
    (N''CreatedAtUtc'',N''datetime2'',CONVERT(bit,0),CONVERT(bit,0),CAST(NULL AS smallint)),
    (N''CreatedByReference'',N''nvarchar'',CONVERT(bit,0),CONVERT(bit,0),CONVERT(smallint,300))
  ) required(ColumnName,DataType,IsNullable,IsIdentity,MaxLength)
  LEFT JOIN sys.columns columnObject
    ON columnObject.object_id=OBJECT_ID(N''dbo.CargoRunStations'',N''U'')
   AND columnObject.name=required.ColumnName
  WHERE columnObject.column_id IS NULL
     OR TYPE_NAME(columnObject.user_type_id)<>required.DataType
     OR columnObject.is_nullable<>required.IsNullable
     OR columnObject.is_identity<>required.IsIdentity
     OR (required.MaxLength IS NOT NULL AND columnObject.max_length<>required.MaxLength)
  UNION ALL
  SELECT N''STATION_CODE_UNIQUENESS_NOT_ENFORCED'',
    N''An enabled, unfiltered unique index whose sole key is StationCode is required.''
  WHERE NOT EXISTS (
    SELECT 1
    FROM sys.indexes indexObject
    WHERE indexObject.object_id=OBJECT_ID(N''dbo.CargoRunStations'',N''U'')
      AND indexObject.is_unique=1 AND indexObject.is_disabled=0 AND indexObject.has_filter=0
      AND 1=(SELECT COUNT(*) FROM sys.index_columns keyColumn
             WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id
               AND keyColumn.key_ordinal>0)
      AND EXISTS (
        SELECT 1 FROM sys.index_columns keyColumn
        JOIN sys.columns columnObject
          ON columnObject.object_id=keyColumn.object_id AND columnObject.column_id=keyColumn.column_id
        WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id
          AND keyColumn.key_ordinal=1 AND columnObject.name=N''StationCode''
      )
  );';

IF @StationCoreReady=1
  SET @StationValidationSql+=N'
    SELECT N''MEL_STATION_MISSING'' AS Finding,N''Exactly one enabled MEL station is required.'' AS Detail
    WHERE NOT EXISTS (
      SELECT 1 FROM dbo.CargoRunStations
      WHERE UPPER(LTRIM(RTRIM(StationCode)))=N''MEL'' AND IsEnabled=1
    )
    UNION ALL
    SELECT N''MULTIPLE_ENABLED_MEL_STATIONS'',N''More than one enabled MEL row exists.''
    WHERE (SELECT COUNT_BIG(*) FROM dbo.CargoRunStations
           WHERE UPPER(LTRIM(RTRIM(StationCode)))=N''MEL'' AND IsEnabled=1)>1
    UNION ALL
    SELECT N''MEL_TIMEZONE_INVALID'',CONCAT(N''StationId '',StationId,N'' has timezone '',COALESCE(TimeZoneId,N''<null>''),N''.'')
    FROM dbo.CargoRunStations
    WHERE UPPER(LTRIM(RTRIM(StationCode)))=N''MEL'' AND IsEnabled=1
      AND (NULLIF(LTRIM(RTRIM(TimeZoneId)),N'''') IS NULL
        OR LTRIM(RTRIM(TimeZoneId)) NOT LIKE N''%/%''
        OR LTRIM(RTRIM(TimeZoneId)) LIKE N''/%''
        OR LTRIM(RTRIM(TimeZoneId)) LIKE N''%/''
        OR LTRIM(RTRIM(TimeZoneId)) LIKE N''%//%'');';

EXEC sys.sp_executesql @StationValidationSql;

-- Optional source fields are selected only when the live columns exist.
DECLARE @FlightSourceExpression nvarchar(400)=CASE
  WHEN COL_LENGTH(N'dbo.Flights',N'SourceType') IS NOT NULL THEN N'CONVERT(nvarchar(100),f.SourceType)'
  WHEN COL_LENGTH(N'dbo.Flights',N'Source') IS NOT NULL THEN N'CONVERT(nvarchar(100),f.Source)'
  WHEN COL_LENGTH(N'dbo.Flights',N'CreatedSource') IS NOT NULL THEN N'CONVERT(nvarchar(100),f.CreatedSource)'
  ELSE N'CAST(NULL AS nvarchar(100))' END;
DECLARE @FlightCreatedExpression nvarchar(400)=CASE
  WHEN COL_LENGTH(N'dbo.Flights',N'CreatedAtUtc') IS NOT NULL THEN N'CONVERT(datetime2(3),f.CreatedAtUtc)'
  WHEN COL_LENGTH(N'dbo.Flights',N'CreatedAt') IS NOT NULL THEN N'CONVERT(datetime2(3),f.CreatedAt)'
  ELSE N'CAST(NULL AS datetime2(3))' END;

-- MACH evidence is kept metadata-gated because historical schemas may lack modern fields.
DECLARE @MachEvidenceOriginExpression nvarchar(300)=CASE
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'OriginAirport') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.OriginAirport)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'SegmentOrigin') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.SegmentOrigin)'
  ELSE N'CAST(NULL AS nvarchar(20))' END;
DECLARE @MachEvidenceDestinationExpression nvarchar(300)=CASE
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'DestinationAirport') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.DestinationAirport)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'SegmentDestination') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.SegmentDestination)'
  ELSE N'CAST(NULL AS nvarchar(20))' END;
DECLARE @MachEvidenceCte nvarchar(max);
IF @MachCoreReady=1 AND COL_LENGTH(N'dbo.IncomingMachMessages',N'StationAirport') IS NOT NULL
  SET @MachEvidenceCte=N'
    SELECT TRY_CONVERT(bigint,message.MatchedFlightId) AS FlightId,
      SUM(CASE WHEN UPPER(LTRIM(RTRIM(message.StationAirport)))=N''MEL'' THEN 1 ELSE 0 END) AS MachMelCount,
      SUM(CASE WHEN NULLIF(LTRIM(RTRIM(message.StationAirport)),N'''') IS NOT NULL
                    AND UPPER(LTRIM(RTRIM(message.StationAirport)))<>N''MEL'' THEN 1 ELSE 0 END) AS MachConflictCount,
      SUM(CASE WHEN NULLIF(LTRIM(RTRIM(message.StationAirport)),N'''') IS NULL
                    OR LEN(LTRIM(RTRIM(message.StationAirport)))<>3
                    OR UPPER(LTRIM(RTRIM(message.StationAirport))) COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%''
               THEN 1 ELSE 0 END) AS MachInvalidCount
      ,SUM(CASE
        WHEN matchedFlight.FlightId IS NOT NULL
          AND ('+@MachEvidenceOriginExpression+N' IS NOT NULL
            AND UPPER(LTRIM(RTRIM('+@MachEvidenceOriginExpression+N')))<>UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),matchedFlight.OriginAirport))))
            OR '+@MachEvidenceDestinationExpression+N' IS NOT NULL
            AND UPPER(LTRIM(RTRIM('+@MachEvidenceDestinationExpression+N')))<>UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),matchedFlight.DestinationAirport)))))
          THEN 1 ELSE 0 END) AS MachRouteConflictCount
    FROM dbo.IncomingMachMessages message
    LEFT JOIN dbo.Flights matchedFlight ON matchedFlight.FlightId=TRY_CONVERT(bigint,message.MatchedFlightId)
    WHERE message.MatchedFlightId IS NOT NULL
    GROUP BY TRY_CONVERT(bigint,message.MatchedFlightId)';
ELSE
  SET @MachEvidenceCte=N'
    SELECT CAST(NULL AS bigint) AS FlightId,CONVERT(bigint,0) AS MachMelCount,
      CONVERT(bigint,0) AS MachConflictCount,CONVERT(bigint,0) AS MachInvalidCount,
      CONVERT(bigint,0) AS MachRouteConflictCount
    WHERE 1=0';

DECLARE @FlightClassificationCte nvarchar(max)=N'WITH MachEvidence AS ('+@MachEvidenceCte+N'),
  FlightEvidence AS (
    SELECT f.FlightId,f.FlightNumber,f.OperatingDate,f.Direction,f.FlightStatus,
      f.OriginAirport,f.DestinationAirport,'+@FlightSourceExpression+N' AS SourceIndicator,
      '+@FlightCreatedExpression+N' AS CreatedAtUtc,
      COALESCE(m.MachMelCount,0) AS MachMelCount,
      COALESCE(m.MachConflictCount,0) AS MachConflictCount,
      COALESCE(m.MachInvalidCount,0) AS MachInvalidCount,
      COALESCE(m.MachRouteConflictCount,0) AS MachRouteConflictCount,
      UPPER(LTRIM(RTRIM(CONVERT(nvarchar(30),f.Direction)))) AS DirectionKey,
      UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),f.OriginAirport)))) AS OriginKey,
      UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),f.DestinationAirport)))) AS DestinationKey
    FROM dbo.Flights f
    LEFT JOIN MachEvidence m ON m.FlightId=TRY_CONVERT(bigint,f.FlightId)
  ), ClassifiedFlights AS (
    SELECT evidence.*,
      CASE
        WHEN evidence.DirectionKey NOT IN (N''IMPORT'',N''EXPORT'')
          OR NULLIF(evidence.OriginKey,N'''') IS NULL OR NULLIF(evidence.DestinationKey,N'''') IS NULL
          OR LEN(evidence.OriginKey) NOT IN (3,4) OR LEN(evidence.DestinationKey) NOT IN (3,4)
          OR evidence.OriginKey COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%''
          OR evidence.DestinationKey COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%''
          OR evidence.OriginKey=evidence.DestinationKey
          OR (evidence.DirectionKey=N''IMPORT'' AND evidence.DestinationKey<>N''MEL'')
          OR (evidence.DirectionKey=N''EXPORT'' AND evidence.OriginKey<>N''MEL'')
          OR evidence.MachConflictCount>0 OR evidence.MachInvalidCount>0 OR evidence.MachRouteConflictCount>0
          THEN N''CONTRADICTORY''
        WHEN evidence.MachMelCount>0 THEN N''SAFE_MEL_CANDIDATE''
        ELSE N''AMBIGUOUS''
      END AS OwnershipClassification,
      CASE
        WHEN NULLIF(evidence.DirectionKey,N'''') IS NULL THEN N''Direction is null or blank''
        WHEN evidence.DirectionKey NOT IN (N''IMPORT'',N''EXPORT'') THEN N''Direction is unsupported''
        WHEN NULLIF(evidence.OriginKey,N'''') IS NULL OR NULLIF(evidence.DestinationKey,N'''') IS NULL THEN N''Airport code is null or blank''
        WHEN LEN(evidence.OriginKey) NOT IN (3,4) OR LEN(evidence.DestinationKey) NOT IN (3,4)
          OR evidence.OriginKey COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%''
          OR evidence.DestinationKey COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%'' THEN N''Airport code is malformed''
        WHEN evidence.OriginKey=evidence.DestinationKey THEN N''Origin and destination are identical''
        WHEN evidence.DirectionKey=N''IMPORT'' AND evidence.DestinationKey<>N''MEL'' THEN N''Import destination is not MEL''
        WHEN evidence.DirectionKey=N''EXPORT'' AND evidence.OriginKey<>N''MEL'' THEN N''Export origin is not MEL''
        WHEN evidence.MachConflictCount>0 THEN N''MACH station contradicts MEL ownership''
        WHEN evidence.MachInvalidCount>0 THEN N''Matched MACH station is null or malformed''
        WHEN evidence.MachRouteConflictCount>0 THEN N''Matched MACH segment contradicts the flight route''
        WHEN evidence.MachMelCount>0 THEN N''Route and matched MACH station support MEL''
        ELSE N''Route is MEL-consistent but lacks independent database corroboration''
      END AS ClassificationReason
    FROM FlightEvidence evidence
  )';

-- 10. Flight population inventory. Each result is empty, rather than unsafe, if core columns are absent.
IF @FlightCoreReady=1
BEGIN
  SET @ExecutableSql=N'
    SELECT COUNT_BIG(*) AS TotalFlights,MIN(OperatingDate) AS EarliestOperatingDate,
      MAX(OperatingDate) AS LatestOperatingDate
    FROM dbo.Flights;
    SELECT Direction,COUNT_BIG(*) AS RecordCount FROM dbo.Flights GROUP BY Direction ORDER BY Direction;
    SELECT FlightStatus,COUNT_BIG(*) AS RecordCount FROM dbo.Flights GROUP BY FlightStatus ORDER BY FlightStatus;
    SELECT DATEPART(year,OperatingDate) AS OperatingYear,MIN(OperatingDate) AS EarliestOperatingDate,
      MAX(OperatingDate) AS LatestOperatingDate,COUNT_BIG(*) AS RecordCount
    FROM dbo.Flights GROUP BY DATEPART(year,OperatingDate) ORDER BY OperatingYear;
    SELECT OriginAirport,COUNT_BIG(*) AS RecordCount FROM dbo.Flights GROUP BY OriginAirport ORDER BY OriginAirport;
    SELECT DestinationAirport,COUNT_BIG(*) AS RecordCount FROM dbo.Flights GROUP BY DestinationAirport ORDER BY DestinationAirport;';
  EXEC sys.sp_executesql @ExecutableSql;

  SET @ExecutableSql=@FlightClassificationCte+N'
    SELECT SourceIndicator,COUNT_BIG(*) AS RecordCount,MIN(CreatedAtUtc) AS EarliestCreatedAtUtc,
      MAX(CreatedAtUtc) AS LatestCreatedAtUtc
    FROM ClassifiedFlights GROUP BY SourceIndicator ORDER BY SourceIndicator;';
  EXEC sys.sp_executesql @ExecutableSql;
  SET @ExecutableSql=@FlightClassificationCte+N'
    SELECT OwnershipClassification,COUNT_BIG(*) AS RecordCount
    FROM ClassifiedFlights GROUP BY OwnershipClassification ORDER BY OwnershipClassification;';
  EXEC sys.sp_executesql @ExecutableSql;
  SET @ExecutableSql=@FlightClassificationCte+N'
    SELECT FlightId,FlightNumber,OperatingDate,Direction,FlightStatus,OriginAirport,DestinationAirport,
      SourceIndicator,CreatedAtUtc,MachMelCount,MachConflictCount,MachInvalidCount,MachRouteConflictCount,
      OwnershipClassification,ClassificationReason
    FROM ClassifiedFlights
    ORDER BY OwnershipClassification,OperatingDate,FlightId;';
  EXEC sys.sp_executesql @ExecutableSql;
END;
ELSE
BEGIN
  SELECT CAST(NULL AS bigint) AS TotalFlights,CAST(NULL AS date) AS EarliestOperatingDate,
    CAST(NULL AS date) AS LatestOperatingDate WHERE 1=0;
  SELECT CAST(NULL AS nvarchar(30)) AS OwnershipClassification,CAST(NULL AS bigint) AS RecordCount WHERE 1=0;
  SELECT CAST(NULL AS bigint) AS FlightId,CAST(NULL AS nvarchar(50)) AS FlightNumber,
    CAST(NULL AS nvarchar(30)) AS OwnershipClassification,CAST(NULL AS nvarchar(300)) AS ClassificationReason
  WHERE 1=0;
END;

-- 11. MACH/FOW corroboration and inconsistencies, using only fields present in the live schema.
DECLARE @MachStationExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'StationAirport') IS NOT NULL
  THEN N'CONVERT(nvarchar(20),message.StationAirport)' ELSE N'CAST(NULL AS nvarchar(20))' END;
DECLARE @MachOriginExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'OriginAirport') IS NOT NULL
  THEN N'CONVERT(nvarchar(20),message.OriginAirport)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'SegmentOrigin') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.SegmentOrigin)'
  ELSE N'CAST(NULL AS nvarchar(20))' END;
DECLARE @MachDestinationExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'DestinationAirport') IS NOT NULL
  THEN N'CONVERT(nvarchar(20),message.DestinationAirport)'
  WHEN COL_LENGTH(N'dbo.IncomingMachMessages',N'SegmentDestination') IS NOT NULL THEN N'CONVERT(nvarchar(20),message.SegmentDestination)'
  ELSE N'CAST(NULL AS nvarchar(20))' END;

-- DocumentCorID contract shared with api/shared/document-cor-id.js:
-- trim only outer U+0020, accept 1-100 ASCII letters/digits/hyphens, then
-- canonicalize ASCII letters to uppercase. Existing evidence is never rewritten.
-- TRANSLATE removes only allowed code units, leaving U+0000 and every other
-- unsupported code unit detectable by DATALENGTH without collation folding.
DECLARE @DocumentIdentityCte nvarchar(max)=N'WITH RawDocumentIdentity AS (
    SELECT message.MachMessageId,
      CONVERT(nvarchar(max),message.DocumentCorID) AS RawDocumentCorID,
      LTRIM(RTRIM(CONVERT(nvarchar(max),message.DocumentCorID))) AS TrimmedDocumentCorID
    FROM dbo.IncomingMachMessages message
  ), AssessedDocumentIdentity AS (
    SELECT raw.*,
      UPPER(raw.TrimmedDocumentCorID COLLATE Latin1_General_100_BIN2) AS CanonicalDocumentCorID,
      CASE WHEN raw.RawDocumentCorID IS NULL OR DATALENGTH(raw.TrimmedDocumentCorID)=0
             OR DATALENGTH(raw.TrimmedDocumentCorID)>200
             OR DATALENGTH(REPLACE(TRANSLATE(
               raw.TrimmedDocumentCorID COLLATE Latin1_General_100_BIN2,
               N''ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-'',REPLICATE(N''A'',63)),N''A'',N''''))<>0
        THEN CONVERT(bit,1) ELSE CONVERT(bit,0) END AS IsInvalid
    FROM RawDocumentIdentity raw
  ), ClassifiedDocumentIdentity AS (
    SELECT assessed.*,
      CASE WHEN assessed.IsInvalid=0
             AND (DATALENGTH(assessed.RawDocumentCorID)<>DATALENGTH(assessed.CanonicalDocumentCorID)
               OR assessed.RawDocumentCorID COLLATE Latin1_General_100_BIN2
                    <>assessed.CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2)
        THEN CONVERT(bit,1) ELSE CONVERT(bit,0) END AS RequiresCanonicalization
    FROM AssessedDocumentIdentity assessed
  )';

IF @DocumentCorIdSchemaReady=1
BEGIN
  SET @ExecutableSql=@DocumentIdentityCte+N'
    SELECT MachMessageId,RawDocumentCorID,TrimmedDocumentCorID,CanonicalDocumentCorID,
      CASE WHEN IsInvalid=1 THEN N''INVALID_DOCUMENTCORID''
           ELSE N''DOCUMENTCORID_CANONICALIZATION_REQUIRED'' END AS Finding
    FROM ClassifiedDocumentIdentity
    WHERE IsInvalid=1 OR RequiresCanonicalization=1
    ORDER BY MachMessageId;';
  EXEC sys.sp_executesql @ExecutableSql;

  SET @ExecutableSql=@DocumentIdentityCte+N'
    SELECT CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2 AS CanonicalDocumentCorID,
      COUNT_BIG(*) AS MessageCount,
      N''DOCUMENTCORID_CANONICAL_COLLISION'' AS Finding
    FROM ClassifiedDocumentIdentity
    WHERE IsInvalid=0
    GROUP BY CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2
    HAVING COUNT_BIG(*)>1
    ORDER BY CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2;';
  EXEC sys.sp_executesql @ExecutableSql;
END;
ELSE
  SELECT N'INVALID_DOCUMENTCORID_SCHEMA' AS Finding,
    N'IncomingMachMessages.DocumentCorID must be a native noncomputed varchar/nvarchar column with capacity for 100 ASCII characters.' AS Detail;

IF @MachCoreReady=1
BEGIN
  DECLARE @MachMessageCte nvarchar(max)=N'WITH MessageEvidence AS (
      SELECT message.MachMessageId,message.DocumentCorID,message.MatchedFlightId,
        '+@MachStationExpression+N' AS StationAirport,
        '+@MachOriginExpression+N' AS SegmentOrigin,
        '+@MachDestinationExpression+N' AS SegmentDestination
      FROM dbo.IncomingMachMessages message
    )';
  SET @ExecutableSql=@MachMessageCte+N'
    SELECT CASE
        WHEN MatchedFlightId IS NULL THEN N''UNMATCHED''
        WHEN NULLIF(LTRIM(RTRIM(StationAirport)),N'''') IS NULL
          OR LEN(LTRIM(RTRIM(StationAirport)))<>3
          OR UPPER(LTRIM(RTRIM(StationAirport))) COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%'' THEN N''INVALID_STATION''
        WHEN UPPER(LTRIM(RTRIM(StationAirport)))=N''MEL'' THEN N''MEL_SUPPORT''
        ELSE N''STATION_CONFLICT'' END AS EvidenceClassification,
      COUNT_BIG(*) AS RecordCount
    FROM MessageEvidence
    GROUP BY CASE
        WHEN MatchedFlightId IS NULL THEN N''UNMATCHED''
        WHEN NULLIF(LTRIM(RTRIM(StationAirport)),N'''') IS NULL
          OR LEN(LTRIM(RTRIM(StationAirport)))<>3
          OR UPPER(LTRIM(RTRIM(StationAirport))) COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%'' THEN N''INVALID_STATION''
        WHEN UPPER(LTRIM(RTRIM(StationAirport)))=N''MEL'' THEN N''MEL_SUPPORT''
        ELSE N''STATION_CONFLICT'' END
    ORDER BY EvidenceClassification;';
  EXEC sys.sp_executesql @ExecutableSql;
  IF @FlightCoreReady=1
  BEGIN
    SET @ExecutableSql=@MachMessageCte+N'
      SELECT message.MachMessageId,message.DocumentCorID,message.MatchedFlightId,
        message.StationAirport,message.SegmentOrigin,message.SegmentDestination,
        flight.FlightId,flight.Direction,flight.OriginAirport AS FlightOriginAirport,
        flight.DestinationAirport AS FlightDestinationAirport,
        CASE
          WHEN message.MatchedFlightId IS NULL THEN N''UNMATCHED_MESSAGE''
          WHEN flight.FlightId IS NULL THEN N''MATCHED_FLIGHT_MISSING''
          WHEN NULLIF(LTRIM(RTRIM(message.StationAirport)),N'''') IS NULL THEN N''INVALID_MESSAGE_STATION''
          WHEN UPPER(LTRIM(RTRIM(message.StationAirport)))<>N''MEL'' THEN N''MACH_STATION_CONFLICT''
          WHEN UPPER(LTRIM(RTRIM(CONVERT(nvarchar(30),flight.Direction))))=N''IMPORT''
            AND UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),flight.DestinationAirport))))<>N''MEL'' THEN N''MESSAGE_FLIGHT_ROUTE_CONFLICT''
          WHEN UPPER(LTRIM(RTRIM(CONVERT(nvarchar(30),flight.Direction))))=N''EXPORT''
            AND UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),flight.OriginAirport))))<>N''MEL'' THEN N''MESSAGE_FLIGHT_ROUTE_CONFLICT''
          WHEN message.SegmentOrigin IS NOT NULL AND message.FlightId IS NOT NULL
            AND UPPER(LTRIM(RTRIM(message.SegmentOrigin)))<>UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),flight.OriginAirport)))) THEN N''MESSAGE_SEGMENT_CONFLICT''
          WHEN message.SegmentDestination IS NOT NULL AND message.FlightId IS NOT NULL
            AND UPPER(LTRIM(RTRIM(message.SegmentDestination)))<>UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),flight.DestinationAirport)))) THEN N''MESSAGE_SEGMENT_CONFLICT''
          ELSE N''CONSISTENT'' END AS Finding
      FROM (
        SELECT evidence.*,evidence.MatchedFlightId AS FlightId FROM MessageEvidence evidence
      ) message
      LEFT JOIN dbo.Flights flight ON flight.FlightId=TRY_CONVERT(bigint,message.MatchedFlightId)
      WHERE message.MatchedFlightId IS NULL OR flight.FlightId IS NULL
         OR NULLIF(LTRIM(RTRIM(message.StationAirport)),N'''') IS NULL
         OR UPPER(LTRIM(RTRIM(message.StationAirport)))<>N''MEL''
         OR (UPPER(LTRIM(RTRIM(CONVERT(nvarchar(30),flight.Direction))))=N''IMPORT''
             AND UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),flight.DestinationAirport))))<>N''MEL'')
         OR (UPPER(LTRIM(RTRIM(CONVERT(nvarchar(30),flight.Direction))))=N''EXPORT''
             AND UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),flight.OriginAirport))))<>N''MEL'')
         OR (message.SegmentOrigin IS NOT NULL AND flight.FlightId IS NOT NULL
             AND UPPER(LTRIM(RTRIM(message.SegmentOrigin)))<>UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),flight.OriginAirport)))))
         OR (message.SegmentDestination IS NOT NULL AND flight.FlightId IS NOT NULL
             AND UPPER(LTRIM(RTRIM(message.SegmentDestination)))<>UPPER(LTRIM(RTRIM(CONVERT(nvarchar(20),flight.DestinationAirport)))));';
    EXEC sys.sp_executesql @ExecutableSql;
  END;
  ELSE
    SELECT N'MACH_FLIGHT_CORROBORATION_UNAVAILABLE' AS Finding,
      N'Flights core route columns are missing; message-to-flight route comparison was skipped.' AS Detail;
  SET @ExecutableSql=@MachMessageCte+N'
    SELECT UPPER(LTRIM(RTRIM(CONVERT(nvarchar(max),DocumentCorID))) COLLATE Latin1_General_100_BIN2 AS CanonicalDocumentCorID,
      COUNT_BIG(*) AS MessageCount,
      COUNT(DISTINCT COALESCE(CONVERT(nvarchar(100),MatchedFlightId),N''<NULL>'')) AS DistinctMatchedFlightCount,
      COUNT(DISTINCT UPPER(LTRIM(RTRIM(COALESCE(StationAirport,N''<NULL>'')))) COLLATE Latin1_General_100_BIN2) AS DistinctStationCount
    FROM MessageEvidence
    GROUP BY UPPER(LTRIM(RTRIM(CONVERT(nvarchar(max),DocumentCorID))) COLLATE Latin1_General_100_BIN2
    HAVING COUNT(DISTINCT COALESCE(CONVERT(nvarchar(100),MatchedFlightId),N''<NULL>''))>1
        OR COUNT(DISTINCT UPPER(LTRIM(RTRIM(COALESCE(StationAirport,N''<NULL>'')))) COLLATE Latin1_General_100_BIN2)>1
    ORDER BY CanonicalDocumentCorID;';
  EXEC sys.sp_executesql @ExecutableSql;
END;
ELSE
BEGIN
  SELECT N'MISSING_MACH_COLUMN' AS Finding,required.ColumnName AS Detail
  FROM (VALUES(N'MachMessageId'),(N'DocumentCorID'),(N'MatchedFlightId')) required(ColumnName)
  WHERE @MachObjectId IS NULL OR COL_LENGTH(N'dbo.IncomingMachMessages',required.ColumnName) IS NULL;
END;

IF @FowObjectId IS NOT NULL
   AND COL_LENGTH(N'dbo.MachFowShipments',N'MachMessageId') IS NOT NULL
   AND COL_LENGTH(N'dbo.MachFowShipments',N'FlightId') IS NOT NULL
   AND @MachCoreReady=1
BEGIN
  SET @ExecutableSql=N'
    SELECT shipment.MachMessageId,shipment.FlightId AS ShipmentFlightId,
      message.MatchedFlightId AS MessageFlightId
    FROM dbo.MachFowShipments shipment
    LEFT JOIN dbo.IncomingMachMessages message ON message.MachMessageId=shipment.MachMessageId
    WHERE message.MachMessageId IS NULL
       OR TRY_CONVERT(bigint,shipment.FlightId)<>TRY_CONVERT(bigint,message.MatchedFlightId)
       OR message.MatchedFlightId IS NULL
    ORDER BY shipment.MachMessageId,shipment.FlightId;';
  EXEC sys.sp_executesql @ExecutableSql;
END;
ELSE
  SELECT N'MISSING_FOW_CORROBORATION_COLUMN' AS Finding,required.ColumnName AS Detail
  FROM (VALUES(N'MachFowShipments.MachMessageId'),(N'MachFowShipments.FlightId'),
              (N'IncomingMachMessages.MachMessageId'),(N'IncomingMachMessages.MatchedFlightId')) required(ColumnName)
  WHERE (@FowObjectId IS NULL OR @MachObjectId IS NULL)
     OR (required.ColumnName=N'MachFowShipments.MachMessageId' AND COL_LENGTH(N'dbo.MachFowShipments',N'MachMessageId') IS NULL)
     OR (required.ColumnName=N'MachFowShipments.FlightId' AND COL_LENGTH(N'dbo.MachFowShipments',N'FlightId') IS NULL)
     OR (required.ColumnName=N'IncomingMachMessages.MachMessageId' AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MachMessageId') IS NULL)
     OR (required.ColumnName=N'IncomingMachMessages.MatchedFlightId' AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MatchedFlightId') IS NULL);

-- 12. Canonical identity preflight. The normalizer mirrors api/shared/flight.js for parity-safe rows.
-- JavaScript \s and Number semantics cannot be guaranteed for unusual Unicode whitespace or long numbers;
-- those rows are deliberately excluded from collision decisions and returned for application-assisted verification.
DECLARE @CanonicalCte nvarchar(max)=N'WITH RawFlightIdentity AS (
    SELECT f.FlightId,f.OperatingDate,f.Direction,f.FlightStatus,'+@FlightSourceExpression+N' AS SourceIndicator,
      CONVERT(nvarchar(4000),f.FlightNumber) AS OriginalFlightNumber,
      UPPER(REPLACE(REPLACE(REPLACE(REPLACE(LTRIM(RTRIM(CONVERT(nvarchar(4000),f.FlightNumber))),
        N'' '',N''''),NCHAR(9),N''''),NCHAR(10),N''''),NCHAR(13),N'''')) AS CompactFlightNumber
    FROM dbo.Flights f
  ), ParsedFlightIdentity AS (
    SELECT raw.*,
      CASE WHEN SUBSTRING(raw.CompactFlightNumber,3,1) COLLATE Latin1_General_100_BIN2 LIKE N''[0-9]'' THEN 2
           WHEN SUBSTRING(raw.CompactFlightNumber,4,1) COLLATE Latin1_General_100_BIN2 LIKE N''[0-9]'' THEN 3
           ELSE NULL END AS PrefixLength,
      CASE WHEN RIGHT(raw.CompactFlightNumber,1) COLLATE Latin1_General_100_BIN2 LIKE N''[A-Z]'' THEN 1 ELSE 0 END AS SuffixLength,
      CASE WHEN CONVERT(nvarchar(4000),raw.OriginalFlightNumber) COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Za-z0-9 ''+NCHAR(9)+NCHAR(10)+NCHAR(13)+N'']%''
           THEN 1 ELSE 0 END AS HasUnmodelledWhitespaceOrCharacter
    FROM RawFlightIdentity raw
  ), NumericFlightIdentity AS (
    SELECT parsed.*,
      CASE WHEN parsed.PrefixLength IS NULL THEN NULL
           ELSE SUBSTRING(parsed.CompactFlightNumber,parsed.PrefixLength+1,
             LEN(parsed.CompactFlightNumber)-parsed.PrefixLength-parsed.SuffixLength) END AS NumericSegment
    FROM ParsedFlightIdentity parsed
  ), CanonicalFlightIdentity AS (
    SELECT numericPart.*,
      CASE WHEN numericPart.PrefixLength IS NOT NULL
             AND NULLIF(numericPart.NumericSegment,N'''') IS NOT NULL
             AND numericPart.NumericSegment COLLATE Latin1_General_100_BIN2 NOT LIKE N''%[^0-9]%''
             AND LEN(numericPart.NumericSegment)<=15
             AND numericPart.HasUnmodelledWhitespaceOrCharacter=0
           THEN CONVERT(bit,1) ELSE CONVERT(bit,0) END AS SqlParityGuaranteed,
      CASE WHEN numericPart.PrefixLength IS NOT NULL
             AND NULLIF(numericPart.NumericSegment,N'''') IS NOT NULL
             AND numericPart.NumericSegment COLLATE Latin1_General_100_BIN2 NOT LIKE N''%[^0-9]%''
             AND LEN(numericPart.NumericSegment)<=15
             AND numericPart.HasUnmodelledWhitespaceOrCharacter=0
           THEN LEFT(numericPart.CompactFlightNumber,numericPart.PrefixLength)
             +CONVERT(nvarchar(40),CONVERT(decimal(38,0),numericPart.NumericSegment))
             +CASE WHEN numericPart.SuffixLength=1 THEN RIGHT(numericPart.CompactFlightNumber,1) ELSE N'''' END
           WHEN numericPart.HasUnmodelledWhitespaceOrCharacter=0 THEN numericPart.CompactFlightNumber
           ELSE NULL END AS NormalizedFlightNumber
    FROM NumericFlightIdentity numericPart
  )';

IF @FlightCoreReady=1
BEGIN
  SET @ExecutableSql=@CanonicalCte+N'
    SELECT FlightId,OperatingDate,OriginalFlightNumber,CompactFlightNumber,NumericSegment,
      N''APPLICATION_ASSISTED_NORMALIZATION_REQUIRED'' AS Finding
    FROM CanonicalFlightIdentity
    WHERE SqlParityGuaranteed=0
      AND (HasUnmodelledWhitespaceOrCharacter=1 OR LEN(COALESCE(NumericSegment,N''''))>15)
    ORDER BY OperatingDate,FlightId;';
  EXEC sys.sp_executesql @ExecutableSql;
  SET @ExecutableSql=@CanonicalCte+N'
    SELECT N''MEL'' AS ConceptualStationCode,OperatingDate,NormalizedFlightNumber,
      COUNT_BIG(*) AS FlightCount,COUNT(DISTINCT UPPER(LTRIM(RTRIM(CONVERT(nvarchar(30),Direction))))) AS DirectionCount,
      COUNT(DISTINCT UPPER(LTRIM(RTRIM(CONVERT(nvarchar(50),FlightStatus))))) AS StatusCount,
      COUNT(DISTINCT COALESCE(SourceIndicator,N''<NULL>'')) AS SourceCount
    FROM CanonicalFlightIdentity
    WHERE NormalizedFlightNumber IS NOT NULL
    GROUP BY OperatingDate,NormalizedFlightNumber
    HAVING COUNT_BIG(*)>1
    ORDER BY OperatingDate,NormalizedFlightNumber;';
  EXEC sys.sp_executesql @ExecutableSql;
  SET @ExecutableSql=@CanonicalCte+N'
    SELECT N''MEL'' AS ConceptualStationCode,OperatingDate,NormalizedFlightNumber,
      FlightId,OriginalFlightNumber,Direction,FlightStatus,SourceIndicator
    FROM CanonicalFlightIdentity
    WHERE NormalizedFlightNumber IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM CanonicalFlightIdentity otherFlight
        WHERE otherFlight.OperatingDate=CanonicalFlightIdentity.OperatingDate
          AND otherFlight.NormalizedFlightNumber=CanonicalFlightIdentity.NormalizedFlightNumber
          AND otherFlight.FlightId<>CanonicalFlightIdentity.FlightId
      )
    ORDER BY OperatingDate,NormalizedFlightNumber,FlightId;';
  EXEC sys.sp_executesql @ExecutableSql;
END;
ELSE
  SELECT N'CANONICAL_PREFLIGHT_UNAVAILABLE' AS Finding,N'Flights core identity columns are missing.' AS Detail;

-- 13. Child ownership and orphan details. Only live tables with a FlightId column are queried.
DECLARE @ChildDetailSql nvarchar(max)=N'
  SELECT CAST(NULL AS nvarchar(128)) AS ChildTable,CAST(NULL AS nvarchar(200)) AS ChildReference,
    CAST(NULL AS nvarchar(100)) AS ChildFlightId,CAST(NULL AS nvarchar(100)) AS Finding
  WHERE 1=0';

IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.ULDs',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ULDs',N'FlightId') IS NOT NULL
  SET @ChildDetailSql+=N' UNION ALL SELECT N''ULDs'',CONVERT(nvarchar(200),'+CASE WHEN COL_LENGTH(N'dbo.ULDs',N'UldId') IS NOT NULL THEN N'child.UldId' ELSE N'child.FlightId' END+N'),CONVERT(nvarchar(100),child.FlightId),CASE WHEN child.FlightId IS NULL THEN N''NULL_FLIGHT_OWNERSHIP'' ELSE N''ORPHAN_CHILD'' END FROM dbo.ULDs child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.Offloads',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.Offloads',N'FlightId') IS NOT NULL
  SET @ChildDetailSql+=N' UNION ALL SELECT N''Offloads'',CONVERT(nvarchar(200),'+CASE WHEN COL_LENGTH(N'dbo.Offloads',N'OffloadId') IS NOT NULL THEN N'child.OffloadId' ELSE N'child.FlightId' END+N'),CONVERT(nvarchar(100),child.FlightId),CASE WHEN child.FlightId IS NULL THEN N''NULL_FLIGHT_OWNERSHIP'' ELSE N''ORPHAN_CHILD'' END FROM dbo.Offloads child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.ImportCompletionRecords',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ImportCompletionRecords',N'FlightId') IS NOT NULL
  SET @ChildDetailSql+=N' UNION ALL SELECT N''ImportCompletionRecords'',CONVERT(nvarchar(200),'+CASE WHEN COL_LENGTH(N'dbo.ImportCompletionRecords',N'CompletionId') IS NOT NULL THEN N'child.CompletionId' ELSE N'child.FlightId' END+N'),CONVERT(nvarchar(100),child.FlightId),CASE WHEN child.FlightId IS NULL THEN N''NULL_FLIGHT_OWNERSHIP'' ELSE N''ORPHAN_CHILD'' END FROM dbo.ImportCompletionRecords child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.ExportCompletionRecords',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ExportCompletionRecords',N'FlightId') IS NOT NULL
  SET @ChildDetailSql+=N' UNION ALL SELECT N''ExportCompletionRecords'',CONVERT(nvarchar(200),'+CASE WHEN COL_LENGTH(N'dbo.ExportCompletionRecords',N'CompletionId') IS NOT NULL THEN N'child.CompletionId' ELSE N'child.FlightId' END+N'),CONVERT(nvarchar(100),child.FlightId),CASE WHEN child.FlightId IS NULL THEN N''NULL_FLIGHT_OWNERSHIP'' ELSE N''ORPHAN_CHILD'' END FROM dbo.ExportCompletionRecords child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.ExportCompletionAmendments',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ExportCompletionAmendments',N'FlightId') IS NOT NULL
  SET @ChildDetailSql+=N' UNION ALL SELECT N''ExportCompletionAmendments'',CONVERT(nvarchar(200),'+CASE WHEN COL_LENGTH(N'dbo.ExportCompletionAmendments',N'AmendmentId') IS NOT NULL THEN N'child.AmendmentId' ELSE N'child.FlightId' END+N'),CONVERT(nvarchar(100),child.FlightId),CASE WHEN child.FlightId IS NULL THEN N''NULL_FLIGHT_OWNERSHIP'' ELSE N''ORPHAN_CHILD'' END FROM dbo.ExportCompletionAmendments child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.ExportManifestFinals',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ExportManifestFinals',N'FlightId') IS NOT NULL
  SET @ChildDetailSql+=N' UNION ALL SELECT N''ExportManifestFinals'',CONVERT(nvarchar(200),'+CASE WHEN COL_LENGTH(N'dbo.ExportManifestFinals',N'FinalManifestId') IS NOT NULL THEN N'child.FinalManifestId' ELSE N'child.FlightId' END+N'),CONVERT(nvarchar(100),child.FlightId),CASE WHEN child.FlightId IS NULL THEN N''NULL_FLIGHT_OWNERSHIP'' ELSE N''ORPHAN_CHILD'' END FROM dbo.ExportManifestFinals child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.ExportManifestFinalUlds',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ExportManifestFinalUlds',N'FlightId') IS NOT NULL
  SET @ChildDetailSql+=N' UNION ALL SELECT N''ExportManifestFinalUlds'',CONVERT(nvarchar(200),'+CASE WHEN COL_LENGTH(N'dbo.ExportManifestFinalUlds',N'UldId') IS NOT NULL THEN N'child.UldId' ELSE N'child.FlightId' END+N'),CONVERT(nvarchar(100),child.FlightId),CASE WHEN child.FlightId IS NULL THEN N''NULL_FLIGHT_OWNERSHIP'' ELSE N''ORPHAN_CHILD'' END FROM dbo.ExportManifestFinalUlds child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.MachFowShipments',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.MachFowShipments',N'FlightId') IS NOT NULL
  SET @ChildDetailSql+=N' UNION ALL SELECT N''MachFowShipments'',CONVERT(nvarchar(200),'+CASE WHEN COL_LENGTH(N'dbo.MachFowShipments',N'MachFowShipmentId') IS NOT NULL THEN N'child.MachFowShipmentId' WHEN COL_LENGTH(N'dbo.MachFowShipments',N'MachMessageId') IS NOT NULL THEN N'child.MachMessageId' ELSE N'child.FlightId' END+N'),CONVERT(nvarchar(100),child.FlightId),CASE WHEN child.FlightId IS NULL THEN N''NULL_FLIGHT_OWNERSHIP'' ELSE N''ORPHAN_CHILD'' END FROM dbo.MachFowShipments child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.AuditEvents',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.AuditEvents',N'FlightId') IS NOT NULL
  SET @ChildDetailSql+=N' UNION ALL SELECT N''AuditEvents'',CONVERT(nvarchar(200),'+CASE WHEN COL_LENGTH(N'dbo.AuditEvents',N'AuditEventId') IS NOT NULL THEN N'child.AuditEventId' WHEN COL_LENGTH(N'dbo.AuditEvents',N'EventId') IS NOT NULL THEN N'child.EventId' ELSE N'child.FlightId' END+N'),CONVERT(nvarchar(100),child.FlightId),CASE WHEN child.FlightId IS NULL THEN N''AUDIT_WITHOUT_FLIGHT'' ELSE N''ORPHAN_CHILD'' END FROM dbo.AuditEvents child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL';

SET @ExecutableSql=N'WITH ChildFindings AS ('+@ChildDetailSql+N')
  SELECT ChildTable,Finding,COUNT_BIG(*) AS RecordCount
  FROM ChildFindings GROUP BY ChildTable,Finding ORDER BY ChildTable,Finding;
  WITH ChildFindings AS ('+@ChildDetailSql+N')
  SELECT ChildTable,ChildReference,ChildFlightId,Finding
  FROM ChildFindings ORDER BY ChildTable,Finding,ChildReference;';
EXEC sys.sp_executesql @ExecutableSql;

-- 14. Report required child ownership columns that are absent instead of silently skipping them.
;WITH RequiredOwnership(TableName,ColumnName) AS (
  SELECT * FROM (VALUES
    (N'ULDs',N'FlightId'),(N'Offloads',N'FlightId'),
    (N'ImportCompletionRecords',N'FlightId'),(N'ExportCompletionRecords',N'FlightId'),
    (N'ExportManifestFinals',N'FlightId'),(N'ExportManifestFinalUlds',N'FlightId'),
    (N'MachFowShipments',N'FlightId')
  ) v(TableName,ColumnName)
), OptionalOwnership(TableName,ColumnName) AS (
  SELECT * FROM (VALUES
    (N'ExportCompletionAmendments',N'FlightId'),(N'AuditEvents',N'FlightId')
  ) v(TableName,ColumnName)
)
SELECT N'MISSING_REQUIRED_CHILD_OWNERSHIP' AS Finding,required.TableName,required.ColumnName,N'STOP' AS Severity
FROM RequiredOwnership required
WHERE OBJECT_ID(N'dbo.'+required.TableName,N'U') IS NULL
   OR COL_LENGTH(N'dbo.'+required.TableName,required.ColumnName) IS NULL
UNION ALL
SELECT N'OPTIONAL_CHILD_OWNERSHIP_UNAVAILABLE',optional.TableName,optional.ColumnName,N'REVIEW'
FROM OptionalOwnership optional
WHERE OBJECT_ID(N'dbo.'+optional.TableName,N'U') IS NULL
   OR COL_LENGTH(N'dbo.'+optional.TableName,optional.ColumnName) IS NULL
ORDER BY Severity,TableName;

-- 15. Historical/legacy review. A repository date cannot prove a live ingestion-policy cutoff,
-- so CreatedAtUtc/source are reported as evidence and no undocumented cutoff is invented.
SELECT N'INGESTION_RULE_CUTOFF_NOT_STORED' AS Finding,N'REVIEW' AS Severity,
  N'No trusted live-schema field identifies when current route-ingestion rules began; use the source and creation-time inventories for operator review.' AS Detail;

IF @FlightCoreReady=1
BEGIN
  SET @ExecutableSql=@FlightClassificationCte+N'
    SELECT FlightId,FlightNumber,OperatingDate,Direction,FlightStatus,OriginAirport,DestinationAirport,
      OwnershipClassification,ClassificationReason,SourceIndicator,CreatedAtUtc
    FROM ClassifiedFlights
    WHERE UPPER(REPLACE(LTRIM(RTRIM(CONVERT(nvarchar(50),FlightStatus))),N''_'',N'''')) IN (N''CLOSED'',N''FINALISED'',N''FINALIZED'')
    ORDER BY OperatingDate,FlightId;';
  EXEC sys.sp_executesql @ExecutableSql;
  SET @ExecutableSql=@FlightClassificationCte+N'
    SELECT OwnershipClassification,
      SUM(CASE WHEN UPPER(REPLACE(LTRIM(RTRIM(CONVERT(nvarchar(50),FlightStatus))),N''_'',N'''')) IN (N''CLOSED'',N''FINALISED'',N''FINALIZED'') THEN 1 ELSE 0 END) AS ClosedOrFinalisedCount,
      COUNT_BIG(*) AS RecordCount,MIN(CreatedAtUtc) AS EarliestCreatedAtUtc,MAX(CreatedAtUtc) AS LatestCreatedAtUtc
    FROM ClassifiedFlights
    GROUP BY OwnershipClassification
    ORDER BY OwnershipClassification;';
  EXEC sys.sp_executesql @ExecutableSql;

  DECLARE @HistoricalEvidenceSql nvarchar(max)=N'
    SELECT CAST(NULL AS nvarchar(100)) AS EvidenceType,CAST(NULL AS bigint) AS EvidenceId,
      CAST(NULL AS bigint) AS FlightId,CAST(NULL AS nvarchar(30)) AS OwnershipClassification,
      CAST(NULL AS nvarchar(300)) AS ClassificationReason
    WHERE 1=0';
  IF OBJECT_ID(N'dbo.ImportCompletionRecords',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ImportCompletionRecords',N'FlightId') IS NOT NULL
    SET @HistoricalEvidenceSql+=N' UNION ALL SELECT N''IMPORT_COMPLETION'',TRY_CONVERT(bigint,'+CASE WHEN COL_LENGTH(N'dbo.ImportCompletionRecords',N'CompletionId') IS NOT NULL THEN N'evidence.CompletionId' ELSE N'evidence.FlightId' END+N'),TRY_CONVERT(bigint,evidence.FlightId),flight.OwnershipClassification,flight.ClassificationReason FROM dbo.ImportCompletionRecords evidence JOIN ClassifiedFlights flight ON flight.FlightId=evidence.FlightId WHERE flight.OwnershipClassification<>N''SAFE_MEL_CANDIDATE''';
  IF OBJECT_ID(N'dbo.ExportCompletionRecords',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ExportCompletionRecords',N'FlightId') IS NOT NULL
    SET @HistoricalEvidenceSql+=N' UNION ALL SELECT N''EXPORT_COMPLETION'',TRY_CONVERT(bigint,'+CASE WHEN COL_LENGTH(N'dbo.ExportCompletionRecords',N'CompletionId') IS NOT NULL THEN N'evidence.CompletionId' ELSE N'evidence.FlightId' END+N'),TRY_CONVERT(bigint,evidence.FlightId),flight.OwnershipClassification,flight.ClassificationReason FROM dbo.ExportCompletionRecords evidence JOIN ClassifiedFlights flight ON flight.FlightId=evidence.FlightId WHERE flight.OwnershipClassification<>N''SAFE_MEL_CANDIDATE''';
  IF OBJECT_ID(N'dbo.ExportManifestFinals',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ExportManifestFinals',N'FlightId') IS NOT NULL
    SET @HistoricalEvidenceSql+=N' UNION ALL SELECT N''EXPORT_FINAL'',TRY_CONVERT(bigint,'+CASE WHEN COL_LENGTH(N'dbo.ExportManifestFinals',N'FinalManifestId') IS NOT NULL THEN N'evidence.FinalManifestId' ELSE N'evidence.FlightId' END+N'),TRY_CONVERT(bigint,evidence.FlightId),flight.OwnershipClassification,flight.ClassificationReason FROM dbo.ExportManifestFinals evidence JOIN ClassifiedFlights flight ON flight.FlightId=evidence.FlightId WHERE flight.OwnershipClassification<>N''SAFE_MEL_CANDIDATE''';
  IF OBJECT_ID(N'dbo.MachFowShipments',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.MachFowShipments',N'FlightId') IS NOT NULL
    SET @HistoricalEvidenceSql+=N' UNION ALL SELECT N''FOW_SHIPMENT'',TRY_CONVERT(bigint,'+CASE WHEN COL_LENGTH(N'dbo.MachFowShipments',N'MachMessageId') IS NOT NULL THEN N'evidence.MachMessageId' ELSE N'evidence.FlightId' END+N'),TRY_CONVERT(bigint,evidence.FlightId),flight.OwnershipClassification,flight.ClassificationReason FROM dbo.MachFowShipments evidence JOIN ClassifiedFlights flight ON flight.FlightId=evidence.FlightId WHERE flight.OwnershipClassification<>N''SAFE_MEL_CANDIDATE''';

  SET @ExecutableSql=@FlightClassificationCte+N', HistoricalEvidence AS ('+@HistoricalEvidenceSql+N')
    SELECT EvidenceType,EvidenceId,FlightId,OwnershipClassification,ClassificationReason
    FROM HistoricalEvidence ORDER BY EvidenceType,FlightId,EvidenceId;';
  EXEC sys.sp_executesql @ExecutableSql;

  DECLARE @LegacyStationExpression nvarchar(300)=CASE WHEN COL_LENGTH(N'dbo.Flights',N'StationId') IS NOT NULL
    THEN N'CONVERT(nvarchar(100),f.StationId)' ELSE N'CAST(NULL AS nvarchar(100))' END;
  SET @ExecutableSql=N'
    SELECT f.FlightId,f.FlightNumber,f.OperatingDate,f.Direction,'+@LegacyStationExpression+N' AS ExistingStationId,
      N''LEGACY_ROW_WOULD_BE_INACCESSIBLE_UNTIL_BACKFILLED'' AS Finding
    FROM dbo.Flights f
    WHERE '+CASE WHEN COL_LENGTH(N'dbo.Flights',N'StationId') IS NOT NULL THEN N'f.StationId IS NULL' ELSE N'1=1' END+N'
    ORDER BY f.OperatingDate,f.FlightId;';
  EXEC sys.sp_executesql @ExecutableSql;
END;
ELSE
  SELECT N'HISTORICAL_REVIEW_UNAVAILABLE' AS Finding,N'Flights core columns are missing.' AS Detail;

-- 16. Final findings and decision. Every STOP finding must be resolved before Phase 2B.
DECLARE @FindingBody nvarchar(max)=N'
  SELECT N''MISSING_REQUIRED_SCHEMA'' AS Finding,COUNT_BIG(*) AS [Count],N''STOP'' AS Severity,
    N''One or more required Phase 2A inventory tables are absent.'' AS Detail
  FROM (VALUES
    (N''CargoRunStations''),(N''Flights''),(N''ULDs''),(N''Offloads''),(N''AuditEvents''),
    (N''ImportCompletionRecords''),(N''ExportCompletionRecords''),(N''ExportCompletionAmendments''),
    (N''ExportManifestFinals''),(N''ExportManifestFinalUlds''),
    (N''IncomingMachMessages''),(N''MachFowShipments'')
  ) required(TableName)
  WHERE OBJECT_ID(N''dbo.''+required.TableName,N''U'') IS NULL
  HAVING COUNT_BIG(*)>0
  UNION ALL
  SELECT N''MISSING_REQUIRED_SCHEMA'',COUNT_BIG(*),N''STOP'',N''Flights is missing one or more required identity, route, or lifecycle columns.''
  FROM (VALUES(N''FlightId''),(N''FlightNumber''),(N''OperatingDate''),(N''Direction''),(N''FlightStatus''),(N''OriginAirport''),(N''DestinationAirport'')) required(ColumnName)
  WHERE COL_LENGTH(N''dbo.Flights'',required.ColumnName) IS NULL
  HAVING COUNT_BIG(*)>0
  UNION ALL
  SELECT N''MISSING_REQUIRED_SCHEMA'',COUNT_BIG(*),N''STOP'',N''A required child table lacks FlightId ownership.''
  FROM (VALUES(N''ULDs''),(N''Offloads''),(N''ImportCompletionRecords''),(N''ExportCompletionRecords''),
              (N''ExportManifestFinals''),(N''ExportManifestFinalUlds''),(N''MachFowShipments'')) required(TableName)
  WHERE COL_LENGTH(N''dbo.''+required.TableName,N''FlightId'') IS NULL
  HAVING COUNT_BIG(*)>0
  UNION ALL
  SELECT N''STATION_MASTER_INVALID'',COUNT_BIG(*),N''STOP'',N''CargoRunStations schema does not match the Phase 1 contract.''
  FROM (VALUES
    (N''StationId'',N''bigint'',CONVERT(bit,0),CONVERT(bit,1),CAST(NULL AS smallint)),
    (N''StationCode'',N''varchar'',CONVERT(bit,0),CONVERT(bit,0),CONVERT(smallint,3)),
    (N''DisplayName'',N''nvarchar'',CONVERT(bit,0),CONVERT(bit,0),CONVERT(smallint,200)),
    (N''TimeZoneId'',N''nvarchar'',CONVERT(bit,0),CONVERT(bit,0),CONVERT(smallint,200)),
    (N''IsEnabled'',N''bit'',CONVERT(bit,0),CONVERT(bit,0),CONVERT(smallint,1)),
    (N''CreatedAtUtc'',N''datetime2'',CONVERT(bit,0),CONVERT(bit,0),CAST(NULL AS smallint)),
    (N''CreatedByReference'',N''nvarchar'',CONVERT(bit,0),CONVERT(bit,0),CONVERT(smallint,300))
  ) required(ColumnName,DataType,IsNullable,IsIdentity,MaxLength)
  LEFT JOIN sys.columns columnObject ON columnObject.object_id=OBJECT_ID(N''dbo.CargoRunStations'',N''U'') AND columnObject.name=required.ColumnName
  WHERE columnObject.column_id IS NULL OR TYPE_NAME(columnObject.user_type_id)<>required.DataType
     OR columnObject.is_nullable<>required.IsNullable OR columnObject.is_identity<>required.IsIdentity
     OR (required.MaxLength IS NOT NULL AND columnObject.max_length<>required.MaxLength)
  HAVING COUNT_BIG(*)>0
  UNION ALL
  SELECT N''FLIGHTS_STATION_ID_STATE'',1,
    CASE WHEN COL_LENGTH(N''dbo.Flights'',N''StationId'') IS NULL THEN N''INFO'' ELSE N''STOP'' END,
    CASE WHEN COL_LENGTH(N''dbo.Flights'',N''StationId'') IS NULL THEN N''Flights.StationId is not installed.'' ELSE N''Flights.StationId already exists and requires compatibility review.'' END
  UNION ALL
  SELECT N''MACH_STATION_ID_STATE'',1,
    CASE WHEN COL_LENGTH(N''dbo.IncomingMachMessages'',N''StationId'') IS NULL THEN N''INFO'' ELSE N''STOP'' END,
    CASE WHEN COL_LENGTH(N''dbo.IncomingMachMessages'',N''StationId'') IS NULL THEN N''IncomingMachMessages.StationId is not installed.'' ELSE N''IncomingMachMessages.StationId already exists and requires compatibility review.'' END';

IF @StationCoreReady=1
  SET @FindingBody+=N'
    UNION ALL SELECT N''STATION_MASTER_INVALID'',1,N''STOP'',N''Exactly one enabled MEL row is required.''
      WHERE (SELECT COUNT_BIG(*) FROM dbo.CargoRunStations WHERE UPPER(LTRIM(RTRIM(StationCode)))=N''MEL'' AND IsEnabled=1)<>1
    UNION ALL SELECT N''STATION_MASTER_INVALID'',COUNT_BIG(*),N''STOP'',N''Enabled MEL timezone is missing or invalid-looking.''
      FROM dbo.CargoRunStations
      WHERE UPPER(LTRIM(RTRIM(StationCode)))=N''MEL'' AND IsEnabled=1
        AND (NULLIF(LTRIM(RTRIM(TimeZoneId)),N'''') IS NULL OR LTRIM(RTRIM(TimeZoneId)) NOT LIKE N''%/%''
          OR LTRIM(RTRIM(TimeZoneId)) LIKE N''/%'' OR LTRIM(RTRIM(TimeZoneId)) LIKE N''%/'' OR LTRIM(RTRIM(TimeZoneId)) LIKE N''%//%'')
      HAVING COUNT_BIG(*)>0';

SET @FindingBody+=N'
  UNION ALL SELECT N''STATION_MASTER_INVALID'',1,N''STOP'',N''StationCode uniqueness is not enforced by an enabled unfiltered unique index.''
  WHERE NOT EXISTS (
    SELECT 1 FROM sys.indexes indexObject
    WHERE indexObject.object_id=OBJECT_ID(N''dbo.CargoRunStations'',N''U'')
      AND indexObject.is_unique=1 AND indexObject.is_disabled=0 AND indexObject.has_filter=0
      AND 1=(SELECT COUNT(*) FROM sys.index_columns keyColumn WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id AND keyColumn.key_ordinal>0)
      AND EXISTS (SELECT 1 FROM sys.index_columns keyColumn JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id AND columnObject.column_id=keyColumn.column_id
                  WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id AND keyColumn.key_ordinal=1 AND columnObject.name=N''StationCode'')
  )';

IF @FlightCoreReady=1
BEGIN
  SET @FindingBody+=N'
    UNION ALL SELECT N''SAFE_MEL_CANDIDATE'',COUNT_BIG(*),N''INFO'',N''Route and matched MACH evidence support MEL ownership.'' FROM ClassifiedFlights WHERE OwnershipClassification=N''SAFE_MEL_CANDIDATE'' HAVING COUNT_BIG(*)>0
    UNION ALL SELECT N''AMBIGUOUS_FLIGHT'',COUNT_BIG(*),N''STOP'',N''MEL-consistent route lacks independent database corroboration.'' FROM ClassifiedFlights WHERE OwnershipClassification=N''AMBIGUOUS'' HAVING COUNT_BIG(*)>0
    UNION ALL SELECT N''CONTRADICTORY_ROUTE'',COUNT_BIG(*),N''STOP'',N''Route, required fields, or matched MACH evidence contradicts a safe MEL backfill.'' FROM ClassifiedFlights WHERE OwnershipClassification=N''CONTRADICTORY'' HAVING COUNT_BIG(*)>0';
  SET @FindingBody+=N'
    UNION ALL SELECT N''LEGACY_OPERATIONAL_ROW'',COUNT_BIG(*),N''INFO'',N''Rows without explicit StationId would become inaccessible under strict enforcement until safely backfilled.''
      FROM dbo.Flights f WHERE '+CASE WHEN COL_LENGTH(N'dbo.Flights',N'StationId') IS NOT NULL THEN N'f.StationId IS NULL' ELSE N'1=1' END+N' HAVING COUNT_BIG(*)>0';
END;

IF @FlightCoreReady=1
  SET @FindingBody+=N'
    UNION ALL SELECT N''CANONICAL_IDENTITY_COLLISION'',COUNT_BIG(*),N''STOP'',N''Multiple FlightIds share OperatingDate plus the application-equivalent normalized FlightNumber.''
    FROM (
      SELECT OperatingDate,NormalizedFlightNumber FROM CanonicalFlightIdentity
      WHERE NormalizedFlightNumber IS NOT NULL
      GROUP BY OperatingDate,NormalizedFlightNumber HAVING COUNT_BIG(*)>1
    ) collision HAVING COUNT_BIG(*)>0
    UNION ALL SELECT N''APPLICATION_ASSISTED_NORMALIZATION_REQUIRED'',COUNT_BIG(*),N''STOP'',N''SQL cannot guarantee parity with JavaScript whitespace/Number semantics for these flight numbers.''
    FROM CanonicalFlightIdentity
    WHERE SqlParityGuaranteed=0 AND (HasUnmodelledWhitespaceOrCharacter=1 OR LEN(COALESCE(NumericSegment,N''''))>15)
    HAVING COUNT_BIG(*)>0';

IF @DocumentCorIdSchemaReady=1
  SET @FindingBody+=N'
    UNION ALL SELECT N''INVALID_DOCUMENTCORID'',COUNT_BIG(*),N''STOP'',N''DocumentCorID must contain 1-100 ASCII letters, digits, or hyphens after trimming outer U+0020 spaces.''
      FROM ClassifiedDocumentIdentity WHERE IsInvalid=1 HAVING COUNT_BIG(*)>0
    UNION ALL SELECT N''DOCUMENTCORID_CANONICALIZATION_REQUIRED'',COUNT_BIG(*),N''STOP'',N''Stored DocumentCorID is not the exact ASCII-uppercase canonical value; existing evidence was not rewritten.''
      FROM ClassifiedDocumentIdentity WHERE RequiresCanonicalization=1 HAVING COUNT_BIG(*)>0
    UNION ALL SELECT N''DOCUMENTCORID_CANONICAL_COLLISION'',COUNT_BIG(*),N''STOP'',N''Multiple messages collapse to the same deterministic DocumentCorID identity.''
      FROM (
        SELECT CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2 AS CanonicalDocumentCorID
        FROM ClassifiedDocumentIdentity
        WHERE IsInvalid=0
        GROUP BY CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2
        HAVING COUNT_BIG(*)>1
      ) collision HAVING COUNT_BIG(*)>0';
ELSE
  SET @FindingBody+=N' UNION ALL SELECT N''INVALID_DOCUMENTCORID_SCHEMA'',1,N''STOP'',N''IncomingMachMessages.DocumentCorID must be a native noncomputed varchar/nvarchar column with capacity for 100 ASCII characters.''';

IF @DocumentCorIdSchemaReady=1 AND EXISTS (
  SELECT 1 FROM sys.indexes indexObject
  JOIN sys.index_columns keyColumn ON keyColumn.object_id=indexObject.object_id
    AND keyColumn.index_id=indexObject.index_id AND keyColumn.key_ordinal>0
  JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id
    AND columnObject.column_id=keyColumn.column_id
  WHERE indexObject.object_id=@MachObjectId AND indexObject.is_unique=1
    AND indexObject.is_disabled=0 AND indexObject.is_hypothetical=0
    AND columnObject.name=N'DocumentCorID'
    AND columnObject.collation_name<>N'Latin1_General_100_BIN2'
)
  SET @FindingBody+=N' UNION ALL SELECT N''DOCUMENTCORID_COLLATION_CONFLICT'',1,N''STOP'',N''An existing unique DocumentCorID key uses linguistic rather than BIN2 equality.''';

IF @MachCoreReady=1
BEGIN
  SET @FindingBody+=N'
    UNION ALL SELECT N''UNMATCHED_MACH_MESSAGE'',COUNT_BIG(*),N''STOP'',N''Incoming MACH evidence has no matched FlightId.''
      FROM dbo.IncomingMachMessages WHERE MatchedFlightId IS NULL HAVING COUNT_BIG(*)>0';
  IF COL_LENGTH(N'dbo.IncomingMachMessages',N'StationAirport') IS NOT NULL
    SET @FindingBody+=N'
      UNION ALL SELECT N''MACH_STATION_CONFLICT'',COUNT_BIG(*),N''STOP'',N''MACH station is missing, malformed, or not MEL.''
      FROM dbo.IncomingMachMessages
      WHERE NULLIF(LTRIM(RTRIM(StationAirport)),N'''') IS NULL OR LEN(LTRIM(RTRIM(StationAirport)))<>3
         OR UPPER(LTRIM(RTRIM(StationAirport))) COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%''
         OR UPPER(LTRIM(RTRIM(StationAirport)))<>N''MEL''
      HAVING COUNT_BIG(*)>0';
  ELSE
    SET @FindingBody+=N' UNION ALL SELECT N''MISSING_REQUIRED_SCHEMA'',1,N''STOP'',N''IncomingMachMessages.StationAirport is unavailable for ownership corroboration.''';
END;
ELSE
  SET @FindingBody+=N' UNION ALL SELECT N''MISSING_REQUIRED_SCHEMA'',1,N''STOP'',N''IncomingMachMessages lacks a required identity/correlation column.''';

IF @MachCoreReady=1 AND COL_LENGTH(N'dbo.IncomingMachMessages',N'StationAirport') IS NOT NULL
  SET @FindingBody+=N'
    UNION ALL SELECT N''DOCUMENT_CORRELATION_CONFLICT'',COUNT_BIG(*),N''STOP'',N''A DocumentCorID is associated with multiple flight or station decisions.''
    FROM (
      SELECT UPPER(LTRIM(RTRIM(CONVERT(nvarchar(max),DocumentCorID))) COLLATE Latin1_General_100_BIN2 AS CanonicalDocumentCorID
      FROM dbo.IncomingMachMessages
      GROUP BY UPPER(LTRIM(RTRIM(CONVERT(nvarchar(max),DocumentCorID))) COLLATE Latin1_General_100_BIN2
      HAVING COUNT(DISTINCT COALESCE(CONVERT(nvarchar(100),MatchedFlightId),N''<NULL>''))>1
          OR COUNT(DISTINCT UPPER(LTRIM(RTRIM(COALESCE(StationAirport,N''<NULL>'')))) COLLATE Latin1_General_100_BIN2)>1
    ) conflict
    HAVING COUNT_BIG(*)>0';

IF @FowObjectId IS NOT NULL AND @MachCoreReady=1
   AND COL_LENGTH(N'dbo.MachFowShipments',N'MachMessageId') IS NOT NULL
   AND COL_LENGTH(N'dbo.MachFowShipments',N'FlightId') IS NOT NULL
  SET @FindingBody+=N'
    UNION ALL SELECT N''FOW_MESSAGE_OWNERSHIP_CONFLICT'',COUNT_BIG(*),N''STOP'',N''A FOW shipment is missing its message or disagrees with the message matched FlightId.''
    FROM dbo.MachFowShipments shipment
    LEFT JOIN dbo.IncomingMachMessages message ON message.MachMessageId=shipment.MachMessageId
    WHERE message.MachMessageId IS NULL OR message.MatchedFlightId IS NULL
       OR TRY_CONVERT(bigint,shipment.FlightId)<>TRY_CONVERT(bigint,message.MatchedFlightId)
    HAVING COUNT_BIG(*)>0';

DECLARE @RequiredChildFindingSql nvarchar(max)=N'';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.ULDs',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ULDs',N'FlightId') IS NOT NULL SET @RequiredChildFindingSql+=N' UNION ALL SELECT N''ORPHAN_CHILD'',COUNT_BIG(*),N''STOP'',N''ULDs contains null or invalid FlightId ownership.'' FROM dbo.ULDs child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL HAVING COUNT_BIG(*)>0';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.Offloads',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.Offloads',N'FlightId') IS NOT NULL SET @RequiredChildFindingSql+=N' UNION ALL SELECT N''ORPHAN_CHILD'',COUNT_BIG(*),N''STOP'',N''Offloads contains null or invalid FlightId ownership.'' FROM dbo.Offloads child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL HAVING COUNT_BIG(*)>0';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.ImportCompletionRecords',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ImportCompletionRecords',N'FlightId') IS NOT NULL SET @RequiredChildFindingSql+=N' UNION ALL SELECT N''ORPHAN_CHILD'',COUNT_BIG(*),N''STOP'',N''Import completion evidence contains null or invalid FlightId ownership.'' FROM dbo.ImportCompletionRecords child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL HAVING COUNT_BIG(*)>0';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.ExportCompletionRecords',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ExportCompletionRecords',N'FlightId') IS NOT NULL SET @RequiredChildFindingSql+=N' UNION ALL SELECT N''ORPHAN_CHILD'',COUNT_BIG(*),N''STOP'',N''Export completion evidence contains null or invalid FlightId ownership.'' FROM dbo.ExportCompletionRecords child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL HAVING COUNT_BIG(*)>0';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.ExportCompletionAmendments',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ExportCompletionAmendments',N'FlightId') IS NOT NULL SET @RequiredChildFindingSql+=N' UNION ALL SELECT N''ORPHAN_CHILD'',COUNT_BIG(*),N''STOP'',N''Export amendments contains null or invalid FlightId ownership.'' FROM dbo.ExportCompletionAmendments child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL HAVING COUNT_BIG(*)>0';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.ExportManifestFinals',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ExportManifestFinals',N'FlightId') IS NOT NULL SET @RequiredChildFindingSql+=N' UNION ALL SELECT N''ORPHAN_CHILD'',COUNT_BIG(*),N''STOP'',N''Export FINAL evidence contains null or invalid FlightId ownership.'' FROM dbo.ExportManifestFinals child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL HAVING COUNT_BIG(*)>0';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.ExportManifestFinalUlds',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.ExportManifestFinalUlds',N'FlightId') IS NOT NULL SET @RequiredChildFindingSql+=N' UNION ALL SELECT N''ORPHAN_CHILD'',COUNT_BIG(*),N''STOP'',N''Export FINAL membership contains null or invalid FlightId ownership.'' FROM dbo.ExportManifestFinalUlds child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL HAVING COUNT_BIG(*)>0';
IF @FlightIdReady=1 AND OBJECT_ID(N'dbo.MachFowShipments',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.MachFowShipments',N'FlightId') IS NOT NULL SET @RequiredChildFindingSql+=N' UNION ALL SELECT N''ORPHAN_CHILD'',COUNT_BIG(*),N''STOP'',N''FOW shipments contains null or invalid FlightId ownership.'' FROM dbo.MachFowShipments child LEFT JOIN dbo.Flights parent ON parent.FlightId=child.FlightId WHERE child.FlightId IS NULL OR parent.FlightId IS NULL HAVING COUNT_BIG(*)>0';
SET @FindingBody+=@RequiredChildFindingSql;

DECLARE @FinalWith nvarchar(max)=N'';
IF @FlightCoreReady=1 SET @FinalWith=@FlightClassificationCte+N','+STUFF(@CanonicalCte,1,5,N'');
IF @DocumentCorIdSchemaReady=1
  SET @FinalWith=CASE WHEN @FinalWith=N'' THEN @DocumentIdentityCte
    ELSE @FinalWith+N','+STUFF(@DocumentIdentityCte,1,5,N'') END;

DECLARE @FinalSql nvarchar(max)=@FinalWith+CASE WHEN @FinalWith=N'' THEN N'WITH ' ELSE N', ' END+N'Findings AS ('+@FindingBody+N'),
  FinalOutput AS (
    SELECT Finding,[Count],Severity,Detail FROM Findings
    UNION ALL
    SELECT N''FINAL_DECISION'',SUM(CASE WHEN Severity=N''STOP'' THEN [Count] ELSE 0 END),
      CASE WHEN EXISTS (SELECT 1 FROM Findings WHERE Severity=N''STOP'') THEN N''STOP'' ELSE N''PROCEED'' END,
      N''PROCEED only when this row says PROCEED and all detail result sets have been reviewed.''
    FROM Findings
  )
  SELECT Finding,[Count],Severity,Detail
  FROM FinalOutput
  ORDER BY CASE Severity WHEN N''STOP'' THEN 1 WHEN N''REVIEW'' THEN 2 WHEN N''PROCEED'' THEN 4 ELSE 3 END,Finding,Detail;';

EXEC sys.sp_executesql @FinalSql;
