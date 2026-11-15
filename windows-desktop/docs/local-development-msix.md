# Local development MSIX testing

Current local acceptance: revision four is built, audited, locally signed and
installed with healthy exact Developer registration. Its primary EXE opened the
real Home window and the Worker buttons now fit, but the GUI later lost its
account helper and began closing. The Worker startup API returned `E_INVALIDARG`.
Fresh GPU preparation and sustained operation have not passed. The installed
pair is not yet ready for processing acceptance.

The owner authorized free local test signing on the Z440 on 15 October 2026 so
both applications can be tested before Microsoft review. This is a separate
development build, not a Store signature, capability approval or public release.
Production still defaults to the exact Store identities and Store signature kind 3. No runtime flag, environment variable or user configuration can enable the
development authority inside a production bundle.

## Development boundary

| Item                       | Local test value                            |
| -------------------------- | ------------------------------------------- |
| GUI identity               | `MusicMute.Development_kthggmwhkdz4t`       |
| Worker identity            | `MusicMute.WorkerDevelopment_kthggmwhkdz4t` |
| Publisher                  | `CN=MusicMute Z440 Development`             |
| Required OS signature kind | Developer (`1`), never unsigned or Store    |
| Personal data              | `%LOCALAPPDATA%\MusicMuteLocalDevelopment`  |
| Worker data                | `%LOCALAPPDATA%\MusicMuteWorkerDevelopment` |
| Chromium user/session data | `%APPDATA%\MusicMute Development`           |

Native development binaries also require the exact signing certificate's DER
SHA-256, compiled into the binary. They retain healthy current registration,
protected installed code, sealed inventory, user/session and process checks.
Loose development registration remains denied. Production and development
receivers reject the other build's identities, authority kind and signature kind.

The certificate is free and its private key is nonexportable in the Z440 user's
Windows certificate store. Only its public certificate may enter Trusted People
on that test machine. It is not a root CA, a credential to upload to Partner
Center, or a file to include in an application package. Removing local trust when
testing ends is a separate explicit action; do not remove unrelated certificates.

GPU exclusion remains shared across the physical adapter. The model, inference
recipe, audio quality, minimum Windows 10 22H2/build 19045, native x64 gate and
single shared Chrome extension remain the same. No CPU inference substitution is
introduced. The native messaging host name, Chrome extension ID, protocol and
execution alias remain shared, so use one installed product cohort for browser
testing. Do not run production and development Worker cohorts simultaneously:
their session locators are separate but their discovery signal is currently
shared. This does not grant cross-profile authority.

## Building and receiving

`node scripts/build.mjs --local-test-v1` fixes the development profile in the main,
preload, renderer, companion and all six agent graphs. The default build selects
`store-v1` explicitly. Five Node agents still compile Electron detection away.
New agent receipts bind the profile, actual compiler definitions, complete source
graph and emitted bytes; old receipts are accepted only by the strict Store
consumer. Compile the separate packaging driver with the same immutable define
`__MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__` set to `"local-test-v1"`.

The supplementary Python code reader has the same closed source profile. Local
packaging changes exactly one sealed literal; qualification and benchmark
wrappers derive the matching private data leaf from that reader. Unknown profiles,
foreign identities and malformed source projections fail closed. The production
inference, qualification and benchmark cores retain their exact original bytes.

Native CMake defaults to `MUSICMUTE_PACKAGE_AUTHORITY=store`. An explicitly
selected `development-test` build also requires
`MUSICMUTE_DEVELOPMENT_CERT_SHA256` as exactly 64 lowercase hexadecimal characters.
The approved QA tool guard's fixed command grammar stays unchanged. The Z440
build uses a new owned source snapshot with these fixed cache values, records its
actual source digest and retains the original source and failure receipts. A
short owned build-output directory avoids the Windows MSBuild path-length limit.

Build fresh GUI and Worker payloads from the same source cohort and actual native
build evidence. Preserve dependency/model bytes and run the existing full payload
audits, guarded SDK packing and unsigned archive readback first. Sign separately
named copies only afterward; do not weaken the production unsigned-archive
verifier to accept signatures. Receiving checks must verify the signed package,
exact publisher/certificate, actual registered identity, signature kind and
application launch. A private test install does not close Store certification or
physical Windows 10 acceptance.

## Z440 execution record

- [x] Explicit owner authorization for local developer builds and certificate
      trust, with no purchase or publication.
- [x] Separate compile-time identities, data/cache paths and strict mutual
      authority rejection; focused TypeScript and portable native checks passed.
- [x] Match the supplementary Python reader and preparation/benchmark data paths
      to the sealed profile; 51 Python receiving tests and 200 focused packaging
      tests passed after this correction.
