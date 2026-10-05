"""Downloader isolation and integrity tests; no video, GPU or fleet mutation."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "engine/downloader_bootstrap.py"
SETUP = SOURCE.parents[1] / "scripts/setup-downloader-wheels.mjs"
PINS = (
    ("bgutil_ytdlp_pot_provider-2.0.1-py3-none-any.whl", 12777, "ff6c2e85443e0777e2483e4a5ef2084ca745a1dd3cc07cf355ddd3a77bd882e8"),
    ("yt_dlp-2026.8.19-py3-none-any.whl", 3_185_533, "1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf"),
    ("yt_dlp_ejs-0.8.0-py3-none-any.whl", 53_443, "79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4"),
)
TARGET = Path(os.environ.get(
    "MUSICMUTE_LOCAL_DOWNLOADER_TARGET",
    Path.home() / "Library/Application Support/MusicMuteLocalMvp/tools/downloader",
))


def qualified_archives_available():
    try:
        return all(
            (TARGET / name).stat().st_size == size
            and hashlib.sha256((TARGET / name).read_bytes()).hexdigest() == digest
            for name, size, digest in PINS
        )
    except OSError:
        return False


QUALIFIED = qualified_archives_available()


class DownloaderBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="musicmute-downloader-")
        self.base = Path(self.temporary.name).resolve()
        self.target = self.base / "private downloader"
        self.target.mkdir(mode=0o700)
        self.script = self.target / "downloader_bootstrap.py"
        shutil.copyfile(SOURCE, self.script)
        self.script.chmod(0o600)
        self.home = self.base / "home"
        self.home.mkdir(mode=0o700)
        self.tmp = self.base / "tmp"
        self.tmp.mkdir(mode=0o700)

    def tearDown(self):
        self.temporary.cleanup()

    def install_archives(self):
        for name, _, _ in PINS:
            destination = self.target / name
            shutil.copyfile(TARGET / name, destination)
            destination.chmod(0o600)

    def launch(self, arguments=None, *, flags=("-I", "-B", "-S"), environment=None, script=None):
        env = {
            "HOME": str(self.home), "TMPDIR": str(self.tmp),
            "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8",
        }
        env.update(environment or {})
        return subprocess.run(
            [sys.executable, *flags, str(script or self.script), *(arguments or ["--musicmute-check-ejs"])],
            cwd=self.home, env=env, capture_output=True, timeout=10,
        )

    def test_other_account_packaged_assets_require_protected_containment(self):
        command = """
