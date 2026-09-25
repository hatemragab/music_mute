"""Private authenticated native-audio transfer; no public media storage."""
import base64
import unicodedata
import hmac
import json
import os
from pathlib import Path
import select
import signal
import shutil
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import runner

ERRORS = {
    'INVALID_URL': (400, 'IMPORT_INVALID_URL'),
    'NETWORK_ADDRESS_REJECTED': (422, 'IMPORT_INVALID_URL'),
    'SINGLE_ITEM_REQUIRED': (422, 'IMPORT_SINGLE_ITEM_REQUIRED'),
    'UNSUPPORTED_PROVIDER': (422, 'IMPORT_UNSUPPORTED_PROVIDER'),
    'AUDIO_FORMAT_UNAVAILABLE': (422, 'IMPORT_UNSUPPORTED_AUDIO_SOURCE'),
    'AUDIO_SELECTION_NOT_PROVEN': (422, 'IMPORT_UNSUPPORTED_AUDIO_SOURCE'),
    'INVALID_AUDIO': (422, 'IMPORT_INVALID_AUDIO'),
    'NON_AUDIO_TRACK': (422, 'IMPORT_INVALID_AUDIO'),
    'SIZE_LIMIT': (422, 'IMPORT_TOO_LARGE'),
    'DURATION_LIMIT': (422, 'IMPORT_TOO_LONG'),
    'UPSTREAM_RATE_LIMIT': (502, 'IMPORT_UPSTREAM_REFUSED'),
    'UPSTREAM_ACCESS_REFUSED': (502, 'IMPORT_UPSTREAM_REFUSED'),
    'BUSY': (503, 'IMPORT_QUEUE_FULL'),
    'DISK_LIMIT': (503, 'IMPORT_DISK_FULL'),
}


def request_body(value):
    if not isinstance(value, dict) or set(value) != {'url', 'max_bytes', 'max_duration_seconds'}:
        raise ValueError('INVALID_URL')
    runner.canonical_url(value['url'])
    for key, maximum in [('max_bytes', runner.MAX_BYTES), ('max_duration_seconds', runner.MAX_SECONDS)]:
        number = value[key]
        if isinstance(number, bool) or not isinstance(number, (float, int)) or not 0 < number <= maximum:
            raise ValueError('INVALID_URL')
    if not isinstance(value['max_bytes'], int):
        raise ValueError('INVALID_URL')
    return value


class Server(ThreadingHTTPServer):
    daemon_threads = False
    request_queue_size = 8

    def __init__(self, address, key):
        self.key = key
        self.stopping = threading.Event()
        self.connections = threading.BoundedSemaphore(4)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()

    def handle_error(self, request, client_address):
        # Never emit a request URL, credential, upstream output, or stack trace.
        print('Private audio request failed', flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = 'MusicMuteAudio'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def log_message(self, *_):
        pass

    def disconnected(self):
        if self.server.stopping.is_set():
            return True
        if select.select([self.connection], [], [], 0)[0]:
            return not self.connection.recv(1, socket.MSG_PEEK)
        return False

    def problem(self, status, code):
        body = json.dumps({'type': 'about:blank', 'title': code,
                           'status': status, 'code': code}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/problem+json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Import-Error', code)
        if status == 401:
            self.send_header('WWW-Authenticate', 'Bearer')
        if status == 503:
            self.send_header('Retry-After', '10')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != '/health':
            self.problem(404, 'NOT_FOUND')
            return
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(b'{}')

    def do_POST(self):
        started_response = False
        try:
            if not hmac.compare_digest(self.headers.get('Authorization', '').encode(),
                                       b'Bearer ' + self.server.key):
                self.problem(401, 'UNAUTHORIZED')
                return
            if self.path != '/audio-imports':
                self.problem(404, 'NOT_FOUND')
                return
            length = self.headers.get('Content-Length', '')
            if (self.headers.get('Transfer-Encoding') or not length.isdigit()
                    or not 0 < int(length) <= 4096
                    or self.headers.get_content_type() != 'application/json'):
                self.problem(400, 'IMPORT_INVALID_URL')
                return
            raw = self.rfile.read(int(length))
            if len(raw) != int(length):
                raise ValueError('INVALID_URL')
            try:
                body = request_body(json.loads(raw))
            except (ValueError, TypeError, KeyError):
                raise ValueError('INVALID_URL') from None
            with runner.prepared(body['url'], self.disconnected, wait=True,
                                 limits=(body['max_bytes'], body['max_duration_seconds']),
                                 normalize_audio=True) as (path, result):
                if result['bytes'] > body['max_bytes']:
                    raise ValueError('SIZE_LIMIT')
                if result['duration_seconds'] > body['max_duration_seconds']:
                    raise ValueError('DURATION_LIMIT')
                if self.disconnected():
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(result['bytes']))
                self.send_header('Cache-Control', 'no-store')
                title = result.get('source', {}).get('title')
                if isinstance(title, str):
                    title = ''.join(c for c in title if unicodedata.category(c) != 'Cc').strip()[:200]
                    if title:
                        self.send_header('X-Import-Title-Base64', base64.b64encode(title.encode('utf-8')).decode('ascii'))
                self.end_headers()
                started_response = True
                with path.open('rb') as source:
                    shutil.copyfileobj(source, self.wfile, 64 * 1024)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception as error:
            if not started_response:
                status, code = ERRORS.get(str(error), (503, 'IMPORT_DEPENDENCY_FAILED'))
                self.problem(status, code)


def main():
    key = Path(os.environ.get('YTDLP_KEY_FILE', '/run/musicmute-ytdlp/api-key')).read_bytes().strip()
    if not 32 <= len(key) <= 256:
        raise RuntimeError('Configure private service authentication')
    runner.ROOT.mkdir(exist_ok=True)
    for path in runner.ROOT.glob('attempt-*'):
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
    print('Private audio service ready', flush=True)
    with Server(('0.0.0.0', 8080), key) as server:
        def stop(*_):
            server.stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        server.serve_forever()


if __name__ == '__main__':
    main()
