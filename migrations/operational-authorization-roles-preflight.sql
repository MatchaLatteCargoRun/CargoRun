-- READ ONLY. Run before operational-authorization-roles.sql.
SET NOCOUNT ON;

CREATE TABLE #Findings(Finding nvarchar(100) NOT NULL,Detail nvarchar(2000) NOT NULL);

INSERT #Findings
SELECT N'MISSING_TABLE',required.TableName
FROM (VALUES
  (N'CargoRunStations'),(N'CargoRunCapabilities'),(N'CargoRunRoles'),
  (N'CargoRunRoleCapabilities'),(N'CargoRunUserRoleAssignments'),
  (N'CargoRunConfigurationAudit')
) required(TableName)
WHERE OBJECT_ID(N'dbo.'+required.TableName,N'U') IS NULL;

IF OBJECT_ID(N'dbo.CargoRunCapabilities',N'U') IS NOT NULL
BEGIN
  INSERT #Findings
  SELECT N'MISSING_OR_DISABLED_CAPABILITY',required.CapabilityCode
  FROM (VALUES
    ('VIEW_FLIGHTS'),('MOVE_ULD'),('SCAN_ULD'),('VIEW_PRIORITY'),
    ('REQUEST_OFFLOAD'),('COLLECT_OFFLOAD'),('COMPLETE_OFFLOAD'),
    ('SET_IN_BLOCK'),('SET_ETD'),('UPLOAD_FLIGHT_DATA'),
    ('CONFIRM_EXPORT_FINAL'),('FINALISE_FLIGHT'),('VIEW_FLIGHT_STATEMENT'),
    ('VIEW_HISTORY'),('EXPORT_HISTORY'),('VIEW_SUPERVISOR')
  ) required(CapabilityCode)
  LEFT JOIN dbo.CargoRunCapabilities capability
    ON capability.CapabilityCode=required.CapabilityCode AND capability.IsEnabled=1
  WHERE capability.CapabilityId IS NULL;
END;

IF OBJECT_ID(N'dbo.CargoRunStations',N'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM dbo.CargoRunStations WHERE StationCode='MEL' AND IsEnabled=1)
  INSERT #Findings VALUES(N'MEL_STATION_MISSING_OR_DISABLED',N'CargoRunStations.MEL');

IF OBJECT_ID(N'dbo.CargoRunRoles',N'U') IS NOT NULL
BEGIN
  INSERT #Findings
  SELECT N'OPERATIONAL_ROLE_DISABLED',RoleCode
  FROM dbo.CargoRunRoles
  WHERE RoleCode IN ('OPERATIONS','SUPERVISOR') AND IsEnabled=0;

  SELECT RoleId,RoleCode,DisplayName,IsEnabled,CreatedAtUtc,CreatedByReference
  FROM dbo.CargoRunRoles
  WHERE RoleCode IN ('OPERATIONS','SUPERVISOR')
  ORDER BY RoleCode;
END;

IF OBJECT_ID(N'dbo.CargoRunUserRoleAssignments',N'U') IS NOT NULL
   AND OBJECT_ID(N'dbo.CargoRunRoles',N'U') IS NOT NULL
   AND OBJECT_ID(N'dbo.CargoRunStations',N'U') IS NOT NULL
BEGIN
  SELECT assignment.ActorReference,assignment.ActorDisplayName,role.RoleCode,
    station.StationCode,assignment.AssignmentAction,assignment.EffectiveFrom,
    assignment.EffectiveTo,assignment.CreatedByReference
  FROM dbo.CargoRunUserRoleAssignments assignment
  JOIN dbo.CargoRunRoles role ON role.RoleId=assignment.RoleId
  LEFT JOIN dbo.CargoRunStations station ON station.StationId=assignment.StationId
  WHERE role.RoleCode IN ('OPERATIONS','SUPERVISOR')
  ORDER BY assignment.ActorReference,role.RoleCode,station.StationCode,assignment.EffectiveFrom;
END;

-- This is the final result set. Every row is a STOP condition.
SELECT Finding,Detail FROM #Findings ORDER BY Finding,Detail;
