# CargoRun Admin configuration foundation

This Phase A design separates effective-dated airline and station business configuration from CargoRun's protected operational integrity rules. It adds no Admin mutation endpoint and does not change the rules used by live operations.

## Existing hard-coded rule inventory

| Current location | Current behaviour | Classification | Phase A treatment |
| --- | --- | --- | --- |
| `index.html` `AIRLINE_META` | CX, UA, MH, QR, TG, BI, GA, VN, AI and JQ names, badge colours and BI bright treatment | Safe to migrate | Exact values are seeded as global airline profile V1 rows and remain frontend fallback values. |
| `index.html` `PRIORITY_TAG_META`, `TEMP_PRIORITY_SHCS`, `VALUABLE_PRIORITY_SHCS`, `priorityTagsFor` | Raw SHCs derive LIVE, TEMP, PHARMA, MAIL, AOG, VALUABLE, HUM and DGR display groups; CX/UA MAL or MAIL derives MAIL | Safe to migrate | Exact raw-code mappings, group metadata and priority levels are seeded. Raw SHCs remain unchanged in ULD evidence. Text detection of `MAIL` remains a compatibility fallback and is not migrated. |
| `index.html` `flightStatusSettings`, `acceptanceThresholds` | Import standard warning/late 20/30 minutes; priority 10/20; timer starts at In Block, or landed plus 10-minute local fallback | Partly safe | Exact acceptance SLA thresholds are seeded. Browser-local arrival integration and landing grace remain unchanged and deferred until authoritative station settings are wired. |
| `index.html` `exportSlaState` | At-aircraft target ETD minus 60 minutes; warning begins 90 minutes before ETD | Safe to migrate | Exact monitoring rule is seeded as `EXPORT_AT_AIRCRAFT`; operational status logic is untouched. |
| `index.html` `isCxUaMail`, `mailSlaState`; `api/mail-scan` audit detail | CX/UA MAL/MAIL requires a scan within 180 minutes of In Block and warns with 60 minutes remaining | Safe to migrate | Exact CX/UA mail rules and the 180/120-minute SLA are seeded; mail completion evidence remains the existing authoritative timestamp. |
| `index.html` offload/Supervisor views | Offloads at 10 minutes are urgent | Safe to migrate | Exact 10-minute monitoring fallback is seeded. Offload transitions and uniqueness are protected and unchanged. |
| `index.html` `showFlightStatusSettings` | Any authenticated browser can change local warning values in local storage | Defer replacement | Existing behavior remains. A later phase must replace it with authorized, audited configuration and remove local edits only after compatibility testing. |
| `index.html` upload parsers; `api/manifest-upload`; `api/shared/export-uws` | Supported worksheets, columns, Import/Export detection, UWS parsing and manual review | Defer | Document-rule tables exist, but no rules are seeded or wired until file-format compatibility is fully inventoried. |
| `api/mach-fow` | MACH message interpretation, idempotency, flight/ULD reuse and FOW expectations | Protected integrity | Not configurable in Phase A. A future document setting may enable an integration, but cannot change FOW physical-status protection. |
| `api/export-manifest-final` and final migrations | FINAL membership, exact IDs, locks, reconciliation, immutability and post-FINAL FOW behavior | Protected integrity | Never an Admin setting. |
| `api/shared/uld`, status APIs, offload APIs | Canonical ULD identity, stable IDs, state transitions, one offload per FlightId+UldId, locking | Protected integrity | Never an Admin setting. |
| completion/amendment helpers and schemas | Immutable V1/V2+ evidence and hash chains | Protected integrity | Never an Admin setting. Historical snapshots are not rewritten. |
| API `getActor` implementations | Generic Entra `authenticated` role authorizes current operations | Staged authorization | Preserved in Phase A. Capability tables are additive; enforcement remains `LEGACY` until an Admin bootstrap and authorization preflight succeed. |
| `index.html` supervisor and history presentation | Flight Board, Supervisor alerts, reporting and local UI group presentation | Defer operational wiring | Resolver outputs can feed these later, once schema and values have been verified against current output. |

