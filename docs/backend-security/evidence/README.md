# Branch evidence reports

Branches 1–4 are merged. Branch 5 has completed E1–E6 and its evidence report is
ready for collection-branch review.

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
