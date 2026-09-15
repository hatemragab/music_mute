"""Bounded HTTPS requests. API authentication is never attached to S3 traffic."""

import base64
import hashlib
import http.client
import json
import math
import re
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from .config import https_url


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str = "API_UNAVAILABLE",
        previous_attempt_id: str | None = None,
        retry_after: float | None = None,
        *,
        can_recover: bool = False,
    ):
        self.status = status
        self.code = code if re.fullmatch(r"[A-Z_]{1,64}", code) else "API_ERROR"
        self.previous_attempt_id = previous_attempt_id
        self.retry_after = retry_after
        self.can_recover = can_recover
        super().__init__(f"API request failed: {self.code} (HTTP {status})")

    @property
    def retryable(self) -> bool:
        return self.status in (0, 408, 429) or self.status >= 500


class TransferError(Exception):
    def __init__(
        self,
        code: str,
        *,
        uncertain: bool = False,
        retryable: bool = False,
        refresh_grant: bool = False,
        retry_after: float | None = None,
    ):
        self.code = code
        self.uncertain = uncertain
        self.retryable = retryable or uncertain or refresh_grant
        self.refresh_grant = refresh_grant
        self.retry_after = retry_after
        super().__init__(code)


def retry_after_seconds(value: str | None) -> float | None:
    """Parse only a delay, never retain response headers or provider bodies."""
    if not value or len(value) > 128:
        return None
    try:
        if value.strip().isdigit():
            seconds = float(value)
        else:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            seconds = (date - datetime.now(timezone.utc)).total_seconds()
        return max(0.0, seconds) if math.isfinite(seconds) else None
    except (ValueError, TypeError, OverflowError):
        return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def opener():
    # Do not inherit proxy environment variables that could route bearer traffic.
    result = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    # Identify this client consistently; the deployed edge rejects generic urllib.
    result.addheaders = [("User-Agent", "MusicMuteWorker/3.0")]
    return result


