# Validation and definition of done

## Frontend scripts to provide and run

From `web-client/`, establish reproducible scripts and run:

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Add a packaging/deployment-test script when packaging is implemented. Prefer
existing installed Google Chrome for desktop Playwright runs; document browser
availability instead of silently downloading new targets. Responsive viewport
checks are desktop browser checks, not physical phone or iOS Safari proof.

The user's device/UI-test constraint is the existing **iPhone 17 Pro, iOS 26.0**
simulator, UDID `3CC14436-EC3C-4419-A079-C84951E5FA07`. Explicitly select it for
any simulator testing. Do not run the Android reference app, use other devices,
create simulators, or download replacement runtimes. If unavailable, report that
blocker; source inspection, unit tests and desktop browser checks may continue.

## Meaningful tests

- Backend web session/device/guard paths and unchanged mobile behavior described
  in `03-backend.md`; owner isolation, revoked sessions and restrictive policies.
- Browser register/login/restore/logout, verification/reset, provider errors,
  reauthentication and account lifecycle using test-only adapters/emulators.
  Ensure fixture auth cannot appear in production builds.
- URL import to completed job; source failure and rate limiting; stable operation
  IDs; cancellation/retry and reload recovery without duplicate jobs.
- Audio validation/preparation/upload/confirmation, integrity mismatch, rejected
  policy, expired grant, interrupted upload and unsupported formats.
- Library pagination/filtering and UID isolation; playback seeking/buffering,
  expired grants, queue progression, route continuity and logout cleanup.
- English/Arabic at representative widths, keyboard/dialog focus, 200% zoom,
  reduced motion, accessible names and relevant contrast checks.
- Invalid/missing public config fails usefully; SPA deep links work; private
  responses and config use appropriate caching; no secrets in production assets.

Use deterministic synthetic media and test-owned MongoDB/Redis/Firebase fixtures.
Mocked UI tests do not prove real API compatibility: exercise the implemented
backend with isolated infrastructure too. Never use production for destructive
account deletion, retries generating paid work, or stress/load tests.

## Backend commands

Follow `backend/AGENTS.md` and package scripts. Run focused tests while iterating,
then `pnpm run verify`, plus relevant auth/processing/URL-import integration
suites using their isolated local prerequisites. Document exact executed commands,
not planned commands. If existing baseline failures block broad verification,
record them precisely and still prove the changed paths. Avoid unrelated format
churn from broad formatting commands.

## Completion gate

All in-scope parity rows have implementation and evidence. No fake progress,
dead buttons, insecure bypasses, hardcoded production secrets, uncaught async
failures, or cross-account cached data remain. Diff contains only allowed paths.
Report local, fixture integration, simulator, and live proof separately. Real
production end-to-end sign-in/upload is NOT established by CORS preflight success.
