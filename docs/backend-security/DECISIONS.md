# Accepted launch decisions and exact limits

This file is the product-policy source of truth for the five branches. Values are
backend-controlled and may later be changed globally or by one active account
override. The defaults below are the accepted launch values.

## 1. Scope

- Support one plan named `standard` for free accounts.
- Do not implement paid subscriptions, device-owned quota, device bans, worker
  rebuilding, machine management, scaling, backups, or disaster recovery here.
- Continue recording installations for authentication/session history only.
- Creating another account receives another account allowance. Cross-account
  device enforcement is explicitly deferred for faster launch.
- Keep working Firebase authentication and authorization foundations.

## 2. Time windows

| Window             | Exact definition                                                  |
| ------------------ | ----------------------------------------------------------------- |
| UTC day            | `00:00:00.000Z` through the next UTC midnight                     |
| UTC calendar month | First day `00:00:00.000Z` through the first day of the next month |
| New account        | Receives the full current-month allowance immediately             |
| Renewal            | Effective on the first instant of each new UTC month              |
| Carryover          | None                                                              |

The accepted simplicity tradeoff is that an account created near month-end can
receive a fresh allowance shortly afterward at the next UTC month boundary.

Use a stable period key such as `YYYY-MM`; do not run a mass monthly reset job.
Reading or mutating usage resolves the current period and creates its compact record
atomically when needed.

## 3. Default policy values

All byte units are decimal to match the existing API conventions.

| Policy                          |                              Default | Boundary                                                    |
| ------------------------------- | -----------------------------------: | ----------------------------------------------------------- |
| Successful processing           |                  7,200 seconds/month | Remaining time must cover the confirmed duration            |
| Audio duration                  |                        1,200 seconds | Inclusive: `duration <= 1,200`                              |
| Prepared upload size            |                     50,000,000 bytes | Inclusive: `bytes <= 50,000,000`                            |
| Upload grants                   |                               30/day | Count a newly issued grant                                  |
| Upload grants                   |                            200/month | Count a newly issued grant                                  |
| Confirmed upload bytes          |                  1,000,000,000/month | Count one verified object once                              |
| Waiting jobs                    |                            3/account | Includes awaiting-upload and queued work not processing     |
| Processing jobs                 |                            1/account | Validating through result finalization                      |
| Infrastructure attempts         |                          3 total/job | Initial attempt plus at most two automatic requeues         |
| Client/input attempts           |                5 total/logical audio | Initial newly issued attempt plus at most four replacements |
| Download grants                 |                            150/month | Count a newly issued result URL                             |
| Estimated download bytes        |                 10,000,000,000/month | Add immutable result size per grant                         |
| Retained successful output      |          1,000,000,000 bytes/account | Block later admissions at/above cap                         |
| Signed URL validity             |                  600 seconds maximum | Upload and download                                         |
| Service outbound safety ceiling | 80,000,000,000 estimated bytes/month | Pause new expensive grants                                  |
| Account deletion recovery       |             15 exact 24-hour periods | From accepted request time                                  |
| Redis data ceiling              |      256 MB initial operator setting | Shared 4 GB VPS; `noeviction`                               |

If one in-flight result causes retained storage to cross the cap, keep the valid
result and block later job admission until the user deletes enough completed work
or an administrator changes the effective limit. Never discard a successfully
processed result merely to force the counter below the cap.

## 4. Account policy and overrides

- Store one global standard-plan policy with a monotonic revision.
- Store at most one active override record per account.
- An override contains only replacement values, never arithmetic additions.
- An override may replace one or several policy fields.
- It includes an optional expiry, reason, administrator identity, creation time,
  update time, and revision.
- Expired overrides are ignored without requiring a scheduler.
- Reducing a limit never rewrites already consumed usage or cancels already
  accepted work. Remaining capacity becomes zero until usage falls below the new
  value or a new period begins.
- Jobs and grants store the policy revision/effective snapshot needed to explain
  why they were accepted.
- Administrators may not edit raw usage counters. Corrections use an audited
  adjustment/settlement operation defined by the owning branch.

## 5. Processing accounting

1. An early admission check confirms the account is active, unrestricted, within
   queue capacity, and plausibly within its remaining monthly allowance.
2. Exact size, checksum, media type, and duration are verified after upload.
3. The confirmed duration is reserved atomically before the job becomes queue
   eligible.
4. Only one reservation exists per job/idempotency identity.
5. Successful finalization converts the reservation to consumed seconds.
6. Cancellation before processing, terminal server failure, or terminal worker
   failure releases the reservation fully.
7. An infrastructure retry reuses the same job and reservation and costs no extra
   minutes.
