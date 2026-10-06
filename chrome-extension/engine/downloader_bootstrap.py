"""Verified, immutable wheel launcher; no extraction, pip, site or user imports."""

import sys

if not (
    sys.flags.isolated
    and sys.flags.ignore_environment
    and sys.flags.no_user_site
    and sys.flags.no_site
    and sys.dont_write_bytecode
):
    sys.stderr.write("DOWNLOADER_ISOLATION_REQUIRED\n")
    raise SystemExit(1)

import hashlib
from contextlib import contextmanager
import os
import re
import stat
import tempfile
from urllib.parse import parse_qsl, urlsplit


WHEELS = (
    ("bgutil_ytdlp_pot_provider-2.0.1-py3-none-any.whl", 12777, "ff6c2e85443e0777e2483e4a5ef2084ca745a1dd3cc07cf355ddd3a77bd882e8"),
    (
        "yt_dlp-2026.8.19-py3-none-any.whl",
        3_185_533,
        "1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf",
    ),
    (
        "yt_dlp_ejs-0.8.0-py3-none-any.whl",
        53_443,
        "79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4",
    ),
)
EJS_HASHES = {
    "yt.solver.core.min.js": "ee5b307d07f55e91e4723edf5ac205cc877a474187849d757dc1322e38427b157a9d706d510c1723d3670f98e5a3f8cbcde77874a80406bd7204bc9fea30f283",
    "yt.solver.lib.min.js": "8420c259ad16e99ce004e4651ac1bcabb53b4457bf5668a97a9359be9a998a789fee8ab124ee17f91a2ea8fd84e0f2b2fc8eabcaf0b16a186ba734cf422ad053",
}


class BootstrapError(Exception):
    """Only fixed codes cross this boundary; no exception paths or text."""


TRACK_ID = re.compile(r"[A-Za-z0-9_.-]{1,128}\Z")
SIGNATURE_KEY = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
MAX_TRACK_STREAMS = 4096
CLI_FLAGS = {
    "--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-warnings",
    "--no-cache-dir", "--no-remote-components", "--no-js-runtimes",
    "--no-cookies", "--no-cookies-from-browser",
    "--skip-download", "--dump-single-json", "--no-progress", "--quiet",
    "--version", "--help", "--list-extractors",
}
CLI_VALUES = {
    "--socket-timeout", "--retries", "--fragment-retries", "--extractor-retries",
    "--sleep-requests", "--sleep-interval", "--js-runtimes", "--ffmpeg-location",
    "--max-filesize", "--concurrent-fragments", "-f", "-o", "--print",
    "--load-info-json",
}


def validate_arguments(arguments):
    """No credential, config, alias, header or plugin override can reach yt-dlp."""
    if len(arguments) > 128 or any(
        not isinstance(value, str) or len(value) > 16 * 1024
        for value in arguments
    ):
        raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
    if not all(
        required in arguments for required in ("--ignore-config", "--no-plugin-dirs")
    ):
        raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
    index = 0
    while index < len(arguments):
        option = arguments[index]
        if option == "--":
            if len(arguments) != index + 2 or not re.fullmatch(
                r"https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}", arguments[index + 1]
            ):
                raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
            return
        if option in CLI_FLAGS:
            index += 1
            continue
        if option not in CLI_VALUES or index + 1 >= len(arguments):
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        value = arguments[index + 1]
        if not value or (
            value.startswith("-")
            and not (option == "--load-info-json" and value == "-")
        ):
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        # Metadata is projected by the native provider and passed through stdin;
        # the downloader must never load a user-supplied JSON/credential file.
        if option == "--load-info-json" and value != "-":
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        if option in {"--retries", "--fragment-retries", "--extractor-retries"} and value != "0":
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        if option == "--sleep-requests" and value != "1":
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        if option == "--sleep-interval" and value != "5":
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        if option == "--concurrent-fragments" and value != "1":
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        index += 2


