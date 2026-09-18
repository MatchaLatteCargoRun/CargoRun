# Phase B isolated rehearsal and deployment gate

Status: prepared, NOT executed against SQL. Node 22 and an explicitly identified
isolated Azure SQL copy were not available in the local environment. Local Node
is v24.14.1. This document does not authorize production execution.

Historical-flight follow-up: the selector now permits ACTIVE/CLOSED/FINALISED
exports regardless of age. Completion-backed historical offloads use the additive
`ExportCompletionAmendments` V2+ store; `ExportCompletionRecords` V1 remains
immutable and `AuditEvents` remains an action trail. Rehearse the identity migration
first and the amendment migration second. Do not treat a failed rehearsal as
permission to remove completion evidence or bypass validation.

## Migration review (actual current file)

| SQL section | Finding |
| --- | --- |
| SET statements | XACT_ABORT ON; all seven filtered-index options explicit and correct. These settings affect the migration session only. |
| TRY / BEGIN TRANSACTION | Schema changes, guards and locks share one transaction. Run as one batch with no GO inserted. |
| Table / column guards | Missing tables or an existing UldId abort. This is a one-time migration, not an idempotent repair script. Metadata visibility and ALTER permissions are prerequisites. |
| TABLOCKX / HOLDLOCK | Freeze Offloads and ULDs through commit/rollback. They block transitions and ULD writers, not only offload creation. Locks can wait/deadlock with existing writers; drain before applying. |
| Population guards | Exactly twelve reviewed IDs; 1-11 unlinked; 9 REQUESTED with known number; 12 FlightId 25/COMPLETE with known number; all other statuses COMPLETE. Abort if these reviewed facts differ. Unknown prior fields cannot be checked against an export that was not supplied. SQL string equality follows database collation, not a byte comparison. |
| Referenced key | Reuses an enabled, non-hypothetical, unfiltered unique index with exactly FlightId,UldId as ordered keys, or creates the unique constraint. Existing ULD number indexes remain. |
| ADD COLUMN | UldId bigint NULL is added in its own sp_executesql invocation. Later references compile in a second invocation after the column exists. |
| Legacy check | NULL permitted only for IDs 1-12. New identity-generated IDs cannot omit UldId. Administrative IDENTITY_INSERT/reseed/delete-recreate permissions must not be available to runtime writers. |
| Flight check | Non-NULL UldId requires non-NULL FlightId; closes SQL composite FK's NULL-component exemption for new rows. |
| Ownership FK | WITH CHECK; composite ownership enforced; no cascade. Historical NULL-UldId rows, including mismatched ID 12, remain valid. |
| Filtered index | UNIQUE FlightId,UldId restricted to REQUESTED/TRANSIT and non-NULL identities. IN is valid. No IGNORE_DUP_KEY option. COMPLETE rows excluded. |
| Object collisions | No DROP/overwrite/IF-NOT-EXISTS masking. Conflicting constraint/index names throw; CATCH rolls back preceding DDL. Only an eligible referenced key is reused. |
| COMMIT / CATCH | Success commits once. On a caught failure, nonzero XACT_STATE rolls back, including a doomed transaction, then THROW preserves error. Same-level compile errors are not generally caught by TRY/CATCH; new-column-dependent DDL is deliberately in a lower compilation scope. Connection loss also requires checking final state before retrying. |

No mandatory SQL correction identified by static review. Actual Azure SQL
execution is still required. The runner tests failure before migration DDL and a
name collision after UldId/key creation; the latter proves rollback of partial DDL.

## Prerequisites and isolation

1. A DBA prepares a DISPOSABLE Azure SQL copy with the reviewed schema/data and
   no connected jobs, Functions, MACH/FOW writers, clients or integrations. Name it
   `CargoRun_PhaseB_Rehearsal_<suffix>`. The runner never creates/copies databases.
2. Confirm its server and database in Azure. Use test-only credentials limited to
   this copy. Never use production connection strings, even for discovery.
3. Preserve the original preflight export and create a fresh copy for each full
   rehearsal. Migration mode must start before UldId exists. Application mode
   changes copy-only row 9 through legitimate application transitions. It never
   changes historical row 12. Do not restore those changes into production.
