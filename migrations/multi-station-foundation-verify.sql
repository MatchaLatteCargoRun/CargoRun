-- READ ONLY. Run after multi-station-foundation.sql.
-- Legacy COMPLETE orphan Offloads are reported for review and are not assigned ownership.
SET NOCOUNT ON;

DECLARE @Findings table(
  Severity varchar(10) NOT NULL,
  Finding nvarchar(100) NOT NULL,
  Detail nvarchar(2000) NOT NULL
);
DECLARE @ExecutableSql nvarchar(max);

DECLARE @RequiredTables table(TableName sysname NOT NULL PRIMARY KEY);
INSERT @RequiredTables(TableName) VALUES
  (N'CargoRunStations'),(N'Flights'),(N'IncomingMachMessages'),(N'Offloads'),
  (N'ULDs'),(N'ImportCompletionRecords'),(N'ExportCompletionRecords'),
  (N'ExportCompletionAmendments'),(N'ExportManifestFinals'),
  (N'ExportManifestFinalUlds'),(N'MachFowShipments');
INSERT @Findings(Severity,Finding,Detail)
SELECT 'STOP',N'MISSING_REQUIRED_TABLE',N'dbo.'+required.TableName
FROM @RequiredTables required
WHERE OBJECT_ID(N'dbo.'+required.TableName,N'U') IS NULL;

DECLARE @RequiredColumns table(TableName sysname NOT NULL,ColumnName sysname NOT NULL,
  PRIMARY KEY(TableName,ColumnName));
INSERT @RequiredColumns(TableName,ColumnName) VALUES
  (N'CargoRunStations',N'StationId'),(N'CargoRunStations',N'StationCode'),
  (N'CargoRunStations',N'DisplayName'),(N'CargoRunStations',N'TimeZoneId'),
  (N'CargoRunStations',N'IsEnabled'),
  (N'Flights',N'FlightId'),(N'Flights',N'StationId'),(N'Flights',N'OperatingDate'),
  (N'Flights',N'FlightNumber'),
  (N'IncomingMachMessages',N'MachMessageId'),(N'IncomingMachMessages',N'StationId'),
  (N'IncomingMachMessages',N'OperatingDate'),(N'IncomingMachMessages',N'DocumentCorID'),
  (N'IncomingMachMessages',N'MatchedFlightId'),
  (N'Offloads',N'OffloadId'),(N'Offloads',N'FlightId'),
  (N'ULDs',N'FlightId'),(N'ImportCompletionRecords',N'FlightId'),
  (N'ExportCompletionRecords',N'FlightId'),(N'ExportCompletionAmendments',N'FlightId'),
  (N'ExportManifestFinals',N'FlightId'),(N'ExportManifestFinalUlds',N'FlightId'),
  (N'MachFowShipments',N'FlightId'),(N'MachFowShipments',N'MachMessageId');
INSERT @Findings(Severity,Finding,Detail)
SELECT 'STOP',N'MISSING_REQUIRED_COLUMN',N'dbo.'+required.TableName+N'.'+required.ColumnName
FROM @RequiredColumns required
WHERE OBJECT_ID(N'dbo.'+required.TableName,N'U') IS NULL
   OR COL_LENGTH(N'dbo.'+required.TableName,required.ColumnName) IS NULL;

DECLARE @StationMasterReady bit=CASE WHEN OBJECT_ID(N'dbo.CargoRunStations',N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.CargoRunStations',N'StationId') IS NOT NULL
  AND COL_LENGTH(N'dbo.CargoRunStations',N'StationCode') IS NOT NULL
  AND COL_LENGTH(N'dbo.CargoRunStations',N'DisplayName') IS NOT NULL
  AND COL_LENGTH(N'dbo.CargoRunStations',N'TimeZoneId') IS NOT NULL
  AND COL_LENGTH(N'dbo.CargoRunStations',N'IsEnabled') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @FlightsReady bit=CASE WHEN OBJECT_ID(N'dbo.Flights',N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'FlightId') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'StationId') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'OperatingDate') IS NOT NULL
  AND COL_LENGTH(N'dbo.Flights',N'FlightNumber') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @MessagesReady bit=CASE WHEN OBJECT_ID(N'dbo.IncomingMachMessages',N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MachMessageId') IS NOT NULL
  AND COL_LENGTH(N'dbo.IncomingMachMessages',N'StationId') IS NOT NULL
  AND COL_LENGTH(N'dbo.IncomingMachMessages',N'OperatingDate') IS NOT NULL
  AND COL_LENGTH(N'dbo.IncomingMachMessages',N'DocumentCorID') IS NOT NULL
  AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MatchedFlightId') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @FowReady bit=CASE WHEN OBJECT_ID(N'dbo.MachFowShipments',N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.MachFowShipments',N'FlightId') IS NOT NULL
  AND COL_LENGTH(N'dbo.MachFowShipments',N'MachMessageId') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @HasOffloadStatus bit=CASE WHEN COL_LENGTH(N'dbo.Offloads',N'OffloadStatus') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @HasStatus bit=CASE WHEN COL_LENGTH(N'dbo.Offloads',N'Status') IS NOT NULL THEN 1 ELSE 0 END;
-- Match api/offloads: Status is authoritative whenever it exists.
DECLARE @OffloadStatusColumn sysname=CASE
  WHEN @HasStatus=1 THEN N'Status'
  WHEN @HasOffloadStatus=1 THEN N'OffloadStatus'
  ELSE NULL END;
DECLARE @OffloadStatusSchemaReady bit=CASE WHEN @OffloadStatusColumn IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM sys.columns columnObject
    WHERE columnObject.object_id=OBJECT_ID(N'dbo.Offloads',N'U')
      AND columnObject.name IN (N'Status',N'OffloadStatus')
      AND (columnObject.system_type_id NOT IN (167,175,231,239)
        OR columnObject.is_computed=1 OR columnObject.collation_name IS NULL)
  ) THEN 1 ELSE 0 END;
