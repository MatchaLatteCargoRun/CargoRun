-- READ ONLY. Run after admin-same-day-decisions.sql.
SET NOCOUNT ON;

DECLARE @Targets table(
  TableName sysname NOT NULL PRIMARY KEY,
  IdentityColumn sysname NOT NULL,
  UniqueConstraint sysname NOT NULL,
  DefaultConstraint sysname NOT NULL,
  CheckConstraint sysname NOT NULL,
  OldKeyColumns nvarchar(1000) NOT NULL,
  NewKeyColumns nvarchar(1000) NOT NULL
);
INSERT @Targets(TableName,IdentityColumn,UniqueConstraint,DefaultConstraint,CheckConstraint,OldKeyColumns,NewKeyColumns) VALUES
  (N'CargoRunAirlineProfiles',N'ProfileVersionId',N'UQ_CargoRunAirlineProfiles_Version',N'DF_CargoRunAirlineProfiles_DecisionSequence',N'CK_CargoRunAirlineProfiles_DecisionSequence',N'AirlineId,StationScopeKey,EffectiveFrom',N'AirlineId,StationScopeKey,EffectiveFrom,DecisionSequence'),
  (N'CargoRunShcGroupVersions',N'GroupVersionId',N'UQ_CargoRunShcGroupVersions_Version',N'DF_CargoRunShcGroupVersions_DecisionSequence',N'CK_CargoRunShcGroupVersions_DecisionSequence',N'ShcGroupId,EffectiveFrom',N'ShcGroupId,EffectiveFrom,DecisionSequence'),
  (N'CargoRunShcGroupMappings',N'MappingId',N'UQ_CargoRunShcGroupMappings_Version',N'DF_CargoRunShcGroupMappings_DecisionSequence',N'CK_CargoRunShcGroupMappings_DecisionSequence',N'ShcId,ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom',N'ShcId,ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence'),
  (N'CargoRunPriorityRules',N'PriorityRuleId',N'UQ_CargoRunPriorityRules_Version',N'DF_CargoRunPriorityRules_DecisionSequence',N'CK_CargoRunPriorityRules_DecisionSequence',N'ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom',N'ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence'),
  (N'CargoRunSlaRules',N'SlaRuleId',N'UQ_CargoRunSlaRules_Version',N'DF_CargoRunSlaRules_DecisionSequence',N'CK_CargoRunSlaRules_DecisionSequence',N'RuleKey,AirlineScopeKey,StationScopeKey,EffectiveFrom',N'RuleKey,AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence'),
  (N'CargoRunMailRules',N'MailRuleId',N'UQ_CargoRunMailRules_Version',N'DF_CargoRunMailRules_DecisionSequence',N'CK_CargoRunMailRules_DecisionSequence',N'AirlineScopeKey,StationScopeKey,EffectiveFrom',N'AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence');

DECLARE @Findings table(Finding nvarchar(100) NOT NULL,Detail nvarchar(2000) NOT NULL);

INSERT @Findings
SELECT N'MISSING_TABLE',target.TableName
FROM @Targets target
WHERE OBJECT_ID(N'dbo.'+target.TableName,N'U') IS NULL;

INSERT @Findings
SELECT N'MISSING_OR_INVALID_SEQUENCE_COLUMN',target.TableName
FROM @Targets target
LEFT JOIN sys.columns columnObject
  ON columnObject.object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
 AND columnObject.name=N'DecisionSequence'
WHERE columnObject.column_id IS NULL
   OR TYPE_NAME(columnObject.user_type_id)<>N'int'
   OR columnObject.is_nullable<>0;

INSERT @Findings
SELECT N'MISSING_SEQUENCE_DEFAULT',target.TableName
FROM @Targets target
LEFT JOIN sys.columns columnObject
  ON columnObject.object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
 AND columnObject.name=N'DecisionSequence'
WHERE columnObject.column_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM sys.default_constraints defaultObject
  WHERE defaultObject.parent_object_id=columnObject.object_id
    AND defaultObject.parent_column_id=columnObject.column_id
    AND defaultObject.name=target.DefaultConstraint
    AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(defaultObject.definition,N'(',N''),N')',N''),N'[',N''),N']',N''),N' ',N'')=N'1'
);

