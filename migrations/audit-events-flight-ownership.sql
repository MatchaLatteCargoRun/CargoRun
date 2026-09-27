-- REVIEW ONLY. Add authoritative nullable Flight ownership to AuditEvents.
-- OFFLINE migration: drain writes; strong locks may also block reads depending on isolation.
-- Take a verified backup/snapshot first and run in a controlled migration window.
-- Run only after audit-events-flight-ownership-preflight.sql returns PROCEED.
SET XACT_ABORT ON;
SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;

BEGIN TRY
  BEGIN TRANSACTION;
  DECLARE @LockResult int;
  EXEC @LockResult=sys.sp_getapplock @Resource=N'CargoRun:Migration:AuditEventsFlightOwnership:v1',
    @LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=15000;
  IF @LockResult<0 THROW 51600,'Could not acquire the AuditEvents ownership migration lock.',1;

  DECLARE @AuditObjectId int=OBJECT_ID(N'dbo.AuditEvents',N'U');
  DECLARE @FlightObjectId int=OBJECT_ID(N'dbo.Flights',N'U');
  DECLARE @Sql nvarchar(max);
  IF @AuditObjectId IS NULL OR @FlightObjectId IS NULL THROW 51601,'AuditEvents and Flights are required.',1;

  DECLARE @AuditIdentityReady bit=CASE WHEN EXISTS (
    SELECT 1 FROM sys.columns c WHERE c.object_id=@AuditObjectId AND c.name=N'AuditEventId'
      AND c.system_type_id=127 AND c.user_type_id=127 AND c.max_length=8 AND c.precision=19 AND c.scale=0
      AND c.is_nullable=0 AND c.is_computed=0
  ) AND EXISTS (
    SELECT 1 FROM sys.indexes i WHERE i.object_id=@AuditObjectId AND i.is_unique=1 AND i.is_disabled=0
      AND i.is_hypothetical=0 AND i.has_filter=0 AND i.ignore_dup_key=0
      AND (SELECT COUNT_BIG(*) FROM sys.index_columns k WHERE k.object_id=i.object_id AND k.index_id=i.index_id AND k.key_ordinal>0)=1
      AND EXISTS (SELECT 1 FROM sys.index_columns k JOIN sys.columns c ON c.object_id=k.object_id AND c.column_id=k.column_id
        WHERE k.object_id=i.object_id AND k.index_id=i.index_id AND k.key_ordinal=1 AND c.name=N'AuditEventId')
  ) THEN 1 ELSE 0 END;
  IF @AuditIdentityReady=0 THROW 51602,'AuditEvents.AuditEventId must be native bigint NOT NULL, noncomputed, and exactly unique.',1;

  DECLARE @FlightIdentityReady bit=CASE WHEN EXISTS (
    SELECT 1 FROM sys.columns c WHERE c.object_id=@FlightObjectId AND c.name=N'FlightId'
      AND c.system_type_id=127 AND c.user_type_id=127 AND c.max_length=8 AND c.precision=19 AND c.scale=0
      AND c.is_nullable=0 AND c.is_computed=0
  ) AND EXISTS (
    SELECT 1 FROM sys.indexes i WHERE i.object_id=@FlightObjectId AND i.is_unique=1 AND i.is_disabled=0
      AND i.is_hypothetical=0 AND i.has_filter=0 AND i.ignore_dup_key=0
      AND (SELECT COUNT_BIG(*) FROM sys.index_columns k WHERE k.object_id=i.object_id AND k.index_id=i.index_id AND k.key_ordinal>0)=1
      AND EXISTS (SELECT 1 FROM sys.index_columns k JOIN sys.columns c ON c.object_id=k.object_id AND c.column_id=k.column_id
        WHERE k.object_id=i.object_id AND k.index_id=i.index_id AND k.key_ordinal=1 AND c.name=N'FlightId')
  ) THEN 1 ELSE 0 END;
  IF @FlightIdentityReady=0 THROW 51603,'Flights.FlightId must be native bigint NOT NULL, noncomputed, and exactly unique.',1;

  IF NOT EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id=@AuditObjectId AND c.name=N'OccurredAtUtc'
    AND c.system_type_id=42 AND c.user_type_id=42 AND c.is_computed=0)
    THROW 51604,'AuditEvents.OccurredAtUtc must be native noncomputed datetime2.',1;

  DECLARE @FlightColumnPresent bit=CASE WHEN COL_LENGTH(N'dbo.AuditEvents',N'FlightId') IS NOT NULL THEN 1 ELSE 0 END;
  DECLARE @FlightColumnReady bit=CASE WHEN EXISTS (
    SELECT 1 FROM sys.columns c LEFT JOIN sys.default_constraints d ON d.parent_object_id=c.object_id AND d.parent_column_id=c.column_id
    WHERE c.object_id=@AuditObjectId AND c.name=N'FlightId' AND c.system_type_id=127 AND c.user_type_id=127
      AND c.max_length=8 AND c.precision=19 AND c.scale=0 AND c.is_nullable=1 AND c.is_computed=0 AND d.object_id IS NULL
  ) THEN 1 ELSE 0 END;
  IF @FlightColumnPresent=1 AND @FlightColumnReady=0 THROW 51605,'Existing AuditEvents.FlightId is incompatible.',1;

  DECLARE @UldReady bit=CASE WHEN OBJECT_ID(N'dbo.ULDs',N'U') IS NOT NULL
    AND EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND c.name=N'UldId' AND c.system_type_id=127 AND c.user_type_id=127 AND c.is_computed=0)
    AND EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND c.name=N'FlightId' AND c.system_type_id=127 AND c.user_type_id=127 AND c.is_computed=0)
    THEN 1 ELSE 0 END;
  DECLARE @OffloadReady bit=CASE WHEN OBJECT_ID(N'dbo.Offloads',N'U') IS NOT NULL
    AND EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id=OBJECT_ID(N'dbo.Offloads',N'U') AND c.name=N'OffloadId' AND c.system_type_id=127 AND c.user_type_id=127 AND c.is_computed=0)
    AND EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id=OBJECT_ID(N'dbo.Offloads',N'U') AND c.name=N'FlightId' AND c.system_type_id=127 AND c.user_type_id=127 AND c.is_computed=0)
    THEN 1 ELSE 0 END;
  IF @UldReady=0 OR @OffloadReady=0 THROW 51606,'ULDs and Offloads require native noncomputed bigint identity and FlightId columns.',1;

  IF EXISTS (SELECT 1 FROM sys.triggers triggerObject WHERE triggerObject.parent_id=@AuditObjectId AND triggerObject.is_disabled=0
    AND EXISTS (SELECT 1 FROM sys.trigger_events triggerEvent WHERE triggerEvent.object_id=triggerObject.object_id AND triggerEvent.type_desc=N'INSERT'))
    THROW 51607,'An enabled AuditEvents INSERT trigger requires operator review before migration.',1;
  IF EXISTS (SELECT 1 FROM sys.triggers triggerObject WHERE triggerObject.parent_id=@AuditObjectId AND triggerObject.is_disabled=0
    AND EXISTS (SELECT 1 FROM sys.trigger_events triggerEvent WHERE triggerEvent.object_id=triggerObject.object_id AND triggerEvent.type_desc=N'UPDATE'))
    THROW 51608,'An enabled AuditEvents UPDATE trigger prevents a provably safe ownership backfill.',1;

  -- Freeze every source used for exact identity resolution. This is an offline migration.
  DECLARE @LockedRows bigint;
  SELECT @LockedRows=COUNT_BIG(AuditEventId) FROM dbo.AuditEvents WITH (TABLOCKX,HOLDLOCK);
  SELECT @LockedRows=COUNT_BIG(FlightId) FROM dbo.Flights WITH (TABLOCKX,HOLDLOCK);
  SELECT @LockedRows=COUNT_BIG(UldId) FROM dbo.ULDs WITH (TABLOCKX,HOLDLOCK);
  SELECT @LockedRows=COUNT_BIG(OffloadId) FROM dbo.Offloads WITH (TABLOCKX,HOLDLOCK);

  IF @FlightColumnPresent=0
  BEGIN
    ALTER TABLE dbo.AuditEvents ADD FlightId bigint NULL;
    SET @FlightColumnPresent=1;
    SET @FlightColumnReady=1;
  END;

  DECLARE @HasEntity bit=CASE WHEN COL_LENGTH(N'dbo.AuditEvents',N'EntityType') IS NOT NULL AND COL_LENGTH(N'dbo.AuditEvents',N'EntityId') IS NOT NULL THEN 1 ELSE 0 END;
  DECLARE @HasDetails bit=CASE WHEN COL_LENGTH(N'dbo.AuditEvents',N'DetailsJson') IS NOT NULL THEN 1 ELSE 0 END;
  DECLARE @HasPhysicalUld bit=CASE WHEN COL_LENGTH(N'dbo.AuditEvents',N'UldId') IS NOT NULL THEN 1 ELSE 0 END;
  DECLARE @HasPhysicalOffload bit=CASE WHEN COL_LENGTH(N'dbo.AuditEvents',N'OffloadId') IS NOT NULL THEN 1 ELSE 0 END;
  DECLARE @CandidateModelReady bit=CONVERT(bit,1);

