# Windows per-user release tooling

This release-tooling source has portable checks recorded under W31. It is not an installable release and
does not authorize signing, native builds, installation or publication.

The fixed payload is native x64 on Windows 10 build 19045 or Windows 11. The
NSIS bootstrapper itself may be I386. The app, native helper, session launcher
and Chrome proxy must be AMD64. Installer scope is current user only, fixed at
`%LOCALAPPDATA%\Programs\MusicMute Local`, with `asInvoker`. Runtime, model,
Library, account/fleet credentials, preferences and outboxes stay in their
existing separate per-user roots and survive ordinary replacement/uninstall.

Approved external inputs must contain all entries declared by
`validate-assets.ts`, with exact bytes/hashes and the approved signer leaf DER
SHA-256 and approved publisher display name. No input folder is present by default. Public account configuration,
signed consumer runtime metadata/download descriptor, update trust, real signed
native binaries, icon and notices are required. An optional exact
`worker-catalog-update-channel.json` is accepted only as an explicit approved input
with the same strict update-trust schema/publisher and ASAR seal; absence keeps
catalog updates unavailable. Retained worker recovery copies that public input
only when it actually exists in the seal. The model remains pinned to the
existing approved upstream source. Missing inputs, foreign profiles, placeholders,
credentials, unexpected files, unsafe links or non-x64 payload binaries fail.

The build/signing order is important:

1. Build actual native x64 helpers on the authorized Windows machine. Audit and
   sign inner PEs with the approved publisher and timestamp. Keep signing keys
   outside this repository and artifacts.
2. Build current main/preload/renderer and role bundles. Verify the shared
   extension key/ID against its existing source. `stageSharedExtension` invokes
   the same shared extension-only builder into a fresh exclusive temporary
   folder, stages all nineteen runnable HTML/JS/static assets plus the audited
   source notice, and generates `extension/inventory.json`. It excludes maps,
   stale sibling `dist`, profiles/private inputs and Mac/worker/native execution.
   Every asset and the inventory enter the resource seal; a manifest-only
   payload cannot enable Load unpacked assistance. New bundled external browser
   dependencies require an explicit notice return rather than dropped licenses.
   Copy only allowlisted generated
   outputs and collect notices; exclude maps, development files and user state.
   The closed build-graph audit requires all nine executed app/Chrome/session/
   login/personal/fleet/Prepare entries, rejects private/test inputs in every
   graph, and collects role-only bundled dependency notices too. Signed external
   runtime role inputs remain subject to the separate consumer release inventory.
3. Validate approved resource inputs with actual Windows Authenticode/asInvoker
   verification. Derive helper/launcher/browser manifests from their final bytes.
4. Compute logical app payload identity from code/resources before inserting its
   own identity sidecar. Seal the resource index inside `app.asar`. Enable ASAR
   integrity, ASAR-only execution and disable RunAsNode/NODE_OPTIONS/inspect fuses.
5. Sign the actual app EXE containing the ASAR integrity binding. Only then derive
   `native/account-authority-manifest.json` from its final SHA/bytes and the same
   approved publisher. This self-pin is checked by native WinVerifyTrust against
   the publisher sealed in ASAR; it cannot live in its own hashed ASAR.
6. Compile/sign NSIS and its generated uninstaller. Audit actual generated scope,
   native architecture/build guards, lifecycle authorization, retained data and
   owned removal inventory. Compute final installer SHA/bytes afterwards. Logical
   payload identity and final installer digest are separate.
7. Sign release channel metadata only after actual candidate acceptance. Upload,
   public readback and downloaded installation require separate authorization.

Root must call `configurePackagedResourceTrust(process.resourcesPath,
app.getAppPath())` before hidden-mode decoding, native helper creation, account
restoration or instance forwarding. Every later packaged trust/resource loader
must use `readPackagedResource`; mutable runtime/capsule/DPAPI files use their
existing separate verification. Browser native messaging runs the normal signed
Electron app `--native-browser-stdio`, never `ELECTRON_RUN_AS_NODE`.

Portable fixtures validate schemas, inventory, hash binding and configuration.
Run source bundling with `npm run build` from `windows-desktop`. The authorized
Windows builder invokes `node packaging/build-release.mjs <absolute approval.json>
<absolute inputs folder> <absolute new staging folder>`. The stage must be new;
the script never installs or publishes the result. Approved input schema is
`{version:1,appVersion,appBuildNumber,publisherName,publisherSha256,entries:[{path,bytes,sha256}]}`.
The positive build number is explicitly approved; it generates sealed
`desktop-build.json` and is never inferred from a default or the semantic version.
Signing credentials are supplied only to the external Windows signing setup.

The pinned v26 signing hook delegates its actual configured signer, audits the
temporary uninstaller before v26 deletes it, and leaves pre-signed helper bytes
unchanged. The after-sign hook generates an exact file removal include from the
real app output, preserving unknown files and all separate data roots. Final
artifact evidence contains framework/app/native hashes and the signed uninstaller
receipt. The HKCU URI registration journals ownership before either view changes;
interrupted prefixes repair only when all existing values still match that receipt.

They do not verify WinVerifyTrust, signed EXE/fuse/ASAR execution, generated NSIS,
installation, SmartScreen, Chrome or fresh-user preparation. Those remain W34.

The exact reviewed 26.15.3 default script is transformed in memory, behind
version/function/source-shape checks, so scope/native path preflight precedes
`SetOutPath`. The temporary unsigned uninstaller-generation program writes its
build output and exits before any installed-directory initialization; the normal
v26 signed-uninstaller path remains intact. `ExecWait` checks launch errors as
well as exit codes. Native preflight authenticates the signed parent and retains
fixed directory handles inside that installer through mutation. This requires
actual Windows/NSIS acceptance; a portable template assertion is only source proof.

Noto Arabic font/OFL, the exact pinned Electron MIT license and a Google brand
attribution/usage notice are mandatory source-derived build assets. The release
builder verifies their actual bytes before staging; after signing it checks the
actual inside-ASAR assets against staging and records their hashes in
`payload-inventory.json.licensedAssets`. Noto remains OFL-1.1; the Google mark
notice points to its branding terms and makes no open-source-logo or OAuth
approval claim. Collected bundled dependency notices and separately approved
runtime notices are also retained. A temporary real-ASAR test checks inclusion
and altered/missing notice denial without signing, Electron execution or NSIS.

Approval-copy and signed inventory reads are bounded, reject links/file-birth
changes and unexpected growth, and cap graph depth/count. New PE approval uses
explicit whole-chain WinTrust policy while retaining the actual file handle
through signature, manifest and ASAR-resource checks. Caller paths remain data
in a fixed PowerShell script and inherited module/Node injection is excluded.
Already-approved installed peer checks use the distinct native cache-only policy;
that policy never authorizes a new package or installer.
