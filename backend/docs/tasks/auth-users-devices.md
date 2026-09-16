# Backend auth, users, and devices task tracker

Status: all ten tasks implemented and locally verified on 2026-09-09.

- [Specification](../superpowers/specs/2026-09-08-auth-users-devices.md)
- [Implementation plan](../superpowers/plans/2026-09-08-auth-users-devices.md)

Work only in `backend/`. No mobile changes, Firebase settings changes, commits,
pushes, deployment, or live account creation are included.

## Ordered implementation tasks

| ID      | Task                                                            | Depends on                | Completion evidence                                                           |
| ------- | --------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| AUTH-01 | Firebase identity verification and safe configuration           | —                         | Token/provider/error tests; production rejects emulator configuration         |
| AUTH-02 | Persistent request limits and atomic email budgets              | AUTH-01                   | Concurrent Redis reservations and API-restart counter tests                   |
| AUTH-03 | User schema, automatic names, authoritative profile sync        | AUTH-01                   | Unique UID races, provider identity, naming, and protected-field tests        |
| AUTH-04 | Installation records and current version/history tracking       | AUTH-03                   | Multiple installations, ownership, revisions, concurrency, and rollback tests |
| AUTH-05 | Optional verification policy and future processing access rules | AUTH-03, AUTH-04          | Optional-by-default, runtime policy change, and minimum-build tests           |
| AUTH-06 | Session/profile/device/policy API contracts                     | AUTH-02–AUTH-05           | HTTP validation, idempotency, ownership, pagination, and recovery-route tests |
| AUTH-07 | User-requested verification and password recovery               | AUTH-02, AUTH-03, AUTH-06 | Mail budgets, generic recovery responses, and ambiguous-send tests            |
| AUTH-08 | Logout from all Firebase sessions                               | AUTH-02, AUTH-03, AUTH-06 | Two-session revocation, fresh sign-in, and partial-failure tests              |
| AUTH-09 | Explicit indexes, policy operations, and version statistics     | AUTH-03–AUTH-08           | Safe dry-run/apply tests, index startup guard, aggregate-count tests          |
| AUTH-10 | Isolated integration proof and backend handoff documentation    | AUTH-01–AUTH-09           | Full verification, emulator/native integration, build and diff review         |

## Execution checklist

- [x] AUTH-01 complete. Firebase signature/provider/configuration tests, owned SDK lifecycle and five-second operation deadline verified; native signature fixture rejects tampering and invalid claims.
- [x] AUTH-02 complete. Real Redis reservations, 200/201 concurrency, atomic refusal, AOF recovery, actual-provider reconnection and shared HTTP counters verified; review closed.
- [x] AUTH-03 complete. UID upsert races, stable names, overlapping alias sync, duplicate-key recovery, immutable UID and strict schema fields verified with unit and MongoDB tests.
- [x] AUTH-04 complete. DTO validation and real MongoDB ownership/revision/history/concurrency/rollback tests passed; pagination and Unicode review fixes verified.
- [x] AUTH-05 complete. Permissive defaults, live policy CAS, unavailable storage, verified-token processing guard and recovery routes verified.
- [x] AUTH-06 complete. Real Nest guard order, body ownership protection, repeated bootstrap, pagination, safe presenters and raw duplicate Authorization headers verified.
- [x] AUTH-07 complete. Voluntary mail, separate atomic budgets, pauses, no ambiguous retry, generic recovery and emulator-only verification action verified.
- [x] AUTH-08 complete. Ordered revocation/cutoff, dependency failures, preserved devices, old sessions rejected and fresh emulator sign-in accepted.
- [x] AUTH-09 complete. Compiled CLI dry-run/statistics preserve an empty database; explicit apply creates all four indexes; duplicates/conflicts, policy CAS and distinct-user statistics verified.
- [x] AUTH-10 complete. Full formatter/linter/type/unit/HTTP/native checks and second compiled-entry build passed; implementation and operations documentation delivered.

