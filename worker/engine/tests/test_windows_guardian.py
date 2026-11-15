from __future__ import annotations

import ctypes
import subprocess
import sys
import queue
import threading
import unittest
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

from musicmute_engine.windows_guardian import ExtendedLimits, guardian_arguments, main, own_job


class WindowsGuardianContractTests(unittest.TestCase):
    def test_private_detached_mode_requires_windows_and_fixed_argument_prefix(self) -> None:
        with patch("sys.platform", "win32"):
            self.assertEqual(guardian_arguments(["--parent-pid", "321", "--detached-console", "--", "-I", "-c", "engine"]),
                             (321, ["-I", "-c", "engine"], True))
            self.assertEqual(guardian_arguments(["--parent-pid", "321", "--", "-I"]), (321, ["-I"], False))
            for arguments in (["--parent-pid", "0", "--", "-I"],
                              ["--parent-pid", "321", "--detached-console", "--"],
                              ["--parent-pid", "321", "--creationflags", "8", "--", "-I"]):
                with self.assertRaises(ValueError):
                    guardian_arguments(arguments)
        with patch("sys.platform", "darwin"):
            with self.assertRaises(ValueError):
                guardian_arguments(["--parent-pid", "321", "--detached-console", "--", "-I"])

    def test_detached_engine_keeps_job_parent_watcher_and_explicit_pipe_lifetime(self) -> None:
        for detached in (False, True):
            with self.subTest(detached=detached):
                order: list[str] = []
                child = MagicMock()
                child.wait.return_value = 0
                msvcrt = types.ModuleType("msvcrt")
                msvcrt.setmode = MagicMock()
                arguments = ["guardian", "--parent-pid", "321", *( ["--detached-console"] if detached else []), "--", "-I", "-c", "engine"]
                def create_child(*_args, **kwargs):
                    order.append("spawn")
                    self.assertEqual(kwargs["creationflags"], 0x8 if detached else 0)
                    self.assertEqual(kwargs["creationflags"] & 0x01000000, 0)  # no BREAKAWAY_FROM_JOB
                    self.assertEqual(kwargs["stdin"], subprocess.PIPE)
                    self.assertIsNone(kwargs["stdout"])
                    self.assertIsNone(kwargs["stderr"])
                    self.assertTrue(kwargs["close_fds"])
                    return child
                with patch("sys.platform", "win32"), patch("sys.argv", arguments), \
                     patch.dict(sys.modules, {"msvcrt": msvcrt}), \
                     patch("musicmute_engine.windows_guardian.own_job", side_effect=lambda: order.append("job") or 42) as own, \
                     patch("musicmute_engine.windows_guardian.watch_parent", side_effect=lambda _pid: order.append("parent")) as watcher, \
                     patch("musicmute_engine.windows_guardian.subprocess.Popen", side_effect=create_child) as spawn, \
                     patch("musicmute_engine.windows_guardian.threading.Thread") as thread, \
                     patch("musicmute_engine.windows_guardian.os._exit", side_effect=SystemExit(0)) as exit_process, \
                     patch.object(__import__("os"), "O_BINARY", 0x8000, create=True):
                    with self.assertRaises(SystemExit):
                        main()
                self.assertEqual(order, ["job", "parent", "spawn"])
                own.assert_called_once_with()
                watcher.assert_called_once_with(321)
                spawn.assert_called_once()
                thread.assert_called_once()
                thread.return_value.start.assert_called_once()
                child.wait.assert_called_once_with()
                exit_process.assert_called_once_with(0)


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

    @unittest.skipUnless(sys.platform == "win32", "native retained Windows console/Job acceptance")
    def test_native_detached_console_keeps_outer_job_and_cleans_descendants(self) -> None:
        # Only these sacrificial fixture processes enter/exit the dedicated Jobs.
        # The existing QA parent's Job chain is preserved; no BREAKAWAY flag.
        # The extra outer Job has no kill-on-close limit, so the guardian's actual
        # parent watcher and sole inner Job handle must retire the descendants.
        engine = """import ctypes,subprocess,sys,os,json,time
child=subprocess.Popen([sys.executable,'-I','-B','-S','-c','import time; time.sleep(60)'],creationflags=0x8)
kernel=ctypes.WinDLL('kernel32',use_last_error=True)
kernel.GetConsoleWindow.restype=ctypes.c_void_p
print(json.dumps({'engine':os.getpid(),'descendant':child.pid,'consoleAbsent':not kernel.GetConsoleWindow()}),flush=True)
while True: pass
"""
        parent = """import ctypes,subprocess,sys,os,json,time
kernel=ctypes.WinDLL('kernel32',use_last_error=True)
kernel.CreateJobObjectW.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p]
kernel.CreateJobObjectW.restype=ctypes.c_void_p
kernel.GetCurrentProcess.restype=ctypes.c_void_p
kernel.AssignProcessToJobObject.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
kernel.AssignProcessToJobObject.restype=ctypes.c_int
job=kernel.CreateJobObjectW(None,None)
if not job or not kernel.AssignProcessToJobObject(job,kernel.GetCurrentProcess()): raise OSError('fixture outer Job unavailable')
p=subprocess.Popen([sys.executable,'-I','-B','-S','-c',"import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('musicmute_engine.windows_guardian',run_name='__main__')",sys.argv[2],'--parent-pid',str(os.getpid()),'--detached-console','--','-I','-B','-S','-c',sys.argv[1]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,creationflags=0x8)
row=json.loads(p.stdout.readline().decode())
kernel=ctypes.WinDLL('kernel32',use_last_error=True)
kernel.OpenProcess.argtypes=[ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
kernel.OpenProcess.restype=ctypes.c_void_p
kernel.IsProcessInJob.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.POINTER(ctypes.c_int)]
kernel.IsProcessInJob.restype=ctypes.c_int
kernel.CloseHandle.argtypes=[ctypes.c_void_p]
checks=[]
for pid in [p.pid,row['engine'],row['descendant']]:
 handle=kernel.OpenProcess(0x1000,False,pid)
 if not handle: raise OSError('fixture child not queryable')
 member=ctypes.c_int()
 try:
  if not kernel.IsProcessInJob(handle,job,ctypes.byref(member)): raise OSError('fixture Job query failed')
  checks.append(bool(member.value))
 finally: kernel.CloseHandle(handle)
print(json.dumps({'guardian':p.pid,**row,'outerJobInherited':all(checks)}),flush=True)
time.sleep(60)
"""
        module_root = str(Path(__file__).resolve().parents[1])
        supervisor = subprocess.Popen([sys.executable, "-I", "-B", "-S", "-c", parent, engine, module_root],
                                      stdout=subprocess.PIPE, text=True, creationflags=0x8)
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
            reader = threading.Thread(target=lambda: ready.put(supervisor.stdout.readline()), daemon=True)
            reader.start()
            row = json.loads(ready.get(timeout=10))
            self.assertIs(row["outerJobInherited"], True)
            self.assertIs(row["consoleAbsent"], True)
            for pid in [row["guardian"], row["engine"], row["descendant"]]:
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

    @unittest.skipUnless(sys.platform == "win32", "native Windows Job Object acceptance")
    def test_native_parent_death_removes_busy_engine_and_descendant(self) -> None:
        # A sacrificial supervisor owns the guardian; only these fixture processes die.
        engine = """import subprocess,sys,os,json,time
child=subprocess.Popen([sys.executable,'-I','-B','-S','-c','import time; time.sleep(60)'])
print(json.dumps([os.getpid(),child.pid]),flush=True)
while True: pass
"""
        parent = """import subprocess,sys,os,time
p=subprocess.Popen([sys.executable,'-I','-B','-S','-c',"import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('musicmute_engine.windows_guardian',run_name='__main__')",sys.argv[2],'--parent-pid',str(os.getpid()),'--','-I','-B','-S','-c',sys.argv[1]],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
print(p.pid,flush=True)
print(p.stdout.readline().decode().strip(),flush=True)
time.sleep(60)
"""
        module_root = str(Path(__file__).resolve().parents[1])
        supervisor = subprocess.Popen([sys.executable, "-I", "-B", "-S", "-c", parent, engine, module_root], stdout=subprocess.PIPE, text=True)
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
