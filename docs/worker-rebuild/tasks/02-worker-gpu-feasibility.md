# Branch 2: codex/worker-gpu-feasibility

**Parent:** accepted `codex/worker-architecture` synchronized to collection. **PR base:** `codex/worker-rebuild`. **Checkpoints:** B1–B4.

## Assignment and purpose

Prove the highest-risk technical assumption before backend implementation: the real `Kim_Vocal_2.onnx` graph can produce valid accelerated output on the intended MVP hardware. This branch is a bounded feasibility spike, not a worker fleet implementation.

Read the system design, audio pipeline, test strategy, trimmer review, source registry, and the preserved reference script. Reconcile the selected package versions with current primary documentation before pinning them.

## B1. Reproducible probe harness

Create a small isolated probe that reports OS/architecture, GPU inventory, runtime/provider versions, model digest, model load, inference result, output validity, elapsed time, and memory observations. Use an owned or rights-cleared deterministic fixture.

The probe must distinguish provider availability from substantive accelerated execution. Supporting CPU preprocessing or unsupported individual operators is acceptable; a wholly CPU inference run is not. Keep CoreML and DirectML environments isolated and do not install competing ONNX Runtime distributions together.

**Evidence:** exact package/model pins, fixture identity, sanitized command, output validation, and explicit limitations.

## B2. Mac mini M4/CoreML proof

Run native ARM64 ONNX Runtime with CoreML using the documented CPU-and-GPU compute-unit policy. Reject Rosetta/x86 builds. Capture the strongest supported profiling or compute-plan evidence that Kim inference is not wholly delegated to CPU.

Record cold model load, warm inference, memory pressure, output duration/format, and whether the candidate can safely proceed to the runtime branch. Do not claim MPS; the selected Apple provider is CoreML.

## B3. Z440 RX 580/DirectML proof

Run the same model and compatible fixture on the actual Windows Z440 with an explicit DirectML device. Access requires owner-supplied connection details and trusted host-key handling; do not scan, guess credentials, or disable host verification.

Record Windows/driver/runtime builds, device identity, cold/warm measurements, memory observations, output validity, and substantive accelerated inference evidence. A listed DirectML provider without a successful Kim run does not pass.

## B4. Feasibility decision and pins

Compare both results without inventing equivalence. Freeze only versions proven on the corresponding host. Classify each target as `PASS`, `FAIL`, `BLOCKED`, or `NOT_RUN` and record the implications for the MVP.

If one target is blocked, the architecture remains extensible but that target is not advertised as supported. The maintainer decides whether the first usable MVP proceeds with the passing platform or waits for both.

**Exit:** checkpoint report with reproducible probes and a reviewed PR. Do not implement enrollment, queues, the supervisor, installers, dashboard pages, or production services in this branch.
