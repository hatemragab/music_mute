# B02 independent review

Date: 2026-09-14. Decision: **approve the bounded local B02 backend scope**. No critical or important correctness/security finding was identified in this review. This is not fleet, native qualification, or production-readiness approval.

## Scope and assessment

Reviewed the B02 task, shared contracts and execution brief against the actual installation module, permanent qualification handoff, shared rate-budget change, credential reservations, admin creation/idle rotation integration, and relevant B05/admin/worker transaction authority. Preserved implementation and unrelated work; this review changes only this evidence file.

- Registration reserves the digest and immutable installation ID/build/platform binding in the same transaction. Conflicting reservations roll back; duplicate-key races retry with a fresh transaction snapshot. Reservations use the digest as their unique Mongo `_id`. Setup versus worker scope and owner must agree on reuse. Keeping these minimal reservations permanently is the approved security architecture; rejection, expiration and rotation do not release them.
- Setup authentication checks the exact path identity, bearer digest, revocation and expiry before operation receipts. Registration retries also check expiry and original metadata. Renewal remains bounded to seven days from creation. A rejected installation cannot renew or submit further authorized work.
- Nested qualification validation and B05 ownership checks prevent a runtime/report from being attached to another installation. Setup reports write the installation authorization fence. Permanent reports derive the original installation from the authenticated registry identity and fence current credentials/revocation through WorkerControl in the same session. Neither path grants readiness.
- Pairing permanently fixes the worker digest, derives a retry-stable 50-bit code through separate HMAC domains, and requires a new operation after code expiry. B05 evaluation runs both on issuance and inside approval, receiving the approval Mongo session and release-policy fence.
- Approval uses fresh worker-management authorization, the admin authority write fence, the expected installation revision and unexpired pending code. Registry/control creation, code consumption, assignment and audit receipt commit together. Rejection conflicts on the same installation document. Lost responses recover the same identity without exposing a raw permanent key or creating runtime readiness.
- Public admission, setup/permanent rolling budgets and approval IP/global limits are present. Failed/in-flight approval reservations use unique Redis members; success removes only its own member. The controller retains failed slots and refunds successful receipts/replays. Redis errors fail closed.
- Safe presenters omit code material, digests, credentials and qualification hardware details. The audit command receives keyed lookup material for fingerprinting, not the raw code, and receipts contain no secret.

The temporary manual-create and idle-rotation paths reserve their newly generated credential digests inside their existing audited transactions. Pairing reserves with the stable installation as owner; subsequent rotations reserve new digests with the worker as owner. No later operation attempts to transfer or release the original reservation, so this ownership distinction does not break normal pairing or rotation.

## Independent validation actually run

From `backend/`:

1. `npm test -- src/worker-installations/installation-pairing.service.spec.ts src/rate-limits/rate-budget.service.spec.ts src/admin-workers/admin-workers.service.spec.ts src/worker/worker-readiness.service.spec.ts src/worker/worker-runtime.service.spec.ts` — **5 files, 65 tests passed**, exit 0.
2. `npm run build` — passed, exit 0.
3. `node --test test/worker-installations.integration.mjs test/worker-readiness.integration.mjs` — **2 compiled native integration tests passed**, exit 0, using isolated local Mongo replica sets and Redis.
4. An additional review-only `node --input-type=module` probe, supplied through stdin without creating a repository helper, exercised the compiled `RateBudgetService` with isolated real Redis. Twenty concurrent reservations admitted exactly five. Refunding one admitted member allowed exactly one replacement. Repeating that refund and refunding an unknown member left all other slots intact. Rejection because another bucket was full left the unused bucket empty. All assertions passed, exit 0.

The native B02 test was inspected rather than relying on its title: it exercises HTTP guards/DTOs, exact-binding registration races, changed digests, code retries/expiry, stale revision, approval/rejection and duplicate approval races, lost-response recovery, expired setup versus permanent reporting, revocation, cross-domain races, manual creation/rotation reservations, response/audit privacy and rate-limit failure behavior. The Redis concurrency/refund probe supplements its sequential five-failure HTTP check; that extra probe is not a committed regression test.

## Boundaries

The broad unit suite was not rerun by this reviewer. The implementation report accurately distinguishes its earlier 868-test checkpoint from the final focused checks. Existing legacy processing/admin claim-fixture failures remain B06 conversion work and were not bypassed or retested here. Events/retention, dashboard onboarding retirement, shared/native worker behavior, signing/publication, actual GPU qualification and unattended reboot remain downstream. No live database, deployment, migration, data reset, commit or push was performed.
