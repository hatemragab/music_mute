> Retired Cobalt design/evidence. Do not use these deployment instructions. The active replacement is [yt-dlp](../ytdlp_test/README.md), tracked in its [migration plan](../ytdlp_test/migration-plan.md).

# Music Mute: implement and deploy the Cobalt URL-import pilot

**Audience:** An implementation agent with computer-use access to the owner's Chrome browser, the local workspace, and available deployment tools.

**Mode:** Implement, test, deploy, and enable the working pilot. Do not stop at an architecture proposal.

**Prepared:** 2026-09-25. Recheck upstream versions and deployed behavior when executing.

## 1. Objective and authorization

Open the owner's CapRover dashboard at **https://captain.music-mute.com/** using the existing Chrome session. Deploy the official Cobalt API and official YouTube session-generator images as internal applications. Update the existing NestJS project in **`backend/`** so a client can submit one supported media URL instead of downloading and uploading the audio from Android.

The owner authorizes the required backend edits, new CapRover applications, configuration, deployment, smoke tests, and enabling the successfully verified feature. Make reasonable implementation decisions without another design questionnaire. Discover existing names, limits, credentials, and conventions instead of inventing them.

**Keep this a small integration, not a new infrastructure project.** Use Cobalt's existing API, the existing backend, existing Redis, existing S3 integration, and the existing CLI-worker job pipeline. Do not build or fork a downloader service.

If a real access problem or upstream incompatibility prevents completion, finish the independent work safely and report the exact blocker. Never claim a deployment or test passed without evidence.

## 2. Fixed decisions: these override earlier discussion

| Area | Required decision |
|---|---|
| Downloader | Cobalt only. No yt-dlp, other extractor, fallback provider, or custom extractor service. |
| YouTube helper | Deploy the official `imputnet/yt-session-generator` webserver and verify actual compatibility with the selected Cobalt image. |
| Source media | **Fetch audio-only media. Fetching video is forbidden, including temporary audio-plus-video files.** |
| Cobalt processing | Do not use Cobalt to decode, encode, or transcode media. Prefer an unprocessed native audio stream. |
| Backend processing | Reuse the backend's existing probing, decoding, encoding, or normalization only when the established ingestion path needs it. |
| Single item | One media item per request. No playlists, collections, channels, batches, or choosing the first item silently. |
| Queue | A small bounded queue using existing Redis and a maintained queue library, preferably the one already installed. |
| Normal execution | Start work immediately when a slot is available. No added sleeps, download pacing loop, or mandatory gaps between successful jobs. |
| Network | Existing VPS outbound connection for this pilot. No IPv6/FREEBIND, proxy procurement, proxy rotation, VPN, or IP-management implementation. |
| Visibility | Cobalt and the generator are private services. Android communicates only with the existing public NestJS API. |
| Compatibility | Preserve every existing Android upload endpoint and the current CLI-worker contract. |
| Scope | Backend and deployment only. Document the new API for Android; do not make old installed clients depend on an Android update. |

The strict media rule is intentional: an audio output does **not** make downloading an upstream video acceptable. When a link cannot be served as audio without fetching video, return a clear unsupported-audio-source error. Do not relax this rule to improve the success rate.

Native audio may be AAC/M4A, Opus/WebM, MP3, or another accepted audio-only format. WAV is acceptable when it is already the source or is produced by the existing backend pipeline. Do not request WAV from Cobalt merely to standardize the extension.

## 3. Minimal target flow

```text
Existing flow, unchanged:
Android downloads audio -> existing upload/finalize API -> S3
  -> existing processing job -> existing CLI worker

New additive flow:
Android sends one URL -> existing NestJS authentication and admission
  -> bounded import queue in existing Redis
  -> backend calls internal Cobalt API
  -> backend receives a verified native audio-only stream
  -> existing media validation/ingestion -> existing S3 storage
  -> existing processing-job creation -> existing CLI worker

Internal dependency:
Cobalt -> internal YouTube session-generator
```

