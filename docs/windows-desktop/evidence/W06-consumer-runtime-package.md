# Evidence: W06 — consumer package and acquisition bootstrap foundation

- Date: 2026-10-09.
- Status: source and code checks complete for packaging/bootstrap foundation; W06 remains in-progress while root integrates Prepare, downloads and activation.
- Host scope: macOS source/code fixtures. No model/runtime downloaded, native Windows process executed, installed runtime changed or artifact published.

## Implemented source

- `worker/src/platform/windows/consumer-package.ts` builds an immutable **windows-user** runtime from mandatory prepared private Node/Python/media, native helper, compiled agents, downloader and Windows YouTube roots. It never substitutes a missing native input. Native default probes require Node 24.18.0, relocatable Python 3.12.10, exact complete DirectML dependency lock, DirectML provider availability, FFmpeg/FFprobe 8.0.3 and Deno 2.9.7. It probes the relocated payload as well as the input roots.
- Assembly copies one shared worker engine/runtime, all acquisition tools and session/fleet/personal/prepare roles; excludes service payloads, model weights, credentials and source maps. Every executable/DLL/PYD/native Node module is audited for x64 PE metadata. Links, reparse entries, hard links, ADS/device/reserved names and Windows case aliases fail closed.
- Downloader verification checks the fixed bootstrap and actual wheel bytes. Windows YouTube verification checks exact target/version, owned provider script pins and complete inventory. The lower-level inventory primitive has synthetic byte-integrity tests; injected native/tool fixtures do not establish actual dependency execution.
- `worker/scripts/build-windows-consumer-runtime.ps1` is a build-time recipe requiring real prepared roots, compiled native helper and agent input, pinned offline pnpm and an external Ed25519 key. It never configures a machine service or mirrors a model. It does not install anything into the user's active app/worker.
- `worker/src/platform/shared/update-metadata.ts` adds optional **installationProfile: windows-user** to the signature material. Consumer verification requires the explicit expected profile; legacy callers cannot adopt consumer metadata. Sequence, expiry, key trust and artifact byte/hash checks remain intact. Backend agent owns catalog/server schema integration.
- Consumer ZIP creation is native-Windows-only and verifies the consumer inventory. Signed metadata binds platform/profile, release version, sequence, validity and ZIP filename/bytes/SHA-256. The ZIP contains its profile-aware inventory, so its digest also binds that inventory. The signer requires an externally supplied Ed25519 private key; no production key was accessed or created.

## Shared bootstrap Windows port

`chrome-extension/engine/downloader_bootstrap.py` retains the POSIX path and adds a sealed, narrow ctypes Win32 adapter:

- Get the actual TokenUser SID, read owner/DACL from a real handle and require current-user ownership with allow ACEs restricted to that SID and SYSTEM. Reject service identities, null/incomplete/unsupported ACLs, foreign allow principals, hard links and reparse points.
- Use CreateFileW with OPEN_REPARSE_POINT and no write/delete sharing. Check and hold ancestor directory handles while reading, convert the same native handle to a binary Python descriptor, and release its parent pins on both success and failure.
- Create fresh guest directories with protected current-user/SYSTEM DACLs. Use native WindowsDirectory for SystemRoot/WINDIR; route HOME/USERPROFILE/TEMP/TMP/APPDATA/LOCALAPPDATA into the disposable guest tree. Remove inherited account data and restore the parent environment after work.
- Use `deno.exe` on Windows. Reject inherited POSIX update-lease descriptors on Windows; native owned-process/broker lifetime and update leases are root's integration responsibility.
- The Windows config uses the verified private runtime `tools/downloader/downloader_bootstrap.py`, avoiding public installed-app inheritance. No arbitrary new sibling module import was introduced.

Bootstrap SHA-256 is `2f510f42390050de123e257a8ae85a00266409e02a8142490c3a1b04a9dda6a2`, 38,836 bytes. Companion and consumer package pins match. The bounded bootstrap cap is 64 KiB. Existing setup/package scripts already derive their inventory hash from current source; historical installed runtime identities have not been changed.

## Code validation

