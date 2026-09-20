-- READ ONLY. Run before import-uld-metadata.sql.
SET NOCOUNT ON;

DECLARE @Required table(ColumnName sysname NOT NULL PRIMARY KEY,DataType sysname NOT NULL,MaxLength smallint NULL,Scale tinyint NULL,IsNullable bit NOT NULL);
INSERT @Required(ColumnName,DataType,MaxLength,Scale,IsNullable) VALUES
  (N'IsEmptyLoadDevice',N'bit',1,NULL,0),
  (N'IsOperatorAdded',N'bit',1,NULL,0),
  (N'OperatorAddedAtUtc',N'datetime2',7,3,1),
  (N'OperatorAddedByReference',N'nvarchar',300,NULL,1),
  (N'OperatorAddedByDisplayName',N'nvarchar',300,NULL,1),
  (N'OperatorAddNote',N'nvarchar',1000,NULL,1);

SELECT c.column_id,c.name AS ColumnName,TYPE_NAME(c.user_type_id) AS DataType,
  c.max_length,c.is_nullable,c.is_identity,dc.name AS DefaultConstraint
FROM sys.columns c
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id=c.object_id AND dc.parent_column_id=c.column_id
WHERE c.object_id=OBJECT_ID(N'dbo.ULDs',N'U')
ORDER BY c.column_id;

DECLARE @Findings table(Finding nvarchar(100) NOT NULL,Detail nvarchar(2000) NOT NULL);

IF OBJECT_ID(N'dbo.ULDs',N'U') IS NULL
  INSERT @Findings VALUES(N'MISSING_TABLE',N'dbo.ULDs does not exist.');
IF OBJECT_ID(N'dbo.Flights',N'U') IS NULL
  INSERT @Findings VALUES(N'MISSING_TABLE',N'dbo.Flights does not exist.');
IF OBJECT_ID(N'dbo.AuditEvents',N'U') IS NULL
  INSERT @Findings VALUES(N'MISSING_TABLE',N'dbo.AuditEvents does not exist.');

IF OBJECT_ID(N'dbo.ULDs',N'U') IS NOT NULL
BEGIN
  DECLARE @Present int=(SELECT COUNT(*) FROM @Required r JOIN sys.columns c
    ON c.object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND c.name=r.ColumnName);
  IF @Present NOT IN (0,6)
    INSERT @Findings VALUES(N'PARTIAL_INSTALL',CONCAT(N'Expected zero or six metadata columns; found ',@Present,N'.'));

  INSERT @Findings
  SELECT N'INCOMPATIBLE_COLUMN',CONCAT(r.ColumnName,N' expected ',r.DataType,N'(',COALESCE(CONVERT(nvarchar(10),r.MaxLength),N'-'),N') nullable=',r.IsNullable,
    N'; found ',TYPE_NAME(c.user_type_id),N'(',c.max_length,N') nullable=',c.is_nullable,N'.')
  FROM @Required r
  JOIN sys.columns c ON c.object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND c.name=r.ColumnName
  WHERE TYPE_NAME(c.user_type_id)<>r.DataType OR c.max_length<>r.MaxLength
    OR (r.Scale IS NOT NULL AND c.scale<>r.Scale) OR c.is_nullable<>r.IsNullable;

  INSERT @Findings
  SELECT N'MISSING_BASE_COLUMN',v.ColumnName
  FROM (VALUES(N'UldId'),(N'FlightId'),(N'UldNumber'),(N'CurrentStatus'),(N'CreatedAtUtc')) v(ColumnName)
  WHERE COL_LENGTH(N'dbo.ULDs',v.ColumnName) IS NULL;

  IF @Present=6
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND name=N'DF_ULDs_IsEmptyLoadDevice'
      AND REPLACE(REPLACE(REPLACE(definition,N'(',N''),N')',N''),N' ',N'')=N'0')
      INSERT @Findings VALUES(N'MISSING_DEFAULT',N'DF_ULDs_IsEmptyLoadDevice');
    IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND name=N'DF_ULDs_IsOperatorAdded'
      AND REPLACE(REPLACE(REPLACE(definition,N'(',N''),N')',N''),N' ',N'')=N'0')
      INSERT @Findings VALUES(N'MISSING_DEFAULT',N'DF_ULDs_IsOperatorAdded');
    IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND name=N'CK_ULDs_OperatorAddedEvidence' AND is_disabled=0 AND is_not_trusted=0)
      INSERT @Findings VALUES(N'MISSING_OR_UNTRUSTED_CHECK',N'CK_ULDs_OperatorAddedEvidence');
  END;
END;

IF @Present=0 AND EXISTS (
  SELECT 1 FROM sys.objects
  WHERE schema_id=SCHEMA_ID(N'dbo')
    AND name IN (N'DF_ULDs_IsEmptyLoadDevice',N'DF_ULDs_IsOperatorAdded',N'CK_ULDs_OperatorAddedEvidence')
)
  INSERT @Findings VALUES(N'CONSTRAINT_NAME_CONFLICT',N'One or more planned ULD metadata constraint names already exist in dbo.');

-- This is the final result set. Every row is a STOP condition; valid output is empty.
SELECT Finding,Detail FROM @Findings ORDER BY Finding,Detail;
