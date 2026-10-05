# Local extension instructions

Read README.md and docs/tasks.md before changing this component. The first MVP is
macOS ARM64 only. Windows offline and online MusicMute are future provider
adapters; never silently switch a local request to online processing.

Keep controls/playback/provider contracts separate from acquisition and the
platform runtime. Reuse the qualified engine read-only for development; do not
enroll or change fleet worker services, credentials, runtime files or settings.
Trim is always false for synchronized playback. Treat native/media messages as
untrusted, validate identity/generation and bound inputs/output/state/retention.

Diagnostics are local only. Never initialize remote telemetry, persist private
media URLs/capabilities or raw tool stderr, or include credentials/media in
exports. Test fault handling and cleanup alongside successful operation.

The native Home screen owns the cross-device account prompt. Signed-out users
must be able to open email sign-in or Google sign-in directly from Home; Google
actions use the multicolor Google G plus accessible localized text. Home also
links to the live web app and the reviewed Android listing. Keep those URLs in
the allowlisted `MusicMuteProductLinks` source rather than scattering literals.
The future public macOS destination is `https://music-mute.com/#downloads`; do
not invent or expose a direct DMG URL before the landing-page/release workflow
provides one. The landing page and store listing are discovery destinations, not
proof that a public download currently exists.

Thin macOS packages contain `runtime-bootstrap.json`, not the expanded runtime.
Prepare installs the exact verified runtime, model and mutable app state below
`~/Library/Application Support/MusicMuteLocal/`; the Chrome registration is
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.musicmute.local.json`.
An ordinary app update preserves these paths. A full uninstall/data-reset is a
separate destructive operation requiring explicit user authorization and must
not touch `MusicMuteWorker`, browser profiles, source/output packages or other
apps. The current local package workflow can use a reserved placeholder runtime
host for offline packaging proof, but a clean consumer cannot download from it.
Do not report fresh Prepare download proof unless the immutable runtime actually
came from its sealed HTTPS URL; a package-bound pre-staged archive proves only
verification, recovery, extraction and activation.

The current 2026-10-05 package/install checkpoint is build `c14116b8` /
`1791212763`: an exact 17,663,025-byte ARM64 ad-hoc package, matching 139-leaf
installed inventory, strict signature readback and passing disposable 15-check
package qualification. Its installed full runtime verification created the
private authenticated receipt used by the new bounded cross-process fast path.
This was an ordinary compatible update that reused existing app data, runtime and
model; it was not a clean Prepare or native app UI acceptance run. A separate
post-install real-YouTube check reached **Voice-only playback** through the final
unpacked `dist`, but only as a warm cache hit; it proves no fresh acquisition,
download, separation, listening or long-run behavior. Build `58d55f40` remains
the historical clean app-data Prepare, synthetic native playback/relaunch and
installed native-messaging checkpoint on this development Mac. It intentionally
used the package-bound complete `.zip.partial` preseed. Treat every result only
within its recorded scope in `docs/validation.md`; neither checkpoint proves the
runtime network path, a fresh OS user/machine, account/R2, notarization, updater,
public release or Web Store delivery. Build `2ed7711e`, e2aa, 679/cb and the
earlier thin candidates are older history.

Run npm run verify and relevant process/browser checks. Synthetic Chrome fixtures
are not live YouTube, source-identity, listening, packaged-app or long-run proof.
Do not claim an unsigned development integration is a public-ready installer.

Keep node_modules, dist, output, profiles, media, model/runtime copies, generated
private config and reports ignored. Do not commit/push/publish/deploy without a
direct request. Preserve unrelated files and user browser profiles.
