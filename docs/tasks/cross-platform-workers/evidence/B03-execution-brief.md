# B03 execution brief

Read the B03 task card, shared event contracts and B02 report before implementing.
This task owns structured event ingestion and exactly 30-day detailed visibility;
it must not turn private job errors into a general setup log table.

## Existing authority

B02 exports `InstallationPairingService.authenticate(id, authorization, session?)`
and its limits/models. Its returned document is private: do not serialize it.
Setup ingestion must check current expiry/revocation and write the installation's
`authorizationFence` in the same transaction as event persistence, as qualification
upload does. Permanent ingestion must use the current registered credential and
stable installation binding with the existing worker control fence.

The setup reporting capability expires independently of the permanent credential.
Do not revive it to flush logs. A paired worker can use its permanent credential to
upload its retained spool against the same installation identity. B02's minimal
credential digest/scope/owner reservations remain operational security state;
do not delete them with detailed events or provisional session metadata.

## Canonical event identity

Use the stable installation ID as the canonical event owner for both setup-token
and permanent-token ingestion. Unique `(installationId, eventId)` identity lets a
spooled event retry after pairing or capability expiry without creating another
event merely because authentication changed. Resolve that installation ID on the
server; never accept a caller-supplied worker/owner override.

Admin worker timelines resolve the worker's installation binding and query those
same events. Admin installation timelines use the same owner. Pairing must not
rewrite old event identity or reset retention. A worker missing its required new
installation binding is rejected explicitly, with no singleton fallback.

## Boundary checks

- Enforce the actual 64-KiB HTTP body limit, including whitespace and chunked JSON,
  as well as 50-event, 4-KiB serialized-event and diagnostic field limits. Checking
  only `JSON.stringify(parsedBody)` does not measure the received HTTP body.
- Allowlist structured diagnostic fields and safe reason codes. Redaction must
  happen before persistence, logs and responses. Never persist raw exception text,
  headers, capability values, codes, private paths or signed download URLs.
- Preserve identical retry success and reject conflicting event-ID reuse without
  overwriting the first event. Account for redaction when defining payload equality;
  distinct unsafe inputs must not silently overwrite or change an accepted event.
- Server receipt time determines `expiresAt`, exactly 30 days later. Client clocks,
  later pairing, duplicate retries and successful subsequent attempts cannot extend
  it. TTL cleanup is insufficient: every list/detail/export path must filter expiry.
- Keep failures from prior attempts visible after a successful retry. Stale setup
  with no terminal event is an unknown/interrupted outcome, not a success or a
  manufactured failure.
- Use existing Redis byte/rate budgets and bounded pagination. A failed multi-budget
  admission must not partially consume another budget, and auth failures must not
  create events. Read access is worker-administrator-only.

Use isolated MongoDB replica-set, Redis and real Nest HTTP tests for scope changes,
duplicate/conflict handling, exact expiry, delayed TTL deletion, body limits,
redaction, quotas and pagination. No live services, deployment, migrations,
backfills, commits or unrelated edits. Record exported interfaces for W03/I01/D01/
D03 and exact verification/limits in `B03-report.md` for independent review.

## Retention retry boundary ruling

Idempotency and conflicting-ID preservation cover retained event records. Do not
add permanent per-event tombstones. An expired-but-present identical event may be
acknowledged as a duplicate without making it visible or renewing expiry. After
TTL physically deletes the record, reject identical old payloads by requiring
`receivedAt - 30 days < occurredAt <= receivedAt` for new event admission. A changed
payload reusing an already deleted ID is outside the retained idempotency history;
document that boundary explicitly. Every accepted event still expires exactly 30
days after its first server receipt, not after its client occurrence timestamp.

Future-clock rejection must have a safe explicit reason and server UTC time must
be available for W03/I01 clock correction; a skewed contributor clock must not
silently discard setup logs. Test exact age/future boundaries and retries both
before and after physical TTL deletion. This avoids unlimited per-event metadata
retention at the cost of bounding conflict detection to retained history and
requiring the native spool to correct its timestamps before first admission.

## Integration findings from B06

`src/http/configure-http.ts` installs the shared JSON body parser before controller
execution. Enforce the event-specific wire-body limit at that boundary, including
chunked payloads, rather than only in a DTO or controller. Preserve the existing
body-parser error mapping in `PublicExceptionFilter` and other routes' limits.

`RateBudgetService.reserve` currently counts sliding-window reservations; it has
no byte weight. Do not implement a byte quota by counting batches or by creating
one Redis member per byte. Add a bounded atomic weighted admission mechanism in
the existing rate-limit infrastructure and prove concurrent byte/rate admission
cannot partially consume unrelated buckets. Keep ordinary request reservations'
existing behavior intact.

Keep `AuthModule` ahead of worker feature modules in `AppModule`: worker modules
import `AdminModule`, whose global guard requires the identity populated by the
authentication guard. B06's compiled dashboard workflow caught the reverse order
denying all admin requests. Add the new event admin controllers to the independent
dashboard route inventory and run both that authorization suite and the compiled
dashboard workflow after wiring B03.
