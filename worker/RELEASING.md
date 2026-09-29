# Worker release procedure

The shared npm CLI targets **macOS Apple Silicon** and **Windows x64 with
DirectML**, with one worker per GPU by default and manual runtime updates.
Validate each platform's exact signed runtime and a fresh npm installation before
promoting the shared package. Linux and Intel Mac are unsupported.
Verification and publication are separate operations.

## Source and npm gates

Use Node 24.18.0 (24.x only), pnpm 10.14.0 and the qualified Python environment
from README.md. From `worker/`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify
pnpm run test:package
pnpm audit --prod
```

`build` cleans this component's generated `dist/` and rejects a symlink there.
`prepack` builds and compares the npm inventory with current source. Missing files,
stale modules, unexpected files and common credential patterns fail the gate.
Review the diff and archive too: a targeted scan cannot recognize every secret.

`test:package` installs the exact tarball in an isolated consumer with lifecycle
scripts disabled, audits the consumer's production dependencies, and exercises
help/version without reading a real worker installation. npm audit does not cover
Python wheels, native binaries, model permissions or license obligations.

To retain a tested tarball and SHA-256 evidence, supply a **new** output directory:

```sh
pnpm run prepack
node scripts/test-package.mjs /absolute/new/release-output
```

The result contains the tarball and `package-evidence.json`. Failed checks produce
no passing evidence. Changing artifact bytes invalidates the evidence. The package
defaults to public access and the `next` tag; this does not publish it.
`prepublishOnly` checks source and the packed consumer when publishing from source.
Publishing a tarball must use the tested artifact; do not depend on source lifecycle
hooks running for every publishing method.

The GitHub workflow uses hosted macOS ARM64, pinned action commits, read-only
repository permissions and no production secrets. Its fixtures do not establish
GPU, service or live-fleet acceptance.

## Runtime and catalog gates

1. Freeze a reviewed commit and one version across `package.json`, the runtime
   manifest, signed metadata and release notes. Rebuild the runtime from that
   source; do not relabel an older `.local.*` archive.
2. Use `mw package-macos` with qualified private Node/Python/media roots and that
   version. Leave `SENTRY_AUTH_TOKEN` unset for local builds that must not upload
   source maps. Keep credentials, state, models and job media outside the archive.
3. Audit the actual native dependency inventory and notices, including the media
   source manifest. Retain the recorded direct-owner model authorization. Do not
   rehost model weights or infer redistribution rights from the CLI license.
4. Verify backend compatibility: root `/worker/...` routes, diagnostic cursor,
   hints, recipe revision 6, optional trimming and execution timings. Upgrade
   compatible workers before enabling recipe changes older workers reject.
5. Sign metadata with the approved external Ed25519 key. Increment the sequence
   and bind version, archive filename/bytes/SHA-256 and validity window. Private
   signing keys stay outside Git, npm, the backend and workers.
6. Run the read-only candidate gate. The last argument is the minimum acceptable
   new sequence, normally the current catalog sequence plus one:

```sh
node scripts/check-release-candidate.mjs \
  /absolute/runtime-directory \
  /absolute/musicmute-worker-darwin-arm64.tar.gz \
  /absolute/release-output/package-evidence.json \
  /absolute/signed-update.json \
  3
```

Replace the example sequence with a value based on current production metadata.
The gate verifies built-in signing trust, expiry, sequence, version agreement,
artifact hashes, runtime inventory and extracted archive contents. After separately
authorized promotion, independently read the deployed catalog. Do not downgrade a
healthy newer local runtime to an older catalog. Automatic fleet rollout is absent.

## Capacity and rollback

Two-worker updates journal the previous runtime configuration before changing
intent. The candidate uses one existing slot per GPU until separately qualified.
The old receipt stays untouched for rollback and cannot authorize the new release.
Configuration is checked even when the service remains stopped. Update JSON reports
`capacityRequalificationRequired: true`; human output explains the next step.

Rollback restores the previous release and configuration, preserving local intent.
Stopped services stay stopped. Expired evidence does not bypass runtime admission,
but maintenance update checks can still authenticate to repair the installation.
If rollback restores an already-expired receipt, two-slot startup still requires
requalification. Benchmark while drained/stopped, then coordinate any second slot
with backend capability and policy approval.

Legacy incomplete journals remain supported. Finish pending updates before
changing CLI versions. Use the CLI that began an update or a newer one for recovery;
older CLIs cannot interpret newer journal fields. Before restarting an older runtime,
rollback durably restores its config and rewrites the journal to a compatible
completed-restoration state; a failed service start retains retryable intent.
Do not edit journals or remove
lock guards. Automatic rollback covers pending activation, not every later crash;
post-activation failures use the restart budget and may require operator recovery.

## Final artifact acceptance

Record the artifact digest, date and results below. Older releases and NOT_RUN
entries do not establish acceptance of the candidate:

- Fresh dedicated Mac: Node/npm setup, enrollment, artifact/model integrity,
  GPU qualification and backend registration; interrupted installation recovery.
- Login startup, screen lock, logout/login, sleep/wake and reboot; pause/drain/
  resume, normal stop/restart and backend pause/revocation fences.
- Running/stopped updates, interrupted activation, verified rollback, expired
  capacity evidence and independent runtime health/configuration read-back.
- Real backend/S3 input download, processing, upload and authoritative completion;
  independent MP3 decoding and listening acceptance.
- Controlled cancellation, network interruption, lease loss and lost completion
  acknowledgement with synthetic jobs; no duplicate published output.
- Sanitized backend/Sentry diagnostic receipt and operator visibility. A local
  spool write or successful capture call is not remote delivery proof.
- Preserved uninstall/reinstall; separately authorized unpair/purge against a
  disposable installation only.

Record minimum supported macOS, memory and free disk from qualified hardware.
Public-input processing belongs on dedicated hardware without personal/cloud
credentials unless stronger isolation is independently qualified. The per-user
process is not an OS sandbox. See the existing public-upload security review.

## Authorized publication

Verify scope ownership, publisher permission and 2FA/trusted-publisher setup.
After explicit authorization and acceptance, publish the tested tarball with public
access and `next`. Install from npm on a fresh consumer, verify registry integrity,
version, enrollment and update behavior, then review results before a stable
release. Never put tokens in source or command arguments. See npm's
[trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).

Removing the global npm CLI does not stop the LaunchAgent. Use the documented
`mw uninstall` procedure before removing the CLI when retiring the worker.