DECLARE @OffloadsReady bit=CASE WHEN OBJECT_ID(N'dbo.Offloads',N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.Offloads',N'OffloadId') IS NOT NULL
  AND COL_LENGTH(N'dbo.Offloads',N'FlightId') IS NOT NULL
  AND @OffloadStatusSchemaReady=1 THEN 1 ELSE 0 END;

IF OBJECT_ID(N'dbo.Offloads',N'U') IS NOT NULL AND @OffloadStatusColumn IS NULL
  INSERT @Findings VALUES('STOP',N'MISSING_REQUIRED_OWNERSHIP_SCHEMA',N'dbo.Offloads requires OffloadStatus or Status.');
IF OBJECT_ID(N'dbo.Offloads',N'U') IS NOT NULL AND @OffloadStatusColumn IS NOT NULL AND @OffloadStatusSchemaReady=0
  INSERT @Findings VALUES('STOP',N'INVALID_OFFLOAD_STATUS_SCHEMA',N'Offloads status columns must be noncomputed character columns.');

-- Transitional schemas with both names are safe only while their normalized
-- values agree. Choosing either value on a disagreement could hide active work.
IF @OffloadsReady=1 AND @HasStatus=1 AND @HasOffloadStatus=1
BEGIN
  SET @ExecutableSql=N'
    SELECT N''STOP'',N''OFFLOAD_STATUS_DISAGREEMENT'',
      CONCAT(N''OffloadId '',CONVERT(nvarchar(100),offload.OffloadId),N'' has conflicting Status and OffloadStatus values.'')
    FROM dbo.Offloads offload
    CROSS APPLY (VALUES(
      UPPER(LTRIM(RTRIM(CONVERT(nvarchar(max),offload.[Status]) COLLATE Latin1_General_100_BIN2))),
      UPPER(LTRIM(RTRIM(CONVERT(nvarchar(max),offload.[OffloadStatus]) COLLATE Latin1_General_100_BIN2)))
    )) normalized(StatusValue,OffloadStatusValue)
    WHERE (normalized.StatusValue IS NULL AND normalized.OffloadStatusValue IS NOT NULL)
       OR (normalized.StatusValue IS NOT NULL AND normalized.OffloadStatusValue IS NULL)
       OR normalized.StatusValue<>normalized.OffloadStatusValue;';
  INSERT @Findings(Severity,Finding,Detail) EXEC sys.sp_executesql @ExecutableSql;
END;

IF @StationMasterReady=1
BEGIN
  SET @ExecutableSql=N'
    SELECT N''STOP'',N''INVALID_STATION_MASTER'',N''Exactly one MEL station row is required.''
    WHERE (SELECT COUNT_BIG(*) FROM dbo.CargoRunStations WHERE UPPER(LTRIM(RTRIM(StationCode)))=N''MEL'')<>1
    UNION ALL
    SELECT N''STOP'',N''INVALID_STATION_MASTER'',N''MEL must have a positive StationId and be enabled with display metadata and Australia/Melbourne timezone.''
    WHERE NOT EXISTS (SELECT 1 FROM dbo.CargoRunStations WHERE UPPER(LTRIM(RTRIM(StationCode)))=N''MEL''
      AND StationId>0 AND IsEnabled=1 AND NULLIF(LTRIM(RTRIM(DisplayName)),N'''') IS NOT NULL
      AND LTRIM(RTRIM(TimeZoneId))=N''Australia/Melbourne'')
    UNION ALL
    SELECT N''STOP'',N''INVALID_STATION_MASTER'',CONCAT(N''StationId '',StationId,N'' has invalid code, display name, or timezone.'')
    FROM dbo.CargoRunStations
    WHERE StationId<=0 OR NULLIF(LTRIM(RTRIM(StationCode)),N'''') IS NULL OR LEN(LTRIM(RTRIM(StationCode)))<>3
      OR UPPER(LTRIM(RTRIM(StationCode))) COLLATE Latin1_General_100_BIN2 LIKE N''%[^A-Z]%''
      OR NULLIF(LTRIM(RTRIM(DisplayName)),N'''') IS NULL OR NULLIF(LTRIM(RTRIM(TimeZoneId)),N'''') IS NULL;';
  INSERT @Findings(Severity,Finding,Detail) EXEC sys.sp_executesql @ExecutableSql;
END;

IF @FlightsReady=1 AND EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'dbo.Flights',N'U')
    AND name=N'StationId' AND (TYPE_NAME(user_type_id)<>N'bigint' OR is_nullable<>1 OR is_computed<>0))
  INSERT @Findings VALUES('STOP',N'INVALID_FLIGHT_STATION_ID',N'dbo.Flights.StationId must be bigint NULL and noncomputed.');
IF @MessagesReady=1 AND EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
    AND name=N'StationId' AND (TYPE_NAME(user_type_id)<>N'bigint' OR is_nullable<>1 OR is_computed<>0))
  INSERT @Findings VALUES('STOP',N'INVALID_MESSAGE_STATION_ID',N'dbo.IncomingMachMessages.StationId must be bigint NULL and noncomputed.');

IF @FlightsReady=1 AND NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys fk
  WHERE fk.parent_object_id=OBJECT_ID(N'dbo.Flights',N'U')
    AND fk.referenced_object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
    AND fk.is_disabled=0 AND fk.is_not_trusted=0
    AND fk.delete_referential_action=0 AND fk.update_referential_action=0
    AND (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns allLinks
         WHERE allLinks.constraint_object_id=fk.object_id)=1
    AND EXISTS (
      SELECT 1 FROM sys.foreign_key_columns exactLink
      WHERE exactLink.constraint_object_id=fk.object_id
        AND COL_NAME(exactLink.parent_object_id,exactLink.parent_column_id)=N'StationId'
        AND COL_NAME(exactLink.referenced_object_id,exactLink.referenced_column_id)=N'StationId'
    ))
  INSERT @Findings VALUES('STOP',N'INVALID_FLIGHT_STATION_FK',N'Flights requires an exact enabled trusted noncascading single-column StationId -> CargoRunStations.StationId foreign key.');
IF @MessagesReady=1 AND NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys fk
  WHERE fk.parent_object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
    AND fk.referenced_object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
    AND fk.is_disabled=0 AND fk.is_not_trusted=0
    AND fk.delete_referential_action=0 AND fk.update_referential_action=0
    AND (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns allLinks
         WHERE allLinks.constraint_object_id=fk.object_id)=1
    AND EXISTS (
      SELECT 1 FROM sys.foreign_key_columns exactLink
      WHERE exactLink.constraint_object_id=fk.object_id
        AND COL_NAME(exactLink.parent_object_id,exactLink.parent_column_id)=N'StationId'
        AND COL_NAME(exactLink.referenced_object_id,exactLink.referenced_column_id)=N'StationId'
    ))
  INSERT @Findings VALUES('STOP',N'INVALID_MESSAGE_STATION_FK',N'IncomingMachMessages requires an exact enabled trusted noncascading single-column StationId -> CargoRunStations.StationId foreign key.');
