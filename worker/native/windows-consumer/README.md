# Windows consumer native boundary

`musicmute-native.exe` is a Windows x64 C++20 helper for the per-user consumer
profile. It never calls SCM, WinSW, HKLM or an administrator shell. The existing
LocalService adapter is unchanged. Production builds use the static MSVC runtime
and an `asInvoker` manifest. Bundle the compiled executable at
`runtime/native/musicmute-native.exe` inside a signed `windows-user` release.

The session agent owns a persistent helper transport. Closing the helper's stdin,
killing the helper or ending the Windows session closes its kill-on-close Job
Objects and terminates their owned descendants. The app UI must not own this
transport for fleet work: closing a window or signing out must not close the
session agent's guardian. Bootstrap the independent session agent through its
stable launcher; its guardian then launches fleet work. The hidden top-level
window handles `WM_QUERYENDSESSION`/`WM_ENDSESSION`; logout verification remains
a real Windows acceptance gate.

## Build and code checks

From a Windows x64 developer command prompt, with CMake and the MSVC SDK:

```sh
cmake -S worker/native/windows-consumer -B windows-desktop/native-build -A x64
cmake --build windows-desktop/native-build --config Release
ctest --test-dir windows-desktop/native-build -C Release --output-on-failure --no-tests=error
```

The default `MUSICMUTE_PACKAGE_AUTHORITY=store` requires the production identities
and actual Store signature kind 3. The separately authorized local test build
uses `-DMUSICMUTE_PACKAGE_AUTHORITY=development-test` and the required
`-DMUSICMUTE_DEVELOPMENT_CERT_SHA256=<64 lowercase hexadecimal characters>`.
That public digest identifies the exact DER signing certificate; no private key
is exported or compiled. Use a separate build directory. An invalid profile,
missing/malformed test pin, or test pin supplied to the Store build fails CMake
configuration. These settings are compile time only.

The test build accepts only `MusicMute.Development` and
`MusicMute.WorkerDevelopment`, publisher `CN=MusicMute Z440 Development`, publisher
ID `kthggmwhkdz4t`, and genuine Windows Developer signature kind 1. It checks the
single CMS signer and signature from the immutable installed `AppxSignature.p7x`
against the compiled certificate digest and validity period. Both profiles still
require a healthy registered protected x64 package, standard logged-in user,
fixed roles and complete sealed inventory hashes. Loose `IsDevelopmentMode`
registrations remain denied. Store builds reject the test identities/signature;
test builds reject production Store identities/signatures.

Protected package reads anchor at the exact current OS-registered package root,
not at the WindowsApps container, which standard users can traverse but cannot
open. The held root still requires a non-reparse normalized path, immutable OS
ACL and no delete sharing; every in-package directory and file retains its own
held-handle, path, ACL and sealed-hash checks. Registration, signature, health
and root path are revalidated. Private/user filesystem containment is unchanged.

Development builds also expose a closed `MMDEV1` startup diagnostic: one fixed
phase token and bounded numeric error, wait, exit and Job census observations.
The native stdio helper emits at most four ASCII lines of at most 256 bytes;
Worker controls show the same closed observations on failure. No paths,
arguments, credentials or raw exception text are included. Production builds
emit no such diagnostics. These observations never replace any authority,
process-exit or whole-Job cleanup check.
Typed native denials survive the existing wire-error translation in development
diagnostics. A rejected StartupTask OS call retains its numeric HRESULT in the
existing `win32` field; public wire errors and production output are unchanged.
Startup state queries use `StartupTask.GetAsync` for the fixed manifest task ID,
then require the returned task ID to match. Async failures retain their original
HRESULT before cancellation; the existing ten-second operation bound, current
package/process checks and foreground-only enable/disable consent remain.

Packaged Store children use the documented Desktop Bridge creation policy
`OVERRIDE | DISABLE_PROCESS_TREE` (6), keeping the created process and subsequent
descendants in the actual creator's package runtime. The value is held through
attribute-list destruction and an attribute failure denies creation. The same
suspended-child package/image/SID/session/hash attestations still run before
resume. Legacy children and the intentional ordinary system registry query
retain their original behavior. The Win32 attribute contract test does not
substitute for actual installed package-child identity and GUI/GPU acceptance.

