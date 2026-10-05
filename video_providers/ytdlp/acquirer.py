"""One cancellable yt-dlp attempt, isolated from the private HTTP service.

Secrets cross an anonymous stdin pipe, never process arguments or files. The
child emits only a small sanitized result; all third-party output is discarded.
"""
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
from typing import Callable

from diagnostics import clean_context, clean_timings, exception_context


MAX_RESULT_BYTES = 8192
MAX_PROGRESS_MESSAGES = 64
MAX_PROTOCOL_BYTES = MAX_RESULT_BYTES + MAX_PROGRESS_MESSAGES * 1024
ATTEMPT_SECONDS = 30
ERROR_STATUSES = {
    'IMPORT_INVALID_URL': 400,
    'IMPORT_INVALID_REQUEST': 400,
    'IMPORT_SINGLE_ITEM_REQUIRED': 422,
    'IMPORT_UNSUPPORTED_AUDIO_SOURCE': 422,
    'IMPORT_TOO_LARGE': 422,
    'IMPORT_TOO_LONG': 422,
    'IMPORT_INVALID_AUDIO': 422,
    'IMPORT_UPSTREAM_REFUSED': 502,
    'IMPORT_SOURCE_UNAVAILABLE': 422,
    'IMPORT_DEPENDENCY_FAILED': 503,
    'IMPORT_DISK_FULL': 503,
}


class AcquisitionError(Exception):
    def __init__(self, code='IMPORT_DEPENDENCY_FAILED', status=None, diagnostics=None, timings_ms=None):
        self.code = code if code in ERROR_STATUSES else 'IMPORT_DEPENDENCY_FAILED'
        self.status = ERROR_STATUSES[self.code]
        self.diagnostics = clean_context(diagnostics)
        self.timings_ms = clean_timings(timings_ms)
        super().__init__(self.code)


@dataclass(frozen=True)
class AcquisitionResult:
    path: Path
    content_type: str
    metadata: dict
    timings_ms: dict[str, float]
    bytes_downloaded: int
    diagnostics: dict | None = None

    @property
    def size(self):
        return self.path.stat().st_size


def _clean_scratch(scratch):
    # acquire requires an empty, exclusively owned request directory.
    for entry in scratch.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink(missing_ok=True)


def _stop(process):
    # Deno and any yt-dlp helpers inherit this group. Kill the whole attempt,
    # including helpers still running after the direct child exited.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def _result(raw, scratch, max_bytes):
    try:
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError()
        if result.get('error'):
            raise AcquisitionError(result['error'], diagnostics=result.get('diagnostics'),
                                   timings_ms=result.get('timings_ms'))
        filename = result['filename']
        if not isinstance(filename, str) or filename not in ('audio.webm', 'audio.m4a'):
            raise ValueError()
        path = scratch / filename
        details = path.lstat()
        if not stat.S_ISREG(details.st_mode) or not 0 < details.st_size <= max_bytes:
            raise ValueError()
        content_type = result['content_type']
        if content_type != {'audio.webm': 'audio/webm', 'audio.m4a': 'audio/mp4'}[filename]:
            raise ValueError()
        metadata = result['metadata']
        timings = result['timings_ms']
        transferred = result['bytes_downloaded']
        if (not isinstance(metadata, dict) or not isinstance(timings, dict)
                or type(transferred) is not int or not details.st_size <= transferred <= max_bytes):
            raise ValueError()
        if (not all(key in ('extraction_ms', 'token_generation_ms', 'transfer_ms')
                    and type(value) in (int, float) and math.isfinite(value)
                    and 0 <= value <= ATTEMPT_SECONDS * 1000 + 1000
                    for key, value in timings.items())):
            raise ValueError()
        # The child applies the same allowlist; validate again across the process
        # boundary without trusting raw extractor dictionaries.
        from extract import clean_metadata
        metadata = clean_metadata(metadata)
        return AcquisitionResult(path, content_type, metadata, timings, transferred,
                                 clean_context(result.get('diagnostics')))
    except (KeyError, TypeError, ValueError, OSError, UnicodeError, RecursionError):
        raise AcquisitionError(diagnostics={'phase': 'child_protocol',
                                            'reason': 'child_protocol_invalid'}) from None


