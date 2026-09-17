-- REVIEW ONLY: execute manually only after approval and isolated SQL testing.
-- One-time migration for the explicitly reviewed OffloadIds 1..12.
-- Pause/drain operational writers while applying. No historical DML.
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
    IF OBJECT_ID(N'dbo.Offloads', N'U') IS NULL
       OR OBJECT_ID(N'dbo.ULDs', N'U') IS NULL
        THROW 51000, 'Required tables are missing.', 1;
    IF COL_LENGTH(N'dbo.Offloads', N'UldId') IS NOT NULL
        THROW 51001, 'Offloads.UldId already exists. Review migration state.', 1;

    DECLARE @OffloadCount bigint, @UldCount bigint;
    SELECT @OffloadCount = COUNT_BIG(*) FROM dbo.Offloads WITH (TABLOCKX, HOLDLOCK);
    SELECT @UldCount = COUNT_BIG(*) FROM dbo.ULDs WITH (TABLOCKX, HOLDLOCK);
    IF @OffloadCount <> 12 OR EXISTS (
        SELECT 1 FROM dbo.Offloads WHERE OffloadId NOT IN (1,2,3,4,5,6,7,8,9,10,11,12)
    )
        THROW 51002, 'Offload population changed. Repeat preflight.', 1;
    IF EXISTS (SELECT 1 FROM dbo.Offloads WHERE OffloadId BETWEEN 1 AND 11 AND FlightId IS NOT NULL)
        THROW 51003, 'Legacy flight ownership changed. Repeat preflight.', 1;
    IF NOT EXISTS (SELECT 1 FROM dbo.Offloads WHERE OffloadId = 9
        AND FlightId IS NULL AND UldNumber = N'QKE52521QR' AND OffloadStatus = 'REQUESTED')
        THROW 51004, 'Offload 9 changed. Repeat preflight.', 1;
    IF NOT EXISTS (SELECT 1 FROM dbo.Offloads WHERE OffloadId = 12
        AND FlightId = 25 AND UldNumber = N'AKE88888CX' AND OffloadStatus = 'COMPLETE')
        THROW 51005, 'Offload 12 changed. Repeat preflight.', 1;
    IF EXISTS (SELECT 1 FROM dbo.Offloads WHERE OffloadId <> 9
        AND (OffloadStatus IS NULL OR OffloadStatus <> 'COMPLETE'))
        THROW 51006, 'Historical statuses changed. Repeat preflight.', 1;

    -- Reuse an enabled, unfiltered two-column unique key if already present.
    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes i
        JOIN sys.index_columns a ON a.object_id=i.object_id AND a.index_id=i.index_id AND a.key_ordinal=1
        JOIN sys.columns ca ON ca.object_id=a.object_id AND ca.column_id=a.column_id
        JOIN sys.index_columns b ON b.object_id=i.object_id AND b.index_id=i.index_id AND b.key_ordinal=2
        JOIN sys.columns cb ON cb.object_id=b.object_id AND cb.column_id=b.column_id
        WHERE i.object_id=OBJECT_ID(N'dbo.ULDs') AND i.is_unique=1
          AND i.is_disabled=0 AND i.is_hypothetical=0 AND i.has_filter=0
          AND ca.name=N'FlightId' AND cb.name=N'UldId'
          AND NOT EXISTS (SELECT 1 FROM sys.index_columns x
              WHERE x.object_id=i.object_id AND x.index_id=i.index_id AND x.key_ordinal>2)
    )
        ALTER TABLE dbo.ULDs ADD CONSTRAINT UQ_ULDs_FlightId_UldId
            UNIQUE NONCLUSTERED (FlightId,UldId);

    -- Separate compilation permits references to the new column below.
    EXEC sys.sp_executesql N'ALTER TABLE dbo.Offloads ADD UldId bigint NULL;';
    EXEC sys.sp_executesql N'
        ALTER TABLE dbo.Offloads WITH CHECK
        ADD CONSTRAINT CK_Offloads_UldId_LegacyAllowance CHECK
            (UldId IS NOT NULL OR OffloadId IN (1,2,3,4,5,6,7,8,9,10,11,12));
        ALTER TABLE dbo.Offloads WITH CHECK
        ADD CONSTRAINT CK_Offloads_UldRequiresFlight CHECK
            (UldId IS NULL OR FlightId IS NOT NULL);
        ALTER TABLE dbo.Offloads WITH CHECK
        ADD CONSTRAINT FK_Offloads_FlightUld
            FOREIGN KEY (FlightId,UldId) REFERENCES dbo.ULDs(FlightId,UldId)
            ON DELETE NO ACTION ON UPDATE NO ACTION;
        CREATE UNIQUE NONCLUSTERED INDEX UX_Offloads_ActiveFlightUld
            ON dbo.Offloads(FlightId,UldId)
            WHERE FlightId IS NOT NULL AND UldId IS NOT NULL
              AND OffloadStatus IN (''REQUESTED'',''TRANSIT'');
    ';
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
