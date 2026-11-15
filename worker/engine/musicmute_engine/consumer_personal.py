"""Private Windows personal engine: fixed tools and strict DirectML, no account transport.

The signed Node owner verifies the release, model receipt/fingerprint and private
Win32 file ACLs before creating a one-job v1 or reusable logged-in-user v2
configuration. The guardian owns this process and every decoder/downloader/JS
child. No external path is writable.
"""
from __future__ import annotations

import argparse
import copy
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, Callable

from .artifacts import ModelArtifactError
from .child import isolate_protocol_output, response
from .ipc import UUID_V4, read_frame, write_frame
from .media import probe_audio, verify_input_identity, sha256_base64, _run, LOCAL_MEDIA_FORMATS
from .pipeline import ProcessRequest, ProcessingFailure, RuntimePipeline
from .recipes import MODEL_BYTES, MODEL_FILENAME, MODEL_SHA256, recipe_snapshot
from .windows_gpu import resolve_adapter, validate_identity, GpuSelectionError
from .qualification import service_identity

MAX_SOURCE_BYTES = 256 * 1024 ** 2
MAX_SECONDS = 1200
CONFIG_KEYS = {"version", "jobId", "workRoot", "releaseRoot", "modelPath", "sid", "gpuIdentity"}
SESSION_CONFIG_KEYS = {"version", "sessionId", "sessionRoot", "jobsRoot", "releaseRoot", "modelPath", "sid", "gpuIdentity"}
PRIVATE_ENVIRONMENT_KEYS = ("HOME", "USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "MPLCONFIGDIR", "NUMBA_CACHE_DIR", "XDG_CACHE_HOME")


def private_environment(root: Path) -> None:
    for name in PRIVATE_ENVIRONMENT_KEYS:
        os.environ[name] = str(root)
    os.environ["SENTRY_ENGINE_ENABLED"] = "0"
    for name in tuple(os.environ):
        if name.startswith("MUSICMUTE_OWNERSHIP_"):
            os.environ.pop(name, None)


class PreparedModel:
    """Bind verification to the prepared model, independently of every job."""

    def __init__(self, model: Path):
        self.path = model
        self.identity = self.fingerprint()

    def fingerprint(self) -> tuple[int, ...]:
        info = self.path.stat()
        if self.path.is_symlink() or not self.path.is_file() or info.st_nlink != 1 or info.st_size != MODEL_BYTES:
            raise ModelArtifactError("Prepared model is invalid")
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def resolve(self, root: Path) -> Path:
        if root != self.path.parent or self.fingerprint() != self.identity:
            raise ModelArtifactError("Prepared model identity changed")
        return self.path

    def validate(self, path: Path) -> Path:
        if path != self.path:
            raise ModelArtifactError("Prepared model path changed")
        return self.resolve(path.parent)


def validate_local_source(path: Path, ffprobe: Path, probe: Callable = probe_audio) -> float:
    if path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1 or not 0 < path.stat().st_size <= MAX_SOURCE_BYTES:
        raise ProcessingFailure("INPUT_LIMIT", "Local source is invalid")
    info = probe(path, ffprobe)
    if not math.isfinite(info.duration_seconds) or not 0 < info.duration_seconds <= MAX_SECONDS:
        raise ProcessingFailure("DURATION_LIMIT", "Personal duration limit exceeded")
    return info.duration_seconds


def normalize_original(source: Path, work: Path, release: Path) -> tuple[Path, float, dict[str, Any] | None]:
    """Match macOS file import: retain audio-only AAC for video source containers."""
    ffprobe, ffmpeg = release / "runtime" / "bin" / "ffprobe.exe", release / "runtime" / "bin" / "ffmpeg.exe"
    duration = validate_local_source(source, ffprobe)
    info = _run([str(ffprobe), "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", LOCAL_MEDIA_FORMATS,
                 "-show_entries", "stream=codec_type", "-of", "json", str(source)], 30, "Input stream probe failed")
    streams = json.loads(info.stdout).get("streams")
    if not isinstance(streams, list) or not 1 <= len(streams) <= 32 or not any(stream.get("codec_type") == "audio" for stream in streams):
        raise ProcessingFailure("INVALID_REQUEST", "Input stream metadata is invalid")
    if not any(stream.get("codec_type") == "video" for stream in streams) and source.suffix.lower() not in (".mkv", ".mov"):
        return source, duration, None
    output = work / "original.m4a"
    if output.exists():
        raise ProcessingFailure("INVALID_REQUEST", "Original audio already exists")
    _run([str(ffmpeg), "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", LOCAL_MEDIA_FORMATS,
          "-max_alloc", "536870912", "-i", str(source), "-map", "0:a:0", "-vn", "-sn", "-dn", "-c:a", "aac", "-b:a", "160k",
          "-ar", "44100", "-ac", "2", "-fs", "30000000", "-n", str(output)], 180, "Original audio extraction failed", capture_output=False)
    measured = probe_audio(output, ffprobe)
    if measured.sample_rate != 44100 or measured.channels != 2 or abs(measured.duration_seconds - duration) > 0.25:
        raise ProcessingFailure("OUTPUT_INVALID", "Original audio extraction changed the timeline")
    size = output.stat().st_size
    if not 0 < size <= 30_000_000:
        raise ProcessingFailure("OUTPUT_INVALID", "Original audio extraction exceeds the bound")
    return output, duration, {"outputPath": str(output), "bytes": size, "sha256": sha256_base64(output), "durationSeconds": measured.duration_seconds, "contentType": "audio/mp4"}


def bounded_tool(arguments: list[str], cwd: Path, output: Path, maximum: int, timeout: int) -> None:
    if output.exists() or output.parent != cwd or maximum not in (65536, 4 * 1024 ** 2) or timeout not in (120, 600):
        raise ProcessingFailure("INVALID_REQUEST", "Tool result is invalid")
    failure = threading.Event()
    stderr = io.BytesIO()
    process = subprocess.Popen(arguments, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, close_fds=True, env=dict(os.environ),
                               creationflags=0x00000008 if sys.platform == "win32" else 0)
    assert process.stdout is not None and process.stderr is not None
    def drain(stream, target, cap):
        written = 0
        try:
            while chunk := stream.read(8192):
                written += len(chunk)
                if written > cap:
                    failure.set(); process.kill(); break
                if target is not None:
                    target.write(chunk)
        except (OSError, ValueError):
            failure.set(); process.kill()
    try:
        with output.open("xb") as target:
            threads = [threading.Thread(target=drain, args=(process.stdout,target,maximum),daemon=True),
                       threading.Thread(target=drain, args=(process.stderr,stderr,128*1024),daemon=True)]
            for thread in threads: thread.start()
            try: code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(); raise ProcessingFailure("SOURCE_UNAVAILABLE", "Source tool timed out")
            for thread in threads: thread.join(timeout=5)
            if code != 0 or failure.is_set() or any(thread.is_alive() for thread in threads):
                # A short ephemeral hint lets the shared Node classifier recognize
                # refusals; never retain/log raw URLs, paths or the extractor dump.
                lines=stderr.getvalue().decode("utf8",errors="replace").splitlines()
                hint="\n".join(line for line in lines if re.match(r"(?:ERROR:|yt-dlp:\s*error:|DOWNLOADER_|YT_DLP_)",line,re.I))
                hint=re.sub(r"https?://\S+", "[URL]", hint)
                hint=re.sub(r"[A-Za-z]:\\[^\s]+", "[PATH]", hint)
                hint=re.sub(r"\b[A-Za-z0-9_-]{11}\b", "[ID]", hint)[:4096]
                raise ProcessingFailure("SOURCE_UNAVAILABLE", hint or "Source tool failed")
            target.flush(); os.fsync(target.fileno())
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    finally:
        process.stdout.close(); process.stderr.close()


class PersonalExecutor:
    def __init__(self, configuration: dict[str, Any], *, prepared_model: PreparedModel | None = None,
                 pipeline: RuntimePipeline | None = None, bind_environment: bool = True,
                 private_input_root: Path | None = None):
        if set(configuration) != CONFIG_KEYS or configuration["version"] != 1 or not isinstance(configuration["jobId"], str) or not UUID_V4.fullmatch(configuration["jobId"]):
            raise ProcessingFailure("INVALID_REQUEST", "Personal configuration is invalid")
        self.configuration = copy.deepcopy(configuration)
        self.work = Path(configuration["workRoot"])
        self.release = Path(configuration["releaseRoot"])
        self.model = Path(configuration["modelPath"])
        if any(not path.is_absolute() for path in (self.work,self.release,self.model)) or self.work.name != configuration["jobId"] or self.model.name != MODEL_FILENAME:
            raise ProcessingFailure("INVALID_REQUEST", "Personal roots are invalid")
        self.prepared_model = prepared_model or PreparedModel(self.model)
        self.prepared_model.validate(self.model)
        self.model_fingerprint = self.prepared_model.identity
        self.pipeline = pipeline or RuntimePipeline(model_resolver=self.prepared_model.resolve, model_validator=self.prepared_model.validate)
        self.private_input_root = private_input_root
        # CPU decode/DSP is allowed; MODEL inference always uses the provider guard.
        if bind_environment:
            private_environment(self.work)

    def _model_fingerprint(self):
        return self.prepared_model.fingerprint()

    def _model(self, root: Path) -> Path:
        return self.prepared_model.resolve(root)

    def execute(self, payload: dict[str,Any], progress, window_progress) -> dict[str,Any]:
        operation = payload.get("operation")
        if operation == "downloader":
            if set(payload) != {"operation", "arguments", "output", "timeout", "maximum"}:
                raise ProcessingFailure("INVALID_REQUEST", "Downloader fields are invalid")
            arguments = payload["arguments"]
            if not isinstance(arguments,list) or len(arguments)>100 or any(not isinstance(arg,str) or len(arg)>4096 or "\0" in arg for arg in arguments):
                raise ProcessingFailure("INVALID_REQUEST", "Downloader arguments are invalid")
            output = self.work / str(payload["output"])
            if output.name not in ("metadata.jsonl", "download.json") or output.parent != self.work:
                raise ProcessingFailure("INVALID_REQUEST", "Downloader output is invalid")
            bundle = self.release / "tools" / "downloader"
            bounded_tool([sys.executable,"-I","-B","-S",str(bundle / "downloader_bootstrap.py"),
                          "--musicmute-downloader-root",str(bundle),"--musicmute-youtube-runtime",str(self.release/"tools"/"youtube"),*arguments],
                         self.work,output,payload["maximum"],payload["timeout"])
            for entry in self.work.glob("source.*"):
                if entry.is_symlink() or not entry.is_file() or entry.stat().st_size > MAX_SOURCE_BYTES:
                    raise ProcessingFailure("INPUT_LIMIT", "Source download exceeds the limit")
            return {"output":output.name}
        if operation == "process":
            if set(payload) != {"operation", "input", "recipeId"}:
                raise ProcessingFailure("INVALID_REQUEST", "Process fields are invalid")
            if sys.platform != "win32" or service_identity() != self.configuration["sid"]:
                raise ProcessingFailure("GPU_UNSUPPORTED", "Native user identity is required")
            try:
                adapter = resolve_adapter(self.configuration["gpuIdentity"])
            except GpuSelectionError as error:
                raise ProcessingFailure("GPU_UNSUPPORTED", "Qualified GPU changed") from error
            source = payload["input"]
            if not isinstance(source,dict) or set(source) != {"path","bytes","sha256"}:
                raise ProcessingFailure("INVALID_REQUEST", "Input fields are invalid")
            input_path = Path(source["path"])
            # Node owns input capability validation; restrict the actual engine read to private personal tree.
            root = self.private_input_root or self.work.parent.parent.parent
            if not input_path.is_absolute() or not input_path.is_relative_to(root):
                raise ProcessingFailure("INVALID_REQUEST", "Input is outside private storage")
            if self.private_input_root is not None:
                if input_path.resolve(strict=True) != input_path:
                    raise ProcessingFailure("INVALID_REQUEST", "Input path is redirected")
                directory = input_path.parent
                while directory != root:
                    _directory_identity(directory)
                    directory = directory.parent
            verify_input_identity(input_path, source["bytes"], source["sha256"])
            progress("input-validation")
            normalized, source_duration, original = normalize_original(input_path, self.work, self.release)
            if original is not None:
                source = {"path": str(normalized), "bytes": original["bytes"], "sha256": original["sha256"]}
                input_path = normalized
            recipe = recipe_snapshot(payload["recipeId"], trim_enabled=payload["recipeId"] == "kim-vocals-v2-trim", revision=6)
            if recipe["modelDigest"] != MODEL_SHA256: raise ProcessingFailure("INVALID_REQUEST", "Model pin changed")
            attempt = self.work / "engine" / self.configuration["jobId"]
            attempt.mkdir(parents=True, exist_ok=False)
            copied = attempt / ("source" + input_path.suffix.lower())
            shutil.copyfile(input_path, copied)
            request = ProcessRequest.from_payload({"attemptId":self.configuration["jobId"],"attemptDirectory":str(attempt),
                "input":{**source,"path":str(copied)},"modelCacheRoot":str(self.model.parent),"provider":"directml","directmlDeviceId":adapter["deviceIndex"],
                "ffmpegPath":str(self.release/"runtime"/"bin"/"ffmpeg.exe"),"ffprobePath":str(self.release/"runtime"/"bin"/"ffprobe.exe"),"recipe":recipe})
            result = self.pipeline.process(request,progress,window_progress)
            result["sourceDurationSeconds"] = source_duration
            if original is not None:
                result["original"] = original
            self._model(self.model.parent)
            resolve_adapter(self.configuration["gpuIdentity"])
            return result
        raise ProcessingFailure("INVALID_REQUEST", "Personal operation is invalid")


def _directory_identity(path: Path) -> tuple[int, int, int | float | None]:
    # Native owner retains the actual Win32 root handles. This second boundary
    # rejects replaced/reparse directories; mutable directory timestamps are not
    # identity because a subsequent job adds a new sibling directory.
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)() or not path.is_dir():
        raise ProcessingFailure("INVALID_REQUEST", "Session directory is invalid")
    info = path.stat()
    return (info.st_dev, info.st_ino, getattr(info, "st_birthtime_ns", getattr(info, "st_birthtime", None)))


