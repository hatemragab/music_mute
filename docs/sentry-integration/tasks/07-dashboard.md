# SEN-07 — Administrator dashboard

Status: TODO. Priority: P1. Dependency: SEN-01.

## Owned implementation scope

`dashboard/package.json`, lockfile, `src/main.tsx`, `src/app/app.tsx`,
`src/app/query-client.ts`, `src/api/api-client.ts`, `src/config.ts`,
`vite.config.ts`, `vite-environment.ts`, `server.mjs`, and deployment/browser tests.

## Work

1. Add the React SDK and initialize before root rendering. Place error boundaries
   around the provider/app graph and relevant routed content with a useful retry/
   reload fallback. Cover React 19 root error callbacks without double capture
   when an error also reaches a boundary/global handler.
2. Extend both Vite's explicit public-config allowlist and production runtime
   config generation/validation. DSN/environment can change at container restart;
   immutable release identity belongs to the compiled assets, not a freely
   changeable runtime value. Preserve base-path deployments.
3. Capture selected terminal query/mutation failures once after retries. Preserve
   ApiError classification, sign-in state, permission handling, and operation
   receipt recovery. Never retry a mutation merely to obtain telemetry, and never
   serialize query keys/data, admin records, upload files, or `ApiError.details`.
4. Filter raw URLs/query strings, private media grants, auth state, user details,
   console breadcrumbs and form values. Leave Replay and logs disabled. Avoid
   account identity fields by default and reset session context on logout.
5. Verify CSP against the configured ingestion origin. Current `connect-src`
   already permits HTTPS; no wildcard expansion or open ingestion proxy is needed.
   Ad blockers/offline Sentry must leave the dashboard fully functional.
6. Treat Router 8 compatibility as a required check before automatic router
   instrumentation. Initial error boundaries do not require navigation tracing.
   Capture only safe route templates if route context is useful.
7. Add hidden source maps, upload and served-artifact cleanup through SEN-08.
   Cover the small `server.mjs` serving process with a minimal Node adapter using
   the dashboard project and `runtime=node`. Initialize before serving, capture
   unexpected startup/serving failures, and preserve response/exit behavior with
   bounded shutdown. The browser SDK cannot cover this process. Keep its tests
   and failure ownership separate from browser event reporting.

## Acceptance and tests

- [ ] Render and unhandled-async synthetic errors produce one sanitized event.
- [ ] Query retries, expected 4xx and operation reconciliation produce no duplicate issues.
- [ ] Production runtime config overrides development config correctly; no token is exposed.
- [ ] Event collection blocked/offline does not break sign-in, tables, media access or mutations.
- [ ] Browser/deployment tests cover a non-root base path and absent public source maps.
- [ ] Compiled/production serving-process tests prove startup capture and safe exit
      without request bodies, static file contents, or duplicate browser errors.

Run focused Vitest tests, then `npm run format:check`, `npm run lint`,
`npm run typecheck`, `npm test`, `npm run test:deployment`, and the relevant
Playwright scenarios through `npm run test:e2e`. Deployment tests already build;
rebuild separately only after further changes. Browser fixtures use isolated
backend services, never production administrator data.
