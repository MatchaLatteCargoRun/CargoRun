# ULD normalization checks

From the repository root, run:

```sh
node --test tests/uld-normalization.test.js
node --test tests/confirmation-safety.test.js
node --test tests/scan-ambiguity.test.js
node --test tests/atomic-status.test.js
node --test tests/flight-concurrency.test.js
node --test tests/offload-identity.test.js
node --test tests/completion-amendments.test.js
node --test tests/flight-summary-offloads.test.js
node --test tests/flight-statement.test.js
```

Uses Node's built-in test runner (project runtime: Node 22). No dependencies,
database connection, credentials, or network access are required.

Run the complete suite with `node --test tests/*.test.js`. If the sandbox blocks
child-process isolation with `spawn EPERM`, use
`node --test --test-isolation=none tests/*.test.js` on a Node version supporting
that option. Record the actual local runtime separately from Azure Node 22.

Phase B tests execute the real offload handler against both legacy aliases and
the live `OffloadStatus`/`Bay` schema. They cover historical ACTIVE/CLOSED/FINALISED
export selection without lifecycle changes, exact ULD ownership, conflicting canonical identities,
duplicate creation (including concurrent fixture transactions), required audit
rollback, pre-migration failure, and NULL-ID legacy transitions. Completion tests
cover immutable V1 bytes, deterministic V2+ hashes, full-chain validation,
transactional V2/V3/V4 writes, concurrent version allocation and rollback.
Browser tests exercise dependent selectors, stale async responses, and exact duplicate focus.
Flight Summary tests cover exact FlightId offload reads, deterministic ordering,
empty/optional-field rendering, lifecycle labels and printable live summaries.
Flight Statement tests cover read-only exact FlightId/CompletionId/version reads,
V1 exact-byte verification, contiguous V2+ chain validation, immutable selected
snapshots, version selection, offload rendering and matching print output.
The SQL fixture models eligibility and locking; it does not execute T-SQL or
prove Azure SQL DST, FK, CHECK, or filtered-index behavior. Run the isolated SQL
checks in `migrations/phase-b-review.md` before applying the review-only migration.

Historical-flight follow-up: the recent-created/today restriction is removed from
offload selection and creation. Options show flight number, full operating date,
lifecycle and FlightId. Tests cover CLOSED duplicate/concurrent requests, exact
ownership across dated flights, unchanged lifecycle, and stable audit IDs.
Completion-backed CLOSED/FINALISED offloads append full immutable snapshots to
`ExportCompletionAmendments` in the same transaction as the operational mutation
and audit. V1 is verified from its exact stored bytes and never rewritten. Flights
without a completion record create and progress offloads without an amendment.
The additive `export-completion-amendments.sql` migration is review-only and must
be rehearsed after the Phase B identity migration before this behavior is deployed.

For the real Azure SQL migration/concurrency rehearsal, follow
`migrations/phase-b-rehearsal.md`. Its explicitly invoked runner is
`tests/integration/phase-b-rehearsal.js`; it is not included in the mock regression
suite. It requires Node 22, an acknowledged disposable copy, and a test-only
connection. Never point it at production. On Node 22 versions exposing isolation
as experimental, use `--experimental-test-isolation=none` instead of
`--test-isolation=none` for the regression command above.

Fixtures exercise the actual backend and inline frontend normalizers. Handler
tests use a small in-memory SQL stand-in to verify canonical writes, flight
scoping, legacy collisions, rejection, transaction/lock requests, and FOW
state/traceability preservation. They do not prove SQL Server lock behavior.

The confirmation-safety checks exercise the inline frontend stable-ID resolvers
and delayed ULD/offload mutations across reorder, insertion, removal, stale
status, duplicate-number, and failed-request scenarios.

The scan-ambiguity checks exercise global full-ULD and numeric-serial candidate
selection, explicit handling of duplicate candidates, and stable-ID resolution
after live polling replaces or reorders the arrays. They also cover offload
operating-date labels, legacy OffloadId fallbacks, selected-offload focus, and
the stable FlightId request contract.

The atomic-status checks execute the canonical ULD status and offload handlers
against an in-memory SQL stand-in. They force status changes between
the initial read and final UPDATE to verify conditional mutation, rollback,
identity-verification safety, authoritative transactional audit writes, trusted
actor attribution, and suppression of rejected movement/audit records. They
also cover idempotent mail auditing and browser duplicate-audit prevention.
Offload cases verify exact FlightId attachment, flight-context mismatch
rejection, linked OperatingDate responses, and transactional rollback when a
required audit insert fails.

The flight-concurrency checks execute the manual, manifest-upload, and MACH FOW
handlers against a transaction-aware SQL stand-in. They force simultaneous
requests for the same canonical flight/date identity and verify one flight,
preserved endpoint conflict/reuse semantics, ULD/link creation, inactive-flight
handling, and rollback after a forced post-flight failure.

Before deployment, use an isolated SQL test database with the existing schema
and indexes to run simultaneous manual/FOW requests against the same existing
flight, including one with no ULDs. Verify one ULD, independent message links,
and preserved status/verification. Repeat on different FlightIds and confirm
separate ULDs. Check lock contention with representative flight sizes.
