"""Bounded native-audio acquisition shared by the private API and operator CLI."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlsplit
from network_guard import public_url

ROOT = Path('/work')
MAX_BYTES = 50_000_000
MAX_SECONDS = 1200
TIMEOUT = 600


def canonical_url(value):
    public_url(value)
    p = urlsplit(value)
    if p.hostname not in {'youtu.be', 'youtube.com', 'www.youtube.com',
                          'm.youtube.com', 'music.youtube.com'}:
        return value
    query = parse_qs(p.query, keep_blank_values=True)
    if 'list' in query:
        raise ValueError('SINGLE_ITEM_REQUIRED')
    if p.hostname == 'youtu.be':
        video = p.path[1:]
    elif p.path == '/watch' and len(query.get('v', [])) == 1:
        video = query['v'][0]
    elif p.path.startswith(('/shorts/', '/embed/')):
        video = p.path.split('/')[-1]
    else:
        raise ValueError('SINGLE_ITEM_REQUIRED')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{11}', video):
        raise ValueError('INVALID_URL')
    return 'https://www.youtube.com/watch?v=' + video


def command(url, directory, limits=None):
    max_bytes, max_seconds = limits or (MAX_BYTES, MAX_SECONDS)
    return [sys.executable, str(Path(__file__).with_name('extractor.py')),
            '--no-plugin-dirs', '--proxy', '', '--ignore-config', '--no-cache-dir', '--no-remote-components',
            '--no-playlist', '--no-progress', '--no-write-info-json',
            '--no-write-thumbnail', '--fixup', 'never', '--js-runtimes', 'deno',
            '--format', 'bestaudio[vcodec=none]', '--match-filter',
            f'!is_live & duration<={max_seconds}', '--max-filesize', str(max_bytes),
            '--limit-rate', '1M', '--concurrent-fragments', '1',
            '--sleep-requests', '1', '--sleep-interval', '5', '--max-sleep-interval', '10',
            '--retries', '1', '--fragment-retries', '1', '--extractor-retries', '1',
            '--socket-timeout', '20', '--abort-on-unavailable-fragments',
            '--print', 'after_move:%(.{id,title,format_id,ext,acodec,vcodec,duration,filesize})j',
            '--output', str(directory / 'source.%(ext)s'), '--', url]


def child_limits():
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES, MAX_BYTES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def classify(text):
    for code in ['SINGLE_ITEM_REQUIRED', 'AUDIO_FORMAT_UNAVAILABLE', 'NETWORK_ADDRESS_REJECTED']:
        if code in text:
            return code
    if 'does not pass filter' in text and 'duration' in text:
        return 'DURATION_LIMIT'
    if 'File is larger than max-filesize' in text:
        return 'SIZE_LIMIT'
    if 'Unsupported URL' in text:
        return 'UNSUPPORTED_PROVIDER'
    if '429' in text or 'rate limit' in text.lower():
        return 'UPSTREAM_RATE_LIMIT'
    if '403' in text or 'confirm you' in text.lower() or 'sign in' in text.lower():
        return 'UPSTREAM_ACCESS_REFUSED'
    if 'format is not available' in text.lower():
        return 'AUDIO_FORMAT_UNAVAILABLE'
    return 'DOWNLOAD_FAILED'


def stop_process(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
    process.wait()


def download(url, directory, cancelled=lambda: False, limits=None):
    max_bytes = limits[0] if limits else MAX_BYTES
    with (directory / 'private.log').open('w+') as log:
        args = command(url, directory, limits) if limits else command(url, directory)
        process = subprocess.Popen(args, stdout=log, stderr=log,
                                   start_new_session=True)
        started = time.monotonic()
        try:
            while process.poll() is None:
                if cancelled():
                    raise ValueError('CANCELLED')
                if time.monotonic() - started > TIMEOUT:
                    raise ValueError('TIMEOUT')
                if sum(p.stat().st_size for p in directory.iterdir() if p.is_file()) > max_bytes + 1_000_000:
                    raise ValueError('SIZE_LIMIT')
                time.sleep(0.2)
            log.seek(0)
            data = log.read(1_000_000)
            if process.returncode:
                raise ValueError(classify(data))
            if 'does not pass filter' in data or 'File is larger than max-filesize' in data:
                raise ValueError(classify(data))
            records = []
            for line in data.splitlines():
                try:
                    value = json.loads(line)
                    if isinstance(value, dict) and 'format_id' in value:
                        records.append(value)
                except ValueError:
                    pass
            if len(records) != 1 or records[0].get('vcodec') != 'none':
                raise ValueError('AUDIO_SELECTION_NOT_PROVEN')
            files = list(directory.glob('source.*'))
            if len(files) != 1 or files[0].suffix in {'.part', '.ytdl'}:
                raise ValueError('INCOMPLETE_AUDIO')
            return files[0], records[0]
        finally:
            stop_process(process)


def checked_output(args, directory, timeout, cancelled):
    with tempfile.TemporaryFile(dir=directory) as output:
        process = subprocess.Popen(args, stdout=output, stderr=subprocess.DEVNULL,
                                   start_new_session=True)
        started = time.monotonic()
        try:
            while process.poll() is None:
                if cancelled() or time.monotonic() - started > timeout:
                    raise ValueError('CANCELLED_OR_TIMEOUT')
                if sum(p.stat().st_size for p in directory.iterdir() if p.is_file()) > 2 * MAX_BYTES + 1_000_000:
                    raise ValueError('SIZE_LIMIT')
                if output.tell() > 64 * 1024:
                    raise ValueError('INVALID_AUDIO')
                time.sleep(0.1)
            if process.returncode:
                raise ValueError('INVALID_AUDIO')
            output.seek(0)
            return output.read(64 * 1024)
        finally:
            stop_process(process)


def verify(path, cancelled=lambda: False):
    output = checked_output(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file',
                             '-show_streams', '-show_format', '-of', 'json', str(path)],
                            path.parent, 20, cancelled)
    metadata = json.loads(output)
    streams = metadata['streams']
    if len(streams) != 1 or streams[0]['codec_type'] != 'audio':
        raise ValueError('NON_AUDIO_TRACK')
    duration = float(metadata['format']['duration'])
    if not 0 < duration <= MAX_SECONDS or not 0 < path.stat().st_size <= MAX_BYTES:
        raise ValueError('DURATION_LIMIT' if duration > MAX_SECONDS else 'SIZE_LIMIT')
    checked_output(['ffmpeg', '-v', 'error', '-xerror', '-nostdin',
                    '-protocol_whitelist', 'file', '-i', str(path),
                    '-map', '0:a', '-f', 'null', '-'], path.parent, 120, cancelled)
    with path.open('rb') as media:
        sha256 = hashlib.file_digest(media, 'sha256').hexdigest()
    return {'bytes': path.stat().st_size, 'duration_seconds': duration,
            'audio_codecs': [s['codec_name'] for s in streams], 'video_tracks': 0,
            'sha256': sha256,
            'format_name': metadata['format'].get('format_name', ''),
            'full_decode': True}


def normalize(path, result, cancelled):
    """Keep compatible native audio unchanged; normalize other audio to AAC.

    This runs only after source verification has proven exactly one audio stream
    and zero video. No video is fetched, and FFmpeg has file-only protocol access.
    """
    formats = set(result.get('format_name', '').split(','))
    codec = result['audio_codecs'][0]
    compatible = (('mp3' in formats and codec == 'mp3')
                  or ('mov' in formats and codec in {'aac', 'alac'})
                  or (formats & {'webm', 'ogg'} and codec in {'opus', 'vorbis'})
                  or ('aac' in formats and codec == 'aac'))
    if compatible:
        return path, result
    output = path.parent / 'normalized.m4a'
    checked_output(['ffmpeg', '-v', 'error', '-xerror', '-nostdin',
                    '-protocol_whitelist', 'file', '-i', str(path), '-map', '0:a:0',
                    '-vn', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
                    str(output)], path.parent, 120, cancelled)
    normalized = verify(output, cancelled)
    path.unlink()
    return output, normalized


def interrupted(signum, frame):
    raise KeyboardInterrupt


@contextmanager
def prepared(value, cancelled=None, wait=False, limits=None, normalize_audio=False):
    url = canonical_url(value)
    ROOT.mkdir(exist_ok=True)
    with (ROOT / '.lock').open('a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('BUSY') from None
        marker = ROOT / '.last-run'
        while marker.exists() and time.time() - marker.stat().st_mtime < 10:
            if not wait:
                raise ValueError('COOLDOWN')
            if cancelled and cancelled():
                raise ValueError('CANCELLED')
            time.sleep(0.2)
        if shutil.disk_usage(ROOT).free < MAX_BYTES + 128_000_000:
            raise ValueError('DISK_LIMIT')
        try:
            with tempfile.TemporaryDirectory(prefix='attempt-', dir=ROOT) as tmp:
                path, source = (download(url, Path(tmp), cancelled, limits) if cancelled
                                else download(url, Path(tmp)))
                result = verify(path, cancelled) if cancelled else verify(path)
                expected_bytes = source.get('filesize')
                if expected_bytes and result['bytes'] != expected_bytes:
                    raise ValueError('INCOMPLETE_AUDIO')
                expected_duration = source.get('duration')
                if expected_duration and abs(result['duration_seconds'] - expected_duration) > 2:
                    raise ValueError('DURATION_MISMATCH')
                if normalize_audio:
                    path, result = normalize(path, result, cancelled or (lambda: False))
                result['source'] = source
                yield path, result
        finally:
            marker.touch()


def run(value):
    with prepared(value) as (_, result):
        return result


def main():
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        result = run(sys.argv[1])
        print(json.dumps({'status': 'passed', **result, 'temporary_audio_removed': True}))
        return 0
    except KeyboardInterrupt:
        error = 'INTERRUPTED'
    except ValueError as exc:
        error = str(exc) if re.fullmatch('[A-Z_]+', str(exc)) else 'INVALID_INPUT'
    except Exception:
        error = 'VALIDATION_OR_RUNTIME_FAILED'
    print(json.dumps({'status': 'failed', 'error': error,
                      'remaining_attempts': len(list(ROOT.glob('attempt-*')))}))
    return 1


if __name__ == '__main__':
    sys.exit(main())
