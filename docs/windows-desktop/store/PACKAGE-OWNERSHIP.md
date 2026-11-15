# Store package ownership and compatibility

Source implementation: 2026-10-12. This records S01/S02 contracts and the initial
version choices for the authorized migration. It does not establish capability
approval, signed packages, installation, certification or publication. Continue
the [migration tasks](MSIX-MIGRATION.md) for those separate gates.

## Product identities and initial versions

The names, publisher and families below come from the two live Partner Center
Product identity records retained outside the repository. Application IDs and
initial version/build values are implementation choices; they are not Store-
assigned MSA application IDs or evidence of a submitted package.

| Field                              | GUI                                   | Worker                                      |
| ---------------------------------- | ------------------------------------- | ------------------------------------------- |
| Display name                       | MusicMute                             | MusicMute Worker                            |
| Store product                      | 9P7VX8JK8B68                          | 9P4GXB0NRJDG                                |
| Identity Name                      | 27120VCHATSDK.MusicMute               | 27120VCHATSDK.MusicMuteWorker               |
| Family                             | 27120VCHATSDK.MusicMute_5q1esjnkz8cve | 27120VCHATSDK.MusicMuteWorker_5q1esjnkz8cve |
| Manifest Application ID            | MusicMute                             | MusicMuteWorker                             |
| Code version                       | 0.1.0                                 | 0.1.3                                       |
| Initial package submission version | 0.1.0.0                               | 0.1.3.0                                     |
| Explicit application build number  | 1                                     | 1                                           |

Both package publishers are `CN=8A81D011-D5B0-414F-B3F7-A768A6B8C95E`, with
publisher ID `5q1esjnkz8cve` and display publisher `VCHATSDK`.

The GUI package's primary Application ID remains `MusicMute`. A second hidden
`MusicMuteChromeHost` Application entry owns its console native-messaging alias
and explicitly supports multiple instances. Both entries share the same GUI
package identity and code owner; they are not separate products or packages.

Each four-part package node is a canonical decimal uint16. Submission reserves
the fourth node as zero. Installed Store packages may have a Microsoft-assigned
nonzero fourth node; compare all four nodes numerically against durable version
floors. Do not infer the positive application build number from package version.
Both packages require native x64 Windows 10 build 19045 or Windows 11, with x64
process architecture. ARM emulation is unsupported.

The initial explicitly supported protocol ABI is **1**, with GUI semantic base
**0.1.0** and Worker semantic base **0.1.3**. Independent Store revisions of these
bases are accepted. An independently updated semantic base or different ABI is
incompatible until a future explicitly reviewed contract adds it. A newer
version alone is not evidence of a compatible process/wire contract.

## Native receiving boundary

`windows-desktop/src/shared/store-contracts.ts` parses exact bounded JSON and
rejects duplicate decoded fields, unknown fields, getters/inherited values,
foreign identities, unsafe paths, wrong architecture, invalid versions and
missing registration health/current status. The installed observation fields
are exactly:

```text
identityName, publisher, publisherId, familyName, fullName, packageVersion,
architecture, signatureKind, healthy, current, installedLocation
```

The expected role is supplied separately by the trusted caller. It is never a
self-asserted role in the observation. Production requires actual OS
`PackageSignatureKind.Store` (**3**); None (**0**), Developer, Enterprise and
System do not grant this production Store authority. A disposable development
prototype uses a separate explicit boundary and cannot satisfy these contracts.
Framework, resource and optional package full-name forms are rejected.

Parsing is not OS authentication. Root/native integration must obtain each
observation from actual registered PackageManager identity/status/signature
data, retain the exact current package generation and living process/file
handles, and validate sealed code hashes before privileged work. A JSON object
or a path under WindowsApps cannot authorize execution by itself. Mutable user
files keep their existing ACL/link/birth/handle rules; Store code uses its own
package-file policy for legitimate deployment hardlinks.

Pair evaluation produces explicit missing-product recovery. A compatible,
registered Worker may continue when GUI is absent. A GUI without Worker cannot
process locally. Incompatible or rolled-back Worker code does not start under a
guessed compatibility rule. Observed Store revisions below a durable floor are
rejected independently for each package.

## Immutable code owners

Every executed byte belongs to one independent main package and a closed sealed
inventory. The classifier determines ownership, not permission to execute an
unverified file. Receiving code must compare its exact bytes/hash against the
actual package seal and use the Native authority above.

