# Branch 7: codex/worker-release-readiness

**Parent:** accepted `codex/worker-integration` synchronized to collection. **PR base:** `codex/worker-rebuild`. **Checkpoints:** G1–G5.

## Assignment

Turn the accepted MVP into a reviewable release candidate without adding post-MVP fleet automation. Finalize versioned packages, manual install/update/rollback procedures, security and license evidence, compatibility windows, and the final release decision.

## G1. Freeze scope and candidate

Freeze supported platforms/providers, model/recipe versions, protocol range, backend/dashboard/runtime commits, database/index changes, artifacts, and known limitations. Re-run component verification against the exact candidate.

## G2. Versioned packaging and manual lifecycle

Produce immutable platform bundles with hashes, manifests, constrained extraction, final paths, health checks, and a preserved known-good version. Validate fresh install, repair, manual update, and manual rollback without mutating the active environment in place.

Automatic dashboard-selected rollout, fleet drain orchestration, signed remote downgrade, and fleet-coordinated rollback are post-MVP. The MVP local launcher must still recover automatically to its known-good version when a manually activated candidate fails. The layout and compatibility contract must leave room for later fleet automation.

## G3. Security, privacy and licenses

Scan tracked files and deliverables for secrets, private audio, local paths, generated environments, unsafe permissions, traversal, and untrusted command execution. Verify machine credential handling, S3 grant scope, log redaction, and backend authorization.

Record redistribution/commercial constraints separately for the model weights, separator integration, ONNX Runtime/providers, FFmpeg/codecs, service wrapper, and bundled runtimes. An unresolved license blocks distribution of the affected artifact.

## G4. Final real-hardware acceptance

Run the exact candidate on each declared MVP platform. Confirm accelerated Kim inference, the accepted recipes, direct S3 flow, one active job per validated worker slot, background service operation, restart recovery, and manual rollback. Missing hardware access remains `BLOCKED` or changes declared scope; it is never silently accepted.

## G5. Release evidence and handoff

Complete checkpoint reports, operator installation/recovery instructions, data/index plan, feature-flag rollout, rollback steps, CI trigger review, artifact digests, residual risks, and the final PR summary. Keep deployment, publication, feature enablement, and merge to `main` as separate explicit owner actions.

**Exit:** release-readiness report and reviewed PR into `codex/worker-rebuild`. Stop. Do not deploy, publish, or merge to `main` without a new instruction.
