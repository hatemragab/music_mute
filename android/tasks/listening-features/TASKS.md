# Tasks

Checked implementation items mean source is implemented and locally compiled;
they do not mean Android device acceptance has passed. See VALIDATION.md.

- [x] Create isolated worktree and feature branch; write plan.
- [x] 1. Compact/large responsive home-screen playback widget + Import.
- [x] 2. Receive shared audio into review (no automatic processing).
- [x] 3. Launcher shortcuts: Import audio, Import link, Library.
- [x] 4. System playback resumption with account/update fences.
- [x] 5. Optional playback silence skipping.
- [x] 6. Browsable Android Auto completed-audio library.
- [x] 7. Cached real waveform seeking with original/voice switching.
- [x] 8. Persistent bookmarks and A–B looping.
- [x] 9. Timed/end-of-track sleep with optional fade.
- [x] 10. Selected voice-clip export and Android sharing.
- [x] English/Arabic, accessibility, loading/error/cancellation review.
- [x] JVM tests, direct/play builds and lint, framework-test compilation.
- [x] Security/lifecycle review and final diff check.
- [x] Commit/push GitHub branch; record evidence and remaining device gates.

## Device validation (not authorized, remains outstanding)

- [ ] Physical Android: widgets on two sizes, cold/warm shortcuts and share URIs.
- [ ] Physical Android: background timer/loop/silence/audio fidelity and seek accuracy.
- [ ] Physical Android: resumption after process stop and logout isolation.
- [ ] Android Auto host browse/play, auth/update rejection, reconnect.
- [ ] English/Arabic, large fonts and TalkBack.
