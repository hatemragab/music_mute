# Local logging verification — 18 October 2026

This records local implementation and synthetic verification. It does not establish
production, real-account, paid-provider, GPU/inference, R2 or multi-machine behavior.
Existing unrelated repository changes and service owners were preserved. No commit,
push, deployment, service installation or real application-data reset was performed.

The later [extension/macOS UI follow-up](UI-TEST-2026-10-18.md) records actual
installed-app/video processing, isolated rebuilt GUI checks and the subsequent
100-record log batches. Its dated coverage extends the initial synthetic checks
below without turning them into production or exhaustive platform proof.

## Shared collection and AI interface

These commands actually ran:

```sh
node tools/local-logging/cli.mjs install
node tools/local-logging/cli.mjs verify-tools
node --test tools/local-logging/*.test.mjs
npm --prefix tools/logs-mcp ci --ignore-scripts
npm --prefix tools/logs-mcp test
node tools/local-logging/cli.mjs health
node tools/local-logging/probe.mjs --idle
node tools/logs-mcp/scripts/verify-live.mjs
backend/node_modules/.bin/oxlint --deny-warnings tools/local-logging tools/logs-mcp/src tools/logs-mcp/test tools/logs-mcp/scripts
node backend/node_modules/prettier/bin/prettier.cjs --check tools/local-logging tools/logs-mcp/src tools/logs-mcp/test tools/logs-mcp/scripts tools/logs-mcp/README.md docs/local-logging/README.md
git diff --check
```

- Shared collector tests: **43 passed**. They include actual pinned Vector file
  ingestion, twelve-second idle latency, bounded traffic, native metadata
  sanitization, output rotation, checkpoint restart recovery, ingress Host/origin/
  authentication/body limits, queue pressure, sink failures, lost-wakeup regression,
  private permissions, exact CRC64/EOF archive retirement, concurrent cold starts
  and preservation of original submillisecond timestamp precision.
- MCP: **54 passed**, including real stdio initialization/tool calls in both supported
  protocol modes, validation, bounded scans/results/cursors, malformed/partial
  coverage, archive/path/link defenses, redaction and all MusicMute source filters.
- The final post-restart idle probe reached retained JSONL in **192 ms**, with
  producer-to-Vector time **170 ms**. Earlier real probes measured **62 ms**,
  **115 ms** and **240 ms**. The probe
  payload remained nested/expandable and its credential canary was absent.
- Actual Vector startup configuration validation passed. Graceful collector restart
  and output rotation preserve owned inputs/checkpoints. The CLI remained running
  through intentional rotation; repeated `start`, `viewer` and `up` reused healthy
  owned services. `up` also started a missing viewer beside an existing collector.
- The configured `musicmute-logs` MCP registration was created using the installed
  Codex CLI. The SDK queried **all five tools against the authoritative capture**.
  The latest iOS trace returned HTTP 200, HTTP 503, cancellation and a post-idle event;
  its error summary reported two warnings, two failed operations and a deduplicated
  error-or-failure count of two, without adding overlapping counts.

An earlier readback snapshot contained 3,308 records from twelve sources:
backend, web-client, dashboard, landing-page, chrome-extension, macos, worker,
provider, ios, mongodb, redis and collector. Counts are a dated snapshot and change
while services run. Synthetic credential canaries and the forbidden release event
were absent. Runtime reports remain private under `.runtime/local-logging/`, including
`final-coverage.json`, `last-probe.json`, `mcp-live-verification.json` and test outputs.

Installed desktop Chrome visibly showed source facets, Cairo timestamps, expanded
redacted nested iOS JSON and the correlated 200/503/aborted/idle timeline in Logdy at
<http://127.0.0.1:19742/>. Semantic search uses expressions such as
`data.traceId == "..."`; bare words are not full-text search. Resume the play/follow
control after pausing to load later records. Viewer windows/exports are bounded
and do not represent the entire retained file.

## Source coverage and component checks

| Component                  | Evidence actually exercised                                                                                                                        | Boundary                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| NestJS backend             | Compiled local API HTTP404/redaction/request IDs, Mongo/Redis commands, service startup, raw WebSocket snapshots; 1,631 retained backend records   | Owned isolated Mongo/Redis fixtures, not production                                    |
| Web client                 | Real Chrome fixture UI, startup, storage and click diagnostics; HTTP/realtime/upload failure fixtures                                              | Synthetic public config; no real Firebase account or R2                                |
| Dashboard                  | Real Chrome sign-in screen/startup diagnostics and HTTP/realtime component fixtures                                                                | No administrator sign-in                                                               |
| Landing page               | Real Chrome page/lifecycle, existing interactive UI and unit fixtures                                                                              | No hosted publication or store flow                                                    |
| Chrome extension           | Actual unpacked debug extension in a fresh isolated installed-Chrome profile; exact extension origin accepted, lifecycle retained                  | Privacy page; no real profile/native-host registration/YouTube                         |
| macOS companion            | Actual AccountApiClient against bounded synthetic loopback HTTP; JSON payload retained; native Swift tests                                         | Installed macOS GUI, prepared worker and LaunchAgent unchanged                         |
| Worker                     | Actual WorkerControlPlaneClient retries against loopback 503 fixture, runtime/hint/context regressions                                             | No inference, real jobs or storage transfers                                           |
| Python adapters            | Actual router `/health` returned 200 and reached capture; all five adapter suites exercised                                                        | No paid acquisition; provider/media bodies omitted                                     |
| iOS                        | Actual app on the authorized simulator, real transport through isolated URLProtocol fixtures, HTTP200/503/abort, lifecycle/storage and idle events | No live authenticated socket, R2, Firebase/APNs or abrupt-crash delivery proof         |
| Android                    | JVM unit tests, lint and APK assembly                                                                                                              | No Android device/emulator used under the device restriction                           |
| Windows                    | Type/build/packaging and failed-file reruns passed                                                                                                 | No Windows execution on this Mac; installer tooling currently targets macOS ARM64      |
| MongoDB/Redis native files | New trusted Homebrew server records retained separately as `server_log` metadata                                                                   | Shared-service observations; no inference that every native event belongs to MusicMute |

