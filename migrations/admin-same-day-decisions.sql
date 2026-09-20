-- Adds deterministic same-day decision ordering without rewriting historical values.
-- Run only after admin-same-day-decisions-preflight.sql returns no STOP conditions.
SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRY
  BEGIN TRANSACTION;

  DECLARE @LockResult int;
  EXEC @LockResult=sys.sp_getapplock
    @Resource=N'CargoRun:Migration:AdminSameDayDecisions',
    @LockMode='Exclusive',
    @LockOwner='Transaction',
    @LockTimeout=10000;
  IF @LockResult<0 THROW 51410,'Could not acquire the Admin same-day decision migration lock.',1;

  DECLARE @Targets table(
    TableName sysname NOT NULL PRIMARY KEY,
    UniqueConstraint sysname NOT NULL,
    DefaultConstraint sysname NOT NULL,
    CheckConstraint sysname NOT NULL,
    OldKeyColumns nvarchar(1000) NOT NULL,
    NewKeyColumns nvarchar(1000) NOT NULL
  );
  INSERT @Targets(TableName,UniqueConstraint,DefaultConstraint,CheckConstraint,OldKeyColumns,NewKeyColumns) VALUES
    (N'CargoRunAirlineProfiles',N'UQ_CargoRunAirlineProfiles_Version',N'DF_CargoRunAirlineProfiles_DecisionSequence',N'CK_CargoRunAirlineProfiles_DecisionSequence',N'AirlineId,StationScopeKey,EffectiveFrom',N'AirlineId,StationScopeKey,EffectiveFrom,DecisionSequence'),
    (N'CargoRunShcGroupVersions',N'UQ_CargoRunShcGroupVersions_Version',N'DF_CargoRunShcGroupVersions_DecisionSequence',N'CK_CargoRunShcGroupVersions_DecisionSequence',N'ShcGroupId,EffectiveFrom',N'ShcGroupId,EffectiveFrom,DecisionSequence'),
    (N'CargoRunShcGroupMappings',N'UQ_CargoRunShcGroupMappings_Version',N'DF_CargoRunShcGroupMappings_DecisionSequence',N'CK_CargoRunShcGroupMappings_DecisionSequence',N'ShcId,ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom',N'ShcId,ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence'),
    (N'CargoRunPriorityRules',N'UQ_CargoRunPriorityRules_Version',N'DF_CargoRunPriorityRules_DecisionSequence',N'CK_CargoRunPriorityRules_DecisionSequence',N'ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom',N'ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence'),
    (N'CargoRunSlaRules',N'UQ_CargoRunSlaRules_Version',N'DF_CargoRunSlaRules_DecisionSequence',N'CK_CargoRunSlaRules_DecisionSequence',N'RuleKey,AirlineScopeKey,StationScopeKey,EffectiveFrom',N'RuleKey,AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence'),
    (N'CargoRunMailRules',N'UQ_CargoRunMailRules_Version',N'DF_CargoRunMailRules_DecisionSequence',N'CK_CargoRunMailRules_DecisionSequence',N'AirlineScopeKey,StationScopeKey,EffectiveFrom',N'AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence');

  IF EXISTS (
    SELECT 1 FROM @Targets target
    WHERE OBJECT_ID(N'dbo.'+target.TableName,N'U') IS NULL
  ) THROW 51411,'One or more Admin configuration tables are missing.',1;

  DECLARE @SequenceColumnCount int=(
    SELECT COUNT(*) FROM @Targets target
    WHERE COL_LENGTH(N'dbo.'+target.TableName,N'DecisionSequence') IS NOT NULL
  );
  IF @SequenceColumnCount NOT IN (0,6)
    THROW 51412,'Partial Admin same-day decision schema detected. Stop for review.',1;

  IF @SequenceColumnCount=0
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM @Targets target
      OUTER APPLY (
        SELECT STRING_AGG(CONVERT(nvarchar(max),columnObject.name),N',')
          WITHIN GROUP (ORDER BY indexColumn.key_ordinal) AS KeyColumns
        FROM sys.key_constraints constraintObject
        JOIN sys.index_columns indexColumn
          ON indexColumn.object_id=constraintObject.parent_object_id
         AND indexColumn.index_id=constraintObject.unique_index_id
         AND indexColumn.key_ordinal>0
        JOIN sys.columns columnObject
          ON columnObject.object_id=indexColumn.object_id
         AND columnObject.column_id=indexColumn.column_id
        WHERE constraintObject.parent_object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
          AND constraintObject.name=target.UniqueConstraint
          AND constraintObject.type='UQ'
      ) definition
      WHERE definition.KeyColumns IS NULL OR definition.KeyColumns<>target.OldKeyColumns
    ) THROW 51413,'An Admin configuration unique constraint has an unexpected pre-migration definition.',1;

    IF EXISTS (
      SELECT 1
      FROM sys.foreign_keys foreignKey
      JOIN sys.tables referencedTable ON referencedTable.object_id=foreignKey.referenced_object_id
      JOIN sys.indexes indexObject
        ON indexObject.object_id=foreignKey.referenced_object_id
       AND indexObject.index_id=foreignKey.key_index_id
      JOIN @Targets target
        ON target.TableName=referencedTable.name
       AND target.UniqueConstraint=indexObject.name
    ) THROW 51414,'A foreign key depends on an Admin configuration unique constraint that must be replaced.',1;

    DECLARE @TableName sysname,@UniqueConstraint sysname,@DefaultConstraint sysname,
      @CheckConstraint sysname,@NewKeyColumns nvarchar(1000),@Sql nvarchar(max);
    DECLARE target_cursor CURSOR LOCAL FAST_FORWARD FOR
      SELECT TableName,UniqueConstraint,DefaultConstraint,CheckConstraint,NewKeyColumns
      FROM @Targets ORDER BY TableName;

    OPEN target_cursor;
    FETCH NEXT FROM target_cursor INTO @TableName,@UniqueConstraint,@DefaultConstraint,@CheckConstraint,@NewKeyColumns;
    WHILE @@FETCH_STATUS=0
    BEGIN
      -- Each statement is compiled only when executed. The replacement constraint
      -- therefore cannot bind DecisionSequence before the preceding ADD is visible.
      SET @Sql=N'ALTER TABLE dbo.'+QUOTENAME(@TableName)
        +N' ADD DecisionSequence int NOT NULL CONSTRAINT '+QUOTENAME(@DefaultConstraint)
        +N' DEFAULT(1) WITH VALUES;';
      EXEC sys.sp_executesql @Sql;

      SET @Sql=N'ALTER TABLE dbo.'+QUOTENAME(@TableName)
        +N' DROP CONSTRAINT '+QUOTENAME(@UniqueConstraint)+N';';
      EXEC sys.sp_executesql @Sql;

      SET @Sql=N'ALTER TABLE dbo.'+QUOTENAME(@TableName)
        +N' ADD CONSTRAINT '+QUOTENAME(@UniqueConstraint)
        +N' UNIQUE('+@NewKeyColumns+N');';
      EXEC sys.sp_executesql @Sql;

      SET @Sql=N'ALTER TABLE dbo.'+QUOTENAME(@TableName)
        +N' WITH CHECK ADD CONSTRAINT '+QUOTENAME(@CheckConstraint)
        +N' CHECK(DecisionSequence>=1);';
      EXEC sys.sp_executesql @Sql;

      FETCH NEXT FROM target_cursor INTO @TableName,@UniqueConstraint,@DefaultConstraint,@CheckConstraint,@NewKeyColumns;
    END;
    CLOSE target_cursor;
    DEALLOCATE target_cursor;
  END;

  -- Fail closed on a rerun or after the additive work if the final shape differs.
  IF EXISTS (
    SELECT 1
    FROM @Targets target
    LEFT JOIN sys.columns columnObject
      ON columnObject.object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
     AND columnObject.name=N'DecisionSequence'
    OUTER APPLY (
      SELECT STRING_AGG(CONVERT(nvarchar(max),keyColumn.name),N',')
        WITHIN GROUP (ORDER BY indexColumn.key_ordinal) AS KeyColumns
      FROM sys.key_constraints constraintObject
      JOIN sys.index_columns indexColumn
        ON indexColumn.object_id=constraintObject.parent_object_id
       AND indexColumn.index_id=constraintObject.unique_index_id
       AND indexColumn.key_ordinal>0
      JOIN sys.columns keyColumn
        ON keyColumn.object_id=indexColumn.object_id
       AND keyColumn.column_id=indexColumn.column_id
      WHERE constraintObject.parent_object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
        AND constraintObject.name=target.UniqueConstraint
        AND constraintObject.type='UQ'
    ) definition
    WHERE columnObject.column_id IS NULL
       OR TYPE_NAME(columnObject.user_type_id)<>N'int'
       OR columnObject.is_nullable<>0
       OR definition.KeyColumns IS NULL
       OR definition.KeyColumns<>target.NewKeyColumns
       OR NOT EXISTS (
         SELECT 1 FROM sys.default_constraints defaultObject
         WHERE defaultObject.parent_object_id=columnObject.object_id
           AND defaultObject.parent_column_id=columnObject.column_id
           AND defaultObject.name=target.DefaultConstraint
           AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(defaultObject.definition,N'(',N''),N')',N''),N'[',N''),N']',N''),N' ',N'')=N'1'
       )
       OR NOT EXISTS (
         SELECT 1 FROM sys.check_constraints checkObject
         WHERE checkObject.parent_object_id=columnObject.object_id
           AND checkObject.name=target.CheckConstraint
           AND checkObject.is_disabled=0 AND checkObject.is_not_trusted=0
           AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(checkObject.definition,N'(',N''),N')',N''),N'[',N''),N']',N''),N' ',N'')=N'DecisionSequence>=1'
       )
  ) THROW 51415,'The Admin same-day decision schema does not match the expected final definition.',1;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
