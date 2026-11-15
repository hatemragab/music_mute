# System design

**Status:** completed MVP design for implementation; not a deployed system.

## Goal

Turn Music Mute's private NestJS backend into a coordinator for multiple trusted GPU machines. Each machine runs one small supervisor and zero or more processing children. A free child pulls one eligible task through its supervisor, executes it, and reports the result. The Z440 is one participant, not a special server on which all jobs depend.

```text
Existing clients ──HTTPS──> NestJS API <──HTTPS── Existing dashboard
       │                       │
       │                       ├── MongoDB: durable jobs, attempts, machines, policy
       │                       └── Redis: transient presence and notifications
       │                              │
       │                one WSS connection per machine
       │                              │
       │                         Supervisor
       │                         ├── Python child / GPU slot 1
       │                         └── Python child / GPU slot 2
       │                              │
       └───────────── S3 <────────────┘
                presigned data transfers
```

No public listener is needed on a worker machine. All normal worker connections are outbound. SSH to the Z440 is a development/testing channel supplied by the owner, not how production jobs are dispatched.

## Responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| Existing NestJS backend | User authorization, admission, recipe snapshots, queue claims, leases, S3 grants, finalization, fleet admin | Model inference or proxying user audio |
| MongoDB | Authoritative job/attempt state and durable policy | Live transport delivery |
| Redis | Expiring live state, notification fan-out if needed | Final job ownership or the only queue |
| Supervisor | Machine identity, one backend connection, local workers, transfers, leases, IPC, logs, configuration, local control | User/admin authentication or permanent AWS access |
| Python child | One inference session/device, one task at a time, audio pipeline, stage diagnostics | Database, Redis, backend admin, S3 account credentials |
| Launcher | Launch selected release, observe startup/crash health, switch to last-known-good | Audio pipeline and arbitrary remote commands |
| Dashboard | Read fleet state, issue allowed admin commands, enroll, select recipes/updates | Executing shell commands or directly accessing machine secrets |

Use TypeScript for CLI/supervisor/backend coordination, Python for existing audio separation capability, and thin platform-specific installers. Start with one backend deployment, not microservices. Reuse existing backend storage/usage/audit capabilities rather than copying them into fleet modules.

## Deployment and identity hierarchy

A `machineId` identifies one enrolled installation, with its GPU inventory and credentials. It is not a MAC address or motherboard serial. Avoid compulsory hardware fingerprinting; a UUID plus protected credentials is sufficient for trusted machines.

A supervisor boot has a new `sessionId`/generation. A reconnect during the same boot keeps that session. A controlled session-replacement operation invalidates the older supervisor's authority; it does not create two valid supervisors for the same machine.

A stable slot has `workerId`, `gpuId`, slot index and current process incarnation. A child process may restart without changing machine identity, but its new incarnation cannot finish the previous process's attempt. One active attempt per slot is enforced in the backend, not only by local code.

The supervisor multiplexes child requests through one authenticated WSS connection and shared HTTPS client. This supplies the requested `backend → N machines → N workers` hierarchy without independent enrollment, heartbeat sockets and updaters for every child.

## Transport decision

Use native WebSocket with Nest `WsAdapter` for job hints, machine heartbeat, progress and policy/release notices. Native WebSocket does not imply raw TCP or unauthenticated traffic. Use WSS outside local isolated loopback/tunnels. [T3]

Use HTTPS for enrollment, activation, opening a supervisor session, claims, batched lease renewals, result/failure acknowledgement, transfer grants and log batches. Responses explicitly identify the operation/attempt. MongoDB is authoritative when a socket message is lost.

Claim on connect, after a job finishes, and after a eligible-work hint. An idle machine also performs a randomized 60–120 second reconciliation check. Reconnect exponentially with jitter. Coalesce work notifications and target eligible idle machines, rather than waking the entire fleet for each job. Busy machines do not poll for work.

