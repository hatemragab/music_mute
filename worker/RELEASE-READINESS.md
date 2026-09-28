# 0.1.0-rc.1 readiness — 2026-09-27

This records local implementation and validation, not npm publication or fleet
deployment. Unrelated Android/backend/web changes in the shared checkout were
preserved. The installed worker and production catalog were not changed.

## Implemented

- Clean builds, automatic prepack, exact package inventory validation, credential
  pattern checks, isolated packed-consumer smoke and dependency audit.
- Public npm metadata and `next` release-candidate tag; source prepublish gates.
- CLI/runtime version reporting, installation/update documentation and changelog.
- Durable config restoration for two-worker updates and interruption recovery.
  Candidates run one worker per GPU until requalified; expired capacity evidence
  does not block maintenance authentication. Runtime admission still enforces it.
- Stopped-service configuration validation and preservation of stopped/paused intent.
- Legacy-compatible rollback journal before older binaries restart; failed restart
  retains retryable intent. This is not post-activation crash-loop rollback.
- Mandatory worker/Node license notices in the macOS runtime package.
- Read-only signed-candidate consistency gate and a CI verification workflow with
  pinned actions and no publishing permissions or production secrets.

## Local evidence

- `pnpm run verify`, using the installed qualified Python via `MUSICMUTE_PYTHON`:
  protocol, formatting, lint, typecheck and build passed; 419 TypeScript tests
  passed and 2 were skipped; 74 Python tests ran with 1 skipped; 7 package-policy
  tests passed. After the final maintenance reader changes, 72 focused CLI,
  updater and runtime-safety tests passed, followed by typecheck, lint and build.
- The lockfile formatting change preserves its parsed content exactly. No dependency
  versions were changed by that formatting repair.
- A fresh temporary source directory, with no `dist/`, installed dependencies
  offline using the frozen lockfile. Plain `npm pack` built the executable through
  prepack and included 246 expected files with no deleted legacy service modules.
- Packed-consumer installation/help/version and its production npm audit passed.
- Four isolated native LaunchAgent interruption tests exercise termination before
  and after activation for one- and two-worker configurations. Their temporary
  service labels are distinct from the installed worker and are cleaned up.
- A native ARM64 runtime archive was built using the existing private dependency
  runtime, without source-map upload. Archive extraction preserved its verified
  20,109-entry inventory and the packaged CLI ran using its private Node.
- The frozen Python lock's 65 packages and the actual private runtime's 66 packages
  were separately audited with pip-audit: no reported vulnerabilities or skipped
  packages. The extra installed package is `onnx2pytorch`; this audit is not an
  FFmpeg/native-code vulnerability certification or license approval.

Final artifacts are retained outside the checkout. Historical/intermediate
artifacts must not be substituted for the final tested candidate. Artifact
hashes and consumer evidence accompany the retained tarballs.

Final candidate directory:
`/Users/hatemragap/.codex/tmp/musicmute-worker-rc1-final-bel3t6a9`.

- npm archive SHA-256:
  `9055430c76abb58f53b5f046732fa073b1798d22ce6990dcf03d7ad360377464`
- Native archive SHA-256:
  `b38cc573c8c4c6ebde65f53ac640764f750a0cee849d15afab51742d8fc9fe6e`

## Still required before a production claim

- Review the final uncommitted changes and select an immutable release commit.
- Qualify the exact final archive on a clean dedicated Mac, including GPU/output
  quality, login/logout/reboot, install/reinstall and the live backend/S3 failure
  scenarios in RELEASING.md. Local fixtures and archive smoke do not replace this.
- Complete final native dependency/notices and supported hardware/OS acceptance.
  Processing under a personal macOS account remains unsandboxed; use dedicated
  hardware or a separately qualified isolation design for public inputs.
- Sign the final runtime metadata using the approved external key and run the
  signed candidate gate. Promote the catalog only with deployment authorization
  and verify read-back; do not downgrade a newer healthy local installation.
- Restore npm authentication: the read-only registry identity check returned
  `E401` in this session. Verify npm scope ownership/publishing permissions.
  Publish the tested candidate
  only when authorized, then independently verify registry bytes and a fresh
  registry install before stable promotion. The GitHub workflow itself has not
  been executed remotely in this local session.

No npm publication, signing-key access, production update, slot/policy change,
mobile device/UI test, or real user-data deletion was performed.