8. A client/input-caused failure does not consume processing minutes, but already
   issued upload grants remain counted.

Usage responses show period, limit, used, reserved, refunded/released, remaining,
effective policy source, and next reset time.

## 6. Upload and media accounting

- Android, iOS, local import, and remote import all follow the same backend policy.
- A repeated HTTP request with the same idempotency key returns the same grant and
  does not increment counters again.
- Asking for a new grant increments daily and monthly grant counters even if the
  URL is unused, because the S3 request capability was created.
- Confirmed bytes increment only after exact key, owner, size, type, checksum, and
  immutable version verification.
- Reconfirming the same verified object is idempotent.
- Five client/input attempts are tracked by a server-owned logical-audio family;
  changing a request ID alone does not erase the family count.
- Temporary or invalid objects never count as retained successful output.

## 7. Queue, retries, and refunds

- An account can have no more than four nonterminal jobs: one processing and three
  waiting.
- `awaiting_upload` and `queued` jobs consume waiting capacity.
- A waiting job cannot be claimed until upload verification and processing-time
  reservation both succeed.
- The picker selects the oldest eligible `queuedAt`, then `_id` as a deterministic
  tie-breaker.
- Eligibility excludes deleting/restricted accounts, accounts already processing,
  expired reservations, exhausted retries, and incompatible worker recipes.
- Launch scope does not add weighted fairness, priorities, subscriptions, or queue
  position promises.
- Infrastructure retry classification is explicit and bounded to three total
  attempts. Invalid input, unsupported media, account restriction, quota denial,
  and client abandonment are not infrastructure retries.
- After the third failed infrastructure attempt, mark the job failed, release the
  processing reservation fully, retain a safe error, and schedule temporary-object
  cleanup.

## 8. S3 storage and download accounting

- The bucket remains private and every grant is for one exact owner-scoped key.
- Existing checksum, exact-size, content-type, immutable-version, and attempt-fence
  validation remains mandatory.
- Upload and download URLs expire in no more than ten minutes. A bucket policy also
  denies presigned requests whose signature age exceeds 600,000 milliseconds.
- Presigned URLs are bearer capabilities and can be reused until expiry. The API
  therefore counts download grants, not unverifiable client GET completions.
- Estimated download bytes equal the immutable object size at grant issuance.
- User result grants count toward both account download limits and the service
  outbound ceiling. Worker input downloads count toward the service ceiling but do
  not consume the user's result-download grant count.
- Use a locally cached valid result for playback when available without requesting
  another URL.
- Successful result objects remain indefinitely while the job/account exists.
- Inputs, abandoned uploads, invalid uploads, cancelled jobs, failed attempts, and
  stale results enter idempotent cleanup and should be removed within 24 hours of
  terminal eligibility.
- Use Intelligent-Tiering Frequent, automatic Infrequent after 30 inactive days,
  and automatic Archive Instant Access after 90 inactive days.
- Do not enable optional Archive Access or Deep Archive Access for launch because
  they require asynchronous restore before playback.

## 9. Abuse and restrictions

- Record typed, bounded account events. Never store raw tokens, URLs, audio,
  credentials, or full request bodies.
- Aggregate repeated identical events instead of writing one unlimited document
  per request.
- Launch enforcement is manual: an authorized administrator may create, update,
  expire, or remove an account restriction with a reason and audit record.
- Do not automatically ban an account or device from an event score.
- A restricted account may authenticate, see the restriction-safe response,
  request account deletion, and use recovery flows. It cannot create cost through
  jobs, upload grants, worker retries, or download grants.
- Device linkage remains informational and is not used to combine account usage.

## 10. Account deletion

- Accept a deletion request only with the existing recent-authentication and
  identity-fencing protections.
- Set `recoverUntil = acceptedAt + 15 * 24 hours`.
- During the grace period, the account may access deletion status and recovery but
  cannot create jobs or upload/download grants.
- Recovery restores the existing account and current-period usage; it does not
  award another monthly allowance or duplicate jobs.
- After the deadline, cleanup permanently removes owned S3 input/output objects,
  jobs, usage/override/restriction data, installation ownership links, personal
  profile data, and the Firebase identity through the existing retryable flow.
- Keep only a minimal non-personal completion tombstone needed for idempotency and
  operational proof. It must not contain email, display name, device identifiers,
  object keys, audio metadata, or raw Firebase UID.

## 11. Deferred work

- device fingerprinting or persistent device quota;
- quota sharing across accounts or households;
- automatic abuse scoring or automatic bans;
- paid plans, priority queues, and weighted fairness;
- optional Glacier-style restore UX;
- worker/machine security changes;
- scaling, backups, and disaster recovery.
