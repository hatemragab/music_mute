// Offline pinned-downloader fixtures only; no acquisition, inference or browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const resources = join(
  homedir(),
  "Applications/MusicMute Local.app/Contents/Resources",
);
const output = join(root, "output/source-selection-proof", randomUUID());
const wheel = join(
  process.env.MUSICMUTE_LOCAL_DOWNLOADER_TARGET ??
    join(root, "output/downloader-wheel-qualification/downloader"),
  "yt_dlp-2026.8.19-py3-none-any.whl",
);
const wheelDigest =
  "1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf";
const wheelSize = 3_185_533;
const python =
  process.env.MUSICMUTE_SOURCE_SELECTION_PYTHON ??
  join(resources, "runtime/runtime/python/bin/python3");
const selector =
  "bestaudio[protocol=https]/bestaudio[protocol=http_dash_segments]";
const previousSelector = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio";
const metadataTemplate =
  "after_move:%(.{id,duration,extractor_key,is_live,live_status,format_id,vcodec,acodec,language,language_preference,musicmute_audio_track_id,musicmute_audio_is_default,ext,filepath})j";
const started = Date.now();
const activeStops = new Set();
const activePids = new Set();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    for (const stop of activeStops) stop("QUALIFICATION_INTERRUPTED");
  });
}
process.once("exit", () => {
  for (const pid of activePids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  }
});
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  scope: "PINNED_YT_DLP_OFFLINE_SOURCE_SELECTION_AND_STDIN_REPLAY",
  source_projection: "CURRENT_TYPESCRIPT_PROJECTION_BUNDLED_FROM_SOURCE",
  acquisition: false,
  inference: false,
  browser_playback: false,
  browser_selected_track_verified: false,
  underlying_full_audio_track_id_verified: false,
  checks: [],
  cases: [],
};

