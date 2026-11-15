# W07 — Implement automatic GPU selection and strict DirectML inference

- Status: code-complete / Windows pending; real pinned frontend and injected engine/GPU source checks pass, with native execution separately deferred.
- Code dependencies: [W03](W03-windows-native-security-adapters.md), [W06](W06-runtime-and-model-package-layout.md).
- Accepted scope points: P03, P05, P19, P22.
- Execution phase: A — implement now once authorized; native checks later.
- Evidence: [W07 code checks and native gates](../evidence/W07-gpu-foundation.md).

Checked rows preserve source checkpoints. Continue source implementation only
within explicit authorization; use code-only fixtures on the Mac and keep actual
native GPU checks in W34.

## Current source audit — 2026-10-10

[Requirement → production entry → portable proof → native acceptance](../evidence/W06-W09-runtime-prepare-readiness-closure-2026-10-10.md)
records every boundary below. `[x]` in implementation/code sections means source
and portable proof, never Windows execution. Historical completion commands below
remain dated slices; use the current matrix for subsequent changes.

## Existing behavior and design consequence

The original Windows service assumed ordinal 0, one RX 580 and LocalService.
The recorded consumer foundation now uses physical identity, explicit current-user
profile and strict provider enforcement. Keep the legacy service contract intact;
finish the consumer application flow without treating the foundation as real GPU proof.

## Read before editing

- [worker/engine/musicmute_engine/windows_gpu.py](../../../worker/engine/musicmute_engine/windows_gpu.py)
- [worker/engine/musicmute_engine/provider_adapter.py](../../../worker/engine/musicmute_engine/provider_adapter.py)
- [worker/engine/musicmute_engine/qualification.py](../../../worker/engine/musicmute_engine/qualification.py)
- [worker/src/enrollment/report-builder.ts](../../../worker/src/enrollment/report-builder.ts)
- [worker/src/platform/runtime-adapter.ts](../../../worker/src/platform/runtime-adapter.ts)

Also read [architecture](../ARCHITECTURE.md), [AI handoff](../AI-HANDOFF.md),
[validation](../VALIDATION.md), and the affected component instructions/manifests.

## Implementation checklist

- [x] Enumerate physical DXGI adapters and stable device/driver identity; reject software adapters and unsupported native host architecture. Choose candidates automatically by a documented deterministic policy, then qualification, rather than product-name allowlists or ordinal zero.
- [x] Resolve the selected physical GPU to the current DirectML ordinal; re-resolve after driver/device/order changes. Persist a qualified preference and permit advanced diagnostic visibility without exposing normal users to backend choices.
- [x] Configure the pinned ONNX session for DirectML sequential execution with memory patterns disabled. Implement supported fail-closed CPU-fallback prevention and placement checks for the model, including normal runtime error/recreation paths.
- [x] Bind qualification receipts to exact model/runtime/provider/recipe/fixture, physical device/driver and resource observations. Invalidate relevant receipts on change; report unsupported hardware truthfully and leave account/library/cloud-explicit features usable.
- [x] Replace consumer report hardcodes for RX 580, device 0 and S-1-5-19 with qualified current-user evidence while retaining legacy service validation. Do not weaken backend eligibility or allow fabricated qualification.
- [x] Default to one inference slot and use measured capacity receipts for any increase. Handle OOM/device loss by bounded recovery or smaller supported configuration followed by requalification; never retry using CPU.
- [x] Define native test cases and evidence fields for NVIDIA/AMD/Intel, integrated/discrete systems and multi-GPU reorder. Do not publish unmeasured minimum VRAM or performance promises.

## Code validation checklist

- [x] Unit-test selection/ordinal mapping with zero/one/multiple/software adapters and changed LUID/driver/ordinal fixtures.
- [x] Test missing DirectML, CPU-node evidence, absent/incomplete profiles, session fallback attempts, invalid receipts, OOM/device-loss recovery and report identity compatibility.
- [x] Run Python code-only provider/qualification tests with injected sessions; label them explicitly as not GPU execution proof.
- [x] Serialize all supported synchronous Run entry points per DirectML session and retain async exclusion through actual native completion, with once-only callback delivery and no user callback under the lock; real-thread injected tests pass.
- [x] Bind personal qualification/readiness to the mandatory current native volatile witness; reused LUID after witness change and legacy absence cannot authorize inference. See [boot/serialization checkpoint](../evidence/W07-W09-boot-witness-and-session-serialization-2026-10-09.md).

## Windows acceptance — deferred until W34

