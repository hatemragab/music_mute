# Sources and verification boundaries

Prepared September 17, 2026. Repository access was read-only through the connected GitHub app. External technical documentation was checked separately. No source here proves that the future implementation or the owner's GPU/service installation works.

## Maintainer-provided sources

**U1:** This conversation establishes the accepted product, Git permissions, private NestJS VPS, machine/worker hierarchy, M4 and RX 580 hosts, future SSH input, `.local.env` plan, pipeline controls and main-branch freeze.

**U2:** [Attached separate.py](separate.py), unchanged SHA-256 `b376a185d24811560fbc6cc681542517e61130a6d737077360ace5f502a32f1d`. The [review](TRIMMER-REVIEW.md) identifies exact lines and distinguishes additions from source behavior.

The older roadmap was an input to the revision. This package's ROADMAP is authoritative for this handoff; do not run both roadmaps in parallel.

## Repository snapshot

Repository: `hatemragab/music_mute`.

Inspected collection branch: `codex/worker-rebuild`.

Verified branch-list result: rebuild and clean-slate both pointed to `a786a1773a3c72fb09d1b02def1ae39330561892`. Reads of substantive files below were pinned to this commit. Recheck the actual base before implementing; branches can move.

A directory/import discovery establishes a path, not the file's detailed behavior. See the [study map](../REPO-STUDY-MAP.md) for that distinction. `CONTRIBUTING.md`, README and package manifests were also available from the preceding read of the same clean-slate baseline; detailed source behaviors below were directly inspected for this package.

| ID | Primary repository material | What it supports |
| --- | --- | --- |
| R1 | [branches](https://github.com/hatemragab/music_mute/branches), [CONTRIBUTING.md](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/CONTRIBUTING.md) | Baseline names, component-local workflow, evidence and deployment limits |
| R2 | [.gitignore](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/.gitignore), [environment.ts](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/backend/src/config/environment.ts), [environment.module.ts](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/backend/src/config/environment.module.ts) | `.local.env` is not covered by `.env.*`; current loader chooses `.env.local`/test/production |
| R3 | [jobs.controller.ts](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/backend/src/jobs/jobs.controller.ts), [job.types.ts](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/backend/src/jobs/job.types.ts), [processing.module.ts](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/backend/src/processing/processing.module.ts) | Retained public status/contracts, unavailable new submissions, surviving history/account components |
| R4 | [job.schema.ts](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/backend/src/jobs/job.schema.ts), [processing-persistence.module.ts](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/backend/src/processing/processing-persistence.module.ts) | `audio_jobs`, strict schema, revision middleware, explicit update operators, retained models |
| R5 | [storage-transfers.service.ts](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/backend/src/storage/storage-transfers.service.ts) | Pinned versions, checksum/HEAD validation and exact-key cleanup |
| R6 | [storage-preflight.service.ts](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/backend/src/storage/storage-preflight.service.ts) | Private versioned bucket requirements and lifecycle-policy restrictions |
| R7 | [job-state.ts](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/backend/src/jobs/job-state.ts) | Canonical base64 media checksum and current input/admission validation |
| R8 | [processing-startup.service.ts](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/backend/src/processing/processing-startup.service.ts) | Writable replica set with sessions and storage preflight when enabled |
| R9 | [dashboard router](https://github.com/hatemragab/music_mute/blob/a786a1773a3c72fb09d1b02def1ae39330561892/dashboard/src/app/router.tsx) | Existing lazy routes, permission boundaries, job/settings/mobile-release features |

The old README-linked `backend/docs/api/audio-processing.md` was not available at the inspected baseline. No content from that missing file has been invented. Source controllers/types take precedence for this package.

## External primary documentation

These support implementation constraints, not blanket hardware compatibility. Re-verify exact package/provider options when pinning a release.

| ID | Primary source | Use in this package |
| --- | --- | --- |
| T1 | [ONNX Runtime CoreML provider](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html) | Apple ONNX path; compute-unit selection and compute-plan profiling; provider presence alone is insufficient |
| T2 | [ONNX Runtime DirectML provider](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html) | DirectML configuration and concurrent-session constraints |
| T3 | [NestJS WebSocket adapters](https://docs.nestjs.com/websockets/adapter) | Native WsAdapter rather than a custom transport server |
| T4 | [ONNX Runtime ROCm provider status](https://onnxruntime.ai/docs/execution-providers/ROCm-ExecutionProvider.html), [MIGraphX provider](https://onnxruntime.ai/docs/execution-providers/MIGraphX-ExecutionProvider.html) | Old ROCm provider removal from 1.23 and current AMD Linux integration direction |
| T5 | [Amazon S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) | Temporary bearer access, headers/checksums, expiry and reuse; not one-time transaction locks |
| T6 | [MongoDB atomicity and transactions](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/) | Conditional single-document ownership writes and transactions for multi-document consistency |
| T7 | [FFmpeg afftdn](https://ffmpeg.org/ffmpeg-filters.html#afftdn), [FFmpeg arnndn](https://ffmpeg.org/ffmpeg-filters.html#arnndn) | Actual denoise options; the chosen fixed FFT preset avoids a separate speech-model dependency |
| T8 | [MongoDB TTL indexes](https://www.mongodb.com/docs/manual/core/index-ttl/) | Asynchronous retention cleanup, not precise lease expiry scheduling |
| T9 | [The Update Framework specification](https://theupdateframework.github.io/specification/latest/) | Authenticated metadata, hashes, freshness and rollback threats; the MVP is not a claim of full TUF compliance |
| T10 | [git merge](https://git-scm.com/docs/git-merge), [GitHub CLI PR create](https://cli.github.com/manual/gh_pr_create) | Explicit merge/fast-forward rules and PR base selection |
| T11 | [python-audio-separator upstream](https://github.com/nomadkaraoke/python-audio-separator) | Separation integration to evaluate and pin; no assumption that all architectures/backends work |

Runtime source checks and package documentation should be recorded with the exact chosen version in B. GitHub repository references above are the user's connected content; external library documentation is outside research. Recommendation defaults such as 20-second renewals, 90-second leases, one initial child, the afftdn preset and rollout budgets are design choices, not performance measurements.

## Evidence generated here

The original package preparation executed the trimmer's eight synthetic cases,
archive consistency checks and an isolated dummy Git workflow test. The later B
feasibility branch also ran the real Kim model and owned fixture on M4/CoreML and
Z440 RX 580/DirectML. See [package validation](../validation/PACKAGE-VALIDATION.md).
No service testing, live S3, npm publication or production deployment occurred.
