"""Trusted, provider-neutral attempt context on the private acquisition hops."""
from dataclasses import dataclass
from datetime import datetime, timezone
import re
import time

HEADER_NAMES = ('X-Import-Attempt', 'X-Import-Max-Attempts',
                'X-Import-Acquisition-Started-At')
UTC_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')


@dataclass(frozen=True)
class AcquisitionContext:
    attempt: int
    max_attempts: int
    started_at: datetime

    def headers(self):
        return dict(zip(HEADER_NAMES, (str(self.attempt), str(self.max_attempts),
                        self.started_at.isoformat(timespec='milliseconds').replace('+00:00', 'Z'))))

    def remaining_seconds(self, budget=120, now=None):
        current = time.time() if now is None else now
        return max(0.0, min(float(budget), self.started_at.timestamp() + budget - current))


def parse_context(headers, now=None):
    """Absent is legacy; partial, duplicate or malformed context fails closed."""
    values = []
    for name in HEADER_NAMES:
        entries = headers.get_all(name, []) if hasattr(headers, 'get_all') else (
            [headers[name]] if name in headers else [])
        if len(entries) > 1:
            raise ValueError('Invalid acquisition context')
        values.append(entries[0] if entries else None)
    if all(value is None for value in values):
        return None
    if any(not isinstance(value, str) for value in values):
        raise ValueError('Invalid acquisition context')
    attempt, maximum, started = values
    if not re.fullmatch('[1-4]', attempt) or not re.fullmatch('[1-4]', maximum):
        raise ValueError('Invalid acquisition context')
    if int(attempt) > int(maximum) or not UTC_DATE.fullmatch(started):
        raise ValueError('Invalid acquisition context')
    try:
        stamp = datetime.fromisoformat(started.replace('Z', '+00:00'))
        current = time.time() if now is None else now
        if stamp.timestamp() > current + 5:
            raise ValueError()
    except (ValueError, OverflowError):
        raise ValueError('Invalid acquisition context') from None
    return AcquisitionContext(int(attempt), int(maximum), stamp.astimezone(timezone.utc))
