# macOS runtime download and license approval checklist

**Prepared:** September 21, 2026. **Scope:** Apple Silicon macOS MVP.
**Status:** maintainer approval recorded for the listed open-source runtime
licenses and for commercial use of the listed model, subject to the
direct-owner-link/no-mirroring condition below. Artifact audit and notice
publication remain release-engineering gates.

This is the review list for every external runtime ingredient currently planned
for the macOS worker. It is an engineering inventory, not legal advice. On
September 21, 2026, the maintainer recorded that the listed source and license
pages were reviewed and approved for the commercial MVP. That decision does
not remove the obligation to ship required licenses/notices, satisfy source or
relinking duties, or make the final packaged bytes pass the artifact audit
described below.

### Recorded model-owner authorization

The maintainer also recorded direct authorization from the relevant model
owner(s) for commercial use through their own hosted download links. The
authorization does **not** permit MusicMute to download and re-upload, mirror,
proxy, or otherwise redistribute those model weights from MusicMute S3. The CLI
therefore uses the exact owner URL and reviewed redirect hosts in the catalog,
checks the expected byte count and SHA-256, and caches the verified bytes only
on the installing machine. The private correspondence remains outside Git;
only a non-secret authorization evidence reference may be stored in release
records.

## 1. What an installed Mac downloads

The installer performs a version and integrity preflight first. A trusted
MusicMute-private Node `>=24.18.0 <25` or complete, same-version
FFmpeg/FFprobe pair in `>=8.0.3 <9` may be reused. An exact hash-and-size
matching model cache entry is copied locally into the protected transaction and
is not requested again. Missing, older, unsafe, incomplete, or incompatible
components are installed by activating a newer private MusicMute release; the
CLI never upgrades or overwrites the user's global tools. Reuse still requires
the same notices, binary audit, signed metadata, and qualification as
downloaded components.

The customer Mac must not build the worker from the upstream URLs later in this
document. The normal network flow is:

| Stage                 | URL/origin                                                         | What is downloaded                                                                                                                      |
| --------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap             | <https://www.npmjs.com/package/@musicmute/worker>                  | MusicMute's small public CLI package after it is published                                                                              |
| Enrollment/catalog    | <https://api.music-mute.com/api/v1>                                | Authenticated metadata and short-lived exact-object grants; this is an API endpoint, not a large artifact download                      |
| Runtime release       | Temporary presigned HTTPS URL for a private MusicMute S3 object    | Qualified macOS ARM64 worker release containing Node, Python, the Python dependency environment, FFmpeg/FFprobe, notices, and manifests |
| Model                 | Exact owner-authorized upstream URL in the signed model descriptor | The exact approved Kim Vocal 2 model bytes; never copied, proxied, or uploaded to MusicMute S3                                          |
| Qualification fixture | Temporary presigned HTTPS URL for a private MusicMute S3 object    | The MusicMute-owned deterministic qualification WAV                                                                                     |
| Job media             | Temporary attempt-scoped S3 input/output URLs                      | User job input and result only after enrollment                                                                                         |

S3 presigned URLs expire and therefore cannot be listed as permanent URLs.
Release engineering downloads the reviewed runtime inputs once, verifies them,
builds and qualifies the immutable MusicMute-owned release/fixture set, uploads
only that set to MusicMute S3, and registers exact sizes, hashes, versions, and
signatures in the catalog. Model weights are excluded: the CLI downloads them
from their owners' approved URLs at installation time.

### Maintainer-provided model authorization condition

On September 21, 2026, the maintainer reported that the relevant model owners
authorized commercial use through their own hosted download links. They did
not authorize MusicMute to download the model files and re-upload, mirror, or
proxy them from MusicMute S3. This condition is normative for CLI and backend
implementation. The private correspondence itself is not committed; the
production catalog records a non-secret evidence/reference ID for the retained
authorization record.

## 2. Direct runtime and model inputs

`Approval` is deliberately conservative. “Review” means the URL is known but
the component-specific notices and redistribution obligations still need to be
checked against the final packaged bytes; it no longer means that maintainer
commercial-use approval is pending. A model marked
“direct-source authorized” may be used commercially only through the recorded
owner-hosted link and must never be mirrored by MusicMute.

