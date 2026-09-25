from __future__ import annotations

import ctypes
import subprocess
import sys
import queue
import threading
import unittest
from unittest.mock import MagicMock, patch

from musicmute_engine.windows_guardian import ExtendedLimits, own_job


class WindowsGuardianContractTests(unittest.TestCase):
    def test_refuses_non_windows_without_starting_any_child(self) -> None:
        with patch("sys.platform", "darwin"):
            with self.assertRaises(OSError):
                own_job()

    def test_configures_kill_on_close_before_joining_job(self) -> None:
        kernel = MagicMock()
        kernel.CreateJobObjectW.return_value = 42
        kernel.SetInformationJobObject.return_value = 1
        kernel.AssignProcessToJobObject.return_value = 1
        kernel.GetCurrentProcess.return_value = 99
        seen_flags: list[int] = []

        def configure(_handle, kind, pointer, size):
            self.assertEqual(kind, 9)
            self.assertEqual(size, ctypes.sizeof(ExtendedLimits))
            seen_flags.append(pointer._obj.BasicLimitInformation.LimitFlags)
            return 1

        kernel.SetInformationJobObject.side_effect = configure
        with patch("sys.platform", "win32"), patch.object(ctypes, "WinDLL", return_value=kernel, create=True):
            self.assertEqual(own_job(), 42)
        self.assertEqual(seen_flags, [0x2000])
        kernel.CreateJobObjectW.assert_called_once_with(None, None)
        kernel.AssignProcessToJobObject.assert_called_once_with(42, 99)
        self.assertLess(
            [call[0] for call in kernel.mock_calls].index("SetInformationJobObject"),
            [call[0] for call in kernel.mock_calls].index("AssignProcessToJobObject"),
        )

    def test_job_assignment_failure_closes_handle_and_fails_closed(self) -> None:
        kernel = MagicMock()
        kernel.CreateJobObjectW.return_value = 42
        kernel.SetInformationJobObject.return_value = 1
        kernel.AssignProcessToJobObject.return_value = 0
        with patch("sys.platform", "win32"), patch.object(ctypes, "WinDLL", return_value=kernel, create=True), \
             patch.object(ctypes, "get_last_error", return_value=5, create=True), \
             patch.object(ctypes, "WinError", side_effect=lambda code: OSError(code, "denied"), create=True):
            with self.assertRaises(OSError):
                own_job()
        kernel.CloseHandle.assert_called_once_with(42)

    @unittest.skipUnless(sys.platform == "win32", "native Windows Job Object acceptance")
    def test_native_parent_death_removes_busy_engine_and_descendant(self) -> None:
        # A sacrificial supervisor owns the guardian; only these fixture processes die.
        engine = """import subprocess,sys,os,json,time
child=subprocess.Popen([sys.executable,'-B','-c','import time; time.sleep(60)'])
print(json.dumps([os.getpid(),child.pid]),flush=True)
while True: pass
"""
        parent = """import subprocess,sys,os,time
p=subprocess.Popen([sys.executable,'-B','-m','musicmute_engine.windows_guardian','--parent-pid',str(os.getpid()),'--','-c',sys.argv[1]],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
print(p.pid,flush=True)
print(p.stdout.readline().decode().strip(),flush=True)
time.sleep(60)
"""
        supervisor = subprocess.Popen([sys.executable, "-B", "-c", parent, engine], stdout=subprocess.PIPE, text=True)
        handles = []
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel.WaitForSingleObject.restype = ctypes.c_ulong
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        try:
            import json
            ready = queue.Queue()
            def read_ready():
                ready.put((supervisor.stdout.readline(), supervisor.stdout.readline()))
            reader = threading.Thread(target=read_ready, daemon=True)
            reader.start()
            guardian_line, descendant_line = ready.get(timeout=10)
            guardian = int(guardian_line)
            descendants = json.loads(descendant_line)
            for pid in [guardian, *descendants]:
                handle = kernel.OpenProcess(0x00100000, False, pid)
                self.assertTrue(handle)
                handles.append(handle)
            supervisor.kill()
            supervisor.wait(timeout=5)
            for handle in handles:
                self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0)
        finally:
            if supervisor.poll() is None:
                supervisor.kill()
            supervisor.wait(timeout=5)
            for handle in handles:
                kernel.CloseHandle(handle)


if __name__ == "__main__":
    unittest.main()