class Api:
    def __init__(self, base_url: str, secret: str, *, allow_http: bool = False):
        self.base_url = https_url(base_url, allow_http=allow_http).rstrip("/")
        if not secret or any(ord(c) < 33 or ord(c) > 126 for c in secret):
            raise ValueError(
                "Worker secret must be nonempty printable ASCII without spaces"
            )
        self._secret = secret

    def post(self, route: str, body: dict) -> dict | None:
        if not re.fullmatch(r"[a-z-]+", route):
            raise ValueError("Invalid worker route")
        request = urllib.request.Request(
            self.base_url + "/worker/" + route,
            data=json.dumps(body, allow_nan=False).encode(),
            headers={
                "Authorization": "Bearer " + self._secret,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            wait = body.get("waitSeconds", 0) if route == "claim" else 0
            timeout = 15 + wait if type(wait) is int and 0 <= wait <= 25 else 15
            with opener().open(request, timeout=timeout) as response:
                if response.status == 204:
                    return None
                data = response.read(65537)
                if len(data) > 65536:
                    raise ApiError(response.status, "INVALID_RESPONSE")
                value = json.loads(data)
                if not isinstance(value, dict):
                    raise ApiError(response.status, "INVALID_RESPONSE")
                return value
        except urllib.error.HTTPError as error:
            with error:
                try:
                    data = json.loads(error.read(65536))
                    if not isinstance(data, dict):
                        data = {}
                except (ValueError, OSError, http.client.HTTPException):
                    data = {}
            previous = data.get("previousAttemptId")
            raise ApiError(
                error.code,
                str(data.get("code", "API_ERROR")),
                previous,
                retry_after_seconds(error.headers.get("Retry-After")),
                can_recover=data.get("canRecover") is True,
            ) from None
        except (
            urllib.error.URLError,
            TimeoutError,
            ConnectionError,
            OSError,
            http.client.HTTPException,
        ):
            raise ApiError(0) from None
        except (ValueError, UnicodeError):
            raise ApiError(0, "INVALID_RESPONSE") from None


class Transfers:
    def __init__(self, *, allow_http: bool = False):
        self.allow_http = allow_http

    def _url(self, grant: dict) -> str:
        try:
            return https_url(grant["url"], allow_http=self.allow_http)
        except (ValueError, KeyError, TypeError):
            raise TransferError("INVALID_TRANSFER_GRANT") from None

    def download(
        self,
        grant: dict,
        path: Path,
        size: int,
        checksum: str,
        check: Callable[[], None],
    ) -> None:
        if type(size) is not int or not 0 < size < 30_000_000:
            raise TransferError("INVALID_AUDIO")
        request = urllib.request.Request(self._url(grant))
        digest = hashlib.sha256()
        received = 0
        try:
            with (
                opener().open(request, timeout=15) as response,
                path.open("wb") as target,
            ):
                while True:
                    check()
                    block = response.read(65536)
                    if not block:
                        break
                    received += len(block)
                    if received > size:
                        raise TransferError("INPUT_CHECKSUM_MISMATCH")
                    digest.update(block)
                    target.write(block)
            if received < size:
                raise TransferError("DOWNLOAD_FAILED", retryable=True)
            if base64.b64encode(digest.digest()).decode() != checksum:
                raise TransferError("INPUT_CHECKSUM_MISMATCH")
        except urllib.error.HTTPError as error:
            with error:
                raise TransferError(
                    "DOWNLOAD_FAILED",
                    retryable=error.code in (408, 429) or error.code >= 500,
                    refresh_grant=error.code == 403,
                    retry_after=retry_after_seconds(error.headers.get("Retry-After")),
                ) from None
        except (urllib.error.URLError, OSError, http.client.HTTPException):
            raise TransferError("DOWNLOAD_FAILED", retryable=True) from None

    def upload(self, grant: dict, path: Path, check: Callable[[], None]) -> None:
        headers = grant.get("headers")
        if grant.get("method") != "PUT" or not isinstance(headers, dict):
            raise TransferError("INVALID_TRANSFER_GRANT")
        normalized = {}
        for name, value in headers.items():
            if (
                not isinstance(name, str)
                or not re.fullmatch(r"[A-Za-z0-9-]+", name)
                or not isinstance(value, str)
                or any(ord(character) < 32 or ord(character) == 127 for character in value)
            ):
                raise TransferError("INVALID_TRANSFER_GRANT")
            normalized[name.lower()] = value
        try:
            checksum = base64.b64decode(
                normalized.get("x-amz-checksum-sha256", ""), validate=True
            )
        except (ValueError, TypeError):
            checksum = b""
        if (
            len(headers) != 3
            or len(normalized) != 3
            or normalized.get("content-type") != "audio/mpeg"
            or normalized.get("if-none-match") != "*"
            or len(checksum) != 32
            or not path.is_file()
        ):
            raise TransferError("INVALID_TRANSFER_GRANT")
        size = path.stat().st_size

        def chunks():
            check()
            with path.open("rb") as source:
                while block := source.read(65536):
                    check()
                    yield block

        request = urllib.request.Request(
            self._url(grant),
            data=chunks(),
            method="PUT",
            headers={
                **headers,
                "Content-Length": str(size),
            },
        )
        try:
            with opener().open(request, timeout=15) as response:
                if response.status not in (200, 201, 204):
                    raise TransferError("OUTPUT_UPLOAD_FAILED")
        except urllib.error.HTTPError as error:
            with error:
                raise TransferError(
                    "OUTPUT_UPLOAD_FAILED",
                    uncertain=error.code in (408, 429) or error.code >= 500,
                    refresh_grant=error.code == 403,
                    retry_after=retry_after_seconds(error.headers.get("Retry-After")),
                ) from None
        except (urllib.error.URLError, OSError, http.client.HTTPException):
            raise TransferError("OUTPUT_UPLOAD_FAILED", uncertain=True) from None