Registered test packages use separate `MusicMuteLocalDevelopment` and
`MusicMuteWorkerDevelopment` Local App Data directories, profile-specific
account/session mutexes and the corresponding test AUMIDs. Existing production
data and legacy unpackaged paths are preserved. Physical GPU ownership remains
shared between profiles. Local test signing and installation do not establish
Microsoft Store acceptance, signing, licensing or publication.

CTest includes the strict portable JSON parser and an isolated Win32 test for
identity, ACL denial, DPAPI namespace separation/corruption/atomic failure,
authenticated pipes and Job Object descendant cleanup. The native test requires
an interactive standard-user session and only writes a new random test directory
under that user's Local App Data. It never uses installed MusicMute data. A test
failure retains its scratch directory and closes owned jobs.

On the Mac, from `worker/`:

```sh
pnpm exec vitest run tests/windows-consumer-native.spec.ts tests/windows-consumer-native-transport.spec.ts
node --test scripts/consumer-native-json.test.mjs
pnpm exec tsc --noEmit
```

These checks exercise policy with injected adapters, actual bounded child-process
transport using isolated Node fixtures, and the portable C++ parser. They do not
compile Win32 source or establish Windows behavior. Real two-user DPAPI/ACL
tests, remote pipes, junction attacks, crash/logout handling and signed packaging
remain W34 work.

## Retained personal engine

The personal role can keep exactly one guardian/engine pair loaded between
attempts. `retained_engine_register` accepts exact `guardian` and `engine`
process identities and returns a random 64-character lowercase-hex `token`.
Both living process handles remain open. The native helper requires its exact
bound personal Node parent, one live role-bound physical GPU guard, the same
SID/session, owner → guardian → engine lineage and the fixed prepared Python
image derived from the Node image's `runtime/node/node.exe` suffix.

`retained_engine_begin` and `retained_engine_complete` accept `token` and
`job_id` (a lowercase UUID v4), returning `{ "busy": true }` and
`{ "idle": true }`. Only the matching busy attempt can complete. Main issues
completion after the trusted engine response confirms detachment of all
attempt files, logs, callbacks, subprocesses and tensors. Both transitions
query the actual bounded Job census: only the exact owner, its existing fixed
native helpers and those two retained Python generations may remain. Unknown
Python processes, descendants, stale births, absence and query failure deny
quiescence. `retained_engine_idle` returns the current exact proof for `token`;
busy engines return false. `retained_engine_forget` acknowledges only after
both held process handles are positively signalled, original `gpuRoleIdle`
succeeds, and both handles close successfully.

Retained quiescence permits only this bound personal owner's completed
processing-attempt workspace markers to retire. It does not change
`inference_idle`, GPU guard release or general file/artifact authority. The
fixed `personal/engine-session/UUID` scratch family remains protected while
Python lives. Its cache admission and disposal read the exact private workspace
marker and require positive original inference/tool-free idleness for the
same bound owner, or its whole-Job exit certificate. That marker must remain
until session scratch deletion finishes; retained quiescence cannot retire it.

Background Node roles, the retained login/on-demand Node launchers and private
helper transports detach their console instead of allocating hidden console
host processes. Suspended role assignment, existing Job inheritance and the
launchers' existing independent-job flags remain in force. Helper pipes stay
referenced: input EOF, actual parent watchers and owned Job guardians continue
to determine lifetime. No console-host image is admitted by either idle census.

Local injected-adapter tests and native stand-in process fixtures preserve
these boundaries separately from real model, installed release and logout
acceptance. They do not establish production signing or a physical GPU run.

## Private contract, version 1

The helper consumes UTF-8 JSON objects separated by LF on its private stdin.
Each request is at most 65,536 bytes and has exactly `version`, monotonically
increasing positive integer `id`, fixed `operation` and operation-specific `args`.
JSON duplicate keys, invalid UTF-8, lone surrogates, noncharacters, excessive depth
and non-integer numbers are rejected. Only sixteen requests may queue.

