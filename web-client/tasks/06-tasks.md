# Ordered implementation tasks

Implementation began after the user authorized it. Execute in dependency order. Use
this file as the resumable task ledger; append short evidence per task rather
than marking unchecked work complete. These are files for the next agent, not
requests to create new Codex chats or recurring automations.

- [x] **01 — Audit and parity matrix.** Read all required source and instructions.
      Produce `parity-matrix.md` mapping Android screens/actions/states to browser
      equivalents and approved omissions. Inspect API platform consumers and local
      audio preparation feasibility. Record decisions and concrete blockers.
- [x] **02 — Backend web support.** Implement the minimal end-to-end platform
      extension in `03-backend.md`, update OpenAPI/docs and run focused regression
      tests. Finish this before claiming real browser auth/processing integration.
- [x] **03 — Web foundation.** Create standalone package/lockfile, strict TS,
      Vite, routing, test/lint/format setup, public configuration validation, API
      adapter and environment examples. Add `web-client/.gitignore` to exclude
      dependencies, build/test artifacts and real local configuration. No root
      package refactor and no dashboard imports.
- [x] **04 — Theme and responsive shell.** Implement Android-derived tokens,
      fonts, accent contrast, navigation, bilingual catalogs/RTL and shared accessible
      controls. Check phone/tablet/desktop layouts before multiplying screens.
- [ ] **05 — Authentication and account lifecycle.** Implement Firebase
      email/password and Google, backend bootstrap/device metadata, restore/loading
      state, refresh/error handling, reset/verify, linked providers, devices, logout,
      logout-all, deletion and recovery. Use isolated test identities for tests.
- [ ] **06 — URL imports and jobs.** Implement reviewed URL intake, trim option,
      import-to-job transition, polling, job history/details/actions, usage/quota and
      account/processing restrictions. Verify retries do not duplicate work.
- [ ] **07 — Local audio.** Implement the policy-compliant preparation/upload
      path, progress/cancellation/error handling and supported-format diagnostics.
      Tests must cover compatible pass-through and conversion-required paths.
- [ ] **08 — Library and player.** Complete online library, lightweight local
      preferences, persistent player/queue, signed-grant renewal, exports and route
      continuity. Ensure logout/account switching clears private in-memory state.
- [ ] **09 — Settings and parity completion.** Finish accent/language/usage/about
      and every remaining in-scope parity row. Audit both locales, all major error
      states and accessibility; remove nonfunctional placeholders.
- [ ] **10 — Browser and API integration proof.** Run the checks in
      `07-validation.md`; fix implementation-caused failures. Record screenshots,
      real-backend fixture coverage, mocked coverage and unavailable proof separately.
- [x] **11 — Packaging and final review.** Prepare CapRover-compatible packaging,
      safe runtime configuration, health endpoint, SPA fallback and documented setup
      inside `web-client/`. Verify archive exclusions, build, headers, deep links and
      secret handling locally. Reconcile the parity matrix and review all diffs.
      Deliver without committing, pushing or deploying unless separately requested.

## Evidence template

Task / status / changed paths / commands and actual results / screenshots or
reports / unresolved issues / next step. Label baseline failures separately and
never weaken tests to turn the checklist green.

## Progress evidence

- 2026-09-26: Task 01 source audit produced `parity-matrix.md` from the current Android navigation/auth/home/library/player/settings and backend platform-policy paths. Every implementation row remains pending. A temporary installed-Chrome probe converted synthetic WAV to AAC-LC and passed through 128 kbps MP3; Task 07 must repeat this with its retained test suite and policy edge cases.
- 2026-09-26: Tasks 02–04 and 11 have code and local proof. Backend `pnpm run verify` passed (867 unit and 147 e2e tests); four auth/device/policy/push integration files passed against isolated Firebase Auth, MongoDB and Redis. API image 68 is live; both health routes and web-origin CORS preflight passed. Web `format:check`, `typecheck`, `lint`, 11 unit tests, three server tests, production build and three installed-Chrome tests passed. Browser checks covered English/Arabic at 360, 390, 768, 1024 and 1440 pixels, and synthetic WAV-to-AAC conversion. Allowlisted archive excludes local environment and tests. Web image 2 is live at `https://app.music-mute.com`; HTTPS redirect, public config shape, deep links and health passed.
- 2026-09-26: Tasks 05–10 have substantial implementation (auth/account, URL/local intake, jobs, library, player, settings and localization) but remain unchecked until real Firebase and API workflows, signed S3 upload/download, account switching, and accessibility/error-path evidence are complete. Mocked browser previews and preflights do not establish those outcomes. No iOS simulator test was run. At initial deployment, no commit, push or PR had been made.
- 2026-09-26: The public app entry now has descriptive and social metadata, a canonical URL, a root-only sitemap, and a PNG favicon rendered from the Android launcher mark. Known authenticated routes receive `noindex, nofollow`; unknown routes return 404. Local web checks passed: 11 unit tests, four server tests, three installed-Chrome tests, lint, typecheck and production build. Search indexing and authenticated production journeys remain unverified.
