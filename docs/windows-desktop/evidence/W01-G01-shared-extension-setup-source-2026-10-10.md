# G01 — Shared extension payload and Setup assistance

2026-10-10, macOS arm64, source/headless only. No Electron/browser, Mac/Swift app,
Windows helper/compiler, model, profile, account, signed package or installation
was executed. Filesystem fixtures use disposable test-owned roots.

## Actual production source

[Shared builder](../../../chrome-extension/scripts/build-extension.mjs) extracts
the existing five browser entries and nineteen HTML/JS/static files. The
[full Mac build](../../../chrome-extension/scripts/build.mjs) retains its prior
companion/Swift/worker sequence and maps; it calls the same helper. Windows
[stage producer](../../../windows-desktop/packaging/shared-extension.mjs) builds
in fresh exclusive temporary output with maps disabled; no stale dist, profile,
private configuration/model or native build input. An onLoad fence rejects private
or non-browser source before loading, and bounded source reads recheck identity.

[Release builder](../../../windows-desktop/packaging/build-release.mjs) now stages
all nineteen assets plus explicit source notice and `extension/inventory.json`,
with unchanged manifest key/ID. Bounds/icon dimensions and actual graph are checked;
new bundled dependencies require real notices. No project license is invented.
All assets/marker enter the existing payload/resource seal. The
[resource parser](../../../windows-desktop/src/main/browser/package-trust.ts)
requires that marker without relaxing its resource-path grammar.

[Setup contract](../../../windows-desktop/src/shared/setup-assistance-contracts.ts),
[factory/controller](../../../windows-desktop/src/main/setup-assistance/factory.ts),
[folder verifier](../../../windows-desktop/src/main/setup-assistance/extension.ts)
and [panel](../../../windows-desktop/src/renderer/setup-assistance-view.tsx)
implement fixed Chrome management/reveal/copy/model commands. Every extension
effect revalidates the exact sealed asset set; altered/missing/extra/link content
is refused. Public snapshots contain no path, instructions stay collapsed, and
no Store URL/automatic install is invented. Actual trusted model component cause
plus native fixed-folder validation is required for model reveal; generic code/
stage, absent Host/null/unknown cause cannot grant it. Owner/cause changes and
disposal retain the actual future, with fixed public errors.

The [actual receiving checkpoint](W04-W26-setup-export-receiving-2026-10-10.md)
now binds Main/preload/App/locales and fixed signed Chrome management. Main
upgrades absent-Host assistance to the actual Host and reads the same captured
Prepare controller's current trusted model cause; generic failures cannot expose
the model folder. Source/portable proof is separate from unrun Windows behavior.

## Executed portable checks

- [Chrome shared build](../../../chrome-extension/tests/extension-build.test.ts)
  plus default/Store regressions: **20 tests/3 files passed 02:06:32**. Two genuine
  source outputs match all files/key, reject poisoned existing output and retain
  default maps; no dist/companion/worker/native input. Whole Chrome TypeScript,
  scoped lint and formatting passed; full native Mac build was not run.
- [Windows stage](../../../windows-desktop/tests/shared-extension-package.test.ts),
  [Setup core](../../../windows-desktop/tests/setup-assistance.test.ts),
  [panel](../../../windows-desktop/tests/setup-assistance-view.test.tsx), existing
  package/trust/localization/static-accessibility cases: **62 tests/8 files passed
  02:11:32**. Actual temp bytes/hashes/notices and tamper/missing/extra/link/escape
  refusal; no public paths, model guessing, stale owner effect, early disposal or
  private uppercase error leak.
- Whole Desktop TypeScript, source build and both bundle boundaries passed.
  At the subsequent moving snapshot whole lint/format failed only concurrent Root
  created-export adapter/Main (one allSettled spread/formatting); these were not
  edited here. A later whole pass requires its actual checkpoint.
- Initial producer run rejected an esbuild plugin Unicode filter flag; it was
  fixed before the genuine source/staging fixtures passed.

[Current official Zalando guidance](https://opensource.zalando.com/restful-api-guidelines/)
was reopened 2026-10-10. Compatible extension/tolerant clients (106/108), sanitized
errors (177), sensitive event exclusion (200) apply; REST URL/status/OpenAPI rules
do not govern these compatible closed private process commands. No endpoint added.

## Still separate

- [x] Main→preload→panel/fixed Chrome-management receiving source and portable
      checkpoint; see the linked receiving evidence, not a Windows execution claim.
- [ ] Signed Windows package, actual Chrome/HKCU/clipboard/Explorer/model-folder/
      permission/reparse/owner behavior and supported standard-user installation.
- [ ] Approved Store/publication/signer/license/resources and unresolved moderate
      development builder-chain release review.
