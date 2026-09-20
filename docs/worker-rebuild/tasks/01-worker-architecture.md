# Branch 1: codex/worker-architecture

**Kind:** documentation only. **Parent:** current accepted `origin/codex/worker-rebuild`. **PR base:** `codex/worker-rebuild`. **Checkpoints:** A1–A4.

## Assignment

Import and reconcile the completed documents in this package. Do not ask another model to invent the architecture again. This branch establishes the written contract for subsequent implementation; it does not build a proof of concept, install dependencies, edit runtime code, create database collections or modify application behavior.

Read [agent rules](../AGENT-RULES.md), [roadmap](../ROADMAP.md) and [source map](../REPO-STUDY-MAP.md). Read the seven supplied architecture documents in numerical order. The original Python reference is archival evidence only, not executable production work added by this branch.

## Existing files to study

Read `CONTRIBUTING.md`, `.gitignore`, the actual backend/dashboard package manifests and lockfiles, `backend/src/app.module.ts`, `backend/src/jobs/jobs.controller.ts`, `job.types.ts`, `job.schema.ts`, `job-state.ts`, the processing module/startup service, storage transfer/preflight services, and `dashboard/src/app/router.tsx`. Follow only the imports necessary to understand preserved contracts. See the source map for exact paths and inspected-versus-discovered distinctions.

The prepared baseline is `a786a1773a3c72fb09d1b02def1ae39330561892`. Record the actual current collection SHA. A different SHA is not permission to reset the branch; inspect the intervening changes and adapt references narrowly.

## A1. Establish the baseline and protect local credentials

Verify a clean working tree and correct repository. Inspect inherited automation before a push. Do not checkout/reset over the owner's changes. Confirm `origin/codex/worker-rebuild` exists and create only this assigned branch using the roadmap commands.

Before copying or staging anything, check whether `.local.env` is tracked. If tracked, stop and report without printing its contents. The current tracked ignore rules do not cover this filename. Protect it immediately through this checkout's `.git/info/exclude` as shown in the agent rules. This local safety measure is not a runtime implementation or a tracked `.gitignore` change. The tracked fix belongs to C1.

Confirm the committed package is present at `docs/worker-rebuild/` on the accepted collection tip. Reconcile it in place and stage explicit documentation paths only. No root `AGENTS.md` replacement, no global configuration changes and no broad `git add .`.

**Checkpoint evidence:** actual base SHA, clean-slate preservation, tracked-file scan result, ignore check result, intended changed-path list. Never attach environment contents.

## A2. Reconcile the supplied design with retained code

Review the finished documents rather than replacing them. Confirm these constraints in source:

- `audio_jobs` remains the public job record; success remains `ready`.
- Public request shapes, usage, history, deletion and notifications remain compatible.
- Media checksums are canonical base64; artifact digests are explicitly hexadecimal.
- Job lifecycle writes preserve revision middleware and explicit update operators.
- MongoDB replica-set sessions and private/versioned S3 preflight remain required.
- The new module, runtime, worker dashboard and protocols are absent implementation work, not surviving old components to revive.

If a documented filename was moved, update the study map to the resolved path. If a material contract conflict is found, record it and stop before coding; do not silently change product semantics. A small correction to a path or citation is ordinary documentation work.

**Checkpoint evidence:** compatibility checklist with source paths, any narrow documentation corrections, no executable behavior changes.

## A3. Freeze audio, policy, security and operational decisions

Review [audio design](../architecture/03-audio-pipelines.md) and [trimmer review](../reference/TRIMMER-REVIEW.md) against `reference/separate.py`.

Explicitly accept internal-gap removal, the default threshold/duration/padding/fades/PCM rounding, the all-silent fallback, and default trim-on/denoise-off behavior. Do not substitute edge-only trimming. Denoise is the documented optional FFmpeg preset, not an unspecified neural model. Both controls come from versioned dashboard policy; running jobs and automatic retries preserve their recipe.

Review the completed enrollment, lease, credential, manual package lifecycle, rollback, and test decisions. Automatic fleet rollout remains a post-MVP extension. Unknown package pins, Mac/RX 580 speed, SSH credentials, service-context GPU behavior, signing keys and production addresses remain validation inputs. Mark them unverified rather than filling them with plausible values.

**Checkpoint evidence:** decision checklist and unresolved validation inputs, not a hardware support claim.

## A4. Documentation verification and PR

Check relative links, Markdown fences, JSON syntax, 36 checkpoint coverage and archive reference checksum. Confirm production code, package manifests, lockfiles, service definitions and database state are unchanged. Documentation-only work does not require application builds.

Write `docs/worker-rebuild/evidence/A-architecture.md` using the checkpoint report template. Clearly state that GPU feasibility runs begin in branch B. Push the assigned branch and open its PR against `codex/worker-rebuild`, using the supplied PR template. Update an existing same-branch PR rather than creating duplicates.

**Exit:** the documentation package is reviewable and source-aligned. Stop for maintainer review and merge. Do not start B, create the collection branch again, or touch `main`.

## Out of scope

Executable GPU probes, new application tests, dependency installation/pinning, `.gitignore` edits, backend schema changes, worker implementation, dashboard code, service installation, publishing and deployment. The unchanged attached script may live under documentation as a reference; it must not be wired into builds or application imports.
