"""Private Tunelio adapter. Standard library only; no local media extractor."""
import base64
from collections import deque
from concurrent.futures import Future, TimeoutError as FutureTimeout
from email.utils import parsedate_to_datetime
import hmac
import http.client
import ipaddress
import json
import math
import os
import re
import select
import socket
import ssl
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

from official_metadata import OfficialMetadata, merge_metadata

API_HOST = 'tunelio.dev'
MAX_BYTES = 100_000_000
MAX_DURATION_SECONDS = 1800
DEADLINE_SECONDS = 150
REQUEST_ID = re.compile(r'^[a-fA-F0-9-]{36}$')
CONTENT_TYPES = {'audio/webm': ('webm', 'webm'), 'video/webm': ('webm', 'webm'),
                 'audio/ogg': ('ogg', 'ogg'), 'application/ogg': ('ogg', 'ogg'),
                 'audio/opus': ('opus', None),
                 'application/octet-stream': (None, None)}
# One acquisition plus one nonfatal metadata lookup can resolve concurrently.
# Separate from HTTP handlers; stalled OS resolvers cannot accumulate threads.
DNS_SLOT = threading.BoundedSemaphore(2)


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
            raise Failure('IMPORT_UNSUPPORTED_PROVIDER', 422,
                          reason='Tunelio accepts YouTube single-item URLs only.')
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video):
            raise ValueError()
        return 'https://www.youtube.com/watch?v=' + video
    except ValueError:
        raise Failure('IMPORT_INVALID_URL', 400) from None


def tunnel_url(value):
    """Only the vendor's documented HTTPS signed tunnel, never Google/CDN URLs."""
    if (not isinstance(value, str) or len(value) > 8192
            or any(c.isspace() or ord(c) < 32 or c == '\\' for c in value)):
        raise Failure(reason='Invalid signed delivery URL.')
    try:
        p = urlsplit(value)
        if (p.scheme != 'https' or p.hostname != API_HOST or p.netloc != API_HOST
                or p.path != '/tunnel' or p.username or p.password or p.port or p.fragment):
            raise ValueError()
        query = parse_qs(p.query, keep_blank_values=True)
        # Signature verification/expiry is the vendor's responsibility. Do not
        # invent a particular token shape: host/path pinning enforces SSRF.
        if (not p.query or not query
                or any(key in query for key in ('progressive', 'hls', 'start', 'end'))):
            raise ValueError()
        return p
    except ValueError:
        raise Failure(reason='Delivery URL failed the signed Tunelio tunnel policy.') from None


def retry_seconds(value, wall_clock=time.time):
    """Honor numeric or HTTP-date Retry-After, bounded to a day."""
    try:
        if isinstance(value, str) and value.isdigit():
            return max(1, min(int(value), 86400))
        date = parsedate_to_datetime(value)
        return max(1, min(math.ceil(date.timestamp() - wall_clock()), 86400))
    except (TypeError, ValueError, OverflowError):
        return 60


class Admission:
    """One process/key: at most 15 paid starts per rolling minute; no waits/replay."""
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.started = deque()
        self.cooldown_until = 0

    def reserve(self):
        with self.lock:
            now = self.clock()
            while self.started and self.started[0] <= now - 60:
                self.started.popleft()
            wait = self.cooldown_until - now
            if len(self.started) >= 15:
                wait = max(wait, self.started[0] + 60 - now)
            if wait > 0:
                raise Failure('IMPORT_QUEUE_FULL', 503,
                              reason='Provider request allowance or cooldown is active; no paid request started.',
                              retry_after=math.ceil(wait))
            self.started.append(now)

    def cooldown(self, seconds):
        with self.lock:
            self.cooldown_until = max(self.cooldown_until, self.clock() + seconds)


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


def included_metadata(payload, content_type):
    result = {'schema_version': 1, 'provider': 'tunelio', 'site': 'youtube'}
    # The requested 128kbps is a nearest-tier preference, not measured bitrate.
    # No provider URLs, filename, raw payload, quality assumptions or API keys.
    extension, container = CONTENT_TYPES[content_type]
    if extension:
        result['extension'] = extension
    if container:
        result['container'] = container
    size = payload.get('file_size')
    if type(size) is int and 0 < size <= MAX_BYTES:
        result['provider_file_bytes'] = size
    return result


