# MusicMute backend security and cost roadmap

**Focus:** launch-safe user management, account limits, S3 cost control, abuse
prevention, and MongoDB/Redis protection.

## Purpose

Keep the launch work simple and divided into five areas. Each area has its own
sequential branch and detailed checklist under
[docs/backend-security/](backend-security/START-HERE.md).

## 1. Account quotas and administrator controls

Replace the old quota behavior with one account-only standard plan: 120 successful
processing minutes per UTC calendar month. Administrators can change global policy
or one account's replacement values with an optional expiry. Usage remains clear,
atomic, and auditable.

## 2. Media and AWS S3 cost protection

Use one 20-minute/50-MB media policy. Bound upload requests and confirmed bytes,
download grants and estimated bandwidth, retained output storage, and service-wide
outbound cost. Keep audio private, use short-lived exact grants, clean temporary
objects, and retain successful results through S3 Intelligent-Tiering until the
user deletes them.

## 3. Job queue, retries, and refunds

Allow one processing job and three waiting jobs per account. The backend selects
the oldest eligible queued job. Infrastructure failures receive bounded no-cost
retry and a full processing-minute refund when terminal; client/input attempts are
also bounded.

## 4. Account abuse and API limits

Reuse the existing Redis/IP/UID rate-limit foundation, add compact typed events,
and let authorized administrators manually restrict or restore an account. Keep
MongoDB and Redis growth bounded. Device-based enforcement and automatic bans are
deferred.

## 5. Account deletion and permanent cleanup

Use a fifteen-day recovery period. During grace, prevent new cost-bearing work.
After the deadline, permanently and resumably remove owned MongoDB data, S3 audio,
installation ownership, and Firebase identity while retaining only a minimal
non-personal completion record.

## Boundaries

This roadmap does not include worker rebuilding/security, machine management,
scaling, backups, disaster recovery, paid plans, device quotas, or automatic bans.
Provider-console work is documented for the operator and is not executed by code
branches.

## Execution

Start at [backend-security/START-HERE.md](backend-security/START-HERE.md). Follow
the exact branch order, checkpoint evidence rules, and test gates. A branch must be
reviewed and merged into the collection before the next branch is created.