The new import is an input acquisition step, not a replacement processing system. The CLI worker should receive the same valid input object/job contract it already consumes.

## 4. Discover the existing system before changing it

Read the workspace instructions, Git status, `backend/` configuration, package manifest, lockfile, tests, and deployment files. Trace one successful current upload all the way to worker completion. Identify:

1. Authentication, account quotas, duration/file-size limits, and where quotas are reserved or charged.
2. Upload initialization/finalization, media probing/conversion, S3 key creation, and cleanup.
3. Job creation, duplicate protection, worker dispatch, and current progress notifications.
4. Redis configuration, queue library/version, queue names/prefixes, and processor deployment.
5. The actual backend CapRover app, replica count, current image/release, environment, and deploy mechanism.
6. Available Chrome/terminal/SSH access and a safe rollback path.

Work on a focused feature branch such as `feat/cobalt-url-import` when consistent with the repository workflow. Preserve unrelated edits. Do not reset the workspace, force-push, alter unrelated applications, or replace the deployment workflow.

Do not reconstruct current business rules from this document. Read and reuse the code. In particular, do not introduce device-level quota restrictions, new subscriptions, or a parallel accounting system.

## 5. Redis and secret handling

The owner has already supplied and authorized an internal Redis connection. Its non-secret connection details are:

```text
Host:     srv-captain--redis
Port:     6379
Username: default
Database: 0

Redacted shape:
redis://default:<EXISTING_REDIS_PASSWORD>@srv-captain--redis:6379/0
```

Reuse the backend's existing Redis environment/configuration. Retrieve the actual secret from the owner's existing authenticated CapRover configuration or existing protected workspace configuration. The owner-provided connection can be used at runtime; its password is deliberately not reproduced here.

Do not create a new Redis instance. Use a distinct import queue name/prefix within the existing installation. Do not change Redis eviction, persistence, ACLs, or other applications' settings for this pilot. Never run `FLUSHDB`, `FLUSHALL`, or a broad key deletion.

Keep passwords, Cobalt API keys, Firebase tokens, S3 credentials, generated YouTube tokens, and signed tunnel URLs out of commits, this document, screenshots shared in reports, and logs. Do not rotate shared credentials as an incidental deployment step.

## 6. Verify official images and the YouTube helper contract

Use these official upstream projects and deployment documentation, not a third-party fork:

- Cobalt: https://github.com/imputnet/cobalt
- Official deployment example: https://github.com/imputnet/cobalt/blob/main/docs/examples/docker-compose.example.yml
- Session generator: https://github.com/imputnet/yt-session-generator

The reviewed official example names `ghcr.io/imputnet/cobalt:11` and `ghcr.io/imputnet/yt-session-generator:webserver`. These are **discovery starting points, not a claim that those tags will be the latest at execution time**. Resolve the latest supported published official Cobalt release/image and compatible official generator image; verify architecture, record the running version and image digest, and use the tested digest for reproducibility. Do not assume a `:latest` tag exists. [S4]

### Mandatory compatibility check

A source-level mismatch was observed while preparing this handoff:

- Cobalt's retrieved `api/src/processing/helpers/youtube-session.js` requests `POST /get_pot` and accepts token-field aliases. Retrieved file blob SHA: `d4b5dfd043c4d8c1d932a2b49f4207d5604c8473`.
- The generator's retrieved `potoken_generator/server.py` exposes `/token` and `/update`, not `/get_pot`. Retrieved file blob SHA: `6673322d919f468fd2d13c699da5e063584a415b`.

This concerns the reviewed source revisions; published image contents may differ. **Inspect the exact deployed image versions and test their interaction.** A healthy generator container or successful `/token` request alone does not prove that Cobalt can consume it. [S7][S8]

