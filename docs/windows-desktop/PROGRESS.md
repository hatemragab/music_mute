# Progress and next handoff

Last updated: 2026-10-11.

Source38/native35 passed all eight native build targets, description and all four
CTests under limited Session1/RunLevel0; actual Job-zero/exact task retirement
passed at 13:28:10 UTC. Source36/native34's failed hardlink-denial expectation and
source37's local, unuploaded cleanup-race rejection remain in history. Source38
changes only fixtures; single-link checks detect aliases without proving atomic
alias-creation prevention. Native22–25's uncertain cleanup remains preserved.
All four v11 production media-015/media-017 recipe runs passed complete decode,
whole-byte read-back and exact Job-zero/task retirement. Their unprofiled
DirectML GPU0/fallback-off policy checks provide no per-run pure-GPU counts.
The peer-approved TypeScript v04 upload-completion repair passed local desktop
2,193 tests/233 files, focused78/5, typecheck/lint/build/scoped format and package
fixtures5. Final worker v02 focused118/3 passed its code checks; worker215/14 remains
v01 history. The native suite and local TS/loopback fixtures do not prove a live
Windows bridge/cloud transfer or close remaining preparation resume/publication,
metadata/mutation/handoff, WinRT/NSIS, signed installed/account/shared Chrome/worker
or physical Windows10 acceptance. Existing combined Windows gates stay unchecked.

## Current connected-machine checkpoint — 2026-10-11

W34 is in progress on Windows 11 Pro 25H2/build 26200, native x64, Radeon RX580
and driver 31.0.21925.1001. The approved Build Tools installation completed with
exit 0 at 2026-10-10T23:28:50.9035457Z, no reboot required and no driver change.
Actual inspected tools have valid signatures: Visual Studio 17.14.37710.0,
MSVC 19.44.35229.0, CMake/CTest 3.31.6-msvc6 and Windows SDK 10.0.26100.0.

Native bootstrap exposed restricted-environment defects. Actual A/B checks proved
that Visual Studio discovery requires retained `ProgramData`/`ALLUSERSPROFILE`,
MSBuild needs the canonical Windows-root `SystemDrive`, and its preferred compiler
host changes from x86 to x64 when `PROCESSOR_ARCHITECTURE=AMD64` is supplied.
The runner and C++ QA guard now derive the validated drive and fix AMD64 while
excluding inherited tool/compiler overrides; configure uses `-A x64 -T host=x64`.
Focused 28 tests/two files, typecheck, lint, formatting and source build passed.
The Mac Desktop regression passed 2,145 tests/232 files, starting 02:50:45 and
lasting 90.87 seconds, before the later native C++ corrections below.

Build tracking failed in the initial AppData QA folder. A fresh private outer
build root configured and compiled the QA guard/fixture; after the compiler-host
environment correction, its bootstrap passed exit 0 with actual approved Hostx64
identity/hash and positive owned Job-zero. Configure/QA compile/guard self-test
took 7.995/11.465/3.307 seconds. This bootstrap remains distinct from full native
build/CTest acceptance.

The first full native run failed actual MSVC compilation under limited Session 1,
after configure passed the exact Hostx64 check. It exposed a malformed browser
manifest initializer, codepage-dependent superscript wchar literals, missing
`ws2ipdef.h`/`shellapi.h` and shadowing locals. Six native files were corrected and
six reserved COM/LPT superscript cases added. Worker policy/transport/login source
checks passed 101 tests/three files plus typecheck. The verified 69-file source
archive contains only those six changes; the 24 engine files and predecessor
evidence are preserved. The failed run's guard ledger confirmed cleanup, and its
exact task was removed with zero remaining test processes.

The second full native run, using source05 digest
`697d1b8774645c050f60dc431756ceea9fb46e569aec7b1cc12c5892f30fbc50`,
compiled/linked all eight targets under limited Session 1 and described the actual
Windows 11/RX580 target. CTest passed only one of four cases (JSON); Win32/security,
QA-tool self-test and GPU keeper failed. Every ledger action confirmed Job-zero,
and the exact native02 task was removed. Source06 adds test-only safe diagnostics
and normalizes CMake's forward-slash sibling path only for the QA self-test;
production request grammar is unchanged. Its native source digest was
`a5ce761dc96a427747eecabe2ed08acfad78284c81d8690354cc064e0a0cb758`.
The fresh source06 guard bootstrap passed configure/compile/self-test. Native03
then completed in 114,293 ms under Session 1 RunLevel0: all eight targets
compiled/linked and the DXGI descriptor passed. CTest passed two of four cases:
JSON and QA-tool descendants (2.34 seconds, actual Job-zero). Win32's browser
lost-publish-ACK case returned `BROWSER_REGISTRATION_CONFLICT`; GPU keeper failed
the watchdog-first assertion at line 269. Both ledgers confirmed cleanup; the
exact task was removed after matching XML, zero instances and zero Session 1 tool
processes. Source07/native04 preserved the two failures and established that the
browser's volume, file ID, content and hash matched while creation time drifted;
the GPU Job had four members rather than the expected two. Source08/native05
identified the two additional members as canonical System32 `conhost.exe`, beside
the two known sleeping leaves. Both native04/native05 ledgers confirmed Job-zero;
each exact task was removed after matching XML and zero instances. These failed
runs remain evidence.

The browser repair restores creation time through the exact held renamed handle
before recording `published`. Interrupted recovery is fenced to `old-removed`
with the staged path absent; published records and same-content clones still
require the full recorded birth. Native crash/tamper fixtures cover that boundary.
The GPU fixture now launches sleeping leaves with `DETACHED_PROCESS`, eliminating
their hidden console hosts while retaining the exact two-member assertion,
deadlines and production security rules. Worker browser source checks passed
100 tests/three files plus typecheck. Native06 used source09 digest:
`39a77c683fa2f54089068217fbe83562ea76435743d1ab1a97087eccec98eb5d`.
Actual native06 ran under limited, non-admin Session 1 in 110,106 ms, with runner
exit 2. All eight build/link targets and the DXGI descriptor passed; CTest stayed
at two of four passes. Every browser checkpoint now passed, including interrupted
rename/restoration and pending-record denials. Win32 then failed file creation in
the remaining isolated checks at helper line 24. GPU's exact two-member assertion
passed after `DETACHED_PROCESS`, followed by actual Job-zero and mutex release;
the immediate process-object-signaling assertion at line 331 failed. The source10
test-only correction adds bounded `WaitForMultipleObjects(5000)` and file-creation
caller/error diagnostics. Frozen source10 changes only `gpu_keeper_tests.cpp`
and `native_tests.cpp` from source09; its native digest is
`fb7ce2ae779f39631ff193504eeba62c47b8789d4d38e49e267cec4365ef1396`.
Source10 transfer/pins and remote source digest matched; PowerShell parsed with
zero errors. Its 69-file membership changed only the two fixture files; all
24 engine files and predecessors were preserved. Native06 artifact SHA-256:
`5334f725eae445dce857b9c4c10a1058d0f8788d4120f7d94828051cd73581f8`;
target SHA-256:
`385517ec8d36935d4d2d5f8a0298a96d4f5301c5e5075096b92ce34881e28728`.
Both case cleanups are confirmed. The exact owned native06 task was removed after
direct two-action ledger/cleanup review, actual artifact hash match, source/input
wrapper checks, recorded XML equality and zero instances. Artifacts are preserved.
Actual source10/native07 then completed under limited Session 1 RunLevel0 in
112,378 ms. All eight native targets compiled/linked and DXGI passed. CTest
improved to three of four: JSON, QA-tool descendants and GPU keeper passed.
Both GPU keeper cases retained Job-zero and final leaf-process-handle proof;
the observed immediate handle results were 258/0, then bounded wait-all returned 0. All browser checks still passed. Win32's remaining failure is now identified
at caller line 275: error 3, `PATH_NOT_FOUND`, while creating a partial fixture
after cache deletion. Fixture-parent/setup versus production behavior remains
under investigation. Artifact SHA-256:
`ed66256da3c59f9c2e5efeb449431423c21147323cdf4574a4dfcf380fd1ed77`;
target SHA-256:
`b6a22c6372f7ef3c0656e91f78760b3d0849ca18a10ea0f712ce444f604ff2de`.
Both case cleanups are confirmed. Its exact task was removed after ledger/artifact
SHA review, source/input wrapper checks, recorded XML equality and zero instances;
artifacts are preserved. Actual long-path behavior is under investigation before
any further source fix. Retained-fixture inspection found the correct
MusicMuteLocal thumbnail parent exists and is not a reparse point; the short cache
leaf is 226 characters versus 267 for the partial path, with actual
`LongPathsEnabled=0`. The prepared correction shortens only the fixture scratch
label, preserving the 64-hex nonce/full private-kernel SID and adding parent/path-
bound assertions. It changes no OS registry, production path or ACL. Installed
app long-path behavior remains unverified. Source11 now shortens the scratch
label to `MMCN-`, saving 23 characters so the same partial path is 244; it preserves
the 64-hex nonce/full private-kernel SID. Explicit existing-parent/nonreparse and
`MAX_PATH` assertions prevent hidden parent recreation. Native09 source11 digest:
`fc5792f8169c37e4b2789c8e591fc9649009025f8f4504e6b22ef540a69497f2`.
Actual remote verification and zero-error PowerShell parsing passed; the 69-file
membership changed only `native_tests.cpp`, keeping all 24 engine files and
predecessors. Native08 failed only guarded configure: CMake printed configure
completion in 5.3 seconds and generation in 0.3 seconds, but the guard returned
code 2 and the wrapper elapsed 120,596 ms. One native-build case failed with
cleanup confirmed; no native08 C++ compilation or CTest proof exists. Artifact
SHA-256: `c615edd82b015856ba67c8a22f2f2b9b633ac857eeaa45f0b11d549e748b53ac`;
target SHA-256:
`c8bb400f8672c793cb99893faa342068b0693e240bc7e8ed0509459b2965232b`.
Actual artifact and wrapper pins, recorded XML equality and zero instances were
verified before exact native08 task removal; outputs are preserved.
Actual same-source11 native09 recovered configure, compiled/linked all eight
targets and passed DXGI in 113,008 ms under limited Session 1 RunLevel0. Its
predispatch build-process census was zero; native08's configure-only timeout was
not reproduced, with all guard deadlines unchanged. CTest passed three of four:
JSON, QA-tool descendants and GPU keeper passed, and browser checks passed.
The shortened partial-path correction now passed. Win32 then failed installer
line 374: the retained 146-character fixture had original root absent and renamed
root present, proving `MoveFileEx` succeeded while `installerDirectoryHandles`
were held. This is a production installer-directory rename-fence defect; a
minimal `installer_path.hpp` fix and native regression are in progress. Artifact
SHA-256: `43493504018b4026523b18bc2d1b122e740b6e06cd7b61067f6b8bade1c1c24c`;
target SHA-256:
`c8bb400f8672c793cb99893faa342068b0693e240bc7e8ed0509459b2965232b`.
Both case cleanups are confirmed. The exact native09 task was removed after
artifact hash, source/input wrapper pins, recorded XML equality and zero-instance
proof; all artifacts are retained. Native09 used the frozen source11 pin.
Native10 source12 fixes shared production `openEntry` in `main.cpp`: directory
opens additionally request `FILE_LIST_DIRECTORY`, while file opens and all
sharing/private/canonical/reparse/ACL/single-link checks remain unchanged.
Stronger native fixtures require installer/ancestor handles to prevent rename,
deny zero-access duplicates as a substitute and permit rename after release.
A later fixture uses a separate `GENERIC_READ` hash handle, preserving metadata,
private-path and full-identity checks. Current native digest:
`2d627fe8d6115beafe76be2e8593fb9d9ffbab91c8cd0d0b71c97aa9e8c02bf3`.
Actual transfer/remote digest, zero-error PowerShell parser and 69-file membership
passed; only `main.cpp`/`native_tests.cpp` changed, with 24 engine files unchanged
and predecessors saved. Independent review and actual Worker policy/transport
checks passed 98 tests/two files plus scoped diff checks. Actual source12/native10
completed under limited Session 1 RunLevel0 in 175,091 ms: configure, all eight
build/link targets and description passed. CTest passed three of four: JSON,
QA-tool descendants and GPU keeper. Win32 now failed its first `browser-publish`
checkpoint with `BROWSER_REGISTRATION_CONFLICT`, after the directory access change;
source11's earlier browser pass does not carry forward. Actual shared-handle fence
semantics and browser flow compatibility are under investigation; the production
directory access remains retained, without QA guard or tool-timeout changes.
Artifact SHA-256:
`2a1bcfa38f43777ae70e614666e6cd3de8a78ce82e18075d98bbca0af3b39af1`;
target SHA-256:
`3f3a93395243e9fa28db1632baf1d9ad6a194696b0c89e532cbd959524cadcf4`.
Both case cleanups are confirmed; exact native10 task removal followed bound
ledger, artifact hash, wrapper pins, recorded XML equality and zero-instance
proof. Outputs remain preserved. The whole native gate remains incomplete;
no GPU inference has started.
Actual source13/native11 completed at about 01:02:40 UTC in 110,565 ms. Configure,
all eight native compile/link targets and description passed; CTest remained
three of four, including both GPU keeper cases. The browser diagnostic now pins
the failing API to `SetFileInformationByHandleRenameBrowserStage`, Win32 error
32 (`SHARING_VIOLATION`). Native11 source13 digest:
`62f52e9bd2d6c43fff3fd022074f5b5ef2d1e386f49c86851a8aaa1ab387a395`.
Artifact SHA-256:
`08e4502044a6a85e46d410bf655fa6465db8a472ddb2bfd408da41ba8f62ebc0`;
target SHA-256:
`05d05d4dd3c0a051ef152d798d26941a1a35edf4688e65ff4b45f313dea1a6a5`.
Both case ledgers confirm cleanup. Its exact task was removed after recorded
dispatch XML equality, zero instances, actual artifact hash match and preserved
wrapper digest/inputs with exit 2; all artifacts remain retained.
The shared directory write-sharing correction is being prepared while preserving
the no-delete-sharing fence; QA guard policy remains unchanged.
Native12 source14 keeps actual `FILE_LIST_DIRECTORY` access and permits directory
read/write sharing, excluding delete sharing. Immutable payload-file sharing is
unchanged. New native fixtures require child full-path rename success, held-parent
rename/removal denial, payload writer error 32 while its hash handle is held,
writer success after payload close, and parent rename after all fences close.
Native12 source14 digest:
`30238ef3d84c31c26651617129047daa4ebcf13f326dc4740e72f8e19ac98601`.
Exactly `main.cpp` and `native_tests.cpp` changed from source13; browser diagnostics
and 24 engine files are unchanged. Actual Worker policy/transport 98/two passed
in 889 ms, with diff checks passed. Remote three input pins/updater hash, zero-
error PowerShell parsing, 69-file membership/native hash and saved predecessors
were verified. Actual source14/native12 completed in 115,871 ms after starting
at 01:06:05 UTC under limited Session 1 RunLevel0. Configure, all eight compile/
link targets and DXGI passed; CTest remained three of four. Every browser
checkpoint passed, including interrupted restoration and cleanup, proving the
production directory sharing change is compatible with this browser flow.
Win32 then failed the new child `SetFileInformationByHandle` rename assertion
at line 404 in the remaining isolated checks; its root cause is under investigation.
Artifact SHA-256:
`3c531a9275619fa63916efc7bc4f6c129f3ea6f220172e109417b3611563a556`;
canonical target SHA-256:
`dd5a38cec91b07d8a74a54bd4a30473e434a376ae844d8d9646771ecac098f4f`.
Both case cleanups/Job-zero, actual hash, recorded XML and zero instances were
verified before exact task removal; artifacts are retained. The complete Win32
gate remains pending. No inference has run. Native13 source15 changes only
`native_tests.cpp`: the child's full `FILE_RENAME_INFO` buffer now matches the
passing browser allocation with trailing NUL and reports the exact operation/
numeric error if it fails. Production main/browser and QA guard are unchanged.
Native13 source15 digest:
`65a72c8ef1a2ff9284a7e51d96e02c35029aebf17e201a90ec4f75625c7e7d74`.
Actual input/updater pins, zero-error PowerShell parsing, native 69-file membership,
24 unchanged engine files and saved predecessors were verified. Native13 started
at 01:10:30 UTC under limited Session 1 RunLevel0. Actual native13 completed in
114,166 ms; all eight build/link targets and descriptor passed, CTest three of
four. All browser checks and the new child-rename/read-write fence/release
positives passed. Win32 failed later at line 439 while creating the non-volatile
test `consumerBootKey`. Source inspection suggests volatile intermediate test
registry parents from the earlier volatile boot witness; production's direct HKCU
key has no intermediates. A test-only direct-HKCU random key and immediate
`LSTATUS` diagnostic are being prepared; the suspected cause still needs retest.
Artifact SHA-256:
`acab2ea034357b06fdecbfe026994c2957a9adb345d4e69b0c7ef61260c4899d`;
canonical target SHA-256:
`3d6cb9e1d28852f3efde985944a4d36628683de15110c915e349d7672812b101`.
Both GPU cases passed; actual Job-zero, both ledgers, artifact hash, recorded task
XML and zero instances were verified before exact task removal. All artifacts
remain retained. Directory claims remain scoped to rename/removal fencing.
Independent review found that empty-directory in-place `FSCTL` reparse mutation
needs a separate actual test; earlier metadata-only opens also had this gap.
The native agent is studying it, with no extra correction yet and no general
junction-race proof claimed. Source audit also found two production Library
`FILE_RENAME_INFO` allocations matching the old failing fixture without extra
NUL storage. A minimal shared-core correction and owned file/tree/conflict
fixtures are being prepared; public Library/account/long-path acceptance stays
pending, with no authentication bypass. Native14 source16 applies the test-only
direct-HKCU random boot key, leaving production boot key/probes unchanged. Its
shared terminated `FILE_RENAME_INFO` core serves the two existing authorized
Library callers with all fences retained. Short owned native fixtures require
file/tree/conflict/hash/birth behavior and direct-boot persistent-key denial,
exact pass and cleanup; they do not establish public account API behavior.
Native14 source16 digest:
`d7ca2a2c606b49fc250fd975e44139eda73cda7ae5d8a1bc045b8dc21c394435`.
Exactly `boot_identity.hpp`, `library_cleanup.hpp` and `native_tests.cpp` changed
from source15; main/browser and 24 engine files are unchanged. Independent review,
actual Worker 98/two in 905 ms and scoped diff checks passed. Remote three input/
updater pins, zero-error PowerShell parser, 69-file membership/source hash and
preserved predecessors were verified. Native14 started at 01:17:48 UTC under
limited Session 1 RunLevel0 and completed in 112,370 ms. All eight build/link
targets and DXGI passed; CTest stayed three of four, failing the new
`library-handle-renames` fixture at packed line 48. Source review confirmed
`hashFile` never rewound: a second full-integrity hash on the held handle read EOF.
Production callers all require a whole-file digest. Artifact SHA-256:
`9849bc56c18b416bc7aea6a0c40a7e1bb8690c666f8c3230a935b024e3dfb183`;
canonical target SHA-256:
`9a1ea653c0ef5e52d0fdef0c84913ccda23d99b5f25a9aacd10bc46da0784e2a`.
Both GPU cases, actual Job-zero/hash, recorded XML and zero instances were
validated before exact task removal; artifacts are retained. The boot correction
was not reached; full Library core and whole-file hash proof remain pending.
Native15 source17 seeks `FILE_BEGIN` before crypto in `startup.hpp`, preserving
full-file digest/cap semantics on reused handles. Native fixtures cover nonzero
offset, repeated EOF, exact cap, undersized cap rejection/recovery and split
Library phases. Boot/Library/main/browser are unchanged. Native15 source17 digest:
`23f12866da6a6b9272415cc9e836caa59b62272bad965dfebf3bd397aafebcdc`.
Only `startup.hpp`/`native_tests.cpp` changed from source16. Independent review,
Worker 98/two in 899 ms and diff checks passed; remote input/updater pins, parser
zero errors, 69-file membership, unchanged engine files and saved predecessors
were verified. Native15 started at 01:22:40 UTC under limited Session 1 RunLevel0
and completed in 124,896 ms with runner exit 0. Both isolated native-build and
native-security cases passed; all four CTest cases passed. Actual fixtures covered
browser, child rename/write-denial/release, Library file/tree/conflict, hash
offset/byte cap, persistent-boot rejection, remaining DPAPI/pipe/Jobs and both GPU
keeper cases. Artifact SHA-256:
`59b83d285add621d681b06158e5e662a9a232b2bb9d38b13d512c4c0cbc7804f`;
canonical target SHA-256:
`089beb789148d2da5298dbc0226cb99be29ebc39c0ff29102e456ab0be0324f9`.
Inputs were preserved; both actual Job-zero ledgers, artifact pin, recorded XML
and zero instances were verified before exact task removal. Artifacts are retained.
The narrow W34 Share/DPAPI fixture row and detached-thread terminal fixture row
are checked for these isolated fixtures only. Whole OS/signature/GUI/journey
acceptance remains pending. Native16 source18 adds only the reviewed bounded
three-control empty/nonempty/held-directory reparse probe in `native_tests.cpp`,
using an owned sibling target and restoring exact handle/birth before assertions.
Production headers are unchanged; the basic source17 pass is retained separately.
Native16 source18 digest:
`2f12cdb66789a56362a2b1c4df80d409259c0f6ead850db1bcd5f16f4fc7f4ba`.
Remote input/updater pins, parser zero errors, source 69-file membership,
24 unchanged engine files and retained predecessors were verified. Native16
started at 01:29:09 UTC under limited Session 1 RunLevel0 and completed in
117,041 ms, runner exit 2. All eight targets/DXGI passed; CTest three of four.
Controls observed unheld-empty reparse set success/error 0, nonempty failure/
error 145, and held-empty success/error 0. The final line-147 assertion failed
after exact handle/file ID/birth restoration and sentinel-hash verification.
This proves the in-place reparse mutation gap; source17's fence claims remain
limited to rename/removal. Secure child operations are being repaired. Artifact
SHA-256: `f75efdaa066372769d238b335ce3acfd9d1011bac171c02acdb04eefc4b43ced`;
canonical target SHA-256:
`b1bb6e724983e93df632297b9d509ac8f4c08bf0e4d605cd156d6efbda077708`.
Both ledgers/cleanup, target/artifact/source, wrapper exit 2 and preserved inputs
were checked, with actual hash/live dispatch XML equality/zero instances verified
before exact task removal. All artifacts remain retained. Source19
adds a helper-only `NtCreateFile` prototype with held `RootDirectory` and
`OBJ_DONT_REPARSE`, plus ordinary create/write/hash/delete, traversal/ADS denial
and mutated-directory containment/error/restoration fixtures. Production callers
are not migrated; the proven production gap remains open. Source19 prototype digest:
`2ce2792accc96736b3ea3b7ac43f1642d4095d22b61d8288f77e4c679016f9c4`.
Only `main.cpp`/`native_tests.cpp` changed; source 69-file membership, 24 unchanged
engine files, updater/input pins, parser zero errors and preserved predecessors
were verified. Native17 was dispatched at about 01:40:50 UTC under limited
Session 1 RunLevel0.
Native17 completed only the guarded configure case in 120,570 ms, runner exit 2;
its single failed ledger confirmed cleanup. Captured configure output (672 bytes)
contained Visual Studio/compiler identification and configuring-done text, SHA-256:
`3e1e82b971228053fd2a39a1341049e1f9c5be24af6fc0d06c963ff63cf5b87e`.
No C++ compile or test coverage was produced; the cause remains unproven and guard
deadlines are unchanged. Native17 artifact SHA-256:
`5a68e63de46e3eacffba9ffcf84e69768bee339984b8e1dac82f1a1b753908ae`.
The same-source19 retry native18 started at 01:44:49 UTC under limited Session 1
RunLevel0 and also failed configure-only in 120,580 ms, runner exit 2, with its
single ledger confirming cleanup. Native18 artifact SHA-256:
`c3ff4f8eb97c5dedbe7af7b95f0809fcd45ceaf0c0ca80a31f61181e251f7252`.
Both runs share canonical target SHA-256:
`6e2a72185297528a7456daf0422fbe0b8f39c43e43bbe25c312f821c033f0f98`.
Each exact task was removed only after ledger/artifact/source/wrapper checks,
actual artifact hash, exact live dispatch XML and zero-instance proof; artifacts
remain retained. Prototype coverage is still pending. Runner-only snapshot20
retains the validated guard termination reason and original tool exit code;
four guard tests, typecheck/build/format passed, with classification/eight-key
shape/Job-zero/timeouts unchanged. Its native digest remains source19, with all
44 native and 24 engine files unchanged. Snapshot20 runner SHA-256:
`2f344c5cdff4578ff10be1fa3155427c6b628a1a826ad01354f24d16df4afbb2`.
Independent native-agent review and actual updater pin/parser zero errors/69-file
census/preserved predecessors passed. Native19 was dispatched at 01:49:40 UTC
under limited Session 1 RunLevel0, with unchanged source19/input-target bytes.
Wrapper SHA-256:
`2dcb5b58ea394eacdbe2fa82a92ddec717fac7e64cef9be5edc311e0f9789967`.
A live read-only CIM observation validated the exact guard image hash, exact Node
parent arguments containing the owned native19 reports, Session 1/birth and a
parent chain bounded to eight. It counted zero CMake/MSBuild/cl/mspdbsrv/VCTIP
and one conhost in that chain. These are parent-chain counts, not Job membership.
Native19 completed configure-only in 120,566 ms: effective exit 2, original tool
exit 0 and recorded guard termination reason `timeout`. Actual CMake exited 0 while
the guard waited for descendants. The parent-chain conhost observation supports
the console-host lifetime hypothesis but proves no actual Job member type.
Captured configure output was 672 bytes, SHA-256:
`6562f2d11b974fa01d3a6a6a5dee4c4ea16dc786e88b3d4811acab3010d99ac6`.
Native19 artifact SHA-256:
`5ec597a0b5b48a9964d4ed03f69de1815e9c58396c87b1847424796d0e110671`;
canonical target remains
`6e2a72185297528a7456daf0422fbe0b8f39c43e43bbe25c312f821c033f0f98`.
Actual Job-zero and cleanup were confirmed. The exact native19 task was removed
after artifact/source/ledger/Job-zero, exact XML and zero-instance checks; all
artifacts remain retained. Snapshot20 changes no C++ source. Current source21
changes only the QA-guard child launch from `CREATE_NO_WINDOW` to `DETACHED_PROCESS`
relative to snapshot20. Independent review passed without changing deadlines,
Job-zero or the security/guard contract. Its actual remote update/hash/parser/
census/source verification passed. Source21 native SHA-256:
`1c8ed0f178178758248d1b7e41a9b1dbb798d52846305b374ff84b0ea342b5bd`.
Actual fresh source21 guard bootstrap passed: configure 4,094 ms, compile/tools
8,188 ms and descendant self-test 3,363 ms with confirmed Job-zero. Report SHA-256:
`9efe4835818aef2a78194bc071ae97211bd019dec561f6c88a8d4b93e13380b0`;
new guard SHA-256:
`e236a48181d9c5277e94a9751532a1a56239c596644dd04bb44fcf4c6ab9e33e`;
tools SHA-256:
`5a72d56ec508d60c265a499ae169fc5e06ae4d0de0cdbbce157f129fb088d2b4`.
Raw bootstrap process-tree cleanup is unverified; the guard self-test's Job-zero
is confirmed. Actual native20/source21/new guard completed configure-only in
120,555 ms under limited Session 1 RunLevel0: original tool exit 0, guard reason
`timeout`, effective exit 2. No C++ compile or test coverage was produced. Its
672-byte configure capture SHA-256:
`493d7924e860f418b767a654a80ecedacc51ca1c5c5e3ff2fafccaf28c89cbbd`;
artifact SHA-256:
`6493a3fd01c76f32e4371f1c76678de25f76f23c21f8c9dbe11ea95bac2f789a`;
canonical target SHA-256:
`1fe1805ed74987050f6efd7409cf77453d6cfc407359e60cfdc7da58dce325f8`.
Actual Job-zero and exact task removal were confirmed after source/ledger/artifact/
XML/zero-instance checks; artifacts retained. The detached launch change alone
therefore did not resolve the configure cleanup stall. A bounded diagnostic of
actual owned Job members is prepared for QA only, with no eight-key protocol,
Job, deadline or cap weakening. Local checks passed 98 tests/two files plus pure
formatter cases (two positives/three negatives). Source22 changes only
`qa_tool_guard.cpp`; native SHA-256:
`4af7eb630875d32c2417c2df5ab556d8b3e334dfd13613e1c86ca12fdb5b7461`.
Source22 was then actually updated, with 69-file census, unchanged engine files
and parser zero errors confirmed. It was the then-deployed native source. Fresh
source22 bootstrap passed configure 3,867 ms, compile 8,322 ms and mandatory
positive/timeout/pure self-tests 4,411 ms with confirmed Job-zero. Report SHA-256:
`9556acf078e66e2822b1a461dc4bc565df894371b2aeaaae0ebfc399eda9c97d`;
guard SHA-256:
`74c42f07768622d19e81683b3bcce5e04a3eb3ced55df2ec81fc90eb5b3a5731`;
tools SHA-256:
`ece3c1b96d74ad646a49b8312b92b395424bb8f3bdb92432b5182ea6da5d3c86`.
Raw bootstrap process-tree cleanup remains unverified. Native21/source22 failed
configure-only in 120,575 ms: original tool exit 0, reason `timeout`, effective
exit 2, without C++ prototype compile/tests. Its 961-byte capture SHA-256:
`f701860f02945861ba886fe47f9c7f37e3df22ce92997e2584fa87ff93d1dbfb`;
artifact SHA-256:
`6cb9771aefc63dad32d38ca185250b51189edebdaadbbbed1703ce3fa05a6527`;
canonical target SHA-256:
`c0323b31c008634180cc08687ee7aa2552b559b03c3f4f552b5141c8f123585b`.
Actual owned Job census recorded root signalled/accounting/active/list-read/
assigned/listed/inspected/member-confirmed all 1. The sole remaining active member
was classified by basename `VCTIP_name=1`; all other name counts, unreadable and
nonmember counts were 0. This classification confers no signature, hash or
canonical-path authority. The earlier CIM conhost was parent-chain evidence
outside the owned Job and is not the owned-Job cause. Actual Job-zero and exact
native21 task removal were confirmed after source/artifact/ledger/XML/zero-instance
checks; artifacts retained. The helper prototype remains unused/uncompiled and
production filesystem callers remain unmigrated.

