# Music Mute worker rebuild: fast MVP branch roadmap

This roadmap keeps stable extension boundaries while delivering one narrow, proven path first. The collection branch is not an implementation milestone; each accepted feature branch merges into it through review.

## 1. Sequential topology

```text
codex/worker-clean-slate                frozen historical baseline
        |
        v
codex/worker-rebuild                    existing collection / PR target
        |
        v
codex/worker-architecture               documentation and contract review
        |
        v
codex/worker-gpu-feasibility            prove Kim on real MVP hardware first
        |
        v
codex/worker-control-plane              minimal durable backend authority
        |
        v
codex/worker-runtime                    supervisor, Python, audio and services
        |
        v
codex/worker-dashboard                  minimum safe fleet administration
        |
        v
codex/worker-integration                complete flow and failure evidence
        |
        v
codex/worker-release-readiness          candidate, packaging and final gates
```

Every completed feature branch opens a PR into `codex/worker-rebuild`. Only after the maintainer accepts and merges it is the next branch created from the accepted collection checkpoint.

After all gates and a separate explicit instruction:

```text
codex/worker-rebuild → final release PR → main
```

No implementation branch pushes directly to `main` or the frozen clean-slate branch. Installation is part of the validated runtime branch. Automatic fleet updates are post-MVP; see [POST-MVP.md](POST-MVP.md).

## 2. Branch parents and outputs

| Branch | Parent checkpoint | Main output | Task |
| --- | --- | --- | --- |
| `codex/worker-architecture` | Current accepted collection | Approved contracts and MVP boundaries | [01](tasks/01-worker-architecture.md) |
| `codex/worker-gpu-feasibility` | Accepted architecture | Real CoreML/DirectML Kim evidence and pins | [02](tasks/02-worker-gpu-feasibility.md) |
| `codex/worker-control-plane` | Accepted feasibility | Enrollment, claims, leases, S3 and minimal APIs | [03](tasks/03-worker-control-plane.md) |
| `codex/worker-runtime` | Accepted control plane | Supervisor, Python pipeline and platform services | [04](tasks/04-worker-runtime.md) |
| `codex/worker-dashboard` | Accepted runtime | Minimum enrollment/status/control UI | [05](tasks/05-worker-dashboard.md) |
| `codex/worker-integration` | Accepted dashboard | End-to-end, failure and security evidence | [06](tasks/06-worker-integration.md) |
| `codex/worker-release-readiness` | Accepted integration | Versioned candidate and final evidence | [07](tasks/07-worker-release-readiness.md) |

All PRs use `codex/worker-rebuild` as their base. A feature branch begins from the exact accepted collection tip after the preceding merge, not independently from `main`.

## 3. Checkpoints

### A. Architecture: documentation only

- [x] **A1:** Reconcile architecture documents with the current repository and public contracts.
- [x] **A2:** Freeze machine/supervisor/child boundaries, identity, attempts, leases, S3 and protocol invariants.
- [x] **A3:** Freeze the narrow MVP recipe, platform targets, trust model, installation boundary and post-MVP list.
- [x] **A4:** Approve the updated manifest, tests, risks and handoff to feasibility.

### B. GPU feasibility

- [x] **B1:** Build a reproducible model/provider probe with valid output checks.
- [x] **B2:** Prove or block native M4/CoreML Kim execution.
- [x] **B3:** Prove or block Z440 RX 580/DirectML Kim execution.
- [x] **B4:** Freeze only proven package/model pins and declared MVP support.

### C. Control plane

- [x] **C1:** Add persistence, versioned protocol validation, indexes and authorization boundaries.
- [x] **C2:** Add enrollment, restricted installation, activation, pause and revocation.
- [x] **C3:** Restore guarded admission and idempotent capability-matched atomic claims.
- [x] **C4:** Add leases, attempt fencing, cancellation, bounded retry and recovery.
- [x] **C5:** Add exact-version S3 grants and idempotent finalization/usage/cleanup.
- [x] **C6:** Add minimum machine/status/policy APIs without making transient transport authoritative.