// The actual pinned CLI parses stdin and selects/processes formats. Network,
// extraction and child tools are fenced before invoking that CLI in every case.
const fixturePython = String.raw`
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time
import traceback

MAX_OUTPUT = 512 * 1024
counts = {"network": 0, "urlopen": 0, "extraction": 0, "tools": 0, "transfer": 0}
tool_kinds = []
tool_sources = []

def blocked_network(*args, **kwargs):
    counts["network"] += 1
    raise OSError("OFFLINE_NETWORK_BLOCKED")

socket.socket.connect = blocked_network
socket.socket.connect_ex = blocked_network
socket.getaddrinfo = blocked_network
socket.create_connection = blocked_network

def audit(event, args):
    if event in ("socket.connect", "socket.getaddrinfo"):
        blocked_network()
    if event in ("subprocess.Popen", "os.system", "os.posix_spawn", "os.fork", "os.forkpty", "os.exec"):
        counts["tools"] += 1
        executable = Path(str(args[0])).name
        tool_kinds.append(executable if executable in ("sw_vers", "uname", "file", "getconf", "ffmpeg", "ffprobe", "node") else "OTHER_TOOL")
        tool_sources.append([frame.name for frame in traceback.extract_stack(limit=8) if frame.name.replace("_", "").isalnum()])
        raise OSError("OFFLINE_TOOL_BLOCKED")

sys.addaudithook(audit)
os.umask(0o077)
archive = Path(sys.argv[1])
mode = sys.argv[2]
format_selector = sys.argv[3]
template = sys.argv[4]
expected_transfer_digest = sys.argv[5]
expected_parent = int(sys.argv[6])
transfer_identity_matched = False
def watch_parent():
    while True:
        if os.getppid() != expected_parent:
            os._exit(1)
        time.sleep(0.2)
threading.Thread(target=watch_parent, daemon=True).start()
if not (sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode):
    raise RuntimeError("PYTHON_ISOLATION_REQUIRED")
if archive.stat().st_size != 3185533 or hashlib.sha256(archive.read_bytes()).hexdigest() != "1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf":
    raise RuntimeError("WHEEL_IDENTITY_INVALID")
sys.path.insert(0, str(archive))
import yt_dlp
from yt_dlp import YoutubeDL
from yt_dlp.downloader.http import HttpFD
from yt_dlp.utils import DownloadError

def blocked_urlopen(self, *args, **kwargs):
    counts["urlopen"] += 1
    raise DownloadError("OFFLINE_URLOPEN_BLOCKED")

def extraction_spy(self, *args, **kwargs):
    counts["extraction"] += 1
    raise DownloadError("OFFLINE_EXTRACTION_BLOCKED")

def fixture_transfer(self, filename, info_dict):
    global transfer_identity_matched
    counts["transfer"] += 1
    identity = [info_dict.get(key) for key in ("url", "format_id", "language", "language_preference", "musicmute_audio_track_id", "musicmute_audio_is_default", "vcodec", "acodec", "ext")]
    transfer_identity_matched = hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest() == expected_transfer_digest
    if not transfer_identity_matched:
        raise RuntimeError("FIXTURE_TRANSFER_IDENTITY_MISMATCH")
    if mode != "success":
        raise DownloadError("FIXTURE_TRANSFER_FAILED")
    destination = Path(filename)
    if destination.parent.resolve() != Path.cwd().resolve() or destination.exists():
        raise RuntimeError("FIXTURE_DESTINATION_INVALID")
    destination.write_bytes(b"offline-webm-fixture-not-decoded\n")
    return True

YoutubeDL.urlopen = blocked_urlopen
YoutubeDL.extract_info = extraction_spy
HttpFD.real_download = fixture_transfer

class BoundedCapture(io.StringIO):
    def __init__(self):
        super().__init__()
        self.size = 0
    def write(self, value):
        self.size += len(value.encode("utf-8"))
        if self.size > MAX_OUTPUT:
            raise RuntimeError("FIXTURE_OUTPUT_LIMIT")
        return super().write(value)

captured_stdout = BoundedCapture()
captured_stderr = BoundedCapture()
arguments = ["--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-remote-components", "--no-js-runtimes", "--quiet", "--no-warnings", "--no-progress", "--retries", "0", "--fragment-retries", "0", "-f", format_selector, "--load-info-json", "-"]
if mode == "simulate":
    arguments.extend(["--simulate", "--dump-single-json"])
else:
    arguments.extend(["--no-simulate", "-o", str(Path.cwd() / "source.%(ext)s"), "--print", template])
exit_code = 0
with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(captured_stderr):
    try:
        yt_dlp.main(arguments)
    except SystemExit as error:
        exit_code = error.code if isinstance(error.code, int) else (0 if error.code is None else 1)
    except Exception:
        exit_code = 2

result = {"exit_code": exit_code, "counts": counts, "child_tool_launches": 0, "blocked_tool_kinds": tool_kinds, "blocked_tool_source_functions": tool_sources, "transfer_identity_matched": transfer_identity_matched, "stdout_bytes": captured_stdout.size, "stderr_bytes": captured_stderr.size}
text = captured_stdout.getvalue().strip()
if exit_code == 0:
    info = json.loads(text)
    safe_fields = ("id", "duration", "extractor_key", "is_live", "live_status", "format_id", "vcodec", "acodec", "language", "language_preference", "musicmute_audio_track_id", "musicmute_audio_is_default", "ext")
    result["selected"] = {key: info[key] for key in safe_fields if key in info}
    if mode == "simulate":
        result["selected_transport"] = {key: info[key] for key in ("url", "format_id", "language", "language_preference", "musicmute_audio_track_id", "musicmute_audio_is_default", "vcodec", "acodec", "ext") if key in info}
        result["format_identities"] = [{key: entry[key] for key in ("format_id", "language", "language_preference", "musicmute_audio_track_id", "musicmute_audio_is_default", "ext") if key in entry} for entry in info["formats"]]
    else:
        media = Path(info["filepath"])
        result["downloaded_metadata"] = info
        result["fixture_output_owned"] = media.parent.resolve() == Path.cwd().resolve() and media.is_file() and not media.is_symlink() and (media.stat().st_mode & 0o077) == 0
        result["fixture_output_sha256"] = hashlib.sha256(media.read_bytes()).hexdigest()
        result["private_url_fields_absent"] = not any(key in info for key in ("url", "formats", "webpage_url", "original_url", "http_headers", "fragments"))
print(json.dumps(result, separators=(",", ":")))
`;

