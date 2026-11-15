# MusicMute Local for Windows

The Windows desktop component uses a packaged React UI in an isolated Electron
renderer. Trusted account, file and process operations live in the main/session
agent; the renderer never receives a general filesystem or shell interface.

[Build inputs and licenses](docs/build-inputs-and-licenses.md) records the source,
dependency, asset and clean-build boundary plus unresolved release review items.

Product support is Windows 10 22H2 x64 (build 19045) and Windows 11 x64.
Windows ARM, x64-on-ARM emulation and x86 are rejected. Model inference requires
a qualified DirectML GPU; this component never substitutes CPU or cloud processing.

The current release route is two independent Microsoft Store MSIX main packages,
using free Store signing. The [18 migration tasks](../docs/windows-desktop/store/MSIX-MIGRATION.md)
are in progress; their source checkpoints do not establish an installable,
fully functional Store release. The owner authorized a private tester-only
release after approval; public publication remains prohibited. The owner will
submit the separate hidden-entry support request later. The earlier NSIS source
remains a separate strict legacy path.

The owner also authorized a separate, free locally signed development pair for
pre-review Z440 testing. Its [build and trust boundary](docs/local-development-msix.md)
uses distinct package identities and data directories; it does not relax the
production Store-signature requirement or publish either app.

## Code checks

Use Node 24.18 and this component's lockfile; there is no root package install.

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
npm run test:contracts
npm run test:package-fixtures
npm run build
npm run format:check
```

`npm ci --ignore-scripts` deliberately does not download or launch an Electron
binary. Code tests run without a UI. The source build generates separate main,
sandboxed preload and renderer bundles plus the shared companion entry, directly
from source; it never uses a sibling component's old `dist`.

The worker runtime uses its independently pinned Node/Python/FFmpeg dependencies.
Electron's embedded Node is not the processing runtime. Native Windows helper
build/install/GPU/UI acceptance is recorded separately in
[the implementation plan](../docs/windows-desktop/README.md).

`npm run build:native` and `npm run test:native` use the same
[guarded acceptance runner](acceptance/README.md), with a source build, connected
Windows x64, named target, approved tools-v2 metadata and existing output folder:

```text
npm run build:native -- <absolute-target.json> <absolute-tools.json> <absolute-output-folder> --acknowledge-windows-phase
npm run test:native -- <absolute-target.json> <absolute-tools.json> <absolute-output-folder> --acknowledge-windows-phase
```

The first selects `native-build`; the second also selects
`native-security-fixtures`. Both require the separately approved QA process guard;
they have no raw CMake/CTest or PATH fallback. Other hosts return a non-success
unsupported-host result before loading target/tool files. They do not run or
install a consumer app. The Windows
application identity is `com.musicmute.local.windows`; the native Chrome host
keeps the shared `com.musicmute.local` identity.

## Dependencies and support

Electron 44.7.0 is pinned from the official npm package. Its
[tagged platform support](https://github.com/electron/electron/blob/v44.7.0/README.md#platform-support)
includes Windows 10 and later. The product's build-19045/native-x64 gate is more
specific. React and source tooling are pinned consistently with existing clients.
Electron and electron-builder are MIT; React is MIT; retained font/Google assets
carry their existing repository notices. Recheck the Electron support window and
security patches before an actual release.

Ordinary app replacement preserves per-user runtime/model, Library, preferences,
outboxes and worker credentials. The approved worker is independent of the app
window/account session, and ends with Windows logout. No live installation or
release publication is implied by a successful source build.

## Private local diagnostics

`npm run build:debug` enables the local collector in an unpackaged Electron
development main process with the logging launcher's environment. Normal builds
compile the gate off; packaged Electron execution also rejects activation.
Validated renderer commands, their results, renderer crashes, native account
HTTP and parsed JSON use the trusted main process collector; no renderer
filesystem, key or general diagnostic IPC capability is added. An accepted
command is separate from its completed result. Run UI acceptance only on an
authorized Windows target; source/build checks on macOS do not prove Windows UI.
See the [local logging guide](../docs/local-logging/README.md) for source keys,
launch commands, privacy, queue bounds, retained capture and read-only MCP.
