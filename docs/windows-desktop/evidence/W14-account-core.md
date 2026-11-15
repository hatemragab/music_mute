# Evidence: W14 — Trusted account core

- Date: 2026-10-09.
- Host: macOS arm64; Node v24.18.0; TypeScript 6.0.2; Vitest 4.1.11.
- Status: account core complete; dependent consumer wiring pending.
- Scope: `windows-desktop/src/main/account/`, `src/shared/account-contracts.ts`, `tests/account-controller.test.ts`, `tests/account-oauth.test.ts`. Root owns the integrated main broker, native HostContext adapter, renderer AccountPanel and its headless tests.

## Source and security boundaries

The trusted `AccountController` implements email sign-in/sign-up, public reset requests, verification cooldown/recheck, credential refresh/restore, Google sign-in/link/reauthentication, password linking, provider unlinking, device history/removal, logout/logout-all, account deletion and server-governed recovery. Routes and Firebase request bodies mirror the existing macOS account source and backend contract; no new backend endpoint or recovery semantics were invented.

Public configuration uses the existing four macOS keys. Fixed Firebase/Google destinations, bounded responses, timeouts and no redirects protect the transport. Google uses a real ephemeral `127.0.0.1` HTTP listener, random PKCE verifier/state, S256, exact callback validation and the system browser. The backend performs its existing fixed-client code exchange. The browser completion page does not reflect codes/state and clears the query with a CSP-bound script.

`AccountView` selects presentation fields only. Refresh/ID tokens and Firebase UID remain in main-process credential/session ports; password command values are transient. Native exceptions and arbitrary upstream payload/error text are not copied to views. Root binds `AccountVaultPort` to the current-user Windows vault; the code test vault uses synthetic values only.

Sign-out immediately rotates generation, clears presentation/account capabilities, queues a persisted tombstone and credential cleanup, and keeps account-free processing independent. Vault/state writes serialize so late old-account writes cannot overwrite the next login. `sessionScope`, `assertScope`, `captureOwnerFence` and private scope publication supply the owner fences consumed by W15/W20/W27. Pending deletion drops active account scope while retaining the narrow credential needed by existing recovery routes. Recovery requests remain pending until the server reports the account active.

`dispose()` aborts browser/network/refresh work and fences the closed controller without logging out, removing saved credentials, or changing a separately enrolled worker.

## Executed code checks

Commands below ran from `windows-desktop/`. No desktop UI was launched and no real OAuth, Firebase account, deletion, worker or Windows vault was used.

| Command                                                                                                                                    | Result                        | Scope                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/account-controller.test.ts tests/account-oauth.test.ts`                                                              | Passed: 28 tests / 2 files    | All implemented account families; request bodies, cooldowns, project/owner scope, wrong/duplicate OAuth callbacks, loopback timeout/cancel, vault failure, A→B switches, delayed writes, revoked refresh, interrupted deletion, offline restore and bounded transport. |
| `npm test`                                                                                                                                 | Passed: 71 tests / 11 files   | Integrated desktop source fixtures, including root-owned account forms/confirmation/labels, native HostContext port fixtures and app/shell contracts. Synthetic/headless proof only.                                                                                   |
| `npm run typecheck`                                                                                                                        | Passed                        | Strict types and integrated AccountController/HostContext/main signatures.                                                                                                                                                                                             |
| `npx oxlint --deny-warnings src/main/account src/shared/account-contracts.ts tests/account-controller.test.ts tests/account-oauth.test.ts` | Passed: 0 warnings / 0 errors | Owned source/tests.                                                                                                                                                                                                                                                    |
| `npm run build`                                                                                                                            | Passed                        | Main/preload/renderer/companion source bundles. Native Windows compilation remains separate.                                                                                                                                                                           |
| Scoped Prettier check                                                                                                                      | Passed                        | Owned account source/tests and W14 documentation.                                                                                                                                                                                                                      |

## Official-source preflight

The current [Zalando RESTful API and Event Guidelines](https://opensource.zalando.com/restful-api-guidelines/), [Firebase Auth REST reference](https://firebase.google.com/docs/reference/rest/auth) and [Google installed-app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) were read on 2026-10-09. Existing secure bearer authorization, compatible request semantics, snake_case backend fields and official Firebase camelCase forms were preserved. Client configuration has no desktop secret; the backend still owns the fixed OAuth exchange credentials.

## Native acceptance and continuation

- Real Windows current-user vault access, Google/email accounts, session restoration, provider linking and authorized deletion/recovery remain W34 checks.
- The combined realtime/download/playback/outbox fence and cross-owner integration checkboxes remain unchecked. W15/W20/W27 bind the trusted scope/fence methods to realtime, durable account outboxes/transfers and Chrome. Their remaining feature implementation is tracked in their own tasks.
- Root controls AccountPanel/main/HostContext integration. English/Arabic presentation/accessibility expansion is also tracked in W28.
- No production settings, account approval, catalog, release, secrets or real user data changed.

## Final review

- Scoped formatting: the owned source/tests/W14 task/evidence Prettier check passed.
- Token-free view/command review: complete; safe fields only, strict known command keys and explicit destructive confirmations.
