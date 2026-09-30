# MusicMute repository guide

Private R2 Standard is the only application storage provider. Read the [current storage guide](docs/r2-storage/README.md) before storage changes. Credentials stay backend-only; old version IDs, acceleration and AWS setup are unsupported. Historical validation records are not live R2 proof.

Read the root README, the affected component's README and manifest, and any
nested `AGENTS.md` before changing code. This repository has no root package
install; run checks from the component directory. Search existing source before
adding a component or utility, preserve unrelated work, and report checks that
actually ran.

## Realtime processing: read before changing live data flows

Read [the AI handoff](docs/realtime-processing-queue/AI-HANDOFF.md) when touching
queue scheduling, job/import updates, browser data fetching, native history,
WebSocket/auth infrastructure or processing UX. It maps the implementation and
links the protocol, tests and dated validation evidence.

- Reuse the existing raw WebSocket transport and full-snapshot subscriptions.
  Do not reintroduce status polling, timer-driven HTTP reads, automatic query
  refetches or Refresh controls on migrated live screens, including the dashboard.
- HTTP still handles auth, commands, grants, transfers and explicit non-live reads;
  legacy REST endpoints remain compatible. This is not an instruction to move all
  HTTP traffic onto WebSockets.
- Queue rank is per job among eligible waiting jobs in the same recipe, not an ETA
  or an account-wide position. Preserve shared scheduler eligibility and capacity
  rules, authorization fences, reconnect recovery and stale-rank hiding.
- Use [PROTOCOL.md](docs/realtime-processing-queue/PROTOCOL.md) for the wire contract
  and [IMPLEMENTATION.md](docs/realtime-processing-queue/IMPLEMENTATION.md) for dated
  evidence. Local implementation does not establish deployment or production health.

## URL imports: private SaaS adapters

Read [provider architecture](video_providers/README.md) and
[provider instructions](video_providers/AGENTS.md) before changing URL imports.
Clients submit to NestJS; a private adapter acquires audio from SaaS and returns
bytes to NestJS for validation, private R2 upload and the existing worker flow.
Only the adapter receives vendor credentials. NestJS uses generic
`AUDIO_ACQUISITION_API_URL` / `AUDIO_ACQUISITION_API_KEY` settings.
Keep included metadata in nullable, sanitized MongoDB `extra_data`, with no paid
enrichment. Preserve bounded scratch cleanup and never expose provider URLs.
Provider swaps require another contract-compatible adapter, not NestJS vendor
branches. No extraction fallback, old-device compatibility or migration bridge
is wanted for this flow. See the provider docs for current support and dated proof.

## Component map

| Directory          | Responsibility                                         | Guide                                                    |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------- |
| `web-client/`      | End-user browser app (React, TypeScript, Vite, npm)    | [`web-client/README.md`](web-client/README.md)           |
| `dashboard/`       | Administrator browser console; separate auth and UI    | [`dashboard/README.md`](dashboard/README.md)             |
| `backend/`         | NestJS API (pnpm); also read `backend/AGENTS.md`       | [`backend/README.md`](backend/README.md)                 |
| `android/`, `ios/` | Native apps and visual/product references              | Their component READMEs                                  |
| `worker/`          | Processing machines                                    | [`worker/README.md`](worker/README.md)                   |
| `video_providers/` | Private SaaS audio adapters and provider documentation | [`video_providers/README.md`](video_providers/README.md) |

The end-user web app lives entirely in `web-client/`. It follows the Android
dark visual language and English/Arabic RTL journeys, but uses browser auth,
URL imports and local **audio** only. It has no offline/PWA or local video flow.
Its API client reports platform `web`; native Android/iOS release policy must
remain compatible. The API contract is in `docs/api/client-contract.md` and
`backend/openapi.yaml`. The source-backed parity inventory, implementation
ledger and production evidence are in `web-client/tasks/`. Unchecked ledger
items are remaining verification work, even when corresponding UI exists.

From `web-client/`, use `npm ci --ignore-scripts`, then `npm run format:check`,
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`,
`npm run test:server` and `npm run test:e2e` as relevant. Browser tests use
installed desktop Chrome and synthetic/mock fixtures; they do not establish
real Firebase, API or R2 end-to-end success. `npm run package:caprover` creates
an allowlisted deployment archive. The live app uses CapRover app `app` at
`https://app.music-mute.com`, with public Firebase Web SDK settings supplied at
runtime. Never place R2 credentials, Firebase Admin keys, database URLs,
backend dotenv values or user data in the web package, browser config or logs.

The public app entry page may be indexed. Authenticated routes should not be
indexed; keep their crawl headers and the root-only sitemap aligned with route
changes. The favicon derives from Android's `ic_vocal.xml`. Update both the
vector and rendered PNG if that mark changes.

For any simulator UI test, use only the existing iPhone 17 Pro, iOS 26.0,
UDID `3CC14436-EC3C-4419-A079-C84951E5FA07`. Do not substitute devices or
create/download a simulator. Do not commit, push, deploy, publish, delete real
data or change production permissions without a direct user request. Distinguish
local, fixture, device and live checks in the final report.
