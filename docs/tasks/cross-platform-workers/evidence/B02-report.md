# B02 local implementation report

Date: 2026-09-14. Status: implementation and scoped validation complete; independent review requested. No commit, push, deployment, real-service operation, data reset, migration, backfill, or compatibility decoder was performed. Unrelated Android and root documentation edits were preserved.

## Implemented behavior

`backend/src/worker-installations/` implements exact installation ID/digest registration, installation-only bearer authentication, 24-hour validity with idempotent renewal bounded to seven days from creation, strict qualification wrappers, pairing issuance/status, and worker-administrator list/detail/approve/reject routes. Registration requires no GPU/profile evidence, so unsupported hardware can establish reporting identity. Event ingestion remains B03 work.

Native installers must generate and protect two distinct random 32-byte secrets locally, encoded as 64 lowercase hexadecimal characters. Registration submits SHA-256 of the UTF-8 installation token; pairing submits SHA-256 of the UTF-8 permanent token. Neither raw secret is persisted or returned by pairing. Every installation endpoint checks current ownership, revocation and expiry before processing retries. Registration retries must match the original ID, digest, build and platform metadata exactly.

Pairing evaluates B05's persisted release/profile/model/provider/fixture/service evidence, both when issuing and inside the approval transaction. Publication alone never qualifies a worker. Approval uses `AdminOperationsService`, fresh `workers.manage` authority, expected installation revision, expiry and one-use checks; the same Mongo session reaches `evaluateForPairing` and its release-policy fence. Approval atomically consumes the code, creates registry/control records, and binds the original installation and permanent digest. It creates no readiness observation. Authenticated status recovers the assigned worker ID without revealing a secret after a lost response.

Codes contain 50 bits displayed as ten Crockford Base32 characters in two groups, valid for 15 minutes. A random 32-byte issuance nonce plus server HMAC produces a retry-stable code. Separate HMAC domains protect code derivation and database lookup. Only the authenticated installer receives a current code. Expired issuance requires a new operation ID; permanent digest binding remains unchanged. Admin operation fingerprints receive keyed code material, never the code itself; audit records contain neither codes nor credential digests.

The existing validated `RATE_LIMIT_HASH_SECRET` supplies the HMAC authority. Domains are `musicmute-installation-code-v1` and `musicmute-installation-lookup-v1`; they are separate from existing rate-limit key domains. Keep that secret stable across API instances. Rotation invalidates outstanding code regeneration/lookup, requiring a new local issuance after expiry; it does not change permanent worker identity. No new environment variable or real secret was introduced.

## Credential-domain reservation

`worker_credential_reservations` uses the digest as its unique key and stores only immutable scope (`installation` or `worker`) and owner ID. Setup registration and first permanent digest issuance reserve it in their Mongo transaction. This prevents deliberate reuse of another installation's token as a permanent worker secret, including concurrent registration versus pairing. The temporary manual creation path and audited idle rotation also reserve new permanent digests. Public registration additionally rejects digests already present in the worker registry.

Reservations are minimal permanent operational security state, not detailed events. They are **not deleted when a session expires, a code expires, a worker rotates credentials, or an installation is rejected**. B03 must preserve them while expiring provisional metadata and 30-day detailed events. Keeping prior digests prevents later cross-domain reuse; the tradeoff is accumulating a small record per issued credential. Public admission is capped at five registrations/IP/hour and 1,000 globally/hour, in addition to existing API admission controls. There is no automatic cleanup, conversion or backfill of existing development records.

## Permanent requalification handoff

The root-approved contract addition `POST /worker/qualification` accepts the same strict `{ runtime, qualificationReport, serviceBindingSha256 }` wrapper using permanent worker authentication. It derives the installation binding from the authenticated registry identity, fences `WorkerControl` against credential changes/revocation, and stores the report in that transaction. An expired setup token does not prevent permanent-auth requalification. Wrong installation identity and revoked permanent credentials fail. This route returns only a new reported observation; `POST /worker/installation-ready` and full B05 readiness remain mandatory.

`WorkerQualificationService.store` now accepts an optional final `ClientSession`. Existing standalone callers retain the original behavior. Both setup and permanent report routes pass a session, with the relevant authority write in the same transaction.

## Limits and privacy