class PersonalSessionExecutor:
    """One logged-in user's serial model session with fresh per-job state."""

    def __init__(self, configuration: dict[str, Any]):
        if not isinstance(configuration, dict) or set(configuration) != SESSION_CONFIG_KEYS or type(configuration["version"]) is not int or configuration["version"] != 2:
            raise ProcessingFailure("INVALID_REQUEST", "Session configuration is invalid")
        session_id = configuration["sessionId"]
        if not isinstance(session_id, str) or not UUID_V4.fullmatch(session_id):
            raise ProcessingFailure("INVALID_REQUEST", "Session identity is invalid")
        paths = {name: configuration[name] for name in ("sessionRoot", "jobsRoot", "releaseRoot", "modelPath")}
        if any(not isinstance(value, str) or not value or "\0" in value for value in paths.values()):
            raise ProcessingFailure("INVALID_REQUEST", "Session roots are invalid")
        converted = {name: Path(value) for name, value in paths.items()}
        if any(not path.is_absolute() or path.resolve(strict=True) != path for path in converted.values()):
            raise ProcessingFailure("INVALID_REQUEST", "Session roots are invalid")
        self.session_id = session_id
        self.session_root = converted["sessionRoot"]
        self.jobs_root = converted["jobsRoot"]
        self.release = converted["releaseRoot"]
        self.model = converted["modelPath"]
        if (self.session_root.name != session_id or self.session_root.parent.name != "engine-session"
                or self.jobs_root != self.session_root.parent.parent / "jobs"
                or self.jobs_root.parent.name != "personal" or self.model.name != MODEL_FILENAME):
            raise ProcessingFailure("INVALID_REQUEST", "Session roots are invalid")
        sid = configuration["sid"]
        if (not isinstance(sid, str)
                or re.fullmatch(r"(?:S-1-5-21-|S-1-12-1-)(?:\d{1,10}-){3}\d{1,10}", sid) is None
                or any(int(part) > 0xffffffff for part in sid.split("-")[4:])):
            raise ProcessingFailure("INVALID_REQUEST", "Session user identity is invalid")
        try:
            validate_identity(configuration["gpuIdentity"])
        except GpuSelectionError as error:
            raise ProcessingFailure("GPU_UNSUPPORTED", "Session GPU identity is invalid") from error
        self.configuration = copy.deepcopy(configuration)
        self._directories: dict[Path, tuple[int, int, int | float | None]] = {}
        for root in (self.session_root, self.jobs_root, self.release, self.model.parent):
            for directory in (root, *root.parents):
                self._directories[directory] = _directory_identity(directory)
        self.prepared_model = PreparedModel(self.model)
        self.pipeline = RuntimePipeline(model_resolver=self.prepared_model.resolve, model_validator=self.prepared_model.validate)
        self._resolved_adapter: dict[str, object] | None = None
        self._lock = threading.Lock()
        self._poisoned = False
        private_environment(self.session_root)

    def _validate_session(self) -> None:
        if self._poisoned:
            raise ProcessingFailure("PROCESSING_FAILED", "Personal session requires restart")
        for directory, identity in self._directories.items():
            if _directory_identity(directory) != identity:
                raise ProcessingFailure("INVALID_REQUEST", "Session directory identity changed")
        if any(os.environ.get(name) != str(self.session_root) for name in PRIVATE_ENVIRONMENT_KEYS):
            raise ProcessingFailure("INVALID_REQUEST", "Session environment changed")
        self.prepared_model.validate(self.model)
        if sys.platform != "win32" or service_identity() != self.configuration["sid"]:
            raise ProcessingFailure("GPU_UNSUPPORTED", "Native user identity is required")
        try:
            adapter = resolve_adapter(self.configuration["gpuIdentity"])
        except GpuSelectionError as error:
            raise ProcessingFailure("GPU_UNSUPPORTED", "Qualified GPU changed") from error
        if self._resolved_adapter is None:
            self._resolved_adapter = dict(adapter)
        elif adapter != self._resolved_adapter:
            raise ProcessingFailure("GPU_UNSUPPORTED", "Qualified GPU changed")

    def execute(self, payload: dict[str, Any], progress, window_progress) -> dict[str, Any]:
        if not self._lock.acquire(blocking=False):
            self._poisoned = True
            raise ProcessingFailure("PROCESSING_FAILED", "Personal session is busy")
        succeeded = False
        try:
            self._validate_session()
            if not isinstance(payload, dict):
                raise ProcessingFailure("INVALID_REQUEST", "Session request is invalid")
            job_id = payload.get("jobId")
            if not isinstance(job_id, str) or not UUID_V4.fullmatch(job_id) or job_id.lower() == self.session_id.lower():
                raise ProcessingFailure("INVALID_REQUEST", "Session job identity is invalid")
            work = self.jobs_root / job_id
            work_identity = _directory_identity(work)
            per_job = {name: self.configuration[name] for name in ("releaseRoot", "modelPath", "sid", "gpuIdentity")}
            per_job.update(version=1, jobId=job_id, workRoot=str(work))
            executor = PersonalExecutor(per_job, prepared_model=self.prepared_model, pipeline=self.pipeline,
                                        bind_environment=False, private_input_root=self.jobs_root.parent)
            reused = self.pipeline.model_loaded and payload.get("operation") == "process"
            result = executor.execute({name: value for name, value in payload.items() if name != "jobId"}, progress, window_progress)
            # Detach before acknowledging so a failed cleanup cannot authorize
            # reuse, publication, or release of a still-owned job directory.
            self.pipeline.detach_job()
            if _directory_identity(work) != work_identity:
                raise ProcessingFailure("INVALID_REQUEST", "Job directory identity changed")
            self._validate_session()
            result["sessionCompletion"] = {"sessionId": self.session_id, "jobId": job_id, "detached": True, "modelReused": reused}
            succeeded = True
            return result
        finally:
            try:
                if not succeeded:
                    self._poisoned = True
                    try:
                        self.pipeline.detach_job()
                    finally:
                        self.pipeline.invalidate()
            finally:
                self._lock.release()


