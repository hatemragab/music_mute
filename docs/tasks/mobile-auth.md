# Mobile authentication tasks

Status: Local implementation and scoped reviews complete on both platforms. Android checks and connected-device flows passed with the password-link emulator limitation below; live provider readiness remains unverified.

- [Design](../superpowers/specs/2026-09-09-mobile-auth.md)
- [Implementation plan](../superpowers/plans/2026-09-09-mobile-auth.md)
- [Validation results and remaining configuration](../validation/mobile-auth-2026-09-09.md)

## Current scope

| ID | Deliverable | Depends on | Status |
| --- | --- | --- | --- |
| MOBILE-AUTH-01 | Native contract and installation persistence | None | Implemented; review closed |
| MOBILE-AUTH-02 | Backend transport and ID-token handling | 01 | Implemented; Android fixture verified |
| MOBILE-AUTH-03 | Firebase email identity adapters | 01 | Implemented; Android fixture verified |
| MOBILE-AUTH-04 | Android Google Credential Manager integration | 03 | Implemented; SDK fixture passed; real prompt unverified |
| MOBILE-AUTH-05 | iOS Apple AuthenticationServices integration | 03 | Implemented; build/static/review passed; runtime excluded |
| MOBILE-AUTH-06 | Session restoration, app gate, and logout lifecycle | 01–05 | Implemented; Android device checks passed; reviews closed |
| MOBILE-AUTH-07 | Login, registration, recovery, and localized UI | 06 | Implemented; Android EN/AR checks passed |
| MOBILE-AUTH-08 | Account linking, reauthentication, safe unlinking | 04–07 | Implemented; Google unlink/relink passed; password link blocked by emulator |
| MOBILE-AUTH-09 | Account, optional verification, installations, logout UI | 06–08 | Implemented; Android fixture checks passed |
| MOBILE-AUTH-10 | Integration tests, regression checks, documentation | 01–09 | Complete within revised test scope; external limits documented |

Android core/UI reviews and final iOS scoped review found no remaining Important findings after fixes. Android: 43 tests passed, lint zero errors, Debug/Release/AuthE2e builds passed. iOS: unsigned Debug/Release builds and static checks passed, with no runtime test claim. The connected test app's local services were restored after the user reported Google service-unavailable during cleanup; Google fixture sign-in was repeated successfully and the services were left running for user review.

## Follow-up after current auth work

- [ ] MOBILE-ACCOUNT-DELETE: Design and implement coordinated account deletion across Firebase and backend after MOBILE-AUTH-10. User requested this follow-up on 2026-09-09. Define reauthentication, Apple grant revocation where applicable, backend records/installation cleanup, failure recovery, and local-data behavior before implementing. Do not expose a partial Firebase-only delete action in the current auth release.

## Fixed boundaries

- Sign-in required; email/password on both platforms, Google on Android, Apple on iOS.
- Link methods to the same Firebase UID; unlink only after reauthentication with a usable method remaining.
- Verification optional initially; mail requests use backend quotas.
- Audio/downloads/playback/history/export remain local with current behavior, without account partition or server synchronization.
- No commit, push, deployment, publication, or production account/mail actions.
- Latest implementation instruction: device/UI testing only on the connected Android device (`$ANDROID_DEVICE_SERIAL`). No iOS runtime tests, Android emulator, or Maestro setup. Use focused existing/unit checks and both-platform build/static validation.