Code-reference paths are relative to the owner's immutable subtree: `app/`
inside the GUI package and `worker/` inside the Worker package. Those outer
prefixes are applied only after exact OS package/root discovery; they are not
included in `relativePath`. Each copy has a separate owner-scoped inventory.

| Owner  | Code and resources                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GUI    | Electron EXE/framework DLLs, ASAR/main/preload/renderer, account authority, player/Library UI, public configuration, shared extension assets, MusicMuteChromeHost.exe, browser-host.cjs, resources/native/musicmute-native.exe for GUI account/bootstrap operations, and MusicMuteSession.exe as its account/session-ticket proxy                                                         |
| Worker | MusicMuteWorker.exe visible worker controls; MusicMuteSession.exe login/session launcher; runtime/native/musicmute-native.exe for processing; Node; complete Python/DirectML executable/module/DLL closure; current engine; complete worker JS/production dependencies; five session/login/personal/fleet/Prepare agents; FFmpeg/ffprobe; Deno and provider/downloader code/caches/wheels |

Native helper and session-proxy copies are separately owned even where their
compiled bytes match. GUI references use `gui-native-helper` and
`gui-session-proxy`; Worker references use `native-helper` and `session-launcher`.
Neither copy grants authority to the other package or to a mutable external copy.

GUI removal cannot remove Worker through a framework/optional-package dependency.
Worker's login activation, saved intent, enrollment credentials and running work
must not depend on a surviving GUI executable. Its independent account refresh
uses existing Worker credentials; GUI account authority still owns interactive
sign-in and existing account commands. Shared APIs and raw realtime behavior do
not change merely because executable ownership changes.

No downloaded runtime ZIP, copied launcher, external JS/Python module, or
user-data directory supplies executable authority in Store mode. Prepare may
download the existing pinned model as data and qualify the installed immutable
runtime. Store owns executable updates for both packages. Closed runtime
assembly/import/DLL/license and installed qualification gates remain S06/S09.

## Lifecycle and mutable data

`planStoreLifecycle` evaluates ownership effects without performing operations
or granting consent. OS-managed uninstall/reset/update remains a separate action
subject to the user's actual request and native lifecycle integration.

| Event                      | Worker and GPU work                                                                                                            | Package/data behavior                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| GUI close                  | Retire that GUI's personal ownership; independently enrolled Worker and other owners may continue while logged in              | No package removal or external data deletion                                                    |
| Account sign-out           | Personal local processing and separately enrolled Worker may continue                                                          | Clear GUI account session through the existing account journey; no worker credential revocation |
| GUI update/repair/reset    | Detach GUI-owned work; Worker remains independent                                                                              | Respect GUI servicing; reset clears GUI account session, with no blanket external-root deletion |
| GUI uninstall              | Worker may continue while logged in                                                                                            | Remove GUI only; GUI package LocalState is OS-owned and removable                               |
| Worker update/repair/reset | Positively retire owned Worker/GPU trees before replacement; recover saved intent only after current code/qualification checks | GUI remains installed; package LocalState is not a durable credential store                     |
| Worker uninstall           | Retire owned Worker/GPU trees; local processing requires Worker installation again                                             | Remove Worker only; GUI remains installed                                                       |
| Both uninstall             | Retire all owned Worker/GPU trees                                                                                              | Both package LocalState roots are removable; external retention needs the proof below           |
| Windows logoff             | Positively retire owned worker/engine/tool trees and release GPU fences                                                        | No unconditional model-retention promise past logoff                                            |

Existing model, media, jobs, Library, preferences, account/fleet credentials,
outboxes, leases and recovery journals belong to guarded external per-user data
roots. Lifecycle plans never authorize deleting them. Persistent data after both
packages are removed/reinstalled is **conditional on actual non-virtualized
external-root namespace proof**. Package LocalState or PublisherCache cannot be
substituted while claiming the same retention. Physical namespace, servicing,
reset/uninstall/reinstall and logoff proof remains S03/S14/S18.

## Remaining approval and evidence

Restricted capabilities, Chrome namespace/activation, Store content/rights
review and background GPU/network disclosures remain unapproved/open. The
source contracts do not certify manifests or create a Store signature. All
physical and certification gates in the migration remain separate.

The [Zalando guidelines](https://opensource.zalando.com/restful-api-guidelines/)
were read on 2026-10-12. Portable security, bounded UTF-8/unique JSON objects and
explicit compatibility boundaries inform this private package contract.
HTTP routes, OAuth/OpenAPI/media-type rules do not apply to this package/native
observation; existing camelCase private fields are preserved. No HTTP API changed.
