-- Additive metadata for deliberate operator-added Import ULDs and ELD context.
-- Existing ULD rows are retained and receive false flags only.
SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRANSACTION;

DECLARE @LockResult int;
EXEC @LockResult=sys.sp_getapplock
  @Resource=N'CargoRun:Migration:ImportUldMetadata',
  @LockMode='Exclusive',
  @LockOwner='Transaction',
  @LockTimeout=10000;
IF @LockResult<0 THROW 51510,'Could not acquire the Import ULD metadata migration lock.',1;

IF OBJECT_ID(N'dbo.ULDs',N'U') IS NULL THROW 51511,'dbo.ULDs does not exist.',1;

DECLARE @Present int=(SELECT COUNT(*) FROM sys.columns WHERE object_id=OBJECT_ID(N'dbo.ULDs',N'U')
  AND name IN (N'IsEmptyLoadDevice',N'IsOperatorAdded',N'OperatorAddedAtUtc',N'OperatorAddedByReference',N'OperatorAddedByDisplayName',N'OperatorAddNote'));
IF @Present NOT IN (0,6) THROW 51512,'A partial Import ULD metadata installation exists. Stop for review.',1;

IF @Present=0
BEGIN
  EXEC sys.sp_executesql N'
    ALTER TABLE dbo.ULDs ADD IsEmptyLoadDevice bit NOT NULL
      CONSTRAINT DF_ULDs_IsEmptyLoadDevice DEFAULT(0) WITH VALUES;';
  EXEC sys.sp_executesql N'
    ALTER TABLE dbo.ULDs ADD IsOperatorAdded bit NOT NULL
      CONSTRAINT DF_ULDs_IsOperatorAdded DEFAULT(0) WITH VALUES;';
  EXEC sys.sp_executesql N'
    ALTER TABLE dbo.ULDs ADD
      OperatorAddedAtUtc datetime2(3) NULL,
      OperatorAddedByReference nvarchar(150) NULL,
      OperatorAddedByDisplayName nvarchar(150) NULL,
      OperatorAddNote nvarchar(500) NULL;';

  EXEC sys.sp_executesql N'
    ALTER TABLE dbo.ULDs WITH CHECK ADD CONSTRAINT CK_ULDs_OperatorAddedEvidence CHECK(
      (IsOperatorAdded=0 AND OperatorAddedAtUtc IS NULL AND OperatorAddedByReference IS NULL
        AND OperatorAddedByDisplayName IS NULL AND OperatorAddNote IS NULL)
      OR
      (IsOperatorAdded=1 AND OperatorAddedAtUtc IS NOT NULL AND OperatorAddedByReference IS NOT NULL
        AND LEN(LTRIM(RTRIM(OperatorAddedByReference)))>0
        AND OperatorAddedByDisplayName IS NOT NULL AND LEN(LTRIM(RTRIM(OperatorAddedByDisplayName)))>0)
    );
    ALTER TABLE dbo.ULDs CHECK CONSTRAINT CK_ULDs_OperatorAddedEvidence;';
END;

IF EXISTS (
  SELECT 1
  FROM (VALUES
    (N'IsEmptyLoadDevice',N'bit',CONVERT(smallint,1),CONVERT(tinyint,NULL),CONVERT(bit,0)),
    (N'IsOperatorAdded',N'bit',CONVERT(smallint,1),CONVERT(tinyint,NULL),CONVERT(bit,0)),
    (N'OperatorAddedAtUtc',N'datetime2',CONVERT(smallint,7),CONVERT(tinyint,3),CONVERT(bit,1)),
    (N'OperatorAddedByReference',N'nvarchar',CONVERT(smallint,300),CONVERT(tinyint,NULL),CONVERT(bit,1)),
    (N'OperatorAddedByDisplayName',N'nvarchar',CONVERT(smallint,300),CONVERT(tinyint,NULL),CONVERT(bit,1)),
    (N'OperatorAddNote',N'nvarchar',CONVERT(smallint,1000),CONVERT(tinyint,NULL),CONVERT(bit,1))
  ) expected(ColumnName,DataType,MaxLength,Scale,IsNullable)
  LEFT JOIN sys.columns actual ON actual.object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND actual.name=expected.ColumnName
  WHERE actual.column_id IS NULL OR TYPE_NAME(actual.user_type_id)<>expected.DataType
    OR actual.max_length<>expected.MaxLength OR (expected.Scale IS NOT NULL AND actual.scale<>expected.Scale)
    OR actual.is_nullable<>expected.IsNullable
) THROW 51513,'Import ULD metadata columns do not match the required schema.',1;

IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND name=N'DF_ULDs_IsEmptyLoadDevice'
  AND REPLACE(REPLACE(REPLACE(definition,N'(',N''),N')',N''),N' ',N'')=N'0')
  THROW 51514,'The IsEmptyLoadDevice default constraint is missing.',1;
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND name=N'DF_ULDs_IsOperatorAdded'
  AND REPLACE(REPLACE(REPLACE(definition,N'(',N''),N')',N''),N' ',N'')=N'0')
  THROW 51515,'The IsOperatorAdded default constraint is missing.',1;
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND name=N'CK_ULDs_OperatorAddedEvidence' AND is_disabled=0 AND is_not_trusted=0)
  THROW 51516,'The operator-added evidence check constraint is missing, disabled, or untrusted.',1;

COMMIT TRANSACTION;
