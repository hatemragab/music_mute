# Local legacy removal — 2026-09-28

This is the pre-deployment cleanup record. It was subsequently deployed and
verified in [release 82](RELEASE-82.md).

The owner requested breaking removal without migrations. This cleanup is local
only: no commit, push, deployment, production data deletion or credential change.

## Removed

- Entire retired downloader component: 24 source, test, configuration and
  documentation files, plus generated Python cache residue.
- Unused temporary deployment bridge. The two current generic hooks remain.
- Backend's separate title-header decoder and its obsolete tests. Titles now
  come from sanitized structured acquisition metadata, covered by unit and
  import integration tests.
- Stale setup/migration instructions and broken references in current guides.

The current provider client, nullable included metadata, audio validation,
storage cleanup and normal S3/worker flow remain. Unrelated checkout edits and
other worktrees were not changed.

Before deletion, exact downloader files and the bridge were archived outside the
repository at `/tmp/musicmute-retired-downloader-BWLpLn/downloader-source.tar.gz`.
Generated residue is beside it. This is temporary recovery storage, not a
repository dependency or deployment artifact; the OS may eventually clear it.

## Verification

- `pnpm run verify`: passed formatting, lint, TypeScript, secret/transfer checks,
  949 unit tests, 148 HTTP tests and NestJS build.
- `pnpm run test:imports:integration`: 6 passed with isolated local services.
- `python3 -B -m unittest -q test_service.py`: 12 adapter tests passed.
- Private OpenAPI Prettier check and `git diff --check`: passed.
- Filesystem/source searches confirmed retired component/client/bridge absence
  and no old downloader environment keys or title-header parser in backend
  source/tests/examples.

Initial verification and integration builds overlapped in the shared generated
`dist` directory, causing build/module-load failures. Both commands were rerun
sequentially and passed. Existing Mongoose deprecation warnings remain.

No live or device validation was performed for this cleanup. Prior deployment
evidence and its release archives describe image 81, not these local changes.
Only YouTube is currently supported by the adapter; the broader bundled client
catalog remains unchanged. The provider-credential rotation noted in
[deployment evidence](DEPLOYMENT.md) remains an owner action.

API preflight: [official Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
read 2026-09-28. Rules 101/178 informed contract consistency; the owner's explicit
no-migration instruction overrides compatibility rule 106 and supplies shutdown
consent under rule 185.
