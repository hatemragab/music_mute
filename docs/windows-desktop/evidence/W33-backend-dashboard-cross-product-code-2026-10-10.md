# W33 — Affected backend, dashboard and landing code checkpoint

Date: 2026-10-10, Africa/Cairo. Source, mocked API, jsdom and owned loopback
fixtures only. No browser/Electron/device/native Windows execution, production
integration, real account/worker operation, signing, release or deployment.
Existing repository/user/private dotenv files were neither read nor written.
No production source, dependency, lockfile or unrelated dirty work was changed.

## Scope and safeguards

Read root/component instructions, manifests, verification scripts and current
configuration before execution. Source scope is the Windows W05/W32 return:
account/device platform, fixed desktop Google exchange, optional consumer profile,
signed consumer/service artifact distinction, independent desktop numeric policy,
existing realtime app-policy projection, dashboard policy/worker presentation and
the EN/AR Windows pending Downloads card. Existing mobile/Mac behavior remains
covered by the same component unit suites.

Vitest configs leave Vite's dotenv directory at its default. The installed
[Vitest Node API](https://vitest.dev/guide/advanced/) was used with the existing
component configs and only the in-memory [Vite `envDir:false` override](https://vite.dev/config/shared-options.html#envdir).
No replacement config file was created. Backend/landing installed Vitest 4 uses
`startVitest('test', filters, options, {envDir:false})`; dashboard Vitest 5 uses
`startVitest(filters, options, {envDir:false})`. Every instance was closed after
execution. Test processes use `APP_ENV=test NODE_ENV=test`.

Dashboard's existing production Vite configuration already disables dotenv files
and its environment loader ignores them outside local mode. The production build
also unsets `SENTRY_AUTH_TOKEN` and `SENTRY_RELEASE`, preventing source-map upload.
Landing's actual existing production config was built with `vite.build({envDir:false})`.
Source builds are not publication or installed-app checks.

The three dashboard environment-profile tests were initially excluded under the
strict no-env interpretation. After the task's explicit clarification, their
source was verified to create/read only their own `mkdtemp` directory's synthetic
dotenv files. The final serialized full run includes all three. No private repo
dotenv file or secret value was inspected.

The required tracked-secret gate was subsequently reviewed and run directly.
The [scanner](../../../backend/scripts/check-tracked-secrets.mjs) reads only
`git ls-files` entries, reads symlink text rather than following links, skips
deleted tracked files and binary contents, and reports only paths/rule names.
A metadata-only inventory found 2,316 tracked paths and nine dotenv entries,
all explicit `.env*.example` templates. The other credential-named paths are
public source/tests or the checked-in synthetic Android auth fixture. No tracked
private dotenv, private key/certificate or real service-account file was found.
The scanner may read those source-controlled dummy templates; it does not scan
ignored private files, untracked new source or generated outputs. Its passing
result therefore does not claim a secret audit of every untracked Windows file.

## Exact executed checks and results

The Node calls below were executed with `node --input-type=module` from their
component, imported from `vitest/node`, awaited and followed by `await ctx.close()`.
Counts from focused subsets overlap whole-suite counts; do not add them together.

| Component / exact command or Node API call                                                                                                                                                            | Actual result                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend `startVitest('test', [], {run:true}, {envDir:false})`                                                                                                                                         | **1,719 passed / 161 files**, 03:17:33, 16.49s; exit 0, no skips/failures.                                                                                     |
| Backend `startVitest('test', windowsFilters, {run:true}, {envDir:false})` — exact filters below                                                                                                       | **286 passed / 19 files**, 03:19:58, 1.16s; exit 0. Expected missing approved-catalog warnings remain safe unavailable fixtures, not real R2 requests.         |
| Backend `startVitest('test', ['test/admin-desktop-policy.e2e-spec.ts','test/admin-publication.e2e-spec.ts'], {run:true,config:'./vitest.config.e2e.ts'}, {envDir:false})`                             | **2 passed / 2 files**, 03:19:05, 2.25s; actual Nest guards/wire with synthetic identities/domain services; no database or live authorization.                 |
| Backend `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run build`                                                                                                              | All exit 0. Formatting/lint are checks, not whole-tree rewrites.                                                                                               |
| Backend second `pnpm run build`, `node --check dist/main.js`, `stat('dist/main.js')`                                                                                                                  | Exit 0; repeated build still emits a regular 1,594-byte API entry point. Syntax check does not claim server startup.                                           |
| Backend actual Node imports of `dist/releases/desktop-policy.types.js` and `dist/app-policy/access-policy.js`; parse a synthetic Windows patch and validate independent Windows policy                | Exit 0; compiled ESM module resolution succeeds, synthetic Windows minimum 42 accepted, existing Android/iOS defaults retained. No AppModule/database startup. |
| Backend `node --test scripts/benchmark-audio-transfers.test.mjs`                                                                                                                                      | **8 passed**, no skips; memory-injected client/sign/fetch ports only, no actual transfer/remote object.                                                        |
| Backend `pnpm run test:secrets` — five isolated scanner fixtures followed by the tracked repository scan                                                                                              | **5 passed**, no skips; tracked secret scan passed, exit 0. Only paths/rules can be emitted; no private dotenv or secret value was exposed.                    |
| Backend `pnpm audit --prod --json`                                                                                                                                                                    | Exit 0; zero runtime findings across 519 production dependencies. This does not replace W01's separate unresolved Windows development-builder review.          |
| Dashboard initial `startVitest([], {run:true,exclude:['**/node_modules/**','**/.git/**','vite-environment.test.ts']}, {envDir:false})`                                                                | **213 passed / 2 timed out / 39 files**, 03:17:32, 21.35s. Preserve this failed checkpoint; details below.                                                     |
| Dashboard isolated `startVitest(['src/features/settings/processing-settings-page.test.tsx'], {run:true}, {envDir:false})`                                                                             | **10 passed / 1 file**, 03:19:05, 9.66s; unchanged five-second per-test budget and unchanged source.                                                           |
| Dashboard final `startVitest([], {run:true,maxWorkers:1,fileParallelism:false}, {envDir:false})`                                                                                                      | **218 passed / 40 files**, 03:19:58, 35.35s; all configured tests, including the three isolated synthetic dotenv cases, no skips/failures.                     |
| Dashboard `npm run format:check`, `npm run lint`, `npm run typecheck`, `env -u SENTRY_AUTH_TOKEN -u SENTRY_RELEASE npm run build`                                                                     | All exit 0. Actual Vite production bundle produced; existing nonfatal >500kB chunk warning remains, without source/upload/deployment change.                   |
| Landing `startVitest('test', [], {run:true}, {envDir:false})`                                                                                                                                         | **15 passed / 3 files**, 03:17:32, 860ms; pending Windows card, centralized destinations and EN/AR contract/server-render checks.                              |
| Landing `npm run format:check`, `npm run lint`, `npm run typecheck`; `APP_ENV=production NODE_ENV=production node --input-type=module` with `import {build} from 'vite'; await build({envDir:false})` | All exit 0; actual English/Arabic production outputs, no dotenv read or publication.                                                                           |
| Landing `node --test server.test.mjs`                                                                                                                                                                 | **11 passed**, no skips; owned temporary site and loopback server/security/audio-range fixtures. No browser or public endpoint request.                        |

Exact `windowsFilters` for the 286-case subset:

```text
src/auth/auth.guard.spec.ts
src/auth/desktop-google-token-exchange.service.spec.ts
src/devices/dto/device-report.dto.spec.ts
src/admin-users/admin-user-devices.service.spec.ts
src/app-policy/access-policy.spec.ts
src/worker-fleet/enrollment/windows-consumer-profile.spec.ts
src/worker-fleet/enrollment/worker-installation-artifacts.service.spec.ts
src/worker-fleet/enrollment/worker-enrollment.service.spec.ts
src/worker-fleet/control/worker-control.service.spec.ts
src/realtime/realtime-resources.service.spec.ts
src/releases/desktop-policy.service.spec.ts
src/releases/release-controller-security.spec.ts
src/releases/release-policy.spec.ts
src/releases/release-policy.service.spec.ts
src/releases/release-publication.service.spec.ts
src/app-policy/app-policy.service.spec.ts
src/app-policy/processing-access.guard.spec.ts
src/realtime/realtime-auth.service.spec.ts
src/http/snake-case-wire.spec.ts
```

## Initial dashboard failure and honest final scope

The broad parallel run timed out in the existing settings tests “finds an exact
account ID with the detail endpoint and canonicalizes uppercase input” and “keeps
selections across explicit user-search pages”. It ran alongside the full backend
and landing/static checks; jsdom creation accounted for 50.50s of aggregate worker
time. The isolated ten-case file and serialized full 218-case run passed without
increasing timeouts, editing production/test source or removing those cases.
This supports a load-sensitive test budget observation, not a Windows UI timing
claim or proof that default concurrent execution can never time out.

No Windows-caused assertion/type/lint/build regression was found, so no source
fix or unrelated mobile/settings fixture rewrite was required.

## Requirement-to-receiving proof

| Windows requirement                                 | Actual receiving entry / test coverage                                                                                                                                                                                                                                                                                                                                                                                                | Deferred proof                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Windows account/device/principals and fixed OAuth   | Backend [auth/device source and contract](W05-backend-platform.md); current full/focused auth/device/exchange units validate Windows and existing platform boundaries.                                                                                                                                                                                                                                                                | Real registered OAuth/Firebase audience, account/device session on installed Windows and deployed backend.           |
| Consumer profile/artifact scope                     | [Windows consumer profile fixture](../../../backend/src/worker-fleet/enrollment/windows-consumer-profile.spec.ts) and [artifact selector](../../../backend/src/worker-fleet/enrollment/worker-installation-artifacts.service.spec.ts) reject wrong build/arch/provider, absent/invalid profile catalog and service fallback.                                                                                                          | Actual approved signed runtime/fixture/catalog, authorized enrollment and qualified GPU.                             |
| Independent desktop cloud gates and live projection | [Desktop policy unit](../../../backend/src/releases/desktop-policy.service.spec.ts), actual direct mock HTTP guard test, existing resource/auth units and dashboard [desktop section](../../../dashboard/src/features/releases/desktop-policy-section.test.tsx)/[API](../../../dashboard/src/features/releases/desktop-policy-api.test.ts)/[page](../../../dashboard/src/features/releases/update-policy-page.test.tsx) are included. | Deployed revision CAS/raw snapshots, fresh real administrator authority and actual installed minimum-build behavior. |
| User-readable Windows worker identity               | Dashboard [platform](../../../dashboard/src/features/workers/worker-platform.test.ts)/[worker API](../../../dashboard/src/features/workers/worker-api.test.ts) and full dashboard suite cover consumer versus omitted legacy service identity and original raw realtime behavior.                                                                                                                                                     | Actual machines/admin filters and native approval/claim behavior.                                                    |
| Honest pending Downloads destination                | Actual [Windows server-render fixture](../../../landing_page/src/windows-release.test.ts), product-link and i18n units; source card preserves 22H2/build19045/native x64/GPU/shared extension and no unverified installer URL/availability.                                                                                                                                                                                           | Authorized publication/readback and actual downloaded signed installation.                                           |

## Explicit exclusions and remaining gates

- Full `pnpm run verify` wrapper was not invoked: its full AppModule-dependent
  HTTP fixtures can evaluate `EnvironmentModule`, whose current test path may
  load private `.env.test`. No private env file or its values were accessed in
  this return. The required `test:secrets` gate was run separately after proving
  its tracked dotenv inputs are public example templates. Direct mock HTTP
  desktop/publication guards were checked instead; the full HTTP suite is not
  reported passed here.
- Mongo/Redis/Firebase/R2/vendor/CapRover integrations, browser Playwright/Electron,
  device/native Windows, signing/installer/package publication and live API calls
  remain unrun. No previous dated integration record is current live evidence.
- Dashboard/landing deployment scripts were inspected; no deploy CLI, Windows
  release builder or production server was launched. Existing backend unit
  archive fixtures create/remove only their disposable allowlisted source
  package. The landing test server and direct mock API are owned loopback fixtures.
- W01's eight moderate development builder findings/security exception and
  W31/W34 real approved inputs/native acceptance remain separate unchecked gates.

This checkpoint completes the assigned affected source-code checks. It is not
release approval, deployment compatibility proof or actual Windows acceptance.

Evidence validation: scoped Prettier passes; all local references resolve.
