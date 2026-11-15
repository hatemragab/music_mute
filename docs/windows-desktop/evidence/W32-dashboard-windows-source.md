# W32 — Windows dashboard source checkpoint

- Date: 2026-10-09. The initial checkpoint below was recorded when implementation paused for task preparation; the later authorized source return is recorded separately below.
- Git base: `c0218633c43559c8ad1988e5037273970a91f99b`.
- Scoped source/test SHA-256: `d13acf5dfc14a5f4f5974435be9e2d0bae9d895cf21c6927abb73a96c4a8463d` across ten affected dashboard/backend files. Existing unrelated dirty changes in those files were preserved; this fingerprint is a checkpoint of full file contents, not an assertion that every dirty line belongs to W32.
- Host: Darwin arm64 / Node v24.18.0; no Windows, browser/device UI, enrollment, publication, deployment, production flags or live R2 actions.
- Status: dashboard/profile source checked; full W32 release/publication/Windows acceptance is incomplete.

## Written source

Dashboard worker runtime types now retain the existing optional `installationProfile: "windows-user"`. `worker-platform.ts` presents the per-user consumer separately from omitted legacy Windows service identity, existing Mac identity, unknown profiles and profile/platform mismatch. Fleet and machine detail show this distinction, the chosen 22H2/build-19045/x64/DirectML/logged-in-user requirements and the distinction between client-reported facts, backend qualification and current machine policy. Existing Windows platform filters/raw WebSocket subscriptions remain unchanged.

Registration guidance and native link-import policy copy include Windows. Existing permissions, recent admin authentication, operation/revision fences, account/worker independence and presentation-only link hiding remain unchanged. New headless tests cover identity distinctions and the actual machine detail rendering; backend tests verify that authorized projections retain optional profile and exclude the credential hash. No production backend route/schema changes were required for the already implemented W05 field.

Affected source: dashboard worker platform/types/fleet/detail/API fixture tests, user registration section, native link-policy form/picker copy, and `backend/src/worker-fleet/control/worker-control.service.spec.ts`. No Windows installer endpoint, direct download URL, release publisher, new mobile distribution or service fallback was added.

## Already executed checks

