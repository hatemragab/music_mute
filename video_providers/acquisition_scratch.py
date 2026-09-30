"""Reserve bounded scratch before provider work, accounting for active writes."""
import os
import threading


class ScratchUnavailable(Exception):
    """Dedicated scratch cannot safely hold another bounded acquisition."""


class ScratchBudget:
    def __init__(self, root, min_free_bytes=128_000_000):
        self.root = root
        self.min_free_bytes = min_free_bytes
        self.lock = threading.Lock()
        self.remaining = 0

    def reserve(self, maximum):
        with self.lock:
            space = os.statvfs(self.root)
            available = space.f_bavail * space.f_frsize
            if available < self.remaining + maximum + self.min_free_bytes:
                raise ScratchUnavailable()
            self.remaining += maximum
        return Reservation(self, maximum)


class Reservation:
    def __init__(self, budget, maximum):
        self.budget = budget
        self.remaining = maximum
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        with self.budget.lock:
            if not self.closed:
                self.budget.remaining -= self.remaining
                self.remaining = 0
                self.closed = True

    def wrap(self, output):
        reservation = self

        class ReservedOutput:
            def write(self, chunk):
                # Flush while holding the budget lock: free-space reads must
                # see allocated bytes before their outstanding reservation falls.
                with reservation.budget.lock:
                    if reservation.closed or len(chunk) > reservation.remaining:
                        raise ValueError('Scratch reservation byte limit exceeded')
                    written = output.write(chunk)
                    output.flush()
                    reservation.remaining -= written
                    reservation.budget.remaining -= written
                    return written

        return ReservedOutput()