Prefer a compatible official image pair for the latest supported Cobalt release. Do not write a token-endpoint adapter, modify either project, switch to another extractor, or silently downgrade and call it “latest.” If no compliant pair works, report the precise mismatch and leave YouTube imports unavailable rather than faking completion. Other verified audio providers may still be enabled.

Run the generator and Cobalt with the same normal public egress for this pilot. The generator supplies session data; it does not conceal the VPS IP or guarantee that YouTube accepts requests. [S5]

## 7. Deploy private applications through CapRover

Use the owner's Chrome session to inspect the dashboard and create/reuse only the required new applications. Prefer names:

```text
music-mute-cobalt
music-mute-yt-session
```

Deploy official images through CapRover's existing-image deployment option or a minimal `captain-definition` referencing the verified image. Do not build a new application around them. [S10]

For **both** applications:

- Enable **Do not expose as web app**.
- Leave host port mappings empty. Do not open firewall ports or add public domains.
- Start with one instance. Preserve image startup requirements; do not remove the generator's browser/runtime components.
- Verify internal DNS and connectivity from the relevant containers.

CapRover documents both inter-app networking and compatibility aliases; app-name DNS behavior depends on the installation. Inspect it rather than assuming only one naming convention. The supplied Redis hostname already uses a prefixed alias. [S9]

Prefer and verify these candidate addresses:

```text
http://srv-captain--music-mute-cobalt:9000/
http://srv-captain--music-mute-yt-session:8080/
```

Use the actual resolving app name/alias if different. Do not use `localhost` to communicate between containers. Do not expose a public endpoint as a shortcut when internal DNS fails.

### Cobalt configuration

Resolve placeholders before saving. Match variable support to the deployed release. [S2]

```dotenv
API_URL=http://srv-captain--music-mute-cobalt:9000/
API_PORT=9000
API_LISTEN_ADDRESS=0.0.0.0
YOUTUBE_SESSION_SERVER=http://srv-captain--music-mute-yt-session:8080/
FORCE_LOCAL_PROCESSING=always
API_AUTH_REQUIRED=1
API_KEY_URL=file:///run/music-mute-cobalt/keys.json
DURATION_LIMIT=<EXISTING_BACKEND_HARD_MAX_DURATION_SECONDS>
```

Use the generator's base URL and verify the endpoint/method Cobalt actually requests. Do not guess that appending `/token` fixes a source-code compatibility issue.

Use the maximum legitimate backend media duration as Cobalt's global ceiling, not one arbitrary account tier. Account-specific checks remain in NestJS. Leave `FREEBIND_CIDR`, outbound proxy variables, custom YouTube client overrides, and account cookies unset for this pilot. Do not alter global networking.

Keep one Cobalt instance and do not add Redis to Cobalt merely because Redis exists: the backend queue already uses it. Add Cobalt tunnel-cache Redis only if the chosen topology actually requires it. Retain sensible built-in Cobalt limits; this task does not require a new throttling system.

### One service API key

Use Cobalt's built-in API-key file, mounted through an available existing host/secret configuration mechanism. Generate a fresh UUIDv4 locally. Do not place it in an image layer or public endpoint. [S3]

```json
{
  "<GENERATED_UUID_V4>": {
    "name": "music-mute-backend"
  }
}
```

Mount this as `/run/music-mute-cobalt/keys.json`, preferably read-only. Store the same key in the backend's protected runtime environment. This is one configuration file, not a custom service. Test that unauthenticated processing requests are rejected.

Private networking does not isolate Cobalt from every other trusted app on the shared cluster. Its API key restricts authorized processing to callers holding the backend credential. Do not claim stronger network isolation than was actually configured.

### Verify before backend integration

Confirm internal Cobalt instance info is reachable, authentication works, returned tunnel origins are internal, and the generator returns valid session data. Confirm Cobalt logs successful consumption of that data without exposing it. Verify the two applications have no public routes or host mappings.

