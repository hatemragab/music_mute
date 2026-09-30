"""Private VideoScale adapter. Standard library only; no local source extractor."""
import base64
import hmac
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import select
import socket
import ssl
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
from official_metadata import OfficialMetadata, merge_metadata
try:
    from acquisition_limits import AcquisitionLimits, Admission, retry_seconds, wait_for_slot
except ModuleNotFoundError as error:
    if error.name != 'acquisition_limits':
        raise
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from acquisition_limits import AcquisitionLimits, Admission, retry_seconds, wait_for_slot
from acquisition_scratch import ScratchBudget, ScratchUnavailable

API_HOST = 'gate.apiscrape.net'
API_PORT = 16262
STORAGE_HOST = 's3.fr-par.scw.cloud'
MAX_BYTES = 100_000_000
MAX_DURATION_SECONDS = 1800
TASK_ID = re.compile(r'^[a-fA-F0-9-]{36}$')


class Failure(Exception):
    def __init__(self, code='IMPORT_DEPENDENCY_FAILED', status=503, retryable=False,
                 reason='The acquisition failed; inspect the last completed step and HTTP status.'):
        self.code, self.status = code, status
        self.retryable = retryable
        self.reason = reason
        super().__init__(code)


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def source_url(value):
    if (not isinstance(value, str) or len(value) > 2048
            or any(c.isspace() or ord(c) < 32 or c == '\\' for c in value)):
        raise Failure('IMPORT_INVALID_URL', 400)
    try:
        p = urlsplit(value)
        if p.scheme != 'https' or p.username or p.password or p.port or p.fragment:
            raise ValueError()
        query = parse_qs(p.query, keep_blank_values=True)
        if any(key in query for key in ('list', 'playlist', 'index', 'in')):
            raise Failure('IMPORT_SINGLE_ITEM_REQUIRED', 422)
        if p.hostname in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'):
            if p.path == '/watch' and len(query.get('v', [])) == 1:
                video = query['v'][0]
            elif re.fullmatch(r'/(shorts|embed|live)/[A-Za-z0-9_-]{11}/?', p.path):
                video = p.path.rstrip('/').rsplit('/', 1)[1]
            else:
                raise ValueError()
        elif p.hostname in ('youtu.be', 'www.youtu.be'):
            video = p.path.strip('/')
        else:
            return platform_source(p, query)
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video):
            raise ValueError()
        return 'https://www.youtube.com/watch?v=' + video
    except ValueError:
        raise Failure('IMPORT_INVALID_URL', 400) from None


def platform_source(p, query):
    """Only public item shapes, not arbitrary URLs, profiles or collections."""
    host = re.sub(r'^(www|m|web)\.', '', p.hostname or '')
    patterns = {
        'instagram.com': r'/(?:p|reel|reels)/[A-Za-z0-9_-]+/?',
        'tiktok.com': r'/@[A-Za-z0-9_.]+/video/[0-9]+/?',
        'vm.tiktok.com': r'/[A-Za-z0-9]+/?',
        'vt.tiktok.com': r'/[A-Za-z0-9]+/?',
        'vimeo.com': r'/[0-9]+/?',
        'player.vimeo.com': r'/video/[0-9]+/?',
        'soundcloud.com': r'/(?!discover/|charts/|search/|you/|stations/)[A-Za-z0-9_-]+/(?!sets/?$|likes/?$|reposts/?$|tracks/?$)[A-Za-z0-9_-]+/?',
        'on.soundcloud.com': r'/[A-Za-z0-9]+/?',
        'facebook.com': r'/(?:share/(?:v|r)/[A-Za-z0-9]+|reel/[0-9]+|[A-Za-z0-9_.-]+/videos/(?:[A-Za-z0-9_.-]+/)?[0-9]+)/?',
        'mixcloud.com': r'/(?!discover/|categories/|live/)[A-Za-z0-9_-]+/(?!stream/?$|listens/?$|uploads/?$|favorites/?$|playlists/?$)[A-Za-z0-9_-]+/?',
        'hearthis.at': r'/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+/?',
        'clyp.it': r'/[a-z0-9]+/?',
        'vocaroo.com': r'/(?:embed/)?[A-Za-z0-9_]+/?',
        'whyp.it': r'/tracks/(?:[0-9]{5,}/)?[A-Za-z0-9_-]+/?',
    }
    if re.fullmatch(r'[a-z0-9-]+\.bandcamp\.com', host):
        patterns[host] = r'/track/[A-Za-z0-9_-]+/?'
    if host not in patterns:
        raise Failure('IMPORT_UNSUPPORTED_PROVIDER', 422,
                      reason='Source host is outside the enabled platform allowlist.')
    if host == 'facebook.com' and p.path in ('/watch', '/watch/', '/video.php'):
        ids = query.get('v', [])
        if len(ids) == 1 and re.fullmatch(r'[0-9]+', ids[0]):
            return 'https://www.facebook.com/watch?v=' + ids[0]
    elif re.fullmatch(patterns[host], p.path):
        # Drop trackers and private access tokens. Never resolve source redirects locally.
        return urlunsplit(('https', host, p.path, '', ''))
    raise Failure('IMPORT_SINGLE_ITEM_REQUIRED', 422,
                  reason='Expected a public single-item URL, not a profile, collection or private link.')