- Setup status/operations: 60/session/minute; renewal, qualification and pairing issuance: 10/session/hour each.
- Permanent qualification: 10/worker/hour and 100/worker/day; no lifetime quota that blocks later legitimate updates.
- Approval: 100/IP/15 minutes and 1,000 global/15 minutes, plus existing admin limits. At most five failed or currently in-flight attempts/admin/15 minutes. Successful operations and successful idempotent replays refund their own reservation; failures retain it. Redis unavailability fails closed. Rate-limit responses expose `Retry-After` through real public/admin exception handling.
- List default 50, maximum 100, bounded cursor queries. Presenters expose safe platform/session/assignment state, never nonce, code, digest, bearer, raw qualification device label or hardware information.
- Registration advertises the shared future B03 batch limits (50 events, 64 KiB); no event endpoint or retention implementation is claimed.

## Exported interfaces and ownership

- **B03:** `WorkerInstallationsModule` exports `InstallationPairingService`, `InstallationLimitsService`, and installation models. `authenticate(id, authorization, session?)` is the shared exact-scope/expiry check. Its returned document is private and includes digest fields: never serialize it. For transactional ingestion, write its `authorizationFence` with the same session before persisting events, as the qualification route does. Preserve credential reservations during metadata retention.
- **D01:** consume `/admin/worker-installations` list/detail revisions, approve/reject receipts, and privacy-safe status. Codes belong only in approval POST bodies, never URLs or lists. Remove the normal manual-create UI as the coordinated next task; audited idle rotation remains supported.
- **I01/W02/W04:** protect both local secrets before submission; persist installation ID, permanent token and pairing operation ID. Retry the same issuance only while valid. Recover worker ID through setup status, then authenticate permanently. Requalification after setup expiry uses `/worker/qualification`; it never renews or revives the old setup capability.

## Validation actually run

From `backend/`:

- `npm test -- src/worker-installations/installation-pairing.service.spec.ts src/rate-limits/rate-budget.service.spec.ts src/admin-workers/admin-workers.service.spec.ts src/worker/worker-readiness.service.spec.ts src/worker/worker-runtime.service.spec.ts` — **5 files, 65 tests passed** after final security changes.
- `npm run typecheck` — passed after reservation/module/admin integration.
- `npm run lint` — passed. One initial control-regex warning was fixed before final validation.
- `npm run build` — passed repeatedly, including the final native integration build.
- `node --test test/worker-installations.integration.mjs test/worker-readiness.integration.mjs` — both compiled integration tests passed. They use isolated local Mongo replica sets and Redis; B02 exercises real Nest controllers, AuthGuard/AdminGuard/WorkerAuthGuard, validation and public exception filtering. Firebase identities are synthetic; release approval descriptors are isolated fixtures, not native evidence.
- B02 native assertions cover fresh concurrent registration and exact retries, conflict/unknown fields, token scope, wrong report owner, fresh roles, stable issuance replay, immutable digest, code expiry/retry, stale revision, duplicate approval, approval/rejection race, lost-response recovery, seven-day renewal bound, expired/revoked setup requests, permanent requalification after setup expiry, revoked permanent token refusal, credential-domain races, temporary manual create/idle rotation reservations, code/digest privacy, exact five-failure quota, public admission `Retry-After`, and Redis fail-closed behavior.
- `npm test` — **114 files, 868 tests passed** at the earlier complete-module checkpoint, before the final credential-reservation addition. Final changes were then covered by the scoped 65 tests and native integrations above. The broad suite emitted existing Mongoose `validateSync` deprecation warnings.
- Scoped Prettier check and `git diff --check` — passed.

Additional targeted native command `node --test test/worker-installations.integration.mjs test/admin-workers.integration.mjs test/worker-readiness.integration.mjs` reported **15 tests, 4 passed, 11 failed** (the admin parent test counts among the failures). The admin suite's create/rotation/receipt/privacy subtest and its admin-first rotation/pending-poll subtest passed. Its ten remaining nested lifecycle/claim cases failed because their old fixtures omit runtime/installation/qualification/boot state and claims now reject with `RUNTIME_REPORT_REQUIRED`, or because their race assertions expected those rejected claims to succeed. Affected cases: management CAS; active drain; stopped recovery; both drain/claim orders; both recovery/finish orders; both revoke/output orders; and worker-first rotation/pending-poll. These additional B06 fixture-conversion failures are distinct from the seven previously documented broad processing failures. No bypass or conversion was introduced. B02 separately verifies actual audited creation and idle rotation in its passing native suite.

## Remaining boundaries

Independent review remains required. B03 owns event ingestion/retention; D01/B06 own manual onboarding retirement and old fixture conversion. The complete legacy processing/admin integration suites are not green. No live deployment, distribution signing/publication, actual GPU execution, native secret-store operation, unattended service reboot, mobile device test, or final installer UI was performed. F01 hardware availability remains separate. This report requests review of the bounded backend implementation, not production-readiness approval.
