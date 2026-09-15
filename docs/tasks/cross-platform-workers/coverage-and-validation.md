# Coverage and validation gates

**Status:** Validation map; actual execution results are recorded in the [execution ledger](evidence/execution-ledger.md) and linked task reports.
**Task index:** [All tasks](README.md)
**Revised direction:** [Light fleet v1](revised-direction.md) — narrows R03 and defers V01–V03; read it before this map.
**Design:** [Approved requirements](../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)

## Requirement coverage

| Requirement | Scope                                                      | Owning tasks                      |
| ----------- | ---------------------------------------------------------- | --------------------------------- |
| R01         | Native shared Windows/macOS/Linux worker                   | W01, I01, I02, I03, I04, F02      |
| R02         | One-command complete setup/model preparation               | W02, I01, I02, I03, I04, H01      |
| R03         | Qualified GPU support for the 4-entry supported set; no CPU-only inference | F01, W02, B05, F02 |
| R04         | Always-on boot startup without login                       | I02, I03, I04, F02                |
| R05         | Trusted code pairing and scoped installation identity      | B02, I01, D01                     |
| R06         | One slot, ownership, cancellation, stopped recovery        | W01, B05, W04, F02                |
| R07         | Setup/runtime/update/failure events in existing dashboard  | B03, W03, I01, D01                |
| R08         | 30-day safe logs and exact read expiry                     | B03, W03                          |
| R09         | Only explicitly selected workers/group snapshots update    | B04 (backend kept; rollout UI deferred) |
| R10         | Signed releases, safe activation and permitted rollback    | W03, W04 (dormant in v1)          |
| R11         | Separate CapRover distribution/domain/storage              | Deferred with H02                 |
| R12         | Existing dashboard/backend control plane                   | B01, B02, B03, B04, D01           |
| R13         | Breaking development cleanup; no migration/legacy adapters | B01, B06, W01, F02                |
| R14         | New-schema durable identity/state across repairs/updates   | W01, W03, W04, I01, F02           |
| R15         | Unknown remains unknown; evidence by hardware/context      | F01, B01, F02                     |
| R16         | Immutable builds and separate stable-install target        | B04 kept; H01-light uses digest pinning |
| R17         | No unauthorized source execution/deployment/data deletion  | All task boundaries; F02          |
| R18         | Native worker/test operation; CapRover host packaging only | W01, I02, I03, I04, F02           |

**R03 narrowing (2026-09-15):** the supported set is 4 profile entries across 3 families — `windows-x64-directml-nvidia`, `windows-x64-directml-amd`, `macos-arm64-coreml`, `linux-x64-cuda-nvidia`. Eight further candidates are recorded as unsupported with a per-entry reason in the [revised direction](revised-direction.md#supported-gpu-set-f01-matrix-cut). The CPU-only inference prohibition is unchanged. Two of the excluded candidates are dead rather than merely deferred: macOS x64 CoreML has no ONNX Runtime 1.24.4 wheel, and ArmNN is rejected outright at runtime preparation.

**R09/R10/R11 are reduced in v1.** Their owning tasks are deferred or dormant, so v1 ships without targeted updates, rollback, or the CapRover distribution app. Requirements are not cancelled — they are out of scope until a later revision re-enables them.

## Required evidence by layer

| Layer              | Required proof                                                                                            | Insufficient substitute                              | v1 |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -- |
| Contracts/auth     | DTO bounds, scopes, expired/used code races, exact identity binding                                       | Successful happy-path request alone                  | Required |
| Event logs         | Pre-Python spool, safe fields, retries/dedupe, quota, exact read expiry at 30 days                        | Local stdout or TTL configuration alone              | Required |
| Scheduler          | Two API instances, claim/readiness/revoke/update races, qualified media limits                            | Dashboard readiness label                            | Claim/readiness only; update races deferred with W04 |
| Worker core        | Checksum/transfer/cancel/cleanup/recovery regression suite                                                | Import or build success                              | Required |
| GPU                | Exact model executes on real accelerator with qualified output/resource evidence                          | GPU name or available-provider list                  | Required — F02 |
| Always-on          | Actual service principal, signed out and rebooted without login                                           | LaunchAgent, user service or interactive console run | Required per platform |
| Updates            | Valid/invalid signatures, interrupted download/activation, permitted full rollback, prohibited fallback   | Source-only backup or process restart                | **Deferred with W03/W04** |
| Dashboard rollout  | Explicit membership snapshot, revisions, unselected machines unchanged                                    | Publication success                                  | **Deferred with D02** |
| Distribution       | Immutable hashes, range requests, partial publish invisibility, redeploy persistence and backup procedure | CapRover app created                                 | **Reduced:** SHA-256 digest pinning at H01-light |
| Development launch | Authorized exact builds/domain and actual selected native fleet cycle                                     | Local package or test success                        | Folded into F02 |

## Fault cases that must not disappear during implementation

- Setup blocked before bootstrap downloads: no remote observation is possible.
- Backend unavailable: local bounded spool survives; no fabricated server success.
- Missing CPU-only/GPU provider/driver/wheel recipe: distinct safe setup rejection.
- Interactive GPU works but boot account fails: never claim always-on readiness.
- Preboot disk unlock blocks startup: report actual limitation; do not weaken host protection.
- Installation approval response lost: same identity and locally held secret recover status.
- Event replay: same content dedupes; conflicting same ID fails.
- Log expired but TTL deletion delayed: API/UI no longer expose it.
- Job completion response lost: preserve and reconcile attempt before updating.
- New schema breaks old development state: no converter or implicit reset.
- Worker reports null telemetry/offline state: do not display zero or proof of termination.

The following fault cases belong to deferred tasks and are out of v1 scope. Keep their text so they are restored with those tasks, not dropped: group membership changes after selection; new release published with no implicit fleet target; candidate fails after a real claim; old fallback below minimum/revoked/incompatible; release storage redeployed.

## Execution report requirements

For each completed task record changed files, exact commands actually run, outcomes, artifact/report hashes where applicable, and unresolved limits. Never place credentials, raw environment files, original media, permanent tokens or pairing codes in evidence.

The pack originally held 23 tasks, all NOT STARTED. [F02](foundation/F02-first-machine-end-to-end-spike.md) was added on 2026-09-15, bringing the register to 24. No installer, endpoint, domain deployment, GPU benchmark, boot test or migration was executed to produce the original planning pack.
