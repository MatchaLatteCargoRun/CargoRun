# CargoRun Admin configuration Phase B

Phase B adds explicit, capability-authorized configuration writes to the Phase A schema. It does not enable capability enforcement for operational APIs. Those APIs remain in `LEGACY_OPERATIONAL_AUTHORIZATION`; only the new Admin mutation operations resolve CargoRun capabilities from the stable Azure Static Web Apps `clientPrincipal.userId`.

## Mutation contract

The `configuration-control/{operation?}` function accepts authenticated `GET` requests for the existing snapshot and explicit `POST` operations for:

- `airlines` — `EDIT_AIRLINE_RULES`
- `shc-groups` — `EDIT_SHC_RULES`
- `shc-mappings` — `EDIT_SHC_RULES`
- `priority-rules` — `EDIT_SHC_RULES`
- `sla-rules` — `EDIT_SLA_RULES`
- `mail-rules` — `EDIT_AIRLINE_RULES`
- `preview` — read-only shared-resolver evaluation

Each mutation begins a SQL transaction, resolves the authenticated identity's effective capability inside that transaction, obtains a transaction-owned application lock, appends the effective-dated configuration version, and appends immutable `CargoRunConfigurationAudit` evidence. Audit failure rolls back the configuration version. Successful commit invalidates the bounded configuration cache. Duplicate same-scope/same-effective-date versions return a conflict rather than replacing history.

Airline codes and SHC group keys are stable identities. Existing identities are never renamed; edits append profile or group versions. Disabling uses a later version. SHC mappings are many-to-many `INCLUDE` or `EXCLUDE` decisions at Global, Station, Airline, or Airline + Station scope. Unknown operational SHCs remain raw evidence and are only added to the configuration master when an administrator explicitly includes them in a reviewed mapping decision.

## Activation state

| Rule family | Phase B state |
| --- | --- |
| Airline display | Fallback only in operational screens; editable and previewable |
| SHC grouping and priority | Fallback only in operational screens; editable and previewable with the shared resolver |
| SLA | Shadow/compare in Admin preview; existing Supervisor logic remains authoritative |
| Mail | Shadow/compare in Admin preview; existing CX/UA behavior remains authoritative |
| Documents, Messaging, Employees, Stations | Read-only |

This staging prevents a configuration edit from changing current operational behavior before production parity has been measured. No schema changes are required beyond the already deployed Phase A schema.
