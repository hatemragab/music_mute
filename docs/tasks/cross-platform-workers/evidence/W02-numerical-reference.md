# W02 local numerical reference

Local development evidence, 2026-09-14. This is not boot-service, capacity, or
release qualification. The macOS candidate remains unavailable.

The isolated reference used upstream MDX STFT/inverse/chunking methods with
Torch 2.13.0, NumPy 2.5.3, and ONNX Runtime 1.24.4. Torch belongs only to the
temporary reference environment; it is not a worker dependency. The production
candidate ran through its prepared Python 3.12.13 environment and CoreML session.

Four synthetic DSP fixtures and fourteen chunk-boundary cases passed. Maximum
forward error was 6.103515625e-05; inverse error 1.1920928955078125e-07;
demix error 1.4901161193847656e-07. These cases compare deterministic transforms,
not model quality. The upstream reference emitted a Torch deprecation warning
for `return_complex=False`.

The actual pinned Kim Vocal 2 model comparison used two seconds of synthetic
stereo audio, producing finite arrays of shape 2 x 88200. The independent CPU
reference versus prepared CoreML worker yielded relative L2 error
9.718199829626781e-05 and maximum absolute error 1.0145595297217369e-07.
Both predetermined engineering thresholds of 0.001 passed. CPU execution was
used only as an offline reference, never as a product admission fallback.

Local reproduction artifacts:

- `/tmp/musicmute-w02-reference-probe.py` and `musicmute-w02-reference-result.json`
- `/tmp/musicmute-w02-model-reference.py` and `musicmute-w02-model-reference-result.json`

Temporary artifacts are not durable release inputs. This evidence does not prove
subjective vocal quality, a ground-truth vocals comparison, final FLAC
quantization, full FFmpeg processing, sustained capacity, or execution before login.

The executed scripts are preserved as `w02-dsp-reference-probe.py` and
`w02-model-reference-probe.py` beside this report. They are diagnostic snapshots
with explicit local workspace/cache paths and temporary upstream source inputs;
they are not installable worker tools. Reproduction requires preparing those
inputs and paths before execution. They intentionally keep the offline CPU
reference separate from the GPU child environment.
