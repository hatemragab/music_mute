# SEN-01 — Configuration, privacy, and event contract

Status: TODO. Priority: P0. Dependencies: none.

## Work

- Confirm the proposed six-project layout, hosting region, organization, retention,
  event budget, operational owner, and alert destination. Inventory DSNs without
  writing private management/upload credentials to source. Provision only under
  a later explicit execution request.
- Pin SDK/plugin versions compatible with Node 24 ESM, NestJS 11, Python 3.13/3.12,
  AGP 8.13.2/Kotlin 2.2.20, Swift/iOS 17 minimum, React 19, Router 8, and Vite 8.
  Record dependencies/licenses and tested compatibility rather than selecting
  every package's latest version blindly.
- Turn [DESIGN.md](../DESIGN.md) into equivalent typed component options and safe
  example configuration. Keep the adapters local to their components.
- Define eligible errors and reporting ownership. Establish approved tags,
  context bounds, deduplication/rate limits, disabled defaults, queue limits,
  flush deadlines, and restart/build semantics for disabling telemetry.
- Create synthetic fixtures for nested JWTs, bearer headers, cookies, signed S3
  queries, enrollment codes, database URIs, email, media names, POSIX/Windows user
  paths, Python locals, and `NSError.userInfo`. Use invented data only.
- Review SDK event channels and default integrations, including native crash
  reports and sessions. Decide how linked diagnostic IDs and queued reports fit
  logout, account deletion, retention, and privacy disclosures.
- Document runtime DSNs versus build-only upload tokens. Choose an existing
  release runner and secret storage approach; do not add CI infrastructure merely
  because a Sentry example assumes it.

## Acceptance

- [ ] All component settings have defaults, validation, ownership, and disable semantics.
- [ ] A configuration with no DSN performs no Sentry network request.
- [ ] Synthetic serialized-envelope tests establish the common privacy contract.
- [ ] Runtime packages cannot contain a Sentry upload/auth token.
- [ ] Open account inputs are recorded; no external setup is claimed without evidence.

## Handoff

Update the design with selected versions/options and decisions, then enable
SEN-02–07 implementation. Keep rollout and source upload authorization separate
from local SDK work.
