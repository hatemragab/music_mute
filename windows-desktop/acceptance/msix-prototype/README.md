# S03 isolated MSIX prototype

This is a disposable x64 native fixture, not MusicMute, a consumer runtime or a
Store-signed release. It never opens Library/account/model files, enrolls a worker,
changes the production extension, buys signing, submits or publishes anything.
Its HELLO response always reports `ready:false` and `qa_only:true`.

## Portable staging and code checks

From `windows-desktop`, use Node 24.18. An invocation without arguments only prints
the plan usage. `plan` creates a new exclusive directory and copies seven frozen
native inputs, a bounded generated configuration header, AppxManifest and real PNG
assets. Existing directories/artifacts are not replaced.

```text
node scripts/msix-prototype.mjs plan <new-absolute-canonical-directory>
npx vitest run tests/msix-prototype.test.ts --maxWorkers 1
npx esbuild acceptance/msix-prototype/native-build.ts --bundle --platform=node --format=cjs --target=node24 --outfile=<external-build-runner.cjs>
```

An explicit `plan-unvirtualized` command stages the separate namespace candidate.
It never changes the default classic profile or executes a tool. Use two fresh
plan directories and different automatically generated QA identities with one
compact UUIDv4 data cohort:

```text
node scripts/msix-prototype.mjs plan-unvirtualized <new-gui-plan-directory> <cohort-UUIDv4-compact> gui
node scripts/msix-prototype.mjs plan-unvirtualized <new-worker-plan-directory> <cohort-UUIDv4-compact> worker
```

