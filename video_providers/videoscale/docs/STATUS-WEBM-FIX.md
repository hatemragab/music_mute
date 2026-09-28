# Task-state handling and audio preference — 2026-09-28

Deployed using the owner-authorized CapRover CLI: adapter image **4**.
Backend remains 83 and web remains 11; no native reinstall needed.

The supplied failure was confirmed in Docker service logs for correlation
`39675cc5-a6c4-41be-aef0-4a606bdb1435`: 47 formats, selected M4A 140,
accepted task, first status HTTP 200, then immediate source-unavailable at
6.822 seconds. The old logger collapsed missing, malformed and unrecognized
state values to `unknown`; these logs cannot establish the vendor's exact value
or prove that M4A itself failed. No raw provider response was retained.

Changes:

- User-requested selection order: WebM/Opus → MP3 → M4A, for all admitted sites.
  Select an actual eligible format ID, never a hardcoded ID. Within a container,
  prefer complete metadata, non-DRC and bitrate. No conversion or paid fallback
  submission; existing audio-only, DRM, size and quality checks remain.
- Unknown task state uses the shared four-read-retry budget, two-second delay,
  cancellation checks and global deadline. Explicit completion is still required.
  Persistent uncertainty is a dependency failure, not proof of unavailable media.
  Explicit failed/error/cancelled states still stop immediately.
- Safe status-shape diagnostics distinguish literal unknown, other strings,
  missing and invalid types. No raw status values, URLs or credentials logged.

API review: official https://opensource.zalando.com/restful-api-guidelines/
read on 2026-09-28. Rules 176/177 preserve problem JSON and no stack traces;
112 motivates bounded handling of unknown response values. No routes, auth,
request schema, metadata shape or success contract changed.

Validation: `python3 -B -m unittest -q test_service.py` passed 36 tests.
Backend `pnpm run verify` passed formatting/lint/types/security/build,
962 unit and 148 HTTP tests; import integration passed 8, processing integration
passed 15. No backend source changed. No credential change or real-data deletion.

Deployment archive: `videoscale-status-webm-2026-09-28.tar` (four allowlisted files).
SHA256: `cf4b1ae821a9ceed813bfa506a04d29f0ad4f35f3b37a01e499232202a3084d6`.
Live `/app/service.py` matches local SHA256:
`1043ecab02a6af410b1e7cfd9b343e905427c59ffab22203420c0388fd7b2486`.
Container healthy, read-only root, no published ports. CLI used saved connection
`musicmute` with PTY; no Chrome or credential output required.

## Live outcome

A concurrent real import `3dca6d38-fabe-4105-9809-1dab78593ca1` selected
WebM/Opus format 251. Three unrecognized string states recovered to `processing`
then `completed`, with no second POST. Adapter delivered 3,507,287 bytes and
reported success in 19,377 ms. This directly demonstrates recovery from the
old immediate-failure condition; the exact raw state string remains withheld.

Correlated NestJS logs confirmed source download (19,469 ms), independent
validation (730 ms), S3 upload (448 ms), and upload confirmation (1,448 ms)
completed. These are per-stage server timers, not total mobile latency or
worker processing proof. Public backend ready returned HTTP 200.

The separate diagnostic request was rejected with IMPORT_QUEUE_FULL while this
real import occupied the adapter. It created no vendor task. Its temporary
qualification directory was independently checked: zero entries. No second
diagnostic was needed after the real import succeeded. Worker output/playback
and all other platform imports were not tested in this follow-up.
