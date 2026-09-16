# D01: Dashboard package, design foundations and Google admission Implementation Plan

> Implemented after the B18 backend gate passed and validated locally with deterministic browser fixtures plus an isolated compiled-backend contract suite. No commit, push, publish, deployment or real-data change was performed.

**Status:** COMPLETE (local)\
**Goal:** Create the approved React + TypeScript + Vite web stack and accessible adaptive application shell with real backend admission and shared typed API handling.\
**Architecture:** Build one React + TypeScript single-page web application with Vite against the verified NestJS contract; use TanStack Query for server state, React Router for navigation, reusable Tailwind CSS + shadcn/ui components and server-enforced permissions.
**Tech Stack:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Firebase Web Authentication (Google), native fetch/XHR, Vitest, React Testing Library, MSW and Playwright. Verify compatible versions and lock them during D01.
**Spec:** [Approved scope](../scope.md), [API contracts](../contracts.md).\
**Dependencies:** current backend dashboard contract and route fixture.

## Global constraints

Read the [execution rules](../README.md) and scope before starting. Preserve unrelated changes and recheck current source; listed new paths are proposed ownership, not claims that files exist. Reuse already implemented portions of older plans rather than creating duplicates. No hosting work. Tests use synthetic owned fixtures and isolated services; no real audio/accounts/credentials. Record unavailable validation honestly. Dashboard validation uses desktop browser tests and responsive viewport sizes; no native dashboard app is planned. Any separately requested mobile/device UI testing must use only the existing iPhone 17 Pro, iOS 26.0, UDID `$IOS_SIMULATOR_UDID`; if unavailable, report the blocker rather than substituting another device. Real configured Google and S3 proof is a separate validation boundary.

## Files and responsibility

- Create `dashboard/package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/styles.css`, `eslint.config.js`, `vitest.config.ts`, `playwright.config.ts` and `README.md` during implementation only; D01 selects and locks compatible package versions.
- Create `src/app/app.tsx`, `src/app/router.tsx`, `src/app/app-shell.tsx`, `src/app/query-client.ts`, `src/styles/tokens.css`, `src/auth/admin-session.tsx`, `src/auth/sign-in-page.tsx`, `src/api/api-client.ts`, `src/api/contracts.ts` and shared components actually used.
- Create `src/auth/admin-session.test.tsx`, `src/api/api-client.test.ts`, `src/test/dashboard-fixtures.ts`, `src/test/setup.ts`, `src/test/handlers.ts`, `e2e/auth.spec.ts` and `e2e/helpers/session.ts`.

## Interfaces

Consume AdminSession and finalized B18 response fixtures. Session states restoring|signedOut|checkingAccess|allowed|denied|failed. The typed TypeScript client returns data or {status,code,message,requestId,retryAfter}; it exposes request cancellation and explicit read-back for uncertain mutations.

## Steps

- [x] 1. Verify B18 has passed and compare current response fixtures before scaffolding. Select compatible React/TypeScript/Vite, Tailwind CSS + shadcn/ui, React Router, TanStack Query and Firebase Web SDK versions; lock dependencies in `package-lock.json`. Use npm and align with the repository Node/npm engines. Define `dev` (Vite), `build` (TypeScript check plus Vite build), `lint` (ESLint), `typecheck` (tsc --noEmit), `format:check` (Prettier), `test` (Vitest run), and `test:e2e` (Playwright test) scripts. Configure React Testing Library with jsdom, MSW fixtures and local Playwright webServer startup; document prerequisites and commands.

- [x] 2. Create Vitest/React Testing Library and Playwright fixture helpers: render real components with router/query providers, intercept finalized API shapes with MSW, emulate Firebase states and expose `signInAs(role)` to browser tests. Keep fixture authentication restricted to the test harness and verify it is absent from the production build. No embedded production credentials or live owner sign-in.

- [x] 3. Implement Google sign-in through Firebase Web Authentication with browser-session persistence and GET /admin/session. Never authorize by frontend email list. Recheck admission after token/role changes and foreground refresh; cancel pending requests and clear TanStack Query caches, privileged state and media on sign-out/denial or identity changes.

- [x] 4. Build a strongly typed native fetch transport with a configured API origin, controlled one-time token refresh for safe reads, AbortSignal cancellation, no-store and safe error messages. Configure TanStack Query read retries to respect 401/403/429 and Retry-After; disable automatic mutation retries. Do not replay non-idempotent actions or leak a Firebase bearer to upload/download URLs; validate configured origin.

- [x] 5. Create permission-filtered React Router navigation for every approved area, Tailwind CSS light/dark design tokens, reusable shadcn/ui components, keyboard focus, semantic HTML, accessible dialogs, responsive navigation, date/empty/error/stale states and paginated tables as needed. Use TanStack Query for API state and React component state for transient UI; avoid a duplicate global data store.

- [x] 6. Define validated public Vite configuration for the API origin, app base path and Firebase Web client identifiers, with documented local defaults and CORS requirements. Treat all VITE_* values as public; never put Admin SDK secrets or credentials in frontend configuration. Do not implement Nest static serving, choose a production domain, change CapRover packaging or add deployment. Test Google-flow cancellation, denied login, refresh failure, permission loss, keyboard navigation and browser viewport widths 360/768/1440.

## Behavioral acceptance fixtures

These are concrete test scenarios to encode in the listed test files before implementation. They describe expected results, not completed tests.

```gherkin
Scenario 1: A Google sign-in followed by backend 403 displays Access denied without rendering privileged content.
Scenario 2: A removed administrator loses page data on the next API check, and sign-out clears cached grants.
Scenario 3: A 401 during a publication action does not silently replay publication after refresh.
```

## Validation

Run from `dashboard/` after implementation. New filenames/scripts below are created by this task or its dependencies; they are not commands run during planning. Capture the new failing expectation before the change, then pass it and the relevant regression checks. Scope formatter writes to owned changed files.

```sh
npm test -- src/auth/admin-session.test.tsx src/api/api-client.test.ts
npm run test:e2e -- e2e/auth.spec.ts
npm run lint
npm run typecheck
npm run build
```

## Completion evidence

- [x] The local dashboard shell uses the real admin boundary and typed API behavior, with no hosting assumptions.
- [x] Attach changed-file list, exact validation commands/results and tested revision.
- [x] Review diff for contract drift, unrelated changes, unsafe data exposure and lifecycle regressions.
- [x] Record remaining external/mobile/Windows limitations separately; do not mark simulated behavior as live proof.
