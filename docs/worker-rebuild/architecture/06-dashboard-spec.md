# Dashboard specification

Use the existing React/Vite/TanStack Query/router/component stack. Add a focused fleet area; do not build a new dashboard framework or duplicate mobile release management. Existing authentication, permission boundaries and audit patterns remain.

## 1. Fleet overview and machine detail

A machines page lists label/ID, platform, GPU, active software, state, last heartbeat, busy/allowed worker count, recipe eligibility and last installation/manual-update outcome. Paginate on the server. Filter by state, platform, version and group. Metrics unavailable on a platform display `Unavailable`, not a misleading zero.

Separate **online**, **ready for jobs**, **busy**, **draining**, **paused**, **updating**, **rejected/unhealthy**, and **offline**. A socket can be online while model validation failed. Derive stale state from timestamps. Background refresh must not reset table selection or an open diagnostic panel.

Machine detail shows GPU/device inventory, benchmark evidence, validated/effective concurrency, each child slot and active attempt, current/desired policy, recipe capabilities, logs and recent events. Persist stable slot IDs across process restarts and show incarnation/session changes separately. Link job attempts to the existing job detail page; do not expose machine credentials or arbitrary filesystem access.

## 2. Enrollment and installations

An administrator selects label/group, expiry and safe initial policy, then creates one-use enrollment. Show Windows and macOS/Linux commands with a pinned CLI/installer version and explicit privilege note. Show the secret once, copy deliberately, avoid analytics/error capture of the command, and do not persist it in query caches/localStorage/session restoration. Clipboard copies are user actions, not automatic side effects.

Show invitation expiry/revocation and installation phase separately. Installation may be running, rejected, failed, interrupted/abandoned, or successful without having become production-ready yet. A GPU rejection remains searchable even though no active machine exists. Logs show timestamps, stages, severity, sequence/completeness and the sanitized error report.

Error UI distinguishes unavailable logs from an empty log. Offer safe retry/repair instructions, not a generic green success toast on command generation. Do not retry a one-use invitation creation automatically in a way that leaks or creates multiple valid secrets without idempotency.

## 3. Worker controls

Provide machine drain/pause/resume/revoke and a bounded max-workers setting. Show dashboard ceiling, owner-local ceiling, validated ceiling and effective result. A request to raise capacity beyond the benchmarked value explains that validation is required; it cannot simply write a larger number and activate it.

Allow slot-level policy to narrow machine settings. Disabling a slot drains it. Controls display desired/applied revision and conflict errors. Mutations send expected revision to prevent two admin tabs silently overwriting each other. Revoke is explicit and audited with its impact on active jobs.

`doctor`, benchmark, and log retrieval requests are named commands with typed parameters and request IDs. The UI never exposes a generic command textbox. A benchmark request requires idle/drained capacity or an explicit deferred status. MVP updates are initiated locally by an operator, not through a dashboard command.

## 4. Pipeline controls

Separate two panels:

**New-job defaults:** Choose one of the four Kim recipe combinations and approved trim/bitrate/preset parameters. Publishing a change creates a new immutable recipe/settings revision. Clearly state: applies to new jobs only; queued/running jobs retain their snapshot. Preview the order `Kim → optional denoise → optional trim → encode`.

**Machine/worker eligibility:** Allow or disallow supported recipe IDs and optional steps for this machine; a slot may narrow these choices. The UI uses labels such as `Accept denoise-required jobs` so disabling it is not mistaken for silently bypassing a job requirement. The backend remains the eligibility authority.

Warn if a policy change leaves a queued recipe with no eligible capacity. Show queued jobs as waiting for compatible workers rather than changing their audio recipe. Provide a separate global default change action for future jobs. Do not mutate recipes in place to clear the queue.

Expose basic trim settings with validation and explanation that qualifying **internal gaps are removed**. Initial defaults: -45 dBFS, 0.8 s minimum silence, 0.2 s padding; trim enabled. Denoise is disabled by default and offers the single approved conservative preset. Do not offer arbitrary FFmpeg filters, Python snippets, model URLs or drag-and-drop graph editing.

## 5. Worker release visibility

For MVP, show the installed version, known-good version, package verification state, compatibility, and the outcome of an explicit local manual update or rollback. Show staged, activating, healthy, failed, rolled-back, and quarantined states separately when reported by a machine.

Publishing release metadata is not proof of successful installation. A rollback should identify old and rejected releases and a sanitized cause. Existing mobile release pages remain unaffected. Dashboard target selection, canary promotion, capacity-aware rollout, pause/abort, and remote automatic update commands are post-MVP.

## 6. Permissions and audit

Extend the existing permission registry with a minimal coherent set, for example `workers.read`, `workers.manage`, `workers.enroll`, `workers.logs.read`, `worker-releases.read`, and `worker-releases.manage`. These are proposed names to reconcile with existing registry conventions. Backend authorization is mandatory even if buttons/routes are hidden.

Audit invitation creation/revocation, machine revocation, policy/concurrency changes, benchmark requests, reported manual update/rollback records, and maintenance overrides. Record actor, target, safe before/after revisions and reason, never token bodies. A read-only admin cannot trigger writes through direct requests.

## 7. UX acceptance

Test loading/empty/error/offline/stale states; permission changes during a session; expired invitation; failed installation; pagination and unknown machine links; invalid numeric input; concurrent-edit conflict; busy benchmark; no compatible capacity; broken update; long and adversarial log text. Use keyboard-accessible dialogs, labels, focus restoration and visible mutation errors. Paginate logs and avoid rendering unbounded data.

Reuse API client retries carefully: non-idempotent actions need request IDs or no automatic replay. Clear sensitive invitation values when closing the dialog. Align frontend and backend contract fixtures and preserve the existing protected shell/navigation behavior. [R9]