Actual MSVC metadata-v02 passed target parser/self-test and static inspection of
four files after benchmark terminal. All four signatures and exact Microsoft name/
organization checks passed as consistency metadata only, not loaded-code or
thumbprint authority. Listed telemetry environment literals were absent in ASCII/
UTF16; VCTIP/SQM tokens were present and each file had one unknown identifier.
`environmentKnobVerified=false`; no process start, file write or registry read/
mutation occurred. The wrong-path v01 attempt stopped before scanning and its
predecessor is preserved. At that checkpoint, strict owned-helper cleanup was design study; no checkbox was added.

The reversible isolated QA VCTIP retirement candidate is implemented locally;
its native QA guard is compiled/bootstrapped on Windows; exact compiler-helper retirement remains unproven. Stable tools-v2/request-v1/receipt-v1
remain closed. Optional tools-v3 adds exact `compilerTelemetry` policy and emits
request-v2's ninth `compiler_telemetry` only for configure/compile; describe/CTest
stay v1 and invalid v3 has no fallback. The native design must bind the pinned
regular held Microsoft-trusted image plus every remaining owned process handle's
SID/session/birth/Job membership after original tool exit0 before exact retirement;
actual whole-Job-zero remains mandatory. No basename allowlist, ignored child or
unknown/mixed-member exception is permitted. Local TypeScript31 tests/two files,
typecheck/build and three-file lint/format passed; new runner SHA-256
`8d129ce31880c952f97ac2f7f055164fcd47da90a9013b2c956019bc44f43a44`
passed independent peer review for TypeScript protocol wiring only; this proves
no C++ authority or runtime behavior. Source23 actual activation passed:69 exact files, three changes only
(`qa_tool_guard.cpp`, `CMakeLists.txt`, `runner.cjs`), predecessors preserved,
engine files unchanged, PowerShell parser zero errors and runner digest verified.
Native SHA-256:
`6d5d2da365eed095ac0d709ac716c66dcbfc0c0d2d9ccf9debdf78f0727de32b`.
Production `main.cpp`/native tests remain unchanged and uncompiled. Their current
prototype tests preflight ordinary relative create, then mutated-parent relative
containment. Native22 was actually dispatched at about02:57 UTC under limited Session1/
RunLevel0; full configure/compile/CTest and prototype coverage remain pending.
Fresh QA-guard bootstrap passed below; exact tool-helper retirement is unproven. The earlier held-empty SET_REPARSE success
occurred with `FILE_LIST_DIRECTORY` access; that access does not prove in-place
reparse prevention, and the production gap remains open.
Both GPU benchmarks are terminal; no Windows compile overlapped their execution.
A reviewer found a PowerShell TEMP draft scalar-validation loophole from array-LHS
comparisons. Pure `Assert-TelemetryMetadata` now requires `tools.version` int/long,
policy kind/path/SHA strings and bytes int/long. TEMP draft:19,614 bytes, SHA-256
`5a7843c1cfa9d335bd3634cf09b932d6312460165209edfff2f70f2331a1f73b`;
test:3,499 bytes, SHA-256
`e731c3483a91f7d61d6088c1011e72d6e682e21c398d8e38077e553e84e8bb37`.
Actual parser zero errors/pure self-tests (two positives/23 negatives) passed with
no native API, process start or file write. The draft is not activated; its source22/
old runner pins remain historical. Final wrapper23:19,614 bytes, SHA-256
`d941632eae55b4d8fa099fff80a0207bb45399cbb51f0925b5efdef2235dc079`;
its two pure policy-gate functions are byte-identical to the target-tested draft.
Exact source23/target23/new-runner pins passed actual activation. Fresh Windows
source23 bootstrap05 passed: configure3,989 ms/QA-tools compile8,769 ms/guard
self-test4,022 ms, including actual descendant-wait and timeout controls with
confirmed Job-zero. Report SHA-256:
`62e216e684c4640d019193d1f9d2e1d6ebe5106b3811608c020ac7a767f0dc96`;
new guard SHA-256:
`f667d4dd29388eb0d256112e16e277341f719bcfe68f72a238a8301bab00c695`;
tools-v3 SHA-256:
`5e116eba0bff835a0ab4206466d6b8bd07d36f38325b302c8c7e01c66d357eca`.
Raw bootstrap process-tree cleanup is unverified. The self-test proves owned
Job cleanup controls, not actual compiler-helper retirement or production
prototype coverage. Native22 terminated with FAIL in673 ms, runner/wrapper exit2,
`native-build` ledger FAIL/cleanup unconfirmed, fixed code
`ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED`. Artifact SHA-256:
`fc74bf9486324cab758629b328ce28c7ff3a19126c6aa56cbe56f232bb183811`;
canonical target SHA-256:
`68342b07633fefa07f8f6fc540ab53e2b29675cbf19e0c8b1a8310d7326983ff`.
Observation logs were empty; runner stdout606 bytes, SHA-256
`18e5528f17491c84c7362a2faf42db37764513abe854a4a73f73e47350ae9c78`,
stderr0. No CMake/root-child/Job receipt was produced, so no child cleanup or
helper-retirement authority is established. Cause is unknown; cached trust and
directory ACLs are hypotheses only. The exact native22 task and artifacts are
retained because cleanup is unconfirmed. Full native compile/CTest,
compiler-helper retirement, relative prototype and production filesystem
containment proof remain open.

Source24 actual activation passed:69 exact files/two exact changes only
(`qa_tool_guard.cpp`, `runner.cjs`), predecessors preserved, engine files unchanged
and PowerShell parser zero errors. Native source SHA-256:
`93edaeaf5ac71f013e5e572b4a2e767910caf90868c2bd016e5b7b464b3dd4f4`.
The 42,843-byte QA guard source SHA-256 is
`04be5cf27023fde3d939c67a766e0d5fea016c8ff0a53d9fcc694022e09c7b00`.
This change adds only28 fixed phase labels, Job/child creation flags and uint32
WinTrust status diagnostics. The TypeScript collector accepts at most1,024 bytes,
rejects unknown/raw stderr, and leaves every failed cleanup unconfirmed. Scoped
33 tests/two files, typecheck/build, narrow lint/format and diff check passed.
Fresh Windows source24 bootstrap05 passed: configure4,035 ms/QA-tools
compile8,676 ms/self-test4,033 ms, actual guard Job-zero. Report SHA-256:
`34b70693b7b3a8052665a595a128ef98b1ba5687892476c8d53c30593f8fd1db`;
new guard SHA-256:
`33ae118cca1c281bab3f2cc1c44f5b23a42c23b50bdcc6750fe3e121a31aab36`;
tools-v3 SHA-256:
`1ed4ed0f2575fcf8403e2635639b04dbca548bc46ceb6f048244ec360c3c941b`.
Raw bootstrap process-tree cleanup remains unverified. Peer review then found
UTF8 BOM stripping in the new TypeScript diagnostic parser. The fix uses
`ignoreBOM:true` to preserve BOM for anchored rejection, with BOM, collector
exit0/1 and over1,024-byte negatives. Final33 tests/two files, typecheck/build and
narrow lint passed. Source25 actual activation passed:69 exact files, runner-only
change, native digest unchanged from source24, predecessors preserved and parser
zero errors. Final runner SHA-256:
`3c3c5844f6a7229eb6402a3599b9e28139c75d2bc88c705c53a462056cd2b1b8`;
final wrapper25:19,614 bytes, SHA-256
`ac741a227a18f64462c56831985bf65ecd8fca3337058f2c906ff9eb714d48c1`.
Native23 was actually dispatched at03:05:57 UTC under limited Session1/RunLevel0
and terminated FAIL in685 ms, runner/wrapper exit2, native-build FAIL/cleanup
unconfirmed. Artifact SHA-256:
`c8ef1d72fdc0e9c48c666a9ebd4dd71defc0dff27a75ede0cc0277217694e3fe`;
canonical target SHA-256:
`cf2436a90b13897cffef7992c334344d5cb4b303c05cfafa0de836b0b7eba0f2`.
The bounded fixed diagnostic identified configure phase `current-identity`,
`jobCreated=false`, `childCreated=false`, `trustObserved=true`, `trustResult=0`.
Trust passed; no CMake child or Job was created in this run. Those flags establish
no Job-zero certificate and do not retroactively certify native22 cleanup.
At that checkpoint the precise failing token-read API or owner-session/nonadmin
check was unknown; no actual nonadmin-check failure was inferred. Source26 split
these finite diagnostics while preserving controls. Native24/source26 terminated
FAIL in647 ms, runner/wrapper exit2, cleanup unconfirmed; fixed configure phase
`identity-elevation`, `jobCreated=false`, `childCreated=false`, trust observed/status0.
Artifact SHA-256:
`198b1cf42249948bfc1ff2f7a14104e94c4681fed353a782b9937de977bb5fbe`;
canonical target SHA-256:
`dfe78dc2a68d057d945a5d6ae8d7f95e22da11aada3761aa4ffa88125922e7fb`.
No CMake child or Job was created in native24; no actual Job-zero certificate is
established. Exact native22/23/24 tasks and evidence remain retained with cleanup
unconfirmed. These current-run flags establish no earlier cleanup proof.