| Ingredient                             | Exact source/review URL                                                                                                                                       | License/notice URL                                                                                                                                                              | Integrity pin                                                                                                                                | Shipped?                                                                         | Approval                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| MusicMute CLI and worker source        | <https://www.npmjs.com/package/@musicmute/worker> after publication                                                                                           | <https://www.apache.org/licenses/LICENSE-2.0>                                                                                                                                   | Release commit and npm integrity generated at publication                                                                                    | Yes                                                                              | Owner selected Apache-2.0; add repository/package license before release                          |
| Node.js 24.18.0, macOS ARM64           | <https://nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.xz>                                                                                          | <https://github.com/nodejs/node/blob/v24.18.0/LICENSE>                                                                                                                          | SHA-256 `4477b9f78efb77744cf5eb57a0e9594dba66466b38b4e93fa9f35cb907a095a6`; official list: <https://nodejs.org/dist/v24.18.0/SHASUMS256.txt> | `bin/node` and applicable notices                                                | Review                                                                                            |
| CPython 3.13.7 standalone, macOS ARM64 | <https://github.com/astral-sh/python-build-standalone/releases/download/20250818/cpython-3.13.7%2B20250818-aarch64-apple-darwin-install_only_stripped.tar.gz> | Distribution composite notices: <https://github.com/astral-sh/python-build-standalone/blob/20250818/LICENSE>; CPython: <https://github.com/python/cpython/blob/v3.13.7/LICENSE> | SHA-256 `024a3a1c95f171e97a4eaa6d2d289baf6802b72e4767023e3d9e4fa246be11bb`; 15,618,039 bytes                                                 | Yes, including its bundled native libraries                                      | Review; recommended reproducible pin, but audit every notice in the archive                       |
| FFmpeg 8.0.3 source                    | <https://ffmpeg.org/releases/ffmpeg-8.0.3.tar.xz>                                                                                                             | <https://ffmpeg.org/legal.html> and `COPYING.LGPLv2.1` in the archive                                                                                                           | SHA-256 `6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818`                                                                   | Built into `ffmpeg` and `ffprobe`                                                | Review; LGPL-2.1-or-later obligations apply                                                       |
| FFmpeg 8.0.3 signature                 | <https://ffmpeg.org/releases/ffmpeg-8.0.3.tar.xz.asc>                                                                                                         | Signing key: <https://ffmpeg.org/ffmpeg-devel.asc>                                                                                                                              | Fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8`                                                                                       | Verification input only                                                          | Required build verification                                                                       |
| LAME 3.100 source                      | <https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz>                                                                                 | Source `COPYING`/`LICENSE`; readable upstream license: <https://github.com/enzo1982/lame/blob/RELEASE__3_100/LICENSE>                                                           | SHA-256 `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`                                                                   | Statically linked into FFmpeg                                                    | Review; LGPL and static-link/relink obligations require explicit approval                         |
| Kim Vocal 2 ONNX model                 | <https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx>                                                               | The public repository does not state the private authorization condition; retain the owner's authorization correspondence outside Git and register its evidence/reference ID    | SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`; 66,759,214 bytes                                                 | Downloaded by the CLI directly into its local verified cache; never MusicMute S3 | **Direct-source authorized for commercial use per maintainer; mirroring/re-upload is prohibited** |
| Qualification WAV                      | Generated by MusicMute's deterministic fixture generator; no external URL                                                                                     | MusicMute copyright/provenance record                                                                                                                                           | Hash and size generated when the fixture is frozen                                                                                           | Yes, as a separate S3 object                                                     | Internal approval required                                                                        |
| Apple CoreML and system frameworks     | Supplied by supported macOS; no worker download                                                                                                               | <https://developer.apple.com/documentation/coreml> and applicable Apple SDK/OS terms                                                                                            | OS/runtime compatibility gate                                                                                                                | No copied framework planned                                                      | Review usage terms; do not bundle Apple SDK files                                                 |

### Current CLI model-source seed

Use this exact descriptor when implementing the first CLI/catalog entry. It is
configuration data, not a secret:

