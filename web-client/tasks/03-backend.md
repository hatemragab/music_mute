# Proper backend support for web

## Confirmed blocker

`backend/src/auth/dto/session.dto.ts` extends `DeviceReportDto`.
`src/devices/dto/device-report.dto.ts`, `src/auth/auth.types.ts`, and
`src/devices/device.schema.ts` accept Android/iOS only. An existing DTO test
explicitly rejects `web`. `src/app-policy/access-policy.ts` and
`app-policy.service.ts` index native-platform policies; simply widening the DTO
would create a runtime or release-policy error.

## Required approach

1. Invoke the available `zalando-api-guidelines` skill and read the current
   official guidelines before changing any wire contract. Follow backend
   `AGENTS.md` and the existing API conventions.
2. Support `platform: web` through session bootstrap, device reports, schema,
   ownership, lists, removal/revocation, and current-session presentation.
   Keep installation UUIDs stable within the browser profile; do not fingerprint
   users. Inspect existing ownership/reassignment semantics before persisting
   installation metadata across account changes.
3. Distinguish client platforms from native release platforms. Web must not
   require an Android APK/iOS release or accidentally inherit the iOS branch of
   a ternary. Prefer keeping the existing native release-policy shape intact
   and handling web explicitly in processing access. Document the decision.
   Do not add an operator-managed web release subsystem for this feature.
4. Preserve all shared identity, account state, verification, quota, suspension,
   installation ownership, rate-limit, and processing availability checks for
   web. Only native binary-update requirements are inapplicable to the browser.
5. Review provider linking/unlinking and recent-auth rules for web. Retain a
   usable sign-in method and same UID. Check deletion/recovery transactions and
   logout-all fencing. No parallel browser-only account database.
6. Ensure web devices are not handed to native FCM/APNs dispatch without a
   registered supported push target. Web push is outside this version.
7. Audit existing Android/iOS/dashboard consumers of device lists and policies.
   Prove new web records do not break their parsing/presentation. If compatibility
   cannot be maintained within approved scope, report the concrete blocker.
8. Update OpenAPI, examples and directly affected client documentation with
   snake_case wire names, exact errors, and web bootstrap metadata semantics.
   Never add `/api/v1` aliases or relax authentication to make the browser work.

## Evidence required

Tests must demonstrate web bootstrap and owned device synchronization, processing
access for an eligible web session, rejection of unknown platforms, rejection of
missing/foreign/revoked installations, native minimum-build enforcement unchanged,
shared verification/suspension/quota checks preserved, old policy documents still
readable, and no native release lookup or native push dispatch for web.
Test owner isolation and existing mobile payload compatibility. Avoid merely
asserting the enum contains `web`; test the complete guard/service path.
