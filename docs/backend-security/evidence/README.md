# Branch evidence reports

All implementation branches are currently `NOT_STARTED`; no success report exists.

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
