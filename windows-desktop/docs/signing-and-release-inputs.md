# Windows Setup signing and release inputs

**Current release decision, 2026-10-12:** use the existing Microsoft developer
account and free Store package signing, with no paid signing purchase. The
[MSIX migration checklist](../../docs/windows-desktop/store/MSIX-MIGRATION.md)
tracks the required feature-preserving port. The standalone NSIS certificate and
runtime-ZIP inputs below describe the earlier release path; they are not a
requirement to purchase signing for the selected Store route.

Verified against current source and official documentation on 2026-10-12.
This guide prepares the existing Windows x64 NSIS release. It does not establish
that an installable, signed Setup.exe or consumer runtime has been produced.

## Microsoft account and signing choice

Partner Center developer registration does not issue a downloadable Authenticode
certificate for the standalone installer. Microsoft signs Store-submitted MSIX
packages after certification; publishers must sign EXE/MSI installers themselves.
See [Microsoft's signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

Azure Artifact Signing is a separate service. Its current Public Trust rules
permit individuals in the US and Canada; Egypt is not eligible. The organization
country list is different. See the
[current prerequisites](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart).

A possible individual certificate route is
[SSL.com IV Code Signing](https://www.ssl.com/products/software-integrity/code-signing/iv/)
with eSigner. The published one-year certificate price is $129; the
[annual Tier 1 signing plan](https://www.ssl.com/guide/esigner-pricing-for-code-signing/)
is $180 for 240 signatures per year. The combined base is $309 per year, before
taxes and extra signatures. Individual identity and country eligibility must be
confirmed by the CA; no purchase or issuance is implied. The certificate shows
the verified personal name, which may differ from a Store publisher alias.

The documented
[eSigner CKA](https://www.ssl.com/how-to/how-to-install-ssl-com-esigner-cloud-key-adapter-cka/)
manual mode supports individual certificates and exposes the certificate through
the Windows certificate store. Its private key stays in the HSM. Do not require
an exportable PFX or promise unattended IV signing. CKA tooling, login, possible
restart and the app's certificate-store integration remain future work.

## Prepared directories

These Mac directories were created outside the repository:

```text
~/Library/Application Support/MusicMuteReleaseInputs/windows-x64/
  approval.json                         # generated after final signed inputs
  inputs/
    native/
    runtime/
    notices/
  artifacts/                            # runtime ZIP and signed sidecars

~/Library/Application Support/MusicMuteSigning/windows/
  authenticode/                         # external signing authority information
  metadata/                             # private Ed25519 release key
```

Private signing directories are owner-only. The newly generated private metadata
key is mode 0600. Neither private keys nor passwords belong in `inputs/`, the
repository, packaged artifacts or chat messages.

The corresponding Windows build locations, to be prepared when signing is
available, are:

```text
C:\Users\hatem\AppData\Local\MusicMuteReleaseInputs\windows-x64\
C:\Users\hatem\AppData\Local\MusicMuteSigning\windows\
```

They are proposed Windows paths, not evidence of creation or installed tooling.
Private Windows paths require the existing owner-only NTFS access policy.

## Owner-controlled inputs

1. **Windows Authenticode signing authority.** Provide the certificate provider
   and supported signing interface, and put an issued public `publisher.cer`
   under `MusicMuteSigning/windows/authenticode/`. A public certificate alone
   cannot sign: the owner must have working token/HSM/cloud signing access. We
   can derive the actual publisher name, SHA-256 of leaf DER and certificate-store
   SHA-1 selector. The owner completes CA identity verification and enters signing
   credentials/OTP directly in the trusted signing UI. Government ID and account
   credentials are not repository inputs.
2. **An existing release-metadata authority, only if it must be reused.** Supply
   its key ID and the local protected key location or signing interface. Otherwise
   the new Windows-specific Ed25519 key described below is prepared for review.
   It does not replace the existing worker or macOS release keys.
3. **Release choices.** Confirm the initial app build number, runtime version and
   monotonic sequence, metadata expiry, immutable runtime URL and update feed URL.
   Current source versions are desktop 0.1.0 and worker 0.1.3. Proposed values are
   not approved manifests, existing downloads or publication evidence.

The shared public Firebase/API and Desktop OAuth configuration was found in the
existing macOS build input, passed the actual Windows configuration validator,
and was copied into the prepared Windows inputs. No new Google client or client
secret is required if this existing shared client remains approved. Native
Windows Google login and backend audience/exchange acceptance still need testing.

If configuration changes are needed, supply only these four public settings in
`inputs/desktop-public-config.json`:

```text
backend_base_url          HTTPS API origin, without path/query/credentials
firebase_api_key          public Firebase Web API key
firebase_project_id       Firebase project ID
google_desktop_client_id  registered shared Desktop OAuth client ID
```

Google client secrets and Firebase Admin credentials remain backend-only.

## Prepared public and private metadata files

- `inputs/desktop-public-config.json`: copied and validated public configuration;
  identical SHA-256 to the selected existing Mac input.
- `inputs/runtime-public-keys.json`: a public Ed25519 SPKI PEM map with key ID
  `windows-user-release-2026-10`.
- `MusicMuteSigning/windows/metadata/windows-user-release-2026-10.private.pem`:
  newly generated private PKCS#8 Ed25519 key, outside the repository and payload.
  A sign/verify challenge passed. This is release-metadata signing authority,
  not a Windows-trusted Authenticode certificate. No runtime release was signed.

The private key must be retained securely for future releases. Only public keys
enter the signed app's resource seal. Existing files are never replaced by this
preparation.

## Complete package inputs generated by the release work

The `inputs/` directory must contain exactly the approved allowlisted resources:

| Relative path                    | Source and remaining work                                                    |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `native/musicmute-native.exe`    | Current compiled x64 helper; sign and audit final bytes.                     |
| `native/MusicMuteSession.exe`    | Current compiled x64 login launcher; sign and audit.                         |
| `native/MusicMuteChromeHost.exe` | Current compiled x64 Chrome host; sign and audit.                            |
| `desktop-public-config.json`     | Prepared shared public configuration; Windows login acceptance pending.      |
| `runtime-public-keys.json`       | Prepared public metadata key map.                                            |
| `runtime/runtime-metadata.json`  | Generated signed consumer-runtime metadata.                                  |
| `runtime/runtime-source.json`    | Generated exact matching archive download descriptor.                        |
| `update-channel.json`            | Generated trust configuration using approved feed and publisher.             |
| `app-icon.ico`                   | Existing artwork already assembled as an ICO candidate; approve final bytes. |
| `notices/runtime.txt`            | Collect notices from the actual qualified runtime dependencies.              |

`worker-catalog-update-channel.json` is optional, with the same trust schema and
publisher pin. Its absence keeps catalog updates unavailable. `approval.json`,
ZIPs, private keys and certificate exports stay outside `inputs/`.

The owner does not need to hand-author inventories, signatures, native manifests,
archive descriptors or notices. They are generated and verified from actual final
bytes. The old pre-sign inventory cannot approve newly signed files.

### Exact generated JSON field sets

`runtime-public-keys.json` is a plain map from key ID to Ed25519 SPKI public PEM,
with one to four keys. It has no private material or `version` wrapper.

`runtime/runtime-metadata.json` is the consumer ZIP's generated signed sidecar:

```text
keyId
metadata:
  schemaVersion: 1
  installationProfile: windows-user
  platform: windows-amd64
  sequence: positive monotonic integer
  releaseVersion
  publishedAt, expiresAt: ISO timestamps
  release: filename, bytes, sha256, contentType: application/zip
signature: Ed25519 base64url signature
```

`runtime/runtime-source.json` has exactly:

```text
version: 1
platform: windows-amd64
installationProfile: windows-user
targetIdentity: derived preparation identity SHA-256
filename, bytes, sha256: matching the signed ZIP metadata
unpackedBytes: exact positive extracted byte count
url: approved HTTPS downloads.music-mute.com/releases/.../<same ZIP filename>
```

The sealed source descriptor permits no credentials, query, fragment, alternate
port, arbitrary host or null unpacked byte count. Its target identity includes
the archive, version, sequence, current model/fixture and qualification identity.

`update-channel.json` and the optional catalog trust file have exactly:

```text
version: 1
feed: approved HTTPS signed metadata feed URL
publicKeys: key ID -> Ed25519 SPKI public PEM
allowedOrigins: one to four exact HTTPS origins
publisherSha256: actual Authenticode signer leaf DER SHA-256
```

The feed serves a signed `ConsumerUpdateMetadata` envelope, not the runtime ZIP
sidecar. Its envelope has `keyId`, `metadata` and `signature`; metadata contains
`schemaVersion`, `installationProfile`, `platform`, `channel`, `sequence`,
`publishedAt`, `expiresAt`, `dataSchema`, `publisherSha256`, `app`, `runtime`,
`model` and `required`. The app record binds its version, logical payload SHA-256
and artifact; runtime/model records bind versions, compatible minimum versions
and artifacts; required binds minimum app/runtime/model versions. Each artifact
binds `filename`, `url`, `bytes`, `sha256` and `contentType`. Both schemas use
Ed25519, but their metadata and signatures cannot be substituted for one another.

`approval.json`, outside `inputs/`, has exactly:

```text
version: 1
appVersion: approved desktop package version
appBuildNumber: explicitly approved positive integer
publisherName: actual approved signing publisher name
publisherSha256: actual signer leaf DER SHA-256
entries: [{ path, bytes, sha256 }] for every approved input
```

No placeholder configuration, fake signature or unverified download URL is
written into release inputs.

## Runtime assembly and final setup

Use `worker/scripts/build-windows-consumer-runtime.ps1` for the `windows-user`
profile with the current agent and warm-session engine code, qualified locked
Node/Python/DirectML/FFmpeg and acquisition inputs, and the external metadata key.
The staged QA Python environment is not a qualified consumer release. The separate
administrator/SCM `package:windows` command is not this app's runtime.

Sign helpers first, build and sign the consumer runtime metadata, then regenerate
all inventories from final bytes. The existing desktop release command runs on
native Windows x64:

```text
node packaging/build-release.mjs <absolute approval.json> <absolute inputs folder> <absolute new staging folder>
```

It seals resources and ASAR, signs Electron, derives the final app authority,
then builds/signs NSIS and its generated uninstaller. The expected artifact is
`<stage>/output/MusicMute-Local-0.1.0-x64.exe` for the current desktop version.
Public runtime delivery, installed-app/Chrome/account acceptance and Windows 10
22H2 acceptance remain separate gates.

## Signing integration limits

Current tooling supports privately supplied `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`
(with `CSC_LINK`/`CSC_KEY_PASSWORD` fallbacks) for an already available supported
certificate file. This is not a recommendation to export hardware-backed keys.
Certificate-store/HSM selection needs a narrow integration through the pinned
builder's `certificateSha1` or `certificateSubjectName` options; our current
configuration does not expose those selectors. Preserve the existing custom
sign hook and generated-uninstaller signature audit.

Current native/app/update trust pins the entire signer leaf certificate DER.
All owned helper/app/setup/uninstaller signatures must match the approved leaf.
Certificate renewal therefore needs a trust transition. Azure Artifact Signing
certificates renew daily and last 72 hours, so it is not a drop-in signer for this
implementation even where eligible. Timestamping does not make different leaf
hashes equal. See
[Microsoft's certificate management guidance](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-certificate-management).

Switching to Store MSIX would require separate packaging and trust/lifecycle
changes; Store package signing does not supply individual Authenticode signatures
for the current helpers or downloaded runtime.
