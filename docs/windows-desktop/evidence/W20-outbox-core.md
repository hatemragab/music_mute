# Evidence: W20 — Durable background account saving core

- Date: 2026-10-09.
- Host: macOS arm64; Node 24.18.0, TypeScript 6.0.2, Vitest 4.1.11.
- Source base: `c0218633`, with unrelated dirty work preserved.
- Owned source/test digest: `c2bce95965fbb2d6c93a0fc9c6a1987a72fff2fc05211eeac27fc54e07d61c14` (sorted outbox TypeScript source/tests and shared contract; checkpoint only).
- Status: outbox/account-save core implemented; main/Library/UI and reuse composition pending.
- Scope: `windows-desktop/src/main/outbox/`, `src/shared/outbox-contracts.ts`, `tests/outbox*.ts`.

## Behavior and ownership

A completed, verified Library original/voice pair is staged with the exact captured account UID/generation and installation identity. Account saving never runs inference or decides whether local playback may start. The journal reserves bounded retention before copying, persists immutable source/model/recipe/hash/timeline metadata and assigns one stable request UUID. Source files are app-owned and hash checked; Library source pins are required and their returned receipt is bound to the exact artifact/path/hash. The outbox owns separate private copies, uses no hardlinks and releases the temporary source pins only after copy verification. A durable `captured` checkpoint lets ordinary Library cleanup release its source independently. Before capture completes, retained source directories remain protected across crashes.

Concurrent staging of one owner/source is coalesced. Receipt notifications cannot compete with an active source capture. Explicit discard first aborts and awaits capture/transfer cleanup, then releases only exact private outbox copies. Pending directories stay protected until a committed save and durable Library association, or explicit discard. Original user-selected source files and global shared media are never removed by this flow. An already-created remote reservation has no cancellation API; discard exposes that it will expire rather than inventing a DELETE.

The Windows store uses private ACL-validated atomic journals and a current-user native cache mutex. Short mutex contention retries only before entering a mutation; uncertain journal writes are recovered from the durable record. Revision and attempt UUID fences reject late writers. The full store is bounded to 256 journals and 32 owner directories, with separate 256 MiB retained-original and voice budgets and a three-GiB free-space admission check. Corrupt journal/pair/profile/path data blocks unsafe transfer and remains visible. Unknown source files are never adopted by scanning a title or arbitrary path.

## Existing backend/storage contracts

The existing `/local-media-syncs` create service verifies owner plus request UUID and immutable body hash before creating an account record. Completions return an already committed row, and upload-grant requests deduplicate their request UUID. The Windows client reuses those exact bodies/routes, shared grant validation and the Windows-safe signed PUT helper. Only these proven idempotent commands receive bounded background retries. Ordinary `/jobs` or `/media-imports` intake is absent. A lost finalize response is resolved by the original create UUID; partial/ambiguous conditional PUTs are resolved by server pair completion/HEAD validation. A grant-refresh UUID is persisted before sending and reused after a lost response. A known expired grant may rotate that UUID; an expired pair reservation never silently receives a replacement intake UUID.

Uploads use private R2 HTTPS grants with exact content/checksum and create-only headers. Opaque server object identity/finalization remains authoritative; a 412 alone is not success. Bearer tokens stay in trusted backend requests and are never attached to R2 PUTs or written into journals/views. Rate-limit Retry-After is honored. Automatic retries are bounded to eight attempts with backoff; manual Retry keeps the same account-record identity. Logout/account switching aborts transport, clears presentation and preserves the original owner's pending records. A later generation of the same UID may resume them; another UID cannot.

Community owner-link compatibility uses the existing ready shared-cache delivery command and full-snapshot provider. It compares the expected local output length/hash and full source/timeline/profile before associating Library metadata. Its delivery request UUID is journal-stable. It performs no separation intake, inference or pair upload. W21 owns complete local/account/community reuse/publication composition.

`WindowsOutboxWatcher` uses Windows directory notifications and a short local debounce to wake durable commands. Reconnect/receipt events and retry deadlines can wake work; there are no recurring HTTP status GETs or automatic live-view refetches. Safe view fields expose saving/saved/retry state and fixed error codes, without owner IDs, media paths, credentials or signed URLs.

## Executed checks

| Command / `windows-desktop`                          | Result                                                | Proof boundary                                                                                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/outbox*.test.ts`               | 43 tests / 5 files passed                             | Journal/copy/upload/finalize faults, crashes/reopen, concurrent capture, cancellation, owner switches, stable request/grant IDs, limits, corrupt metadata, rate limits and community-owner delivery. |
| `npm test`                                           | 507 tests / 64 files passed                           | Current integrated source/headless fixtures; no UI/native app execution.                                                                                                                             |
| `npm run typecheck`                                  | Passed                                                | Strict source types including Library/account integration interfaces.                                                                                                                                |
| `npm run build`                                      | Passed                                                | Source bundles only; no Windows native build or installer.                                                                                                                                           |
| Scoped `oxlint --deny-warnings` / `prettier --check` | Passed after removing one unnecessary iterable spread | Owned source/tests and cloud/history follow-up files.                                                                                                                                                |

Six focused tests use real temporary filesystem files through a Windows-path fixture adapter. They prove copy/hash/pin/partial cleanup behavior, including matching MP4/M4A MIME names; they do not prove Windows ACL, file sharing or native mutex behavior. HTTP, R2 and account data are synthetic fixtures.

## Remaining composition and Windows acceptance

Root owns completed-personal-result staging with its original captured scope, main command/view binding, safe save/retry/discard UI, the Library attach/pin/pruner callbacks and watcher/reconnect lifecycle. Those checkboxes remain open. W21 still needs to bind verified reuse/community publication to this owner-link path. Durable model/profile changes need an explicit future schema migration; incompatible journals are preserved rather than silently relabeled.

Windows private disk/ACL/mutex/watcher behavior, real authorized original/voice account round trips, actual offline restart/owner switching and playback-before-save acceptance remain W34. No real user media, account, R2 grant, enrollment, production permissions, deployment or Windows execution was used.

## Follow-up: durable submit capture and completion recovery (2026-10-09)

The authenticated private session dispatcher now supplies `captured_scope`; omission and Chrome remain permanently account-free. Personal null-scope jobs survive MusicMute account changes. Account jobs retain their immutable UID/generation in the DPAPI request journal and strict private completion receipt. Replays under another account/generation are refused. Idle proof is true only after actual runner stop, scratch cleanup and admission release; Ready/failed alone is insufficient.

`WindowsPersonalCompletionSource` / `PersonalCompletionProducer` recover final private pairs through exact hash-bound pins into the existing guest catalog. Automatic saving requires a current full-profile receipt and the original captured UID matching the authenticated current UID. `OutboxController.stageCaptured` explicitly authorizes same-UID new-generation resume while preserving the original journal generation. A null capture is permanently auto-save ineligible; explicit Save uses a newly authorized scope. Production OutboxMedia also checks the actual full-profile pair receipt before assigning model/recipe to upload. Legacy playback does not invent compatible save evidence.

`retentionUsage` sums unreleased original/voice bytes across all account partitions, including discarded cleanup failures. A fixed personal-results watcher root wakes completion recovery without polling HTTP. Root composition remains unchecked. Focused capture/reuse/outbox/control/transfer suites passed 90 tests / 14 files; current Desktop strict typecheck/build, 591 integrated code tests and scoped lint/format passed. See W21 evidence for coordinated receipts/adoption/publication source.
