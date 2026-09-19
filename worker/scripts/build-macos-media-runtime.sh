#!/bin/sh

set -eu
umask 022

ffmpeg_version="8.0.3"
ffmpeg_sha256="6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818"
ffmpeg_signing_fingerprint="FCF986EA15E6E293A5644F10B4322F04D67658D8"
lame_version="3.100"
lame_sha256="ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"

fail() {
  printf 'MusicMute media runtime build: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "expected one absolute output directory"
case "$1" in
  /*) ;;
  *) fail "output directory must be absolute" ;;
esac

output_parent=$(dirname "$1")
output_name=$(basename "$1")
[ -d "$output_parent" ] || fail "output parent does not exist"
output_parent=$(cd "$output_parent" && pwd -P)
case "$output_name" in
  "" | "." | "..") fail "output directory is unsafe" ;;
esac
output_root="$output_parent/$output_name"
[ ! -e "$output_root" ] || fail "output directory already exists"

[ "$(uname -s)" = "Darwin" ] || fail "Darwin is required"
[ "$(uname -m)" = "arm64" ] || fail "native ARM64 is required"

for tool in curl gpg shasum tar make clang lipo otool node; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done

temporary_parent=${TMPDIR:-/tmp}
case "$temporary_parent" in
  /*) ;;
  *) fail "TMPDIR must be absolute" ;;
esac
build_root=$(mktemp -d "${temporary_parent%/}/musicmute-media-build.XXXXXX")
stage_root="$output_parent/.$output_name.building.$$"

cleanup() {
  rm -rf "$build_root" "$stage_root"
}
trap cleanup EXIT HUP INT TERM

jobs=${MUSICMUTE_BUILD_JOBS:-$(sysctl -n hw.logicalcpu 2>/dev/null || printf '4')}
case "$jobs" in
  "" | *[!0-9]*) fail "MUSICMUTE_BUILD_JOBS must be an integer" ;;
esac
[ "$jobs" -ge 1 ] || fail "MUSICMUTE_BUILD_JOBS must be positive"
[ "$jobs" -le 16 ] || jobs=16

download() {
  curl --fail --location --silent --show-error \
    --proto '=https' --tlsv1.2 \
    --output "$2" "$1"
}

verify_sha256() {
  actual=$(shasum -a 256 "$2" | awk '{print $1}')
  [ "$actual" = "$1" ] || fail "source checksum mismatch"
}

ffmpeg_archive="$build_root/ffmpeg-$ffmpeg_version.tar.xz"
ffmpeg_signature="$ffmpeg_archive.asc"
ffmpeg_key="$build_root/ffmpeg-devel.asc"
lame_archive="$build_root/lame-$lame_version.tar.gz"

download "https://ffmpeg.org/releases/ffmpeg-$ffmpeg_version.tar.xz" "$ffmpeg_archive"
download "https://ffmpeg.org/releases/ffmpeg-$ffmpeg_version.tar.xz.asc" "$ffmpeg_signature"
download "https://ffmpeg.org/ffmpeg-devel.asc" "$ffmpeg_key"
download "https://downloads.sourceforge.net/project/lame/lame/$lame_version/lame-$lame_version.tar.gz" "$lame_archive"
verify_sha256 "$ffmpeg_sha256" "$ffmpeg_archive"
verify_sha256 "$lame_sha256" "$lame_archive"

gpg_home="$build_root/gnupg"
mkdir -m 0700 "$gpg_home"
gpg --homedir "$gpg_home" --batch --no-autostart --quiet --import "$ffmpeg_key"
actual_fingerprint=$(gpg --homedir "$gpg_home" --batch --no-autostart --with-colons --fingerprint | awk -F: '$1 == "fpr" { print $10; exit }')
[ "$actual_fingerprint" = "$ffmpeg_signing_fingerprint" ] || fail "FFmpeg signing key fingerprint mismatch"
valid_signature=$(gpg --homedir "$gpg_home" --batch --no-autostart --status-fd 1 --verify "$ffmpeg_signature" "$ffmpeg_archive" 2>/dev/null | awk '$2 == "VALIDSIG" { print $3; exit }')
[ "$valid_signature" = "$ffmpeg_signing_fingerprint" ] || fail "FFmpeg source signature is invalid"

tar -xf "$lame_archive" -C "$build_root"
tar -xf "$ffmpeg_archive" -C "$build_root"
mkdir "$build_root/lame-build" "$build_root/ffmpeg-build" "$build_root/prefix"

(
  cd "$build_root/lame-build"
  "$build_root/lame-$lame_version/configure" \
    --prefix="$build_root/prefix" \
    --disable-shared \
    --enable-static \
    --disable-frontend \
    --disable-decoder \
    CFLAGS='-O2 -arch arm64 -mmacosx-version-min=13.0' \
    LDFLAGS='-arch arm64 -mmacosx-version-min=13.0'
  make -j"$jobs"
  make install
)

(
  cd "$build_root/ffmpeg-build"
  "$build_root/ffmpeg-$ffmpeg_version/configure" \
    --prefix="$build_root/prefix" \
    --cc=/usr/bin/clang \
    --arch=arm64 \
    --target-os=darwin \
    --disable-shared \
    --enable-static \
    --disable-debug \
    --disable-doc \
    --disable-ffplay \
    --disable-autodetect \
    --disable-network \
    --enable-libmp3lame \
    --extra-cflags="-O2 -arch arm64 -mmacosx-version-min=13.0 -I$build_root/prefix/include" \
    --extra-ldflags="-arch arm64 -mmacosx-version-min=13.0 -L$build_root/prefix/lib"
  make -j"$jobs"
)

mkdir -p \
  "$stage_root/bin" \
  "$stage_root/licenses/ffmpeg" \
  "$stage_root/licenses/lame"
install -m 0755 "$build_root/ffmpeg-build/ffmpeg" "$stage_root/bin/ffmpeg"
install -m 0755 "$build_root/ffmpeg-build/ffprobe" "$stage_root/bin/ffprobe"
install -m 0644 "$build_root/ffmpeg-$ffmpeg_version/COPYING.LGPLv2.1" "$stage_root/licenses/ffmpeg/COPYING.LGPLv2.1"
install -m 0644 "$build_root/lame-$lame_version/COPYING" "$stage_root/licenses/lame/COPYING"

for binary in "$stage_root/bin/ffmpeg" "$stage_root/bin/ffprobe"; do
  [ "$(lipo -archs "$binary")" = "arm64" ] || fail "media executable is not ARM64-only"
  unsupported=$(otool -L "$binary" | awk 'NR > 1 { print $1 }' | awk '$0 !~ "^/usr/lib/" && $0 !~ "^/System/Library/" { print; exit }')
  [ -z "$unsupported" ] || fail "media executable has a non-system dependency"
done

"$stage_root/bin/ffmpeg" -hide_banner -encoders >"$build_root/encoders.txt" 2>&1
"$stage_root/bin/ffmpeg" -hide_banner -filters >"$build_root/filters.txt" 2>&1
"$stage_root/bin/ffmpeg" -hide_banner -protocols >"$build_root/protocols.txt" 2>&1
grep -Eq '^[[:space:]]*A.*[[:space:]]libmp3lame[[:space:]]' "$build_root/encoders.txt" || fail "libmp3lame encoder is unavailable"
grep -Eq '^[[:space:]]*[.A-Z]+[[:space:]]+afftdn[[:space:]]' "$build_root/filters.txt" || fail "afftdn filter is unavailable"
grep -Eq '^[[:space:]]*[.A-Z]+[[:space:]]+silenceremove[[:space:]]' "$build_root/filters.txt" || fail "silenceremove filter is unavailable"
grep -Eq '^[[:space:]]+file$' "$build_root/protocols.txt" || fail "file protocol is unavailable"
for protocol in http https rtmp rtmps rtsp srt tcp tls udp; do
  if grep -Eq "^[[:space:]]+$protocol$" "$build_root/protocols.txt"; then
    fail "network protocol is unexpectedly enabled"
  fi
done

manifest_root="$stage_root" \
ffmpeg_version="$ffmpeg_version" \
ffmpeg_sha256="$ffmpeg_sha256" \
ffmpeg_signing_fingerprint="$ffmpeg_signing_fingerprint" \
lame_version="$lame_version" \
lame_sha256="$lame_sha256" \
node --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.manifest_root;
if (!root) throw new Error("manifest root is missing");
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const manifest = {
  schemaVersion: 1,
  platform: "darwin",
  architecture: "arm64",
  minimumMacosVersion: "13.0",
  ffmpeg: {
    version: process.env.ffmpeg_version,
    sourceUrl: `https://ffmpeg.org/releases/ffmpeg-${process.env.ffmpeg_version}.tar.xz`,
    sourceSha256: process.env.ffmpeg_sha256,
    sourceSignatureFingerprint: process.env.ffmpeg_signing_fingerprint,
    binarySha256: digest(join(root, "bin", "ffmpeg")),
    license: "LGPL-2.1-or-later",
  },
  ffprobe: {
    version: process.env.ffmpeg_version,
    binarySha256: digest(join(root, "bin", "ffprobe")),
  },
  lame: {
    version: process.env.lame_version,
    sourceUrl: `https://downloads.sourceforge.net/project/lame/lame/${process.env.lame_version}/lame-${process.env.lame_version}.tar.gz`,
    sourceSha256: process.env.lame_sha256,
    license: "LGPL-2.0-or-later",
  },
  build: {
    networkProtocols: false,
    sharedLibraries: false,
    mp3Encoder: "libmp3lame",
  },
};
writeFileSync(
  join(root, "SOURCE-MANIFEST.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { encoding: "utf8", mode: 0o644, flag: "wx" },
);
NODE

mv "$stage_root" "$output_root"
printf 'MusicMute media runtime: %s\n' "$output_root"
