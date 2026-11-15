# Build inputs and licenses

Source review: 2026-10-10. Installed Windows, native compiler and redistribution
acceptance remain in W34. This inventory does not supply release credentials or
replace the signed external resource approval required by the release builder.

## Toolchain and compatibility

The component lockfile pins Electron 44.7.0, electron-builder 26.15.3, React and
React DOM 19.2.8, yauzl 3.4.0, esbuild 0.28.2, TypeScript 6.0.2, Vitest 4.1.11,
JSDOM 30.0.1, oxlint 1.58.0 and Prettier 3.9.6. Development uses Node 24.18.x.
Installed package metadata reports MIT for these packages except TypeScript
(Apache-2.0). The type packages and Testing Library also report MIT.

The [pinned Electron platform documentation](https://github.com/electron/electron/blob/v44.7.0/README.md#platform-support)
lists Windows 10 and later. The [Node 24.18 build platform table](https://github.com/nodejs/node/blob/v24.18.0/BUILDING.md#platform-list)
is a separate compatibility input for the independent processing runtime.
MusicMute's own gates still require Windows Workstation build 19045 or later,
native AMD64 and a qualified DirectML GPU. Framework ARM support does not change
the product's x64-only scope. Actual pinned PEs and DLLs must pass W34 on Windows
10 22H2 and the recorded Windows 11 target; source support tables cannot prove it.

Electron's embedded Node and the independently approved runtime Node are separate.
The native helper uses the explicit x64 MSVC/Windows SDK recipe. Consumer package
approval must retain the actual Node/Python/FFmpeg/ONNX/DirectML/acquisition/model
identities and notices specified by W06/W31, rather than infer them from this
desktop package manifest. Model redistribution terms require the actual approved
upstream inputs and notices; no license is invented here.

## Source and artifact boundary

The source build creates twelve entries directly from the current Windows,
shared companion and worker source. Nine are release execution graphs:
main, preload, renderer, browser host, session agent, login worker, personal,
fleet and Prepare. Packaging validation, acceptance runner and the shared
companion entry are separate build/check outputs.

The release builder's closed graph inventory audits all nine execution graphs
for required entry bindings, private/test inputs and build-only dependencies,
and collects notices from their actual dependency inputs. It rejects the eight
reviewed builder-chain packages in bundled inputs and import edges, including
external imports, nested package paths and Windows path/case variants. This
gate executes before the release builder stages application code/notices. It
excludes source maps and development state
from the staged application. Native PEs, public account configuration, signed
runtime/model/update resources, app icon and runtime notices come only from the
explicit approved input inventory. See [release tooling](../packaging/README.md).

Required source-derived assets are Noto Sans Arabic (844,676 bytes), its OFL-1.1
notice (4,381 bytes), the pinned Electron MIT notice (1,096 bytes), and Google
brand attribution/terms (467 bytes). The release validator compares bytes and
checks their actual inside-ASAR copies. The Google notice is not an open-source
logo license or OAuth approval. Dependency notices are collected from the actual
build graph; Electron/runtime third-party notices remain required release inputs.

## Dependency findings

Fresh `npm audit --omit=dev --json` on 2026-10-09 returned zero runtime dependency
findings. Full `npm audit --json` returned eight moderate development-chain
findings rooted in sprintf-js 1.1.3 through roarr, global-agent, @electron/get and
electron-builder. This is not a clean full dependency audit.

The [upstream disclosure](https://github.com/alexei/sprintf.js/issues/237) and
[reviewed advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) describe
unbounded precision in attacker-controlled format strings. The registry's latest
sprintf-js remains 1.1.3 and the advisory lists no patched version at this review.
The installed global-agent call sites use fixed log-format strings with dynamic
values in context fields; the twelve inspected application build graphs contain
none of sprintf-js, roarr, global-agent, electron-builder or app-builder-lib.
These facts bound the observed application exposure, without fixing the upstream
package or proving the Windows builder invulnerable.

Keep the reviewed builder pin and use approved build inputs in the isolated
release environment. Do not apply npm's proposed downgrade to 26.5.0: W31's
audited scope/signing hooks are explicitly bound to 26.15.3. Review any upstream
fix or builder replacement with those hooks and native packaging tests before
release. The unresolved development advisory remains a disclosed release-review
item; it is not silently suppressed by an audit exception or a fabricated version.

## Clean source proof

An allowlisted temporary source snapshot contained 709 public source/fixture
files and no installed app state, private configuration, sibling node_modules or
sibling dist. `npm ci --ignore-scripts --no-audit --no-fund` installed 393 packages
from the unchanged lockfile and did not download an Electron binary. Source build,
TypeScript and both renderer/preload boundary checks passed there. The first
snapshot typecheck lacked two explicitly imported worker benchmark fixtures; they
were added to the source inventory and the subsequent typecheck passed.

Recorded lock SHA-256:
`9fbf9f922b853d5898768118008b55d368b388004d63f08d7bfedb00d5fcf3d1`.
The final snapshot inventory digest was
`36ec8d15100ad23534904cd53868fb23a77d183e2990badad61a0049cb0a08dc`.
This proves the recorded source/build boundary, not later feature edits or native
installation. W33 supplies final combined code validation after source freezes.

## Audit refresh — 2026-10-10

The current runtime-only audit again returned **zero findings/exit 0**; the full
audit again returned **eight moderate development findings/exit 1**. `npm view
sprintf-js version dist-tags --json` still reports latest 1.1.3, and the
[reviewed advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) still lists
no patched version. Operator-controlled release-builder isolation remains required;
this is an unresolved development release-review item, not a passing full audit.

The new source build's twelve actual metafiles again contain none of sprintf-js,
roarr, global-agent, electron-builder or app-builder-lib. Whole TypeScript, owned
lint/format, source build and both bundle-boundary checks passed at the recorded
Root checkpoint. Later runtime/native/feature changes are not implicitly covered.

## Development dependency review decision — 2026-10-10

The source assessment and runtime containment change are complete. Retain the
reviewed lockfile and electron-builder 26.15.3; a clean full audit or release
security exception is **not** granted by this decision. The
[scoped evidence](../../docs/windows-desktop/evidence/W01-development-dependency-review-2026-10-10.md)
records current commands, actual call sites, the production receiving gate and
every-role rejection fixtures.

The official [reviewed advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
still affects sprintf-js through 1.1.3 and lists no patched release. It describes
an availability failure when a caller supplies an excessive numeric precision
in a format string. The [upstream issue](https://github.com/alexei/sprintf.js/issues/237)
remains open; disagreement in that discussion is not an advisory withdrawal or
a published fix. Current registry metadata, read with `npm view`, reports:

| Primary registry input                                                        | Observed value                           | Compatibility consequence                                                                                   |
| ----------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [sprintf-js](https://registry.npmjs.org/sprintf-js)                           | `latest` 1.1.3                           | No published fixed version to pin.                                                                          |
| [electron-builder](https://registry.npmjs.org/electron-builder)               | `latest` 26.15.3; `v26` 26.17.0          | A newer tag is not proof that this chain is removed.                                                        |
| [app-builder-lib 26.17.0](https://registry.npmjs.org/app-builder-lib/26.17.0) | Depends on `@electron/get ^3.0.0`        | Moving to that version alone retains the affected dependency path.                                          |
| [@electron/get 5.1.0](https://registry.npmjs.org/@electron%2fget/5.1.0)       | No global-agent dependency; Node >=22.12 | Used by the separate Electron package, not an approved drop-in replacement for the builder's v3 dependency. |

Actual installed dependencies resolve builder 26.15.3 → app-builder-lib 26.15.3
→ @electron/get 3.1.0 → global-agent 3.0.0 → roarr 2.15.4 → sprintf-js 1.1.3.
Fourteen logging calls across the installed global-agent JavaScript source use
fixed format literals; request/proxy/error values are structured context fields.
That bounds the observed format-string route, without proving all future builder
inputs safe. No untrusted-format demonstration or Windows builder was executed.

The existing `executedBuildGraphs` gate now rejects `sprintf-js`, `roarr`,
`global-agent`, `@electron/get`, `app-builder-lib`, `dmg-builder`, `electron-builder`
and `electron-builder-squirrel-windows` from all nine runtime graphs, on both
input and output import edges. This is enforced source behavior; the clean
runtime audit and current twelve-graph absence are separate observations.
Required graph identity/private-input checks and dependency notices remain.

`npm audit` proposes a builder downgrade to 26.5.0. That conflicts with the
exact version/function hashes in `builder-compat.cjs` and the reviewed NSIS/signing
hooks. No downgrade, override, alpha upgrade, dependency patch or lockfile change
is made. A future dependency replacement must revalidate these hooks and actual
Windows packaging before it can become approved.

The release security exception stays unchecked. It must explicitly address the
remaining eight moderate development findings, record the release's fresh audit
and upstream status, and approve or reject the builder's residual availability
risk. The release operator must provide an isolated builder with reviewed inputs
and controlled configuration. The scripts do not create an OS sandbox or sanitize
the whole inherited environment; `build-release.mjs` invokes the fixed builder
with inherited environment plus its fixed stage value. Do not describe that
operator requirement as code-enforced or already tested. No audit suppression,
exception approval, signed package or Windows acceptance is implied here.
