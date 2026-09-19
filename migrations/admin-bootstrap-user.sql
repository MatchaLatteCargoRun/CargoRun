-- ONE-TIME TEMPLATE. Copy this file outside the repository, replace the placeholder,
-- review the resulting copy, and execute that copy with an approved migration identity.
-- The value must be the stable Azure Static Web Apps clientPrincipal.userId.
-- Do not use clientPrincipal.userDetails, an email address, or a display name.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @BootstrapUserId nvarchar(150)=N'__REPLACE_WITH_AZURE_SWA_USER_ID__';
DECLARE @EffectiveFrom date=CONVERT(date,SYSUTCDATETIME());
DECLARE @BootstrapActorReference nvarchar(150)=LEFT(CONCAT(N'SQL:',ORIGINAL_LOGIN()),150);
DECLARE @BootstrapActorDisplayName nvarchar(150)=LEFT(CONCAT(N'CargoRun SQL bootstrap: ',ORIGINAL_LOGIN()),150);
DECLARE @AdminRoleId bigint;
DECLARE @LockResult int;
DECLARE @RoleCreated bit=0;
DECLARE @CapabilityGrantsAdded int=0;
DECLARE @AssignmentAdded bit=0;

IF NULLIF(LTRIM(RTRIM(@BootstrapUserId)),N'') IS NULL
   OR @BootstrapUserId LIKE N'%REPLACE_WITH%'
  THROW 51400,'Replace @BootstrapUserId with the stable Azure Static Web Apps userId before execution.',1;

IF @BootstrapUserId<>LTRIM(RTRIM(@BootstrapUserId))
  THROW 51401,'@BootstrapUserId must not contain leading or trailing whitespace.',1;

IF @BootstrapUserId LIKE N'%@%'
  THROW 51402,'@BootstrapUserId appears to be an email address. Use the stable Azure Static Web Apps userId.',1;

IF OBJECT_ID(N'dbo.CargoRunCapabilities',N'U') IS NULL
   OR OBJECT_ID(N'dbo.CargoRunRoles',N'U') IS NULL
   OR OBJECT_ID(N'dbo.CargoRunRoleCapabilities',N'U') IS NULL
   OR OBJECT_ID(N'dbo.CargoRunUserRoleAssignments',N'U') IS NULL
   OR OBJECT_ID(N'dbo.CargoRunConfigurationAudit',N'U') IS NULL
  THROW 51403,'The CargoRun Admin configuration schema is incomplete. Do not bootstrap.',1;

DECLARE @RequiredCapabilities TABLE (
  CapabilityCode varchar(60) NOT NULL PRIMARY KEY
);

INSERT @RequiredCapabilities(CapabilityCode) VALUES
  ('VIEW_FLIGHTS'),('MOVE_ULD'),('SCAN_ULD'),('VIEW_PRIORITY'),
  ('REQUEST_OFFLOAD'),('COLLECT_OFFLOAD'),('COMPLETE_OFFLOAD'),
  ('SET_IN_BLOCK'),('SET_ETD'),('UPLOAD_FLIGHT_DATA'),
  ('CONFIRM_EXPORT_FINAL'),('FINALISE_FLIGHT'),('VIEW_FLIGHT_STATEMENT'),
  ('VIEW_HISTORY'),('EXPORT_HISTORY'),('VIEW_SUPERVISOR'),
  ('PUBLISH_MESSAGES'),('EDIT_AIRLINE_RULES'),('EDIT_SLA_RULES'),
  ('EDIT_SHC_RULES'),('MANAGE_USERS'),('VIEW_ADMIN_AUDIT');

