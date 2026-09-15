/* CargoRun Step 5C — Offload instruction fields
   Safe additive migration. Existing offloads are untouched. */
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRANSACTION;
  IF COL_LENGTH('dbo.Offloads', 'RequestInstruction') IS NULL
    ALTER TABLE dbo.Offloads ADD RequestInstruction NVARCHAR(300) NULL;
  IF COL_LENGTH('dbo.Offloads', 'CompletionNote') IS NULL
    ALTER TABLE dbo.Offloads ADD CompletionNote NVARCHAR(300) NULL;
  COMMIT TRANSACTION;
  SELECT COL_LENGTH('dbo.Offloads', 'RequestInstruction') AS RequestInstructionBytes, COL_LENGTH('dbo.Offloads', 'CompletionNote') AS CompletionNoteBytes;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
