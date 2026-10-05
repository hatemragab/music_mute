# Packaged tool qualification

This read-only check runs the packaged tools on an Apple Silicon Mac without
Apple Developer credentials. It accepts an existing local app bundle and the
verified Kim Vocal 2 model already cached by MusicMute. It does not install the
app, launch its GUI, open Chrome, download a model or start processing work.

```sh
node scripts/qualify-packaged-tools.mjs \
  --app '/absolute/path/MusicMute Local.app' \
  --model '/absolute/path/Kim_Vocal_2.onnx'
```

The model must be a regular file owned by the current user, with private
permissions, exactly 66,759,214 bytes and SHA-256
`ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.
The check copies it into fresh private state under the component's ignored
`output/packaged-tools-proof/<UUID>.noindex/` directory. Generated native-host
registration belongs only to the isolated HOME inside that directory.
The app must be the exact output beside its `package-result.json`, runtime ZIP
and sidecar manifest. The check never downloads that ZIP: it verifies the
package record, embedded bootstrap, archive digest/listing, complete extracted
inventory and every native signature, then recreates the active external-runtime
layout, including the private `bootstrap.lock` and active descriptor, only inside
the disposable qualification state.

The script checks:

- Deep strict code-signature verification before and after execution.
- Bundle directories at 0755, ordinary files at 0644, executable files at 0755,
  single-link files and contained relative symlinks.
- The actual packaged downloader and YouTube runtime verifiers in packaged mode,
  with a simulated differing UID. The Python bootstrap must reject that simulated
  UID because the staged external runtime is user-owned and is not a protected
  path inside the signed app bundle.
- Actual externally staged Python and Node running Prepare through the update
  lease, with no expanded runtime present inside the app.
  Prepare checks the cached model, MPS engine readiness, pinned yt-dlp/EJS,
  Deno and the offline token-provider dependency/canvas health.
- A subsequent status command with all six components ready.
- The isolated Chrome registration and generated launcher, including repair of
  an absent launcher without changing registration. The packaged app binary then
  exchanges one framed HELLO with the actual companion under a disposable
  `CFFIXED_USER_HOME`, without launching the app GUI, followed by clean shutdown
  on stdin closure. HELLO must advertise the error-context and cloud-handoff
  capabilities.

The macOS sandbox denies all network operations during Prepare/status. Native
HELLO permits the helper's loopback listener while denying outbound networking.
All child writes outside the private qualification directory are denied except
`/dev/null`; writes to the staged runtime and its active pointer are denied even
inside that directory. The full runtime inventory, permissions, signatures and
active pointer are re-audited after the child processes exit. Existing MusicMute
state, worker state, the real Chrome profile and Keychain files are denied to
child readers, and execution of the Keychain helper is denied. No START command,
YouTube request, account sign-in or cloud request is sent.

The private `result.json` records fixed checks, phases, allowlisted failure codes,
exit status, elapsed time and output-byte counts. Raw stderr, source URLs,
credentials, account identifiers and input paths are excluded. Console output
includes the artifact path so the local report can be opened.

An ad hoc signed local app can pass this check. That result does not establish
Developer ID signing, notarization, fresh-user Gatekeeper acceptance, Chrome
installation/playback, model-download recovery or YouTube guest acceptance.
Changing `getuid()` proves only the two expected ownership branches: immutable
packaged resources remain readable after another account installs the app, while
the external runtime bootstrap rejects another owner. `CFFIXED_USER_HOME` proves
the packaged native-host path against disposable state, not execution as another
operating-system user or an installed Chrome launcher. No separation inference is
run by this check.
