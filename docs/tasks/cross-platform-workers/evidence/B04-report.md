# B04 execution report — local implementation

Date: 2026-09-13. Scope: backend releases/groups/explicit selected rollouts and signed publication receipt boundary. No commits, pushes, distribution publication, deployment, live services, real data changes, migrations, backfills, or legacy compatibility paths were performed. Unrelated Android and F01/B01 work was preserved.

## Implemented source

- `backend/src/worker-releases/publication-receipt.ts`: real Ed25519 authority verification, canonical signed bytes, exact schema and binding validation, bounded artifacts, expiry, exact configured public origin and safe immutable artifact paths. Unknown/unconfigured authority fails closed. No network fetch of caller-controlled URLs and no development trust bypass.
- `worker-release.schema.ts`: separate worker releases, saved groups, global release policy/fence, immutable selected rollout membership, and per-worker update policy. Mobile app release collections are untouched. Build numbers are uniquely reserved and monotonically increasing when a draft is created; published metadata has no mutation API.
- `worker-rollouts.service.ts`: existing `AdminOperationsService.run` audit/idempotency/replay and authority fencing; revision-checked groups; bounded deduplicated selection; explicit compatibility previews; group/member/worker-policy/management/compatibility confirmation CAS; explicit supersession; transactional lifecycle fencing; stable-new-install metadata; pause and selected retry; authenticated ordered stage observations; persisted independent ready-attempt evidence for verification; withdrawn-target holds and dynamically filtered fallback allowlists.
- `worker-releases.controller.ts` / `worker-releases.module.ts`: all B04 admin, worker and stable-bootstrap routes. Existing workers.read/workers.manage permission vocabulary is reused without adding redundant permissions. Publication, withdrawal, stable, confirmation and retry use fresh admin auth and sensitive operation budgets. Worker routes use WorkerOnly/WorkerCleanup permanent identity and existing RateBudgetService/RateLimitKeys with fail-closed Redis and hashed IDs. Existing global security admission also applies.
- Scoped integration: `backend/src/app.module.ts`, validated trust configuration in `backend/src/config/environment.ts`, and `WorkerRuntime.rolloutFence` in B01's runtime schema. Rollout writes increment this separate internal fence so concurrent runtime compatibility writes cannot pass a stale snapshot. Ordinary telemetry neither increments managementRevision nor invalidates a preview when only liveness/activity changed.
- `contracts.md`: exact H02 signed receipt envelope, signing bytes, trust settings, expiry behavior, B04 confirmation/status request shapes, and B05 transaction integration are documented for subsequent consumers.

## Behavioral evidence and red/green chronology

The receipt unit suite was written before its implementation. Its initial run failed because the new receipt module did not yet exist. After implementation it passed all four assertions: exact valid signature, absent authority rejection, modified origin/digest/length rejection, and expired valid-signature rejection. This initial red was a module-availability failure, not an assertion-level result; it is not misrepresented as one.

The compiled integration fixture was introduced before the schemas/service. Its initial run likewise failed on missing compiled module. The first complete implementation then passed against native isolated Mongo replica-set services. Subsequent behavioral fixtures expanded the real compiled integration rather than substituting mock persistence. An invocation from the repository root failed because the existing service helper resolves `test/helpers/redis.conf` relative to backend; rerunning from backend succeeded. This was a test invocation issue, not a passing test.

Self-review identified that activation needed its own current compatibility check after a preview/prepare. A regression fixture changed the reported model digest immediately before activation. The compiled test failed with **AssertionError: Missing expected rejection** at that activation assertion. The fix rechecks runtime compatibility and writes its fence inside activation authorization. Rebuild and the same fixture then passed. Thus the discovered activation race has an observed assertion-level red/green cycle.

The compiled integration now checks:

- Actual Ed25519-signed draft/publication, monotonic build rejection, audited mutation receipts, and exact operation replay recovering the original group resource ID.
- Group A/B snapshot exclusion of later C; stale membership rejection; stale management revision and runtime compatibility rejection; heartbeat/controlRevision and activity-only changes remaining valid.
- Same-preview concurrent rollout confirmation produces exactly one winner; explicit 1001 selection rejection; target/floor/stable independence for previously unselected workers.
- Competing target refusal without explicit supersession and a successful explicit replacement.
- Pause prevents activation and preserves a running stage; selected retry resumes only its selected candidate while another remains held.
- Ordered available/downloaded/prepared/validating/activating/running state progression. Changed runtime model blocks activation. A boolean/self-attestation cannot mark a candidate verified; a different worker's successful attempt is rejected; a matching persisted ready attempt after running plus current build can mark verified.
- Published fallback appears in policy, withdrawn fallback disappears, withdrawn target returns hold with null target, and withdrawn stable selection returns null.
- A real Nest worker HTTP boundary with actual registry guard rejects anonymous and installation-token requests; rejects foreign owner fields; returns no-store current policy; real Redis exhaustion produces 429; keys do not contain worker IDs; disconnecting Redis produces 503.

## Validation

Commands run from `backend/`:

```sh
npm test -- src/worker-releases/worker-rollouts.service.spec.ts
npm run typecheck
npm run lint
npm run build
node --test test/worker-rollouts.integration.mjs
```