INSERT @Findings
SELECT N'MISSING_OR_UNTRUSTED_SEQUENCE_CHECK',target.TableName
FROM @Targets target
WHERE NOT EXISTS (
  SELECT 1 FROM sys.check_constraints checkObject
  WHERE checkObject.parent_object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
    AND checkObject.name=target.CheckConstraint
    AND checkObject.is_disabled=0 AND checkObject.is_not_trusted=0
    AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(checkObject.definition,N'(',N''),N')',N''),N'[',N''),N']',N''),N' ',N'')=N'DecisionSequence>=1'
);

INSERT @Findings
SELECT N'MISSING_OR_INVALID_SEQUENCE_UNIQUENESS',CONCAT(target.TableName,N'.',target.UniqueConstraint,N' = ',COALESCE(definition.KeyColumns,N'<missing>'))
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
WHERE definition.KeyColumns IS NULL OR definition.KeyColumns<>target.NewKeyColumns;

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
WHERE oldIndex.KeyColumns=target.OldKeyColumns;

INSERT @Findings
SELECT N'DISABLED_OR_UNTRUSTED_FOREIGN_KEY',CONCAT(OBJECT_NAME(foreignKey.parent_object_id),N'.',foreignKey.name)
FROM sys.foreign_keys foreignKey
WHERE (foreignKey.parent_object_id IN (SELECT OBJECT_ID(N'dbo.'+TableName,N'U') FROM @Targets)
    OR foreignKey.referenced_object_id IN (SELECT OBJECT_ID(N'dbo.'+TableName,N'U') FROM @Targets))
  AND (foreignKey.is_disabled=1 OR foreignKey.is_not_trusted=1);

INSERT @Findings
SELECT N'DISABLED_OR_UNTRUSTED_CHECK',CONCAT(OBJECT_NAME(checkObject.parent_object_id),N'.',checkObject.name)
FROM sys.check_constraints checkObject
WHERE checkObject.parent_object_id IN (SELECT OBJECT_ID(N'dbo.'+TableName,N'U') FROM @Targets)
  AND (checkObject.is_disabled=1 OR checkObject.is_not_trusted=1);

DECLARE @ReadyTableCount int=(
  SELECT COUNT(*)
  FROM @Targets target
  JOIN sys.columns columnObject
    ON columnObject.object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
   AND columnObject.name=N'DecisionSequence'
   AND TYPE_NAME(columnObject.user_type_id)=N'int'
   AND columnObject.is_nullable=0
);

-- Direct data references are deferred so verification reports a missing column
-- as a STOP finding instead of failing batch compilation.
IF @ReadyTableCount=6
BEGIN
  DECLARE @ValidationSql nvarchar(max)=N'
    SELECT N''INVALID_EFFECTIVE_PERIOD'',CONCAT(N''CargoRunAirlineProfiles:'',ProfileVersionId) FROM dbo.CargoRunAirlineProfiles WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
    UNION ALL SELECT N''INVALID_EFFECTIVE_PERIOD'',CONCAT(N''CargoRunShcGroupVersions:'',GroupVersionId) FROM dbo.CargoRunShcGroupVersions WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
    UNION ALL SELECT N''INVALID_EFFECTIVE_PERIOD'',CONCAT(N''CargoRunShcGroupMappings:'',MappingId) FROM dbo.CargoRunShcGroupMappings WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
    UNION ALL SELECT N''INVALID_EFFECTIVE_PERIOD'',CONCAT(N''CargoRunPriorityRules:'',PriorityRuleId) FROM dbo.CargoRunPriorityRules WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
    UNION ALL SELECT N''INVALID_EFFECTIVE_PERIOD'',CONCAT(N''CargoRunSlaRules:'',SlaRuleId) FROM dbo.CargoRunSlaRules WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
    UNION ALL SELECT N''INVALID_EFFECTIVE_PERIOD'',CONCAT(N''CargoRunMailRules:'',MailRuleId) FROM dbo.CargoRunMailRules WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
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
    UNION ALL SELECT N''DUPLICATE_DECISION_SEQUENCE'',CONCAT(N''CargoRunMailRules:'',AirlineScopeKey,N'':'',StationScopeKey,N'':'',EffectiveFrom,N'':'',DecisionSequence) FROM dbo.CargoRunMailRules GROUP BY AirlineScopeKey,StationScopeKey,EffectiveFrom,DecisionSequence HAVING COUNT_BIG(*)>1;';
  INSERT @Findings(Finding,Detail) EXEC sys.sp_executesql @ValidationSql;