Do not check off a task solely because its files exist. Record the actual command
and outcome beside its task when the behavior and its verification are complete.

## Release acceptance

- [x] Firebase owns credentials; all backend identity derives from verified UID.
- [x] Ordinary names use email prefixes; Apple relay aliases remain stable.
- [x] Verification is optional, sends are user-requested, enforcement is initially off.
- [x] Shared limits enforce 60 seconds / 3 per user per day / 200 per project per day.
- [x] Multiple installations retain current versions and bounded transition history.
- [x] Stale reports and other users cannot overwrite an installation's metadata.
- [x] Logout-all rejects both existing sessions and retains device statistics.
- [x] Future processing policy can require verification or a newer build.
- [x] No passwords, tokens, keys, or raw email/IP values leak through production logs/jobs.
- [x] No real mail, accounts, cloud settings, database migrations, or deployment were used as test fixtures.

## Planning validation

Planning validation covered document formatting, consistency, links and scope.
The execution checklist above records actual implementation evidence. The final
combined commands and local-versus-production boundaries follow.

## Final verification

Run from `backend/` on 2026-09-09:

| Command                         | Observed result                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format`                | Passed                                                                                                                                       |
| `npm run verify`                | Formatting, lint, TypeScript and build passed; 147 unit tests and 23 HTTP tests passed                                                       |
| `npm run test:integration`      | 1 native infrastructure test passed, including API/Redis crashes and queue AOF recovery                                                      |
| `npm run test:auth:integration` | 15 native tests passed with isolated MongoDB, Redis, Firebase Auth Emulator, compiled operator CLI and production-verifier signature fixture |
| `npm run build` again           | Passed; nonempty API and operations CLI entry points verified                                                                                |
| `git diff --check`              | Passed; new backend files also covered by formatting and scoped source reviews                                                               |
| `npm ls --omit=dev --depth=0`   | Passed with no invalid runtime dependency tree                                                                                               |
| `npm audit --omit=dev`          | Exit 1: six moderate package findings from one transitive uuid advisory; zero high/critical runtime findings                                 |

The native auth scenario proves two installations and two Firebase sessions for
one UID, other-owner isolation, voluntary emulator verification and token refresh,
shared IP/mail limits across API restarts, same-process Redis outage recovery with
persisted limits, and logout of old sessions followed by a successful later sign-in.
Actual operator policy changes are enforced by a test-only processing endpoint
using the verified emulator token and owned MongoDB installation. The production
API does not contain that probe or any audio-processing endpoint.

Scoped reviews identified and resolved the profile alias race, Unicode and
pagination mismatches, Firebase operation deadline, Redis reconnection, dry-run
database mutation, missing query indexes, special index-key normalization, and
stable HTTP error-code mismatches.

## Main implementation files

- `src/auth/auth.module.ts`, `auth.guard.ts`, `auth.controller.ts`, and the Firebase,
  mail and logout services: request identity, account routes and failure handling.
- `src/users/users.service.ts` and `src/devices/devices.service.ts`: owner-scoped
  profiles, installations, revisions and bounded history.
- `src/rate-limits/`: shared counters, atomic mail budgets and reconnecting security client.
- `src/app-policy/`: live policy storage and future processing-access guard.
- `src/operations/cli.ts`: explicit index/policy commands and installation statistics.
- `test/`: isolated integration fixtures and HTTP contract coverage.
- [Client API](../auth-api.md) and [operator commands](../auth-operations.md).

## Remaining proof boundaries

This is local implementation and validation, not deployment proof. Real Firebase
credentials/provider configuration, native Google/Apple sign-in, real mailbox
delivery, Atlas access, S3 access, Docker builds and VPS deployment were not tested.
Firebase protections still apply outside these backend counters. The moderate
runtime advisory remains documented; no forced downgrade or unverified major
override was applied. No commits, pushes or production mutations were performed.