4. Run in a dedicated Node 22 shell. Install the same dependency artifact that
   production will deploy under `api/node_modules`. Record `npm --prefix api ls
   mssql tedious`. There is currently no committed package lock, so the declared
   `mssql ^11.0.1` range alone does not identify the deployed driver build.
5. The test login needs the application's normal DML rights, test-copy-only ALTER
   rights for migration/audit fault injection, and visibility of both test sessions
   in `sys.dm_exec_requests` (Azure SQL permission depends on service tier). Lack of
   visibility must FAIL the contention proof, not skip it or imply success.
6. Keep test credentials out of files, command history and reports. Set
   `CARGORUN_TEST_SQL_CONNECTION` using your existing secret mechanism. Set these
   non-secret controls separately:

```powershell
$env:CARGORUN_TEST_SERVER = 'YOUR-ISOLATED-SERVER.database.windows.net'
$env:CARGORUN_TEST_DATABASE = 'CargoRun_PhaseB_Rehearsal_20260917'
$env:CARGORUN_PHASE_B_ACK = 'ISOLATED_DATABASE_ONLY'
```

The runner checks acknowledgement, Node version and parsed server/database before
connecting; checks DB_NAME after connecting; rejects database fallback; and never
uses DATABASE_CONNECTION_STRING as an input. During application mode it sets that
variable only inside its own process to the validated test connection.

## Node 22 validation

From the repository root, using the Node 22 executable selected in PATH:

```powershell
node --version
node --test --test-isolation=none tests/*.test.js
```

Record the actual result. Some Node 22 releases (including 22.18) expose this as
an experimental flag instead. If the preceding command reports `bad option`, use
the documented Node 22 form (22.8+):

```powershell
node --test --experimental-test-isolation=none tests/*.test.js
```

Do not substitute a Node 24 success for this gate. Then run:

```powershell
$jsFiles = rg --files -g '*.js' -g '!node_modules' -g '!api/node_modules'
foreach ($jsFile in $jsFiles) {
    node --check $jsFile
    if ($LASTEXITCODE -ne 0) { throw "Syntax failed: $jsFile" }
}
$html = Get-Content -Raw index.html
$scripts = [regex]::Matches($html, '(?is)<script\b[^>]*>(.*?)</script>')
foreach ($script in $scripts) {
    if ($script.Groups[1].Value.Trim()) {
        $script.Groups[1].Value | node --check -
        if ($LASTEXITCODE -ne 0) { throw 'Inline script syntax failed' }
    }
}
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'Whitespace check failed' }
```

## A-E, N: migration and rollback rehearsal

```powershell
node tests/integration/phase-b-rehearsal.js migration
if ($LASTEXITCODE -ne 0) { throw 'Migration rehearsal failed' }
```

The runner uses the actual migration file, unmodified, and:

- Captures all original Offloads columns using server-side JSON (including NULLs
  and SQL timestamp precision), plus schema metadata.
- Creates a test-only pre-existing UldId in an outer transaction: the migration
  must throw 51001 and roll back the column; original schema/data must match.
- Creates a conflicting FK name in an outer transaction: the migration must fail
  after its preceding DDL and roll back every schema addition and injected object.
- Applies the actual migration successfully. Every original Offloads column must
  equal the captured baseline; every new UldId must be NULL.
- Specifically checks row 9 still REQUESTED/unlinked and row 12 still
  COMPLETE/FlightId 25/AKE88888CX. No inferred ownership.
- Executes `phase-b-verify.sql`, prints metadata, asserts the three violation result
  sets are empty, and asserts the three new constraints are enabled/trusted.
- Asserts the active index exists, is unique, enabled and filtered. Independently
  review the printed FK columns/index key order/filter against the migration.
- Applies the review-only amendment migration second, proves Offloads and exact V1
  completion JSON are unchanged, confirms the new table starts empty, runs
  `export-completion-amendments-verify.sql`, and confirms its immutable trigger.

Keep full stdout as rehearsal evidence, without credentials. A failure is not
permission to weaken constraints or edit historical data. Investigate, then use a
fresh disposable copy. The production migration is never automatically invoked.