Final local rerun passed every command above (unit suite: 4 tests; compiled integration: one comprehensive real-services scenario, 5.65 seconds overall). Scoped Prettier was applied to the B04 source, integration test and touched app/config/runtime files. Independent review belongs to the controlling task. No simulator/device test is relevant to this backend-only work, and no native launcher/TUF server or GPU proof is claimed.

## Important boundaries and remaining downstream work

H01/H02 must implement atomic distribution and the publisher authentication boundary and emit the exact documented signed receipt after TUF target/byte verification. Backend receipt verification is real now, tested with ephemeral local signing keys; no deployed publisher, live distribution receipt or downloaded production artifact has been tested. Backend rejects publication if authority is unconfigured. A draft whose exact signed receipt expires cannot be edited or refreshed in place; create a new build/draft. Successful idempotent operation replays remain recoverable after expiry.

B05 owns actual fresh-claim minimum-build, runtime/qualification and update-hold enforcement. It must use exported WorkerUpdatePolicy/ReleasePolicy models in the existing transaction, write WorkerControl and ReleasePolicy.fence, and preserve owned-attempt compatibility. B04 does not claim that merely exposing policy enforces fresh claims. Stable publication never fills a missing worker policy. B01 identity capability remains unsupported until the later worker-update consumer is integrated.

The current supported verification observation is a separately identified persisted real processing attempt (`JobAttempt.outcome = ready`), not a fabricated synthetic validator. Synthetic-job qualification and launcher consumer behavior are later tasks. `WorkerRollout.workerIds` preserves all historical recipients while its detail's current policy rows/count explicitly exclude superseded recipients; observed status is the current candidate state, not a complete append-only event timeline (structured event retention belongs to B03). Desired/current/unknown/offline counts stay separate.

Compatibility now distinguishes signed source eligibility from exact installed target identity, as corrected below. Incompatible/missing selections reject atomically at confirmation. State-read range is preserved in signed metadata for the local W04 reader, not inferred from B01 runtime fields that do not report a state-schema version. Signed profile approval/hardware qualification is consumed later by B05/H02; B04 authenticates the authority's exact profile binding and does not claim native qualification proof.

## Round 1 independent-review corrections

Read `B04-review.md` and addressed both findings without changing B05 claim ownership or adding a compatibility decoder.

P1: `WorkerReleaseTarget` now has required signed `os`, `arch`, and `compatibleSources` (0-32 unique exact profile/model/runtime-lock tuples with required `rollbackAllowed`). Signature verification binds these fields and rejects invalid platform values, malformed/duplicate tuples and tampering. Selection considers every artifact: current exact recipe or a listed signed source may prepare the target only with matching OS/architecture and launcher/protocol bounds; multiple matches are rejected. Activation checks that source while reporting the truthful old observed build. Running/verified instead require the new exact installed target build/profile/model/runtime-lock/platform. Current runtime writes are fenced at these transition boundaries. The new target's signed source entry can explicitly authorize reverse rollback to an immutable old release; policy still requires explicit fallback IDs, published state, floor, exact observed restored identity and an unambiguous compatible artifact. W04 remains responsible for actual local stateReadMin/stateReadMax compatibility before restoration. Source eligibility never stands in for installed readiness in B05.

P2: detail uses the newest WorkerRuntime.receivedAt/WorkerControl.lastSeenAt with configured PROCESSING_LEASE_SECONDS (default 90 seconds) for machine liveness. It exposes lastSeenAt separately. No liveness means unknown; stale actual liveness means offline. WorkerUpdatePolicy.receivedAt is left as the last real ordered stage observation. Retry clears receivedAt and observedBuild rather than carrying an old candidate's acknowledgement.

Regression-first evidence:

- Before the P2 fix, the new real-service assertion aged only a verified update event while keeping runtime liveness fresh; it failed `1 !== 0` for offline count. The fix makes that assertion pass and preserves the old event timestamp. Additional tests age real runtime/control liveness to produce offline, remove both liveness sources to produce unknown, and check retry resets acknowledgement.
- Before extending the signed receipt verifier, the valid new-shape unit fixture failed `HttpException: Invalid request`; the verifier extension restores its valid-signature acceptance with the new fields covered by the signature.
- Before separating source/target identity, truthful old-build activation in the compiled regression failed `HttpException: Invalid request`. The implementation now accepts it while retaining old observedBuild until startup.
- Compiled integration now performs a real signed build-4 change of **profile, model and runtime lock** from the original recipe: preview/confirm/source preparation/activation, rejection of falsely claimed target startup, exact target runtime startup, rejection of incorrect model at verification, persisted own successful processing-attempt verification, and explicit rollback to the old signed source recipe.
- Signed but unlisted source identity, wrong OS, wrong architecture, tampered rollback metadata, rollbackAllowed=false, ambiguous matching artifacts, wrong observed rollback identity, and withdrawn fallbacks are exercised and rejected as appropriate. Old release metadata is never edited to authorize the future recipe.

Updated `contracts.md` and `worker/contracts/worker-protocol-v3.json` together with both backend fixture suites. No source hash checks were relaxed. The shared fixture's releaseTarget illustrates a signed transition from its existing runtime tuple to a new recipe.

Validation commands are the same scoped formatter, typecheck, lint, unit, build and native compiled integration commands listed above. The final round-1 rerun passed all of them (four unit tests and the expanded native Mongo/Redis/Nest integration, 5.82 seconds overall), including missing-liveness/retry-reset/new-recipe verification assertions. No commit, distribution publication, live database, native worker launch or device proof is claimed.
