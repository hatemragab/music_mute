# Tunelio routing: deployment and live qualification, 2026-09-30

YouTube imports now use the private Tunelio adapter. Other supported public
single-item sites use the existing VideoScale adapter. NestJS retains the generic
acquisition contract and its existing media validation, private S3 and worker flow.

## Active deployment

| CapRover app              | Active image                            | Purpose                                                 |
| ------------------------- | --------------------------------------- | ------------------------------------------------------- |
| `api`                     | `img-captain-api:95`                    | Existing API; only its generic acquisition URL changed. |
| `music-mute-videoscale`   | `img-captain-music-mute-videoscale:7`   | Existing adapter for other supported sites.             |
| `music-mute-tunelio`      | `img-captain-music-mute-tunelio:1`      | New YouTube-only native Opus adapter.                   |
| `music-mute-audio-router` | `img-captain-music-mute-audio-router:2` | New provider-neutral private router.                    |

The API and VideoScale images were retained. No backend working-tree package
was deployed. Unrelated local edits were preserved. The final router source was
packaged after its expanded tests; deployed source hashes match the frozen files.

The saved `musicmute` CapRover CLI connection was used for deployment:

```sh
python3.12 -B video_providers/tunelio/package_caprover.py /tmp/musicmute-tunelio.tar
caprover deploy -n musicmute -a music-mute-tunelio -t /tmp/musicmute-tunelio.tar
python3.12 -B video_providers/router/package_caprover.py /tmp/musicmute-audio-router.tar
caprover deploy -n musicmute -a music-mute-audio-router -t /tmp/musicmute-audio-router.tar
```

Each archive contains five ordinary, allowlisted files, byte-checked against
current source. No credentials, environment files, configuration hooks, tests,
documentation or generated output enter the build context.

| Archive | SHA-256                                                            |
| ------- | ------------------------------------------------------------------ |
| Tunelio | `d72e24c4dd4f31c1a4beddfebfad7c984e271be1f9546e8d20e86b5d5c736203` |
| Router  | `7a1d8313b63f4d020a7b1aad0275af41e6d2f12dd16c64c45b648277df634dc9` |

## Saved configuration and credentials

Use the [Tunelio configuration](../tunelio/config.example.json),
[Tunelio setup](../tunelio/README.md), [router configuration](../router/config.example.json)
and [router setup](../router/README.md). These files contain public settings and
credential names only. The installed CapRover settings preserve existing
environment entries and hooks.

The API now has `AUDIO_ACQUISITION_API_URL=http://music-mute-audio-router:8080/`.
The router's YouTube URL is `http://music-mute-tunelio:8080/`; its other-site URL
is `http://music-mute-videoscale:8080/`. The documented `srv-captain--` aliases
are also accepted. All three acquisition apps remain private, without published
ports or public app routing. Requests to the two new public `/health` hostnames
returned HTML 404 rather than private health responses.

`TUNELIO_API_KEY` is installed only in the Tunelio app's runtime configuration.
Its separate private bearer key is read by the installed pre-deploy hook from
`/captain/data/musicmute-acquisition/tunelio-api-key`, owned by root with mode
0600 in the protected 0700 directory. Existing API/VideoScale private credentials
were retained. The router hook reads the two protected private service-key files;
it receives no vendor, cloud or database credential. Key comparisons passed
without printing values. Credential values are excluded from this repository.

Both new services run one replica, as nonroot users with read-only roots, all
capabilities dropped and logs bounded to two 5 MB files. Tunelio has a 128 MiB
scratch tmpfs, 256 MiB memory and one CPU; the router has 128 MiB memory, half a
CPU and no scratch mount. Neither adapter performs FFmpeg conversion.

## Production YouTube journey

One import was submitted through the existing authenticated MusicMute browser
session using the public Blender Foundation film
`https://www.youtube.com/watch?v=aqz-KE-bpKQ`, with trim enabled. No diagnostic
replayed the paid submission.

Job `6abd37d3a6b1dfb031bf55da` reached **Ready**. Metadata records provider
`tunelio`, site `youtube`, native WebM audio, measured duration 634.601 seconds
and 10,258,925 input bytes. The requested `opus`/128 kbps setting selects a native
tier; it is not a guarantee of an exact measured bitrate.

| Stage                                 |     Observed time |
| ------------------------------------- | ----------------: |
| Import queue                          |     0.348 seconds |
| Audio acquisition, measured by NestJS | **3.212 seconds** |
| Native media validation               |     0.585 seconds |
| Private S3 input upload               |     0.494 seconds |
| Job confirmation                      |     1.469 seconds |
| Worker processing                     |   115.548 seconds |
| Submission to Ready                   |   133.676 seconds |

The worker/overall times are separate measurements; the overall time includes
other scheduling and transfer work. It is not the audio-download duration.

Exact execution `b0e4460c-e601-4bcc-ac42-22652067c8ec` records one Tunelio paid
creation (HTTP 200, 0.583 seconds), one credential-free tunnel transfer (HTTP 200,
2.358 seconds), and one successful YouTube router relay (3.166 seconds). The
adapter completed in 3.145 seconds. No matching VideoScale acquisition occurred.

Input and 2,014,084-byte vocal output both passed S3 HEAD size, checksum, version
and content-type comparisons. There was no job error. API scratch and Tunelio
`/work` both contained zero entries after completion. Vocal playback loaded,
advanced and was paused after verification. Realtime updates remained connected.

Ready state and vocal playback were also captured in a local browser screenshot.
The generated screenshot is excluded from the source commit.

The free credit check read 44 trial credits before qualification and 34 after,
consistent with one 10-credit creation. This leaves three complete imports on
that trial balance. Continued traffic requires sufficient provider credits;
no paid plan was purchased. The adapter conservatively admits at most 15 paid
starts per rolling minute and honors upstream 429 cooldown without replay.

## Validation and scope

- Tunelio: 40 tests passed on Python 3.12 and 3.14.
- Router: 25 tests passed on Python 3.12, including isolated service keys,
  metadata/error sanitation, cancellation, deadlines, same-destination admission
  and delivery without metadata.
- Combined HTTP qualification: three tests passed through the actual router
  and Tunelio implementation using a local vendor fixture, synthetic native
  Opus and the real NestJS media probe. The other-site path uses a local
  VideoScale-contract fixture; paid failure has no replay or fallback.
- Backend format, lint, typecheck, secret scan and transfer benchmarks passed;
  1,021 unit tests passed. The initial `pnpm run verify` stopped at a five-second
  device HTTP test timeout. The focused three-test rerun and full 158-test HTTP
  rerun passed without edits. Both integration scripts rebuilt successfully and
  passed sequentially: imports 16 tests, processing 17 tests.
- Hook isolation checks, deployment allowlist/byte checks, new-scope credential
  scan, documentation/configuration formatting and diff checks passed.
- Live internal health/auth/malformed-body checks returned 200/401/400 for each
  acquisition service. API live/readiness endpoints returned 200; unauthenticated
  client/admin realtime tickets and WebSocket upgrade returned 401.
- Frozen deployed runtime source hashes matched local source. Qualification
  completed before Git publication.

This establishes one real YouTube journey through the production API, private
S3 and worker. Other sites retain VideoScale and have routing/contract fixture
coverage; no fresh paid production imports for those sites were submitted here.
One video does not establish latency under load or across all YouTube items;
provider caching and upstream availability are not controlled by this adapter.
Automatic retry or fallback remains disabled to avoid duplicate provider charges.
