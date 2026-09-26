# Approved scope

## User decisions

- Build a responsive end-user web client matching the Android app's theme and
  user journeys: authentication, imports, jobs, library, player, settings/account,
  and logout.
- Keep the entire new web application, its tooling, tests, packaging, and this
  task package under `web-client/`.
- Minimal backward-compatible backend changes for genuine `web` platform
  support are approved. Do not impersonate Android in browser requests.
- No offline mode, offline media library, service-worker caching, or installable
  PWA in this version. Normal Firebase session persistence and lightweight
  preferences are allowed; they are not an offline application mode.
- Intake is URL imports plus local AUDIO only. No local video picker/extraction,
  video rendering/muxing, or browser implementation of yt-dlp.
- English and Arabic with complete RTL support; retain Android accent selection.
- Intended public origin: `https://app.music-mute.com`, on existing CapRover.
  Configuration work already completed is described separately; hosting is not
  yet deployed and this package does not grant deployment permission.

## Stack and boundaries

Use React + TypeScript + Vite, React Router, TanStack Query, Tailwind CSS, and
accessible Radix primitives where useful. Use Firebase Web Authentication,
HTML audio with a persistent player, and Vitest/Testing Library/Playwright.
Choose compatible, locked versions after inspecting `dashboard/package.json`
and its lockfile; avoid speculative packages. A new Next.js server, database,
Firebase Admin SDK, or duplicate media-processing backend is unnecessary.

Use the existing NestJS API and signed S3 transfer contracts. Keep web source
independent of dashboard source/build output. The dashboard is a reference for
patterns, not a runtime dependency or an administrator login gate for end users.

Allowed future edits: `web-client/**`, the narrowly required backend modules,
backend contract tests/OpenAPI, and directly related existing API documentation.
Do not change Android, iOS, dashboard, workers, or downloader implementation.
If a genuine compatibility blocker requires a change outside that scope,
document the exact issue and obtain expanded scope instead of hiding it.
Do not restructure the repository into a monorepo workspace.

## Explicit adaptations

- Files downloaded through the browser are user exports, not managed offline
  tracks. Do not promise they can be erased by web logout.
- Native installation/update dialogs, Android permissions, foreground services,
  share-intent intake and mobile push behavior are not copied literally.
- Provide normal offline/network error states, but no offline app functionality.
- Favorites/hidden items currently have local Android storage semantics. Match
  these as UID-scoped browser preferences if absent from the API; do not promise
  cross-device synchronization or add a backend favorites subsystem.
- Preserve the required backend authorization, suspension, verification, quota,
  account deletion/recovery, and processing admission rules.
