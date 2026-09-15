# W03 pre-upload clock response

Root-owned W03 backend integration, 2026-09-14. Added response-only ISO UTC
`serverTime` to installation registration, authenticated installation status,
and every permanent worker update-policy decision. Existing no-store headers,
authentication, limits, registration identity checks and policy state remain in
place. No new endpoint, persistence field, migration or legacy path was added.

Files: `backend/src/worker-installations/installation-pairing.service.ts`,
`backend/src/worker-releases/worker-rollouts.service.ts`, and their compiled
installation/rollout integration fixtures. The installation HTTP fixture checks
registration and authenticated status. The rollout fixture checks policy responses
with and without a target. Each timestamp must be canonical ISO UTC and fall
within the local test's request interval. Existing authority/race assertions run
in the same isolated database fixtures.

Red: both new integration assertions failed against the previous compiled backend
because serverTime was missing. Green: rebuilt backend and both complete isolated
integration scenarios passed. Build, scoped lint, formatting and TypeScript
typecheck passed. Tests used isolated services; no production requests occurred.

W03 client work consumes this clock before the first event transmission and still
must implement/test conservative skew correction, restart handling and immutable
uncertain/accepted retries. This backend field alone does not establish that
client behavior. Include these files in the full W03 independent review.
