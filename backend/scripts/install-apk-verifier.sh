#!/bin/sh
set -eu

fail() {
  printf 'APK verifier installer: %s\n' "$1" >&2
  exit 1
}

build_tools_version="${ANDROID_BUILD_TOOLS_VERSION:-35.0.0}"
build_tools_sha256="${ANDROID_BUILD_TOOLS_SHA256:-bd3a4966912eb8b30ed0d00b0cda6b6543b949d5ffe00bea54c04c81e1561d88}"
build_tools_url="${ANDROID_BUILD_TOOLS_URL:-https://dl.google.com/android/repository/build-tools_r35_linux.zip}"
sdk_root="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
build_arch="${ANDROID_BUILD_ARCH:-$(dpkg --print-architecture 2>/dev/null || uname -m)}"

case "$build_arch" in
  amd64 | x86_64) ;;
  *) fail "official Android Build Tools require an amd64 build host, got ${build_arch}" ;;
esac

case "$sdk_root" in
  /*) ;;
  *) fail "ANDROID_SDK_ROOT must be an absolute path" ;;
esac
[ "$sdk_root" != / ] || fail "refusing to install into /"
[ "${#build_tools_sha256}" -eq 64 ] || fail "invalid Build Tools checksum"
case "$build_tools_sha256" in
  *[!0-9a-f]*) fail "invalid Build Tools checksum" ;;
esac
case "$build_tools_version" in
  '' | *[!0-9.]* | .* | *. | *..*) fail "invalid Build Tools version" ;;
esac

working_directory="$(mktemp -d)"
trap 'rm -rf "$working_directory"' EXIT HUP INT TERM
archive="$working_directory/build-tools.zip"
unpacked="$working_directory/unpacked"

curl --fail --location --silent --show-error \
  --retry 3 --connect-timeout 20 --max-time 300 \
  "$build_tools_url" --output "$archive"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "$archive" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
else
  fail "sha256sum or shasum is required"
fi
[ "$actual_sha256" = "$build_tools_sha256" ] || fail "Build Tools checksum mismatch"

mkdir -p "$unpacked"
unzip -q "$archive" -d "$unpacked"
set -- "$unpacked"/*
[ "$#" -eq 1 ] && [ -d "$1" ] || fail "Build Tools archive must contain one root directory"
build_tools_source="$1"
aapt2="$build_tools_source/aapt2"
apksigner="$build_tools_source/apksigner"
[ -x "$aapt2" ] || fail "Build Tools archive is missing aapt2"
[ -x "$apksigner" ] || fail "Build Tools archive is missing apksigner"
"$aapt2" version >/dev/null
"$apksigner" version >/dev/null

target="$sdk_root/build-tools/$build_tools_version"
rm -rf "$target"
mkdir -p "$sdk_root/build-tools"
mv "$build_tools_source" "$target"
chmod -R a+rX "$target"
printf 'APK verifier installed: Android Build Tools %s\n' "$build_tools_version"
