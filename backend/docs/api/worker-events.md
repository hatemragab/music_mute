# Structured worker events

All paths have `/api/v1`. `POST /worker-installations/:id/events` accepts only the
current unexpired installation bearer for that exact ID. `POST /worker/events`
accepts the current permanent worker bearer; it derives the installation binding
on the server. It remains usable after setup capability expiry, without renewing
that capability, including while `AUDIO_PROCESSING_ENABLED=false`. It uses the
existing authenticated cleanup/control-route availability marker; credential,
binding and transactional revocation checks remain mandatory. Both paths use the same transactional ingestion service and
unique `(installationId,eventId)` identity. Setup writes the installation
authorization fence; permanent authentication fences both worker control and the
bound installation. Revoked credentials or bindings cannot append events.

The JSON body is `{events: WorkerEvent[]}` using the shared cross-platform contract.
Only JSON with identity encoding is accepted. Maximum actual body length is 65,536
bytes, including whitespace and chunked transfer payload; compressed requests are
rejected. Batches contain 1–50 events. Each serialized event is at most 4,096 UTF-8
bytes. Unknown fields, caller-supplied owners/timestamps, invalid UUIDv4 lowercase
IDs, nonpositive/unsafe sequences and invalid numeric counters are rejected.
Occurrence timestamps use canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`.

`src/worker-events/worker-event-policy.ts` exports the exact `EventInput`,
`EventDetails`, category/status/stage/code vocabularies. Stage, reason code and
component are fixed allowlists; component versions are one to four numeric
segments of up to five digits each. Counters are safe integers (attempt starts at
one, other counters at zero; exit code may be negative). Diagnostic is limited to
1,024 UTF-16 code units and can contain only a fixed `EVENT_CODES` value in stored
form. Any other diagnostic is replaced by `[redacted]`, including URLs, local
paths, credentials and raw exceptions. No arbitrary diagnostic prose is stored,
logged, returned, or included in a conflict error. New native stages or reason
codes require an explicit contract/allowlist change before use.

Approved setup/GPU reasons are also fixed safe diagnostic values:
`CPU_ONLY_UNSUPPORTED`, `GPU_PROVIDER_UNAVAILABLE`, `GPU_UNAVAILABLE_IN_SERVICE`,
`GPU_QUALIFICATION_FAILED`, `DRIVER_ACTION_REQUIRED`, `UNSUPPORTED_OS_ARCH`,
`DEPENDENCY_RECIPE_UNAVAILABLE`, `INSUFFICIENT_DISK`, `INSUFFICIENT_MEMORY`,
`MODEL_INTEGRITY_FAILED`, `PREBOOT_UNLOCK_REQUIRED`, `STARTUP_INSTALL_FAILED`,
`REPORTING_UNAVAILABLE`, and `UPDATE_SIGNATURE_INVALID`. Unknown codes are still
rejected; arbitrary diagnostics still redact to `[redacted]`.

Success (201) returns `{acceptedEventIds,duplicateEventIds,serverTime}`. Identical
retries succeed while retained; conflicting payload reuse returns
`EVENT_ID_CONFLICT` (409). Equality uses canonical field ordering and a keyed HMAC
of the original validated payload, so two distinct diagnostics that both redact
to the same marker still conflict. HMAC uses the existing stable
`RATE_LIMIT_HASH_SECRET` with a dedicated event domain; changing that secret
invalidates retained retry fingerprints and cursors. Owner resolution or pairing
never rewrites original rows. `workerId` is the assignment known at original
receipt and may remain null for setup events; worker timelines query canonical
installation ownership instead of this historical annotation.

Every new event receives server `receivedAt` and `expiresAt = receivedAt +
30*24*60*60*1000ms`. TTL is zero seconds on `expiresAt`; all reads independently
require `expiresAt > serverNow`. Retries, later pairing or successful attempts do
not extend expiry or delete earlier failures. Expired rows awaiting TTL deletion
can acknowledge identical retries but are never listed. No permanent per-event
tombstones are kept. Once a row is physically deleted, a byte-identical old event
is rejected because its occurrence is outside admission age; changed payloads
reusing a deleted ID are outside retained idempotency history.

For a new event, `serverNow-30days < occurredAt <= serverNow` is mandatory.
`EVENT_CLOCK_AHEAD` and `EVENT_TOO_OLD` return 400 with `serverTime` in UTC. An entire
batch is transactional: validation, clock, conflict or progress-admission errors
persist none of its new events. W03/I01 must correct local clock offset using
server UTC **before first submission**. Preserve the original payload after any
accepted or uncertain response; never alter an accepted event under its old ID.
Explicit rejection proving batch nonpersistence allows correction. Record local
rejections/dropped counts rather than silently losing logs. Server receipt always
controls retention, regardless of corrected client time.

Redis weighted admission atomically checks per-installation rate and byte counters
before consuming either. One counter per budget provides constant space; it never
allocates one item per byte. Event-specific fixed windows start at first admitted
batch: 60 batches/minute by default, 2 MiB/setup bearer/24h, 20 MiB/permanent
worker/24h. Ordinary application sliding-window reservations are unchanged.
Retries and subsequently rejected authenticated batches consume admitted traffic
budgets. Failed multi-budget admission consumes neither counter. Unchanged
progress (same operation, category, stage, safe details and code) is limited to once per five
server seconds; exact retries and terminal events are exempt from that progress
rule. Quota/progress failures return structured 429 `RATE_LIMITED` with
`Retry-After` seconds. Redis failure returns safe 503 and stores no events.
W03 must coalesce unchanged progress before batching, preserve the first/last
relevant observation and all failures/terminal events, and obey `Retry-After`.
Repeated unchanged progress in one mixed batch rejects that entire batch without
persistence; split/coalesce only after explicit rejection proves nonpersistence.

Validated configuration in both safe environment examples:

| Key                                  |  Default | Bounds           |
| ------------------------------------ | -------: | ---------------- |
| `WORKER_EVENTS_SETUP_BYTES_PER_DAY`  |  2097152 | 65536–1073741824 |
| `WORKER_EVENTS_WORKER_BYTES_PER_DAY` | 20971520 | 65536–1073741824 |
| `WORKER_EVENTS_BATCHES_PER_MINUTE`   |       60 | 1–1000           |
| `WORKER_EVENTS_STALE_SECONDS`        |      300 | 30–3600          |

## Administrator timelines

`GET /admin/workers/:id/events` and
`GET /admin/worker-installations/:id/events` require existing `workers.read`
administrator permission (owner, worker_manager, support, viewer). Permanent worker
tokens, setup tokens, public callers and release_manager cannot read timelines.
Worker reads resolve the registered installation; a missing binding is rejected
explicitly. There is no public/detail/export event reader.

Both return `{items,nextCursor,reporting,serverTime}`. Optional filters: category,
operationId, stage, status, and inclusive server receipt bounds `from`/`to` in
canonical UTC. `limit` defaults to 50, maximum 100. Ordering is descending
`receivedAt,_id`; `nextCursor` is opaque, signed and bound to owner and filters.
Retain filters while following a cursor. Expiry filtering is reapplied each page.
Items expose only allowlisted event fields and the original owner/receipt/expiry.
Indexes support installation/time, installation/operation/time and
installation/category/status/time queries.

`reporting` is computed independently of filters/cursor. Its explicit
`scope:most_recently_reported_operation` and `operationId` identify the operation
from the latest server-received unexpired event. Within that operation the highest
sequence determines status, with server receipt/ObjectId as deterministic ties.
No unique sequence constraint is imposed; distinct event IDs remain separate.
Late lower-sequence spool progress cannot undo a visible terminal outcome.
It describes reporting history, not current setup state or operational readiness.
Staleness uses the selected observation's server receipt. A nonterminal event at least the configured
stale interval old reports `status:reporting_interrupted,outcome:unknown`; no
visible event reports `unknown`. A terminal succeeded/failed event retains its
reported outcome while visible; interrupted remains unknown. Failed attempts
remain in the timeline after later success. Expired logs do not change registry,
credential reservation, qualification or current worker control state.