-- CANONICAL AUDIT OWNERSHIP CANDIDATE MODEL BEGIN
CREATE TABLE #CandidateClaims(AuditEventId bigint NOT NULL,CandidateFlightId bigint NOT NULL,EvidenceType varchar(40) NOT NULL,EvidencePriority tinyint NOT NULL);
CREATE TABLE #JsonOwnershipClaims(AuditEventId bigint NOT NULL,OwnershipKey varchar(20) NOT NULL,RawValue nvarchar(max) NULL,JsonType int NOT NULL);
CREATE TABLE #UldIdentityClaims(AuditEventId bigint NOT NULL,UldId bigint NOT NULL);
CREATE TABLE #OffloadIdentityClaims(AuditEventId bigint NOT NULL,OffloadId bigint NOT NULL);
CREATE TABLE #FlightScopedEvents(AuditEventId bigint NOT NULL PRIMARY KEY);
CREATE TABLE #Resolved(AuditEventId bigint NOT NULL PRIMARY KEY,FlightId bigint NOT NULL,EvidenceType varchar(40) NOT NULL,EvidencePriority tinyint NOT NULL);
DECLARE @DuplicateJsonOwnership bigint=0,@DuplicateUldIdentity bigint=0,@DuplicateOffloadIdentity bigint=0;
DECLARE @InvalidCandidateReference bigint=0,@Ambiguous bigint=0;

