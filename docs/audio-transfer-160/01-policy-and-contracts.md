# 01 — Define bitrate policy and contract cases

**Status: implemented locally.** Dependency: review the package
[README](README.md). Own the policy specification and shared contract decisions.

## Purpose and source entry points

Remove disagreement between mobile preparation, backend policy and worker output
before changing runtime behavior. Read these existing paths first:

- `backend/src/admin-settings/account-policy.service.ts`
- `android/app/src/main/java/com/hatem/musicmute/processing/ProcessingMediaPolicy.kt`
- `ios/Vocal/Processing/ProcessingMediaPolicy.swift`
- `backend/src/jobs/worker-recipes.ts`
- `backend/src/worker-fleet/protocol/v1/protocol.ts`
- `worker/src/runtime/contracts.ts` and `worker/engine/musicmute_engine/recipes.py`

## Planned work

1. Define the shared units and semantics: 160,000 bits/s audio target, 50,000,000
   upload bytes, source versus prepared audio rate, declared versus observed
   values, and unknown rate. Do not confuse sample rate with bitrate or use total
   video bitrate as audio bitrate.
2. Write cases for 64/96/128/160 kbps copy or extraction; 192/256/320 kbps single
   encode to 160; WAV/lossless encoding to 160; incompatible compressed input
   encoded at no higher than its known lower rate; and malformed/unknown input.
3. Decide which already-supported compressed containers can pass through on both
   mobile and worker. If a codec is incompatible, remux where possible before
   considering an encode. Do not promise support for every possible audio codec.
4. Identify metadata already carried by the local source inspector, server import result,
   prepared-input result, API and worker probe. Reuse it; add only fields needed
   for policy and diagnostics. Treat client rate declarations as hints, not proof.
   Do not add database persistence merely to carry an encode decision locally.
5. Resolve the README's unknown-rate and very-low-MP3-rate decisions with the
   user before implementing those paths. Cover VBR average versus nominal rate,
   encoder tolerance and discrete MP3 rates. For example, a measured 138 kbps
   source may require a 128 kbps MP3 target rather than a nonexistent 138 kbps CBR
   setting. Document the resulting quality tradeoff.
6. Choose explicit recipe/profile identifiers for the new policy and update the
   complete producer/validator/consumer inventory, including strict mobile policy
   readers, worker runtime and any dashboard recipe display. No old/new shims.

## Acceptance and handoff

- One reviewed decision table governs Android, iOS, backend and worker, including
  zero/negative/missing rate, unsupported codec, multiple audio tracks and VBR.
- Shared contract changes have named consumers and tests; recipe identifiers are
  never changed on only one side of the protocol.
- Known lower-rate input is never automatically raised to 160 kbps. Unknown rate
  is explicitly unknown, with the approved fallback recorded.
- The handoff includes policy examples, source pointers, any unresolved choice,
  and the exact files owned by subsequent tasks. This task does not add a new
  media pipeline or an independent bitrate-inspection stage.
