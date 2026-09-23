# 14 — Evaluate alternative GPU models and runtimes for speed and vocal quality

**Status:** Bounded research complete; keep the measured Kim Vocal 2 MPS path.
Alternative runtime/model paths were not qualified or adopted. **Depends on:** 13;
compares against 08–12 evidence.
Read [shared rules](EXECUTION-RULES.md) and [measurement protocol](VALIDATION.md).

## Objective and scope

Determine whether a different compatible GPU runtime or model offers a better
speed/quality tradeoff than the measured Kim Vocal 2 path. This is a bounded
research task with optional isolated prototypes, not a requirement to replace a
working model. Keep runtime-only comparisons separate from model changes.

Read `worker/engine/musicmute_engine/provider_adapter.py`, `separator.py`,
`artifacts.py`, `recipes.py`, `qualification.py`, pinned dependency locks and
`tools/worker-gpu-feasibility/README.md`. Use current official model-owner/runtime
documentation and source for candidate claims; record exact URLs, versions and dates.

## Required work

1. Build a shortlist, initially at most two viable candidates. Evaluate model
   availability, license/distribution terms, supported Apple GPU execution,
   conversion/operator support, memory, maintenance, download size and packaging.
   Reject CPU-only or unprovable GPU paths before benchmarking.
2. Prefer testing the same model under another supported GPU execution route before
   attributing gains to a different model. A CoreML/other route is only a candidate
   if actual model/operator/device support is verified, not assumed from branding.
3. Source weights directly from reviewed owners, with expected bytes/hash and safe
   redirects. Do not upload weights to project S3, download untrusted serialized
   code, modify system packages globally, or use cloud GPU services without scope.
4. Build task-owned isolated prototypes using one active job per GPU and identical
   full-length input. Keep original source quality and comparable output encoding.
   Record cold/warm timing, stage timing, GPU memory, actual provider evidence,
   conversion/startup cost and packaging implications.
5. Compare vocals on quiet speech, heavy music, transients, boundaries and relevant
   languages/voice styles present in authorized fixtures. Use reference-stem metrics
   only if suitable reference stems exist; otherwise report objective validity and
   listening evidence honestly.
6. Recommend keep-current, candidate-for-further-review, or adoptable-candidate with
   explicit evidence. Do not silently switch the default recipe in a research task.
   If conversion/grouping is still blocked, report the precise limitation.

## Validation and acceptance

Deliver a sourced comparison matrix and reproducible reports using task 07 tooling
where compatible. Run meaningful adapter/protocol tests for any prototype. Record
failed/inconclusive candidates and listening status. Any recommended switch needs
repeatable benefit, preserved quality, acceptable memory and maintainable packaging.
An evidence-backed recommendation to keep the current model completes this research.

## Handoff

Give task 15 the comparison report, exact tested identities, default configuration
remaining in use, and any adoption decision requiring user review. Keep experimental
dependencies isolated or remove only task-owned unsuccessful changes.

## Sourced evaluation — 2026-09-23

The current worker uses the exact 66,759,214-byte `Kim_Vocal_2.onnx` with
SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`,
downloaded directly from the [UVR model-owner release](https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models).
The macOS adapter converts this ONNX graph to PyTorch and executes it on MPS,
following [UVR's published Apple GPU path](https://github.com/Anjok07/ultimatevocalremovergui/releases).
The local full-song report proves accelerated MPS dispatch with no CPU node
events in that qualification, and a 10.3238-second first-session median warm
engine pass (8.6490 seconds separation). Grouping two windows lowered the
observed warm engine median to 9.6106 seconds, pending listening approval.
These are local M4 Pro measurements, not a general model ranking.

| Candidate | Owner/runtime evidence | GPU-only and packaging gate | Outcome |
| --- | --- | --- | --- |
| Same Kim model via ONNX Runtime CoreML EP | [CoreML EP documentation](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html) says macOS builds can expose CoreML, while dynamic shapes can hurt performance. [ORT architecture](https://onnxruntime.ai/docs/reference/high-level-design.html) allows unsupported graph partitions to fall back to another provider. | The current pinned macOS path is PyTorch MPS; a different isolated ORT package and complete graph/operator/partition profile would be required. The Kim model has a dynamic batch dimension. Neither zero CPU fallback nor faster full-song GPU execution has been demonstrated for this exact graph. | Research candidate only. Do not switch or benchmark an unverified mixed-provider path as GPU-only. |
| MVSEP MDX23 model family | The [model author's repository](https://github.com/ZFTurbo/MVSEP-MDX23-music-separation-model) describes four-stem/ensemble processing, a vocals-only mode and a single-ONNX option that trades some quality for memory. Its fast multi-model mode documents more than 11 GB available GPU memory. [UVR's macOS release notes](https://github.com/Anjok07/ultimatevocalremovergui/releases) say MPS supports MDX-Net models generally. | A specific owner-approved checkpoint, exact bytes/hash, configuration, Apple MPS dispatch proof, full-song memory/timing and listening comparison are missing. The published contest quality scores are on another dataset and cannot predict this song's vocal quality or speed. | Not qualified for this worker. No weights downloaded or recipe changed. |

The current UVR-compatible model remains the only candidate with a verified
owner source, locked identity, this host's GPU dispatch proof, reproducible warm
timing, and decoded output comparison. The alternative runtime has a plausible
conversion/fallback and maintenance cost; the other model changes both quality
and resource requirements. No CPU inference benchmark, cloud GPU service,
third-party weight mirror, or model rehosting was used. There was no candidate
prototype because neither alternative passed the exact GPU-only and model
identity gates. No relative speed or quality claim is assigned to either.

Task 15 should keep the current Kim recipe and one GPU slot per job. The only
performance option with local evidence is two-window MPS grouping; it must stay
behind the current default until the retained vocal comparison receives a
listening review. CoreML or MDX23 would need a separate, fully specified owner
artifact and isolated qualification before reconsideration.
