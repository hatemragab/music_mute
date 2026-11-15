# W10 durable session state and current lifetime source return

Reviewed and checked on macOS, 2026-10-10. These tests execute the real TypeScript
vault store, supervisor, control/client and event modules with injected native
ports. They do not run Windows, a Job, DPAPI, registry startup or live claims.

## Current source audit

The existing [W10 requirement ledger](W03-W10-W26-W31-W33-2026-10-09-closure.md#w10-independent-session-and-worker-source)
maps the actual independent launcher/bootstrap, SID-wide singleton, role Jobs,
saved intent, trusted personal owner, separate event lane, maintenance, login
capsule and account-independent fleet lifetime. Its machine-only gates remain
open. Current [session-agent](../../../windows-desktop/src/agent/session-agent.ts)
binds native events, real supervisor/control serving and qualified GPU admission;
confirmed ending stops the session, while ending-requested does not. Rebind and
new launch still require current protected preparation and ownership checks.

This review found one concrete durable-record gap:
[VaultSessionStateStore](../../../windows-desktop/src/main/session/state-store.ts)
used raw JSON parsing and could accept duplicate saved-intent/Force fields.
It now uses the existing bounded duplicate-key-refusing strict parser. Malformed
UTF-8, oversize, ambiguous or invalid records remain `STATE_UNAVAILABLE`; no
running intent is guessed. The only retained legacy migration is an absent
maintenance field. Plain record validation rejects accessors and inherited
records before that migration or reading a Force field. Force reason must be an
exact string literal; object conversion cannot manufacture an accepted reason.
Read and write plaintext buffers are cleared, including failed reads.

[Real-store fixtures](../../../windows-desktop/tests/session-state-store.test.ts)
preserve all four saved intents and exact Force records, reject top-level,
nested and escaped duplicate keys, malformed UTF-8, oversize and accessor/object
values. A composed real Vault store → real SessionSupervisor case proves an
ambiguous record blocks before eligibility, role launch or claim reconciliation,
then releases the captured session lock during shutdown.

## Executed checks

- New store, supervisor and login-worker: **59 tests / 3 files passed at
  02:56:26**.
- Broader session/ownership/event/bootstrap/account lifetime:
  **126 tests / 14 files passed at 02:56:47**, 1.71 seconds:

  ```text
  npm test -- tests/session-state-store.test.ts tests/session-supervisor.test.ts tests/session-control.test.ts tests/session-observer.test.ts tests/session-login-worker.test.ts tests/session-login-capsule.test.ts tests/session-preparation-gate.test.ts tests/session-personal-owner-proof.test.ts tests/session-activity.test.ts tests/session-admission.test.ts tests/desktop-session-client.test.ts tests/account-lifetime.test.ts tests/browser-host-bootstrap.test.ts tests/personal-activity-notifier.test.ts --maxWorkers=2
  ```

- Whole Desktop TypeScript passed after correcting literal return types in the
  new injected-native fixture. Initial typecheck failures were confined to that
  fixture and are not called passes.
- Scoped lint on two changed files passed with zero warnings/errors; their
  formatting passed. Current source build and both renderer/preload package
  boundaries passed after the receiving source change.

Counts overlap. This is W10 source closure, not the final W33 whole-tree pass.
W25 separately records the reviewed Advanced Force Main/UI binding; its real
accepted-work interruption and exact native Job proof remain W34.

## Deferred native evidence

- [ ] Actual standard-user login, delayed/disabled HKCU Run and on-demand starts.
- [ ] App/Chrome/account-independent approved fleet lifetime and saved intents.
- [ ] WTS, cancelled shutdown, lock/sleep/network/logout and next-login delivery.
- [ ] Actual signed shim, named pipes, SID/logon contention, DPAPI and Job zero.
- [ ] Connected Force/guardian/secondary-GPU/uninstall and installed acceptance.

The native source owner reported no additional W10 lifetime source gap during
this review. Moving native registration, storage and GPU test-source returns
remain tracked in their owning W03/W11/W22/W26/W31 tasks.
