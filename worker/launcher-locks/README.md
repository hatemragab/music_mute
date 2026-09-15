# Private launcher dependencies

These locks are separate from every GPU recipe/environment. Python 3.12 is the
launcher ABI. Each JSON lock identifies exactly six wheel files by filename,
HTTPS URL, bytes and SHA-256; each matching requirements file installs only those
assets with required hashes. No source distributions or broad resolver hash lists
are permitted. TUF 7.0.1 uses securesystemslib's crypto extra with cryptography,
cffi and pycparser; urllib3 is its maintained HTTP dependency.

Use a private launcher environment provided by I01/H01, then install its platform
lock with `uv pip install --python <private-python> --require-hashes --only-binary
:all: -r <platform>-py312.txt`. Do not install these into system Python or the
separation environment. H01 must authenticate the lock as part of the signed
release/bootstrap delivery and bundle/provision its initial trusted TUF root.

macOS arm64 has an isolated installation and actual Ed25519/TUF test execution.
Windows x64 and Linux x64 wheel downloads/hashes were verified; those platforms
have dependency solve evidence, not launcher/native GPU/boot execution proof.
Other platforms are explicitly unavailable until exact locks and native evidence
are added. No production trust root or signing key is stored here.
