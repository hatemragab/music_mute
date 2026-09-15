#!/bin/sh
# Release packaging renders this source template; it is not a published installer.
set -eu
umask 077
BOOTSTRAP_CONFIGURED=0
# @@RECIPE@@

fail() { printf '%s\n' "MusicMute setup stopped: $1" >&2; exit 1; }
[ "$BOOTSTRAP_CONFIGURED" = 1 ] || fail BOOTSTRAP_NOT_CONFIGURED
[ "$#" -le 1 ] || fail INVALID_SETUP_ACTION
case "${1:-install}" in install|repair|pause|status|uninstall|pairing-retry) ;; *) fail INVALID_SETUP_ACTION ;; esac
[ "$(id -u)" = 0 ] || fail ADMINISTRATOR_REQUIRED
case "$(uname -s)" in
    Darwin) OS=macos; BASE='/Library/Application Support/MusicMute'; HASH='shasum -a 256' ;;
    Linux) OS=linux; BASE=/var/lib/musicmute; HASH=sha256sum ;;
    *) fail UNSUPPORTED_PLATFORM ;;
esac
case "$(uname -m)" in
    arm64|aarch64) ARCH=arm64 ;;
    x86_64) ARCH=x64 ;;
    *) fail UNSUPPORTED_PLATFORM ;;
esac
if [ "$OS" = macos ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || :)" = 1 ]; then ARCH=arm64; fi
select_bundle
for tool in curl od tr sed awk tar gzip; do command -v "$tool" >/dev/null || fail BOOTSTRAP_TOOL_MISSING; done
digest() { $HASH | awk '{print $1}'; }
random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
uuid() { random_hex | sed -E 's/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/\1-\2-4\3-a\4-\5/'; }
# Refuse symbolic links in every existing path component before privileged writes.
secure_dir() {
    target=$1
    cursor=$target
    while [ "$cursor" != / ]; do
        [ ! -L "$cursor" ] || fail UNSAFE_STATE_PATH
        cursor=$(dirname "$cursor")
    done
    if [ -e "$target" ]; then
        [ -d "$target" ] || fail UNSAFE_STATE_PATH
        case "$OS" in
            macos) owner=$(stat -f %u "$target"); mode=$(stat -f %Lp "$target") ;;
            linux) owner=$(stat -c %u "$target"); mode=$(stat -c %a "$target") ;;
        esac
        [ "$owner" = 0 ] && [ "$mode" = 700 ] || fail UNSAFE_STATE_PERMISSIONS
    else
        mkdir -m 700 "$target" || fail STATE_CREATE_FAILED
    fi
}
secure_dir "$BASE"
for name in identity config state releases models journals events; do secure_dir "$BASE/$name"; done
secure_dir "$BASE/events/bootstrap"
secure_dir "$BASE/state/setup"
# Durable server backoff. A one-shot entrypoint still has to remember a
# Retry-After across manual reruns, otherwise an operator retry loop hammers a
# throttled endpoint and the follow-on error report has no deadline at all.
RETRY="$BASE/state/setup/retry-after.json"
RETRY_DEFAULT=900
RETRY_DEADLINE=''
# Validate once at top level: `fail` inside a command substitution only ends the
# subshell, so a corrupt record must never be discovered from inside `request`.
read_retry() {
    [ -e "$RETRY" ] || return 0
    [ -f "$RETRY" ] && [ ! -L "$RETRY" ] || fail UNSAFE_STATE_PATH
    [ "$(wc -c < "$RETRY")" -le 4096 ] || fail UNSAFE_STATE_PATH
    RETRY_DEADLINE=$(sed -n 's/.*"deadlineEpoch":[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$RETRY")
    [ -n "$RETRY_DEADLINE" ] || fail UNSAFE_STATE_PATH
}
retry_blocked() {
    [ -n "$RETRY_DEADLINE" ] && [ "$(date +%s)" -lt "$RETRY_DEADLINE" ]
}
persist_retry() {
    code=$1
    delay=$(tr -d '\r' < "$LOCK/headers" 2>/dev/null \
        | sed -n 's/^[Rr]etry-[Aa]fter:[[:space:]]*\([0-9]\{1,\}\)[[:space:]]*$/\1/p' \
        | tail -n 1)
    case "$delay" in ''|*[!0-9]*) delay=$RETRY_DEFAULT ;; esac
    # An HTTP-date header is not reinterpreted here; the bounded default keeps
    # the deadline durable instead of guessing a wall-clock conversion.
    [ "$delay" -ge 1 ] && [ "$delay" -le 86400 ] || delay=$RETRY_DEFAULT
    RETRY_DEADLINE=$(( $(date +%s) + delay ))
    printf '{"deadlineEpoch":%s,"code":"%s","schemaVersion":3}' \
        "$RETRY_DEADLINE" "$code" > "$LOCK/retry"
    mv "$LOCK/retry" "$RETRY"
    sync
}
clear_retry() { RETRY_DEADLINE=''; rm -f "$RETRY"; }
read_retry
# The native importer uses BSD flock on this same retained inode. Kernel locks
# release after process interruption; a leftover filename is not a held lock.
LOCKFILE="$BASE/state/bootstrap.lock"
[ ! -L "$LOCKFILE" ] || fail UNSAFE_STATE_PATH
exec 9>>"$LOCKFILE"
case "$OS" in
    macos) /usr/bin/lockf -s -t 0 9 || fail BOOTSTRAP_BUSY ;;
    linux) command -v flock >/dev/null || fail BOOTSTRAP_TOOL_MISSING
           flock -n 9 || fail BOOTSTRAP_BUSY ;;