Do not install Watchtower or grant Docker-socket access just because an example Compose file includes it. Use CapRover's normal release lifecycle.

## 8. Prove the strict audio path before enabling providers

Call Cobalt directly from the existing backend. Use its API schema; these settings are the initial request profile to verify against the selected version. [S1][S6]

```http
POST /
Accept: application/json
Content-Type: application/json
Authorization: Api-Key <BACKEND_SERVICE_KEY>
```

```json
{
  "url": "<SINGLE_VALIDATED_MEDIA_URL>",
  "downloadMode": "audio",
  "audioFormat": "best",
  "alwaysProxy": true,
  "localProcessing": "forced",
  "disableMetadata": true,
  "youtubeHLS": false
}
```

“Local processing” refers to Cobalt's API client, which here is **NestJS**, not Android. Use it to obtain unprocessed source tunnels instead of asking Cobalt to transcode. Do not request cover art, subtitles, alternate full soundtracks, or video streams.

**Neither `audioFormat: best` nor `alwaysProxy: true` proves the source is audio-only.** The reviewed action-selection source has processing branches, including HLS handling, that need explicit verification. The local-processing `output` describes an intended output and is not proof of the input stream's tracks. [S11][S12]

Implement only a small acceptance check in the existing integration:

1. Enable provider/link paths for which the selected Cobalt release demonstrably returns a separate audio source without Cobalt conversion.
2. Accept a single native audio tunnel on that verified path. A verified local-processing response may include `type: proxy`; validate against actual source/behavior instead of relying on an incomplete hand-written enum.
3. Reject picker, video/merge, ambiguous source, and unverified HLS/transcoding paths **before requesting their media bodies**.
4. Do not fetch an unknown video-containing file merely to inspect or strip it. Source verification comes first; backend probing is an additional integrity check afterward.
5. Do not execute processing commands or fetch every URL described by a Cobalt response.

Start with YouTube and an independent audio source such as SoundCloud as test targets, **not assumed successes**. Enable additional Cobalt-supported providers only when this same rule is satisfied. If a source needs custom extraction logic to satisfy the rule, reject it in the pilot rather than write that logic.

Cobalt's supported-services list describes output capabilities. It is not a promise that every listed provider supports Music Mute's stricter no-video-fetch policy. Record the tested subset and any link-type limitations. [S13]

Resolve Cobalt's short-lived tunnels only when the queued import starts. Consume them immediately; do not resolve them at admission and leave their URLs waiting in Redis. Do not persist them as permanent source URLs. [S2]

## 9. Add the smallest backend API integration

Reuse the project's route prefix, DTO validation, authentication guards, error envelope, logging, HTTP client, and dependency injection. Do not introduce a provider framework for a single integration.

Suggested additive contract, adapted to existing conventions:

```http
POST /v1/media/imports
Authorization: Bearer <EXISTING_USER_TOKEN>
Content-Type: application/json

{"url":"https://www.youtube.com/watch?v=<VIDEO_ID>"}
```

Return quickly after successful admission:

```json
{
  "importId": "<OPAQUE_IMPORT_ID>",
  "status": "queued"
}
```

Use HTTP `202` unless the existing API has an established equivalent. Reject known invalid/unsupported/playlist requests before admitting them. Do not keep the request open through the download.

Expose owner-scoped status through an existing mechanism or:

```http
GET /v1/media/imports/<IMPORT_ID>
```

Reuse existing job/storage models where suitable; do not force new import-only states into an old enum if that would break installed clients. A small import record is acceptable when needed. Store only the account owner, source URL/provider, state, resulting job reference, and sanitized error/progress details necessary for the feature.

Suggested progression:

```text
queued -> downloading -> validating -> uploading -> submitted
                                                \-> failed
```

Return the existing processing `jobId` once submitted. From there, the existing job-status mechanism remains authoritative. Do not mark separation complete merely because import completed.

### Notifications, not imaginary Cobalt webhooks