```json
{
  "modelId": "kim-vocal-2",
  "sourceUrl": "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx",
  "sourceHost": "github.com",
  "allowedRedirectHosts": ["release-assets.githubusercontent.com"],
  "maximumRedirects": 2,
  "bytes": 66759214,
  "sha256Hex": "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
  "distributionPolicy": "direct-owner-source-only"
}
```

The redirect chain was rechecked on September 21, 2026: `github.com` returned
one redirect to `release-assets.githubusercontent.com`, which returned the
model. The CLI must not preserve the redirect's temporary query string, log it,
or treat a different redirect host as automatically trusted. If the owner
changes hosting, update and re-sign the catalog descriptor after authorization
and integrity review; do not silently broaden the allowlist.

The separate MLX conversion at
<https://huggingface.co/mlx-community/mel-roformer-kim-vocal-2-mlx/blob/main/LICENSE>
has an MIT license file, but that does **not** prove that the exact ONNX file
above can be redistributed. It cannot be used as the ONNX approval record.

## 3. Pinned Python environment review URLs

The current native CoreML lock contains the following 64 exact package
versions. The PyPI version page is the stable review page for release files,
project metadata, declared license, and upstream links. It is not sufficient by
itself for final approval: the final wheelhouse must pin the exact macOS ARM64
wheel or source archive URL and SHA-256 for every row, then extract all
`*.dist-info/licenses`, notices, and embedded native-library licenses.