END;

SELECT target.TableName,columnObject.name AS ColumnName,TYPE_NAME(columnObject.user_type_id) AS DataType,
  columnObject.is_nullable,defaultObject.name AS DefaultConstraint,checkObject.name AS CheckConstraint,
  checkObject.is_disabled AS CheckDisabled,checkObject.is_not_trusted AS CheckNotTrusted,
  definition.KeyColumns AS UniqueKeyColumns
FROM @Targets target
LEFT JOIN sys.columns columnObject
  ON columnObject.object_id=OBJECT_ID(N'dbo.'+target.TableName,N'U')
 AND columnObject.name=N'DecisionSequence'
LEFT JOIN sys.default_constraints defaultObject
  ON defaultObject.parent_object_id=columnObject.object_id
 AND defaultObject.parent_column_id=columnObject.column_id
LEFT JOIN sys.check_constraints checkObject
  ON checkObject.parent_object_id=columnObject.object_id
 AND checkObject.name=target.CheckConstraint
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
ORDER BY target.TableName;

IF @ReadyTableCount=6
BEGIN
  EXEC sys.sp_executesql N'
    SELECT N''CargoRunAirlineProfiles'' AS TableName,COUNT_BIG(*) AS RecordCount,SUM(CONVERT(bigint,CASE WHEN DecisionSequence=1 THEN 1 ELSE 0 END)) AS SequenceOneCount,MIN(DecisionSequence) AS MinSequence,MAX(DecisionSequence) AS MaxSequence FROM dbo.CargoRunAirlineProfiles
    UNION ALL SELECT N''CargoRunShcGroupVersions'',COUNT_BIG(*),SUM(CONVERT(bigint,CASE WHEN DecisionSequence=1 THEN 1 ELSE 0 END)),MIN(DecisionSequence),MAX(DecisionSequence) FROM dbo.CargoRunShcGroupVersions
    UNION ALL SELECT N''CargoRunShcGroupMappings'',COUNT_BIG(*),SUM(CONVERT(bigint,CASE WHEN DecisionSequence=1 THEN 1 ELSE 0 END)),MIN(DecisionSequence),MAX(DecisionSequence) FROM dbo.CargoRunShcGroupMappings
    UNION ALL SELECT N''CargoRunPriorityRules'',COUNT_BIG(*),SUM(CONVERT(bigint,CASE WHEN DecisionSequence=1 THEN 1 ELSE 0 END)),MIN(DecisionSequence),MAX(DecisionSequence) FROM dbo.CargoRunPriorityRules
    UNION ALL SELECT N''CargoRunSlaRules'',COUNT_BIG(*),SUM(CONVERT(bigint,CASE WHEN DecisionSequence=1 THEN 1 ELSE 0 END)),MIN(DecisionSequence),MAX(DecisionSequence) FROM dbo.CargoRunSlaRules
    UNION ALL SELECT N''CargoRunMailRules'',COUNT_BIG(*),SUM(CONVERT(bigint,CASE WHEN DecisionSequence=1 THEN 1 ELSE 0 END)),MIN(DecisionSequence),MAX(DecisionSequence) FROM dbo.CargoRunMailRules
    ORDER BY TableName;';
END;

-- This is the final result set. Every row is a STOP condition; valid output is empty.
SELECT Finding,Detail FROM @Findings ORDER BY Finding,Detail;
