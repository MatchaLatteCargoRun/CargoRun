# CargoRun controlled application recovery

Status: local candidate only. No recovery commit, push, workflow dispatch or Azure upload has occurred.

The recovery branch `recovery/cbb579c-controlled` starts from baseline source `cbb579c27d4c1b20d91429abd66d6b6a1963c476`. Its 83 published application files must match `docs/recovery-source-contract.json` and the preserved local package at `C:\Users\Maxwell\Documents\CargoRun-Recovery-Baseline-cbb579c`. The branch adds the reviewed lockfile, scoped dependency policy, security gate, packaging tools and a manual recovery workflow. The existing verified package stays unchanged.

## Prepare the branch for an emergency

1. Obtain separate approval to commit and push **only** this isolated recovery candidate. Do not push main or merge the recovery branch. Confirm the complete diff and source contract first. `api/node_modules`, `.release`, SQL migrations and evidence do not belong in the commit.
2. Push only `HEAD:refs/heads/recovery/cbb579c-controlled` without force. The branch push triggers `.github/workflows/validate-cargorun-recovery.yml`. That workflow has no Azure action or secret access.
3. Require a successful Ubuntu validation for that **exact recovery commit**: Node 22.23.3, npm 11.11.0, clean `npm ci`, baseline and security tests, testing and scoped production audit gates, package build and source/package verification. Record the SHA and run URL. A failed check stops the route.
4. Confirm the hosted deployment workflow in the recovery commit is manual only and the GitHub default branch still exposes the existing `deploy-cargorun.yml` workflow with `workflow_dispatch`. The recovery workflow requires `github.ref == refs/heads/recovery/cbb579c-controlled` and sets `production_branch` to that branch. A push to the recovery branch cannot invoke it.

## Execute only under separate recovery authorization

1. Freeze all CargoRun production deployments. Confirm the active app is `cargorun-dev`, its default hostname is `lemon-smoke-02c3eeb00.3.azurestaticapps.net`, AKL is disabled and ungranted, the ADMIN SQL remediation still has six global controls and no global operational grants, and the ADMIN actor has explicit MEL SUPERVISOR access. Record the current deployment identity and reason for rollback.
2. Reconfirm remote recovery ref equals the exact validated SHA. Confirm the approved exception has not expired (2026-11-08 00:00 UTC) and the current audit contains no unapproved advisory. Confirm the existing GitHub secret `AZURE_STATIC_WEB_APPS_API_TOKEN` still belongs to `cargorun-dev`; never reveal it.
3. In GitHub Actions, select the existing workflow file `.github/workflows/deploy-cargorun.yml`, choose **Run workflow**, and select branch `recovery/cbb579c-controlled`. Verify the branch and SHA before starting. Do not select main. The job checks source bytes, clean dependencies, tests, audit, allowlisted package and all package hashes before the Azure upload step.
4. The action uses the existing repository secret, `.release/public` and `.release/api`, with both builds skipped and `production_branch: recovery/cbb579c-controlled`. Verify the result reports the **default production hostname** above. If it reports a branch preview hostname or a different site, stop: the production recovery is not verified.
5. Record the workflow run, checked-out SHA, package inventory, action result, Azure deployment record and observed live hostname. Since main remains at the hardened release commit, do not infer the deployed version from main after this manual recovery.

## Read-only post-recovery checks

- Sign in as the intended ADMIN and inspect `GET /api/session`. Confirm the six control capabilities remain and MEL StationId 1 is available through explicit MEL SUPERVISOR membership. The session response combines global and station capabilities, so do not treat that list alone as proof of database grant scope.
- Open the Admin screen and its read-only configuration view. Open MEL Flight Board (`GET /api/flights?stationId=1`), History and Supervisor, and confirm their read operations succeed for an authorized MEL user.
- Confirm AKL remains absent from allowed operational stations. If an AKL row exists, use its actual ID for an authorized read request and require `403 STATION_ACCESS_DENIED`. Do not invent or seed a station ID.
- Check station timestamps remain Australia/Melbourne and monitor authorization errors and unexpected machine ingestion failures. Any test that writes data or sends MACH/FOW requires its own approval.

Stop on failed integrity/audit/test gates, an unexpected branch/SHA, wrong Azure hostname, missing MEL access, global operational ADMIN access or AKL access. Do not restore the database, regrant global ADMIN operations or enable AKL. This application recovery restores the older runtime authorization rules, so it is only suitable while the verified MEL-only data state holds. It is a new Ubuntu build from the exact baseline source and reviewed lockfile; the historical Azure artifact was not retained. Linux execution and Azure production routing remain unproven until their respective approved runs complete.
