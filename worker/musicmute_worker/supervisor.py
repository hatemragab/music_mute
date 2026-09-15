"""Shared queue loop used by the native worker child after authorization."""

import logging
import threading
from .transport import ApiError
from .worker import LeaseLost, Worker


def run_loop(worker: Worker, stop: threading.Event, *, once: bool = False) -> int:
    """Long poll when idle; back off connection failures without losing progress."""
    log = logging.getLogger("musicmute.worker")
    failures = 0
    while not stop.is_set():
        try:
            wait = 0 if once else worker.config.claim_wait_seconds
            outcome = worker.run_once(wait_seconds=wait)
            failures = 0
            if once:
                print("One-job run finished: " + outcome)
                return 0 if outcome in ("ready", "idle", "cancelled") else 1
            if outcome == "idle" and not wait:
                stop.wait(1)
        except (LeaseLost, ApiError) as error:
            worker.close()
            if (
                isinstance(error, ApiError)
                and not error.retryable
                and error.status in (400, 401, 403, 404)
            ):
                log.error(
                    "Worker API rejected request: %s. Check backend URL and worker secret.",
                    error.code,
                )
                return 2
            log.warning(
                "Connection or assignment changed; stopped processing and will reconcile"
            )
            if once:
                print(
                    "Run interrupted. Run --once again to reconcile the saved assignment."
                )
                return 1
            delay = min(2 ** min(failures, 4), 15)
            if isinstance(error, ApiError):
                delay = max(delay, error.retry_after or 0)
            failures += 1
            stop.wait(delay)
    return 0