IF EXISTS (
  SELECT 1 FROM sys.foreign_keys fk
  WHERE fk.parent_object_id IN (OBJECT_ID(N'dbo.Flights',N'U'),OBJECT_ID(N'dbo.IncomingMachMessages',N'U'))
    AND EXISTS (
      SELECT 1 FROM sys.foreign_key_columns stationLink
      WHERE stationLink.constraint_object_id=fk.object_id
        AND stationLink.parent_object_id=fk.parent_object_id
        AND COL_NAME(stationLink.parent_object_id,stationLink.parent_column_id)=N'StationId'
    )
    AND (fk.referenced_object_id<>OBJECT_ID(N'dbo.CargoRunStations',N'U')
      OR fk.is_disabled=1 OR fk.is_not_trusted=1
      OR fk.delete_referential_action<>0 OR fk.update_referential_action<>0
      OR (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns allLinks
          WHERE allLinks.constraint_object_id=fk.object_id)<>1
      OR NOT EXISTS (
        SELECT 1 FROM sys.foreign_key_columns exactLink
        WHERE exactLink.constraint_object_id=fk.object_id
          AND exactLink.parent_object_id=fk.parent_object_id
          AND exactLink.referenced_object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
          AND COL_NAME(exactLink.parent_object_id,exactLink.parent_column_id)=N'StationId'
          AND COL_NAME(exactLink.referenced_object_id,exactLink.referenced_column_id)=N'StationId'
      )))
  INSERT @Findings VALUES('STOP',N'CONFLICTING_STATION_FK',N'A StationId foreign key is composite, conflicting, disabled, untrusted, or cascading.');

IF @FlightsReady=1 AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  WHERE i.object_id=OBJECT_ID(N'dbo.Flights',N'U') AND i.is_disabled=0 AND i.is_hypothetical=0 AND i.has_filter=0
    AND EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal=1 AND c.name=N'StationId')
    AND EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal=2 AND c.name=N'OperatingDate')
    AND EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal=3 AND c.name=N'FlightNumber'))
  INSERT @Findings VALUES('STOP',N'MISSING_FLIGHT_STATION_INDEX',N'Flights requires a real nonfiltered StationId, OperatingDate, FlightNumber lookup index.');
IF @MessagesReady=1 AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  WHERE i.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U') AND i.is_disabled=0 AND i.is_hypothetical=0 AND i.has_filter=0
    AND EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal=1 AND c.name=N'StationId')
    AND EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal=2 AND c.name=N'OperatingDate')
    AND EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal=3 AND c.name=N'MachMessageId'))
  INSERT @Findings VALUES('STOP',N'MISSING_MESSAGE_STATION_INDEX',N'IncomingMachMessages requires a real nonfiltered StationId, OperatingDate, MachMessageId lookup index.');

IF @FlightsReady=1 AND @StationMasterReady=1
BEGIN
  SET @ExecutableSql=N'
    SELECT N''STOP'',N''NULL_FLIGHT_STATION_ID'',CONCAT(N''FlightId '',FlightId) FROM dbo.Flights WHERE StationId IS NULL
    UNION ALL
    SELECT N''STOP'',N''INVALID_FLIGHT_STATION_REFERENCE'',CONCAT(N''FlightId '',flight.FlightId)
    FROM dbo.Flights flight LEFT JOIN dbo.CargoRunStations station ON station.StationId=flight.StationId
    WHERE flight.StationId IS NOT NULL AND (station.StationId IS NULL OR station.IsEnabled=0);';
  INSERT @Findings(Severity,Finding,Detail) EXEC sys.sp_executesql @ExecutableSql;
END;

IF @MessagesReady=1 AND @StationMasterReady=1
BEGIN
  SET @ExecutableSql=N'
    SELECT N''STOP'',N''NULL_MESSAGE_STATION_ID'',CONCAT(N''MachMessageId '',MachMessageId) FROM dbo.IncomingMachMessages WHERE StationId IS NULL
    UNION ALL
    SELECT N''STOP'',N''INVALID_MESSAGE_STATION_REFERENCE'',CONCAT(N''MachMessageId '',message.MachMessageId)
    FROM dbo.IncomingMachMessages message LEFT JOIN dbo.CargoRunStations station ON station.StationId=message.StationId
    WHERE message.StationId IS NOT NULL AND (station.StationId IS NULL OR station.IsEnabled=0);';
  INSERT @Findings(Severity,Finding,Detail) EXEC sys.sp_executesql @ExecutableSql;
END;

-- DocumentCorID shares one identity contract with runtime: outer U+0020 trim at
-- input, 1-100 ASCII letters/digits/hyphens, and ASCII uppercase storage. Every
-- comparison and uniqueness key is explicit BIN2 rather than database-default.
DECLARE @DocumentCorIdSchemaReady bit=CASE WHEN EXISTS (
  SELECT 1 FROM sys.columns columnObject
  WHERE columnObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
    AND columnObject.name=N'DocumentCorID'
    AND columnObject.user_type_id=columnObject.system_type_id
    AND columnObject.system_type_id IN (167,231)
    AND columnObject.is_computed=0 AND columnObject.collation_name IS NOT NULL
    AND ((columnObject.system_type_id=167 AND (columnObject.max_length=-1 OR columnObject.max_length>=100))
      OR (columnObject.system_type_id=231 AND (columnObject.max_length=-1 OR columnObject.max_length>=200)))
) THEN 1 ELSE 0 END;

IF OBJECT_ID(N'dbo.IncomingMachMessages',N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.IncomingMachMessages',N'DocumentCorID') IS NOT NULL
  AND @DocumentCorIdSchemaReady=0
  INSERT @Findings VALUES('STOP',N'INVALID_DOCUMENTCORID_SCHEMA',N'IncomingMachMessages.DocumentCorID must be a native noncomputed varchar/nvarchar column with capacity for 100 ASCII characters.');

IF @DocumentCorIdSchemaReady=1
BEGIN
  -- TRANSLATE removes only the explicit ASCII allowed set. Any residual byte,
  -- including U+0000, makes the value invalid without relying on LIKE.
  SET @ExecutableSql=N'WITH RawDocumentIdentity AS (
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
    )
    SELECT N''STOP'',N''INVALID_DOCUMENTCORID'',CONCAT(N''MachMessageId '',MachMessageId)
    FROM ClassifiedDocumentIdentity WHERE IsInvalid=1
    UNION ALL
    SELECT N''STOP'',N''DOCUMENTCORID_CANONICALIZATION_REQUIRED'',CONCAT(N''MachMessageId '',MachMessageId)
    FROM ClassifiedDocumentIdentity WHERE RequiresCanonicalization=1
    UNION ALL
    SELECT N''STOP'',N''DOCUMENTCORID_CANONICAL_COLLISION'',
      CONCAT(N''Canonical DocumentCorID '',CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2)
    FROM ClassifiedDocumentIdentity
    WHERE IsInvalid=0
    GROUP BY CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2
    HAVING COUNT_BIG(*)>1;';
  INSERT @Findings(Severity,Finding,Detail) EXEC sys.sp_executesql @ExecutableSql;
