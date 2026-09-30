# Shared npm release acceptance — 2026-09-30

> Historical S3 release evidence. These archives and version IDs predate the
> R2 migration and must not be reused as an R2 release. See
> [the current storage guide](../r2-storage/README.md) for rebuilt runtimes,
> verified R2 identities and separately authorized publication.

Released CLI: `@music-mute/worker@0.1.1` on npm's `latest` tag, supporting
macOS ARM64/MPS and Windows x64/DirectML. The documentation-only patch retains
byte-identical executable/protocol/engine files from the accepted `0.1.0` CLI
and the accepted signed `0.1.0` runtimes (Mac sequence 3, Windows sequence 2).
Public tarball checksum verification and fresh default-tag registry consumers
passed on both platforms, including all 343 installed package files, help/version,
local readiness and signed update discovery. The original installations were
restored with their original two GPU slots. Ubuntu remains future work.
Dated entries below retain earlier failures and recovery evidence.

| Required check                                           | macOS Apple Silicon | Windows x64 / Z440                                                      |
| -------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------- |
| Fresh npm tarball consumer and signed production runtime | Passed, sequence 3  | Passed, corrected sequence 2                                            |
| Fresh enrollment and native GPU qualification            | Passed, MPS         | Passed, DirectML under LocalService                                     |
| Production input / processing / S3 output                | Passed              | Passed, corrected sequence 2                                            |
| Pinned output checksum and complete MP3 decode           | Passed              | Passed, corrected sequence 2                                            |
| Service restart with retained machine/slot identity      | Passed              | Passed, new PID/session                                                 |
| Signed discovery and current-version update command      | Passed, sequence 3  | Passed, sequence 2                                                      |
| Actual original-installation signed runtime update       | Passed              | Passed to preceding sequence 1; corrected runtime restoration completed |
| Confirmed unpair followed by conservative uninstall      | Passed              | Passed, normal installed sequence 2 CLI                                 |
| Operational two-worker installation restored and ready   | Passed              | Passed on corrected runtime                                             |
| Registry publication and clean registry consumers        | Passed, 0.1.1       | Passed, 0.1.1                                                           |

These checks cover service restart, not a new physical reboot/sleep/logout test
matrix. Synthetic output was decoded; human listening acceptance was not performed.
The per-user Mac runtime retains the security boundary described in its README.

## Signing and installer changes

The operator approved adding the public key `worker-release-2026-01` alongside
the existing `worker-release-2026-09` key. The saved private key was used only
on the operator Mac. Its derived public key matched the additional built-in
trust entry before signing. No private key is included in npm, runtime archives,
the backend or the Windows machine.

The initial artifact grant now includes the existing signed update envelope.
The CLI validates its built-in Ed25519 trust, platform, validity window and
release descriptor before downloading/extracting the runtime. Version, filename,
bytes, SHA-256 and content type must match the signed descriptor. The existing
machine update route shares this envelope construction. Existing authentication,
permissions and routes remain unchanged; the response extension is optional for
older clients, while the new installer requires a valid signature.

Windows enrollment inputs and staging directories are checked with actual NTFS
ACLs. The installation instructions create a protected parent and staging
directory; POSIX mode bits alone do not protect Windows credentials.

