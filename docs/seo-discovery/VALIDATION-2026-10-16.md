# Search discovery release: 2026-10-16

## Delivered

The landing page serves complete English and Arabic HTML before JavaScript,
then hydrates React. The web app has a useful public HTML introduction, while
account routes strip public discovery metadata and remain `noindex`. Metadata,
structured data, social previews, canonical redirects, crawler MIME types, public
reading guides and optional per-host IndexNow verification are implemented.

The missing apex DNS A record was added to the same existing CapRover origin,
with the existing Cloudflare proxy policy. CapRover app `www` now has
`music-mute.com` attached with HTTPS; `www` permanently redirects to the apex.
No security protections or production account/API permissions were changed.
A separate public DNS TXT record verifies the owner's existing Google Search
Console account for the `music-mute.com` domain property. Verification values
and per-host IndexNow values are excluded from source control.

## Git and deployment scope

The SEO commit is isolated from the repository's substantial pre-existing local
changes. Deployment archives were built from the current affected component
trees with the SEO patch overlaid, preserving the existing Google redirect and
Firebase helper fixes, product-release copy, artwork and library behavior.
Those unrelated existing changes are not part of this SEO commit. The complete
deployment snapshot therefore includes more than the clean commit. No backend,
mobile, worker, extension or dashboard code was committed or deployed.

## Checks actually run

Both components passed `npm run format:check`, `npm run lint`,
`npm run typecheck`, `npm test`, `npm run build`, `npm run test:server`,
`npm run test:e2e`, and `npm run package:caprover`. Landing additionally passed
`npm run test:deployment`.

| Tree                          | Unit | Server | Chrome |            Package |
| ----------------------------- | ---: | -----: | -----: | -----------------: |
| Clean SEO landing             |   15 |     16 |     10 |                  1 |
| Clean SEO web app             |  196 |     15 |     10 | archive byte check |
| Integrated deployment landing |   20 |     16 |     10 |                  1 |
| Integrated deployment web app |  275 |     29 |     13 | archive byte check |

Chrome tests used installed desktop Chrome. No mobile simulator/device test was
required or run. Checks include no-JavaScript public content, stable language
URLs and RTL, matching hydration, audio errors before hydration, public/private
metadata separation, GET/HEAD, redirects, MIME, schema and IndexNow validation.
The integrated server tests retain the Firebase helper/proxy regression suite.
The existing landing browser assertion was reconciled with the already present
fifth Windows platform card and duplicate pending-release labels.

`npm ci --ignore-scripts` succeeded for the clean web component and both Linux
deployment builds. Local clean landing installation timed out, so its unchanged
lockfile-compatible installed dependencies were reused. No dependency versions
or lockfiles changed. Web installation still reports one existing high-severity
dependency advisory, and its build retains existing large-chunk warnings.

## Exact source archives and active deployments

Each archived regular file was byte-compared to its source. Archives contain
allowlisted component build inputs only, without dotenv files, dependencies,
private data, tests or built output.

| App           | Files | SHA-256                                                            | Active image         |
| ------------- | ----: | ------------------------------------------------------------------ | -------------------- |
| Landing `www` |    29 | `9f024df18208675dc551db6284b0e891f34f5a4412e2e064d96b53f8a8a31722` | `img-captain-www:4`  |
| Web `app`     |    65 | `84b5f3978d6b49d301d840ea2e38422a274bd39d73ce0f529826b1f90b3594ff` | `img-captain-app:25` |

CapRover CLI reported both builds/deployments successful. Authenticated
configuration read-back confirms one configured instance each, no build in
progress, the active images above, unchanged existing environment values,
ports, HTTPS and WebSocket settings. The only added environment setting is
`INDEXNOW_KEY` for each app; it is not emitted in browser configuration.

## Live verification

- HTTPS serves complete `/` and `/ar/` landing content and the public web root.
- Public pages contain H1 content, valid JSON-LD and their own canonical URLs.
- The landing language alternates and sitemap list the two canonical URLs;
  the app sitemap contains only its public root.
- `robots.txt`, `sitemap.xml`, `llms.txt` and the 1200 by 630 PNG preview return
  200 with correct MIME types on both hosts.
- Known `www` redirects return 308 to the apex, preserving path/query.
  `index.html` redirects preserve queries, health returns 200, and unknown
  documents return real 404 responses.
- Both configured IndexNow verification files return their exact values.
- App auth/account/jobs/job/library/player/settings GET and HEAD return
  `noindex, nofollow`; their HTML contains no public canonical or JSON-LD.
- The existing Firebase authentication JavaScript helper still returns 200.
- Googlebot, bingbot, OAI-SearchBot, ChatGPT-User, PerplexityBot and
  Claude-SearchBot user-agent probes return 200 with product content on both
  hosts. These probes do not authenticate the originating engine's IP.

Public Cloudflare and Google DNS resolvers return apex A records. The local
system resolver retained its earlier NXDOMAIN cache during shell verification,
so apex curl checks used the Cloudflare address returned by public Google DNS
while retaining normal TLS hostname verification. Existing Chrome navigation
to the apex succeeds normally, and Google successfully fetched its sitemap.

## Search-engine acceptance

Google Search Console domain ownership is verified. Both submitted sitemaps
show **Success**, read on October 16, 2026: the landing sitemap reports two
discovered pages and the web-app sitemap reports one. Discovered pages are not
a claim that the pages are indexed or ranked.

IndexNow received both host notifications with **HTTP 202**: the two landing
URLs and the one public web-app URL. Its key validation and subsequent indexing
remain engine-controlled. No private URLs were submitted.

## Remaining boundaries

Actual search rankings, indexed coverage and citations in AI answers are not
proved by this release. Measure them in the verified Search Console property
and search-engine reports after crawling. CDN policies were preserved; verified
crawler IP access is a separate diagnostic if an engine reports a future block.
Real authenticated processing, Firebase user sign-in, private storage transfers,
native releases and production capacity were outside this SEO validation.
