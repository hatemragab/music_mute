"""Source-tree-only development observations; excluded from deployment packages.

No media, provider payload, URL, credential, arbitrary exception or stderr crosses
this boundary. The existing service remains the owner of request/stream handling.
"""
from datetime import datetime, timezone
import http.client
import json
import os
from pathlib import Path
import queue
import re
import threading
import time
import uuid

_INSTANCE = str(uuid.uuid4())
_QUEUE = queue.Queue(maxsize=128)
_LOCK = threading.Lock()
_STARTED = False
_STATS = {"delivered": 0, "dropped": 0, "failed": 0}
_SOURCE_TREE = (Path(__file__).resolve().parent.name == 'video_providers'
                and (Path(__file__).resolve().parents[1] / 'AGENTS.md').is_file())
_ID = re.compile(r'^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$')


def enabled():
    return (_SOURCE_TREE and os.environ.get('NODE_ENV') == 'development'
            and os.environ.get('APP_ENV') == 'local'
            and os.environ.get('MUSICMUTE_LOG_ENABLED') == '1'
            and bool(re.fullmatch(r'[a-f0-9]{64}', os.environ.get('MUSICMUTE_LOG_KEY', ''))))


def status():
    with _LOCK:
        return {**_STATS, 'enabled': enabled(), 'pending': _QUEUE.qsize()}


def _send():
    while True:
        body = _QUEUE.get()
        connection = None
        try:
            # Fixed loopback transport, never inherited proxy settings or redirects.
            connection = http.client.HTTPConnection('127.0.0.1', 19740, timeout=2)
            connection.request('POST', '/ingest/provider', body, {
                'Content-Type': 'application/json',
                'x-musicmute-log-key': os.environ.get('MUSICMUTE_LOG_KEY', ''),
            })
            response = connection.getresponse()
            with _LOCK:
                _STATS['delivered' if response.status == 202 else 'failed'] += 1
        except Exception:
            with _LOCK:
                _STATS['failed'] += 1
        finally:
            if connection:
                connection.close()
            _QUEUE.task_done()


def emit_http(service, method, route, status_code, duration_ms, request_id=None,
              phase='completed', content_type=None, content_length=None):
    """Closed scalar envelope: caller text/payloads cannot bypass redaction."""
    global _STARTED
    if not enabled():
        return
    try:
        service = service if service in {'router', 'videoscale', 'tunelio', 'jojapi', 'ytdlp'} else 'unknown'
        method = method if method in {'GET', 'POST', 'OPTIONS'} else 'OTHER'
        route = route if route in {'/health', '/audio-imports'} else '[unmatched]'
        status_code = status_code if type(status_code) is int and 100 <= status_code <= 599 else None
        record = {
            'timestamp': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'timestampSource': 'event', 'source': 'provider', 'origin': 'application',
            'instanceId': _INSTANCE, 'service': service, 'category': 'http',
            'name': 'http.provider', 'summary': 'Provider HTTP operation',
            'level': 'warn' if status_code is None or status_code >= 400 else 'info',
            'operation': method, 'route': route, 'status': status_code,
            'phase': phase if phase in {'completed', 'aborted', 'failed'} else 'unknown',
            'result': 'response_observed' if status_code and status_code < 400 and phase == 'completed' else 'failure',
            'durationMs': round(max(0, min(float(duration_ms), 3600000)), 2),
            'data': {'omitted': 'provider_and_media_payloads_always_private',
                     'completion': 'handler_returned_not_media_validation_or_client_delivery'},
        }
        if isinstance(request_id, str) and _ID.fullmatch(request_id):
            record['requestId'] = request_id
        if isinstance(content_type, str) and re.fullmatch(r'(?:application|audio)/[a-z0-9.+-]{1,64}', content_type):
            record['contentType'] = content_type
        if isinstance(content_length, str) and re.fullmatch(r'\d{1,12}', content_length):
            record['contentLength'] = int(content_length)
        body = json.dumps(record, separators=(',', ':')).encode()
        with _LOCK:
            if not _STARTED:
                threading.Thread(target=_send, name='local-provider-logs', daemon=True).start()
                _STARTED = True
        try:
            _QUEUE.put_nowait(body)
        except queue.Full:
            with _LOCK:
                _STATS['dropped'] += 1
    except Exception:
        # Diagnostics never alter a response, cancellation, or paid operation.
        with _LOCK:
            _STATS['failed'] += 1


class LocalLoggingHandlerMixin:
    def handle_one_request(self):
        started = time.monotonic()
        self._local_log_status = None
        self._local_log_type = None
        self._local_log_length = None
        phase = 'completed'
        try:
            return super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            phase = 'aborted'
            raise
        except Exception:
            phase = 'failed'
            raise
        finally:
            if getattr(self, 'command', None) and getattr(self, 'command', None) != 'OPTIONS':
                supplied = getattr(self, 'headers', {}).get('X-Import-Request-ID')
                emit_http(self.local_log_service, self.command, getattr(self, 'path', ''),
                          self._local_log_status, (time.monotonic() - started) * 1000,
                          supplied, phase, self._local_log_type, self._local_log_length)

    def send_response(self, code, message=None):
        self._local_log_status = code
        return super().send_response(code, message)

    def send_header(self, keyword, value):
        if keyword.lower() == 'content-type':
            self._local_log_type = value
        elif keyword.lower() == 'content-length':
            self._local_log_length = value
        return super().send_header(keyword, value)
