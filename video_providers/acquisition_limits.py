"""Shared bounded acquisition capacity and cancellable paid-start pacing."""
from collections import deque
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
import math
import os
import threading
import time

DEFAULT_CONCURRENCY = 20
DEFAULT_REQUESTS_PER_SECOND = 5


def retry_seconds(value, wall_clock=time.time):
    """Bound provider cooldowns without retaining upstream headers or content."""
    try:
        if isinstance(value, str) and value.isdigit():
            return max(1, min(int(value), 86400))
        date = parsedate_to_datetime(value)
        return max(1, min(math.ceil(date.timestamp() - wall_clock()), 86400))
    except (TypeError, ValueError, OverflowError):
        return 60


@dataclass(frozen=True)
class AcquisitionLimits:
    concurrency: int = DEFAULT_CONCURRENCY
    requests_per_second: int = DEFAULT_REQUESTS_PER_SECOND

    def __post_init__(self):
        for name, value, maximum in (
            ('ACQUISITION_CONCURRENCY', self.concurrency, DEFAULT_CONCURRENCY),
            ('ACQUISITION_REQUESTS_PER_SECOND', self.requests_per_second, DEFAULT_REQUESTS_PER_SECOND),
        ):
            if type(value) is not int or not 1 <= value <= maximum:
                raise ValueError('Invalid acquisition setting: ' + name)

    @classmethod
    def from_env(cls, environment=None):
        environment = os.environ if environment is None else environment

        def integer(name, default):
            value = environment.get(name, str(default))
            if not isinstance(value, str) or not value.isascii() or not value.isdigit():
                raise ValueError('Invalid acquisition setting: ' + name)
            return int(value)

        return cls(integer('ACQUISITION_CONCURRENCY', DEFAULT_CONCURRENCY),
                   integer('ACQUISITION_REQUESTS_PER_SECOND', DEFAULT_REQUESTS_PER_SECOND))


class Admission:
    """Reserve one start per execution, waiting before submission without replay."""
    def __init__(self, requests_per_second=DEFAULT_REQUESTS_PER_SECOND,
                 clock=time.monotonic, sleep=time.sleep):
        AcquisitionLimits(requests_per_second=requests_per_second)
        self.requests_per_second = requests_per_second
        self.clock, self.sleep = clock, sleep
        self.lock = threading.Lock()
        self.started = deque()
        self.cooldown_until = 0

    def reserve(self, check=lambda: None):
        while True:
            check()
            with self.lock:
                now = self.clock()
                while self.started and self.started[0] <= now - 1:
                    self.started.popleft()
                wait = self.cooldown_until - now
                if len(self.started) >= self.requests_per_second:
                    wait = max(wait, self.started[0] + 1 - now)
                if wait <= 0:
                    self.started.append(now)
                    return
            # Guard checks keep client cancellation and the original deadline live.
            self.sleep(min(wait, 0.1))

    def cooldown(self, seconds):
        with self.lock:
            self.cooldown_until = max(self.cooldown_until, self.clock() + seconds)


def wait_for_slot(semaphore, check):
    """Wait for active capacity; a cancelled waiter never retains a slot."""
    while True:
        check()
        if semaphore.acquire(timeout=0.1):
            try:
                check()
            except BaseException:
                semaphore.release()
                raise
            return
