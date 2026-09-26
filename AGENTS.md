# MusicMute repository guide

Read the root README, the affected component's README and manifest, and any
nested `AGENTS.md` before changing code. This repository has no root package
install; run checks from the component directory. Search existing source before
adding a component or utility, preserve unrelated work, and report checks that
actually ran.

| Directory          | Responsibility                                      | Guide                                          |
| ------------------ | --------------------------------------------------- | ---------------------------------------------- |
| `web-client/`      | End-user browser app (React, TypeScript, Vite, npm) | [`web-client/README.md`](web-client/README.md) |
| `dashboard/`       | Administrator browser console; separate auth and UI | [`dashboard/README.md`](dashboard/README.md)   |
| `backend/`         | NestJS API (pnpm); also read `backend/AGENTS.md`    | [`backend/README.md`](backend/README.md)       |
| `android/`, `ios/` | Native apps and visual/product references           | Their component READMEs                        |
| `worker/`          | Processing machines                                 | [`worker/README.md`](worker/README.md)         |

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
real Firebase, API or S3 end-to-end success. `npm run package:caprover` creates
an allowlisted deployment archive. The live app uses CapRover app `app` at
`https://app.music-mute.com`, with public Firebase Web SDK settings supplied at
runtime. Never place AWS credentials, Firebase Admin keys, database URLs,
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
