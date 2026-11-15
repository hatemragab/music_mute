# Evidence: W07 — DirectML GPU foundation

- Date: 2026-10-09.
- Scope: source and injected code fixtures on macOS; no Windows machine attached.
- Status: code-complete-Windows-pending for the GPU foundation. W08/W09/W11 integrate these APIs into the app and agent.

## Implementation

- `worker/engine/musicmute_engine/windows_gpu.py`: native x64 detection with IsWow64Process2, DXGI hardware enumeration and DirectX 12 capability probe, deterministic candidate ranking, exact LUID/device/driver receipt identity, ordinal re-resolution and bounded one-attempt-per-candidate qualification. Shared request contract bounds the DirectML ordinal to 0–15. A LUID change after reboot/reset requires qualification, avoiding ambiguous identical GPUs.
- `provider_adapter.py`: request only DirectML, set `session.disable_cpu_ep_fallback=1`, pass `enable_fallback=False` before construction, disable runtime fallback, and reject provider recreation/enabling fallback. Native startup checks refuse software/WARP adapters, and constructor snapshots reject a changing physical device before inference. Execution methods retain their guard after construction. ORT implicitly registers its CPU provider; graph assignment to that provider is prohibited by its pinned configuration. CPU decoding/DSP remains outside this rule.
- `qualification.py`: explicit consumer profile/current SID, selected GPU identity and GPU-only policy; check identity again after inference. Bind exact model/release/fixture/recipe results and observed timings; record DXGI memory limits and one slot. Automatic selection runs complete qualification per candidate and never substitutes CPU. Preferred receipt affects candidate priority only; it does not bypass qualification.
- `benchmark_file.py`: preserve selected ordinal, accept current-user profile/SID and report fallback policy truthfully. Older raw reports lacking the explicit policy remain distinguishable.
- `worker/src/enrollment/report-builder.ts`: consumer receipt context requires approved fixture digest and exact current SID; compare runtime version, GPU/driver and recipe catalog against the verified pinned runtime. No RX 580 or ordinal-zero constraint for the consumer profile. Legacy LocalService validation remains intact.
- `worker/src/enrollment/enrollment-client.ts`: additive `runtime.installationProfile: windows-user`, converted by existing snake_case wire adapter; consumer Windows/x64/DirectML/one-slot validation.
- `runtime-adapter.ts`: explicit `windows-user` adapter selects login-session/current-user ACL behavior; default remains the legacy service adapter. Native ACL checks remain required, as POSIX mode bits cannot establish Windows protection.
- `windows/release-manifest.ts`: profile is part of the hashed inventory. User artifact requires real native helper, session/fleet/personal/prepare agent entrypoints and shared engine/runtime; reject service payloads and unsafe Windows paths. Explicit expected profile prevents service/user artifact adoption. Root W06 wraps the inventory digest in signed artifact metadata.

## Code checks

| Command and working directory                                                                                                                                                       | Result             | Scope                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `../.venv/bin/python -B -m unittest tests.test_provider_adapter tests.test_qualification tests.test_windows_gpu tests.test_benchmark_file tests.test_pipeline` from `worker/engine` | Passed: 45 tests   | Injected sessions/hardware and synthetic pipeline fixtures; no GPU execution                                                       |
| `node_modules/.bin/vitest run tests/runtime-adapter.spec.ts tests/windows-release-manifest.spec.ts tests/enrollment-report.spec.ts tests/enrollment-client.spec.ts` from `worker`   | Passed: 33 tests   | Temporary inventories/reports and injected hardware; no native Windows install                                                     |
| `node_modules/.bin/tsc --noEmit` from `worker`                                                                                                                                      | Passed             | Worker source/type contract                                                                                                        |
| Scoped `oxlint --deny-warnings` on touched TS files/tests                                                                                                                           | Passed             | Touched source lint                                                                                                                |
| Scoped Prettier + `git diff --check`                                                                                                                                                | Passed             | Formatting and whitespace                                                                                                          |
| Expanded Python run including `tests.test_separator`                                                                                                                                | 52 tests, 3 errors | Existing venv lacks `audio_separator`; no tests skipped to hide the missing dependency. Focused suites above passed independently. |

## Native acceptance pending

- Windows 10 build 19045+ and Windows 11 native x64; reject Windows ARM even under x64 emulation.
- NVIDIA, AMD and Intel; integrated/discrete, two adapters, duplicate model cards and changing adapter order.
- Real pinned Kim inference with accelerated placement profiles, zero CPU node placement, valid MP3 and listening comparison.
- Missing/disabled GPU, insufficient memory, device removal, driver update and reboot/LUID changes: fail/requalify or try another GPU with bounded attempts, with no CPU inference.
- Measure elapsed time and process/GPU resource usage on recorded hardware. Current memory fields are capacity limits, not measured peak usage or a minimum-VRAM promise.

## Handoff API

- `runtimePlatformAdapter(host, 'windows-user')` is explicit; omission remains legacy.
- `create/writeWindowsReleaseManifest(root, version, 'windows-user')`; `verifyWindowsRelease(root, 'windows-user')`.
- `parseQualificationEvidence(value, { runtimeProfile: 'windows-user', expectedUserSid, expectedFixtureDigest })`.
- Report creation uses the same context and verifies native runtime/SID/GPU/recipe observations.
- Qualification: `--runtime-profile windows-user --expected-user-sid <native SID> --auto-select`; optional `--preferred-gpu-receipt` is a bounded existing receipt file. Explicit selected ordinal remains available to advanced benchmarks.

## Source references

Checked during this implementation: [DirectML settings/adapter ordinal](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html), [pinned ORT CPU-fallback config](https://github.com/microsoft/onnxruntime/blob/v1.24.4/include/onnxruntime/core/session/onnxruntime_session_options_config_keys.h), [pinned Python constructor/run fallback](https://github.com/microsoft/onnxruntime/blob/v1.24.4/onnxruntime/python/onnxruntime_inference_collection.py), [ORT implicit CPU registration and assignment check](https://github.com/microsoft/onnxruntime/blob/v1.24.4/onnxruntime/core/session/inference_session.cc).

The `zalando-api-guidelines` skill was applied to the optional report wire field. Current official rules 101 (OpenAPI), 104 (security), 106 (compatibility) and 118 (snake_case) shaped the additive change; backend agent owns server/OpenAPI updates. [Official guidelines](https://opensource.zalando.com/restful-api-guidelines/) retrieved during this session. No routes/auth scopes changed in this task.