|   # | Package                           | Exact version review/download page                         | Approval                                                      |
| --: | --------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
|   1 | `absl-py==2.5.0`                  | <https://pypi.org/project/absl-py/2.5.0/>                  | Review                                                        |
|   2 | `audio-separator==0.47.0`         | <https://pypi.org/project/audio-separator/0.47.0/>         | Review                                                        |
|   3 | `audioop-lts==0.2.2`              | <https://pypi.org/project/audioop-lts/0.2.2/>              | Review                                                        |
|   4 | `audioread==3.1.0`                | <https://pypi.org/project/audioread/3.1.0/>                | Review                                                        |
|   5 | `beartype==0.18.5`                | <https://pypi.org/project/beartype/0.18.5/>                | Review                                                        |
|   6 | `certifi==2026.7.22`              | <https://pypi.org/project/certifi/2026.7.22/>              | Review                                                        |
|   7 | `cffi==2.1.1`                     | <https://pypi.org/project/cffi/2.1.1/>                     | Review                                                        |
|   8 | `charset-normalizer==3.5.1`       | <https://pypi.org/project/charset-normalizer/3.5.1/>       | Review                                                        |
|   9 | `cloudpickle==3.1.2`              | <https://pypi.org/project/cloudpickle/3.1.2/>              | Review                                                        |
|  10 | `Cython==3.3.0`                   | <https://pypi.org/project/Cython/3.3.0/>                   | Review                                                        |
|  11 | `decorator==5.3.1`                | <https://pypi.org/project/decorator/5.3.1/>                | Review                                                        |
|  12 | `diffq==0.2.4`                    | <https://pypi.org/project/diffq/0.2.4/>                    | Review                                                        |
|  13 | `einops==0.8.2`                   | <https://pypi.org/project/einops/0.8.2/>                   | Review                                                        |
|  14 | `filelock==4.0.0`                 | <https://pypi.org/project/filelock/4.0.0/>                 | Review                                                        |
|  15 | `flatbuffers==25.12.19`           | <https://pypi.org/project/flatbuffers/25.12.19/>           | Review                                                        |
|  16 | `fsspec==2026.7.0`                | <https://pypi.org/project/fsspec/2026.7.0/>                | Review                                                        |
|  17 | `idna==3.19`                      | <https://pypi.org/project/idna/3.19/>                      | Review                                                        |
|  18 | `Jinja2==3.1.6`                   | <https://pypi.org/project/Jinja2/3.1.6/>                   | Review                                                        |
|  19 | `joblib==1.6.0`                   | <https://pypi.org/project/joblib/1.6.0/>                   | Review                                                        |
|  20 | `julius==0.2.8`                   | <https://pypi.org/project/julius/0.2.8/>                   | Review                                                        |
|  21 | `lazy-loader==0.5`                | <https://pypi.org/project/lazy-loader/0.5/>                | Review                                                        |
|  22 | `librosa==1.0.0`                  | <https://pypi.org/project/librosa/1.0.0/>                  | Review                                                        |
|  23 | `llvmlite==0.49.0`                | <https://pypi.org/project/llvmlite/0.49.0/>                | Review                                                        |
|  24 | `MarkupSafe==3.0.3`               | <https://pypi.org/project/MarkupSafe/3.0.3/>               | Review                                                        |
|  25 | `ml_collections==1.1.0`           | <https://pypi.org/project/ml_collections/1.1.0/>           | Review                                                        |
|  26 | `ml_dtypes==0.6.0`                | <https://pypi.org/project/ml_dtypes/0.6.0/>                | Review                                                        |
|  27 | `mpmath==1.3.0`                   | <https://pypi.org/project/mpmath/1.3.0/>                   | Review                                                        |
|  28 | `msgpack==1.2.2`                  | <https://pypi.org/project/msgpack/1.2.2/>                  | Review                                                        |
|  29 | `narwhals==2.26.0`                | <https://pypi.org/project/narwhals/2.26.0/>                | Review                                                        |
|  30 | `networkx==3.6.1`                 | <https://pypi.org/project/networkx/3.6.1/>                 | Review                                                        |
|  31 | `numba==0.67.0`                   | <https://pypi.org/project/numba/0.67.0/>                   | Review                                                        |
|  32 | `numpy==2.5.3`                    | <https://pypi.org/project/numpy/2.5.3/>                    | Review; inspect bundled native notices                        |
|  33 | `onnx-weekly==1.24.0.dev20260914` | <https://pypi.org/project/onnx-weekly/1.24.0.dev20260914/> | Review                                                        |
|  34 | `onnx2torch-py313==1.6.0`         | <https://pypi.org/project/onnx2torch-py313/1.6.0/>         | Review                                                        |
|  35 | `onnxruntime==1.30.0`             | <https://pypi.org/project/onnxruntime/1.30.0/>             | Review; inspect bundled native notices                        |
|  36 | `packaging==26.3`                 | <https://pypi.org/project/packaging/26.3/>                 | Review                                                        |
|  37 | `pillow==12.3.0`                  | <https://pypi.org/project/pillow/12.3.0/>                  | Review; inspect bundled codec notices                         |
|  38 | `pip==26.2.1`                     | <https://pypi.org/project/pip/26.2.1/>                     | Review                                                        |
|  39 | `platformdirs==4.11.9`            | <https://pypi.org/project/platformdirs/4.11.9/>            | Review                                                        |
|  40 | `pooch==1.9.0`                    | <https://pypi.org/project/pooch/1.9.0/>                    | Review                                                        |
|  41 | `protobuf==7.36.1`                | <https://pypi.org/project/protobuf/7.36.1/>                | Review                                                        |
|  42 | `pycparser==3.0`                  | <https://pypi.org/project/pycparser/3.0/>                  | Review                                                        |
|  43 | `pydub==0.25.1`                   | <https://pypi.org/project/pydub/0.25.1/>                   | Review                                                        |
|  44 | `PyYAML==6.0.3`                   | <https://pypi.org/project/PyYAML/6.0.3/>                   | Review                                                        |
|  45 | `requests==2.34.2`                | <https://pypi.org/project/requests/2.34.2/>                | Review                                                        |
|  46 | `resampy==0.4.3`                  | <https://pypi.org/project/resampy/0.4.3/>                  | Review                                                        |
|  47 | `rotary-embedding-torch==0.6.5`   | <https://pypi.org/project/rotary-embedding-torch/0.6.5/>   | Review                                                        |
|  48 | `samplerate==0.1.0`               | <https://pypi.org/project/samplerate/0.1.0/>               | Review; inspect bundled native notices                        |
|  49 | `scikit-learn==1.9.1`             | <https://pypi.org/project/scikit-learn/1.9.1/>             | Review; inspect bundled native notices                        |
|  50 | `scipy==1.18.1`                   | <https://pypi.org/project/scipy/1.18.1/>                   | Review; inspect bundled native notices                        |
|  51 | `setuptools==84.0.0`              | <https://pypi.org/project/setuptools/84.0.0/>              | Review                                                        |
|  52 | `six==1.17.0`                     | <https://pypi.org/project/six/1.17.0/>                     | Review                                                        |
|  53 | `soundfile==0.14.0`               | <https://pypi.org/project/soundfile/0.14.0/>               | Review; inspect libsndfile/CFFI behavior and notices          |
|  54 | `soxr==1.1.0`                     | <https://pypi.org/project/soxr/1.1.0/>                     | Review; LGPL-2.1-or-later metadata requires explicit approval |
|  55 | `standard-aifc==3.13.0`           | <https://pypi.org/project/standard-aifc/3.13.0/>           | Review                                                        |
|  56 | `standard-chunk==3.13.0`          | <https://pypi.org/project/standard-chunk/3.13.0/>          | Review                                                        |
|  57 | `standard-sunau==3.13.0`          | <https://pypi.org/project/standard-sunau/3.13.0/>          | Review                                                        |
|  58 | `sympy==1.14.0`                   | <https://pypi.org/project/sympy/1.14.0/>                   | Review                                                        |
|  59 | `threadpoolctl==3.7.0`            | <https://pypi.org/project/threadpoolctl/3.7.0/>            | Review                                                        |
|  60 | `torch==2.14.0`                   | <https://pypi.org/project/torch/2.14.0/>                   | Review; complex bundled third-party/native notices            |
|  61 | `torchvision==0.29.0`             | <https://pypi.org/project/torchvision/0.29.0/>             | Review; bundled third-party/native notices                    |
|  62 | `tqdm==4.70.1`                    | <https://pypi.org/project/tqdm/4.70.1/>                    | Review; metadata includes MPL-2.0 and MIT terms               |
|  63 | `typing_extensions==4.16.0`       | <https://pypi.org/project/typing_extensions/4.16.0/>       | Review                                                        |
|  64 | `urllib3==2.8.0`                  | <https://pypi.org/project/urllib3/2.8.0/>                  | Review                                                        |