class Provider:
    def __init__(self, key, check, admission, connection=PublicTLS, log=None, deadline=None):
        self.key, self.check, self.admission, self.connection = key, check, admission, connection
        self.log = log or (lambda **fields: None)
        self.stage, self.http_status = 'create', None
        self.deadline = deadline if deadline is not None else time.monotonic() + DEADLINE_SECONDS
        self.active_connection = None
        self.active_response = None

    def diagnostics(self):
        return {'stage': self.stage, 'upstream_http_status': self.http_status}

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

    def connect(self):
        self.guard()
        self.active_connection = self.connection(API_HOST, 443, timeout=self.guard())
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

    def status_error(self, response):
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
        if response.status != 200:
            raise Failure(reason='Provider returned a non-200 response; request is never replayed.')
        if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
            raise Failure(reason='Compressed upstream responses are not accepted.')

    def create(self, url):
        self.step('create', 'Requesting native Opus audio once; no paid metadata, retries or job polling.')
        self.guard()
        self.admission.reserve()
        conn = self.connect()
        started, headers_ms = time.monotonic(), None
        try:
            conn.request('GET', '/create?' + urlencode({'url': url, 'quality': 'opus', 'audioBitrate': 128}),
                         headers={'Authorization': 'Bearer ' + self.key,
                                  'Accept': 'application/json', 'Accept-Encoding': 'identity'})
            self.guard()
            response = conn.getresponse()
            self.active_response = response
            headers_ms = round((time.monotonic() - started) * 1000)
            self.guard()
            self.status_error(response)
            if response.getheader('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
                raise Failure(reason='Provider creation response is not JSON.')
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
            if (not isinstance(payload, dict) or payload.get('status') != 'ok'
                    or payload.get('mode') != 'audio' or payload.get('quality') != 'opus'):
                raise Failure('IMPORT_UNSUPPORTED_AUDIO_SOURCE', 422,
                              reason='Provider did not confirm requested native Opus audio.')
            return payload
        finally:
            self.close()
            self.log(message='Paid creation request ended; it is never automatically replayed.',
                     request_duration_ms=round((time.monotonic() - started) * 1000),
                     response_headers_ms=headers_ms, **self.diagnostics())

    def acquire(self, url, limit, output):
        payload = self.create(url)
        declared = payload.get('file_size')
        if declared is not None and (type(declared) is not int or declared < 1):
            raise Failure(reason='Provider declared an invalid audio size.')
        if declared is not None and declared > limit:
            raise Failure('IMPORT_TOO_LARGE', 422, reason='Provider-declared audio exceeds the byte limit.')
        p = tunnel_url(payload.get('url'))
        self.step('audio-transfer', 'Downloading signed Tunelio audio once without any vendor credentials.')
        conn = self.connect()
        started, headers_ms = time.monotonic(), None
        try:
            conn.request('GET', p.path + '?' + p.query, headers={'Accept-Encoding': 'identity'})
            self.guard()
            response = conn.getresponse()
            self.active_response = response
            headers_ms = round((time.monotonic() - started) * 1000)
            self.guard()
            self.status_error(response)
            content_type = response.getheader('Content-Type', '').split(';')[0].strip().lower()
            if content_type not in CONTENT_TYPES:
                raise Failure('IMPORT_UNSUPPORTED_AUDIO_SOURCE', 422,
                              reason='Audio delivery Content-Type is not a recognized native Opus container.')
            length = response_length(response, limit)
            size = 0
            while True:
                self.guard()
                chunk = response.read1(65536)
                self.guard()
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise Failure('IMPORT_TOO_LARGE', 422, reason='Actual audio bytes exceeded the byte limit.')
                output.write(chunk)
            if (size == 0 or (length is not None and size != length)
                    or (declared is not None and size != declared)):
                raise Failure('IMPORT_INVALID_AUDIO', 422,
                              reason='Audio delivery was empty, truncated or differed from its declared size.')
            self.log(message='Complete audio stored in bounded anonymous scratch for NestJS validation.',
                     file_bytes=size, **self.diagnostics())
            return size, included_metadata(payload, content_type)
        finally:
            self.close()
            self.log(message='Credential-free audio transfer ended; no media retry or paid fallback.',
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
            acquired = self.server.slots.acquire(blocking=False)
            if not acquired:
                raise Failure('IMPORT_QUEUE_FULL', 503,
                              reason='Adapter is already acquiring an item; no upstream request started.')

            def check():
                remaining = DEADLINE_SECONDS - (time.monotonic() - started)
                if remaining <= 0:
                    raise Failure(reason='The 150-second acquisition deadline expired.')
                self.connection.settimeout(min(15, remaining))
                if select.select([self.connection], [], [], 0)[0]:
                    if not self.connection.recv(1, socket.MSG_PEEK):
                        raise ConnectionAbortedError()

            with tempfile.TemporaryFile(dir=self.server.scratch) as audio:
                def log(**fields):
                    print(json.dumps({'event': 'audio-acquisition-step', 'acquisition_id': acquisition_id,
                                      'elapsed_ms': round((time.monotonic() - started) * 1000),
                                      **fields}), flush=True)
                provider = Provider(self.server.provider_key, check, self.server.admission, log=log,
                                    deadline=started + DEADLINE_SECONDS)
                lookup = self.server.metadata.start(url)
                size, extra = provider.acquire(url, limit, audio)
                extra = merge_metadata(extra, lookup)
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
    request_queue_size = 8
    threads = threading.BoundedSemaphore(16)

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
    vendor = os.environ.get('TUNELIO_API_KEY', '')
    if (not 32 <= len(key) <= 256 or not re.fullmatch(r'[A-Za-z0-9_-]+', key)
            or not re.fullmatch(r'tnl_[A-Za-z0-9_-]{16,252}', vendor)):
        raise SystemExit('Missing valid acquisition credentials')
    scratch = os.environ.get('ACQUISITION_TEMP_ROOT', '/work')
    if not os.path.isdir(scratch) or os.path.islink(scratch) or scratch in ('/', '/tmp'):
        raise SystemExit('Dedicated acquisition scratch directory required')
    server = Server(('0.0.0.0', 8080), Handler)
    server.api_key, server.provider_key, server.scratch = key, vendor, scratch
    server.slots = threading.BoundedSemaphore(1)
    server.admission = Admission()
    server.metadata = OfficialMetadata(PublicTLS)
    print('Private Tunelio audio acquisition ready', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