Cobalt's documented contract returns a result/tunnel for the caller to consume; do not assume a download-completion webhook exists. The backend knows completion from its stream/ingestion operation. [S1]

Reuse existing queue completion events and existing mobile notifications/socket events. If no notification facility exists, the status endpoint is sufficient for this pilot. Do not create a webhook platform, arbitrary callback-URL field, or publicly exposed internal callback endpoint. The owner wants completion visibility, not a new messaging system.

## 10. Small bounded queue on existing Redis

Use the installed maintained queue package. If none exists, add the standard NestJS/BullMQ integration, not a custom Redis scheduler. Keep the processor inside the existing backend deployment structure.

Pilot defaults, unless equivalent existing limits already apply:

```dotenv
URL_IMPORT_ENABLED=false
URL_IMPORT_CONCURRENCY=2
URL_IMPORT_MAX_OUTSTANDING=20
```

These are **proposed application settings**, not Cobalt environment variables. Reuse existing names when possible. `MAX_OUTSTANDING` includes active and waiting imports; it is not a completed-job retention limit.

Reuse the existing bounded admission mechanism. If absent, add only the minimal race-safe capacity check/reservation necessary for this queue. A plain count-then-add check can race under concurrent submissions; test the actual boundary. Do not build a queue framework or custom worker system.

Apply concurrency across actual processor replicas, not accidentally per replica. Use the queue library's supported global concurrency where available; do not upgrade or replace the whole queue subsystem just for this feature. BullMQ documents a global concurrency setting distinct from worker-local concurrency. [S14]

Start eligible jobs as soon as a slot becomes free. When full, reject new admission with a clear retryable capacity error. Do not insert artificial sleep calls or add a request-pacing scheduler. Use one processing attempt for upstream-blocking failures in this pilot; no rapid retry loop on `403`/`429`, authentication failures, or unsupported content. Reuse existing bounded handling for ordinary transient infrastructure failures.

Preserve existing idempotency/unique-job safeguards so retries or processor recovery cannot create duplicate paid processing jobs. Do not put media bytes, secrets, or tunnel links in queue payloads. Retain enough failed/completed state to make status queries meaningful, using existing retention/cleanup patterns.

## 11. Checks, native ingestion, S3, and worker handoff

### Before admission or media transfer

Use existing account authentication and quotas. Parse a normal HTTP(S) provider URL; reject credentials in URLs, arbitrary internal destinations, unknown hosts, and unsupported schemes. Use established URL-validation helpers and a small verified-provider allowlist, not a general-purpose remote-file downloader.

Reject playlist/collection-only URLs explicitly. For a single-video URL carrying a playlist parameter, reject it with an instruction to submit the clean single-video link; do not silently import the collection or first item. Cover shortened provider URLs through Cobalt's existing resolver without adding a custom resolver.

Apply all limits that can be checked at this stage. Use Cobalt's configured global duration ceiling as an early safeguard where its extractor supports it. Do not assume Cobalt has an undocumented metadata/duration endpoint.

### After receiving a verified audio-only source

Use the established backend ingest path. Prefer its temporary-file workflow if that is already used: a bounded temporary file, existing probe/validation, existing S3 upload, then existing job creation. Avoid building a separate streaming/storage architecture for this pilot.

Enforce the existing hard byte limit while reading, even if `Content-Length` is absent. Use finite request/stream deadlines from existing configuration and abort failed transfers. Keep memory bounded; do not buffer a whole potentially large media file in RAM.

Probe the downloaded audio with the existing tooling. Validate actual duration, audio presence, accepted container/codec, and absence of a video stream. Do not trust filenames or output MIME labels as track verification. Apply the account's real duration and quota rules before S3 acceptance/worker submission. Where Cobalt could not expose account-specific duration earlier, make this final validation authoritative.

