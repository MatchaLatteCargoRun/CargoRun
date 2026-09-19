-- CargoRun Admin Centre foundation. ADDITIVE MIGRATION - DO NOT run without preflight review.
SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRY
  BEGIN TRANSACTION;

  IF EXISTS (
    SELECT 1 FROM sys.tables
    WHERE schema_id=SCHEMA_ID(N'dbo') AND name IN (
      N'CargoRunStations',N'CargoRunAirlines',N'CargoRunAirlineStations',N'CargoRunAirlineProfiles',
      N'CargoRunShcs',N'CargoRunShcVersions',N'CargoRunShcGroups',N'CargoRunShcGroupVersions',
      N'CargoRunShcGroupMappings',N'CargoRunPriorityRules',N'CargoRunSlaRules',N'CargoRunMailRules',
      N'CargoRunDocumentRules',N'CargoRunLocations',N'CargoRunCapabilities',N'CargoRunRoles',
      N'CargoRunRoleCapabilities',N'CargoRunUserRoleAssignments',N'CargoRunAdminMessages',
      N'CargoRunConfigurationAudit'
    )
  ) THROW 51300, 'CargoRun Admin configuration objects already exist. Stop and run verification; do not merge schemas automatically.', 1;

  CREATE TABLE dbo.CargoRunStations (
    StationId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunStations PRIMARY KEY,
    StationCode varchar(3) NOT NULL,
    DisplayName nvarchar(100) NOT NULL,
    TimeZoneId nvarchar(100) NOT NULL,
    IsEnabled bit NOT NULL CONSTRAINT DF_CargoRunStations_IsEnabled DEFAULT(1),
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunStations_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT UQ_CargoRunStations_Code UNIQUE(StationCode),
    CONSTRAINT CK_CargoRunStations_Code CHECK(StationCode NOT LIKE '%[^A-Z]%' AND LEN(StationCode)=3)
  );

  CREATE TABLE dbo.CargoRunAirlines (
    AirlineId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunAirlines PRIMARY KEY,
    AirlineCode varchar(3) NOT NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunAirlines_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT UQ_CargoRunAirlines_Code UNIQUE(AirlineCode),
    CONSTRAINT CK_CargoRunAirlines_Code CHECK(AirlineCode NOT LIKE '%[^A-Z0-9]%' AND LEN(AirlineCode) BETWEEN 2 AND 3)
  );

  CREATE TABLE dbo.CargoRunAirlineStations (
    AirlineStationVersionId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunAirlineStations PRIMARY KEY,
    AirlineId bigint NOT NULL,
    StationId bigint NOT NULL,
    AssignmentAction varchar(10) NOT NULL,
    EffectiveFrom date NOT NULL,
    EffectiveTo date NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunAirlineStations_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunAirlineStations_Airline FOREIGN KEY(AirlineId) REFERENCES dbo.CargoRunAirlines(AirlineId),
    CONSTRAINT FK_CargoRunAirlineStations_Station FOREIGN KEY(StationId) REFERENCES dbo.CargoRunStations(StationId),
    CONSTRAINT UQ_CargoRunAirlineStations_Version UNIQUE(AirlineId,StationId,EffectiveFrom),
    CONSTRAINT CK_CargoRunAirlineStations_Action CHECK(AssignmentAction IN ('ENABLE','DISABLE')),
    CONSTRAINT CK_CargoRunAirlineStations_Dates CHECK(EffectiveTo IS NULL OR EffectiveTo>EffectiveFrom)
  );

  CREATE TABLE dbo.CargoRunAirlineProfiles (
    ProfileVersionId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunAirlineProfiles PRIMARY KEY,
    AirlineId bigint NOT NULL,
    StationId bigint NULL,
    StationScopeKey AS ISNULL(StationId,CONVERT(bigint,0)) PERSISTED,
    DisplayName nvarchar(100) NOT NULL,
    BadgeColour varchar(7) NOT NULL,
    BrightBadge bit NOT NULL CONSTRAINT DF_CargoRunAirlineProfiles_Bright DEFAULT(0),
    IsEnabled bit NOT NULL,
    OperationalNotes nvarchar(1000) NULL,
    EffectiveFrom date NOT NULL,
    EffectiveTo date NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunAirlineProfiles_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunAirlineProfiles_Airline FOREIGN KEY(AirlineId) REFERENCES dbo.CargoRunAirlines(AirlineId),
    CONSTRAINT FK_CargoRunAirlineProfiles_Station FOREIGN KEY(StationId) REFERENCES dbo.CargoRunStations(StationId),
    CONSTRAINT UQ_CargoRunAirlineProfiles_Version UNIQUE(AirlineId,StationScopeKey,EffectiveFrom),
    CONSTRAINT CK_CargoRunAirlineProfiles_Colour CHECK(LEN(BadgeColour)=7 AND LEFT(BadgeColour,1)='#' AND SUBSTRING(BadgeColour,2,6) NOT LIKE '%[^0-9A-Fa-f]%'),
    CONSTRAINT CK_CargoRunAirlineProfiles_Dates CHECK(EffectiveTo IS NULL OR EffectiveTo>EffectiveFrom)
  );

  CREATE TABLE dbo.CargoRunShcs (
    ShcId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunShcs PRIMARY KEY,
    ShcCode varchar(10) NOT NULL,
    CarrierAirlineId bigint NULL,
    CarrierScopeKey AS ISNULL(CarrierAirlineId,CONVERT(bigint,0)) PERSISTED,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunShcs_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunShcs_Carrier FOREIGN KEY(CarrierAirlineId) REFERENCES dbo.CargoRunAirlines(AirlineId),
    CONSTRAINT UQ_CargoRunShcs_CodeCarrier UNIQUE(ShcCode,CarrierScopeKey),
    CONSTRAINT CK_CargoRunShcs_Code CHECK(LEN(ShcCode) BETWEEN 2 AND 10 AND ShcCode NOT LIKE '%[^A-Z0-9]%')
  );

  CREATE TABLE dbo.CargoRunShcVersions (
    ShcVersionId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunShcVersions PRIMARY KEY,
    ShcId bigint NOT NULL,
    Description nvarchar(200) NOT NULL,
    StandardIndicator varchar(20) NOT NULL,
    IsEnabled bit NOT NULL,
    EffectiveFrom date NOT NULL,
    EffectiveTo date NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunShcVersions_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunShcVersions_Shc FOREIGN KEY(ShcId) REFERENCES dbo.CargoRunShcs(ShcId),
    CONSTRAINT UQ_CargoRunShcVersions_Version UNIQUE(ShcId,EffectiveFrom),
    CONSTRAINT CK_CargoRunShcVersions_Indicator CHECK(StandardIndicator IN ('STANDARD','CARRIER_SPECIFIC','UNKNOWN')),
    CONSTRAINT CK_CargoRunShcVersions_Dates CHECK(EffectiveTo IS NULL OR EffectiveTo>EffectiveFrom)
  );

  CREATE TABLE dbo.CargoRunShcGroups (
    ShcGroupId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunShcGroups PRIMARY KEY,
    GroupKey varchar(40) NOT NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunShcGroups_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT UQ_CargoRunShcGroups_Key UNIQUE(GroupKey),
    CONSTRAINT CK_CargoRunShcGroups_Key CHECK(LEN(GroupKey) BETWEEN 2 AND 40 AND GroupKey NOT LIKE '%[^A-Z0-9_]%')
  );

  CREATE TABLE dbo.CargoRunShcGroupVersions (
    GroupVersionId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunShcGroupVersions PRIMARY KEY,
    ShcGroupId bigint NOT NULL,
    DisplayToken nvarchar(20) NOT NULL,
    DisplayName nvarchar(100) NOT NULL,
    Description nvarchar(500) NULL,
    DisplayOrder int NOT NULL,
    VisualClass varchar(30) NULL,
    IsEnabled bit NOT NULL,
    EffectiveFrom date NOT NULL,
    EffectiveTo date NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunShcGroupVersions_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunShcGroupVersions_Group FOREIGN KEY(ShcGroupId) REFERENCES dbo.CargoRunShcGroups(ShcGroupId),
    CONSTRAINT UQ_CargoRunShcGroupVersions_Version UNIQUE(ShcGroupId,EffectiveFrom),
    CONSTRAINT CK_CargoRunShcGroupVersions_Order CHECK(DisplayOrder BETWEEN 0 AND 10000),
    CONSTRAINT CK_CargoRunShcGroupVersions_Dates CHECK(EffectiveTo IS NULL OR EffectiveTo>EffectiveFrom)
  );

  CREATE TABLE dbo.CargoRunShcGroupMappings (
    MappingId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunShcGroupMappings PRIMARY KEY,
    ShcId bigint NOT NULL,
    ShcGroupId bigint NOT NULL,
    AirlineId bigint NULL,
    StationId bigint NULL,
    AirlineScopeKey AS ISNULL(AirlineId,CONVERT(bigint,0)) PERSISTED,
    StationScopeKey AS ISNULL(StationId,CONVERT(bigint,0)) PERSISTED,
    MappingAction varchar(10) NOT NULL,
    EffectiveFrom date NOT NULL,
    EffectiveTo date NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunShcGroupMappings_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunShcGroupMappings_Shc FOREIGN KEY(ShcId) REFERENCES dbo.CargoRunShcs(ShcId),
    CONSTRAINT FK_CargoRunShcGroupMappings_Group FOREIGN KEY(ShcGroupId) REFERENCES dbo.CargoRunShcGroups(ShcGroupId),
    CONSTRAINT FK_CargoRunShcGroupMappings_Airline FOREIGN KEY(AirlineId) REFERENCES dbo.CargoRunAirlines(AirlineId),
    CONSTRAINT FK_CargoRunShcGroupMappings_Station FOREIGN KEY(StationId) REFERENCES dbo.CargoRunStations(StationId),
    CONSTRAINT UQ_CargoRunShcGroupMappings_Version UNIQUE(ShcId,ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom),
    CONSTRAINT CK_CargoRunShcGroupMappings_Action CHECK(MappingAction IN ('INCLUDE','EXCLUDE')),
    CONSTRAINT CK_CargoRunShcGroupMappings_Dates CHECK(EffectiveTo IS NULL OR EffectiveTo>EffectiveFrom)
  );

  CREATE TABLE dbo.CargoRunSlaRules (
    SlaRuleId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunSlaRules PRIMARY KEY,
    RuleKey varchar(50) NOT NULL,
    AirlineId bigint NULL,
    StationId bigint NULL,
    AirlineScopeKey AS ISNULL(AirlineId,CONVERT(bigint,0)) PERSISTED,
    StationScopeKey AS ISNULL(StationId,CONVERT(bigint,0)) PERSISTED,
    Direction varchar(10) NULL,
    StartEvent varchar(50) NOT NULL,
    TargetEvent varchar(50) NOT NULL,
    TargetMinutes int NOT NULL,
    WarningMinutes int NOT NULL,
    BreachMinutes int NOT NULL,
    IsEnabled bit NOT NULL,
    ApplicabilityNotes nvarchar(500) NULL,
    EffectiveFrom date NOT NULL,
    EffectiveTo date NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunSlaRules_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunSlaRules_Airline FOREIGN KEY(AirlineId) REFERENCES dbo.CargoRunAirlines(AirlineId),
    CONSTRAINT FK_CargoRunSlaRules_Station FOREIGN KEY(StationId) REFERENCES dbo.CargoRunStations(StationId),
    CONSTRAINT UQ_CargoRunSlaRules_Version UNIQUE(RuleKey,AirlineScopeKey,StationScopeKey,EffectiveFrom),
    CONSTRAINT CK_CargoRunSlaRules_Direction CHECK(Direction IS NULL OR Direction IN ('IMPORT','EXPORT')),
    CONSTRAINT CK_CargoRunSlaRules_Minutes CHECK(TargetMinutes BETWEEN -1440 AND 10080 AND WarningMinutes BETWEEN -1440 AND 10080 AND BreachMinutes BETWEEN -1440 AND 10080),
    CONSTRAINT CK_CargoRunSlaRules_Dates CHECK(EffectiveTo IS NULL OR EffectiveTo>EffectiveFrom)
  );

  CREATE TABLE dbo.CargoRunPriorityRules (
    PriorityRuleId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunPriorityRules PRIMARY KEY,
    ShcGroupId bigint NOT NULL,
    AirlineId bigint NULL,
    StationId bigint NULL,
    AirlineScopeKey AS ISNULL(AirlineId,CONVERT(bigint,0)) PERSISTED,
    StationScopeKey AS ISNULL(StationId,CONVERT(bigint,0)) PERSISTED,
    PriorityLevel varchar(12) NOT NULL,
    CountsAsPriority bit NOT NULL,
    SupervisorAttention bit NOT NULL,
    EscalationEnabled bit NOT NULL,
    SlaRuleKeyOverride varchar(50) NULL,
    EffectiveFrom date NOT NULL,
    EffectiveTo date NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunPriorityRules_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunPriorityRules_Group FOREIGN KEY(ShcGroupId) REFERENCES dbo.CargoRunShcGroups(ShcGroupId),
    CONSTRAINT FK_CargoRunPriorityRules_Airline FOREIGN KEY(AirlineId) REFERENCES dbo.CargoRunAirlines(AirlineId),
    CONSTRAINT FK_CargoRunPriorityRules_Station FOREIGN KEY(StationId) REFERENCES dbo.CargoRunStations(StationId),
    CONSTRAINT UQ_CargoRunPriorityRules_Version UNIQUE(ShcGroupId,AirlineScopeKey,StationScopeKey,EffectiveFrom),
    CONSTRAINT CK_CargoRunPriorityRules_Level CHECK(PriorityLevel IN ('NORMAL','PRIORITY','HIGH','CRITICAL')),
    CONSTRAINT CK_CargoRunPriorityRules_Dates CHECK(EffectiveTo IS NULL OR EffectiveTo>EffectiveFrom)
  );

  CREATE TABLE dbo.CargoRunMailRules (
    MailRuleId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunMailRules PRIMARY KEY,
    AirlineId bigint NULL,
    StationId bigint NULL,
    AirlineScopeKey AS ISNULL(AirlineId,CONVERT(bigint,0)) PERSISTED,
    StationScopeKey AS ISNULL(StationId,CONVERT(bigint,0)) PERSISTED,
    MailHandlingRequired bit NOT NULL,
    MailScanRequired bit NOT NULL,
    SlaEnabled bit NOT NULL,
    SlaRuleKey varchar(50) NULL,
    ReminderEnabled bit NOT NULL,
    EscalationEnabled bit NOT NULL,
    OperationalInstructions nvarchar(1000) NULL,
    EffectiveFrom date NOT NULL,
    EffectiveTo date NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunMailRules_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunMailRules_Airline FOREIGN KEY(AirlineId) REFERENCES dbo.CargoRunAirlines(AirlineId),
    CONSTRAINT FK_CargoRunMailRules_Station FOREIGN KEY(StationId) REFERENCES dbo.CargoRunStations(StationId),
    CONSTRAINT UQ_CargoRunMailRules_Version UNIQUE(AirlineScopeKey,StationScopeKey,EffectiveFrom),
    CONSTRAINT CK_CargoRunMailRules_Sla CHECK(SlaEnabled=0 OR SlaRuleKey IS NOT NULL),
    CONSTRAINT CK_CargoRunMailRules_Dates CHECK(EffectiveTo IS NULL OR EffectiveTo>EffectiveFrom)
  );

  CREATE TABLE dbo.CargoRunDocumentRules (
    DocumentRuleId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunDocumentRules PRIMARY KEY,
    AirlineId bigint NULL,
    StationId bigint NULL,
    AirlineScopeKey AS ISNULL(AirlineId,CONVERT(bigint,0)) PERSISTED,
    StationScopeKey AS ISNULL(StationId,CONVERT(bigint,0)) PERSISTED,
    Direction varchar(10) NOT NULL,
    DocumentType varchar(40) NOT NULL,
    IsSupported bit NOT NULL,
    IsRequired bit NOT NULL,
    BulkPieceConfirmationEnabled bit NOT NULL,
    OperationalInstructions nvarchar(1000) NULL,
    EffectiveFrom date NOT NULL,
    EffectiveTo date NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunDocumentRules_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunDocumentRules_Airline FOREIGN KEY(AirlineId) REFERENCES dbo.CargoRunAirlines(AirlineId),
    CONSTRAINT FK_CargoRunDocumentRules_Station FOREIGN KEY(StationId) REFERENCES dbo.CargoRunStations(StationId),
    CONSTRAINT UQ_CargoRunDocumentRules_Version UNIQUE(DocumentType,Direction,AirlineScopeKey,StationScopeKey,EffectiveFrom),
    CONSTRAINT CK_CargoRunDocumentRules_Direction CHECK(Direction IN ('IMPORT','EXPORT')),
    CONSTRAINT CK_CargoRunDocumentRules_Type CHECK(DocumentType IN ('ULD_SUMMARY','EXPORT_UNIT_LIST','UWS','FOW')),
    CONSTRAINT CK_CargoRunDocumentRules_Dates CHECK(EffectiveTo IS NULL OR EffectiveTo>EffectiveFrom)
  );

  CREATE TABLE dbo.CargoRunLocations (
    LocationId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunLocations PRIMARY KEY,
    StationId bigint NOT NULL,
    LocationCode varchar(40) NOT NULL,
    DisplayName nvarchar(100) NOT NULL,
    IsEnabled bit NOT NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunLocations_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunLocations_Station FOREIGN KEY(StationId) REFERENCES dbo.CargoRunStations(StationId),
    CONSTRAINT UQ_CargoRunLocations_Code UNIQUE(StationId,LocationCode)
  );

  CREATE TABLE dbo.CargoRunCapabilities (
    CapabilityId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunCapabilities PRIMARY KEY,
    CapabilityCode varchar(60) NOT NULL,
    DisplayName nvarchar(100) NOT NULL,
    Description nvarchar(500) NULL,
    IsEnabled bit NOT NULL CONSTRAINT DF_CargoRunCapabilities_Enabled DEFAULT(1),
    CONSTRAINT UQ_CargoRunCapabilities_Code UNIQUE(CapabilityCode),
    CONSTRAINT CK_CargoRunCapabilities_Code CHECK(CapabilityCode NOT LIKE '%[^A-Z0-9_]%')
  );

  CREATE TABLE dbo.CargoRunRoles (
    RoleId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunRoles PRIMARY KEY,
    RoleCode varchar(40) NOT NULL,
    DisplayName nvarchar(100) NOT NULL,
    Description nvarchar(500) NULL,
    IsEnabled bit NOT NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunRoles_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT UQ_CargoRunRoles_Code UNIQUE(RoleCode),
    CONSTRAINT CK_CargoRunRoles_Code CHECK(RoleCode NOT LIKE '%[^A-Z0-9_]%')
  );

  CREATE TABLE dbo.CargoRunRoleCapabilities (
    RoleCapabilityVersionId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunRoleCapabilities PRIMARY KEY,
    RoleId bigint NOT NULL,
    CapabilityId bigint NOT NULL,
    CapabilityAction varchar(10) NOT NULL,
    EffectiveFrom date NOT NULL,
    EffectiveTo date NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunRoleCapabilities_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunRoleCapabilities_Role FOREIGN KEY(RoleId) REFERENCES dbo.CargoRunRoles(RoleId),
    CONSTRAINT FK_CargoRunRoleCapabilities_Capability FOREIGN KEY(CapabilityId) REFERENCES dbo.CargoRunCapabilities(CapabilityId),
    CONSTRAINT UQ_CargoRunRoleCapabilities_Version UNIQUE(RoleId,CapabilityId,EffectiveFrom),
    CONSTRAINT CK_CargoRunRoleCapabilities_Action CHECK(CapabilityAction IN ('GRANT','REVOKE')),
    CONSTRAINT CK_CargoRunRoleCapabilities_Dates CHECK(EffectiveTo IS NULL OR EffectiveTo>EffectiveFrom)
  );

  CREATE TABLE dbo.CargoRunUserRoleAssignments (
    UserRoleVersionId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunUserRoleAssignments PRIMARY KEY,
    ActorReference nvarchar(150) NOT NULL,
    ActorDisplayName nvarchar(150) NULL,
    RoleId bigint NOT NULL,
    StationId bigint NULL,
    StationScopeKey AS ISNULL(StationId,CONVERT(bigint,0)) PERSISTED,
    AssignmentAction varchar(10) NOT NULL,
    EffectiveFrom date NOT NULL,
    EffectiveTo date NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunUserRoles_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunUserRoles_Role FOREIGN KEY(RoleId) REFERENCES dbo.CargoRunRoles(RoleId),
    CONSTRAINT FK_CargoRunUserRoles_Station FOREIGN KEY(StationId) REFERENCES dbo.CargoRunStations(StationId),
    CONSTRAINT UQ_CargoRunUserRoles_Version UNIQUE(ActorReference,RoleId,StationScopeKey,EffectiveFrom),
    CONSTRAINT CK_CargoRunUserRoles_Action CHECK(AssignmentAction IN ('GRANT','REVOKE')),
    CONSTRAINT CK_CargoRunUserRoles_Dates CHECK(EffectiveTo IS NULL OR EffectiveTo>EffectiveFrom)
  );

  CREATE TABLE dbo.CargoRunAdminMessages (
    MessageId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunAdminMessages PRIMARY KEY,
    MessageSeriesId uniqueidentifier NOT NULL CONSTRAINT DF_CargoRunAdminMessages_Series DEFAULT(NEWID()),
    VersionNumber int NOT NULL,
    Title nvarchar(150) NOT NULL,
    MessageBody nvarchar(2000) NOT NULL,
    Severity varchar(20) NOT NULL,
    AudienceType varchar(20) NOT NULL,
    StationId bigint NULL,
    AirlineId bigint NULL,
    RoleId bigint NULL,
    FlightId bigint NULL,
    AudienceReference nvarchar(150) NULL,
    StartsAtUtc datetime2(3) NOT NULL,
    ExpiresAtUtc datetime2(3) NULL,
    MessageAction varchar(12) NOT NULL,
    CreatedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunAdminMessages_CreatedAt DEFAULT(SYSUTCDATETIME()),
    CreatedByDisplayName nvarchar(150) NOT NULL,
    CreatedByReference nvarchar(150) NOT NULL,
    CONSTRAINT FK_CargoRunAdminMessages_Station FOREIGN KEY(StationId) REFERENCES dbo.CargoRunStations(StationId),
    CONSTRAINT FK_CargoRunAdminMessages_Airline FOREIGN KEY(AirlineId) REFERENCES dbo.CargoRunAirlines(AirlineId),
    CONSTRAINT FK_CargoRunAdminMessages_Role FOREIGN KEY(RoleId) REFERENCES dbo.CargoRunRoles(RoleId),
    CONSTRAINT FK_CargoRunAdminMessages_Flight FOREIGN KEY(FlightId) REFERENCES dbo.Flights(FlightId),
    CONSTRAINT UQ_CargoRunAdminMessages_Version UNIQUE(MessageSeriesId,VersionNumber),
    CONSTRAINT CK_CargoRunAdminMessages_Version CHECK(VersionNumber>=1),
    CONSTRAINT CK_CargoRunAdminMessages_Severity CHECK(Severity IN ('INFORMATION','ACTION_REQUIRED','URGENT')),
    CONSTRAINT CK_CargoRunAdminMessages_Audience CHECK(AudienceType IN ('ALL_STATION','AIRLINE','ROLE','FLIGHT')),
    CONSTRAINT CK_CargoRunAdminMessages_Action CHECK(MessageAction IN ('PUBLISH','AMEND','WITHDRAW')),
    CONSTRAINT CK_CargoRunAdminMessages_Dates CHECK(ExpiresAtUtc IS NULL OR ExpiresAtUtc>StartsAtUtc)
  );

  CREATE TABLE dbo.CargoRunConfigurationAudit (
    ConfigurationAuditId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CargoRunConfigurationAudit PRIMARY KEY,
    Operation varchar(60) NOT NULL,
    EntityType varchar(60) NOT NULL,
    EntityId nvarchar(150) NOT NULL,
    EffectiveFrom date NULL,
    OldValueJson nvarchar(max) NULL,
    NewValueJson nvarchar(max) NULL,
    ActorReference nvarchar(150) NOT NULL,
    ActorDisplayName nvarchar(150) NOT NULL,
    OccurredAtUtc datetime2(3) NOT NULL CONSTRAINT DF_CargoRunConfigurationAudit_Occurred DEFAULT(SYSUTCDATETIME()),
    CorrelationId uniqueidentifier NOT NULL CONSTRAINT DF_CargoRunConfigurationAudit_Correlation DEFAULT(NEWID()),
    CONSTRAINT CK_CargoRunConfigurationAudit_OldJson CHECK(OldValueJson IS NULL OR ISJSON(OldValueJson)=1),
    CONSTRAINT CK_CargoRunConfigurationAudit_NewJson CHECK(NewValueJson IS NULL OR ISJSON(NewValueJson)=1)
  );

  CREATE INDEX IX_CargoRunShcMappings_Resolve ON dbo.CargoRunShcGroupMappings(ShcId,AirlineScopeKey,StationScopeKey,EffectiveFrom DESC) INCLUDE(ShcGroupId,MappingAction,EffectiveTo);
  CREATE INDEX IX_CargoRunSlaRules_Resolve ON dbo.CargoRunSlaRules(RuleKey,AirlineScopeKey,StationScopeKey,EffectiveFrom DESC) INCLUDE(EffectiveTo,IsEnabled);
  CREATE INDEX IX_CargoRunMessages_Audience ON dbo.CargoRunAdminMessages(AudienceType,StartsAtUtc,ExpiresAtUtc);
  CREATE INDEX IX_CargoRunConfigAudit_Time ON dbo.CargoRunConfigurationAudit(OccurredAtUtc DESC,ConfigurationAuditId DESC);

  DECLARE @SeedActor nvarchar(150)=N'MIGRATION_CURRENT_FALLBACK', @BaseDate date='20000101';
  INSERT dbo.CargoRunStations(StationCode,DisplayName,TimeZoneId,CreatedByReference)
  VALUES('MEL',N'Melbourne',N'Australia/Melbourne',@SeedActor);

  INSERT dbo.CargoRunAirlines(AirlineCode,CreatedByReference)
  VALUES('CX',@SeedActor),('UA',@SeedActor),('MH',@SeedActor),('QR',@SeedActor),('TG',@SeedActor),('BI',@SeedActor),('GA',@SeedActor),('VN',@SeedActor),('AI',@SeedActor),('JQ',@SeedActor);

  INSERT dbo.CargoRunAirlineProfiles(AirlineId,DisplayName,BadgeColour,BrightBadge,IsEnabled,EffectiveFrom,CreatedByReference)
  SELECT a.AirlineId,v.DisplayName,v.BadgeColour,v.BrightBadge,1,@BaseDate,@SeedActor
  FROM dbo.CargoRunAirlines a JOIN (VALUES
    ('CX',N'Cathay Pacific','#006564',0),('UA',N'United Airlines','#0033A0',0),
    ('MH',N'Malaysia Airlines','#002B5C',0),('QR',N'Qatar Airways','#662046',0),
    ('TG',N'Thai Airways','#370E62',0),('BI',N'Royal Brunei','#FFE600',1),
    ('GA',N'Garuda Indonesia','#202D5C',0),('VN',N'Vietnam Airlines','#005E80',0),
    ('AI',N'Air India','#DA0E29',0),('JQ',N'Jetstar','#E65C00',0)
  ) v(AirlineCode,DisplayName,BadgeColour,BrightBadge) ON v.AirlineCode=a.AirlineCode;

  INSERT dbo.CargoRunAirlineStations(AirlineId,StationId,AssignmentAction,EffectiveFrom,CreatedByReference)
  SELECT a.AirlineId,s.StationId,'ENABLE',@BaseDate,@SeedActor FROM dbo.CargoRunAirlines a CROSS JOIN dbo.CargoRunStations s WHERE s.StationCode='MEL';

  INSERT dbo.CargoRunShcs(ShcCode,CreatedByReference)
  SELECT v.ShcCode,@SeedActor FROM (VALUES('AVI'),('COL'),('CRT'),('FRO'),('EAT'),('PEF'),('PER'),('ICE'),('PIL'),('AOG'),('VAL'),('AVP'),('AVC'),('GOL'),('HUM'),('DGR'),('MAL'),('MAIL')) v(ShcCode);
  INSERT dbo.CargoRunShcVersions(ShcId,Description,StandardIndicator,IsEnabled,EffectiveFrom,CreatedByReference)
  SELECT ShcId,N'Existing CargoRun fallback code',N'UNKNOWN',1,@BaseDate,@SeedActor FROM dbo.CargoRunShcs;

  INSERT dbo.CargoRunShcGroups(GroupKey,CreatedByReference)
  VALUES('LIVE',@SeedActor),('TEMP',@SeedActor),('PHARMA',@SeedActor),('MAIL',@SeedActor),('AOG',@SeedActor),('VALUABLE',@SeedActor),('HUM',@SeedActor),('DGR',@SeedActor);
  INSERT dbo.CargoRunShcGroupVersions(ShcGroupId,DisplayToken,DisplayName,Description,DisplayOrder,VisualClass,IsEnabled,EffectiveFrom,CreatedByReference)
  SELECT g.ShcGroupId,v.Token,v.DisplayName,N'Migrated from the exact current CargoRun fallback',v.DisplayOrder,v.VisualClass,1,@BaseDate,@SeedActor
  FROM dbo.CargoRunShcGroups g JOIN (VALUES
    ('LIVE',N'AVI',N'Live Animals',10,'critical'),('TEMP',N'TEMP',N'Temperature Controlled',20,'temp'),
    ('PHARMA',N'PHARMA',N'Pharma',30,'temp'),('MAIL',N'MAIL',N'Priority Mail',40,'mail'),
    ('AOG',N'AOG',N'Aircraft on Ground',50,'critical'),('VALUABLE',N'VAL',N'Valuable Cargo',60,''),
    ('HUM',N'HUM',N'Human Remains',70,''),('DGR',N'DGR',N'Dangerous Goods',80,'critical')
  ) v(GroupKey,Token,DisplayName,DisplayOrder,VisualClass) ON v.GroupKey=g.GroupKey;

  INSERT dbo.CargoRunShcGroupMappings(ShcId,ShcGroupId,MappingAction,EffectiveFrom,CreatedByReference)
  SELECT sh.ShcId,g.ShcGroupId,'INCLUDE',@BaseDate,@SeedActor
  FROM (VALUES
    ('AVI','LIVE'),('COL','TEMP'),('CRT','TEMP'),('FRO','TEMP'),('EAT','TEMP'),('PEF','TEMP'),('PER','TEMP'),('ICE','TEMP'),
    ('PIL','PHARMA'),('AOG','AOG'),('VAL','VALUABLE'),('AVP','VALUABLE'),('AVC','VALUABLE'),('GOL','VALUABLE'),('HUM','HUM'),('DGR','DGR')
  ) v(ShcCode,GroupKey) JOIN dbo.CargoRunShcs sh ON sh.ShcCode=v.ShcCode AND sh.CarrierAirlineId IS NULL JOIN dbo.CargoRunShcGroups g ON g.GroupKey=v.GroupKey;
  INSERT dbo.CargoRunShcGroupMappings(ShcId,ShcGroupId,AirlineId,MappingAction,EffectiveFrom,CreatedByReference)
  SELECT sh.ShcId,g.ShcGroupId,a.AirlineId,'INCLUDE',@BaseDate,@SeedActor
  FROM dbo.CargoRunShcs sh CROSS JOIN dbo.CargoRunShcGroups g CROSS JOIN dbo.CargoRunAirlines a
  WHERE sh.ShcCode IN ('MAL','MAIL') AND g.GroupKey='MAIL' AND a.AirlineCode IN ('CX','UA');

  INSERT dbo.CargoRunSlaRules(RuleKey,Direction,StartEvent,TargetEvent,TargetMinutes,WarningMinutes,BreachMinutes,IsEnabled,ApplicabilityNotes,EffectiveFrom,CreatedByReference)
  VALUES
    ('IMPORT_ACCEPTANCE_STANDARD','IMPORT','IN_BLOCK','ULD_ACCEPTED',30,20,30,1,N'Current CargoRun standard acceptance fallback',@BaseDate,@SeedActor),
    ('IMPORT_ACCEPTANCE_PRIORITY','IMPORT','IN_BLOCK','ULD_ACCEPTED',20,10,20,1,N'Current CargoRun priority acceptance fallback',@BaseDate,@SeedActor),
    ('EXPORT_AT_AIRCRAFT','EXPORT','ESTIMATED_DEPARTURE','ULD_AT_AIRCRAFT',-60,-90,-60,1,N'Current ETD-relative aircraft delivery fallback',@BaseDate,@SeedActor),
    ('MAIL_SCAN','IMPORT','IN_BLOCK','MAIL_SCANNED',180,120,180,1,N'Current three-hour CX and UA mail fallback',@BaseDate,@SeedActor),
    ('OFFLOAD_AGE','EXPORT','OFFLOAD_REQUESTED','OFFLOAD_COMPLETED',10,10,10,1,N'Current Supervisor offload age fallback',@BaseDate,@SeedActor);

  INSERT dbo.CargoRunPriorityRules(ShcGroupId,PriorityLevel,CountsAsPriority,SupervisorAttention,EscalationEnabled,EffectiveFrom,CreatedByReference)
  SELECT g.ShcGroupId,CASE WHEN g.GroupKey IN ('LIVE','AOG') THEN 'CRITICAL' ELSE 'PRIORITY' END,1,1,1,@BaseDate,@SeedActor
  FROM dbo.CargoRunShcGroups g;

  INSERT dbo.CargoRunMailRules(AirlineId,MailHandlingRequired,MailScanRequired,SlaEnabled,SlaRuleKey,ReminderEnabled,EscalationEnabled,EffectiveFrom,CreatedByReference)
  SELECT AirlineId,1,1,1,'MAIL_SCAN',1,1,@BaseDate,@SeedActor FROM dbo.CargoRunAirlines WHERE AirlineCode IN ('CX','UA');

  INSERT dbo.CargoRunCapabilities(CapabilityCode,DisplayName,Description)
  SELECT CapabilityCode,DisplayName,Description FROM (VALUES
    ('VIEW_FLIGHTS',N'View flights',N'View CargoRun operational flight data'),('MOVE_ULD',N'Move ULD',N'Record a ULD status transition'),
    ('SCAN_ULD',N'Scan ULD',N'Use operational ULD scanning'),('VIEW_PRIORITY',N'View priority cargo',N'View derived priority handling'),
    ('REQUEST_OFFLOAD',N'Request offload',N'Create an offload request'),('COLLECT_OFFLOAD',N'Collect offload',N'Move an offload to transit'),
    ('COMPLETE_OFFLOAD',N'Complete offload',N'Complete an offload'),('SET_IN_BLOCK',N'Set in block',N'Set the aircraft in-block time'),
    ('SET_ETD',N'Set ETD',N'Set estimated departure'),('UPLOAD_FLIGHT_DATA',N'Upload flight data',N'Upload supported intake documents'),
    ('CONFIRM_EXPORT_FINAL',N'Confirm Export FINAL',N'Confirm immutable Export FINAL membership'),('FINALISE_FLIGHT',N'Finalise flight',N'Create completion evidence'),
    ('VIEW_FLIGHT_STATEMENT',N'View Flight Statement',N'View immutable flight evidence'),('VIEW_HISTORY',N'View history',N'View operational audit history'),
    ('EXPORT_HISTORY',N'Export history',N'Export operational audit reports'),('VIEW_SUPERVISOR',N'View Supervisor',N'View Supervisor dashboard'),
    ('PUBLISH_MESSAGES',N'Publish messages',N'Publish operational messages'),('EDIT_AIRLINE_RULES',N'Edit airline rules',N'Create airline configuration versions'),
    ('EDIT_SLA_RULES',N'Edit SLA rules',N'Create SLA configuration versions'),('EDIT_SHC_RULES',N'Edit SHC rules',N'Create SHC and group configuration versions'),
    ('MANAGE_USERS',N'Manage users',N'Manage role assignments'),('VIEW_ADMIN_AUDIT',N'View Admin audit',N'View configuration audit evidence')
  ) v(CapabilityCode,DisplayName,Description);

  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunConfigurationAudit_Immutable ON dbo.CargoRunConfigurationAudit INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51320, ''Configuration audit rows are immutable.'', 1; END;');
  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunAdminMessages_Immutable ON dbo.CargoRunAdminMessages INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51321, ''Admin message versions are immutable; append a new version.'', 1; END;');
  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunShcMappings_Immutable ON dbo.CargoRunShcGroupMappings INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51322, ''SHC mapping versions are immutable; append a new version.'', 1; END;');
  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunRules_Immutable ON dbo.CargoRunSlaRules INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51323, ''SLA rule versions are immutable; append a new version.'', 1; END;');
  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunAirlineStations_Immutable ON dbo.CargoRunAirlineStations INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51324, ''Airline station versions are immutable; append a new version.'', 1; END;');
  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunAirlineProfiles_Immutable ON dbo.CargoRunAirlineProfiles INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51325, ''Airline profile versions are immutable; append a new version.'', 1; END;');
  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunShcVersions_Immutable ON dbo.CargoRunShcVersions INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51326, ''SHC versions are immutable; append a new version.'', 1; END;');
  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunShcGroupVersions_Immutable ON dbo.CargoRunShcGroupVersions INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51327, ''SHC group versions are immutable; append a new version.'', 1; END;');
  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunPriorityRules_Immutable ON dbo.CargoRunPriorityRules INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51328, ''Priority rule versions are immutable; append a new version.'', 1; END;');
  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunMailRules_Immutable ON dbo.CargoRunMailRules INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51329, ''Mail rule versions are immutable; append a new version.'', 1; END;');
  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunDocumentRules_Immutable ON dbo.CargoRunDocumentRules INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51330, ''Document rule versions are immutable; append a new version.'', 1; END;');
  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunRoleCapabilities_Immutable ON dbo.CargoRunRoleCapabilities INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51331, ''Role capability versions are immutable; append a new version.'', 1; END;');
  EXEC(N'CREATE TRIGGER dbo.TR_CargoRunUserRoles_Immutable ON dbo.CargoRunUserRoleAssignments INSTEAD OF UPDATE,DELETE AS BEGIN SET NOCOUNT ON; THROW 51332, ''User role versions are immutable; append a new version.'', 1; END;');

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