The API preflight used the [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-09-29: security rule 104, compatibility rule 106 and OpenAPI rule 101.
This is source guidance and local validation, not a compliance certification.

## Frozen artifact evidence

| Artifact                                                      |     Bytes | SHA-256                                                            | Candidate gate                                            |
| ------------------------------------------------------------- | --------: | ------------------------------------------------------------------ | --------------------------------------------------------- |
| npm `music-mute-worker-0.1.0.tgz`                             |    405613 | `44ab1b5123db036951356b00367366a18b0eb076ba48ea99fc5a657fe79eb97d` | Packed consumer passed                                    |
| npm `music-mute-worker-0.1.1.tgz`                             |    406074 | `08d1fbd5960459f3260a5adfb86fe99e5f0b778e0cd3c7b47af3601c141c433f` | Documentation patch; both fresh registry consumers passed |
| macOS `musicmute-worker-darwin-arm64-0.1.0.tar.gz`            | 330921314 | `4c8be302de484ac7cacf6fd3c5bae0b9c76f16543f9f689f55186a9c26428994` | Passed on macOS, signed sequence 3                        |
| Windows sequence 1 `musicmute-worker-windows-amd64-0.1.0.zip` | 354470664 | `96dbae85d33e84d210dd8bdedcd169ac2e726d507ae008af5fe239d77584767f` | Superseded; confirmed-unpair uninstall failed             |
| Windows sequence 2 `musicmute-worker-windows-amd64-0.1.0.zip` | 354471021 | `68f3f15a01dae995dc3541bd429dad6bc5e8f438c34f27151ff91e160763f39c` | Native gate and corrected fresh acceptance passed         |

The exact npm evidence is in the private operator directory
`/tmp/musicmute-final-1.0-npm-v7/package-evidence.json`. Native runtime manifests,
archive digests, signatures, npm version agreement and extracted archive contents
were verified by `scripts/check-release-candidate.mjs` on each native platform.
Do not substitute an earlier npm tarball for this candidate. The final documentation
refresh changed only README, CHANGELOG and RELEASING; compiled CLI, engine,
manifest and license bytes stayed identical to the preceding frozen candidate.
Both native candidate gates and fresh CLI consumer installations passed again
against v3 npm evidence. A later native Windows download exposed the total-timeout
issue described below. The table now identifies v7, which also fixes expired
invitation replay. Its packed consumer smoke/audit and both native candidate
gates passed. v5 retained a stale compiled enrollment module and is rejected;
v6 failed its npm audit request with ECONNRESET and has no passing evidence.

Both archive uploads succeeded to the private versioned S3 bucket with encryption
`AES256`. Independent pinned-version HEAD checks confirmed exact signed bytes,
content type and full-file `ChecksumSHA256`. Windows version
`PxTBtskUQljXKQ2G1KBvdiTeNz4_y9Wo` contains the verified 354470664-byte ZIP.
The first macOS upload lacked S3 SHA-256 metadata; a server-side copy of the exact
pinned source added the required full checksum while retaining the original
version. The catalog pins verified macOS version
`5JdYH_gBd_ZwlVH8wC3XnAjbZ574Kqu.`. The unchanged fixture's full S3 checksum was
also verified. Earlier failed Windows multipart transfer was closed without
removing an artifact; the successful local ZIP was promoted from `.partial` only
after checking its complete size and SHA-256. Temporary archive-only HTTP and SSH
forwarding were closed after transfer completion.

The first API staging started from the recorded API 91 archive, SHA-256
`7c611699991a19e277bdc8556ef6af3ab5af095f49335e871f5feac03ca8468d`.
API 91 was independently observed in the deployment UI. That staging must not be
deployed after the coordinated notification release: it lacks the new notification
module and Owner permissions.

The operator authorized coordination with the notification-release chat. The
worker catalog staging was rebased onto its exact current-main archive, SHA-256
`1c830b3af8a57cc97e555d919b7ca7669e304bec406bf94da226cda3eb8d6422`,
with 329 entries, under `/tmp/musicmute-1.0-api-main-staging`. The archive already
contains the same initial-artifact signing extension, and retains the notification
module and permissions. Rebased typecheck and build passed. The later worker
deployment must change only the catalog, retain all other bytes, and start from
the independently verified coordinated live image. Catalog preparation and final
archive comparison passed: the deployment has 329 entries, SHA-256
`45c2a2f862d00fe5c22db0ce1c120a111d6f57456c586978320897c790f3b2ca`,
and only `backend/config/worker-installation-catalog.json` differs from API 93.
The compiled backend parsed both descriptors and reproduced the exact original
signed envelopes for initial installation and updates. Thirteen focused artifact
service tests passed. A test attempt inside deployment staging found no test
files because deployment archives exclude tests; the focused suite then passed
from the repository.

The coordinated chat reported successful activation as `img-captain-api:93` from
that same archive after a failed build attempt 92. Its report included HTTP 200
liveness/readiness and the live Owner notification composer/history. The worker
release independently confirmed image 93 in the deployment UI immediately before
uploading its catalog-only archive. The build and activation succeeded as
`img-captain-api:94` at 2026-09-29T22:30:54Z. Screenshot proof is stored in
`/tmp/musicmute-public-1.0-artifacts/proof/api94-catalog.jpg`. Live installer,
update and runtime acceptance remain separate checks. Main CI run `36634024483` was independently read: backend,
web and dashboard jobs succeeded for commit
`84704c3e273ecff26f8024ce660936449be0b322`.

## Checks that actually ran

- Backend `pnpm run verify`: passed, including 979 unit and 153 HTTP tests,
  formatting, lint, typecheck, security checks and build.
- Worker `pnpm run verify` passed with `MUSICMUTE_PYTHON` selecting the installed
  qualified private Python. Protocol, formatting, lint and typecheck passed; the main TypeScript
  suite passed 540 tests with 17 expected platform skips; packaging passed 11 tests.
- The first full worker verification command failed at engine preflight because
  its default Python lacked the qualified dependencies. Engine checks were rerun
  with the installed private Python selected through `MUSICMUTE_PYTHON`; 95 tests
  ran with one expected skip. The subsequent full verification and build passed;
  final log: `/tmp/musicmute-final-1.0-worker-verify.log`.
- After additive trust and the Windows fixture correction, focused signing and
  enrollment tests passed on macOS. Windows passed 43 tests with one macOS-only
  skip, including restricted enrollment replay and native ACL checks.
- `pnpm run prepack` and `scripts/test-package.mjs` passed for the final npm
  tarball: 343 files, isolated installation, help/version and a clean production
  dependency audit. Scoped `git diff --check` passed.
- Fresh global installations of that tarball succeeded in separate npm prefixes
  on both machines with `--omit=dev --ignore-scripts`. The CLI inspected existing
  service installations. These are fresh CLI consumer checks, **not fresh runtime
  enrollment or activation**.
- Windows update discovery returned `WORKER_DEPENDENCY_UNAVAILABLE` before catalog
  promotion, as production still lacked a Windows runtime entry.

## Production acceptance plan at the initial freeze

1. Archive uploads, full S3 checksums, pinned versions and the two-platform signed
   catalog are verified. Keep the immutable versions pinned.
2. API 94 activation is verified for the catalog-only archive byte-compared against
   API 93. Verify readiness, auth boundaries and both authenticated artifact
   responses.
3. Exercise fresh runtime enrollment, GPU qualification, activation, real
   backend/S3 processing and independent output decoding on both platforms.
4. Exercise native restart and production signed update/recovery. Requalify two
   workers after an update; preserve the existing machine/slot identities and
   Windows Automatic startup policy when restoring the operational installations.
5. Publish the exact tested npm artifact, independently verify registry version,
   digest and tags, and install from the registry on both platforms.

The Z440's observed active adapter was Wi-Fi at 28.9 Mbps. Ethernet was requested
as an optional way to finish unreliable transfers; the operator chose to continue
over Wi-Fi. A service inspection briefly observed Stopped/Automatic, followed by
Running/Auto with both DirectML slots warming. At 2026-09-29T21:27:10Z the native
CLI reported running/healthy, both slots ready, active policy and claims allowed.
The thirty-minute error read contained 12 `NETWORK_UNAVAILABLE` occurrences,
last observed at 21:18:10Z, with zero affected jobs. This is a dated observation,
not continuous uptime or reboot proof. No production catalog was replaced and no
stable npm release was published in this acceptance stage.

A later inspection observed stale runtime status while SCM still reported
Running/Auto. The protected restart budget contained five starts, with no engine
processes remaining; sanitized stderr reported restart-budget exhaustion after
repeated `NETWORK_UNAVAILABLE` failures. An independent Windows API request also
encountered a connection reset. Restore stable API connectivity, then use the
documented stopped-service restart/reset path and verify fresh runtime readiness.
The earlier healthy snapshot does not establish the later state as healthy.

The supported CLI recovery restart reset the budget after verifying five starts
and zero engine processes. Its six-minute `start --wait-ready` observation timed
out while startup control requests remained unavailable. After briefly pausing the
large archive transfer, the independent Windows API readiness request returned
HTTP 200 in 0.759 seconds. At 2026-09-29T22:01:32Z local runtime status was fresh
and healthy, both original DirectML slot IDs were ready, and the active backend
policy allowed claims. A later SCM read confirmed Running/Auto. This restored the
existing private runtime, not the public `0.1.0` candidate. Transfer resumed with
a 128 KiB/s limit; its effect on sustained connectivity remains to be verified.
The active USB adapter was Realtek RTL8188EU, `Wi-Fi 4`, at 21.7 Mbps; reported
packet error/discard counters were zero and do not rule out the observed resets.

The archive-only transfer uses a Windows loopback HTTP listener through an
authenticated SSH port forward. A separate operator process waits for the exact
signed length, verifies the full SHA-256, renames the partial file, uploads it with
S3 `If-None-Match: *` and SHA-256, and checks the immutable version with HEAD.
Its running handle is not upload success; consume its terminal result before
preparing or promoting the production catalog. Close the temporary listener and
forward after transfer completion.

At 2026-09-29T22:26:40Z the Z440 again reported a fresh healthy snapshot, both
original slots ready and active policy allowing claims. This remains the existing
private runtime, not acceptance of public `0.1.0` activation or continuous uptime.

The repository installation/release documentation refresh, v3 package repack,
consumer smoke checks and both native candidate gates completed. The table above
identifies that final artifact. Fresh CLI installation still does not establish
fresh runtime enrollment, production processing, restart or update acceptance.

Production API 94 checks: both native final CLI consumers verified the signed
`0.1.0` update (macOS sequence 3, Windows sequence 1). API readiness returned
HTTP 200 with `{"status":"ok"}`; unauthenticated POST `/worker/updates` returned 401. An earlier generic urllib health probe received 403; the expected worker
user agent with curl passed. Managed runtime update commands are in progress;
update discovery is not activation acceptance. Scoped documentation/catalog
format checks and diff whitespace checks passed.

## Slow-connection correction and native update results

macOS production update completed at 2026-09-29T22:44:58Z: public runtime `0.1.0`,
sequence 3, healthy update state, unchanged original machine identity. Its
release-bound two-worker receipt needs requalification; the updater retained one
active MPS slot and preserved the additional slot identity.

The v3 Windows updater downloaded continuously but failed with `Transfer total
timeout` after ten minutes, before any runtime activation. A subsequent native
read confirmed Running/Auto, original private runtime and both original slots.
The final CLI increases only artifact downloads' total budget to one hour while
retaining thirty-second inactivity protection, explicit caller deadlines, safe
partial cleanup and full integrity checks. Qualification uploads and job transfer
budgets are unchanged. Regression tests reproduced the original failure, then
passed a progressing thirteen-minute transfer and verified cleanup at the
one-hour bound. Focused artifact/fault suites passed 18 tests; typecheck and
scoped lint passed. The full TypeScript suite passed 546 tests with 17 expected
platform skips. Source/docs format and scoped diff checks passed.

The v4 npm artifact was built from the frozen package with an isolated TypeScript
rebuild of the corrected module. Compiled changes are limited to
`enrollment/artifact-download.js` and its source map; declarations and all other
frozen modules remain byte-identical. Package docs include the corrected download
window. Native service archives and signed descriptors remain unchanged: managed
updates/downloads use the separately installed npm CLI. Packed consumer, audit,
fresh global consumer and native candidate gates passed on both machines.

For genuine fresh macOS enrollment, the original paired installation was drained
and explicitly stopped. Its complete root and LaunchAgent were renamed into
`~/Library/Application Support/MusicMuteWorkerAcceptance-0.1.0-20260930`, with
private restoration metadata and hashes. No original credential was revoked and
no data was purged. The default installation path was empty before starting the
final CLI with a new one-use invitation. Fresh enrollment/installation is running;
it is not yet accepted. Restore the original identity and two-worker configuration
after the temporary installation's processing/restart checks. Windows v4 update
was restarted through the supported drain/stop path and is also running.

Fresh Mac installation subsequently exchanged its one-use code and began the
trusted production archive download, but a real network stall triggered the
thirty-second inactivity deadline. No runtime was activated. Its consumed
enrollment state was preserved as `fresh-pending-root` inside the private
acceptance backup. The original paired public runtime was restored and resumed;
independent local/remote status at 2026-09-29T23:02:26Z confirmed ready, active,
healthy, unchanged machine identity and one MPS slot. Two-worker requalification
remains pending. Retry the preserved fresh installation without `--new-code`.

The SSH connection dropped during the Windows v4 transfer. After reconnecting,
authoritative Win32_Process inspection confirmed updater PID 12368 remained live
and had written 231442406 bytes. SCM remained Stopped/Auto/PID 0, as deliberately
requested before the update, and the old active release was preserved. Do not
restart or duplicate that updater merely because its SSH observation terminated.
The next fresh installation attempt will follow the Windows bulk transfer rather
than run both downloads concurrently.

## Enrollment recovery and fresh Mac acceptance

The genuine fresh Mac install downloaded the signed runtime and direct-owner
model, passed GPU qualification, then failed when enrollment repeated the
original invitation exchange after its fifteen-minute expiry. The installation
credential remained valid for one hour. The CLI now resumes with the protected
saved installation identity/credential, and replays activation using the saved
report revision. Backend expiry and idempotency checks remain authoritative.

The regression was reproduced before the fix. The updated enrollment suite
passed 16 tests against both source and independently compiled modules, including
an uncertain activation response. Typecheck, scoped lint/format and the full
TypeScript suite passed: 547 tests, 17 expected skips. The final v7 npm consumer
and native Windows/macOS candidate gates passed.

At 2026-09-29T23:24Z, the preserved fresh enrollment successfully activated Mac
`4136fa5c-2a7e-48a1-9699-7973d64b79b9` with MPS slot
`064f859a-e000-46a7-a15d-96a46853430c`. This was recovered original enrollment
`8a682431-afd3-472a-a796-d141c9d241a9`; no replacement code or preseeded runtime
was used. The local/remote CLI reported healthy, ready and claims allowed.

Synthetic 60-second WAV job `6abc489b16f50f2cad88680f` completed through the
production app/backend/private-S3 flow on attempt
`3554a1a9-c01c-4cef-895a-fbe8e9d8c2dc`. The app showed Ready and the worker
recorded one succeeded attempt, no retry or child restart. Separation took
6.237 seconds and the worker attempt took 25.816 seconds. The exact app-granted
S3 output version was independently retrieved with full SHA-256 verification:
1202721 bytes, digest
`512ec11f4dffac190e21c8b4644445bc7c7c25b42788c2c15a191f8597d56012`.
FFprobe reported stereo MP3, 44100 Hz, 60.070023 seconds; FFmpeg decoded the
complete file without error. This synthetic check is not listening acceptance.

Fresh Mac restart passed with a new service PID/session and the same machine/slot
identity. The signed production update check returned current/available version
0.1.0, sequence 3, updateAvailable false. The original paired Mac previously
passed actual signed activation of that runtime. The disposable fresh machine
was backend-confirmed unpaired and conservatively uninstalled; its retained
files were preserved in the private acceptance backup. Original pairing/config
and credential hashes were verified before restoration. Two-worker qualification
on the restored Mac is running; final resumed two-slot status is not yet proven.

Windows v4 update committed runtime 0.1.0 with highest signed sequence 1 and no
quarantined version. Native start and independent local/remote readiness passed
on its retained original machine and first DirectML slot. Its two-worker native
qualification remains running. SSH observation dropped during the benchmark;
reconnection independently proved Node PID 12416 and concurrent Python children
were still alive and writing output. Do not launch duplicate qualification based
on an SSH observer ending. Fresh Windows enrollment/processing, final two-slot
restoration and npm publication are still pending.

At 2026-09-29T23:38Z the restored original Mac passed new two-worker capacity
qualification on both recipes (throughput speedups 1.26435 and 1.24327). Capacity
was set to two, launchd started and local intent resumed. Independent CLI status
proved runtime 0.1.0, healthy/ready/active, claims allowed, original machine
`d4874cbf-1167-4af8-ae15-c029b4acdd65` and both original MPS slot IDs retained.
The same v7 packed enrollment modules passed the native Windows regression suite:
15 tests passed, one macOS-only artifact preparation test skipped. Windows native
capacity report remains IN_PROGRESS; its live Node PID 12416 and new Python
cohort were independently observed after the lost SSH output session.

Qualified hosts observed in this acceptance: macOS 26.6.2 build 25G83, Apple M4
Pro, 24 GiB physical RAM; Windows 11 Pro build 26200, HP Z440, about 24 GiB
physical RAM. These records do not establish minimum OS/RAM support for every
compatible GPU or input length. The README documents installation qualification,
Node 24.18.0, administrator-only Windows setup, per-user Mac setup and unsupported
platforms including future Ubuntu.

## Windows capacity and fresh enrollment progress

The ten-minute Windows input completed its two-worker measurement with passing
quality checks and throughput speedups 1.53424 and 1.66929. This is measurement
evidence only: the input is not the installed qualification fixture, so the
supported approval command correctly refused to issue a capacity receipt.

The subsequent benchmark used the exact installed qualification fixture. Report
`benchmark-a43ead97-ad06-4c3e-b42b-f6ab0beaf34e.json` passed both recipes, with
throughput speedups 1.52134 and 1.33625. The native capacity receipt was validated
at 2026-09-29T23:58:47.734Z, and `mw capacity --workers 2 --json` retained both
original Windows slot identities. This is actual native capacity qualification,
separate from fresh installation and production processing acceptance.

Before the fresh Windows test, conservative uninstall preserved the original
configuration, machine credential, models, releases and logs. Configuration and
credential hashes were checked before moving the retained root into a private
Administrators/SYSTEM acceptance backup. The original machine was not unpaired.
Its two-slot installation must be restored with Automatic service startup after
the disposable fresh installation is tested.

The unused invitation expired before exchange and was replaced. A background
Node launch exited before enrollment; authoritative process and state inspection
confirmed this before retrying. The foreground invocation initially included an
unsupported `--json` flag for first-install bootstrap; it failed before exchange.
The documented first-install command without that flag subsequently exchanged
the invitation and saved installation `fc96255d-f6b7-4dbe-803b-207959513a2c`.
Foreground installer PID 13532 was independently observed running. Runtime
download, activation, fresh Windows processing, restoration and npm publication
remain unproven at this stage. Preserve this enrollment state when retrying.

An operator `.ps1` invocation was rejected by the host's Restricted execution
policy, and an oversized inline command exceeded Windows' command-line limit;
neither performed its intended operation. Preservation completed through smaller
reviewed inline commands without changing the execution policy. The final npm
tarball also passed a publication dry run; registry tags still pointed to
`0.1.0-rc.1`, so the dry run does not establish publication.

## Windows sequence 1 acceptance and sequence 2 correction

The genuine foreground Windows installation completed with all artifacts
freshly downloaded and DirectML qualification passed under LocalService.
Disposable machine `f2570013-32cf-482a-8c2e-4778139906b7` registered slot
`31719193-879e-4690-90a1-de960dcc4fad`. Its service was Running/Automatic.

Synthetic 60-second WAV job `6abc57e516f50f2cad886815` completed on one attempt
`8ecc557c-740c-4020-b924-45c1ffc79418`, with no retry or child restart.
Separation took 6.690 seconds; the worker attempt took 22.684 seconds. The app
showed Ready. The exact granted S3 output version was independently retrieved
and verified: 1202721 bytes, SHA-256
`ecf21aa0e15bd0db2aaba27e1223221f695e4142f264e25d6370444ce0b5d5ba`.
FFprobe reported stereo MP3, 44100 Hz, 60.070023 seconds; complete FFmpeg decode
passed. Restart retained machine/slot identity with a new PID/session. Signed
update discovery and the current-version update command passed for sequence 1.

Confirmed unpair removed the pairing files after service stop. Conservative
uninstall and ordinary recovery then failed because the native journal reader
required those absent files. The corrected helper permits this state only when
both files are absent, the service was stopped, and a bounded strict unpair receipt
is Administrators/SYSTEM-owned with safe ACLs. Missing, malformed or service-writable
receipts, partial pairing and restart intent remain rejected. The native regression
reproduced the old failure and passed after the fix. Recovery/script suites passed
12 native tests; the separate opted-in WinSW stop integration passed. Focused
macOS tests passed 27 tests with 9 expected Windows-only skips.

The reviewed corrected source manager recovered and conservatively uninstalled
the disposable installation without modifying its immutable installed runtime.
This operator recovery does not establish ordinary CLI recovery on sequence 1.
Its retained root remains private. Original config/credential hashes were checked
before restoring the original installation. Independent status at
2026-09-30T00:59:58Z proved Automatic startup, healthy/ready/active and claims
allowed, with original machine `8bd8181d-eeb0-473d-91ee-aff313103349` and both
original DirectML slots. Mac status at 01:03Z remained healthy/ready/active with
both original MPS slots.

Native `pnpm run package:windows` rebuilt the corrected runtime successfully:
354471021 bytes, SHA-256
`68f3f15a01dae995dc3541bd429dad6bc5e8f438c34f27151ff91e160763f39c`.
Signed Windows metadata uses sequence 2 and the approved January key. The helper
and two generated pnpm metadata files differ from the preceding archive; compiled
JavaScript, engine and native binaries are unchanged. The npm v7 tarball is
unchanged. Corrected archive transfer, pinned S3 verification, native candidate
verification and production installer acceptance remain pending. Original
Windows two-worker capacity must be requalified against the new runtime manifest.

## Corrected signed runtime delivery — 2026-09-30T01:32Z

Windows sequence 2 passed the native candidate gate with the unchanged v7 npm
evidence. The transferred archive matched its signed bytes and complete SHA-256.
Private encrypted S3 upload pins version `Qq1UUOpQ0pJg_K7uAYLRvhjUgr5glFe9`
at `worker-installation-artifacts/releases/windows-amd64/0.1.0-unpair-recovery.zip`;
independent pinned HEAD confirmed full checksum, content type and exact size.
The preceding artifact/version remains retained.

API 95 is independently active in the deployment UI. Its archive has 329 entries,
SHA-256 `a33bdfedd0aaf16f35c2d3ea1ba8669bd3f8ab76b3b61c19520307f0b74b5119`.
Comparison with the verified API 94 archive proved only the worker catalog file
changed. Mac/model/fixture descriptors and all other backend bytes are unchanged.
Compiled backend artifact service read-back reproduced exact signed initial and
update envelopes for Windows sequence 2 and Mac sequence 3. Live curl health
checks returned 200; Python urllib requests returned 403, which is not health
proof. Authenticated native Windows update discovery verified sequence 2; Mac
update discovery still verified sequence 3.

The full current TypeScript suite passed 547 tests with 18 expected platform skips.
Typecheck, scoped lint/format, protocol check, 11 packaging tests and scoped diff
check passed. npm publication was attempted with `next`; the registry required
security-key authentication, whose waiting session then expired with E404. No
publication success is claimed. The original Windows pairing/root was
conservatively preserved again for genuinely downloaded sequence 2 installation.
Corrected fresh acceptance and operational restoration remain in progress.

## Corrected Windows sequence 2 fresh acceptance — 2026-09-30T01:54Z

A genuinely downloaded production installation completed successfully with
installation `ec0c0512-f505-484c-aa97-09ed6fcaa6b1`, machine
`9d7e6897-2442-44bc-85ed-27030d7e5e45` and DirectML slot
`2ec053ad-bb1b-45e9-a312-3a2fa2f80e01`. No archive/model/fixture was preseeded;
`prepare-installation` reported reused false. DirectML qualification passed under
LocalService. Independent installed manifest SHA-256 was
`5bdf175c634c35ad591433ff8db8cf3c8250587282275f5ea8e8b6ab38c43f7a`,
matching the corrected candidate. Bootstrap exited zero and native status proved
Running/Automatic, healthy/ready/active and claims allowed.

Synthetic 60-second WAV job `6abc69e5198328e1513e8d00` completed through the
production app/backend/private-S3 flow on attempt
`9441d20e-2596-4a6c-86ef-13932c224cb1`: 22.906 seconds for the worker attempt,
7.586 seconds separation, one succeeded attempt, no retry or child restart.
The app showed Ready. Exact granted S3 output version
`u3nd0Rfcy5hEbpV3qLDvnAukWTMO_Wpu` was independently retrieved and checked:
1202721 bytes, SHA-256
`ecf21aa0e15bd0db2aaba27e1223221f695e4142f264e25d6370444ce0b5d5ba`.
FFprobe reported stereo MP3, 44100 Hz, 60.070023 seconds; complete FFmpeg decode
passed. This does not establish human listening acceptance.

Signed update discovery and the current-version update command both passed with
sequence 2. Service restart produced new runtime PID 5244 and session
`5ad53ce8-4854-4bf5-8bda-c284d8cc3129`, retained the original fresh slot, and
returned to healthy/ready/active with Automatic startup. Ordinary installed
`mw unpair --json` returned backend confirmation; ordinary
`mw uninstall --json` then succeeded with preservedData true. No corrected-source
operator recovery or immutable-runtime modification was needed. The disposable
root remains retained in the private acceptance backup.

The operational original Windows data is being restored to a separate root with
the corrected immutable 0.1.0 runtime. Both old original and accepted disposable
roots remain retained; the old immutable directory is not overwritten. Original
pairing hashes are checked before and after restoration. Two-worker qualification
must bind the corrected manifest before the original second slot is admitted.
npm publication remains pending security-key authentication and registry consumer
checks; the default tag must not be described as promoted.

## Original Windows two-worker restoration — 2026-09-30T02:15Z

The original credential hash and machine identity were retained. Original files
were cloned into a separate installation root while excluding the preceding
immutable 0.1.0 directory; the corrected accepted runtime was copied into the
new empty version directory. Both retained roots remain untouched. The existing
capacity configuration validator safely selected one slot while the SCM service
was absent and retained the second original identity; ordinary reactivation and
first-slot model readiness passed.

The exact installed fixture benchmark
`benchmark-ff0eeec6-eb0d-4889-aeb2-395d6d2c0948.json` passed both recipes with
throughput speedups 1.3696389 and 1.1865234, including all quality comparisons.
Supported native approval produced a PASS receipt bound to corrected manifest
`5bdf175c634c35ad591433ff8db8cf3c8250587282275f5ea8e8b6ab38c43f7a`, original
machine `8bd8181d-eeb0-473d-91ee-aff313103349` and validated capacity two.
The receipt expires 2026-10-07T02:09:59.806Z; its normal seven-day validity remains
unchanged. No receipt was fabricated or reused across manifest identities.

`mw capacity --workers 2`, model-ready start and resume passed. Independent status
proved healthy/ready/active, claims allowed and both original IDs
`e37fb847-c5e9-4e93-85f3-e7e80a78a5cc` and
`b378451b-c458-4a3e-9f09-c2618ccdee2c`. Native SCM registration was independently
Running/Automatic under LocalService; original credential hash matched the
preservation record. The original Mac also remains healthy/ready/active with its
two original MPS slots. The corrected runtime acceptance and operational
restoration are complete. Final npm publication is waiting for registry-required
security-key authentication; clean registry consumers remain pending publication.

## npm publication authentication expired — 2026-09-30T02:31Z

The final `latest` publication process exited with E404 after its web
authentication request expired. Registry read-back still returns
`latest: 0.1.0-rc.1` and `next: 0.1.0-rc.1`; `0.1.0` publication is not
established. No publisher is waiting on that expired request. A fresh request
requires the operator to complete npm's security-key/passkey authentication.
Clean registry installation checks on both platforms remain pending publication.
The frozen v7 npm tarball and accepted native runtime artifacts are unchanged.

## npm upload accepted — 2026-09-30T12:57Z

The expired npm login was refreshed through the operator's security key. A
separate publication challenge completed successfully. Publishing the exact v7
tarball with `--tag latest --access public` exited zero and returned
`+ @music-mute/worker@0.1.0`; the registry PUT returned HTTP 202. This proves
upload acceptance, not yet public installation availability. Read-back still
returns the preceding release. `npm stage list --json` returned an empty list.

[npm's publish-time scanning notice](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)
explains that scanning normally delays installation availability, typically about
five minutes and sometimes longer. Scanning is the likely explanation; an exact
scan result has not yet been observed. Do not republish or bypass these checks.

An initial clean default-tag registry consumer on macOS resolved `0.1.0-rc.1`
while the new upload was unavailable. It is retained separately and is not
accepted as the final 0.1.0 registry test. The original Mac's local status still
reports healthy and model-ready on runtime 0.1.0; local-only status does not
establish current backend claim eligibility. The Z440 SSH connection to
192.168.1.124 currently times out. Windows registry consumer validation needs
host connectivity restored; the earlier fresh native acceptance evidence remains
separate.

## npm public availability and Windows command correction — 2026-09-30

The authenticated `0.1.0` publication returned HTTP 202 at 12:53:55 UTC.
After npm validation and propagation, the public tarball downloaded successfully
at 13:22:57 UTC. Its complete SHA-256 matched the frozen v7 artifact above.
A fresh default-tag macOS registry installation passed help, version, local native
readiness and signed sequence 3 discovery, with all 343 package files compared
against that public tarball. Windows registry installation attempts failed with
ETIMEDOUT over Wi-Fi; these attempts are not passing consumer evidence.

A native check found that default Restricted PowerShell resolves bare `mw` to
`mw.ps1` and rejects it with SecurityError. The Windows documentation now uses
`npm.cmd` and `mw.cmd`, without changing or bypassing execution policy. The
`0.1.1` CLI documentation patch retains the accepted signed `0.1.0` runtimes.

The workspace has advanced with a separate dashboard diagnostics change. A
rebuilt workspace package therefore failed the documentation-only byte gate and
was rejected for this patch. Private staging instead starts from the exact
accepted v7 tarball and changes only README, CHANGELOG, RELEASING and the manifest
version. The resulting 343-file archive has SHA-256
`08d1fbd5960459f3260a5adfb86fe99e5f0b778e0cd3c7b47af3601c141c433f`.
Compiled CLI, protocol, engine and license bytes are identical to v7; the manifest
diff contains only the version. Its isolated packed consumer and production
dependency audit passed. Native runtime candidate gates remain bound to the
original accepted v7 evidence and signed catalogs. No newer repository source
was overwritten. `0.1.1` publication and both fresh registry consumer checks
remain pending at this entry.

The Windows `0.1.0` registry retry completed successfully in eight minutes using
the official registry/cache, process-scoped IPv4-first resolution and two npm
connections. All 343 installed package files matched the accepted public tarball.
The Restricted-policy `mw.cmd` consumer passed help/version, healthy model-ready
local status and signed sequence 2 update discovery. A later status check observed
the operational service stopped; normal `mw.cmd start --wait-ready` restored
Running/Automatic and healthy model-ready status, without changing policy or
capacity. These observations are retained separately from the preceding native
acceptance and do not establish a physical reboot test.

The fresh `0.1.1` publication passkey completed successfully. npm accepted the
exact frozen v3 tarball with HTTP 202; the owner version table shows Validating.
Public availability and both `0.1.1` registry consumers are pending.

## Final registry acceptance — CLI 0.1.1

At 14:23:34 UTC, canonical public registry metadata identified `latest` as
`0.1.1`, and its full 406074-byte tarball download matched the frozen v3 SHA-256
above. Fresh default-tag npm installations completed on both native platforms.
All 343 files matched the public artifact; help/version, healthy model-ready
local status and signed current-version update checks passed. The CLI reports
`0.1.1`, while the separately signed managed runtime correctly reports `0.1.0`.
Windows uses `mw.cmd` under the unchanged Restricted execution policy.
The Windows consumer initially observed a loading model and failed readiness;
the normal readiness wait completed, and the complete consumer check then passed.
This failed intermediate observation was retained, not counted as success.

Final private evidence includes `npm-0.1.1-code-identity.json`,
`npm-0.1.1-public-readback.json`, `darwin-registry-consumer-0.1.1.json` and
`win32-registry-consumer-0.1.1.json` under the existing operator proof directory.
The patch was published from the accepted executable bytes, not the newer
workspace diagnostics module. Native enrollment, processing, service restart,
update and removal evidence remains the accepted runtime evidence above.

Operational limitation observed during this run: the Z440's Wi-Fi transfer and
control-plane requests intermittently timed out. Runtime stderr reported
NETWORK_UNAVAILABLE exits, and Windows recorded an unexpected service termination
with its configured automatic recovery. Normal startup/recovery returned both
DirectML slots to model-ready state. Final registry readiness passed after recovery,
but this is not evidence of continuous availability during network outages.
No retry-budget bypass, network configuration change or driver replacement was
applied. Physical reboot/sleep/logout and human listening checks remain outside
this acceptance matrix.
