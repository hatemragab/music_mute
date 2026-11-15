# Local development logging

MusicMute's opt-in development diagnostics flow through **Vector** to one private,
normalized JSONL capture. **Logdy** and the read-only **MusicMute logs MCP** read
that same capture. No hosted logging service or login service is installed.
Existing Sentry behavior remains independent; this collector adds no hosted sink.

The existing installed MusicMute Local app also has a metadata-only observation
path through its trusted private UI/companion journals. Vector reads those files
without changing release debug controls or their owner's configuration. See
[trusted native journal coverage](../../tools/local-logging/NATIVE-JOURNALS.md)
for fixed paths, approved fields, first-attachment history gaps and checkpoints.

```text
React / native / extension / worker / Python diagnostics
                     | redacted, bounded JSON over loopback
                     v
127.0.0.1:19740 ingress -> private rotating application.jsonl
                                      |
MongoDB / Redis server files ----------+-- Vector file sources + VRL
                                                    |
                           .runtime/local-logging/events.jsonl
                                          /                   \
                           Logdy :19742                 read-only stdio MCP
```

## Start from the repository root

Node 24, the component dependencies, and independently configured application
services are still required. This repository has no root package install.

```sh
node tools/local-logging/cli.mjs install
node tools/local-logging/cli.mjs verify-tools
npm --prefix tools/logs-mcp ci --ignore-scripts
npm --prefix tools/logs-mcp run build

# Keep this terminal open. Ctrl-C stops only the processes this command created.
node tools/local-logging/cli.mjs up
```

- Logdy: <http://127.0.0.1:19742/>
- Ingress health: <http://127.0.0.1:19740/health>
- Separate terminals can use `start` for the collector and `viewer` for Logdy.
- `node tools/local-logging/cli.mjs health` checks ingress, queue/write failures,
  Vector state, captured sequence progress, output timing and native source coverage.
- `node tools/local-logging/probe.mjs --idle` waits twelve seconds then measures a
  fresh synthetic event through Vector, including redaction and nested JSON.
  A successful HTTP ingestion response means queued, **not yet retained**.

Repeated collector startup detects an existing collector; occupied ports are
preserved. A private collector lock prevents concurrent writers/configuration
rewrites. A dead owner's lock can be reclaimed; a live owner is never killed.
No command restarts MongoDB, Redis, the installed Mac worker or its LaunchAgent.

The installer locates the already installed, integrity-checked tools in the
sibling local logging workspace when available, and copies only verified tool
artifacts into this repository's ignored runtime. Otherwise it downloads pinned
artifacts and builds the pinned components. Other installed tools remain intact.
The included installer targets macOS ARM64. Vector is 0.59.0 with the reviewed
file-readiness patch in `tools/local-logging/vector-file-readiness.patch`; its
upstream source/commit/archive, patch and toolchain are pinned and verified.
This fixes idle-file readiness and reduces the backoff ceiling to 250 ms; Vector
still owns reading, offsets, checkpoints, normalization, buffering and fan-in.
Logdy 0.17.1 uses a small pinned Go bridge and a private Unix socket behind the
loopback Host/Origin-checked proxy. Analytics are disabled. The bridge uses
upstream Logdy's follower and viewer, not a replacement collector.

