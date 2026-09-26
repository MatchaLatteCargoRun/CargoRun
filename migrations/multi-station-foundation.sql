-- Phase 2B: explicit station ownership with operator-confirmed MEL-only legacy backfill.
-- This migration deliberately does not repair route fields or infer orphan Offload ownership.
SET XACT_ABORT ON;
SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;

BEGIN TRY
  BEGIN TRANSACTION;

  DECLARE @LockResult int;
  EXEC @LockResult=sys.sp_getapplock
    @Resource=N'CargoRun:Migration:MultiStationFoundation:v2b',
    @LockMode='Exclusive',
    @LockOwner='Transaction',
    @LockTimeout=15000;
  IF @LockResult<0 THROW 51520,'Could not acquire the multi-station foundation migration lock.',1;

  DECLARE @ExecutableSql nvarchar(max);

  IF OBJECT_ID(N'dbo.CargoRunStations',N'U') IS NULL
    THROW 51521,'CargoRunStations is required.',1;
  IF OBJECT_ID(N'dbo.Flights',N'U') IS NULL
    THROW 51522,'Flights is required.',1;
  IF OBJECT_ID(N'dbo.IncomingMachMessages',N'U') IS NULL
    THROW 51523,'IncomingMachMessages is required.',1;
  IF OBJECT_ID(N'dbo.Offloads',N'U') IS NULL
    THROW 51542,'Offloads is required for the active-orphan safety gate.',1;

  IF NOT EXISTS (
    SELECT 1 FROM sys.columns columnObject
    WHERE columnObject.object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
      AND columnObject.name=N'StationId' AND TYPE_NAME(columnObject.user_type_id)=N'bigint'
      AND columnObject.max_length=8 AND columnObject.is_nullable=0 AND columnObject.is_computed=0
  ) THROW 51524,'CargoRunStations.StationId is incompatible.',1;
  IF NOT EXISTS (
    SELECT 1 FROM sys.columns columnObject
    WHERE columnObject.object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
      AND columnObject.name=N'StationCode' AND TYPE_NAME(columnObject.user_type_id)=N'varchar'
      AND columnObject.max_length=3 AND columnObject.is_nullable=0
  ) THROW 51525,'CargoRunStations.StationCode is incompatible.',1;
  IF COL_LENGTH(N'dbo.CargoRunStations',N'DisplayName') IS NULL
     OR COL_LENGTH(N'dbo.CargoRunStations',N'TimeZoneId') IS NULL
     OR COL_LENGTH(N'dbo.CargoRunStations',N'IsEnabled') IS NULL
    THROW 51526,'CargoRunStations metadata is incomplete.',1;

  DECLARE @MelStationCount bigint=(
    SELECT COUNT_BIG(*) FROM dbo.CargoRunStations
    WHERE UPPER(LTRIM(RTRIM(StationCode)))=N'MEL'
  );
  IF @MelStationCount<>1 THROW 51527,'Exactly one MEL station row is required.',1;

  DECLARE @MelStationId bigint;
  SELECT @MelStationId=StationId
  FROM dbo.CargoRunStations
  WHERE UPPER(LTRIM(RTRIM(StationCode)))=N'MEL'
    AND IsEnabled=1
    AND NULLIF(LTRIM(RTRIM(DisplayName)),N'') IS NOT NULL
    AND LTRIM(RTRIM(TimeZoneId))=N'Australia/Melbourne';
  IF @MelStationId IS NULL OR @MelStationId<=0
    THROW 51528,'MEL must be enabled with display metadata and Australia/Melbourne timezone.',1;

  IF COL_LENGTH(N'dbo.Flights',N'OperatingDate') IS NULL
     OR COL_LENGTH(N'dbo.Flights',N'FlightNumber') IS NULL
     OR COL_LENGTH(N'dbo.Flights',N'FlightId') IS NULL
    THROW 51529,'Flights identity columns are incomplete.',1;
  IF COL_LENGTH(N'dbo.IncomingMachMessages',N'OperatingDate') IS NULL
     OR COL_LENGTH(N'dbo.IncomingMachMessages',N'MachMessageId') IS NULL
     OR COL_LENGTH(N'dbo.IncomingMachMessages',N'DocumentCorID') IS NULL
    THROW 51530,'IncomingMachMessages identity columns are incomplete.',1;
  IF NOT EXISTS (
    SELECT 1 FROM sys.columns columnObject
    WHERE columnObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
      AND columnObject.name=N'DocumentCorID'
      AND columnObject.user_type_id=columnObject.system_type_id
      AND columnObject.system_type_id IN (167,231)
      AND columnObject.is_computed=0 AND columnObject.collation_name IS NOT NULL
      AND ((columnObject.system_type_id=167 AND (columnObject.max_length=-1 OR columnObject.max_length>=100))
        OR (columnObject.system_type_id=231 AND (columnObject.max_length=-1 OR columnObject.max_length>=200)))
  ) THROW 51549,'IncomingMachMessages.DocumentCorID must be a native noncomputed varchar/nvarchar column with capacity for 100 ASCII characters.',1;
  IF COL_LENGTH(N'dbo.Offloads',N'OffloadId') IS NULL
     OR COL_LENGTH(N'dbo.Offloads',N'FlightId') IS NULL
    THROW 51543,'Offloads ownership columns are incomplete.',1;

  DECLARE @HasOffloadStatus bit=CASE WHEN COL_LENGTH(N'dbo.Offloads',N'OffloadStatus') IS NOT NULL THEN 1 ELSE 0 END;
  DECLARE @HasStatus bit=CASE WHEN COL_LENGTH(N'dbo.Offloads',N'Status') IS NOT NULL THEN 1 ELSE 0 END;
  -- Match the runtime contract: Status is authoritative whenever it exists.
  DECLARE @OffloadStatusColumn sysname=CASE
    WHEN @HasStatus=1 THEN N'Status'
    WHEN @HasOffloadStatus=1 THEN N'OffloadStatus'
    ELSE NULL END;
  IF @OffloadStatusColumn IS NULL
    THROW 51544,'Offloads requires OffloadStatus or Status for the active-orphan safety gate.',1;

  -- Status must be a directly readable/writable character value. This keeps the
  -- safety gate fail-closed and makes conversion to nvarchar(max) non-truncating.
  IF EXISTS (
    SELECT 1
    FROM sys.columns columnObject
    WHERE columnObject.object_id=OBJECT_ID(N'dbo.Offloads',N'U')
      AND columnObject.name IN (N'Status',N'OffloadStatus')
      AND (TYPE_NAME(columnObject.system_type_id) NOT IN (N'varchar',N'char',N'nvarchar',N'nchar')
        OR columnObject.is_computed=1 OR columnObject.collation_name IS NULL)
  ) THROW 51547,'Offloads status columns have an unsafe schema for the active-orphan safety gate.',1;

  DECLARE @NormalizedOffloadStatusExpression nvarchar(1000)=
    N'UPPER(LTRIM(RTRIM(CONVERT(nvarchar(max),offload.'+QUOTENAME(@OffloadStatusColumn)
      +N') COLLATE Latin1_General_100_BIN2)))';

  -- A dual-column schema is transitional. It is safe only while both normalized
  -- values agree; otherwise choosing either column could hide active work.
  IF @HasStatus=1 AND @HasOffloadStatus=1
  BEGIN
    DECLARE @OffloadStatusConflictCount bigint;
    SET @ExecutableSql=N'SELECT @OffloadStatusConflictCount=COUNT_BIG(*)
      FROM dbo.Offloads offload
      CROSS APPLY (VALUES(
        UPPER(LTRIM(RTRIM(CONVERT(nvarchar(max),offload.[Status]) COLLATE Latin1_General_100_BIN2))),
        UPPER(LTRIM(RTRIM(CONVERT(nvarchar(max),offload.[OffloadStatus]) COLLATE Latin1_General_100_BIN2)))
      )) normalized(StatusValue,OffloadStatusValue)
      WHERE (normalized.StatusValue IS NULL AND normalized.OffloadStatusValue IS NOT NULL)
         OR (normalized.StatusValue IS NOT NULL AND normalized.OffloadStatusValue IS NULL)
         OR normalized.StatusValue<>normalized.OffloadStatusValue;';
    EXEC sys.sp_executesql @ExecutableSql,N'@OffloadStatusConflictCount bigint OUTPUT',
      @OffloadStatusConflictCount=@OffloadStatusConflictCount OUTPUT;
    IF @OffloadStatusConflictCount<>0
      THROW 51548,'Offloads Status and OffloadStatus disagree; migration cannot choose ownership lifecycle state safely.',1;
  END;

  DECLARE @ActiveOrphanOffloadCount bigint;
  SET @ExecutableSql=N'SELECT @ActiveOrphanOffloadCount=COUNT_BIG(*)
    FROM dbo.Offloads offload
    LEFT JOIN dbo.Flights flight ON flight.FlightId=offload.FlightId
    WHERE (offload.FlightId IS NULL OR flight.FlightId IS NULL)
      AND ('+@NormalizedOffloadStatusExpression+N' IS NULL
        OR '+@NormalizedOffloadStatusExpression+N'<>N''COMPLETE'' COLLATE Latin1_General_100_BIN2);';
  EXEC sys.sp_executesql @ExecutableSql,N'@ActiveOrphanOffloadCount bigint OUTPUT',
    @ActiveOrphanOffloadCount=@ActiveOrphanOffloadCount OUTPUT;
  IF @ActiveOrphanOffloadCount<>0
    THROW 51545,'Active or unclassified orphan Offloads must be resolved before Phase 2B.',1;

  -- DocumentCorID identity is deliberately narrower than any database default
  -- collation: trim only outer U+0020 on input, allow 1-100 ASCII
  -- letters/digits/hyphens, and persist deterministic ASCII uppercase. Existing
  -- evidence must already be canonical; this migration never rewrites it.
  -- TRANSLATE removes only the explicit allowed code units; DATALENGTH detects
  -- every residual value, including U+0000 which Windows-collation LIKE misses.
  DECLARE @InvalidDocumentCorIdCount bigint,@DocumentCorIdCanonicalizationCount bigint,
    @DocumentCorIdCollisionCount bigint;
  SET @ExecutableSql=N'
    SELECT
      @InvalidDocumentCorIdCount=COALESCE(SUM(CASE
        WHEN raw.RawDocumentCorID IS NULL OR DATALENGTH(trimmed.TrimmedDocumentCorID)=0
          OR DATALENGTH(trimmed.TrimmedDocumentCorID)>200
          OR DATALENGTH(REPLACE(TRANSLATE(
            trimmed.TrimmedDocumentCorID COLLATE Latin1_General_100_BIN2,
            N''ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-'',REPLICATE(N''A'',63)),N''A'',N''''))<>0
        THEN CONVERT(bigint,1) ELSE CONVERT(bigint,0) END),0),
      @DocumentCorIdCanonicalizationCount=COALESCE(SUM(CASE
        WHEN raw.RawDocumentCorID IS NOT NULL AND DATALENGTH(trimmed.TrimmedDocumentCorID)>0
          AND DATALENGTH(trimmed.TrimmedDocumentCorID)<=200
          AND DATALENGTH(REPLACE(TRANSLATE(
            trimmed.TrimmedDocumentCorID COLLATE Latin1_General_100_BIN2,
            N''ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-'',REPLICATE(N''A'',63)),N''A'',N''''))=0
          AND (DATALENGTH(raw.RawDocumentCorID)<>DATALENGTH(canonical.CanonicalDocumentCorID)
            OR raw.RawDocumentCorID COLLATE Latin1_General_100_BIN2
                 <>canonical.CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2)
        THEN CONVERT(bigint,1) ELSE CONVERT(bigint,0) END),0)
    FROM dbo.IncomingMachMessages message
    CROSS APPLY (VALUES(CONVERT(nvarchar(max),message.DocumentCorID))) raw(RawDocumentCorID)
    CROSS APPLY (VALUES(LTRIM(RTRIM(raw.RawDocumentCorID)))) trimmed(TrimmedDocumentCorID)
    CROSS APPLY (VALUES(UPPER(trimmed.TrimmedDocumentCorID COLLATE Latin1_General_100_BIN2))) canonical(CanonicalDocumentCorID);

    SELECT @DocumentCorIdCollisionCount=COUNT_BIG(*)
    FROM (
      SELECT canonical.CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2 AS CanonicalDocumentCorID
      FROM dbo.IncomingMachMessages message
      CROSS APPLY (VALUES(CONVERT(nvarchar(max),message.DocumentCorID))) raw(RawDocumentCorID)
      CROSS APPLY (VALUES(LTRIM(RTRIM(raw.RawDocumentCorID)))) trimmed(TrimmedDocumentCorID)
      CROSS APPLY (VALUES(UPPER(trimmed.TrimmedDocumentCorID COLLATE Latin1_General_100_BIN2))) canonical(CanonicalDocumentCorID)
      WHERE raw.RawDocumentCorID IS NOT NULL AND DATALENGTH(trimmed.TrimmedDocumentCorID)>0
        AND DATALENGTH(trimmed.TrimmedDocumentCorID)<=200
        AND DATALENGTH(REPLACE(TRANSLATE(
          trimmed.TrimmedDocumentCorID COLLATE Latin1_General_100_BIN2,
          N''ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-'',REPLICATE(N''A'',63)),N''A'',N''''))=0
      GROUP BY canonical.CanonicalDocumentCorID COLLATE Latin1_General_100_BIN2
      HAVING COUNT_BIG(*)>1
    ) collision;';
  EXEC sys.sp_executesql @ExecutableSql,
    N'@InvalidDocumentCorIdCount bigint OUTPUT,@DocumentCorIdCanonicalizationCount bigint OUTPUT,@DocumentCorIdCollisionCount bigint OUTPUT',
    @InvalidDocumentCorIdCount=@InvalidDocumentCorIdCount OUTPUT,
    @DocumentCorIdCanonicalizationCount=@DocumentCorIdCanonicalizationCount OUTPUT,
    @DocumentCorIdCollisionCount=@DocumentCorIdCollisionCount OUTPUT;
  IF @InvalidDocumentCorIdCount<>0
    THROW 51550,'INVALID_DOCUMENTCORID: existing values must contain 1-100 ASCII letters, digits, or hyphens after trimming outer U+0020.',1;
  IF @DocumentCorIdCanonicalizationCount<>0
    THROW 51551,'DOCUMENTCORID_CANONICALIZATION_REQUIRED: existing evidence is not stored as exact ASCII uppercase canonical identity.',1;
  IF @DocumentCorIdCollisionCount<>0
    THROW 51552,'DOCUMENTCORID_CANONICAL_COLLISION: existing messages collapse to the same canonical identity.',1;

  -- A pre-existing linguistic unique key could reject identities that the
  -- application and BIN2 contract keep distinct. It must be reviewed rather
  -- than silently removed by this migration.
  IF EXISTS (
    SELECT 1 FROM sys.indexes indexObject
    JOIN sys.index_columns keyColumn ON keyColumn.object_id=indexObject.object_id
      AND keyColumn.index_id=indexObject.index_id AND keyColumn.key_ordinal>0
    JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id
      AND columnObject.column_id=keyColumn.column_id
    WHERE indexObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
      AND indexObject.is_unique=1 AND indexObject.is_disabled=0 AND indexObject.is_hypothetical=0
      AND columnObject.name=N'DocumentCorID'
      AND columnObject.collation_name<>N'Latin1_General_100_BIN2'
  ) THROW 51553,'An existing unique DocumentCorID key uses linguistic equality and must be reviewed before Phase 2B.',1;

  -- Preserve raw evidence and add a deterministic BIN2 identity projection for
  -- database-enforced global uniqueness.
  IF COL_LENGTH(N'dbo.IncomingMachMessages',N'DocumentCorIDCanonical') IS NULL
  BEGIN
    SET @ExecutableSql=N'ALTER TABLE dbo.IncomingMachMessages ADD DocumentCorIDCanonical AS
      (CONVERT(nvarchar(100),DocumentCorID) COLLATE Latin1_General_100_BIN2) PERSISTED;';
    EXEC sys.sp_executesql @ExecutableSql;
  END;
  DECLARE @DocumentCorIdComputedDefinition nvarchar(max)=(
    SELECT LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
      columnObject.definition,N'[',N''),N']',N''),N'(',N''),N')',N''),N' ',N''),NCHAR(13),N''),NCHAR(10),N''),NCHAR(9),N''))
    FROM sys.computed_columns columnObject
    WHERE columnObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
      AND columnObject.name=N'DocumentCorIDCanonical'
  );
  IF NOT EXISTS (
    SELECT 1 FROM sys.computed_columns columnObject
    WHERE columnObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
      AND columnObject.name=N'DocumentCorIDCanonical'
      AND columnObject.user_type_id=columnObject.system_type_id
      AND columnObject.system_type_id=231 AND columnObject.max_length=200
      AND columnObject.is_persisted=1 AND columnObject.collation_name=N'Latin1_General_100_BIN2'
  ) OR @DocumentCorIdComputedDefinition<>N'convertnvarchar100,documentcoridcollatelatin1_general_100_bin2'
    THROW 51554,'IncomingMachMessages.DocumentCorIDCanonical exists with an incompatible definition.',1;

  -- Replace only the migration-owned guard name on rerun. CHECK constraints
  -- have no referencing key dependencies, and transactional replacement avoids
  -- accepting a weaker same-name definition.
  IF OBJECT_ID(N'dbo.CK_IncomingMachMessages_DocumentCorID_Canonical',N'C') IS NOT NULL
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM sys.fn_listextendedproperty(N'CargoRun.DocumentCorIDCanonicalGuardHash',
        N'SCHEMA',N'dbo',N'TABLE',N'IncomingMachMessages',N'CONSTRAINT',
        N'CK_IncomingMachMessages_DocumentCorID_Canonical')
    )
      EXEC sys.sp_dropextendedproperty
        @name=N'CargoRun.DocumentCorIDCanonicalGuardHash',
        @level0type=N'SCHEMA',@level0name=N'dbo',
        @level1type=N'TABLE',@level1name=N'IncomingMachMessages',
        @level2type=N'CONSTRAINT',@level2name=N'CK_IncomingMachMessages_DocumentCorID_Canonical';
    SET @ExecutableSql=N'ALTER TABLE dbo.IncomingMachMessages DROP CONSTRAINT CK_IncomingMachMessages_DocumentCorID_Canonical;';
    EXEC sys.sp_executesql @ExecutableSql;
  END;
  SET @ExecutableSql=N'ALTER TABLE dbo.IncomingMachMessages WITH CHECK ADD CONSTRAINT CK_IncomingMachMessages_DocumentCorID_Canonical CHECK (
    DocumentCorID IS NOT NULL
    AND DATALENGTH(CONVERT(nvarchar(max),DocumentCorID))>=2
    AND DATALENGTH(CONVERT(nvarchar(max),DocumentCorID))<=200
    AND DATALENGTH(CONVERT(nvarchar(max),DocumentCorID))
      =DATALENGTH(LTRIM(RTRIM(CONVERT(nvarchar(max),DocumentCorID))))
    AND DATALENGTH(REPLACE(TRANSLATE(
      CONVERT(nvarchar(max),DocumentCorID) COLLATE Latin1_General_100_BIN2,
      N''ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'',REPLICATE(N''A'',37)),N''A'',N''''))=0
  );';
  EXEC sys.sp_executesql @ExecutableSql;
  SET @ExecutableSql=N'ALTER TABLE dbo.IncomingMachMessages WITH CHECK CHECK CONSTRAINT CK_IncomingMachMessages_DocumentCorID_Canonical;';
  EXEC sys.sp_executesql @ExecutableSql;

  -- The catalog text is hashed after SQL Server has normalized the expression.
  -- Dropping/recreating the constraint also drops this object-level signature,
  -- so the verifier can prove that the trusted guard still has this exact body.
  DECLARE @DocumentCorIdCheckDefinitionHash varchar(64)=(
    SELECT CONVERT(varchar(64),HASHBYTES('SHA2_256',CONVERT(varbinary(max),checkObject.definition)),2)
    FROM sys.check_constraints checkObject
    WHERE checkObject.parent_object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
      AND checkObject.name=N'CK_IncomingMachMessages_DocumentCorID_Canonical'
  );
  IF @DocumentCorIdCheckDefinitionHash IS NULL
    THROW 51555,'The canonical DocumentCorID guard definition could not be signed.',1;
  EXEC sys.sp_addextendedproperty
    @name=N'CargoRun.DocumentCorIDCanonicalGuardHash',@value=@DocumentCorIdCheckDefinitionHash,
    @level0type=N'SCHEMA',@level0name=N'dbo',
    @level1type=N'TABLE',@level1name=N'IncomingMachMessages',
    @level2type=N'CONSTRAINT',@level2name=N'CK_IncomingMachMessages_DocumentCorID_Canonical';
  IF NOT EXISTS (
    SELECT 1
    FROM sys.fn_listextendedproperty(N'CargoRun.DocumentCorIDCanonicalGuardHash',
      N'SCHEMA',N'dbo',N'TABLE',N'IncomingMachMessages',N'CONSTRAINT',
      N'CK_IncomingMachMessages_DocumentCorID_Canonical') property
    WHERE CONVERT(varchar(64),property.value)=@DocumentCorIdCheckDefinitionHash
  ) THROW 51555,'The canonical DocumentCorID guard definition signature could not be verified.',1;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes indexObject
    WHERE indexObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
      AND indexObject.is_unique=1 AND indexObject.is_disabled=0
      AND indexObject.is_hypothetical=0 AND indexObject.has_filter=0
      AND indexObject.ignore_dup_key=0
      AND (SELECT COUNT_BIG(*) FROM sys.index_columns keyColumn
           WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id
             AND keyColumn.key_ordinal>0)=1
      AND EXISTS (
        SELECT 1 FROM sys.index_columns keyColumn
        JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id
          AND columnObject.column_id=keyColumn.column_id
        WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id
          AND keyColumn.key_ordinal=1 AND columnObject.name=N'DocumentCorIDCanonical'
      )
  )
  BEGIN
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
      AND name=N'UX_IncomingMachMessages_DocumentCorIDCanonical')
      THROW 51556,'UX_IncomingMachMessages_DocumentCorIDCanonical exists with an incompatible definition.',1;
    SET @ExecutableSql=N'CREATE UNIQUE INDEX UX_IncomingMachMessages_DocumentCorIDCanonical
      ON dbo.IncomingMachMessages(DocumentCorIDCanonical);';
    EXEC sys.sp_executesql @ExecutableSql;
  END;

  IF EXISTS (
    SELECT 1 FROM sys.check_constraints checkObject
    WHERE checkObject.parent_object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
      AND checkObject.name=N'CK_IncomingMachMessages_DocumentCorID_Canonical'
      AND (checkObject.is_disabled=1 OR checkObject.is_not_trusted=1)
  ) THROW 51557,'The canonical DocumentCorID check constraint is disabled or untrusted.',1;
  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes indexObject
    WHERE indexObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
      AND indexObject.is_unique=1 AND indexObject.is_disabled=0
      AND indexObject.is_hypothetical=0 AND indexObject.has_filter=0
      AND indexObject.ignore_dup_key=0
      AND (SELECT COUNT_BIG(*) FROM sys.index_columns keyColumn
           WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id
             AND keyColumn.key_ordinal>0)=1
      AND EXISTS (
        SELECT 1 FROM sys.index_columns keyColumn
        JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id
          AND columnObject.column_id=keyColumn.column_id
        WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id
          AND keyColumn.key_ordinal=1 AND columnObject.name=N'DocumentCorIDCanonical'
      )
  ) THROW 51558,'Global BIN2 DocumentCorID uniqueness could not be verified.',1;

  IF COL_LENGTH(N'dbo.Flights',N'StationId') IS NULL
  BEGIN
    SET @ExecutableSql=N'ALTER TABLE dbo.Flights ADD StationId bigint NULL;';
    EXEC sys.sp_executesql @ExecutableSql;
  END;
  IF COL_LENGTH(N'dbo.IncomingMachMessages',N'StationId') IS NULL
  BEGIN
    SET @ExecutableSql=N'ALTER TABLE dbo.IncomingMachMessages ADD StationId bigint NULL;';
    EXEC sys.sp_executesql @ExecutableSql;
  END;

  IF EXISTS (
    SELECT 1 FROM sys.columns columnObject
    WHERE columnObject.object_id IN (OBJECT_ID(N'dbo.Flights',N'U'),OBJECT_ID(N'dbo.IncomingMachMessages',N'U'))
      AND columnObject.name=N'StationId'
      AND (TYPE_NAME(columnObject.user_type_id)<>N'bigint' OR columnObject.max_length<>8
        OR columnObject.is_nullable<>1 OR columnObject.is_computed<>0)
  ) THROW 51531,'Operational StationId columns are incompatible.',1;

  IF EXISTS (
    SELECT 1
    FROM sys.foreign_keys foreignKey
    WHERE foreignKey.parent_object_id IN (OBJECT_ID(N'dbo.Flights',N'U'),OBJECT_ID(N'dbo.IncomingMachMessages',N'U'))
      AND EXISTS (
        SELECT 1 FROM sys.foreign_key_columns stationLink
        WHERE stationLink.constraint_object_id=foreignKey.object_id
          AND stationLink.parent_object_id=foreignKey.parent_object_id
          AND COL_NAME(stationLink.parent_object_id,stationLink.parent_column_id)=N'StationId'
      )
      AND (foreignKey.referenced_object_id<>OBJECT_ID(N'dbo.CargoRunStations',N'U')
        OR foreignKey.is_disabled=1 OR foreignKey.is_not_trusted=1
        OR foreignKey.delete_referential_action<>0 OR foreignKey.update_referential_action<>0
        OR (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns allLinks
            WHERE allLinks.constraint_object_id=foreignKey.object_id)<>1
        OR NOT EXISTS (
          SELECT 1 FROM sys.foreign_key_columns exactLink
          WHERE exactLink.constraint_object_id=foreignKey.object_id
            AND exactLink.parent_object_id=foreignKey.parent_object_id
            AND exactLink.referenced_object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
            AND COL_NAME(exactLink.parent_object_id,exactLink.parent_column_id)=N'StationId'
            AND COL_NAME(exactLink.referenced_object_id,exactLink.referenced_column_id)=N'StationId'
        ))
  ) THROW 51546,'A StationId foreign key is composite, conflicting, disabled, untrusted, or cascading.',1;

  IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys foreignKey
    WHERE foreignKey.parent_object_id=OBJECT_ID(N'dbo.Flights',N'U')
      AND foreignKey.referenced_object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
      AND foreignKey.is_disabled=0 AND foreignKey.is_not_trusted=0
      AND foreignKey.delete_referential_action=0 AND foreignKey.update_referential_action=0
      AND (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns allLinks
           WHERE allLinks.constraint_object_id=foreignKey.object_id)=1
      AND EXISTS (
        SELECT 1 FROM sys.foreign_key_columns exactLink
        WHERE exactLink.constraint_object_id=foreignKey.object_id
          AND COL_NAME(exactLink.parent_object_id,exactLink.parent_column_id)=N'StationId'
          AND COL_NAME(exactLink.referenced_object_id,exactLink.referenced_column_id)=N'StationId'
      )
  )
  BEGIN
    IF OBJECT_ID(N'dbo.FK_Flights_CargoRunStation',N'F') IS NOT NULL
      THROW 51532,'FK_Flights_CargoRunStation exists with an incompatible definition.',1;
    SET @ExecutableSql=N'ALTER TABLE dbo.Flights WITH CHECK ADD CONSTRAINT FK_Flights_CargoRunStation FOREIGN KEY(StationId) REFERENCES dbo.CargoRunStations(StationId); ALTER TABLE dbo.Flights CHECK CONSTRAINT FK_Flights_CargoRunStation;';
    EXEC sys.sp_executesql @ExecutableSql;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys foreignKey
    WHERE foreignKey.parent_object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
      AND foreignKey.referenced_object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
      AND foreignKey.is_disabled=0 AND foreignKey.is_not_trusted=0
      AND foreignKey.delete_referential_action=0 AND foreignKey.update_referential_action=0
      AND (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns allLinks
           WHERE allLinks.constraint_object_id=foreignKey.object_id)=1
      AND EXISTS (
        SELECT 1 FROM sys.foreign_key_columns exactLink
        WHERE exactLink.constraint_object_id=foreignKey.object_id
          AND COL_NAME(exactLink.parent_object_id,exactLink.parent_column_id)=N'StationId'
          AND COL_NAME(exactLink.referenced_object_id,exactLink.referenced_column_id)=N'StationId'
      )
  )
  BEGIN
    IF OBJECT_ID(N'dbo.FK_IncomingMachMessages_CargoRunStation',N'F') IS NOT NULL
      THROW 51533,'FK_IncomingMachMessages_CargoRunStation exists with an incompatible definition.',1;
    SET @ExecutableSql=N'ALTER TABLE dbo.IncomingMachMessages WITH CHECK ADD CONSTRAINT FK_IncomingMachMessages_CargoRunStation FOREIGN KEY(StationId) REFERENCES dbo.CargoRunStations(StationId); ALTER TABLE dbo.IncomingMachMessages CHECK CONSTRAINT FK_IncomingMachMessages_CargoRunStation;';
    EXEC sys.sp_executesql @ExecutableSql;
  END;

  DECLARE @FlightsForeignKey sysname=(
    SELECT TOP (1) foreignKey.name
    FROM sys.foreign_keys foreignKey
    WHERE foreignKey.parent_object_id=OBJECT_ID(N'dbo.Flights',N'U')
      AND foreignKey.referenced_object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
      AND foreignKey.is_disabled=0 AND foreignKey.is_not_trusted=0
      AND foreignKey.delete_referential_action=0 AND foreignKey.update_referential_action=0
      AND (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns allLinks
           WHERE allLinks.constraint_object_id=foreignKey.object_id)=1
      AND EXISTS (
        SELECT 1 FROM sys.foreign_key_columns exactLink
        WHERE exactLink.constraint_object_id=foreignKey.object_id
          AND COL_NAME(exactLink.parent_object_id,exactLink.parent_column_id)=N'StationId'
          AND COL_NAME(exactLink.referenced_object_id,exactLink.referenced_column_id)=N'StationId'
      )
  );
  DECLARE @MessagesForeignKey sysname=(
    SELECT TOP (1) foreignKey.name
    FROM sys.foreign_keys foreignKey
    WHERE foreignKey.parent_object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
      AND foreignKey.referenced_object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
      AND foreignKey.is_disabled=0 AND foreignKey.is_not_trusted=0
      AND foreignKey.delete_referential_action=0 AND foreignKey.update_referential_action=0
      AND (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns allLinks
           WHERE allLinks.constraint_object_id=foreignKey.object_id)=1
      AND EXISTS (
        SELECT 1 FROM sys.foreign_key_columns exactLink
        WHERE exactLink.constraint_object_id=foreignKey.object_id
          AND COL_NAME(exactLink.parent_object_id,exactLink.parent_column_id)=N'StationId'
          AND COL_NAME(exactLink.referenced_object_id,exactLink.referenced_column_id)=N'StationId'
      )
  );
  IF @FlightsForeignKey IS NULL OR @MessagesForeignKey IS NULL
    THROW 51539,'Station ownership foreign keys could not be resolved.',1;
  SET @ExecutableSql=N'ALTER TABLE dbo.Flights WITH CHECK CHECK CONSTRAINT '+QUOTENAME(@FlightsForeignKey)+N'; ALTER TABLE dbo.IncomingMachMessages WITH CHECK CHECK CONSTRAINT '+QUOTENAME(@MessagesForeignKey)+N';';
  EXEC sys.sp_executesql @ExecutableSql;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes indexObject
    WHERE indexObject.object_id=OBJECT_ID(N'dbo.Flights',N'U') AND indexObject.is_disabled=0
      AND indexObject.is_hypothetical=0 AND indexObject.has_filter=0
      AND EXISTS (SELECT 1 FROM sys.index_columns keyColumn JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id AND columnObject.column_id=keyColumn.column_id WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id AND keyColumn.key_ordinal=1 AND columnObject.name=N'StationId')
      AND EXISTS (SELECT 1 FROM sys.index_columns keyColumn JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id AND columnObject.column_id=keyColumn.column_id WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id AND keyColumn.key_ordinal=2 AND columnObject.name=N'OperatingDate')
      AND EXISTS (SELECT 1 FROM sys.index_columns keyColumn JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id AND columnObject.column_id=keyColumn.column_id WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id AND keyColumn.key_ordinal=3 AND columnObject.name=N'FlightNumber')
  )
  BEGIN
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.Flights',N'U') AND name=N'IX_Flights_Station_Date_Flight')
      THROW 51534,'IX_Flights_Station_Date_Flight exists with an incompatible definition.',1;
    SET @ExecutableSql=N'CREATE INDEX IX_Flights_Station_Date_Flight ON dbo.Flights(StationId,OperatingDate,FlightNumber) INCLUDE(Direction,FlightStatus);';
    EXEC sys.sp_executesql @ExecutableSql;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes indexObject
    WHERE indexObject.object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U') AND indexObject.is_disabled=0
      AND indexObject.is_hypothetical=0 AND indexObject.has_filter=0
      AND EXISTS (SELECT 1 FROM sys.index_columns keyColumn JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id AND columnObject.column_id=keyColumn.column_id WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id AND keyColumn.key_ordinal=1 AND columnObject.name=N'StationId')
      AND EXISTS (SELECT 1 FROM sys.index_columns keyColumn JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id AND columnObject.column_id=keyColumn.column_id WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id AND keyColumn.key_ordinal=2 AND columnObject.name=N'OperatingDate')
      AND EXISTS (SELECT 1 FROM sys.index_columns keyColumn JOIN sys.columns columnObject ON columnObject.object_id=keyColumn.object_id AND columnObject.column_id=keyColumn.column_id WHERE keyColumn.object_id=indexObject.object_id AND keyColumn.index_id=indexObject.index_id AND keyColumn.key_ordinal=3 AND columnObject.name=N'MachMessageId')
  )
  BEGIN
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U') AND name=N'IX_IncomingMachMessages_Station_Date_Message')
      THROW 51535,'IX_IncomingMachMessages_Station_Date_Message exists with an incompatible definition.',1;
    SET @ExecutableSql=N'CREATE INDEX IX_IncomingMachMessages_Station_Date_Message ON dbo.IncomingMachMessages(StationId,OperatingDate,MachMessageId);';
    EXEC sys.sp_executesql @ExecutableSql;
  END;

  -- Operator-confirmed fact: every row present before Phase 2B is MEL test data.
  -- Route fields are intentionally not consulted or changed by this backfill.
  DECLARE @ExistingNonMelFlights bigint,@ExistingNonMelMessages bigint;
  SET @ExecutableSql=N'SELECT @ExistingNonMelFlights=COUNT_BIG(*) FROM dbo.Flights WHERE StationId IS NOT NULL AND StationId<>@MelStationId; SELECT @ExistingNonMelMessages=COUNT_BIG(*) FROM dbo.IncomingMachMessages WHERE StationId IS NOT NULL AND StationId<>@MelStationId;';
  EXEC sys.sp_executesql @ExecutableSql,N'@MelStationId bigint,@ExistingNonMelFlights bigint OUTPUT,@ExistingNonMelMessages bigint OUTPUT',@MelStationId=@MelStationId,@ExistingNonMelFlights=@ExistingNonMelFlights OUTPUT,@ExistingNonMelMessages=@ExistingNonMelMessages OUTPUT;
  IF @ExistingNonMelFlights<>0 THROW 51540,'Existing flight ownership contradicts the operator-confirmed MEL-only backfill.',1;
  IF @ExistingNonMelMessages<>0 THROW 51541,'Existing MACH ownership contradicts the operator-confirmed MEL-only backfill.',1;

  SET @ExecutableSql=N'UPDATE dbo.Flights SET StationId=@MelStationId WHERE StationId IS NULL; UPDATE dbo.IncomingMachMessages SET StationId=@MelStationId WHERE StationId IS NULL;';
  EXEC sys.sp_executesql @ExecutableSql,N'@MelStationId bigint',@MelStationId=@MelStationId;

  DECLARE @InvalidFlights bigint,@InvalidMessages bigint;
  SET @ExecutableSql=N'SELECT @InvalidFlights=COUNT_BIG(*) FROM dbo.Flights flight LEFT JOIN dbo.CargoRunStations station ON station.StationId=flight.StationId WHERE flight.StationId IS NULL OR station.StationId IS NULL OR station.IsEnabled=0; SELECT @InvalidMessages=COUNT_BIG(*) FROM dbo.IncomingMachMessages message LEFT JOIN dbo.CargoRunStations station ON station.StationId=message.StationId WHERE message.StationId IS NULL OR station.StationId IS NULL OR station.IsEnabled=0;';
  EXEC sys.sp_executesql @ExecutableSql,N'@InvalidFlights bigint OUTPUT,@InvalidMessages bigint OUTPUT',@InvalidFlights=@InvalidFlights OUTPUT,@InvalidMessages=@InvalidMessages OUTPUT;
  IF @InvalidFlights<>0 THROW 51536,'Flights station backfill verification failed.',1;
  IF @InvalidMessages<>0 THROW 51537,'Incoming MACH station backfill verification failed.',1;
  IF EXISTS (
    SELECT 1 FROM sys.foreign_keys foreignKey
    WHERE foreignKey.parent_object_id IN (OBJECT_ID(N'dbo.Flights',N'U'),OBJECT_ID(N'dbo.IncomingMachMessages',N'U'))
      AND EXISTS (
        SELECT 1 FROM sys.foreign_key_columns stationLink
        WHERE stationLink.constraint_object_id=foreignKey.object_id
          AND stationLink.parent_object_id=foreignKey.parent_object_id
          AND COL_NAME(stationLink.parent_object_id,stationLink.parent_column_id)=N'StationId'
      )
      AND (foreignKey.referenced_object_id<>OBJECT_ID(N'dbo.CargoRunStations',N'U')
        OR foreignKey.is_disabled=1 OR foreignKey.is_not_trusted=1
        OR foreignKey.delete_referential_action<>0 OR foreignKey.update_referential_action<>0
        OR (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns allLinks
            WHERE allLinks.constraint_object_id=foreignKey.object_id)<>1
        OR NOT EXISTS (
          SELECT 1 FROM sys.foreign_key_columns exactLink
          WHERE exactLink.constraint_object_id=foreignKey.object_id
            AND exactLink.parent_object_id=foreignKey.parent_object_id
            AND exactLink.referenced_object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
            AND COL_NAME(exactLink.parent_object_id,exactLink.parent_column_id)=N'StationId'
            AND COL_NAME(exactLink.referenced_object_id,exactLink.referenced_column_id)=N'StationId'
        ))
  ) OR NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys foreignKey
    WHERE foreignKey.parent_object_id=OBJECT_ID(N'dbo.Flights',N'U')
      AND foreignKey.referenced_object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
      AND foreignKey.is_disabled=0 AND foreignKey.is_not_trusted=0
      AND foreignKey.delete_referential_action=0 AND foreignKey.update_referential_action=0
      AND (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns allLinks
           WHERE allLinks.constraint_object_id=foreignKey.object_id)=1
      AND EXISTS (SELECT 1 FROM sys.foreign_key_columns exactLink
        WHERE exactLink.constraint_object_id=foreignKey.object_id
          AND COL_NAME(exactLink.parent_object_id,exactLink.parent_column_id)=N'StationId'
          AND COL_NAME(exactLink.referenced_object_id,exactLink.referenced_column_id)=N'StationId')
  ) OR NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys foreignKey
    WHERE foreignKey.parent_object_id=OBJECT_ID(N'dbo.IncomingMachMessages',N'U')
      AND foreignKey.referenced_object_id=OBJECT_ID(N'dbo.CargoRunStations',N'U')
      AND foreignKey.is_disabled=0 AND foreignKey.is_not_trusted=0
      AND foreignKey.delete_referential_action=0 AND foreignKey.update_referential_action=0
      AND (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns allLinks
           WHERE allLinks.constraint_object_id=foreignKey.object_id)=1
      AND EXISTS (SELECT 1 FROM sys.foreign_key_columns exactLink
        WHERE exactLink.constraint_object_id=foreignKey.object_id
          AND COL_NAME(exactLink.parent_object_id,exactLink.parent_column_id)=N'StationId'
          AND COL_NAME(exactLink.referenced_object_id,exactLink.referenced_column_id)=N'StationId')
  )
    THROW 51538,'Station ownership foreign keys are not exact, enabled, trusted, single-column, and noncascading.',1;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
