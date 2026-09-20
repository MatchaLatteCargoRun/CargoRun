-- READ ONLY. Run after import-uld-metadata.sql.
SET NOCOUNT ON;

SELECT c.column_id,c.name AS ColumnName,TYPE_NAME(c.user_type_id) AS DataType,
  c.max_length,c.precision,c.scale,c.is_nullable,dc.name AS DefaultConstraint
FROM sys.columns c
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id=c.object_id AND dc.parent_column_id=c.column_id
WHERE c.object_id=OBJECT_ID(N'dbo.ULDs',N'U')
  AND c.name IN (N'IsEmptyLoadDevice',N'IsOperatorAdded',N'OperatorAddedAtUtc',N'OperatorAddedByReference',N'OperatorAddedByDisplayName',N'OperatorAddNote')
ORDER BY c.column_id;

SELECT name,is_disabled,is_not_trusted,definition
FROM sys.check_constraints
WHERE parent_object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND name=N'CK_ULDs_OperatorAddedEvidence';

CREATE TABLE #Findings(Finding nvarchar(100) NOT NULL,Detail nvarchar(2000) NOT NULL);

IF OBJECT_ID(N'dbo.ULDs',N'U') IS NULL INSERT #Findings VALUES(N'MISSING_TABLE',N'dbo.ULDs');

INSERT #Findings
SELECT N'MISSING_OR_INVALID_COLUMN',r.ColumnName
FROM (VALUES
  (N'IsEmptyLoadDevice',N'bit',CONVERT(smallint,1),CONVERT(bit,0)),
  (N'IsOperatorAdded',N'bit',CONVERT(smallint,1),CONVERT(bit,0)),
  (N'OperatorAddedAtUtc',N'datetime2',CONVERT(smallint,7),CONVERT(bit,1)),
  (N'OperatorAddedByReference',N'nvarchar',CONVERT(smallint,300),CONVERT(bit,1)),
  (N'OperatorAddedByDisplayName',N'nvarchar',CONVERT(smallint,300),CONVERT(bit,1)),
  (N'OperatorAddNote',N'nvarchar',CONVERT(smallint,1000),CONVERT(bit,1))
) r(ColumnName,DataType,MaxLength,IsNullable)
LEFT JOIN sys.columns c ON c.object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND c.name=r.ColumnName
WHERE c.column_id IS NULL OR TYPE_NAME(c.user_type_id)<>r.DataType OR c.max_length<>r.MaxLength OR c.is_nullable<>r.IsNullable;

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND name=N'OperatorAddedAtUtc' AND scale<>3)
  INSERT #Findings VALUES(N'INVALID_DATETIME_SCALE',N'OperatorAddedAtUtc must be datetime2(3).');

IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND name=N'DF_ULDs_IsEmptyLoadDevice'
  AND REPLACE(REPLACE(REPLACE(definition,N'(',N''),N')',N''),N' ',N'')=N'0')
  INSERT #Findings VALUES(N'MISSING_DEFAULT',N'DF_ULDs_IsEmptyLoadDevice');
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND name=N'DF_ULDs_IsOperatorAdded'
  AND REPLACE(REPLACE(REPLACE(definition,N'(',N''),N')',N''),N' ',N'')=N'0')
  INSERT #Findings VALUES(N'MISSING_DEFAULT',N'DF_ULDs_IsOperatorAdded');
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND name=N'CK_ULDs_OperatorAddedEvidence' AND is_disabled=0 AND is_not_trusted=0)
  INSERT #Findings VALUES(N'MISSING_OR_UNTRUSTED_CHECK',N'CK_ULDs_OperatorAddedEvidence');

IF COL_LENGTH(N'dbo.ULDs',N'IsOperatorAdded') IS NOT NULL
BEGIN
  EXEC sys.sp_executesql N'
    INSERT #Findings(Finding,Detail)
    SELECT N''INVALID_OPERATOR_ADDED_EVIDENCE'',CONCAT(N''UldId '',UldId)
    FROM dbo.ULDs
    WHERE (IsOperatorAdded=0 AND (OperatorAddedAtUtc IS NOT NULL OR OperatorAddedByReference IS NOT NULL
      OR OperatorAddedByDisplayName IS NOT NULL OR OperatorAddNote IS NOT NULL))
       OR (IsOperatorAdded=1 AND (OperatorAddedAtUtc IS NULL OR NULLIF(LTRIM(RTRIM(OperatorAddedByReference)),N'''') IS NULL
         OR NULLIF(LTRIM(RTRIM(OperatorAddedByDisplayName)),N'''') IS NULL));';
END;

-- This is the final result set. Every row is a STOP condition; valid output is empty.
SELECT Finding,Detail FROM #Findings ORDER BY Finding,Detail;
