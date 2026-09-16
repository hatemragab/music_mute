# Worker Rebuild Branch Workflow

## Purpose

The worker system will be redesigned and rebuilt in explicit stages. Each stage
must be reviewed and accepted before implementation continues into the next
stage. The existing Python audio-separation implementation may be reused later,
but it does not determine the control-plane, protocol, pairing, or platform
architecture.

## Branch flow

```text
codex/worker-clean-slate
        ↓
codex/worker-architecture
        ↓
codex/worker-control-plane
        ├── codex/worker-dashboard
        └── codex/worker-shared-runtime
                  ├── codex/worker-linux
                  ├── codex/worker-windows
                  └── codex/worker-macos

All completed branches
        ↓
codex/worker-integration
        ↓
codex/worker-release-readiness
```

## Stage responsibilities

### `codex/worker-clean-slate`

The worker-free baseline. It contains no active worker fleet, pairing,
machine-management, or execution protocol implementation.

### `codex/worker-architecture`

Documentation and approved decisions only. It defines technology choices,
system boundaries, pairing, machine identity, security, protocol versioning,
job lifecycle, failure recovery, capability matching, storage flow,
observability, updates, data design, API contracts, dashboard behavior, and
delivery phases. No production worker implementation starts here.

### `codex/worker-control-plane`

Implements the approved database migrations, backend models, machine identity
and authentication, pairing APIs, job assignment, health and heartbeat
handling, capability matching, revocation, recovery behavior, and backend
tests.

### `codex/worker-dashboard`

Starts from `codex/worker-control-plane`. Implements administrator-facing
pairing, approval, revocation, machine status, capabilities, health, job
visibility, and operational controls.

### `codex/worker-shared-runtime`

Starts from `codex/worker-control-plane`. Implements only cross-platform worker
behavior: protocol client, authentication, heartbeats, job acquisition,
download and upload, cancellation, retries, recovery, configuration, logging,
and the shared boundary around audio separation.

### Platform branches

`codex/worker-linux`, `codex/worker-windows`, and `codex/worker-macos` all start
from `codex/worker-shared-runtime`. They contain only platform-specific service
management, secure credential storage, filesystem integration, hardware and
accelerator discovery, packaging, installation, upgrades, and qualification.

Platform branches must not depend on one another. Physical machines do not get
their own branches; machines are registered instances with individual identity
and capability data.

### `codex/worker-integration`

Combines the accepted control plane, dashboard, shared runtime, and platform
branches. It proves end-to-end protocol compatibility, job ownership,
cancellation, retries, restart recovery, offline handling, and cross-platform
behavior.

### `codex/worker-release-readiness`

Completes installer and upgrade validation, security review, recovery testing,
cross-platform qualification, operational documentation, and release evidence.

## Working rules

- A later stage begins only after the previous contract is approved.
- Every implementation branch includes its own focused tests.
- Database migrations belong to the control-plane branch.
- Shared protocol and runtime behavior never belongs in a platform branch.
- Platform-specific behavior never leaks into the shared protocol.
- Machine credentials are unique, revocable, and never shared across machines.
- The worker protocol is versioned before multiple platforms implement it.
- Platform work converges through the integration branch before release claims.
- Source tests do not prove native GPU, installer, service, or production
  readiness; those require platform qualification evidence.
