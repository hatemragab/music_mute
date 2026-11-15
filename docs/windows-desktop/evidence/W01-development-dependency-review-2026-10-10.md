# W01 — Development dependency assessment and runtime containment

Date: 2026-10-10, Africa/Cairo. Source/portable proof only. No Windows builder,
NSIS, native compiler, signer, installer, device, production account or release
publication was run. This record does not approve a security exception.

## Decision and boundary

Complete W01's source dependency assessment and preserve the reviewed lockfile.
Fix the concrete containment gap in the existing release graph gate: build-only
dependencies were absent from current bundles, but that absence was not enforced
for future inputs/imports. The gate now rejects the entire reviewed eight-package
builder chain from every runtime graph. The release security exception and
operator-controlled isolated builder remain unchecked. No upstream vulnerability
fix or clean full audit is claimed.

No manifest, lockfile, installed dependency, version pin, NSIS/signing hook or
environment configuration was changed. The lockfile SHA-256 remains
`9fbf9f922b853d5898768118008b55d368b388004d63f08d7bfedb00d5fcf3d1`.

## Actual dependency and primary-source review

The current installed dependency path is:

`electron-builder 26.15.3 → app-builder-lib 26.15.3 → @electron/get 3.1.0 → global-agent 3.0.0 → roarr 2.15.4 → sprintf-js 1.1.3`.

The actual runtime-only audit returns zero findings. The full audit returns eight
moderate package findings for that development chain, including dmg-builder and
electron-builder-squirrel-windows. They derive from the single sprintf-js
advisory; eight package findings are not eight independent root vulnerabilities.

