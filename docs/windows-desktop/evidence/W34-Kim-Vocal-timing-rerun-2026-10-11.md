# Evidence: W34 — Kim Vocal production timing repeat

Date: 2026-10-11, Cairo client date. The user requested another timed run of the
same song after the original 53.3-second result. This is an isolated production
engine run on the connected Z440, Windows 11 build 26200 x64 / RX580. It does not
close installed-app or release acceptance.

## Result and timing scope

Functional-06 passed with **49.811388399990392 seconds** around
`PersonalExecutor.execute`, compared with functional-02's
**53.276366300000518 seconds**: 3.465 seconds (6.5%) shorter. The input was the
same media015 private copy, duration **283.562 seconds**. No speed optimization,
recipe, model or engine change was made; the cause of the variation is unproved.

| Measured work                             | Original functional-02 | Repeat functional-06 |
| ----------------------------------------- | ---------------------: | -------------------: |
| Execute total                             |           53.2763663 s |         49.8113884 s |
| Model/session load                        |           16.0141488 s |         15.0878792 s |
| Separation                                |           26.4829395 s |         23.9472389 s |
| Primary demix, included within separation |           23.3305535 s |         20.7654867 s |
| Encoding                                  |            2.7992949 s |          2.7270767 s |
| Preparation                               |   Not transcribed here |          1.0194323 s |

Both runs create the model/session in a fresh process. This is a cold model/session
load, not proof that the operating system's file cache was cold. The execute timer
excludes Python process startup, QA setup and validation performed after the call.
The listed stages are not the complete total; primary demix must not be added to
separation again. Thus the quoted 53.3 seconds includes model/session loading and
pipeline work beyond neural inference.

The fixed production `kim-vocals-v2` revision6 recipe uses `trim: false`.
DirectML GPU0 and disabled CPU inference fallback were validated. Per-node GPU
profiling was off; these runs do not independently establish per-node GPU counts.
Source references: [production executor](../../../worker/engine/musicmute_engine/consumer_personal.py),
[pipeline timers](../../../worker/engine/musicmute_engine/pipeline.py),
[separation timers](../../../worker/engine/musicmute_engine/separator.py) and
[desktop personal runner](../../../windows-desktop/src/main/personal/runner.ts).

## Frozen inputs and retained evidence

The run used the unchanged v11 engine cohort and model:

| Pin                           | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| Engine digest                 | `1475d4120cf10ea3563ec1dec5727c6f7b7cd0cfb87471b8dde2e832593dd6e0` |
| Engine file census            | `ccb9a82963f41e4572589d468440b637802ce58f08ad8682b5f5b03c3e0964ab` |
| Model, 66,759,214 bytes       | `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b` |
| Recipe                        | `23e22a5fe3b9a604f7ff5241f0fa7194bacf153fc37df83d83898949610a89d9` |
| Input, 12,634,231 bytes       | `b6bdbddde76c864c8c00f67ba697058396b3f211177009509fc490c79df19c8e` |
| Functional-06 receipt         | `8bf2c4a29983a8931b197acb2b06b0593e83fcd19765275573cd809dfbeb1ef7` |
| Functional-06 report          | `5da44ef424d0d09363fa2226b1a1d88d3b53a6a027fb8955d7de98cc036ded96` |
| MP3, 5,672,272 bytes          | `77d2e6a8c29ca0e52731a5ad134b68ffa048d3bb9c4110fd14a8397d149c1960` |
| Original AAC, 5,764,901 bytes | `ad4a9fe23fa71bbef08154e81e584b33b91be8440ed858b6b24546486dd2d4c0` |

Report/receipt UUID: `2f4ec9e0-a60b-4ca9-ba3e-f3fbcdf85690`. Entire retained-handle
MP3/AAC read-back and full decode passed; decode time was **0.4630008 seconds**,
outside the execute timer. Both output byte counts and hashes exactly match
functional-02. Original song files were preserved.

Execution used the actual limited **Session1 / RunLevel0** desktop token.
Owned Job-zero was confirmed. After `ValidateOnly` passed, the exact functional-06
task retirement passed at **17:42:48 UTC** (20:42:48 Cairo), using the pinned,
unchanged `cleanup-engine-run-v10.ps1 -QaVersion v11`. Only that exact task was
removed; retained artifacts remain. No cleanup is inferred from task absence alone.

See the [full Z440 evidence](W34-Z440-Win11-26200-RX580-2026-10-11.md) for original
runs and preserved failures. Signing, runtime release inputs, installed app/account/
Chrome journeys, Windows 10 acceptance and remaining filesystem containment gates
stay open. No code tests were rerun for this documentation-only update.
