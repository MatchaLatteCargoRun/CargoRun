-- READ ONLY. Run against the intended CargoRun database before admin-configuration.sql.
SET NOCOUNT ON;

SELECT
  DB_NAME() AS DatabaseName,
  USER_NAME() AS DatabaseUser,
  IS_ROLEMEMBER('db_datareader') AS IsDataReader,
  IS_ROLEMEMBER('db_datawriter') AS IsDataWriter,
  IS_ROLEMEMBER('db_owner') AS IsDatabaseOwner,
  IS_ROLEMEMBER('db_ddladmin') AS IsDdlAdmin,
  HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CREATE TABLE') AS CanCreateTable;

SELECT t.name AS ExistingCargoRunConfigurationTable
FROM sys.tables t
WHERE t.schema_id=SCHEMA_ID(N'dbo')
  AND t.name IN (
    N'CargoRunStations',N'CargoRunAirlines',N'CargoRunAirlineStations',N'CargoRunAirlineProfiles',
    N'CargoRunShcs',N'CargoRunShcVersions',N'CargoRunShcGroups',N'CargoRunShcGroupVersions',
    N'CargoRunShcGroupMappings',N'CargoRunPriorityRules',N'CargoRunSlaRules',N'CargoRunMailRules',
    N'CargoRunDocumentRules',N'CargoRunLocations',N'CargoRunCapabilities',N'CargoRunRoles',
    N'CargoRunRoleCapabilities',N'CargoRunUserRoleAssignments',N'CargoRunAdminMessages',
    N'CargoRunConfigurationAudit'
  )
ORDER BY t.name;

SELECT t.name AS TableName,c.column_id,c.name AS ColumnName,TYPE_NAME(c.user_type_id) AS DataType,
  c.max_length,c.is_nullable,c.is_identity
FROM sys.tables t
JOIN sys.columns c ON c.object_id=t.object_id
WHERE t.object_id IN (OBJECT_ID(N'dbo.Flights',N'U'),OBJECT_ID(N'dbo.AuditEvents',N'U'))
ORDER BY t.name,c.column_id;

SELECT i.name,i.is_unique,i.is_primary_key,
  STRING_AGG(CONVERT(nvarchar(max),c.name),N',') WITHIN GROUP(ORDER BY ic.key_ordinal) AS KeyColumns
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>0
JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
WHERE i.object_id=OBJECT_ID(N'dbo.Flights',N'U')
GROUP BY i.name,i.is_unique,i.is_primary_key
ORDER BY i.name;

-- This result set must be empty before the migration is applied.
SELECT StopCode,Detail
FROM (
  SELECT 'WRONG_DATABASE' AS StopCode,CONCAT('Connected to ',DB_NAME(),' instead of cargorun-db') AS Detail
  WHERE DB_NAME()<>N'cargorun-db'
  UNION ALL
  SELECT 'MISSING_FLIGHTS_TABLE','dbo.Flights is required'
  WHERE OBJECT_ID(N'dbo.Flights',N'U') IS NULL
  UNION ALL
  SELECT 'MISSING_FLIGHT_ID','dbo.Flights.FlightId is required'
  WHERE OBJECT_ID(N'dbo.Flights',N'U') IS NOT NULL AND COL_LENGTH(N'dbo.Flights',N'FlightId') IS NULL
  UNION ALL
  SELECT 'MISSING_FLIGHT_ID_UNIQUE_KEY','A trusted unique key on dbo.Flights(FlightId) is required for message targeting'
  WHERE COL_LENGTH(N'dbo.Flights',N'FlightId') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sys.indexes i
    WHERE i.object_id=OBJECT_ID(N'dbo.Flights',N'U') AND i.is_unique=1 AND i.is_disabled=0
      AND 1=(SELECT COUNT(*) FROM sys.index_columns ic WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>0)
      AND EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal=1 AND c.name=N'FlightId')
  )
  UNION ALL
  SELECT 'CONFIGURATION_OBJECT_ALREADY_EXISTS',CONCAT('dbo.',t.name,' already exists; inspect and verify instead of rerunning the migration')
  FROM sys.tables t
  WHERE t.schema_id=SCHEMA_ID(N'dbo') AND t.name IN (
    N'CargoRunStations',N'CargoRunAirlines',N'CargoRunAirlineStations',N'CargoRunAirlineProfiles',
    N'CargoRunShcs',N'CargoRunShcVersions',N'CargoRunShcGroups',N'CargoRunShcGroupVersions',
    N'CargoRunShcGroupMappings',N'CargoRunPriorityRules',N'CargoRunSlaRules',N'CargoRunMailRules',
    N'CargoRunDocumentRules',N'CargoRunLocations',N'CargoRunCapabilities',N'CargoRunRoles',
    N'CargoRunRoleCapabilities',N'CargoRunUserRoleAssignments',N'CargoRunAdminMessages',N'CargoRunConfigurationAudit'
  )
) stops
ORDER BY StopCode,Detail;