END;

DECLARE @DocumentCorIdComputedDefinition nvarchar(max)=(
  SELECT LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
    columnObject.definition,N'[',N''),N']',N''),N'(',N''),N')',N''),N' ',N''),NCHAR(13),N''),NCHAR(10),N''),NCHAR(9),N''))
  FROM sys.computed_columns columnObject
  WHERE columnObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
    AND columnObject.name=N'DocumentCorIDCanonical'
);
DECLARE @DocumentCorIdCanonicalColumnReady bit=CASE WHEN EXISTS (
  SELECT 1 FROM sys.computed_columns columnObject
  WHERE columnObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
    AND columnObject.name=N'DocumentCorIDCanonical'
    AND columnObject.user_type_id=columnObject.system_type_id
    AND columnObject.system_type_id=231 AND columnObject.max_length=200
    AND columnObject.is_persisted=1 AND columnObject.collation_name=N'Latin1_General_100_BIN2'
  ) AND @DocumentCorIdComputedDefinition=N'convertnvarchar100,documentcoridcollatelatin1_general_100_bin2'
  THEN 1 ELSE 0 END;
IF @MessagesReady=1 AND @DocumentCorIdCanonicalColumnReady=0
  INSERT @Findings VALUES('STOP',N'INVALID_DOCUMENTCORID_CANONICAL_COLUMN',N'IncomingMachMessages requires the persisted nvarchar(100) BIN2 DocumentCorIDCanonical projection.');

