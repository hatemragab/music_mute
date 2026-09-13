# Execution ledger — media input and fair queue

Plan: `docs/superpowers/plans/2026-09-13-media-input-and-queue.md`.

User approved implementation of all tasks and API/dashboard CapRover deployment on 2026-09-13. This supersedes the plan's planning-only/deployment-not-authorized status, but does not authorize destructive infrastructure changes, Git publication, or additional device targets.

## Rulings

- Work directly in the current repository on `codex/media-input-fair-queue`, honoring the user's existing repository instruction; retain the uncommitted approved plan. No commits or Git pushes without a separate request.
- Use domain-owned subagents under the executing/subagent-development skills. Backend owns shared wire contracts; native clients can develop from the approved contract while backend implementation proceeds, but integration is gated on backend read-back and tests. Parent owns worker/fixtures/deployment and cross-component review. No overlapping source ownership.
- Model missing hardware evidence explicitly. Complete safe implementation and deploy only compatible behavior; do not fabricate benchmark results or enable 30-minute processing on workers that cannot handle it.
- Keep a durable progress record here instead of deleting the plan workspace. Source changes and deployment evidence must remain reviewable without commits.
- User subsequently brought the Z440 online and explicitly authorized its worker update over SSH. After initial key authentication failed, user-supplied password authentication succeeded. Worker update and live capability verification are complete; physical benchmark qualification remains outstanding.

## Preflight review

| Boundary | Review ruling |
| --- | --- |
| B01–B06 share backend policy, admission, lifecycle | One backend owner implements sequentially and owns contract decisions. |
| A01–A04 share Android preparer/coordinator/UI | One Android owner; source-only and local JVM/build validation under current device restrictions. |
| I01–I04 share iOS preparer/coordinator/UI | One iOS owner; only designated existing simulator. |
| B05 and W01/W02 share assignment/measurement protocol | Backend owner publishes exact wire shape to parent before worker integration. |
| B06 and D01–D03 share admin API contracts | Dashboard waits for backend fixture/contract handoff. |
| R01 and native tasks share media support evidence | Generate synthetic fixtures; native adapters report actual measured support without substituting devices. |
| R02 and queue enablement share hardware evidence | Benchmark only on authorized idle environment; unknown evidence cannot authorize worker capacity. |
| All tasks versus deployment boundary | User authorizes API/dashboard CapRover updates and subsequently explicitly authorizes the Z440 SSH worker update. |

## Status

| Tasks | State |
| --- | --- |
| R01/R02 | In progress: baseline/fixture/worker evidence discovery |
| B01–B06 | Implemented and deployed as API v35, including independently tested maintenance CAS correction |
| A01–A04 | Implemented; both flavor tests/lint/build pass; native device qualification outstanding |
| I01–I04 | Implemented; 156 unit tests and eight offline UI scenarios pass on designated simulator; two live tests skipped |
| W01/W02 | Implemented and independently reviewed; 161 tests pass with 17 platform skips, 11 separator parity/integration tests pass |
| D01–D03 | Implemented; 55 unit tests, 36 full browser tests, subsequent targeted/compiled contract tests and production build pass |
| V01/V02 | Focused automated/native simulator and production read-back evidence complete; physical media/throughput qualification remains outstanding |
| API/dashboard deployment | API v35 and dashboard v5 live; health and new policy/settings read-back verified |
| Z440 deployment | Updated over SSH; source hashes and protected-file preservation verified, 157 Windows tests passed with two skips, DirectML/FFmpeg checks passed; scheduled task Running and backend reports fresh expanded-media v2 capability |

Domain validation and known limitations are recorded under `evidence/`. Expanded 30-minute intake remains disabled pending physical qualification. Native device proof is limited to the designated iOS simulator. Z440 retains its existing 30,000,000-byte output cap and 7200-second timeout; these must be included in measured qualification before expanded activation.