| Command / component                                                                                                      | Result                      | Proof boundary                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck` / dashboard                                                                                          | Passed, exit 0              | Current dashboard TypeScript.                                                                                                    |
| Explicit worker platform/API, registration, processing-settings and mobile update-policy Vitest files / dashboard        | 44 passed / 5 files, exit 0 | Headless React/transport fixtures; no real browser, auth, backend, R2 or Windows execution.                                      |
| `npm run build` / dashboard                                                                                              | Passed, exit 0              | Source bundle; existing larger-than-500-kB chunk advisory remains.                                                               |
| Scoped ESLint on nine affected dashboard files                                                                           | Passed, exit 0              | Source/test lint; no unrelated rewrite.                                                                                          |
| Scoped dashboard Prettier write                                                                                          | Completed                   | Formatting of affected files only. No later format-check claim is made here.                                                     |
| Explicit worker control/consumer profile/artifact, public mobile release-policy and access-policy Vitest files / backend | 71 passed / 5 files, exit 0 | Existing Windows/legacy selection, no-secret projection, absent catalog and mobile compatibility; synthetic fixture grants only. |
| `pnpm exec tsc --noEmit`, `pnpm run build` / backend                                                                     | Passed, exit 0              | Current strict source and Nest build; no server/deployment execution.                                                            |
| Scoped backend oxlint                                                                                                    | 0 warnings/errors, exit 0   | Changed projection regression file.                                                                                              |

The artifact fixture tests deliberately emit dependency-unavailable warnings for missing/unpublished trusted catalog inputs. Those warnings are expected fail-closed behavior and not a configured release proof.

## Gap audit for task preparation

- W32 still needs final W29/W31 signed app/runtime/model/publisher metadata binding and any approved desktop policy administration/distribution presentation. `/admin/update-policy` is the existing Android/iOS store workflow; Mac has its separate Sparkle workflow. It must not be reused as an invented Windows installer publisher.
- Windows numeric account-policy minimum build is separate from the consumer updater's signed semantic minimum versions. The final packaged build identity and release metadata must map these honestly; no future build/URL should be fabricated to satisfy a required update.
- Backend `WORKER_INSTALLATION_CATALOG_PATH` selects authenticated worker runtime/model/approved fixture grants; `windows-amd64-user` is the consumer runtime target. A worker ZIP/grant is not a public app installer destination.
- Windows product destinations are already centralized in `windows-desktop/src/main/security.ts`; current Downloads is the reviewed landing-page destination. A direct installer requires actual verified publication metadata. No new direct URL was introduced or live availability verified.
- Full native/OS/GPU/installer/update/admin visibility, cross-product live compatibility and deployment acceptance remain pending and require the later connected Windows target and explicit release/deployment authorization.

The [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/) were refreshed on 2026-10-09. Compatibility, authorization, secret-free projection and existing wire naming guided this consumer change; no new REST endpoint or wire field was invented. Preserve this checkpoint and revalidate after future implementation is explicitly resumed.

## Authorized desktop policy and live-gate source return — 2026-10-09

The earlier fingerprint/results above remain historical. The independent
`GET/PATCH /admin/update-policy/desktop` resource now manages numeric macOS/Windows
cloud-access gates. Read uses `releases.read`; write uses existing fresh Google
`releases.manage`, reason, UUIDv4 operation ID, transactional AdminOperations receipt
and global AppPolicy revision CAS. Selected gates require null or an integer
1–2147483647; omission preserves the other channel. Closed bodies reject mobile,
URLs/publisher fields, unknown properties and unsafe revisions. The last safe
revision is allowed once; overflow is rejected before an operation starts.

The service writes only selected desktop paths/revision; mobile selections,
verified-email policy, signed updater channels and app/runtime/model publication
remain independent. Replay never repeats a write. Current policy may be newer
than receipt `applied_revision`; database failures use bounded Problem JSON.
OpenAPI, client contract, route/security matrix and admin inventory are aligned.

Dashboard UpdatePolicyPage mounts a separate desktop section independent of mobile
draft/preview failures. It loads once with no polling or focus/reconnect refetch.
Review freezes only changed channels, then existing fresh Google/reason confirms
save. Permission, integer/clear, CAS and response-loss receipt readback are tested.
A conflict reads current state once and requires another review; missing committed
receipt revision stays uncertain. No installer target, direct URL or mobile
selection is guessed.

The established owner `policy` full snapshot adds optional `app_policy` using the
existing public presenter. The shared feed observes `app_policies` and invalidates
only policy. Public minimums/email requirement/global revision contain no release
selection, installer URL or account selector. Existing clients ignore this additive
field; REST processing-policy shape and schema version remain unchanged.
Windows AccountUsage applies the live field through its existing callback even
with identical processing revision. Separate checkout/owner epochs and the account
controller's global revision fence prevent delayed reads/old owner streams/lower
or later unversioned policy relaxing a newer gate, including later bootstrap.
Cached/offline policy does not grant cloud admission. No new socket/resource,
scheduler, recurring HTTP read or command transport was added.

| Executed component checks                                               | Current result and boundary                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend desktop/publication/mobile/access/worker profile/artifact units | **7 files / 94 tests passed**; synthetic services/grants.                                                                                                                                                        |
| Backend desktop/publication/exhaustive admin HTTP fixtures              | **3 files / 83 tests passed**; real Nest guards/wire/freshness, synthetic identity/domain services.                                                                                                              |
| Backend realtime projection/auth/socket/protocol/queue fixtures         | **5 files / 51 tests passed**; scoped invalidation/compatible full snapshots.                                                                                                                                    |
| Compiled owned loopback Mongo replica-set/Redis realtime integration    | **1 passed**; app-policy commit/clear reached both feed instances without processing revision changes. Baseline 6 sockets/2 feeds/202 queued fixtures/8 timed queue writes/p95 1081 ms; not production capacity. |
| Backend full TypeScript/lint/Nest build and scoped formatting           | Passed; no deployment.                                                                                                                                                                                           |
| Dashboard desktop/mobile/worker/registration/settings/API fixtures      | **8 files / 67 tests passed**; headless React/transport only.                                                                                                                                                    |
| Dashboard types/scoped ESLint/Prettier/source build                     | Passed; existing >500-kB chunk advisory remains.                                                                                                                                                                 |
| Windows fleet/update/account/usage/realtime                             | **27 files / 269 tests passed**, full types/lint/build, 392 files/zero warnings/errors.                                                                                                                          |

The [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were refreshed on 2026-10-09 for endpoint security/scopes, snake wire, compatible
extensions, bounded OpenAPI responses, idempotent PATCH/conflicts. Existing body
operation IDs/global revision conventions are retained. Explicit null clear and
omitted channel preserve follow documented partial-update semantics, while missing
persisted desktop gates project null. REST rules do not replace raw socket framing;
the additive contract is in PROTOCOL.md.

Remaining prerequisites: genuine sealed W29/W31 publisher/feed/catalog inputs,
public destination publication, authorized backend/dashboard deployment and actual
admin/Windows minimum-build/update journeys. Destinations remain centralized;
private worker artifacts/grants are not app downloads. Real native signing,
installer/GPU/registration and cross-product acceptance remain unrun. No live
policy change, deployment, publication, enrollment or real-data mutation occurred.

## Final production-source return — 2026-10-10

The [W05/W32 final matrix](W05-W32-final-source-closure-2026-10-10.md)
supersedes the earlier source-gap statements without erasing historical evidence.
Actual sealed numeric build identity, independent app/catalog consumer source,
authenticated installed catalog loader and real rebound Prepare Operations now
compose the separate desktop administrator policy and live account gate.
Original backend enrollment reports remain immutable reported facts, distinct
from locally protected current-boot fleet/GPU authority and backend capacity.

The remaining source presentation gap is closed: landing Downloads has an EN/AR
Windows pending card, explicit Win10 22H2/build19045 and Win11 x64/GPU requirements,
the shared extension as a future verified release, and no download action/URL/live
badge. Both actual App server-rendered locales are tested. A dashboard actual
Windows device-snapshot test validates numeric version/build/OS without implying
online status, worker approval or a download.

Current dashboard 49 cases/7 files and full type/lint/format/build pass; landing all
15 cases/3 files and full type/lint/format/build pass. Backend current 286 unit
cases/19 distinct files plus 44 isolated HTTP/7 files and complete component checks
pass. Windows/package/catalog/account/locale and policy/realtime/guest/closed UI
slices pass 114/7 and 65/5 respectively. Web canonical Downloads test passes.
Exact commands, intermediate corrected fixture errors and proof boundaries are
recorded in the matrix. Genuine provider/catalog/publisher/feed/package/public
release inputs, real Windows/Chrome/GPU/native acceptance and authorized deployment
remain unchecked; no live availability was asserted or release work performed.
