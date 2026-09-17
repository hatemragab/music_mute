# Mac mini M4 and isolated local test resources

## Purpose and authorization

This runbook is for the implementation agent operating on the owner's Mac mini M4. Preparing this package did not provide access to that machine. Ordinary scoped local builds/tests and the agreed worker service work are permitted; production mutation, arbitrary driver changes, logout/reboot and public publishing are not implicit permissions.

Use the assigned branch and [agent rules](../AGENT-RULES.md). Record actual hardware and OS information rather than inferring RAM from the M4 name. Keep both the original project files and local credentials intact.

## 1. Preflight

Confirm repository path, current branch, clean working tree, package/lock conventions and current collection ancestry. Inspect ignored/tracked environment paths without printing contents. Protect `.local.env` before staging anything; the persistent tracked ignore fix is in C1.

The repository currently loads `.env.local`, not `.local.env`. C supplies an explicit isolated-test loader for the owner's filename. Do not rename/copy or shell-source the file automatically. Never export its entire content into an agent/engine environment.

Record `uname -m`, macOS version, actual GPU/unified-memory report and runtime architectures. Native `arm64` is required for the Apple path. Run only the pinned model/package release selected by B.

## 2. Database and Redis isolation

Use dedicated local ports or the existing repository's isolated-service helper. MongoDB must be a writable replica set with sessions; a local single-node replica set is sufficient for these integration tests. If the repository already provisions one, reuse that mechanism rather than introduce another service manager.

Generate a unique run ID and database name such as `musicmute_worker_test_<runid>`. Use a dedicated Redis instance when possible; otherwise an approved logical DB plus an explicit worker-test key prefix. Check target addresses and names before cleanup. No `FLUSHALL`, production collection dropping or broad wildcard deletion.

Override the harness's DB/Redis targets with these explicit values after parsing owner configuration. Refuse `production` APP_ENV and unapproved remote database targets for destructive fault tests. Put a marker record/key in the owned namespace so teardown can prove it owns what it deletes.

Apply migrations/index initialization only to that namespace. Use synthetic auth/admin accounts or existing emulator helpers; never hardcode an auth bypass into production controllers.

## 3. S3 test configuration

The backend/harness may read the owner's AWS credentials from `.local.env`. Workers and children must not receive them. Use a dedicated approved test bucket or an approved narrow prefix such as `worker-tests/<runid>/` in a compliant private versioned bucket. A prefix is not a substitute for an IAM policy; verify actual permissions and preflight without changing bucket settings.

Provision a short owned/licensed demo fixture with exact SHA-256, S3 version and manifest. Keep input and output keys in a teardown manifest. Reuse existing exact-key/version cleanup; do not add broad lifecycle expiry or delete neighboring user objects. Budget tests by fixture size and attempt count rather than stress-uploading unlimited audio.

Store logs/evidence with query strings and account secrets redacted. Backend credentials remain in the local harness process. A child environment is constructed from a small allowlist, not `{...process.env}`.

## 4. Backend and runtime startup

Read actual component scripts. The inspected backend manifest uses pnpm; older prose mentions npm. Follow the current committed lockfile and do not generate another lockfile. Run the branch's new fleet integration commands only after they exist and are documented.

Start the local backend bound to loopback by default. Enable worker processing only for the isolated test configuration. Register a scoped test machine using real enrollment. Start one M4 worker slot, test `doctor`/benchmark, then process a real S3 job.

Capture provider/model/recipe digests, actual acceleration evidence, memory, decode/separation/postprocess/encode/transfer timings and valid output. Run default trim-on/denoise-off, then the other three recipes. Keep audio listening results distinct from numeric smoke checks.

## 5. Service-context testing

After D implements installation, inspect the generated LaunchDaemon and service account/filesystem ownership. Install through normal supported elevation; never pipe an unverified remote installer into a root shell just for convenience.

Test a service-launched job using absolute runtime/model/cache paths and sanitized environment. Confirm native ARM64 and accelerated inference from this service context. Then test service stop/restart, child crash and repair.

For an actual interactive logout/reboot test, coordinate with the owner first and preserve the test backend independently of the session being ended. Otherwise logout may kill the development API and make the test measure backend loss rather than worker startup. A temporary approved backend service or an already available isolated staging backend may be used; do not silently deploy production infrastructure.

FileVault unlocking after a cold boot may be necessary before the normal OS service can run. Do not disable encryption or claim a service bypasses it. Label service restart, interactive logout, warm reboot and cold boot separately in evidence.

## 6. Failure/manual-update test sequence

Use small fixtures. Stop only the test child or test supervisor, not unrelated processes. Block only the selected test connection, not the owner's whole network. Observe leases, requeue and stale-attempt fencing.

During G, explicitly install a locally verified bad test candidate on this test machine. Prove launcher rollback without backend access. Restore the known-good test release and remove the synthetic bad release/quarantine override deliberately. Do not automatically delete evidence before recording it. Fleet target selection and remote rollout are post-MVP.

## 7. Teardown and evidence

Drain/stop test slots, revoke ephemeral credentials, clean exact test-owned S3 versions, drop only marker-verified test database/Redis keys, and stop only services this run created. Leave agreed installed production-intent worker files alone unless uninstall was explicitly part of the test.

Record commands, versions, outcomes, run IDs, checksums and sanitized traces using the checkpoint template. Do not attach `.local.env`, tokens, raw private audio or absolute personal home-directory dumps. Tests not run are marked `NOT_RUN` with the required next input.
