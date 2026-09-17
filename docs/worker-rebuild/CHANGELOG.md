# Package changes

## Revision 3.0

- Replaced the earlier eight-branch implementation plan with seven sequential branches after the existing collection: architecture, GPU feasibility, control plane, runtime, dashboard, integration, and release readiness.
- Moved real M4/CoreML and Z440/DirectML proof into its own GPU-feasibility branch before backend implementation.
- Combined supervisor, Python processing, platform packaging, installers, and service integration in `codex/worker-runtime`.
- Reduced the plan to 36 checkpoints and synchronized the roadmap, task files, manifest, runbooks, architecture references, validation metadata, and Git-flow fixture.
- Kept MVP release handling explicit and local: immutable packages, manual per-machine update, and independent rollback. Automatic fleet targeting, canary promotion, and rollout orchestration are post-MVP.
- Preserved all other accepted architecture decisions unless their documents explicitly mark them as proposals or validation inputs.

Prepared documents and consistency checks are not implementation acceptance. No worker implementation, deployment, merge, or hardware proof was performed by this documentation revision.

## Revision 2.0

**Historical and superseded by Revision 3.0.** The branch/checkpoint counts below describe the former package layout.

This package supersedes the earlier `musicmute-worker-branch-roadmap.md`.

- Existing `codex/worker-rebuild`, not the frozen clean-slate branch, is the first implementation branch's parent and all branch PRs' target.
- Agent may push its assigned branch and open/update the PR. Maintainer retains merge, deployment, publishing, and next-branch approval.
- The architecture branch contains supplied documentation, not GPU probe implementation. Actual probes move to checkpoint C1.
- Supplied `separate.py` establishes **internal-gap as well as edge trimming**. Preserve its thresholds, padding, fades, PCM quantization and all-silent behavior. Add an actual disable switch in the new worker.
- Initial recipe: Kim Vocal 2, trimming on, denoise off, voice-only 192 kbps MP3. Optional MVP denoise uses a versioned FFmpeg `afftdn` preset, subject to real voice-quality evaluation.
- Dashboard can enable/disable recipes and optional capabilities per machine and narrow eligibility per child worker. Policy changes never silently change an existing job's recipe.
- M4 is the first real test host; Z440 is tested over owner-supplied SSH later. Linux/NVIDIA paths remain unverified and release-disabled without real evidence.
- Local test database/Redis and scoped S3 use are authorized. Existing MongoDB replica-set and versioned-S3 safeguards remain intact.
- `.local.env` receives explicit ignore protection and a test-only loader; credentials never reach worker environments.
- The previous broad task descriptions are replaced by completed specifications, a source study map, eight detailed task files, 42 checkpoints, and operating runbooks.
- Checkpoints are verification/commit boundaries. The default human approval gate is the branch PR, keeping the process usable without dozens of unnecessary approval prompts.

Prepared documents and archive checks were not implementation acceptance. No source branch was modified while preparing that historical package revision.
