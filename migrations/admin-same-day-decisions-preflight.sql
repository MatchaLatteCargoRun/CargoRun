-- READ ONLY. Run before admin-same-day-decisions.sql.
SET NOCOUNT ON;

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

DECLARE @Findings table(Finding nvarchar(100) NOT NULL,Detail nvarchar(2000) NOT NULL);

INSERT @Findings
SELECT N'MISSING_TABLE',target.TableName
FROM @Targets target
WHERE OBJECT_ID(N'dbo.'+target.TableName,N'U') IS NULL;

DECLARE @ExistingTableCount int=(
  SELECT COUNT(*) FROM @Targets target WHERE OBJECT_ID(N'dbo.'+target.TableName,N'U') IS NOT NULL
);
DECLARE @SequenceColumnCount int=(
  SELECT COUNT(*) FROM @Targets target
  WHERE COL_LENGTH(N'dbo.'+target.TableName,N'DecisionSequence') IS NOT NULL
);
DECLARE @ReadySequenceColumnCount int=(
  SELECT COUNT(*)
  FROM @Targets target
  JOIN sys.columns columnObject
    ON columnObject.object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
   AND columnObject.name=N'DecisionSequence'
   AND TYPE_NAME(columnObject.user_type_id)=N'int'
   AND columnObject.is_nullable=0
);

IF @ExistingTableCount=6 AND @SequenceColumnCount NOT IN (0,6)
  INSERT @Findings VALUES(N'PARTIAL_DECISION_SEQUENCE_INSTALL',CONCAT(@SequenceColumnCount,N' of 6 tables contain DecisionSequence.'));

-- An untouched schema must have the exact original Phase B unique constraints.
INSERT @Findings
SELECT N'UNEXPECTED_PRE_MIGRATION_UNIQUENESS',CONCAT(target.TableName,N'.',target.UniqueConstraint,N' = ',COALESCE(definition.KeyColumns,N'<missing>'))
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
WHERE OBJECT_ID(N'dbo.'+target.TableName,N'U') IS NOT NULL
  AND COL_LENGTH(N'dbo.'+target.TableName,N'DecisionSequence') IS NULL
  AND (definition.KeyColumns IS NULL OR definition.KeyColumns<>target.OldKeyColumns);

-- A migrated schema must have the exact column, default, check and replacement key.
INSERT @Findings
SELECT N'INVALID_DECISION_SEQUENCE_COLUMN',target.TableName
FROM @Targets target
JOIN sys.columns columnObject
  ON columnObject.object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
 AND columnObject.name=N'DecisionSequence'
WHERE TYPE_NAME(columnObject.user_type_id)<>N'int' OR columnObject.is_nullable<>0;

INSERT @Findings
SELECT N'MISSING_SEQUENCE_DEFAULT',target.TableName
FROM @Targets target
JOIN sys.columns columnObject
  ON columnObject.object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
 AND columnObject.name=N'DecisionSequence'
WHERE NOT EXISTS (
  SELECT 1 FROM sys.default_constraints defaultObject
  WHERE defaultObject.parent_object_id=columnObject.object_id
    AND defaultObject.parent_column_id=columnObject.column_id
    AND defaultObject.name=target.DefaultConstraint
    AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(defaultObject.definition,N'(',N''),N')',N''),N'[',N''),N']',N''),N' ',N'')=N'1'
);

INSERT @Findings
SELECT N'MISSING_OR_UNTRUSTED_SEQUENCE_CHECK',target.TableName
FROM @Targets target
WHERE COL_LENGTH(N'dbo.'+target.TableName,N'DecisionSequence') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM sys.check_constraints checkObject
    WHERE checkObject.parent_object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
      AND checkObject.name=target.CheckConstraint
      AND checkObject.is_disabled=0 AND checkObject.is_not_trusted=0
      AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(checkObject.definition,N'(',N''),N')',N''),N'[',N''),N']',N''),N' ',N'')=N'DecisionSequence>=1'
  );

INSERT @Findings
SELECT N'UNEXPECTED_POST_MIGRATION_UNIQUENESS',CONCAT(target.TableName,N'.',target.UniqueConstraint,N' = ',COALESCE(definition.KeyColumns,N'<missing>'))
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
WHERE COL_LENGTH(N'dbo.'+target.TableName,N'DecisionSequence') IS NOT NULL
  AND (definition.KeyColumns IS NULL OR definition.KeyColumns<>target.NewKeyColumns);