Source27 changes only the QA guard's token-elevation read to direct typed
`TOKEN_ELEVATION`/`sizeof`/exact returned-length validation, with semantics and all
authority gates unchanged and a mandatory real Win32 identity API self-test.
Native source SHA-256:
`e8aef3edfe175239ebd1cba140e18e80d0d8b5de37e114b5a29f1ae28408e899`;
QA guard source44,082 bytes/SHA-256:
`145056275164e6468e7e1d2223932e3ba49b651932d185dd8c7cb6ba228aec27`.
Actual source27 activation passed:69 exact files/one change, parser zero errors,
predecessors preserved and all engine files unchanged. Source ZIP261,098 bytes/
SHA-256 `fecbe29f31b0e3d2b6e3c68b54707131c8dddc0f47b174f1faca409eced55032`;
input target254 bytes/SHA-256
`9056c3339c89fcf537deed0bf2a9c5c48be95092dca6bb31e62d0ef6137c66ef`;
wrapper27:19,614 bytes/SHA-256
`3d765a5499384c872a3d728fc4461d71bed8c98baecc300618e666a106c1ce21`;
updater27:4,051 bytes/SHA-256
`c0c26685fcb7213d70b0a8206cfa07a6659910ca4afd4abfaa167e9a910dcee2`.
Fresh bootstrap `b8c7b44a-de9f-4cb7-81e3-22c23232dcb9` passed Windows
configure4,008 ms/QA compile9,163 ms/self-test8,696 ms, each exit0, including real
identity APIs and actual owned guard Job-zero controls (`guardOwnedJob0=true`).
Report SHA-256:
`dcfab342c501bbd7d5217d2c781da6e067df17d0d2e93ec1849c9c0d73048811`;
tools-v3 SHA-256:
`d62dcb20bc4044f4713d0dd8018cf238f06dc82171799bf5be7768f183a668ff`;
new guard SHA-256:
`d126aff9fa0a65f459cba70235be139b9af68c67ede472f7d4eae91cacdd4f41`.
Raw bootstrap process-tree cleanup remains unverified. Bootstrap identity/Job
self-tests do not establish limited consumer execution, actual compiler-helper
retirement, production prototype or prior-run cleanup authority. Native25
terminated FAIL in633 ms, runner/wrapper exit2, cleanup unconfirmed. Artifact
SHA-256:
`695a551236822c8e5a7c071a9e5783a1abed6fdc4faec81c9e6431cdc6d27ce7`;
canonical target SHA-256:
`7f703d4a13a1d1a76a3d0a883b11bb9eee1c8e88b70c01005a3d694dc97dcbb2`.
The fixed configure diagnostic was `identity-complete`, `jobCreated=true`,
`childCreated=true`, trust observed/status0; observation logs were empty. The typed
fix passed the current-owner gate and child identity API reads, but the failing
combined child predicate remains unproven. Native25's task/evidence is retained;
no cleanup certificate was produced. Read-only source27/native25 lifetime review
places the identity-complete failure after successful AssignProcessToJobObject
and before ResumeThread. RAII closes the unnamed/noninherited Job with
KILL_ON_JOB_CLOSE set, but this exception path has no explicit TerminateJobObject,
wait or actual Job-zero query; the outer catch reports cleanup unconfirmed.
Source28 retains that lifetime path. Source establishes a kill-on-close request,
not an actual cleanup certificate for native22–25. A source28 candidate will add
four narrow child-predicate phases and correct
the held-tool architecture comparison described below; other gates remain unchanged.
Full native configure/compile/CTest, actual compiler-helper retirement, relative
prototype and production containment proof remain open.
Actual static inspection of the approved CMake (11,307,584 bytes) and CTest
(12,292,672 bytes) images found both PE I386/machine332 and PE32/magic267. These
are build-tool images; product output remains `-A x64`/Hostx64 on native AMD64.
Source28 binds root process architecture to the exact held/hash-verified tool
PE identity, admitting I386/WOW on AMD64 or AMD64/native as appropriate instead
of requiring every approved tool root to be native AMD64. Actual VCTIP members
remain strict native AMD64; all other identity/Job/trust gates remain unchanged.
Source28 was frozen/peer-approved/root-reviewed and actually activated at03:29 UTC:
69 exact files/two allowed changes only (`qa_tool_guard.cpp`, `runner.cjs`), all24
engine files unchanged, predecessors preserved and PowerShell parser zero errors.
Native source SHA-256:
`ab9831c7884f9ffb6f952b0596517211ff7c5a4a8cacf7f945976a4dc3c96a9c`;
QA guard47,241 bytes/SHA-256
`d0b5751f20219e618e8d535d46f19690bc39555e5043da50613de6d02a379810`.
Four closed child-predicate phases are added (40 total); no gate is weakened.
Source ZIP261,731 bytes/SHA-256
`5a0d536f645286981c19f211d43ca56c1b295aa8e49793f6cedbfc860322386e`;
input target254 bytes/SHA-256
`264332bc764d8fe3c8297538ed44fe2764f6964f6cca9c7783d232014d935aa4`;
wrapper28:19,614 bytes/SHA-256
`aa28a217c9c511b9209349fea9af139a8fe558526b560120c1f609f0132d41fe`;
updater28:4,234 bytes/SHA-256
`50262d1a7909da403002493b0e81bcb78117c3bd3c63f70d3fb66ed5373b7ec5`.
New guard pure controls (four positives/14 negatives) and all prior portable
Clang/Werror controls passed. Scoped root33 tests/two files, typecheck/build,
three-file lint and Prettier passed. Actual source28 bootstrap09
`b6815c35-23d2-4032-a701-dad7c63f8cdc` passed: configure4,146 ms/QA compile9,033 ms/
self-test14,563 ms, each exit0 and confirmed owned guard Job-zero. Report SHA-256:
`e41835dae5be128c644ea844efe834b9d53dc7fe6a02fd401bf3cdd714f0c618`;
tools-v3 SHA-256:
`48b67502b045d8817c3992e4c3a50c5a7a8ca77828bf5f5b05e2508a9d84bf5f`;
new guard SHA-256:
`0f996d4647d7a3f2574cdb021be7f0cee1119737b48c42bc8461cdc6bae5fde9`.
The self-test exercised real identity and the guard's own PE/header/process APIs
with expected native matching. It does not prove actual I386 CMake root acceptance.
Raw bootstrap process-tree cleanup remains unverified. Native26 was actually
dispatched at03:29:45 UTC under limited nonadmin Session1/RunLevel0 and passed
source28 native-build and native-security-fixtures in130,595 ms, runner exit0,
both cleanup ledgers confirmed. Shared artifact SHA-256:
`31405eec13fd3a2e64809fc336ee8acd6247ce12eb8beac6eb8cf238edf82733`;
canonical target SHA-256:
`6bc7ec38d5977e6fafe3cc8c0765a3afe9143269fd6c840ba05184a36e757d57`.
All four guard steps (configure/compile/describe/CTest) completed with original
and effective tool exit0 and actual Job-zero. Captured configure724 bytes/SHA-256
`b47e10de6c1a891aed1bdb2855c0f8f6dc89553999b71a6d815faea15391b4ad`;
compile3,846 bytes/SHA-256
`cf03e73499221125a209cf71bb4b3be08dad2d778ddf81d93797196c81ffcce1`;
describe412 bytes/SHA-256
`3b78e7eced2af7b0b608e304487c5bd8222f6773e35746b2a64b83e485f0783c`;
CTest844 bytes/SHA-256
`6facbbd125881f9d5eae9769974588ffa854b8cc17a4c23d007dcaee22bae115`.
Both configure and compile explicitly recorded
`QA tool pinned compiler telemetry retired: count=1`; this is actual bounded
owned-helper retirement with subsequent Job-zero for those two steps. CTest
explicitly passed all4 tests/zero failed. The expanded reparse controls still
observed unheld-empty SET1/error0, nonempty SET0/error145 and held-empty SET1/error0.
Ordinary relative-create preflight assertions passed in that completed fixture;
mutated held-parent relative child creation returned0 with NTSTATUS3221226112
(`0xc0000280`). This establishes the unused helper prototype's containment/error
behavior for that fixture. Production filesystem callers remain unmigrated and
no relative-rename probe was executed, so the production in-place reparse gap
remains open. Native26 actual read-only PE byte audit passed via existing
`inspect-native-pe-v01.ps1`, SHA-256
`d76b1c0c69c66a90aa368dd5239cee91a7daabbfae9fcf6e97109550aedb4f50`:
all8 targets AMD64/PE32+ with `asInvoker`/`uiAccess=false`; all3 production images
have NX/ASLR/high-entropy/CFG header flags. CFG instrumentation, consumer signatures
and Ready remain unverified/false. The exclusive private actual audit artifact
was11,457 bytes/SHA-256
`2165f8d3de21b3741b31dd781e941f6070d2f76b91149167c46f44ed292195d1`.
Its first audit passed; intermediate persistence stopped solely at a null
`LASTEXITCODE` check and created no artifact. A corrected typed status gate then
passed exclusive artifact persistence; this was an artifact-write checker issue.
Native26 `cleanup-native-26.ps1`, SHA-256
`17ab7d564ed51f222751c3d0b209b0fcfc8393cdc979569bac4691016ceeb085`,
passed parser zero errors, actual `ValidateOnly`, exact DeleteTask and bounded
GetTasks absence read-back at03:35 UTC. Exact artifact/target/source/wrapper/XML,
all4 completed step receipts and actual Job-zero were bound; all artifacts are
preserved. Native26's exact task is retired. Native22–25 cleanup stays unconfirmed;
this pass certifies none of those runs. All combined Windows/feature gates and
existing three narrow checkbox rows are preserved; no installed/signed/Ready/
full-product pass is claimed.
The user subsequently authorized the filesystem-containment fix and production-
recipe long tests; signing/runtime inputs remain awaited for installed acceptance.
Fresh SSH inspection at 10:17 UTC confirmed the same Windows build 26200/native
AMD64/RX580/driver 31.0.21925.1001 target. Source29 freezes only the unused retained-
parent rename helper/probe and strict non-POSIX relative create, with no absolute
path fallback; production headers/callers are not migrated. Source review required
unconditional canonical read-back on the failure path; that was repaired before
conditional peer approval. 98 source tests/two files, one portable parser check and
real no-index whitespace validation passed. Native source SHA-256:
`3b58d4d0d3158ac3baca7ffad0699670d21b1a03aa39f003b51fa43d019d8952`;
main.cpp 64,480 bytes/SHA-256
`b42737816cc27ffdda40b8b36ddf6f7eeb034d6a5f3c7425157dae70ef282eb8`;
tests 87,067 bytes/SHA-256
`83c61b7403a8d23263d3cce42429e817676e1ff713e5ecacb2d0dd5c9e58085e`.
The 69-file snapshot had exactly those two deltas, all 24 engine files unchanged,
PowerShell parser zero errors and saved predecessors. Source ZIP 263,758 bytes/
SHA-256 `0050f473e3c520391555d00c679a6fdf12bffc6efc30fab6c2dd91f6347009a5`;
input target 254 bytes/SHA-256
`371bc10ebb1f074a83a00b2c112f76305d33dc7fc7d9a819bed5e2fdf4a2392d`;
wrapper29:19,614 bytes/SHA-256
`7004e96f129f92197bdef592f1a1e7606ae801d2a2203261029c9d605b5de4f2`;
updater29:4,230 bytes/SHA-256
`c05d8ab40892201523d4789db07ebcd3a685a3586197495d77b33874063e04d0`.
Native27 was actually dispatched around 10:30 UTC under nonadmin Session 1 and
terminated in 131,017 ms, runner exit 2/sourceInputsPreserved=true. Native-build
passed and native-security-fixtures failed; both cleanup ledgers were confirmed.
Shared artifact SHA-256
`a90a711f245a380af7b22dcf346f4a949eaadf971a75081e7c5e717f9649363a`;
canonical target SHA-256
`2b425d4a7b92f7d3797de5a8baf2b15474c2d87b0bb0ff460e757ff6c191845a`.
Configure exit 0/log 724 bytes/SHA-256
`818a291b5bd4a35868112e2001b1514a2dc8a95d144cbacc77d60fa0e6f2474f`;
compile exit 0/log 3,846 bytes/SHA-256
`51d57e75098170bd4461323a1eb5e2a3880cb756bc6c553015ebaa2c29ab41d0`;
describe exit 0/log 412 bytes/SHA-256
`3b78e7eced2af7b0b608e304487c5bd8222f6773e35746b2a64b83e485f0783c`;
CTest original/effective exit 8/reason `completed`, log 3,088 bytes/SHA-256
`83247ee27094b75aea85e684aaf5b097d79f732a078fef3721700e4ea7fe1040`;
no failedDiagnostics payload was present. Bounded sanitized projection passed:
strict relative-create rejected the mutated held parent with 0xc0000280, and an
independent held-target missing lookup returned 0xc0000034/Win32 error 2. Ordinary
relative rename returned false/Win32 error 87 at fixture line 216. CTest passed 3/4
(75%); foreign-leaf conflict and the rename-attack cases were not reached. The
reviewed retained-RootDirectory SetFileInformationByHandle rename call failed on
this target with ERROR_INVALID_PARAMETER; there is no rename-containment pass.
At the source29 checkpoint, the source30 direct NtSetInformationFile candidate
was frozen with peer review/native tests pending; no source30 pass was available
then. Production headers/callers were still unmigrated. Native27's exact task retirement passed around 10:43 UTC
through the 3,231-byte temporary cleanup helper, SHA-256
`c629bd3e1144096ae76b0851009bb2d5c103a352f51a02d9037552a1d2a8f2cb`:
actual pin/PowerShell parser zero errors/`ValidateOnly` passed, then actual exact
`MMQA6ec8a1a8-native-native-27` retirement passed. Exact XML/Session 1/RunLevel 0/
zero instances and prior actual Job-zero/artifact/log/wrapper pins were checked;
exactTaskRemoved=true/actualJobZeroConfirmed=true/artifactPinVerified=true/
artifactsPreserved=true. All artifacts are retained. Earlier native22–25 cleanup/
task uncertainties remain unchanged; native27 supplies no retroactive proof.
Source30's unused direct NtSetInformationFile prototype subsequently passed
native28; peer review approved its exact two main/tests pins, and 98 local Vitest
tests/two files plus one portable check passed. Native source SHA-256
`3e839a15b11ddeadc65cc411d471e4c1934655af51ddf48f6d33a13cf9c1372a`;
source ZIP 264,080 bytes/SHA-256
`4f760996352284846857d64ee3203bbc3f6a4d041b459799979b119a3f7525fe`;
input target 254 bytes/SHA-256
`c6d07c6a1abaf5356af984a446aae2181dc56240ff7b829c91018ade24f2ecb4`;
wrapper30:19,614 bytes/SHA-256
`3c9961e60b58498c0b3046db84c88c9a363f494224983c4c6f34d92d3f50dfa5`;
updater30:4,230 bytes/SHA-256
`cbd956dad02a2b8b4bd202096b8729141720f00200e4810510324ab0ab374100`.
The 69-member snapshot contained exactly two main/tests deltas with all 24 engine
files unchanged and source29 predecessors saved. Native28 actually passed in
123,723 ms/runner 0/sourceInputsPreserved=true, with native-build and native-security-
fixtures passed and both cleanup ledgers confirmed. Shared artifact SHA-256
`11e6502220ff8a0f75b9153e8e5a3b447d295edc89af5a81feac96dbe2f48290`;
canonical target artifact SHA-256
`b49d67f3971a3329e420468041db910ff08347ab10dfe0bcd251a56c9eba13d9`.
All four configure/compile/describe/CTest tools completed with exit 0. CTest log
844 bytes/SHA-256
`f0554eb5ee6f2d56a1d947aecbe778fbe11764a8b7c173e71790c77495a263b3`
passed 4/4 tests. The completed fixture asserts strict relative create, ordinary
relative NtSetInformationFile rename, no-replace foreign-leaf conflict, and the
held-junction attack with source identity/hash, sentinel integrity, independent
missing-target lookup and restoration. Exact native28 task retirement passed
around 10:46 UTC using the 3,230-byte cleanup helper, SHA-256
`9177b333bb3405e11f216d4c3c0ce116a564d84451a11c658c24f3cb3104e81b`:
actual pin/parser zero errors/`ValidateOnly`, then actual retirement after actual
Job-zero/artifact pins/XML/zero instances/bounded task-absence checks; all artifacts
are preserved. This remains an unused prototype with zero production callers in
the source30 snapshot. At that checkpoint production main/tests/16-header migration
had started with final review/compilation/native retest pending. Source31's later
19-file activation, native29 failure and source32/native30 are recorded next;
source30's unused
prototype does not establish production containment. Earlier native22–25 cleanup
remains unconfirmed.
Source31's production native migration passed independent review for 19 changed
files: central retained-parent opens/inventory/absence and immutable vault
replacement recovery, 16 caller headers plus launcher, private Library parent
provenance/exact absence, and held-age legacy cleanup with stale-inventory/fresh/
future fixtures. Local source checks passed 98 Vitest tests/two files and the
portable parser one check. Actual source31 activation passed the exact 19-file
change census with all 24 engine files unchanged; native source SHA-256
`023488725d003a485a6fcd1e7a3b18367f17c1a0ec20ffb82ed0743a10292f17`.
ZIP31:274,547 bytes/SHA-256
`b631bbfcd196c7cde7535b05857a9ba4697592deb7733a37c02a4595c10e3b72`;
input target31:254 bytes/SHA-256
`19906836abe5eb7aa628b65fea5e6cfec686c201eb4489c8b9a4747bd8e8a94f`;
wrapper31:19,614 bytes/SHA-256
`3979fae97cac2f41f86a27d8fe6b8b7bb3c386f604e9f046c235db914ad270aa`;
updater31:7,468 bytes/SHA-256
`3dee8b6d24322dea5b5fa7668f1787ee4124e94e6953b3f6e773210c494e958f`.
Guarded native29 was actually dispatched around 11:32–11:33 UTC under limited
Session 1 using those source/wrapper pins. It failed compile-only after 306,445 ms.
Configure completed original/effective exit 0; log 724 bytes/SHA-256
`c6610201283155f6cce54cff31bc17aaeb72c0375c980ef337069565d9f225a3`.
Compile returned original exit 1/effective exit 2 with guard reason `timeout`;
log 31,425 bytes/SHA-256
`0e61cbd687b25dc7cd072fa27d441cbfb11b68d2597a43e96b273c61bef746a8`.
Neither descriptor nor CTest ran. The pinned bounded compiler diagnosis located
library_cleanup.hpp line 55/column 42: C2220 plus C4456, declaration `separator`
hides the earlier local. No other error was present in the bounded reviewed
source diagnostics; that projection does not establish the guard timeout/stall
cause. The native-build case failed with cleanup confirmed/actual owned Job-zero.
Shared artifact SHA-256
`e0d4ec34ce58770b717cdb6a57813c5bf5f1eb24be62f7b9e7aae5e2c3791a12`;
target artifact SHA-256
`59b249e956d40d599743d0ff62166a106a87d3113c486a7dbaf6f82117f99754`.
Exact native29 task retirement passed around 11:41 UTC through the pinned
cleanup-native-29.ps1, 2,922 bytes/SHA-256
`4d8234daf2fa591e4659ec13f3f2bddb0bdfa8f605285d30ab9941440be0f4fc`:
`ValidateOnly` then actual retirement after pin/parser-zero/XML/zero-instance/
bounded absence checks. Artifacts remain preserved. This run establishes no
production native security/CTest pass and does not certify native22–25 cleanup.
The source32 correction only renames that outer local to `baseSeparator`, with
no behavior change. Actual target activation passed exactly one library-header
delta versus source31, all 24 engine files unchanged, parser-zero and predecessor
preservation. Native source32 SHA-256
`35110d63a8eb099325620e6eaa2729b65855ef7192475ea87798958b483d8064`.
ZIP32:274,555 bytes/SHA-256
`aa1f63b8aa94d8ccb719b05169b2c61056d358a3139e515eccbf2a116d3c958c`;
input target32:254 bytes/SHA-256
`3946206b25a6a28f3eb0e36a6896e181d5c5d98148a942a8301275e7b6b236fc`;
wrapper32:19,614 bytes/SHA-256
`512f304dd6ca82250a44e5543bd1f98b9ba2c927a7dabc94334f121eb754993c`;
updater32:4,053 bytes/SHA-256
`0f5b38842503b1de76849868ae385068e6b2715bb8c1caa02ab261a69f6a1e23`.
Worker `tsc --noEmit` passed as a source check. Guarded native30/source32 was
actually dispatched around 11:41–11:42 UTC under limited Session 1/RunLevel 0.
It failed compile-only after 306,645 ms with source inputs preserved and actual
owned Job-zero. Configure completed original/effective exit 0; log 724 bytes/
SHA-256 `00bca7fe68b4c2f888d67bd71c2f078576b62f1d7dcdd280f3bbb5755234579b`.
Compile original exit 1/effective exit 2/guard reason `timeout`; log 28,811 bytes/
SHA-256 `b4778a3ff8c5c6a96cce5a357cbc82f45010c40918059e0b960c211d1881fde1`.
No descriptor or CTest ran. Bounded diagnostics reported C2220 and STL C4244,
int-to-unsigned-char from `const _Ty=int`; no source callpoint was exported or
verified by that diagnostic. It does not establish the guard timeout/stall cause.
Shared artifact SHA-256
`e2a53ab3cb97bcf479dff178b985ca68763ae500df08a8eab4ac01133c1abbc1`;
target artifact SHA-256
`4b14a58c0c27036165dffe962c06af7cad1b5a60d70f88fd0bc70ed1bfb9c8d0`.
Exact native30 task retirement actually passed around 11:50 UTC through the pinned
2,922-byte helper/SHA-256
`2995bafd0d8940f401df81073602aafa361827f8fdffafb0e92e3f2b4c181508`:
pin/parser-zero/`ValidateOnly` then actual XML/zero-instance/bounded absence checks;
artifacts retained. This does not certify the earlier native22–25 uncertain cleanup.
Independent source inspection corrected enumerateNativeDirectory's
`std::fill(buffer.begin(), buffer.end(), 0)` to `BYTE{0}`, eliminating the inferred
int fill. Its actual Windows result was unproved at that source-only checkpoint;
native31 subsequently compiled all targets but failed a security fixture below.
Main:83,732 bytes/SHA-256
`b3414f429e9bb3b816e912d5f9fee8594166ae05e9f9dc363b58c099e544abeb`;
tests remain unchanged at 108,903 bytes/SHA-256
`ddb46a4c4427bfcb4812d2c4df3548319fc9ee2c180966fd4180ffbfe14b9cd8`.
Actual source33 activation passed exactly one main-file typed-zero delta versus
source32, all 24 engine files unchanged, parser-zero and predecessor preservation.
Native source33 SHA-256
`590613edaa515ad88127579b5f60210a0b39a38113800e7574523701723a69c8`.
ZIP33:274,559 bytes/SHA-256
`83fa5d89b427cb7a0a4ada9b5ad5cea2202628542175be59576541d1236c808b`;
input target33:254 bytes/SHA-256
`e61ef646b3ebf954ce867ec0be52ca7c3136cbc03e39e6eba4220313d0ea7be3`;
wrapper33:19,614 bytes/SHA-256
`7287349d74592cc7cf6de0722e700174a71c27b455a195159fe1337796a0a096`;
updater33:4,042 bytes/SHA-256
`bece5b62899f831591b16f7adc22ce30d925338e478231d6e757abbbcc56666b`.
At source33's activation checkpoint native31 had not yet been dispatched. It was
subsequently actually dispatched at 11:56:50 UTC under limited Session 1/RunLevel 0,
using source33, and completed in 132,312 ms. Native-build passed all eight targets
and target description passed. Native-security-fixtures failed with CTest exit 8:
75% passed/one of four cases failed. Both case ledgers confirmed cleanup with actual
owned Job-zero. Shared artifact SHA-256
`da6b3030d61285596b35cb8fcc8feb519102804c604303ac4b7920f7e68c7a20`;
target artifact SHA-256
`0b20fbccd4e39e65a15387a5aa7761f985ca9e37cad7e6b58db944b0cfe7f644`.
Configure log:724 bytes/SHA-256
`6983d58e84713f35d2295eb58cb0d6ae9735a638a3002e314cba75e890a2310d`;
compile log:3,846 bytes/SHA-256
`66679ca4c7762e27992db8fe407c9f9319773b7c01223b4373493fa0020d32d1`;
describe log:412 bytes/SHA-256
`3b78e7eced2af7b0b608e304487c5bd8222f6773e35746b2a64b83e485f0783c`;
CTest log:1,524 bytes/SHA-256
`c518e25bd4f792ec8f043a13b7d7ab1575feda479ad3129657989206bd312bdc`.
The exact sanitized diagnosis identified assertion line 405 after
`browser-pending-retirement`; the source cause is not established by that line
projection. Native31's exact task retirement actually passed around 12:04 UTC:
cleanup-native-31.ps1 3,231 bytes/SHA-256
`637e6b07f961664b94e13b29d08a0117a9a7a113c4f6859512d9b0d35d192a19`.
Actual remote hash/parser-zero/`ValidateOnly` then exact XML/Session 1/RunLevel 0/
zero task instances/all artifact and log pins/actual Job-zero/exact task-absence
checks passed; artifacts are preserved. Independent source review identified
that delete-pending NTSTATUS threw the wrong error. At that checkpoint a correction
and focused status fixture were in progress, with the browser assertion unchanged.
This remains an actual production native build pass and an actual security-fixture
failure, with no full production containment/security pass or earlier native22–25
cleanup certification.
Source34's delete-pending repair was then frozen/independently approved and actually
activated around 12:08 UTC. Exact STATUS_DELETE_PENDING (`0xc0000056`) returns false
and is never classified as absence. The focused fixture covers the pending reader,
no-replace operation, source identity and missing-after-close; the original browser
assertions remain unchanged. Native32/source34 was actually dispatched at 12:10:35
UTC under limited Session 1/RunLevel 0 with pinned wrapper SHA-256 `4fca57289c426730d3f482c7afcb55f09f9df7d3447835bad2bb2d3100b63495`.
Its later actual build/security results and exact task retirement are recorded
below. Local owner source
checks passed 98 tests/two files plus portable JSON one check. Actual remote four
pins/parser-zero/activation passed exactly two main/tests changes versus source33,
with all engine/runner files unchanged and predecessors preserved.
Native source34 SHA-256
`55d4de7302b698b6c60965dd24ca14b78eb9a1f7d0dbad032c9af6b48ab48c47`.
Main:83,903 bytes/SHA-256
`4e092088716010d77c828f1c0058ac35c58276f738090333e6d4ce755bd30936`;
tests:111,964 bytes/SHA-256
`4590e2e0cfda5ea8a1ed296cd3da16aec291a68473ec1ebf5b2493ef6c8fde15`.
ZIP34:275,119 bytes/SHA-256
`a8913126b47d954a190bda151a8c91a422cae08c05ba9745a6023ca8862ad347`;
input target34:254 bytes/SHA-256
`d2b0b19aa45c019c3903d627da1ad5ab1df73717897e2c08963890a7f569612e`;
wrapper34:19,614 bytes/SHA-256
`4fca57289c426730d3f482c7afcb55f09f9df7d3447835bad2bb2d3100b63495`;
updater34:4,230 bytes/SHA-256
`1ed47fc15e89ed3b139cf16e599a237af1a6b2dfcc735a93177e3ac71c241968`.
Native32 actually completed in 139,103 ms: all eight build targets and description
passed, but security fixtures failed CTest exit 8/three of four passed. Both case
ledgers confirmed actual owned Job-zero. Shared artifact SHA-256
`c8e7b714a3c4fabc1041c33877e400e83d006f454a1b01ea680f5c3c9dfffa00`;
target artifact SHA-256
`21dfe2c91651db4a63f966e9227cc7bded84bd1850f25d7d2c25bd9387b3df04`.
Configure log:724 bytes/SHA-256
`d49bc0711f3bf9ff7c5ef66a048a5e6b5b694dd95f32fb8157d4526a3b1648dc`;
compile log:3,846 bytes/SHA-256
`1dc3ad6b4d881356684ccc75a1afefee3c5f43a6b3d139f8ddd6be1a8b7a089a`;
describe log:412 bytes/SHA-256
`3b78e7eced2af7b0b608e304487c5bd8222f6773e35746b2a64b83e485f0783c`;
CTest log:2,772 bytes/SHA-256
`8b20a3733117faf00f728a21ed5830a9365979c9f6e2c6bfcf9f961f42289f07`.
The bounded projection proves the new pending-status observation 3,221,225,558 =
`0xc0000056`/Win32 error 5 and the entire browser sequence through cleanup passed.
Central paths and vault replacement then proceeded; an uncaught `PATH_UNSAFE`
occurred at `vault-legacy-staging-policy` before the stale-inventory checkpoint.
This establishes the pending-status/browser repair on Windows, but the later
security fixture remains failed. Source review identifies missing
`FILE_READ_ATTRIBUTES` on timestamp-only opens before an unconditional metadata
query as a candidate cause at that checkpoint. Source35's narrowly reviewed repair
and actual native33 retest are recorded next; the native32 failure remains failed.
Exact native32 task retirement actually passed around 12:17 UTC using the pinned
3,231-byte cleanup helper/SHA-256
`2671c3b0180d29264c0c9faf2ceccd700ae2fd973987e6368142541bf5702d06`:
pin/parser-zero/`ValidateOnly` then actual run-bound retirement, with all artifacts
retained. Native32 confirms no earlier native22–25 cleanup. At that checkpoint full
native security/whole-app containment and capability follow-on remained open;
source/activation and those partial fixture passes did not close them.
Source35 was frozen and independently reviewed from the exact source34/35 archives:
69 members unchanged in name, exactly main/tests changed, both byte/hash pins
matched. Main adds only `FILE_READ_ATTRIBUTES` beside mandatory `SYNCHRONIZE` plus
two comments, because the helper unconditionally reads metadata. Retained-parent
resolution, reparse/type/single-link checks, status handling, sharing, security
descriptor and ACL validation are unchanged. Tests add only six safe legacy
checkpoints; WRITE_ATTRIBUTES-only caller requests and every assertion remain
unchanged. The required access request does not grant ACL permission. Local owner
checks passed 98 tests/two files plus portable JSON one check; independent review
ran no additional code/native tests.
Actual source35 activation passed around 12:21 UTC: four target pins/two parser-
zero checks, exactly two source changes, engine unchanged and predecessors
preserved. Native source35 SHA-256
`7f4db86d344f0007e1e4e26fc737c20e62be6a95730d70343810de9b7faebf9a`.
Main:84,066 bytes/SHA-256
`8fd969d497e067d095bd3f6cb20e7788f9f66d01a881acdc9f03a19beed6f85a`;
tests:112,211 bytes/SHA-256
`82d86c2d4984ab05237ca98e6586b1ce4b288177f0e92c6e146695f6313c49a4`.
ZIP35:275,235 bytes/SHA-256
`8b6866d821bce5ca52d9de8a0f649dc5dc8954d11427714a9c63e6aa28c6187b`;
input target35:254 bytes/SHA-256
`ec1342bb604671269a0e21f6544184bc04c016d967fd9d5cd3b8fa83f8123c8d`;
wrapper35:19,614 bytes/SHA-256
`7cec5f8de5868fcd06c2ba5b83d1ccca547b9e733847fd2301cf72fbbc905951`;
updater35:4,230 bytes/SHA-256
`30e2b68edf4ea5bc820197271e421c6d6ce4f5aeccc3d0786241b2d83334e573`.
Native33/source35 actually dispatched at 12:22:20 UTC under limited Session 1/
RunLevel 0 and was observed completed at 12:25:12 UTC: runner 0/134,961 ms/
source inputs preserved, all eight build targets and description passed, all four
CTests passed. Both native-build/native-security fixture cases confirmed cleanup
with actual owned Job-zero. Shared artifact SHA-256
`0ae9b2ca79890ac55f1ac826704707c56e2565638d54544a14d139235eff398f`;
target artifact SHA-256
`00973e48ac0674964b795cab7dcaaacdd813711c38dd8e7bbf95e5c5751877dd`.
All four configure/compile/describe/CTest tools completed original/effective exit 0.
Configure log:724 bytes/SHA-256
`9d484d25c18feb8132cc48a05b61e65f53f1b4b766e9b38de5c0635bc7373996`;
compile log:3,846 bytes/SHA-256
`d5a84f2a2704815d6396518dbd68ea89ac257b915b4ae4fbf70806597c6be534`;
describe log:412 bytes/SHA-256
`3b78e7eced2af7b0b608e304487c5bd8222f6773e35746b2a64b83e485f0783c`;
CTest log:844 bytes/SHA-256
`c19caf8f346750b294cdb8e4a9bb3a98c1aa0110276080da3fd095ebd8bf6813`.
Exact native33 task retirement passed at 12:31:04 UTC using the pinned 3,230-byte
cleanup helper/SHA-256
`ab394e4e8b6d8f5d12085509b9b4f1d182a9470d45be7972d4ed3476c989cbc9`:
pin/parser-zero/`ValidateOnly` then actual all source/artifact/log/wrapper/task
bindings and actual Job-zero/exact task absence; all artifacts are preserved.
This establishes source35's isolated native build/security suite and metadata-
access repair, with no retrospective native22–25 cleanup certification.
At the source35 checkpoint the additive native `private_file_*` token core,
TypeScript private-file bridge and root atomic lock-read migration were outside
that snapshot and had no actual target proof. Source36 subsequently froze the
additive native token core only. Independent read-only archive review verified
69 exact members/three changed sources (main/tests/README), all 24 engine files
and frozen acceptance runner unchanged, and the independently recomputed 43-source
digest. All preexisting source35 main/tests fixes and assertions remained byte-
identical after removing the additive token code/dispatch/new fixture calls.
Reviewed gates include personal-only root/closed schemas/16 random lifetime tokens,
retained ancestors and exact leaf with canonical/type/reparse/single-link/private
ACL checks, 4-GiB capacities/24,576-byte I/O spans, exact two resume paths/birth before
mutation, raw ancestor volume/file-index/creation FILETIME witnesses permitting
zero/pre-1970 values, unchanged leaf/resume Node identities, canonical base64 only
for new writes, and close success only after all retained handles close. No new
fixture target result was available at that review checkpoint; the actual native34
failure is recorded below.
Actual source36 activation passed at 12:53:34 UTC: three source changes, engine
unchanged, parser-zero and predecessor preservation. Native source36 SHA-256
`3aefdef44005f887e8153e1729649a8c4421b76c6ef2367e7bf9b9273c287e4d`.
Main:94,576 bytes/SHA-256
`c4ca521803f166e145c75a1ef98cb18add38c0011ffb8be9f4fc98ec908a442f`;
tests:127,635 bytes/SHA-256
`e258ee4b4496b3a4144822678a575b241746524e7e69c818fafae1952d952713`;
README:25,281 bytes/SHA-256
`e4769de4cd46adc42ca4ec8e9b99bed80a0dd0e067b011394b6d8a5904d1f591`.
ZIP36:282,361 bytes/SHA-256
`a029fade0d53c70fe18b209302001b52052c5f03e84b6403a33fbfaff009a0f3`;
input target36:254 bytes/SHA-256
`40e0e439239eb29598a2673feeaac6d65e870cc0d57bfb9d814b5683a0aca042`;
wrapper36:19,614 bytes/SHA-256
`8b4b1a0251cb464a416582513a31e1f9add2810ba60a92ed9440bfd1ac476a87`;
updater36:4,411 bytes/SHA-256
`9fac145013db7584559fb2aacb587aa3c0c1f53e97220d0f63e4f5c79559e961`.
The reviewed updater pins exact old35 main/tests/README/target/wrapper inputs,
requires only those three deltas/69 members, preserves predecessors without
replacement and checks the intended PowerShell parser/source-digest gates.
Native34 was actually dispatched as exact task
`MMQA6ec8a1a8-native-native-34` under limited Session 1/RunLevel 0 using source36.
No exact dispatch UTC is recorded from an approximate root clock. Native34 actually
failed in 125,230 ms/runner exit 2/source inputs preserved: native-build passed,
native-security fixtures failed, with both case cleanup ledgers confirmed.
Shared artifact SHA-256
`c87bc558c66185f1acc160bfb96cf8309f954d465dbf47f7895f28cb9aa7a4a8`;
target artifact SHA-256
`1a3a370a3d4f7aa21f78b7fb6fb6427c852acbb2f9c7118a1b18c6792453e21e`.
Configure completed original/effective exit 0, log 724 bytes/SHA-256
`617531189a08e83155a8f2d95b77e3bcb88f965f3ba9e9cf87d2bbb99169c618`;
compile completed original/effective exit 0, log 3,846 bytes/SHA-256
`035ce9c63a0a2d960f170c00f5201e53805127f30bbd3cf7ea26861a0da7a288`;
describe completed original/effective exit 0, log 412 bytes/SHA-256
`3b78e7eced2af7b0b608e304487c5bd8222f6773e35746b2a64b83e485f0783c`;
CTest completed original/effective exit 8, log 1,350 bytes/SHA-256
`9b2068a174370bc4ef7d8e0e08c48c2c22652e072ed21427f5318d38001e11c9`.
No failed-tool diagnostics were recorded. The pinned bounded diagnosis reached
`private-file-capability-io` and `private-file-exclusive-fences`, then failed
assertion line 383 with safe code `NATIVE_TEST_FAILED`; scratch was retained.
CTest passed 75%/three of four, with one failed case. The native owner is studying
the source cause at that checkpoint. A later actual pinned/parser-validated v02
leaf inspector passed: helper 3,616 bytes/SHA-256
`3b930a1491d54958ad1ddda2f8669f6038c13a22c1dba8b5e2d6f852b7b1f7cc`.
It found exactly one run-window scratch candidate, originalExists=true/
renamedExists=false/linkedExists=true/originalnlinks=2/linkedIsExactOriginal=true.
This confirms assertion383 was an unsupported hardlink-creation-denial expectation.
The initial inline command was rejected for length before execution. Inspector
v01 (3,452 bytes) then failed before metadata because its root literal was `personal`
rather than the actual `MusicMuteLocal`; that failed predecessor is retained.
V02 changes only two relative root labels and a safe outer catch, projects only
metadata flags/counts, exports no paths, reads no media/fixture content and writes
no fixture/media files.
Source37 was rejected locally before upload: fixture alias cleanup used a
check-then-absolute-delete after releasing retained handles. Its frozen predecessor
is preserved, unuploaded/unactivated. Source38 was built from actual source36,
changing only tests to retire the owned alias through a checked retained handle;
production main/README and I/O policy remain unchanged.
Single-link validation before/after I/O detects aliases; it does not prove alias
creation between checks is atomically impossible. The reviewed cleanup-native-34.ps1 is
3,231 bytes/SHA-256
`446d883db44b50ae7ff37ef5c04918667dfe65b8563c0ea4e9d51f3b5bc66d01`;
read-only review approved its exact run/source/artifact/target/four-log/wrapper/
case/XML/Session1RunLevel0/zero-instance/fixed-task-delete/artifact-preservation
bindings. At that review checkpoint no actual retirement was claimed. Actual
helper pin/parser-zero/`ValidateOnly` and exact task retirement subsequently passed
at 13:03:58 UTC: taskRetired/exactTaskRemoved/actualJobZeroConfirmed/artifactPinVerified/
artifactsPreserved all true. No scratch was deleted. Source36/native34 remains
failed; positive run-bound cleanup does not promote its capability fixture or
certify native22–25 cleanup. Activation/source review/compilation establish no
capability-fixture or whole-app containment pass.

