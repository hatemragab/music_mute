# Branch evidence reports

> **Storage update — 2026-09-30:** AWS/S3 observations and setup commands below
> belong to earlier releases. They are historical evidence, not R2 acceptance.
> Do not execute the old provider/versioning/tiering/acceleration setup. Use the
> [current private R2 Standard setup and verification guide](../../r2-storage/README.md); the owner
> approved fresh MongoDB and quoted ETag identities with no legacy bridge.

All five branches are merged into the collection branch with A1–E6 complete.

When a branch starts, copy `../templates/CHECKPOINT-REPORT.md` to the evidence file
named in `../branch-manifest.json`. Update it after every checkpoint. Do not create
or prefill five reports with fake `PASS` rows.

Expected files:

- `01-account-quotas-admin-controls.md`
- `02-media-s3-cost-protection.md`
- `03-job-queue-retries-refunds.md`
- `04-account-abuse-api-limits.md`
- `05-account-deletion-cleanup.md`

Evidence files must contain only synthetic/sanitized identifiers and summaries.
Never attach environment values, credentials, presigned URLs, private audio, real
user records, database dumps, or provider screenshots with sensitive information.
