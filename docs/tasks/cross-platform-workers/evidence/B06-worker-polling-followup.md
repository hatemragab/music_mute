# B06 worker polling follow-up

Local development-contract cleanup, 2026-09-14. Removed the worker's old-server
HTTP 400 retry without `waitSeconds` and the associated `long_poll_supported`
state. The current backend already implements long polling. Requests rejected by
that contract now propagate to existing supervisor error handling. Explicit
`claim_wait_seconds=0` still uses bounded one-second idle polling; this is a
supported configuration, not negotiation with an older backend.

Changed `worker/musicmute_worker/worker.py`, `supervisor.py`, and the focused
`test_runtime_claims.py`/`test_loop.py` files. GPU admission and recovery-only
ownership discovery remain unchanged. No database conversion or migration exists.

Red: a new regression expecting the original API error failed because the old
branch silently retried. Green: five claim/recovery tests and four supervisor
loop tests passed. Formatting and focused static checks accompany the change.
This report covers only the polling adapter. Independent scoped review approved
the change in `B06-worker-polling-review.md`. The ledger records the separate
media-policy audit: existing versioned job admission remains a product contract,
outside removal of the legacy worker backend and old-server negotiation.
