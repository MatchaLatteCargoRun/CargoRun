-- LOCAL TEMPLATE. Run once per CargoRun operational user before deploying H-01.
-- Replace every REPLACE_WITH value locally. Never commit a real userId here.
SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @TargetUserId nvarchar(150)=N'REPLACE_WITH_SWA_USER_ID';
DECLARE @TargetDisplayName nvarchar(150)=N'REPLACE_WITH_DISPLAY_NAME';
DECLARE @RoleCode varchar(40)='REPLACE_WITH_OPERATIONAL_ROLE'; -- OPERATIONS or SUPERVISOR
DECLARE @StationCode varchar(3)='REPLACE_WITH_STATION';
DECLARE @ExecutedByUserId nvarchar(150)=N'REPLACE_WITH_ADMIN_SWA_USER_ID';
DECLARE @EffectiveFrom date=CONVERT(date,SYSUTCDATETIME());
DECLARE @RoleId bigint,@StationId bigint,@LockResult int;

IF NULLIF(LTRIM(RTRIM(@TargetUserId)),N'') IS NULL OR @TargetUserId LIKE N'%REPLACE_WITH%'
  THROW 51510,'Replace @TargetUserId with the stable Azure Static Web Apps userId.',1;
IF @TargetUserId<>LTRIM(RTRIM(@TargetUserId)) OR @TargetUserId LIKE N'%@%'
  THROW 51511,'@TargetUserId must be a stable SWA userId, not an email address.',1;
IF NULLIF(LTRIM(RTRIM(@ExecutedByUserId)),N'') IS NULL OR @ExecutedByUserId LIKE N'%REPLACE_WITH%'
  THROW 51512,'Replace @ExecutedByUserId with the administering stable SWA userId.',1;
IF @ExecutedByUserId<>LTRIM(RTRIM(@ExecutedByUserId)) OR @ExecutedByUserId LIKE N'%@%'
  THROW 51513,'@ExecutedByUserId must be a stable SWA userId, not an email address.',1;
IF @RoleCode NOT IN ('OPERATIONS','SUPERVISOR')
  THROW 51514,'@RoleCode must be OPERATIONS or SUPERVISOR.',1;
IF @StationCode LIKE '%[^A-Z]%' OR LEN(@StationCode)<>3 OR @StationCode LIKE '%REPLACE_WITH%'
  THROW 51515,'Replace @StationCode with an enabled three-letter CargoRun station.',1;
IF NULLIF(LTRIM(RTRIM(@TargetDisplayName)),N'') IS NULL OR @TargetDisplayName LIKE N'%REPLACE_WITH%'
  THROW 51516,'Replace @TargetDisplayName for auditable display evidence.',1;

