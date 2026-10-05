"""Fail-closed supervision for the private adapter and loopback Deno provider."""
import importlib.metadata
import importlib.resources
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

PINNED = {'yt-dlp': '2026.8.19', 'yt-dlp-ejs': '0.8.0',
          'bgutil-ytdlp-pot-provider': '2.0.1'}
DENO_VERSION = '2.9.5'
DENO = '/usr/bin/deno'
PROVIDER_HOME = Path('/app')
PROVIDER_URL = 'http://127.0.0.1:4416/ping'


def bundled_ejs_present():
    try:
        solver = importlib.resources.files('yt_dlp_ejs.yt.solver')
        return all((solver / name).is_file() and len((solver / name).read_bytes()) > 1000
                   for name in ('core.min.js', 'lib.min.js'))
    except (ImportError, OSError, TypeError):
        return False


def validate_runtime():
    """Check installed, matching components without fetching or contacting YouTube."""
    try:
        if any(importlib.metadata.version(name) != version for name, version in PINNED.items()):
            raise ValueError()
        if not bundled_ejs_present():
            raise ValueError()
        completed = subprocess.run([DENO, '--version'], capture_output=True, text=True,
                                   timeout=3, check=True)
        # Deno appends channel, release and target details on Linux/macOS.
        if completed.stdout.splitlines()[0].split()[:2] != ['deno', DENO_VERSION]:
            raise ValueError()
        if not all((PROVIDER_HOME / name).exists()
                   for name in ('src/main.ts', 'node_modules', 'deno.lock', '.cache/deno')):
            raise ValueError()
    except (importlib.metadata.PackageNotFoundError, OSError, ValueError,
            IndexError, subprocess.SubprocessError):
        raise SystemExit('Missing matching acquisition runtime components') from None


def provider_command():
    return [DENO, 'run', '--cached-only', '--frozen', '--no-check', '--v8-flags=--max-old-space-size=384',
            '--allow-env', '--allow-net',
            '--allow-ffi=/app/node_modules', '--allow-read=/app/node_modules',
            '/app/src/main.ts', '--host', '127.0.0.1', '--port', '4416']


def provider_environment():
    # Proxy credentials arrive only in a loopback request for that sticky session.
    # Do not expose adapter credentials or unrelated operator secrets to Deno.
    return {'PATH': '/usr/bin:/bin', 'DENO_DIR': '/app/.cache/deno',
            'DENO_NO_PROMPT': '1', 'DENO_NO_UPDATE_CHECK': '1', 'DENO_USE_CGROUPS': '1'}


def provider_ready():
    # Explicitly disable ambient HTTP(S)_PROXY even for this loopback health read.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(PROVIDER_URL, timeout=1) as response:
            if response.status != 200:
                return False
            payload = response.read(1025)
        return len(payload) <= 1024 and json.loads(payload).get('version') == PINNED['bgutil-ytdlp-pot-provider']
    except (OSError, ValueError, AttributeError):
        return False


def wait_until_ready(provider, stopped, timeout=15):
    deadline = time.monotonic() + timeout
    while not stopped() and time.monotonic() < deadline:
        if provider.poll() is not None:
            return False
        if provider_ready():
            return True
        time.sleep(0.1)
    return False


def terminate_children(children):
    # Each child owns a process group, including transient yt-dlp/EJS descendants.
    for child in children:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 3
    for child in children:
        try:
            child.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            pass
    for child in children:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for child in children:
        child.wait()


def main():
    validate_runtime()
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    children = []
    try:
        # The upstream provider can print raw proxy error stacks; keep its output
        # out of operator logs. The adapter emits bounded stable timing events.
        provider = subprocess.Popen(provider_command(), cwd=PROVIDER_HOME,
                                    env=provider_environment(), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    start_new_session=True)
        children.append(provider)
        if not wait_until_ready(provider, lambda: stopping):
            if stopping:
                return 0
            raise SystemExit('Private token provider did not become ready')
        adapter = subprocess.Popen([sys.executable, str(Path(__file__).with_name('service.py'))],
                                   stdin=subprocess.DEVNULL, start_new_session=True)
        children.append(adapter)
        while not stopping:
            if any(child.poll() is not None for child in children):
                raise SystemExit('Private acquisition dependency stopped')
            time.sleep(0.5)
        return 0
    finally:
        terminate_children(children)


if __name__ == '__main__':
    sys.exit(main())
