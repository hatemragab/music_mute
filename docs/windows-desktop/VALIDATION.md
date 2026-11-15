# Validation strategy

The user explicitly chose **all implementation first, Windows machine testing
after connecting the machine**. During implementation run code checks only.
Writing native tests and release tooling now is required; running them later
must not be confused with their existence.

## Phase A: code checks on the development Mac

Allowed: formatting, lint, type checks, compilation supported by the installed
toolchain, unit tests, headless component tests without launching an app/browser,
protocol fixtures, signed-manifest/package fixtures, temporary-filesystem fault
tests and isolated backend tests using disposable local dependencies.

Use injected Windows adapters to exercise Windows policy and command generation
on the Mac. Test both success and denial paths. Mark the native invocation layer
unverified until Phase B. Do not run tests that mutate the installed Mac app,
worker, credentials, model, Chrome profile or launchd state. Do not run browser,
Electron, simulator, device, real OAuth/R2 or live fleet tests in Phase A.

Inspect scripts before execution: names such as `verify`, `test:engine` or
`test:packaging` can include host-specific operations. Select safe suites and
record exclusions. A skipped native check remains pending, even if the runner
reports an overall success. Native helper compile/link checks unavailable on
macOS are listed individually for W34; never replace a native binary with a stub.

## Existing command registry

Commands below were read from manifests, **not run as application validation for
this documentation task**. Execute from the named component and use its lockfile.
Re-read the manifest before running. Do not reformat unrelated dirty files.

| Component                       | Code commands, subject to script inspection                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chrome-extension/`             | `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run format:check`; pure native source/unit checks only where they have no installed-app side effects.                                                                                                                 |
| `worker/`                       | `pnpm run protocol:check`, `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `pnpm run test:packaging`, `pnpm run build`, `pnpm run format:check`. Inspect `test:engine` and run only code-only subsets; no real GPU inference on the Mac for Windows evidence.                            |
| `backend/`                      | `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `pnpm run test:secrets`, `pnpm run test:transfer-benchmark`, `pnpm run build`, `pnpm run format:check`; isolated HTTP/integration tests only with disposable dependencies and no production configuration.                               |
| `dashboard/`                    | `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run format:check`; browser E2E deferred.                                                                                                                                                                              |
| `web-client/`, only if affected | `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:server`, `npm run format:check`; browser E2E deferred.                                                                                                                                                       |
| `windows-desktop/`              | `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:contracts`, `npm run test:package-fixtures`, `npm run build`, `npm run format:check`. These source/headless scripts exist; inspect their current definitions before execution. Native build/test scripts remain Windows-only. |

Run a task's focused regressions first, then required affected-component checks.
Broaden only for actual shared changes or unresolved failures. Keep the full
output local and record concise results, test counts/skips, versions and command
exit codes. Never claim that generating an EXE on another OS proves it launches.

## Phase B: connected Windows machine

Execute W34 after W01–W33 implementation. Record the actual machine/OS build,
native architecture, GPU/driver, app/runtime/model versions and artifact hashes.
A Windows 11 machine cannot close Windows 10 acceptance, and one GPU cannot
close NVIDIA/AMD/Intel coverage. Do not create VMs, use additional machines or
install drivers/toolchains without the relevant user authorization.

| Matrix group              | Required acceptance                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS/installation           | Standard non-admin user, Windows 10 22H2 and selected Windows 11 x64 versions; clean profile without developer tools; unsupported architecture/older OS refusal; no UAC requirement.                              |
| Native security           | Real current-SID ACLs, DPAPI, pipe peer identity/remote rejection, process creation identity, Job Objects, registry views and safe path handling.                                                                 |
| GPU                       | Actual inference placement and output; eligible NVIDIA/AMD/Intel examples as available; multi-GPU ordinal changes, software/unsupported device refusal, driver/device loss, memory pressure and no CPU fallback.  |
| Prepare                   | Fresh network runtime/model download from approved real URLs, resume, cancel, low disk, corrupt artifact, signature mismatch, crash recovery, repair, no false Ready, archive cleanup.                            |
| Personal media            | Audio and macOS-supported video formats, large/unicode paths, cancel/retry, source identity, original/voice timing, listening quality, seeking/rate, gap/repeat/silence behavior.                                 |
| Account/Library           | Real Google/email flows, session restore, offline local use, owner switching, device/logout/delete/recovery, quota/policy, private downloads, realtime reconnect and durable sync.                                |
| Chrome                    | The same extension on real Chrome; registration/repair/reinstall, UI closed, SPA changes, background/reload recovery, duration gates, origin/capability boundaries and synchronization.                           |
| Worker                    | Google/admin eligibility, local Stop/Pause/Drain/Resume, backend permission changes, accepted work handover, app close/sign-out independence, lock, sleep/resume, logout/login and no orphan processes.           |
| Update/removal            | App/runtime/model transitions with active consumers; signed downloaded installer, rollback, preserved library/outboxes/credentials, standard uninstall, separately approved purge and legacy-service coexistence. |
| Accessibility/performance | English/Arabic RTL, keyboard/screen reader/high contrast/DPI, GPU/resource/startup measurements, extended playback/work and long-run bounded disk/log behavior.                                                   |

Build the full harness during W33. Use synthetic/rightfully available media and
designated test accounts. Real fleet enrollment, production claims, account
deletion, purge and publication are separate external actions requiring the
user's relevant instruction; preparing the harness does not authorize them.

## Release gates

1. Code checks and required native build/link/package checks pass.
2. Required OS/GPU/features have actual recorded acceptance or an explicitly
   narrowed, user-approved release support claim.
3. Installer/PE signing and manifest trust, fresh Prepare URLs, license notices,
   rollback and uninstall are verified for the release candidate.
4. Backend/configuration prerequisites are deployed only through an authorized
   release, and live success is recorded separately from local fixtures.
5. The user authorizes publication. Upload readback, hash and actual download
   checks then establish distribution proof; documentation never substitutes.
