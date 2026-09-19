# Job queue, retry, and refund lifecycle

## Objective

Allow an account to prepare more work while limiting active resource consumption.
MongoDB remains the durable queue and the existing worker claim protocol remains
the execution boundary.

## Account capacity

An account may hold:

- one processing job; and
- three waiting jobs.

Waiting capacity includes `awaiting_upload` and verified `queued` jobs. Processing
capacity includes claim/validation, inference, result upload, and exact finalization.
Cancelled, failed, ready, and deleted jobs do not consume admission capacity.

Admission checks and state transitions must be protected by the existing account
fence/transaction pattern so simultaneous requests cannot exceed the limits.

## State groups

| Group        | Typical states                                           | Capacity                   |
| ------------ | -------------------------------------------------------- | -------------------------- |
| Preparing    | `awaiting_upload`                                        | One of three waiting slots |
| Ready to run | `queued`                                                 | One of three waiting slots |
| Processing   | claimed/validating/processing/uploading-result ownership | Single processing slot     |
| Terminal     | `ready`, `failed`, `cancelled`, deleted                  | No queue slot              |

The exact public status names remain compatible where possible. Internal attempt
state does not leak through public serializers.

## Queue eligibility and picking

A worker claim queries the oldest eligible job ordered by `queuedAt`, then `_id`.
A candidate is eligible only when:

- its account is active, not deleting, and not manually restricted;
- no other job for that account owns the processing slot;
- its upload identity and duration are verified;
- its processing reservation exists and is not terminally released;
- its retry eligibility and `nextAttemptAt` allow execution;
- its immutable recipe is supported by the claiming worker;
- current worker/machine/session/slot fences pass.

The claim transaction atomically rechecks account activity, account processing
ownership, candidate state, worker slot, and attempt ownership. A losing contender
retries selection rather than claiming a second job for the account.

Do not introduce BullMQ, a second queue collection, weighted plans, queue priority,
or per-account round-robin for launch.

## Failure taxonomy

Every failure maps to one stable class before retry/accounting decisions:

| Class                    | Examples                                                                                      | Automatic processing retry                 | Processing minutes                       |
| ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| Infrastructure transient | worker offline, lease loss, timeout, temporary storage/network/server failure                 | Yes, within three total attempts           | Same reservation; no extra charge        |
| Infrastructure terminal  | three attempts exhausted, incompatible/corrupt worker output, non-retryable server fault      | No                                         | Full release/refund                      |
| Client/input             | invalid media, checksum/type/duration mismatch, abandoned upload, client-selected replacement | No worker retry; up to five input attempts | No processing charge                     |
| User action              | cancellation or deletion                                                                      | No                                         | Release unless success already finalized |
| Policy                   | quota, restriction, deletion state, queue full                                                | No                                         | No new reservation                       |

Safe public errors expose the category and next action without internal worker,
provider, or abuse-rule details.

## Infrastructure attempts

The maximum is three total processing attempts for one logical job: initial plus
at most two requeues. Attempt number and ownership are durable.

- Lease recovery classifies the observed failure before requeue.
- Backoff is bounded and stored as `nextAttemptAt`.
- Retry reuses the same job, input identity, recipe, and processing reservation.
- Every attempt gets a new attempt ID and exact output key.
- Late renewal/finalization from an old attempt is fenced and its output cleaned.
- After attempt three fails, the job becomes terminal failed and its reservation is
  released fully exactly once.

## Client/input attempts

The five-attempt limit belongs to one server-generated logical-audio family. It
counts newly issued input attempts, not network replay of the same idempotent call.
An invalid or abandoned attempt schedules its exact object for cleanup.

The client may present a clear reselect/retry action while attempts remain. It must
not create hidden retry loops or manufacture a fresh identity to bypass the limit.

## Settlement invariants

- A job has one processing reservation.
- Successful exact result finalization consumes that reservation once.
- Infrastructure retry does not create another reservation or usage charge.
- Terminal failure/cancellation releases the reservation once.
- A result cannot be published after cancellation, account deletion, restriction,
  lease loss, attempt replacement, or ownership change.
- Duplicate create, confirm, claim, renew, cancel, retry, and finalize requests are
  idempotent or return a stable conflict.
- Reconciliation repairs interrupted multi-document transitions without inventing
  usage or accepting stale output.

## Queue presentation

Clients show stable states such as waiting, processing, retrying, failed, and ready.
They may show jobs ordered in the account queue but must not promise an exact start
time or globally stable numeric position.

The dashboard may show the account's active/waiting counts, current attempt number,
safe failure class, reservation settlement, and administrative actions already
authorized by existing permissions. Internal worker credentials and raw errors are
never displayed.
