# W11 serialized GPU admission core

Date: 2026-10-09. Status: in-progress; native transport/guard/factory composition remains open.

`windows-desktop/src/main/admission/gpu-broker.ts` implements one serialized per-user/physical-GPU authority. It persists ownership before issuing a lease, binds requests to role, SID/session, process creation identity, nonce, generation and qualified GPU/driver, prioritizes personal requests, fences new fleet claims and requires inference-child cleanup proof before release. It never changes backend capacity or saved worker intent.

Six deterministic fixtures passed: fleet accepted-work handover; simultaneous app/Chrome requests and idempotent waiting; foreign user/driver/PID-reuse rejection; abandoned-mutex recovery; cancelled cross-session contention; durable-state failure with unissued guard release. These use simulated native/control ports.

The real factory must bind verified role peers, DPAPI state, the native cross-session GPU guard, actual fleet admission wake/grant behavior and exact owned inference-child exit proof. An abandoned mutex or PID absence alone is insufficient. Native factory/client wiring, broader failures and all Windows contention tests remain unchecked.