## F-M: database constraints, concurrency, audits and transitions

Select a real eligible flight/ULD pair in the copy. ACTIVE, CLOSED and FINALISED
exports are eligible regardless of age (FINALIZED is also supported). Do not
rewrite creation timestamps, lifecycle statuses or historic identities.
This read-only query lists candidates; choose one explicitly, not TOP 1:

```sql
SELECT f.FlightId,f.FlightNumber,f.OperatingDate,f.CreatedAtUtc,u.UldId,u.UldNumber
FROM dbo.Flights f JOIN dbo.ULDs u ON u.FlightId=f.FlightId
WHERE f.Direction='EXPORT' AND f.FlightStatus IN ('ACTIVE','CLOSED','FINALISED','FINALIZED')
  AND NOT EXISTS (SELECT 1 FROM dbo.Offloads o WHERE o.FlightId=f.FlightId
    AND o.UldId=u.UldId AND o.OffloadStatus IN ('REQUESTED','TRANSIT'))
ORDER BY f.FlightId,u.UldId;
```

```powershell
$env:CARGORUN_TEST_FLIGHT_ID = 'REPLACE_WITH_COPY_FLIGHT_ID'
$env:CARGORUN_TEST_ULD_ID = 'REPLACE_WITH_ITS_ULD_ID'
node tests/integration/phase-b-rehearsal.js application
if ($LASTEXITCODE -ne 0) { throw 'Application rehearsal failed' }
```

This is REAL SQL integration, not the mock regression harness. It invokes the real
offload handler with the real mssql package. Each invocation constructs its own
pool/transaction. A local test principal exercises normal actor handling; it does
not test the hosted Entra/SWA authentication boundary, which requires a signed-in
staging browser. No application modules are edited or SQL responses mocked.

| Requirement | Executed assertion |
| --- | --- |
| Actual session options | Observe SESSIONPROPERTY on the pinned connection immediately after each application's transaction begins; assert all seven values before proceeding. No corrective SET initialization masks a failing default. |
| Concurrent creation | Hold flight UPDLOCK/HOLDLOCK in a third transaction. Start two handler calls; observe distinct SPIDs both actually waiting on that blocker. Release it; require exactly 201 and 409 ACTIVE_OFFLOAD_EXISTS with the winner's ID. |
| Atomic success | Exactly one new Offloads row, one active pair and one new AuditEvents row across the two requests. Exclusive copy prevents unrelated writers contaminating counts. |
| F | Direct insertion omitting UldId fails with the legacy-allowance CHECK, SQL 547. |
| G/H | Valid pair succeeds; existing wrong-flight pair fails specifically with ownership FK. Non-NULL UldId/NULL FlightId fails with the Flight check. |
| I/J/K | Database rejects REQUESTED/REQUESTED, REQUESTED/TRANSIT and TRANSIT/REQUESTED pairs with the named unique index, SQL 2601/2627. |
| L | COMPLETE row can coexist; completing the first application request permits a new REQUESTED request. |
| M | Row 9 progresses through the real PATCH handler, retains both NULL IDs and rejects stale retry. Row 12's full representation is identical afterward. |
| Stale/duplicate audits | Rejection does not increment audit count or modify offload count/state. |
| Audit failure | Add a test-only CHECK rejecting a dedicated actor name. Real AuditEvents insert fails 547 with that CHECK name. Assert the preceding Offloads insert rolled back and counts are unchanged. Remove only this injected CHECK in finally, then retry successfully. |
| Lock timeout | Set LOCK_TIMEOUT=800 only on the test request's pinned connection; hold the actual flight lock. Require logged SQL error 1222, HTTP 500, no offload or audit; release blocker in finally. |
| Driver timeout | Repeat without SET LOCK_TIMEOUT, leaving real driver request cancellation in effect. Require ETIMEOUT, HTTP 500 and unchanged counts. Record the configured/default request timeout, require 1-30 seconds, and use an additional watchdog. |

Direct constraint probes clone all required non-identity/non-computed fields from
a NEW rehearsal offload, override only the probe fields, and always roll back.
They do not weaken constraints or touch legacy evidence. Rolled-back inserts may
consume identity values, which is normal. The application test intentionally
retains committed test rows/audits in the disposable copy for review.

