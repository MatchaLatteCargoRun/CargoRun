-- READ ONLY. Run only after admin-configuration.sql has been deliberately applied.
SET NOCOUNT ON;

SELECT t.name AS TableName,COUNT(c.column_id) AS ColumnCount
FROM sys.tables t
LEFT JOIN sys.columns c ON c.object_id=t.object_id
WHERE t.schema_id=SCHEMA_ID(N'dbo') AND t.name LIKE N'CargoRun%'
GROUP BY t.name ORDER BY t.name;

SELECT OBJECT_NAME(o.parent_object_id) AS TableName,o.type_desc,o.name,
  COALESCE(fk.is_disabled,cc.is_disabled,0) AS is_disabled,
  COALESCE(fk.is_not_trusted,cc.is_not_trusted,0) AS is_not_trusted
FROM sys.objects o
LEFT JOIN sys.foreign_keys fk ON fk.object_id=o.object_id
LEFT JOIN sys.check_constraints cc ON cc.object_id=o.object_id
WHERE OBJECT_NAME(o.parent_object_id) LIKE N'CargoRun%'
  AND o.type IN ('F','C','PK','UQ')
ORDER BY TableName,o.type_desc,o.name;

SELECT OBJECT_NAME(parent_id) AS TableName,name,is_disabled
FROM sys.triggers
WHERE OBJECT_NAME(parent_id) LIKE N'CargoRun%'
ORDER BY TableName,name;

SELECT
  (SELECT COUNT_BIG(*) FROM dbo.CargoRunStations) AS Stations,
  (SELECT COUNT_BIG(*) FROM dbo.CargoRunAirlines) AS Airlines,
  (SELECT COUNT_BIG(*) FROM dbo.CargoRunAirlineProfiles) AS AirlineProfileVersions,
  (SELECT COUNT_BIG(*) FROM dbo.CargoRunShcs) AS Shcs,
  (SELECT COUNT_BIG(*) FROM dbo.CargoRunShcGroups) AS ShcGroups,
  (SELECT COUNT_BIG(*) FROM dbo.CargoRunShcGroupMappings) AS ShcMappings,
  (SELECT COUNT_BIG(*) FROM dbo.CargoRunSlaRules) AS SlaRules,
  (SELECT COUNT_BIG(*) FROM dbo.CargoRunCapabilities) AS Capabilities,
  (SELECT COUNT_BIG(*) FROM dbo.CargoRunRoles) AS Roles,
  (SELECT COUNT_BIG(*) FROM dbo.CargoRunUserRoleAssignments) AS UserRoleAssignments;

-- Every result set below must be empty.
SELECT 'MISSING_TABLE' AS Finding,v.TableName AS Detail
FROM (VALUES
  ('CargoRunStations'),('CargoRunAirlines'),('CargoRunAirlineStations'),('CargoRunAirlineProfiles'),
  ('CargoRunShcs'),('CargoRunShcVersions'),('CargoRunShcGroups'),('CargoRunShcGroupVersions'),
  ('CargoRunShcGroupMappings'),('CargoRunPriorityRules'),('CargoRunSlaRules'),('CargoRunMailRules'),
  ('CargoRunDocumentRules'),('CargoRunLocations'),('CargoRunCapabilities'),('CargoRunRoles'),
  ('CargoRunRoleCapabilities'),('CargoRunUserRoleAssignments'),('CargoRunAdminMessages'),('CargoRunConfigurationAudit')
) v(TableName)
WHERE OBJECT_ID(N'dbo.'+v.TableName,N'U') IS NULL;

SELECT 'DISABLED_OR_UNTRUSTED_CONSTRAINT' AS Finding,CONCAT(OBJECT_NAME(o.parent_object_id),'.',o.name) AS Detail
FROM sys.objects o
LEFT JOIN sys.foreign_keys fk ON fk.object_id=o.object_id
LEFT JOIN sys.check_constraints cc ON cc.object_id=o.object_id
WHERE OBJECT_NAME(o.parent_object_id) LIKE N'CargoRun%'
  AND o.type IN ('F','C')
  AND (COALESCE(fk.is_disabled,cc.is_disabled,0)=1 OR COALESCE(fk.is_not_trusted,cc.is_not_trusted,0)=1);

SELECT 'DISABLED_TRIGGER' AS Finding,CONCAT(OBJECT_NAME(parent_id),'.',name) AS Detail
FROM sys.triggers WHERE OBJECT_NAME(parent_id) LIKE N'CargoRun%' AND is_disabled=1;