def run(incarnation: str, executor: PersonalExecutor | PersonalSessionExecutor) -> int:
    output = isolate_protocol_output()
    try:
        ready = {"processCapacity":1,"recipeIds":["kim-vocals-v2","kim-vocals-v2-trim"]}
        if isinstance(executor, PersonalSessionExecutor):
            ready["sessionEngine"] = {"sessionId": executor.session_id, "processId": os.getpid()}
        write_frame(output,response("ready",str(uuid.uuid4()),incarnation,ready))
        while message := read_frame(sys.stdin.buffer,expected_incarnation=incarnation):
            request_id,command=message["requestId"],message["command"]
            if command == "shutdown":
                write_frame(output,response("result",request_id,incarnation,{"stopped":True})); return 0
            if command == "ping":
                write_frame(output,response("result",request_id,incarnation,{"status":"ok"})); continue
            if command != "process":
                write_frame(output,response("error",request_id,incarnation,{"code":"INVALID_REQUEST"})); continue
            try:
                progress=lambda stage:write_frame(output,response("progress",request_id,incarnation,{"stage":stage}))
                windows=lambda completed,total:write_frame(output,response("progress",request_id,incarnation,{"stage":"separation","unit":"windows","completed":completed,"total":total}))
                result=executor.execute(message["payload"],progress,windows)
                write_frame(output,response("result",request_id,incarnation,result))
            except ProcessingFailure as error:
                write_frame(output,response("error",request_id,incarnation,{"code":error.code,"summary":error.summary}))
            except Exception:
                write_frame(output,response("error",request_id,incarnation,{"code":"PROCESSING_FAILED"}))
        return 0
    finally: output.close()


def main() -> int:
    parser=argparse.ArgumentParser(add_help=False); parser.add_argument("--consumer-config",type=Path,required=True); parser.add_argument("--incarnation",required=True)
    args=parser.parse_args()
    if sys.platform != "win32" or not UUID_V4.fullmatch(args.incarnation) or not args.consumer_config.is_absolute() or args.consumer_config.is_symlink() or args.consumer_config.stat().st_size > 16384:
        return 2
    try:
        configuration = json.loads(args.consumer_config.read_text(encoding="utf8"))
        executor = PersonalSessionExecutor(configuration) if isinstance(configuration, dict) and configuration.get("version") == 2 else PersonalExecutor(configuration)
        return run(args.incarnation,executor)
    except Exception: return 2


if __name__ == "__main__": raise SystemExit(main())