esac
LOCK=$(mktemp -d "$BASE/state/.bootstrap.XXXXXXXX")
cleanup() { rm -rf "$LOCK"; exec 9>&-; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
case "$OS" in
    macos) MACHINE=$(ioreg -rd1 -c IOPlatformExpertDevice | sed -n 's/.*"IOPlatformUUID" = "\([A-Fa-f0-9-]*\)"/\1/p' | tr A-F a-f) ;;
    linux) MACHINE=$(tr A-F a-f < /etc/machine-id) ;;
esac
printf '%s' "$MACHINE" | grep -Eq '^[a-f0-9-]{32,36}$' || fail MACHINE_ID_UNAVAILABLE
BINDING=$(printf 'musicmute-worker-machine-v1\n%s\n%s\n' "$OS" "$MACHINE" | digest)
IDENTITY="$BASE/identity/setup-identity.json"
if [ -e "$IDENTITY" ] || [ -L "$IDENTITY" ]; then
    [ ! -L "$IDENTITY" ] && [ -f "$IDENTITY" ] || fail UNSAFE_IDENTITY
    [ "$(wc -c < "$IDENTITY")" -le 8192 ] || fail INVALID_IDENTITY
    # Only canonical JSON emitted by this protocol is accepted before Python.
    TOKEN=$(sed -n 's/.*"installationToken":"\([a-f0-9]*\)".*/\1/p' "$IDENTITY")
    ID=$(sed -n 's/.*"installationId":"\([a-f0-9-]*\)".*/\1/p' "$IDENTITY")
else
    for record in "$BASE/state/setup/setup.json" "$BASE/identity/installation.json" "$BASE/config/setup-host.json"; do
        [ ! -e "$record" ] && [ ! -L "$record" ] || fail MISSING_IDENTITY
    done
    TOKEN=$(random_hex); ID=$(uuid)
