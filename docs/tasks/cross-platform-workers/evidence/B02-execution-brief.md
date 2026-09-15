# B02 execution brief

Implement the installation and pairing task after B05 review. This brief supplements
the task card and shared contracts; it does not authorize deployment or real data
changes.

## Ownership and prerequisites

- Own `backend/src/worker-installations/`, its isolated tests, and necessary module,
  configuration, rate-limit and admin integration changes.
- Read the current B05 report and `worker-qualification.service.ts` before connecting
  qualification reporting. Use its report storage and evaluation authority rather
  than duplicating approval logic. Publication is not GPU qualification.
- Reuse `backend/src/admin/admin-operations.service.ts`, the existing registration
  and control schemas, transaction infrastructure and Redis rate budgets.
- Read `admin-workers.service.ts:create` for existing transaction conventions.
  Pairing must bind the locally generated permanent credential digest; it must not
  use the old server-generated raw-key registration response.
- Other work is present in this checkout, particularly unrelated Android edits.
  Preserve it. Do not commit, push, deploy, create migrations, backfill records or
  introduce compatibility bridges.

The B05 implementer exposes `WorkerQualificationService.store(installationId,
runtime, report, serviceBindingSha256)` and
`evaluateForPairing(installationId, reportId, session?)`. Storage returns a report
ID and a `reported` decision; it is not approval. Evaluate pairing in the approval
transaction with its session so release policy is fenced. That evaluator checks
the signed artifact approval and model/provider/fixture/service evidence without
requiring unattended reboot. B02 owns authentication, session expiry, strict DTO
validation and rate limits around these calls. Verify the final reviewed signatures
before implementation.

The installation qualification HTTP body is `{ runtime, qualificationReport,
serviceBindingSha256 }`, with strict nested validation using the shared DTOs. The
path installation ID must match the runtime installation ID. The earlier report-
only route sketch omitted the runtime and service identity needed by B05; the
shared route table now includes them. Do not invent a default service binding or
derive runtime identity from an unauthenticated client header.

Also expose `POST /worker/qualification` under the existing permanent worker
authentication. Resolve the stable installation binding from that identity and
reject any mismatched runtime installation ID. Use the same immutable report
storage with bounded per-worker rate/count budgets. This is the requalification
path after a setup token expires, not a setup-token renewal or new enrollment.
Test a paired worker whose installation capability is expired: that capability
stays rejected while its valid permanent credential can report new qualification
for the original installation. Wrong installation binding and revoked permanent
credentials must fail. No report alone grants fresh-claim readiness.

Reserve setup and permanent credential digests in one unique namespace to reject
deliberate cross-session reuse, not only equality with the same session's token.
Reservations and binding mutations must be atomic and retry-safe. Cover both
creation orders and concurrent setup registration versus pairing, plus supported
credential creation/rotation paths. Document reservation ownership and retention;
do not release a digest while its credential could still authenticate in either
scope. Use fresh-schema fixtures with no migration or backfill.

## Decisions to preserve

Installation capabilities are separate from permanent worker credentials. Register
only an exact installation ID/digest binding. Check expiry on every authorized
operation, including idempotent retries. A lost response may recover its original
non-secret result but cannot revive an expired capability or mint another worker.

The reporting capability begins before Python installation and may submit a failed
GPU setup through B03 later. Do not require GPU qualification merely to register a
reporting session. Pairing itself requires successful model and service-context
qualification. Unattended reboot proof is a later claim-readiness gate, so the user
can approve and reboot without losing the saved identity.

Pairing codes expire after 15 minutes and require an explicit local retry after
expiry. Bind the permanent credential digest once a code is issued, including
across code retries. Keep codes out of admin lists, URLs, logs and audit request
payloads. Provide retry-safe code issuance without persisting plaintext permanent
credentials or reporting capabilities. Hash low-entropy lookup material with a
server-held secret; a plain code hash does not protect a database dump from offline
enumeration. Any secret configuration must be validated and documented with safe
examples only.

Approval is one audited transaction: verify current authorization and revision,
consume one unexpired code, create one registry/control identity and attach the
installation binding. It must race safely with rejection and repeated approvals.
Approval cannot independently set claim readiness. Status returns the same assigned
worker ID after a lost approval response, without revealing any secret.

Keep the existing manual registration removal coordinated with D01/B06. This is a
temporary implementation dependency, not a compatibility feature to retain in the
finished product. Preserve audited idle credential rotation.

## Required evidence

Use isolated MongoDB replica-set and Redis instances, following the B01/B04/B05
integration harnesses. Exercise real HTTP guards, public exception filtering and
strict DTO validation. Cover token scope, expired/revoked sessions, exact-binding
registration races, issuance replay, changed credential digest, approval/rejection
races, stale revision, expiry boundaries, rate limits and lost-response recovery.
Verify no codes, tokens or credential digests escape through safe admin responses
or audit records. B03 owns event ingestion and retention; do not claim those are
implemented in B02.

Record exact commands, results and remaining boundaries in `B02-report.md`. Request
the root task's independent review when the scoped implementation is ready; do not
spawn another implementation or review agent.
