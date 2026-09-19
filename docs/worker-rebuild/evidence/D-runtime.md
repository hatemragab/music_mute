# D runtime evidence

Observed 2026-09-19 in Africa/Cairo on `codex/worker-runtime`, created from the
accepted control-plane collection commit
`1cd22912dd93363b45f556951555c16d9ba6e796`. The D1 local environment was
Darwin 25.6 ARM64 with Node.js 24.18.0, pnpm 10.14.0 and Python 3.14.4.

## Checkpoint status

| Checkpoint | Status | Evidence |
| --- | --- | --- |
| D1 supervisor and child protocol | PASS | Standalone worker package, generated backend protocol copy, bounded framed TypeScript/Python IPC, lifecycle/timeouts/cancellation and focused verification. |
| D2 versioned Kim recipes | PASS | Four immutable recipes, model/media validation, safe ordered pipeline, reference trimmer parity, real FFmpeg option coverage and a real framed M4/CoreML Kim-to-MP3 run. |
| D3 runtime ownership and recovery | NOT_RUN | No backend polling, claims, leases or S3 execution is claimed by D1. |
| D4 Mac service | NOT_RUN | No LaunchDaemon was installed or tested. |
| D5 Windows service | NOT_RUN | No Windows service was installed or tested. |
| D6 safety and adapters | NOT_RUN | Full runtime safety, provider and platform adapter acceptance remains. |

## D1 supervisor and child protocol

- Created a new component-owned `worker/` package using the repository's pinned
  Node.js 24 and pnpm 10 ranges. It does not alter backend or dashboard package
  ownership.
- The backend pure-data protocol remains canonical. A deterministic script
  copies it into the worker package, records the source SHA-256 digest and makes
  verification fail if the committed copy drifts.
- Added a 64 KiB big-endian length-prefixed JSON protocol shared by TypeScript
  and Python. Both sides reject unknown envelope fields, unsupported versions,
  invalid UUID-v4 request/incarnation values, noncanonical timestamps,
  excessive nesting/items/strings, invalid JSON and incomplete/oversized
  frames.
- The supervisor starts one initial child per unique GPU, waits for a bounded
  ready handshake, correlates terminal responses by request ID, provides
  cancellation, kills timed-out children and shuts them down cleanly.
- Child processes inherit only basic platform variables plus two explicit
  non-secret MusicMute keys. Backend/S3 credentials are not accepted. Stderr is
  sanitized and retained only as a bounded tail.
- At the D1 checkpoint, the Python child answered protocol health checks and
  explicitly returned `PROCESSING_NOT_IMPLEMENTED`. D2 replaced that guard with
  the validated pipeline below.

## Verification

From `worker/`:

```bash
pnpm run verify
node dist/src/cli/main.js protocol-doctor
```

Result: PASS.

- backend protocol source-digest check: PASS
- formatting: PASS
- lint: PASS, zero warnings and errors
- TypeScript typecheck: PASS
- TypeScript tests: PASS, 3 files and 10 tests
- Python IPC tests: PASS, 4 tests
- TypeScript production build: PASS
- built CLI to real Python-child handshake: PASS

The tests cover fragmented/consecutive frames, size/depth/field rejection,
cross-language startup and ping, explicit unavailable processing, cancellation,
request timeout/forced stop, stderr redaction, environment rejection and
one-child-per-GPU capacity.

## D2 versioned Kim recipe family

- Frozen exactly four recipes: `kim-vocals-v1`, `kim-vocals-trim-v1`,
  `kim-vocals-denoise-v1` and `kim-vocals-denoise-trim-v1`. Disabled steps are
  absent from the ordered step list and execution timings rather than simulated
  with no-op parameters. `kim-vocals-trim-v1` remains the initial default.
- The backend and Python runtime independently derive the same canonical
  SHA-256 recipe digests. A child rejects unknown fields, unknown recipes or any
  mismatch in the model, step, trim, denoise, preparation or encoding snapshot.
- The model cache is keyed by the qualified artifact digest. Installation and
  every child configuration validate `Kim_Vocal_2.onnx` as 66,759,214 bytes
  with SHA-256
  `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.
  The model remains excluded from Git and its redistribution status remains
  unresolved.
- Media commands use absolute executable paths, argument arrays, no shell and
  a local-only FFmpeg protocol allowlist. The fixed order is input identity and
  decoded-media validation, PCM16 stereo 44.1 kHz preparation, Kim vocal-only
  FLAC separation, optional `afftdn-conservative-v1`, optional
  `trim-vocal-gaps-v1`, 192 kbps MP3 encoding, then final probe/size/hash.
- The trimmer port matches the preserved source's eight synthetic sample-count
  vectors and produces byte-identical PCM16 output for the internal-gap parity
  case, including partial frames, louder-channel RMS, padding, fades, rounding
  and all-silent fallback. Retained ranges are reported in bounded chunks.
- Four-recipe pipeline tests use real FFmpeg/ffprobe with a deterministic fake
  separator so both enabled and genuinely omitted denoise/trim paths run. A
  warm pipeline reuses one separator without cross-attempt output reuse.

### Real M4/CoreML child run

The accepted native ARM64 Python 3.13.7 environment, qualified model and owned
8-second fixture (`dd1c139a6353ba06075a4216b3e83ac8ae8ddc0601c434105dcece5486bf28c1`)
were used through the built TypeScript supervisor child wrapper and framed
Python process command. Result: PASS.

- child advertised exactly the four recipe IDs and returned a terminal result;
- output existed as `audio/mpeg`, 193,767 bytes, stereo 44.1 kHz and 8.0 seconds;
- source/output were 352,800 samples, with one identity edit range because this
  fixture's separated vocal stem had no qualifying gap;
- recipe digest was
  `1a70379331fafb360f4cd388e17f4c6ce511031e4082f34ba63676957d8c34c3`;
- executed stages were model validation/load, input identity, media validation,
  preparation, separation, trim, encode and output validation;
- third-party progress text initially corrupted stdout framing. The child now
  reserves a duplicate protocol descriptor and redirects Python/native stdout
  to bounded sanitized stderr; a focused subprocess regression test covers it.

The earlier B2 profile remains the evidence that this exact lock/model dispatches
the Kim graph to CoreML. D2 did not create a new ONNX Runtime provider profile.
The synthetic run proves execution and output structure, not listening quality.

### D2 verification

- worker formatter/lint/typecheck/build: PASS;
- TypeScript worker tests: PASS, 3 files and 10 tests;
- Python engine tests: PASS, 13 tests, including all four recipes and trimmer
  parity;
- backend D2-focused tests: PASS, 10 files and 42 tests;
- backend formatter, lint, typecheck and production build: PASS;
- backend unit tests: PASS, 108 files and 729 tests. Because Vitest imports
  this checkout's developer `.env.local` as strings, 107 files/727 tests ran
  in an env-file-free temporary copy and the two repository-root packaging
  tests ran in the original checkout; no environment file was changed;
- backend E2E tests: PASS, 22 files and 135 tests in the same env-file-free
  temporary copy;
- real framed M4/CoreML child pipeline: PASS.

## Limits

This is local protocol/pipeline evidence. It does not prove backend polling/S3
integration, service-account operation, installation, logged-out behavior,
reboot survival, DirectML service execution, denoise listening quality or
release readiness. D4 must package the accepted native ARM64 Python
3.13/CoreML environment; the system Python 3.14 used for D1 protocol tests is
not a runtime qualification.