The closed `unvirtualized-candidate-v1` profile declares `win32App`/`mediumIL`,
`runFullTrust`, `unvirtualizedResources`, and the desktop6 registry and filesystem
write virtualization properties set to `disabled`. It uses no external package
location, mutable package directory, environment-provided path or product data.
Its two different package names share the same QA publisher and fixed data-cohort
identifier. `EntryPoint` is omitted: Microsoft's
[Application schema](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-f-application#combinations-of-activation-info-attributes)
lists `win32App`/`mediumIL` as an allowed activation combination and warns against
contradictory redundant activation attributes.

Microsoft documents the old desktop6 properties for Windows10 build18362 and
later, and explains that disabled virtualization permits shared writes to survive
uninstall in its [flexible virtualization guide](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization).
That documentation is not physical Windows10 evidence or Microsoft Store approval
of this restricted capability. The candidate's observation explicitly reports
`store_capability_approval_proven:false` and `production_data_parity_proven:false`.

After the same guarded build, archive audit and explicit isolated unsigned
deployment, run only the fixed operations below as the limited console user. No
operation accepts a path, command, file content or product setting:

```text
GUI package MusicMuteMsixProbe.exe --shared-create
Worker package MusicMuteMsixProbe.exe --shared-observe
Worker package MusicMuteMsixProbe.exe --shared-add-worker
GUI package MusicMuteMsixProbe.exe --shared-add-gui-v2
```

These use `%LOCALAPPDATA%\MusicMuteMsixQA-<cohort>-shared`, outside `Packages`,
and create only four fixed QA text files. The probe holds every canonical
non-reparse ancestor without delete sharing, requires current-user ownership,
checks exact protected user/System-only DACLs, and uses exclusive file creation
and single-link final-handle checks. A redirected or conflicting root fails
closed. Existing files must match the compiled cohort and exact bounded QA bytes;
the GUI's original bytes stay unchanged when the worker adds its own marker.
The device run must independently read the actual files outside package context,
then remove the GUI package and prove the remaining worker sees the same hashes,
then remove the worker and prove ordinary-process retention. Exact nonce cleanup
follows those readbacks; product roots are outside the fixture's scope.
Native observations also record the actual `GetApplicationUserModelId` result,
including an absent application identity when returned by Windows, together with
the shared directory's volume serial, file ID, creation FILETIME, owner SID and
final path casing. These are physical readbacks, not inferred from the manifest.

### Recorded Windows 11 observations — 2026-10-12

The Z440's Windows 11 x64 build26200 physically built, audited and installed two
different unsigned QA packages using this candidate. Both processes reported
their actual package and application identities while running as the standard
logged-in user. The GUI created the private shared directory exclusively; the
worker adopted that same directory, read the original GUI bytes and added its
own file. A subsequent GUI write preserved both earlier files. Duplicate GUI
creation and creation by the worker were rejected. An independent unpackaged
observer matched the directory's volume/file ID/creation time, final path casing,
owner/protected DACL and all four files' IDs and hashes.

After GUI removal, the remaining packaged worker and the ordinary observer read
the same original data. After worker removal, an ordinary standard-user observer
again proved all four files and the unchanged directory birth identity survived.
All ten native runtime invocations recorded root exit, both pipe EOFs and actual
whole-Job-zero. Both packages/aliases were then read back absent. Cleanup deleted
only the four fully proved static QA files by held handles and the empty QA root,
without recursive deletion. Twelve exact cohort tasks were checked stopped,
their definitions preserved, then retired and read back absent. Raw evidence and
its pins remain in the orchestrator's external acceptance artifacts.

The optional read-only `KF_FLAG_RETURN_FILTER_REDIRECTION_TARGET` query returned
`0x80070002` before any data creation. That failed observation is preserved
separately; it is not treated as a passing namespace query. The independent fixed
shared-data operations above used `KF_FLAG_NO_PACKAGE_REDIRECTION` and retained
all containment guards. One initial GUI protocol CTest also timed out. A guarded
verbose diagnostic and the unchanged primary CTest subsequently passed with the
original timeout; the initial failure and actual Job-zero receipt remain
preserved, and its timing cause is unestablished.

These results establish this disposable candidate's Windows 11 filesystem
namespace and removal-retention feasibility only. The candidate's Chrome registry
namespace, update-generation rebinding, disabled aliases, Windows10 build19045,
restricted-capability Store approval, genuine Store signatures, consumer data,
accounts, startup lifecycle and GPU processing still require their own acceptance.
The earlier classic-profile Chrome handshake evidence does not prove these
candidate-specific gates.

The portable tests execute the actual shared C++ parser/frame implementation with
Clang, including Unicode, malformed JSON/UUID, duplicate names, unknown operations,
frame size limits and Store-origin policy negatives. The fixture reuses
`worker/native/windows-consumer/json.hpp`; it does not maintain a second JSON parser.
The private STDIO grammar follows portable security/JSON/compatibility principles
from the [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/),
read on 2026-10-12. REST URL, OAuth, HTTP and OpenAPI requirements do not apply to
this isolated binary STDIO protocol; production contracts remain unchanged.

## Guarded native build and package

On the authorized Windows x64 target, run `runPrototypeNativeBuild` exported from
the generated external CJS bundle. Its only input fields are:

```json
{
  "planRoot": "<absolute-existing-plan-directory>",
  "toolsFile": "<absolute-approved-tools-v3.json>",
  "expectedPlanSha256": "<actual-plan.json-sha256>",
  "expectedToolsSha256": "<actual-approved-tools-json-sha256>"
}
```

The root orchestrator supplies these exact values and freezes its runner/source
hashes before execution. Run the runner as the standard logged-in console user
inside the existing authorized QA task/guardian. The runner recreates the native
guard's fixed source geometry only under `<planRoot>/repository/worker/native/windows-consumer`.
The build directory is fixed to `<planRoot>/MusicMuteAcceptance-<UUIDv4>/native-build`,
using the QA ID formatted as a UUIDv4. Closed plan/build-receipt validation checks
this grammar before dispatch; other UUID versions and variants are rejected.
It calls the existing `runGuardedNativeTool` for configure, compile and CTest; it
does not call raw CMake/CTest or depend on production-native describe/output-count
assertions. Each delivered step requires the original guard's actual whole-Job-zero
certificate. An undelivered or failed step is not cleanup evidence.

CMake's ALL target builds two `asInvoker` fixture executables and the protocol
test, then copies the executables into the isolated payload and invokes this
fixed, pinned tool inside the same guarded compile Job:

```text
C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\MakeAppx.exe
bytes: 584024
SHA-256: 00fff202b71c1266b8c3899701e42b5468ea153b2b33a0a47215fe27695f16d0
```

Root read back that SDK tool on Z440 on 2026-10-12: FileVersion10.0.26100.7705,
AuthenticodeValid/MicrosoftCorporation. A different tool fails before the build;
there is no SDK download or PATH fallback. `native-build-receipt.json` binds
plan/tools hashes, delivered guard results, logs, all three binaries and package.
Build failures preserve their partial receipt and artifacts.

After native success, run these source tools on the same plan directory:

```text
node scripts/msix-prototype.mjs layout <planRoot>
node scripts/msix-prototype.mjs record-package <planRoot>
```

`layout` checks the native build receipt, x64 PE headers, compiled QA identity and
byte-equal payload. `record-package` decompresses and compares all seven expected
payload files, rejects extra/signature/encrypted/duplicate/escaping entries, and
requires the MakeAppx block map/content-types parts. These checks establish the
exact unsigned fixture bytes, not Store origin or production trust.

## Explicit unsigned QA deployment

[Microsoft documents](https://learn.microsoft.com/en-us/windows/msix/package/unsigned-package)
unsigned package deployment on Windows 11 with a special Publisher OID and
`Add-AppxPackage -AllowUnsigned`. Executable unsigned installation requires elevated
PowerShell and has **all-user scope**. It needs no self-signing certificate,
certificate trust-store import or Developer Mode change. A different unsigned
identity cannot impersonate the reserved signed product identity. This route does
not establish unsigned installation support on Windows10 build19045.

The script below is generated only with the explicit acknowledgement. Generation
does not deploy; root separately inspects/runs the saved PowerShell file under the
authorized test scope.

```text
node scripts/msix-prototype.mjs deployment-script <planRoot> --acknowledge-all-users-unsigned-qa
```

The saved `deploy-unsigned-qa.ps1` requires Windows11/elevation/AllowUnsigned, binds
the MSIX hash, rejects an existing package with the QA name, and records before
and after package/user identity receipts. It changes no policies, trust stores or
browser profiles and never performs automatic removal. Package runtime tests must
subsequently run as the limited console user; elevated deployment is not runtime
acceptance. Root owns exact artifact/task/process/registration cleanup and must
not delete real application data or unrelated packages.

Every newly emitted receipt uses exclusive creation; successful readbacks are
pinned before subsequent consumers. A failed earlier receipt must never be
rewritten by a retry.

## Native namespace/activation operations

The executable requires actual unsigned QA package identity, matching compiled
Name/Publisher, native x64, a non-admin nonzero-session token, its exact registered
package image path and a held immutable package-file handle. It reports package
root/family/generation/SignatureKind, SID/session, OS build, image hash/file ID and
legitimate package hardlink count. A copied raw executable fails. SignatureKind
None is always denied by the production Store-origin policy; the fixture is a
separate target, never a production acceptance override.

Launch `MusicMuteMsixProbe.exe` **with actual package context** and exactly one of:

```text
--observe
--namespace-observe
--system-reg-trust-observe
--register-package-manifest
--register-direct
--register-system
--register-system-breakaway
```

The three registration operations use separate fixed per-plan hostname suffixes,
so their namespace observations do not shadow one another. Each writes two
isolated native messaging manifests: exact registered package executable versus
the package-declared stable execution alias. The allowed origin is the fixed
QA fixture origin `chrome-extension://npkabaieihgikeiahjojlkjjakajjnpa/`.
The real shared extension source, key, ID and profile are untouched.

`--namespace-observe` reads the two shell-known LocalAppData candidates and checks
their physical ancestors without creating a directory or writing a registry key.
Failures report a fixed phase, requested and actual opened path/attributes, and
owner SID observations on stderr. The observed last Win32 error is recorded as an
observation, not inferred to be the failure's cause. Native host stdout remains
framed protocol output only.

`--register-package-manifest` separately tests Chrome registration without a
mutable LocalAppData workspace. It holds the immutable packaged
`NativeMessagingHost.json`, verifies its compiled byte hash, holds the package
host image and registers only the fixed `.immutable` QA hostname through the same
bounded signed-System32 broker. Chrome documents a Windows native host path
[relative to the manifest directory](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host),
so the packaged manifest names `MusicMuteMsixChromeHost.exe`. This is a separate
interop observation and cannot turn a failed data containment probe into success.

`direct` uses Win32 HKCU writes from the package. `system` and `breakaway` invoke
only held, hash-recorded, Microsoft-verified System32 `reg.exe` with fixed ADD
arguments, the isolated QA key/manifest, no `/f`, no shell, filtered environment,
explicit inherited handles, suspended child identity/SID/session checks, a
kill-on-close Job, 10s deadline, 16KiB output bound and actual Job-zero. `breakaway`
additionally requests `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY` at child creation;
it is not Job Object breakaway. Child package identity is observed before resume.
System32 `reg.exe` is bound to the actual Z440 image SHA-256
`ef37663b44ac66920c6f33694deea01acb78ae3f3012884819373fa04c3eb5f0`.
Both embedded and catalog trust use Windows signature policy and the actual
Microsoft Windows signer chain, Code Signing and Windows System Component
Verification EKUs. Catalog verification uses a SHA-256 membership hash from the
held image with the current strong-signature policy, one bounded lookup, the held
OS-protected System32 CatRoot catalog and WinVerifyTrust's catalog/member policy.
File birth/hash/ACL observations are rechecked before launch and after Job-zero.
The fixture accepts no arbitrary catalog, unsigned executable or shell. A Windows
update changing the frozen system image needs a reviewed new QA source cohort.
`--system-reg-trust-observe` exercises this same trust authority read-only.
The implementation follows Microsoft's
[catalog context](https://learn.microsoft.com/en-us/windows/win32/api/mscat/nf-mscat-cryptcatadminacquirecontext2),
[held-file hash](https://learn.microsoft.com/en-us/windows/win32/api/mscat/nf-mscat-cryptcatadmincalchashfromfilehandle2),
[catalog lookup](https://learn.microsoft.com/en-us/windows/win32/api/mscat/nf-mscat-cryptcatadminenumcatalogfromhash)
and [catalog membership trust](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_catalog_info)
APIs, reviewed on 2026-10-12.

Manifests live only under the observed, exclusively created QA directory with
owner-SID ACLs and held single-link nonreparse files. The fixture holds every
physical ancestor of both shell-known LocalAppData namespace candidates without
delete sharing, then holds its new per-QA/per-mode root through registration.
It preserves existing paths rather than adopting an existing QA directory.
Reports expose the requested and final opened paths, both registry
views as observed by the package, tool exit/package identity and bounded output
counts. They always say `ordinary_chrome_visibility_proven:false`: root must
independently query the same values from an ordinary process and actually exercise
Chrome before claiming interoperability. Shared HKCU registry views can result in
the second owned-view write being skipped; this is recorded rather than mistaken
for an independent second registry hive.

The host accepts only the fixed fixture origin and optional bounded decimal
`--parent-window`. It exchanges up to32 frames, each a four-byte little-endian
length followed by strict UTF8 JSON, with the existing four envelope fields:

```json
{"protocol_version":1,"request_id":"00000000-0000-0000-0000-000000000001","type":"HELLO","payload":{}}
{"protocol_version":1,"request_id":"00000000-0000-0000-0000-000000000001","type":"ECHO","payload":{"text":"مرحبا 🎵"}}
```

There are no processing, file, URL, script or command operations. Root can compare
fixed-path/alias framing using a controlled parent and then an explicitly isolated
Chrome test profile. No profile is created or edited by this prototype. Alias
disablement, frame truncation, wrong origin/arguments, current package generation,
ordinary Chrome startup before UI, actual update/uninstall and real signed Store
origin remain physical acceptance gates.

The Chrome-host HELLO observation also records the actual inherited STDIN/STDOUT
file types and flags, both named-pipe server/client PID API success or Win32
error, and read-only held-process image, SID, session, creation time and liveness
observations for any returned PID. The fixture never substitutes a parent PID or
claims that these calls identify Chrome. Compare them with the real isolated
Chrome launch/profile readback; a controlled STDIO harness identifies its own
controller instead. This is an explicit physical feasibility experiment for the
production Chrome peer policy. Its response remains QA-only, unsigned, not ready
and denied by production Store-origin policy.

On 2026-10-12 the Z440 (Windows 11 build 26200 x64, standard console session 1)
ran this observation with Google Chrome 154.0.8037.99, a fresh exclusive QA profile,
the real **Load unpacked** UI and the immutable packaged manifest. HELLO and the
Arabic/emoji ECHO succeeded in 223ms; this is handshake time, not song processing
time. Both inherited-handle server queries identified the actual launched Chrome
PID, held image, creation time, SID and session. Both client queries identified
the signed System32 `cmd.exe` launcher instead. The controlled non-Chrome case
identified its PowerShell controller, so a successful PID API alone admits no
browser rights.

The three controlled native cases and the real Chrome Job recorded actual root
exit, complete STDIO EOF and whole-Job process count 0. The disposable unsigned
package, alias, exact QA host in both ordinary registry views, four exclusive
runtime/profile trees and seven stopped nonce-bound tasks were removed and their
absence independently read back. The first runtime script failed on PowerShell's
reserved `Host` variable before native cases; its source and failure receipts
remain preserved beside the successful fresh attempt. The external 201-file
evidence archive has SHA-256
`7de0e79adbaaad83b0cb48e83d48a51b6aac03d9ca9d1dddd4049f177986f8d2`.
This proves the tested Windows 11/Chrome inherited-pipe observation only. Genuine
Store origin 3, Windows 10 22H2, capability approval and full production account,
servicing, startup and GPU acceptance remain separate gates.

## Real Chrome QA fixture

`plan` also writes four frozen files under `<planRoot>/ChromeQA`, separate from the
MSIX payload. Its `manifest.json` contains only a dedicated public RSA SPKI key,
whose SHA-256 ID is `npkabaieihgikeiahjojlkjjakajjnpa`, and the `nativeMessaging`
permission. No private key is saved or used to sign anything. The generated popup
contains exactly seven native host names for this plan (direct/system/breakaway,
fixed/alias, and the immutable packaged manifest), sends HELLO and a fixed Arabic/emoji ECHO, validates unsigned QA
package identity and response correlation, and disconnects after two responses or
a 10s deadline. It has no account/media/backend/site access or Chrome storage.
The plan records every fixture file's byte length and SHA-256; source layout
validation rechecks those pins and byte-equal generated code. Portable VM tests
execute the real popup code with synthetic ports; they do not establish Chrome or
MSIX acceptance.

Root owns the authorized disposable Chrome profile and real UI run. Use the
installed Google Chrome as the standard console user. Open a new exclusive QA
profile using a pinned Chrome executable and `--user-data-dir=<newQAProfile>`,
`--no-first-run` and `--no-default-browser-check`. Do not sign in or import browser
data. Keep the exact profile path/Chrome image PID in the root acceptance receipt;
the prototype itself creates or edits no profile.

In that QA profile only, open `chrome://extensions`, enable its extension Developer
mode, click **Load unpacked**, and choose the frozen `<planRoot>/ChromeQA` directory.
This is Chrome's extension development switch, not Windows Developer Mode. Verify
that Chrome displays the exact ID above and grants only native messaging. This
follows Chrome's official [Load unpacked procedure](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
and [manifest-key ID behavior](https://developer.chrome.com/docs/extensions/reference/manifest/key).
Branded Chrome [removed command-line extension loading in Chrome137](https://developer.chrome.com/blog/extension-news-june-2025),
so this procedure does not assume `--load-extension` works.

Open the fixture action popup (or its `chrome-extension://npkabaieihgikeiahjojlkjjakajjnpa/popup.html`
page), choose the registered QA host and click **Test HELLO and Unicode ECHO**.
Record the actual visible JSON result, Chrome version/profile/image, ordinary
registry observation, native package root/generation/SignatureKind and whether the
path or alias was used. Only an actual `success:true` result from this Chrome UI
establishes native messaging for that tested mode and package generation. A direct
STDIO harness, VM test, extension load or registry entry alone is insufficient.
Root separately cleans up only its admitted QA package/profile/hostnames; existing
personal profiles and the shared production extension remain untouched.