The current offload handler uses transactional UPDLOCK/HOLDLOCK, NOT sp_getapplock.
Flight-creation's application lock is a different feature. This runner proves
offload contention and separately attempts direct duplicates to exercise the
index without relying on the handler's locks.

If the environment uses custom cancellation/deadlock handling, also force those
paths in the copy and verify rollback/lock release. A forced deadlock-victim or
connection-loss test is not claimed by the lock-timeout/driver-timeout tests.

## Filtered-index connection options

Required ON: ANSI_NULLS, ANSI_PADDING, ANSI_WARNINGS, ARITHABORT,
CONCAT_NULL_YIELDS_NULL, QUOTED_IDENTIFIER. Required OFF: NUMERIC_ROUNDABORT.

`api/offloads/index.js` constructs `new sql.ConnectionPool(connectionString)` and
does not explicitly configure these options. Tedious documentation specifies all
seven compatible defaults; node-mssql's Tedious adapter passes configuration
options through. No installed mssql/tedious tree, package lock, or test connection
was available during preparation, so actual deployed session values are UNKNOWN.
Do not report defaults as measured evidence.

The runner measures real transaction connections, including both concurrent pools
and PATCH sessions. A query in Azure's SQL editor or on a different pool connection
does not prove these values. If measurements differ, stop rollout and explicitly
configure the failing connection options for every writer, then rerun old and new
transition tests. An initialization query sent once to an arbitrary pooled
connection is insufficient. No speculative production configuration changes have
been made in this task.

## Deployment-window analysis

- Old backend + new schema: old INSERT lacks UldId, so the database CHECK rejects
  it; no NULL-identity row is created. Transactional audit cannot commit success
  for that failed insertion. Old transitions do not touch identity and remain
  compatible, provided their actual session SET options pass.
- New backend + old schema: a valid new creation payload returns 503
  OFFLOAD_SCHEMA_NOT_READY before beginning creation; an old/missing-ID payload
  gets 400. Existing GET/PATCH tolerate the missing UldId column.
- New backend + stale UI: old payload missing UldId is rejected; refresh clients.
- During schema DDL: exclusive table/schema locks can delay transitions. Also,
  row 9 advancing between preflight and the migration makes its guard abort. Thus
  creation-only pause does NOT guarantee uninterrupted transition availability.

Controlled sequence: pause creation; drain it; finish or briefly pause/drain
transitions and ULD writers for the short migration window; repeat preflight;
apply migration; run verification; resume compatible transitions; deploy backend
and frontend while creation remains paused; hard-refresh clients; smoke-test;
resume creation. If row 9 has legitimately progressed, repeat the reviewed
baseline/migration review; never revert its status to satisfy the old guard.

## Production smoke checklist (after separate deployment approval)

Use a designated operationally valid test movement approved by the operator.
Do not fabricate a physical movement or advance legacy 9 solely for a smoke test.

- Sign in normally; Request Offload includes historical ACTIVE/CLOSED/FINALISED
  exports, with number, operating date and lifecycle shown; imports are excluded.
- Choose flight; dropdown contains only its authoritative ULDs. Switch flights
  quickly; old responses must not repopulate the dropdown. Arbitrary ULD unavailable.
- Request valid offload; record returned OffloadId and actual FlightId/UldId.
- Repeat request: conflict focuses exactly that OffloadId, no extra audit.
- Perform actual REQUESTED -> TRANSIT -> COMPLETE movements; confirm one matching
  authenticated audit for each success. Stale retry must produce no success audit.
- Global full/serial scan and explicit ambiguity selection still focus stable IDs.
- Verify legacy 9 remains visible and supports its next legitimate transition.
  Its full transition proof belongs to the disposable-copy rehearsal.
- Historical 12 remains unchanged and NULL-UldId. Review read-only queries below.

