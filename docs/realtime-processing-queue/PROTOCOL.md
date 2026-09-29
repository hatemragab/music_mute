# Realtime protocol v1

The client opens one native RFC 6455 WebSocket per authenticated app session.
Browser clients keep that shared connection while the page remains loaded,
including when the user switches browser tabs; route and visibility changes do
not create another socket. Native clients retain their platform foreground
session fencing. HTTP remains responsible for authentication, commands, signed
grants, file transfers and explicitly requested non-live resources. There is no
HTTP polling fallback for live resources. Existing REST routes remain compatible.

## Establishing a session

1. POST an empty JSON object to `/realtime-tickets` (owner) or
   `/admin/realtime-tickets` (administrator), using the existing Firebase bearer
   and installation/auth headers. Response: 201, `Cache-Control: no-store`.
2. Read `ticket`, `path`, `protocol`, `expires_at`. The 32-byte opaque ticket is
   hashed in Redis, expires after 30 seconds and is consumed exactly once.
3. Upgrade the returned path on the configured API origin using the subprotocols
   `musicmute.realtime.v1` and `ticket.<ticket>`. The server selects only the first.
   Never put the bearer token or ticket in a URL, log, analytics event or storage.
   Browser Origin must match the ticket and configured CORS allowlist. Native
   clients omit Origin. Cross-origin redirects are not supported.
4. Wait for `ready`, then subscribe. A new connection always receives complete
   snapshots. Session lifetime is bounded by Firebase expiry and 15 minutes;
   reconnect obtains a fresh ticket. Firebase revocation and current owner/admin
   access are rechecked, including before and after snapshot reads.

```json
{"type":"ready","protocol_version":1,"stream_id":"unique-per-connection","server_time":"2026-09-26T10:00:00.000Z"}
{"type":"subscribe","subscription_id":"jobs-page-1","resource":"jobs","params":{"limit":"20"}}
{"type":"snapshot","protocol_version":1,"stream_id":"unique-per-connection","subscription_id":"jobs-page-1","sequence":1,"data":{"items":[],"next_cursor":null}}
```

All wire keys are snake_case. Subscription IDs are 1–64 ASCII letters, digits,
underscores or hyphens. Parameters are strings with the same validation and
pagination semantics as the domain's existing REST reads. No arbitrary URLs,
Mongo expressions or write commands are accepted.

## Resources

| Audience | Resource                                     | Parameters / authorization                                           |
| -------- | -------------------------------------------- | -------------------------------------------------------------------- |
| Owner    | `jobs`                                       | Existing owner job list filters and cursor; authenticated owner only |
| Owner    | `job`, `import`                              | `id`; ownership checked by existing service                          |
| Owner    | `usage`                                      | No parameters                                                        |
| Owner    | `policy`                                     | Optional `schema_version`                                            |
| Admin    | `admin.jobs`, `admin.job`                    | Existing list filters / `id`; `jobs.read`                            |
| Admin    | `admin.overview`                             | Existing range; `overview.read` and existing field-level permissions |
| Admin    | `admin.health`, `admin.alerts`               | No parameters / existing alert filters; `health.read`                |
| Admin    | `admin.workers`, `admin.worker`              | Existing list filters / `id`; `workers.read`                         |
| Admin    | `admin.diagnostics`                          | `id` and page filters; `workers.logs.read`                           |
| Admin    | `admin.invitations`                          | Page filters; `workers.enroll`                                       |
| Admin    | `admin.recoveries`, `admin.recovery_summary` | Existing filters / no parameters; `users.account-recovery.manage`    |
| Admin    | `admin.release_upload`                       | `release_id`, `upload_id`; `releases.read`                           |

Owner subscriptions cannot use administrator resources and vice versa. Job/import
not-found behavior does not reveal another account's data. Administrative writes
still use existing HTTP authorization, reasons, revisions and operation receipts.

## Queue meaning

Job snapshots add `queue` and the compatible admin alias `queue_position`:

```json
{
  "queue": {
    "state": "waiting",
    "position": 3,
    "jobs_ahead": 2,
    "scope": "recipe",
    "reason": null,
    "as_of": "2026-09-26T10:00:00.000Z"
  },
  "queue_position": 3
}
```

Position is the one-based rank of **this job**, among currently eligible waiting
jobs in its recipe, ordered by `(queuedAt, _id)`. Running work is excluded. This is
not an ETA or a guarantee of start order across parallel workers. A user's jobs
can have different positions. The projection shares the scheduler eligibility
query and capacity predicate; it performs no claim or admission writes.

States: `waiting`, `blocked`, `not_queued`, `unavailable`. Position and jobs-ahead
are null unless waiting. Reasons: `account_capacity`, `account_restricted`,
`retry_backoff`, `processing_paused`, `worker_unavailable`,
`eligibility_unavailable`, or null. Busy compatible slots establish worker
availability; disabled recipes, stale machines (90 seconds), mismatched policy or
session, exhausted attempts and invalid reservations do not produce invented ranks.