@contextmanager
def isolated_downloader_environment():
    """A disposable guest HOME, with no inherited account/browser configuration."""
    previous = dict(os.environ)
    temporary_root = previous.get("TMPDIR")
    if not temporary_root or not os.path.isabs(temporary_root):
        raise BootstrapError("DOWNLOADER_ISOLATION_REQUIRED")
    information = os.lstat(temporary_root)
    if (
        not stat.S_ISDIR(information.st_mode)
        or information.st_uid != os.getuid()
        or information.st_mode & 0o077
    ):
        raise BootstrapError("DOWNLOADER_ISOLATION_REQUIRED")
    with tempfile.TemporaryDirectory(prefix="musicmute-guest-", dir=temporary_root) as home:
        environment = {
            name: previous[name]
            for name in ("PATH", "LANG", "LC_ALL", "MUSICMUTE_LOCAL_PARENT_PID", "DENO_DIR", "MUSICMUTE_UPDATE_LEASE_FD", "MUSICMUTE_LOCAL_ROOT", "MUSICMUTE_LOCAL_APP_RESOURCES")
            if name in previous
        }
        environment.update({
            "HOME": home,
            "TMPDIR": home,
            "XDG_CONFIG_HOME": os.path.join(home, "config"),
            "XDG_CACHE_HOME": os.path.join(home, "cache"),
            "XDG_DATA_HOME": os.path.join(home, "data"),
            "DENO_DIR": os.path.join(home, "deno"),
            "DENO_NO_PROMPT": "1",
            "DENO_NO_UPDATE_CHECK": "1",
            "TOKEN_TTL": "1",
        })
        os.mkdir(environment["XDG_CACHE_HOME"], 0o700)
        os.environ.clear()
        os.environ.update(environment)
        try:
            yield
        finally:
            os.environ.clear()
            os.environ.update(previous)


def transfer_key(value, signature_key=None):
    """Ignore only the n/pot/signature changes made by this exact upstream pin."""
    if not isinstance(value, str) or not 0 < len(value) <= 16 * 1024:
        return None
    try:
        url = urlsplit(value)
        if (
            url.scheme != "https"
            or url.username or url.password or url.port or url.fragment
            or not url.hostname
            or not (url.hostname == "googlevideo.com" or url.hostname.endswith(".googlevideo.com"))
        ):
            return None
        ignored = {"n", "pot"}
        if signature_key:
            ignored.add(signature_key)
        query = tuple(sorted(
            (key, item) for key, item in parse_qsl(url.query, keep_blank_values=True)
            if key not in ignored
        ))
        return url.netloc, url.path, query
    except (TypeError, ValueError):
        return None


def enrich_audio_tracks(formats, player_responses):
    """Bind optional raw track scalars to emitted transfers; no requests or guesses."""
    if not isinstance(player_responses, list) or len(player_responses) > 64:
        return
    groups = {}
    streams = 0
    for response in player_responses:
        data = response.get("streamingData") if isinstance(response, dict) else None
        if not isinstance(data, dict):
            continue
        for name in ("formats", "adaptiveFormats"):
            raw_formats = data.get(name) or []
            if not isinstance(raw_formats, list):
                return
            streams += len(raw_formats)
            if streams > MAX_TRACK_STREAMS:
                return
            for raw in raw_formats:
                if not isinstance(raw, dict):
                    continue
                url = raw.get("url")
                signature_key = None
                if not url:
                    cipher = raw.get("signatureCipher")
                    if not isinstance(cipher, str) or len(cipher) > 32 * 1024:
                        continue
                    cipher_fields = {}
                    for key, item in parse_qsl(cipher, keep_blank_values=True):
                        cipher_fields.setdefault(key, []).append(item)
                    urls = cipher_fields.get("url", [])
                    if not urls:
                        continue
                    url = urls[0]
                    signature_key = (cipher_fields.get("sp") or ["signature"])[-1] or "signature"
                    if not SIGNATURE_KEY.fullmatch(signature_key):
                        continue
                    # A cipher only appends this key; an existing value is not safe to discard.
                    try:
                        existing_signature = any(key == signature_key for key, _ in parse_qsl(urlsplit(url).query))
                    except ValueError:
                        continue
                    if existing_signature:
                        continue
                key = transfer_key(url, signature_key)
                if key is None:
                    continue
                track = raw.get("audioTrack")
                track = track if isinstance(track, dict) else {}
                identifier = track.get("id")
                identifier = identifier if isinstance(identifier, str) and TRACK_ID.fullmatch(identifier) else None
                default = track.get("audioIsDefault")
                default = default if isinstance(default, bool) else None
                groups.setdefault(signature_key, {}).setdefault(key, set()).add((identifier, default))
    # Bound comparison work even if malformed responses specify many signature keys.
    if len(groups) > 32 or not isinstance(formats, list) or len(formats) > 2048:
        return
    for fmt in formats:
        if not isinstance(fmt, dict) or fmt.get("vcodec") != "none" or fmt.get("acodec") in (None, "none"):
            continue
        if fmt.get("protocol") not in (None, "https", "http_dash_segments"):
            continue
        matches = set()
        for signature_key, candidates in groups.items():
            key = transfer_key(fmt.get("url"), signature_key)
            if key is not None:
                matches.update(candidates.get(key, ()))
        identifiers = {identifier for identifier, _ in matches}
        if len(identifiers) != 1:
            continue
        identifier = identifiers.pop()
        if identifier is not None:
            fmt["musicmute_audio_track_id"] = identifier
        defaults = {default for _, default in matches}
        if len(defaults) == 1:
            default = defaults.pop()
            if default is not None:
                fmt["musicmute_audio_is_default"] = default