IF @CandidateModelReady=1
BEGIN
  IF @FlightColumnReady=1
  BEGIN
    SET @Sql=N'INSERT #CandidateClaims SELECT audit.AuditEventId,audit.FlightId,''ALREADY_OWNED'',0
      FROM dbo.AuditEvents audit WHERE audit.FlightId IS NOT NULL;';
    EXEC sys.sp_executesql @Sql;
  END;
  IF @HasDetails=1
  BEGIN
    -- Malformed JSON deliberately contributes no JSON candidate. Duplicate ownership keys fail closed below.
    SET @Sql=N'INSERT #JsonOwnershipClaims(AuditEventId,OwnershipKey,RawValue,JsonType)
      SELECT audit.AuditEventId,CONVERT(varchar(20),jsonEntry.[key]),jsonEntry.[value],jsonEntry.[type]
      FROM dbo.AuditEvents audit
      CROSS APPLY OPENJSON(CASE WHEN ISJSON(audit.DetailsJson)=1 THEN audit.DetailsJson ELSE N''{}'' END) jsonEntry
      WHERE jsonEntry.[key] COLLATE Latin1_General_100_BIN2 IN (N''flightId'',N''uldId'',N''offloadId'');';
    EXEC sys.sp_executesql @Sql;
    SELECT @DuplicateJsonOwnership=COUNT_BIG(*) FROM (
      SELECT AuditEventId,OwnershipKey FROM #JsonOwnershipClaims GROUP BY AuditEventId,OwnershipKey HAVING COUNT_BIG(*)>1
    ) duplicateJson;
  END;
  IF @HasEntity=1
  BEGIN
    SET @Sql=N'INSERT #CandidateClaims
      SELECT audit.AuditEventId,parsed.IdValue,''BACKFILL_FROM_FLIGHT'',10 FROM dbo.AuditEvents audit
      CROSS APPLY (VALUES(LTRIM(RTRIM(CONVERT(nvarchar(100),audit.EntityId))) COLLATE Latin1_General_100_BIN2)) normalized(IdText)
      CROSS APPLY (VALUES(TRY_CONVERT(bigint,normalized.IdText))) parsed(IdValue)
      WHERE UPPER(LTRIM(RTRIM(CONVERT(nvarchar(50),audit.EntityType)))) COLLATE Latin1_General_100_BIN2=N''FLIGHT''
        AND normalized.IdText<>N'''' AND LEN(normalized.IdText)<=19
        AND normalized.IdText NOT LIKE N''%[^0-9]%'' COLLATE Latin1_General_100_BIN2 AND parsed.IdValue>0;';
    EXEC sys.sp_executesql @Sql;
    SET @Sql=N'INSERT #FlightScopedEvents SELECT audit.AuditEventId FROM dbo.AuditEvents audit
      WHERE UPPER(LTRIM(RTRIM(CONVERT(nvarchar(50),audit.EntityType)))) COLLATE Latin1_General_100_BIN2 IN (N''FLIGHT'',N''ULD'',N''OFFLOAD'')
        AND NOT EXISTS (SELECT 1 FROM #FlightScopedEvents scoped WHERE scoped.AuditEventId=audit.AuditEventId);';
    EXEC sys.sp_executesql @Sql;
  END;
  ;WITH SingleJsonFlight AS (
    SELECT AuditEventId,MIN(RawValue) RawValue,MIN(JsonType) JsonType FROM #JsonOwnershipClaims WHERE OwnershipKey='flightId'
    GROUP BY AuditEventId HAVING COUNT_BIG(*)=1
  )
  INSERT #CandidateClaims
  SELECT claim.AuditEventId,parsed.IdValue,'BACKFILL_FROM_FLIGHT',11 FROM SingleJsonFlight claim
  CROSS APPLY (VALUES(LTRIM(RTRIM(CONVERT(nvarchar(100),claim.RawValue))) COLLATE Latin1_General_100_BIN2)) normalized(IdText)
  CROSS APPLY (VALUES(TRY_CONVERT(bigint,normalized.IdText))) parsed(IdValue)
  WHERE claim.JsonType IN (1,2) AND normalized.IdText<>N'' AND LEN(normalized.IdText)<=19
    AND normalized.IdText NOT LIKE N'%[^0-9]%' COLLATE Latin1_General_100_BIN2 AND parsed.IdValue>0;

  IF @HasPhysicalUld=1
  BEGIN
    SET @Sql=N'INSERT #UldIdentityClaims SELECT audit.AuditEventId,parsed.IdValue FROM dbo.AuditEvents audit
      CROSS APPLY (VALUES(LTRIM(RTRIM(CONVERT(nvarchar(100),audit.UldId))) COLLATE Latin1_General_100_BIN2)) normalized(IdText)
      CROSS APPLY (VALUES(TRY_CONVERT(bigint,normalized.IdText))) parsed(IdValue)
      WHERE audit.UldId IS NOT NULL AND normalized.IdText<>N'''' AND LEN(normalized.IdText)<=19
        AND normalized.IdText NOT LIKE N''%[^0-9]%'' COLLATE Latin1_General_100_BIN2 AND parsed.IdValue>0;';
    EXEC sys.sp_executesql @Sql;
    SET @Sql=N'INSERT #FlightScopedEvents SELECT audit.AuditEventId FROM dbo.AuditEvents audit WHERE audit.UldId IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM #FlightScopedEvents scoped WHERE scoped.AuditEventId=audit.AuditEventId);';
    EXEC sys.sp_executesql @Sql;
  END;
  IF @HasEntity=1
  BEGIN
    SET @Sql=N'INSERT #UldIdentityClaims SELECT audit.AuditEventId,parsed.IdValue FROM dbo.AuditEvents audit
      CROSS APPLY (VALUES(LTRIM(RTRIM(CONVERT(nvarchar(100),audit.EntityId))) COLLATE Latin1_General_100_BIN2)) normalized(IdText)
      CROSS APPLY (VALUES(TRY_CONVERT(bigint,normalized.IdText))) parsed(IdValue)
      WHERE UPPER(LTRIM(RTRIM(CONVERT(nvarchar(50),audit.EntityType)))) COLLATE Latin1_General_100_BIN2=N''ULD''
        AND normalized.IdText<>N'''' AND LEN(normalized.IdText)<=19
        AND normalized.IdText NOT LIKE N''%[^0-9]%'' COLLATE Latin1_General_100_BIN2 AND parsed.IdValue>0;';
    EXEC sys.sp_executesql @Sql;
  END;
  ;WITH SingleJsonUld AS (
    SELECT AuditEventId,MIN(RawValue) RawValue,MIN(JsonType) JsonType FROM #JsonOwnershipClaims WHERE OwnershipKey='uldId'
    GROUP BY AuditEventId HAVING COUNT_BIG(*)=1
  )
  INSERT #UldIdentityClaims
  SELECT claim.AuditEventId,parsed.IdValue FROM SingleJsonUld claim
  CROSS APPLY (VALUES(LTRIM(RTRIM(CONVERT(nvarchar(100),claim.RawValue))) COLLATE Latin1_General_100_BIN2)) normalized(IdText)
  CROSS APPLY (VALUES(TRY_CONVERT(bigint,normalized.IdText))) parsed(IdValue)
  WHERE claim.JsonType IN (1,2) AND normalized.IdText<>N'' AND LEN(normalized.IdText)<=19
    AND normalized.IdText NOT LIKE N'%[^0-9]%' COLLATE Latin1_General_100_BIN2 AND parsed.IdValue>0;

  IF @HasPhysicalOffload=1
  BEGIN
    SET @Sql=N'INSERT #OffloadIdentityClaims SELECT audit.AuditEventId,parsed.IdValue FROM dbo.AuditEvents audit
      CROSS APPLY (VALUES(LTRIM(RTRIM(CONVERT(nvarchar(100),audit.OffloadId))) COLLATE Latin1_General_100_BIN2)) normalized(IdText)
      CROSS APPLY (VALUES(TRY_CONVERT(bigint,normalized.IdText))) parsed(IdValue)
      WHERE audit.OffloadId IS NOT NULL AND normalized.IdText<>N'''' AND LEN(normalized.IdText)<=19
        AND normalized.IdText NOT LIKE N''%[^0-9]%'' COLLATE Latin1_General_100_BIN2 AND parsed.IdValue>0;';
    EXEC sys.sp_executesql @Sql;
    SET @Sql=N'INSERT #FlightScopedEvents SELECT audit.AuditEventId FROM dbo.AuditEvents audit WHERE audit.OffloadId IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM #FlightScopedEvents scoped WHERE scoped.AuditEventId=audit.AuditEventId);';
    EXEC sys.sp_executesql @Sql;
  END;
  IF @HasEntity=1
  BEGIN
    SET @Sql=N'INSERT #OffloadIdentityClaims SELECT audit.AuditEventId,parsed.IdValue FROM dbo.AuditEvents audit
      CROSS APPLY (VALUES(LTRIM(RTRIM(CONVERT(nvarchar(100),audit.EntityId))) COLLATE Latin1_General_100_BIN2)) normalized(IdText)
      CROSS APPLY (VALUES(TRY_CONVERT(bigint,normalized.IdText))) parsed(IdValue)
      WHERE UPPER(LTRIM(RTRIM(CONVERT(nvarchar(50),audit.EntityType)))) COLLATE Latin1_General_100_BIN2=N''OFFLOAD''
        AND normalized.IdText<>N'''' AND LEN(normalized.IdText)<=19
        AND normalized.IdText NOT LIKE N''%[^0-9]%'' COLLATE Latin1_General_100_BIN2 AND parsed.IdValue>0;';
    EXEC sys.sp_executesql @Sql;
  END;
  ;WITH SingleJsonOffload AS (
    SELECT AuditEventId,MIN(RawValue) RawValue,MIN(JsonType) JsonType FROM #JsonOwnershipClaims WHERE OwnershipKey='offloadId'
    GROUP BY AuditEventId HAVING COUNT_BIG(*)=1
  )
  INSERT #OffloadIdentityClaims
  SELECT claim.AuditEventId,parsed.IdValue FROM SingleJsonOffload claim
  CROSS APPLY (VALUES(LTRIM(RTRIM(CONVERT(nvarchar(100),claim.RawValue))) COLLATE Latin1_General_100_BIN2)) normalized(IdText)
  CROSS APPLY (VALUES(TRY_CONVERT(bigint,normalized.IdText))) parsed(IdValue)
  WHERE claim.JsonType IN (1,2) AND normalized.IdText<>N'' AND LEN(normalized.IdText)<=19
    AND normalized.IdText NOT LIKE N'%[^0-9]%' COLLATE Latin1_General_100_BIN2 AND parsed.IdValue>0;

  INSERT #FlightScopedEvents SELECT jsonClaim.AuditEventId FROM #JsonOwnershipClaims jsonClaim
  WHERE NOT EXISTS (SELECT 1 FROM #FlightScopedEvents scoped WHERE scoped.AuditEventId=jsonClaim.AuditEventId)
  GROUP BY jsonClaim.AuditEventId;

  SET @Sql=N'SELECT @Count=COUNT_BIG(*) FROM (SELECT UldId FROM dbo.ULDs WHERE UldId IS NOT NULL GROUP BY UldId HAVING COUNT_BIG(*)>1) duplicateIdentity;';
  EXEC sys.sp_executesql @Sql,N'@Count bigint OUTPUT',@Count=@DuplicateUldIdentity OUTPUT;
  SET @Sql=N'SELECT @Count=COUNT_BIG(*) FROM (SELECT OffloadId FROM dbo.Offloads WHERE OffloadId IS NOT NULL GROUP BY OffloadId HAVING COUNT_BIG(*)>1) duplicateIdentity;';
  EXEC sys.sp_executesql @Sql,N'@Count bigint OUTPUT',@Count=@DuplicateOffloadIdentity OUTPUT;
  SET @Sql=N';WITH ExactUld AS (SELECT UldId,MIN(FlightId) FlightId FROM dbo.ULDs WHERE UldId IS NOT NULL
      GROUP BY UldId HAVING COUNT_BIG(*)=1 AND MIN(FlightId) IS NOT NULL)
    INSERT #CandidateClaims SELECT claim.AuditEventId,uld.FlightId,''BACKFILL_FROM_ULD'',20
    FROM #UldIdentityClaims claim JOIN ExactUld uld ON uld.UldId=claim.UldId;';
  EXEC sys.sp_executesql @Sql;
  SET @Sql=N';WITH ExactOffload AS (SELECT OffloadId,MIN(FlightId) FlightId FROM dbo.Offloads WHERE OffloadId IS NOT NULL
      GROUP BY OffloadId HAVING COUNT_BIG(*)=1 AND MIN(FlightId) IS NOT NULL)
    INSERT #CandidateClaims SELECT claim.AuditEventId,offload.FlightId,''BACKFILL_FROM_OFFLOAD'',30
    FROM #OffloadIdentityClaims claim JOIN ExactOffload offload ON offload.OffloadId=claim.OffloadId;';
  EXEC sys.sp_executesql @Sql;
  SET @Sql=N'SELECT @Count=COUNT_BIG(*) FROM (SELECT DISTINCT claim.AuditEventId FROM #CandidateClaims claim
      LEFT JOIN dbo.Flights flight ON flight.FlightId=claim.CandidateFlightId WHERE flight.FlightId IS NULL) invalidReference;';
  EXEC sys.sp_executesql @Sql,N'@Count bigint OUTPUT',@Count=@InvalidCandidateReference OUTPUT;
  SELECT @Ambiguous=COUNT_BIG(*) FROM (SELECT AuditEventId FROM #CandidateClaims GROUP BY AuditEventId
    HAVING COUNT(DISTINCT CandidateFlightId)>1) conflicts;
  SET @Sql=N';WITH SafeOwnership AS (
      SELECT claim.AuditEventId,MIN(claim.CandidateFlightId) FlightId FROM #CandidateClaims claim
      WHERE NOT EXISTS (SELECT 1 FROM #CandidateClaims checked LEFT JOIN dbo.Flights flight
        ON flight.FlightId=checked.CandidateFlightId WHERE checked.AuditEventId=claim.AuditEventId AND flight.FlightId IS NULL)
      GROUP BY claim.AuditEventId HAVING COUNT(DISTINCT claim.CandidateFlightId)=1)
    INSERT #Resolved
    SELECT ownership.AuditEventId,ownership.FlightId,chosen.EvidenceType,chosen.EvidencePriority FROM SafeOwnership ownership
    CROSS APPLY (SELECT TOP (1) claim.EvidenceType,claim.EvidencePriority FROM #CandidateClaims claim
      WHERE claim.AuditEventId=ownership.AuditEventId AND claim.CandidateFlightId=ownership.FlightId
      ORDER BY claim.EvidencePriority,claim.EvidenceType) chosen;';
  EXEC sys.sp_executesql @Sql;
END;
-- CANONICAL AUDIT OWNERSHIP CANDIDATE MODEL END

  IF @DuplicateJsonOwnership>0 THROW 51609,'Duplicate DetailsJson ownership keys require operator review.',1;
  IF @DuplicateUldIdentity>0 THROW 51610,'ULDs contains duplicate UldId identities.',1;
  IF @DuplicateOffloadIdentity>0 THROW 51611,'Offloads contains duplicate OffloadId identities.',1;
  IF @InvalidCandidateReference>0 THROW 51612,'An exact ownership candidate references a missing Flight.',1;
  IF @Ambiguous>0 THROW 51613,'AuditEvents contains contradictory exact Flight ownership evidence; no ownership was changed.',1;

  DECLARE @Total bigint=(SELECT COUNT_BIG(*) FROM dbo.AuditEvents);
  DECLARE @AlreadyOwned bigint=(SELECT COUNT_BIG(*) FROM dbo.AuditEvents WHERE FlightId IS NOT NULL);
  CREATE TABLE #Backfilled(AuditEventId bigint NOT NULL,FlightId bigint NOT NULL,EvidenceType varchar(40) NOT NULL);
  UPDATE audit SET FlightId=resolved.FlightId
    OUTPUT inserted.AuditEventId,inserted.FlightId,resolved.EvidenceType INTO #Backfilled
  FROM dbo.AuditEvents audit JOIN #Resolved resolved ON resolved.AuditEventId=audit.AuditEventId
  WHERE audit.FlightId IS NULL;

  IF EXISTS (SELECT 1 FROM dbo.AuditEvents audit LEFT JOIN dbo.Flights flight ON flight.FlightId=audit.FlightId
    WHERE audit.FlightId IS NOT NULL AND flight.FlightId IS NULL)
    THROW 51614,'AuditEvents Flight ownership validation failed after backfill.',1;

  DECLARE @TouchingFkCount int=0,@CompatibleFkCount int=0,@IntendedFkNameConflict bit=0;
  SELECT @TouchingFkCount=COUNT(DISTINCT fk.object_id) FROM sys.foreign_keys fk JOIN sys.foreign_key_columns link ON link.constraint_object_id=fk.object_id
  WHERE fk.parent_object_id=@AuditObjectId AND COL_NAME(link.parent_object_id,link.parent_column_id)=N'FlightId';
  SELECT @CompatibleFkCount=COUNT(*) FROM sys.foreign_keys fk WHERE fk.parent_object_id=@AuditObjectId AND fk.referenced_object_id=@FlightObjectId
    AND fk.is_disabled=0 AND fk.is_not_trusted=0 AND fk.delete_referential_action=0 AND fk.update_referential_action=0
    AND (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns links WHERE links.constraint_object_id=fk.object_id)=1
    AND EXISTS (SELECT 1 FROM sys.foreign_key_columns link WHERE link.constraint_object_id=fk.object_id
      AND COL_NAME(link.parent_object_id,link.parent_column_id)=N'FlightId' AND COL_NAME(link.referenced_object_id,link.referenced_column_id)=N'FlightId');
  SET @IntendedFkNameConflict=CASE WHEN OBJECT_ID(N'dbo.FK_AuditEvents_Flights_FlightId',N'F') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys fk WHERE fk.object_id=OBJECT_ID(N'dbo.FK_AuditEvents_Flights_FlightId',N'F')
      AND fk.parent_object_id=@AuditObjectId AND fk.referenced_object_id=@FlightObjectId AND fk.is_disabled=0 AND fk.is_not_trusted=0
      AND fk.delete_referential_action=0 AND fk.update_referential_action=0
      AND (SELECT COUNT_BIG(*) FROM sys.foreign_key_columns links WHERE links.constraint_object_id=fk.object_id)=1
      AND EXISTS (SELECT 1 FROM sys.foreign_key_columns link WHERE link.constraint_object_id=fk.object_id
        AND COL_NAME(link.parent_object_id,link.parent_column_id)=N'FlightId' AND COL_NAME(link.referenced_object_id,link.referenced_column_id)=N'FlightId')) THEN 1 ELSE 0 END;
  IF @IntendedFkNameConflict=1 OR @CompatibleFkCount>1 OR @TouchingFkCount<>@CompatibleFkCount
    THROW 51615,'AuditEvents has a conflicting, disabled, untrusted, composite, cascading, or duplicate FlightId foreign key.',1;
  IF @CompatibleFkCount=0
  BEGIN
    ALTER TABLE dbo.AuditEvents WITH CHECK ADD CONSTRAINT FK_AuditEvents_Flights_FlightId
      FOREIGN KEY(FlightId) REFERENCES dbo.Flights(FlightId);
    ALTER TABLE dbo.AuditEvents CHECK CONSTRAINT FK_AuditEvents_Flights_FlightId;
  END;

  DECLARE @IndexReady bit=CASE WHEN EXISTS (
    SELECT 1 FROM sys.indexes i WHERE i.object_id=@AuditObjectId AND i.is_disabled=0 AND i.is_hypothetical=0 AND i.has_filter=0
      AND EXISTS (SELECT 1 FROM sys.index_columns k JOIN sys.columns c ON c.object_id=k.object_id AND c.column_id=k.column_id
        WHERE k.object_id=i.object_id AND k.index_id=i.index_id AND k.key_ordinal=1 AND c.name=N'FlightId')
      AND EXISTS (SELECT 1 FROM sys.index_columns k JOIN sys.columns c ON c.object_id=k.object_id AND c.column_id=k.column_id
        WHERE k.object_id=i.object_id AND k.index_id=i.index_id AND k.key_ordinal=2 AND c.name=N'OccurredAtUtc')
  ) THEN 1 ELSE 0 END;
  DECLARE @NamedIndexConflict bit=CASE WHEN EXISTS (
    SELECT 1 FROM sys.indexes i WHERE i.object_id=@AuditObjectId AND i.name=N'IX_AuditEvents_Flight_OccurredAtUtc'
      AND NOT (i.is_disabled=0 AND i.is_hypothetical=0 AND i.has_filter=0
        AND EXISTS (SELECT 1 FROM sys.index_columns k JOIN sys.columns c ON c.object_id=k.object_id AND c.column_id=k.column_id
          WHERE k.object_id=i.object_id AND k.index_id=i.index_id AND k.key_ordinal=1 AND c.name=N'FlightId')
        AND EXISTS (SELECT 1 FROM sys.index_columns k JOIN sys.columns c ON c.object_id=k.object_id AND c.column_id=k.column_id
          WHERE k.object_id=i.object_id AND k.index_id=i.index_id AND k.key_ordinal=2 AND c.name=N'OccurredAtUtc'))
  ) THEN 1 ELSE 0 END;
  IF @NamedIndexConflict=1 THROW 51616,'IX_AuditEvents_Flight_OccurredAtUtc exists with an incompatible definition.',1;
  IF @IndexReady=0 CREATE INDEX IX_AuditEvents_Flight_OccurredAtUtc ON dbo.AuditEvents(FlightId,OccurredAtUtc DESC);

  DECLARE @RemainingGlobal bigint=0,@RemainingUnprovable bigint=0,@LegacyOrphanOffloadCount bigint=0;
  SELECT @RemainingGlobal=SUM(CASE WHEN audit.FlightId IS NULL AND scoped.AuditEventId IS NULL THEN CONVERT(bigint,1) ELSE CONVERT(bigint,0) END),
    @RemainingUnprovable=SUM(CASE WHEN audit.FlightId IS NULL AND scoped.AuditEventId IS NOT NULL THEN CONVERT(bigint,1) ELSE CONVERT(bigint,0) END)
  FROM dbo.AuditEvents audit LEFT JOIN #FlightScopedEvents scoped ON scoped.AuditEventId=audit.AuditEventId;
  SELECT @LegacyOrphanOffloadCount=COUNT_BIG(*) FROM (SELECT DISTINCT claim.AuditEventId FROM #OffloadIdentityClaims claim
    JOIN dbo.Offloads offload ON offload.OffloadId=claim.OffloadId WHERE offload.FlightId IS NULL) orphanClaim;
  SET @RemainingGlobal=COALESCE(@RemainingGlobal,0); SET @RemainingUnprovable=COALESCE(@RemainingUnprovable,0);

  COMMIT TRANSACTION;

  -- Success is emitted only after COMMIT completes.
  SELECT CHECK_NAME,RESULT,SEVERITY FROM (VALUES
    (N'TOTAL_AUDIT_EVENTS',CONVERT(nvarchar(100),@Total),N'INFO'),
    (N'ALREADY_OWNED',CONVERT(nvarchar(100),@AlreadyOwned),N'INFO'),
    (N'BACKFILL_FROM_FLIGHT',CONVERT(nvarchar(100),(SELECT COUNT_BIG(*) FROM #Backfilled WHERE EvidenceType='BACKFILL_FROM_FLIGHT')),N'INFO'),
    (N'BACKFILL_FROM_ULD',CONVERT(nvarchar(100),(SELECT COUNT_BIG(*) FROM #Backfilled WHERE EvidenceType='BACKFILL_FROM_ULD')),N'INFO'),
    (N'BACKFILL_FROM_OFFLOAD',CONVERT(nvarchar(100),(SELECT COUNT_BIG(*) FROM #Backfilled WHERE EvidenceType='BACKFILL_FROM_OFFLOAD')),N'INFO'),
    (N'REMAINING_NULL_GLOBAL',CONVERT(nvarchar(100),@RemainingGlobal),N'INFO'),
    (N'REMAINING_NULL_UNPROVABLE',CONVERT(nvarchar(100),@RemainingUnprovable),N'INFO'),
    (N'LEGACY_ORPHAN_OFFLOAD_AUDIT',CONVERT(nvarchar(100),@LegacyOrphanOffloadCount),N'INFO'),
    (N'AMBIGUOUS',N'0',N'INFO'),(N'INVALID_REFERENCE',N'0',N'INFO'),
    (N'FINAL_DECISION',N'PROCEED',N'PROCEED')
  ) output(CHECK_NAME,RESULT,SEVERITY);
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
