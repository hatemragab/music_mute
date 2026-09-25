"""Offline process cancellation checks. No external request is made."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path('/work')
if list(ROOT.glob('attempt-*')):
    raise SystemExit('A live test is already active')

for mode in ['interrupt', 'timeout']:
    with tempfile.TemporaryDirectory(prefix='fault-', dir=ROOT) as tmp:
        scratch = Path(tmp)
        child_code = ('import os,time,pathlib,sys; '
                      'pathlib.Path(sys.argv[1]).write_bytes(b"partial"); '
                      'pathlib.Path(sys.argv[2]).write_text(str(os.getpid())); time.sleep(120)')
        code = f'''
import runner, sys
from pathlib import Path
runner.ROOT = Path({str(scratch)!r})
runner.TIMEOUT = {0.5 if mode == 'timeout' else 600}
runner.command = lambda url, d: [sys.executable, '-c', {child_code!r},
                                str(d / 'source.webm.part'), {str(scratch / 'child.pid')!r}]
sys.argv = ['runner', 'https://youtu.be/aqz-KE-bpKQ']
sys.exit(runner.main())
'''
        process = subprocess.Popen([sys.executable, '-c', code], cwd='/app',
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 10
            marker = scratch / 'child.pid'
            while not marker.exists():
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Synthetic child did not start')
                time.sleep(0.05)
            child_pid = int(marker.read_text())
            if mode == 'interrupt':
                process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=10)
            outcome = json.loads(stdout)
            assert process.returncode == 1
            assert outcome['error'] == ('INTERRUPTED' if mode == 'interrupt' else 'TIMEOUT')
            assert not list(scratch.glob('attempt-*'))
            assert not Path(f'/proc/{child_pid}').exists(), 'Downloader child survived'
            print(json.dumps({'test': mode, 'status': 'passed', 'child_stopped': True,
                              'partial_audio_removed': True}), flush=True)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
