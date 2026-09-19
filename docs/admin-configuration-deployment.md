# Admin configuration deployment plan

The application changes in this branch must remain local until the schema is deliberately deployed and verified.

## Phase A: schema and read-only comparison

1. Run `migrations/admin-configuration-preflight.sql` with the existing live read-only preflight identity.
2. Stop if any row appears in the final STOP result set. Existing `CargoRun*` tables require manual reconciliation; do not rerun or merge automatically.
3. Review the exact current fallback seeds in `migrations/admin-configuration.sql` against the deployed frontend version.
4. Apply `migrations/admin-configuration.sql` once with an approved migration identity and change record.
5. Run `migrations/admin-configuration-verify.sql` read-only. All schema integrity result sets must be empty. The separate Phase C Admin gate is expected to report not ready until roles are assigned.
6. Deploy the read-only API and Admin Centre shell.
7. Compare resolver output with current production output for airline badges, priority grouping, acceptance alerts, export alerts, mail, and offload ageing. Existing fallback remains operational authority during this comparison.

## Phase B: Admin bootstrap and mutations

1. Obtain the intended first Admin's stable Azure Static Web Apps `clientPrincipal.userId` from the authenticated `/.auth/me` response. Do not use `userDetails`, an email address, or a display name.
2. Copy `migrations/admin-bootstrap-user.sql` to a temporary file outside the repository. Replace its single `__REPLACE_WITH_AZURE_SWA_USER_ID__` placeholder in that copy and review the change.
3. Execute the temporary copy once with the approved migration identity. The transaction creates or reuses `ADMIN`, grants the complete Phase A capability catalog, assigns exactly that stable identity globally, and writes one immutable configuration-audit row when state changes.
4. Run `migrations/admin-bootstrap-user-verify.sql` read-only. Its final STOP result set must be empty, exactly one effective Admin must be listed, and both `HasManageUsers` and `HasViewAdminAudit` must equal `1`.
5. Delete the temporary copy containing the stable user ID. Keep the repository template unchanged.
6. Add server mutation endpoints that require explicit capabilities and write the configuration row plus `CargoRunConfigurationAudit` in one transaction.
7. Add validation for allowed codes, minute ranges, dates, duplicate versions, bulk-review tokens, and audience ownership.
8. Use the audited mutation path to add a second recovery identity where staffing permits before enforcement is considered.
9. Enable `AUDIT` mode first. Record decisions that enforcement would deny without denying current operators.

The bootstrap and its verification do not enable capability enforcement. The current Admin API continues to report `LEGACY_OPERATIONAL_AUTHORIZATION`; enabling `AUDIT` or `ENFORCED` remains a separate application deployment decision.

## Phase C: explicit enforcement and operational adoption

1. Resolve every current operator to required capabilities and review audit-mode denies.
2. Enable server-side `ENFORCED` mode through secure environment configuration, with rollback to `AUDIT` documented.
3. Wire one business-rule family at a time to configured resolution, starting with presentation-only airline profiles and SHC groups.
4. For each family, compare configured and fallback decisions before switching authority.
5. Snapshot evaluated rule identifiers into new immutable evidence only after a separate evidence-version review. Never rewrite old snapshots.

## Stop conditions

Stop deployment if preflight finds an existing object, verification finds a disabled/untrusted constraint or trigger, resolver output differs from current fallback, no Admin recovery identity exists, mutation audit cannot be atomic, tests fail, or an integrity rule would become configurable.
