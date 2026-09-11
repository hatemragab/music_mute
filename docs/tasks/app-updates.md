# Release dashboard and app-update tasks

Status: **Planned only. No feature implementation or runtime validation completed.**

- [Design and exact contracts](../superpowers/specs/2026-09-10-app-updates-design.md)
- [Execution order and release gates](../superpowers/plans/2026-09-10-app-updates.md)
- [Backend and S3](../superpowers/plans/2026-09-10-app-updates-backend.md)
- [Dashboard](../superpowers/plans/2026-09-10-app-updates-dashboard.md)
- [Android](../superpowers/plans/2026-09-10-app-updates-android.md)
- [iOS](../superpowers/plans/2026-09-10-app-updates-ios.md)

Every row remains unchecked until its acceptance tests pass and the evidence is recorded. Planning a task does not authorize production mutations or publishing.

| ID | Deliverable | Depends on | Status |
| --- | --- | --- | --- |
| UPD-B01 | Google admin authentication and expandable allowlist | None | Planned |
| UPD-B02 | Release records, policy contract and compatibility | None | Planned |
| UPD-B03 | Private S3 upload, immutable APK verification | B01, B02 | Planned |
| UPD-B04 | Atomic publication, withdrawal and download grants | B01–B03 | Planned |
| UPD-B05 | Processing enforcement with existing-job continuity | B04 | Planned |
| UPD-B06 | Backend verifier packaging and operations documentation | B03–B05 | Planned |
| UPD-D01 | Dashboard shell, Google login and admission | B01 | Planned |
| UPD-D02 | APK upload, draft editing and verification UI | B02, B03, D01 | Planned |
| UPD-D03 | Preview/publish, source settings, history and admin list | B04, D02 | Planned |
| UPD-A01 | Direct/Play flavors and selected updater compatibility | None | Planned |
| UPD-A02 | Android policy persistence, scheduler and optional reminder | B02, A01 | Planned |
| UPD-A03 | Android whole-app gate and local-work pause | B05, A02 | Planned |
| UPD-A04 | Verified S3 APK download and installation | B04, A01–A03 | Planned |
| UPD-A05 | Google Play provider and channel migration behavior | B04, A03 | Planned |
| UPD-I01 | iOS policy persistence, scheduler and optional reminder | B02 | Planned |
| UPD-I02 | iOS whole-app gate and local-work pause | B05, I01 | Planned |
| UPD-I03 | App Store handoff and return-to-app behavior | I02 | Planned |
| UPD-V01 | Cross-component contracts, regression and package checks | B06, D03, A04, A05, I03 | Planned |
| UPD-V02 | Allowed simulator UI proof and external-proof ledger | V01 | Planned; Android device permission absent |
| UPD-V03 | Bootstrap-release and production-readiness handoff | V01, V02 | Planned; production execution not authorized |

## Requirements mapped to tasks

| Requirement | Tasks |
| --- | --- |
| Google login, initial owner, add accounts later | B01, D01, D03 |
| Dashboard APK upload to private S3 | B03, D02, A04 |
| azhon/AppUpdate | A01, A04 |
| English-only changelog | B02, D02, A03, I02 |
| Optional versus whole-app forced update | B02, B04, A03, I02 |
| Launch, reconnect, due foreground and 15-minute checks | A02, I01 |
| Open offline without a known forced requirement | A02, A03, I01, I02 |
| Later defers 24 hours | A02, I01 |
| Backend refuses outdated submissions | B05 |
| Existing jobs finish and results survive | B05, A03, I02, V01 |
| Configurable direct APK to Google Play transition | B04, D03, A01, A05 |
| iOS update destination | I03 |
| Only designated iPhone simulator for device/UI tests | V02 |
| Preserve unrelated edits; no commit/deploy/publish | All |

## Progress checklist

- [ ] Backend tasks B01–B06 complete with evidence.
- [ ] Dashboard tasks D01–D03 complete with evidence.
- [ ] Android tasks A01–A05 complete with evidence.
- [ ] iOS tasks I01–I03 complete with evidence.
- [ ] V01 local checks complete.
- [ ] V02 device proof recorded with unverified boundaries.
- [ ] V03 operational prerequisites documented; approvals remain separate.

## Evidence record

During implementation create `docs/validation/app-updates-2026-09-10.md`. For each command record working directory, actual command, exit status, observed result and limitation. Distinguish source review, unit test, build, browser test, simulator test, real Android installation, Play delivery and production S3 proof. Do not mark a layer proven using evidence from another layer.