## 4. Build-only tools and excluded downloads

Apple clang/Xcode Command Line Tools, `make`, `curl`, `gpg`, archive tools, and
the release builder's Node process are build-machine prerequisites. They are
not copied into the runtime archive and therefore are not customer downloads.
Their use still belongs in the build-environment record, but not in the shipped
software bill of materials.

No Homebrew package, `uv` executable, pip cache, compiler, Apple SDK, GitHub
checkout, or AWS credential may be copied accidentally into the release. The
runtime must not perform dependency resolution or contact PyPI/GitHub/model
sites after installation.

## 5. Approval and release gate

Before production upload:

1. Retain the model owners' commercial-use authorization records outside Git,
   register non-secret evidence/reference IDs, and enforce their
   direct-owner-link/no-mirroring condition in the catalog and CLI.
2. Approve the FFmpeg/LAME configuration and satisfy LGPL source, notice, and
   relinking obligations. The current static LAME linkage needs special review.
3. Freeze a macOS ARM64 wheelhouse with exact filenames, source URLs, hashes,
   and environment markers; do not release from the unhashed requirements file.
4. Generate an SBOM and a consolidated `THIRD_PARTY_NOTICES` tree from the
   actual release archive, including Python-standalone and native wheel content.
5. Compare the SBOM with this list. New, missing, differently versioned, or
   undeclared-license content fails the build.
6. Scan Mach-O dependencies and the entire archive so nothing was picked up
   from a developer machine accidentally.
7. Record reviewer, decision, date, conditions, and evidence for every row.
8. Publish the corresponding third-party notices and any required source/source
   offer beside the downloadable MusicMute release.

Only after these checks pass may the exact runtime, model, and fixture metadata
be registered in the production catalog. Runtime/fixture objects may be served
through presigned MusicMute S3 URLs; model bytes must be fetched only from the
approved owner-hosted URLs and must never enter MusicMute S3.