Reject over-limit media without submitting it for separation. Clean up only this import's temporary/staging objects. Reuse existing quota reservation/release/charging rules; an import is not a second billable separation job. Recheck quota at the established finalization point to avoid concurrent-import overspend.

Preserve the actual native extension and content type; do not relabel Opus/WebM as WAV or M4A. Reuse existing conversion only when needed for current ingestion/worker compatibility. Store media using the existing server-generated S3 key pattern and permissions, never a caller-selected key or bucket.

Only after a successful validated upload invoke the same application service that the old upload-finalization flow uses to create the processing job. Do not fabricate worker documents directly or make the CLI worker download provider URLs. Reuse cleanup and retry/idempotency behavior for failures between S3 upload and job creation.

Basic URL/stream safety, ownership, existing business limits, and cleanup remain part of correctness. Advanced anti-abuse infrastructure is out of scope.

## 12. Clear errors without widening scope

Use the existing error envelope and naming conventions. Provide distinctions equivalent to:

| Situation | User-facing meaning |
|---|---|
| Invalid URL | Enter a valid media link. |
| Unsupported provider | This website is not supported for URL import. |
| Playlist/collection | Only one media item is supported; submit a single-item link. |
| No compliant audio source | This link cannot provide audio without downloading video. |
| Duration/file-size limit | The media exceeds the permitted limit; include the real applicable limit. |
| Account quota exceeded | The account does not have enough remaining allowance. |
| Import queue full | Import capacity is currently full; try again later. |
| Private/unavailable media | The source is unavailable or requires access not supported by this import feature. |
| Upstream block/rate limit | The source platform temporarily refused the request. |
| Internal dependency failure | Import failed; no processing job was submitted. |

Do not map every upstream error to “IP blocked.” Do not expose raw upstream traces, tokens, internal URLs, or signed URLs to Android.

Pre-admission failures return an HTTP error immediately. Failures after `202` appear on the import status and existing notifications with the same structured code/message. Avoid charging twice on retries.

## 13. Tests required before and after deployment

Use small owner-authorized or otherwise permitted test media. Prefer integration mocks for limits, failures, and concurrency; never load-test a public provider to prove queue behavior.

Prove the following, and record pass/fail with evidence:

1. Current upload initialization/finalization and existing worker processing still work with the old API contract.
2. Cobalt and generator are internal; processing without the backend service key fails.
3. The exact deployed Cobalt/generator pair actually exchanges usable session data.
4. A YouTube link imports a separate audio stream, without fetching video or starting Cobalt conversion. A status `200` alone is insufficient.
5. At least one independent supported audio provider completes the same flow, when upstream access permits.
6. A source requiring video download is rejected before media transfer; picker and unverified processing paths are rejected.
7. Playlist/collection, unknown website, missing audio, excessive duration, and excessive actual bytes return the correct errors and create no processing job.
8. Account authentication, ownership isolation, quota accounting, and duplicate protection hold.
9. Multiple admissions respect active concurrency and maximum outstanding capacity, including simultaneous submissions. Ready jobs have no artificial delay.
10. An upstream `403`/`429`, generator failure, and expired tunnel fail cleanly without retry storms or stuck states.
11. S3 upload or finalization failure does not produce an invalid/duplicate worker job and cleans up this import appropriately.
12. A backend restart/deploy leaves new import records recoverable or terminal, not permanently “downloading.”
13. A successful import uploads validated audio, creates exactly one existing processing job, and the existing CLI worker produces the expected result.

For the strict source rule, use the selected Cobalt source path and observable stream/processing behavior as evidence, plus a backend probe of the actual received audio. A final audio file alone does not prove no upstream video was fetched.

If a live provider is inaccessible from the VPS, record the real failure. Do not substitute mocked success for a live end-to-end pass or purchase network services to hide it.

## 14. Deploy and enable without breaking existing clients

Run the existing formatter, lint, type checks, build, and relevant tests. Update only the necessary deployment configuration and environment. Add concise API usage examples to existing backend documentation; avoid a new dashboard.

