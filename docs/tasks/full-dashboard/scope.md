# MusicMute dashboard scope

The private React + TypeScript + Vite dashboard administers the current NestJS
API. It is an operations console, not a public application.

## Included areas

- overview metrics and bounded exports;
- retained job history, cancellation, and deliberate media access;
- users, processing access, allowances, and account recovery;
- releases, APK verification, publication, and update policy;
- administrator access;
- basic processing admission settings;
- health alerts and audit history.

The API derives permissions from the stored administrator role. Current roles are
`owner`, `release_manager`, `support`, and `viewer`. Private media access remains a
separate permission and requires recent Google authentication.

## Temporary processing boundary

New audio processing is temporarily unavailable while the execution architecture
is redesigned. The dashboard contains no machine administration, execution,
attempt, recovery, or queue-capacity controls. Existing job history and completed
result access remain visible according to permissions.

## Validation boundary

Fixture and isolated-service tests prove local behavior only. They do not authorize
hosting or prove live Firebase, S3, signer compatibility, production data, mobile
installation, or deployment.