BEGIN TRY
  BEGIN TRANSACTION;

  EXEC @LockResult=sys.sp_getapplock
    @Resource=N'CargoRun:AdminBootstrap',
    @LockMode='Exclusive',
    @LockOwner='Transaction',
    @LockTimeout=15000;

  IF @LockResult<0
  BEGIN
    DECLARE @LockMessage nvarchar(2048)=CONCAT(N'Could not acquire the CargoRun Admin bootstrap lock. sp_getapplock returned ',@LockResult,N'.');
    THROW 51404,@LockMessage,1;
  END;

  IF EXISTS (
    SELECT 1
    FROM @RequiredCapabilities required
    LEFT JOIN dbo.CargoRunCapabilities capability WITH (UPDLOCK,HOLDLOCK)
      ON capability.CapabilityCode=required.CapabilityCode AND capability.IsEnabled=1
    WHERE capability.CapabilityId IS NULL
  )
  BEGIN
    DECLARE @MissingCapabilities nvarchar(2048)=(
      SELECT STRING_AGG(CONVERT(nvarchar(max),required.CapabilityCode),N', ')
      FROM @RequiredCapabilities required
      LEFT JOIN dbo.CargoRunCapabilities capability
        ON capability.CapabilityCode=required.CapabilityCode AND capability.IsEnabled=1
      WHERE capability.CapabilityId IS NULL
    );
    DECLARE @MissingMessage nvarchar(2048)=CONCAT(N'Required ADMIN capabilities are missing or disabled: ',@MissingCapabilities);
    THROW 51405,@MissingMessage,1;
  END;

  SELECT @AdminRoleId=RoleId
  FROM dbo.CargoRunRoles WITH (UPDLOCK,HOLDLOCK)
  WHERE RoleCode='ADMIN';

  IF @AdminRoleId IS NULL
  BEGIN
    INSERT dbo.CargoRunRoles(RoleCode,DisplayName,Description,IsEnabled,CreatedByReference)
    VALUES('ADMIN',N'Administrator',N'CargoRun system administrator',1,@BootstrapActorReference);
    SET @AdminRoleId=CONVERT(bigint,SCOPE_IDENTITY());
    SET @RoleCreated=1;
  END
  ELSE IF EXISTS (SELECT 1 FROM dbo.CargoRunRoles WHERE RoleId=@AdminRoleId AND IsEnabled=0)
    THROW 51406,'The existing ADMIN role is disabled. Review it rather than silently re-enabling it.',1;

  -- A same-day REVOKE occupies the immutable version key. Fail for review instead
  -- of attempting to overwrite evidence or guessing which decision should win.
  IF EXISTS (
    SELECT 1
    FROM @RequiredCapabilities required
    JOIN dbo.CargoRunCapabilities capability ON capability.CapabilityCode=required.CapabilityCode
    JOIN dbo.CargoRunRoleCapabilities decision WITH (UPDLOCK,HOLDLOCK)
      ON decision.RoleId=@AdminRoleId AND decision.CapabilityId=capability.CapabilityId
     AND decision.EffectiveFrom=@EffectiveFrom AND decision.CapabilityAction='REVOKE'
     AND (decision.EffectiveTo IS NULL OR decision.EffectiveTo>@EffectiveFrom)
  )
    THROW 51407,'A required ADMIN capability has a same-day REVOKE. Review the immutable decision history.',1;

  INSERT dbo.CargoRunRoleCapabilities
    (RoleId,CapabilityId,CapabilityAction,EffectiveFrom,EffectiveTo,CreatedByReference)
  SELECT @AdminRoleId,capability.CapabilityId,'GRANT',@EffectiveFrom,NULL,@BootstrapActorReference
  FROM @RequiredCapabilities required
  JOIN dbo.CargoRunCapabilities capability ON capability.CapabilityCode=required.CapabilityCode
  OUTER APPLY (
    SELECT TOP(1) decision.CapabilityAction
    FROM dbo.CargoRunRoleCapabilities decision WITH (UPDLOCK,HOLDLOCK)
    WHERE decision.RoleId=@AdminRoleId
      AND decision.CapabilityId=capability.CapabilityId
      AND decision.EffectiveFrom<=@EffectiveFrom
      AND (decision.EffectiveTo IS NULL OR decision.EffectiveTo>@EffectiveFrom)
    ORDER BY decision.EffectiveFrom DESC,decision.RoleCapabilityVersionId DESC
  ) currentDecision
  WHERE currentDecision.CapabilityAction IS NULL OR currentDecision.CapabilityAction='REVOKE';
  SET @CapabilityGrantsAdded=@@ROWCOUNT;

  -- Bootstrap is deliberately single-identity. An existing effective ADMIN for
  -- another stable actor is a review condition, never an identity to replace.
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT assignment.ActorReference,assignment.AssignmentAction,
        ROW_NUMBER() OVER (
          PARTITION BY assignment.ActorReference,assignment.RoleId,assignment.StationScopeKey
          ORDER BY assignment.EffectiveFrom DESC,assignment.UserRoleVersionId DESC
        ) AS DecisionRank
      FROM dbo.CargoRunUserRoleAssignments assignment WITH (UPDLOCK,HOLDLOCK)
      WHERE assignment.RoleId=@AdminRoleId
        AND assignment.EffectiveFrom<=@EffectiveFrom
        AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>@EffectiveFrom)
    ) currentAssignments
    WHERE currentAssignments.DecisionRank=1
      AND currentAssignments.AssignmentAction='GRANT'
      AND currentAssignments.ActorReference<>@BootstrapUserId
  )
    THROW 51408,'Another stable identity already has an effective ADMIN assignment. Bootstrap requires review.',1;

  IF EXISTS (
    SELECT 1
    FROM dbo.CargoRunUserRoleAssignments assignment WITH (UPDLOCK,HOLDLOCK)
    WHERE assignment.ActorReference=@BootstrapUserId
      AND assignment.RoleId=@AdminRoleId
      AND assignment.StationId IS NULL
      AND assignment.EffectiveFrom=@EffectiveFrom
      AND assignment.AssignmentAction='REVOKE'
      AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>@EffectiveFrom)
  )
    THROW 51409,'The target identity has a same-day ADMIN REVOKE. Review the immutable assignment history.',1;

  IF NOT EXISTS (
    SELECT 1
    FROM (
      SELECT assignment.AssignmentAction,
        ROW_NUMBER() OVER (
          ORDER BY assignment.EffectiveFrom DESC,assignment.UserRoleVersionId DESC
        ) AS DecisionRank
      FROM dbo.CargoRunUserRoleAssignments assignment WITH (UPDLOCK,HOLDLOCK)
      WHERE assignment.ActorReference=@BootstrapUserId
        AND assignment.RoleId=@AdminRoleId
        AND assignment.StationId IS NULL
        AND assignment.EffectiveFrom<=@EffectiveFrom
        AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>@EffectiveFrom)
    ) currentAssignment
    WHERE currentAssignment.DecisionRank=1 AND currentAssignment.AssignmentAction='GRANT'
  )
  BEGIN
    INSERT dbo.CargoRunUserRoleAssignments
      (ActorReference,ActorDisplayName,RoleId,StationId,AssignmentAction,EffectiveFrom,EffectiveTo,CreatedByReference)
    VALUES(@BootstrapUserId,NULL,@AdminRoleId,NULL,'GRANT',@EffectiveFrom,NULL,@BootstrapActorReference);
    SET @AssignmentAdded=1;
  END;

  IF (
    SELECT COUNT_BIG(DISTINCT currentAssignments.ActorReference)
    FROM (
      SELECT assignment.ActorReference,assignment.AssignmentAction,
        ROW_NUMBER() OVER (
          PARTITION BY assignment.ActorReference,assignment.RoleId,assignment.StationScopeKey
          ORDER BY assignment.EffectiveFrom DESC,assignment.UserRoleVersionId DESC
        ) AS DecisionRank
      FROM dbo.CargoRunUserRoleAssignments assignment WITH (UPDLOCK,HOLDLOCK)
      WHERE assignment.RoleId=@AdminRoleId
        AND assignment.EffectiveFrom<=@EffectiveFrom
        AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>@EffectiveFrom)
    ) currentAssignments
    WHERE currentAssignments.DecisionRank=1 AND currentAssignments.AssignmentAction='GRANT'
  )<>1
    THROW 51410,'Bootstrap did not produce exactly one effective ADMIN identity.',1;

  IF NOT EXISTS (
    SELECT 1
    FROM (
      SELECT assignment.ActorReference,assignment.AssignmentAction,
        ROW_NUMBER() OVER (
          PARTITION BY assignment.ActorReference,assignment.RoleId,assignment.StationScopeKey
          ORDER BY assignment.EffectiveFrom DESC,assignment.UserRoleVersionId DESC
        ) AS DecisionRank
      FROM dbo.CargoRunUserRoleAssignments assignment WITH (UPDLOCK,HOLDLOCK)
      WHERE assignment.RoleId=@AdminRoleId
        AND assignment.EffectiveFrom<=@EffectiveFrom
        AND (assignment.EffectiveTo IS NULL OR assignment.EffectiveTo>@EffectiveFrom)
    ) currentAssignments
    WHERE currentAssignments.DecisionRank=1
      AND currentAssignments.AssignmentAction='GRANT'
      AND currentAssignments.ActorReference=@BootstrapUserId
  )
    THROW 51411,'The supplied stable userId is not the sole effective ADMIN identity.',1;

  IF @RoleCreated=1 OR @CapabilityGrantsAdded>0 OR @AssignmentAdded=1
  BEGIN
    DECLARE @AuditValue nvarchar(max)=(
      SELECT @AdminRoleId AS roleId,'ADMIN' AS roleCode,@BootstrapUserId AS actorReference,
        @CapabilityGrantsAdded AS capabilityGrantsAdded,@AssignmentAdded AS assignmentAdded,
        ORIGINAL_LOGIN() AS executedBySqlLogin
      FOR JSON PATH,WITHOUT_ARRAY_WRAPPER
    );

    INSERT dbo.CargoRunConfigurationAudit
      (Operation,EntityType,EntityId,EffectiveFrom,OldValueJson,NewValueJson,ActorReference,ActorDisplayName)
    VALUES
      ('ADMIN_BOOTSTRAPPED','USER_ROLE_ASSIGNMENT',@BootstrapUserId,@EffectiveFrom,NULL,@AuditValue,
       @BootstrapActorReference,@BootstrapActorDisplayName);
  END;

  COMMIT TRANSACTION;

  SELECT @AdminRoleId AS AdminRoleId,@BootstrapUserId AS ActorReference,@EffectiveFrom AS EffectiveFrom,
    @RoleCreated AS RoleCreated,@CapabilityGrantsAdded AS CapabilityGrantsAdded,
    @AssignmentAdded AS AssignmentAdded,
    CASE WHEN @RoleCreated=0 AND @CapabilityGrantsAdded=0 AND @AssignmentAdded=0 THEN 1 ELSE 0 END AS AlreadyBootstrapped;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