## Normalized schema

Stable master identities are separated from append-only effective-dated versions:

- `CargoRunStations`, `CargoRunAirlines`, and `CargoRunAirlineStations` define station and airline availability.
- `CargoRunAirlineProfiles` stores effective-dated names, colours, enabled state, and notes. A nullable StationId provides a local override without copying the airline.
- `CargoRunShcs` and `CargoRunShcVersions` preserve raw codes and version descriptive metadata.
- `CargoRunShcGroups` and `CargoRunShcGroupVersions` define operator groups separately from raw codes.
- `CargoRunShcGroupMappings` provides many-to-many `INCLUDE`/`EXCLUDE` decisions at global, station, airline, or airline+station scope.
- `CargoRunPriorityRules`, `CargoRunSlaRules`, `CargoRunMailRules`, and `CargoRunDocumentRules` store scoped effective-dated business decisions.
- `CargoRunLocations` is a future master-data foundation. Existing free-text locations remain authoritative during compatibility work.
- `CargoRunAdminMessages` is an immutable message-version stream with stable audience foreign keys, including exact FlightId.
- `CargoRunCapabilities`, `CargoRunRoles`, `CargoRunRoleCapabilities`, and `CargoRunUserRoleAssignments` provide capability-based authorization without hard-coded employee IDs.
- `CargoRunConfigurationAudit` stores immutable old/new JSON evidence with stable actor identity. JSON is used for audit payloads, not core relational rules.

No foreign key uses cascade delete. Effective-dated behavior rows are append-only. A later value at the same scope takes effect from its `EffectiveFrom`; historical operating dates continue to resolve the earlier value. Same-scope and same-date duplicates are blocked by unique constraints and fail closed in the resolver.

## Resolution contract

`api/shared/configuration.js` applies this exact precedence:

1. global
2. station
3. airline
4. airline + station

The most specific applicable row wins. Within that scope, the newest `EffectiveFrom` not later than the flight operating date wins. `EffectiveTo` is exclusive. A same-scope, same-start ambiguity throws `CONFIGURATION_AMBIGUOUS` rather than choosing an arbitrary row.

SHC mapping is many-to-many. Each raw code/group pair resolves independently, so one raw SHC can derive several groups. `EXCLUDE` explicitly suppresses an inherited mapping. Unknown codes remain in raw evidence and are returned through `unassignedShcs`; the resolver never guesses.

The server store loads all business configuration in one SQL batch and caches the immutable snapshot for at most 60 seconds. Admin mutations will explicitly invalidate this cache in a later phase. User capability decisions are never stored in that cache.

## Protected rules

The schema intentionally contains no setting for FlightId/UldId/OffloadId identity, ULD normalization, physical status sequences, FOW/FINAL locks, FINAL membership, offload uniqueness, evidence immutability, hashes, or audit requirements. `Manual FINAL confirmation required` is also not configurable in this pass because disabling it could weaken the current safety boundary.

## Authorization stage

The current production principal supplies a stable Entra user ID and the broad `authenticated` role. It does not yet supply verified CargoRun Admin capabilities. Phase A therefore exposes only an authenticated, read-only configuration endpoint. It excludes role assignments and configuration audit details, and there is no POST, PATCH, PUT, or DELETE Admin route.

Capability resolution supports `LEGACY`, `AUDIT`, and `ENFORCED` modes. Existing APIs remain on legacy authorization. No enforcement mode is read from a browser or enabled by this change.

## Intentionally deferred

- Admin mutations, bulk edits, copy-airline workflow, and rule simulation saves.
- Production capability enforcement and frontend button authorization.
- Operational consumption of configured rules by Import, Export, Priority, Supervisor, mail, or intake flows.
- Replacing local arrival settings.
- Configuration snapshots in new immutable Flight Statements.
- Authoritative location validation.
- Text-based MAIL fallback classification and full document-format rules.

These items require schema deployment, read-only comparison against current results, at least one verified Admin assignment, transactional configuration audit writes, and mutation-specific server validation.