def acquire(url: str, max_bytes: int, max_duration_seconds: float, proxy: str,
            deadline: float, check: Callable[[], None], scratch: Path,
            token_provider_url: str, deno_path: str = 'deno',
            progress: Callable[[dict, dict], None] | None = None) -> AcquisitionResult:
    """Run exactly one extraction/download attempt within a hard deadline.

Format fallback occurs in the child against the same extracted metadata and
sticky proxy. The HTTP service owns attempt ordinals, admission and retries.
Caller cancellation exceptions propagate unchanged after process/file cleanup.
"""
    scratch = Path(scratch).resolve(strict=True)
    if not scratch.is_dir() or any(scratch.iterdir()):
        raise AcquisitionError('IMPORT_INVALID_REQUEST')
    deadline = min(deadline, time.monotonic() + ATTEMPT_SECONDS)
    request = {
        'url': url, 'max_bytes': max_bytes,
        'max_duration_seconds': max_duration_seconds,
        'proxy': proxy, 'deadline': deadline, 'scratch': str(scratch),
        'token_provider_url': token_provider_url, 'deno_path': deno_path,
    }
    payload = json.dumps(request, ensure_ascii=True, separators=(',', ':')).encode()
    if len(payload) > 12_288:
        raise AcquisitionError('IMPORT_INVALID_REQUEST')
    process = None
    succeeded = False
    selector = selectors.DefaultSelector()
    diagnostics, timings = {'phase': 'startup'}, {}
    phase_started = time.monotonic()
    output, pending = bytearray(), bytearray()
    protocol_bytes, progress_messages = 0, 0

    def report():
        if progress:
            progress(clean_context(diagnostics), clean_timings(timings))

    def consume(line):
        nonlocal progress_messages, phase_started
        try:
            value = json.loads(line)
        except (ValueError, UnicodeError, RecursionError):
            raise AcquisitionError(diagnostics={'reason': 'child_protocol_invalid'}) from None
        if isinstance(value, dict) and 'progress' in value:
            progress_messages += 1
            if len(line) > 1024 or progress_messages > MAX_PROGRESS_MESSAGES:
                raise AcquisitionError(diagnostics={'reason': 'child_protocol_invalid'})
            context = clean_context(value['progress'])
            if context.get('phase') and context['phase'] != diagnostics.get('phase'):
                phase_started = time.monotonic()
            diagnostics.update(context)
            timings.update(clean_timings(value.get('timings_ms')))
            report()
        else:
            if output or len(line) > MAX_RESULT_BYTES:
                raise AcquisitionError(diagnostics={'reason': 'child_protocol_invalid'})
            output.extend(line)

    try:
        check()
        if time.monotonic() >= deadline:
            raise AcquisitionError(diagnostics={'reason': 'attempt_deadline', 'timeout': True})
        # Prevent ambient proxies, browser cookies and unrelated runtime secrets
        # from entering the child. Deno discovers only its explicit path/HOME.
        environment = {
            'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
            'HOME': str(scratch), 'PYTHONDONTWRITEBYTECODE': '1',
            'PYTHONUNBUFFERED': '1', 'DENO_NO_UPDATE_CHECK': '1',
        }
        if os.environ.get('DENO_DIR'):
            environment['DENO_DIR'] = os.environ['DENO_DIR']
        process = subprocess.Popen(
            [sys.executable, '-B', str(Path(__file__).with_name('extract.py'))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, start_new_session=True,
            env=environment, bufsize=0,
        )
        process.stdin.write(payload)
        process.stdin.close()
        selector.register(process.stdout, selectors.EVENT_READ)
        eof = False
        while not eof or process.poll() is None:
            check()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AcquisitionError(diagnostics={'reason': 'attempt_deadline', 'timeout': True,
                                                    'child_killed': True})
            for key, _ in selector.select(min(0.05, remaining)):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    eof = True
                    if pending:
                        consume(pending)
                        pending.clear()
                else:
                    protocol_bytes += len(chunk)
                    pending.extend(chunk)
                    if protocol_bytes > MAX_PROTOCOL_BYTES:
                        raise AcquisitionError(diagnostics={'reason': 'child_protocol_invalid'})
                    while b'\n' in pending:
                        line, _, remainder = pending.partition(b'\n')
                        consume(line)
                        pending[:] = remainder
                    if len(pending) > MAX_RESULT_BYTES:
                        raise AcquisitionError(diagnostics={'reason': 'child_protocol_invalid'})
            if eof and process.poll() is None:
                time.sleep(min(0.01, max(0, remaining)))
        check()
        if time.monotonic() >= deadline:
            raise AcquisitionError(diagnostics={'reason': 'attempt_deadline', 'timeout': True,
                                                'child_killed': True})
        if process.returncode != 0:
            raise AcquisitionError(diagnostics={'reason': 'child_exit'})
        result = _result(output, scratch, max_bytes)
        succeeded = True
        return result
    except Exception as error:
        diagnostics['phase_elapsed_ms'] = min(31_000, round((time.monotonic() - phase_started) * 1000))
        if isinstance(error, AcquisitionError):
            error.diagnostics = clean_context({**diagnostics, **error.diagnostics})
            error.timings_ms = clean_timings({**timings, **error.timings_ms})
            diagnostics.update(error.diagnostics)
            timings.update(error.timings_ms)
        else:
            # Caller cancellation remains the exact original exception. The
            # callback retains phase/timings without changing retry semantics.
            diagnostics.update(exception_context(error, diagnostics.get('phase')))
        report()
        raise
    finally:
        selector.close()
        if process is not None:
            _stop(process)
            if process.stdout:
                process.stdout.close()
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
        if not succeeded:
            _clean_scratch(scratch)