Deploy the new private applications first, then deploy the additive backend change using the established CapRover workflow. Keep URL importing disabled until configuration and smoke tests pass, then enable the verified pilot paths with `URL_IMPORT_ENABLED=true` or the existing equivalent.

Keep upstream-specific failures scoped to the affected import/provider. If YouTube cannot satisfy the verified latest-image/helper contract, do not claim YouTube readiness or disable the old file-upload flow. Enable other verified providers when useful and clearly report the partial result.

Old Android installations must keep working without knowing Cobalt exists. New Android integration needs only the new URL submission/status contract; do not distribute internal Cobalt credentials or URLs.

### Rollback

Record the pre-change backend release/image and relevant non-secret configuration. If the new feature fails, disable only URL-import admission, safely stop/finish its own in-flight work, and preserve existing uploads and worker processing. Restore the previous backend release if regression requires it. Do not stop shared Redis, clear shared queues, delete user files, or change worker protocols.

Use additive database changes. Avoid any migration that prevents the previous backend image from running.

## 15. Completion report

Finish with a compact report containing:

- Actual CapRover app names, verified internal addresses, image versions/digests, and generator compatibility result.
- Backend branch/commit, changed files, deployment result, and final feature state.
- New request/status examples with placeholders, not secrets.
- Verified provider/link types and rejected unsupported-audio paths.
- Test results, including old-client regression and real S3-to-worker completion evidence.
- Queue limits, reused account limits, exact rollback steps, and any concrete remaining blocker.

Explicitly distinguish **implemented**, **deployed**, **enabled**, and **live-tested**. Do not call the task complete merely because containers start.

**Do not add:** IPv6/FREEBIND, proxy rotation, stealth/anti-block guarantees, custom downloaders, a Cobalt fork, token API shims, browser automation of media websites, personal account cookies, playlist support, arbitrary callbacks, device quotas, new payment rules, or a new infrastructure control plane. Those are not this pilot.

## Source references and version notes

These primary references support the integration facts above. They do not prove the owner's deployment already works. Inspect sources matching the actual published image rather than assuming the current default branch equals the image.

- **[S1] Cobalt HTTP API:** https://github.com/imputnet/cobalt/blob/main/docs/api.md
- **[S2] Cobalt configuration:** https://github.com/imputnet/cobalt/blob/main/docs/api-env-variables.md
- **[S3] Cobalt API-key setup:** https://github.com/imputnet/cobalt/blob/main/docs/protect-an-instance.md
- **[S4] Official container deployment example:** https://github.com/imputnet/cobalt/blob/main/docs/examples/docker-compose.example.yml
- **[S5] Official session-generator README:** https://github.com/imputnet/yt-session-generator
- **[S6] Cobalt request schema:** https://github.com/imputnet/cobalt/blob/main/api/src/processing/schema.js
- **[S7] Cobalt token-client implementation:** https://github.com/imputnet/cobalt/blob/main/api/src/processing/helpers/youtube-session.js
- **[S8] Generator HTTP routes:** https://github.com/imputnet/yt-session-generator/blob/main/potoken_generator/server.py
- **[S9] CapRover private-app settings and service DNS:** https://caprover.com/docs/app-configuration.html
- **[S10] CapRover image deployment:** https://caprover.com/docs/captain-definition-file.html and https://caprover.com/docs/deployment-methods.html
- **[S11] Cobalt processing/action selection:** https://github.com/imputnet/cobalt/blob/main/api/src/processing/match-action.js
- **[S12] Cobalt response construction:** https://github.com/imputnet/cobalt/blob/main/api/src/processing/request.js
- **[S13] Cobalt provider/output capabilities:** https://github.com/imputnet/cobalt/blob/main/api/README.md
- **[S14] BullMQ global concurrency:** https://docs.bullmq.io/guide/queues/global-concurrency