def install_audio_track_identity():
    """Small owned wrapper around the verified extractor, never a second extraction."""
    from yt_dlp.extractor.youtube import YoutubeIE

    if getattr(YoutubeIE, "_musicmute_track_identity_installed", False):
        return
    upstream = YoutubeIE._list_formats

    def list_formats(self, video_id, microformats, video_details, player_responses, player_url, duration=None):
        result = upstream(self, video_id, microformats, video_details, player_responses, player_url, duration)
        enrich_audio_tracks(result[2], player_responses)
        return result

    YoutubeIE._list_formats = list_formats
    YoutubeIE._musicmute_track_identity_installed = True


def protected_packaged_resource(path):
    """A protected app can be installed by a different local Mac account."""
    resources = os.environ.get("MUSICMUTE_LOCAL_APP_RESOURCES", "")
    absolute = os.path.abspath(path)
    if (
        not resources or not os.path.isabs(resources)
        or resources != os.path.realpath(resources)
        or absolute != os.path.realpath(absolute)
        or not absolute.startswith(resources.rstrip(os.sep) + os.sep)
    ):
        return False
    current = os.path.dirname(absolute)
    while True:
        information = os.lstat(current)
        if not stat.S_ISDIR(information.st_mode) or information.st_mode & 0o022:
            return False
        if current == resources:
            return True
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


def safe_stat(path, *, directory=False):
    information = os.lstat(path)
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if (
        not expected(information.st_mode)
        or (information.st_uid != os.getuid() and not protected_packaged_resource(path))
        or information.st_mode & 0o022
        or (not directory and information.st_nlink != 1)
    ):
        raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
    return information


