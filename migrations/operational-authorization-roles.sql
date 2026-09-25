-- Seeds the two operational roles used by the server-enforced H-01 boundary.
-- This changes configuration metadata only. Assign users separately with
-- operational-authorization-user.sql before deploying enforcement code.
SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @EffectiveFrom date=CONVERT(date,SYSUTCDATETIME());
DECLARE @SeedActor nvarchar(150)=N'MIGRATION_OPERATIONAL_AUTHORIZATION';
DECLARE @LockResult int;

DECLARE @Roles table(
  RoleCode varchar(40) NOT NULL PRIMARY KEY,
  DisplayName nvarchar(100) NOT NULL,
  Description nvarchar(500) NOT NULL
);
INSERT @Roles VALUES
  ('OPERATIONS',N'Operations',N'Station-scoped CargoRun operational mutations'),
  ('SUPERVISOR',N'Supervisor',N'Station-scoped CargoRun operations and flight finalisation');

DECLARE @RoleCapabilities table(
  RoleCode varchar(40) NOT NULL,
  CapabilityCode varchar(60) NOT NULL,
  PRIMARY KEY(RoleCode,CapabilityCode)
);
INSERT @RoleCapabilities VALUES
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

BEGIN TRY
  BEGIN TRANSACTION;

  EXEC @LockResult=sys.sp_getapplock
    @Resource=N'CargoRun:Configuration:OperationalAuthorizationRoles',
    @LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=15000;
  IF @LockResult<0 THROW 51500,'Could not acquire the operational authorization role lock.',1;

  IF OBJECT_ID(N'dbo.CargoRunCapabilities',N'U') IS NULL
     OR OBJECT_ID(N'dbo.CargoRunRoles',N'U') IS NULL
     OR OBJECT_ID(N'dbo.CargoRunRoleCapabilities',N'U') IS NULL
     OR OBJECT_ID(N'dbo.CargoRunConfigurationAudit',N'U') IS NULL
    THROW 51501,'The CargoRun authorization configuration schema is incomplete.',1;

  IF EXISTS (
    SELECT 1 FROM @RoleCapabilities required
    LEFT JOIN dbo.CargoRunCapabilities capability WITH (UPDLOCK,HOLDLOCK)
      ON capability.CapabilityCode=required.CapabilityCode AND capability.IsEnabled=1
    WHERE capability.CapabilityId IS NULL
  ) THROW 51502,'One or more required operational capabilities are missing or disabled.',1;

  IF EXISTS (
    SELECT 1 FROM @Roles required
    JOIN dbo.CargoRunRoles role WITH (UPDLOCK,HOLDLOCK) ON role.RoleCode=required.RoleCode
    WHERE role.IsEnabled=0
  ) THROW 51503,'An existing operational role is disabled. Review it before continuing.',1;

  DECLARE @ChangedRoles table(RoleId bigint NOT NULL PRIMARY KEY);
  INSERT dbo.CargoRunRoles(RoleCode,DisplayName,Description,IsEnabled,CreatedByReference)
    OUTPUT INSERTED.RoleId INTO @ChangedRoles(RoleId)
  SELECT required.RoleCode,required.DisplayName,required.Description,1,@SeedActor
  FROM @Roles required
  WHERE NOT EXISTS (SELECT 1 FROM dbo.CargoRunRoles role WITH (UPDLOCK,HOLDLOCK) WHERE role.RoleCode=required.RoleCode);

  IF EXISTS (
    SELECT 1
    FROM dbo.CargoRunRoles role
    CROSS APPLY (
      SELECT capability.CapabilityCode,decision.CapabilityAction,
        ROW_NUMBER() OVER (PARTITION BY decision.CapabilityId ORDER BY decision.EffectiveFrom DESC,decision.RoleCapabilityVersionId DESC) AS DecisionRank
      FROM dbo.CargoRunRoleCapabilities decision
      JOIN dbo.CargoRunCapabilities capability ON capability.CapabilityId=decision.CapabilityId
      WHERE decision.RoleId=role.RoleId AND decision.EffectiveFrom<=@EffectiveFrom
        AND (decision.EffectiveTo IS NULL OR decision.EffectiveTo>@EffectiveFrom)
    ) currentDecision
    WHERE role.RoleCode IN ('OPERATIONS','SUPERVISOR')
      AND currentDecision.DecisionRank=1 AND currentDecision.CapabilityAction='GRANT'
      AND NOT EXISTS (
        SELECT 1 FROM @RoleCapabilities expected
        WHERE expected.RoleCode=role.RoleCode AND expected.CapabilityCode=currentDecision.CapabilityCode
      )
  ) THROW 51504,'An operational role already has an unexpected effective capability. Review rather than silently broadening access.',1;

  IF EXISTS (
    SELECT 1
    FROM @RoleCapabilities expected
    JOIN dbo.CargoRunRoles role ON role.RoleCode=expected.RoleCode
    JOIN dbo.CargoRunCapabilities capability ON capability.CapabilityCode=expected.CapabilityCode
    JOIN dbo.CargoRunRoleCapabilities decision WITH (UPDLOCK,HOLDLOCK)
      ON decision.RoleId=role.RoleId AND decision.CapabilityId=capability.CapabilityId
     AND decision.EffectiveFrom=@EffectiveFrom AND decision.CapabilityAction='REVOKE'
  ) THROW 51505,'A required role capability has a same-day REVOKE. Review immutable authorization history.',1;

  DECLARE @ChangedCapabilities table(RoleId bigint NOT NULL,CapabilityId bigint NOT NULL,PRIMARY KEY(RoleId,CapabilityId));
  INSERT dbo.CargoRunRoleCapabilities
    (RoleId,CapabilityId,CapabilityAction,EffectiveFrom,EffectiveTo,CreatedByReference)
    OUTPUT INSERTED.RoleId,INSERTED.CapabilityId INTO @ChangedCapabilities(RoleId,CapabilityId)
  SELECT role.RoleId,capability.CapabilityId,'GRANT',@EffectiveFrom,NULL,@SeedActor
  FROM @RoleCapabilities expected
  JOIN dbo.CargoRunRoles role ON role.RoleCode=expected.RoleCode
  JOIN dbo.CargoRunCapabilities capability ON capability.CapabilityCode=expected.CapabilityCode
  OUTER APPLY (
    SELECT TOP(1) decision.CapabilityAction
    FROM dbo.CargoRunRoleCapabilities decision WITH (UPDLOCK,HOLDLOCK)
    WHERE decision.RoleId=role.RoleId AND decision.CapabilityId=capability.CapabilityId
      AND decision.EffectiveFrom<=@EffectiveFrom
      AND (decision.EffectiveTo IS NULL OR decision.EffectiveTo>@EffectiveFrom)
    ORDER BY decision.EffectiveFrom DESC,decision.RoleCapabilityVersionId DESC
  ) currentDecision
  WHERE currentDecision.CapabilityAction IS NULL OR currentDecision.CapabilityAction='REVOKE';

  INSERT dbo.CargoRunConfigurationAudit
    (Operation,EntityType,EntityId,EffectiveFrom,OldValueJson,NewValueJson,
     ActorReference,ActorDisplayName)
  SELECT 'SEED_OPERATIONAL_ROLE','Role',role.RoleCode,@EffectiveFrom,NULL,
    (SELECT role.RoleCode AS roleCode,
      JSON_QUERY((SELECT expected.CapabilityCode AS capabilityCode
        FROM @RoleCapabilities expected WHERE expected.RoleCode=role.RoleCode
        ORDER BY expected.CapabilityCode FOR JSON PATH)) AS capabilities
      FOR JSON PATH,WITHOUT_ARRAY_WRAPPER),
    @SeedActor,N'Operational authorization migration'
  FROM dbo.CargoRunRoles role
  WHERE role.RoleCode IN ('OPERATIONS','SUPERVISOR')
    AND (EXISTS (SELECT 1 FROM @ChangedRoles changed WHERE changed.RoleId=role.RoleId)
      OR EXISTS (SELECT 1 FROM @ChangedCapabilities changed WHERE changed.RoleId=role.RoleId));

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
