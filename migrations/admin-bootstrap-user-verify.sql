-- READ ONLY. Run after the one-time Admin bootstrap.
-- This validates configuration metadata only. Operational authorization remains
-- LEGACY until a later, separately reviewed server deployment enables it.
SET NOCOUNT ON;

DECLARE @AsOfDate date=CONVERT(date,SYSUTCDATETIME());

-- The current server implementation reports LEGACY_OPERATIONAL_AUTHORIZATION;
-- neither the Phase A migration nor the bootstrap creates an enforcement switch.
SELECT 'LEGACY_OPERATIONAL_AUTHORIZATION' AS AuthorizationMode,
  CONVERT(bit,0) AS CapabilityEnforcementEnabled,
  N'Bootstrap creates role metadata only; it does not enable authorization enforcement.' AS Evidence;

WITH LatestAssignments AS (
  SELECT assignment.ActorReference,assignment.ActorDisplayName,assignment.RoleId,
    assignment.StationScopeKey,assignment.AssignmentAction,
    ROW_NUMBER() OVER (
      PARTITION BY assignment.ActorReference,assignment.RoleId,assignment.StationScopeKey
      ORDER BY assignment.EffectiveFrom DESC,assignment.UserRoleVersionId DESC
    ) AS DecisionRank
  FROM dbo.CargoRunUserRoleAssignments assignment
  WHERE assignment.EffectiveFrom<=@AsOfDate
    AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>@AsOfDate)
), LatestCapabilities AS (
  SELECT decision.RoleCapabilityVersionId,decision.RoleId,decision.CapabilityId,decision.CapabilityAction,
    ROW_NUMBER() OVER (
      PARTITION BY decision.RoleId,decision.CapabilityId
      ORDER BY decision.EffectiveFrom DESC,decision.RoleCapabilityVersionId DESC
    ) AS DecisionRank
  FROM dbo.CargoRunRoleCapabilities decision
  WHERE decision.EffectiveFrom<=@AsOfDate
    AND (decision.EffectiveTo IS NULL OR decision.EffectiveTo>@AsOfDate)
), EffectiveAdmins AS (
  SELECT DISTINCT assignment.ActorReference
  FROM LatestAssignments assignment
  JOIN dbo.CargoRunRoles role ON role.RoleId=assignment.RoleId
  WHERE assignment.DecisionRank=1 AND assignment.AssignmentAction='GRANT'
    AND role.RoleCode='ADMIN' AND role.IsEnabled=1
)
SELECT admin.ActorReference,
  CONVERT(bit,MAX(CASE WHEN capability.CapabilityCode='MANAGE_USERS' AND decision.CapabilityAction='GRANT' THEN 1 ELSE 0 END)) AS HasManageUsers,
  CONVERT(bit,MAX(CASE WHEN capability.CapabilityCode='VIEW_ADMIN_AUDIT' AND decision.CapabilityAction='GRANT' THEN 1 ELSE 0 END)) AS HasViewAdminAudit,
  COUNT(DISTINCT CASE WHEN decision.CapabilityAction='GRANT' AND capability.IsEnabled=1 THEN capability.CapabilityCode END) AS EffectiveCapabilityCount
FROM EffectiveAdmins admin
CROSS JOIN dbo.CargoRunRoles role
LEFT JOIN LatestCapabilities decision ON decision.RoleId=role.RoleId AND decision.DecisionRank=1
LEFT JOIN dbo.CargoRunCapabilities capability ON capability.CapabilityId=decision.CapabilityId
WHERE role.RoleCode='ADMIN' AND role.IsEnabled=1
GROUP BY admin.ActorReference
ORDER BY admin.ActorReference;

