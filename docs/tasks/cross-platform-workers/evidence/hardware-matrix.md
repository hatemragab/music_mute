# F01 candidate hardware matrix

**Observed on:** 2026-09-13
**Evidence level:** source inventory and local admission tests only
**Qualified recipes:** none

The table intentionally lists difficult and unavailable families. `Unavailable`
means the required physical GPU, isolated runtime, or native service/reboot proof
was not available in this execution. It is not evidence that the family cannot
work. Profile details and proposed exact dependencies are in
`worker/qualification/candidates.json`.

| OS / arch | GPU family | Provider | Candidate profile | Status | Missing evidence |
| --- | --- | --- | --- | --- | --- |
| Windows x64 | AMD | DirectML | `windows-x64-directml-amd-ort-1.24.4` | Unavailable | Current model/fixture/runtime hashes, graph profile, memory, bounded long clip, cancellation, service-context and reboot proof. Prior Z440 measurements are not bound to this recipe. |
| Windows x64 | Intel | DirectML | `windows-x64-directml-intel-ort-1.24.4` | Unavailable | Compatible Intel host and all native evidence. |
| Windows x64 | NVIDIA | DirectML | `windows-x64-directml-nvidia-ort-1.24.4` | Unavailable | Compatible NVIDIA host and all native evidence. |
| Windows x64 | NVIDIA | CUDA | `windows-x64-cuda-nvidia-ort-1.26.0` | Unavailable | Exact driver floor, isolated CUDA/cuDNN runtime, graph profile and all native evidence. |
| macOS arm64 | Apple Silicon | CoreML | `macos-arm64-coreml-ort-1.24.4` | Unavailable | Kim Vocal 2 partition/allocation proof, reference/resource/cancellation checks, LaunchDaemon and reboot proof. |
| macOS x64 | Intel | CoreML | `macos-x64-coreml-intel-ort-1.24.4` | Unavailable | Intel Mac; proof CoreML used the GPU rather than CPU; all other native evidence. |
| Linux x64 | NVIDIA | CUDA | `linux-x64-cuda-nvidia-ort-1.26.0` | Unavailable | Compatible host, exact driver floor, graph/resource/output evidence, systemd and reboot proof. |
| Linux x64 | AMD | MIGraphX / ROCm | `linux-x64-migraphx-amd-ort-1.23.2-rocm-7.2.1` | Unavailable | Supported AMD tuple, isolated AMD wheel/source provenance, model compile/graph coverage, all native evidence. |
| Linux x64 | Intel | OpenVINO GPU | `linux-x64-openvino-intel-ort-2025.2.0` | Unavailable | Compatible Intel GPU, isolated version-pair proof, explicit GPU graph evidence, all native evidence. |
| Linux arm64 | Arm | Arm NN | `linux-arm64-armnn-source-candidate` | Unavailable | No general immutable binary recipe or selected board; source-build provenance and all native evidence. |
| Linux arm64 | NVIDIA Jetson | CUDA | `linux-arm64-cuda-nvidia-jetson-candidate` | Unavailable | Select a board/JetPack tuple and immutable ARM64 wheel, then collect graph/output/resource, systemd, and reboot proof. |
| Windows arm64 | Qualcomm | DirectML | `windows-arm64-directml-qualcomm-candidate` | Unavailable | Native dependency wheel resolution, Qualcomm device, model graph/output/resource evidence, service and reboot proof. |

Other combinations are not silently treated as supported. Discrete NVIDIA/AMD
GPU recipes on Apple Silicon are omitted because current macOS systems use Apple's
GPU stack; Intel Mac eGPU variants require a concrete still-supported host/runtime
before they can become separate candidates. Windows ARM64 AMD/Intel and Linux
ARM64 AMD/Intel lack a selected target device plus an immutable provider/runtime
recipe in this execution. Add a distinct unavailable candidate when W02 selects
such a real target; do not generalize proof from x64 or another vendor.

No media class is admitted. The deterministic short synthetic fixture still needs
to be generated and digested, and representative clips must be selected; no
reference tolerances can be truthfully set. These are actionable artifact tasks,
separate from hardware availability. The local validator rejects `candidate`, `rejected`, and
`unavailable` entries before considering contributor-reported evidence and rejects
CPU-only or partially accelerated neural graphs.

Native qualification must record exact OS build, architecture, GPU and driver,
Python and dependency lock, model and fixture digests, provider profile, cold/warm
duration, peak host memory, GPU memory when observable, decoded reference metrics,
output validity, cancellation, bounded long clip, service principal/context, and
an unattended reboot observation. Missing telemetry remains unknown rather than
zero or success.