The initial scheduler is **oldest eligible queued job first**, with deterministic tie-breaking. Eligibility includes active machine, current session, free validated slot, enabled policy, supported exact recipe/model hashes, memory/capacity and an undeleted authorized job. Do not add geographic optimization, performance auctions, predictive GPU packing or a second queue library now.

## Hardware policy and platform status

| Target | Admission requirement | Implementation status before testing |
| --- | --- | --- |
| macOS ARM64 | Apple Silicon M1+; actual Kim acceleration via CoreML; adequate unified memory | Required first target: M4 |
| Windows x86_64 / AMD | DirectX 12/DirectML and at least 4 GiB dedicated VRAM; real Kim execution | Required second target: RX 580 8 GB |
| Windows/Linux x86_64 / NVIDIA | CUDA-supported runtime/device and at least 4 GiB dedicated VRAM | Prepare adapter; disable production until tested |
| Linux x86_64 / AMD | Officially supported ROCm/device/runtime combination; at least 4 GiB dedicated VRAM | Prepare MIGraphX path; disable until tested |
| Intel Mac, Intel GPU, CPU-only machine | Not supported | Reject |
| Windows/Linux ARM64 | Not part of initial tested support | Reject with explicit platform reason |

The 4 GiB threshold and 8 GiB recommendation are product policies, not model execution guarantees. Record actual byte counts, not approximate string names. Apple unified memory is not dedicated VRAM; assess a conservative working-memory budget and the real benchmark.

For ONNX on Apple, use the CoreML provider, not a claimed MPS implementation. Configure `CPUAndGPU` for the GPU admission probe and verify actual dispatch. An available provider name alone, or CoreML dispatch to CPU only, does not pass. Supporting CPU operators and CPU decoding/trimming are allowed; a wholly CPU inference run is not. [T1]

DirectML has session configuration and concurrent-run restrictions. Start from documented supported settings and isolate one session in each child. [T2] For modern AMD Linux work, do not assume the removed ONNX Runtime ROCm provider is available; validate the MIGraphX path against current official support. [T4]

Do not enumerate GPU marketing model names as the sole admission rule. Capability tests still need a tested runtime/OS/driver compatibility envelope. Unknown/new combinations remain rejected or explicitly unverified, not auto-admitted because they contain a GPU.

## Repository integration

Retain `audio_jobs` and its public APIs. Add execution fields/attempt records under explicit new schemas. Do not restore old worker routes, code or dashboard. Preserve history, completed outputs, account deletion and usage behavior. Public success remains `ready`; local pipeline stages need not become new public status values. [R3–R7]

Keep new admission behind `AUDIO_PROCESSING_ENABLED` and an explicit fleet readiness switch until integration. Do not change production default behavior when a branch is merged into the collection branch. Existing completed-job reads must work when fleet admission is disabled.

## Extension boundaries

A versioned recipe references approved steps and artifacts. New model families can add adapters without changing job ownership or installation identity. Machine policy advertises supported/allowed recipes, not arbitrary user code. Updates preserve a protocol compatibility window and independent recovery.

Future ideas are extension points only: more model families, auto-scaling concurrency, remote checkpoint resumption, public worker operators and high-availability backend deployments. A single VPS is still a coordinator failure point; worker distribution alone does not remove that risk.

## Initial defaults

Heartbeat and active renewal: 20 seconds. Lease: 90 seconds. Recovery scan: 10 seconds. Idle reconciliation: randomized 60–120 seconds. Enrollment invite: 15 minutes, one use. Heartbeat sample history: 10%, expires after 48 hours. Default capacity: one child per GPU. Default recipe: Kim + reference trimming, denoise off, MP3 192 kbps.

These are design defaults to validate and configure, not measurements. Exact supported OS builds and dependency pins are filled from real feasibility evidence in branch B, not fabricated in the architecture branch.

Sources: [source index](../reference/SOURCES.md).
