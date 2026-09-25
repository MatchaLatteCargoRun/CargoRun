-- READ ONLY. Run after role seeding and all intended user assignments.
-- The final result set must be empty before deploying H-01 enforcement code.
SET NOCOUNT ON;
DECLARE @AsOfDate date=CONVERT(date,SYSUTCDATETIME());
CREATE TABLE #Findings(Finding nvarchar(100) NOT NULL,Detail nvarchar(2000) NOT NULL);

DECLARE @Expected table(RoleCode varchar(40) NOT NULL,CapabilityCode varchar(60) NOT NULL,PRIMARY KEY(RoleCode,CapabilityCode));
INSERT @Expected VALUES
  ('OPERATIONS','VIEW_FLIGHTS'),('OPERATIONS','MOVE_ULD'),('OPERATIONS','SCAN_ULD'),
  ('OPERATIONS','VIEW_PRIORITY'),('OPERATIONS','REQUEST_OFFLOAD'),
  ('OPERATIONS','COLLECT_OFFLOAD'),('OPERATIONS','COMPLETE_OFFLOAD'),
  ('OPERATIONS','SET_IN_BLOCK'),('OPERATIONS','SET_ETD'),
  ('OPERATIONS','UPLOAD_FLIGHT_DATA'),('OPERATIONS','VIEW_FLIGHT_STATEMENT'),
  ('SUPERVISOR','VIEW_FLIGHTS'),('SUPERVISOR','MOVE_ULD'),('SUPERVISOR','SCAN_ULD'),
  ('SUPERVISOR','VIEW_PRIORITY'),('SUPERVISOR','REQUEST_OFFLOAD'),
  ('SUPERVISOR','COLLECT_OFFLOAD'),('SUPERVISOR','COMPLETE_OFFLOAD'),
  ('SUPERVISOR','SET_IN_BLOCK'),('SUPERVISOR','SET_ETD'),
  ('SUPERVISOR','UPLOAD_FLIGHT_DATA'),('SUPERVISOR','VIEW_FLIGHT_STATEMENT'),
  ('SUPERVISOR','CONFIRM_EXPORT_FINAL'),('SUPERVISOR','FINALISE_FLIGHT'),
  ('SUPERVISOR','VIEW_HISTORY'),('SUPERVISOR','EXPORT_HISTORY'),
  ('SUPERVISOR','VIEW_SUPERVISOR');

;WITH CapabilityDecisions AS (
  SELECT role.RoleCode,capability.CapabilityCode,decision.CapabilityAction,
    ROW_NUMBER() OVER (PARTITION BY role.RoleId,capability.CapabilityId
      ORDER BY decision.EffectiveFrom DESC,decision.RoleCapabilityVersionId DESC) AS DecisionRank
  FROM dbo.CargoRunRoles role
  JOIN dbo.CargoRunRoleCapabilities decision ON decision.RoleId=role.RoleId
  JOIN dbo.CargoRunCapabilities capability ON capability.CapabilityId=decision.CapabilityId
  WHERE role.RoleCode IN ('OPERATIONS','SUPERVISOR')
    AND role.IsEnabled=1 AND capability.IsEnabled=1
    AND decision.EffectiveFrom<=@AsOfDate
    AND (decision.EffectiveTo IS NULL OR decision.EffectiveTo>@AsOfDate)
), EffectiveCapabilities AS (
  SELECT RoleCode,CapabilityCode FROM CapabilityDecisions
  WHERE DecisionRank=1 AND CapabilityAction='GRANT'
)
INSERT #Findings
SELECT N'MISSING_ROLE_CAPABILITY',CONCAT(expected.RoleCode,N'.',expected.CapabilityCode)
FROM @Expected expected
LEFT JOIN EffectiveCapabilities actual
  ON actual.RoleCode=expected.RoleCode AND actual.CapabilityCode=expected.CapabilityCode
WHERE actual.CapabilityCode IS NULL
UNION ALL
SELECT N'UNEXPECTED_ROLE_CAPABILITY',CONCAT(actual.RoleCode,N'.',actual.CapabilityCode)
FROM EffectiveCapabilities actual
LEFT JOIN @Expected expected
  ON expected.RoleCode=actual.RoleCode AND expected.CapabilityCode=actual.CapabilityCode
