# Import ULD metadata deployment review

The Import-only **Add ULD** workflow needs structured persistence for the ELD
marker and for who deliberately added the ULD. Existing ULD columns and SHCs do
not carry that evidence without ambiguity, so the application change must not
be deployed before this additive schema change.

Deployment order:

1. Back up the target and confirm the intended database and credentials.
2. Run `import-uld-metadata-preflight.sql` read-only. Its final result set must
   contain zero rows.
3. Apply `import-uld-metadata.sql` once using the deliberately authorised schema
   migration identity.
4. Run `import-uld-metadata-verify.sql` read-only. Its final result set must
   contain zero rows and both defaults plus the trusted evidence check must be
   present.
5. Deploy the application only after verification succeeds.
6. Smoke-test one active Import flight: add a canonical ULD, confirm it begins
   `UNARRIVED`, verify the ELD/ADDED display and `IMPORT_ULD_ADDED` audit, then
   confirm an Export flight exposes no manual Add ULD action.

The migration retains every existing ULD row. Existing rows receive false ELD
and operator-added flags; no status, identity, timestamp, SHC, or movement data
is rewritten. The application and migration remain local until this order is
reviewed and deliberately executed.
