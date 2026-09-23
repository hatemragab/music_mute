# 03 — Update worker output and CLI diagnostics

**Status: implemented locally; GPU timing and listening pending.** Depends on tasks 01–02. Own worker
media handling, recipe/runtime agreement and existing CLI diagnostic fields.

## Source entry points

- `worker/engine/musicmute_engine/media.py`, `pipeline.py` and `recipes.py`
- `worker/engine/tests/test_media_limits.py`, `test_pipeline.py` and `test_recipes.py`
- `worker/src/runtime/contracts.ts`, `worker-runtime.ts` and `control-plane-client.ts`
- `worker/src/platform/macos/performance-report.ts` and existing job diagnostics
- `backend/src/jobs/worker-recipes.ts` and corresponding recipe tests

## Planned work

1. Extend the existing bounded `probe_audio` request to read useful audio-stream
   bitrate metadata together with its current duration/channel/sample-rate data.
   Avoid another process invocation, full-file scan or decode merely for bitrate.
   Never use a video's total container bitrate as the audio rate.
2. Preserve the source/prepared rate needed for output selection before decoding
   to PCM. The PCM bitrate is not the compressed input bitrate and must never
   determine final MP3 bitrate. Validate any mobile hints against available
   observed media evidence; use task 01's explicit unknown fallback.
3. Decode once through the current worker flow, keep existing GPU separation,
   and encode the final vocals once. Replace the fixed 192 kbps MP3 target with
   the reviewed selection at or below 160 kbps and at or below a known lower
   input rate. Validate encoder-supported bitrate/sample-rate combinations.
4. Update recipe step identifiers, engine validation, runtime contracts,
   fixtures, qualification/benchmark assumptions and backend recipe definitions
   together. Check all references to the old 192 kbps step; preserve historical
   reports as historical. Prevent `recipe.stepIds[...] is invalid` mismatches.
5. Expose source/prepared bitrate when known, selected output target, actual
   output bytes, metadata confidence and existing encode/probe timings through
   current job/performance diagnostics. No extra CLI command family, repeated
   expensive probe, new logging service or unsolicited private media metadata.

## Acceptance and validation

- Known 64/96/128/160 kbps inputs use the approved lower/equal output targets;
  higher-rate and lossless inputs select 160. Test unknown, corrupt, multi-stream
  and VBR metadata plus unsupported encoder-rate combinations.
- A mocked invocation-count test proves bitrate reading adds no second probe or
  decode. Assert encoding arguments and decoded duration/channel integrity;
  allow MP3 container overhead when comparing file sizes and measured bitrate.
- Existing cancellation, timeout, size, cleanup and error diagnostics still work.
- Run focused Python engine/TypeScript tests, protocol check and required worker
  verification (`pnpm run verify` from `worker/`). Real separation validation uses
  the GPU only, one job and one window; no new model/window experiment.
- Handoff: exact policy and recipe identity, observed rates/bytes/timings,
  focused test results, and audio artifacts for later listening. Valid MP3 output
  alone is not evidence that vocal quality is acceptable.
