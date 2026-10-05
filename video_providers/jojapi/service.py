"""Private JoJAPI adapter. Standard library only; no local media extractor."""
import base64
from concurrent.futures import Future, TimeoutError as FutureTimeout
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
from urllib.parse import parse_qs, unquote, urlencode, urlsplit

from official_metadata import OfficialMetadata, merge_metadata
try:
    from acquisition_limits import AcquisitionLimits, Admission as SharedAdmission, retry_seconds, wait_for_slot
except ModuleNotFoundError as error:
    if error.name != 'acquisition_limits':
        raise
    # Deployment bundles the shared module beside this file; direct local
    # execution uses its single source in the provider directory instead.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from acquisition_limits import AcquisitionLimits, Admission as SharedAdmission, retry_seconds, wait_for_slot
from acquisition_scratch import ScratchBudget, ScratchUnavailable

API_HOST = 'wgvkv.jojapi.net'
MAX_BYTES = 100_000_000
MAX_DURATION_SECONDS = 1800
DEADLINE_SECONDS = 150
REQUEST_ID = re.compile(r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')
CONTENT_TYPES = {'webm': {'audio/webm', 'video/webm', 'application/octet-stream'},
                 'm4a': {'audio/mp4', 'audio/x-m4a', 'application/octet-stream'}}
# JoJAPI's published plans currently allow one paid request per second.
# The shared router may admit five, but this adapter always caps vendor starts.
MAX_PROVIDER_REQUESTS_PER_SECOND = 1
MIN_PROVIDER_START_INTERVAL = 1.1
MEDIA_CHUNK_BYTES = 10 * 1024 * 1024
MAX_MEDIA_REDIRECTS = 3
MEDIA_REDIRECT_STATUSES = frozenset((301, 302, 303, 307, 308))
DELIVERY_HEADERS = {'user-agent': ('User-Agent', 512), 'accept': ('Accept', 1024),
                    'accept-language': ('Accept-Language', 128),
                    'sec-fetch-mode': ('Sec-Fetch-Mode', 32), 'cookie': ('Cookie', 4096)}
# RFC 6265 request syntax: token names and unquoted or quoted cookie-octets.
# A Cookie header carries no Domain/Path attributes, so it is host-scoped below.
COOKIE_OCTETS = r'[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*'
COOKIE_PAIR = r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+=(?:" + COOKIE_OCTETS + '|"' + COOKIE_OCTETS + '")'
MEDIA_COOKIE = re.compile(COOKIE_PAIR + '(?:; ' + COOKIE_PAIR + ')*')
# Twenty acquisitions plus one nonfatal metadata lookup can resolve concurrently.
# Separate from HTTP handlers; stalled OS resolvers cannot accumulate threads.
DNS_SLOT = threading.BoundedSemaphore(21)


class Admission(SharedAdmission):
    """JoJAPI one-start plan cap with a conservative 1.1-second spacing margin."""
    def __init__(self, requests_per_second=MAX_PROVIDER_REQUESTS_PER_SECOND,
                 clock=time.monotonic, sleep=time.sleep):
        AcquisitionLimits(requests_per_second=requests_per_second)
        super().__init__(min(requests_per_second, MAX_PROVIDER_REQUESTS_PER_SECOND), clock, sleep)
        self.last_started = None

    def reserve(self, check=lambda: None):
        while True:
            check()
            with self.lock:
                now = self.clock()
                while self.started and self.started[0] <= now - 1:
                    self.started.popleft()
                wait = self.cooldown_until - now
                if self.last_started is not None:
                    wait = max(wait, self.last_started + MIN_PROVIDER_START_INTERVAL - now)
                if wait <= 0:
                    self.started.append(now)
                    self.last_started = now
                    return
            self.sleep(min(wait, 0.1))


class Failure(Exception):
    def __init__(self, code='IMPORT_DEPENDENCY_FAILED', status=503,
                 reason='Audio acquisition failed; upstream details are withheld.', retry_after=30):
        self.code, self.status, self.reason = code, status, reason
        self.retry_after = max(1, min(int(retry_after), 86400))
        super().__init__(code)


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def source_url(value):
    """Canonical single YouTube item only; never resolve a source redirect."""
    if (not isinstance(value, str) or len(value) > 2048
            or any(c.isspace() or ord(c) < 32 or c == '\\' for c in value)):
        raise Failure('IMPORT_INVALID_URL', 400)
    try:
        p = urlsplit(value)
        if p.scheme != 'https' or p.username or p.password or p.port or p.fragment:
            raise ValueError()
        query = parse_qs(p.query, keep_blank_values=True)
        if p.hostname in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'):
            if p.path == '/playlist':
                raise Failure('IMPORT_SINGLE_ITEM_REQUIRED', 422)
            if p.path in ('/watch', '/watch/') and len(query.get('v', [])) == 1:
                video = query['v'][0]
            elif re.fullmatch(r'/(shorts|embed|live)/[A-Za-z0-9_-]{11}/?', p.path):
                video = p.path.rstrip('/').rsplit('/', 1)[1]
            else:
                raise ValueError()
        elif p.hostname in ('youtu.be', 'www.youtu.be'):
            video = p.path.strip('/')
        else:
            if any(key in query for key in ('list', 'playlist', 'index', 'in')):
                raise Failure('IMPORT_SINGLE_ITEM_REQUIRED', 422)
            raise Failure('IMPORT_UNSUPPORTED_PROVIDER', 422,
                          reason='JoJAPI accepts YouTube single-item URLs only.')
        ids = query.get('v', [])
        if (not re.fullmatch(r'[A-Za-z0-9_-]{11}', video)
                or len(ids) > 1 or (ids and ids[0] != video)):
            raise ValueError()
        # Playlist/radio context does not change an explicitly selected video.
        return 'https://www.youtube.com/watch?v=' + video
    except ValueError:
        raise Failure('IMPORT_INVALID_URL', 400) from None


def delivery_url(value, secrets=()):
    """Validate every Google HTTPS media hop; never an arbitrary host/path."""
    if (not isinstance(value, str) or len(value) > 8192
            or any(c.isspace() or ord(c) < 32 or ord(c) == 127 or c == '\\' for c in value)):
        raise Failure(reason='Invalid signed delivery URL.')
    # Signed media query strings are legitimate and must not be generically
    # rejected. Only exact known runtime credentials are forbidden, including
    # percent-encoded reflection into a request target or relocation Location.
    decoded = unquote(value)
    if any(secret and (secret in value or secret in decoded) for secret in secrets):
        raise Failure(reason='A runtime credential appeared in a media delivery URL; blocked.')
    try:
        p = urlsplit(value)
        host = p.hostname or ''
        if (p.scheme != 'https' or not host.endswith('.googlevideo.com')
                or not re.fullmatch(r'[a-z0-9-]+(?:\.[a-z0-9-]+)*\.googlevideo\.com', host)
                or p.netloc != host or p.path != '/videoplayback'
                or p.username or p.password or p.port or p.fragment or not p.query):
            raise ValueError()
        return p
    except ValueError:
        raise Failure(reason='Delivery URL failed the Google media host and path policy.') from None


def secret_value(value, secrets=()):
    """Prevent known credentials or credential-shaped values entering outbound data."""
    return (isinstance(value, str)
            and (re.search(r'jk_[A-Za-z0-9_-]+|Bearer\s|Basic\s|X-Amz-|Signature=', value, re.I)
                 or any(secret and secret in value for secret in secrets)))


def delivery_headers(payload, secrets=()):
    """Copy bounded vendor browser headers and host-scoped media cookies only."""
    supplied = payload.get('http_headers', {})
    if not isinstance(supplied, dict) or len(supplied) > 32:
        raise Failure(reason='Provider returned invalid media headers.')
    result = {'Accept-Encoding': 'identity'}
    for name, value in supplied.items():
        rule = DELIVERY_HEADERS.get(name.lower()) if isinstance(name, str) else None
        if rule is None:
            continue
        canonical, maximum = rule
        if (canonical in result or not isinstance(value, str) or not 1 <= len(value) <= maximum
                or not value.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in value)
                or secret_value(value, secrets)
                or (canonical == 'Cookie' and (not MEDIA_COOKIE.fullmatch(value)
                                               or secret_value(unquote(value), secrets)))):
            raise Failure(reason='Provider returned an unsafe media header.')
        result[canonical] = value
    return result


def validate_format(payload):
    """The download endpoint must return one unencrypted native audio format."""
    if (not isinstance(payload, dict) or payload.get('vcodec') != 'none'
            or payload.get('has_drm') is not False
            or (payload.get('ext'), payload.get('acodec')) not in (
                ('webm', 'opus'), ('m4a', 'mp4a.40.2'), ('m4a', 'mp4a.40.5'))
            or payload.get('protocol') != 'https'
            or payload.get('video_ext', 'none') != 'none'
            or any(payload.get(key) not in (None, 0) for key in ('width', 'height', 'fps', 'vbr'))
            or not isinstance(payload.get('format_id'), str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', payload['format_id'])):
        raise Failure('IMPORT_UNSUPPORTED_AUDIO_SOURCE', 422,
                      reason='Provider did not return one eligible unencrypted native audio format.')
    for field, maximum in (('abr', 10000), ('asr', 384000), ('audio_channels', 32)):
        value = payload.get(field)
        if value is not None and (not finite(value) or not 0 < value <= maximum):
            raise Failure('IMPORT_UNSUPPORTED_AUDIO_SOURCE', 422,
                          reason='Provider returned invalid audio format metadata.')
    return payload


def public_addresses(host, port, timeout):
    """Bound DNS time and threads even if the system resolver stalls."""
    if not DNS_SLOT.acquire(blocking=False):
        raise Failure(reason='A bounded upstream DNS lookup is already running.')
    future = Future()

    def resolve():
        try:
            future.set_result(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM))
        except Exception as error:
            future.set_exception(error)
        finally:
            DNS_SLOT.release()
    try:
        threading.Thread(target=resolve, daemon=True).start()
    except Exception:
        DNS_SLOT.release()
        raise
    try:
        candidates = future.result(timeout=min(timeout, 10))
    except FutureTimeout:
        raise Failure(reason='The bounded upstream DNS deadline expired.') from None
    if not candidates or len(candidates) > 32:
        raise Failure(reason='Upstream DNS returned an empty or oversized address list.')
    for _, _, _, _, address in candidates:
        ip = ipaddress.ip_address(address[0])
        if (not ip.is_global or ip.is_multicast or ip.is_reserved
                or getattr(ip, 'ipv4_mapped', None)
                or getattr(ip, 'sixtofour', None) or getattr(ip, 'teredo', None)
                or ip in ipaddress.ip_network('64:ff9b::/96')
                or ip in ipaddress.ip_network('64:ff9b:1::/48')):
            raise Failure(reason='Upstream DNS returned a non-public address; connection blocked.')
    return candidates


class PublicTLS(http.client.HTTPSConnection):
    """Validate every DNS answer, pin connections, verify hostname/TLS, no redirects."""
    def connect(self):
        expires = time.monotonic() + self.timeout
        candidates = public_addresses(self.host, self.port, self.timeout)
        for family, kind, proto, _, address in candidates:
            remaining = expires - time.monotonic()
            if remaining <= 0:
                break
            sock = socket.socket(family, kind, proto)
            sock.settimeout(remaining)
            try:
                sock.connect(address)
                remaining = expires - time.monotonic()
                if remaining <= 0:
                    sock.close()
                    break
                sock.settimeout(remaining)
                self.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=self.host)
                return
            except ssl.SSLCertVerificationError:
                sock.close()
                raise
            except OSError:
                sock.close()
        raise Failure(reason='Could not establish a verified public TLS connection.')


def response_length(response, maximum):
    lengths = response.headers.get_all('Content-Length', [])
    encoding = response.getheader('Transfer-Encoding')
    if (len(lengths) > 1 or (encoding and lengths)
            or (encoding and encoding.lower() != 'chunked')):
        raise Failure(reason='Upstream response framing is ambiguous.')
    if not lengths:
        return None
    if not lengths[0].isdigit():
        raise Failure(reason='Upstream Content-Length is invalid.')
    length = int(lengths[0])
    if length > maximum:
        raise Failure('IMPORT_TOO_LARGE', 422, reason='Upstream bytes exceed the request limit.')
    return length


def range_length(response, start, end, total):
    """Accept exactly one contiguous requested native-media byte span."""
    supplied = response.headers.get_all('Content-Range', [])
    if (len(supplied) != 1 or len(supplied[0]) > 128
            or not re.fullmatch(r'bytes [0-9]+-[0-9]+/[0-9]+', supplied[0])):
        raise Failure('IMPORT_INVALID_AUDIO', 422, reason='Partial media has invalid Content-Range.')
    span, advertised_total = supplied[0][6:].split('/')
    actual_start, actual_end = span.split('-')
    if (int(actual_start), int(actual_end), int(advertised_total)) != (start, end, total):
        raise Failure('IMPORT_INVALID_AUDIO', 422,
                      reason='Partial media differs from its requested span or declared total.')
    return end - start + 1


def included_metadata(payload, content_type=None, secrets=()):
    result = {'schema_version': 1, 'provider': 'jojapi', 'site': 'youtube'}
    # Only actual response fields; URLs, headers and downloader options stay local.
    for source, target in [('format_id', 'format_id'), ('ext', 'extension'),
                           ('acodec', 'audio_codec'), ('container', 'container'),
                           ('language', 'language')]:
        value = payload.get(source)
        if (isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', value)
                and not secret_value(value, secrets)):
            result[target] = value
    for source, target, maximum in [('abr', 'bitrate_kbps', 10000), ('asr', 'sample_rate_hz', 384000),
                                    ('audio_channels', 'audio_channels', 32),
                                    ('filesize', 'provider_file_bytes', MAX_BYTES)]:
        value = payload.get(source)
        if finite(value) and 0 < value <= maximum:
            result[target] = value
    return result


class Provider:
    def __init__(self, key, check, admission, connection=PublicTLS, log=None, deadline=None, secrets=()):
        self.key, self.check, self.admission, self.connection = key, check, admission, connection
        self.secrets = (key, *secrets)
        self.log = log or (lambda **fields: None)
        self.stage, self.http_status = 'create', None
        self.media_redirects = 0
        self.deadline = deadline if deadline is not None else time.monotonic() + DEADLINE_SECONDS
        self.active_connection = None
        self.active_response = None

    def diagnostics(self):
        return {'stage': self.stage, 'upstream_http_status': self.http_status,
                'media_redirects': self.media_redirects}

    def step(self, stage, message):
        self.stage, self.http_status = stage, None
        self.log(message=message, **self.diagnostics())

    def guard(self):
        self.check()
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise Failure(reason='The 150-second acquisition deadline expired.')
        conn = self.active_connection
        sock = conn.sock if conn is not None else None
        if sock is None and self.active_response is not None:
            fp = self.active_response.fp
            sock = getattr(getattr(fp, 'raw', None), '_sock', None)
        if sock is not None:
            sock.settimeout(min(25, remaining))
        return min(25, remaining)

    def connect(self, host=API_HOST):
        self.guard()
        self.active_connection = self.connection(host, 443, timeout=self.guard())
        return self.active_connection

    def close(self):
        response, self.active_response = self.active_response, None
        conn, self.active_connection = self.active_connection, None
        for stream in (response, conn):
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass  # Best-effort disposal must not leak the admission slot.

    def status_error(self, response, accepted=(200,)):
        self.http_status = response.status
        if response.status == 429:
            seconds = retry_seconds(response.getheader('Retry-After'))
            self.admission.cooldown(seconds)
            raise Failure('IMPORT_DEPENDENCY_FAILED', 503,
                          reason='Provider rate limit reached; cooldown applied without replay.',
                          retry_after=seconds)
        if response.status in (404, 410):
            raise Failure('IMPORT_SOURCE_UNAVAILABLE', 422,
                          reason='Source or signed audio delivery is unavailable; no new paid request.')
        if response.status not in accepted:
            raise Failure(reason='Provider returned an unaccepted response; request is never replayed.')
        if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
            raise Failure(reason='Compressed upstream responses are not accepted.')

    def create(self, url):
        self.step('create', 'Requesting highest native audio once; no paid metadata, retries or job polling.')
        self.guard()
        conn = self.connect()
        started, headers_ms = time.monotonic(), None
        try:
            # Complete DNS/TLS first, then pace immediately before paid bytes.
            # Variable connection latency must not bunch previously reserved
            # requests into a larger provider-visible burst.
            conn.connect()
            self.guard()
            self.admission.reserve(self.guard)
            self.guard()
            video_id = parse_qs(urlsplit(source_url(url)).query)['v'][0]
            conn.request('GET', '/download?' + urlencode({'id': video_id, 'filter': 'audioonly',
                                                        'quality': 'highestaudio'}),
                         headers={'X-JoJAPI-Key': self.key,
                                  'Accept': 'application/json', 'Accept-Encoding': 'identity',
                                  'User-Agent': 'MusicMute/1.0'})
            self.guard()
            response = conn.getresponse()
            self.active_response = response
            headers_ms = round((time.monotonic() - started) * 1000)
            self.guard()
            self.status_error(response)
            # Live JoJAPI JSON is sometimes labelled text/html by its nginx gateway.
            # Accept only this observed label in addition to application/json;
            # bounded JSON decoding and strict native-format validation remain mandatory.
            if response.getheader('Content-Type', '').split(';')[0].strip().lower() not in (
                    'application/json', 'text/html'):
                raise Failure(reason='Provider creation Content-Type is not an accepted vendor JSON type.')
            length = response_length(response, 65536)
            data = bytearray()
            while True:
                self.guard()
                chunk = response.read1(16384)
                self.guard()
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > 65536:
                    raise Failure(reason='Provider JSON exceeds the bounded response size.')
            if length is not None and len(data) != length:
                raise Failure(reason='Provider JSON ended before its declared length.')
            try:
                payload = json.loads(data)
            except (ValueError, UnicodeError):
                raise Failure(reason='Provider creation returned malformed JSON.') from None
            return validate_format(payload)
        finally:
            self.close()
            self.log(message='Paid creation request ended; it is never automatically replayed.',
                     request_duration_ms=round((time.monotonic() - started) * 1000),
                     response_headers_ms=headers_ms, **self.diagnostics())

    def media_response(self, destination, headers, visited):
        """Open one media span, retaining a single redirect budget across all spans."""
        while True:
            conn = self.connect(destination.hostname)
            conn.request('GET', destination.path + '?' + destination.query, headers=headers)
            self.guard()
            response = conn.getresponse()
            self.active_response = response
            self.guard()
            self.http_status = response.status
            if response.status not in MEDIA_REDIRECT_STATUSES:
                self.status_error(response, accepted=(200, 206))
                return destination, response
            # CDN relocation is the same delivery operation, never a paid replay.
            # Every hop repeats key/host/path policy, public DNS pinning and TLS.
            locations = response.headers.get_all('Location', [])
            if len(locations) != 1 or self.media_redirects >= MAX_MEDIA_REDIRECTS:
                raise Failure(reason='Google media relocation exceeded its bounded policy.')
            target = delivery_url(locations[0], self.secrets)
            if target.geturl() in visited:
                raise Failure(reason='Google media relocation loop blocked.')
            if target.hostname != destination.hostname:
                # Only the vendor payload's Cookie may enter this request-local
                # dictionary. Without Domain scope, never carry it to another
                # Google host or restore it on later redirects/media spans.
                headers.pop('Cookie', None)
            visited.add(target.geturl())
            self.media_redirects += 1
            self.log(message='Following a validated Google CDN relocation within the original deadline.',
                     **self.diagnostics())
            self.close()
            destination = target

    def acquire(self, url, limit, output):
        self.media_redirects = 0
        payload = self.create(url)
        declared = payload.get('filesize')
        if declared is not None and (type(declared) is not int or declared < 1):
            raise Failure(reason='Provider declared an invalid audio size.')
        if declared is not None and declared > min(limit, MAX_BYTES):
            raise Failure('IMPORT_TOO_LARGE', 422, reason='Provider-declared audio exceeds the byte limit.')
        destination = delivery_url(payload.get('url'), self.secrets)
        headers = delivery_headers(payload, self.secrets)
        self.step('audio-transfer', 'Downloading bounded Google native audio without API credentials.')
        started, headers_ms = time.monotonic(), None
        visited = {destination.geturl()}
        size = 0
        try:
            # Native byte ranges avoid Google's throttled whole-file path. Each
            # span is requested once, never retried. Unknown-size media remains
            # a single bounded GET, with the backend retaining its media probe.
            starts = range(0, declared, MEDIA_CHUNK_BYTES) if declared is not None else (None,)
            for start in starts:
                end = min(declared - 1, start + MEDIA_CHUNK_BYTES - 1) if start is not None else None
                if start is not None:
                    headers['Range'] = f'bytes={start}-{end}'
                destination, response = self.media_response(destination, headers, visited)
                headers_ms = round((time.monotonic() - started) * 1000)
                full_body = response.status == 200
                if response.status == 206:
                    if start is None:
                        raise Failure('IMPORT_INVALID_AUDIO', 422,
                                      reason='Unrequested partial media cannot establish a complete audio file.')
                    expected = range_length(response, start, end, declared)
                else:
                    if start not in (None, 0) or response.headers.get_all('Content-Range', []):
                        raise Failure('IMPORT_INVALID_AUDIO', 422,
                                      reason='A later media span ignored its range; duplicate bytes blocked.')
                    expected = declared  # First ignored range may provide the complete body once.
                content_type = response.getheader('Content-Type', '').split(';')[0].strip().lower()
                if content_type not in CONTENT_TYPES[payload['ext']]:
                    raise Failure('IMPORT_UNSUPPORTED_AUDIO_SOURCE', 422,
                                  reason='Audio delivery Content-Type differs from the selected native container.')
                length = response_length(response, expected if expected is not None else limit)
                if expected is not None and length is not None and length != expected:
                    raise Failure('IMPORT_INVALID_AUDIO', 422,
                                  reason='Media span Content-Length differs from its expected byte count.')
                span_size = 0
                while True:
                    self.guard()
                    chunk = response.read1(65536)
                    self.guard()
                    if not chunk:
                        break
                    span_size += len(chunk)
                    if size + len(chunk) > limit:
                        raise Failure('IMPORT_TOO_LARGE', 422,
                                      reason='Actual audio bytes exceeded the byte limit.')
                    if expected is not None and span_size > expected:
                        raise Failure('IMPORT_INVALID_AUDIO', 422,
                                      reason='Partial media contains bytes outside its requested span.')
                    output.write(chunk)
                    size += len(chunk)
                if (span_size == 0 or (length is not None and span_size != length)
                        or (expected is not None and span_size != expected)):
                    raise Failure('IMPORT_INVALID_AUDIO', 422,
                                  reason='Audio media span was empty, truncated or differed from its declared bytes.')
                self.close()
                self.log(message='Verified one complete native media span without retry.',
                         file_bytes=size, span_bytes=span_size, **self.diagnostics())
                if full_body:
                    break  # Never append another span after a complete ignored-range response.
            if size == 0 or (declared is not None and size != declared):
                raise Failure('IMPORT_INVALID_AUDIO', 422, reason='Complete audio differs from its declared byte count.')
            self.log(message='Complete audio stored in bounded anonymous scratch for NestJS validation.',
                     file_bytes=size, **self.diagnostics())
            return size, included_metadata(payload, content_type, self.secrets)
        finally:
            self.close()
            self.log(message='Google media transfer ended; no span retry or paid fallback.',
                     request_duration_ms=round((time.monotonic() - started) * 1000),
                     response_headers_ms=headers_ms, **self.diagnostics())


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
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(content)
        self.close_connection = True

    def problem(self, failure):
        extra = {'X-Import-Error': failure.code}
        if failure.status == 503:
            extra['Retry-After'] = str(failure.retry_after)
        self.reply(failure.status, json.dumps({'type': 'about:blank', 'title': failure.code,
                                              'status': failure.status, 'code': failure.code}).encode(),
                   extra=extra)

    def do_GET(self):
        if self.path == '/health':
            self.reply(200, b'{"status":"ok"}', 'application/json')
        else:
            self.problem(Failure('IMPORT_NOT_FOUND', 404))

    def do_POST(self):
        acquired, streaming = False, False
        started = time.monotonic()
        result, message = 'IMPORT_DEPENDENCY_FAILED', 'Import did not complete.'
        acquisition_id = str(uuid.uuid4())
        provider, exception_type, code_line = None, None, None
        try:
            if self.path != '/audio-imports':
                raise Failure('IMPORT_NOT_FOUND', 404)
            supplied = self.headers.get_all('Authorization', [])
            if (len(supplied) != 1 or not hmac.compare_digest(
                    supplied[0].encode(), ('Bearer ' + self.server.api_key).encode())):
                raise Failure('IMPORT_UNAUTHORIZED', 401)
            supplied_id = self.headers.get('X-Import-Request-ID', '')
            if REQUEST_ID.fullmatch(supplied_id):
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
                remaining = DEADLINE_SECONDS - (time.monotonic() - started)
                if remaining <= 0:
                    raise Failure(reason='The 150-second acquisition deadline expired.')
                self.connection.settimeout(min(15, remaining))
                if select.select([self.connection], [], [], 0)[0]:
                    if not self.connection.recv(1, socket.MSG_PEEK):
                        raise ConnectionAbortedError()

            wait_for_slot(self.server.slots, check)
            acquired = True
            try:
                reservation = self.server.scratch_budget.reserve(limit)
            except ScratchUnavailable:
                raise Failure('IMPORT_DISK_FULL', 503,
                              reason='Dedicated scratch cannot safely reserve the requested audio bytes.') from None
            with reservation, tempfile.TemporaryFile(dir=self.server.scratch) as audio:
                def log(**fields):
                    print(json.dumps({'event': 'audio-acquisition-step', 'acquisition_id': acquisition_id,
                                      'elapsed_ms': round((time.monotonic() - started) * 1000),
                                      **fields}), flush=True)
                provider = Provider(self.server.provider_key, check, self.server.admission, log=log,
                                    deadline=started + DEADLINE_SECONDS, secrets=(self.server.api_key,))
                lookup = self.server.metadata.start(url)
                size, extra = provider.acquire(url, limit, reservation.wrap(audio))
                extra = merge_metadata(extra, lookup)
                extra = {key: value for key, value in extra.items()
                         if not secret_value(value, provider.secrets)}
                provider.step('backend-transfer', 'Sending bounded audio to NestJS for independent media validation.')
                check()
                audio.seek(0)
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(size))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Connection', 'close')
                self.send_header('X-Import-Extra-Data-Base64', base64.b64encode(json.dumps(extra).encode()).decode())
                streaming = True
                self.end_headers()
                while chunk := audio.read(65536):
                    check()
                    self.wfile.write(chunk)
                result, message = 'SUCCEEDED', 'Audio sent to NestJS; scratch released. Validation is a separate step.'
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            result, message = 'CLIENT_DISCONNECTED', 'NestJS disconnected; local work stopped without a second paid request.'
        except Exception as error:
            exception_type = type(error).__name__
            frame = error.__traceback__
            while frame:
                if frame.tb_frame.f_code.co_filename == __file__:
                    code_line = frame.tb_lineno
                frame = frame.tb_next
            failure = error if isinstance(error, Failure) else Failure()
            if isinstance(error, (json.JSONDecodeError, UnicodeError)):
                failure = Failure('IMPORT_INVALID_REQUEST', 400)
            result, message = failure.code, failure.reason
            try:
                if not streaming:
                    self.problem(failure)
            except OSError:
                pass
        finally:
            self.close_connection = True
            if provider is not None:
                provider.close()
            if acquired:
                self.server.slots.release()
            print(json.dumps({'event': 'audio-acquisition', 'result': result, 'message': message,
                              'exception_type': exception_type, 'code_line': code_line,
                              'acquisition_id': acquisition_id,
                              **(provider.diagnostics() if provider else {'stage': 'admission'}),
                              'duration_ms': round((time.monotonic() - started) * 1000)}), flush=True)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64
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
    vendor = os.environ.get('JOJAPI_API_KEY', '')
    if (not 32 <= len(key) <= 256 or not re.fullmatch(r'[A-Za-z0-9_-]+', key)
            or not re.fullmatch(r'jk_[A-Za-z0-9_-]{16,252}', vendor)):
        raise SystemExit('Missing valid acquisition credentials')
    scratch = os.environ.get('ACQUISITION_TEMP_ROOT', '/work')
    if not os.path.isdir(scratch) or os.path.islink(scratch) or scratch in ('/', '/tmp'):
        raise SystemExit('Dedicated acquisition scratch directory required')
    limits = AcquisitionLimits.from_env()
    server = Server(('0.0.0.0', 8080), Handler)
    server.api_key, server.provider_key, server.scratch = key, vendor, scratch
    server.slots = threading.BoundedSemaphore(limits.concurrency)
    server.admission = Admission(min(limits.requests_per_second, MAX_PROVIDER_REQUESTS_PER_SECOND))
    server.scratch_budget = ScratchBudget(scratch)
    server.metadata = OfficialMetadata(PublicTLS)
    print('Private JoJAPI audio acquisition ready', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
