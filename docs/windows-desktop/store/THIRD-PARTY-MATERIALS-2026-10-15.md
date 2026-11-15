# Third-party release materials — 15 October 2026

This is the reviewer inventory for the current two unsigned Store candidates.
It records material already prepared and the remaining distribution evidence.
It does not approve rights declarations, certify corresponding-source delivery,
or authorize publication. The owner will submit the separate Microsoft support
request later. Use the [submission packet](SUBMISSION-PACKET-2026-10-15.md) for
the capability and hidden-entry requests.

## Exact candidate boundary

| Product                         | Candidate                          |       Bytes | SHA-256                                                            |
| ------------------------------- | ---------------------------------- | ----------: | ------------------------------------------------------------------ |
| MusicMute `9P7VX8JK8B68`        | `MusicMute-0.1.0.0-x64.msix`       | 167,074,916 | `99ffc7819c3478f2fa2c7966fa66189cf467c22c2f74f6d17f35111b8f7c40f5` |
| MusicMute Worker `9P4GXB0NRJDG` | `MusicMuteWorker-0.1.3.0-x64.msix` | 424,942,319 | `aa5d7c08b7edaed2f541d91635f2c845709f167418e499819c3ad92ad93f84a5` |

The [original SDK archive receipt](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Build-Proofs-Current-2026-10-15-ab42e4db/msix20/archive-receipt.json)
records complete readback of 110 GUI inventory files and 19,344 Worker inventory
files, plus two generated SDK metadata files per package. Both remain unsigned,
non-installable, unpublished, and pending namespace/capability approval. These
hashes supersede the earlier GUI upload that Microsoft rejected; do not attach
the old artifact or its receipt as the current release.

Both candidates retain Windows 10 22H2/build 19045 and Windows 11 native x64,
the same GPU model and recipes, and the single shared Chrome extension. The
default/trim, cold/warm comparison across the original and Store Python profiles
passed eight actual GPU calls with exact output parity. That result establishes
no Store-installed behavior or redistribution rights.

The [current sealed payload inventories](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Store-Review-Materials-2026-10-15/CURRENT-PACKAGE-INVENTORIES.json)
were copied with full size/SHA verification: GUI 13,368 bytes/SHA-256
`8be9d1b1232e7022ddcf50b2e65d0f7c1dbf0e5f8f33c122803e63b5c0b18b7c`
and Worker 3,404,008 bytes/SHA-256
`14f901df0282475a4ca0d910eb620687102c25541d0831a953633434832f8333`.
They contain 104 GUI and 19,338 Worker payload entries; the archive audit above
also covers each package's six packaging files. The
[machine-readable third-party review index](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Store-Review-Materials-2026-10-15/THIRD-PARTY-INVENTORY-DRAFT.json)
selects notice-named paths and all 62 top-level Python distribution METADATA
pins, records the exact five additional notice texts and provenance, and confirms
zero `diffq` paths in the current Worker inventory. It is not a complete legal
SBOM or license approval; the full inventories remain authoritative for bytes.

## Material ownership and notice locations

Paths below are relative to the relevant package root. The Worker runtime lives
under its `worker/` prefix; source builders validate retained notice bytes before
staging and again at receiving. License names in this table identify the material
to review; they do not replace the complete bundled terms or native-library
notices.

