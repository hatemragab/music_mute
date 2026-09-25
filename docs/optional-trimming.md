# Optional trimming — 2026-09-26

POST /jobs and POST /media-imports accept strict boolean `trim_enabled`, default
true. False skips the trimmer and preserves the full separated-audio sample
sequence. The immutable choice participates in request idempotency and survives
job retries and import recovery. Android continues to use the default.

Recipe revision 6 uses -40 dBFS, 0.6-second minimum silence, 0.2-second padding,
and 5 ms fades. Revision 5 snapshots retain their original -32 dBFS behavior.
No-trim outputs contain one identity edit range and zero removed samples. MP3
encoder delay/padding still requires handling by a future video muxer.

## Deployed proof

Backend: img-captain-api:66, readiness HTTP 200. Local worker:
0.1.0-mvp.45-trim6.local.20260926.1. The previous installed release is retained.
Only the three engine files and the tested HTTP 500 retry classification changed
in the cloned installed release; existing newer runtime components were preserved.
The release manifest was regenerated and verified. Two-worker capacity check
passed at 1.55x throughput. Full worker doctor passed.

Same Facebook source, separate synthetic test account:

| Trim | Job | Input seconds | MP3 seconds | Result |
|---|---|---:|---:|---|
| false | 6ab6e9d5d1c289cc6f329a24 | 28.165805 | 28.212245 | ready, full decode passed |
| true | 6ab6ea51d1c289cc6f329a28 | 28.165805 | 20.950204 | ready, full decode passed |

Both saved revision 6 and the requested trim flag. Reusing the request ID with
the opposite flag returned HTTP 409. Temporary test credentials were removed and
refresh tokens revoked. Test download scratch files were removed by ImportFiles.

## Validation and limitations

Backend verify: 863 unit and 147 HTTP tests, formatting, lint, typecheck, secret
scan and build passed. Import integrations: six passed. Native compiled
infrastructure test passed. Production dependency audit: no known vulnerabilities.
Worker lint/typecheck/build passed; 390 tests passed, two skipped. Engine: 74
run, one skipped, no failures using the installed Python environment.

Worker aggregate verify encounters an existing formatting issue in untouched
pnpm-lock.yaml; its other checks ran separately. Initial engine run using the
checkout venv lacked audio_separator; rerunning with the complete installed
Python environment passed. Scoped formatting and git diff --check passed.
No commits, pushes, mobile UI changes or public worker package release.

Guidelines: https://opensource.zalando.com/restful-api-guidelines/ read 2026-09-26.
Rules 101, 104, 106, 118 and 176 shaped OpenAPI, security, compatibility,
snake_case and problem responses.