### D. Runtime and installation

- [x] **D1:** Implement the Node supervisor and bounded Python child protocol.
- [ ] **D2:** Implement and verify the versioned Kim recipe family and processing order.
- [ ] **D3:** Implement polling, ownership, renewal, recovery and S3 execution.
- [ ] **D4:** Package and prove the accepted Mac runtime as a system service.
- [ ] **D5:** Package and prove the accepted Windows runtime as a system service.
- [ ] **D6:** Verify local safety, one-job capacity and future provider/platform adapter boundaries.

### E. Dashboard

- [ ] **E1:** Add protected navigation and a minimal machine list.
- [ ] **E2:** Add one-use enrollment and installation-status UX.
- [ ] **E3:** Add machine detail, current work and recent bounded diagnostics.
- [ ] **E4:** Add safe machine controls, typed operations, capacity, and pipeline policy.
- [ ] **E5:** Complete permissions, contract, accessibility and adverse-state tests.

### F. Integration

- [ ] **F1:** Prove complete app/API/S3/worker/result flow.
- [ ] **F2:** Prove ownership, concurrency, expiry and recovery invariants.
- [ ] **F3:** Prove cancellation, account deletion, policy and finalization races.
- [ ] **F4:** Prove real background-service behavior on declared platforms.
- [ ] **F5:** Complete security and resilience scenarios.
- [ ] **F6:** Reconcile A–F evidence and unsupported-platform claims.

### G. Release readiness

- [ ] **G1:** Freeze the exact supported scope and candidate commits/artifacts.
- [ ] **G2:** Validate immutable packaging, fresh install, repair, manual update and rollback.
- [ ] **G3:** Complete security, privacy, secrets and license review.
- [ ] **G4:** Run final real-hardware acceptance on every declared MVP platform.
- [ ] **G5:** Complete release evidence, operator handoff, feature-flag and rollback plan.

## 4. Exact Git workflow

### Start architecture from the existing collection

```sh
git fetch origin
git switch codex/worker-rebuild
git pull --ff-only origin codex/worker-rebuild
git switch -c codex/worker-architecture
```

Before editing, record the collection SHA, inspect status, confirm the branch parent, and complete the secret/local-artifact preflight in [AGENT-RULES.md](AGENT-RULES.md).

### Finish each branch

1. Complete only its task file and checkpoint evidence.
2. Run the required validation and review the explicit staged paths.
3. Commit and push the feature branch.
4. Open/update its PR with base `codex/worker-rebuild`.
5. Stop for maintainer review. Do not merge or begin the successor.

### Start a successor after acceptance

Expected strategy is a regular merge commit preserving branch ancestry.

```sh
git fetch origin
git switch <accepted-previous-branch>
git merge-base --is-ancestor HEAD origin/codex/worker-rebuild
git merge --ff-only origin/codex/worker-rebuild
git switch -c <next-branch>
```

This gives the successor the exact accepted collection state, including reviewed merge resolutions. If history was squash/rebase merged or the ancestry check fails, stop and reconcile rather than guessing or forcing.

## 5. MVP and extension boundary

The MVP proves one durable path: trusted enrollment, a validated GPU/provider, one safe active job per worker slot, exact-version S3 transfers, attempt leasing/fencing, the fixed initial audio path, minimum administration, platform service operation, recovery and manual rollback.

Extension fields and adapters may exist only where they make the first implementation clearer and testable. Do not implement speculative frameworks. This sequence explicitly moves only automatic fleet-update orchestration to [POST-MVP.md](POST-MVP.md); all other scope follows the accepted architecture until separately revised.

## 6. Handoff per branch

Each branch maintains one checkpoint report using [the template](templates/CHECKPOINT-REPORT.md), containing:

- parent and tested commit;
- delivered behavior and files;
- tests actually run and environment/hardware class;
- `PASS`, `FAIL`, `NOT_RUN`, `BLOCKED` or `SIMULATED` results;
- security/compatibility review;
- unresolved limitations and impact;
- next branch, which remains unauthorized until maintainer acceptance.
