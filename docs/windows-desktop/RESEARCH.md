# Research and decisions

Official sources reviewed for this plan on 2026-10-09. Recheck versions and
release policies before packaging. These sources establish API/design constraints;
they do not prove MusicMute works on a particular Windows computer.

| Topic                     | Official source                                                                                                                    | Consequence for this plan                                                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron isolation        | [Security checklist](https://www.electronjs.org/docs/latest/tutorial/security)                                                     | Packaged UI, sandbox, context isolation, restrictive navigation and narrow validated IPC. Security behavior must match the pinned Electron version.                                                                                                                         |
| Windows secret protection | [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)                                                    | Windows encryption uses DPAPI; another application running as the same user is not excluded by that alone. Fleet credentials need availability independent of Electron UI.                                                                                                  |
| Desktop OAuth             | [Google installed-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)                                   | Use the system browser, state/PKCE and bounded loopback callback. Keep the repository's server-side token-exchange configuration and secrets off the desktop.                                                                                                               |
| Chrome native messaging   | [Chrome documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)                             | HKCU registration supports per-user installation. Preserve the allowed extension identity, bound messages and use binary framed stdio on Windows. Repair must account for registry views.                                                                                   |
| GPU backend               | [ONNX Runtime DirectML](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)                           | Requires suitable DirectX 12 hardware; configure sequential execution and disable memory patterns. DirectML remains supported in sustained engineering; qualify the pinned model/runtime. Do not substitute a newer Windows-only backend that raises the agreed OS minimum. |
| Login trigger             | [Run/RunOnce registry keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)                | Use HKCU Run with a short, correctly quoted stable launcher. Startup can be delayed, so app/Chrome must also support on-demand startup.                                                                                                                                     |
| Process trees             | [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)                                              | Own and terminate complete child trees with tested handle/lifetime behavior. A Job Object is not a complete security sandbox or a GPU quota mechanism.                                                                                                                      |
| Local control transport   | [Named pipe access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)              | Provide explicit DACLs; default permissions include access that is too broad for private control. Validate peers and reject remote clients.                                                                                                                                 |
| Installer                 | [electron-builder NSIS](https://www.electron.build/v26/docs/nsis/)                                                                 | Configure an exclusively per-user x64 installer and audit the generated manifest/scripts. Merely setting `allowElevation=false` is not sufficient evidence of a no-admin installation.                                                                                      |
| Download reputation       | [Microsoft SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)         | Plan production Authenticode signing and downloaded-file tests. A valid signature does not promise the absence of reputation warnings.                                                                                                                                      |
| Future Store route        | [MSI/EXE Store requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements) | Store packaging/submission is separate future scope. Reassess installer, signing and distribution requirements then; website-first keeps that outside implementation dependencies.                                                                                          |

## Refreshed checks for the detailed task pack

Reopened the official DirectML, Chrome native-messaging, Electron security, NSIS,
Google desktop OAuth and HKCU startup documentation during this planning review.
These checks support the adapter boundaries and later acceptance cases; they
provide no MusicMute installation or hardware evidence.

- DirectML sessions require sequential execution and disabled memory patterns;
  do not call `Run` concurrently on the same session. GPU ordinal zero follows
  DXGI enumeration and need not select the strongest adapter. Preserve a
  physical-identity qualification and execution gate in W07/W11. DirectML is
  maintained in sustained engineering; qualify the pinned version with Windows
  10 rather than silently choosing a backend with a higher minimum. [Official DirectML guidance](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html).
- Chrome permits per-user HKCU native-host registration. Host framing, exact
  extension origin and Windows stdout behavior remain real native acceptance
  checks; a protocol fixture cannot establish registry or browser success. [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
- HKCU Run is a launch trigger whose timing may be delayed. Keep on-demand
  single-instance startup and durable intent; do not promise immediate worker
  start or re-enable a startup entry disabled by the user. [Microsoft Run keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys).
- Windows 10 ordinary support ended on 2025-10-14. The user's Windows 10 22H2
  requirement remains the product minimum. W01/W29/W31 must track framework,
  toolchain and dependency compatibility and security maintenance before a
  release; operating-system lifecycle is distinct from tested app compatibility.
  [Microsoft lifecycle notice](https://learn.microsoft.com/en-us/lifecycle/announcements/windows-10-end-of-support).
- The pinned electron-builder 26.15.3 declarations agree with the stable v26
  documentation: an assisted installer with both `oneClick=false` and
  `perMachine=false` offers an installation-mode page. W31 therefore uses explicit
  `oneClick=true`, `perMachine=false` and `packElevateHelper=false`, followed by
  generated-script, fixed-destination, execution-manifest and override checks.
  Check versioned documentation; the current documentation entry also exposes
  unreleased v27 material. [Stable v26 NSIS options](https://www.electron.build/v26/docs/api/electron-builder.interface.nsisoptions/).

## Source-backed conclusions

### Additional primary-source checks for this task handoff

- The pinned Electron 44.7.0 README lists Windows 10 and later. This supports the
  framework selection; it does not qualify MusicMute's entire dependency/runtime
  package on build 19045. Preserve x64-only product guards even though upstream
  also distributes ARM64. [Pinned Electron platform support](https://github.com/electron/electron/blob/v44.7.0/README.md#platform-support).
- Adapter LUID uniqueness is guaranteed only until restart. W07/W09/W11 must
  separate current-boot device binding from persistent physical-device preference
  and never revive an old permit from reused numeric identity. [Microsoft adapter LUID lifetime](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12device-getadapterluid).
- Chrome checks the 32-bit registry view before the 64-bit view; Windows native
  stdio must be binary and length must count UTF-8 bytes. W26/W31/W34 therefore
  check both owned views, partial/Unicode frames and log-free actual app-proxy
  output. App-specific bounds may be stricter than Chrome's transport limits.
  [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
- HTTP Range requests can be ignored; resume requires validated actual status,
  range, representation and strong validator. W06/W08 test clean restart,
  unsatisfied range and changed representation rather than assuming server
  behavior. [RFC 9110 Range semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2).

The source inventory also confirmed the current Mac local-input staging bounds:
64 entries and 512 MiB aggregate. W12/W22 preserve these product resource bounds
with Windows journal/process-birth recovery, rather than importing Mac PID-only
cleanup. See [file provider constants and admission](../../chrome-extension/src/companion/file-provider.ts).

### Product scope corrections from repository evidence

Native link-import visibility explicitly excludes Chrome controls and its bridge.
W13/W15/W27 must retain this boundary; it does not alter cloud account/allowance
admission. Manual saved-cloud START is an existing native-authorized browser
journey alongside explicit app-review handoff and does not depend on local model/
GPU Prepare. [Native hiding scope](../link-import-ui/USER-EXCLUSIONS.md),
[saved processing behavior](../../chrome-extension/docs/processing-selection.md).

### Porting conclusions

- Most acquisition/cache/sync/protocol logic already exists in TypeScript; the
  native Swift UI, account vault, player and setup coordinator require Windows
  implementations. This is a platform port plus UI work, not only packaging.
- Existing Windows worker infrastructure is useful for engine/release behavior
  but assumes a machine service. Per-user credentials, supervision, startup,
  admission and report identity are material changes.
- The current local enrollment report hardcodes a GPU/device/service identity
  more narrowly than backend Windows qualification. Broaden the consumer report
  using real qualification rather than weakening backend admission.
- Model/provider execution must be checked beyond a successful import. The
  existing accelerated-node/zero-CPU-node qualification provides a baseline,
  while normal runtime behavior also needs a fail-closed policy.
- Mac-only code tests can verify state machines, parsers, signatures, owner
  fences and fault recovery. They cannot verify Windows ACLs, GPU behavior,
  credentials, startup, codecs, signed installer behavior or listening quality.

## Deferred empirical decisions

W07/W34 determine hardware support and measured resource limits. W18/W34 verify
Windows media codec/timeline behavior. W31/W34 verify no-admin packaging and
native dependencies. W11/W34 verify cross-session contention guards. Until then,
do not advertise every DirectX 12 GPU, a minimum VRAM number, timing guarantees,
universal codec support or a warning-free installer.