Source38 independently passed frozen-cohort review and actual activation at
13:22:20 UTC: 69 members, exactly one tests-file delta, predecessor preservation,
parser-zero and unchanged 24 engine files/frozen acceptance runner. Native43 digest:
`9ef0018f7b335e0b5a9ddc6bb4c85e2d16aa288f8ffdfc0268aca549ff22635e`.
Tests:133,316 bytes/SHA-256
`71b007199380e7126810aaba85a40d26bf7f4b6574b55e313da54680366f1caa`.
ZIP38:283,660 bytes/SHA-256
`bb6096dc1064097bcf30d7e935c78f8d7af56bdf49569f75e9d96da7fd79db10`;
input target38:254 bytes/SHA-256
`f320cceda8bc4c214978fb3cb4ac6b583af1568935861fdd7296a9b9ba2e1407`;
wrapper38:19,614 bytes/SHA-256
`802adce1a43eeee4f0bf0286c4ea07ca22f47ede5631704f416b9b4246e5086e`;
updater38:4,050 bytes/SHA-256
`720f18e2a915501db14d0da4690f6a417256f8875f2b806dfa7ab8d54721edda`.
Actual native35 under limited Session1/RunLevel0 passed in 135,334 ms/runner0,
inputs preserved: all eight build targets, description and all four CTests.
Both cases passed/cleanup confirmed; all four tools completed original/effective0,
with no failed-tool diagnostics. Shared artifact SHA-256
`e8b55152b36c6d6ffc5aa63b1a22706f3a67e6ef21fc54f376765edb75fc4c95`;
target artifact SHA-256
`0780fc2363463e1790291a4df63dfb6e009b114fb069fbccaf8ffa1ca4f576dc`.
The passing fixture preserves rename/delete/writer denials, accepts actual exact-
original two-link creation, then rejects all five capability operations with
`PATH_UNSAFE`. Positive token close precedes alias retirement using a fixed leaf,
held relative parent, checked raw identity/birth/type/count/private ACL/canonical
path and same-handle disposition/positive close. The metadata witness remains held
through retirement, then closes positively before relative absence and unchanged
original whole-hash/birth/bytes checks. The unheld hardlink control remains.
This detects aliases without proving atomic alias-creation prevention.
The exact native35 task retired at 13:28:10 UTC after pinned/parser-zero
cleanup-native-35.ps1, `ValidateOnly`, exact XML/Session1/RunLevel0/zero-instance/
artifact-log-source-wrapper binding and bounded task-absence read-back. Helper:
3,230 bytes/SHA-256
`19302cae5efe71c62a41e1d4792a16739a20ae5053c7f46f24556c21931e2f79`.
Artifact pin/actual Job-zero/exact task removal/artifacts preserved all true.
This isolated native suite does not certify earlier native22–25 cleanup, live TS
bridge/cloud transfers, signing/installed consumer journeys or whole-app handoffs.