-- The obsolete logical/scope/date-only uniqueness must not survive migration.
INSERT @Findings
SELECT N'OBSOLETE_SAME_DAY_UNIQUENESS',CONCAT(target.TableName,N'.',oldIndex.name)
FROM @Targets target
CROSS APPLY (
  SELECT indexObject.name,
    STRING_AGG(CONVERT(nvarchar(max),columnObject.name),N',')
      WITHIN GROUP (ORDER BY indexColumn.key_ordinal) AS KeyColumns
  FROM sys.indexes indexObject
  JOIN sys.index_columns indexColumn
    ON indexColumn.object_id=indexObject.object_id
   AND indexColumn.index_id=indexObject.index_id
   AND indexColumn.key_ordinal>0
  JOIN sys.columns columnObject
    ON columnObject.object_id=indexColumn.object_id
   AND columnObject.column_id=indexColumn.column_id
  WHERE indexObject.object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
    AND indexObject.is_unique=1
  GROUP BY indexObject.name,indexObject.index_id
) oldIndex
WHERE COL_LENGTH(N'dbo.'+target.TableName,N'DecisionSequence') IS NOT NULL
  AND oldIndex.KeyColumns=target.OldKeyColumns;

-- Dropping an expected pre-migration key is forbidden if a foreign key uses it.
INSERT @Findings
SELECT N'UNIQUE_CONSTRAINT_REFERENCED_BY_FOREIGN_KEY',
  CONCAT(referencingTable.name,N'.',foreignKey.name,N' -> ',referencedTable.name,N'.',indexObject.name)
FROM sys.foreign_keys foreignKey
JOIN sys.tables referencingTable ON referencingTable.object_id=foreignKey.parent_object_id
JOIN sys.tables referencedTable ON referencedTable.object_id=foreignKey.referenced_object_id
JOIN sys.indexes indexObject
  ON indexObject.object_id=foreignKey.referenced_object_id
 AND indexObject.index_id=foreignKey.key_index_id
JOIN @Targets target
  ON target.TableName=referencedTable.name
 AND target.UniqueConstraint=indexObject.name
WHERE COL_LENGTH(N'dbo.'+target.TableName,N'DecisionSequence') IS NULL;

