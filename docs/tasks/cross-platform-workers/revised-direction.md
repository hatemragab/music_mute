# Revised direction: light fleet v1

**Date:** 2026-09-15
**Status:** Supersedes the task register in [README.md](README.md) wherever they conflict. No source change is authorized by this file.
**Owner decision:** "i need a light multi cross workers remove the complex things please make it light i need to go up not waste a lot of time in development"

## Short version

Cut the fleet pack down to what is needed for a real contributor machine to install, pair, claim, process and report. Everything else is deferred, not deleted.

The complexity in this pack is mostly in work that is **not built yet**. B01–B06, W01–W04 and the reviewed part of I01 already exist and passed independent review; deleting them would be pure loss. So this revision stops building new complex things and leaves finished work alone.

## v1 scope — active

| Task | State | v1 role |
| --- | --- | --- |
| F01 | in progress | Matrix cut to 4 profile entries across 3 families; native evidence still open |
| B01–B06 | locally reviewed | Keep as-is. Backend authority is done |
| W01, W02 | locally reviewed | Keep as-is. Shared core and GPU runtime are done |
| I01 | in progress | Finish. Last blocker before any real install |
| I02, I03, I04 | not started | Build all three, macOS first — it is the only adapter provable on local hardware |
| D01 | not started | Minimal pairing and approval UI. Required for an administrator to approve a code |
| F02 | not started | First-machine end-to-end spike. Gates launch |
| H01-light | not started | Redefined: build a per-platform tarball plus SHA-256, publish manually. See below |

## v1 scope — deliberate cuts

| Cut | Replacement in v1 |
| --- | --- |
| **W03/W04 wiring** — TUF signed downloads, activation journal, rollback | Code stays in the tree, reviewed and untouched. Not wired into I01, not packaged by H01. Updates become "tell the operator to reinstall". Flip on later at zero cost |
| **H01 signing ceremony** — online/offline TUF root, notarization, rotation | Tarball + SHA-256 digest + manual upload. Signature/integrity still checked by hash |
| **H02** — entire CapRover `worker-distribution` app and `updates.music-mute.com` | Serve the tarball from hosting that already exists. The installer already verifies a digest |
| **D02** — groups, rollout preview/confirm, revision CAS screens, pause/retry | B04's backend stays. v1 runs whatever is installed. No rollout UI |
| **D03** — rich event timeline, filters, retention UI | v1 shows worker online/offline and last job only. B03 still stores and retains the full event history, so the UI can be added later without backend work |
| **V01** — formal hardware matrix qualification | Folded into F02. A profile is proven when a real machine ran it, recorded in the F02 report |
| **V02** — fleet fault/race suite | Folded into F02 plus basic smoke checks |
| **V03** — deployment ceremony | Folded into F02. Launch is: install on the machines, pair, run |

Also cut: the 12-profile GPU matrix. See the supported set below.

## Supported GPU set (F01 matrix cut)

**Supported — 4 profile entries, 3 families:**

| profileId | Family |
| --- | --- |
| `windows-x64-directml-nvidia-ort-1.24.4` | Windows DirectML |
| `windows-x64-directml-amd-ort-1.24.4` | Windows DirectML |
| `macos-arm64-coreml-ort-1.24.4` | macOS CoreML |
| `linux-x64-cuda-nvidia-ort-1.26.0` | Linux CUDA |

**Unsupported — 8 entries, with the reason each is excluded:**

| profileId | Reason |
| --- | --- |
| `windows-x64-directml-intel-ort-1.24.4` | Intel iGPU DirectML is low-value for this workload; not worth a lock and driver floor |
| `windows-x64-cuda-nvidia-ort-1.26.0` | Duplicate of the DirectML NVIDIA path on the same hardware |
| `macos-x64-coreml-intel-ort-1.24.4` | **Dead:** no ONNX Runtime 1.24.4 macOS x64 wheel exists |
| `linux-x64-migraphx-amd-ort-1.23.2-rocm-7.2.1` | ROCm/MIGraphX version pair unproven and an outsized support burden |
| `linux-x64-openvino-intel-ort-2025.2.0` | Intel GPU path unproven; low value for this workload |
| `linux-arm64-armnn-source-candidate` | **Dead:** vocabulary-only, rejected outright at runtime preparation |
| `linux-arm64-cuda-nvidia-jetson-candidate` | Jetson wheel/driver stack unproven |
| `windows-arm64-directml-qualcomm-candidate` | No viable dependency wheels |

This narrows R03. R03's "no CPU-only inference" rule is unchanged and still enforced by B05 and W02. The design spec's "do not silently reduce the scope" instruction is satisfied by recording every exclusion above with its reason rather than dropping it quietly.

Implementing the cut means editing `worker/qualification/candidates.json` and `evidence/hardware-matrix.md`. **That is a source change and waits for explicit authorization.**

## Why not delete the finished complex code

W03 and W04 passed independent review after multiple fix rounds, including two real defects the reviewer reproduced (future-dated queued timestamps after clock correction; a runtime mutation corrupting the durable transaction). That work is done. Ripping it out now costs deletion effort, loses its test suite, and buys nothing that deferring does not already buy.

The saving comes from **not building** D02, D03, H02, V01–V03, and from **not packaging** the update path. It does not come from removing what exists.

## Recommended execution order

1. **I01 closeout** — native host registration, then the two open gates (native `Retry-After` persistence, aggregate spool bound).
2. **I03 macOS** — provable on local hardware; reuses the existing CoreML smoke evidence.
3. **I02 Windows**, then **I04 Linux** — same adapter interface, run on the real machines.
4. **D01** minimal pairing UI — needed before a real approval can happen.
5. **H01-light** — tarball plus digest.
6. **F02 spike** — the gate. One machine, full loop, real job.
7. **Fleet v1 launch** on the machines that passed F02.

F02 cannot run before I01 and at least one adapter. An earlier draft placed it at wave 1 with no dependencies; that was incorrect and is fixed in the [F02 task file](foundation/F02-first-machine-end-to-end-spike.md).

## What this revision does not change

- **No migration, backfill, compatibility bridge or legacy decoder.** Unchanged and still binding.
- **No data deletion.** Unchanged. Incompatible development state is reported, not erased.
- **No commits, pushes, publication or deployment** are authorized by this file or any other.
- **Evidence discipline.** A task is complete only with layer-appropriate evidence. F02 proves one machine on one platform; it does not qualify a profile across hardware.
- **Unresolved and still blocking launch:** Kim Vocal 2 redistribution permission. A tarball cannot legally ship the model bytes until this is settled. Nothing in this revision addresses it.
- **Unresolved:** contributor audio trust. The design already states that neither pairing nor software checks prove an owner cannot inspect the audio they process. v1 does not fix this and should not be described as if it does.