DECLARE @DocumentCorIdCheckDefinition nvarchar(max)=(
  SELECT LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
    checkObject.definition,N'[',N''),N']',N''),N'(',N''),N')',N''),N' ',N''),NCHAR(13),N''),NCHAR(10),N''),NCHAR(9),N''))
  FROM sys.check_constraints checkObject
  WHERE checkObject.parent_object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
    AND checkObject.name=N'CK_IncomingMachMessages_DocumentCorID_Canonical'
);
DECLARE @DocumentCorIdCheckDefinitionHash varchar(64)=(
  SELECT CONVERT(varchar(64),HASHBYTES('SHA2_256',CONVERT(varbinary(max),checkObject.definition)),2)
  FROM sys.check_constraints checkObject
  WHERE checkObject.parent_object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
    AND checkObject.name=N'CK_IncomingMachMessages_DocumentCorID_Canonical'
);
DECLARE @DocumentCorIdStoredCheckDefinitionHash varchar(64)=(
  SELECT CONVERT(varchar(64),property.value)
  FROM sys.fn_listextendedproperty(N'CargoRun.DocumentCorIDCanonicalGuardHash',
    N'SCHEMA',N'dbo',N'TABLE',N'IncomingMachMessages',N'CONSTRAINT',
    N'CK_IncomingMachMessages_DocumentCorID_Canonical') property
);
DECLARE @DocumentCorIdCheckReady bit=CASE WHEN EXISTS (
  SELECT 1 FROM sys.check_constraints checkObject
  WHERE checkObject.parent_object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
    AND checkObject.name=N'CK_IncomingMachMessages_DocumentCorID_Canonical'
    AND checkObject.is_disabled=0 AND checkObject.is_not_trusted=0
  )
  AND @DocumentCorIdCheckDefinitionHash IS NOT NULL
  AND @DocumentCorIdCheckDefinitionHash=@DocumentCorIdStoredCheckDefinitionHash
  AND @DocumentCorIdCheckDefinition LIKE N'%documentcoridisnotnull%'
  AND @DocumentCorIdCheckDefinition LIKE N'%datalengthconvertnvarcharmax,documentcorid>=2%'
  AND @DocumentCorIdCheckDefinition LIKE N'%datalengthconvertnvarcharmax,documentcorid<=200%'
  AND @DocumentCorIdCheckDefinition LIKE
    N'%datalengthconvertnvarcharmax,documentcorid=datalengthltrimrtrimconvertnvarcharmax,documentcorid%'
  AND @DocumentCorIdCheckDefinition LIKE
    N'%datalengthreplacetranslateconvertnvarcharmax,documentcoridcollatelatin1_general_100_bin2,n''abcdefghijklmnopqrstuvwxyz0123456789-'',replicaten''a'',37,n''a'',n''''=0%'
  THEN 1 ELSE 0 END;
IF @MessagesReady=1 AND @DocumentCorIdCheckReady=0
  INSERT @Findings VALUES('STOP',N'MISSING_DOCUMENTCORID_CANONICAL_GUARD',N'IncomingMachMessages requires an enabled trusted check constraint enforcing exact uppercase ASCII DocumentCorID storage.');

DECLARE @DocumentCorIdUniqueIndexReady bit=CASE WHEN @DocumentCorIdCanonicalColumnReady=1 AND EXISTS (
    SELECT 1 FROM sys.indexes i
    JOIN sys.index_columns firstKey ON firstKey.object_id=i.object_id AND firstKey.index_id=i.index_id AND firstKey.key_ordinal=1
    JOIN sys.columns firstColumn ON firstColumn.object_id=firstKey.object_id AND firstColumn.column_id=firstKey.column_id
    WHERE i.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U') AND i.is_unique=1
      AND i.is_disabled=0 AND i.is_hypothetical=0 AND i.has_filter=0
      AND i.ignore_dup_key=0
      AND firstColumn.name=N'DocumentCorIDCanonical'
      AND firstColumn.collation_name=N'Latin1_General_100_BIN2'
      AND NOT EXISTS (SELECT 1 FROM sys.index_columns additionalKey
        WHERE additionalKey.object_id=i.object_id AND additionalKey.index_id=i.index_id AND additionalKey.key_ordinal>1)
  ) THEN 1 ELSE 0 END;
IF @MessagesReady=1 AND @DocumentCorIdUniqueIndexReady=0
  INSERT @Findings VALUES('STOP',N'MISSING_DOCUMENTCORID_UNIQUENESS',N'An enabled unfiltered single-column unique BIN2 DocumentCorIDCanonical index is required in addition to the global runtime lock.');

IF @DocumentCorIdSchemaReady=1 AND EXISTS (
  SELECT 1 FROM sys.indexes indexObject
  JOIN sys.index_columns keyColumn ON keyColumn.object_id=indexObject.object_id
    AND keyColumn.index_id=indexObject.index_id AND keyColumn.key_ordinal>0
  JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id
    AND columnObject.column_id=keyColumn.column_id
  WHERE indexObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
    AND indexObject.is_unique=1 AND indexObject.is_disabled=0 AND indexObject.is_hypothetical=0
    AND columnObject.name=N'DocumentCorID'
    AND columnObject.collation_name<>N'Latin1_General_100_BIN2'
)
  INSERT @Findings VALUES('STOP',N'DOCUMENTCORID_COLLATION_CONFLICT',N'An existing unique DocumentCorID key uses linguistic rather than BIN2 equality.');

-- This safe-subset normalizer mirrors api/shared/flight.js only where SQL can
-- prove parity. Unsupported schema, values, Unicode, or Number semantics STOP.
DECLARE @FlightIdentitySchemaReady bit=CASE WHEN @FlightsReady=1
  AND EXISTS (
    SELECT 1 FROM sys.columns columnObject
    WHERE columnObject.object_id=OBJECT_ID(N'dbo.Flights',N'U')
      AND columnObject.name=N'FlightNumber'
      AND columnObject.user_type_id=columnObject.system_type_id
      AND columnObject.system_type_id IN (167,231)
      AND columnObject.is_computed=0 AND columnObject.collation_name IS NOT NULL
      AND ((columnObject.system_type_id=167 AND columnObject.max_length BETWEEN 1 AND 4000)
        OR (columnObject.system_type_id=231 AND columnObject.max_length BETWEEN 2 AND 8000
          AND columnObject.max_length%2=0))
  )
  AND EXISTS (
    SELECT 1 FROM sys.columns columnObject
    WHERE columnObject.object_id=OBJECT_ID(N'dbo.Flights',N'U')
      AND columnObject.name=N'OperatingDate'
      AND columnObject.user_type_id=columnObject.system_type_id
      AND columnObject.system_type_id=40 AND columnObject.is_computed=0
  ) THEN 1 ELSE 0 END;

IF @FlightsReady=1 AND @FlightIdentitySchemaReady=0
  INSERT @Findings VALUES('STOP',N'INVALID_FLIGHT_IDENTITY_SCHEMA',N'FlightNumber must be a bounded varchar/nvarchar column and OperatingDate must be a date column before SQL canonical verification is safe.');

IF @FlightIdentitySchemaReady=1
BEGIN
  SET @ExecutableSql=N'
    WITH RawFlightIdentity AS (
      SELECT FlightId,StationId,OperatingDate,
        CONVERT(nvarchar(4000),FlightNumber) COLLATE Latin1_General_100_BIN2 AS OriginalFlightNumber,
        UPPER((REPLACE(REPLACE(REPLACE(REPLACE(CONVERT(nvarchar(4000),FlightNumber),
          N'' '',N''''),NCHAR(9),N''''),NCHAR(10),N''''),NCHAR(13),N''''))
          COLLATE Latin1_General_100_BIN2) COLLATE Latin1_General_100_BIN2 AS CompactFlightNumber,
        DATALENGTH(CONVERT(nvarchar(max),FlightNumber)) AS ConvertedFlightNumberBytes
      FROM dbo.Flights
    ), ParsedFlightIdentity AS (
      SELECT raw.*,
        CASE WHEN SUBSTRING(raw.CompactFlightNumber,3,1) COLLATE Latin1_General_100_BIN2 LIKE N''[0-9]'' THEN 2
             WHEN SUBSTRING(raw.CompactFlightNumber,4,1) COLLATE Latin1_General_100_BIN2 LIKE N''[0-9]'' THEN 3 ELSE NULL END AS PrefixLength,
        CASE WHEN RIGHT(raw.CompactFlightNumber,1) COLLATE Latin1_General_100_BIN2 LIKE N''[A-Z]'' THEN 1 ELSE 0 END AS SuffixLength,
        CASE WHEN raw.OperatingDate IS NULL OR raw.OriginalFlightNumber IS NULL
          OR NULLIF(raw.CompactFlightNumber,N'''') IS NULL OR raw.ConvertedFlightNumberBytes>8000
          OR raw.OriginalFlightNumber COLLATE Latin1_General_100_BIN2
            LIKE N''%[^A-Za-z0-9 ''+NCHAR(9)+NCHAR(10)+NCHAR(13)+N'']%'' COLLATE Latin1_General_100_BIN2
             THEN 1 ELSE 0 END AS HasUnsupportedIdentityValue
      FROM RawFlightIdentity raw
    ), NumericFlightIdentity AS (
      SELECT parsed.*,CASE WHEN parsed.PrefixLength IS NULL THEN NULL
        ELSE SUBSTRING(parsed.CompactFlightNumber,parsed.PrefixLength+1,
          LEN(parsed.CompactFlightNumber)-parsed.PrefixLength-parsed.SuffixLength) END AS NumericSegment
      FROM ParsedFlightIdentity parsed
    ), ParityAssessedFlightIdentity AS (
      SELECT numericPart.*,CASE WHEN numericPart.HasUnsupportedIdentityValue=0
          AND numericPart.PrefixLength IN (2,3)
          AND LEFT(numericPart.CompactFlightNumber,numericPart.PrefixLength)
            COLLATE Latin1_General_100_BIN2 NOT LIKE N''%[^A-Z0-9]%'' COLLATE Latin1_General_100_BIN2
          AND NULLIF(numericPart.NumericSegment,N'''') IS NOT NULL
          AND numericPart.NumericSegment COLLATE Latin1_General_100_BIN2 NOT LIKE N''%[^0-9]%''
          AND LEN(numericPart.NumericSegment)<=15
        THEN CONVERT(bit,1) ELSE CONVERT(bit,0) END AS SqlParityGuaranteed
      FROM NumericFlightIdentity numericPart
    ), CanonicalFlightIdentity AS (
      SELECT assessed.*,
        CASE WHEN assessed.SqlParityGuaranteed=1
          THEN LEFT(assessed.CompactFlightNumber,assessed.PrefixLength)
            +CONVERT(nvarchar(40),CONVERT(decimal(38,0),assessed.NumericSegment))
            +CASE WHEN assessed.SuffixLength=1 THEN RIGHT(assessed.CompactFlightNumber,1) ELSE N'''' END
          ELSE NULL END AS CanonicalFlightNumber
      FROM ParityAssessedFlightIdentity assessed
    )
    SELECT N''STOP'',N''APPLICATION_ASSISTED_NORMALIZATION_REQUIRED'',
      CONCAT(N''FlightId '',FlightId,N'', FlightNumber '',COALESCE(OriginalFlightNumber,N''<NULL>''),
        CASE WHEN OperatingDate IS NULL THEN N'', OperatingDate <NULL>'' ELSE N'''' END)
    FROM CanonicalFlightIdentity WHERE SqlParityGuaranteed=0
    UNION ALL
    SELECT N''STOP'',N''CANONICAL_IDENTITY_COLLISION'',CONCAT(N''StationId '',StationId,N'', '',OperatingDate,N'', '',CanonicalFlightNumber)
    FROM CanonicalFlightIdentity
    WHERE SqlParityGuaranteed=1 AND CanonicalFlightNumber IS NOT NULL
    GROUP BY StationId,OperatingDate,CanonicalFlightNumber HAVING COUNT_BIG(*)>1;';
  INSERT @Findings(Severity,Finding,Detail) EXEC sys.sp_executesql @ExecutableSql;
END;

-- The FOW ownership chain is evaluated only after its native bigint identities,
-- links, and exact single-column unique keys have been proven from metadata.
DECLARE @OwnershipChainColumnsPresent bit=CASE
  WHEN OBJECT_ID(N'dbo.Flights',N'U') IS NOT NULL
    AND COL_LENGTH(N'dbo.Flights',N'FlightId') IS NOT NULL
    AND COL_LENGTH(N'dbo.Flights',N'StationId') IS NOT NULL
    AND OBJECT_ID(N'dbo.IncomingMachMessages',N'U') IS NOT NULL
    AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MachMessageId') IS NOT NULL
    AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MatchedFlightId') IS NOT NULL
    AND COL_LENGTH(N'dbo.IncomingMachMessages',N'StationId') IS NOT NULL
    AND OBJECT_ID(N'dbo.MachFowShipments',N'U') IS NOT NULL
    AND COL_LENGTH(N'dbo.MachFowShipments',N'MachMessageId') IS NOT NULL
    AND COL_LENGTH(N'dbo.MachFowShipments',N'FlightId') IS NOT NULL
  THEN 1 ELSE 0 END;

IF @OwnershipChainColumnsPresent=0
  INSERT @Findings VALUES('STOP',N'MISSING_REQUIRED_OWNERSHIP_SCHEMA',N'FOW verification requires Flights.FlightId/StationId, IncomingMachMessages.MachMessageId/MatchedFlightId/StationId, and MachFowShipments.MachMessageId/FlightId.');

DECLARE @FlightIdColumnReady bit=CASE WHEN EXISTS (
  SELECT 1 FROM sys.columns columnObject
  WHERE columnObject.object_id=OBJECT_ID(N'dbo.Flights',N'U')
    AND columnObject.name=N'FlightId'
    AND columnObject.system_type_id=127 AND columnObject.user_type_id=127
    AND columnObject.max_length=8 AND columnObject.precision=19 AND columnObject.scale=0
    AND columnObject.is_nullable=0 AND columnObject.is_computed=0
) THEN 1 ELSE 0 END;
DECLARE @MessageIdColumnReady bit=CASE WHEN EXISTS (
  SELECT 1 FROM sys.columns columnObject
  WHERE columnObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
    AND columnObject.name=N'MachMessageId'
    AND columnObject.system_type_id=127 AND columnObject.user_type_id=127
    AND columnObject.max_length=8 AND columnObject.precision=19 AND columnObject.scale=0
    AND columnObject.is_nullable=0 AND columnObject.is_computed=0
) THEN 1 ELSE 0 END;
DECLARE @MatchedFlightIdColumnReady bit=CASE WHEN EXISTS (
  SELECT 1 FROM sys.columns columnObject
  WHERE columnObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
    AND columnObject.name=N'MatchedFlightId'
    AND columnObject.system_type_id=127 AND columnObject.user_type_id=127
    AND columnObject.max_length=8 AND columnObject.precision=19 AND columnObject.scale=0
    AND columnObject.is_computed=0
) THEN 1 ELSE 0 END;
DECLARE @FowMessageIdColumnReady bit=CASE WHEN EXISTS (
  SELECT 1 FROM sys.columns columnObject
  WHERE columnObject.object_id=OBJECT_ID(N'dbo.MachFowShipments',N'U')
    AND columnObject.name=N'MachMessageId'
    AND columnObject.system_type_id=127 AND columnObject.user_type_id=127
    AND columnObject.max_length=8 AND columnObject.precision=19 AND columnObject.scale=0
    AND columnObject.is_computed=0
) THEN 1 ELSE 0 END;
DECLARE @FowFlightIdColumnReady bit=CASE WHEN EXISTS (
  SELECT 1 FROM sys.columns columnObject
  WHERE columnObject.object_id=OBJECT_ID(N'dbo.MachFowShipments',N'U')
    AND columnObject.name=N'FlightId'
    AND columnObject.system_type_id=127 AND columnObject.user_type_id=127
    AND columnObject.max_length=8 AND columnObject.precision=19 AND columnObject.scale=0
    AND columnObject.is_computed=0
) THEN 1 ELSE 0 END;

IF OBJECT_ID(N'dbo.Flights',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.Flights',N'FlightId') IS NOT NULL AND @FlightIdColumnReady=0
  INSERT @Findings VALUES('STOP',N'INVALID_IDENTITY_COLUMN_TYPE',N'Flights.FlightId must be native bigint NOT NULL and noncomputed.');
IF OBJECT_ID(N'dbo.IncomingMachMessages',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MachMessageId') IS NOT NULL AND @MessageIdColumnReady=0
  INSERT @Findings VALUES('STOP',N'INVALID_IDENTITY_COLUMN_TYPE',N'IncomingMachMessages.MachMessageId must be native bigint NOT NULL and noncomputed.');
IF OBJECT_ID(N'dbo.IncomingMachMessages',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MatchedFlightId') IS NOT NULL AND @MatchedFlightIdColumnReady=0
  INSERT @Findings VALUES('STOP',N'INVALID_IDENTITY_COLUMN_TYPE',N'IncomingMachMessages.MatchedFlightId must be native bigint compatible with Flights.FlightId and noncomputed.');
IF OBJECT_ID(N'dbo.MachFowShipments',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.MachFowShipments',N'MachMessageId') IS NOT NULL AND @FowMessageIdColumnReady=0
  INSERT @Findings VALUES('STOP',N'INVALID_IDENTITY_COLUMN_TYPE',N'MachFowShipments.MachMessageId must be native bigint compatible with IncomingMachMessages.MachMessageId and noncomputed.');
IF OBJECT_ID(N'dbo.MachFowShipments',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.MachFowShipments',N'FlightId') IS NOT NULL AND @FowFlightIdColumnReady=0
  INSERT @Findings VALUES('STOP',N'INVALID_IDENTITY_COLUMN_TYPE',N'MachFowShipments.FlightId must be native bigint compatible with Flights.FlightId and noncomputed.');

DECLARE @FlightIdUniqueReady bit=CASE WHEN EXISTS (
  SELECT 1 FROM sys.indexes identityIndex
  WHERE identityIndex.object_id=OBJECT_ID(N'dbo.Flights',N'U')
    AND identityIndex.is_unique=1 AND identityIndex.is_disabled=0
    AND identityIndex.is_hypothetical=0 AND identityIndex.has_filter=0
    AND (SELECT COUNT_BIG(*) FROM sys.index_columns keyColumn
         WHERE keyColumn.object_id=identityIndex.object_id
           AND keyColumn.index_id=identityIndex.index_id AND keyColumn.key_ordinal>0)=1
    AND EXISTS (
      SELECT 1 FROM sys.index_columns keyColumn
      JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id
        AND columnObject.column_id=keyColumn.column_id
      WHERE keyColumn.object_id=identityIndex.object_id
        AND keyColumn.index_id=identityIndex.index_id AND keyColumn.key_ordinal=1
        AND columnObject.name=N'FlightId'
    )
) THEN 1 ELSE 0 END;
DECLARE @MessageIdUniqueReady bit=CASE WHEN EXISTS (
  SELECT 1 FROM sys.indexes identityIndex
  WHERE identityIndex.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
    AND identityIndex.is_unique=1 AND identityIndex.is_disabled=0
    AND identityIndex.is_hypothetical=0 AND identityIndex.has_filter=0
    AND (SELECT COUNT_BIG(*) FROM sys.index_columns keyColumn
         WHERE keyColumn.object_id=identityIndex.object_id
           AND keyColumn.index_id=identityIndex.index_id AND keyColumn.key_ordinal>0)=1
    AND EXISTS (
      SELECT 1 FROM sys.index_columns keyColumn
      JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id
        AND columnObject.column_id=keyColumn.column_id
      WHERE keyColumn.object_id=identityIndex.object_id
        AND keyColumn.index_id=identityIndex.index_id AND keyColumn.key_ordinal=1
        AND columnObject.name=N'MachMessageId'
    )
) THEN 1 ELSE 0 END;

IF OBJECT_ID(N'dbo.Flights',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.Flights',N'FlightId') IS NOT NULL AND @FlightIdUniqueReady=0
  INSERT @Findings VALUES('STOP',N'NON_UNIQUE_FLIGHT_IDENTITY',N'Flights.FlightId requires an enabled unfiltered unique index or key with FlightId as its only key column.');
IF OBJECT_ID(N'dbo.IncomingMachMessages',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.IncomingMachMessages',N'MachMessageId') IS NOT NULL AND @MessageIdUniqueReady=0
  INSERT @Findings VALUES('STOP',N'NON_UNIQUE_MESSAGE_IDENTITY',N'IncomingMachMessages.MachMessageId requires an enabled unfiltered unique index or key with MachMessageId as its only key column.');

-- Preserve row-level evidence for duplicate identities while the missing exact
-- unique key already keeps all ownership joins closed.
IF @FlightIdColumnReady=1 AND @FlightIdUniqueReady=0
BEGIN
  SET @ExecutableSql=N'SELECT N''STOP'',N''NON_UNIQUE_FLIGHT_IDENTITY'',CONCAT(N''Duplicate FlightId '',FlightId)
    FROM dbo.Flights GROUP BY FlightId HAVING COUNT_BIG(*)>1;';
  INSERT @Findings(Severity,Finding,Detail) EXEC sys.sp_executesql @ExecutableSql;
END;
IF @MessageIdColumnReady=1 AND @MessageIdUniqueReady=0
BEGIN
  SET @ExecutableSql=N'SELECT N''STOP'',N''NON_UNIQUE_MESSAGE_IDENTITY'',CONCAT(N''Duplicate MachMessageId '',MachMessageId)
    FROM dbo.IncomingMachMessages GROUP BY MachMessageId HAVING COUNT_BIG(*)>1;';
  INSERT @Findings(Severity,Finding,Detail) EXEC sys.sp_executesql @ExecutableSql;
END;

DECLARE @MessageFlightLinkSchemaReady bit=CASE WHEN @OwnershipChainColumnsPresent=1
  AND @FlightsReady=1 AND @MessagesReady=1
  AND @FlightIdColumnReady=1 AND @MessageIdColumnReady=1 AND @MatchedFlightIdColumnReady=1
  AND @FlightIdUniqueReady=1 AND @MessageIdUniqueReady=1 THEN 1 ELSE 0 END;
DECLARE @FowOwnershipSchemaReady bit=CASE WHEN @MessageFlightLinkSchemaReady=1 AND @FowReady=1
  AND @FowMessageIdColumnReady=1 AND @FowFlightIdColumnReady=1 THEN 1 ELSE 0 END;

IF @MessageFlightLinkSchemaReady=1
BEGIN
  SET @ExecutableSql=N'
    SELECT N''STOP'',N''ORPHAN_MACH_MATCHED_FLIGHT'',CONCAT(N''MachMessageId '',message.MachMessageId,N'' -> FlightId '',message.MatchedFlightId)
    FROM dbo.IncomingMachMessages message LEFT JOIN dbo.Flights flight ON flight.FlightId=message.MatchedFlightId
    WHERE message.MatchedFlightId IS NOT NULL AND flight.FlightId IS NULL
    UNION ALL
    SELECT N''STOP'',N''CROSS_STATION_MESSAGE_LINK'',CONCAT(N''MachMessageId '',message.MachMessageId,N'' -> FlightId '',message.MatchedFlightId)
    FROM dbo.IncomingMachMessages message JOIN dbo.Flights flight ON flight.FlightId=message.MatchedFlightId
    WHERE message.StationId<>flight.StationId;';
  INSERT @Findings(Severity,Finding,Detail) EXEC sys.sp_executesql @ExecutableSql;
END;

-- A FOW row inherits ownership only through its uniquely identified MACH
-- message and the authoritative Flight matched by that message.
IF @FowOwnershipSchemaReady=1
BEGIN
  SET @ExecutableSql=N'
    SELECT N''STOP'',N''FOW_MESSAGE_OWNERSHIP_CONFLICT'',
      CONCAT(N''MachMessageId '',COALESCE(CONVERT(nvarchar(100),shipment.MachMessageId),N''<NULL>''),
        N'', shipment FlightId '',COALESCE(CONVERT(nvarchar(100),shipment.FlightId),N''<NULL>''),N'': '',
        CASE
          WHEN shipment.MachMessageId IS NULL THEN N''shipment MachMessageId is null''
          WHEN message.MachMessageId IS NULL THEN N''referenced MACH message does not exist''
          WHEN message.MatchedFlightId IS NULL THEN N''MACH message has no matched FlightId''
          WHEN shipment.FlightId IS NULL THEN N''shipment has no FlightId''
          WHEN shipment.FlightId<>message.MatchedFlightId THEN N''shipment FlightId disagrees with message MatchedFlightId''
          WHEN flight.FlightId IS NULL THEN N''matched Flight does not exist''
          ELSE N''message StationId disagrees with matched Flight StationId'' END)
    FROM dbo.MachFowShipments shipment
    LEFT JOIN dbo.IncomingMachMessages message ON message.MachMessageId=shipment.MachMessageId
    LEFT JOIN dbo.Flights flight ON flight.FlightId=message.MatchedFlightId
    WHERE shipment.MachMessageId IS NULL OR message.MachMessageId IS NULL
       OR message.MatchedFlightId IS NULL OR shipment.FlightId IS NULL
       OR shipment.FlightId<>message.MatchedFlightId
       OR flight.FlightId IS NULL OR message.StationId IS NULL OR flight.StationId IS NULL
       OR message.StationId<>flight.StationId;';
  INSERT @Findings(Severity,Finding,Detail) EXEC sys.sp_executesql @ExecutableSql;
END;

IF @FlightsReady=1
BEGIN
  DECLARE @ChildTargets table(TableName sysname NOT NULL,IdentityColumn sysname NOT NULL);
  INSERT @ChildTargets(TableName,IdentityColumn) VALUES
    (N'ULDs',N'UldId'),(N'ImportCompletionRecords',N'ImportCompletionRecordId'),
    (N'ExportCompletionRecords',N'CompletionId'),(N'ExportCompletionAmendments',N'AmendmentId'),
    (N'ExportManifestFinals',N'FinalManifestId'),(N'ExportManifestFinalUlds',N'FinalManifestId'),
    (N'MachFowShipments',N'MachFowShipmentId');
  DECLARE @ChildTable sysname,@ChildIdentity sysname,@IdentityExpression nvarchar(500);
  DECLARE ChildCursor CURSOR LOCAL FAST_FORWARD FOR SELECT TableName,IdentityColumn FROM @ChildTargets;
  OPEN ChildCursor;
  FETCH NEXT FROM ChildCursor INTO @ChildTable,@ChildIdentity;
  WHILE @@FETCH_STATUS=0
  BEGIN
    IF OBJECT_ID(N'dbo.'+@ChildTable,N'U') IS NOT NULL AND COL_LENGTH(N'dbo.'+@ChildTable,N'FlightId') IS NOT NULL
      AND (@ChildTable<>N'MachFowShipments' OR @FowOwnershipSchemaReady=1)
    BEGIN
      SET @IdentityExpression=CASE WHEN COL_LENGTH(N'dbo.'+@ChildTable,@ChildIdentity) IS NOT NULL
        THEN N'CONVERT(nvarchar(100),child.'+QUOTENAME(@ChildIdentity)+N')' ELSE N'N''<identity unavailable>''' END;
      SET @ExecutableSql=N'SELECT N''STOP'',N''ORPHAN_OPERATIONAL_CHILD'',CONCAT(N'''+REPLACE(@ChildTable,N'''',N'''''')+N' '',
        '+@IdentityExpression+N',N'' references missing FlightId '',CONVERT(nvarchar(100),child.FlightId))
        FROM dbo.'+QUOTENAME(@ChildTable)+N' child LEFT JOIN dbo.Flights flight ON flight.FlightId=child.FlightId
        WHERE child.FlightId IS NULL OR flight.FlightId IS NULL;';
      INSERT @Findings(Severity,Finding,Detail) EXEC sys.sp_executesql @ExecutableSql;
    END;
    FETCH NEXT FROM ChildCursor INTO @ChildTable,@ChildIdentity;
  END;
  CLOSE ChildCursor;
  DEALLOCATE ChildCursor;
END;

-- Exact FlightId inheritance is required for active child records. COMPLETE is
-- the sole terminal/historical status accepted for a legacy orphan Offload.
IF @OffloadsReady=1 AND @FlightsReady=1
BEGIN
  SET @ExecutableSql=N'
    SELECT CASE WHEN normalized.StatusValue=N''COMPLETE'' COLLATE Latin1_General_100_BIN2 THEN N''INFO'' ELSE N''STOP'' END,
      CASE WHEN normalized.StatusValue=N''COMPLETE'' COLLATE Latin1_General_100_BIN2 THEN N''LEGACY_ORPHAN_OFFLOAD'' ELSE N''ACTIVE_ORPHAN_OFFLOAD'' END,
      CONCAT(N''OffloadId '',CONVERT(nvarchar(100),offload.OffloadId),N'' remains unassigned; no ownership was inferred.'')
    FROM dbo.Offloads offload LEFT JOIN dbo.Flights flight ON flight.FlightId=offload.FlightId
    CROSS APPLY (VALUES(UPPER(LTRIM(RTRIM(CONVERT(nvarchar(max),offload.'+QUOTENAME(@OffloadStatusColumn)+N')
      COLLATE Latin1_General_100_BIN2))))) normalized(StatusValue)
    WHERE offload.FlightId IS NULL OR flight.FlightId IS NULL;';
  INSERT @Findings(Severity,Finding,Detail) EXEC sys.sp_executesql @ExecutableSql;
END;

IF @FlightsReady=1 AND @StationMasterReady=1
  EXEC sys.sp_executesql N'SELECT station.StationCode,COUNT_BIG(*) AS FlightCount FROM dbo.Flights flight LEFT JOIN dbo.CargoRunStations station ON station.StationId=flight.StationId GROUP BY station.StationCode ORDER BY station.StationCode;';
IF @MessagesReady=1 AND @StationMasterReady=1
  EXEC sys.sp_executesql N'SELECT station.StationCode,COUNT_BIG(*) AS MessageCount FROM dbo.IncomingMachMessages message LEFT JOIN dbo.CargoRunStations station ON station.StationId=message.StationId GROUP BY station.StationCode ORDER BY station.StationCode;';

SELECT Severity,Finding,Detail FROM @Findings
ORDER BY CASE Severity WHEN 'STOP' THEN 0 ELSE 1 END,Finding,Detail;
