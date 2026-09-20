# Branch 4: codex/worker-runtime

**Parent:** accepted `codex/worker-control-plane` synchronized to collection. **PR base:** `codex/worker-rebuild`. **Checkpoints:** D1–D6.

## Assignment and prerequisites

Implement the shared supervisor, Python processing child, fixed initial audio path, and the minimum installation/service adapters for each platform accepted in B. Reuse the accepted backend protocol; do not invent a second ownership mechanism.

The runtime must remain provider-neutral above a small platform adapter boundary. Supporting another GPU later should require a validated adapter and package set, not a rewritten supervisor or backend.

## D1. Supervisor and child protocol

Create one lightweight Node.js/TypeScript supervisor per machine and one initial Python processing child per validated GPU. Define a bounded framed pipe protocol with request IDs, schema versions, payload limits, timeouts, cancellation, and process incarnation.

The supervisor owns authentication, polling/reconciliation, lease renewals, capacity, child lifecycle, diagnostics, and S3 grants. Python owns local media preparation, model execution, post-processing, validation, and result metadata. A child never owns durable job authority.

## D2. Versioned Kim recipe family

Implement the documented safe order: exact-version download and checksum, media validation, PCM16 stereo 44.1 kHz preparation, `Kim_Vocal_2.onnx`, optional approved denoise, optional documented trimming, MP3 encoding, final validation/hash, attempt-scoped upload, and conditional completion. Support only the four versioned Kim recipe combinations accepted by the architecture.

Preserve the reference trimmer's internal-gap semantics, padding, fades, PCM rounding, partial-frame behavior, all-silent fallback, and bounded edit map. Disabled steps must genuinely be omitted. Additional models and unapproved processing variants remain extension points.

## D3. Runtime ownership and recovery

Use transient WebSocket hints where the accepted protocol calls for them, but poll/reconcile through HTTPS, claim only when an eligible slot is idle, renew only live owned attempts, stop before authority becomes uncertain, and reject publication after cancellation, expiry, revocation, or session replacement.

Handle child crash, supervisor restart, backend restart, network loss, sleep/wake, S3 retry, lost responses, and orphan cleanup idempotently. Restart from input after a new attempt; do not claim cross-machine checkpoint/resume.

## D4. Mac runtime and service installation

Package the accepted native ARM64 CoreML environment in a private versioned installation. Provide a diagnosable bootstrap/repair command and install the supervisor as a system LaunchDaemon without changing global Node/Python.

Validate permissions, secure credential storage, model/artifact hashes, logged-out operation, service restart, actual M4 inference, S3 flow, and uninstall boundaries. Do not claim reboot proof unless a real authorized reboot was run.

## D5. Windows runtime and service installation

Package the accepted x86_64 DirectML environment in a private versioned installation. Provide a PowerShell bootstrap/repair command and install a Windows Service without changing global Node/Python or silently replacing GPU drivers.

Validate secure credential storage, service-account GPU access, exact RX 580 device selection, model/artifact hashes, logged-out operation, restart behavior, actual inference, S3 flow, and uninstall boundaries. Use only owner-authorized remote access.

## D6. Runtime safety and extension boundary

Enforce attempt-local directories, trusted filenames, local-media-only FFmpeg input, safe argument arrays, disk/memory/output limits, log redaction, bounded local spool, and clean per-job model state. Start with one processing child per validated GPU and one active job per child unless a separately accepted benchmark proves more.

Define tested adapters for provider discovery/session creation and platform service/credential operations. Linux/CUDA/MIGraphX and additional recipes remain disabled until their own real evidence exists.

**Exit:** focused tests, accepted-platform service proof, real end-to-end processing evidence, and reviewed PR. No rich dashboard, automatic fleet updater, deployment, or public package publication.
