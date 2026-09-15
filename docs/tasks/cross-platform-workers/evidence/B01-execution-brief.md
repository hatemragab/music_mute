# B01 execution clarifications

Read `../backend/B01-runtime-contract-and-schema.md` and `../contracts.md` as requirements. This file records the integration decisions from source inspection; it does not replace those requirements.

## Existing integration points

- Mongoose models are registered through `backend/src/processing/processing-persistence.module.ts` in `PROCESSING_MODELS`. `ProcessingStartupService` awaits model initialization. Do not add a schema migration or manual index rewrite.
- Controllers/providers are in `backend/src/processing/processing.module.ts`.
- `WorkerRegistryService.fence(identity, session)` serializes lifecycle mutations on the existing control row through `ProcessingTransactions`. Keep active assignment ownership exclusively in that row.
- `controlRevision` serializes worker lifecycle and administrative writes; `managementRevision` is the stable dashboard CAS and must not change due to runtime observations.
- Existing native tests use `test/helpers/isolated-services.mjs` with a fresh Mongo replica set. Local `mongod` and `redis-server` are available. Never use configured development or production data.
- Existing DTO tests use Nest `ValidationPipe` with transform, whitelist, and forbidNonWhitelisted. Exercise nested unknown keys and missing-versus-null telemetry too.

## Decisions

- Return protocol 3 directly from identity. Obsolete runtime protocol reports must return a specific reinstall/upgrade reason; do not decode or adapt protocol 2.
- Installation binding is mandatory for the new readiness flow. Runtime cannot silently create or bind registrations from an arbitrary request ID. B02 will create the pairing binding transactionally.
- `installation-ready` can record validated evidence before B05 exists but cannot claim qualification from reported flags. Any incomplete admission decision is fail closed, with explicit reason codes; do not add a temporary true/always-qualified path.
- Ordinary observations do not overwrite approved boot/qualification evidence. Claimed readiness changes must serialize through the lifecycle fence; liveness timestamps are authoritative server time.
- Source classes may remain wired into existing auth during this foundational task. B06 will remove the existing mode implementation outright; B01 must introduce no new legacy branch or compatibility constructor.
- Update only tests affected by this task. Preserve unrelated Android edits, do not format unrelated files, and do not commit.

## Baseline

`npm test -- src/worker/`: 10 files, 63 tests passed.
`npm run typecheck`: passed.

Report implementation, test-first failure and passing proof, native integration result, and unresolved downstream gates in `B01-report.md` in this evidence directory.