BEGIN TRY
  BEGIN TRANSACTION;
  EXEC @LockResult=sys.sp_getapplock
    @Resource=N'CargoRun:Configuration:OperationalAuthorizationUsers',
    @LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=15000;
  IF @LockResult<0 THROW 51517,'Could not acquire the operational user assignment lock.',1;

  SELECT @RoleId=RoleId FROM dbo.CargoRunRoles WITH (UPDLOCK,HOLDLOCK)
  WHERE RoleCode=@RoleCode AND IsEnabled=1;
  SELECT @StationId=StationId FROM dbo.CargoRunStations WITH (UPDLOCK,HOLDLOCK)
  WHERE StationCode=@StationCode AND IsEnabled=1;
  IF @RoleId IS NULL THROW 51518,'The selected operational role is missing or disabled. Apply and verify the role seed first.',1;
  IF @StationId IS NULL THROW 51519,'The selected station is missing or disabled.',1;

  ;WITH AssignmentDecisions AS (
    SELECT assignment.RoleId,assignment.AssignmentAction,
      ROW_NUMBER() OVER (
        PARTITION BY assignment.RoleId
        ORDER BY CASE WHEN assignment.StationId IS NULL THEN 0 ELSE 1 END DESC,
          assignment.EffectiveFrom DESC,assignment.UserRoleVersionId DESC
      ) AS DecisionRank
    FROM dbo.CargoRunUserRoleAssignments assignment WITH (UPDLOCK,HOLDLOCK)
    WHERE assignment.ActorReference=@ExecutedByUserId
      AND assignment.EffectiveFrom<=@EffectiveFrom
      AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>@EffectiveFrom)
      AND (assignment.StationId IS NULL OR assignment.StationId=@StationId)
  ), EffectiveRoles AS (
    SELECT RoleId FROM AssignmentDecisions
    WHERE DecisionRank=1 AND AssignmentAction='GRANT'
  ), CapabilityDecisions AS (
    SELECT roleDecision.RoleId,roleDecision.CapabilityId,roleDecision.CapabilityAction,
      ROW_NUMBER() OVER (
        PARTITION BY roleDecision.RoleId,roleDecision.CapabilityId
        ORDER BY roleDecision.EffectiveFrom DESC,roleDecision.RoleCapabilityVersionId DESC
      ) AS DecisionRank
    FROM dbo.CargoRunRoleCapabilities roleDecision WITH (UPDLOCK,HOLDLOCK)
    JOIN EffectiveRoles role ON role.RoleId=roleDecision.RoleId
    WHERE roleDecision.EffectiveFrom<=@EffectiveFrom
      AND (roleDecision.EffectiveTo IS NULL OR roleDecision.EffectiveTo>@EffectiveFrom)
  )
  SELECT @LockResult=COUNT(*)
  FROM CapabilityDecisions decision
  JOIN dbo.CargoRunCapabilities capability ON capability.CapabilityId=decision.CapabilityId
  JOIN dbo.CargoRunRoles role ON role.RoleId=decision.RoleId
  WHERE decision.DecisionRank=1 AND decision.CapabilityAction='GRANT'
    AND capability.CapabilityCode='MANAGE_USERS'
    AND capability.IsEnabled=1 AND role.IsEnabled=1;
  IF @LockResult=0 THROW 51520,'The administering identity does not have an effective MANAGE_USERS grant for this station.',1;

  IF EXISTS (
    SELECT 1 FROM dbo.CargoRunUserRoleAssignments assignment WITH (UPDLOCK,HOLDLOCK)
    JOIN dbo.CargoRunRoles role ON role.RoleId=assignment.RoleId
    WHERE assignment.ActorReference=@TargetUserId AND role.RoleCode IN ('OPERATIONS','SUPERVISOR')
      AND assignment.StationId IS NULL AND assignment.AssignmentAction='GRANT'
      AND assignment.EffectiveFrom<=@EffectiveFrom
      AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>@EffectiveFrom)
  ) THROW 51521,'The target already has a global operational role. Review and replace it with explicit station scope.',1;

  IF EXISTS (
    SELECT 1 FROM dbo.CargoRunUserRoleAssignments WITH (UPDLOCK,HOLDLOCK)
    WHERE ActorReference=@TargetUserId AND RoleId=@RoleId AND StationId=@StationId
      AND EffectiveFrom=@EffectiveFrom AND AssignmentAction='REVOKE'
  ) THROW 51522,'The target has a same-day REVOKE for this role and station. Review immutable assignment history.',1;

  IF NOT EXISTS (
    SELECT 1 FROM (
      SELECT AssignmentAction,
        ROW_NUMBER() OVER (ORDER BY EffectiveFrom DESC,UserRoleVersionId DESC) AS DecisionRank
      FROM dbo.CargoRunUserRoleAssignments WITH (UPDLOCK,HOLDLOCK)
      WHERE ActorReference=@TargetUserId AND RoleId=@RoleId AND StationId=@StationId
        AND EffectiveFrom<=@EffectiveFrom
        AND (EffectiveTo IS NULL OR EffectiveTo>@EffectiveFrom)
    ) currentAssignment
    WHERE DecisionRank=1 AND AssignmentAction='GRANT'
  )
  BEGIN
    INSERT dbo.CargoRunUserRoleAssignments
      (ActorReference,ActorDisplayName,RoleId,StationId,AssignmentAction,
       EffectiveFrom,EffectiveTo,CreatedByReference)
    VALUES(@TargetUserId,@TargetDisplayName,@RoleId,@StationId,'GRANT',
      @EffectiveFrom,NULL,@ExecutedByUserId);

    INSERT dbo.CargoRunConfigurationAudit
      (Operation,EntityType,EntityId,EffectiveFrom,OldValueJson,NewValueJson,
       ActorReference,ActorDisplayName)
    VALUES('ASSIGN_OPERATIONAL_ROLE','UserRoleAssignment',@TargetUserId,@EffectiveFrom,NULL,
      (SELECT @TargetUserId AS actorReference,@RoleCode AS roleCode,@StationCode AS stationCode
       FOR JSON PATH,WITHOUT_ARRAY_WRAPPER),
      @ExecutedByUserId,N'Operational access administrator');
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