Separately, TypeScript v01 local source checks passed worker Windows suites
215 tests/14 files and desktop 2,161 tests/233 physical files. Both components'
typecheck/lint/build/scoped format passed. Retained lock/copy-reader source checks
passed 21 tests/two suites, included in the full desktop 2,161. A semantic-open
resource-lifecycle gap was then found. The subsequent v02 correction is frozen in
manifest-v02.json: private-file core 12,741 bytes/SHA-256
`50e47d95704ae7b6d84329934f84c47ee48d81e7cb0b61b72f319cd58de38747`;
focused test 18,851 bytes/SHA-256
`338d36783c8138a5367054aa1400e6b3361f8c81a665072aba8695502927f0c2`.
Actual v02 local worker focused checks passed 118 tests/three files plus typecheck/
lint/build/format; desktop affected checks passed 140 tests/13 files plus typecheck/
lint/build. Root package fixtures passed five tests. The historical v01 worker
215/14 and desktop 2,161/233 whole runs remain separately attributed; neither had
been repeated at the v02 checkpoint after those two core/test changes. V02 awaits helper teardown for
malformed/uncertain opens, without replay or arbitrary-token cleanup, surfaces
teardown failure, and snapshots birth before awaiting. Local real-child-close-
event-before-rejection and sibling-poisoning fixtures passed. Those are local
transport/source checks, not actual Windows capability execution or full app
containment. The TypeScript bridge/root lock-read work remains absent from source36.
Node mutation/publication/metadata/rename/handoff and WinRT/NSIS receiving paths
remain open. Neither source35's native suite nor source36 review/activation/local
TS checks closes a combined user journey/index checkbox or establishes whole-app
filesystem containment.