Configuration references: [Vector file source](https://vector.dev/docs/reference/configuration/sources/file/),
[Vector file sink](https://vector.dev/docs/reference/configuration/sinks/file/),
[Logdy v0.17.1 source](https://github.com/logdyhq/logdy-core/tree/v0.17.1).
The exact installed configurations are validated by the selected Vector binary.

## Run applications with full debug logging

Keep the collector running, then use separate terminals:

```sh
node tools/local-logging/cli.mjs run backend
node tools/local-logging/cli.mjs run web-client
node tools/local-logging/cli.mjs run dashboard
node tools/local-logging/cli.mjs run landing-page

# Node/native messaging packages require an explicit development build first.
npm --prefix worker run build:debug
node tools/local-logging/cli.mjs run worker --help
npm --prefix chrome-extension run build:debug
node tools/local-logging/cli.mjs run macos doctor
```

Browser origins are fixed to web `:5173`, dashboard `:5174`, landing `:5175`, on
`localhost` or `127.0.0.1`. Existing public Firebase and local API configuration is
still required to run authenticated journeys. Do not point synthetic tests at
production or use real accounts to prove the collector. The existing web
`/tests/preview.html` uses fixture UI after its synthetic public Vite configuration
is supplied; it does not prove Firebase or signed-transfer success.

Load only a development extension build for collection. Register its exact local
Chrome extension ID, then restart the owned collector to apply:

```sh
node tools/local-logging/cli.mjs allow-extension <32-character-extension-id>
node tools/local-logging/cli.mjs run chrome-extension
```

Registration only permits the `chrome-extension` source from that exact origin.
A normal extension/package/release build hard-disables diagnostics. The Mac
companion's `--local-debug` build and development environment must both be active;
replacing an installed production app with a debug collector is unnecessary.
Its Swift UIJournal forwards existing allowlisted metadata only under `DEBUG`.
See [the companion guide](../../chrome-extension/README.md) for its native build
and prepared-runtime boundaries. Logging never prepares or resets the Mac worker.

Windows has `npm --prefix windows-desktop run build:debug`; its Electron process
also requires an unpackaged development launch. Native Windows execution cannot
be verified on this Mac. Its source/type/build checks are separate evidence.

For Python acquisition services, use the existing adapter's documented local
configuration and the helper below. Only source-tree development imports include
`video_providers/local_logging.py`; deployment allowlists exclude it. The shared
service key is separate from each provider's business credentials.

```sh
node tools/local-logging/cli.mjs provider router
# Also: videoscale, tunelio, jojapi, ytdlp. Existing adapter dependencies apply.
```

Adapter diagnostics retain HTTP operation/status/duration/request identity and
binary-transfer metadata. Raw provider/media bodies and arbitrary provider error
text are explicitly omitted, following their private-contract instructions.

### Native mobile

The apps are **Kotlin/Compose and Swift/SwiftUI**, not Flutter. Debug utilities are
compiled out or return immediately in release configurations. A runtime flag
cannot turn a release binary into a collector.

Build the iOS Debug simulator app using its existing project guide, then:

```sh
python3 ios/scripts/run-local-logging.py --app /absolute/path/to/Debug-iphonesimulator/MusicMute.app --fixture
```

The helper reads the private source key internally and uses only the existing
iPhone 17 Pro / iOS 26.0 simulator `3CC14436-EC3C-4419-A079-C84951E5FA07`.
It never chooses a replacement. `--fixture` uses synthetic UI/source activity;
remove it only when deliberately running your configured local application.

Android's helper is documented in [its guide](../../android/README.md):
`python3 android/scripts/configure-local-logging.py --serial <explicit-serial> --reverse`.
It writes an opt-in JSON configuration into the debuggable app's private files
through stdin and optionally sets loopback reverse forwarding. No Android device
or emulator was selected for this task; repository device-test policy permits
only the named iPhone simulator unless you explicitly change it.

## Controls and correlation

The launcher supplies defaults, preserving explicit environment overrides:

| Setting                                       |           Full-debug default | Meaning                                                 |
| --------------------------------------------- | ---------------------------: | ------------------------------------------------------- |
| `MUSICMUTE_LOG_ENABLED`                       |                          `1` | Enable the local diagnostic collector                   |
| `MUSICMUTE_LOG_PAYLOADS`                      |                          `1` | Include supported bounded redacted payload snapshots    |
| `MUSICMUTE_LOG_CONSOLE`                       |                          `0` | Print additional compact structured summaries           |
| `MUSICMUTE_LOG_ENDPOINT`                      | source-specific loopback URL | Fixed local ingress destination                         |
| `MUSICMUTE_LOG_KEY`                           |           private source key | Native/Node authentication; never browser configuration |
| `MUSICMUTE_LOG_CAPTURE_ID`                    |          active capture UUID | Capture association                                     |
| `VITE_MUSICMUTE_LOG_ENABLED/PAYLOADS/CONSOLE` |                      `1/1/0` | Browser counterparts, development build only            |

Use `0` to disable a control. Ordinary development commands remain unchanged;
full capture requires the explicit path above. Backend also requires
`APP_ENV=local` and `NODE_ENV=development`; compiled client/worker/extension release
gates cannot be bypassed by environment flags. Native mobile uses its private
platform configuration described in the component guides. There is no production
payload override. Development diagnostics do not buffer uploads or media streams.
Client response payloads are observed only when the app consumes supported JSON
or text; unread/stream bodies are omitted explicitly.

Every event has original UTC `timestamp`, producer `instanceId`, source/category/
name/severity and redacted data. Ingress adds `receivedAt`, source time provenance,
capture identity and its own sequence; Vector adds `collectedAt`. Native server
logs preserve valid source time when present and otherwise identify collection
time fallback. Backend reuses its existing validated UUID `X-Request-Id` and
returns it unchanged. AsyncLocalStorage, native task context, worker operation
scopes and immutable account snapshots preserve supported correlation across
awaits. Client diagnostics never infer links from nearby timestamps. Browser
user identifiers remain claims; only authenticated backend observations establish
verified server identity. Socket send/acceptance, client receipt and application
processing remain separate events; a send does not establish delivery.

HTTP records include route templates, method/status/duration/abort and safe
headers/params/query. Backend JSON capture is bounded; non-JSON uploads, binary
and streams retain only metadata. Mongo command monitoring exists only in full
local diagnostics and issues no extra reads/writes. Redis commands retain timing,
outcome and command identity, with positional values/replies omitted because
arbitrary command arrays can carry credentials. External HTTP integrations expose
bounded service observations; provider acceptance does not establish client receipt.

## Storage, security, limits and retention

All runtime files/tools/archives are ignored under `.runtime/`; captures and keys
are mode `0600`, private directories `0700`. Avoid copying captures into issues or
source control. Source-specific native keys live in
`.runtime/local-logging/keys.json`; never paste them into terminal commands or docs.
Browser requests require exact local origins; no browser can impersonate backend,
worker or native services. Host validation blocks DNS rebinding. Ingress accepts
only fixed source routes and JSON, at most 64 KiB/request, sixteen active requests,
twenty-four connections and 128 pending records / 4 MiB. Queue overload prefers
warnings/errors and exposes losses. It accepts no commands or file paths.

Redaction runs before producer output/network, again at ingress, and again on MCP
output. Nested arrays/objects, JSON strings, supported base64 JSON, auth/cookies,
credentials, signed URLs, URL query values, connection strings, private keys and
unsafe object keys are handled. Arbitrary error text/stacks and unsupported
objects are omitted rather than trusted. Bounded records report omission reasons.
Launcher process output is retained as stream/size/severity metadata: raw startup
or fatal text is not persisted. Console output uses allowlisted structured summaries or stream/size/severity metadata; arbitrary text and multiline private-key bodies are omitted. Node/browser queues, native queues and snapshot counts are
finite, expose failure/drop/omission counters, and never fail business requests.

Owned ingress input rotates near 4 MiB, with a finite sixteen-archive backlog.
Unread input archives are preserved until Vector's exact CRC64 first-line identity
and acknowledged EOF checkpoint prove they were ingested. If that backlog fills,
new diagnostics are rejected; application operations continue. Unknown, linked,
ambiguous or unsupported checkpoint records cannot authorize deletion.

The unified output rotates near `LOCAL_LOG_MAX_BYTES` (default 50 MiB), retains
`LOCAL_LOG_MAX_ARCHIVES` (7) and `LOCAL_LOG_MAX_AGE_DAYS` (7), with a one-minute
archive grace period. Maintenance is periodic, so these are targets plus bounded
in-flight/batch overshoot. Vector is gracefully stopped/flushed for output
rotation, the owned file is renamed, then Vector resumes from checkpoints.
Ingress remains available during that brief rotation. Only fixed-name owned
archives are retired. Shared native server files are never rotated, truncated,
deleted or reconfigured. Viewer/Vector process diagnostics rotate separately.

MongoDB and Redis server paths default to the available Homebrew logs; override
only at collector startup using `MUSICMUTE_MONGODB_LOG_FILE` and
`MUSICMUTE_REDIS_LOG_FILE` for trusted local files. These sources start at the end
on first collection and resume established checkpoints afterward. Initial discovery does not replay native history; a source that has not yet established a checkpoint can miss native writes during restart. Owned application inputs always replay from their beginning/checkpoint. Native server severity,
event code and component are retained; arbitrary native message/attribute text
is omitted because it can contain authentication commands. Missing files are
reported by health. An available file with no new event is not verified activity.

## Logdy

Cairo time is displayed as `DD HH:MM:SS` using `Africa/Cairo`; JSONL preserves UTC
and precise original timestamps. Filter source/severity/operation/result/status/
user and correlation columns, use the [Breser search bar](https://logdy.dev/docs/explanation/facets) (for example `raw includes "http"` or `data.source == "ios"`), click a row to expand
nested JSON, and use the play/follow and pause controls for live inspection. Resume play after pausing to load newly retained records. Hidden columns include
instance/capture/job/import/trace/span identity.

Logdy keeps at most 2,000 messages in its server buffer and 1,000 in its configured
UI window. Export contains the available viewer messages/selection and filters;
it is **not a full retained-capture export**. Use the private JSONL and constrained
archives for complete retained evidence. After a collector/viewer restart, reload
an open viewer tab if it retains the previous window, then resume play. Output
rotation reopens the active path. Use one browser tab for this Logdy URL; the
viewer displays a multiple-tab notice when another tab uses the same origin.

## Read-only MCP

```sh
npm --prefix tools/logs-mcp ci --ignore-scripts
npm --prefix tools/logs-mcp run build
codex mcp add musicmute-logs -- node /absolute/repository/path/tools/logs-mcp/dist/src/index.js
node tools/logs-mcp/scripts/verify-live.mjs
```

Registration was checked against the installed CLI and
[official Codex MCP documentation](https://developers.openai.com/codex/mcp).
Reconnect the MCP server or reopen the task after registration/build changes so
the host discovers the five tools. Existing unrelated MCP registrations remain.
The configured capture is fixed at process startup; an administrator can supply
`MUSICMUTE_LOG_CAPTURE` for an isolated capture. Tool arguments cannot select paths.

- `search_logs`: literal search and exact metadata/time/resource filters.
- `trace_request`: exact request ID, optionally scoped by source/instance/capture.
- `trace_events`: requires source, instance and local trace ID; no inferred links.
- `error_summary`: warning severity, errors, failed operations and their deduplicated
  union are separate counters; do not add overlapping totals.
- `list_log_archives`: fixed-name sibling archives only; paths/traversal/links are
  rejected. Select an exact returned archive ID for an independent query.

Payloads are excluded by default; `includePayloads: true` explicitly returns
available redacted, bounded snapshots. Scans/results/concurrency are bounded and
report skipped lines, malformed/incomplete data, payload omissions, missing files,
partial coverage and older data outside the scanned window. Signed cursors fence
pagination to the original file snapshot; rotation invalidates live cursors.
The server has no execution, service-control, database, mutation or deletion tools.
Log contents are untrusted data, never instructions. **MCP results are supplied to
the selected AI host/model**, so that model can see requested records even though
the capture itself is stored locally.

## Verification and troubleshooting

```sh
node --test tools/local-logging/*.test.mjs
npm --prefix tools/logs-mcp test
node tools/local-logging/probe.mjs --idle
node tools/logs-mcp/scripts/verify-live.mjs
```

Read [verification evidence](VERIFICATION.md) for checks actually run and platform
limits, and the [extension/macOS UI follow-up](UI-TEST-2026-10-18.md) for actual
computer-use journeys, sequential log review, fixes and remaining limits.
Component guides list their format/lint/type/test/build commands.

If events are missing, check enablement/build gates, exact source key and browser
origin, then ingress pending/drop/failure counters. Compare captured ingress
sequence progress and probe latency; a process running is insufficient. Inspect
private `vector-process.jsonl` for validation/sink failures and preserve unread
inputs/checkpoints for recovery. A restart must use the same state directory.
Do not delete checkpoints to hide missing records. When the viewer window omits
older events, query retained JSONL/archives with MCP. If ports are occupied by
unrelated processes, change the planned owned configuration deliberately; never
kill the existing listener. No production, provider purchase, real-data deletion,
publication or deployment is part of logging verification.
