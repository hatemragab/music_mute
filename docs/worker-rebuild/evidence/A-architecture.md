# Checkpoint evidence report: A — architecture

## Identity

- Assigned branch: `codex/worker-architecture`
- Parent and accepted collection SHA: `ec03f5e21b489d600f267727d0d3a3eaf0811d7d`
- Historical source baseline recorded by the package: `a786a1773a3c72fb09d1b02def1ae39330561892`
- Source-code changes between those SHAs under `backend/src`, `dashboard/src`, and their package manifests: none
- Environment class: local repository inspection on macOS; documentation-only work
- Hardware/provider evidence: `NOT_RUN` by design in A; begins in B

## A1 — baseline and credential safety: PASS

- Confirmed `codex/worker-architecture` was created from the exact pushed `origin/codex/worker-rebuild` tip.
- Confirmed `origin/codex/worker-clean-slate` remains at `a786a1773a3c72fb09d1b02def1ae39330561892`.
- `git ls-files -- .local.env backend/.local.env` returned no tracked secret file.
- Added only local Git exclusions for `.local.env` and `backend/.local.env`; no environment values were read or printed.
- Unrelated local files `bundled-yt-dlp`, `old-extractor-test.webm`, and `youtube-diagnostic.webm` remain untracked and outside this branch's intended change list.
- Repository push-trigger inspection found no tracked GitHub Actions workflow; this does not authorize deployment or publication.

## A2 — retained contract reconciliation: PASS

| Contract | Current source evidence | Result |
| --- | --- | --- |
| Public job record | `backend/src/jobs/job.schema.ts` still uses strict collection `audio_jobs`; `backend/src/jobs/job.types.ts` retains the lowercase public statuses and `ready` success | Preserved |
| Public job surface | `backend/src/jobs/jobs.controller.ts` retains list, detail, download, rename, cancel, delete, create, retry, upload URL, and upload completion routes; new submission paths still reject through `ProcessingUnavailableService` | Preserved clean-slate boundary |
| History/account/usage/notifications | `backend/src/processing/processing.module.ts` retains query, actions, deletion, usage, notification, registration, maintenance, and cleanup services | Preserved |
| Media identity | `ObjectIdentity` remains `{key, versionId, bytes, sha256, contentType}`; `isSha256` enforces canonical base64 while worker model/release documents explicitly use hexadecimal digests | Preserved |
| Revision safety | `backend/src/jobs/job.schema.ts` keeps `revision`/`adminRevision`, rejects pipeline-style lifecycle updates, and increments administrative revision for visible conditional updates | Preserved |
| MongoDB safety | processing startup still requires session/transaction capability when processing is enabled, and registered models initialize before maintenance proceeds | Preserved |
| S3 safety | storage transfer code verifies exact `VersionId`, size, type, and `ChecksumSHA256`; preflight requires versioning, private policy/ACL, all public-access blocks, and restricted lifecycle behavior | Preserved |
| Worker clean slate | No worker/fleet route, module, controller, service, or dashboard feature exists; `processing.module.spec.ts` explicitly asserts no provider with a `Worker` name remains | Preserved |
| Dashboard foundation | Existing protected jobs, settings, health, audit, and mobile-release pages remain available through permission guards; no worker dashboard route exists | Preserved |

The only source-adjacent documentation mismatch found was stale root backend npm guidance. `README.md` and `CONTRIBUTING.md` now follow the backend manifest and lockfile by using pnpm; dashboard npm instructions remain unchanged.

## A3 — architecture decisions and validation inputs: PASS

Accepted for implementation:

- backend → enrolled machine → one supervisor → stable GPU worker slots;
- MongoDB as durable authority, Redis/WebSocket as transient acceleration, and HTTPS reconciliation as authoritative;
- renewable leased attempts with session/incarnation fencing, bounded retries, and no cross-machine resume;
- direct exact-version S3 transfers with backend-issued narrow grants and conditional finalization;
- Kim Vocal 2 with the documented preparation order, internal-gap trimming semantics, optional approved denoise, immutable recipe snapshots, and voice-only MP3 output;
- initial hardware proof targets Mac mini M4/CoreML and Windows Z440/RX 580/DirectML;
- installation and platform services in D, manual versioned update/local rollback in G, and automatic fleet rollout after MVP.

Still unverified and never inferred in A:

- compatible ONNX Runtime/provider/package pins and the model artifact digest;
- real CoreML and DirectML dispatch, memory use, output validity, and performance;
- Z440 SSH target/authentication/host-key details;
- background-service GPU behavior, logout/reboot behavior, final artifact URLs, signing keys, and production addresses;
- redistribution/commercial terms for every packaged runtime, model, FFmpeg codec, and service wrapper.

## A4 — documentation verification and handoff: PASS

Validation performed:

- package JSON parsing, relative Markdown links, fenced-code balance, task/manifest/roadmap checkpoint alignment, archival `separate.py` digest, and active-obsolete-reference scan;
- SHA-256 verification for every package file listed by `SHA256SUMS`;
- staged-diff whitespace and secret-pattern review before commit;
- source reconciliation searches limited to the documented backend/dashboard paths and necessary imports.

Application builds and runtime tests were not run because A changes documentation only. No database, Redis, S3, GPU, service, SSH, deployment, publication, or production operation was performed.

## Handoff

- A1: `PASS`
- A2: `PASS`
- A3: `PASS`
- A4: `PASS`
- Next branch after maintainer merge/acceptance: `codex/worker-gpu-feasibility`
- Next branch is not authorized by this report alone.