import importlib.util
import os
import sys
spec = importlib.util.spec_from_file_location('bootstrap_fixture', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
real_uid = os.getuid()
os.getuid = lambda: real_uid + 1
path = sys.argv[1]
try:
    module.safe_stat(path)
    raise AssertionError('foreign developer resource accepted')
except module.BootstrapError:
    pass
os.environ['MUSICMUTE_LOCAL_APP_RESOURCES'] = os.path.dirname(os.path.dirname(path))
module.safe_stat(path)
os.chmod(os.path.dirname(path), 0o777)
try:
    module.safe_stat(path)
    raise AssertionError('writable app resource accepted')
except module.BootstrapError:
    pass
print('ready')
"""
        result = subprocess.run(
            [sys.executable, '-I', '-B', '-S', '-c', command, str(self.script)],
            capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b'ready\n')
        self.target.chmod(0o700)

    def assert_failure(self, result, code):
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, (code + "\n").encode())

    def launch_import_spy(self, *, environment=None, fail=False, checking=False):
        # Only standard-library code and an injected synthetic yt_dlp module run.
        # The child's interpreter also runs isolated, without site or bytecode.
        command = """
import builtins
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import types

source, fail, checking = sys.argv[1], sys.argv[2] == 'true', sys.argv[3] == 'true'
spec = importlib.util.spec_from_file_location('downloader_fixture', source)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
observations = {}
original_environment = dict(os.environ)

def observe():
    home = Path(os.environ['HOME'])
    return {
        'environment': dict(os.environ),
        'home_exists': home.is_dir(),
        'home_mode': home.stat().st_mode & 0o777,
        'home_uid': home.stat().st_uid,
    }

def archives(**kwargs):
    observations['archives'] = observe()
    return []

def check_ejs():
    observations['ejs'] = observe()

def main(arguments):
    observations['main'] = observe()
    observations['arguments'] = arguments
    child = subprocess.run(
        [sys.executable, '-I', '-B', '-S', '-c',
         'import json,os; print(json.dumps(dict(os.environ)))'],
        check=True, capture_output=True, text=True, timeout=5,
    )
    observations['child_environment'] = json.loads(child.stdout)
    if fail:
        raise RuntimeError('synthetic failure')

fake = types.ModuleType('yt_dlp')
fake.main = main
original_import = builtins.__import__

def importing(name, *args, **kwargs):
    if name == 'yt_dlp':
        observations['import'] = observe()
        return fake
    return original_import(name, *args, **kwargs)

bootstrap.verified_archives = archives
bootstrap.check_ejs = check_ejs
bootstrap.install_audio_track_identity = lambda: None
builtins.__import__ = importing
sys.argv = [source, '--musicmute-check-ejs'] if checking else [source, '--ignore-config', '--no-plugin-dirs', '--version']
output = io.StringIO()
try:
    with contextlib.redirect_stdout(output):
        bootstrap.main()
except Exception as error:
    observations['error_type'] = type(error).__name__
finally:
    builtins.__import__ = original_import
observations['environment_restored'] = dict(os.environ) == original_environment
observations['stdout'] = output.getvalue()
print(json.dumps(observations))
"""
        env = {
            "HOME": str(self.home), "TMPDIR": str(self.tmp),
            "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8",
            "LC_ALL": "en_US.UTF-8",
            "MUSICMUTE_LOCAL_PARENT_PID": str(os.getpid()),
        }
        env.update(environment or {})
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-S", "-c", command, str(self.script), str(fail).lower(), str(checking).lower()],
            cwd=self.home, env=env, capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        return json.loads(result.stdout)

    def test_isolation_flags_are_required(self):
        # Never omit -B when running a signed runtime: Python imports encodings
        # before our script can reject unsafe flags, creating bundle bytecode.
        for flags in (("-B", "-S"), ("-I", "-B")):
            with self.subTest(flags=flags):
                self.assert_failure(self.launch(flags=flags), "DOWNLOADER_ISOLATION_REQUIRED")
        # Exercise the writable-bytecode guard only after safe interpreter
        # startup. Builtins suffice here; no imports run after toggling it.
        command = "import sys;sys.dont_write_bytecode=False;exec(compile(open(sys.argv[1],'rb').read(),sys.argv[1],'exec'),{'__name__':'__main__','__file__':sys.argv[1]})"
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-S", "-c", command, str(self.script)],
            cwd=self.home, env={"HOME": str(self.home), "PATH": "/usr/bin:/bin"},
            capture_output=True, timeout=10,
        )
        self.assert_failure(result, "DOWNLOADER_ISOLATION_REQUIRED")

    def test_missing_archive_is_a_safe_error(self):
        self.assert_failure(self.launch(), "DOWNLOADER_IDENTITY_INVALID")

    def test_unsafe_check_arguments_are_rejected(self):
        self.assert_failure(self.launch(["--musicmute-check-ejs", "--version"]), "DOWNLOADER_ARGUMENTS_INVALID")

    def test_cli_requires_config_and_plugin_isolation(self):
        for arguments in (["--version"], ["--version", "--ignore-config"], ["--version", "--no-plugin-dirs"]):
            with self.subTest(arguments=arguments):
                self.assert_failure(self.launch(arguments), "DOWNLOADER_ARGUMENTS_INVALID")

    def test_private_and_abbreviated_cli_options_are_rejected_before_archive_import(self):
        # No archives exist: a different error would mean the unsafe command
        # reached archive loading instead of being refused at the boundary.
        unsafe = (
            ["--cookies", "fixture-cookies.txt"],
            ["--cookies=fixture-cookies.txt"],
            ["--cookies-from-browser", "chrome:fixture-profile"],
            ["--cookies-from-browser=chrome:fixture-profile"],
            ["--cookies-from", "chrome"],
            ["--coo", "fixture-cookies.txt"],
            ["--username", "fixture-user"],
            ["--username=fixture-user"],
            ["-u", "fixture-user"],
            ["--password", "fixture-password"],
            ["-p", "fixture-password"],
            ["--video-password=fixture-password"],
            ["--netrc"],
            ["-n"],
            ["--netrc-location", "fixture.netrc"],
            ["--netrc-cmd", "printf fixture"],
            ["--config-locations", "fixture-config"],
            ["--config-locations=fixture-config"],
            ["--config-loc", "fixture-config"],
            ["--alias", "private", "--cookies fixture-cookies.txt"],
            ["--alias=private,--cookies fixture-cookies.txt"],
            ["--add-header", "Authorization: Bearer fixture-token"],
            ["--add-headers=Cookie: fixture=value"],
            ["--user-agent", "fixture-client"],
            ["--referer", "https://fixture.invalid"],
            ["--extractor-args", "youtube:visitor_data=fixture-visitor"],
            ["--extractor-args=youtube:po_token=web.gvs+fixture-token"],
            ["--proxy=http://fixture.invalid"],
            ["--impersonate", "chrome"],
            ["--plugin-dirs", "fixture-plugins"],
            ["--remote-components", "ejs:github"],
            ["--exec", "printf fixture"],
            ["--ver"],
            ["--no-plugin-dir"],
            ["--load-info-jso", "-"],
            ["--load-info-json", "fixture-info.json"],
            ["--load-info-json=fixture-info.json"],
            ["--retries", "1"],
            ["--fragment-retries", "1"],
            ["--extractor-retries", "3"],
            ["--sleep-requests", "0"],
            ["--sleep-requests", "-1"],
            ["--sleep-interval", "0"],
            ["--concurrent-fragments", "2"],
            ["--concurrent-fragments", "50"],
            ["--print", "--cookies"],
        )
        for arguments in unsafe:
            with self.subTest(arguments=arguments):
                self.assert_failure(
                    self.launch(["--ignore-config", "--no-plugin-dirs", "--version", *arguments]),
                    "DOWNLOADER_ARGUMENTS_INVALID",
                )

    def test_import_and_child_receive_private_home_without_inherited_credentials(self):
        inherited = {
            key: "fixture-only-value"
            for key in (
                "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                "http_proxy", "https_proxy", "all_proxy", "no_proxy",
                "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP",
                "NODE_OPTIONS", "NODE_PATH", "NETRC", "AUTHORIZATION",
                "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
                "CURL_CA_BUNDLE", "GOOGLE_APPLICATION_CREDENTIALS",
                "AWS_SHARED_CREDENTIALS_FILE", "GIT_ASKPASS", "SSH_ASKPASS",
            )
        }
        inherited.update({
            "XDG_CONFIG_HOME": str(self.home / "config"),
            "XDG_CACHE_HOME": str(self.home / "cache"),
            "XDG_DATA_HOME": str(self.home / "data"),
        })
        result = self.launch_import_spy(environment=inherited)
        self.assertNotIn("error_type", result)
        allowed_keys = {
            "PATH", "LANG", "LC_ALL", "TMPDIR", "MUSICMUTE_LOCAL_PARENT_PID",
            "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "DENO_DIR", "DENO_NO_PROMPT", "DENO_NO_UPDATE_CHECK", "TOKEN_TTL",
        }
        homes = set()
        for boundary in ("import", "main"):
            observation = result[boundary]
            environment = observation["environment"]
            private_home = Path(environment["HOME"])
            homes.add(private_home)
            self.assertNotEqual(private_home, self.home)
            self.assertEqual(private_home.parent, self.tmp)
            self.assertTrue(observation["home_exists"])
            self.assertEqual(observation["home_mode"], 0o700)
            self.assertEqual(observation["home_uid"], os.getuid())
            self.assertEqual(set(environment), allowed_keys)
            for key in ("XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"):
                self.assertTrue(Path(environment[key]).is_relative_to(private_home))
                self.assertNotEqual(environment[key], inherited[key])
            self.assertEqual(environment["TMPDIR"], str(private_home))
            self.assertEqual(environment["PATH"], "/usr/bin:/bin")
            self.assertEqual(environment["LANG"], "en_US.UTF-8")
            self.assertEqual(environment["LC_ALL"], "en_US.UTF-8")
            self.assertEqual(environment["MUSICMUTE_LOCAL_PARENT_PID"], str(os.getpid()))
        self.assertEqual(len(homes), 1)
        self.assertIn("archives", result)
        child_environment = dict(result["child_environment"])
        # macOS can add its own CoreFoundation text-encoding marker at process
        # startup; this is not an inherited proxy or credential setting.
        child_environment.pop("__CF_USER_TEXT_ENCODING", None)
        self.assertEqual(child_environment, result["main"]["environment"])
        self.assertEqual(result["arguments"][:2], ["--no-cookies", "--no-cookies-from-browser"])
        for option in ("--netrc", "--netrc-location", "--netrc-cmd"):
            self.assertNotIn(option, result["arguments"])
        self.assertEqual(result["arguments"][-3:], ["--ignore-config", "--no-plugin-dirs", "--version"])
        for option in ("--retries", "--fragment-retries", "--extractor-retries"):
            self.assertEqual(result["arguments"][result["arguments"].index(option) + 1], "0")
        for option, value in (("--sleep-requests", "1"), ("--sleep-interval", "5")):
            self.assertEqual(result["arguments"][result["arguments"].index(option) + 1], value)
        self.assertTrue(result["environment_restored"])
        self.assertTrue(all(not home.exists() for home in homes))
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_private_home_is_fresh_per_launch_and_removed_after_failure(self):
        successful = self.launch_import_spy()
        failed = self.launch_import_spy(fail=True)
        first_home = Path(successful["main"]["environment"]["HOME"])
        failed_home = Path(failed["main"]["environment"]["HOME"])
        self.assertNotEqual(first_home, failed_home)
        self.assertEqual(failed["error_type"], "RuntimeError")
        self.assertTrue(successful["environment_restored"])
        self.assertTrue(failed["environment_restored"])
        self.assertFalse(first_home.exists())
        self.assertFalse(failed_home.exists())
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_ejs_check_uses_disposable_home_and_restores_environment(self):
        result = self.launch_import_spy(checking=True)
        self.assertNotIn("error_type", result)
        self.assertNotIn("main", result)
        self.assertEqual(result["stdout"], "ready\n")
        environment = result["ejs"]["environment"]
        private_home = Path(environment["HOME"])
        self.assertEqual(private_home.parent, self.tmp)
        self.assertNotEqual(private_home, self.home)
        self.assertEqual(result["ejs"]["home_mode"], 0o700)
        self.assertEqual(environment["TMPDIR"], str(private_home))
        for key in ("XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"):
            self.assertTrue(Path(environment[key]).is_relative_to(private_home))
        self.assertTrue(result["environment_restored"])
        self.assertFalse(private_home.exists())
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_symbolic_link_is_rejected_without_reading_foreign_file(self):
        foreign = self.base / "foreign.whl"
        foreign.write_bytes(b"foreign")
        (self.target / PINS[0][0]).symlink_to(foreign)
        self.assert_failure(self.launch(), "DOWNLOADER_IDENTITY_INVALID")
        self.assertEqual(foreign.read_bytes(), b"foreign")

    def test_hard_link_is_rejected(self):
        foreign = self.base / "foreign.whl"
        foreign.write_bytes(b"foreign")
        os.link(foreign, self.target / PINS[0][0])
        self.assert_failure(self.launch(), "DOWNLOADER_IDENTITY_INVALID")

    @unittest.skipUnless(QUALIFIED, "requires explicitly prepared pinned wheels")
    def test_pinned_guest_extractor_can_fetch_token_without_forwarding_cookies(self):
        self.install_archives()
        runtime = self.base / "youtube runtime"
        scripts = runtime / "provider/src"
        scripts.mkdir(parents=True, mode=0o700)
        (runtime / "provider").chmod(0o700)
        shutil.copyfile(
            SOURCE.parents[1] / "scripts/youtube-runtime/generate_once.ts",
            scripts / "generate_once.ts",
        )
        (scripts / "generate_once.ts").chmod(0o600)
        command = """
import dataclasses
import importlib.util
import json
import sys
from unittest import mock

spec = importlib.util.spec_from_file_location('bootstrap_fixture', sys.argv[1])
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
sys.path[:0] = bootstrap.verified_archives()
with bootstrap.isolated_downloader_environment():
    from yt_dlp import YoutubeDL
    from yt_dlp.cookies import YoutubeDLCookieJar
    from yt_dlp.extractor.youtube import YoutubeIE
    from yt_dlp.extractor.youtube.pot.provider import PoTokenContext, PoTokenRequest
    from yt_dlp.networking.common import HTTPHeaderDict

    bootstrap.install_token_provider(sys.argv[2])
    from yt_dlp_plugins.extractor.getpot_bgutil_script import BgUtilScriptDenoPTP

    class Logger:
        def __getattr__(self, _name):
            return lambda *args, **kwargs: None

    token = 'Zml4dHVyZS10b2tlbg=='
    commands = []
    jars = []
    def run(command, **kwargs):
        commands.append(command)
        if command[-1] == '--version':
            return '2.0.1', '', 0
        assert command[command.index('-c') + 1] == 'fixture-guest-visitor'
        context = json.loads(command[command.index('--innertube-context') + 1])
        assert context['client']['clientName'] == 'MWEB'
        assert not any(option in command for option in ('--cookies', '--proxy', '-p', '--source-address', '--disable-tls-verification'))
        return json.dumps({'poToken': token}), '', 0

    ydl = YoutubeDL({'quiet': True, 'no_warnings': True, 'cachedir': False, 'extractor_args': {'youtube': {'player_client': ['mweb']}}})
    ydl.urlopen = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('network forbidden'))
    ie = YoutubeIE(ydl)
    ie.initialize()
    names = {cookie.name for cookie in ydl.cookiejar}
    assert names == {'PREF', 'SOCS'}, names
    assert not ie.is_authenticated

    request = PoTokenRequest(
        context=PoTokenContext.GVS,
        innertube_context=ie._get_default_ytcfg('mweb')['INNERTUBE_CONTEXT'],
        internal_client_name='mweb', visitor_data='fixture-guest-visitor',
        video_id='abcdefghijk', request_cookiejar=ydl.cookiejar,
    )
    assert request.copy().request_cookiejar is ydl.cookiejar
    instance = BgUtilScriptDenoPTP(ie, Logger(), {})
    with mock.patch('yt_dlp_plugins.extractor.getpot_bgutil_script.Popen.run', side_effect=run):
        def fetch_token(**kwargs):
            return ie.fetch_po_token(
                client='mweb', context=PoTokenContext.GVS,
                ytcfg=ie._get_default_ytcfg('mweb'), visitor_data='fixture-guest-visitor',
                video_id='abcdefghijk', **kwargs,
            )
        def audio_formats(fetch):
            response = {'streamingData': {
                '__yt_dlp_client': 'mweb', '__yt_dlp_fetch_gvs_po_token': fetch,
                '__yt_dlp_is_premium_subscriber': False, '__yt_dlp_player_token_provided': False,
                '__yt_dlp_available_at_timestamp': None,
                'adaptiveFormats': [{
                    'itag': 140, 'url': 'https://fixture.googlevideo.com/videoplayback?itag=140',
                    'mimeType': 'audio/mp4; codecs="mp4a.40.2"', 'bitrate': 128000,
                    'audioQuality': 'AUDIO_QUALITY_MEDIUM', 'contentLength': '1024',
                    'audioTrack': {'id': 'en.1', 'audioIsDefault': True, 'displayName': 'English (original)'},
                }],
            }}
            return [item for item in ie._extract_formats_and_subtitles('abcdefghijk', [response], None, 'not_live', 120) if item.get('format_id')]

        # Reproduce the old guard through the pinned director: ordinary guest
        # cookies prevented a token and the extractor removed the audio format.
        fixed_request = BgUtilScriptDenoPTP._real_request_pot
        def old_request(self, item):
            if list(item.request_cookiejar):
                raise bootstrap.BootstrapError('DOWNLOADER_ARGUMENTS_INVALID')
            return fixed_request(self, item)
        with mock.patch.object(BgUtilScriptDenoPTP, '_real_request_pot', old_request), mock.patch.object(ydl, 'report_error'):
            assert fetch_token(required=True) is None
            assert audio_formats(fetch_token) == []

        assert instance.request_pot(request).po_token == token
        assert names == {cookie.name for cookie in ydl.cookiejar}
        # Exercise the exact pinned director/extractor path which previously
        # treated the nonempty guest jar as an error and omitted GVS formats.
        assert fetch_token(required=True) == token
        formats = audio_formats(fetch_token)
        assert len(formats) == 1 and formats[0]['format_id'] == '140'
        assert formats[0]['vcodec'] == 'none' and formats[0]['ext'] == 'm4a'
        assert 'pot=' in formats[0]['url']

        # Capture the jar after validation but before the reviewed script uses
        # its binding. The original guest jar is never cleared or forwarded.
        original_binding = sys.modules['yt_dlp_plugins.extractor.getpot_bgutil_script'].get_webpo_content_binding
        def binding(item):
            jars.append(item.request_cookiejar)
            return original_binding(item)
        with mock.patch('yt_dlp_plugins.extractor.getpot_bgutil_script.get_webpo_content_binding', side_effect=binding):
            instance.request_pot(dataclasses.replace(request, session_index=0))
            ie._set_cookie('.youtube.com', 'VISITOR_INFO1_LIVE', 'fixture-guest-visitor-cookie')
            instance.request_pot(dataclasses.replace(request, session_index='0', request_headers=HTTPHeaderDict({'X-Goog-AuthUser': '0'})))
            ydl.cookiejar.clear('.youtube.com', '/', 'VISITOR_INFO1_LIVE')
            # The extractor receives additional anonymous cookies over time.
            # Their exact names must not disable a guest's token generation.
            guest_names = ('DEVICE_INFO', 'YT_DEVICE_MEASUREMENT_ID', '__Secure-ROLLOUT_TOKEN', '__Secure-YNID', '__Secure-YT_TVFAS', 'future_guest_cookie')
            for name in guest_names:
                ie._set_cookie('.youtube.com', name, 'fixture-guest-only')
            assert instance.request_pot(request).po_token == token
            for name in guest_names:
                ydl.cookiejar.clear('.youtube.com', '/', name)
        assert jars and all(not list(jar) and jar is not ydl.cookiejar for jar in jars)

        # Account and foreign context is rejected before launching the script.
        changes = (
            {'is_authenticated': True}, {'data_sync_id': 'fixture-account-id'},
            {'session_index': 1}, {'request_cookiejar': YoutubeDLCookieJar()},
            {'request_proxy': 'http://fixture.invalid'}, {'request_source_address': '127.0.0.1'},
            {'request_verify_tls': False}, {'request_headers': HTTPHeaderDict({'Cookie': 'fixture=value'})},
            {'request_headers': HTTPHeaderDict({'Authorization': 'Bearer fixture'})},
            {'request_headers': HTTPHeaderDict({'X-Goog-PageId': 'fixture-account'})},
            {'request_headers': HTTPHeaderDict({'X-Goog-AuthUser': '1'})},
        )
        count = len(commands)
        for change in changes:
            try:
                instance.request_pot(dataclasses.replace(request, **change))
                raise AssertionError('account/foreign context accepted')
            except bootstrap.BootstrapError as error:
                assert str(error) == 'DOWNLOADER_ARGUMENTS_INVALID'
        account_names = ('SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'SIDCC', 'LOGIN_INFO', 'LSID', 'OSID', '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID', '__Secure-1PSIDTS', '__Secure-3PSIDCC', '__Host-1PSID', '__Host-3PSID')
        for name, domain in (*((name, '.youtube.com') for name in account_names), ('PREF', '.foreign.invalid')):
            ie._set_cookie(domain, name, 'fixture-only')
            try:
                instance.request_pot(request)
                raise AssertionError('account/foreign cookie accepted')
            except bootstrap.BootstrapError as error:
                assert str(error) == 'DOWNLOADER_ARGUMENTS_INVALID'
            ydl.cookiejar.clear(domain, '/', name)
        for parameter in ('cookiefile', 'cookiesfrombrowser'):
            ydl.params[parameter] = 'fixture-only'
            try:
                instance.request_pot(request)
                raise AssertionError('imported jar accepted')
            except bootstrap.BootstrapError as error:
                assert str(error) == 'DOWNLOADER_ARGUMENTS_INVALID'
            del ydl.params[parameter]
        assert len(commands) == count
    ydl.close()
print('ready')
"""
        result = subprocess.run(
            [sys.executable, '-I', '-B', '-S', '-c', command, str(self.script), str(runtime)],
            cwd=self.home,
            env={"HOME": str(self.home), "TMPDIR": str(self.tmp), "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"},
            capture_output=True, timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b'ready\n')
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_shared_writable_directory_is_rejected(self):
        self.target.chmod(0o770)
        self.assert_failure(self.launch(), "DOWNLOADER_IDENTITY_INVALID")

    @unittest.skipUnless(QUALIFIED, "requires explicitly prepared pinned wheels")
    def test_ejs_resources_load_from_verified_archives(self):
        self.install_archives()
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"ready\n")
        self.assertEqual(result.stderr, b"")
        self.assertEqual(sorted(item.name for item in self.target.iterdir()), sorted([self.script.name, *(pin[0] for pin in PINS)]))

    @unittest.skipUnless(QUALIFIED, "requires explicitly prepared pinned wheels")
    def test_same_size_tampering_is_detected_before_import(self):
        self.install_archives()
        for name, _, _ in PINS:
            path = self.target / name
            original = path.read_bytes()
            path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
            with self.subTest(archive=name):
                self.assert_failure(self.launch(), "DOWNLOADER_IDENTITY_INVALID")
            path.write_bytes(original)

    @unittest.skipUnless(QUALIFIED, "requires explicitly prepared pinned wheels")
    def test_package_site_and_plugin_injection_never_execute(self):
        self.install_archives()
        marker = self.base / "foreign-code-executed"
        foreign = self.base / "foreign packages"
        foreign.mkdir(mode=0o700)
        code = "from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('bad')\nraise RuntimeError('foreign package imported')\n"
        (foreign / "sitecustomize.py").write_text(code)
        for module in ("yt_dlp", "yt_dlp_ejs"):
            (foreign / module).mkdir()
            (foreign / module / "__init__.py").write_text(code)
            (self.home / module).mkdir()
            (self.home / module / "__init__.py").write_text(code)
        plugin = self.home / ".config/yt-dlp/plugins/foreign/yt_dlp_plugins/extractor"
        plugin.mkdir(parents=True)
        (plugin / "foreign.py").write_text(code)
        result = self.launch(["--ignore-config", "--no-plugin-dirs", "--list-extractors"], environment={"PYTHONPATH": str(foreign), "PYTHONUSERBASE": str(foreign), "PYTHONSTARTUP": str(foreign / "sitecustomize.py")})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"youtube", result.stdout.lower())
        self.assertFalse(marker.exists())
        self.assertEqual(list(self.base.rglob("__pycache__")), [])
        self.assertEqual(list(self.base.rglob("*.pyc")), [])

    @unittest.skipUnless(QUALIFIED, "requires explicitly prepared pinned wheels")
    def test_version_retains_cli_and_no_bytecode_or_extraction(self):
        self.install_archives()
        before = {item.name: hashlib.sha256(item.read_bytes()).hexdigest() for item in self.target.iterdir()}
        result = self.launch(["--ignore-config", "--no-plugin-dirs", "--version"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"2026.08.19\n")
        self.assertEqual(result.stderr, b"")
        after = {item.name: hashlib.sha256(item.read_bytes()).hexdigest() for item in self.target.iterdir()}
        self.assertEqual(after, before)
        self.assertEqual(list(self.tmp.iterdir()), [])
        self.assertEqual(list(self.base.rglob("__pycache__")), [])

    @unittest.skipUnless(QUALIFIED, "requires explicitly prepared pinned wheels")
    def test_offline_version_preserves_synthetic_browser_config_and_netrc_canaries(self):
        self.install_archives()
        cookies = self.home / "Library/Application Support/Google/Chrome/Default/Cookies"
        cookies.parent.mkdir(parents=True)
        cookies.write_bytes(b"synthetic cookie canary; not a browser database")
        netrc = self.home / ".netrc"
        netrc.write_text("machine youtube.com login fixture-user password fixture-password\n")
        netrc.chmod(0o600)
        config = self.home / ".config/yt-dlp/config"
        config.parent.mkdir(parents=True)
        config.write_text(
            "--cookies " + repr(str(cookies)) + "\n"
            "--cookies-from-browser chrome:" + repr(str(cookies.parent)) + "\n"
            "--netrc\n--username fixture-user\n--password fixture-password\n"
        )
        canaries = (cookies, netrc, config)
        before = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in canaries}
        result = self.launch(
            ["--ignore-config", "--no-plugin-dirs", "--version"],
            environment={
                "XDG_CONFIG_HOME": str(config.parent.parent),
                "XDG_CACHE_HOME": str(self.home / "foreign-cache"),
                "XDG_DATA_HOME": str(self.home / "foreign-data"),
                "NETRC": str(netrc),
                "HTTP_PROXY": "http://fixture.invalid:9",
                "NODE_OPTIONS": "--require fixture-missing-module",
            },
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"2026.08.19\n")
        self.assertEqual(result.stderr, b"")
        self.assertEqual(
            {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in canaries},
            before,
        )
        self.assertFalse((self.home / "foreign-cache").exists())
        self.assertFalse((self.home / "foreign-data").exists())
        self.assertEqual(list(self.tmp.iterdir()), [])
        self.assertEqual(list(self.base.rglob("__pycache__")), [])

    @unittest.skipUnless(QUALIFIED, "requires explicitly prepared pinned wheels")
    def test_pinned_parser_keeps_cookie_retry_and_pacing_policy(self):
        self.install_archives()
        command = """
import importlib.util
import json
import socket
import sys

def no_network(*args, **kwargs):
    raise AssertionError('network is forbidden in this parser fixture')

socket.socket.connect = no_network
socket.socket.connect_ex = no_network
socket.create_connection = no_network
socket.getaddrinfo = no_network
source = sys.argv[1]
spec = importlib.util.spec_from_file_location('downloader_fixture', source)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
sys.path[:0] = bootstrap.verified_archives()
import yt_dlp

def parse_only(arguments):
    options = yt_dlp.parse_options(arguments).ydl_opts
    keys = (
        'cookiefile', 'cookiesfrombrowser', 'usenetrc', 'retries',
        'fragment_retries', 'extractor_retries', 'sleep_interval_requests',
        'sleep_interval', 'concurrent_fragment_downloads',
    )
    print(json.dumps({key: options[key] for key in keys}))

yt_dlp.main = parse_only
sys.argv = [
    source, '--ignore-config', '--no-plugin-dirs', '--quiet',
    '--sleep-requests', '1', '--sleep-interval', '5',
    '--concurrent-fragments', '1',
]
bootstrap.main()
"""
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-S", "-c", command, str(self.script)],
            cwd=self.home,
            env={"HOME": str(self.home), "TMPDIR": str(self.tmp), "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"},
            capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(json.loads(result.stdout), {
            "cookiefile": None,
            "cookiesfrombrowser": None,
            "usenetrc": False,
            "retries": 0,
            "fragment_retries": 0,
            "extractor_retries": 0,
            "sleep_interval_requests": 1,
            "sleep_interval": 5,
            "concurrent_fragment_downloads": 1,
        })
        self.assertEqual(list(self.tmp.iterdir()), [])
        self.assertEqual(list(self.base.rglob("__pycache__")), [])


@unittest.skipUnless(QUALIFIED and shutil.which("node"), "requires prepared wheels and desktop Node")
class DownloaderSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="musicmute-wheel-setup-")
        self.base = Path(self.temporary.name).resolve()
        self.target = self.base / "downloader"
        self.target.mkdir(mode=0o700)
        for name in ["downloader_bootstrap.py", "identity.json", *(pin[0] for pin in PINS)]:
            shutil.copyfile(TARGET / name, self.target / name)
            (self.target / name).chmod(0o600)
        # Installed wheels remain read-only build fixtures. Setup validates the
        # current source bootstrap, which may legitimately precede repackaging.
        shutil.copyfile(SOURCE, self.target / "downloader_bootstrap.py")
        identity = self.target / "identity.json"
        data = json.loads(identity.read_text())
        bootstrap = (self.target / "downloader_bootstrap.py").read_bytes()
        data["bootstrap"] = {
            "file": "downloader_bootstrap.py",
            "bytes": len(bootstrap),
            "sha256": hashlib.sha256(bootstrap).hexdigest(),
        }
        identity.write_text(json.dumps(data))

    def tearDown(self):
        self.temporary.cleanup()

    def launch(self, target=None):
        return subprocess.run(
            [shutil.which("node"), str(SETUP)],
            env={"HOME": str(self.base), "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "MUSICMUTE_LOCAL_DOWNLOADER_TARGET": str(target or self.target)},
            capture_output=True, timeout=10,
        )

    def fingerprints(self):
        return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in self.target.iterdir()}

    def test_cached_identity_is_validated_without_mutation_and_projected(self):
        identity = self.target / "identity.json"
        data = json.loads(identity.read_text())
        data["private_extra"] = "fixture-only-secret"
        identity.write_text(json.dumps(data))
        before = self.fingerprints()
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertTrue(json.loads(result.stdout)["cached"])
        self.assertNotIn(b"fixture-only-secret", result.stdout)
        self.assertEqual(self.fingerprints(), before)
        self.assertFalse((self.base / ".setup-downloader-wheels.lock").exists())

    def test_corrupt_prior_is_refused_without_replacement(self):
        wheel = self.target / PINS[0][0]
        data = wheel.read_bytes()
        wheel.write_bytes(bytes([data[0] ^ 1]) + data[1:])
        before = self.fingerprints()
        result = self.launch()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"DOWNLOADER_IDENTITY_INVALID\n")
        self.assertEqual(self.fingerprints(), before)

    def test_foreign_prior_entries_are_preserved(self):
        (self.target / "foreign-file").write_text("fixture")
        before = self.fingerprints()
        result = self.launch()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"FOREIGN_DOWNLOADER_EXISTS\n")
        self.assertEqual(self.fingerprints(), before)

    def test_symlink_target_is_refused(self):
        link = self.base / "alias"
        link.symlink_to(self.target, target_is_directory=True)
        before = self.fingerprints()
        result = self.launch(link)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"DOWNLOADER_IDENTITY_INVALID\n")
        self.assertEqual(self.fingerprints(), before)

    def test_competing_setup_lock_is_preserved(self):
        lock = self.base / ".setup-downloader-wheels.lock"
        lock.write_text("existing setup fixture")
        lock.chmod(0o600)
        result = self.launch()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"DOWNLOADER_SETUP_BUSY\n")
        self.assertEqual(lock.read_text(), "existing setup fixture")


if __name__ == "__main__":
    unittest.main()
