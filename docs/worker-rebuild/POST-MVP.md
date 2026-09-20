# Post-MVP extension backlog

The simplified branch sequence makes one explicit scope decision: installation belongs in `codex/worker-runtime`, while automatic fleet-update orchestration is deferred until after MVP. This file does not silently defer any other capability described by the accepted architecture; those decisions remain subject to their own review.

## Automated fleet updates

- Signed release manifests and trusted-key rotation.
- Dashboard-selected canary rollout and capacity-aware draining.
- Automated activation health checks and local rollback.
- Rollout pause/abort, compatibility windows, update telemetry and authorized downgrade policy.

The first implementation of automatic fleet updates requires its own approved scope, tests, evidence, migration/compatibility review, and branch plan.