- [x] Create the nonexportable local certificate; its public DER SHA-256 is
      `6226594348fbf2f8b28d8b5ef81a10dcbc50b0c07eb92d8133cadd1e63d5066d`,
      expiring 15 January 2027.
- [x] Correct native and Python containment to anchor at the exact OS-registered
      package root; 54 Python receiving tests and four engine projection tests
      passed. Protected code and descendant checks remain enforced.
- [x] Complete actual corrected Windows native compilation and the full guarded
      CTest rerun: 31 passed, one packaged-startup fixture skipped, zero failed
      in 108.50 seconds. Confirm whole-job cleanup. An independent review passed
      37 provenance assertions and raw-file checks.
- [x] Build and audit both corrected revision-one development MSIX packages.
      Both received fresh SDK packing and full archive census/hash/CRC checks:
      110 GUI files and 19,344 Worker files, plus two expected SDK metadata
      entries per package. Six processing-core file hashes remain unchanged.
- [x] Sign the first test pair and trust only the public certificate in
      LocalMachine Trusted People. Both signed archives retained every original
      member hash; their P7X/catalog signatures and SDK `signtool /pa` verification
      passed. No Root trust was added.
- [x] Install the first regular per-user MSIX pair. Windows reports both exact
      development families/versions as x64, signature kind Developer (`1`) and
      healthy `Ok`. The Worker window opened in standard Session 1.
- [x] Sign and fully verify both corrected revision-one packages with the same
      free local certificate; the signing wrapper exited zero.
- [x] Update both corrected revision-one packages in place: GUI `0.1.0.1` and
      Worker `0.1.3.1`, exact development families, healthy Developer (`1`)
      signature, native x64 and regular MSIX registration.
- [x] Build, fully audit, locally sign and update the packaged-child correction:
      GUI `0.1.0.2` and Worker `0.1.3.2`; both regular MSIX registrations are
      healthy, native x64 and Developer (`1`).
- [x] Observe both real main application windows initially in standard Session
      1, with no owned error dialogs, and update both Desktop shortcuts to
      revision two.
- [ ] Resolve the later account-helper loss/cleanup-pending state and verify
      sustained GUI and Worker operation.
- [ ] Verify installed Prepare/GPU and shared-extension behavior separately from
      the earlier production-core GPU timing tests.

The first installed launch failed: the standalone Worker opened but
reported unconfirmed startup-helper cleanup, and the GUI showed its generic early
bootstrap error. Healthy registration and valid signatures do not establish
runtime readiness. Actual process/job probes ruled out the initial retained-root-
handle hypothesis; no cleanup condition was weakened. A development-only closed
phase/numeric diagnostic has passed its source tests and Windows compilation.
Its Windows run executed the three previously skipped installed-package tests;
all three failed with `STORE_FILE_DENIED`, while the other 29 tests passed.
A standard-user probe found that the exact installed package roots and files are
accessible, but opening their `WindowsApps` ancestor returns Windows error 5,
including with zero desired access. The native and Python readers now anchor at
the exact OS-registered package root, retaining its canonical nonreparse path,
immutable ACL, held handle, descendant checks and package revalidation. All 54
Python receiving tests passed. No ancestor ACL, Windows security policy or
long-path policy was changed.

The corrected native source digest is
`8516ad9b95e52873c2953e4e4e06e4a6b381f48971237e8346bb5c024f304ad9`.
Its first full CTest run reached the 120-second aggregate guard limit after
tests 1–28 passed. A separately bootstrapped QA guard with a bounded 300-second
CTest limit passed its actual policy/descendant test and rejected 300,001 ms.
All other command, identity and cleanup constraints remain unchanged. The first
retry completed in 51.93 seconds: 30 passed, one skipped because
the fixture is not a packaged startup entry, and the runtime OS fixture failed
with `STORE_FILE_DENIED`. The package authority OS fixture passed. A separate
probe then passed full initial runtime admission, hashing and retaining all
19,338 files and 2,487 directories, and completing held revalidation/watch
admission at 22,438 ms. A read-only Node census found no missing, extra, case or
size differences; the longest installed file path is 238 characters.
The separate probe confirmed initial admission could complete; the path census
found no paths exceeding MAX_PATH. Neither established the cause of the earlier
intermittent denial. The unchanged full 32-test rerun subsequently completed with 31 passed, one
startup fixture skipped and zero failed in 108.50 seconds; its runtime OS test
took 64.07 seconds. The earlier intermittent denial, original timeout and all
receipts remain preserved. One passing rerun does not establish repeated
reliability, installed GUI startup or GPU preparation.

