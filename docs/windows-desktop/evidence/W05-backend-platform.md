# Evidence: W05 — Windows backend contracts

- Date: 2026-10-09.
- Source revision: `c0218633c43559c8ad1988e5037273970a91f99b`; existing checkout contains substantial unrelated work, preserved in place.
- Scoped tracked-source diff SHA-256: `8ef12e6c3b332c0e1d718da4e275511e27566452f02f0fcce62fc0bea3731785` (auth/device/policy/worker-profile/OpenAPI and relevant fixtures; includes pre-existing edits in those paths).
- Host: macOS arm64; Node v24.18.0; Vitest v4.1.11; installed pnpm and component dependencies.
- Status: code-complete-Windows-pending.

## Implemented behavior

- One `CLIENT_PLATFORMS` constant accepts Windows account sessions and device reports. Persisted device platform remains immutable, and ownership/session/metadata fences remain unchanged.
- Windows has a separate optional desktop minimum-build policy. Absent persisted policies remain valid; public responses show a null Windows gate. Existing mobile store selections are unchanged.
- Installation runtime identity optionally records `installationProfile: "windows-user"`. Consumer activation requires Windows x64, build 19045 or later, DirectML capabilities that reference reported GPUs, and existing model/recipe/output and account-approval fences. These are client declarations rather than remote GPU attestation.
- Consumer artifact/update selectors use the distinct trusted catalog key `windows-amd64-user`. They never fall back to the service artifact. The consumer profile is covered by the reconstructed signed metadata. Update selection matches the machine's stored profile and approved platform; revoked/deleted machines and unsigned consumer packages fail closed.
- Existing fixed-client, loopback-only PKCE Google exchange serves both desktops. No new secret, client-ID selector, redirect alias or upstream endpoint was added. Public Windows configuration must match the existing backend client ID and Firebase audience policy; its matching secret remains backend-only.
- OpenAPI/client/realtime documentation preserves snake_case requests and responses, with exact camelCase `signed.metadata` retained for signature verification. Worker job protocol framing and its generated copy are unchanged.

## Code checks

All backend commands were run from `backend/`; the protocol-copy command was run from `worker/`. No UI/device tests or production services were used.

| Command                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Result                                                                                                         | Evidence scope                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run lint`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Passed, exit 0                                                                                                 | Backend source/test lint with warnings denied.                                                                                                                                                                            |
| `pnpm run typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Passed, exit 0                                                                                                 | Current strict TypeScript contracts and tests.                                                                                                                                                                            |
| `pnpm run build`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Passed, exit 0                                                                                                 | Compiled Nest ESM source.                                                                                                                                                                                                 |
| `pnpm exec vitest run src/auth/auth.guard.spec.ts src/auth/desktop-google-token-exchange.service.spec.ts src/app-policy/access-policy.spec.ts src/devices/dto/device-report.dto.spec.ts src/worker-fleet/enrollment/worker-installation-artifacts.service.spec.ts src/worker-fleet/enrollment/windows-consumer-profile.spec.ts src/worker-fleet/enrollment/worker-enrollment.service.spec.ts src/realtime/realtime-auth.service.spec.ts src/http/snake-case-wire.spec.ts` | Passed, 190 tests / 9 files                                                                                    | Windows metadata and build gates, consumer/profile/signature boundary, wrong architecture/provider/build/GPU/profile, permission/auth-time/revocation, fixed OAuth configuration and stale realtime identity regressions. |
| `pnpm run test:e2e`                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Passed, 224 tests / 33 files                                                                                   | Isolated HTTP composition and existing client behavior; Windows bootstrap reports its own platform and build policy. These are API fixtures, not UI tests.                                                                |
| `node --test --test-concurrency=1 test/devices.integration.mjs test/app-policy.integration.mjs`                                                                                                                                                                                                                                                                                                                                                                           | Passed, 2 tests                                                                                                | Compiled source with owned loopback Mongo fixtures: Windows platform persistence, isolation/immutability, independent desktop gates and revision CAS.                                                                     |
| `node scripts/sync-protocol.mjs --check`                                                                                                                                                                                                                                                                                                                                                                                                                                  | Passed, exit 0                                                                                                 | Generated worker protocol copy matches the authoritative backend source.                                                                                                                                                  |
| `pnpm test`                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Initial full run passed 1,696 tests / 159 files; final broader run had 1,696 passes and 1 failure out of 1,697 | Failure is the unrelated existing public-page configuration fixture described below. All 190 W05-focused tests passed after the final security edits.                                                                     |

Scoped Prettier checks and the final build are recorded at completion below.

## Broader fixture limitations

The compiled `test/auth.integration.mjs` run reaches native Node API startup with isolated Firebase Auth, Mongo and Redis, then fails at line 110 because it expects `/delete-account` to return 503 without custom public-policy configuration. Current repository-owned defaults return 200. The assertion was left unchanged.

The final full unit run also records one unrelated public-pages test expecting 503 where 200 was returned for a `PUBLIC_SUPPORT_EMAIL` case. No public-page source, configuration or test was changed for W05. These failures do not establish a Windows contract defect and must not be reported as passing broad checks.

## API guideline preflight

Read the current [official Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/) on 2026-10-09 using the `zalando-api-guidelines` skill. Rules 100/101 shaped specification-first updates; 104/105 preserved authentication/permission fences; 106 requires compatible extension; 118 keeps wire keys snake_case; 148/151 preserve existing method/status behavior. Existing lowercase platform enums and opaque signed metadata retain their established protocol. REST URL/method rules do not replace the raw WebSocket framing or worker hint transport. No API was deployed.

## Native acceptance and continuation

- Real Windows Google/email session reports, consumer enrollment, DirectML execution and update installation are unrun and remain W34 acceptance items.
- No real OAuth credentials, Firebase provider settings, R2 catalogs, account approvals or fleet registrations were changed.
- No new Windows download URL was invented or published. App/installer/runtime release production inputs and artifact signatures belong to W29/W31.
- Client use belongs to W14/W23/W29, with dashboard presentation in W32.

## Final completion checks

- Scoped formatter: `pnpm exec prettier --check` for all W05 source/fixture/contract/task/evidence files passed.
- Current-source rebuild: final `pnpm run build` passed; `git diff --check` for scoped tracked files passed.
- Diff/contract review: completed; unrelated work preserved.

## Final receiving-source return — 2026-10-10

The [W05/W32 final matrix](W05-W32-final-source-closure-2026-10-10.md)
reconciles all task source rows against actual backend/admin/client entry points,
separate numeric/signed version authorities, compatibility/privacy fixtures and
operator prerequisites. Current backend 232 + 54 unit cases/19 distinct files,
44 isolated HTTP cases/7 files and full types/lint/format/build pass. Historical
unit/HTTP/Mongo counts above are preserved rather than presented as fresh runs.
All real OAuth/Windows/GPU/enrollment/catalog/release/deployment proof remains
unchecked. No provider/configuration secret, live approval or release URL changed.