-- Table data is inspected in a deferred compilation unit so a missing table or
-- missing DecisionSequence column is reported as a STOP finding, not a batch error.
IF @ExistingTableCount=6
BEGIN
  DECLARE @ValidationSql nvarchar(max)=N'
    SELECT N''INVALID_EFFECTIVE_PERIOD'',CONCAT(N''CargoRunAirlineProfiles:'',ProfileVersionId) FROM dbo.CargoRunAirlineProfiles WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
    UNION ALL SELECT N''INVALID_EFFECTIVE_PERIOD'',CONCAT(N''CargoRunShcGroupVersions:'',GroupVersionId) FROM dbo.CargoRunShcGroupVersions WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
    UNION ALL SELECT N''INVALID_EFFECTIVE_PERIOD'',CONCAT(N''CargoRunShcGroupMappings:'',MappingId) FROM dbo.CargoRunShcGroupMappings WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
    UNION ALL SELECT N''INVALID_EFFECTIVE_PERIOD'',CONCAT(N''CargoRunPriorityRules:'',PriorityRuleId) FROM dbo.CargoRunPriorityRules WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
    UNION ALL SELECT N''INVALID_EFFECTIVE_PERIOD'',CONCAT(N''CargoRunSlaRules:'',SlaRuleId) FROM dbo.CargoRunSlaRules WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
    UNION ALL SELECT N''INVALID_EFFECTIVE_PERIOD'',CONCAT(N''CargoRunMailRules:'',MailRuleId) FROM dbo.CargoRunMailRules WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom';
  IF @ReadySequenceColumnCount=6 SET @ValidationSql+=N'
    UNION ALL SELECT N''INVALID_DECISION_SEQUENCE'',CONCAT(N''CargoRunAirlineProfiles:'',ProfileVersionId) FROM dbo.CargoRunAirlineProfiles WHERE DecisionSequence<1
    UNION ALL SELECT N''INVALID_DECISION_SEQUENCE'',CONCAT(N''CargoRunShcGroupVersions:'',GroupVersionId) FROM dbo.CargoRunShcGroupVersions WHERE DecisionSequence<1
    UNION ALL SELECT N''INVALID_DECISION_SEQUENCE'',CONCAT(N''CargoRunShcGroupMappings:'',MappingId) FROM dbo.CargoRunShcGroupMappings WHERE DecisionSequence<1
    UNION ALL SELECT N''INVALID_DECISION_SEQUENCE'',CONCAT(N''CargoRunPriorityRules:'',PriorityRuleId) FROM dbo.CargoRunPriorityRules WHERE DecisionSequence<1
    UNION ALL SELECT N''INVALID_DECISION_SEQUENCE'',CONCAT(N''CargoRunSlaRules:'',SlaRuleId) FROM dbo.CargoRunSlaRules WHERE DecisionSequence<1
    UNION ALL SELECT N''INVALID_DECISION_SEQUENCE'',CONCAT(N''CargoRunMailRules:'',MailRuleId) FROM dbo.CargoRunMailRules WHERE DecisionSequence<1
    UNION ALL SELECT N''DUPLICATE_DECISION_SEQUENCE'',CONCAT(N''CargoRunAirlineProfiles:'',AirlineId,N'':'',StationScopeKey,N'':'',EffectiveFrom,N'':'',DecisionSequence) FROM dbo.CargoRunAirlineProfiles GROUP BY AirlineId,StationScopeKey,EffectiveFrom,DecisionSequence HAVING COUNT_BIG(*)>1
    UNION ALL SELECT N''DUPLICATE_DECISION_SEQUENCE'',CONCAT(N''CargoRunShcGroupVersions:'',ShcGroupId,N'':'',EffectiveFrom,N'':'',DecisionSequence) FROM dbo.CargoRunShcGroupVersions GROUP BY ShcGroupId,EffectiveFrom,DecisionSequence HAVING COUNT_BIG(*)>1
    UNION ALL SELECT N''DUPLICATE_DECISION_SEQUENCE'',CONCAT(N''CargoRunShcGroupMappings:'',ShcId,N'':'',ShcGroupId,N'':'',AirlineScopeKey,N'':'',StationScopeKey,N'':'',EffectiveFrom,N'':'',DecisionSequence) FROM dbo.CargoRunShcGroupMappings GROUP BY ShcId,ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence HAVING COUNT_BIG(*)>1
    UNION ALL SELECT N''DUPLICATE_DECISION_SEQUENCE'',CONCAT(N''CargoRunPriorityRules:'',ShcGroupId,N'':'',AirlineScopeKey,N'':'',StationScopeKey,N'':'',EffectiveFrom,N'':'',DecisionSequence) FROM dbo.CargoRunPriorityRules GROUP BY ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence HAVING COUNT_BIG(*)>1
    UNION ALL SELECT N''DUPLICATE_DECISION_SEQUENCE'',CONCAT(N''CargoRunSlaRules:'',RuleKey,N'':'',AirlineScopeKey,N'':'',StationScopeKey,N'':'',EffectiveFrom,N'':'',DecisionSequence) FROM dbo.CargoRunSlaRules GROUP BY RuleKey,AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence HAVING COUNT_BIG(*)>1
    UNION ALL SELECT N''DUPLICATE_DECISION_SEQUENCE'',CONCAT(N''CargoRunMailRules:'',AirlineScopeKey,N'':'',StationScopeKey,N'':'',EffectiveFrom,N'':'',DecisionSequence) FROM dbo.CargoRunMailRules GROUP BY AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence HAVING COUNT_BIG(*)>1';
  SET @ValidationSql+=N';';
  INSERT @Findings(Finding,Detail) EXEC sys.sp_executesql @ValidationSql;
END;

SELECT target.TableName,
  CASE WHEN tableObject.object_id IS NULL THEN 0 ELSE 1 END AS TableExists,
  CASE WHEN sequenceColumn.column_id IS NULL THEN 0 ELSE 1 END AS DecisionSequenceExists,
  TYPE_NAME(sequenceColumn.user_type_id) AS DecisionSequenceType,
  sequenceColumn.is_nullable AS DecisionSequenceNullable,
  definition.KeyColumns AS CurrentUniqueKey
FROM @Targets target
LEFT JOIN sys.tables tableObject
  ON tableObject.schema_id=SCHEMA_ID(N'dbo') AND tableObject.name=target.TableName
LEFT JOIN sys.columns sequenceColumn
  ON sequenceColumn.object_id=tableObject.object_id AND sequenceColumn.name=N'DecisionSequence'
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
  WHERE constraintObject.parent_object_id=tableObject.object_id
    AND constraintObject.name=target.UniqueConstraint
    AND constraintObject.type='UQ'
) definition
ORDER BY target.TableName;

SELECT CASE
  WHEN @ExistingTableCount<>6 OR @SequenceColumnCount NOT IN (0,6) OR EXISTS(SELECT 1 FROM @Findings)
    THEN N'PARTIAL_OR_INCOMPATIBLE'
  WHEN @SequenceColumnCount=0 THEN N'CLEAN_PRE_MIGRATION'
  ELSE N'CLEAN_MIGRATED'
END AS SchemaState;

-- Every row below is a STOP condition. A clean pre-migration or migrated schema returns none.
SELECT Finding,Detail FROM @Findings ORDER BY Finding,Detail;