-- Every row below is a STOP condition.
WITH RequiredCapabilities AS (
  SELECT CapabilityCode FROM (VALUES
    ('VIEW_FLIGHTS'),('MOVE_ULD'),('SCAN_ULD'),('VIEW_PRIORITY'),
    ('REQUEST_OFFLOAD'),('COLLECT_OFFLOAD'),('COMPLETE_OFFLOAD'),
    ('SET_IN_BLOCK'),('SET_ETD'),('UPLOAD_FLIGHT_DATA'),
    ('CONFIRM_EXPORT_FINAL'),('FINALISE_FLIGHT'),('VIEW_FLIGHT_STATEMENT'),
    ('VIEW_HISTORY'),('EXPORT_HISTORY'),('VIEW_SUPERVISOR'),
    ('PUBLISH_MESSAGES'),('EDIT_AIRLINE_RULES'),('EDIT_SLA_RULES'),
    ('EDIT_SHC_RULES'),('MANAGE_USERS'),('VIEW_ADMIN_AUDIT')
  ) required(CapabilityCode)
), LatestAssignments AS (
  SELECT assignment.ActorReference,assignment.RoleId,assignment.StationScopeKey,assignment.AssignmentAction,
    ROW_NUMBER() OVER (
      PARTITION BY assignment.ActorReference,assignment.RoleId,assignment.StationScopeKey
      ORDER BY assignment.EffectiveFrom DESC,assignment.UserRoleVersionId DESC
    ) AS DecisionRank
  FROM dbo.CargoRunUserRoleAssignments assignment
  WHERE assignment.EffectiveFrom<=@AsOfDate
    AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>@AsOfDate)
), LatestCapabilities AS (
  SELECT decision.RoleCapabilityVersionId,decision.RoleId,decision.CapabilityId,decision.CapabilityAction,
    ROW_NUMBER() OVER (
      PARTITION BY decision.RoleId,decision.CapabilityId
      ORDER BY decision.EffectiveFrom DESC,decision.RoleCapabilityVersionId DESC
    ) AS DecisionRank
  FROM dbo.CargoRunRoleCapabilities decision
  WHERE decision.EffectiveFrom<=@AsOfDate
    AND (decision.EffectiveTo IS NULL OR decision.EffectiveTo>@AsOfDate)
), EffectiveAdmins AS (
  SELECT DISTINCT assignment.ActorReference,assignment.RoleId
  FROM LatestAssignments assignment
  JOIN dbo.CargoRunRoles role ON role.RoleId=assignment.RoleId
  WHERE assignment.DecisionRank=1 AND assignment.AssignmentAction='GRANT'
    AND role.RoleCode='ADMIN' AND role.IsEnabled=1
), AdminCount AS (
  SELECT COUNT(DISTINCT ActorReference) AS EffectiveAdminCount FROM EffectiveAdmins
), MissingCapabilities AS (
  SELECT required.CapabilityCode
  FROM RequiredCapabilities required
  LEFT JOIN dbo.CargoRunCapabilities capability
    ON capability.CapabilityCode=required.CapabilityCode AND capability.IsEnabled=1
  LEFT JOIN dbo.CargoRunRoles role ON role.RoleCode='ADMIN' AND role.IsEnabled=1
  LEFT JOIN LatestCapabilities decision
    ON decision.RoleId=role.RoleId AND decision.CapabilityId=capability.CapabilityId
   AND decision.DecisionRank=1 AND decision.CapabilityAction='GRANT'
  WHERE decision.RoleCapabilityVersionId IS NULL
)
SELECT 'ADMIN_ROLE_MISSING_OR_DISABLED' AS Finding,N'ADMIN role must exist and be enabled.' AS Detail
WHERE NOT EXISTS (SELECT 1 FROM dbo.CargoRunRoles WHERE RoleCode='ADMIN' AND IsEnabled=1)
UNION ALL
SELECT 'EFFECTIVE_ADMIN_COUNT',CONCAT(N'Expected exactly one effective ADMIN identity; found ',EffectiveAdminCount,N'.')
FROM AdminCount WHERE EffectiveAdminCount<>1
UNION ALL
SELECT 'ADMIN_CAPABILITY_MISSING',CONVERT(nvarchar(150),CapabilityCode)
FROM MissingCapabilities
UNION ALL
SELECT 'ADMIN_MISSING_MANAGE_USERS',admin.ActorReference
FROM EffectiveAdmins admin
WHERE NOT EXISTS (
  SELECT 1 FROM LatestCapabilities decision
  JOIN dbo.CargoRunCapabilities capability ON capability.CapabilityId=decision.CapabilityId
  WHERE decision.RoleId=admin.RoleId AND decision.DecisionRank=1
    AND decision.CapabilityAction='GRANT' AND capability.IsEnabled=1
    AND capability.CapabilityCode='MANAGE_USERS'
)
UNION ALL
SELECT 'ADMIN_MISSING_VIEW_ADMIN_AUDIT',admin.ActorReference
FROM EffectiveAdmins admin
WHERE NOT EXISTS (
  SELECT 1 FROM LatestCapabilities decision
  JOIN dbo.CargoRunCapabilities capability ON capability.CapabilityId=decision.CapabilityId
  WHERE decision.RoleId=admin.RoleId AND decision.DecisionRank=1
    AND decision.CapabilityAction='GRANT' AND capability.IsEnabled=1
    AND capability.CapabilityCode='VIEW_ADMIN_AUDIT'
);
