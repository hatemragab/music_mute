# W11 fleet current-GPU control receiving return

2026-10-10, macOS arm64, source/typed fixtures only. No Windows helper, hardware,
GPU/model, real enrollment, account, worker claim or network was executed.

[Owned fleet child](../../../windows-desktop/src/agent/fleet.ts) constructs its
WorkerRuntime from full verified release/model/approved fixture qualification and
the current accepted GPU overlay. The runtime publishes that resolved identity
in `fleetGpuIdentities`. Before this return its real `FleetRoleControl` compared
incoming guard requests to the immutable original enrollment GPU LUID. A genuine
cross-boot qualified rebind could therefore use one GPU in the worker and be
refused by its control channel.

The actual receiver now calls `createQualifiedFleetRoleControl` with the runtime's
published resolved identity. An absent identity fails `FLEET_GPU_INVALID` before
the control exists. The original enrollment report, approval, credential, worker/
machine ID, capacity and saved intent remain unchanged. Actual guard acquisition
still re-enumerates/checks the qualified GPU and release still requires positive
inference cleanup; no CPU or privileged fallback was added.

The [focused fixture](../../../windows-desktop/tests/fleet-qualified-role.test.ts)
composes the real
[operational identity resolver](../../../windows-desktop/src/main/fleet/active-runtime.ts)
with the real
[guard command receiver](../../../windows-desktop/src/main/fleet/role-control.ts).
It supplies explicit synthetic current-witness/native GPU replies and guard
leases; it does not claim native enforcement. It proves:

- A fresh accepted cross-boot overlay binds the actual new LUID/driver. The old
  enrollment LUID is refused before guard effects; original record is immutable.
- Same qualified LUID can remap to the actual current enumeration ordinal.
- Stale witness/driver/hardware/LUID cannot produce operational control authority.
- A missing published runtime GPU fails closed. Failed guard release keeps the
  held guard until the exact release succeeds.

Executed from `windows-desktop/`:

- `npm test -- tests/fleet-qualified-role.test.ts tests/fleet-admission.test.ts
tests/fleet-active-runtime.test.ts tests/fleet-runtime.test.ts
tests/admission-role-composition.test.ts`: **45 passed / 5 files, 02:32:00**.
- Scoped lint on the two changed files, scoped formatting and source build passed.
- Whole TypeScript at that moving snapshot failed only the separately edited
  Share cleanup parameter/optional-method fixture. It is not claimed passed here;
  the earlier pre-return whole TypeScript checkpoint is dated separately.
- The subsequent whole TypeScript passed at the 02:37:56 check. Fleet receiving
  and fresh shared-extension stage/Setup/trust slice passed **64 / 9 files**;
  this includes the same five Fleet files and is not an additive/native result.

The Session admission reader/per-LUID broker receiving return is owned separately;
this narrow return does not mark the whole W11 task complete. Current native guard,
accepted drain, helper/controller crash, cross-boot/reorder and real multi-adapter
behavior remain W34 proof. No immutable approval or live policy was changed.