fi
printf '%s' "$TOKEN" | grep -Eq '^[a-f0-9]{64}$' || fail INVALID_IDENTITY
printf '%s' "$ID" | grep -Eq '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' || fail INVALID_IDENTITY
EXPECTED=$(printf '{"apiBaseUrl":"%s","installationId":"%s","installationToken":"%s","machineBindingSha256":"%s","schemaVersion":3}' "$API" "$ID" "$TOKEN" "$BINDING")
if [ -e "$IDENTITY" ]; then
    [ "$(cat "$IDENTITY")" = "$EXPECTED" ] || fail IDENTITY_BINDING_MISMATCH
else
    printf '%s' "$EXPECTED" > "$LOCK/identity"
    mv "$LOCK/identity" "$IDENTITY"
    sync # Before public registration; never regenerate on a lost response.
fi
STAGE="$BASE/releases/bootstrap-$BUNDLE_SHA"
verify_cached_bundle() {
    [ ! -L "$STAGE" ] && [ -d "$STAGE" ] || fail UNSAFE_STATE_PATH
    [ -f "$STAGE/.bootstrap-sha256" ] && [ ! -L "$STAGE/.bootstrap-sha256" ] || fail BOOTSTRAP_CACHE_INVALID
    [ -z "$(find "$STAGE" -type l -print)" ] || fail UNSAFE_STATE_PATH
    (cd "$STAGE" && $HASH -c .bootstrap-sha256 >/dev/null 2>&1) || fail BOOTSTRAP_CACHE_INVALID
    expected_files=$(wc -l < "$STAGE/.bootstrap-sha256")
    actual_files=$(find "$STAGE" -type f ! -name .bootstrap-sha256 | wc -l)
    [ "$expected_files" -eq "$actual_files" ] || fail BOOTSTRAP_CACHE_INVALID
    [ -x "$STAGE/$PYTHON_REL" ] || fail PYTHON_MISSING
}
# Once Python is installed, shared setup owns session renewal and permanent auth.
# Status/repair must never depend on the short-lived public setup capability.
if [ -e "$BASE/config/setup-host.json" ] || [ -L "$BASE/config/setup-host.json" ]; then
    [ ! -L "$BASE/config/setup-host.json" ] && [ -f "$BASE/config/setup-host.json" ] || fail UNSAFE_STATE_PATH
    [ "$(wc -c < "$BASE/config/setup-host.json")" -le 16384 ] || fail BOOTSTRAP_CACHE_INVALID
    cached_launcher=$(sed -n 's/.*"launcherPath":"\([^"]*\)".*/\1/p' "$BASE/config/setup-host.json")
    case "$cached_launcher" in "$BASE"/releases/bootstrap-*/python/bin/python3) ;; *) fail BOOTSTRAP_CACHE_INVALID ;; esac
    STAGE=${cached_launcher%/python/bin/python3}
    [ "$(dirname "$STAGE")" = "$BASE/releases" ] || fail BOOTSTRAP_CACHE_INVALID
    basename "$STAGE" | grep -Eq '^bootstrap-[a-f0-9]{64}$' || fail BOOTSTRAP_CACHE_INVALID
    verify_cached_bundle
    cleanup
    trap - EXIT
    exec "$STAGE/$PYTHON_REL" -I -B -m musicmute_worker.setup_host --action "${1:-install}" --config "$BASE/config/setup-host.json"