| Material                                                                 | Release location or evidence                                                                                                                                                                  | Current status                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GUI Electron 44.7.0, React/React DOM 19.2.8, compiled dependency notices | GUI `app/LICENSE.electron.txt`, `app/LICENSES.chromium.html` and `app/resources/notices/bundled.txt`; asset validation in [GUI audit](../../../windows-desktop/packaging/store/audit.ts)      | Exact GUI byte inventory passed; retain the complete Electron/Chromium third-party notice set.                                                                                                                                                                               |
| Noto Sans Arabic and Google brand assets                                 | Inside GUI ASAR, checked against the [licensed build assets](../../../windows-desktop/docs/build-inputs-and-licenses.md)                                                                      | OFL-1.1 font notice and Google attribution retained. The Google mark is not an OAuth or third-party service permission.                                                                                                                                                      |
| Compiled session/Prepare/personal/fleet/browser agents                   | Worker `worker/runtime/licenses/agent/bundled.txt`; GUI compiled dependencies retain their own notices                                                                                        | [Agent notice source](../../../windows-desktop/packaging/store/agent-notices.ts) binds exact Electron 44.7.0, pend 1.2.0 and yauzl 3.4.0 license bytes to actual compiled inputs.                                                                                            |
| Node 24.18.0, CPython 3.12.10 and MusicMute engine                       | Worker `worker/runtime/node/LICENSE`, `worker/runtime/python/LICENSE.txt`, `worker/runtime/licenses/python/LICENSE.txt`, `worker/runtime/licenses/musicmute/LICENSE`                          | Actual retained files are covered by the complete archive audit. The original composite Node/Python notices remain necessary.                                                                                                                                                |
| Python/DirectML runtime                                                  | Worker `worker/runtime/python/Lib/site-packages/`, `worker/runtime/requirements-directml.lock.txt`; separate build-side `python-build-work/python-projection-receipt.json`                    | Store profile expects 62 distributions from the preserved 63-distribution source lock. Retain each distribution's metadata and bundled native notices; do not infer all terms from the top-level package name.                                                               |
| Cython 3.3.0                                                             | Worker `worker/runtime/licenses/cython/COPYING.txt` and `worker/runtime/licenses/cython/LICENSE.txt`                                                                                          | Exact 756/10,174-byte upstream notices and wheel METADATA pins are enforced.                                                                                                                                                                                                 |
| flatbuffers 25.12.19                                                     | Worker `worker/runtime/licenses/flatbuffers/LICENSE`                                                                                                                                          | Exact 11,358-byte Apache-2.0 text, bound to actual wheel metadata.                                                                                                                                                                                                           |
| samplerate 0.1.0                                                         | Worker `worker/runtime/licenses/samplerate/LICENSE.rst`                                                                                                                                       | Exact 1,099-byte upstream notice, bound to the retained binding and wheel metadata.                                                                                                                                                                                          |
| libsamplerate 0.1.9                                                      | Worker `worker/runtime/licenses/libsamplerate/COPYING`                                                                                                                                        | Exact 1,334-byte upstream notice, bound to the retained x64 library.                                                                                                                                                                                                         |
| Provenance for the five notices above                                    | Worker `worker/runtime/licenses/python-notice-sources.json`; [source pins](../../../windows-desktop/packaging/store/python-notices.ts)                                                        | The five notice texts total 24,721 bytes, with a separate provenance JSON. Exact source/archive/member and retained wheel/library identities are verified; this is notice closure for these identified gaps.                                                                 |
| FFmpeg 8.0.3 and statically linked LAME 3.100                            | Worker `worker/runtime/bin/ffmpeg.exe`, `ffprobe.exe`, `worker/runtime/licenses/ffmpeg/COPYING.LGPLv2.1`, `worker/runtime/licenses/lame/COPYING`, `worker/runtime/media-source-manifest.json` | Licenses and exact upstream sources recovered; scratch reconstruction/relink passed. Original-binary source correspondence and recipient delivery remain open below.                                                                                                         |
| Acquisition runtime                                                      | Worker `worker/tools/downloader/` and `worker/tools/youtube/`, including wheel-contained licenses, `worker/tools/youtube/licenses/deno/LICENSE` and `worker/tools/youtube/provider/LICENSE`   | Exact pins include Deno 2.9.7, provider 2.0.1, yt-dlp 2026.08.19 and EJS 0.8.0. [Assembly pins](../../../worker/src/platform/windows/consumer-pins.ts) bind the artifacts. Keep provider dependency notices and explain fetched challenge-code evaluation in reviewer notes. |
| Kim Vocal 2 model                                                        | Verified owner-hosted download during Prepare; excluded from both MSIX archives                                                                                                               | 66,759,214 bytes, SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`. The retained authorization condition permits direct owner-hosted use, with no MusicMute mirroring. Keep private authorization correspondence outside this packet.              |
| Shared Chrome extension                                                  | GUI `app/resources/extension/notices.txt` and shared extension output; no Windows-specific fork                                                                                               | Existing identity `acmgefmmndomcpdlgnafkjbgobinllep` and native host `com.musicmute.local`. Retain its exact source-derived notices; this packet asserts no Chrome Web Store distribution.                                                                                   |

The full source lock still names `diffq-fixed` 0.2.4. The Store-only
`store-kim-mdx-v1` projection explicitly omits its 16 pinned unused leaves;
the original lock and full runtime are preserved. The owner reports no
dependency-specific grant. Do not reuse the earlier full-runtime archive for
Store submission, or describe the Store projection as a grant for that
CC BY-NC dependency. The [projection policy](../../../windows-desktop/packaging/store/python-projection.ts)
records exact omissions; the [production runtime admission](../../../worker/src/platform/windows/consumer-package.ts)
checks the selected 62-distribution profile independently.

## Current Python declarations and additional source inputs

The [62-component JSON declarations](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Store-Review-Materials-2026-10-15/PYTHON-THIRD-PARTY-DECLARATIONS-DRAFT.json)
and [CSV](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Store-Review-Materials-2026-10-15/PYTHON-THIRD-PARTY-DECLARATIONS-DRAFT.csv)
retain each exact name/version, declared license headers/classifiers and shipped
METADATA pin. All 62 raw members in
[the metadata ZIP](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Store-Review-Materials-2026-10-15/python-metadata-current-62.zip)
match the current sealed inventory: 258,253 compressed bytes, SHA-256
`78dd1548a54443e1e5ecead873412babd134405812df0c8e2906a9c4d83481b2`,
710,717 uncompressed bytes. Declared labels do not adjudicate all bundled native
terms. In particular, `certifi` declares MPL-2.0, `tqdm` declares MPL-2.0 AND MIT,
and `soxr` declares LGPL-2.1-or-later. Their retained source/notices require the
same complete dependency review; the FFmpeg draft covers neither SoXR nor the
acquisition provider automatically.

Additional immutable inputs are retained in the
[source-input index](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Store-Review-Materials-2026-10-15/third-party-source-inputs-DRAFT/SOURCE-INPUTS-DRAFT-INDEX.json):

| Input                                                                                             | Verified connection to the current package                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Remaining scope                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bgutil provider 2.0.1 official source, resolved commit `2df09aeaa71a4eec1e31901e84fbddbf0c7c54a9` | 118,472-byte archive, SHA-256 `ae39fc64ac60e87c1f8ccada172f49471f7d5138f06e6302d84e9065786ad126`; complete official [GPLv3 license text](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/blob/2.0.1/LICENSE) matches the packaged 35,149-byte license. Applying the retained repository patch in memory produces the exact packaged `session_manager.ts`; the patch script and `generate_once.ts` also match their current packaged pins. Original sources, modifications and a unified diff are retained together. | Source modification correspondence is established for these files. Complete provider/dependency/native build-source delivery and applicable combined-work terms remain for review; no application relicensing is asserted.                                                                                               |
| Python-SoXR 1.1.0 official source distribution                                                    | 173,067 bytes, SHA-256 `9f228ae21c78fa9359ca98d8a5e8e91f30639e438e574133dace62c5b5309e44`; includes bundled libsoxr source and build files. Official `cp312-abi3-win_amd64` wheel is 174,357 bytes, SHA-256 `6ae2a174bffea94e8ead857dad85999d3f49f091774dbad5b046c0417d7092f4`; its ten code/native/metadata/license members match the current package exactly.                                                                                                                                                             | The wheel's installation RECORD differs from the packaged installation record, and all four source license texts use LF while the official Windows wheel uses CRLF; those exact differences are recorded without changing either archive. Original native build/relink qualification and recipient delivery remain open. |

The [Python-SoXR release page](https://pypi.org/project/soxr/1.1.0/) identifies
its bundled modified libsoxr and LGPL terms. The source-input receipt records
the exact PyPI file digests, current native-binding pin and four full license-text
comparisons. Recovering source archives and existing patches does not change the
installed runtime, recipe, model or application licensing.

## FFmpeg/LAME source and relink evidence already prepared

The current [source reconstruction draft 10](/Users/hatemragap/Downloads/MusicMute-Windows-x64-2026-10-15/Source-Materials-Reconstruction-DRAFT-2026-10-15/musicmute-windows-media-source-proof.draft10.zip)
is 13,291,427 bytes, SHA-256
`37dd28dbd0d25b07b2a3099c5441552dc6cf7cd8047fd604bed1b7541ecebc2a`.
Its 171 entries passed complete CRC readback. Read its
`CURRENT-TECHNICAL-STATE10.json` for the current conclusion; historical records
retain their original failed or earlier scope.

| Source material inside the draft                                                | Exact identity                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sources/ffmpeg-8.0.3.tar.xz`                                                   | 11,407,656 bytes; SHA-256 `6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818`                                                                                                                                               |
| `sources/lame-3.100.tar.gz`                                                     | 1,524,133 bytes; SHA-256 `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`                                                                                                                                                |
| FFmpeg signature and verification key                                           | Signature verified using the retained upstream key in an isolated keyring; no global trust or private key change.                                                                                                                          |
| `licenses/`, generated `configuration/`, original executed scripts and Mac logs | Exact source-matched license texts; successful new baseline build, modified LAME build and static relink. All 10,219 original extracted source files retained their bytes.                                                                 |
| `patches/lame-relink-canary03.patch`                                            | Explicit new diagnostic-only modification and relink demonstration; no production audio calculation or shipped binary changed.                                                                                                             |
| `evidence/windows-media09/`                                                     | Actual Z440 qualification passed all six child calls, full MP3 and decoded PCM parity, and unique marker only in the relinked encoder. Both original request-bound native guard frames report exit 0, whole-Job zero and both stream EOFs. |
| `rebuild-new-reconstruction.py`                                                 | Path-portable replay adapter passed local syntax, archive/tool validation and negative checks. A complete build through this new adapter has not yet been run.                                                                             |

