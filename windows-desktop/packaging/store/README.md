# Windows Store package source

This implements upload-candidate staging and receiving audits for the independent
MusicMute and MusicMute Worker main packages. It does not sign, install, upload,
submit or publish either product. A successful candidate audit is not Store
capability approval, namespace proof, GPU qualification or an installable Setup.

Both packages use the actual identities in `src/shared/store-contracts.ts`, x64,
Windows 10 22H2 build 19045 as the minimum, initial protocol ABI 1 and explicit
positive application build numbers. Submission versions are `0.1.0.0` and
`0.1.3.0`; an installed Microsoft revision may have a nonzero fourth node.

The GUI package also contains a hidden `MusicMuteChromeHost` Application entry
for its native messaging console alias. Its Application explicitly declares
`desktop4:Subsystem="console"` and `desktop4:SupportsMultipleInstances="true"`,
as required by the SDK. The primary Electron GUI entry owns the protocol; the
host entry owns only the Chrome alias. This adds no separate Store package.

## Inputs and builder order

Build the current desktop and Worker sources before assembly. Use the existing
shared extension builder rather than a sibling's previous `dist`. Supply a
complete final GUI Electron directory and a freshly assembled `windows-user`
Worker runtime. `auditStorePayload` reports missing relative files and refuses a
thin app, a source-only runtime, old agent/engine/modules, mismatched lock/tool
versions, missing acquisition code, unsafe DLL imports, development state,
links, private material, media or externally downloaded executable authority.

Worker controls and session executables must be present before regenerating its
complete `release-manifest.json`. Omit package-manager development state from
the new owned staging tree before generating that manifest. Preserve source
and user files. The current consumer assembler performs native version/import
probes before and after relocation; retained receipts alone do not establish a
fresh installed GPU result.

`storeElectronDirectoryConfig(stageWindowsPath)` supplies the pinned
electron-builder 26.15.3/Electron 44.7.0 GUI **directory** configuration. It expects
`application/` (compiled app plus resource-index v2), `resources/`,
`root/MusicMuteChromeHost.exe`, `root/MusicMuteSession.exe` and
`assets/app-icon.ico`. It preserves embedded ASAR integrity and restrictive
fuses. This separate upload directory configuration does not weaken the legacy
signed NSIS builder. `buildStoreIcon` derives the ICO from the genuine pinned
shared extension artwork; no sample icon is accepted.

The exact bounded input JSON is:

```json
{
  "version": 1,
  "purpose": "unsigned-store-upload-candidate",
  "guiPayloadRoot": "C:\\MusicMuteStoreBuild\\gui-final",
  "workerPayloadRoot": "C:\\MusicMuteStoreBuild\\worker-final",
  "guiBuildNumber": 1,
  "workerBuildNumber": 1,
  "namespaceProfile": "packaged-classic-v1"
}
```

The illustrated paths are arguments, not existing or qualified release inputs.
Use canonical absolute paths and a new stage outside source/input roots:

```text
node scripts/build-store.mjs <absolute-inputs.json> <absolute-new-stage>
```

This calls `prepareStorePackages(inputs, componentRoot, newStageRoot)`. It audits
both complete inputs before creating any candidate, copies pinned payload bytes
under `app/` and `worker/`, generates the real tile artwork and two explicit
manifests, then writes the protected code inventory after final ASAR/fuse edits.
The Native-compatible inventory is ASCII, binary sorted, case unique, bounded
to 8 MiB/65,536 entries and excludes its own circular hash. Manifest/assets/index
also appear in the separate pack-time pin list.

The generated `gui-pack-project/` and `worker-pack-project/` CMake projects must
run through the separately approved QA CMake Job. They invoke only the pinned
Microsoft SDK 26100 MakeAppx executable, verify the entire file set and hashes
before and after packing, keep validation enabled, and refuse overwrites. There
is no raw MakeAppx/PATH fallback, signer, shell, Store API or automatic install.

After the guarded SDK pack succeeds, read back the actual archives:

```text
node scripts/build-store.mjs --verify <absolute-inputs.json> <absolute-stage>
```

This calls `verifyPreparedStorePackages(inputs, componentRoot, stage)`. It
reaudits source/payload/index/manifest/artwork and streams each actual ZIP entry
through a held file handle without extraction. Every owned byte must match its
hash/size and ZIP CRC; local/central headers must agree. Extra, missing, aliased,
encrypted, signed and nonregular entries fail. The two bounded generated XML
entries receive size/CRC read-back; MakeAppx retains its own schema/block-map
validation. Only then is a new `archive-receipt.json` written. All receipts keep
`signed`, `installable`, `releaseReady` and `published` false.

## Namespace and installation gates

The default manifest is `packagedClassicApp`/`mediumIL` with requested
`runFullTrust`. The explicit `unvirtualized-candidate-v1` variant renders a
`win32App` candidate and requests `unvirtualizedResources`; it is not an approved
route. Candidate receipts keep namespace proof and capability approval pending.
No caller flag can turn those receipts into production OS authority.

Installed production execution requires actual current healthy Store registration
and OS `PackageSignatureKind.Store` (3), plus the sealed inventory and Native
authority integration. Unsigned SDK output cannot satisfy that boundary. User
data/model retention after both package removals still needs the actual proven
nonvirtualized data route. The migration ledger retains these physical and
Store certification gates separately.

## Source validation

`tests/store-packaging.test.ts` exercises real generated manifests/PNG assets,
strict full-runtime inventories, fresh shared extension and compiled-module
receiving checks, missing-runtime denial and actual ZIP bytes (stored/deflate,
descriptors and malformed/foreign content). These code tests do not run the
consumer app, Windows SDK, GPU or Store installation.