- [ ] Run the exact model on real supported GPUs and capture execution-placement evidence, output integrity/listening quality and resource measurements.
- [ ] Verify multi-GPU selection, driver/device changes, insufficient memory and unavailable GPU all preserve the no-CPU-inference rule.

## Agent execution contract — planning review 2026-10-09

| Input/proof                | Consumption rule                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native OS/process identity | Require native x64, x64 process, supported Windows build and real current-user SID; reject x64-on-ARM emulation.                                                                                    |
| GPU inventory              | Source string `DXGI EnumAdapters1/GetDesc1`, 16 lowercase hex LUID, current `deviceIndex`, hardware IDs, driver version and DXGI memory fields. Software adapters never become candidates.          |
| Selection                  | Deterministic candidate ranking followed by the pinned model qualification. Adapter names and dedicated-memory values are hints, not eligibility or measured memory capacity.                       |
| Receipt                    | Bind release/inventory, model, fixture, recipe/revision/digest, provider/runtime, SID and physical GPU/driver. Current ordinal may be resolved again only for the same qualified physical identity. |
| Runtime admission          | Require W11 logical permit and its matching physical GPU guard before loading the model. Hold ownership until the actual engine tree exits and cleanup is confirmed.                                |
| Inference                  | DirectML placement and zero CPU-model nodes; ordinary decode/DSP/encode may use CPU. Failure cannot silently re-create a CPU session or select cloud.                                               |

### Implementation order and ownership

1. [x] Reconcile native `consumer-native-gpu.ts`/`gpu.hpp`, Python
       `windows_gpu.py`, report parser and readiness bindings. Keep one normalized
       identity shape across them and round-trip fixture values without coercion.
2. [x] Review fresh-factory discovery and ordinal resolution on each relevant
       device/driver change. Resolve the current ordinal immediately before session
       creation and check the physical identity again after creation; do not retain
       an ordinal as a durable GPU identifier.
3. [x] Review deterministic qualification across all candidates and bounded
       per-candidate shutdown. One failed candidate must release its owned tree and
       guard before trying the next. Do not infer a supported configuration from
       the presence of the DirectML package alone.
4. [x] Preserve sequential execution, disabled memory patterns, pinned session
       options, `session.disable_cpu_ep_fallback=1` and Python fallback prevention.
       Test both graph initialization and a later `Run` failure/provider replacement.
5. [x] Reconcile W08 personal fixture qualification with backend-approved fleet
       qualification; personal readiness must not create an enrollment/capacity
       grant. Default capacity is one, and any increase requires the separate
       measured W25/backend receipt.
6. [x] Review all normal personal/fleet engine entry points against the same
       profile/model/provider/physical guard rules. Keep invalidation and retry
       bounded; a changed driver, unsupported graph, OOM or device loss yields an
       honest unavailable/requalification state.

Provider/qualification logic lives in the shared worker engine and enrollment
report parser. Native adapter/keeper behavior belongs to W03/W11; app receipt
persistence belongs to W08/W09; measured capacity and backend grants belong to
W25. Reconcile these code boundaries before changing shared fields, and retain
omitted-profile legacy tests. One sequential implementation agent can execute
these tasks without relying on the earlier development team's roles.

### Additional code-only fixture matrix

- [x] Inventory: no adapters; software-only; integrated + discrete; same product
      name with different LUID; duplicate physical identity; malformed driver data;
      reordered ordinals; adapter removed between discovery and session creation.
- [x] Architecture: unsupported build/x86/native ARM with x64 process, service
      SID, local/domain SID and Azure AD SID. Consumer and legacy report acceptance
      remain distinct; neither can masquerade as the other.
- [x] Placement: missing DML; CPU-only session; mixed CPU-node profile; empty or
      truncated profiling; forced CPU graph assignment; internal fallback call;
      `Run` error attempting provider reset. Every negative case refuses readiness.
- [x] Receipt: changed model/release/recipe/fixture/runtime/driver, ordinal-only
      reorder, expired capacity, fabricated memory observation and malformed SID.
      Reorder may resolve the same GPU; changed physical/driver proof requires fresh
      qualification rather than rewriting the old receipt.
- [x] Ownership: cancelled qualification, abandoned GPU guard, keeper/helper
      loss, late engine success after cancellation, and release acknowledgement
      missing. No next candidate/model load before confirmed safe ownership.

Use injected ONNX sessions, DXGI/native ports and profile JSON fixtures on the
Mac. Existing Python/provider/report tests are the starting point; a fake session
that records DML options demonstrates orchestration only. Do not add broad
Windows skips or success-returning hardware stubs.

### Deferred machine evidence and deliverables

