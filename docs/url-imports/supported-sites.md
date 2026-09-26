# Client admission for verified audio sites

Policy agreed on 2026-09-26: admit only individually checked sites, rather than
advertising the entire yt-dlp extractor catalog. Unknown sites and unsupported
link shapes are rejected **offline**, before token acquisition or `POST
/media-imports`. No catalog endpoint, provider request or DNS lookup is needed
for client validation. Normal account and job refresh requests remain unchanged.

The single source of truth is
[`supported-audio-sites.json`](../../web-client/src/site-policy/data/supported-audio-sites.json).
Web imports it directly; Android packages the same file as a Java resource;
XcodeGen includes the same file as an iOS application resource. Tests consume
[the same URL fixtures](../../web-client/src/site-policy/fixtures/url-policy-cases.json).
Missing/unreadable native catalogs fail closed. Rebuild all three clients when
changing admission rules; existing installed clients retain their bundled list.

## Qualification and limits

The official [yt-dlp site catalog](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
is an extractor inventory, not an audio-only certification. Availability depends
on the item, account restrictions, geography, site changes and server IP. There
is no way to prove every item's audio availability using only its URL.

The checksum-pinned downloader `2026.09.16.232951` from `ytdlp_test/Dockerfile`
was used for live **metadata-only** checks of 21 public sample links on
2026-09-26. Nine returned a selected separate audio format, a nonempty audio
codec, a supported native transfer protocol, a single item, and no live flag:

| Enabled site | Observed format | Protocol |
| --- | --- | --- |
| YouTube | Opus / WebM | HTTPS |
| Facebook | AAC / M4A | HTTPS |
| SoundCloud | AAC / M4A | native HLS |
| Bandcamp | ALAC / M4A | HTTPS |
| Mixcloud | AAC / M4A | native DASH |
| hearthis.at | WAV | HTTPS |
| Clyp | Ogg | HTTPS |
| Vocaroo | MP3 | HTTPS |
| Whyp | FLAC | HTTPS |

[Sanitized results](qualification-2026-09-26.json) retain public page URLs and
format metadata, without expiring media URLs, headers, cookies or tokens.
These are format-availability checks from this development machine, **not**
full downloads, codec validation, production-IP qualification, or new
API/S3/worker end-to-end proof. Historical full YouTube/Facebook production
proof remains in `ytdlp_test/results.md`. A sample such as the Mixcloud mix may
exceed the current account's duration allowance even though its site offers
separate audio. The server remains authoritative for every accepted item.

Audiomack, Vimeo, Dailymotion, Reddit, Internet Archive, AudioBoom, Spreaker,
Podomatic, Jamendo, Freesound, Tumblr and Apple Podcasts were not qualified by
these probes and remain blocked. A failed probe does not establish permanent
lack of support. Unverified redirect hosts such as `fb.watch` and
`on.soundcloud.com`, custom Bandcamp domains and all other sites remain blocked
until their routes have evidence and explicit catalog rules.

## URL and submission behavior

- Exact host and item-path matching rejects lookalike domains, homepages,
  unsupported collection routes, IP literals, credentials, ports, fragments,
  controls, backslashes and path traversal before any import request.
- Decoded query keys reject playlists (`list`, `playlist`, `in`) and duplicate
  parameters. Required item identifiers are checked locally. Valid media query
  parameters are preserved. Android retains its existing SoundCloud identity
  normalization for durable request deduplication.
- Android validates at form/coordinator intake and again at the API boundary,
  including restored pending submissions. Web validates before creating retry
  state and at the API boundary. English/Arabic messages display local rejection.
- iOS now has a rights-confirmed link form with the same list, owner-scoped
  durable request identity, progress polling, explicit retry after a transient
  error, foreground recovery and a link to the existing processing view. Its
  optional persisted field remains compatible with old processing snapshots
  and participates in existing account cleanup.
- Pausing or switching accounts fences iOS callbacks. Ambiguous submissions keep
  their request ID; definitive rejection allows a different link. Existing
  server imports continue even when the client is backgrounded.

Server acquisition still uses `bestaudio[vcodec=none]`, transport/SSRF controls,
full audio verification, limits, cleanup and the established S3/worker flow.
Client admission is a UX boundary; it does not replace server security or stop
custom/older clients from submitting to the existing API. No API contract,
production flag or service configuration was changed.

## Maintenance

Download the exact official executable specified in `ytdlp_test/Dockerfile`
and verify its SHA-256 before probing a candidate. Use:

```sh
python3 /path/to/checksum-verified/yt-dlp --ignore-config --no-playlist \
  --skip-download --dump-single-json --no-warnings --socket-timeout 10 \
  --retries 0 --extractor-retries 0 -f 'bestaudio[vcodec=none]' '<public-item-url>'
```

Do not save the raw JSON (it contains temporary media URLs). Retain only the
fields used in the qualification report. Add a site only with observed separate
audio, a supported transfer protocol and a reviewed narrow item-link rule.
Include accepted and rejected cases and run all three policy test suites.
Do not automatically enable extractor names from the upstream site inventory.

The iOS client continues the existing REST contract: snake_case wire payloads,
202 admission, stable request UUIDs, bearer/installation authentication and
sanitized failures. The official [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were consulted on 2026-09-26 for security (104), compatibility (106), JSON naming
(118), HTTP methods (148) and idempotent POST design (229). This is a client
implementation check, not a claim of production compliance.

## Local validation (2026-09-26)

- Web: `npm run format:check`, `npm run lint`, `npm run typecheck`,
  `npm test` (86 tests), `npm run build`, and `npm run test:server` (7 tests)
  passed. Installed-Chrome Playwright covered responsive English/Arabic layouts,
  audio conversion and local unsupported-link rejection. The rejection test was
  rerun successfully after scoping its selector to the form's alert; the preview
  also contains an unrelated fixture error alert.
- Android: `:app:testDirectAuthE2eUnitTest --tests '*UrlImportsTest'
  --tests '*SupportedAudioSitesTest' :app:assembleDirectAuthE2e
  :app:lintDirectAuthE2e` passed (10 tests). The APK contains the nine-site
  catalog. This uses the checked-in synthetic Firebase fixture, not release
  signing or production configuration. No Android device was used.
- iOS: XcodeGen plus `xcodebuild build-for-testing` passed. All 22 focused URL-import
  and Jobs API tests and the unsupported-link UI test passed on **iPhone 17 Pro,
  iOS 26.0, 3CC14436-EC3C-4419-A079-C84951E5FA07**, with parallel testing disabled.
  The fixture test runner supplies `--processing-ui-fixture` to the unit-test
  host using a temporary copy of the generated `.xctestrun` file. No Firebase
  configuration was copied or fabricated. The initial unconfigured production
  test host could not launch; the existing isolated harness resolved that.
- The broader iOS unit run executed 148 tests: 146 passed, one live test was
  skipped, and one configuration test failed four assertions because the local
  production `GoogleService-Info.plist` is absent. It is not a fully passing
  production-configured suite. The feature's focused tests passed separately.
- Scoped `swift-format lint --strict`, localization `plutil -lint`, and
  `git diff --check` passed. The shared policy has 61 admission/rejection cases.

Per the task's generated-file constraint, the generated checked-in Xcode project
is left unchanged. Run `xcodegen generate --spec ios/project.yml` from the repo
root before an iOS build to include the new sources and shared resources. Normal
production-graph builds also require the ignored local Firebase configuration
as described in the iOS README. Existing Firebase project references are retained
in the unchanged checked-in project.

Validation above predates Git publication. No production deployment, production
enablement, real Firebase login or new API/S3/worker completion was performed. Existing release/runtime
warnings and the web media encoder chunk-size warning remain outside this change.