Backend commands all passed, including every constituent of its verification gate:

```sh
# backend/
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:secrets
pnpm run test:transfer-benchmark
pnpm test
pnpm run test:e2e
pnpm run build
pnpm run test:logging:integration
pnpm run test:integration
pnpm run test:realtime:integration
pnpm audit --prod
```

Backend results: **1,749 unit tests**, **233 API tests**, **5 secret-check tests**,
**8 transfer fixture tests**, isolated infrastructure/logging/realtime integration,
and no known production dependency vulnerabilities. The existing realtime fixture
used six sockets/two feeds; server send observations do not establish client delivery.

All six JavaScript components ran their component `typecheck`, `lint`,
`format:check` and build commands successfully. Full suite results were web **286**,
dashboard **225**, landing **27**, extension **2,348 passed / 4 skipped**, worker
**1,473 passed / 21 skipped**. Final context-failure regression suites passed
**8/8/8/8/9**, final opaque-error omission suites passed **9/9/9/9/10**, and final web
upload/core suites passed **16**. Windows initially had
Node-version/load failures; all failing files subsequently passed (**44** tests plus
**163** with the existing, read-only Node 24.18 runtime). Its initial full run had
**305 passing files / 3,678 passing tests** and packaging checks passed **13**. This
is reported as a full run plus successful failed-file reruns, not a separate claim
that a fresh complete Windows run passed. Swift companion tests passed with and
without `DEBUG`. Python suites passed router **37**, VideoScale **71**, Tunelio
**53**, JoJAPI **83**, yt-dlp **78**, plus **4** logging tests and Python compilation.

Native commands actually ran:

```sh
# android/ — build/JVM only, existing local SDK and JDK17
JAVA_HOME=$(/usr/libexec/java_home -v 17) \
ANDROID_HOME="$HOME/Library/Android/sdk" \
./gradlew :app:testPlayDebugUnitTest :app:lintPlayDebug :app:assemblePlayDebug

# ios/ — only the authorized existing simulator
xcodebuild -quiet -project MusicMute.xcodeproj -scheme MusicMute \
  -destination 'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07' \
  -derivedDataPath /private/tmp/musicmute-local-logging-ios \
  -parallel-testing-enabled NO \
  -only-testing:VocalTests/LocalDiagnosticsTests \
  -only-testing:VocalTests/JobsAPIClientTests \
  -only-testing:VocalTests/ProcessingRealtimeTests \
  -only-testing:VocalTests/ProcessingStoreTests \
  -only-testing:VocalTests/ArtifactDownloadTransportTests \
  -only-testing:VocalTests/AccountRecoveryAPIClientTests \
  test CODE_SIGNING_ALLOWED=NO

# repository root
python3 ios/scripts/run-local-logging.py \
  --app /private/tmp/musicmute-local-logging-ios/Build/Products/Debug-iphonesimulator/MusicMute.app \
  --fixture
```

Android: **424 tests / 67 suites**, zero failures/errors/skips; APK assembled;
lint zero errors and 186 baseline warnings, none located in the new diagnostics.
iOS: **43/43 tests** on iPhone 17 Pro, iOS 26.0, exactly
`3CC14436-EC3C-4419-A079-C84951E5FA07`. Seven exact-source Swift diagnostics tests,
Swift formatting/lint, helper syntax/help and a release-compiled sender check also
passed. Real opt-in/key environment could not enable that release sender.

The final actual iOS fixture instance emitted eight records, with **3.1–261.8 ms**
producer-to-Vector arrival, including an event after three seconds idle. HTTP
fixtures used the real transport with a dedicated URLProtocol; no external API
was contacted. Its trace was queried through MCP and displayed in Logdy.

## Deliberate omissions and limits

Raw third-party mobile/OS logs, arbitrary stacks/messages, Redis positional values,
provider/media bodies and unsupported stream/binary content are omitted explicitly.
Native server file startup begins at EOF, so historical lines are not replayed and
a source without an established checkpoint may miss writes during restart. Owned
application inputs have the tested replay/checkpoint path. Warnings/drops/failures
must be considered when assessing completeness; lack of a record is not proof an
operation did not happen. Native macOS GUI/Windows/Android runtime paths and real
cloud integrations require separate authorized verification. No production health,
capacity, paid-provider outcome or end-user delivery guarantee is implied.