A shared Mongo snapshot transaction reads at most 5,000 queued jobs; the result is
coalesced/cached for up to one second and invalidated by relevant changes. Query
budgets or invalid data produce unavailable, never a partial or guessed rank.
Retry eligibility and worker liveness deadlines trigger server invalidation even
without writes. Clients hide queue numbers while reconnecting.

## Delivery and recovery

- `sequence` is monotonic per subscription within `stream_id`; it is separate from
  job revision and worker progress sequence. Ignore duplicates/older frames. On
  gaps, send `{"type":"resync","subscription_id":"jobs-page-1"}`. This requests
  another complete snapshot, not a durable replay log.
- `unsubscribe` has the same ID shape. Late reads from replaced/unsubscribed
  subscriptions are fenced. Reconnect discards old stream state and resubscribes.
- Server sends `ping` with `server_time` every 30 seconds; clients answer
  `{"type":"pong"}`. Client watchdog is 65 seconds, initial ready deadline 10
  seconds; browser subscription deadline is 10 seconds, native first snapshot
  deadline 15 seconds, and browser one-shot reads time out at 15 seconds. Browser
  watchdog and subscription deadlines are suspended while the document is hidden;
  returning visible gives the existing socket one heartbeat grace window before
  recovery. Reconnect uses exponential backoff with jitter capped around 30
  seconds. Browser retries honor Retry-After.
- `subscription_error` includes `stream_id`, `subscription_id`, `status`, `code`.
  Retry transient failures through the socket. Definitive missing/access errors
  are surfaced. Session rejection clears privileged view state.
- Code 4001 means session revalidation is required, 1013 means temporary capacity
  or dependency failure, 1008 means invalid/bounded protocol use. No silent REST
  fallback. Offline cached native results remain usable under existing rules.
- History retains a moving window of ten live pages; loading more can advance
  beyond that window. Reopening history starts from the newest page. Changes to
  cursor boundaries discard later pages, avoiding holes/duplicate rows.

## Server limits and deployment

One Mongo change-stream cursor per API process observes committed relevant
collections, with resume tokens. Lost history forces fresh snapshots. Feed loss
closes sockets instead of leaving clients marked live. Each API replica observes
the database independently; Redis is for single-use tickets and distributed leases.

Limits: six concurrent connections per account/audience across replicas, 3,000
connections per process, 3,000 upgrades globally/minute, 60 upgrades per IP/minute, 16 subscriptions/connection,
120 control messages/30 seconds, four concurrent reads/connection, 8 KiB inbound
frames, 256 KiB snapshots and 1 MiB buffered outbound data. No compression.
Invalidations coalesce for one second. Time-dependent reads are refreshed from the
server heartbeat; active job views continue that refresh for elapsed and progress
staleness fields, while fully terminal job views and change-driven policy views do
not reread periodically. Existing health sampling and overview caches are reused.
The API emits one-minute, aggregate-only socket metrics for connection/rejection/
close categories, snapshot read latency, outbound bytes and backpressure. Those
records contain no identity, resource parameters or payload data.

Deploy backend first, then web/native clients. Mongo must be a replica set or
sharded deployment with change-stream privileges. Standalone Mongo can support
legacy REST but cannot provide this realtime feed. Keep Redis available. Reverse
proxies must forward WebSocket Upgrade/Connection and subprotocol headers, with an
idle timeout longer than the heartbeat/watchdog. Allow only configured browser
origins. Both web servers include the exact API WSS origin in CSP. The existing
worker-hint socket shares the upgrade dispatcher and keeps its own protocol,
including its one-use ticket, server heartbeat and Redis-backed single-machine
connection lease.

No index migration or persisted job schema change is introduced. Rollback clients
before removing backend websocket support; older clients can keep using REST.
Production proxy, privileges, fleet-scale latency and multi-device behavior still
require an authorized staging/production exercise. Local fixtures are not live
release proof. No deployment or production configuration changes were performed.

### Administrator announcement history

`admin.notifications` requires `notifications.read` (owner only) and accepts
`cursor` (24-character campaign ID) and `limit` (1–50, default 20). It returns the
same full snapshot as `GET /admin/notifications`, newest IDs first, with `items`
and `next_cursor`. Each item contains title/body, creator/reason, timestamps,
`state`, `targets_frozen`, and per-device `counts` (`pending`, `sent`, `failed`,
`invalid`, `ineligible`). `sent` means FCM accepted the submission, not device
receipt. Changes to `notification_campaigns` and `notification_campaign_deliveries`
invalidate the resource; existing user/admin authorization fences still apply.
Creation remains an audited HTTP command. There is no browser polling.

### Worker observation time (2026-09-29)

`admin.worker` and the compatible HTTP machine-detail response now include
`as_of`, an additive UTC server timestamp for the bounded snapshot. The dashboard
uses it to assess last-contact freshness without relying on the browser clock.
Older responses without it display freshness as unknown. Existing command metrics
remain bounded name/value/unit arrays; updated workers report additional numeric
resource metrics through the same command-result route. No new socket resource or
polling path is introduced.
