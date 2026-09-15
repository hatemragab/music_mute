# H02: Prepare the separate CapRover distribution app and safe publication Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** NOT STARTED
**Goal:** Serve installers and immutable releases at updates.music-mute.com without moving worker control into another backend.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** B04, H01

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create worker-distribution/package.json, src/publications.ts, src/artifact-response.ts, src/server.ts, Dockerfile and captain-definition.
- Create worker-distribution/test/publications.test.ts and deployment-package.test.mjs.
- Create worker-distribution/README.md, .env.example and scripts/package-caprover.mjs.
- Add backend/src/worker-releases/distribution-client.ts and focused tests for the configured internal publication interface.

## Interfaces

- Implements /internal/publications and immutable public artifact/trust paths in contracts.md.
- CapRover app name musicmute-worker-distribution; HTTPS domain updates.music-mute.com; persistent directory /data/releases. Existing backend owns release authorization and rollout selection.

## Steps

- [ ] 1. Implement authenticated internal staging with exact declared lengths/digests, bounded streaming, idempotent publication receipts and atomic commit only after every signed asset is verified.

- [ ] 2. Use one small Node/TypeScript HTTP process for authenticated publication and bounded streaming artifact responses behind CapRover's existing reverse proxy. Do not add a second process manager, dashboard, contributor database, job queue or worker auth service.

- [ ] 3. Serve range requests, content lengths, strong ETags and immutable version caching. Mutable bootstrap/trust entries revalidate. Disable directory listing and reject path traversal/symlinks.

- [ ] 4. Enforce internal service auth and configured origin; do not expose a public unrestricted upload API or fetch arbitrary administrator URLs.

- [ ] 5. Prepare CapRover packaging with persistent /data/releases, one initial instance, HTTPS, health checks, upload/download limits, disk monitoring and resumable transfers. The server-side image is for the requested CapRover host only.

- [ ] 6. Define backups of release data and trust metadata, and retention of installed/targeted/stable/in-flight/rollback references. Never use the 30-day log TTL to delete active releases.

- [ ] 7. Test redeploy using an isolated local directory/service, partial upload, invalid signature, publish replay and unavailable origin. Produce deployment instructions without creating the live app or DNS.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: Distribution app is redeployed
  Given a committed release exists in persistent storage
  When a fresh app instance starts using that same storage
  Then its exact immutable bytes and trust metadata remain available
  And no worker rollout policy is changed
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
npm ci
npm test
npm run typecheck
npm run build
node --test test/deployment-package.test.mjs
```

## Completion evidence and limits

Commands run from worker-distribution/ after its scripts are created. Include range/hash/redeploy/publication-auth tests and a reviewable CapRover package.

Same-server disk/bandwidth is shared with other apps. Publishing/deployment is not authorized by implementation or package creation.
