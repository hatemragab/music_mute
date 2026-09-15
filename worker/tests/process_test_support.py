"""Test-only namespaces: tests must never open production Windows OS objects."""

from contextlib import ExitStack
from unittest.mock import patch
from uuid import uuid4

from musicmute_worker import processes


class ProcessTestIsolation:
    """Patch one test and its explicitly launched Python children consistently.

    Use ``self.enterContext(ProcessTestIsolation())`` in unittest setUp before
    constructing any worker. Prefix subprocess Python code with ``child_setup``
    before calling worker/process APIs. No production environment/configuration
    override is introduced. Tests in one Python interpreter run sequentially.
    """

    def __init__(self):
        namespace = rf"Global\MusicMute.Tests.{uuid4().hex}"
        self.job = namespace + ".Processes"
        self.mutex = namespace + ".Worker"
        self.production_job = processes._JOB_NAME
        self.production_mutex = processes._MUTEX_NAME
        self._stack = ExitStack()

    @property
    def child_setup(self) -> str:
        return (
            "from musicmute_worker import processes; "
            f"processes._JOB_NAME = {self.job!r}; "
            f"processes._MUTEX_NAME = {self.mutex!r}; "
        )

    def __enter__(self):
        self._stack.enter_context(patch.object(processes, "_JOB_NAME", self.job))
        self._stack.enter_context(patch.object(processes, "_MUTEX_NAME", self.mutex))
        return self

    def __exit__(self, *exc):
        return self._stack.__exit__(*exc)
