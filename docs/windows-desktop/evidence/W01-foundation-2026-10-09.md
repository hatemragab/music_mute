# W01 foundation evidence — 2026-10-09

- Host: macOS ARM64, Node 24.18.0, npm 11.16.0.
- Status: code-complete / Windows pending.
- Product files: new `windows-desktop/` component only; preserved unrelated dirty work.
- Inventory: `windows-desktop/docs/parity-inventory.md` traces the current Mac/companion behavior and maps it to the accepted task set.
- Build: independent packaged main/preload/renderer/shared-companion entrypoints directly from source; Electron 44.7.0 and toolchain pinned in lockfile.

## Commands actually run

| Command from windows-desktop   | Result                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm install --ignore-scripts` | Passed; no Electron binary launch/download script.                                                                                                           |
| `npm run verify`               | Passed: typecheck, lint, 22 unit/headless component tests, 2 bundle-boundary fixture tests, source build and formatting.                                     |
| `npm audit --omit=dev --json`  | Passed, zero production dependency findings.                                                                                                                 |
| `npm audit --json`             | 8 moderate development-tool findings via electron-builder's download/logging dependencies, ultimately sprintf-js. Packaging/release review remains required. |

Initial type/CSS fixture/headless text-matcher failures were corrected and the full
component verification rerun successfully. These are code-only checks; no UI was
launched and no installed Mac app/worker/browser state was changed.

The tagged official Electron README includes Windows 10+ platform support.
The product's pure support gate tests Windows 10 build 19045 and Windows 11,
rejecting older/malformed builds, x86 and native ARM even when the process is x64.
Native OS/architecture detection is still integrated through W03, not proven by
the simulated host fixtures.

## Deferred checks

Native Windows compile/link, actual packaged launch, standard-user clean install,
GPU readiness and all product UI acceptance remain unchecked. The source shell
is a foundation, not a completed feature suite. W02/W04 onward must connect real
services and finish feature behavior before W33 can close implementation.
