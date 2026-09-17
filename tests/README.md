# ULD normalization checks

From the repository root, run:

```sh
node --test tests/uld-normalization.test.js
node --test tests/confirmation-safety.test.js
node --test tests/atomic-status.test.js
node --test tests/flight-concurrency.test.js
```

Uses Node's built-in test runner (project runtime: Node 22). No dependencies,
database connection, credentials, or network access are required.

Fixtures exercise the actual backend and inline frontend normalizers. Handler
tests use a small in-memory SQL stand-in to verify canonical writes, flight
scoping, legacy collisions, rejection, transaction/lock requests, and FOW
state/traceability preservation. They do not prove SQL Server lock behavior.

The confirmation-safety checks exercise the inline frontend stable-ID resolvers
and delayed ULD/offload mutations across reorder, insertion, removal, stale
status, duplicate-number, and failed-request scenarios.

The atomic-status checks execute the canonical ULD status and offload handlers
against an in-memory SQL stand-in. They force status changes between
the initial read and final UPDATE to verify conditional mutation, rollback,
identity-verification safety, authoritative transactional audit writes, trusted
actor attribution, and suppression of rejected movement/audit records. They
also cover idempotent mail auditing and browser duplicate-audit prevention.

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