def verified_archives(check_contents=True, bundle_root=None):
    root = bundle_root or os.path.dirname(os.path.abspath(__file__))
    safe_stat(root, directory=True)
    safe_stat(os.path.abspath(__file__))
    archives = []
    for filename, expected_bytes, expected_sha in WHEELS:
        path = os.path.join(root, filename)
        before = safe_stat(path)
        if before.st_size != expected_bytes:
            raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        if not check_contents:
            # Normal acquisition trusts the installed tools. Explicit EJS/setup
            # diagnostics retain the complete byte verification below.
            archives.append(path)
            continue
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as archive:
            opened = os.fstat(archive.fileno())
            if (
                (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
                or opened.st_nlink != 1
                or not stat.S_ISREG(opened.st_mode)
            ):
                raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
            digest = hashlib.sha256()
            for chunk in iter(lambda: archive.read(128 * 1024), b""):
                digest.update(chunk)
            after = os.fstat(archive.fileno())
            if (
                digest.hexdigest() != expected_sha
                or after.st_size != expected_bytes
                or (after.st_mtime_ns, after.st_ctime_ns)
                != (opened.st_mtime_ns, opened.st_ctime_ns)
            ):
                raise BootstrapError("DOWNLOADER_IDENTITY_INVALID")
        archives.append(path)
    return archives


def check_ejs():
    # Both packages are verified before import. Traversable reads work directly
    # from ZIP archives; Node later receives this JavaScript on stdin.
    import yt_dlp_ejs
    from yt_dlp.extractor.youtube.jsc._builtin import vendor
    from yt_dlp_ejs.yt import solver

    if yt_dlp_ejs.version != "0.8.0" or vendor.VERSION != "0.8.0":
        raise BootstrapError("YT_DLP_EJS_MISSING")
    for name, code in (
        ("yt.solver.core.min.js", solver.core()),
        ("yt.solver.lib.min.js", solver.lib()),
    ):
        expected = EJS_HASHES[name]
        if (
            vendor.HASHES.get(name) != expected
            or hashlib.sha3_512(code.encode("utf-8")).hexdigest() != expected
        ):
            raise BootstrapError("YT_DLP_EJS_MISSING")


def check_challenge_runtime(runtime_root):
    """Execute the pinned solver/parser graph with a synthetic offline challenge."""
    import json
    import subprocess
    from yt_dlp_ejs.yt import solver
    check_ejs()
    challenge = {
        "type": "preprocessed",
        "preprocessed_player": "_result.sig = input => input.split('').reverse().join(''); _result.n = input => input.slice(1);",
        "requests": [{"type": "sig", "challenges": ["musicmute"]}, {"type": "n", "challenges": ["abc"]}],
    }
    code = solver.lib() + "\nObject.assign(globalThis, lib);\n" + solver.core() + "\n"
    code += "const ast = meriyah.parse('let answer = 6 * 7;'); if (!astring.generate(ast).includes('answer')) throw new Error();\n"
    code += "const output = jsc(" + json.dumps(challenge) + ");\n"
    code += "if (output.type !== 'result' || output.responses[0].data.musicmute !== 'etumcisum' || output.responses[1].data.abc !== 'bc') throw new Error(); console.log('ready');\n"
    completed = subprocess.run([
        os.path.join(runtime_root, "bin", "deno"), "run", "--ext=js", "--no-code-cache",
        "--no-prompt", "--no-remote", "--no-lock", "--node-modules-dir=none", "--no-config", "--no-npm", "--cached-only", "-",
    ], input=code, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
    if completed.returncode or completed.stdout.strip() != "ready":
        raise BootstrapError("YT_DLP_EJS_MISSING")


def require_gvs_token():
    """Fail closed at the pinned extractor's GVS boundary, not its player API.

    mweb obtains its GVS token during format extraction, after the player
    response. Preserve that content binding and do not send a GVS token as a
    player token. Earlier YouTube refusals retain their original classification.
    """
    from yt_dlp.extractor.youtube import YoutubeIE
    from yt_dlp.extractor.youtube.pot.provider import PoTokenContext

    upstream = YoutubeIE.fetch_po_token

    def fetch(self, client='web', context=PoTokenContext.GVS, **kwargs):
        required = client == 'mweb' and context == PoTokenContext.GVS
        if required:
            kwargs['required'] = True
        token = upstream(self, client=client, context=context, **kwargs)
        if required and not token:
            raise BootstrapError("SOURCE_TOKEN_REQUIRED")
        return token

    YoutubeIE.fetch_po_token = fetch


def install_token_provider(runtime_root, check_contents=True, bundle_root=None):
    """Load only the verified pinned plugin, never search any plugin directory."""
    import types
    import zipfile
    import functools
    import dataclasses
    from yt_dlp.cookies import YoutubeDLCookieJar
    from yt_dlp.extractor.youtube.pot._registry import _pot_providers
    from yt_dlp.extractor.youtube.pot._director import validate_response
    from yt_dlp.extractor.youtube.pot.provider import PoTokenProviderError

    provider_root = os.path.join(runtime_root, "provider")
    for path in (runtime_root, provider_root, os.path.join(provider_root, "src")):
        safe_stat(path, directory=True)
    script_path = os.path.join(provider_root, "src", "generate_once.ts")
    safe_stat(script_path)
    # The owned wrapper source is pinned independently of its manifest.
    if check_contents:
        with open(script_path, "rb") as script:
            if hashlib.sha256(script.read()).hexdigest() != PROVIDER_SCRIPT_SHA256:
                raise BootstrapError("PO_TOKEN_PROVIDER_INVALID")
    for name in ("yt_dlp_plugins", "yt_dlp_plugins.extractor"):
        module = types.ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module
    archive_path = os.path.join(bundle_root or os.path.dirname(os.path.abspath(__file__)), WHEELS[0][0])
    with zipfile.ZipFile(archive_path) as archive:
        for suffix in ("getpot_bgutil", "getpot_bgutil_script"):
            name = "yt_dlp_plugins.extractor." + suffix
            module = types.ModuleType(name)
            sys.modules[name] = module
            exec(compile(archive.read("yt_dlp_plugins/extractor/" + suffix + ".py"), name, "exec"), module.__dict__)
    module = sys.modules["yt_dlp_plugins.extractor.getpot_bgutil_script"]
    _pot_providers.value.pop(module.BgUtilScriptNodePTP.PROVIDER_KEY, None)
    provider = module.BgUtilScriptDenoPTP
    provider._server_home = functools.cached_property(lambda self: provider_root)
    provider._server_home.__set_name__(provider, "_server_home")
    provider._script_cache_dir = functools.cached_property(lambda self: os.environ["XDG_CACHE_HOME"])
    provider._script_cache_dir.__set_name__(provider, "_script_cache_dir")
    provider._jsrt_path_impl = lambda self: os.path.join(runtime_root, "bin", "deno")
    def arguments(self):
        def escaped(value):
            return value.replace(",", ",,")
        cache = os.environ["XDG_CACHE_HOME"]
        return (
            "run", "--cached-only", "--frozen", "--no-check", "--allow-env", "--allow-net",
            "--allow-ffi=" + escaped(os.path.join(provider_root, "node_modules")),
            "--allow-read=" + escaped(runtime_root) + "," + escaped(cache),
            "--allow-write=" + escaped(cache),
            "--config", os.path.join(provider_root, "deno.json"),
        )
    provider._jsrt_args = arguments
    # The pinned extractor creates anonymous PREF/SOCS cookies even with
    # --no-cookies. Reject account/imported jars, not its own guest context.
    # The reviewed script uses only content binding and Innertube context;
    # no cookies are forwarded to it.
    original_request = provider._real_request_pot
    def request(self, item):
        downloader = self.ie._downloader
        account_cookies = {"SID", "HSID", "SSID", "APISID", "SAPISID", "SIDCC", "LOGIN_INFO", "LSID", "OSID"}
        if (
            item.is_authenticated or item.data_sync_id
            or item.session_index not in (None, 0, "0")
            or item.request_proxy or item.request_source_address or not item.request_verify_tls
            or downloader.params.get("cookiefile") or downloader.params.get("cookiesfrombrowser")
            or item.request_cookiejar is not downloader.cookiejar
            or any(
                cookie.name.upper() in account_cookies
                or cookie.name.upper().startswith(("__SECURE-1P", "__SECURE-3P", "__HOST-1P", "__HOST-3P"))
                or cookie.domain.lstrip(".").lower() not in {"youtube.com", "www.youtube.com", "m.youtube.com"}
                for cookie in item.request_cookiejar
            )
            or any(name.lower() in {"cookie", "authorization", "x-goog-pageid"} for name in item.request_headers)
            or item.request_headers.get("X-Goog-AuthUser", "0") != "0"
        ):
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        try:
            response = original_request(self, dataclasses.replace(item, request_cookiejar=YoutubeDLCookieJar()))
            if not validate_response(response):
                raise ValueError("invalid response")
            return response
        except Exception:
            # Upstream errors can include script output or token values. Only a
            # fixed code may reach its director/logger; no raw provider text.
            raise PoTokenProviderError("SOURCE_TOKEN_REQUIRED", expected=True) from None
    provider._real_request_pot = request
    require_gvs_token()


PROVIDER_SCRIPT_SHA256 = "718ba412feecbc67d423c30048fb9a5066c195a610773208abfe1912f6f10b7c"

def install_process_lease():
    if "MUSICMUTE_UPDATE_LEASE_FD" not in os.environ:
        return
    import importlib.util
    resources = os.environ.get("MUSICMUTE_LOCAL_APP_RESOURCES")
    if not resources or not os.path.isabs(resources):
        raise BootstrapError("LOCAL_UPDATE_LEASE_INVALID")
    spec = importlib.util.spec_from_file_location("musicmute_process_lease", os.path.join(resources, "engine", "process_lease.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.propagate_update_lease()


def main():
    install_process_lease()
    arguments = sys.argv[1:]
    bundle_root = None
    if arguments[:1] == ["--musicmute-downloader-root"]:
        if len(arguments) < 3 or not os.path.isabs(arguments[1]):
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        bundle_root = arguments[1]
        arguments = arguments[2:]
    runtime_root = None
    if arguments[:1] == ["--musicmute-youtube-runtime"]:
        if len(arguments) < 3 or not os.path.isabs(arguments[1]):
            raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
        runtime_root = arguments[1]
        arguments = arguments[2:]
    checking = arguments == ["--musicmute-check-ejs"]
    if "--musicmute-check-ejs" in arguments and not checking:
        raise BootstrapError("DOWNLOADER_ARGUMENTS_INVALID")
    if not checking:
        validate_arguments(arguments)
    sys.path[:0] = verified_archives(check_contents=checking, bundle_root=bundle_root)
    with isolated_downloader_environment():
        if checking:
            check_ejs()
            if runtime_root:
                check_challenge_runtime(runtime_root)
            sys.stdout.write("ready\n")
            return 0
        import yt_dlp

        install_audio_track_identity()
        if runtime_root:
            install_token_provider(runtime_root, check_contents=False, bundle_root=bundle_root)
        yt_dlp.main([
            *(["--extractor-args", "youtube:player_client=mweb"] if runtime_root else []),
            "--no-cookies", "--no-cookies-from-browser",
            "--retries", "0", "--fragment-retries", "0", "--extractor-retries", "0",
            "--sleep-requests", "1", "--sleep-interval", "5",
            *arguments,
        ])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BootstrapError as error:
        sys.stderr.write(str(error) + "\n")
        raise SystemExit(1)
    except Exception:
        sys.stderr.write("DOWNLOADER_IDENTITY_INVALID\n")
        raise SystemExit(1)
