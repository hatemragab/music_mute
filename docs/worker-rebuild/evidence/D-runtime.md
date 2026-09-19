# D runtime evidence

Observed 2026-09-19 in Africa/Cairo on `codex/worker-runtime`, created from the
accepted control-plane collection commit
`1cd22912dd93363b45f556951555c16d9ba6e796`. The D1 local environment was
Darwin 25.6 ARM64 with Node.js 24.18.0, pnpm 10.14.0 and Python 3.14.4.

## Checkpoint status

| Checkpoint | Status | Evidence |
| --- | --- | --- |
| D1 supervisor and child protocol | PASS | Standalone worker package, generated backend protocol copy, bounded framed TypeScript/Python IPC, lifecycle/timeouts/cancellation and focused verification. |
| D2 versioned Kim recipes | NOT_RUN | No audio pipeline or inference is claimed by D1. |
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
- The D1 Python child answers protocol health checks and explicitly returns
  `PROCESSING_NOT_IMPLEMENTED` for work. This prevents a protocol test from
  being mistaken for D2 inference.

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

## Limits

This is local protocol/lifecycle evidence only. It does not prove model output,
native GPU dispatch, backend/S3 integration, service-account operation,
installation, logged-out behavior, reboot survival or release readiness. D4
must use the accepted native ARM64 Python 3.13/CoreML package; the system
Python 3.14 used for D1 protocol tests is not a runtime qualification.
