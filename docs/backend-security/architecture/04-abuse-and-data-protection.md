# Abuse records, account restrictions, and datastore protection

## Objective

Make abuse visible and manually manageable without building an opaque automatic-ban
system. Protect costly endpoints and keep Redis/MongoDB growth bounded on the
current 4 GB VPS and Atlas Free cluster.

## Typed abuse events

Initial event types:

- `upload_grant_limit`;
- `upload_attempt_limit`;
- `invalid_upload_repeat`;
- `cancel_after_upload_repeat`;
- `client_retry_limit`;
- `download_grant_limit`;
- `download_bytes_limit`;
- `processing_quota_limit`;
- `queue_limit`;
- `endpoint_rate_limit`;
- `restriction_bypass_attempt`;
- `service_safety_ceiling`.

An event stores account ID, type, severity, first/last occurrence, bounded count,
safe route/operation class, policy revision, optional restriction link, and expiry.
Do not store raw IP, email, Firebase UID, device ID, token, presigned URL, object
key, audio name, or request body. If an IP correlation key is needed, use the
existing keyed/hash pattern and keep it short lived.

Repeated identical events aggregate within a time bucket using an atomic upsert.
Detailed event buckets expire after 90 days. A compact monthly type/count summary
may remain for twelve months. Neither is the source of quota truth.

## Rate-limit layers

Cost-creating routes use the smallest relevant set of budgets:

1. existing global/IP HTTP ceiling;
2. authenticated account/UID endpoint ceiling;
3. durable account quota/grant counter;
4. service-wide safety ceiling where S3/worker cost is involved.

Apply route-specific budgets to create job, issue upload URL, confirm upload,
retry/cancel mutations, issue download URL, account deletion/recovery, and
administrator mutations. Read-only history may use a less strict budget.

HTTP rate limiting is not a substitute for durable quota. Redis counter expiry or
restart must never create extra monthly processing, upload, or download capacity.

## Manual account restrictions

One active restriction record contains:

```text
accountId
status: active / expired / removed
reason code and safe note
startsAt / expiresAt (optional)
createdBy / updatedBy
audit references
revision
```

Only an authorized administrator can apply or remove it. An optional expiry makes
the restriction inactive at read time without waiting for a scheduler. Permanent
manual restriction uses no expiry. Launch code does not create a restriction from
an abuse score automatically.

Enforcement blocks new jobs, upload/download grants, and user-requested retries.
It does not prevent authentication, safe account/status reads, account deletion,
or account recovery. In-flight work is cancelled or allowed to finish according to
one explicit transition chosen and tested by the branch; the safe default is to
fence new worker ownership and cancel work that has not finalized successfully.

## Administrator experience

The dashboard provides:

- account search and current restriction status;
- event filters by account, type, severity, and date;
- compact counts and last occurrence, not unlimited request logs;
- create/update/remove restriction with reason and optional expiry;
- confirmation, fresh-authentication, permission, optimistic revision, and audit;
- clear separation between quota override and abuse restriction.

The UI never exposes exact rate thresholds that would materially help bypass
detection beyond the public product limits already shown to users.

## Redis safety

Reuse the shared authenticated Redis client, hashed keys, atomic Lua budget, bounded
timeouts, and readiness behavior. Every security/abuse key has a TTL.

Operator target for the shared 4 GB VPS:

- `maxmemory 256mb` initially;
- `maxmemory-policy noeviction`;
- private/authenticated access and existing supported Redis version;
- alert before the limit rather than allowing the OS OOM killer to affect NestJS.

Application behavior when Redis is unavailable:

- fail closed with a sanitized retryable 503 for operations that create processing,
  upload, download, mail, or other provider cost;
- durable MongoDB quota checks remain mandatory;
- bounded safe reads may continue only where existing security policy allows;
- never silently switch to unlimited in-process counters.

The code branch documents these settings but does not modify the VPS.

## MongoDB safety

Design within Atlas Free constraints:

- compact period summaries rather than request logs;
- TTL for short-lived grants, event buckets, expired tokens, and completed cleanup
  records where deletion is safe;
- no unbounded embedded arrays;
- indexes only for account/period uniqueness, queue selection, cleanup leasing,
  restriction lookup, and bounded admin filtering;
- pagination and projection on every admin event query;
- bounded cleanup batches and no disk-spilling aggregation assumption;
- application alerts before the 0.5 GB hard storage ceiling.

Do not store S3 media, error stacks, or large diagnostics in MongoDB. Safe job
errors remain bounded and user-presentable.

## Privacy and deletion integration

Abuse events and restrictions are account data during normal operation. Branch 5
must delete or irreversibly de-identify them during account purge. Device history
may be shown for support but does not combine quotas or automatically restrict
other accounts.
