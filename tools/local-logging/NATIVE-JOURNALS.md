# Trusted MusicMute Local journals

The collector can observe the already installed app without changing its release
logging controls. This is a Vector file source over the application's existing,
allowlisted local journals. It never enables release HTTP/realtime payload
capture, modifies native registration, touches media/model/runtime files, or
writes/rotates/truncates the journals.

Only the current user's fixed private directory is considered:
`~/Library/Application Support/MusicMuteLocal/logs/`.

| Journal                                                                                    | Existing owner                             | Retained observation                                                                   |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `ui-events.jsonl`, existing `ui-events.jsonl.1`                                            | Swift app shell                            | `macos`, component `app-ui`                                                            |
| `events.jsonl`, existing `events.1.jsonl` through `events.3.jsonl`                         | Node companion                             | `chrome-extension` when the companion records component `extension`; otherwise `macos` |
| `desktop/events.jsonl`, existing `desktop/events.1.jsonl` through `desktop/events.3.jsonl` | Native desktop processing/playback service | `macos`, provenance `macos_desktop`                                                    |
| `setup/events.jsonl`, existing `setup/events.1.jsonl` through `setup/events.3.jsonl`       | Native app setup service                   | `macos`, provenance `macos_setup`                                                      |

Discovery rejects symlinked parents/leaves, nonprivate log directories/files,
foreign ownership, multiple links, nonregular leaves and files beyond their
producer limits (512 KiB UI; 5 MiB companion segments). HTTP/MCP callers cannot
select paths. Tests inject owned temporary paths through an internal collector
option; normal startup always discovers the fixed application paths.

Every event has `origin: native_journal` and `category: native_journal`.
`data.journal` identifies the exact fixed journal namespace. Desktop/setup
subdirectories undergo the same owner/privacy/symlink validation as the log root.
`native_journal.<event>` retains approved producer event names, approved diagnostic
codes, UI commands, numeric/boolean metrics and approved stages. Original UTC
`at`/`recorded_at`, random process `session_id` as `instanceId`, sequence, UUID
request/job IDs and observed duration are preserved when valid. Unknown fields,
raw errors/stacks, paths, URLs, user/account information, media metadata and
credentials are omitted before the authoritative capture. Unknown codes become
`UNKNOWN_ERROR` with explicit omission metadata. Invalid records produce a bounded
metadata warning; they never copy arbitrary source text. The fixed inventory is
mirrored from the producer schemas and checked by tests.

Identified desktop optional-operation warnings preserve a closed operation name,
`phase: failed`, `result: failed`, validated HTTP error status (400–599) and an
existing UUID request ID. These top-level fields remain available to ordinary
MCP metadata queries without payload access. A failed optional account lookup or
staging observation does not mean the overall local processing job failed.
Historical unscoped `UNKNOWN_ERROR` warnings remain unscoped; their causes cannot
be recovered from nearby events.

An exact `job_cancelled` event has `phase/result: cancelled`; an exact `job_ready`
has `phase: completed` and `result: success`. User cancellation is not a failed
operation. Identified optional-operation warnings with exact code `CANCELLED`
also retain cancelled phase/result and their warning severity; this does not
classify the overall processing job as failed. Process exit observations do not
establish application delivery.

`chrome-extension` records from this source are **companion observations of
extension diagnostics**. They do not prove that an extension received a backend
publication or processed a message. A native journal and a debug emitter can
observe the same action separately; their distinct origins are retained rather
than merged by nearby timestamps.

Vector uses checksum fingerprints, persistent checkpoints, bounded reads and the
producer's known rotation names. New sources start at EOF (`read_from: end`), so
history before first source attachment is intentionally unavailable. Previously
checkpointed files resume after collector downtime. As with other `read_from:
end` sources, the initial contents of an entirely new, previously undiscovered
file are skipped; journal-owner rotation and very short-lived processes remain
best-effort coverage. No journal is retired by the logging command.

`journalSources` and `missingJournalSources` in collector health describe startup
discovery. Restart only the owned collector after enabling this source or after
an initially missing journal appears. The running application and its services
need no restart. Source coverage requires a new application event to reach
`events.jsonl`; process presence or a successful configuration validation alone
is insufficient proof.

Validation: `node --test tools/local-logging/native-journals.test.mjs` exercises
private-path checks, mirrored code inventory and the actual pinned Vector
normalizer, redaction, first-attachment history exclusion, checkpoint recovery
and a real read-only MCP SDK metadata query against an isolated fixture capture.
Build/install `tools/logs-mcp` before running this integration test.
The source behavior follows the official [Vector file-source documentation](https://vector.dev/docs/reference/configuration/sources/file/).
