# W09 — Worker Advanced status and execution verification

Reviewed and code-tested 2026-10-10 on macOS arm64. No Windows helper, model,
DirectML, fleet enrollment, network control plane or Electron app was executed.

## Receiving source and authority

[Main](../../../windows-desktop/src/main/main.ts) passes its real
`WindowsPreparationOperations` to
[createWindowsFleetAdvanced](../../../windows-desktop/src/main/fleet/advanced/factory.ts).
That factory now requires both `snapshotReadyStatus` and `snapshotReady`; there
is no optional full-hash fallback for a missing or failing status port. The
[inspection adapter](../../../windows-desktop/src/main/fleet/advanced/inspection.ts)
likewise requires separate `readyStatus` and `ready` ports.

| Entry                                               | Verification and remaining authority                                                                                                                                                        | Portable proof                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Versions, quick Doctor                              | Authenticated readiness capsule/file fingerprints through `snapshotReadyStatus`; current SID/boot, approved fleet overlay, actual GPU/driver and exact owned runtime checks remain in place | Inspection fixture reads all ordinary sections with a full-verifier failure installed; zero full calls. Quick status attestation failure stays failed, without full fallback               |
| Logs, job, errors, explanation, performance, status | Existing bounded retained local publications/investigation and authenticated Session/native birth/Job checks; no full inventory/model reads introduced                                      | Existing history/redaction/ownership fixtures plus the operation-count case                                                                                                                |
| Capacity report                                     | Status attestation validates the existing local hash-bound capacity receipt and current fleet/GPU/model/fixture identity. Cached backend policy remains explicitly non-current              | Real test-owned receipt bytes are read and hashed; report validates two local slots with one status call and zero full calls                                                               |
| Explicit full Doctor                                | Full `snapshotReady` plus explicit full model integrity verification. No live model inference is claimed                                                                                    | Full-port rejection is requested exactly once and reports failed; the cheap port is not substituted                                                                                        |
| Benchmark or two-worker capacity mutation           | Existing full `snapshotReady` remains mandatory before child/receipt/backend effects; genuine maintenance and guarded inference are unchanged                                               | Receiving controller rejects changed full bytes before benchmark ownership or HTTP. A previously valid capacity report cannot authorize mutation against failing current full verification |
| Enrollment, fleet refresh/recovery, update/restore  | Existing execution paths keep their full verification defaults; this return changes only ordinary inspection/capacity-report reads                                                          | Scoped source/diff review; adjacent task suites preserve these paths                                                                                                                       |

The cheap status path remains a truthful observation, never GPU admission or a
new qualification receipt. Explicit one-worker reduction, ordinary Stop and
credential retirement retain their existing semantics; this change adds no
model requirement merely to stop/reduce work.

## Meaningful fixtures and checks

- [fleet-advanced-status.test.ts](../../../windows-desktop/tests/fleet-advanced-status.test.ts)
  runs the actual factory/controller with real temporary-file receipt bytes,
  receipt SHA and existing capacity identity/parser. Native/Session ports are
  explicit synthetic boundaries. It proves capacity report status-only reads
  and full-verification refusal before any mutation HTTP effect.
- [fleet-advanced-inspection.test.ts](../../../windows-desktop/tests/fleet-advanced-inspection.test.ts)
  covers every ordinary read, full Doctor, no fallback, missing readiness,
  retained history, redaction, exact runtime birth/Job membership and changed
  current witness/driver refusal.
- [fleet-advanced-authority.test.ts](../../../windows-desktop/tests/fleet-advanced-authority.test.ts)
  executes ordinary reads then reviewed benchmark dispatch against a failing
  full verifier, preserving the recovery journal and zero benchmark/HTTP effects.
- Existing composition/purge fixtures explicitly implement the new required
  status port; no fake optional fallback was added to production.

Commands from `windows-desktop/`:

```sh
npm test -- tests/save-destinations.test.ts tests/library-export.test.ts tests/library-export-fault-matrix.test.ts tests/fleet-advanced-status.test.ts tests/fleet-advanced-inspection.test.ts tests/fleet-advanced-authority.test.ts tests/fleet-advanced-composition.test.ts tests/fleet-advanced-purge.test.ts tests/fleet-advanced-benchmark.test.ts tests/fleet-advanced-candidate.test.ts tests/fleet-advanced-exports.test.ts tests/benchmark-export.test.ts
npm run typecheck
npm run lint
```

At **01:45:38**, **98 tests / 12 files passed** in the combined scoped slice;
counts include independent W04 export fixtures and overlap earlier checkpoints.
TypeScript passed; lint checked **499 files** with zero warnings/errors. Whole
component formatting, source build and both renderer/preload bundle-boundary
fixtures subsequently passed. The four scoped task/evidence documents validated
**76 local references**. Later combined checks retain their own actual checkpoint,
rather than being inferred from these cases.

## Deferred Windows acceptance

- [ ] Real NTFS fingerprints/ACL/reparse/private receipt and current-witness
      enforcement, actual owned process/Job and GPU/driver enumeration.
- [ ] Measured repeated Worker Advanced panels/windows share attested status
      without model/inventory hashing; explicit full integrity checks still hash.
- [ ] Actual qualified GPU benchmark/capacity mutation and backend permission
      intersection on the named supported Windows machine.

This closes the Advanced ordinary-status source gap only. Broader W09 sharing,
instrumentation and native acceptance remain tracked in W09 and peer evidence.
