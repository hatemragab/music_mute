# JoJAPI production YouTube test activation, 2026-10-01

The owner explicitly requested switching production YouTube routing to JoJAPI
despite the known source-version defect. The private router now selects JoJAPI;
VideoScale still handles other enabled sites. The CapRover CLI build began at
**10:39:59 UTC on 2026-10-01**; subsequent runtime checks confirmed activation.
No commit or push was made;
the changes remain in the current `main` working tree.

This is an owner-authorized test activation, not evidence that the vendor defect
is fixed. The [initial qualification](DEPLOYMENT-2026-10-01.md) demonstrated that
two different uploads of Big Buck Bunny could return identical audio. Sequential
adapter calls and standalone vendor calls reproduced it. The gateway response
has no reliable source identifier. Successful transfer, hashing, format checks,
ffprobe and requested-URL oEmbed cannot establish which upload the bytes belong
to. The [request-context follow-up](REQUEST-CONTEXT-2026-10-01.md) qualified
header/cookie handling and a VPS range transfer; it did not resolve source identity.

## Active deployment and configuration

| CapRover app              | Active image                            | Status                                                            |
| ------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| `api`                     | `img-captain-api:101`                   | Retained, generic acquisition settings unchanged.                 |
| `music-mute-audio-router` | `img-captain-music-mute-audio-router:8` | Build complete; JoJAPI explicitly selected for YouTube.           |
| `music-mute-jojapi`       | `img-captain-music-mute-jojapi:5`       | Retained private adapter with qualified request-context handling. |
| `music-mute-videoscale`   | `img-captain-music-mute-videoscale:8`   | Retained other-site adapter.                                      |
| `music-mute-tunelio`      | `img-captain-music-mute-tunelio:2`      | Retained; no automatic fallback.                                  |

Runtime checks on the MusicMute VPS confirmed these exact private destinations:

| Runtime setting                            | Verified value                                |
| ------------------------------------------ | --------------------------------------------- |
| Router `YOUTUBE_AUDIO_ACQUISITION_API_URL` | `http://srv-captain--music-mute-jojapi:8080/` |
| Router `OTHER_AUDIO_ACQUISITION_API_URL`   | `http://music-mute-videoscale:8080/`          |
| API `AUDIO_ACQUISITION_API_URL`            | `http://music-mute-audio-router:8080/`        |

The change selects a different URL and matching internal bearer; no runtime
source was edited for this activation. The existing hook reads only the selected
YouTube key file and the common ingress/VideoScale key file. JoJAPI's selected
service key matched `/captain/data/musicmute-acquisition/jojapi-api-key`;
Tunelio's bearer was absent from the router runtime. Common ingress and
VideoScale keys matched their protected file. The vendor key remains exclusive
to the JoJAPI app and is absent from the router and backend.

Router and JoJAPI runtime source-hash comparisons all matched the current
working-tree files (`service.py`/`source_policy.py` for the router and
`service.py`/`official_metadata.py` for JoJAPI). Both services were healthy,
private, read-only, nonroot UID 10001, one replica, HTTP port 8080, and without
published ports, volumes or domains. Private health/authentication/malformed-body
checks returned **200/401/400** for both. JoJAPI scratch was empty.

The hook and router resource override were unchanged:

| File              | SHA-256                                                            |
| ----------------- | ------------------------------------------------------------------ |
| Selected-key hook | `727f5a1f33201dbfeb71ae8c678fa6838845399f1a76477c7f9385ca79757992` |
| Router override   | `d9addd1dc82d0e65f8613d3ebfb6209ccabfec43e64376bfe9874c69a1e5ba4a` |

The six-member router archive contained only ordinary allowlisted runtime files.
Its post-deployment exact-byte check passed, with SHA-256
`6618bcf6b2ba6288e8518658758148711e9067927f53be7c27611a4c521e0b49`.
No credentials, environment files, tests, hooks or documentation were packaged.
The deployment command was:

```sh
caprover deploy -n musicmute -a music-mute-audio-router -t /tmp/musicmute-audio-router-jojapi-activation-20261001.tar
```

## Fresh production-route transfer

One fresh authorized paid acquisition ran from the existing API container
through its default generic router URL and key, with no direct-adapter override.
The requested public source was
[jNQXAC9IVRw](https://www.youtube.com/watch?v=jNQXAC9IVRw).
The deployed acquisition client and media probe completed successfully:

| Measurement                         | Result                                                             |
| ----------------------------------- | ------------------------------------------------------------------ |
| Metadata provider                   | `jojapi`                                                           |
| Native container                    | M4A                                                                |
| Measured bytes                      | 309,288                                                            |
| ffprobe duration                    | 19.063583 seconds                                                  |
| Acquisition elapsed time            | 9,502 milliseconds                                                 |
| SHA-256                             | `a01b38c896d27707ef852301f1ccc6c39cebe792852c868109e85753ef159e47` |
| Remaining acquisition scratch files | 0                                                                  |
| Process exit                        | 0                                                                  |

This sample confirms routing, bounded transfer, independent media validation and
cleanup. It does not clear the source-version defect or guarantee future Google
IP acceptance, quota, latency or availability. It was one distinct paid request,
without retry or fallback. No new R2 upload, worker processing job, authenticated
user job or MusicMute UI/device test was performed.

For owner testing, use a YouTube video ID that has not already been imported.
The backend implementation can reuse a shared original or completed result
before acquisition; changing tracking parameters or trim does not necessarily
call the selected adapter. See the [shared-media guide](../../../docs/url-imports/shared-media.md).
The fresh acquisition above calls the deployed download client directly and
does not go through that reuse decision.

## Validation and operator reversal

From `video_providers/router/`,
`python3.12 -B -m unittest -q test_service.py` passed **30 tests in 32.865 seconds**.
This includes the strict Tunelio/JoJAPI destination allowlist, selected-key hook
isolation, invalid/duplicate/missing configuration, no replay or fallback, and
the private relay's existing safeguards. Prior adapter/backend qualification
remains dated evidence in the linked records; it was not rerun as a full backend
suite for this configuration-only activation.

The prior router snapshot is protected with mode 0600 at
`/tmp/musicmute-jojapi-router-before-activation-20261001.json`; its contents are
not copied into source or documentation. An explicit operator reversal can set
`YOUTUBE_AUDIO_ACQUISITION_API_URL=http://music-mute-tunelio:8080/` and redeploy
with the same selected-key hook, which restores the matching Tunelio bearer.
Configuration examples may retain Tunelio as their default. Provider changes
remain deliberate operator actions; executions never switch providers after
failure.
