# Mac application updates

MusicMute embeds **Sparkle 2.10.0** for direct-download Mac updates. The framework
archive is pinned to GitHub's published SHA-256
`c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c`.
Packaging extracts a fresh copy from the verified archive, preserves symlinks,
links its framework and seals its native binaries, XPC services, Updater app,
framework and outer MusicMute app from the inside out. Its license is included.

## User behavior

Configured builds check automatically once a day while the Mac app is running.
Settings can disable automatic checks, and **Check for Updates…** in the app
menu or Settings performs a manual check. Sparkle owns scheduling: there is no
extra update polling timer. System profile submission is disabled.

Updates require HTTPS, the embedded Ed25519 public key, signed update archives,
signed feeds and verification before extraction. Feed signature failures do not
expire into weaker fallback behavior. A user explicitly chooses installation;
automatic downloads and install-on-normal-quit are disabled. Dismissing the final
installation window cancels the installation rather than leaving a pending
install on the next ordinary quit.

Installation waits for local processing and playback to stop. All packaged
native/control/acquisition processes hold shared leases on one private
`update.lock` inode. The installer takes an exclusive lease before downloading
an accepted update, preventing new Chrome or native processing from starting.
An active Chrome native connection also holds the lease. Stop its processing and
playback before installing; the extension closes an idle connection automatically.
Paused playback retains its grant until Stop. The app does not kill Chrome,
interrupt processing or discard active playback pins to install an update.

A detached safety helper acknowledges startup and retains the exclusive lease
across app termination and Sparkle's atomic bundle replacement. The app only
allows update termination after Sparkle's installer-ready callback and a live,
registered Updater agent. A crashed/aborted updater recovers after its parent
and actual Sparkle installer processes have ended; it does not use an arbitrary
installation timeout to reopen acquisition. A failed process observation retains
the gate. This conservative observation may wait for another app's Sparkle
installer with the same executable name to finish.

The Chrome extension can process locally while MusicMute's window is closed,
after first setup, through its separate native helper. Sparkle checks run when
the Mac app runs. Use **Open MusicMute** when setup, account confirmation or an
app update needs the app. Closing the GUI does not turn it into a permanent
background updater service.

The processing runtime and model are not inside the bundle Sparkle replaces.
They remain in the current user's Application Support directory. If an updated
app pins the same runtime identity, it revalidates and reuses those bytes with no
runtime or model download. If the runtime identity changes, Setup reports that
preparation is required and installs the new content-addressed runtime before
starting companion commands. The previous active descriptor is restored if the
new setup fails.

## Build configuration

`npm run setup:updater` prepares the verified framework in ignored
`output/sparkle/2.10.0.noindex/`. Mac packaging also prepares it automatically.
No end-user package manager is needed. This is a build dependency; users receive
it inside the app.

Mac packaging reads these public environment inputs:

| Input                                    | Meaning                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `MUSICMUTE_MAC_VERSION`                  | Numeric marketing version, default package.json version.                                                                |
| `MUSICMUTE_MAC_BUILD`                    | Positive integer bundle build, default UTC epoch seconds; use a monotonically increasing release value.                 |
| `MUSICMUTE_UPDATE_FEED_URL`              | Permanent HTTPS appcast address owned by the publisher, without credentials, query, fragment or custom port.            |
| `MUSICMUTE_UPDATE_PUBLIC_ED_KEY`         | Canonical Base64 Ed25519 public key, exactly 32 decoded bytes.                                                          |
| `MUSICMUTE_UPDATE_CONFIG_FILE`           | Path to the public publisher JSON downloaded from the dashboard's Mac updates page; replaces the feed/key pair.         |
| `MUSICMUTE_RUNTIME_DOWNLOAD_BASE_URL`    | Required immutable HTTPS directory for the separately generated runtime ZIP.                                            |
| `MUSICMUTE_RUNTIME_REDIRECT_HOSTS`       | Optional comma-separated HTTPS redirect/CDN host allowlist, maximum seven hosts beyond the source host.                 |
| `MUSICMUTE_RUNTIME_REUSE_PACKAGE_RESULT` | Optional absolute path to an exact prior `build-<UUID>.noindex/package-result.json` for a same-runtime app-only update. |

