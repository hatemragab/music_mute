# Prompt for the next implementation agent

Implement the MusicMute end-user web client described in `web-client/tasks/`.
Work ONLY in `/Users/hatemragap/.codex/worktrees/web-client/music_remover`, branch
`hatem/web-client`. Read `web-client/tasks/README.md` and every linked task file
before coding, then repository/component instructions and the mapped source.
Verify branch/base/status and preserve all existing changes. Do not switch to or
copy uncommitted work from the original checkout or the other `website-app`
worktree. The recorded base is origin/main at
`2d4d8ba00dac212ea55a0f4e73e736a4e4a0b05e`; inspect drift before changing base and
never discard this handoff to update the branch.

The approved product is a responsive React/TypeScript/Vite web client using the
Android dark theme, accent picker, English and Arabic/RTL. Cover the Android
user journeys from auth through imports/jobs/library/player/settings/account to
logout. URL imports and local AUDIO uploads only. No local video, offline mode,
PWA, or offline media library. Put the full frontend, tests and packaging in
`web-client/`. Minimal proper backend web-platform support and related contracts,
tests/docs are explicitly approved; Android/iOS/dashboard/worker changes are not.

Create the source-backed parity matrix first, then execute the ordered checklist
in `06-tasks.md`, updating it with real evidence. Implement genuine web sessions
and processing access; do not fake an Android installation. Inspect native
platform policy indexing and downstream consumers before widening platform enums.
Use the Zalando API skill before backend contract edits. Reuse existing patterns,
keep dependencies modest, and implement meaningful security/error tests.

The user has already answered the product questions. Resolve ordinary technical
choices yourself and continue until all authorized local implementation and
verification is complete. Do not ask again about backend approval, languages,
offline scope or media scope. Do not launch new chats or automations merely to
track these tasks. Keep progress updates concise and report concrete blockers.

Use existing installed desktop Chrome for browser checks. For any simulator UI
test, use only iPhone 17 Pro/iOS 26.0 UDID
`3CC14436-EC3C-4419-A079-C84951E5FA07`; report unavailability instead of substituting.
Never claim mocked checks prove production. Read `08-infrastructure.md` for
already verified Firebase/API/S3 settings and remaining hosting work.

Do not commit, push, publish, deploy, delete real data, expose credentials, or
change production permissions without separate authorization. Deliver a working,
locally verified implementation, its task ledger/parity matrix, main changed
files, commands actually run, screenshots and remaining release limitations.
