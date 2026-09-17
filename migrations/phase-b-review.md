# Phase B review — not executed

The migration and verification SQL are manual review artifacts. No API, startup
hook, or deployment workflow executes them.

## Legacy rule

Keep the exact reviewed OffloadIds 1–12 allowance. A boundary (`<=12`) would also
admit unreviewed zero/negative IDs. A mutable `LegacyRecord` flag adds a bypass and
another field to protect. Application-only validation allows old writers to
continue inserting NULL identities. A separate allowance table or trigger is not
needed for twelve fixed records. Restrict runtime identity reseeding,
IDENTITY_INSERT, deletion/recreation of historical records, and schema changes.

The migration checks the reviewed IDs, flight associations, known ULD numbers,
and statuses. It cannot detect changes to unprovided historical bay/instruction
values; retain the preflight export for independent comparison if required.
No legacy exception is extended automatically if the population changes.

## Deployment

1. Test schema and application together in isolated Azure SQL, including required
   filtered-index SET options on every API connection.
2. Pause/drain writers before the short schema transaction (table locks are used).
3. Repeat canonical collision/data checks; confirm the reviewed population and
   proposed object names. Apply `phase-b-offload-identity.sql` only after approval.
4. Run `phase-b-verify.sql`: trusted/enabled constraints, correct index keys/filter,
   all twelve legacy UldIds NULL, Offload 9 REQUESTED/unlinked, Offload 12 unchanged.
5. Deploy compatible backend/UI, smoke-test, then resume writers. Old creation
   code must fail the NULL-UldId CHECK; old transition SQL remains valid.

New code before migration returns OFFLOAD_SCHEMA_NOT_READY on creation; existing
GET and PATCH continue working. No versioned summary code is included.

## Isolated SQL tests required

- Legacy ID 9 collection/completion succeeds without any inferred IDs; stale retry
  returns STALE_STATUS and no extra audit. Historical ID 12 remains unchanged.
- Old INSERT omitting UldId is rejected. NULL FlightId/non-NULL UldId is rejected.
- Wrong-flight UldId is rejected by composite FK.
- Two simultaneous same-pair creates produce one active row/audit and one conflict.
- A direct duplicate insert is rejected by the filtered unique index.
- COMPLETE history permits a subsequent request.
- Audit failure rolls back insertion. ULD/flight lock contention and deadlocks fail
  closed; SQL mock tests cannot establish actual lock behavior.
- SQL creation boundary and Melbourne date/DST conversion match the approved rule.

## Rollback

Failed migration rolls back its own schema changes. After successful migration,
retain additive schema/evidence. If creation has a problem, disable creation while
keeping OffloadId-based transitions available. Do not drop integrity constraints
to restore unsafe old creation code. Any schema rollback requires a separate
review once new non-NULL identities exist.