The runtime reuse input is an explicit alternative to generating a fresh
runtime artifact. It preserves the prior bootstrap URL and copies the exact ZIP
and manifest into the new build root after revalidating source/API/signing
compatibility, ownership, hashes, inventory, runtime identity and signatures.
If a download base URL or redirect list is also supplied, each supplied value
must exactly match the prior sealed manifest. Runtime-producing changes require
the normal fresh path; they must not use this input.

Feed and public key must be provided together. They are sealed into Info.plist;
there is no user-controlled feed setting. A previous Sparkle UserDefaults feed
override is cleared when the updater starts. Leave both unset for local builds:
Settings explicitly shows **Update checks are not configured for this build.**
The app, setup and local processing continue to work.

The [dashboard publisher guide](../../docs/macos-updates.md) describes public-key
setup, signed artifact upload and publication. The dashboard derives the stable
feed and archive addresses from the API's configured public origin. Download its
publisher JSON and set `MUSICMUTE_UPDATE_CONFIG_FILE` before packaging. Providing
that file together with either feed/key environment input is rejected. No signing
key is generated or exported by packaging. Apple Developer ID signing,
notarization and deployment remain separate release work. Local ad hoc packages disable library validation only for the outer local
app so the ad hoc embedded framework can load. Distribution packages retain
library validation and sign all nested code under their selected Developer ID.

## Prepare an update without publishing

After the existing release workflow has produced an accepted, stapled, verified
`release-result.json`, run `npm run prepare:macos:update --` with these arguments:

- `--release-result`: absolute path to that exact release-result.json.
- `--download-base`: publisher-owned HTTPS directory for immutable update archives.
- `--dashboard-config`: downloaded publisher JSON, instead of `--download-base`.
- `--keychain-account`: the local Sparkle signing key's account name.

The command reads an existing Keychain key; it does not generate/export a key,
connect Apple credentials or upload anything. It verifies the release and package
identity, matches the existing public key to the app's embedded key, checks the
stapled DMG, copies its exact bytes to a version/build/hash-named archive, signs
and verifies both archive and appcast, and writes `update-result.json` with
`published: false` in an ignored private output directory.

The generated appcast is a complete one-version feed. Preserve the preceding
signed feed and release archives when publishing/rolling back; the preparation
command never replaces a remote feed. Changing feed contents after signing
requires signing it again. A real public update/relaunch test remains a release
gate once Apple signing, the update key and the public feed are configured.

With dashboard configuration, preparation also requires the package's sealed
feed/key to match that file. It takes the archive base from the same file. The
accepted input DMG is the exact `accepted.noindex/MusicMute-VERSION-arm64.dmg`
written by notarization; alternate paths, changed hashes and unfinished releases
are refused. Upload the resulting named DMG and exact signed `appcast.xml` in
**Mac updates**, then publish the verified draft there.

## Validation scope

Swift tests cover configuration, explicitly unconfigured builds, shared/exclusive
lease collision/release and symlink rejection. Python process fixtures cover
native host coexistence, helper lease lifetime, update exclusion and failed
installation recovery. TypeScript fixtures cover build/feed/key validation and
appcast generation. These local fixtures do not prove Apple acceptance, remote
hosting, an actual downloaded update or a live production relaunch.

Upstream references: [setup](https://sparkle-project.org/documentation/),
[programmatic setup](https://sparkle-project.org/documentation/programmatic-setup/),
[publishing](https://sparkle-project.org/documentation/publishing/),
[customization](https://sparkle-project.org/documentation/customization/), and
[user driver contract](https://sparkle-project.org/documentation/api-reference/Protocols/SPUUserDriver.html).

`node scripts/qualify-updater.mjs` runs the pinned Sparkle signer against a
synthetic archive and signed appcast, verifies both and proves that a modified
archive is rejected. Its deterministic fixture key exists only in a temporary
private output directory and is removed when the check finishes. It never reads
the login Keychain and does not establish a public installer update.
