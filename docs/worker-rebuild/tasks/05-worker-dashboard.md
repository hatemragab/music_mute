# Branch 5: codex/worker-dashboard

**Parent:** accepted `codex/worker-runtime` synchronized to collection. **PR base:** `codex/worker-rebuild`. **Checkpoints:** E1–E5.

## Assignment

Build the minimum administrator experience needed to operate the accepted MVP safely. Reuse existing dashboard authentication, permissions, API client, layout, and design system. Do not create a second backend or expose worker credentials.

## E1. Navigation, permissions and machine list

Add protected fleet navigation and routes. Show loading, empty, error, unavailable, and stale states. List machine name, platform, GPU/runtime, release, active/paused/revoked state, last contact, current job, and recent error summary with server-side pagination.

## E2. Enrollment and installation status

Create one-use invitations with explicit expiry and one-time secret display. Clear secrets when the dialog closes and never put them in URLs, telemetry, or persistent browser storage.

Show pending, validating, active, failed, expired, and abandoned installation states plus bounded sanitized diagnostics. Support safe invitation revocation and retry through a new invitation.

## E3. Machine detail and current work

Show identity, session/slot state, capabilities proven in B/D, desired/applied policy revision, current attempt, processing stage, recent bounded logs, and last errors. Do not expose user audio URLs, machine credentials, or private internal fields.

## E4. Safe controls and pipeline policy

Implement drain/pause/resume new claims, revoke machine, bounded concurrency, typed doctor/benchmark actions, new-job recipe defaults, and machine/slot recipe eligibility as specified by the accepted architecture. Use accessible confirmation, visible failures, optimistic revisions, and request IDs for retried mutations. Running work retains its frozen recipe and follows accepted drain/cancel semantics; the UI must not imply an action completed before acknowledgement.

## E5. Contract and UX verification

Test permissions, invitation expiry, concurrent changes, unknown IDs, long/adversarial log text, pagination, stale/offline states, session permission changes, keyboard operation, focus restoration, and bounded rendering.

**Exit:** dashboard format/lint/typecheck/tests/build and contract fixtures against the accepted control plane. Push/open PR and stop. Automatic fleet-update rollout controls are post-MVP; other dashboard scope remains governed by the accepted architecture and explicit branch review.