TSv03 migrated the private upload source across all three callers. Its local
2,182/233 desktop and focused67/5 passes remain historical: independent review
found that early2xx headers could resolve fetch before source EOF, hiding a late
reader error or truncating the source during final stream destruction.
[Node24.18's bundled Undici source](https://raw.githubusercontent.com/nodejs/node/v24.18.0/deps/undici/src/lib/web/fetch/index.js)
separates response-header resolution from request-body iteration.
The independently approved final v04 repair requires metered natural EOF and exact
source bytes before non412 success, bounded by the existing 120-second signal.
It preserves early412 handling, checks account/session after body completion and
final identity read-back, observes late failures, destroys the stream and awaits
reader close.
The local actual Node24.18 loopback early201 test acknowledged the complete source
and teardown; four epoch-only account/session failure cases also passed. These are
local synthetic fixtures, not live Windows bridge/R2 acceptance.
Final desktop checks passed 2,193/2,193 tests in 233 physical files and focused78/5,
with zero failed/skipped; typecheck/lint/build/scoped format and final-build package
fixtures5/5 passed. Final worker v02 focused118/3/typecheck/lint/build/format remains
separate from the historical v01 broad215/14 run. Manifest-v04.json preserves
v01–v03 predecessors and all 38 current source/test pins matched:11,082 bytes/SHA-256
`9ac3c31e585f5660bea5a6de6dfe59c7263d3c5ddc69725a5df3365c20258767`.
Final transfers.ts:9,402 bytes/SHA-256
`e1cc97815c5493b32b3d79eb1e8266322cca6cd93b05f9b585f9e8ac8613addc`;
cloud-transfers.test.ts:26,274 bytes/SHA-256
`e77eb45c4e9710c232076f4c625e1a1d807c336fc9b0a6db8d250011417f7c99`.
Native/engine files are unchanged by v04. Preparation resume/publication,
metadata/mutation/rename/process handoffs, WinRT/NSIS, signed installation,
account/shared Chrome/worker, physical Windows10 and all broad journeys remain open.
No new target or combined-checklist pass follows from these local source checks.

Node/WinRT/NSIS and process handoffs remain separate receiving-path gaps, so even
a later native migration pass must not establish whole-app filesystem containment.
The v10 QA production-functional cohort was frozen and independently reviewed
across core/PowerShell inspector/read-back/dispatcher/cleanup. Pins file
engine-pins-10.json 2,027 bytes/SHA-256
`395382c0512d7fcbfb6857d9b3db0adf949fc05ef83e9272ba469e14a2c8c6f3`;
wrapper 14,526 bytes/SHA-256
`89d6919e5d8d7d171a97f560191bc9343d5b7827b1c4dd16580982ec4ae1f01c`;
child 49,079 bytes/SHA-256
`1897bcd97cc065fbd2dc3e3df61eacc0a9d6240eb0e6bec7fb47ff77f8170936`;
controller 36,287 bytes/SHA-256
`28450fb03a8b921c9042d033fa17867c104aa6ff0d88a146722f579515635fbd`.
Initial activation helper 11,766 bytes/SHA-256
`fed640d29b668569f8cbfac6acbf0c3e60b82104ee7c984b7aa4e7f81aeed609`
was rejected before upload because its expected alias size 14,232 differed from
the new 14,526 bytes. The one-line immutable correction
activate-engine-qa-v10-v02.ps1 11,766 bytes/SHA-256
`ef1c41be942463a03ab4be0a4e77d37bb2d010aea29844d3218b8a330de3a362`
passed review. Actual 16 transferred inputs/pins and all PowerShell parser-zero
checks passed. Target pure controls passed: functional 12 positives/106 negatives,
audio 7/25, cleanup 10/44, qualification 9/8 and benchmark 7/38. The correctly bounded
long-QA prefix had zero engine tasks before activation, with alias v09 verified.
Actual v10 activation passed `ValidateOnly` then activation around 10:54 UTC,
verified 15 dependencies/preserved v09/overwrite=false; activation ran no inference.
Actual pinned Python 3.12 `-I -B -S` pure guard 7/28, observer 10/30 and production-
recorder 14/43 passed, with no engine imports, inference, native calls or processes
in those tests. Functional-01 was dispatched around 10:54 UTC under limited
Session 1/RunLevel 0: exact production PersonalExecutor/Kimv2 revision 6/trim=False/
media-015(input 283.562 s)/GPU0 with fallback disabled. Media-017's input is
728.781497 s. It actually failed at 10:56:56 UTC in 112,688 ms, exit 1/reason `completed`
with actual owned Job-zero/cleanup confirmed; no functional report was produced.
Run ID `4d2781f6-bcdb-439b-8f6e-cbc2e4a11b15`; receipt SHA-256
`e202f17bcbc9418fe20aaeaabaa0fa44e6abe300746a5b8cbebe4d2755d45fd4`.
The bounded closed failure projection bound the 2,651-byte log, SHA-256
`6db1147101fb253cd31658af6771e9b6c7e313360eab059ecb91a49036875f8f`;
only input-validation progress was present. Fixed frames were
consumer_personal.normalize_original line 60 → media._run line 345 → QA
validate_command line 290, with safe code `QA_MEDIA_COMMAND_REJECTED`. Actual
production normalization took its extraction branch, whose exact FFmpeg
normalization command was omitted from the QA guard. Failure occurred before
inference; no output/functional result is accepted. Exact functional-01 task
retirement passed around 10:59 UTC through retained cleanup-v09 bound by the v10
pins, with all artifacts preserved. The initial v11 normalization-guard repair
was an unactivated draft; a legacyValue singleton-array finding prompted strict
v03 PowerShell helper corrections. That draft checkpoint is superseded by the
actual final v11 upload/activation and functional results below; the failed v10
predecessor remains failed.
The final corrected v11 cohort actually uploaded with all 16 pins matched and
eight PowerShell parser checks reporting zero errors. Pinned target Python 3.12
isolated controls passed guard 7 positives/28 negatives, observer 10/30 and
functional recorder 24/68. Target PowerShell pure SelfTests passed functional
inspector 18/183, audio read-back 13/44, retirement 10/44, qualification 9/8 and
benchmark 7/38. Activation v11-v02 passed `ValidateOnly` and actual activation;
the old v10 alias was preserved. These controls remain separate from inference.
Production functional-02 actually passed for media-015/Kimv2 revision 6/trim=False,
run UUID `3a8e325d-5aea-4d31-afbb-ba1bb7e66a5c`; receipt SHA-256
`adcaf07474bd3da772357026ae138f8cb15626deb138e03a3b09881b6225052d`;
report SHA-256
`e1a7402f5873f57e9a15451a65fee684b27d43d16af7d9d7c46ec0777a6e46a6`.
Elapsed 53.2763663 seconds; source 283.562 seconds; measured output 283.545873
seconds. MP3:5,672,272 bytes/SHA-256
`77d2e6a8c29ca0e52731a5ad134b68ffa048d3bb9c4110fd14a8397d149c1960`.
Normalized AAC original:5,764,901 bytes/SHA-256
`ad4a9fe23fa71bbef08154e81e584b33b91be8440ed858b6b24546486dd2d4c0`.
The strict inspector and entire held-byte MP3/AAC-original read-back passed;
complete decode passed in 0.4938652 seconds. Exact task retirement and actual
owned Job-zero passed.
Production functional-03 actually passed for media-015/Kimv2Trim revision 6,
run UUID `63522a60-e5db-455e-b9b0-6396e685f409`; receipt SHA-256
`aea28d70ef1f9cae2e3c1f86d33b206ef9d1afc25e2f9373a35851c6f574ea78`;
report SHA-256
`80ce1d541a907abb6f6b5ce9742e2ff78295a3ddc142c1fc4e965e8e1bbdeef0`.
Elapsed 52.4759493 seconds; measured output 243.94 seconds; 12,504,373 input
samples became 10,757,754 output samples, removing 1,746,619 samples across
18 edit ranges. MP3:4,880,240 bytes/SHA-256
`11aa58f4ed69c6810ec15008021f143610ab58ec12dfcf304c9eace7a9402bbd`;
normalized original has the same whole-byte identity as functional-02. The strict
inspector and entire held-byte MP3/AAC-original read-back passed; complete decode
passed in 0.4038169 seconds. Exact task retirement and actual owned Job-zero passed.
Production functional-04 actually passed for media-017/Kimv2 revision 6/trim=False,
run UUID `d715f5d6-ea6e-4446-8cab-ac4f330e7fbc`; receipt SHA-256
`796109bd4274de5865f9a03c6843eefb9eb28a2aaaa0950ec3158f35cbc8c21e`;
report SHA-256
`8299fd4410b5b95b30d480d307fe3cb269116c1667b9dfb21c42be3607913bd7`.
Core elapsed 120.4418674 seconds; fixed source 728.781497 seconds; measured input
728.781995 seconds; measured output 728.804195 seconds. Samples 32,140,265 →
32,140,265, removed 0 with one edit range. MP3:14,577,415 bytes/SHA-256
`a14fc8eee32ef92e165b326bec7db37e69c3cdab0fd42042b862640f1c4133ba`.
Normalized AAC original:14,689,905 bytes/SHA-256
`d398e93f5888805bac82cc51b55bbe6167dbbaf768f824db70890ae774ffd084`;
measured original duration 728.781995 seconds. The strict inspector and entire
held-byte MP3/AAC-original read-back passed; complete decode passed in 1.1461309
seconds. Exact task retirement passed at 11:56:49 UTC with actual owned Job-zero.
Production functional-05 actually passed for media-017/Kimv2Trim revision 6, with
its recipe unchanged; run UUID `d844783c-d5c6-4f94-ae8f-9da725c83cdf`;
receipt SHA-256
`1b353f15182e6ed339f07a8919b5478e3d2f3c9ba5cdebd2d5714b442b780651`;
report SHA-256
`0e69b29f0b86d2575ce13b659fab3d4ec31c3334edb18e1b035f8eeaf5e867fa`.
The actual limited Session 1/RunLevel 0 run used pinned v11/GPU0 after its 12:05:01
UTC dispatch. Core elapsed 118.5608285999988 seconds; measured output 715.084195
seconds. Samples 32,140,265 → 31,535,213, removing 605,052 samples across 17 edit
ranges. MP3:14,303,129 bytes/SHA-256
`7c3ce30f83f5ce6840225c35ec1c311cc43cbfe4530eff3586a13525fc8fc3b3`.
Normalized AAC original:14,689,905 bytes/SHA-256
`d398e93f5888805bac82cc51b55bbe6167dbbaf768f824db70890ae774ffd084`;
measured duration 728.781995 seconds, the same whole-byte original as functional-04.
The strict inspector passed; complete decode passed in 1.1308351 seconds. Full
MP3/AAC-original read-back passed single-link/regular/nonreparse/canonical-path/
stable-identity/whole-SHA/size checks for both files. Strict exact cleanup-v10
`ValidateOnly` and actual task retirement passed at 12:10:35 UTC with actual
owned Job-zero; all artifacts are kept.
All four long production fixture/recipe results now passed and their exact tasks
are retired: media-015 and media-017 across Kimv2 trim=False and Kimv2Trim. All four
checked DirectML GPU0 session policy with fallback disabled and profiling off.
They provide no per-long-run GPU dispatch/event counts or pure-GPU proof; the
earlier profiled qualification remains separate. Full decode, entire held-byte
read-back, actual Job-zero and exact retirement are recorded for each accepted
run. All 24/source24 engine files remain unchanged. Signed installation,
Prepare/Ready, listening and whole-product acceptance remain pending.
Read-only whole-app source audit also identified a Node validate-then-fs.write
race. Preserve source36/native34's failed predecessor and exact task retirement.
Source38/native35's corrected isolated suite passed; peer-approved TypeScript v04
passed the local desktop regression. The TS bridge/root lock-read/upload work is
outside that native cohort, with no live Windows/cloud or whole-app target proof.
Remaining metadata/rename/mutation/publication/process handoffs and WinRT/NSIS
containment remain open. Native-only migration cannot establish whole-app
filesystem containment; those receiving paths require their own proof.
No new checkbox, signed/install/Ready or whole-product pass is claimed.
No whole-product native acceptance pass is claimed. The private contract and dated portable Zalando rule mapping are in
[the acceptance guide](../../windows-desktop/acceptance/README.md#compiler-helper-qa-contract).
Source35 native CTest passed; broader security/containment remains open. The local QA GPU fixture pass is recorded
below, with whole-product GPU/Prepare acceptance still pending.

Runtime/model copies preserved their original identities. The initial limited
engine self-test failed before controller/run-folder creation on copied QA access;
its exact finished task was removed. Repair then validated all 22,956 copied files
with current-user/SYSTEM access only and unchanged length, mtime and read-only
attributes. Original input ACLs were untouched. Actual non-admin Session 1 engine
controller tests passed: the descendant case waited 1,406 ms after the parent
exited while its child remained active, then confirmed Job-zero; the timeout case
terminated its Job after 1,015 ms and confirmed zero. Both exact temporary tasks
were removed after matching XML, zero instances and bound cleanup receipts.
The first CPU inspection failed after 274,828 ms with
`MEDIA_CENSUS_BOUND_EXCEEDED`, before a public summary existed. Actual owned
Job-zero was confirmed and the exact task removed. A read-only sample plan found
94 designated files, selected 32 totaling 483,600,580 bytes and excluded 62 whose
payload was unverified. The v02 helper's four actual Windows pins were verified,
its PowerShell parser reported zero errors and the predecessor wrapper was
preserved. CPUinspect02 verified all 63 pins, 20 imports, 3,099 origins and the
32 original hash/mtime identities, then its QA audit rejected Windows `Popen`'s
flattened command line before doctor/media completion. It ran no inference.
The v03 private QA guard uses an exact 37-command whitelist: five fixed queries
and the 32 selected media probes. Its 370 synthetic cases and independent review
passed without permitting external commands or weakening input trust.

Actual CPUinspect03 passed in 203,985 ms under the limited controller. Runtime
doctor recorded Python 3.12.10, ONNX Runtime DirectML 1.24.4, audio-separator 0.47
and offline FFmpeg 8.0.3 with the model hash pinned. All 32 selected media probes
passed over 483,600,580 bytes; four anonymous representative files were copied.
All selected original, model and runtime identities were preserved. The other
62 payloads remain unverified, and full census, inference, consumer Ready and
signature verification remain false. Actual owned Job-zero was confirmed; the
exact task was removed after matching XML and zero instances. Receipt SHA-256:
`609d243b320ede4ef6501c9314f4666f06b35296a94065216d075b663ad0c4ef`;
summary SHA-256:
`2eaae34b6c48bf02a2e620c069fa4fe03ca1bd9e0c52cbbaf98b7ccfbd31efc7`.

The basic source17 isolated native gate passed. Strict DirectML `qualify-01` was dispatched
at 01:25:46 UTC under limited Session 1 RunLevel0 on the original QA workspace,
using the reviewed frozen v05 wrapper/dispatcher with remote hashes verified.
Qualification-01 failed terminally with no engine report; that run proved no
GPU inference. Run ID `3024680c-e677-4e08-af10-a40fe5fdf495`, receipt SHA-256:
`ed92161b45a6e725e2010a1cd24ccbba2fd4b4f8c25d2dc3cdc815659d48937f`.
Controller/wrapper exit 1, reason `completed`, with cleanup confirmed and actual
active processes 0; signed consumer Ready is false. Cleanup helper `ValidateOnly`
initially rejected a generic code with `taskRemovalSubmitted=false`, so the exact
qualify-01 task was retained at that checkpoint. Phased retirement diagnosis found
`dispatch-run-level`: recorded XML omitted `RunLevel`, while the request and
live COM principal were 0, `LogonType=3`, with exact XML/zero instances. No elevation
was found. Reviewed cleanup v04 subsequently passed actual parser zero errors and self-tests
(eight positives/40 negatives), SHA-256:
`0e72fdf943b24fe01cdcfac259fd42129b8b745105936f4e40ed68dfd44d8e72`.
Actual `ValidateOnly` passed after positive live COM RunLevel0/LogonType3 and
resolved NTAccount-to-exact-current-SID validation. The exact qualify-01 task was
then deleted and absence read back, with actual Job-zero/receipt binding confirmed;
all artifacts remain retained. Earlier omitted-default-XML and canonical-username
checker rejections remain historical and do not explain the engine failure.
The bounded qualification child diagnostic observed 123,296 ms and 1,676 log
bytes, exposing only approved frames `qualification.main:562` →
`windows_gpu.qualify_candidates:216` and exception type `GpuSelectionError`
(`QA_CHILD_FAILED`). Candidate selection catches inner exceptions and discards
their tracebacks, so the inner cause remains unknown. Raw logs were not exported.
Actual diagnostic v03 passed parser/self-tests (three positives/11 negatives),
projecting one candidate `ProcessingFailure` and a matching recorded RX580 LUID.
The cause remains unknown. The fixed-device v06 QA alias passed exact actual activation. `qualify-02` was
dispatched at 01:54:30 UTC under limited Session 1 with DirectML ordinal 0 fixed.
Qualification-02 failed after 117,375 ms, reason `completed`, exit 1, confirmed
Job-zero/active processes 0. Run ID `1a92059e-b8f0-4349-8d62-5aef49e265fb`;
receipt SHA-256:
`aea67f4275a562d6088e9e72bdf4d40bd70dc37f6b3ac01c23538ff787f29a45`.
Its 5,653-byte log SHA-256:
`2b4e2e8d338884a272500f239fece3ea30f71a2d1793fb068bf1c3248c402fdd`.
Reviewed diagnostic v04 passed actual parser zero errors/self-tests (three
positives/11 negatives) and bounded projection: `QA_PROCESS_EXECUTABLE_REJECTED`
was raised during Separator initialization, before inference. This does not prove
an intrinsic GPU failure. Actual cleanup v05 `ValidateOnly` then DeleteTask/absence
read-back passed; the exact qualify-02 task was removed and artifacts retained.
At that failed checkpoint, no GPU inference/qualification pass or consumer Ready
was established. Production
GPU guard is unchanged. Reviewed diagnostic v06 passed actual parser zero errors,
self-tests (five positives/20 negatives) and receipt-bound projection. The installed
`audio_separator/separator/separator.py` is 80,964 bytes, pinned SHA-256:
`43c0b2c84ccc8106e5b74c71a21fc559fb2d12cf5e5f3d917e3bdb39c1054c78`.
Exact `check_ffmpeg_installed` line 405, source/trace literal `('ffmpeg', '-version')`
and child guard failure frame match. The confirmed cause is a relative FFmpeg
startup version query denied before inference; this is no intrinsic GPU failure
proof. A narrow QA-only v07 adapter was prepared; its later actual activation and
recipe result follow below.
Classifier v05 initially rejected a raw input-identity hash mismatch. Canonical
Python-row census SHA-256
`53617088199daafb2f1fff2c2f960e24adb118ce081d6d10382232b1a4c1d7a4`
is distinct from the raw private `source-and-copy-identities.json`, 5,463,878 bytes,
SHA-256 `b11b0c643d46e86b00325d448ab75999acbe92b7a4a42b1e4691a907792e6574`.
Diagnostic v06 binds the actual raw SHA/size with all privacy/source/receipt gates
retained; raw contents are not exported.

The narrow QA-only v07 cohort subsequently passed actual ten input pins/five
PowerShell parser-zero checks, target Python 3.12 recorder self-tests (seven
positives/28 negatives), qualifier (nine/eight), benchmark (seven/38), retirement
(eight/40), plus activation preflight 11 pins/signature one/three/run-binding
two/three. Actual v07 activation passed; alias SHA-256:
`dcfe09ad250b81b91f11428ba6345e0b7aee6bf43f5c27f0976b8ac4f23f86a4`.
The v06 predecessor was preserved exclusively. Fixed-device0 `qualify-03` was
dispatched at 02:16:17 UTC under limited Session 1 RunLevel0 and passed. Run ID
`49201b6c-f88a-46ab-98aa-1afd821939fc`; receipt SHA-256:
`195c8fe74aa2d55a974f6b832a5586b393b56e969c968b55fd5fbcd2620aa16b`;
report SHA-256:
`b2e1bc8d9169fa620ef5b97a7b9e4cbf59a5065ddd61dfdb2c89e5597c777ceb`.
Actual Job-zero/active0/root0, `completed`, matching SID/device0/fallback disabled
and pure GPU profile were confirmed: 784 accelerated node events, CPU0/profile1.
Both Kimv2 and Trim passed the six-second full-timeline fixture; each output was
121,252 bytes, SHA-256
`81bad95da76378961b27e7191be6818fc2070602441592539f6eb9a02165f2d9`,
bitrate160. Reported Kimv2/Trim times were 4.7119895/2.0194241 s, preload16.4284041 s,
total23.2316207 s. Actual `ValidateOnly`, exact task DeleteTask/absence read-back
passed; artifacts retained. This establishes local QA engine recipes on the
existing staged runtime, not signed consumer Ready, fresh Prepare/install/UI,
listening or product acceptance. Only the narrow W34 GPU fixture row is checked.
Full-song benchmark01 was dispatched at 02:20:21 UTC under limited Session 1
RunLevel0 for anonymous media-018 (source99.302 s), Kimv2/GPU0, with no concurrent
native compile. Actual benchmark result passed: controller/wrapper exit0,
Job-zero/active0, expected user/device0, fallback off, pure GPU10752/CPU0. Run ID
`5d3dd39a-247e-417c-825d-e73d414a387b`; receipt SHA-256:
`92ae5af573ede9a235bc3a2a8f4cb26317393e4dc75bd4267c3093ebafdcb2e5`;
report SHA-256:
`ff4611f6cdb8b80724f00ae89680501ba14171b500062f36687e8cff02df963d`.
Reported cold/warmup times were 13.8126638/10.9321203 s; measured runs
11.0496126/11.8284975/11.0073365 s; preload15.6086334 s, total75.2376615 s.
Trim was enabled: source99.302 s/output89.52 s. All five outputs were reported as
1,791,521 bytes, SHA-256
`073a9189bbf707f5d1da31de60c7d819f1d8d740ba1f895442979b1532d1f9a3`.
Actual saved-audio byte verification passed. `verify-benchmark-audio-v01.ps1`
(16,987 bytes), SHA-256
`026941b5230b1944ced06c614b1e598c1fbd5ab04eeec071a61a3f72a6e09696`,
passed target parser zero errors and pure self-tests (eight positives/19 negatives)
before `saved-audio-byte-readback-passed`. All five complete 1,791,521-byte files
matched the reported SHA above. Retained read handles bound the canonical exact
owned run/audio files with stable file ID/birth/mtime/size, regular/nonreparse/
one-link checks and recognized MP3 prefix. No process started or file was written;
this establishes bytes, not listening. Cleanup06 bound `QaVersion=v07`,
`FixtureId=media018`, `Recipe=Kimv2`, `GPU=0`; actual `ValidateOnly` then exact
DeleteTask/absence read-back passed with Job-zero and artifacts retained.
Signed consumer Ready remains false; no combined row is promoted. Benchmark02
media017 (728.781497 s), Kimv2, failed after 499,157 ms: reason `completed`, exit1,
not a deadline. Run ID `e82d43ce-f6c7-4174-8560-d5165e53f9b0`;
receipt SHA-256:
`c0bfe7364c9990869fc027f46b5ac77c1c74145f8d5264ae5ee3898df65be88f`;
log35,055 bytes/SHA-256:
`ce2c65ef7a292105dc4dc65fdc360f1237fa45a01002b932503dae40f45c9971`.
Actual cleanup06 exact-argument `ValidateOnly`, DeleteTask and absence read-back
passed with Job-zero; the exact benchmark02 task was retired at about 02:43:30 UTC,
receipt bound to the SHA above, with all artifacts retained. Outputs are not
verified and no benchmark02 GPU pass is claimed. Reviewed diagnostic02-v02
(45,521 bytes), SHA-256
`fab93f01f45515d0ab6b5287fd2910f82476aaa1c17dff04e8f792dbf6eafceb`,
passed actual PowerShell parser zero errors and pure self-tests (three positives/
seven negatives), then actual typed private projection. Its failure report was
3,376 bytes, SHA-256
`cb004dcc0fe353d656631912aa35c133d3bad8bc790cfd4a8a1c39474d9d03ce`.
It projected `QualificationError`/`provider-profile-safety-check-failed` and all
five `run-complete` events. The existing profile limit is 67,108,864 bytes;
`limitExceededProven=false`. This identifies the failing safety-check category,
not a proven limit breach or GPU acceptance. Raw private details were not exported.
Diagnostic02-v03 (58,591 bytes), SHA-256
`e59abd8b8f04f93a01d02b9f270aec7941ef403694adda77c9d26511f33f8719`,
passed actual PowerShell parser zero errors/pure self-tests (nine positives/
21 negatives) and actual metadata projection. The owned work census found
zero qualification directories/zero profiles, `noQualificationDirectoriesRemain=true`,
profile-content reads0/profile hashes0. The pinned engine finally deletes those
profiles, so later absence cannot identify the historical unsafe predicate or
prove a 67,108,864-byte breach. Both remain unproven. A QA-only v08 observer is
being prepared to observe bounded metadata before profile cleanup; production
and all24 staged engine files and the profile cap remain unchanged. The v08
sidecar inspector (32,722 bytes), SHA-256
`de85d734fa09be387d5590a232cd40cad8efdbc1b4ff6f8fb4bef05da21c8208`,
passed actual PowerShell parser zero errors/pure self-tests (14 positives/
77 negatives), with no inference. V08 activation/preflight does not establish
a benchmark04 result; no v08 inference has run at this checkpoint.
The QA-only v08 observer cohort passed preflight/actual activation with12 input
pins and PowerShell parser zero errors; `ValidateOnly` and actual activation
passed, with the exclusive v07 predecessor preserved. Pins file1,556 bytes/
SHA-256 `4d84f04e122695478ea43969f4ea3954eaf47ee1fea90d3e3ec6b96e37337876`;
activation helper10,861 bytes/SHA-256
`91220d4a6c6f917aee0757a2e25ab471069ca1df67d7be0ec80b51d4fb6193cd`;
actual v08 alias SHA-256:
`7e40cea2357346bf728c7ec7f709e8b0900610d2119708b7887501e15e725931`;
child32,956 bytes/SHA-256
`20cf4be10ffcfbf2986261eff2665c2ef51232692d062c129bb13e5671856b62`;
controller31,852 bytes/SHA-256
`b6d041333fc1e1e6146d39924e7d8df58ca40390eb2f89a16c8263c2c03e4b93`.
Actual target Python3.12 `-I -B -S` guard self-tests7 positives/28 negatives and
observer9/29 passed. PowerShell qualification inspector9/8, benchmark inspector7/38,
cleanup8/40 and activation signature1/3/result-binding2/3 pure controls passed.
Production and all24 staged engine files/profile cap are unchanged. Preflight/
activation establishes no v08 inference or benchmark04 pass, signed consumer Ready
or release-signature promotion; this checkpoint preceded benchmark04.
Benchmark04/v08 failed early before an engine report or observer sidecar was
produced; no inference proof is established. Run ID
`502a1f29-aff0-4553-9f23-f4ea9b546fe3`; receipt734 bytes/SHA-256
`8d39f827884096a5497079e8ab24b46d12f646c06f5f267d78409a25bc6ecc52`;
controller/wrapper exit1, reason `completed`, actual owned Job-zero. Private child
log1,025 bytes/SHA-256
`8ceb29e9fbcafac5ee23450c607aafc9a906093e0ff6c5783715ad320183deab`;
wrapper report422 bytes/SHA-256
`5df27fe3df399efb1bbee4f38f23daf788443a8b8bc1ef5b53bcfdd56ffe2ee2`.
Cleanup-v07 `ValidateOnly` and actual exact task removal passed, all artifacts
preserved. Source review found a QA observer comparing `verify_engine`'s JSON-census
SHA-256 `ccb9a82963f41e4572589d468440b637802ce58f08ad8682b5f5b03c3e0964ab`
with the distinct engine `code_digest`, calculated using another grammar.
`diagnose-benchmark-04-v01.ps1` (43,711 bytes), SHA-256
`b32a3ab0e52bd67a1d34ab01975ce892e0d65e6dd69ae7341c12d24ee82607be`,
passed actual parser zero errors/pure self-tests (three positives/five negatives)
and receipt/wrapper/log/current-SID/source closed binding. Actual bounded
projection observed54,297 ms, `RuntimeError`, known cause
`QA_PROFILE_OBSERVER_CONTEXT_REJECTED`, with reviewed v08 frames module586/main563/
install_profile_observer347/fail44, and no engine report. This confirms the
incompatible census-grammar preflight failure; no v08 inference acceptance is
established. No benchmark04 GPU, sidecar, signed consumer Ready or product
pass is claimed.
The QA-only v09 correction passed actual target preflight and activation at
03:36:53 UTC. Context verification now compares the named JSON-census SHA-256
`ccb9a82963f41e4572589d468440b637802ce58f08ad8682b5f5b03c3e0964ab`;
the emitted engineDigest remains unchanged, with an explicit census tag added to
the 22-field observer sidecar. The original other child functions/main and
controller AST remain unchanged, as do all 24 staged engine files, the 67,108,864-byte
profile cap and GPU/inference-outcome gates. Pins file 1,556 bytes/SHA-256
`94741aeeb07526690986c36a4c8736444642a87d2aad2073bc2c06983b4874bf`;
activation helper 10,861 bytes/SHA-256
`51d1945f3a4549562c987329596d4b41193636cc5c6bf35580c17fbf9eed90c7`;
child 33,227 bytes/SHA-256
`3f5f01218ec6992e9cae28629149fdd6ec84825059fb0b7cdd2e1076c85f8729`;
wrapper 14,232 bytes/SHA-256
`88af9677756726a93152992bf5b0f497b898f9bbf715e1fe4c6047a7ec3b84fd`;
controller 31,852 bytes/SHA-256
`99f70b8479c7c51a8b5d902c405ffec3d21ff76ab0f0632c5023d7bf425b5abb`;
sidecar inspector 33,425 bytes/SHA-256
`fc9f47db86da4a8bbfa7ecd62278c6bd1101d76c42d146a00b81794ef30243ac`.
Actual target Python 3.12 `-I -B -S` guard 7 positives/28 negatives and observer 10/30
passed, including integration with golden verify_engine/public_digest, actual
main wiring and cross-grammar rejection. Actual PowerShell qualification 9/8,
benchmark 7/38, cleanup 8/40 and sidecar 14/81 controls passed. Activation
`ValidateOnly` bound 12 pins with parser zero errors/signature 1/3/result-binding 2/3
controls, then actual alias activation passed; v08 was exclusively preserved
before v09, with no overwrite. Benchmark05/v09 was dispatched at 03:37:03 UTC
under limited Session 1 for fixed media017/Kimv2/GPU0, then actually completed
with exit 1/reason `completed` in 492,062 ms and actual owned Job-zero. Run ID
`fc8ce75c-f574-4723-ac98-656b9b747dda`; receipt 888 bytes/SHA-256
`3399db06cc8ba566e75bfdef86a535e020156801feb8363efe303351d8f1869e`;
failure report 3,376 bytes/SHA-256
`d87e7ac21492961ee2dc80a188363530126e1c488b0cec7a72a4b4c95deeb9d8`;
observer sidecar 1,177 bytes/SHA-256
`fea2ac5966567a3fbb570b40e35f3b1107a02ee81b9e7e8d740a860a589a1035`;
private log 35,055 bytes/SHA-256
`a61f6d64b0cbe876ec08d42e528cd75a448b67cb8ab586fbf7a906e9795a8867`.
The frozen v09 sidecar inspector passed actual closed pin/SID/source/run/receipt/
report/sidecar binding. It observed metadataStable=true, one owned regular
non-symlink profile of 67,513,356 bytes, exceeding the original 67,108,864-byte cap
by 404,492 bytes; the profile was not below its minimum size. This proves the original profile-size-limit
predicate for benchmark05. The observer delegated the unchanged original
`QualificationError` profile-safety failure; handlesClosedBeforeCleanup=true,
profile-content reads 0/acceptanceChanged=false. The benchmark remains FAILED;
GPU event counts, full performance and saved-output verification are not accepted.
Benchmark05 exact task cleanup through the frozen v08 helper passed
`ValidateOnly`, actual DeleteTask and bounded absence read-back at 03:47:31 UTC,
with all source/receipt/report/sidecar/task bindings and actual Job-zero checked;
artifactsPreserved=true. The exact task is retired; all artifacts remain retained.
The temporary v01 completion projector passed target source-pin checking and
PowerShell parser zero errors, then its pure SelfTest failed at
synthetic-five-pass-positive with exit 1 around 03:50 UTC. No actual private
benchmark05 artifact projection ran through v01. Source review identified a local
`$recipe` PSProperty shadowing `$Recipe` under PowerShell's case-insensitive variable
rules. Exclusive immutable v02 uses `recipeProperty`, explicit `$script:Recipe`
and a shadow-caller regression. Its 51,885-byte source, SHA-256
`1bbe486bd43203fd655a558965aabec6d2ac3f6cb3b5a04f6a99a08ad4e48fc6`,
passed actual PowerShell parser zero errors/pure 6 positives/14 negatives, then
actual benchmark05 projection around 03:52 UTC. It bound 27 source pins and the
receipt 888/report 3,376/log 35,055 byte identities above: exit 1/reason `completed`,
cleanup confirmed/active 0/492,062 ms. Both the fixed report and log contained
distinct ordered start-to-complete indices 1..5 with roles cold/warmup/measured/
measured/measured. Counts: preload-start 1/preload-complete 1/run-start 5/run-complete 5/
reportReady=0; allFivePipelineCompletionsObserved=true/reportAndLogCountsMatch=true.
This observes five pipeline completions while retaining the FAILED benchmark.
Timing/output/provider counts remain unaccepted. The read-only projection read
no profile files, started no processes, made no writes and exported no private
contents. Its inherited failure-report-only profileLimitExceededProven=false
means that projector alone establishes no cap breach; the separate actual v09
sidecar proves 67,513,356 > 67,108,864 bytes/excess 404,492 for 05 only. The benchmark
failure, size-limit proof and exact task retirement remain unchanged; no active
accepted QA run remains. Benchmark02's exact historical predicate remains unknown; 05 supplies
no retroactive proof for 02. Signed consumer Ready and whole-product acceptance
remain pending.
Read-only source review found that `qualification.py` uses one profiled
KimSeparator/preload for all five passes, then finishes/summarizes the completed
profile. The 64 MiB cap applies to that cumulative completed profile; it is not an
input-duration limit. This source review supplied no actual benchmark05 outcome
or cause; the run-bound sidecar evidence above now proves 05's profile-size limit.
Media017 (728.781497 s/54,574,444 bytes) is within the documented Personal
1,200-second/shared 1,800-second bounds. Prepare defaults to a six-second stereo
44,100 Hz/264,600-frame/1,058,444-byte WAV fixture. Production Personal reaches
RuntimePipeline/KimSeparator with profile_directory=None; provider_adapter only
enables profiling for a non-None directory, while fallback/session protection
remains in force. The QA qualification recipe defaults Kimv2 to trim=True;
production Personal explicitly uses trim=False for Kimv2 and true for Trim.
Benchmark01 Kimv2's duration/timing therefore establishes no production Kimv2
recipe result. Preserve benchmark05's proved profile-cap failure and require
a reviewed immutable QA guard with the production recipe (Kimv2 trim=False), or
the morning signed installed path, before a long functional run. Do not raise or
bypass the profile cap.
Benchmark03 was actually dispatched at 02:43:31 UTC under limited Session1/
RunLevel0 for media019 (140.805805 s), `Kimv2Trim`/GPU0, sequentially after02
retirement. Actual report passed: root/controller/wrapper exit0, actual Job-zero,
expected nonadmin Session1/user/device0, fallback off, GPU14,672/CPU0. Run ID
`e5ee01dc-4580-4e6e-bd5d-b297e339ea1c`; receipt SHA-256:
`1dcad627dc3b8794af5c2f87acd94f733ca8fb96d3f206a5bb3b83e68087d49b`;
report SHA-256:
`292ee9fc2f222d648ec1e1fb1890389e4812366249a50e3fc12195890d5431dd`.
Source140.805805 s/output130.89 s; cold15.6678271 s/warmup14.5530476 s;
measured14.6353891/14.2211520/14.5388266 s, total90.3301319 s. All five outputs
were reported as 2,619,080 bytes, SHA-256
`37f0610b9ec4eba0b4f22b1adfb47e554a9e8b1cb2a28b20089ea38002aa901f`.
Actual saved-file byte verification passed via `verify-benchmark-audio-v02.ps1`
(18,705 bytes), SHA-256
`ee5ea4d53d43d6bef31f5441a62e29ffb845861775fb94aba68f1fecefb70d21`.
Actual parser zero errors/pure self-tests (nine positives/24 negatives) passed;
all five retained read-only complete files matched SHA/bytes with canonical exact
owned paths, stable file ID/birth/mtime, regular/nonreparse/single-link checks and
recognized MP3 prefix. This establishes saved bytes, not listening. Exact
benchmark03 cleanup06 bound exact v07/03/media019/Trim/GPU0: actual `ValidateOnly`
then exact DeleteTask/absence read-back passed with actual Job-zero and all
artifacts preserved.
No Windows compile or metadata inspection overlapped its execution. The initial root checker
invocation omitted `-FixtureId`; it was a checker invocation error, not a product
failure. The duration/name above corrects the earlier compact message's spacing:
media-018/source99.302 s, not media01/source899.302 s. Local QA engine evidence
continues to establish no signed consumer Ready, fresh Prepare/install/UI/listening
or whole-product acceptance.
Authorized-song benchmark01 started after the later qualify-03 pass. The v04 independent review passed,
but it was not activated: actual system `whoami.exe` has two hardlinks with valid
Authenticode, conflicting with its single-link gate. The narrow private temporary
v05 QA helpers were uploaded/pinned and passed actual Windows `ValidateOnly`
and independent review. Seven input pins and zero parser errors were confirmed;
one signature positive/three negative fixtures and two run-binding positives/
three negatives passed. The reviewed v05 alias was activated with the prior
v03 alias preserved, without overwrite. The temporary benchmark inspector now
uses PowerShell 5.1-compatible `strictDecimal` and optional non-trim timing;
independent review, actual remote hash/parser zero errors and self-tests (six
positives/38 negatives) passed without I/O or inference. A separate qualification
v06 preserves v05, changing only actual-path decimal parsing to `strictDecimal`;
independent review plus actual parser/self-tests (nine positives/eight negatives)
passed. All model/runtime/run bindings, GPU and cleanup rules and no-Ready scope
are unchanged. A separate engine cleanup helper passed independent review,
actual hash/parser zero errors and six positive/28 negative synthetic cases
without I/O, COM or tasks. Its initial actual retirement rejection is historical;
reviewed v04 validated exact retirement as recorded above. Qualification child
diagnosis remains open. Earlier v02 cleanup-helper local/remote SHA-256:
`18d8eb037553076b42dd367dd53285598777cac5dc9f69890fdd0c57d71405d7`.
Actual source17
[PE byte audit](evidence/W34-Z440-native-source17-pe-audit.json) passed all eight
targets and three production image hashes as AMD64/PE32+. Production images have
NX/ASLR/high-entropy/CFG header flags and exact embedded `asInvoker`/`uiAccess=false`;
signatures and CFG instrumentation remain unverified. The audit started/loaded
no processes/images and establishes no consumer Ready.
The 45 candidate/manual app, Chrome, account and worker cases await the approved
signing/runtime inputs. All 68 combined task Windows boxes and 93 feature journey
boxes remain unchecked. See [the detailed current evidence](evidence/W34-Z440-Win11-26200-RX580-2026-10-11.md).

## Historical reconnection/staging checkpoint — 2026-10-11

The following checkpoint predates tool installation and the native diagnostics
above; retain its failed transfer/copy observations as history.

The user supplied the new address and approved Visual Studio2022 C++ Build Tools,
Windows11SDK26100 and CMake installation without automatic reboot or driver
changes. The new endpoint matched the previous SSH host key and actual OS/GPU.
The interrupted transfer had created no source/report files. Source, helpers and
personal fixture were re-uploaded and hash-verified; the actual native-only47-case
plan was generated on Windows. Compilation/tests are unrun; tools are installing.

Isolated runtime/model staging passed22949Python files/1917797037 total copied
bytes with exact original identities preserved and copies marked read-only. The
first limited-token copy failed before output creation; its finished task was
removed. Immutable copying then completed through the approved SSH context.
Actual native/doctor/model tests still require the limited desktop context.
See [current evidence](evidence/W34-Z440-Win11-26200-RX580-2026-10-11.md).

## Historical initial connected Z440 checkpoint — 2026-10-11

The user authorized testing the named Z440 and its designated songs. Fresh
inventory observed Windows 11 Pro 25H2/build26200, native x64, AMD Radeon RX580
and driver31.0.21925.1001. The SSH token is elevated in Session0; a separate
one-shot limited interactive-token probe passed in Session1, and its exact
temporary task was removed. This proves the QA execution context, not product
security, GPU qualification or an installed app.

[Current target evidence](evidence/W34-Z440-Win11-26200-RX580-2026-10-11.md)
records the partial results and next gates. MSVC/Windows SDK/CMake were absent;
Microsoft's signed bootstrapper was verified but not installed while the required
tool-install authorization is pending. The connection then stopped responding:
fresh port22 connections timed out, and source transfer/extraction are unconfirmed.
Reconcile the private QA workspace before retrying; do not overwrite it blindly.

The first-build target now has a separate closed native-only v2 shape, with no
invented installer/runtime identities. It permits only the two isolated native
cases and rejects candidate/manual evidence. Its source checks passed Desktop
2139/232, whole typecheck/lint536/format/build and package fixtures5. The native
source digest remains64699a82b582061626a2fac619d8f35a9d2ac14c63e93839bd26fdbd208234fd.
No native compilation, CTest, runtime doctor, model hash, inference, installed UI,
Chrome, account or release acceptance has passed. All combined Windows task and
feature checkboxes remain open; W34 is in progress with connection/tool gates.

## Historical final source/code closure — 2026-10-10

**33 of33 implementation and available-code-check tasks are closed. W34 remains
open until the connected Windows phase.** The [task index](TASKS.md),
[30-point/93-journey report](CODE-COMPLETION.md) and
[final regression evidence](evidence/W33-final-source-regression-2026-10-10.md)
are reconciled. Earlier records below are historical, including their old counts
and remaining-work descriptions.

Final Desktop2135/232 at04:28:29 passed, plus whole typecheck/lint536/format/build,
package5, extended17 and the actual9/12graph gate. Chrome2341/four existing skips,
Worker1006/21 existing skips plus packaging16/build/prepack, backend1719/161,
dashboard218/40 and landing15/three plus11 server checks are recorded separately.
Skipped/omitted checks remain unavailable, never passed; counts overlap.

Final Native security/local/registry/package/report and Library deletion/effect/
ACK/LRU/shutdown returns are reconciled. Main and headless Storage now validate
the same durable all-owner pending-original sum; exact-limit, +1-byte, discarded/
released and malformed-journal receiving cases passed30/three. Source digests and
the scoped dirty checkout fingerprint are in W33 evidence.

No Windows/compiler/DirectML/installed Electron or Chrome/account/R2/fleet/
listening/logon/Share/install/update/uninstall observation ran. Actual approved
configuration/licensed runtime/model/native binaries, independently approved QA
guard, signing/reputation/security release review and publication remain pending.
Nothing was committed, pushed, installed, signed, published or deployed.

Next: after the user connects/names the Windows target, use W34's actual OS/GPU/
artifact matrix and guarded native compile/fixtures before installed journeys.
No other target or actual pass is inferred from this source closure.

## Historical authorized implementation phase

The active goal explicitly requests implementing every task. The preceding
planning turn made concrete progress: 34 deep task files, 30 accepted points,
93 feature journeys and the source-aware handoff were validated. Source work
now resumes against the actual dirty checkout; preserve unrelated changes.

## Latest combined source checkpoint — 00:21, 2026-10-10

- `npm test -- --maxWorkers=2` passed **1,764 tests in 205 files**, start
  00:21:56, duration 43.89 seconds. TypeScript, full lint (484 files, zero
  findings), formatting, source build and both bundle boundaries passed.
- Main now binds actual Chrome CHECK/voice-cache cleanup/local events, Prepare
  maintenance and protected recovery, local startup/attachment timings, the
  authenticated installed catalog runtime resolver, and independently started
  first playback/deferred publication. Account destructive review is bound to
  the exact reviewed account and login generation.
- Whole-authority shutdown retains unconfirmed cleanup owners and native gates,
  with English/Arabic closing retry. Unissued Library descriptor/pin failures
  also have retained exact cleanup owners. No native exit is a Job-exit proof.
- [Current integration evidence](evidence/W04-W08-W09-W20-W27-integration-2026-10-10.md)
  maps the actual production entries and focused/composed proof. W13/W16/W18 and
  W23/W24/W25/W29 now have detailed source/code closure matrices, alongside the
  previously closed W17/W28. The overall requirement audit remains open.
- Known source returns remain: dead-owner-first runtime-stage reclaim, required
  Prepare stage/commit-ACK fault coverage, and full bilingual bookmark capacity
  within the fixed native vault bound. Later fixes are not automatically covered
  by this frozen checkpoint. W34 and real release inputs remain wholly pending.

Subsequent source returns: the accepted bilingual bookmark capacity now uses
bounded atomic chunks under the unchanged native 16 KiB/key cap. Its 23 specific
fixtures and wider **104 tests/nine files** passed at 00:34:38, with TypeScript,
scoped lint/format, source build and boundaries. W19's remaining whole-task review
continues. W21's last cancelled shared lookup now waits its actual cleanup before
external idle; the affected **39 tests/five files** passed at 00:26:45.
W14/W15/W20/W21 have full source/code requirement matrices and the task index is
reconciled. W02/W27 source returns are closed with their actual Main bindings.
Runtime staging/Prepare fault coverage, app-local DLL closure, remaining storage/
diagnostic/feature audits and the next coherent combined checkpoint remain work.

## Later source continuation — 01:03, 2026-10-10

- W19's whole advanced-listening source/code audit is closed, including stale
  same-source media events, disposed-resume callbacks and missing-map restoration.
  Its final **115 tests/nine files** passed at 00:49:01; TypeScript, owned
  lint/format, source build and both boundaries passed at 00:55. W19, W05 and W32
  are now reconciled in the index; every Windows acceptance box stays open.
- Root's captured window-close cleanup uses `PendingOperations.runCleanup`.
  One failed owner cannot release the barrier before another cleanup settles;
  a synchronous failure also cannot prevent later closures from starting. The
  shell/navigation/pending/shutdown/forwarded-entry slice passed **39 tests/eight
  files at 01:02:52**, with whole TypeScript and scoped lint passing.
- Personal Quit now awaits the actual owner-fenced cleanup promise. Navigation
  intent wins over late restoration, malformed second-instance input is refused,
  and input/benchmark dialogs use the captured window lifetime. Subsequent Quit
  cleanup and direct-export retention work need their final composed checks.
- The native duplicate-owned fixed mutex now returns contention rather than
  a request error. Its SDK source tests passed; actual Win32 behavior is unrun.
  The reported source digest is
  `7166c8e1b099002848f817f8543fbe42d2cee6513f7c3de43fe8b9f6a8e38b68`;
  further native deletion changes will require a new recorded digest.
- Open work: exact-owner export settlement/retry, corrupt-runtime durable repair,
  final runtime/DLL/GPU/local-source audits, handle-held native cache deletion,
  storage/diagnostics source closure and the next frozen combined regression.
  No Windows machine, native compiler, actual GPU or installed browser was tested.

## Later lifetime and acceptance source return — 2026-10-10

The [later lifetime/acceptance source return](evidence/W04-W33-lifetime-harness-2026-10-10.md)
records the new awaited window/export cleanup, strict accepted-point case mapping,
revised evidence resume, target/fixture specification and source checks. Later
save/export/Advanced checks passed 98/12 with TypeScript/lint499/format/build and
boundaries. Readiness now has scalable complete authenticated chunks and actual
signed-ZIP operation-count proof beyond 8,192 files; actual Windows latency is
unmeasured. The old 1,764/205 whole baseline does not cover these later changes.

Those receiving gaps are superseded by the later checkpoint below. Compiler/test
descendant Job-zero guard, remaining source audits and final frozen regression
remain work. No native or release action was run.

## Later Setup/export receiving checkpoint — 02:17, 2026-10-10

The [new receiving evidence](evidence/W04-W26-setup-export-receiving-2026-10-10.md)
records actual Main/preload/Setup UI, complete sealed shared extension, fixed
native Chrome command, and created-export discard/positive receipt ACK binding.
Failed helper exit stays retained; ACK retry cannot repeat deletion. Native-owner
independent source review passed; Win32/HANDLE/Chrome execution stays W34.

The broader shell/bridge/security/export/shutdown/navigation/recovery/UI slice
passed **182 tests/23 files at 02:17:13**, following **109/9 at 02:15:13**.
Whole TypeScript/lint509, owned formatting, source build and two bundle boundaries
passed. Counts overlap and do not replace the old frozen whole 1,764/205 baseline.
Signed output-location preflight subsequently passed 108/seven files at 02:22:32
with whole TypeScript; W04 receiving source/code is closed. W06/W09 current source
matrices are also reconciled in the index. Source work remains: automatic
Main Prepare launch/settlement composition proof, final W11/W12 and storage/
diagnostic cleanup review, platform-aware shared error guidance, compiler Job-zero
guard and combined regression/task reconciliation. No release action occurred.

The later shared-extension G04 audit reopened W27 for actual HELLO-aware error,
download/setup and privacy wording; Windows must not receive a Mac companion link
or Apple-Silicon-only instructions. Earlier correct platform loading branches are
preserved. The current summary is **20 source/code tasks closed, 13 open, W34
deferred**, with zero Windows acceptance checks marked passed.

## Latest status reconciliation — 2026-10-10

Automatic Main Prepare now executes a reusable exact-owner lifecycle and opens
Setup for cold installation without overriding explicit navigation. Real
Controller/Maintenance/Gate and signed Operations cold-to-authenticated-warm
fixtures passed **141 tests/11 files at 02:46:21**; TypeScript, scoped lint/format,
source build and two boundaries passed. See [W08 lifecycle evidence](evidence/W08-desktop-lifecycle-2026-10-10.md).

The shared Chrome G04 guidance/privacy/copied-report return is complete. Whole
shared source passed **2,329 tests, four existing skips/83 files at 02:37:23**,
with whole TypeScript/lint224/format; receiving Desktop assets/Setup/Fleet passed
64/nine files. See [W27 evidence](evidence/W27-platform-guidance-and-privacy-2026-10-10.md).

W08/W27 source and code checklists are reconciled: **22 of 33 implementation
and code-check tasks closed, 11 open; W34 deferred**. This is task-count state,
not a percentage of product or release readiness. Remaining source closure covers
native security/session lifetime, GPU/local processing matrices, storage and
diagnostics cleanup, Chrome manifest/registry transactions, installer/build-input
review, native acceptance harness and final frozen combined regression. The
older 1,764/205 whole Desktop pass does not include these later changes.

No Windows/compiler/DirectML/installed Chrome/account/logon/device or release
acceptance was run. All native acceptance checkboxes remain open.

## Foundation and session closure — 2026-10-10

W01 development assessment now enforces builder-chain exclusion in every runtime
graph, including external import edges; 13 package-recipe tests cover the full
role matrix. Current source build, two boundaries, whole TypeScript and the real
nine-entry gate over twelve metafiles passed. [Dependency evidence](evidence/W01-development-dependency-review-2026-10-10.md)
retains the separate unresolved release/security decision and operator builder
isolation; source containment does not approve either.

W10 now rejects duplicate-key saved intent and Force records before startup.
The actual Vault store → Supervisor and broader lifetime/event/bootstrap checks
passed **126 tests/14 files at 02:56:47**, with whole TypeScript, scoped lint/format,
source build and two boundaries; [evidence](evidence/W10-durable-session-state-2026-10-10.md)
records the exact portable/native boundary. Initial fixture literal-type errors
were corrected before the passing typecheck.

Current tracker: **24 of 33 source/code tasks closed, nine open; W34 deferred**.
Remaining source includes required GPU wait presentation and isolated native GPU
fault-test source, final upstream frontend tests, exact native storage/Chrome
registration cleanup, security/installer reconciliation, acceptance harness and
the frozen full affected-component regression. No Windows acceptance is checked.

## Pinned frontend dependency return — 2026-10-10

W07's three unavailable upstream loader checks now pass in a disposable Python
3.13.7 environment installed from the complete existing frozen host dependency
list. Genuine upstream imports were preserved; **10/10 separator tests passed**,
and the existing full engine runner executed **131 tests: 130 pass, one existing
native Windows Job skip** in6.399s. Pip check and direct installed-pin comparison
passed. [Current evidence](evidence/W07-pinned-frontend-code-checks-2026-10-10.md)
records that no genuine weights/model inference or Windows runtime installation
was involved. Earlier import errors remain historical, not current blockers.

W07 source/code is reconciled. Current tracker: **25 of 33 source/code tasks
closed, eight open; W34 deferred**. W11 Waiting for worker/Busy event-driven
receiving and isolated native GPU test-source, exact native cleanup/registration,
security/installer/harness closure and the frozen combined regression remain.
Every actual Windows/GPU/compiler/installed acceptance checkbox stays open.

## GPU waiting and acceptance procedure return — 2026-10-10

W11 now exposes actual event-driven pending reason through protected admission,
Runner/Controller, Desktop and the shared Chrome JOB stage; no polling or private
GPU/owner data. Core/receiving **98/12 passed at 03:11:57**, then Root's terminal
Busy/renderer/admission/localization **31/five passed at 03:13:41**. Whole shared
Chrome passed **2,341 tests/four existing skips/83 files at 03:09:56**; TypeScript,
lint, source build/boundaries and owned formatting passed. [Evidence](evidence/W11-personal-wait-reason-2026-10-10.md)
records the exact boundaries; GUID-only native GPU fault source remains unrun.

W11 source/code is closed: **26 of 33 tasks closed, seven open; W34 deferred**.
W12's personal core is complete but its summary remains open until moving native
partial/marker cleanup returns. W03/W22/W26/W30/W31 and final W33 closure remain.
The acceptance manifest/runbook now explicitly includes the newly audited native
fault scenarios; changed procedures/revisions invalidate older partial ledgers.
Acceptance policy/guard checks passed **18/two at 03:14:31**, including a same-ID/
revision/target procedure-only stale-attestation refusal. No native result exists.

## Frozen full regression result to resolve — 2026-10-10

The new whole Desktop run started03:17:40 and finished109.22s later: **2,046
passed, five failed /226files**. All five are in partial/marker cleanup receiving
(library-artifacts1, outbox-media2, personal-storage2). Native found one genuine
marker overconstraint: normal completed-job cleanup occurs within a live personal
role, so it needs exact bound-role/owner plus actual inference/tools idle;
unbound/restart cleanup still needs durable whole-Job exit. The other old real-file
fixtures need exact injected partial receivers. Fixes and the next full run are
required; this checkpoint is not green. [Current evidence](evidence/W33-final-source-regression-2026-10-10.md)
records the failures and expanded unrun native procedures. Whole DesktopTSC,
lint522, standardformat and extended acceptance/packaging style/lint passed.

The final safe [Worker return](evidence/W33-worker-source-checks-2026-10-10.md)
passed **1,004tests/21existing platform or opt-in skips**,16packaging fixtures,
protocol/type/lint/format/build and dry package inventory. The [backend/dashboard/
cross-product return](evidence/W33-backend-dashboard-cross-product-code-2026-10-10.md)
passed backend1,719/161, dashboard218/40 serialized, landing15/3 plus11loopback
server fixtures and required static/build checks. Initial dashboard timeouts were
resolved by unchanged isolated/serialized runs, not altered timeouts/source.
Native/compiler/installed/live acceptance remains wholly deferred W34.

## Corrected whole Desktop pass and final diagnostics audit — 2026-10-10

The corrected frozen Desktop suite passed **2,052tests/226files at03:27:05**,
92.83s. Whole TypeScript/lint523/fullformat, extended packaging/acceptance checks,
source build, two boundaries,52contract tests and the real9/12runtime graph gate
passed. Native source digest64714e9fafc9bba0463f4542bbfaab150a416e23e1f2ed7cbe066a0c7df3299d
is source identity only. Earlier2,046/fivefail checkpoint remains recorded.

The final W30 read-only receiving audit found actual missing journal outcomes,
trusted code projection, cancelled state, sealed inventory digest and observed
stage timings. Backend now implements that source slice; W30/W33 remain open and
the2,052whole pass becomes historical over those later changes. Native is
reconciling W03/W12/W22/W26/W31 source rows against its corrected receiver proof.
No Windows/compiler/installed/GPU/account/browser/live acceptance was run.

## Later W22 receiving return — 2026-10-10

The final named-row audit found actual post-eviction and partial-effect gaps.
Main Export/Share now restores only the authorized selected missing variant via
the existing Library grant/cache path with captured account generation and window
cancellation. Main and headless Personal read all-owner durable retention journals
even without configured live account/publication controllers. The receiving slice
passed66/six, then the broader Library/export/Share/outbox/publication slice
passed**145tests/12files at03:39:56**, with whole TypeScript, owned lint/format,
source build and two bundle boundary checks. [Evidence](evidence/W22-library-action-retention-2026-10-10.md)
records the actual bindings and deferred installed proof.

Native continues the remaining W22 exact Library/native cleanup, actual post-effect
capacity/availability reconciliation and malformed advisory LRU handling. W30
diagnostic receiving fixes also remain active. The tracker stays26/33 source/code
tasks closed, seven open, W34 deferred. The2,052whole pass predates these later
edits and must be refreshed after source freeze. No Windows acceptance is checked.

## Earlier combined source checkpoint — 22:43, 2026-10-09

- `npm test -- --maxWorkers=2` passed **1,476 tests in 179 files** at
  22:43:50 in 36.64 seconds. TypeScript, full lint (444 files, zero findings)
  and full formatting passed. Source build and both renderer/preload boundary
  fixtures also passed again during the subsequent status review.
- The checkpoint includes W28 safe initial/return modal focus, busy-dismiss
  fencing and real keyboard-event regressions, the restricted production IPC
  ingress and composed preload/UI queue actions, and seven composed Cloud I/O
  cases. The Cloud review corrected a prepared-input/result-workspace collision.
- The queue transport fixture was extended after the full run to cover an
  account-owned queued action revoked at sign-out while guest playback continues.
  Its four-case suite passed at 22:45:48 (four tests in one file). This uses
  the actual preload, ingress and playback controller with an injected owner
  event; it is not live OAuth or native media evidence.
- W17 and W28 have completed their detailed source/code checklists. Final
  requirement-by-requirement integration, production-entry and task closure
  review remains open; source presence is not overall code-completion.
- Windows compilation, signed packaging, fresh install, actual DirectML audio,
  Chrome registration, authentication, Share, logon and UI acceptance remain
  unrun under W34. Approved production assets and signing are release inputs.
  No commit, push, publication, deployment or live enrollment occurred.
- Details: [recovery and current combined evidence](evidence/W10-W16-W17-recovery-integration-2026-10-09.md),
  [W28 source audit](evidence/W28-composed-accessibility-2026-10-09.md) and
  [composed Cloud I/O](evidence/W13-composed-cloud-io-2026-10-09.md).

## Earlier combined source checkpoint — 22:19, 2026-10-09

- Full desktop regression at 22:19:16 passed **1,424 tests in 174 files** in
  32.87 seconds. Desktop TypeScript, lint (437 files, zero warnings/errors), full
  formatting, source build and both renderer/preload boundaries passed.
- This combined snapshot includes independent logged-in worker bootstrap,
  stopped/paused/draining intent fences, approved-secondary PERSONAL/fleet GPU
  alignment, current-DXGI/boot proof and retained qualification-cleanup fencing.
  It also includes protected Main recovery/rebind, Library fixes, Preparing,
  current-snapshot keyboard dispatch and existing controls without GPU Ready.
- Earlier full-suite keyboard/Doctor and moving login-port failures below are
  resolved. Their dated records remain history rather than current blockers.
- Final task/feature audit continues. W28 review found a modal initial/return
  focus and busy-dismiss gap; its narrow source fix and focused fixtures are
  underway after this full checkpoint. Later edits are not implicitly covered.
- W17 source/code task is checked; native Windows acceptance remains unchecked.
  W34 C++/installer/DirectML/Chrome/OAuth/audio/Share/logon/UI/release proof is unrun.
  No commit, push, signing, deployment, publication or live enrollment occurred.

## Earlier source continuation — 22:03, 2026-10-09

- Main now binds genuine post-Prepare fleet recovery, protected startup fencing,
  positive retirement and retained rebind/explicit retry. Ordinary GUI uninstall
  preserves independent worker startup. The current independent login bootstrap
  has source/fixture evidence; actual Windows login is unrun.
- Library deletion retires only exact current playback after ACK/current-owner
  proof. Cache integrity failures, original sharing and honest availability/trim
  explanations are corrected. Preparing progress uses the actual 0–1 fraction.
- W17 is `code-complete / Windows pending`: its fresh six-file history/Library/
  listening composition passed 81 tests. Its task/index checkboxes now reflect
  source completion without checking Windows acceptance.
- Recovery subset passed 28 tests/5 files; later keyboard/preparing/localization
  passed 39/5. Static headless accessibility passed 14/1 across all seven routes
  in both languages. TypeScript, lint (435 files, zero findings), source build,
  owned formatting and both bundle boundaries passed at their recorded snapshots.
- Full regression at 21:59:30 passed 1,389 tests and failed two in 172 files.
  The stale keyboard closure is fixed with focused proof. Current Doctor/GPU
  composition, approved secondary GPU PERSONAL/fleet alignment, final bootstrap
  packaging and combined checks continue. Do not call the whole tree validated.
- See [current recovery/history evidence](evidence/W10-W16-W17-recovery-integration-2026-10-09.md).
  W34 native/GPU/browser/UI/live tests remain unrun; no release action occurred.

## Earlier source continuation — 20:43, 2026-10-09

- Full desktop checkpoint at 20:38:50: **1,265 tests passed in 162 files**;
  TypeScript, lint (416 files, no warnings/errors), source build and both bundle
  checks passed. Later UI subset: **36 tests passed in nine files** at 20:43:56.
- Main now binds bounded private Chrome reports, exact captured personal scope,
  acknowledged event-watch recovery, account usage and realtime rejection, and
  approved-origin guest policy without downgrading rejected accounts.
- Preferences/UI closure includes readonly readiness, translated stages/errors,
  custom sleep, busy keyboard suppression, recovery navigation and RTL/modal
  state preservation. See [current evidence](evidence/W28-W30-W15-ui-integration.md).
- Source review found and is closing immediate account scope retirement,
  reboot-sensitive GPU qualification, DirectML session serialization and remaining
  native installer/trust/Share boundaries. The full checkpoint does not cover
  later changes implicitly; final combined regression and task audit continue.
- Current boot-witness migration is not type-complete: the later TypeScript
  check reports fleet/update qualification and Host fixture mismatches. Owners
  are updating those contracts/fixtures. Later playback/listening/UI slice passed
  69 tests in six files; full lint and formatting passed, and documentation has
  1,020 valid local file links with zero errors. Do not call the current tree fully
  validated until the boot migration and final combined checks finish.
- W34 Windows/native/GPU/browser/UI/live checks remain unrun. No commit, push,
  publication, deployment, enrollment or real-user data deletion occurred.

## Earlier stable source checkpoint — 19:50, 2026-10-09

- **1,197 desktop tests passed in 152 files**. TypeScript, full lint (398 files),
  full formatting, source build and both bundle boundary checks passed.
- Core source now includes account/device management; guest/account Library,
  history/player/queue/listening; local GPU preparation and processing; cloud and
  shared Chrome paths; per-user session/worker and Advanced controls; bounded
  saving/reuse/storage; settings/localized native dialogs, Diagnostics and update
  recovery. This is code evidence, not installed Windows proof.
- The independent desktop policy editor/backend path and existing realtime app
  gate projection have focused/backend/dashboard code and loopback evidence.
- Latest integration fixes capture playback metric ownership, fence stale queue
  actions, gate fresh-result autoplay, bind native Share copies/receipts and
  serialize updater reinitialization/background writer deferral.
- Remaining source work: finish the complete parity/security/package/harness
  review and check each expanded acceptance row against its evidence. Native
  C++ review continues; actual Windows compilation/installation/GPU/Chrome/OAuth/
  sharing/audio/update/device UI and release acceptance remain deferred to W34.
- No commit, push, publication, deployment or live enrollment occurred.
- Details: [latest integration evidence](evidence/W16-W18-W29-final-integration.md).

## Earlier implementation handoff — historical context

- In progress: trusted Worker Advanced main/preload/UI/export composition,
  initialization/shutdown ordering and account-independent worker controls.
- Parallel source work: browser owner proof/account gateway and Mac regressions;
  actual updater rollback/approved active-fleet identity; personal pre-acquisition
  reuse and storage/input recovery closure.
- Initial desktop `npm run typecheck` passed on this turn's starting snapshot;
  coupled changes require their own final validation. No Windows/native/UI/live
  operations are run on this development Mac.
- W34 stays deferred until the user connects the named Windows target. No commit,
  deployment, enrollment, destructive installed-data mutation or publication.

## Earlier source integration checkpoint — 18:37, 2026-10-09

- Desktop full source/headless suite: **1,106 tests passed in 145 files**, no skips;
  started at 18:37:30 and completed in 26.40 seconds.
- Current TypeScript, full lint (387 files, zero warnings/errors), source build
  and both renderer/preload bundle boundary tests passed.
- Main now integrates real updater activity/installer handoff, rich benchmark
  native pickers/streamed destinations, readonly readiness/shortcut actions and
  local Diagnostics. These source checks do not prove Windows behavior.
- Final parity review, native Share/dialog translation, independent
  desktop dashboard policy, final installer/harness review and overall task
  closure continue. W34 remains deferred until connection.
- See [the detailed checkpoint](evidence/W25-W29-W30-main-integration.md).

## Production binding checkpoint — 2026-10-09

See [current main/player/browser binding evidence](evidence/W04-W18-W27-production-bindings.md).

- Desktop full headless/source suite passed 966 tests in 124 files at 16:53:51;
  full lint, TypeScript, source build and both bundle boundary tests passed.
- Main now composes real Advanced commands/exports, account-independent worker
  controls, cold cloud/guest Chrome media, exact playback publication proof,
  account SID gate, bounded transport recovery and event-driven headless lifetime.
- Player has direct original start, Restart/manual Next/repeat/queue occurrence
  parity and explicitly separate standalone voice-output coordinates/markers.
- Later sleep-at-natural-end and AB-buffering fixes passed 36 player/listening
  tests; the earlier full-suite result is not silently extended to later edits.
- W29 Main/update UI, rich W25 controls/retirement, W28/W30 and W31/harness source
  continue. W34 Windows/GPU/UI/live acceptance remains unrun.

## Completed task-preparation phase

The earlier planning request was a deep AI-agent task pack. That phase expanded and verified
the task documents without new app implementation. The implementation agent
will complete source and available code checks without a connected Windows
machine, then run real Windows acceptance after connection. Existing implementation
records below are historical checkpoints, not a current whole-app pass. Partial
source must be reviewed and validated before its task is closed.

The expanded task pack adds concrete execution plans, failure/recovery cases,
code-only fixtures, integration returns and a feature acceptance inventory. New
implementation and Windows checks remain unchecked until their own evidence exists.

## Planning deliverable

- [x] Review the existing macOS/Chrome/worker/backend architecture and porting gaps.
- [x] Record the user's Windows/GPU/shared-extension/per-user-worker decisions.
- [x] Create ordered task specifications and map all 30 accepted scope points.
- [x] Separate code checks from later Windows acceptance and release actions.
- [x] Validate this documentation set's links, dependency order and formatting.

## Planning validation — 2026-10-09

### Latest source-aware task review

The current review preserves partial source and updates the task pack rather than
starting new implementation. It supersedes stale gap claims in the older planning
record: fresh transfer and Advanced core source now exist, the typed fleet fixture
is repaired, and newer browser changes still need validation. See
[RESUME-GAPS](RESUME-GAPS.md) for exact current failure/integration boundaries.

- [x] Review all 34 task specifications against current component/source
      inventories and the 30 accepted points; retain 93 named feature journeys.
- [x] Add production returns for sole account/headless authority, cold manual
      Cloud without local Prepare, cache-only restore and playback-gated publication.
- [x] Correct native-only link visibility scope and retain every required Worker
      Advanced benchmark journey rather than making accepted parity optional.
- [x] Specify reboot/device identity, exact writer/tombstone recovery, account-free
      local worker controls and update rollback/approved-fleet identity preservation.
- [x] Complete named account/device/privacy/policy, direct original/standalone
      trimmed voice, transport/count/timer, shortcut/settings and Diagnostics action
      requirements from the final read-only macOS source audits.
- [x] Reconcile current source checkpoints without checking incomplete whole
      tasks or any real Windows item; preserve the latest known browser failure.
- [x] Finish final refreshed-pack formatting, link/anchor, dependency, checklist
      and whitespace checks; results are recorded below.

Final refreshed-pack checks actually run:

- `node chrome-extension/node_modules/prettier/bin/prettier.cjs --check 'docs/windows-desktop/**/*.md'`: passed, exit 0, all 71 Markdown files.
- Read-only Python folder audit: 34 ordered tasks, all 30 scope points, 93 feature
  journeys, valid local links/heading anchors, earlier-only foundation dependencies,
  required checklists/handoffs and zero checked native-acceptance items; zero errors.
- Task checklists preserve 141 historical checked items and 901 pending items;
  counts are documentation state, not whole-app completion or test coverage.
- Explicit folder-wide fence/whitespace/final-newline checks and
  `git diff --check -- docs/windows-desktop` passed. The Python checks include
  untracked files that Git diff does not inspect.
- Planning base is `c0218633c43559c8ad1988e5037273970a91f99b`; existing dirty app
  source is preserved. See [the review record](evidence/TASK-PACK-REVIEW-2026-10-09.md).

No new application tests, Windows/native/UI/live checks, enrollment, deployment
or publication are part of this planning review. The older implementation evidence
below describes its recorded source slice and must be revalidated after changes.

### Expanded task pack — final documentation checkpoint

- [x] Deepen all 34 tasks with execution order, source/authority boundaries,
      failure and recovery cases, meaningful portable fixtures, deliverables and
      separately deferred Windows acceptance.
- [x] Add the sequential execution plan, 93 feature acceptance journeys across
      all 30 points, required input inventory and current source-gap handoff.
- [x] Preserve manual Chrome cloud-provider processing alongside the separate
      native handoff, all queue editing actions and valid trimmed playback/export/
      share. New private trimmed ingestion remains conditional future scope.
- [x] Record source-checkpoint limitations accurately, including the typed fleet
      mutex lease fixture failure and remaining setup/composition/release gaps.
- [x] Finish folder-wide formatting, link/anchor, dependency, checklist and
      whitespace validation without app implementation or Windows actions.

Actual final checks for this documentation phase:

- `node chrome-extension/node_modules/prettier/bin/prettier.cjs --check 'docs/windows-desktop/**/*.md'`: passed for all 68 Markdown files.
- Read-only Python structure/link audit: 34 sequential task files; 955 valid
  local links, including five Markdown heading anchors; all 30 coverage points;
  93 future feature journeys; earlier-only declared code dependencies; complete
  required sections and detailed handoffs; zero errors.
- The task files preserve 137 checked historical items and contain 753 pending
  items, counting both bullet and numbered checklists. Native acceptance and the
  93 feature journeys remain unchecked. These counts are documentation state,
  not product-completion or test-coverage measurements.
- Explicit whitespace/final-newline/fence checks passed for every file.
  `git diff --check -- docs/windows-desktop` also passed; explicit file checks
  cover the folder's untracked files that Git diff does not include.
- No production source edits, application/device/browser/native tests,
  deployment, publication or real enrollment occurred in this documentation
  phase. Earlier code evidence is retained below; see RESUME-GAPS.md for its
  limitations and the latest reported failure.

### Initial planning checkpoint retained

- `node chrome-extension/node_modules/prettier/bin/prettier.cjs --check 'docs/windows-desktop/**/*.md'`: passed after formatting only this new folder.
- Read-only Python documentation validation: 44 Markdown files, 34 sequential task
  files, all 30 scope rows, 709 existing local links, earlier-only dependencies,
  required checklist sections and task-index coverage; zero errors.
- Whitespace/final-newline checks: passed for every file. Scoped
  `git diff --check -- docs/windows-desktop` also returned success; the explicit
  file checks cover the new untracked files that Git diff does not include.
- The initial plan contained 396 unchecked task items. The implementation records
  below and individual task files now identify completed code work; native items remain pending.

## Earlier implementation checkpoints

- Earlier authorization and source checkpoints are retained for traceability; use the current request to determine the active phase.
- W01: code-complete / Windows pending; new component/build boundary and parity inventory validated.
- Current root work: W02/W04 integration, W08 concrete preparation, W09 readiness caching and W11 serialized GPU admission. See their evidence for completed slices and production composition still open.
- W05 and W07: code-complete / Windows pending; see their task evidence for exact scope and baseline limitations.
- Parallel work: W10 native/session composition and physical GPU guard; W12 personal DirectML processing; W23/W24 fleet onboarding/runtime/controls. W06 runtime recipe, W14 account and W15 realtime/usage cores have source evidence; dependent UI/runtime integration remains open.
- Remaining tasks continue in dependency order; do not wait for Windows.
- W34: pending implementation and a connected Windows machine.
- Application code checks: W01 verify passed (22 unit/component tests, 2 bundle boundary tests, typecheck/lint/build/format); production dependency audit zero findings.
- W01 full dependency audit: 8 moderate development-tool findings in the builder download/logging chain; revisit before packaging/release.
- Shared companion code checks: typecheck/lint and focused 102 tests passed. Full suite finished with 2269 passed, 4 skipped, 1 failure in existing app-setup backoff coverage; record and revisit in W08 rather than changing unrelated assertions.
- W04 shell code checks: verify passed with 33 tests plus 2 bundle-boundary tests, type/lint/build/format. File capabilities, single-instance recreation, section persistence and quit policy exist; account UI/export/processing activity integration remains open.
- Windows native tests: none run.
- Latest desktop code snapshot: 197 tests passed across 22 files, TypeScript passed, scoped root lint passed and two bundle boundary checks passed. Build passed; unused worker module URL warnings were removed in a later build. This is code proof, not native Windows proof.
- Latest affected shared companion checks: 162 focused tests passed across windows-config/local-platform/downloader/app-setup files, and TypeScript passed. The earlier full-suite backoff failure passed in this focused rerun; a new full regression run remains necessary after shared changes stabilize.
- Next action: bind the real native GPU guard/admission factories to personal/fleet/Prepare, finish registration/readiness/packaging, then continue remaining product features. Do not stop for absent Windows.

## Resume record

New product files are under windows-desktop/. Shared changes currently touch desktop-protocol.ts
and new local-platform.ts/tests; other agents own their stated worker/backend paths.
See task evidence for exact commands. Keep unrelated existing dirty work. Native security,
GPU and backend tests have separate scopes and must not be mistaken for Windows proof.

## W09 code checkpoint

- Added DPAPI-bound private startup capsules, bounded file/GPU identity checks and exact previously activated offline artifact reuse.
- Readiness/preparation/qualification/receipt/host suites: 49 focused tests passed; scoped lint and desktop TypeScript passed.
- Cached status never authorizes execution or accepts an interrupted journal; first install and repair retain full verification.
- Shared host/agent status composition and Windows NTFS/GPU/timing validation remain pending. See W09 evidence.

## Personal/player/listening source checkpoint

- Desktop personal processing now uses the independent session authority, opaque selected-file capabilities, explicit rights confirmation and event-driven full progress snapshots. Partial connection failures close their UI helpers and remain recoverable; changing the selected file resets its rights confirmation.
- W18/W19 controller, media server, exact Library artifact pins, React audio controls, listening domain, DPAPI preferences and owned CPU silence branch have source evidence. Main/Library/history composition remains in progress.
- Combined root checkpoint: 55 tests/10 files passed; desktop TypeScript, 27-file scoped lint and source builds passed. All UI tests were headless; no Windows, Electron/browser UI, installed-state or live-account tests were run.
- Prepare now calls the concrete per-user browser registration module. Native Chrome host, installer/runtime resources, application composition and real registry/codec/GPU fault behavior remain under implementation or W34 acceptance.

## Integrated Library, cloud and preferences checkpoint

- Trusted main now composes account/guest Library, actual player media grants and pins, listening/history, cloud submission and result adoption. Library playback freezes the visible Up Next order; loaded account pages retain individual full-snapshot subscriptions, bounded at 82 pages/4096 unique jobs, and owner changes fence every page.
- Evicted local copies are reported unavailable rather than treated as playable. Exact linked account hashes authorize restoration; account changes do not reassign guest results. Captured completion/outbox/reuse integration is still being completed.
- Preferences, English/Arabic, RTL, licensed font packaging, keyboard controls, modal focus and accessibility CSS have source evidence in W28. Remaining Worker/storage/update/diagnostics UI must use the same checks.
- Latest root checkpoint: 71 tests across 12 files passed; desktop TypeScript passed; source build passed; two package-boundary fixtures passed; scoped lint passed on 39 files. The font-bundle issue found during validation was corrected before the successful build/boundary checks.
- Native GPU keeper/watchdog crash handling and per-user browser registration have additional source/fake-transport checks. No Windows compilation, registry, GPU, Authenticode, real browser, installed app or live-account/fleet checks were run.
- W12 trim parity is under correction: the earlier runtime ignored the trim recipe. Exact retained-sample maps and original/voice propagation must finish before that feature is marked complete.
- Continue W20/W21 completion/reuse, W22 storage hooks, Worker main/Advanced UI, W27 shared extension, W29 concrete updates, W30 diagnostics, W31 release tooling and W33 acceptance harness. W34 remains deferred until the machine is connected.