fi
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$LOCK/auth"
request() {
    endpoint=$1; body=$2; authenticated=$3
    # Clear before the deadline check so a blocked call cannot leave stale
    # headers behind and re-persist an already-recorded throttle.
    : > "$LOCK/headers"
    # A durable server deadline outranks a manual rerun: no request is sent at all.
    retry_blocked && return 1
    if [ "$authenticated" = yes ]; then set -- --config "$LOCK/auth"; else set --; fi
    if [ -n "$body" ]; then set -- "$@" --header 'Content-Type: application/json' --data-binary "@$body"; fi
    # Credentials stay in a protected file. Disable user curlrc, redirects and proxies.
    curl -q "$@" --proto '=https' --noproxy '*' --connect-timeout 10 --max-time 30 \
        --max-filesize 65536 --silent --dump-header "$LOCK/headers" \
        --output "$LOCK/response" --write-out '%{http_code}' \
        "$API$endpoint" 2>/dev/null
}
report() {
    stage=$1; status=$2; code=$3
    count=$(find "$BASE/events/bootstrap" -type f | wc -l)
    [ "$count" -lt 128 ] || return 1
    eid=$(uuid)
    stamp=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
    delivery=queued
    http=$(request "/worker-installations/$ID" '' yes) || http=000
    if [ "$http" != 200 ] && grep -qi '^[Rr]etry-[Aa]fter:' "$LOCK/headers" 2>/dev/null; then
        # The event report is itself throttled; remember it before retrying.
        persist_retry REPORTING_UNAVAILABLE || :
    fi
    if [ "$http" = 200 ]; then
        server=$(sed -n 's/.*"serverTime":"\([0-9T:Z.-]*\)".*/\1/p' "$LOCK/response")
        if printf '%s' "$server" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'; then
            stamp=$server; delivery=uncertain
        fi
    fi
    extra=''
    [ -z "$code" ] || extra=$(printf ',"code":"%s"' "$code")
    printf '{"eventId":"%s","operationId":"%s","sequence":1,"category":"installation","stage":"%s","status":"%s","occurredAt":"%s"%s}' "$eid" "$eid" "$stage" "$status" "$stamp" "$extra" > "$LOCK/event"
    printf '{"schemaVersion":3,"installationId":"%s","event":%s,"delivery":"%s"}' "$ID" "$(cat "$LOCK/event")" "$delivery" > "$LOCK/envelope"
    mv "$LOCK/envelope" "$BASE/events/bootstrap/$eid.json"
    sync # Persist uncertain bytes before first transmission; importer owns deletion.
    if [ "$delivery" = uncertain ]; then
        printf '{"events":[%s]}' "$(cat "$LOCK/event")" > "$LOCK/batch"
        request "/worker-installations/$ID/events" "$LOCK/batch" yes >/dev/null || :
    fi
}
TOKEN_SHA=$(printf '%s' "$TOKEN" | digest)
printf '{"installationId":"%s","tokenSha256":"%s","installerBuild":%s,"os":"%s","arch":"%s"}' "$ID" "$TOKEN_SHA" "$INSTALLER_BUILD" "$OS" "$ARCH" > "$LOCK/register"
HTTP=$(request /worker-installations "$LOCK/register" no) || HTTP=000
case "$HTTP" in
    200|201) clear_retry ;;
    *)
        # Persist throttling before reporting: a 429 must not be retried by hand
        # until its deadline, and the failure report obeys the same deadline.
        if grep -qi '^[Rr]etry-[Aa]fter:' "$LOCK/headers" 2>/dev/null; then
            persist_retry REPORTING_UNAVAILABLE || :
        fi
        report bootstrap failed REPORTING_UNAVAILABLE || :
        fail REPORTING_UNAVAILABLE
        ;;
