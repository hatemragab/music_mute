# Shared npm release acceptance — 2026-09-30

Candidate: `@music-mute/worker@0.1.0`, macOS ARM64/MPS and Windows
x64/DirectML. Publication and production catalog promotion are **pending**.
Ubuntu remains future work. This ledger records candidate checks; it does not
replace fresh production installation, enrollment or processing acceptance.

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

| Artifact                                           |                Bytes | SHA-256                                                            | Candidate gate                       |
| -------------------------------------------------- | -------------------: | ------------------------------------------------------------------ | ------------------------------------ |
| npm `music-mute-worker-0.1.0.tgz`                  | See package evidence | `b63b1eb6e0c1801458579a0f76f56b902255dc1cb977c3f427702e25a266e9b1` | Packed consumer passed               |
| macOS `musicmute-worker-darwin-arm64-0.1.0.tar.gz` |            330921314 | `4c8be302de484ac7cacf6fd3c5bae0b9c76f16543f9f689f55186a9c26428994` | Passed on macOS, signed sequence 3   |
| Windows `musicmute-worker-windows-amd64-0.1.0.zip` |            354470664 | `96dbae85d33e84d210dd8bdedcd169ac2e726d507ae008af5fe239d77584767f` | Passed on Windows, signed sequence 1 |

The exact npm evidence is in the private operator directory
`/tmp/musicmute-final-1.0-npm-v2/package-evidence.json`. Native runtime manifests,
archive digests, signatures, npm version agreement and extracted archive contents
were verified by `scripts/check-release-candidate.mjs` on each native platform.
Do not substitute either earlier npm tarball for this candidate.

macOS archive upload succeeded to the private versioned S3 bucket with encryption
`AES256`. Independent pinned-version HEAD confirmed 330921314 bytes and
`application/gzip`. Windows upload is incomplete: direct and chunked uploads
encountered connection resets. The empty multipart session was closed without
deleting an artifact. A partial download is explicitly named `.zip.partial` and
must never be promoted without the full digest check.

The API deployment candidate starts from the recorded API 91 archive, SHA-256
`7c611699991a19e277bdc8556ef6af3ab5af095f49335e871f5feac03ca8468d`.
Only the installer artifact service was copied from the current checkout into
the isolated source tree. Its typecheck and build passed. The catalog and final
archive comparison remain pending; unrelated checkout changes must not enter
this deployment. API 91 was independently observed in the deployment UI.

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

## Remaining production acceptance

1. Finish the Windows archive transfer/upload and independently verify its pinned
   S3 version, full bytes and digest. Prepare the two-platform signed catalog.
2. Byte-compare the isolated backend archive against API 91, deploy the installer
   extension/catalog and verify the active image, readiness, auth boundaries and
   both authenticated artifact responses.
3. Exercise fresh runtime enrollment, GPU qualification, activation, real
   backend/S3 processing and independent output decoding on both platforms.
4. Exercise native restart and production signed update/recovery. Requalify two
   workers after an update; preserve the existing machine/slot identities and
   Windows Automatic startup policy when restoring the operational installations.
5. Publish the exact tested npm artifact, independently verify registry version,
   digest and tags, and install from the registry on both platforms.

The Z440's observed active adapter was Wi-Fi at 28.9 Mbps. Ethernet was requested
as an optional way to finish unreliable transfers. A service inspection briefly
observed Stopped/Automatic, followed by Running/Auto with both DirectML slots
warming. The follow-up health/error read was interrupted by SSH connectivity loss.
Do not interpret startup policy or that transient Running observation as current
healthy/online proof. No production catalog was replaced and no stable npm release
was published in this acceptance stage.