The production FFmpeg readback reports GCC 16.2.0, MSYS2 Rev3. The new
reconstruction uses Homebrew MinGW-w64/GCC 16.2.0 and NASM 3.02. Equal GCC version
numbers do not identify equal toolchains. The scratch executables are distinct
from the original shipped FFmpeg, SHA-256
`8903984c02dc98239dffc9924fb8a6a7c556149742ce3dcb32559d760eaaab03`.
A focused repository recipe search found the macOS media recipe, which does not
recover the original Windows LAME configure flags, patch state or toolchain
executable hashes. The draft records this gap explicitly.

## Recipient delivery and original-source correspondence still to close

The [FFmpeg distribution guidance](https://www.ffmpeg.org/legal.html) calls for
source corresponding to the distributed binaries and build instructions; it
also calls out linked external libraries such as LAME. Its suggested linking
checklist is not a legal determination for this application. Review the actual
[LGPL 2.1 terms](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) and
[LAME guidance](https://lame.sourceforge.io/license.txt) against the shipped
separate command-line executables and static LAME linkage. A successful scratch
relink proves a technical path; it does not establish original-source
correspondence, customer delivery or an obligation to disclose proprietary app
objects merely because independent programs share an MSIX.

- [x] Retain complete exact upstream source archives, license texts and FFmpeg
      signature evidence, rather than upstream links alone.
- [x] Retain actual successful Mac reconstruction/modified-library relink logs,
      Windows execution/parity proofs and all corresponding input/output pins.
- [x] Identify the original compiler string and observed FFmpeg configure flags.
- [ ] Recover the original Windows FFmpeg/LAME build recipe, exact LAME options
      and patch/change record, and original toolchain provenance. If unavailable,
      define a future fully provenanced replacement release, then rebuild,
      requalify and regenerate both affected artifact identities before declaring
      correspondence. No replacement is implemented by this document.
- [ ] Run a clean full replay from the portable bundle in a new owned workspace,
      documenting prerequisites and complete outputs. Retain the successful
      historical commands separately; do not relabel preflight as a full replay.
- [ ] Select an owner-approved recipient delivery route for complete applicable
      source/build/relink materials. Provide recipients the actual files through
      that route, with stable version/hash attribution. A private local Downloads
      path or this repository's reviewer packet is not recipient delivery.
- [ ] Prepare a recipient-facing source/notice index that names the final two
      exact MSIX hashes, each applicable native component, source bundle hash,
      modifications, rebuild/relink entry points and support contact. Exclude
      credentials, private authorization correspondence and user media.
- [ ] Verify the chosen recipient path as an allowed tester: download the whole
      bundle, check its bytes/hash, read all licenses/instructions, and complete
      the qualified rebuild/relink procedure. Record retrieval and build evidence.
- [ ] Review source attribution and applicable terms in the actual distributed
      notices and recipient-facing descriptions, including translations. Do not
      claim a live source URL before it exists and is independently read back.
- [ ] Reconcile the complete retained Python/native/acquisition/GUI terms and
      actual model authorization with the intended distribution, then approve
      accurate Store rights declarations. No blanket clearance is recorded here.
      Include SoXR's native binding/source route, the provider's retained source
      modifications/dependencies, and the MPL components identified by the
      current metadata. Their obligations are not closed by the FFmpeg/LAME
      reconstruction.

No public source upload, application release, paid signing, certificate purchase,
Store certification submission or model mirroring was performed for this material.
Free Store signing remains the selected route.

## Concise reviewer statement

Use this factual statement with the separate certification instructions; it is
not a completed rights declaration:

> MusicMute and MusicMute Worker are separate native-x64 Store packages. Worker
> contains the pinned Python/DirectML, media and acquisition runtime; MusicMute
> contains the GUI and the single shared Chrome native-messaging integration.
> Third-party notices and exact input provenance are retained and checked against
> the package inventories. The model is obtained only from its authorized owner
> source. A new FFmpeg/LAME source reconstruction and modified-library relink
> passed Windows execution and exact audio parity without changing the shipped
> runtime. Original-build correspondence and recipient source delivery remain
> review gates; the attached technical draft does not assert legal clearance.
