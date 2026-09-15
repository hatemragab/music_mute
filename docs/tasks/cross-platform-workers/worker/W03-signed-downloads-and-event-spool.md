# W03: Build independent update verification and durable event reporting Implementation Plan

> **For agentic workers:** When implementation is separately authorized, use superpowers:executing-plans task by task. This file authorizes no commits, pushes, publishing, deployment, or real data changes.

**Status:** LOCALLY REVIEWED — [implementation and fix evidence](../evidence/W03-report.md), [independent review](../evidence/W03-review.md), and [real isolated spool/backend integration](../evidence/W03-spool-backend-integration.md). Native boot, trust publication and downstream integration gates remain open.
**Goal:** Keep signed downloads and reporting usable even when the separation environment is broken.
**Architecture:** Follow the shared-core/native-adapter boundaries and existing lifecycle authority.
**Tech Stack:** Existing NestJS/TypeScript, Python, React, native OS tools, and signed static artifacts as applicable.
**Spec:** [Approved design](../../../superpowers/specs/2026-09-13-cross-platform-worker-fleet-design.md)
**Dependencies:** W01, B03, B04

## Global constraints

Read [execution rules](../README.md) and [contracts](../contracts.md). All R01–R18 constraints apply. New paths below are proposed files, not claims of implementation. Preserve unrelated work and current ownership journals. No production access in tests; native GPU/boot proof is distinct from mocks.

## Files and responsibility

- Create worker/musicmute_worker/update/trust.py, download.py, policy.py and worker/musicmute_worker/events.py.
- Create a separate minimal launcher dependency lock that includes the chosen maintained TUF client.
- Create worker/tests/test_update_trust.py, test_update_download.py and test_event_spool.py.
- Modify launcher configuration and private cache layout; do not install updater dependencies into the GPU environment.

## Interfaces

- Produces ReleaseVerifier.resolve/verify_artifact and EventSpool.append/upload_pending from contracts.md.
- Consumes UpdateDecision, signed TUF metadata, configured distribution origin and installation/permanent authenticated event clients.

## Steps

- [ ] 1. Implement TUF trust-root continuity, expiry/version/hash checks, bounded metadata and target lengths, and safe key rotation using the maintained client rather than custom signature parsing.

- [ ] 2. Bind downloads to configured HTTPS origin, target digest and length; resume with range/ETag checks and restart safely when content identity changes.

- [ ] 3. Confine extraction, reject traversal/symlinks/unexpected files/decompression overflow and verify disk headroom for both active and staged environments.

- [ ] 4. Persist spool entries before transmission, preserve installation scope across pairing, redact through a shared allowlist and enforce size/age/priority rules.

  Use B03's server UTC response to correct contributor clock skew before first
  event submission, including events queued before registration. Once an event is
  accepted or its result is uncertain, keep its content immutable for retries.
  Correct an explicitly rejected future-clock event only when the response proves
  that the batch was not persisted. Handle future-clock and
  expired-event reasons explicitly without silently dropping setup diagnostics;
  test fast/slow clocks, restart persistence and the exact 30-day boundary. See
  [B03 retention ruling](../evidence/B03-execution-brief.md#retention-retry-boundary-ruling).

- [ ] 5. Retry network failures with jitter, respect Retry-After, deduplicate by eventId and expose dropped-event counts. Disk-full/reporting errors cannot erase the job journal.

  Coalesce unchanged progress before batching and honor B03's server-receipt
  minimum interval. Preserve failure/terminal events and handle an atomically
  rejected mixed batch by safe splitting/coalescing, not dropping its terminal
  records. Accepted duplicate retries must keep their exact payloads.

- [ ] 6. Keep artifact caching separate from log TTL and retain assets referenced by active, prepared and permitted rollback releases.

- [ ] 7. Prove imports, policy fetch and reporting work with a deliberately broken GPU environment. Reject untrusted metadata before executing downloaded code.

- [ ] 8. Run the listed checks, inspect the exact diff, and record evidence and unresolved limits. Leave the task uncompleted if required proof is missing.

## Behavioral acceptance fixture

Encode this scenario and the edge cases named in the steps in the listed tests before implementation. It is an expected outcome, not an executed test.

```gherkin
Scenario: GPU package import is broken
  Given the active separation environment cannot import ONNX Runtime
  When the stable launcher starts
  Then it can report the safe failure and fetch a verified repair release
  And it does not import that broken GPU package itself
```

## Validation commands

Commands reference files introduced by this task or its dependencies. Backend commands run from backend/; dashboard commands from dashboard/; Python/native commands from the repository root unless explicitly qualified. Existing native integration helpers must create isolated services.

```sh
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_update_*.py' -v
PYTHONPATH=worker python3 -m unittest discover -s worker/tests -p 'test_event_spool.py' -v
```

## Completion evidence and limits

Trust corruption/expiry/rotation fixtures, interrupted transfers, confined extraction, durable redacted spool and launcher independence.

First installation still trusts the published bootstrap delivery origin; provide a verifiable download alternative and do not claim TUF can validate a bootstrap before it first executes.