The primary [GitHub reviewed advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
is CVE-2026-97058, affects versions through 1.1.3 and lists no patched version.
It describes availability loss from excessive precision in caller-controlled
format strings. The [upstream disclosure](https://github.com/alexei/sprintf.js/issues/237)
remains open. Maintainer disagreement does not establish withdrawal or a
published patched release. These pages were reread during this review.

Official registry metadata was read using `npm view`, rather than inferred from
an announcement or third-party article:

| Registry source                                                               | Actual result                                           | Decision                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [sprintf-js metadata](https://registry.npmjs.org/sprintf-js)                  | `latest` 1.1.3                                          | No published fixed pin.                                                                                             |
| [electron-builder metadata](https://registry.npmjs.org/electron-builder)      | `latest` 26.15.3; `v26` 26.17.0; `next` 27.0.0-alpha.10 | A newer tag/alpha is not an approved replacement.                                                                   |
| [app-builder-lib 26.17.0](https://registry.npmjs.org/app-builder-lib/26.17.0) | `@electron/get ^3.0.0`                                  | Does not remove the affected dependency path merely by moving to the newer v26 tag.                                 |
| [@electron/get 5.1.0](https://registry.npmjs.org/@electron%2fget/5.1.0)       | No global-agent dependency; requires Node >=22.12       | The separately installed Electron downloader uses this version; it is not evidence of builder v3 API compatibility. |

`npm audit` proposes electron-builder 26.5.0. The
[exact version/function hashes](../../../windows-desktop/packaging/builder-compat.cjs)
and [reviewed NSIS hook](../../../windows-desktop/packaging/nsis-startup.cjs)
bind 26.15.3. A downgrade or forced major transitive override would invalidate
that review. Replacing the builder/downloader requires a separate compatibility
and actual Windows packaging review; no blind dependency change is warranted.

Read-only TypeScript AST inspection of the seventeen installed global-agent
JavaScript files found fourteen logger calls. Every format/message argument is
a fixed string literal; request, error and proxy values use structured context.
The installed roarr formatter distinguishes these context/message arguments.
This is an observed call-site constraint, not a guarantee about every future
builder input or a proof that the vulnerable formatter is patched. No exploit
payload or uncontrolled third-party template was executed.

## Receiving source and meaningful proof

| Requirement                                | Production entry / source authority                                                                                                                                                                                                                                          | Portable proof                                                                                                                                                                                                                    | Remaining proof                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| All runtime entries are assessed           | [build-release.mjs](../../../windows-desktop/packaging/build-release.mjs) calls [executedBuildGraphs](../../../windows-desktop/packaging/inventory.cjs) before staging code/notices. Requires Main, preload, renderer, browser, session, login, personal, fleet and Prepare. | Existing fixture removes/duplicates/unbinds each entry; actual fresh twelve-metafile build selects all nine execution graphs.                                                                                                     | Actual approved Windows package invocation.                               |
| Builder dependencies cannot enter runtime  | The same gate rejects sprintf-js, roarr, global-agent, @electron/get, app-builder-lib, dmg-builder, electron-builder and electron-builder-squirrel-windows in input names and input/output import edges, including external imports.                                         | [package-recipe.test.ts](../../../windows-desktop/tests/package-recipe.test.ts): 360 injected input cases and 432 external-edge cases across all nine roles, nested npm/pnpm paths, Windows separators/case, bare names/subpaths. | Rerun against the actual final approved release graph.                    |
| Legitimate runtime code remains compatible | Package matching uses exact package boundaries; required entry/private-input checks and notice collection remain.                                                                                                                                                            | React, similarly prefixed package names, scoped-name boundaries, Electron and Node externals remain accepted. Existing role-only notice fixture still passes.                                                                     | Final inside-ASAR/runtime notice inventory.                               |
| Packaging pins remain intact               | `builder-compat.cjs`, `nsis-startup.cjs`, fixed target/config and signing hooks remain unchanged.                                                                                                                                                                            | Actual installed schema/function-hook tests in the package recipe suite pass. Lock digest is unchanged.                                                                                                                           | Real NSIS, signed generated uninstaller and native scope/PE verification. |
| Builder risk is disclosed separately       | [build-inputs and licenses](../../../windows-desktop/docs/build-inputs-and-licenses.md) and W01 separate source review from security exception.                                                                                                                              | Actual npm/registry/advisory results recorded below.                                                                                                                                                                              | Explicit release decision and operator isolation.                         |

The fixed scripts/approved input validator bound release resources, source entry
identity and staging; they do not create an OS sandbox. The builder subprocess
still inherits the environment plus its fixed stage value. Do not call the
operator's isolated release environment implemented or verified by this gate.

## Commands actually run

All component commands ran from `windows-desktop/` using the existing install.
The audit/registry commands were read-only, without install scripts or lock writes.

| Command / inspection                                                                                                                          | Actual result                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm audit --omit=dev --json`                                                                                                                 | Exit 0; zero findings, reread during this source return.                                                                                                                                                                                                                                                              |
| `npm audit --json`                                                                                                                            | Exit 1 as expected; eight moderate development findings, zero high/critical. No suppression.                                                                                                                                                                                                                          |
| `npm ls sprintf-js roarr global-agent @electron/get electron-builder app-builder-lib --all --json`                                            | Exit 0; actual version path above.                                                                                                                                                                                                                                                                                    |
| `npm view sprintf-js version dist-tags --json` and `npm view electron-builder version dist-tags --json`                                       | Exit 0; current tags above.                                                                                                                                                                                                                                                                                           |
| `npm view app-builder-lib@26.17.0 version engines dependencies --json` and `npm view @electron/get@5.1.0 version engines dependencies --json` | Exit 0; direct dependencies/engine requirements above.                                                                                                                                                                                                                                                                |
| Read-only AST logger inspection                                                                                                               | Exit 0; seventeen JS files, fourteen fixed-format call sites.                                                                                                                                                                                                                                                         |
| `npx vitest run tests/package-recipe.test.ts`                                                                                                 | 13/13 pass at 02:55:27, including every-role builder-chain rejection and pinned packaging/notice checks.                                                                                                                                                                                                              |
| `npm run typecheck`                                                                                                                           | Earlier whole-component run at 02:54 returned exit 0. Final rerun returned exit 2 only at the concurrently edited `tests/session-state-store.test.ts:151`: fixture `osMajor` inferred `number`, required literal `10`. This peer-owned fixture was reported and preserved; no latest whole-typecheck pass is claimed. |
| `npm run lint`                                                                                                                                | Exit 0; 518 files, zero warnings/errors.                                                                                                                                                                                                                                                                              |
| Scoped oxlint on `packaging/inventory.cjs` and recipe test                                                                                    | Exit 0; the packaging source is outside the standard lint script's directory list and was explicitly checked.                                                                                                                                                                                                         |
| `npm run build`                                                                                                                               | Exit 0; source bundling only, no Windows/Electron execution.                                                                                                                                                                                                                                                          |
| `npm run test:package-fixtures`                                                                                                               | 2/2 renderer/preload boundary tests pass.                                                                                                                                                                                                                                                                             |
| Real gate on fresh `dist/build-metafiles.json`                                                                                                | Exit 0; twelve graphs, nine approved runtime graphs; graph SHA-256 `a37ddd280ff4e08b43c4f73b8f1fc02aa854c8e0365f392b74235abc4190fa8f`.                                                                                                                                                                                |
| Scoped Prettier on both source/test and all three documents                                                                                   | Exit 0; five files match formatting.                                                                                                                                                                                                                                                                                  |
| Local document-reference validation                                                                                                           | Exit 0; 25 local references across all three documents exist.                                                                                                                                                                                                                                                         |

## Unchecked release/security acceptance

- [x] Review production and development findings separately, trace installed
      exposure, research primary upstream/registry status and implement runtime
      graph rejection without changing reviewed packaging pins.
- [ ] Recheck official advisory/registry/full audit at release time; resolve the
      development finding or obtain an explicit documented release/security
      decision accepting or rejecting the residual builder availability risk.
- [ ] Establish and verify the operator-controlled isolated Windows builder,
      approved inputs, inherited configuration and actual final graph/license
      evidence. No source test supplies this environment.
- [ ] Perform actual Windows native/NSIS/signature/install/SmartScreen/ABI/GPU
      and distribution acceptance under W31/W34 with separately approved inputs.
