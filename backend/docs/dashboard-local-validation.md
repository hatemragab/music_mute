# Dashboard backend local validation

The dashboard contract is validated by the backend unit, HTTP, build, and isolated
dashboard integration suites. Current fixtures cover administrator access, retained
jobs, users, account recovery, deliberate media grants, releases, update policy,
basic settings, health alerts, activity, and exports.

Execution-machine administration, execution attempts, recovery, retry, and queue
capacity are absent from the current route and workflow fixtures. New processing
uses the canonical `PROCESSING_UNAVAILABLE` boundary.

These checks use test-owned local MongoDB/Redis processes and synthetic provider
doubles. They do not prove live Firebase, S3/IAM/CORS, Android tooling, production
data, or deployment.

Compare dashboard typed contracts against [dashboard-api.md](dashboard-api.md),
permissions against [dashboard-permissions.md](dashboard-permissions.md), and the
compiled route inventory against
[`test/fixtures/dashboard-contracts/routes.json`](../test/fixtures/dashboard-contracts/routes.json).
