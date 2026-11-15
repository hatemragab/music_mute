# Setup and created-export receiving checkpoint

2026-10-10, macOS arm64, source and portable checks only. No Electron/browser,
Windows helper/compiler, GPU, registry, installed app, signing or live service ran.
Injected native replies below are not Win32 deletion or Chrome execution proof.

## Production receiving paths

[Main](../../../windows-desktop/src/main/main.ts) binds
[TrustedSaveDestinations](../../../windows-desktop/src/main/save-destinations.ts)
to the private [created-export receiver](../../../windows-desktop/src/main/created-export-discard.ts).
The callback opens the fixed signed app-resource helper, loads the sealed approved
Main pin, and asks that helper for the actual consuming Main process identity.
It sends the immutable exclusively created UUID, birth and closed-FD fingerprint
through the real [SDK](../../../worker/src/platform/windows/consumer-native.ts).
The [native receiver](../../../worker/native/windows-consumer/export_discard.hpp)
authenticates the fixed signed Main/helper parent, pins non-reparse ancestors and
the exact current-SID leaf handle, and persists intent/submitted/completed state.
Its bounded protected certificate is separate from user media and cache deletion.

Main also binds the signed output-location preflight before the registry opens a
new exclusive destination. Unsupported mapped/network/device/UNC/reparse/existing
locations are refused before creation. The registry rechecks captured owner and
abort after the actual native future/helper exit; late revoked consent cannot
create an empty file. This preflight does not claim to eliminate a later same-SID
pathname substitution; exact leaf/ancestor proof is independently enforced during
discard, and unknown cleanup remains retained.

A positive certificate creates a closure over that exact UUID, nonce and approved
pin. Failed acknowledgement retries only receipt retirement; it never repeats
deletion or treats path/inspection absence as deletion proof. The adapter waits
for every helper's actual exit. Failed helper retirement stays strongly retained
and blocks later helper admission until its exact cleanup succeeds. Main's idle
assertion and shutdown cleanup/release include this owner; the dialog registry
retains file/descriptor/pin cleanup independently until positive settlement.

The [closed desktop contract](../../../windows-desktop/src/shared/contracts.ts)
and [preload](../../../windows-desktop/src/preload/index.ts) expose only four fixed
Setup actions. Main serializes actual assistance work, captures window/owner and
abort lifetime, and rechecks sender and maintenance authority before queued effects.
It binds the [factory/controller](../../../windows-desktop/src/main/setup-assistance/factory.ts)
to the source-built complete sealed extension folder from
[the producer checkpoint](W01-G01-shared-extension-setup-source-2026-10-10.md).
Reveal/copy revalidate the complete asset set; no renderer path or arbitrary URL
is accepted. The signed app-resource helper receives only the fixed
`chrome_extensions_open` command and approved Main pin. Its
[Chrome receiver](../../../worker/native/windows-consumer/chrome_extensions.hpp)
verifies registered signed Google Chrome and launches only `chrome://extensions`.
It creates no owned browser Job, inherits no helper handles and requires breakaway
if a parent Job exists. A launch ACK does not prove visible UI or extension install.

The [actual Setup route](../../../windows-desktop/src/renderer/app.tsx) includes
the assistance panel with English/Arabic guidance. Missing assistance after a
terminal startup failure is unavailable instead of endlessly checking. An earlier
no-Host controller is disposed before a later Host upgrade. Model assistance uses
only the current captured Host's explicit trusted Prepare `errorComponent=model`;
Main immediately hides old model availability when that cause clears. Generic
integrity/stage failures never authorize model-folder reveal. No Store URL or
automatic extension installation is invented.

## Executed checks

- `npm test -- tests/created-export-discard.test.ts tests/save-destinations.test.ts tests/library-export.test.ts tests/desktop-ipc-transport.test.tsx tests/contracts.test.ts tests/shell-lifecycle.test.ts tests/pending-operations.test.ts tests/setup-assistance.test.ts tests/setup-assistance-view.test.tsx --maxWorkers=2`:
  **109 tests/nine files passed at 02:15:13**, duration 1.92 seconds.
- The broader shell/bridge/security/input/navigation/export/shutdown/recovery/
  localization/accessibility/initialization slice passed **182 tests/23 files at
  02:17:13**, duration 4.86 seconds. Includes two new terminal Setup EN/AR cases.
- Whole Desktop `npm run typecheck` passed after these bindings; whole
  `npm run lint` passed on **509 files**, zero warnings/errors. Owned formatting,
  `npm run build` and `npm run test:package-fixtures` passed; both renderer/preload
  boundaries remain intact. No Electron binary was launched.
- [Seven adapter fixtures](../../../windows-desktop/tests/created-export-discard.test.ts)
  use the actual SDK with injected native transport. They prove creator/pin wire
  binding, stable certificate-only ACK retry, held/rejected actual helper-exit
  barriers, serialized later admission, missing creator refusal and genuine pending.
  They perform no user-file deletion. Existing save/export fixtures exercise real
  test-owned filesystem descriptors and retained owner/pin behavior separately.
- The later preflight/export/bridge/initialization slice passed **108 tests/seven
  files at 02:22:32**, duration 9.30 seconds, followed by whole TypeScript. Two
  real test-owned filesystem cases prove failed preflight and delayed revoked
  consent leave no file; the actual SDK preflight waits helper exit before success.
- [The composed UI transport](../../../windows-desktop/tests/desktop-ipc-transport.test.tsx)
  builds actual restricted preload and runs production ingress/controller/React.
  Copy sends only the fixed command; path injection is refused, and no model action
  appears without trusted availability. Native/OS execution is injected.

Counts overlap and are not added together. The previous frozen whole Desktop run
is still 1,764/205 at 00:21:56; later changes require a new coherent full regression.
Native source and required CTest cases remain uncompiled and unrun for W34.

## Remaining source and native work

Independent native-owner review confirms the export parent/pin/certificate/helper
lifetime source contract. The added signed Main preflight is bound and portably
checked without an arbitrary-path utility or renderer filesystem API. W06–W12
final Prepare/GPU/local matrices, Share/diagnostic temporary
file cleanup, W33 compiler/test whole-descendant Job-zero guard, shared platform
error guidance and the final combined regression remain separate source work.
Actual Win10/11, file HANDLE/DPAPI/ACL/crash behavior, installed Chrome and signed
fresh-user package acceptance remain W34. No commit, push, deployment or release
action occurred.
