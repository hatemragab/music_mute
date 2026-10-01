# MusicMute private audio acquisition router

Production YouTube configuration selects JoJAPI for the
[owner-authorized test activation](../jojapi/docs/ACTIVATION-2026-10-01.md).
The known vendor source-version mismatch remains unresolved; see the
[earlier qualification and Tunelio restoration](../jojapi/docs/DEPLOYMENT-2026-10-01.md).
Successful transfer or media probing does not establish requested-source identity.
The router keeps NestJS provider-neutral while selecting one private adapter:

`NestJS → router → configured YouTube adapter / VideoScale for other enabled sites`

`adapter audio bytes → router → NestJS validation → existing private R2 → worker`

The existing VideoScale app remains deployed. Routing is decided before any
upstream submission. YouTube failures never fall back to VideoScale; a fallback
could spend credits twice after an ambiguous result. There is exactly one
adapter `POST /audio-imports` per execution, with no retry or redirects.

## Contract and admission

[OpenAPI](openapi.yaml) preserves the existing provider-neutral binary contract:
`GET /health` and authenticated `POST /audio-imports`. Requests contain only
`url`, `max_bytes` and `max_duration_seconds`. URL length is capped at 2048,
JSON request bodies at 4096 bytes, audio at 100 MB decimal and requested duration
at 1800 seconds. Lower caller limits are forwarded unchanged.

[Source admission](source_policy.py) matches the existing VideoScale catalog's
public single-item shapes. Exact qualified YouTube hosts canonicalize to
`https://www.youtube.com/watch?v=<id>` and use the single configured YouTube
adapter. Instagram, TikTok, Vimeo,
SoundCloud, Facebook, Bandcamp, Mixcloud, hearthis.at, Clyp, Vocaroo and Whyp
use VideoScale. Playlists, profiles, credentials, ports, fragments, unsafe URLs
and unqualified destinations are rejected before submission. Tracking query
parameters are removed. Keep this policy, VideoScale admission and the shared
client site catalog aligned when adding platforms. Admission is not proof that
every source offers usable separate audio.

The router receives service keys only, never vendor credentials. It replaces
the incoming bearer with the selected adapter's key and forwards only JSON
content headers and a validated/generated execution UUID. That UUID is internal
correlation, not idempotency. No cookies or incoming user headers are forwarded.

Successful responses require one valid positive `Content-Length` within the
caller limit and an allowlisted audio/octet-stream content type. Transfer
encoding and compressed responses are rejected. Audio is relayed in 64 KiB
chunks without memory buffering of the full file or persistent scratch. A
truncated transfer closes the binary response; NestJS's independent exact byte
count, ffprobe validation and duration enforcement still determine admission.
Bytes outside HTTP's declared response framing are never relayed.

All responses use `Cache-Control: no-store`. Only bounded, decoded, allowlisted
schema-version-1 metadata is re-encoded into `X-Import-Extra-Data-Base64`; invalid
metadata is nonfatal. URLs, credential-shaped text, exact runtime service keys
and unknown fields are dropped. No Location, cookie, signed-URL or other raw
upstream header is forwarded. Error bodies are never read or copied. Only
allowlisted `IMPORT_*` error/status pairs survive; other failures become a
sanitized `IMPORT_DEPENDENCY_FAILED` problem response. A bounded numeric
`Retry-After` on 503 does not authorize automatic paid resubmission.

Twenty admitted relays and sixty-four HTTP handlers are bounded. One shared
capacity pool covers both destinations; there is no per-provider serialization.
Additional requests wait for a slot before submission, within the original
600-second operation deadline, with cancellation checks. A shared rolling-second
admission gate starts at most five adapter requests per second across both routes.
Waiting never retries or replays a submission. The backend's durable queue holds
the normal backlog; the router's bounded handlers protect its private HTTP hop.
The independent health handler never contacts or waits for adapters. A 100 ms
watcher interrupts blocked upstream headers/body reads on caller disconnect or
deadline, including Connection-close response sockets. Already submitted vendor
work may still spend quota; upstream cancellation is not guaranteed.

Logs contain only route, opaque request UUID, stable result, numeric HTTP status,
transferred bytes and duration. No source URLs, raw error text, bodies, secrets
or delivery links are logged.

## Configuration and CapRover

Create private app `music-mute-audio-router`, no public web exposure, domains,
host ports or persistent volumes, one replica, HTTP port 8080. Apply
[caprover-override.json](caprover-override.json): non-root read-only runtime,
dropped capabilities, 128 MiB RAM, half a CPU and bounded logs. The router
does not require writable scratch or FFmpeg.

Use [config.example.json](config.example.json) for nonsecret settings:

| Environment key                     | Runtime value                                     |
| ----------------------------------- | ------------------------------------------------- |
| `ACQUISITION_CONCURRENCY`           | Shared active capacity, 1–20; default 20          |
| `ACQUISITION_REQUESTS_PER_SECOND`   | Shared start rate, 1–5; default 5                 |
| `AUDIO_ACQUISITION_API_KEY`         | Private NestJS/router service key                 |
| `YOUTUBE_AUDIO_ACQUISITION_API_URL` | `http://srv-captain--music-mute-tunelio:8080/`    |
| `YOUTUBE_AUDIO_ACQUISITION_API_KEY` | Private bearer for the selected YouTube adapter   |
| `OTHER_AUDIO_ACQUISITION_API_URL`   | `http://srv-captain--music-mute-videoscale:8080/` |
| `OTHER_AUDIO_ACQUISITION_API_KEY`   | Existing private VideoScale service key           |

Startup accepts exactly one YouTube destination: `music-mute-tunelio` or
`music-mute-jojapi`, with their `srv-captain--` aliases. The other-site destination
accepts only `music-mute-videoscale` or its alias. All destinations require HTTP
port 8080 and an empty/root path. Arbitrary URLs, public hosts, redirects and
user-controlled destinations are never permitted. Selection comes only from
operator configuration and does not change after any execution failure.

[caprover-adapter-hook.js](caprover-adapter-hook.js) injects the existing private
key from `/captain/data/musicmute-acquisition/api-key` for ingress and VideoScale,
and the selected adapter's separate private service key from
`/captain/data/musicmute-acquisition/tunelio-api-key` or
`/captain/data/musicmute-acquisition/jojapi-api-key`. The hook reads exactly one
`YOUTUBE_AUDIO_ACQUISITION_API_URL` entry from CapRover's `envVars`, validates the
exact private URL and reads only that adapter's key. Missing, duplicate or
unqualified URLs fail before any key read. These are protected runtime files,
not vendor credentials or package files. Never place secret values in
configuration examples, archives, source or logs. The operator installs the
hook in CapRover; it is excluded from the runtime image/archive.

The example retains Tunelio, while production test configuration now selects
JoJAPI by explicit owner instruction despite the documented unresolved defect.
An explicit
operator switch sets `YOUTUBE_AUDIO_ACQUISITION_API_URL` to
`http://srv-captain--music-mute-jojapi:8080/`; its matching internal bearer comes
from the selected protected key file. Keep the vendor key exclusive to the
JoJAPI app. Successful download or ffprobe validation does not establish that the
vendor defect is fixed. The allowlist supports an explicit operator switch, not automatic
retry or fallback.

NestJS retains only its existing generic settings:

```text
AUDIO_ACQUISITION_API_URL=http://srv-captain--music-mute-audio-router:8080/
AUDIO_ACQUISITION_API_KEY=<matching private router ingress key>
```

## Validation and packaging

From this directory:

```sh
PYTHONDONTWRITEBYTECODE=1 python3.12 -m unittest -v test_service.py
python3.12 package_caprover.py /absolute/path/outside/source/audio-router.tar
caprover deploy -n musicmute -a music-mute-audio-router -t /absolute/path/outside/source/audio-router.tar
```

The package contains exactly `captain-definition`, `Dockerfile`, `.dockerignore`,
`service.py`, `source_policy.py` and the shared `acquisition_limits.py`. The packaging command checks names and exact
source bytes; no tests, hooks, configuration, environment files or credentials
enter the image. Deploy only with current explicit user authorization.

Local tests use synthetic HTTP adapters. They cover correct routing/key
isolation, metadata/error sanitation, one submission on transport failure,
limits, response framing/truncation, disconnect/deadline cancellation, shared
concurrent capacity, independent health and archive contents. They do not establish
vendor, production, R2, worker or account-quota availability. Run backend
verification/import/processing integration checks separately before releasing.

After building the backend, run `python3.12 -B -m unittest discover -s
video_providers/tests -v` from the repository root. Its JoJAPI fixture qualifies
both private HTTP hops with generated native Opus and the real NestJS media
probe, plus Google refusal/expired-delivery failures without replay or fallback.
The existing Tunelio qualifier remains available. These fixtures make no real
provider or Google request.

API preflight read the current [Zalando RESTful API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-01. Rules 104 (security), 148 (methods), 176 (problem JSON),
177 (no stack traces), 106 (compatibility), 178 (content headers) and 227
(cache semantics) shaped this contract-compatible private relay. Existing
internal bearer keys/private HTTP and the explicitly unauthenticated process
health check retain the repository's private-network operational contract.
