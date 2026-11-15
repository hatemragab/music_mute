# W07/W08/W09 consumer boot binding and DirectML serialization

Source checkpoint on 2026-10-09. Actual Windows registry, reboot, GPU and device
acceptance remain deferred to W34.

## Concrete audit gaps and source correction

The earlier readiness binding checked the entire selected GPU identity, including
LUID and driver, but had no current-boot witness. Windows can reuse a LUID after a
reboot, so unchanged adapter fields could otherwise authorize an old qualification.
The native adapter now supplies `bootIdentity(): Promise<string>`: a bounded
64-hex app-owned private volatile-registry witness. It survives ordinary app/helper
exits and invalidates on reboot or earlier hive unload. It is not an OS boot GUID,
wall-clock/uptime approximation or logon-LUID inference. Native source validates
the private key/shape and volatility, refusing a persistent squatted key. The
owning native task records its implementation and injected SDK checks separately;
actual registry/ACL/reboot/fast-startup behavior is still unrun.

Prepare qualification captures the native witness before its guarded candidate
work and checks it after the result and whole-tree stop. `QualificationResult`
adds that witness outside the immutable engine report. ReadyReceipt, startup
capsule and DPAPI marker are version 2. Their current witness is mandatory;
missing/version-1 or changed-boot evidence requires fresh qualification, even if
the LUID, hardware, driver and model files are unchanged. Same-boot exact physical
identity still permits ordinal remapping. Cheap readiness checks remain fingerprint/
capsule/native discovery operations and do not load a model.

The personal configuration carries the same witness. Session/desktop receipt
readers compare it to the actual native helper, and the personal runner checks it
before creating a model child or granting inference and again at its existing
execution verification boundaries. This affects GPU readiness rather than cloud
CPU tools, already verified cache reuse or retained audio playback. Existing fleet
enrollment approval remains immutable; separate current-runtime/capacity/benchmark
overlays must carry the current witness and fresh approved-fixture qualification.
That fleet/update migration is coordinated under its owning task and must be
revalidated separately before claiming all-role closure.

A past-boot v2 receipt can still identify the exact prior installed release for
the existing network-disabled expired-metadata exception. It cannot grant cached
Ready or inference. This permits offline requalification of already signed/fully
verified runtime/model bytes without inventing a fresh artifact URL or bypassing
expiry for new downloads. GPU/runtime activation still requires current proof.

The DirectML session wrapper previously pinned sequential ONNX execution and
disabled CPU fallback but did not serialize concurrent calls on one session.
It now attaches one real lock to each session's supported synchronous Run entry
points. Distinct sessions retain their permitted independence. Async submission
holds exclusion until the actual native completion callback; duplicate completion
is one-use, and the lock releases before user callback code can start another Run.
An exception after attempted native submission is not completion proof: the lock
stays held until actual late completion or owned process teardown. No timeout,
callback loss or error causes a guessed idle state or CPU retry.

## Checks actually run

- `python3 -B -m unittest tests.test_provider_adapter tests.test_windows_gpu tests.test_qualification`
  from `worker/engine`: **29 tests passed**. The new cases use actual Python
  threads/locks and injected sessions/native completion callbacks, including
  cross-entry serialization, distinct-session independence, callback reentrancy,
  duplicate completion and unknown async acknowledgement retention. No ONNX
  Runtime/model/GPU was executed.
- The 20-file Prepare/readiness/qualification/personal/admission/listening portable
  slice passed **173 tests**, start 20:51:25. Its exact command was:
  `npx vitest run tests/prepare-controller.test.ts tests/prepare-records.test.ts tests/readiness-cache.test.ts tests/qualification-runner.test.ts tests/personal-runner.test.ts tests/personal-control.test.ts tests/personal-events.test.ts tests/host-context.test.ts tests/admission-broker.test.ts tests/session-admission.test.ts tests/desktop-personal.test.ts tests/session-control.test.ts tests/personal-controller.test.ts tests/personal-storage.test.ts tests/personal-intake-journal.test.ts tests/listening.test.ts tests/listening-player-integration.test.tsx tests/bookmark-store.test.ts tests/silence-child.test.ts tests/silence-runner-storage.test.ts`.
- After adding the offline past-boot activation regression, the exact final
  seven-file slice passed **68 tests**, start 20:53:41:
  `npx vitest run tests/prepare-records.test.ts tests/readiness-cache.test.ts tests/qualification-runner.test.ts tests/personal-runner.test.ts tests/host-context.test.ts tests/prepare-controller.test.ts tests/runtime-bundle-source.test.ts`.
- Scoped lint on the 14 changed source/fixture files passed with zero warnings/
  errors; Prettier, source build, Python AST parsing and `git diff --check` passed.
  The in-progress global TypeScript run still reported the separately owned
  fleet-update qualification-result and update-readiness v1 fixtures. The shared
  HostNativePort fixture now supplies the required injected witness and its tests
  passed. A stable full checkpoint follows fleet/update migration.

Relevant source: `prepare/operations.ts`, `readiness-cache.ts`,
`qualification-runner.ts`, personal configuration/session-port/runner,
HostNativePort, the native boot adapter and the shared worker
`provider_adapter.py`. Tests validate orchestration and policy with native/file/
session ports injected; their fake witness/GPU values are not installed evidence.

The [official DirectML provider constraints](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)
and [pinned ONNX Runtime 1.24.4 Python implementation](https://github.com/microsoft/onnxruntime/blob/v1.24.4/onnxruntime/python/onnxruntime_inference_collection.py)
were read on 2026-10-09: one session requires serialized Run calls, and async Run
delivers completion through its native callback. No provider migration or new
dependency was introduced.

## Deferred native proof

- [ ] Compile and run the fixed volatile-key/ACL/persistent-key denial checks on
      native x64 Windows 10 22H2 and Windows 11.
- [ ] Verify stability across ordinary helper/app exit and invalidation across
      actual reboot, fast startup, hibernate and hive unload; conservative early
      invalidation must yield requalification rather than fabricated Ready.
- [ ] Test real same-boot ordinal reorder versus reused-LUID restart with the
      actual pinned model; prove GPU placement and output/listening quality separately.
- [ ] Exercise unknown native async completion, process teardown and role guard
      retention on Windows. Injected callback/Job fixtures do not prove driver behavior.
