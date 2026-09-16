# Dashboard contract summary

The detailed current contract is maintained in
`backend/docs/dashboard-api.md`. The route inventory used by isolated tests is
`backend/test/fixtures/dashboard-contracts/routes.json`.

## Shared rules

- `/api/v1/admin/*` requires an admitted verified Google administrator and returns
  `Cache-Control: no-store`.
- Permissions are derived by the backend from the stored role.
- Revisioned mutations use `expectedRevision`, UUID `operationId`, and a bounded
  nonblank reason.
- Signed media and upload URLs never appear in operation receipts or audit events.
- Cursor values are opaque and tied to their original filters.

## Current surface

The contract covers administrator access, overview, retained jobs, user controls,
account recovery, private media grants, releases, update policy, basic settings,
health alerts, audit events, and bounded exports.

There is no machine registration, key, lifecycle, execution, attempt, recovery,
or queue-capacity contract. New processing creation and retry remain behind the
canonical `PROCESSING_UNAVAILABLE` response until a separately approved redesign.
