"""Private provider-neutral binary router. No vendor keys, retries or scratch."""
import hmac
import http.client
import json
import os
import re
import select
import socket
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from pathlib import Path

try:
    from acquisition_limits import AcquisitionLimits, Admission, wait_for_slot
    from acquisition_context import parse_context
    from acquisition_metadata import clean_metadata
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from acquisition_limits import AcquisitionLimits, Admission, wait_for_slot
    from acquisition_context import parse_context
    from acquisition_metadata import clean_metadata

from source_policy import Failure, MAX_BYTES, MAX_DURATION_SECONDS, finite, route_for, source_url

REQUEST_ID = re.compile(r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')
UPSTREAM_ERRORS = {
    'IMPORT_INVALID_URL': {400},
    'IMPORT_INVALID_REQUEST': {400, 413, 415},
    'IMPORT_UNSUPPORTED_PROVIDER': {422},
    'IMPORT_SINGLE_ITEM_REQUIRED': {422},
    'IMPORT_UNSUPPORTED_AUDIO_SOURCE': {422},
    'IMPORT_TOO_LARGE': {422},
    'IMPORT_TOO_LONG': {422},
    'IMPORT_INVALID_AUDIO': {422},
    'IMPORT_QUEUE_FULL': {503},
    'IMPORT_UPSTREAM_REFUSED': {502},
    'IMPORT_SOURCE_UNAVAILABLE': {422},
    'IMPORT_DEPENDENCY_FAILED': {503},
    'IMPORT_ACQUISITION_EXHAUSTED': {503},
    'IMPORT_DISK_FULL': {503},
}
CONTENT_TYPES = {'application/octet-stream', 'audio/webm', 'audio/mpeg', 'audio/mp4',
                 'audio/ogg', 'audio/opus', 'application/ogg'}


@dataclass(frozen=True)
class Destination:
    host: str
    port: int
    key: str


def valid_key(key):
    return isinstance(key, str) and bool(re.fullmatch(r'[!-~]{32,256}', key))


def destination(value, key, app):
    """Only operator-configured, exact private CapRover service destinations."""
    if not isinstance(value, str) or any(c.isspace() or c == '\\' for c in value):
        raise ValueError('Invalid private acquisition destination')
    apps = (app,) if isinstance(app, str) else app
    hosts = {host for name in apps for host in (name, 'srv-captain--' + name)}
    try:
        p = urlsplit(value)
        if (p.scheme != 'http' or p.hostname not in hosts
                or p.port != 8080 or p.username or p.password or p.query or p.fragment
                or p.path not in ('', '/') or not valid_key(key)):
            raise ValueError()
        return Destination(p.hostname, 8080, key)
    except ValueError:
        raise ValueError('Invalid private acquisition destination') from None


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Failure('IMPORT_INVALID_REQUEST', 400)
        result[key] = value
    return result


class Operation:
    """Cancel blocked upstream IO when the caller closes or the deadline expires."""
    def __init__(self, client, timeout):
        self.client = client
        self.deadline = time.monotonic() + timeout
        self.connection = None
        self.transport = None
        self.response = None
        self.finished = threading.Event()
        self.cancelled = threading.Event()
        self.timed_out = False
        self.streaming = False
        self.lock = threading.Lock()
        self.watcher = threading.Thread(target=self.watch, daemon=True)

    def __enter__(self):
        self.check()
        self.watcher.start()
        return self

    def __exit__(self, *_args):
        self.finished.set()
        self.close_upstream()
        if self.response:
            self.response.close()
        self.watcher.join(timeout=1)

    def attach(self, connection):
        with self.lock:
            self.connection = connection
        self.check()

    def attach_transport(self, transport):
        # getresponse() detaches Connection-close sockets from HTTPConnection.
        # Keep the transport to interrupt a blocked HTTPResponse.read1() as well.
        with self.lock:
            self.transport = transport
        self.check()

    def disconnected(self):
        try:
            return (bool(select.select([self.client], [], [], 0)[0])
                    and not self.client.recv(1, socket.MSG_PEEK))
        except OSError:
            return True

    def check(self):
        if self.timed_out or time.monotonic() >= self.deadline:
            self.timed_out = True
            raise Failure()
        if self.cancelled.is_set() or self.disconnected():
            raise ConnectionAbortedError()

    def close_upstream(self):
        with self.lock:
            transport = self.transport or (self.connection.sock if self.connection else None)
            if transport:
                try:
                    transport.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            if self.connection:
                self.connection.close()

    def watch(self):
        while not self.finished.wait(0.1):
            if time.monotonic() >= self.deadline or self.disconnected():
                self.timed_out = time.monotonic() >= self.deadline
                self.cancelled.set()
                self.close_upstream()
                if self.timed_out and self.streaming:
                    try:
                        self.client.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                return


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'AudioAcquisitionRouter/1'

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_args):
        pass

    def send_error(self, code, *_args):
        # BaseHTTPRequestHandler also uses this for malformed request lines.
        self.problem(Failure('IMPORT_INVALID_REQUEST', code))

    def reply(self, status, content, content_type='application/problem+json', extra=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.close_connection = True
        self.wfile.write(content)

    def problem(self, failure):
        headers = {'X-Import-Error': failure.code}
        if failure.status == 401:
            headers['WWW-Authenticate'] = 'Bearer'
        if failure.status == 503 and failure.code != 'IMPORT_ACQUISITION_EXHAUSTED':
            headers['Retry-After'] = str(failure.retry_after)
        self.reply(failure.status, json.dumps({
            'type': 'about:blank', 'title': failure.code,
            'status': failure.status, 'code': failure.code,
        }).encode(), extra=headers)

    def do_GET(self):
        if self.path == '/health':
            self.reply(200, b'{"status":"ok"}', 'application/json')
        else:
            self.problem(Failure('IMPORT_NOT_FOUND', 404))

    def body(self):
        if len(self.headers.get_all('Authorization', [])) != 1 or not hmac.compare_digest(
                self.headers.get('Authorization', '').encode(), ('Bearer ' + self.server.api_key).encode()):
            raise Failure('IMPORT_UNAUTHORIZED', 401)
        try:
            self.acquisition_context = parse_context(self.headers)
        except ValueError:
            raise Failure('IMPORT_INVALID_REQUEST', 400) from None
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
            raise Failure('IMPORT_INVALID_REQUEST', 415)
        lengths = self.headers.get_all('Content-Length', [])
        if (self.headers.get('Transfer-Encoding') or self.headers.get('Content-Encoding')
                or len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,9}', lengths[0])):
            raise Failure('IMPORT_INVALID_REQUEST', 400)
        length = int(lengths[0])
        if not 1 <= length <= 4096:
            raise Failure('IMPORT_INVALID_REQUEST', 413)
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise Failure('IMPORT_INVALID_REQUEST', 400)
        body = json.loads(raw, object_pairs_hook=unique_object)
        if not isinstance(body, dict) or set(body) != {'url', 'max_bytes', 'max_duration_seconds'}:
            raise Failure('IMPORT_INVALID_REQUEST', 400)
        if (type(body['max_bytes']) is not int or not 1 <= body['max_bytes'] <= MAX_BYTES
                or not finite(body['max_duration_seconds'])
                or not 0 < body['max_duration_seconds'] <= MAX_DURATION_SECONDS):
            raise Failure('IMPORT_INVALID_REQUEST', 400)
        body['url'] = source_url(body['url'])
        return body

    def do_POST(self):
        started = time.monotonic()
        acquired = False
        self.streaming = False
        self.upstream_status = None
        self.bytes_sent = 0
        route = 'admission'
        result = 'IMPORT_DEPENDENCY_FAILED'
        ids = self.headers.get_all('X-Import-Request-ID', [])
        supplied_id = ids[0] if len(ids) == 1 else ''
        request_id = supplied_id if REQUEST_ID.fullmatch(supplied_id) else str(uuid.uuid4())
        operation = None
        try:
            if self.path != '/audio-imports':
                raise Failure('IMPORT_NOT_FOUND', 404)
            body = self.body()
            route = route_for(body['url'])
            target = self.server.destinations[route]
            remaining = self.server.operation_timeout - (time.monotonic() - started)
            with Operation(self.connection, remaining) as operation:
                wait_for_slot(self.server.slots, operation.check)
                acquired = True
                self.relay(body, target, request_id, operation)
                result = 'SUCCEEDED'
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            disconnected = operation and not operation.timed_out and operation.disconnected()
            result = 'CLIENT_DISCONNECTED' if disconnected else 'IMPORT_DEPENDENCY_FAILED'
            if not disconnected and not self.streaming:
                try:
                    self.problem(Failure())
                except OSError:
                    pass
        except Exception as error:
            failure = error if isinstance(error, Failure) else Failure()
            if isinstance(error, (json.JSONDecodeError, UnicodeError, RecursionError)):
                failure = Failure('IMPORT_INVALID_REQUEST', 400)
            if operation and operation.cancelled.is_set() and not operation.timed_out:
                result = 'CLIENT_DISCONNECTED'
            else:
                result = failure.code
                if not self.streaming:
                    try:
                        self.problem(failure)
                    except OSError:
                        pass
        finally:
            self.close_connection = True
            if acquired:
                self.server.slots.release()
            self.server.log({'event': 'audio-acquisition-route', 'request_id': request_id,
                             'route': route, 'result': result, 'upstream_status': self.upstream_status,
                             'bytes_sent': self.bytes_sent, 'duration_ms': round((time.monotonic() - started) * 1000)})

    def relay(self, body, target, request_id, operation):
        connection = self.server.connection_factory(target.host, target.port, timeout=25)
        operation.attach(connection)
        connection.connect()
        operation.attach_transport(connection.sock)
        operation.check()
        # Pace sends after connecting: uneven DNS/TCP latency must not bunch starts.
        self.server.admission.reserve(operation.check)
        operation.check()
        connection.sock.settimeout(max(0.1, operation.deadline - time.monotonic()))
        # Exactly one POST. Never repeat or switch providers after any result.
        headers = {
            'Authorization': 'Bearer ' + target.key,
            'Content-Type': 'application/json',
            'Accept': 'application/octet-stream, application/problem+json',
            'X-Import-Request-ID': request_id,
            'Connection': 'close',
        }
        if self.acquisition_context:
            headers.update(self.acquisition_context.headers())
        connection.request('POST', '/audio-imports', json.dumps(body).encode(), headers)
        response = connection.getresponse()
        operation.response = response
        operation.check()
        self.upstream_status = response.status
        if response.status != 200:
            codes = response.headers.get_all('X-Import-Error', [])
            code = codes[0] if len(codes) == 1 else None
            if response.status in UPSTREAM_ERRORS.get(code, set()):
                retry = response.getheader('Retry-After', '')
                retry = min(int(retry), 86400) if re.fullmatch(r'[0-9]{1,6}', retry) else 30
                raise Failure(code, response.status, retry)
            raise Failure()
        lengths = response.headers.get_all('Content-Length', [])
        if (len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,9}', lengths[0])
                or response.getheader('Transfer-Encoding') or response.getheader('Content-Encoding')):
            raise Failure()
        expected = int(lengths[0])
        if expected > body['max_bytes']:
            raise Failure('IMPORT_TOO_LARGE', 422)
        content_types = response.headers.get_all('Content-Type', [])
        if (expected < 1 or len(content_types) != 1
                or content_types[0] not in CONTENT_TYPES):
            raise Failure()
        extras = response.headers.get_all('X-Import-Extra-Data-Base64', [])
        extra = clean_metadata(extras[0], self.server.secrets) if len(extras) == 1 else None
        self.send_response(200)
        self.send_header('Content-Type', content_types[0])
        self.send_header('Content-Length', str(expected))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        if extra:
            self.send_header('X-Import-Extra-Data-Base64', extra)
        self.end_headers()
        self.streaming = True
        operation.streaming = True
        while self.bytes_sent < expected:
            operation.check()
            chunk = response.read1(min(65536, expected - self.bytes_sent))
            operation.check()
            if not chunk:
                raise Failure()
            received = self.bytes_sent + len(chunk)
            if received > expected or received > body['max_bytes']:
                raise Failure('IMPORT_TOO_LARGE', 422)
            self.wfile.write(chunk)
            self.bytes_sent = received


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, address, api_key, destinations, *, connection_factory=http.client.HTTPConnection,
                 operation_timeout=600, log=None, limits=None):
        super().__init__(address, Handler)
        self.api_key = api_key
        self.destinations = destinations
        self.secrets = [api_key, *(target.key for target in destinations.values())]
        self.connection_factory = connection_factory
        self.operation_timeout = operation_timeout
        self.limits = limits or AcquisitionLimits.from_env()
        self.slots = threading.BoundedSemaphore(self.limits.concurrency)
        self.admission = Admission(self.limits.requests_per_second)
        self.threads = threading.BoundedSemaphore(64)
        self.log = log or (lambda fields: print(json.dumps(fields), flush=True))

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
    if not valid_key(key):
        raise SystemExit('Missing valid private router credentials')
    try:
        targets = {
            'youtube': destination(os.environ.get('YOUTUBE_AUDIO_ACQUISITION_API_URL', ''),
                                   os.environ.get('YOUTUBE_AUDIO_ACQUISITION_API_KEY', ''),
                                   ('music-mute-tunelio', 'music-mute-jojapi', 'music-mute-ytdlp')),
            'other': destination(os.environ.get('OTHER_AUDIO_ACQUISITION_API_URL', ''),
                                 os.environ.get('OTHER_AUDIO_ACQUISITION_API_KEY', ''), 'music-mute-videoscale'),
        }
    except ValueError:
        raise SystemExit('Missing valid private adapter configuration') from None
    try:
        limits = AcquisitionLimits.from_env()
    except ValueError as error:
        raise SystemExit(str(error)) from None
    server = Server(('0.0.0.0', 8080), key, targets, limits=limits)
    print('Private audio acquisition router ready', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