```json
{ "version": 1, "id": 1, "operation": "identity", "args": {} }
```

Responses contain `version`, matching `id`, `ok` and either `result` or a safe
`error.code`. Native text, command lines, credential contents and stack traces
are never error payloads. An incompatible helper version, unknown response ID,
duplicate response, oversized frame or timeout closes the transport. Secret
writes are never automatically replayed after an uncertain response.

| Operation                  | Arguments                                                   | Result and constraints                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`                 | none                                                        | SID, logon SID, session ID, helper PID/FILETIME birth identity, native/process architecture, actual OS build and Known Folder Local App Data.                                          |
| `process_identity`         | `pid`                                                       | Actual SID/session/PID/decimal FILETIME, or `null` only for confirmed exited/absent process; inaccessible state is an error.                                                           |
| `ensure_private_directory` | `root`, `relative_path`                                     | Create an explicitly private directory under `personal` or `fleet`; returns its native resolved path.                                                                                  |
| `validate_path`            | `root`, `relative_path`, `kind`                             | Validate directory/file/absent target, locked ancestors, non-reparse canonical path, owner/ACL and single-link regular file.                                                           |
| `vault_put`                | `namespace`, `key`, `bytes_base64`                          | Account/fleet namespace, lowercase key, at most 16 KiB plaintext; current-user DPAPI then encrypted atomic write.                                                                      |
| `vault_get`                | `namespace`, `key`                                          | Versioned bounded record bytes or absent; corruption has no plaintext fallback.                                                                                                        |
| `vault_delete`             | `namespace`, `key`                                          | Explicit removal of that key's encrypted record.                                                                                                                                       |
| `vault_recover`            | `namespace`                                                 | Explicit scan of at most sixteen correctly named stale encrypted staging files, private regular entries only; newer files are retained.                                                |
| `launch_owned`             | `role`, `release`                                           | Fixed `session-agent`/`personal`/`fleet`/`prepare` entries and runtime Node path; assigns suspended child to guardian Job Object before resume, returns random nonce + birth identity. |
| `stop_owned`               | `role`, `nonce`, `identity`                                 | Terminates only a Job Object owned by this helper, with exact nonce/SID/session/PID/FILETIME match.                                                                                    |
| `pipe_exchange`            | `channel`, `nonce`, `peer`, `timeout_ms`, `response_base64` | One authenticated server transaction. First instance, session logon SID DACL, remote rejection, expected client birth identity and random nonce.                                       |
| `pipe_connect`             | `channel`, `nonce`, `peer`, `timeout_ms`, `payload_base64`  | Native client transaction with specific pipe rights and expected server birth identity.                                                                                                |

`personal` is `%LOCALAPPDATA%\MusicMuteLocal`; `fleet` is
`%LOCALAPPDATA%\MusicMuteWorker`. The helper resolves both through Known Folder
APIs, never a renderer-supplied absolute root. Consumer data grants only the
current owner and SYSTEM, with a protected root DACL. Inherited child ACEs are
accepted only when they still grant those identities. LocalService, broad Users,
Everyone and other user owners are rejected. Ancestors stay open without delete
sharing during mutations, preventing reparse/rename substitution. Relative paths
reject traversal, UNC/device paths, alternate streams and reserved names; Unicode
and spaces are passed as strings, without shell interpolation.

Vault files contain `MMCV0001`, a four-byte little-endian ciphertext length and
DPAPI ciphertext. DPAPI entropy binds the format, namespace and key. The helper
uses `CRYPTPROTECT_UI_FORBIDDEN`, never `CRYPTPROTECT_LOCAL_MACHINE`. It flushes a
new private staging file before atomic replace and keeps the previous ciphertext
after commit failure. Sixteen abandoned staging records block further writes
until explicit bounded repair. DPAPI and the DACL do not isolate credentials
from every hostile process running as the same user.

Named pipe messages use a four-byte little-endian JSON byte length: at most
8192 request-envelope bytes and 49152 reply-envelope bytes, with a 4096-byte
application command and a 32768-byte application reply. Each transaction has sequence
one and a fresh 64-character random hex channel/nonce. The helper and wrapper
reject reuse. Pipe DACL rights exclude `FILE_CREATE_PIPE_INSTANCE`; ordinary
generic-write Node pipe connections may therefore be rejected. Use the native
client operation. Both peers check the kernel-reported process birth identity;
the server also checks the impersonated client token's SID/logon/session. The
`pipe_exchange` retains the compatible predetermined-response snapshot operation.
State-changing brokers use `pipe_accept`, execute authenticated dispatch, then
`pipe_reply` or `pipe_close`. Capabilities expire and bind the actual accepted
peer/nonce. Concurrent native client waits do not move thread-affine mutex work.

## Fixed process layout

The fixed roles launch
`MusicMuteLocal\runtime\releases\<release>\runtime\node\node.exe` with the
corresponding `agent\session-agent.cjs`, `agent\personal.cjs`,
`agent\fleet.cjs` or `agent\prepare.cjs` in that release.
They receive only `--consumer-config` pointing to the role's fixed personal/fleet
data-root config: session/fleet `consumer-config.json`, personal
`personal-config.json` or Prepare `prepare-config.json`. No arbitrary executable, shell string, eval
flag or renderer argv is accepted. The helper filters inherited environment
variables and excludes Node/Python startup injection settings. The wrapper
requires a launch verifier for the signed consumer inventory and current leases;
the signed digest and inventory remain the release layer's authority.

## Native user Share and inference cleanup

`share_start` accepts only a sealed `share\\requests\\<UUID>\\media.<audio extension>`
copy, SHA-256/byte count, bounded title/MIME, the actual app window HWND and its
PID/creation-time/SID/session identity. The current helper must be a child of the
signed, account-gated installed app. No caller-selected executable, recipient,
URL or renderer path is accepted. A separate STA owns a popup whose verified
owner is that app window and uses `IDataTransferManagerInterop` with that popup.
Only user-selected Windows Share UI delivers the read-only StorageFile.

The helper saves an account-DPAPI pending receipt before showing the sheet. The
receipt binds the request nonce, helper/app process identities, relative path,
SHA-256/bytes and Windows volume/file-index/creation-time identity. `shown` is
an observation, never cleanup proof. `share_cancel` fences new data delivery;
it does not invent a ShareCanceled event. Main waits at most five minutes and
retains uncertain copies and their persistent storage budget. `share_inspect`
never reopens the Share sheet or derives terminal success from process death.

`share_cleanup_acknowledge` accepts only the exact request/nonce after the
terminal/quiesced receipt and staged-copy absence. A lost acknowledgement or
already removed journal row is recovered by fixed `share_cleanup_completed`:
at most sixteen completed/quiesced absent-copy receipts are removed per scan.
Pending/unconfirmed receipts and present copies are retained, without a TTL.
The recursive current-SID account namespace mutex serializes the persistent
64-receipt slot limit across dedicated helpers; reaching it fails Share busy.

Only an actual DataPackage ShareCompleted or ShareCanceled callback, followed
by revoked handlers, released package/StorageFile/ancestor handles and an
exclusive file open with exact birth/hash/size, permits `quiesced:true`. If a
different helper inspects an incomplete terminal receipt, the original helper
must have positively exited before probing; an active exact helper retains
ownership. Root account/window invalidation requests a delivery fence. Source
and controller tests do not establish actual Windows dialog/event semantics.

After an actual terminal callback, the dedicated STA retries only a blocked
exclusive-open proof every 200 ms for at most five minutes. This bounded local
file-handle reconciliation emits the existing quiesced event when proven and
retains incomplete proof at the bound. It does not poll HTTP/job status or
delete a copy merely because time elapsed.

`inference_idle` is a read-only query for the helper's already bound personal or
fleet named Job. It rejects an unbound helper and uses actual Job process-list
inspection. Only the exact fixed Node owner and permitted native helper children
may remain; inference/downloader/media descendants deny idleness. Consumer
personal/fleet cleanup now waits for this proof after engine stop. An exited
Python guardian PID alone never grants scratch deletion or GPU release.

References reviewed 2026-10-09: [desktop Share integration](https://learn.microsoft.com/en-us/windows/apps/develop/windows-integration/integrate-sharesheet-send),
[DataPackage events and Windows version history](https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.datatransfer.datapackage?view=winrt-26100),
[ShareCanceled](https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.datatransfer.datapackage.sharecanceled?view=winrt-26100).
ShareCanceled requires Windows 10 2004; the agreed Windows 10 22H2 minimum includes
that API. WinRT compilation, actual Share callbacks, second-logon behavior and
whole-Job cleanup remain connected Windows acceptance work.

## Volatile witness and installer trust

`boot_identity` returns the exact bounded object
`{boot_id:<64 lowercase hex>,source:"volatile-registry-witness-v1"}`. This is an
app-owned **volatile user-hive lifetime witness**, not a BCD identifier or kernel
boot GUID. The fixed private HKCU key is initialized under a current-SID kernel
mutex. It survives helper/app exit; hive unload/reboot invalidates it. Earlier
hive unload causes conservative extra qualification. Existing keys must prove
actual volatility with a fresh nonvolatile child probe returning
`ERROR_CHILD_MUST_BE_VOLATILE`; ignored create options are never accepted as
proof. Owner/protected DACL, symbolic-link handling, closed values, named handle
rechecks and size/encoding checks fail closed. It accepts no path or caller
witness. Old/missing readiness witnesses require fresh local qualification.

Installed app peer/Share verification remains fixed-path and exact approved
SHA/bytes/publisher bound. Only that already-approved installed check requests
`WTD_CACHE_ONLY_URL_RETRIEVAL`; revocation and signature policy remain enabled,
and unknown/stale/missing trust still fails. New helper/installer/package
approval retains network-capable whole-chain verification. Neither path uses
hash-only, no-policy or no-revocation flags.

The closed `--installer-path-preflight` entry authenticates its actual signed
NSIS parent (same SID/session/birth, same trusted signer, MusicMute setup or
uninstall version marker, asInvoker and supported host) before fixed directory
creation. It rejects reparse/hardlink/foreign or oversized existing trees, holds
every fixed ancestor/existing directory, and duplicates bounded zero-access,
non-inheritable directory references into that exact parent. Their share modes
deny directory write/delete replacement until the installer exits. Child-file
removal/extraction remains the signed installer's job; no arbitrary path or
process ID is accepted. Empty app directories can remain after uninstall while
those references are held. Win32 behavior is not proven by source review.

Primary references reviewed 2026-10-09: [volatile registry keys](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regcreatekeyexw),
[MS-RRP volatile-parent rule](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rrp/c7186ae2-1c82-45e9-933b-97d9873657e8),
[WinTrust policy flags](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_data),
[DuplicateHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle),
[file sharing lifetime](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).
Reboot/fast-startup/hibernation, persistent/linked registry attacks, remote-handle
retention during actual NSIS extraction/uninstall, cached-revocation failures,
and Windows compilation/linking remain unrun W34 acceptance.

## Independent worker login bootstrap — source checkpoint

Explicit activation copies the exact approved, signed `MusicMuteSession.exe` to
the private `MusicMuteWorker\\bin` directory. Its HKCU Run command points there,
outside the GUI install. Ordinary GUI uninstall preserves that command, runtime,
credentials and intent. The retained shim starts the signed runtime's fixed
`agent/login-worker.cjs` under its pinned Node, holding Node/helper/entry and a
five-required-file public resource capsule (plus only optional approved worker catalog trust) immutable through bootstrap. There is no
Electron/account-controller or GUI executable dependency on this login route.

`worker_login_peer_verify` checks helper → Node → retained signed shim, exact
birth/SID/logon, approved hashes and publisher. Only that authenticated helper's
activation lease publishes a temporary session owner; exact nonce/helper release
clears it. This reuses atomic account/session cross-logon exclusion without
acquiring account ownership. Normal UI activation keeps its previous behavior.

`worker_login_idle` accepts only `session` or `prepare`. The former requires
positive certificates for the latest personal/fleet Job trees; the latter also
requires the exact Prepare controller to retire. An abandoned mutex or absent
PID never substitutes for a whole-Job certificate. Uncertain qualification
cleanup retains the real Prepare and activation fences until this proof; native
fatal-owner/logout teardown remains an unconfirmed outcome rather than Ready.

Saved running, paused and draining intent restore through the existing supervisor
after real qualification when the volatile user-hive witness changed. Stopped,
removed, unapproved and restart-blocked workers do not qualify or claim work.
Original approved Fleet fixtures/identity and intent revision are rechecked; no
downloads, re-enrollment or account credential changes occur. Current-witness
restoration uses fingerprints/current DXGI and bounded IPC snapshots; cold Chrome
cloud remains GPU-free and unrelated CPU media does not block a qualified worker.

Microsoft documents the [HKCU Run command limit and delayed scheduling](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys).
Real logon, cross-logon races, signed-shim trust, cleanup fault injection and
uninstall/relogin remain W34. The native isolated fixture injects the signed-peer
boundary only inside its test target; the production protocol has no bypass.

## Store CPU workspace cleanup

Store CPU observations describe the exact Creator-owned operation and original
Personal or Prepare Node. They grant no new process, GPU or file authority.
Marker retirement requires the actual retired operation, version-2 marker,
cache lease and original held parents. Its DPAPI receipt is tagged
`store-cpu-workspace`; generic cleanup and recovery cannot acknowledge it.

The Store ACK closes its original marker/reservation handles before forgetting
the actual Creator row. It retains a private acknowledgement nonce and bounded
completion record until the SDK receives that ACK and sends the separate
`store_cpu_workspace_marker_release` bookkeeping request. Lost replies retry
the same retained owners; another song cannot overwrite their completion.
The release response reports bookkeeping collection only, never file or Job
closure. Neither path stops the warm Personal Node or changes inference quality.

## Guideline review

Reviewed the current [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
and Microsoft [pipe ACL](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights),
[DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
and [Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
documentation on 2026-10-09. Applicable portable rules: 104/105 authentication and
operation authorization, 106 compatibility, 118 snake_case wire fields, 167
bounded UTF-8 JSON objects and 177 safe errors. This component-internal pipe/stdio
contract uses typed adapters and the table above; HTTP methods, bearer headers,
REST URLs, pagination and OpenAPI endpoint declarations do not apply.

## Retained private-file capabilities

The private version-1 transport supports the following additive operations.
Each request keeps the existing closed request/argument schema and safe error
codes. These capabilities are implemented in source; the new native fixtures
still require target compilation and execution. They do not establish signed
installation, Node consumer migration, WinRT/NSIS handoff containment or release
readiness.

| Operation               | Closed arguments                                                   | Closed result                                            |
| ----------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| `private_file_open`     | `root`, `relative_path`, `mode`, `maximum_bytes`, `expected_birth` | `{state:"opened",token,identity}` or `{state:"missing"}` |
| `private_file_info`     | `token`                                                            | `{identity}`                                             |
| `private_file_read`     | `token`, `position`, `length`                                      | `{bytes_base64,bytes_read}`                              |
| `private_file_write`    | `token`, `position`, `bytes_base64`                                | `{bytes_written}`                                        |
| `private_file_truncate` | `token`, `length`                                                  | `{identity}`                                             |
| `private_file_sync`     | `token`                                                            | `{synced:true,identity}`                                 |
| `private_file_close`    | `token`                                                            | `{closed:true}`                                          |

`root` is exactly `personal`. `relative_path` follows the existing validated
Windows single-component grammar with at most 32 relative components and 4,096
UTF-8 bytes. Parents must already exist and be private beneath the approved root.
The native helper walks them from a volume-root anchor, retains every validated
ancestor plus the exact non-reparse, single-link leaf, and never reopens that
leaf by pathname for token operations. Tokens are opaque, random 64-character
lowercase hexadecimal values, scoped to one helper lifetime; at most 16 are live.
They must not be persisted, logged or reused after close or helper exit.

`maximum_bytes` is a positive integer from 1 through 4,294,967,296. Empty files
are supported with positive capacity. All offsets and lengths are nonnegative
integers within that capacity. Reads and decoded writes are at most 24,576 bytes
per request. Read responses may be shorter at EOF, including empty base64 and
zero bytes; callers must honor the returned counts. Writes must use canonical
standard base64 with no whitespace or alternate padding. The helper checks the
entire write span before writing and bounds every truncate. A successful partial
write acknowledges only `bytes_written`; an uncertain mutation acknowledgement
must never be automatically replayed.

`mode` is one of `read`, `create-new`, or `resume`. Read handles permit only read
sharing and reject write, truncate and sync operations. Create-new handles are
exclusive, use the private SDDL and cannot replace an existing leaf. Resume is
exclusive and is allowed only for `prepare\downloads\runtime.part` and
`models\Kim_Vocal_2.onnx.part`. It requires the exact existing birth before any
write/truncate and never truncates during open. `expected_birth` is always
present: null for read/create-new, or exactly `{device,file_id,born_at}` for
resume. All three birth fields use the existing canonical decimal-string cache
identity semantics; `identity` additionally contains integer `bytes` and decimal
string `written_at`/`changed_at`.

Only read-mode exact leaf `STATUS_OBJECT_NAME_NOT_FOUND` returns `missing`.
Missing/unsafe ancestors, reparse/type/link violations, sharing/access denial,
creation collisions and stale resume generations are errors. Before and after
I/O, info, truncate and sync, the helper rechecks retained ancestor and leaf
identity, canonical path, type/reparse/link count, applicable private ACL and
capacity. Ancestor witnesses preserve raw volume/file-index/creation FILETIME
values, including zero and pre-1970 volume timestamps; leaf/resume wire births
keep the existing Node mapping. Effects use the same leaf handle. No generic delete or rename authority
is added. Close only releases a known token's retained handles; it remains
available when data checks reject altered ancestors. A failed close retains the
token and unreleased handles and receives no success acknowledgement. Transport
exit closes the helper's kernel handles and invalidates all its tokens.

The wire preflight read the current [Zalando API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-11. Portable security, compatibility, bounded JSON/object payload and
safe-error principles shaped this extension (104, 106, 118, 167, 177). REST HTTP,
URL, OAuth and OpenAPI rules do not define this existing private stdin protocol.

## Store model publication contract

The Store GUI's three additive operations are `store_model_file_open`
(`mode`, `expected_birth`), `store_model_publish` (`token`) and
`store_model_recover` (empty arguments). They accept no executable/model path,
hash override, alternate root or caller Prepare certificate. The helper checks
the actual GUI/package/data authority and holds its real Prepare mutex before
touching the fixed Kim model stage. Worker roles cannot mutate this model.
Publication pins all 66,759,214 bytes to the existing SHA-256, uses no-replace
handle-relative renames, preserves the old model as a bounded hash-named backup,
and retains a DPAPI intent through original source and ancestor closure. Recovery
requires the exact held births and full hashes; matching content in a different
file is insufficient. A crash after rename and before birth normalization stays
pending; recovery never normalizes a reopened clone. Completed observations are
data, and still require independent qualification before Ready/GPU use.

The wire preflight read the current [Zalando API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-12. Applicable rules are operation authorization (104), additive
compatibility (106), existing snake_case private fields (118), bounded UTF-8
objects and precise number representation (171). Birth values remain canonical
decimal strings; sizes remain bounded integers. HTTP URLs/methods, OAuth headers
and OpenAPI routing do not apply to this internal pipe. The existing Store
qualification stdout frame retains `errorCode` for compatibility with that
separate receiving contract; it emits only closed typed errors, with no paths
or exception text.