def source_site(url):
    host = urlsplit(url).hostname or ''
    for site in ('youtube', 'instagram', 'tiktok', 'vimeo', 'soundcloud', 'facebook',
                 'bandcamp', 'mixcloud', 'vocaroo'):
        if host == site + '.com' or host.endswith('.' + site + '.com'):
            return site
    return {'youtu.be': 'youtube', 'www.youtu.be': 'youtube', 'hearthis.at': 'hearthisat',
            'clyp.it': 'clyp', 'whyp.it': 'whyp'}.get(host, 'unknown')


def storage_url(value):
    if not isinstance(value, str) or len(value) > 8192:
        raise Failure(reason='Delivery URL is missing, invalid or too long.')
    try:
        p = urlsplit(value)
        if (p.scheme not in ('http', 'https') or p.hostname != STORAGE_HOST
                or p.username or p.password or p.port or p.fragment
                or any(c.isspace() or ord(c) < 32 or c == '\\' for c in value)):
            raise ValueError()
        # Qualified provider currently returns HTTP signed URLs. Upgrade only
        # this exact storage host; certificate verification remains mandatory.
        return urlunsplit(('https', p.netloc, p.path, p.query, ''))
    except ValueError:
        raise Failure(reason='Delivery URL failed the HTTPS storage-host security policy.') from None


class PublicTLS(http.client.HTTPSConnection):
    """Resolve once, reject non-public DNS answers, connect pinned IP with SNI."""
    def connect(self):
        candidates = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)
        for _, _, _, _, address in candidates:
            ip = ipaddress.ip_address(address[0])
            if (not ip.is_global or ip.is_multicast or ip.is_reserved
                    or getattr(ip, 'ipv4_mapped', None)
                    or getattr(ip, 'sixtofour', None) or getattr(ip, 'teredo', None)
                    or ip in ipaddress.ip_network('64:ff9b::/96')
                    or ip in ipaddress.ip_network('64:ff9b:1::/48')):
                raise Failure(reason='Upstream DNS returned a non-public address; connection blocked.')
        for family, kind, proto, _, address in candidates:
            sock = socket.socket(family, kind, proto)
            sock.settimeout(self.timeout)
            try:
                sock.connect(address)
                self.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=self.host)
                return
            except OSError:
                sock.close()
        raise Failure(reason='Could not establish a verified TLS connection to any upstream address.')


