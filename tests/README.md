# ULD normalization checks

From the repository root, run:

```sh
node --test tests/uld-normalization.test.js
```

Uses Node's built-in test runner (project runtime: Node 22). No dependencies,
database connection, credentials, or network access are required.

Fixtures exercise the actual backend and inline frontend normalizers. Handler
tests use a small in-memory SQL stand-in to verify canonical writes, flight
scoping, legacy collisions, rejection, transaction/lock requests, and FOW
state/traceability preservation. They do not prove SQL Server lock behavior.

Before deployment, use an isolated SQL test database with the existing schema
and indexes to run simultaneous manual/FOW requests against the same existing
flight, including one with no ULDs. Verify one ULD, independent message links,
and preserved status/verification. Repeat on different FlightIds and confirm
separate ULDs. Check lock contention with representative flight sizes.
