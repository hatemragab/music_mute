# B05 lifecycle integration handoff

Read `../backend/B05-claim-gates-and-qualification.md` and the shared contracts as requirements.

B01 deliberately records reported runtime and boot state without granting claim permission. Its `installation-ready` transaction touches the existing control fence. Its ordinary `store` path writes runtime observations but does not fence the control row, because B01 has no approved admission state yet.

When B05 starts consuming runtime state for claims, close that concurrency boundary explicitly. Material eligibility changes (build/profile/model/runtime lock/activity/service conditions, qualification, update hold and policy) must serialize against claims using the existing control fence or a runtime-row fence inside the claim transaction. A snapshot read of runtime alone does not make an unrelated runtime write conflict with a claim. Unchanged periodic telemetry can stay lightweight; neither telemetry nor a worker readiness update should increment dashboard `managementRevision`.

Add a compiled concurrent integration case that races a material runtime disqualification with a fresh claim and proves the claim cannot succeed using invalidated readiness. Keep current owned-attempt heartbeat, terminal cleanup and recovery routes available under their explicit lifecycle rules, including when a new build floor prevents another fresh claim.

All F01 candidates remain unavailable until full artifact/native qualification. B05 must reject those candidates without a permissive test-only or development fallback in production code. Tests can create explicit authority-owned qualified fixtures in isolated databases.

## B04 policy handoff

Use the exported `WorkerUpdatePolicy` and `ReleasePolicy` models inside the existing claim transaction; do not invoke `getUpdateDecision` as a nested separate transaction. Per-worker target/pause/floor mutations touch WorkerControl. Publication/withdrawal touches ReleasePolicy, so admission must also fence the release availability it relies on. B04's `WorkerRuntime.rolloutFence` provides a runtime-row write boundary for compatibility changes.

Publication is not itself qualification. B04's artifact receipt initially binds code/runtime/model metadata but does not independently supply provider execution, fixture identity, media limits or native evidence approval. B05 must establish an explicit authority-owned approved-profile descriptor bound to the signed artifact/release (extending the new unpublished receipt contract directly if needed), then compare the installation's persisted qualification report to it. Do not silently infer `published => GPU qualified` or trust a contributor's accelerator flag as offline approval.

Since B05 precedes B02, place any qualification-report storage/evaluation needed by both in an exportable service/model and document the API for B02's installation-token controller. B02 will provide authenticated installation ownership and pairing; do not expose an unguarded qualification route as a shortcut.