The corrected development pair uses installed revisions `0.1.0.1` and `0.1.3.1` to
update the existing packages without uninstalling or clearing their data.
[Microsoft requires a new package identity when contents change](https://devblogs.microsoft.com/insidemsix/third-rule-of-msix/).
Only the external local-test controller stamps these development manifest
revisions; the sealed semantic inventories and production submission versions
remain unchanged.

The development-only startup diagnostic contains closed phase labels and bounded
numeric observations, without paths, tokens, arbitrary exception messages or
stack traces. The protocol review applied the relevant
[Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on numeric precision (171), compatibility (106), stack traces (177) and sensitive
data (200), read on 15 October 2026. REST routing and HTTP rules do not apply to
this native stderr protocol.

The revision-one unsigned preparation receipt is
`C:\MusicMuteBuild\MusicMute-Development-20261015-921d8d13\development-build-diagnostic-complete.json`,
44,435 bytes, SHA-256
`bc54895211bb6de85fc752d71372e0ed0b43d042ac0e58dc05b03f020790260e`.
It records four fresh guarded SDK configure/compile operations, both full
archive checks, the exact native source cohort and unchanged processing cores.
It is not a signing or installation receipt.

| Unsigned local test package | Version   | Bytes       | SHA-256                                                            |
| --------------------------- | --------- | ----------- | ------------------------------------------------------------------ |
| MusicMute                   | `0.1.0.1` | 167,087,870 | `5bee7d7b2802fb325e2f587bbbaf2987a9f93088951f1e080629dc7139f5fd11` |
| MusicMute Worker            | `0.1.3.1` | 424,961,791 | `b750ebd107076321d7986319057e42cb2410d050f7a49be86ce52fa1364c723a` |

These revision-one unsigned artifacts are under `C:\MMD921d8d13\packages3`. The historical
earlier corrected preparation receipt is
`C:\MusicMuteBuild\MusicMute-Development-20261015-921d8d13\development-build-corrected-complete.json`,
SHA-256 `f31554a47e18170a38f1a4fc669b6f4804466220dcc2f222447afd6eefa2789b`.
Its separate reused GUI and fresh Worker evidence does not describe the latest
revision-one pair. Earlier failed preflight receipts remain preserved.

The revision-one signed-pair receipt is
`C:\MusicMuteBuild\MusicMute-Development-20261015-921d8d13\development-update-revision1-cohort\development-signing-receipt.json`,
11,153 bytes, SHA-256
`360ea15902e2a4acdf10f3f485caa4c6129e32036cb16839c770ddb6eecb6d64`.
Signing and full signed-copy receiving passed for both packages; this receipt
does not establish installation or application readiness.

The signed copies are already on the Z440 at
`C:\Users\hatem\Desktop\MusicMute-Development-Current-Test-2026-10-15-921d8d13`:
`MusicMute Development.msix`, `MusicMute Worker Development.msix`, their public
certificate and `SIGNING-AND-HASHES.json`. Exact signed archive hashes remain in
those device receipts. The complete signing receipt was downloaded and its
11,153-byte/SHA-256 pin verified after reconnection.

| Signed local test package    | Bytes       | SHA-256                                                            |
| ---------------------------- | ----------- | ------------------------------------------------------------------ |
| MusicMute Development        | 167,089,344 | `eb9cf5f328531b8a79885b2b272bbc9af52d115e3d7f5f15a91ddde460d7a093` |
| MusicMute Worker Development | 424,447,166 | `ace37719f65ff8927a01821a705df27e3ec4d934b960f378d3882a891ea571c5` |

At 12:47 UTC, the update-script upload failed with SCP connection-closed status
255 before an update was dispatched. Tailscale reported the device offline;
both a Tailscale ping and a new TCP/22 probe failed. Neither revision-one install
was attempted before that disconnection. The owner reconnected the device and
the prepared standard-user update was dispatched once in active Session 1,
RunLevel 0. Both in-place updates passed. Worker opened its own 740 × 370 window
showing “Reading Windows startup settings.” The launch observer then stopped
at `launch-gui` with `OWN_PROCESS_VERIFICATION_FAILED`; it could encounter a
transient Electron child while scanning processes. This observer failure is
preserved and does not roll back the successful installs. Current owned-window
and fresh GPU acceptance require supplementary observation. No rebuild,
re-signing, reinstall, uninstall or data clearing was needed to resume.

The supplementary observation confirmed a real startup failure in revision one:
GUI `native-boot` / native `entry-self code=6` (`STORE_PACKAGE_DENIED`), and Worker
`child-attest code=8` (`STORE_PROCESS_DENIED`). In revision one, both packages
were installed and healthy, but the GUI main window and GPU preparation failed.
The exact owned-window receipt is 9,868 bytes, SHA-256
`0badc0ca8631c12c7203216d1d14a7863507fbc47bc8c81de3fbb2764d81198b`.
External child sampling was inconclusive and is not evidence of missing package
identity. The next revision uses a supported explicit packaged-child launch
policy and the existing GUI session launcher; no identity
or cleanup checks are being waived.

At the owner's request, the exact installed `app\MusicMute Local.exe` was also
launched directly in standard Session 1. Windows assigned its genuine GUI
package identity, but it displayed the same `native-boot` / `entry-self code=6`
error. Direct EXE activation therefore did not resolve this observed failure.
The own-window receipt is 4,995 bytes, SHA-256
`df34515ea4c6990067455327fd47a8f37f9dc79f79530c6aff2f48f28b6d8506`.

The new source cohort is 107 files, SHA-256
`953d342f35e7357d1436e908337a8211b260bcd455c84001e8961b417c942058`.
It uses the existing `MusicMuteSession.exe` as the GUI activation launcher and
retains Electron at its original `guiApplication` role/path. Store-owned child
creation explicitly sets desktop policy `OVERRIDE | DISABLE_PROCESS_TREE`;
Windows still must supply the exact package identity, and suspended-child
attestation remains required. The Worker/legacy lifetime rules, intentional
ordinary registry query, all processing cores and shared extension remain
unchanged. The activation grammar preserves UI, setup, cloud and headless-account
routes. [Microsoft documents the combinable desktop policy flags](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

All four new native application executables compiled on Windows. Focused
packaging validation passed 147 tests; the portable GUI argument tests passed
55 checks in each compiled profile. Independent source review found no blocker.
The first full 34-test Windows run failed: namespace hit its existing 15-second
timeout, and runtime OS admission reported `STORE_FILE_DENIED`. Both newly added
policy tests passed. One unchanged warm rerun completed with 33 passed, one
startup fixture skipped and zero failed in 112.87 seconds (113.07 seconds in
the whole-job guard). An independent review passed 47 provenance assertions;
both actual Windows packaging provenance receivers accepted this source cohort.
The original failures and binaries remain preserved, with no test, timeout or
selection relaxation. This single passing rerun does not establish repeated
reliability. Packaging, installation and runtime observations follow below.

The revision-two unsigned pair subsequently completed fresh guarded SDK packing
and full archive readback: GUI `0.1.0.2` and Worker `0.1.3.2`. The complete
receipt is
`C:\MusicMuteBuild\MusicMute-Development-20261015-921d8d13\development-build-launch-revision2-complete.json`,
50,236 bytes, SHA-256
`5298d66c5cf63b978414cbfac3e130ba1d1b3a9aef61501117ab33eff6a0cb59`.
All four fresh SDK jobs completed with zero remaining processes and both output
streams closed. Full archive checks verified 110 GUI files and 19,344 Worker
files, plus two generated SDK metadata entries per package. All five agents,
283 Worker distribution files and six processing cores remain unchanged.

| Revision-two unsigned local test package | Bytes       | SHA-256                                                            |
| ---------------------------------------- | ----------- | ------------------------------------------------------------------ |
| MusicMute `0.1.0.2`                      | 167,094,747 | `f51cfb3c2d0aab528d89ab97f54fe8b559bd81fdfdaf10ca57c5d0259451c472` |
| MusicMute Worker `0.1.3.2`               | 424,968,829 | `052d1494317bdaafc9a1e45fca8e9ccfaece38cf0fe0551b41196f9a3f8841a6` |

These files are under `C:\MMD921d8d13\packages4`. The completed fresh GUI build
was reused after two external packaging-check corrections: admit only the four
expected build-time acceptance-runner metadata changes, and convert ASAR lookup
paths to native Windows separators. All eleven consumer compiler graphs were
identical. Earlier failed receipts remain preserved. Neither correction changed
application code, audit requirements, model quality or the shared extension.
Signing, installation and runtime readiness require their separate receipts.

Both revision-two packages were then signed and fully received using the same
approved certificate. The signing receipt is
`C:\MusicMuteBuild\MusicMute-Development-20261015-921d8d13\development-update-revision2-cohort\development-signing-receipt.json`,
11,400 bytes, SHA-256
`5e2f7d3a39485d0960bcff10505ade16d2218584eb08d2a121e860ffbd180685`.
Both SDK signature verifications and full unsigned-to-signed ZIP comparisons
passed, including exact certificate and catalog signatures. An independent
read-only review also verified the four fresh SDK operations, both archive
records, all eleven unchanged consumer graphs and the unchanged core, agent and
Worker distribution bytes. No certificate trust or Windows policy changed.

| Revision-two signed local test package | Bytes       | SHA-256                                                            |
| -------------------------------------- | ----------- | ------------------------------------------------------------------ |
| MusicMute Development `0.1.0.2`        | 167,096,225 | `91c94ce898bf222d60ec7dca86ad4b49c050e0f35d47b8621a26fca9d43d7cc4` |
| MusicMute Worker Development `0.1.3.2` | 424,454,201 | `f24e021208856ccb3948aff482870b07a11b915d1bf6b06d9e8ef4b059acd391` |

The new signed files are on the Z440 under
`C:\Users\hatem\Desktop\MusicMute-Development-Current-Test-Revision2-2026-10-15-921d8d13`.
Both revision-two packages subsequently installed in place, with no uninstall,
data clearing or Developer Mode change. Windows readback confirmed their exact
versions/families, healthy Developer (`1`) signatures and native x64. The install
receipt is 2,141 bytes, SHA-256
`935f746cf82db09e06dc5ae2e5351c1ccd28b67c8040d0c2df148dd8254d97a8`.

Both real main windows opened in standard Session 1 with the correct package
identity and no owned error dialog. The GUI displayed Home and the initial
“Prepare this PC for local processing” state; the Worker window was reading
startup settings. The launch receipt is 13,266 bytes, SHA-256
`96bcf34d5e633102dc3013e46397e7dd6d82940c601c35a80cfaaf1030a3fc49`.
Both receipts are under `development-update-revision2-cohort`. Desktop shortcuts
are `MusicMute Development.lnk` and `MusicMute Worker Development.lnk`, bound to
their unchanged development AUMIDs and revision-two icon paths. These successful
window observations do not establish completed Prepare or Worker operation.

The later readiness observation at 14:06:43 UTC found the GUI in “Closing
MusicMute” / “MusicMute could not confirm cleanup. Retry closing,” with local
agent/background-saving attention messages and no fresh Prepare events. The
readiness receipt is 6,194 bytes, SHA-256
`3700f832f7ad0c360ab5c61fe2fd71cf8dac259993c83ed5fe3a7265f54685ae`;
the current-window/stabilization receipt is 25,463 bytes, SHA-256
`a99fd554f9d92b65f23dfa27e3f30ec763007d3ec34e5ecd5a802f522c6d9b64`.
Worker diagnostics included `store-startup code=8 wait=258 exit=259 active=2`
and `shutdown-confirm code=8 wait=0 exit=2 active=0`. These snapshots do not
prove a timeout: typed errors are currently flattened by the bridge and
controls. Source tracing identified a 12-second GUI owner-operation deadline
whose abort closes the authority and triggers shutdown; the actual failing
operation is still being investigated. No timeout, authority or cleanup check
was relaxed.

One actual, verified Worker “Check status” action then failed in under 4.53
seconds, ruling out its 30-second request deadline for that run. The helper's
real parent was the Worker controls process. The 48,206-byte timing receipt has
SHA-256 `c1653c2ff910cde68f96b65f920f7b95086b62cd72e69d11ef99f4901b13ed7d`.
A separate qualified read-only native probe measured actual GUI/Worker package
observations, root resolution and revalidation: all calls totaled 376 ms.
These measurements do not justify raising timeouts. They do not identify the
original typed rejection, which the bridge currently discards.

The next diagnostic-only source cohort preserves that original closed numeric
code and StartupTask HRESULT through the existing error mapping. It changes no
wire result, authority decision, cleanup rule, phase/schema bound or production
output. Its 107-file source digest is
`f238c741524eb02f279a84b739f2dc03183cceeb9295c516d98d53d9dee14d23`.
Both profiles passed 4,162 portable diagnostic checks and 255 startup checks.
All four executables compiled on Windows. The initial full run retained a cold
10-second policy-test timeout and runtime `STORE_FILE_DENIED`; an unchanged full
rerun passed 33 tests with one startup fixture skipped in 91.32 seconds. The
cold failures remain unexplained. Independent code and 50-assertion provenance
reviews passed. The native input receipt is 5,892 bytes, SHA-256
`dc685949193b1fe4b76fcf89a73c37c74567192f1bf837d5726c016cdd1bf5d7`.
Revision-three packaging completed with four fresh guarded SDK operations and
both full archive audits. An independent review checked all four actual SDK
request/receipt/IO/log sets, source bindings and admitted payload differences.
The unsigned completion receipt is 48,349 bytes, SHA-256
`0aa32595bd4478ad8882318b4757c1eae56ba0bb2d86009728524a1975eebcc4`.

Both revision-three packages were signed with the existing approved certificate.
The signing receipt under `development-update-revision3-cohort` is 11,369 bytes,
SHA-256 `79a1fa450d48c2f5fa760d37a9585cea7805154deb0c5edf1bc27c4bf2a9d9b5`.

| Revision-three signed local test package | Bytes       | SHA-256                                                            |
| ---------------------------------------- | ----------- | ------------------------------------------------------------------ |
| MusicMute Development `0.1.0.3`          | 167,096,789 | `0207fad801a07724613f1fbac3e6037e4da1615d061859c56327fe3d1edb9987` |
| MusicMute Worker Development `0.1.3.3`   | 424,454,750 | `a0547cc5d6274a0178f0ab57b56f1a63f2490cf8a8dbd5c997196c8a3ff83511` |

The signed files are on the Z440 in
`C:\Users\hatem\Desktop\MusicMute-Development-Current-Test-Revision3-2026-10-15-921d8d13`.
Worker updated normally. GUI deployment first returned `0x80073D02` because
the old cleanup-pending development processes remained after supported Retry
closing and window close. After verifying the exact old package had no visible
window, selected input or Prepare activity, the authorized GUI-only deployment
used `Add-AppxPackage -ForceApplicationShutdown`. No uninstall, data removal,
certificate trust or security policy change occurred. Both exact revision-three
registrations are healthy native x64 with Developer (`1`) signatures. The
recovered install receipt is 2,236 bytes, SHA-256
`c84b1bb01c756d6dba8e086e6e7e87e331a15251194be0904007819b859f67e3`.

The recovered launch receipt is 12,473 bytes, SHA-256
`f40140e5ef16904450eb44aa065f8c005077696092d44c3574ae568af72f5424`.
It records the reused revision-three Worker window and a genuinely fresh GUI
main window displaying Home in standard Session 1. Worker now exposes the
original inner `store-startup code=10 win32=0` (`STORE_FILE_DENIED`), rather than
only the outer generic process denial. This does not identify the failing file
check or establish a timeout, completed Prepare or GPU processing.

Prepare was then started through the installed GUI's Home and Prepare buttons.
It displayed real preparation progress before reporting failure at 15:07:35 UTC;
no fresh Ready state or installed GPU job resulted. The invocation receipt is
10,405 bytes, SHA-256
`6ef7983aef6553224f20f9035eb996b904be86ce9fb73edb3903f44921a9b199`.
A fresh Worker controls launch after both deployments still returned code 10.
Explicit OS activation of the fixed Worker Session AUMID subsequently returned
`S_OK` and an observed correctly packaged Session process; another actual status
read still failed. First activation alone therefore did not resolve this run.

Separately, source review found browser-server cleanup attempted owner ticket
removal even when that invocation never published a ticket. The source fix
tracks successful validated publication, retains ownership across listener
rotation and preserves retirement/removal failures. Six regressions were added;
103 focused tests, TypeScript checking, scoped lint and formatting passed. A
development-only late owner diagnostic was also added in source. These newer
TypeScript changes are **not included in frozen revision three**; their device
effect remains unproved until a coherent subsequent build is installed.

The owned Worker screenshot also exposed a DPI sizing defect: its layout and
font scaled while its initial physical window remained 740 by 370, hiding the
buttons. The source fix sizes the initial and minimum client area at the actual
window DPI, then includes the Windows frame. Both portable profiles passed 301
controls-policy checks. The fixed task lookup and preserved asynchronous error
status, together with these three DPI files, are frozen in native source digest
`e1edb8a41dc54b77187777e820645ca99eda4b1215f3f70447777e5298c3d8aa`.
All four executables subsequently compiled on Windows, including the new WinRT
operation-policy tests. The first full run again retained `STORE_FILE_DENIED` in
the runtime OS fixture after 37.44 seconds; 32 other checks passed and one startup
fixture skipped. One unchanged full rerun passed 33 checks with that one skip in
97.02 seconds. Its qualified native input receipt is 5,872 bytes, SHA-256
`434a29bd078a8f00f05956143d7611203bc4a6754628d313ff32bcc00676f59e`.
An independent read-only review verified the source, raw runs, unchanged PE pins,
guarded cleanup and colocation. The cold failure remains unexplained, and this
does not establish reliable first-run or installed behavior. Revision-three
packages and their evidence remain unchanged.

Revision four packages the reviewed native changes together with the four newer
runtime TypeScript files. All twelve compiler graphs ran afresh, the changed
agent receipts were regenerated, both Windows SDK packs passed, and both full
unsigned archive audits completed. Its build completion receipt is 65,793 bytes,
SHA-256 `02a7eff7d4db44f2a9130029351aa70858ec4fe7b8e6731b9f6fb66eaa525945`.
Independent review verified 119 raw SDK receipt, log and input assertions.
Worker dependency payloads, processing cores, model, recipe and shared extension
remain unchanged.

Both separately named revision-four copies were signed and verified using the
existing local certificate. The signing receipt is 11,362 bytes, SHA-256
`59b2ded7ce92d91bba37a5fad8ec6a2293aa103fdff559676c75384897a612bc`.
The signed copies are in
`C:\Users\hatem\Desktop\MusicMute-Development-Current-Test-Revision4-2026-10-15-921d8d13`:

| Product                      | Version   |       Bytes | SHA-256                                                            |
| ---------------------------- | --------- | ----------: | ------------------------------------------------------------------ |
| MusicMute Development        | `0.1.0.4` | 167,097,241 | `c2b8cfa8540b4a6cd11e3c64c676117c0de18b678f3db263bbbd48441c8b1f81` |
| MusicMute Worker Development | `0.1.3.4` | 424,455,646 | `27b53c093d71f20f2049f5f8636cb54684f729eda8e7c9d5d6c87173c3117046` |

Both in-place updates completed at 16:02:29 UTC with healthy exact Developer
(`1`) registration, native x64 architecture and no loose development mode.
The paired install receipt is 2,236 bytes, SHA-256
`fa7c0e2cbd261ade472d16d9db6696bc09b63bf688806337576ebb98972bff95`.
Normal GUI deployment first failed with `0x80073D02` because the old revision-three
GUI was stuck closing. Its own visible closing state and absence of active
preparation were checked before the exact GUI update used Windows'
`ForceApplicationShutdown`; no uninstall, data removal or manual process kill
was performed. The initial failure and the first recovery preflight refusal
remain preserved. No production archive, trust configuration or publishing state
was changed.

Actual direct activation of the installed `app\MusicMuteSession.exe` then
produced a fresh packaged Electron main process and the visible Home window.
The primary launcher exited zero after handing off. The Worker also opened in
standard Session 1; its corrected 1,132-by-611 window showed all four buttons.
The launch receipt is 14,469 bytes, SHA-256
`b41999373313b436fb1ea856add594758a1d1cfb092179282e5fe4cd8a09dff9`.
These short launch observations do not establish sustained operation.

The actual revision-four Worker status request retained its helper through exit
2 and reported native startup code 5 with `0x80070057` (`E_INVALIDARG`). Both
controls and helper had the actual `!MusicMuteWorker` application identity;
the exact installed manifest's matching fixed `MusicMuteWorkerStartup` task is
declared under `MusicMuteWorkerSession`. This association difference is observed,
but API lookup scope or first-registration causation is not proved.

Before a preparation action could be invoked, the GUI displayed its new
development-only late account-owner diagnostic: `store-dispatch code=0
win32=233`, followed by `transport-eof code=0 win32=0`, and entered safe closing.
The first preparation observers preserved their failed UI preconditions with
no Prepare/Retry action; there is no new GPU preparation duration or census
timeout measurement. No eventual account-owner exit was captured, and a missing
process snapshot is not substituted for a held exit observation. Source review
identified the post-ACK named-pipe EOF handling as a candidate for a real Windows
regression test; this does not yet prove the original failing operation.

A guarded, isolated Win32 reproduction then observed exactly
`ReadFile=false/error=233/count=0` after a reply, ACK and deliberate server
disconnect. The unchanged transfer rejected it; the corrected copy accepted
read EOF. Pending EOF and negative frame/write/deadline checks also passed:
46 checks in 1.83 seconds, whole-Job zero confirmed. This was a synthetic pipe
test, not an installed-app acceptance run. The product correction accepts only
zero-byte reads with `ERROR_BROKEN_PIPE` or `ERROR_PIPE_NOT_CONNECTED`; writes,
missing/truncated required frames and unexpected trailing bytes still fail.

Separately, genuine activation of the revision-four Worker Session application
did not fix the controls' startup query. Its retained process exited with
`0xC0000005`; Windows Application Error event 1000, record 6399, identified the
exact installed Session application and `bcrypt.dll` as the faulting module.
Source review found both native file-hash functions freed their CNG backing
buffer before destroying the hash handle, contrary to
[Microsoft's lifetime requirement](https://learn.microsoft.com/en-us/windows/win32/api/bcrypt/nf-bcrypt-bcryptcreatehash).
Both now retain that buffer in the hash owner until its destructor body finishes.
The Worker startup task ID, declaration, API and time limits remain unchanged.

These five reviewed source/test files are frozen in revision-five native digest
`fdb5b56e10e0a6139c6ee08e75fc2fe7ba9d9de75274b79eaffa260fdf188fbc`.
The other 102 native inputs match the previous cohort exactly. Both portable
profiles passed 124 strict Clang policy checks. A focused lifetime test double
reproduced the original defect and passed 128 success/unwind/recovery assertions
with the exact corrected hash bodies; this is not actual CNG evidence. Sanitizer
binaries compiled but hung, so no sanitizer runtime pass is claimed.

All four executables then compiled on Windows. Actual CNG known-vector and
failure-unwind checks passed, as did the isolated Win32 EOF regressions. The
first full 34-case run still failed only the recurring runtime OS check with
`STORE_FILE_DENIED` after 37.13 seconds: 32 passed, one skipped, one failed. One
unchanged full rerun passed 33 with the same one startup skip in 93.47 seconds;
the runtime OS case took 67.89 seconds. No source, PE, tool, selection or timeout
changed between those runs. The first failure remains preserved and unexplained.
The qualified native receipt is 5,866 bytes, SHA-256
`ddb69150d5b6635ba46dbce36dc4638418aa0edb356cfddbcb118050700ddc43`.
Revision-five packaging completed with four fresh guarded SDK records and both
complete archive audits. Its completion receipt is 50,581 bytes, SHA-256
`81e060912f461cc96969ac00cf2ece3fdbf43ae5c830487321e9a7a23aec528a`.
The unsigned test copies are:

| Product                      | Version   |       Bytes | SHA-256                                                            |
| ---------------------------- | --------- | ----------: | ------------------------------------------------------------------ |
| MusicMute Development        | `0.1.0.5` | 167,095,958 | `0bf077ae7e37036ae46003b888c825e3dbaa2f44c3768967c9fe51aadf2204ec` |
| MusicMute Worker Development | `0.1.3.5` | 424,970,593 | `907012dad8fd9426956e0ae5f0163cc7efac9d6a58b480ffe4c0e87a938c74a5` |

Current TypeScript graphs, five Worker agent receipts, 283 Worker dist files,
the Python reader, six processing cores, model, recipe and shared extension
match revision four. Both revision-five copies are now signed with the existing
free test certificate. SDK verification, both complete signed-to-unsigned
member comparisons and both P7X/catalog checks passed. The signing receipt is
11,362 bytes, SHA-256
`a586aeb6417c50235077871d7dc1cbe0f70c5c0fff4aa1025f01b8a5d9c00405`.
The signed GUI is 167,097,434 bytes, SHA-256
`603ba500ed478a3dac1b7115cb5b98eaeaf02f005b218823aff154b6c628f528`;
the signed Worker is 424,455,985 bytes, SHA-256
`308af8a9410981ae9014d39dac19d4d4b476d88648d9d9400903383dfcf33084`.
Both are on the Z440 Desktop in
`MusicMute-Development-Current-Test-Revision5-2026-10-15-921d8d13`.
No certificate, trust or production policy changed. Installation is in progress.
The reviewed fixes are not yet in the installed revision-four packages; a warm
rerun does not establish reliable first-run operation, completed preparation or
an installed GPU job.

Direct revision-two primary EXE and registered `musicmute-local://setup`
activation both observed the existing main window. Their short initial
snapshots do not establish sustained readiness or a Chrome native handshake.
The direct primary was subsequently absent; no eventual exit code was inferred.

The actual Windows SDK signer creates `AppxSignature.p7x` and
`AppxMetadata/CodeIntegrity.cat`, with their matching content-type declarations.
[Microsoft documents this generated catalog](https://github.com/microsoft/WinAppCli/blob/main/docs/usage.md#create-external-catalog).
The signed-copy receiver permits only these generated additions, verifies both
CMS signatures against the exact development certificate, and requires every
original payload, manifest and block-map member to remain byte-identical. The
production unsigned-upload verifier is unchanged.

The initial Windows native validation registered 31 CTest cases: 28 passed, three
package-dependent cases skipped and none failed. The skips are not installed-app
proof. Portable native policy checks passed for both compiled profiles; scoped
TypeScript type/lint checks and the focused receiving tests also passed.

Do not promote the development artifacts, certificate or screenshots as evidence
of Store signing. The [Store readiness record](../../docs/windows-desktop/store/STORE-REVIEW-READINESS-2026-10-15.md)
retains Microsoft's separate approvals and release requirements.