```sql
DECLARE @OffloadId bigint = 0; -- replace with exact returned test ID
SELECT o.*,u.FlightId AS AuthoritativeFlightId,u.UldNumber AS AuthoritativeUld,
       f.FlightNumber AS AuthoritativeFlight,f.OperatingDate,f.Direction,f.FlightStatus
FROM dbo.Offloads o
LEFT JOIN dbo.ULDs u ON u.UldId=o.UldId
LEFT JOIN dbo.Flights f ON f.FlightId=o.FlightId
WHERE o.OffloadId=@OffloadId;

SELECT o.FlightId,o.UldId,COUNT_BIG(*) AS ActiveCount
FROM dbo.Offloads o JOIN dbo.Offloads selected ON selected.OffloadId=@OffloadId
  AND selected.FlightId=o.FlightId AND selected.UldId=o.UldId
WHERE o.OffloadStatus IN ('REQUESTED','TRANSIT')
GROUP BY o.FlightId,o.UldId; -- 1 when active; no row after COMPLETE absent a later request

SELECT OffloadId,FlightId,UldId,UldNumber,OffloadStatus
FROM dbo.Offloads WHERE OffloadId IN (9,12);
```

Audit schema is adaptive. This read-only query chooses the SAME identifier
representations written by the helper: JSON offloadId, or EntityType/EntityId.
If neither exists it stops instead of claiming number-only evidence is exact:

```sql
DECLARE @OffloadId bigint=0; -- exact returned ID
DECLARE @Json sysname,@Predicate nvarchar(max);
SELECT @Json=CASE
  WHEN COL_LENGTH('dbo.AuditEvents','DetailsJson') IS NOT NULL THEN 'DetailsJson'
  WHEN COL_LENGTH('dbo.AuditEvents','DetailJson') IS NOT NULL THEN 'DetailJson'
  WHEN COL_LENGTH('dbo.AuditEvents','MetadataJson') IS NOT NULL THEN 'MetadataJson' END;
IF @Json IS NOT NULL
  SET @Predicate=N'TRY_CONVERT(bigint,JSON_VALUE(CASE WHEN ISJSON('
    + QUOTENAME(@Json)+N')=1 THEN '+QUOTENAME(@Json)+N' ELSE N''{}'' END,''$.offloadId''))=@Id';
ELSE IF COL_LENGTH('dbo.AuditEvents','EntityId') IS NOT NULL
    AND COL_LENGTH('dbo.AuditEvents','EntityType') IS NOT NULL
  SET @Predicate=N'EntityType=N''Offload'' AND TRY_CONVERT(bigint,EntityId)=@Id';
ELSE THROW 51020,'Audit schema has no exact offload reference written by this helper; review evidence mapping.',1;
DECLARE @ReadOnlySql nvarchar(max)=N'SELECT * FROM dbo.AuditEvents WHERE '+@Predicate+N';';
EXEC sys.sp_executesql @ReadOnlySql,N'@Id bigint',@Id=@OffloadId;
```

Check action, authenticated actor, server timestamp, status changes, and reference
for each expected audit. Do not use fabricated timestamps or number-only matching
to fill gaps. The helper does not directly populate an OffloadId column; identifiers
are stored in its supported JSON/entity fields.

## Evidence required before changing the deployment verdict

Node 22 full-suite and syntax results; actual migration and both rollback proofs;
verified constraints/key/filter; two observed blocked application SPIDs and final
201/409 responses; exact row/audit count deltas; real 1222 and driver timeout
rollback results; measured SET options and resolved dependency versions; signed-in
staging UI/legacy transition checks. Missing evidence remains a deployment blocker.

If the run is interrupted during audit fault injection, inspect/remove ONLY
CK_PhaseB_Rehearsal_ForceAuditFailure in the disposable copy or recreate that copy.
Never disable production constraints. After a successful production migration,
rollback should retain additive integrity/evidence and pause creation, rather than
restore unsafe legacy creation or drop constraints.

Sources: [SQL Server CREATE INDEX and SET requirements](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql),
[Tedious connection options](https://tediousjs.github.io/tedious/api-connection.html),
[node-mssql Tedious adapter](https://github.com/tediousjs/node-mssql/blob/v11.0.1/lib/tedious/connection-pool.js),
[Node 22.18 CLI flags](https://nodejs.org/download/release/v22.18.0/docs/api/cli.html).
