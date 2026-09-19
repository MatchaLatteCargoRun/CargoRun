-- REVIEW ONLY. Additive immutable export build FINAL state and membership.
-- Do not execute against live until the read-only preflight and isolated rehearsal pass.
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID(N'dbo.Flights',N'U') IS NULL
     OR OBJECT_ID(N'dbo.ULDs',N'U') IS NULL
     OR OBJECT_ID(N'dbo.AuditEvents',N'U') IS NULL
    THROW 51200, 'Required CargoRun tables are missing.', 1;
  IF OBJECT_ID(N'dbo.ExportManifestFinals',N'U') IS NOT NULL
     OR OBJECT_ID(N'dbo.ExportManifestFinalUlds',N'U') IS NOT NULL
    THROW 51201, 'Export manifest FINAL tables already exist; review migration state.', 1;
  IF COL_LENGTH(N'dbo.Flights',N'FlightId') IS NULL
     OR COL_LENGTH(N'dbo.ULDs',N'FlightId') IS NULL
     OR COL_LENGTH(N'dbo.ULDs',N'UldId') IS NULL
     OR COL_LENGTH(N'dbo.ULDs',N'UldNumber') IS NULL
    THROW 51202, 'Required flight/ULD identity columns are missing.', 1;
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      (OBJECT_ID(N'dbo.Flights',N'U'),N'FlightId'),
      (OBJECT_ID(N'dbo.ULDs',N'U'),N'FlightId'),
      (OBJECT_ID(N'dbo.ULDs',N'U'),N'UldId')
    ) required(ObjectId,ColumnName)
    JOIN sys.columns c ON c.object_id=required.ObjectId AND c.name=required.ColumnName
    WHERE TYPE_NAME(c.user_type_id)<>N'bigint'
  ) THROW 51206, 'Required flight/ULD identity columns must be bigint.', 1;
  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes i
    JOIN sys.index_columns a ON a.object_id=i.object_id AND a.index_id=i.index_id AND a.key_ordinal=1
    JOIN sys.columns ca ON ca.object_id=a.object_id AND ca.column_id=a.column_id
    JOIN sys.index_columns b ON b.object_id=i.object_id AND b.index_id=i.index_id AND b.key_ordinal=2
    JOIN sys.columns cb ON cb.object_id=b.object_id AND cb.column_id=b.column_id
    WHERE i.object_id=OBJECT_ID(N'dbo.ULDs',N'U') AND i.is_unique=1
      AND i.is_disabled=0 AND i.is_hypothetical=0 AND i.has_filter=0
      AND ca.name=N'FlightId' AND cb.name=N'UldId'
      AND NOT EXISTS (SELECT 1 FROM sys.index_columns x
        WHERE x.object_id=i.object_id AND x.index_id=i.index_id AND x.key_ordinal>2)
  ) THROW 51203, 'Unique dbo.ULDs(FlightId,UldId) ownership key is required.', 1;

  CREATE TABLE dbo.ExportManifestFinals (
    FinalManifestId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_ExportManifestFinals PRIMARY KEY,
    FlightId bigint NOT NULL,
    ConfirmedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_ExportManifestFinals_ConfirmedAtUtc DEFAULT SYSUTCDATETIME(),
    ConfirmedByObjectId nvarchar(150) NULL,
    ConfirmedByDisplayName nvarchar(150) NOT NULL,
    SourceFileName nvarchar(260) NULL,
    ManifestHash char(64) NOT NULL,
    FinalUldCount int NOT NULL,
    MatchedCount int NOT NULL,
    AddedCount int NOT NULL,
    ExcludedCount int NOT NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_ExportManifestFinals_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_ExportManifestFinals_Flight UNIQUE (FlightId),
    CONSTRAINT UQ_ExportManifestFinals_IdFlight UNIQUE (FinalManifestId,FlightId),
    CONSTRAINT FK_ExportManifestFinals_Flight FOREIGN KEY (FlightId) REFERENCES dbo.Flights(FlightId)
      ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT CK_ExportManifestFinals_Hash CHECK (LEN(ManifestHash)=64),
    CONSTRAINT CK_ExportManifestFinals_Counts CHECK (
      FinalUldCount>0 AND MatchedCount>=0 AND AddedCount>=0 AND ExcludedCount>=0
      AND FinalUldCount=MatchedCount+AddedCount
    )
  );

  CREATE TABLE dbo.ExportManifestFinalUlds (
    FinalManifestId bigint NOT NULL,
    FlightId bigint NOT NULL,
    UldId bigint NOT NULL,
    UldNumber nvarchar(20) NOT NULL,
    ManifestOrdinal int NOT NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_ExportManifestFinalUlds_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_ExportManifestFinalUlds PRIMARY KEY (FinalManifestId,UldId),
    CONSTRAINT UQ_ExportManifestFinalUlds_Number UNIQUE (FinalManifestId,UldNumber),
    CONSTRAINT UQ_ExportManifestFinalUlds_Ordinal UNIQUE (FinalManifestId,ManifestOrdinal),
    CONSTRAINT CK_ExportManifestFinalUlds_Ordinal CHECK (ManifestOrdinal>=1),
    CONSTRAINT FK_ExportManifestFinalUlds_Final FOREIGN KEY (FinalManifestId,FlightId)
      REFERENCES dbo.ExportManifestFinals(FinalManifestId,FlightId)
      ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT FK_ExportManifestFinalUlds_Uld FOREIGN KEY (FlightId,UldId)
      REFERENCES dbo.ULDs(FlightId,UldId)
      ON DELETE NO ACTION ON UPDATE NO ACTION
  );

  EXEC sys.sp_executesql N'
    CREATE TRIGGER dbo.TR_ExportManifestFinals_Immutable
    ON dbo.ExportManifestFinals
    INSTEAD OF UPDATE, DELETE
    AS
    BEGIN
      SET NOCOUNT ON;
      THROW 51204, ''Export manifest FINAL records are immutable.'', 1;
    END;';

  EXEC sys.sp_executesql N'
    CREATE TRIGGER dbo.TR_ExportManifestFinalUlds_Immutable
    ON dbo.ExportManifestFinalUlds
    INSTEAD OF UPDATE, DELETE
    AS
    BEGIN
      SET NOCOUNT ON;
      THROW 51205, ''Export manifest FINAL membership is immutable.'', 1;
    END;';

  EXEC sys.sp_executesql N'
    CREATE TRIGGER dbo.TR_ExportManifestFinalUlds_InsertGuard
    ON dbo.ExportManifestFinalUlds
    AFTER INSERT
    AS
    BEGIN
      SET NOCOUNT ON;
      IF EXISTS (
        SELECT 1
        FROM (SELECT DISTINCT FinalManifestId FROM inserted) changed
        JOIN dbo.ExportManifestFinals f ON f.FinalManifestId=changed.FinalManifestId
        CROSS APPLY (
          SELECT COUNT_BIG(*) AS MembershipCount
          FROM dbo.ExportManifestFinalUlds m WITH (UPDLOCK,HOLDLOCK)
          WHERE m.FinalManifestId=changed.FinalManifestId
        ) totals
        WHERE totals.MembershipCount>f.FinalUldCount
      ) THROW 51207, ''Export manifest FINAL membership cannot be extended.'', 1;
    END;';

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
