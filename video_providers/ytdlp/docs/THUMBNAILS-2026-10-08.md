# Thumbnail metadata release, 2026-10-08

The owner authorized thumbnail metadata, redeployment and one real verification
request. No commit or push was performed.

## Behavior

The adapter adds optional `thumbnail_url` from the pinned extractor's original
`thumbnail` field. It does not use speculative entries in `thumbnails`, guess a
resolution, fetch an image or perform a separate metadata lookup. The URL must
use HTTPS, exact `i.ytimg.com`, a bounded `/vi/` or `/vi_webp/` JPG/WebP path
matching the requested video ID, and only bounded optional `sqp`/`rs` parameters.
Unsafe or missing thumbnails are omitted. If a thumbnail would exceed the
4096-character header cap, it is omitted while existing metadata is retained.
The private router preserves the same validated field.

The additive field retains metadata schema version 1 and the existing binary
audio contract. Backend job metadata persistence and client display are outside
this change; the existing backend allowlist does not yet retain this field.

## Deployment and read-back

CapRover CLI deployed `music-mute-ytdlp` image `:7` and
`music-mute-audio-router` image `:10`; both current replicas are healthy.
Releases overlay only `extract.py`, `service.py` and `acquisition_metadata.py`
on adapter image `:6`, and only `acquisition_metadata.py` on router image `:9`.
An unrelated difference between local and live `source_policy.py` was detected
before deployment; basing the releases on existing images preserves live policy.

All 12 adapter runtime Python files and five router files match the expected
release hashes. Environment hashes, container options, resource limits, network
configuration, replica count and private endpoint settings match the baseline.
No public web exposure, credential or route change was made.

## Live request

One authenticated router request for public video `jNQXAC9IVRw` returned HTTP 200
in 26.133 seconds with title `Me at the zoo`, existing native WebM/Opus metadata
and a `thumbnail_url` on `i.ytimg.com` for that same video. The original public
thumbnail parameters were preserved; the image was not fetched.

Native audio was 143,795 bytes, SHA-256
`938c96573f27d57d0c41eff2920044b2c07e246c5d89afbcda4694616b54a49a`.
Correlation `f2763cfb-4cf7-45c2-9842-d71e4258fe28` has exactly one completed
adapter acquisition (attempt 1) and one successful YouTube router execution.
The request created no backend job, R2 object or worker task.
Sanitized release/read-back evidence is under
`/tmp/musicmute-thumbnail-20261008-release/` on the development host.

## Local validation

An isolated Python 3.12 environment installed the pinned hashed requirements.
The following unittest discovery runs passed: 78 adapter tests, 37 router tests,
21 synthetic routing/probe integration tests, eight shared metadata tests and
three acquisition-context tests (147 total):

```sh
python -B -m unittest discover -s video_providers/ytdlp -p 'test_*.py' -v
python -B -m unittest discover -s video_providers/router -p 'test_*.py' -v
python -B -m unittest discover -s video_providers/tests -v
python -B -m unittest discover -s video_providers -p 'test_acquisition_metadata.py' -v
python -B -m unittest discover -s video_providers -p 'test_acquisition_context.py' -v
git diff --check -- video_providers
```

Python syntax checks and Ruby YAML parsing of both OpenAPI files passed. Archive
allowlists and exact source bytes were verified. Synthetic fixtures do not
establish universal YouTube availability; the live result covers this one source.

API preflight read the current [Zalando RESTful API guidelines](https://opensource.zalando.com/restful-api-guidelines/)
on 2026-10-08. Rules 104 (service authentication), 106 (compatible extension),
118 (`thumbnail_url` snake_case) and 178 (unchanged binary content headers) apply.
