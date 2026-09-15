import base64
import hashlib
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar
from unittest.mock import patch

from musicmute_worker.config import Config
from musicmute_worker.transport import Api, ApiError, TransferError, Transfers


class Handler(BaseHTTPRequestHandler):
    requests: ClassVar[list] = []
    data = b"sample audio"

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.requests.append((self.path, dict(self.headers), body))
        if self.path.endswith("truncated"):
            self.send_response(200)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self.wfile.write(b'20\r\n{"status":')
            self.close_connection = True
        elif self.path.endswith("claim"):
            self.send_response(204)
            self.send_header("Retry-After", "15")
            self.end_headers()
        elif self.path.endswith("identity"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                b'{"workerId":"fixture-worker","state":"enabled","protocolVersion":3}'
            )
        elif self.path.endswith("fail"):
            self.send_response(409)
            self.end_headers()
            self.wfile.write(b'{"code":"STALE_ATTEMPT"}')
        elif self.path.endswith("redirect"):
            self.send_response(302)
            self.send_header("Location", "/leaked")
            self.end_headers()
        else:
            self.send_response(204)
            self.end_headers()

    def do_PUT(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.requests.append((self.path, dict(self.headers), body))
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        self.requests.append((self.path, dict(self.headers), b""))
        if self.path == "/busy":
            self.send_response(503)
            self.send_header("Retry-After", "7")
            self.end_headers()
            return
        if self.path == "/expired":
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(self.data)))
        self.end_headers()
        self.wfile.write(self.data)


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        Handler.requests.clear()

    def test_api_empty_queue_and_safe_error(self):
        api = Api(self.url + "/api/v1", "private-test-secret", allow_http=True)
        self.assertIsNone(api.post("claim", {"sessionId": "test"}))
        self.assertEqual(
            Handler.requests[0][1]["Authorization"], "Bearer private-test-secret"
        )
        self.assertEqual(Handler.requests[0][1]["User-Agent"], "MusicMuteWorker/3.0")
        with self.assertRaises(ApiError) as caught:
            api.post("fail", {})
        self.assertEqual(caught.exception.code, "STALE_ATTEMPT")
        self.assertNotIn("private-test-secret", str(caught.exception))

    def test_identity_request_sends_an_authenticated_empty_body(self):
        api = Api(self.url + "/api/v1", "private-test-secret", allow_http=True)
        self.assertEqual(
            api.post("identity", {}),
            {"workerId": "fixture-worker", "state": "enabled", "protocolVersion": 3},
        )
        path, headers, body = Handler.requests[0]
        self.assertEqual(path, "/api/v1/worker/identity")
        self.assertEqual(body, b"{}")
        self.assertEqual(headers["Authorization"], "Bearer private-test-secret")

    def test_api_does_not_follow_redirects(self):
        api = Api(self.url + "/api/v1", "secret", allow_http=True)
        with self.assertRaises(ApiError):
            api.post("redirect", {})
        self.assertEqual(len(Handler.requests), 1)

    def test_truncated_chunked_reply_is_retryable(self):
        with self.assertRaises(ApiError) as caught:
            Api(self.url, "secret", allow_http=True).post("truncated", {})
        self.assertTrue(caught.exception.retryable)

    def test_download_integrity_and_no_api_credentials(self):
        transfers = Transfers(allow_http=True)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "input.mp3"
            checksum = base64.b64encode(hashlib.sha256(Handler.data).digest()).decode()
            transfers.download(
                {"url": self.url}, path, len(Handler.data), checksum, lambda: None
            )
            self.assertEqual(path.read_bytes(), Handler.data)
            self.assertNotIn("Authorization", Handler.requests[0][1])
            with self.assertRaises(TransferError):
                transfers.download({"url": self.url}, path, 1, checksum, lambda: None)
            with self.assertRaises(TransferError):
                transfers.download(
                    {"url": self.url}, path, len(Handler.data), "wrong", lambda: None
                )

    def test_upload_sends_raw_file_with_signed_headers(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "vocals.mp3"
            path.write_bytes(Handler.data)
            checksum = base64.b64encode(hashlib.sha256(Handler.data).digest()).decode()
            Transfers(allow_http=True).upload(
                {
                    "method": "PUT",
                    "url": self.url,
                    "headers": {
                        "Content-Type": "audio/mpeg",
                        "x-amz-checksum-sha256": checksum,
                        "If-None-Match": "*",
                    },
                },
                path,
                lambda: None,
            )
        _, headers, body = Handler.requests[0]
        lower_headers = {name.lower(): value for name, value in headers.items()}
        self.assertNotIn("Authorization", headers)
        self.assertEqual(int(headers["Content-Length"]), len(body))
        self.assertEqual(headers["Content-Type"], "audio/mpeg")
        self.assertEqual(lower_headers["x-amz-checksum-sha256"], checksum)
        self.assertEqual(lower_headers["if-none-match"], "*")
        self.assertEqual(Handler.data, body)

    def test_download_errors_preserve_retry_classification_and_server_delay(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "input.mp3"
            with self.assertRaises(TransferError) as caught:
                Transfers(allow_http=True).download(
                    {"url": self.url + "/busy"}, path, 12, "checksum", lambda: None
                )
            self.assertTrue(caught.exception.retryable)
            self.assertEqual(caught.exception.retry_after, 7)
            with self.assertRaises(TransferError) as expired:
                Transfers(allow_http=True).download(
                    {"url": self.url + "/expired"}, path, 12, "checksum", lambda: None
                )
            self.assertTrue(expired.exception.refresh_grant)

    def test_claim_timeout_exceeds_requested_long_poll(self):
        api = Api(self.url, "secret", allow_http=True)
        with patch("musicmute_worker.transport.opener") as make_opener:
            response = make_opener.return_value.open.return_value.__enter__.return_value
            response.status = 204
            api.post("claim", {"sessionId": "session", "waitSeconds": 25})
            self.assertGreater(
                make_opener.return_value.open.call_args.kwargs["timeout"], 25
            )

    def test_production_rejects_insecure_urls(self):
        with self.assertRaises(ValueError):
            Api(self.url, "secret")
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(TransferError):
            Transfers().download(
                {"url": self.url}, Path(folder) / "x", 1, "x", lambda: None
            )

    def test_configuration_requires_https_and_external_secret(self):
        from worker_test_support import config_document

        with tempfile.TemporaryDirectory() as folder:
            path, document = config_document(Path(folder).resolve())
            path.write_text(json.dumps(document))
            config = Config.load(path)
            self.assertEqual(config.api_base_url, "https://api.example.com/api/v1")
            self.assertEqual(config.worker_id, "fixture-worker")
            for invalid in ("", "GPU-02", "-gpu", "gpu_02", "a" * 65):
                path.write_text(json.dumps({**document, "worker_id": invalid}))
                with (
                    self.subTest(invalid=invalid),
                    self.assertRaisesRegex(ValueError, "worker_id"),
                ):
                    Config.load(path)
            for updates in ({"api_base_url": "http://example.com"}, {"secret": "bad"}):
                path.write_text(json.dumps({**document, **updates}))
                with self.assertRaises(ValueError):
                    Config.load(path)


if __name__ == "__main__":
    unittest.main()