function check(name, condition) {
  assert.ok(condition, "QUALIFICATION_CHECK_FAILED");
  report.checks.push(name);
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  assert.ok(
    info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o077),
    "UNSAFE_FIXTURE_DIRECTORY",
  );
}

async function readOwnedFile(path, maximum) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.uid === process.getuid() &&
      info.size <= maximum,
    "UNSAFE_FIXTURE_FILE",
  );
  return readFile(path);
}

function runFixture(
  name,
  mode,
  formatSelector,
  info,
  expectedFormat = info.formats[0],
) {
  if (interrupted) throw new Error("QUALIFICATION_INTERRUPTED");
  const work = join(output, name);
  return privateDirectory(work).then(
    () =>
      new Promise((resolveResult, reject) => {
        const input = JSON.stringify(info);
        assert.ok(Buffer.byteLength(input) < 64 * 1024, "FIXTURE_INPUT_LIMIT");
        const child = spawn(
          python,
          [
            "-I",
            "-B",
            "-S",
            "-c",
            fixturePython,
            wheel,
            mode,
            formatSelector,
            metadataTemplate,
            digest(
              JSON.stringify(
                [
                  "url",
                  "format_id",
                  "language",
                  "language_preference",
                  "musicmute_audio_track_id",
                  "musicmute_audio_is_default",
                  "vcodec",
                  "acodec",
                  "ext",
                ].map((key) => expectedFormat[key] ?? null),
              ),
            ),
            String(process.pid),
          ],
          {
            cwd: work,
            detached: true,
            env: {
              HOME: join(output, "home"),
              TMPDIR: join(output, "tmp"),
              PATH: "/usr/bin:/bin",
              LANG: "en_US.UTF-8",
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        if (child.pid) activePids.add(child.pid);
        let stdout = "";
        let outputBytes = 0;
        let failure;
        let escalation;
        function stop(code) {
          failure ??= new Error(code);
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            /* Already exited. */
          }
          activeStops.add(stop);
          escalation ??= setTimeout(() => {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Already exited. */
            }
          }, 500);
        }
        const deadline = setTimeout(
          () => stop("FIXTURE_TIMEOUT"),
          Math.max(1, Math.min(20_000, 90_000 - (Date.now() - started))),
        );
        child.on("error", () => stop("FIXTURE_START_FAILED"));
        child.stdin.on("error", () => {
          /* Early child failure is handled on close. */
        });
        child.stdout.on("data", (chunk) => {
          outputBytes += chunk.length;
          if (outputBytes > 64 * 1024) stop("FIXTURE_OUTPUT_LIMIT");
          else stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
          outputBytes += chunk.length;
          if (outputBytes > 64 * 1024) stop("FIXTURE_OUTPUT_LIMIT");
        });
        child.on("close", (code, signal) => {
          activeStops.delete(stop);
          activePids.delete(child.pid);
          clearTimeout(deadline);
          if (escalation) clearTimeout(escalation);
          if (failure) {
            reject(failure);
            return;
          }
          if (code !== 0 || signal) {
            reject(new Error("FIXTURE_CHILD_FAILED"));
            return;
          }
          try {
            const result = JSON.parse(stdout);
            try {
              process.kill(-child.pid, 0);
              result.owned_process_group_gone = false;
            } catch (error) {
              result.owned_process_group_gone = error.code === "ESRCH";
            }
            const {
              downloaded_metadata: _metadata,
              selected_transport: _transport,
              ...safeResult
            } = result;
            report.cases.push({ name, ...safeResult });
            resolveResult(result);
          } catch {
            reject(new Error("FIXTURE_RESULT_INVALID"));
          }
        });
        child.stdin.end(input);
      }),
  );
}

function format(formatId, language, preference, ext) {
  return {
    format_id: formatId,
    language,
    language_preference: preference,
    ext,
    acodec: ext === "webm" ? "opus" : "mp4a.40.2",
    vcodec: "none",
    protocol: "https",
    url: `https://fixture.googlevideo.com/offline-fixture/${formatId}-${language}-${preference}-${ext}`,
    container: `${ext}_dash`,
    abr: preference === 10 ? 64 : 128,
    http_headers: { "User-Agent": "MusicMuteOfflineFixture" },
    downloader_options: { http_chunk_size: 10 * 1024 * 1024 },
  };
}

function video(formats, extra = {}) {
  return {
    _type: "video",
    id: "fixture0001",
    title: "Offline source-selection fixture",
    duration: 19,
    extractor: "youtube",
    extractor_key: "Youtube",
    is_live: false,
    live_status: "not_live",
    formats,
    ...extra,
  };
}

function guarded(name, result, extraction = 0, transfers = 0) {
  check(
    `${name}: network fenced and child tool attempts blocked before launch`,
    result.counts.network === 0 &&
      result.counts.urlopen === 0 &&
      result.child_tool_launches === 0 &&
      result.owned_process_group_gone === true,
  );
  check(
    `${name}: expected extraction and fixture transfer counts`,
    result.counts.extraction === extraction &&
      result.counts.transfer === transfers,
  );
}

try {
  assert.equal(process.platform, "darwin", "MACOS_REQUIRED");
  assert.equal(process.argv.length, 2, "ARGUMENTS_INVALID");
  await privateDirectory(output);
  await privateDirectory(join(output, "home"));
  await privateDirectory(join(output, "tmp"));
  const archive = await readOwnedFile(wheel, wheelSize);
  check(
    "pinned wheel size and SHA-256 verified before import",
    archive.length === wheelSize && digest(archive) === wheelDigest,
  );
  report.wheel_sha256 = wheelDigest;
  report.python_sha256 = digest(
    await readOwnedFile(await realpath(python), 128 * 1024 * 1024),
  );
  report.script_sha256 = digest(await readFile(import.meta.filename));
  report.fixture_python_sha256 = digest(fixturePython);
  const sourcePath = join(root, "src/companion/local-provider.ts");
  const sourceBytes = await readFile(sourcePath);
  report.typescript_source_sha256 = digest(sourceBytes);
  const adapterPath = join(output, "source-adapter.mjs");
  await build({
    stdin: {
      contents: `export { validateSourceMetadata, validateDownloadedMetadata } from ${JSON.stringify(sourcePath)};`,
      resolveDir: root,
      sourcefile: "source-selection-adapter.mjs",
    },
    outfile: adapterPath,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    logLevel: "silent",
  });
  await chmod(adapterPath, 0o600);
  const adapter = await import(pathToFileURL(adapterPath).href);
  const request = {
    provider: "LOCAL_MACOS",
    video_id: "fixture0001",
    duration_seconds: 19,
  };
  const original = format("251", "en", 10, "webm");
  original.musicmute_audio_track_id = "en.4";
  original.musicmute_audio_is_default = false;
  const dubbed = format("140", "ar", 5, "m4a");
  const preferred = await runFixture(
    "original-preference",
    "simulate",
    selector,
    video([dubbed, original]),
  );
  guarded("original preference", preferred);
  check(
    "actual pinned best-audio selector prefers original WebM over default M4A",
    preferred.exit_code === 0 &&
      preferred.selected.format_id === "251" &&
      preferred.selected.language_preference === 10 &&
      preferred.selected.musicmute_audio_track_id === "en.4" &&
      preferred.selected.musicmute_audio_is_default === false,
  );
  let refusal;
  try {
    adapter.validateSourceMetadata(
      video([dubbed, original], original),
      request,
    );
  } catch (error) {
    refusal = error.code;
  }
  check(
    "actual TypeScript qualification refuses multiple exposed audio profiles",
    refusal === "SOURCE_AUDIO_TRACK_UNSUPPORTED",
  );
  const previous = await runFixture(
    "container-first-control",
    "simulate",
    previousSelector,
    video([dubbed, original]),
  );
  guarded("container-first negative control", previous);
  check(
    "old container-first selector reproduces default M4A selection",
    previous.exit_code === 0 &&
      previous.selected.format_id === "140" &&
      previous.selected.language_preference === 5,
  );
  const duplicates = await runFixture(
    "duplicate-id-renumbering",
    "simulate",
    selector,
    video([format("140", "ar", 5, "m4a"), format("140", "en", 10, "m4a")]),
  );
  guarded("duplicate format IDs", duplicates);
  check(
    "actual pinned processing assigns distinct positional format IDs",
    duplicates.exit_code === 0 &&
      duplicates.format_identities.length === 2 &&
      new Set(duplicates.format_identities.map((entry) => entry.format_id))
        .size === 2 &&
      duplicates.format_identities.every((entry) =>
        /^140-[01]$/.test(entry.format_id),
      ),
  );
  const selectedId = duplicates.selected.format_id;
  const selectedDuplicate = format(selectedId, "en", 10, "m4a");
  selectedDuplicate.url = duplicates.selected_transport.url;
  const duplicateSource = adapter.validateSourceMetadata(
    video([selectedDuplicate], selectedDuplicate),
    request,
  );
  const replay = await runFixture(
    "one-entry-replay",
    "simulate",
    duplicateSource.format_id,
    duplicateSource.download_info,
  );
  guarded("one-entry replay", replay);
  check(
    "single-entry stdin replay preserves selected duplicate ID and language marker",
    replay.exit_code === 0 &&
      replay.selected.format_id === selectedId &&
      replay.selected.language === "en" &&
      replay.selected.language_preference === 10,
  );
  refusal = undefined;
  try {
    adapter.validateSourceMetadata(
      video(
        [format("140", "en", 10, "m4a"), format("140", "en", 10, "m4a")],
        format("140", "en", 10, "m4a"),
      ),
      request,
    );
  } catch (error) {
    refusal = error.code;
  }
  check(
    "actual TypeScript qualification rejects duplicate selected format IDs",
    refusal === "SOURCE_AUDIO_TRACK_UNVERIFIED",
  );
  const alternateId = {
    ...original,
    format_id: "140",
    musicmute_audio_track_id: "en.5",
  };
  refusal = undefined;
  try {
    adapter.validateSourceMetadata(
      video([original, alternateId], original),
      request,
    );
  } catch (error) {
    refusal = error.code;
  }
  check(
    "distinct known full IDs sharing language and preference are refused",
    refusal === "SOURCE_AUDIO_TRACK_UNSUPPORTED",
  );
  const unknown = format("251", "en", 10, "webm");
  const unknownSource = adapter.validateSourceMetadata(
    video([unknown], unknown),
    request,
  );
  check(
    "single-profile source without raw track fields remains supported and unknown",
    unknownSource.identity.musicmute_audio_track_id === null &&
      unknownSource.identity.musicmute_audio_is_default === null,
  );
  const source = adapter.validateSourceMetadata(
    video([original], original),
    request,
  );
  check(
    "actual TypeScript replay preserves the original selected transport URL",
    source.download_info.formats[0].url === original.url &&
      duplicateSource.download_info.formats[0].url ===
        duplicates.selected_transport.url,
  );
  check(
    "actual TypeScript transfer projection removes extraction and private metadata fields",
    source.download_info._type === "video" &&
      source.download_info.formats.length === 1 &&
      ![
        "webpage_url",
        "original_url",
        "additional_urls",
        "entries",
        "requested_downloads",
      ].some((key) => key in source.download_info),
  );
  const failed = await runFixture(
    "strict-transfer-failure",
    "failure",
    source.format_id,
    source.download_info,
    original,
  );
  guarded("strict transfer failure", failed, 0, 1);
  check(
    "injected DownloadError fails without fresh extraction",
    failed.exit_code !== 0,
  );
  const fallback = await runFixture(
    "webpage-fallback-control",
    "failure",
    "251",
    video([original], {
      webpage_url: "https://www.youtube.com/watch?v=fixture0001",
    }),
  );
  guarded("webpage fallback negative control", fallback, 1, 1);
  check(
    "retained webpage URL reproduces extraction fallback and is blocked",
    fallback.exit_code !== 0,
  );
  const succeeded = await runFixture(
    "after-move-projection",
    "success",
    source.format_id,
    source.download_info,
    original,
  );
  guarded("successful offline transfer", succeeded, 0, 1);
  check(
    "actual after_move template emits expected source and selected audio identity",
    succeeded.exit_code === 0 &&
      succeeded.selected.id === "fixture0001" &&
      succeeded.selected.duration === 19 &&
      succeeded.selected.extractor_key === "Youtube" &&
      succeeded.selected.live_status === "not_live" &&
      succeeded.selected.is_live === false &&
      succeeded.selected.format_id === "251" &&
      succeeded.selected.ext === "webm" &&
      succeeded.selected.acodec === "opus" &&
      succeeded.selected.vcodec === "none" &&
      succeeded.selected.language === "en" &&
      succeeded.selected.language_preference === 10 &&
      succeeded.selected.musicmute_audio_track_id === "en.4" &&
      succeeded.selected.musicmute_audio_is_default === false,
  );
  check(
    "fixture output remains private and inside disposable owned work directory",
    succeeded.fixture_output_owned === true &&
      succeeded.fixture_output_sha256 ===
        digest("offline-webm-fixture-not-decoded\n"),
  );
  check(
    "actual transfer receives the frozen selected URL and audio identity",
    failed.transfer_identity_matched &&
      fallback.transfer_identity_matched &&
      succeeded.transfer_identity_matched,
  );
  check(
    "after_move output excludes private URLs, headers and format arrays",
    succeeded.private_url_fields_absent === true,
  );
  check(
    "actual TypeScript downloaded metadata validator accepts pinned after_move output",
    adapter.validateDownloadedMetadata(
      succeeded.downloaded_metadata,
      source,
    ) === succeeded.downloaded_metadata.filepath,
  );
  for (const changed of [
    { musicmute_audio_track_id: "en.5" },
    { musicmute_audio_track_id: undefined },
    { musicmute_audio_is_default: true },
  ]) {
    refusal = undefined;
    try {
      adapter.validateDownloadedMetadata(
        { ...succeeded.downloaded_metadata, ...changed },
        source,
      );
    } catch (error) {
      refusal = error.code;
    }
    check(
      "download projection cannot change or discard preserved raw track evidence",
      refusal === "SOURCE_AUDIO_TRACK_MISMATCH",
    );
  }
  check(
    "reviewed TypeScript source remained unchanged during qualification",
    digest(await readFile(sourcePath)) === report.typescript_source_sha256,
  );
  report.result = "PASSED";
} catch (error) {
  report.result = "FAILED";
  const code = error instanceof Error ? error.message : "QUALIFICATION_FAILED";
  report.failure_code = /^[A-Z_]{1,80}$/.test(code)
    ? code
    : "QUALIFICATION_FAILED";
  process.exitCode = 1;
} finally {
  report.elapsed_ms = Date.now() - started;
  await privateDirectory(dirname(output));
  await privateDirectory(output);
  const reportPath = join(output, "result.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(reportPath, 0o600);
  process.stdout.write(
    `${JSON.stringify({ result: report.result, checks: report.checks.length, elapsed_ms: report.elapsed_ms, report: reportPath })}\n`,
  );
}