WHERE expected.CapabilityCode IS NULL;

INSERT #Findings
SELECT N'MISSING_OR_DISABLED_ROLE',required.RoleCode
FROM (VALUES('OPERATIONS'),('SUPERVISOR')) required(RoleCode)
LEFT JOIN dbo.CargoRunRoles role ON role.RoleCode=required.RoleCode AND role.IsEnabled=1
WHERE role.RoleId IS NULL;

;WITH AssignmentDecisions AS (
  SELECT assignment.ActorReference,assignment.ActorDisplayName,assignment.RoleId,
    assignment.StationId,assignment.AssignmentAction,
    ROW_NUMBER() OVER (
      PARTITION BY assignment.ActorReference,assignment.RoleId,assignment.StationScopeKey
      ORDER BY assignment.EffectiveFrom DESC,assignment.UserRoleVersionId DESC
    ) AS DecisionRank
  FROM dbo.CargoRunUserRoleAssignments assignment
  WHERE assignment.EffectiveFrom<=@AsOfDate
    AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>@AsOfDate)
), EffectiveAssignments AS (
  SELECT decision.ActorReference,decision.ActorDisplayName,decision.RoleId,decision.StationId
  FROM AssignmentDecisions decision
  WHERE decision.DecisionRank=1 AND decision.AssignmentAction='GRANT'
)
SELECT assignment.ActorReference,assignment.ActorDisplayName,role.RoleCode,
  station.StationCode,station.IsEnabled AS StationEnabled
FROM EffectiveAssignments assignment
JOIN dbo.CargoRunRoles role ON role.RoleId=assignment.RoleId
LEFT JOIN dbo.CargoRunStations station ON station.StationId=assignment.StationId
WHERE role.RoleCode IN ('OPERATIONS','SUPERVISOR')
ORDER BY station.StationCode,role.RoleCode,assignment.ActorReference;

;WITH AssignmentDecisions AS (
  SELECT assignment.ActorReference,assignment.RoleId,assignment.StationId,
    assignment.StationScopeKey,assignment.AssignmentAction,
    ROW_NUMBER() OVER (
      PARTITION BY assignment.ActorReference,assignment.RoleId,assignment.StationScopeKey
      ORDER BY assignment.EffectiveFrom DESC,assignment.UserRoleVersionId DESC
    ) AS DecisionRank
  FROM dbo.CargoRunUserRoleAssignments assignment
  WHERE assignment.EffectiveFrom<=@AsOfDate
    AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>@AsOfDate)
), EffectiveOperationalAssignments AS (
  SELECT decision.ActorReference,decision.RoleId,decision.StationId
  FROM AssignmentDecisions decision
  JOIN dbo.CargoRunRoles role ON role.RoleId=decision.RoleId
  WHERE decision.DecisionRank=1 AND decision.AssignmentAction='GRANT'
    AND role.RoleCode IN ('OPERATIONS','SUPERVISOR') AND role.IsEnabled=1
)
INSERT #Findings
SELECT N'NO_OPERATIONAL_ASSIGNMENTS',N'Assign intended stable SWA userIds to station-scoped OPERATIONS or SUPERVISOR roles before deployment.'
WHERE NOT EXISTS (SELECT 1 FROM EffectiveOperationalAssignments)
UNION ALL
SELECT N'GLOBAL_OPERATIONAL_ASSIGNMENT',assignment.ActorReference
FROM EffectiveOperationalAssignments assignment WHERE assignment.StationId IS NULL
UNION ALL
SELECT N'ASSIGNMENT_STATION_MISSING_OR_DISABLED',assignment.ActorReference
FROM EffectiveOperationalAssignments assignment
LEFT JOIN dbo.CargoRunStations station ON station.StationId=assignment.StationId AND station.IsEnabled=1
WHERE assignment.StationId IS NOT NULL AND station.StationId IS NULL;

-- This is the final result set. Every row is a STOP condition.
SELECT Finding,Detail FROM #Findings ORDER BY Finding,Detail;