| Command                                                                                                                                              | Result                                                        | What it establishes                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Worker Vitest: runtime-adapter, Windows release manifest, enrollment report/client, consumer package, Mac signed metadata and Windows updater suites | 58 tests passed                                               | Portable contract, inventory/PE/signature and injected-native fixtures                                                             |
| Worker `tsc --noEmit`                                                                                                                                | Passed                                                        | Current worker source/types                                                                                                        |
| Scoped worker oxlint and Prettier                                                                                                                    | Passed                                                        | Touched TS/script source                                                                                                           |
| Companion Vitest `tests/downloader-bundle.test.ts`                                                                                                   | 8 tests passed                                                | Bootstrap hash cohort and Mac bundle policy fixtures                                                                               |
| Python `unittest discover -s chrome-extension/tests -p test_downloader_bootstrap.py` with `-B`                                                       | 28 cases: 15 passed, 13 existing prepared-wheel cases skipped | All 3 new Windows policy/environment/descriptor fixtures passed; existing wheel/EJS/import tests lack required pre-prepared assets |
| `node --test scripts/windows-consumer-runtime-recipe.test.mjs`                                                                                       | 2 passed                                                      | Native-input/offline/key requirements and no service/model/bypass source recipe                                                    |
| Scoped `git diff --check`                                                                                                                            | Passed                                                        | Whitespace for touched source                                                                                                      |

The 13 prepared-wheel cases remain explicitly unrun; no wheel download or broad test substitution was used. New Windows WinAPI execution is **not** proven by injected fixtures.

## Fresh transfer source checkpoint — 2026-10-09

The Windows Prepare source now reads an optional sealed
`runtime/runtime-source.json` bound to verified signed consumer metadata and
target identity. Its explicit public HTTPS URL, filename, bytes, SHA and unpacked
size are validated; no Windows release URL is invented or fetched from the ZIP.
The W31 package must provide a genuine descriptor and include it in trusted app
resources. Existing packaged ZIP fixtures remain compatible.

New `artifact-transfer.ts`, `runtime-source.ts` and `private-transfer.ts` implement
bounded credential-free streaming, strong-ETag/range resume, prefix rehashing,
private descriptor/identity checks and complete checksum verification before
publication. DPAPI keys `prepare_runtime_transfer` and `prepare_model_transfer`
hold only bound checkpoints, never redirected/signed URLs. Runtime partial/final
archives live under private `prepare/downloads`; the exact shared model pin stays
upstream-only. Expired exact-active metadata cannot authorize a new runtime
download. Operations now uses these paths and removes only the private completed
archive after durable activation.

Checks actually run from `windows-desktop`:

- `npx vitest run tests/artifact-transfer.test.ts tests/runtime-source.test.ts tests/private-transfer.test.ts tests/runtime-bundle-source.test.ts tests/model-download.test.ts tests/prepare-records.test.ts tests/prepare-controller.test.ts tests/readiness-cache.test.ts tests/verified-archive.test.ts`: **99 passed / nine files**.
- `npx tsc --noEmit`: passed on the shared tree at this checkpoint.
- Scoped `npx oxlint --deny-warnings`: zero warnings/errors across nine transfer/operations/test files.
- Scoped Prettier check and `npm run build`: passed.

These are temporary byte/archive fixtures, injected HTTP/native ports and a
synthetic module model pin in one private-publication fixture. They prove no real
runtime/model download, native ACL, Windows installation, GPU or live release.
Writer-journal/admission cleanup integration continues in W22; W06 remains open
for complete dependency/license/packaging closure and its deferred native gates.

## Native and integration follow-up

- W06/W08/W22 finish lease-aware recovery/cleanup and W31 supplies actual package resources. Fresh transfer source is recorded above; complete task closure still requires its remaining source and machine gates.
- Assemble real prepared Windows inputs with this recipe. Check source/license closure and actual relocated DLL/FFI/provider loading, including clean caches. The native helper and compiled agents are mandatory input artifacts; no placeholder executable can become a fresh-user release.
- Verify real Win32 ACLs, Azure AD/local/domain users, ancestor junction races, long paths, hard links, replacement sharing and guest cleanup on Windows 10 22H2 x64 and Windows 11 x64.
- Verify immutable ZIP/signed metadata read-back before any separately authorized publication. Current code fixtures are not signing/notarization/installation/GPU or fresh-network release proof.

## Official sources checked

Existing tool versions come from the repository's accepted locks. Windows archive checksum metadata was read from [Node 24.18.0 checksums](https://nodejs.org/dist/v24.18.0/SHASUMS256.txt), [Deno 2.9.7 official release metadata](https://api.github.com/repos/denoland/deno/releases/tags/v2.9.7) and [node-canvas 3.2.3 official release metadata](https://api.github.com/repos/Automattic/node-canvas/releases/tags/v3.2.3). Runtime archives were not downloaded in this turn.

Win32 behavior was checked against [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo) and [security descriptor string format](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptor-string-format). The optional signed profile follows the current [Zalando API guidelines](https://opensource.zalando.com/restful-api-guidelines/) compatibility/security requirements; signature subtrees retain the existing exact camelCase material by contract while the outer REST wire converter uses snake_case.
