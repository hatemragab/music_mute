# Full dashboard local validation

The current dashboard exposes overview, retained jobs, users, account recovery,
releases, update policy, basic processing settings, health alerts, activity, and
administrator access. Private media access remains deliberate and permission-bound.

The clean-slate removal deleted execution-machine administration, execution
attempts, recovery and retry controls, queue-capacity policy, and their fixtures.
New processing is intentionally unavailable until a separately approved redesign.

Run the current dashboard formatter, linter, typecheck, unit tests, deployment
tests, production build, and Playwright suite from `dashboard/`. Run the backend
dashboard integration suite from `backend/` against its test-owned services.

Local checks do not prove live Firebase, S3/IAM/CORS, production data,
administrative writes, mobile installation, or deployment. No production database
or service is changed by these validations.