SELECT 'INVALID_EFFECTIVE_PERIOD' AS Finding,CONCAT('SLA ',SlaRuleId) AS Detail
FROM dbo.CargoRunSlaRules WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
UNION ALL
SELECT 'INVALID_EFFECTIVE_PERIOD',CONCAT('SHC mapping ',MappingId)
FROM dbo.CargoRunShcGroupMappings WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
UNION ALL
SELECT 'INVALID_EFFECTIVE_PERIOD',CONCAT('Mail rule ',MailRuleId)
FROM dbo.CargoRunMailRules WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom
UNION ALL
SELECT 'INVALID_EFFECTIVE_PERIOD',CONCAT('Document rule ',DocumentRuleId)
FROM dbo.CargoRunDocumentRules WHERE EffectiveTo IS NOT NULL AND EffectiveTo<=EffectiveFrom;

SELECT AirlineId,StationScopeKey,EffectiveFrom,COUNT_BIG(*) AS RecordCount
FROM dbo.CargoRunAirlineProfiles GROUP BY AirlineId,StationScopeKey,EffectiveFrom HAVING COUNT_BIG(*)>1;

SELECT ShcId,ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom,COUNT_BIG(*) AS RecordCount
FROM dbo.CargoRunShcGroupMappings GROUP BY ShcId,ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom HAVING COUNT_BIG(*)>1;

SELECT RuleKey,AirlineScopeKey,StationScopeKey,EffectiveFrom,COUNT_BIG(*) AS RecordCount
FROM dbo.CargoRunSlaRules GROUP BY RuleKey,AirlineScopeKey,StationScopeKey,EffectiveFrom HAVING COUNT_BIG(*)>1;

SELECT 'MISSING_FALLBACK_SEED' AS Finding,v.Code AS Detail
FROM (VALUES('CX'),('UA'),('MH'),('QR'),('TG'),('BI'),('GA'),('VN'),('AI'),('JQ')) v(Code)
LEFT JOIN dbo.CargoRunAirlines a ON a.AirlineCode=v.Code
WHERE a.AirlineId IS NULL;

-- PHASE C AUTHORIZATION GATE. This is expected to return one row after the
-- Phase A schema migration and must be empty before enforcement is enabled.
DECLARE @AuthorizationAsOfDate date=CONVERT(date,SYSUTCDATETIME());

;WITH LatestAssignments AS (
  SELECT u.ActorReference,u.RoleId,u.StationScopeKey,u.AssignmentAction,
    ROW_NUMBER() OVER (
      PARTITION BY u.ActorReference,u.RoleId,u.StationScopeKey
      ORDER BY u.EffectiveFrom DESC,u.UserRoleVersionId DESC
    ) AS DecisionRank
  FROM dbo.CargoRunUserRoleAssignments u
  WHERE u.EffectiveFrom<=@AuthorizationAsOfDate
    AND (u.EffectiveTo IS NULL OR u.EffectiveTo>@AuthorizationAsOfDate)
), LatestCapabilities AS (
  SELECT rc.RoleId,rc.CapabilityId,rc.CapabilityAction,
    ROW_NUMBER() OVER (
      PARTITION BY rc.RoleId,rc.CapabilityId
      ORDER BY rc.EffectiveFrom DESC,rc.RoleCapabilityVersionId DESC
    ) AS DecisionRank
  FROM dbo.CargoRunRoleCapabilities rc
  WHERE rc.EffectiveFrom<=@AuthorizationAsOfDate
    AND (rc.EffectiveTo IS NULL OR rc.EffectiveTo>@AuthorizationAsOfDate)
)
SELECT 'ROLE_ASSIGNMENT_WITHOUT_ADMIN' AS Finding,N'No effective user has MANAGE_USERS and VIEW_ADMIN_AUDIT; do not enable enforcement.' AS Detail
WHERE NOT EXISTS (
  SELECT 1
  FROM LatestAssignments u
  JOIN dbo.CargoRunRoles r ON r.RoleId=u.RoleId AND r.RoleCode='ADMIN' AND r.IsEnabled=1
  JOIN LatestCapabilities rc ON rc.RoleId=u.RoleId AND rc.DecisionRank=1 AND rc.CapabilityAction='GRANT'
  JOIN dbo.CargoRunCapabilities c ON c.CapabilityId=rc.CapabilityId AND c.IsEnabled=1
  WHERE u.DecisionRank=1 AND u.AssignmentAction='GRANT'
    AND c.CapabilityCode IN ('MANAGE_USERS','VIEW_ADMIN_AUDIT')
  GROUP BY u.ActorReference
  HAVING COUNT(DISTINCT c.CapabilityCode)=2
);
