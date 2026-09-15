# B04 execution boundaries

Read `../backend/B04-releases-groups-and-rollouts.md` and `../contracts.md` as requirements. B04 follows B01 before pairing exposure so B05 can enforce admission before machines join through B02.

## Integration

- Reuse `AdminOperationsService.run` for idempotent audited mutations and transactional authority fencing. It fingerprints request/route/action and returns a non-secret receipt on replay. New receipt handling must recover the selected resource without re-executing the mutation.
- Use the existing worker admin permissions (`workers.read` and `workers.manage`) with fresh authentication for publication, stable selection and target/build-floor changes. Keep mobile release records and mobile-only artifact verification separate.
- `ProcessingTransactions` and the existing worker control row are the lifecycle authority. Coordinate target/floor changes with that row; do not invent a second active-assignment slot.
- `RateBudgetService` and `RateLimitKeys` provide bounded fail-closed Redis admission with hashed identities. Do not introduce an unrelated Redis client or plaintext identity keys.

## Distribution dependency

H01/H02 implement the distribution publisher later. B04 can introduce the verified-receipt client and test a real cryptographic or authenticated transport fixture now; it must reject publication while receipt authority is unconfigured or unverifiable. Never add an always-valid development receipt, trust an administrator-supplied checksum alone, or use a caller-supplied fetch URL. Define the exact receipt shape in contracts before implementing its two consumers, and bind the release/build/profile/artifact digest and length/compatible runtime-model state to that receipt.

## Required race semantics

- A confirmed rollout contains the exact deduplicated selection snapshot. Group membership changes never add recipients to an existing rollout.
- Confirmation checks the preview's group, worker and release-policy revisions. A stale selection is rejected rather than silently expanded.
- Stable-new-install selection and published availability never assign updates or raise build floors on unselected workers.
- Pause prevents new activation authorization; it does not claim that already-running activation has stopped. Explicit supersession and fallback decisions must preserve truthful per-worker state.

No distribution deployment, publication, or real database operation is authorized. All integration services and signing fixtures must be local and isolated.

## Review ruling: recipe transitions

Pre-update source compatibility and post-start target identity must be distinct. Add explicit signed source tuples (profile/model/runtime lock, with rollback permission) and OS/architecture to release targets. A source transition is allowed only when the exact currently installed tuple is authorized; running/verified must match the new target exactly. Ambiguous target matches are rejected.

For a permitted reverse transition, the new target's signed source tuple can authorize restoration of the old immutable release without rewriting that old release's metadata. This additionally requires current explicit fallback selection, published status, build-floor compliance, and local state-read compatibility. No implicit cross-profile or cross-platform fallback is permitted.

Cost if this design needs revision: signed receipt/target producers and consumers change together before first publication. Existing source changes are still local, so no migration or compatibility decoder is needed.
