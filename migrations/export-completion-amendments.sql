-- REVIEW ONLY. Additive immutable export-completion amendments for V2+.
-- Do not execute without isolated Azure SQL rehearsal and approval.
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

  IF OBJECT_ID(N'dbo.ExportCompletionRecords',N'U') IS NULL
     OR OBJECT_ID(N'dbo.Flights',N'U') IS NULL
     OR OBJECT_ID(N'dbo.Offloads',N'U') IS NULL
     OR OBJECT_ID(N'dbo.ULDs',N'U') IS NULL
    THROW 51100, 'Required Phase B tables are missing.', 1;
  IF OBJECT_ID(N'dbo.ExportCompletionAmendments',N'U') IS NOT NULL
    THROW 51101, 'ExportCompletionAmendments already exists; review migration state.', 1;
  IF COL_LENGTH(N'dbo.ExportCompletionRecords',N'ExportCompletionRecordId') IS NULL
     OR COL_LENGTH(N'dbo.ExportCompletionRecords',N'FlightId') IS NULL
     OR COL_LENGTH(N'dbo.ExportCompletionRecords',N'VerificationId') IS NULL
     OR COL_LENGTH(N'dbo.ExportCompletionRecords',N'SnapshotJson') IS NULL
     OR COL_LENGTH(N'dbo.ExportCompletionRecords',N'RecordHash') IS NULL
     OR COL_LENGTH(N'dbo.Offloads',N'UldId') IS NULL
    THROW 51102, 'Required completion/offload identity columns are missing.', 1;

  -- Freeze relevant ranges and reject ambiguous base records before adding keys.
  SELECT ExportCompletionRecordId FROM dbo.ExportCompletionRecords WITH (TABLOCKX,HOLDLOCK);
  SELECT OffloadId FROM dbo.Offloads WITH (TABLOCKX,HOLDLOCK);
  SELECT UldId FROM dbo.ULDs WITH (TABLOCKX,HOLDLOCK);
  IF EXISTS (SELECT 1 FROM dbo.ExportCompletionRecords WHERE FlightId IS NULL)
     OR EXISTS (SELECT 1 FROM dbo.ExportCompletionRecords GROUP BY FlightId HAVING COUNT_BIG(*)>1)
    THROW 51103, 'ExportCompletionRecords contains a missing or duplicate FlightId association.', 1;

  ALTER TABLE dbo.ExportCompletionRecords ADD CONSTRAINT UQ_ExportCompletionRecords_Flight
    UNIQUE NONCLUSTERED (FlightId);
  ALTER TABLE dbo.ExportCompletionRecords ADD CONSTRAINT UQ_ExportCompletionRecords_Flight_Record
    UNIQUE NONCLUSTERED (FlightId,ExportCompletionRecordId);
  ALTER TABLE dbo.Offloads ADD CONSTRAINT UQ_Offloads_Flight_Offload
    UNIQUE NONCLUSTERED (FlightId,OffloadId);

  CREATE TABLE dbo.ExportCompletionAmendments (
    AmendmentId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_ExportCompletionAmendments PRIMARY KEY,
    ExportCompletionRecordId bigint NOT NULL,
    FlightId bigint NOT NULL,
    VersionNumber int NOT NULL,
    PreviousHash nvarchar(128) NOT NULL,
    RecordHash nvarchar(128) NOT NULL,
    VerificationId nvarchar(100) NOT NULL,
    OperationId nvarchar(100) NOT NULL,
    Action nvarchar(150) NOT NULL,
    PreviousStatus nvarchar(30) NULL,
    ResultingStatus nvarchar(30) NOT NULL,
    Reason nvarchar(1000) NULL,
    RelatedOffloadId bigint NULL,
    RelatedUldId bigint NULL,
    ActorProvider nvarchar(100) NULL,
    ActorReference nvarchar(150) NULL,
    ActorDisplayName nvarchar(150) NOT NULL,
    OccurredAtUtc datetime2(3) NOT NULL,
    SnapshotJson nvarchar(max) NOT NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_ExportCompletionAmendments_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_ExportCompletionAmendments_Version CHECK (VersionNumber>=2),
    CONSTRAINT CK_ExportCompletionAmendments_PreviousHash CHECK (LEN(PreviousHash)=64),
    CONSTRAINT CK_ExportCompletionAmendments_RecordHash CHECK (LEN(RecordHash)=64),
    CONSTRAINT CK_ExportCompletionAmendments_SnapshotJson CHECK (ISJSON(SnapshotJson)=1),
    CONSTRAINT CK_ExportCompletionAmendments_OffloadTransition CHECK (
      (Action=N'OFFLOAD_REQUESTED' AND PreviousStatus IS NULL AND ResultingStatus=N'REQUESTED') OR
      (Action=N'OFFLOAD_TRANSIT' AND PreviousStatus=N'REQUESTED' AND ResultingStatus=N'TRANSIT') OR
      (Action=N'OFFLOAD_COMPLETE' AND PreviousStatus=N'TRANSIT' AND ResultingStatus=N'COMPLETE')
    ),
    CONSTRAINT UQ_ExportCompletionAmendments_BaseVersion UNIQUE (ExportCompletionRecordId,VersionNumber),
    CONSTRAINT UQ_ExportCompletionAmendments_FlightVersion UNIQUE (FlightId,VersionNumber),
    CONSTRAINT UQ_ExportCompletionAmendments_Verification UNIQUE (VerificationId),
    CONSTRAINT UQ_ExportCompletionAmendments_Operation UNIQUE (OperationId),
    CONSTRAINT FK_ExportCompletionAmendments_BaseFlight FOREIGN KEY (FlightId,ExportCompletionRecordId)
      REFERENCES dbo.ExportCompletionRecords(FlightId,ExportCompletionRecordId),
    CONSTRAINT FK_ExportCompletionAmendments_FlightOffload FOREIGN KEY (FlightId,RelatedOffloadId)
      REFERENCES dbo.Offloads(FlightId,OffloadId),
    CONSTRAINT FK_ExportCompletionAmendments_FlightUld FOREIGN KEY (FlightId,RelatedUldId)
      REFERENCES dbo.ULDs(FlightId,UldId)
  );

  EXEC sys.sp_executesql N'
    CREATE TRIGGER dbo.TR_ExportCompletionAmendments_Immutable
    ON dbo.ExportCompletionAmendments
    INSTEAD OF UPDATE, DELETE
    AS
    BEGIN
      SET NOCOUNT ON;
      THROW 51104, ''Export completion amendments are append-only.'', 1;
    END;';

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
