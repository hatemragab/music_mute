# E dashboard evidence

Observed 2026-09-20 in Africa/Cairo on `codex/worker-dashboard`.

## Identity

- Parent accepted collection commit:
  `481d5ee9ea23b99b0f19a1cd4d1cdaa6dea491a7`.
- Tested implementation commit:
  `c9196cfb0754f4cf3d737e90c2d651dee14cd327`.
- Host: Darwin 25.6.0, arm64.
- Toolchain: Node.js 24.18.0 and pnpm 10.14.0.
- Browser verification: Playwright Chrome against the isolated compiled backend
  on port 3101. The user's backend on port 3100 was not stopped or modified.

## Scope

This checkpoint adds the minimum safe fleet administration surface. It covers
fleet discovery, one-use enrollment, installation history, machine detail,
bounded diagnostics, machine operations and the revision-fenced pipeline
policy. Backend list projections and indexes were extended only where the
dashboard needed bounded, stable data.

## Checkpoint results

| ID  | Status | Evidence                                                                           | Actual observation                                                                                                                                                                | Remaining input                                         |
| --- | ------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| E1  | PASS   | Protected routes, role matrix, fleet list, server cursor/filter tests              | Owner, support and viewer see only permitted navigation; the list renders platform, runtime, release, contact, current work and error state with stable server pagination         | None for dashboard acceptance                           |
| E2  | PASS   | Enrollment dialog unit/browser tests and invitation installation projection        | Fresh authentication is required; the credential exists only in dialog-local state, is not recoverable from history, and is cleared on close                                      | Live fleet enrollment remains an integration checkpoint |
| E3  | PASS   | Machine detail browser flow, diagnostic unit test and compiled backend projections | Identity, sessions, slots, capabilities, revisions, current/recent attempts, commands, installation state and bounded redacted diagnostics render without private URLs or secrets | Live runtime data remains an integration checkpoint     |
| E4  | PASS   | Reasoned operation dialogs, permission browser tests and policy contract tests     | Pause, drain, resume, revoke, doctor, benchmark and policy updates use fresh auth where required, operation IDs, expected revisions and request IDs                               | None for dashboard acceptance                           |
| E5  | PASS   | Complete backend and dashboard verification listed below                           | Contract, permission, adverse-state, accessibility, responsive-width and production-build gates passed                                                                            | Production deployment was not requested                 |

## Delivered behavior

- Added `/workers` and `/workers/:id` behind `workers.read` and aligned the
  dashboard role presentation with backend worker permissions.
- Added status, platform, group and release filtering, opaque server cursor
  pagination, stable null-last-seen ordering and supporting MongoDB indexes.
- Joined bounded current-attempt, recent-error and installation-status summaries
  without returning invitation credentials or private internal fields.
- Added one-use invitation creation, revocation and replacement guidance. A
  replay which cannot re-show the credential fails closed and directs the
  operator to revoke and replace it.
- Added machine controls, doctor and benchmark requests, policy editing with
  expected revisions, safe bounds and explicit future-claim semantics.
- Added bounded diagnostic presentation: at most 10 entries, 20 displayed lines
  per entry and 1,000 characters per line. Signed URLs, authorization headers,
  credentials, tokens and secrets are redacted again in the browser.
- Added loading, empty, error, stale, offline and never-contacted states, request
  IDs on failed operations, responsive table containment and keyboard focus
  restoration after the enrollment dialog closes.

## Commands actually executed

- `cd backend && pnpm run verify`
  - PASS: Prettier.
  - PASS: oxlint with zero warnings and errors.
  - PASS: TypeScript typecheck.
  - PASS: four tracked-secret checks and tracked-secret scan.
  - PASS: 110 unit files, 753 tests.
  - PASS: 22 E2E files, 135 tests.
  - PASS: Nest production build.
- `cd dashboard && pnpm run format:check`
  - PASS.
- `cd dashboard && pnpm run lint`
  - PASS with zero warnings.
- `cd dashboard && pnpm run typecheck`
  - PASS.
- `cd dashboard && pnpm run test`
  - PASS: 18 files, 56 tests.
- `cd dashboard && pnpm run build`
  - PASS: production Vite build.
- `cd dashboard && DASHBOARD_E2E_API_PORT=3101 pnpm run test:e2e`
  - PASS: 32 Chrome tests, including the worker flow, permissions, compiled
    backend contracts, responsive widths and accessibility.
- `git diff --check`
  - PASS before the implementation commit.

## Hardware and runtime evidence

No new GPU inference was required for E. The UI consumes the already accepted
Mac mini M4/CoreML and Z440/RX 580/DirectML capability and qualification
metadata. The current Z440 address `192.168.1.7` initially timed out, then
became reachable through owner-authorized SSH. A read-only audit confirmed the
automatic `MusicMuteWorker` service uses `LocalService`, active release `0.1.1`
and preserved private config/credential files; the service remains stopped as
recorded by the prior `0.1.3` stage. The Mac backend was not reachable from the
Z440, and no remote state changed.

## Failure, recovery and safety evidence

- Cursor scope changes are rejected, including changes to status, platform,
  release or limit.
- Unknown machines, stale policy revisions and forbidden direct routes are
  covered by backend or browser tests.
- Invitation history never contains the one-use credential. Dialog teardown
  removes the only browser copy and restores focus to its trigger.
- Diagnostic limits and redaction cover signed URLs, key/value logs, JSON token
  fields, bearer authorization headers and plain secret fields.
- Destructive and sensitive operations require a reason and fresh identity;
  response request IDs are preserved for support without exposing secrets.
- The browser suite used an isolated backend port; no production service,
  database, release or infrastructure was changed.

## Pending and limitations

- This is local and isolated-browser acceptance, not production deployment or
  a live fleet/dashboard run.
- The runtime checkpoint still lacks live backend/S3 bootstrap on both native
  hosts, logged-out and reboot acceptance, and Windows interrupted-upgrade
  recovery acceptance.
- Z440 SSH is reachable, but the Mac-hosted backend is not yet exposed to the
  host and no live enrollment/S3 activation was run in this checkpoint.

## Handoff

- Dashboard checkpoints E1-E5 are ready for review and merge into
  `codex/worker-rebuild`.
- After that merge, the permitted successor is `codex/worker-integration`.
- Integration must not reinterpret this simulated dashboard data as live fleet
  acceptance.