- [ ] Record named OS/build, native/process architecture, GPU hardware/driver,
      release/model/recipe/fixture digests, actual provider events, wall/engine time,
      output hashes/durations and resource observations for each tested GPU.
- [ ] Test actual NVIDIA/AMD/Intel examples as available, integrated/discrete
      multi-GPU ordering, dock/undock, driver replacement, low memory and device loss.
      Untested families remain unqualified; no invented universal/minimum-VRAM claim.
- [ ] Verify helper/keeper crash and logout cannot release physical ownership
      while any GPU child survives. Listen to the output separately from placement
      proof; accelerated nodes do not establish audio quality.
- [ ] Deliver normalized identity examples, selection policy, invalidation
      matrix, strict-provider regression results and the explicit W34 GPU matrix.

Official constraints checked: [ONNX Runtime DirectML](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)
requires sequential execution, disabled memory patterns and serialized `Run`
calls per session; adapter 0 need not be the fastest GPU. [DXGI enumeration](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgifactory-enumadapters)
requires a new factory after adapter changes. [CheckInterfaceSupport](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgiadapter-checkinterfacesupport)
can provide driver-version evidence through `IDXGIDevice`; Direct3D 12 support
must be checked by actual device creation, not by querying a D3D12 interface there.

## Reboot identity and GPU receipt return

- [x] Separate same-boot adapter LUID/ordinal from persistent physical-device
      preference. A LUID is not a cross-reboot identity; document the trusted
      physical/driver/runtime/model/recipe evidence required to rebind it.
- [x] Invalidate old execution permits across restart even if a numeric LUID is
      reused. Resolve current native/Python identity before admission; ambiguous
      rebinding requires qualification, not vendor/name equality.
- [x] Test reordered, changed and reused LUIDs after reboot, same-name distinct
      GPUs and driver/model changes. Keep routine valid warm startup cheap under
      W09; no unconditional full model hash/inference on every app open.
- [x] Test serialized `Run` calls on one DirectML session and native/Python device
      identity agreement immediately around creation. Session availability is not
      evidence that all model inference executes on the selected GPU.

See [Microsoft's adapter LUID lifetime](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12device-getadapterluid).

## Explicit portable dependency return

- [x] Run the injected provider/GPU/qualification/pipeline and pure first-session
      timing slice: 45 tests passed without actual ORT/GPU execution.
- [x] Run the full separator regression and preserve its actual result: 10 tests
      executed, 7 passed and 3 dependency errors.
- [x] Supply a disposable compatible declared frontend dependency environment and
      pass `test_direct_mdx_configuration_matches_pinned_upstream_loader`,
      `test_primary_only_preserves_vocal_math_without_secondary_pass`, and
      `test_verified_model_load_uses_pinned_metadata_without_network_or_discovery`.
      The disposable exact frozen frontend environment passes all ten separator
      tests, including these three real upstream import cases; pip check and
      installed-pin comparison pass. Existing full engine discovery runs 131
      tests: 130 pass, one existing Windows-only Job case skips. See
      [current dependency proof](../evidence/W07-pinned-frontend-code-checks-2026-10-10.md).
      No success stubs, CPU/model inference or prepared-runtime mutation were used.
- [x] Deliver normalized identity/selection/invalidation examples and the source
      policy matrix G01–G06. Actual GPU families, output listening and boot/hive
      behavior remain the separate deferred machine deliverable above.

## Completion record

- Implementation files and review: DXGI discovery/identity/selection, strict ONNX adapter, qualification and benchmark CLI, consumer enrollment report, explicit runtime adapter and profile-aware Windows inventory; see evidence for paths.
- Commands/results and evidence: 44 injected Python tests and 33 TypeScript tests passed; worker typecheck, scoped lint/format and diff checks passed. No GPU inference executed.
- Unrun native/toolchain checks: Windows DXGI/DirectML execution, native x64/ARM-emulation rejection, real drivers, memory/device loss, clean-machine toolchain and output quality.
- Current source return: G01–G06 and P06/S01/S02 in the current matrix cover shared identities, current-witness/preference/ordinal rules, strict provider settings and exact teardown. Actual DirectML and peak GPU use remain unmeasured. Three real pinned upstream-loader checks now pass in the exact disposable frozen frontend environment, independently of the injected provider tests. The full engine result is 130 passed plus one existing native Windows-only skip; see [current proof](../evidence/W07-pinned-frontend-code-checks-2026-10-10.md).

Check completed items individually and update [TASKS](../TASKS.md) and
[PROGRESS](../PROGRESS.md). Use `code-complete / Windows pending` only when
the required source work and executable code checks are complete; unavailable
native compilation remains explicitly recorded. Do not claim a release from
fixture or source-only proof.