def select_format(formats, limit, rejected=None):
    if not isinstance(formats, list) or len(formats) > 1000:
        raise Failure(reason='Format discovery returned an invalid list or more than 1000 formats.')
    choices = []
    oversized = False
    def reject(reason):
        if rejected is not None:
            rejected[reason] = rejected.get(reason, 0) + 1
    for f in formats:
        if not isinstance(f, dict):
            reject('invalid_entry')
            continue
        reason = None
        if f.get('vcodec') != 'none':
            reason = 'not_separate_audio'
        elif f.get('has_drm') is True:
            reason = 'drm'
        elif (f.get('ext'), f.get('acodec')) not in (
                ('m4a', 'mp4a.40.2'), ('m4a', 'mp4a.40.5'), ('webm', 'opus'), ('mp3', 'mp3')):
            reason = 'unsupported_codec_container'
        elif f.get('protocol') not in ('https', 'm3u8_native', 'http_dash_segments'):
            reason = 'unsupported_protocol'
        elif (not isinstance(f.get('format_id'), str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', f['format_id'])):
            reason = 'invalid_format_id'
        if reason:
            reject(reason)
            continue
        channels, bitrate = f.get('audio_channels'), f.get('abr')
        # VideoScale can omit optional quality metadata. Missing is not evidence
        # of an unusable stream; keep it as a fallback for independent NestJS
        # validation. Explicit invalid/out-of-policy values still exclude it.
        if channels is not None and (not finite(channels) or channels not in (1, 2)):
            reject('channel_limit')
            continue
        if bitrate is not None and (not finite(bitrate) or not 0 < bitrate <= 160):
            reject('bitrate_limit')
            continue
        size = f.get('filesize') or f.get('filesize_approx')
        if finite(size) and size > limit:
            oversized = True
            reject('byte_limit')
            continue
        choices.append(f)
    if not choices:
        raise Failure('IMPORT_TOO_LARGE' if oversized else 'IMPORT_UNSUPPORTED_AUDIO_SOURCE', 422,
                      reason=('Eligible audio exceeds the byte limit.' if oversized else
                              'No eligible separate audio: check video/DRM, codec, protocol, format ID and quality limits.'))
    # Prefer WebM/Opus, then MP3, then M4A. Never require a fixed
    # format ID (including 140) or invent one absent from the provider response.
    return max(choices, key=lambda f: (
        {'webm': 2, 'mp3': 1, 'm4a': 0}[f['ext']],
        finite(f.get('audio_channels')) and finite(f.get('abr')),
        '-drc' not in f['format_id'], f.get('abr') or 0))


def metadata(f, site='youtube'):
    result = {'schema_version': 1, 'provider': 'videoscale', 'site': site}
    for source, target in [('format_id', 'format_id'), ('ext', 'extension'),
                           ('acodec', 'audio_codec'), ('container', 'container'),
                           ('language', 'language')]:
        value = f.get(source)
        if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', value):
            result[target] = value
    for source, target, maximum in [('abr', 'bitrate_kbps', 10000), ('asr', 'sample_rate_hz', 384000),
                                    ('audio_channels', 'audio_channels', 32),
                                    ('filesize', 'provider_file_bytes', MAX_BYTES)]:
        value = f.get(source)
        if finite(value) and 0 < value <= maximum:
            result[target] = value
    return result


class Provider:
    def __init__(self, authorization, check, connection=PublicTLS, log=None, admission=None):
        self.authorization, self.check, self.connection = authorization, check, connection
        self.stage = 'formats'
        self.http_status = None
        self.task_status = None
        self.task_status_shape = None
        self.read_retries = 0
        self.log = log or (lambda **fields: None)
        self.poll_count = 0
        self.unknown_polls = 0
        self.selected = None
        self.rejected_formats = {}
        self.read_connection = None
        self.admission = admission or Admission()

    def close(self):
        conn, self.read_connection = self.read_connection, None
        if conn is not None:
            conn.close()

    def step(self, stage, message, **fields):
        self.stage = stage
        self.http_status = None
        self.log(message=message, **self.diagnostics(), **fields)

    def diagnostics(self):
        return {'stage': self.stage, 'upstream_http_status': self.http_status,
                'task_status': self.task_status, 'task_status_shape': self.task_status_shape,
                'read_retries': self.read_retries,
                'poll_count': self.poll_count, 'selected_format': self.selected,
                'unknown_polls': self.unknown_polls,
                'rejected_formats': self.rejected_formats}

    def pause(self, seconds):
        for _ in range(int(seconds * 4)):
            self.check()
            time.sleep(0.25)
        self.check()

    def retry_read(self, seconds):
        # One operation-wide budget in addition to per-request limits/deadline.
        if self.read_retries >= 4:
            return False
        self.read_retries += 1
        self.log(message='Retrying a read-only request; no new download task is submitted.',
                 delay_seconds=seconds, **self.diagnostics())
        self.pause(seconds)
        return True

    def request(self, path, body=None):
        for attempt in range(3):
            try:
                return self._request(path, body)
            except Failure as error:
                if (body is not None or not error.retryable or attempt == 2
                        or not self.retry_read(attempt + 1)):
                    raise

    def _request(self, path, body=None):
        self.check()
        self.http_status = None
        started = time.monotonic()
        reused = (body is None and self.read_connection is not None
                  and self.read_connection.sock is not None)
        if body is None and not reused:
            self.close()
        # A paid POST must never use an idle socket or share its transport with
        # retried reads. Only this acquisition owns the retained GET connection.
        conn = self.read_connection if reused else self.connection(API_HOST, API_PORT, timeout=25)
        retain = False
        response_headers_ms = None
        try:
            if body is not None:
                # Dedicated transport connects before the paid-start window;
                # DNS/TLS delays cannot release an oversized paid burst later.
                conn.connect()
                self.check()
                self.admission.reserve(self.check)
                self.check()
            headers = {'Authorization': self.authorization, 'Accept': 'application/json',
                       'Accept-Encoding': 'identity'}
            if body is not None:
                headers['Content-Type'] = 'application/json'
            conn.request('POST' if body is not None else 'GET', path,
                         json.dumps(body).encode() if body is not None else None, headers)
            response = conn.getresponse()
            response_headers_ms = round((time.monotonic() - started) * 1000)
            self.http_status = response.status
            if response.status == 429:
                self.admission.cooldown(retry_seconds(response.getheader('Retry-After')))
            if response.status in (403, 429):
                raise Failure('IMPORT_UPSTREAM_REFUSED', 502,
                              reason='VideoScale refused access (403) or rate-limited the request (429); no automatic retry.')
            if response.status == 404:
                raise Failure('IMPORT_SOURCE_UNAVAILABLE', 422,
                              reason='VideoScale returned HTTP 404 at this step; this alone does not prove the source was deleted.')
            if response.status not in (200, 202):
                raise Failure(retryable=response.status in (500, 502, 503, 504),
                              reason=('VideoScale rejected the configured API credential.' if response.status == 401
                                      else 'VideoScale returned an unexpected HTTP status; inspect upstream_http_status.'))
            payload = bytearray()
            while True:
                self.check()
                chunk = response.read1(65536)
                if not chunk:
                    break
                payload.extend(chunk)
                if len(payload) > 1_048_576:
                    raise Failure(reason='VideoScale JSON response exceeded the 1 MiB safety limit.')
            # read1() can return EOF without raising IncompleteRead when the
            # advertised Content-Length has not arrived, even with valid JSON.
            if response.length is not None and response.length != 0:
                raise Failure(retryable=True, reason='VideoScale JSON response ended before its Content-Length.')
            try:
                result = json.loads(payload)
            except (ValueError, UnicodeError):
                raise Failure(reason='VideoScale returned invalid JSON.') from None
            # EOF above is required before reuse. Server-close responses and
            # failed/malformed/partial responses always discard the connection.
            retain = body is None and not response.will_close and conn.sock is not None
            return result
        except (TimeoutError, ConnectionResetError, ConnectionRefusedError,
                BrokenPipeError, ssl.SSLEOFError, http.client.RemoteDisconnected, http.client.IncompleteRead):
            raise Failure(retryable=True, reason='Upstream connection timed out, disconnected or returned an incomplete response.') from None
        finally:
            if retain:
                self.read_connection = conn
            else:
                if self.read_connection is conn:
                    self.read_connection = None
                conn.close()
            self.log(message='VideoScale request ended; duration excludes local retry and polling waits.',
                     request_method='POST' if body is not None else 'GET',
                     request_duration_ms=round((time.monotonic() - started) * 1000),
                     response_headers_ms=response_headers_ms,
                     reused_connection=reused, **self.diagnostics())

    def acquire(self, url, limit, output):
        try:
            return self._acquire(url, limit, output)
        finally:
            self.close()

    def _acquire(self, url, limit, output):
        site = source_site(url)
        self.step('formats', 'Discovering available formats using GET /api/formats.', site=site)
        for attempt in range(2):
            formats = self.request('/api/formats?' + urlencode({'video_url': url}))
            self.log(message='Format discovery response received; selecting separate audio.',
                     format_count=len(formats) if isinstance(formats, list) else None,
                     **self.diagnostics())
            try:
                self.rejected_formats = {}
                selected = select_format(formats, limit, self.rejected_formats)
                break
            except Failure as error:
                # Empty/incomplete lists were observed for previously working
                # items. Recheck once; never relax native audio/DRM/size guards.
                if (error.code != 'IMPORT_UNSUPPORTED_AUDIO_SOURCE' or attempt
                        or not self.retry_read(1)):
                    raise
        # No retries: the provider does not advertise an idempotency contract.
        self.selected = metadata(selected, site)
        self.step('task-create', 'Selected audio format; submitting POST /api/download exactly once.')
        task = self.request('/api/download', {'url': url, 'format_id': selected['format_id']})
        task_id = task.get('task_id') if isinstance(task, dict) else None
        if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id):
            raise Failure(reason='Download creation did not return a valid task ID; POST is not retried to avoid duplicate charges.')
        submitted = time.monotonic()
        unknown_since = None
        missing_status_polls = 0
        self.step('task-status', 'Download task accepted; waiting for completion using GET /api/status/{task_id}.')
        while True:
            self.check()
            self.poll_count += 1
            try:
                status = self.request('/api/status/' + task_id)
            except Failure as error:
                # A freshly returned task can briefly be absent from the status
                # endpoint. Retry only this read, never the paid submission.
                if (error.code != 'IMPORT_SOURCE_UNAVAILABLE' or time.monotonic() - submitted >= 10
                        or not self.retry_read(missing_status_polls + 1)):
                    raise
                missing_status_polls += 1
                # retry_read already waited; do not add the normal pending
                # two-second pause before checking the same accepted task.
                continue
            if not isinstance(status, dict):
                raise Failure(reason='Task status response was not a JSON object.')
            # No provider messages/URLs or arbitrary status strings in logs.
            previous_status = self.task_status
            raw_status = status.get('status')
            self.task_status_shape = (
                'missing' if 'status' not in status else
                'literal_unknown' if raw_status == 'unknown' else
                'string' if isinstance(raw_status, str) else 'invalid_type')
            self.task_status = (status.get('status') if status.get('status') in
                                ('completed', 'queued', 'processing', 'pending', 'downloading',
                                 'failed', 'error', 'cancelled', 'canceled') else 'unknown')
            if self.task_status != previous_status or self.poll_count % 15 == 0:
                self.log(message='Provider task state observed; only completed authorizes audio delivery.', **self.diagnostics())
            if status.get('status') == 'completed':
                break
            if self.task_status in ('failed', 'error', 'cancelled', 'canceled'):
                raise Failure('IMPORT_SOURCE_UNAVAILABLE', 422,
                              reason='VideoScale task failed or was cancelled; raw provider text is withheld.')
            if self.task_status == 'unknown':
                if unknown_since is None:
                    unknown_since = time.monotonic()
                self.unknown_polls += 1
                self.log(message='Task state is not recognized; checking the same task for at most 60 seconds or 30 rechecks, without resubmission.',
                         **self.diagnostics())
                if self.unknown_polls > 30 or time.monotonic() - unknown_since >= 60:
                    raise Failure(reason='VideoScale task state remained unrecognized beyond its bounded status window; no second task was submitted.')
                self.pause(2)
                continue
            self.pause(2)
        self.step('delivery-url', 'Task completed; resolving delivery using GET /api/download/{task_id}.')
        delivery = self.request('/api/download/' + task_id)
        url = storage_url(delivery.get('download_url') if isinstance(delivery, dict) else None)
        p = urlsplit(url)
        self.close()
        self.step('audio-transfer', 'Delivery host validated; downloading audio over HTTPS without vendor credentials.')
        started = time.monotonic()
        response_headers_ms = None
        conn = self.connection(STORAGE_HOST, 443, timeout=25)
        try:
            # Never forward provider credentials or formats' http_headers.
            conn.request('GET', p.path + ('?' + p.query if p.query else ''),
                         headers={'Accept-Encoding': 'identity'})
            response = conn.getresponse()
            response_headers_ms = round((time.monotonic() - started) * 1000)
            self.http_status = response.status
            if response.status != 200 or response.getheader('Content-Encoding', 'identity') != 'identity':
                raise Failure(reason='Audio delivery returned a non-200 status or unsupported content encoding.')
            length = response.getheader('Content-Length')
            if length is not None and (not length.isdigit() or int(length) > limit):
                raise Failure('IMPORT_TOO_LARGE', 422, reason='Audio Content-Length is invalid or exceeds the byte limit.')
            size = 0
            while True:
                self.check()
                chunk = response.read1(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise Failure('IMPORT_TOO_LARGE', 422, reason='Actual audio bytes exceeded the byte limit; transfer stopped.')
                output.write(chunk)
            if size == 0 or (length is not None and size != int(length)):
                raise Failure('IMPORT_INVALID_AUDIO', 422, reason='Audio delivery was empty or shorter than Content-Length.')
            self.log(message='Audio downloaded completely into bounded temporary storage.', file_bytes=size,
                     **self.diagnostics())
            return size, metadata(selected, site)
        finally:
            conn.close()
            self.log(message='Audio transfer ended; connection was isolated from vendor authentication.',
                     request_method='GET',
                     request_duration_ms=round((time.monotonic() - started) * 1000),
                     response_headers_ms=response_headers_ms,
                     reused_connection=False, **self.diagnostics())


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'AudioAcquisition/1'

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_args):
        pass

    def reply(self, status, content, content_type='application/problem+json', extra=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        if status == 401:
            self.send_header('WWW-Authenticate', 'Bearer')
        if status == 503:
            self.send_header('Retry-After', '30')
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(content)
        self.close_connection = True

    def problem(self, failure):
        self.reply(failure.status, json.dumps({'type': 'about:blank', 'title': failure.code,
                                              'status': failure.status, 'code': failure.code}).encode(),
                   extra={'X-Import-Error': failure.code})

    def do_GET(self):
        if self.path == '/health':
            self.reply(200, b'{"status":"ok"}', 'application/json')
        else:
            self.problem(Failure('IMPORT_NOT_FOUND', 404))

    def do_POST(self):
        acquired = False
        streaming = False
        started = time.monotonic()
        result = 'IMPORT_DEPENDENCY_FAILED'
        message = 'Import did not complete.'
        acquisition_id = str(uuid.uuid4())
        provider = None
        exception_type = None
        code_line = None
        try:
            if self.path != '/audio-imports':
                raise Failure('IMPORT_NOT_FOUND', 404, reason='Unknown adapter route; use POST /audio-imports.')
            supplied = self.headers.get('Authorization', '').encode()
            if not hmac.compare_digest(supplied, ('Bearer ' + self.server.api_key).encode()):
                raise Failure('IMPORT_UNAUTHORIZED', 401, reason='NestJS service key is missing or does not match the adapter key.')
            supplied_id = self.headers.get('X-Import-Request-ID', '')
            if TASK_ID.fullmatch(supplied_id):
                acquisition_id = supplied_id
            if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
                raise Failure('IMPORT_INVALID_REQUEST', 415)
            lengths = self.headers.get_all('Content-Length', [])
            if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not lengths[0].isdigit():
                raise Failure('IMPORT_INVALID_REQUEST', 400)
            length = int(lengths[0])
            if not 1 <= length <= 4096:
                raise Failure('IMPORT_INVALID_REQUEST', 413)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict) or set(body) != {'url', 'max_bytes', 'max_duration_seconds'}:
                raise Failure('IMPORT_INVALID_REQUEST', 400)
            limit, duration = body['max_bytes'], body['max_duration_seconds']
            if (type(limit) is not int or not 1 <= limit <= MAX_BYTES
                    or not finite(duration) or not 0 < duration <= MAX_DURATION_SECONDS):
                raise Failure('IMPORT_INVALID_REQUEST', 400)
            url = source_url(body['url'])
            def check():
                if time.monotonic() - started > 600:
                    raise Failure(reason='The 600-second acquisition deadline expired; no further upstream requests will be made.')
                if select.select([self.connection], [], [], 0)[0]:
                    # Client cancellation closes this dedicated HTTP connection.
                    if not self.connection.recv(1, socket.MSG_PEEK):
                        raise ConnectionAbortedError()

            wait_for_slot(self.server.slots, check)
            acquired = True
            try:
                reservation = self.server.scratch_budget.reserve(limit)
            except ScratchUnavailable:
                raise Failure('IMPORT_DISK_FULL', 503,
                              reason='Dedicated scratch cannot safely reserve the requested audio bytes.') from None
            # Unlinked immediately by TemporaryFile: crash/restart cannot leave
            # named media orphans. Deployment mounts this directory as tmpfs.
            with reservation, tempfile.TemporaryFile(dir=self.server.scratch) as audio:
                def log(**fields):
                    print(json.dumps({'event': 'audio-acquisition-step', 'acquisition_id': acquisition_id,
                                      'elapsed_ms': round((time.monotonic() - started) * 1000),
                                      **fields}), flush=True)

                provider = Provider(self.server.provider_auth, check, log=log, admission=self.server.admission)
                title_lookup = self.server.metadata.start(url)
                size, extra = provider.acquire(url, limit, reservation.wrap(audio))
                extra = merge_metadata(extra, title_lookup)
                log(stage='metadata', message='Optional official metadata lookup finished or skipped; audio acquisition is not retried.',
                    metadata_ready=title_lookup.done(), has_title='title' in extra)
                provider.step('backend-transfer', 'Sending acquired audio to NestJS for independent validation and S3 upload.')
                check()
                audio.seek(0)
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(size))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Connection', 'close')
                self.send_header('X-Import-Extra-Data-Base64', base64.b64encode(json.dumps(extra).encode()).decode())
                self.end_headers()
                streaming = True
                while chunk := audio.read(65536):
                    check()
                    self.wfile.write(chunk)
                self.close_connection = True
                result = 'SUCCEEDED'
                message = 'Audio sent to NestJS; adapter scratch released. NestJS validation/processing is a separate step.'
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            result = 'CLIENT_DISCONNECTED'
            message = 'NestJS connection closed; local acquisition stopped. An already submitted vendor task may still run.'
        except Exception as error:
            # Code location only: never serialize exceptions, locals or source lines.
            exception_type = type(error).__name__
            frame = error.__traceback__
            while frame:
                if frame.tb_frame.f_code.co_filename == __file__:
                    code_line = frame.tb_lineno
                frame = frame.tb_next
            failure = error if isinstance(error, Failure) else Failure()
            if isinstance(error, (json.JSONDecodeError, UnicodeError)):
                failure = Failure('IMPORT_INVALID_REQUEST', 400)
            result = failure.code
            message = failure.reason
            if not isinstance(error, Failure):
                message = 'Unexpected adapter exception; inspect exception_type and code_line. Raw exception text is withheld.'
            try:
                if not streaming:
                    self.problem(failure)
            except OSError:
                pass
        finally:
            self.close_connection = True
            if acquired:
                self.server.slots.release()
            print(json.dumps({'event': 'audio-acquisition', 'result': result,
                              'message': message,
                              'exception_type': exception_type, 'code_line': code_line,
                              'acquisition_id': acquisition_id,
                              **(provider.diagnostics() if provider else {'stage': 'admission'}),
                              'duration_ms': round((time.monotonic() - started) * 1000)}), flush=True)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    metadata = OfficialMetadata(PublicTLS)
    request_queue_size = 64
    # Bound even unauthenticated slow-client handler threads.
    threads = threading.BoundedSemaphore(64)

    def process_request(self, request, client_address):
        if not self.threads.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.threads.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.threads.release()

    def handle_error(self, *_args):
        pass


def main():
    key = os.environ.get('AUDIO_ACQUISITION_API_KEY', '')
    basic = os.environ.get('VIDEOSCALE_BASIC_AUTH', '')
    if not 32 <= len(key) <= 256 or not re.fullmatch(r'Basic [A-Za-z0-9+/=]+', basic):
        raise SystemExit('Missing valid acquisition credentials')
    scratch = os.environ.get('ACQUISITION_TEMP_ROOT', '/work')
    if not os.path.isdir(scratch) or os.path.islink(scratch) or scratch in ('/', '/tmp'):
        raise SystemExit('Dedicated acquisition scratch directory required')
    limits = AcquisitionLimits.from_env()
    server = Server(('0.0.0.0', 8080), Handler)
    server.api_key, server.provider_auth, server.scratch = key, basic, scratch
    server.slots = threading.BoundedSemaphore(limits.concurrency)
    server.admission = Admission(limits.requests_per_second)
    server.scratch_budget = ScratchBudget(scratch)
    print('Private audio acquisition ready', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
