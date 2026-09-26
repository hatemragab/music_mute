# MusicMute web client implementation handoff

Status: implementation merged in [PR #35](https://github.com/hatemragab/music_mute/pull/35)
and deployed on 2026-09-26; authenticated production journeys still require
test-identity proof. See `06-tasks.md` and `08-infrastructure.md`.
Prepared: 2026-09-26. Branch: `hatem/web-client`.
Base: freshly fetched `origin/main`, commit `2d4d8ba00dac212ea55a0f4e73e736a4e4a0b05e`.
Worktree: `/Users/hatemragap/.codex/worktrees/web-client/music_remover`.

## Start here

Read these files in order:

1. [Approved scope and boundaries](01-scope.md)
2. [Source inspection map](02-source-map.md)
3. [Backend web support](03-backend.md)
4. [UX and localization](04-ux.md)
5. [Imports, jobs, library and playback](05-media.md)
6. [Ordered implementation tasks](06-tasks.md)
7. [Validation and completion criteria](07-validation.md)
8. [Infrastructure facts and release boundaries](08-infrastructure.md)
9. [Ready-to-use next-agent prompt](NEXT_AGENT_PROMPT.md)

The user subsequently authorized implementation and deployment. The web client
and minimal backend web support are in this worktree, and both were deployed to
CapRover on 2026-09-26. At initial deployment no commit, push or PR had been
made. The source was later merged through PR #35 and the web image was updated
from the merged checkout. Android remains read-only. Check the latest ledger
entry for exact publication and release evidence.

Maintain the checklist in `06-tasks.md`. For each completed task record changed
files, exact checks and results, and unresolved limitations. Never mark a task
done using only a mock screen or an assumed production result. Continue through
implementation, review, and authorized local checks without repeated permission
questions for routine reversible work. Ask only when a material requirement or
external approval actually blocks progress.

The original checkout has unrelated uncommitted job-stage timing work. Another
locked worktree named `website-app` also existed at preparation time. Neither
was copied or modified. Do not merge, reset, stash, delete, or copy their work.
All commands for this task must explicitly use the worktree above.