esac
bootstrap_error() {
    case "$1" in
        ARTIFACT_SIZE_MISMATCH|ARTIFACT_HASH_MISMATCH|TRUST_ROOT_INVALID) safe_code=CHECKSUM_MISMATCH ;;
        DOWNLOAD_FAILED) safe_code=DOWNLOAD_FAILED ;;
        INSUFFICIENT_DISK) safe_code=INSUFFICIENT_DISK ;;
        *) safe_code=INSTALLATION_FAILED ;;
    esac
    report download failed "$safe_code" || :
    fail "$1"
}
if [ ! -e "$STAGE" ]; then
    available_kb=$(df -Pk "$BASE" | awk 'END {print $4}')
    [ "$available_kb" -ge $(((BUNDLE_BYTES + EXPANDED_BYTES * 2 + 1023) / 1024)) ] || bootstrap_error INSUFFICIENT_DISK
    secure_dir "$LOCK/bundle"
    curl -q --proto '=https' --noproxy '*' --connect-timeout 10 --max-time 600 \
        --max-filesize "$BUNDLE_BYTES" --fail --silent --output "$LOCK/archive.gz" "$BUNDLE_URL" 2>/dev/null || bootstrap_error DOWNLOAD_FAILED
    [ "$(wc -c < "$LOCK/archive.gz")" -eq "$BUNDLE_BYTES" ] || bootstrap_error ARTIFACT_SIZE_MISMATCH
    [ "$(digest < "$LOCK/archive.gz")" = "$BUNDLE_SHA" ] || bootstrap_error ARTIFACT_HASH_MISMATCH
    # Bound the decompressed tar before extraction, including headers and padding.
    (ulimit -f $(((EXPANDED_BYTES + 511) / 512)); gzip -dc "$LOCK/archive.gz" > "$LOCK/archive.tar") 2>/dev/null || bootstrap_error ARTIFACT_INVALID
    [ "$(wc -c < "$LOCK/archive.tar")" -eq "$EXPANDED_BYTES" ] || bootstrap_error ARTIFACT_SIZE_MISMATCH
    tar -tf "$LOCK/archive.tar" > "$LOCK/names" 2>/dev/null || bootstrap_error ARTIFACT_INVALID
    awk 'BEGIN { bad=0 } !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/?$/ || /(^|\/)\.\.?($|\/)/ {bad=1} {name=tolower($0); sub(/\/$/, "", name); if (seen[name]++) bad=1} END {exit bad}' "$LOCK/names" || bootstrap_error ARTIFACT_UNSAFE_PATH
    tar -tvf "$LOCK/archive.tar" > "$LOCK/types" 2>/dev/null || bootstrap_error ARTIFACT_INVALID
    LC_ALL=C grep -Eq '^[^-d]' "$LOCK/types" && bootstrap_error ARTIFACT_UNSAFE_PATH
    tar -xf "$LOCK/archive.tar" -C "$LOCK/bundle" 2>/dev/null || bootstrap_error ARTIFACT_INVALID
    [ -f "$LOCK/bundle/$PYTHON_REL" ] && [ -x "$LOCK/bundle/$PYTHON_REL" ] || bootstrap_error PYTHON_MISSING
    [ "$(digest < "$LOCK/bundle/$ROOT_REL")" = "$ROOT_SHA" ] || bootstrap_error TRUST_ROOT_INVALID
    (cd "$LOCK/bundle" && find . -type f -exec $HASH {} \;) > "$LOCK/inventory"
    mv "$LOCK/inventory" "$LOCK/bundle/.bootstrap-sha256"
    mv "$LOCK/bundle" "$STAGE"
    sync
fi
verify_cached_bundle
# I02–I04 consume these canonical protected paths; no login-dependent service here.
printf '{"schemaVersion":3,"apiBaseUrl":"%s","paths":{' "$API" > "$LOCK/config"
separator=''
for name in identity config state releases models journals events; do
    printf '%s"%s":"%s/%s"' "$separator" "$name" "$BASE" "$name" >> "$LOCK/config"; separator=,
done
printf '},"distributionOrigin":"%s","bootstrapRootPath":"%s/%s","launcherPath":"%s/%s","launcherBuild":%s,"installerBuild":%s}' "$ORIGIN" "$STAGE" "$ROOT_REL" "$STAGE" "$PYTHON_REL" "$LAUNCHER_BUILD" "$INSTALLER_BUILD" >> "$LOCK/config"
mv "$LOCK/config" "$BASE/config/setup-host.json"
report download succeeded '' || fail EVENT_SPOOL_FULL
cleanup
trap - EXIT
exec "$STAGE/$PYTHON_REL" -I -B -m musicmute_worker.setup_host --action "${1:-install}" --config "$BASE/config/setup-host.json"
