"""Cloud Run Job entrypoint — per-job pipeline.

Usage:
  python -m app.workers.separation --job-id <id>

Implements PLAN.md §6 pipeline:
  S3 uploads/{job_id}/input.*  OR  youtube  ->  /tmp/input  ->  ffmpeg 44.1k stereo
  -> SeparatorWrapper (ONNX baked)  ->  ffmpeg mp3 192k  ->  S3 results/{job_id}/
  -> MongoDB status done/failed + S3 uploads prefix cleanup.

All heavy deps are guarded / lazy so the module is importable without them.
"""

from __future__ import annotations

import argparse
import asyncio
import glob
import logging
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Progress / stage helpers
# ---------------------------------------------------------------------------

async def _mark(job_id: str, *, status: str | None = None, progress: int | None = None, stage: str | None = None, extra: dict | None = None) -> None:
    fields: dict[str, Any] = {}
    if status is not None:
        fields["status"] = status
    if progress is not None:
        fields["progress"] = int(progress)
    if stage is not None:
        fields["stage"] = stage
    if extra:
        fields.update(extra)
    if not fields:
        return
    try:
        from app.jobs import update_job  # type: ignore

        ok = await update_job(job_id, fields)
        if not ok:
            logger.warning("update_job %s -> %r matched nothing", job_id, fields)
    except Exception as exc:
        logger.warning("update_job %s -> %r failed: %s", job_id, fields, exc)


async def _mark_failed(job_id: str, msg: str) -> None:
    now = datetime.now(timezone.utc)
    await _mark(job_id, status="failed", progress=100, stage="failed", extra={"error": msg, "finishedAt": now, "finished_at": now})


# ---------------------------------------------------------------------------
# S3 helpers (best-effort, guarded)
# ---------------------------------------------------------------------------

def _download_upload_input(job_id: str, dest_dir: str) -> str | None:
    """Try to download the S3 uploads/{job_id}/ object to dest_dir. Returns path or None."""
    try:
        from app.storage import get_s3_client, s3_bucket  # type: ignore

        c = get_s3_client()
        if c is None:
            return None
        bucket = s3_bucket()
        prefix = f"uploads/{job_id}/"
        resp = c.list_objects_v2(Bucket=bucket, Prefix=prefix)
        keys = [o["Key"] for o in resp.get("Contents", []) if o.get("Key")]
        if not keys:
            return None
        # Pick first key (normally uploads/{job_id}/input.<ext>)
        key = keys[0]
        filename = Path(key).name or "input"
        dest = str(Path(dest_dir) / filename)
        c.download_file(bucket, key, dest)
        # If the key had no extension andcontent-type was set, keep as-is.
        logger.info("Downloaded S3 upload %s -> %s", key, dest)
        return dest
    except Exception as exc:
        logger.warning("S3 download uploads/%s failed: %s", job_id, exc)
        return None


def _upload_results(job_id: str, mp3_paths: list[str]) -> list[dict[str, Any]]:
    """Upload mp3s to S3 results/{job_id}/. Returns results[] entries."""
    entries: list[dict[str, Any]] = []
    try:
        from app.storage import get_s3_client, result_key, s3_bucket  # type: ignore
        from app.services.ffmpeg import probe  # type: ignore

        c = get_s3_client()
        if c is None:
            # No S3 — still build entries with local paths.
            for p in mp3_paths:
                stem = Path(p).stem
                entries.append({"stem": stem, "url": f"/api/v1/results/{job_id}/{Path(p).name}", "size_bytes": _file_size(p), "duration_s": None})
            return entries

        bucket = s3_bucket()
        for p in mp3_paths:
            basename = Path(p).name
            # Normalize stem: vocals, instrumental, drums, bass, other, accompaniment -> instrumental
            stem_raw = Path(p).stem.lower()
            stem = _normalize_stem(stem_raw)
            key = result_key(job_id, basename)
            try:
                c.upload_file(p, bucket, key)
                logger.info("Uploaded %s -> s3://%s/%s", p, bucket, key)
            except Exception as exc:
                logger.warning("S3 upload %s -> %s failed: %s", p, key, exc)
            # Collect metadata for Mongo results[]
            size = _file_size(p)
            try:
                meta = probe(p)
                dur = meta.get("duration_s")
            except Exception:
                dur = None
            entries.append({"stem": stem, "url": f"/api/v1/results/{job_id}/{basename}", "size_bytes": size, "duration_s": dur})
        return entries
    except Exception as exc:
        logger.warning("_upload_results failed for %s: %s", job_id, exc)
        for p in mp3_paths:
            stem = _normalize_stem(Path(p).stem.lower())
            entries.append({"stem": stem, "url": f"/api/v1/results/{job_id}/{Path(p).name}", "size_bytes": _file_size(p), "duration_s": None})
        return entries


def _cleanup_s3_uploads(job_id: str) -> None:
    try:
        from app.storage import get_s3_client, s3_bucket  # type: ignore

        c = get_s3_client()
        if c is None:
            return
        bucket = s3_bucket()
        prefix = f"uploads/{job_id}/"
        resp = c.list_objects_v2(Bucket=bucket, Prefix=prefix)
        for o in resp.get("Contents", []) or []:
            key = o.get("Key")
            if key:
                try:
                    c.delete_object(Bucket=bucket, Key=key)
                except Exception:
                    pass
        logger.info("Cleaned S3 uploads prefix %s", prefix)
    except Exception as exc:
        logger.warning("S3 uploads cleanup %s failed: %s", job_id, exc)


def _file_size(p: str) -> int | None:
    try:
        return int(Path(p).stat().st_size)
    except Exception:
        return None


def _normalize_stem(raw_stem: str) -> str:
    s = raw_stem.lower()
    # audio-separator filenames look like "vocals_UVR-MDX..." etc.
    if "vocal" in s:
        return "vocals"
    if "instrument" in s or "accompan" in s:
        return "instrumental"
    if "drum" in s:
        return "drums"
    if "bass" in s:
        return "bass"
    if "other" in s:
        return "other"
    # Fallback: raw basename first token
    return raw_stem.split("_")[0].split("-")[0][:32] or raw_stem[:32]


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

async def run_job(job_id: str) -> None:
    """Execute the full pipeline for job_id.

    Must be called from an async context (the CLI wraps with asyncio.run).
    """
    from app.jobs import get_job  # type: ignore

    job = await get_job(job_id)
    if job is None:
        raise SystemExit(f"Job {job_id!r} not found (MongoDB/fallback has no such _id)")

    model: str = (job.get("model") or job.get("MODEL") or "UVR-MDX-NET-Inst_HQ_3")  # type: ignore[assignment]
    stems: str = (job.get("stems") or "2stems")  # type: ignore[assignment]
    source: str = (job.get("source") or ("youtube" if job.get("youtube_url") or job.get("youtubeUrl") else "upload"))
    youtube_url: str | None = job.get("youtube_url") or job.get("youtubeUrl")  # type: ignore[assignment]
    title: str | None = job.get("title")

    tmpdir = tempfile.mkdtemp(prefix=f"vocal-{job_id}-")
    # Track files to clean: tmpdir is whacked in finally.
    raw_input_path: str | None = None
    normalized_wav: str | None = None

    try:
        # --- Mark processing/have leasing semantics via stage + progress ---
        await _mark(job_id, status="processing", progress=5, stage="downloading")

        # --- Resolve input (S3 upload vs youtube) ---
        if youtube_url and source == "youtube":
            # YouTube path — validate + download inside the Job (per PLAN 6).
            try:
                from app.services.youtube import download_audio, preflight  # type: ignore
            except ImportError as exc:
                raise RuntimeError(f"yt-dlp not available for YouTube job: {exc}") from exc

            cookies_secret = os.environ.get("YT_COOKIES_SECRET")

            # Preflight re-check (api already validated; Job re-checks for TTL/limit enforcement)
            try:
                meta = preflight(youtube_url, cookies_secret=cookies_secret)
                if meta.get("title") and not title:
                    title = meta["title"]  # type: ignore[assignment]
            except ValueError as exc:
                await _mark_failed(job_id, str(exc))
                raise SystemExit(str(exc)) from exc
            except RuntimeError as exc:
                # Surface yt-dlp preflight error but allow download attempt anyway.
                logger.warning("YouTube preflight for %s failed (continuing): %s", job_id, exc)

            yt_raw = str(Path(tmpdir) / "yt_input")
            try:
                raw_input_path = download_audio(youtube_url, yt_raw, cookies_secret=cookies_secret)
            except ValueError as exc:
                await _mark_failed(job_id, str(exc))
                raise SystemExit(str(exc)) from exc
            except RuntimeError as exc:
                await _mark_failed(job_id, str(exc))
                raise
            except ImportError as exc:
                await _mark_failed(job_id, str(exc))
                raise
        else:
            # Upload path — pull S3 uploads/{job_id}/ to /tmp
            p = _download_upload_input(job_id, tmpdir)
            if p is None:
                # Fallback: look for any file that might already be on disk (local dev without S3)
                # Common local path: /tmp/vocal-* or uploads/
                globs = [
                    str(Path(tmpdir) / "input*"),
                    f"/tmp/uploads/{job_id}/*",
                    f"uploads/{job_id}/*",
                ]
                found: list[str] = []
                for pat in globs:
                    found.extend(glob.glob(pat))
                # Also try to infer from job doc: job["input_path"] / job["s3_key"]
                for k in ("input_path", "s3_key", "inputKey", "key"):
                    v = job.get(k)
                    if isinstance(v, str) and Path(v).exists():
                        found.append(v)
                if found:
                    p = found[0]
                else:
                    msg = (
                        f"No input found for job {job_id!r} (source={source!r}). "
                        f"Expected S3 s3://.../uploads/{job_id}/ or YouTube URL. "
                        f"Checked S3 prefix uploads/{job_id}/ and local fallbacks."
                    )
                    await _mark_failed(job_id, msg)
                    raise SystemExit(msg)
            raw_input_path = p

        assert raw_input_path is not None

        # --- Convert to 44.1 kHz stereo wav (separator expects this) ---
        await _mark(job_id, progress=15, stage="converting")
        try:
            from app.services.ffmpeg import convert_to_wav, probe  # type: ignore
        except ImportError as exc:
            await _mark_failed(job_id, f"ffmpeg helpers unavailable: {exc}")
            raise

        # Probe duration cap (20 min cap, PLAN.md 4)
        try:
            pmeta = probe(raw_input_path)
            dur = pmeta.get("duration_s")
            if isinstance(dur, (int, float)) and dur > 1200:
                msg = f"Audio too long ({dur:.0f}s > 1200s / 20 min)"
                await _mark_failed(job_id, msg)
                raise SystemExit(msg)
        except RuntimeError:
            # ffprobe unavailable or failed — carry on; downstream will fail if truly invalid.
            pass
        except SystemExit:
            raise

        normalized_wav = str(Path(tmpdir) / "input.wav")
        try:
            convert_to_wav(raw_input_path, normalized_wav, sr=44100, channels=2)
        except RuntimeError as exc:
            await _mark_failed(job_id, f"Audio conversion failed: {exc}")
            raise

        # --- Separate ---
        await _mark(job_id, progress=30, stage="separating")
        try:
            from app.services.separator import SeparatorWrapper  # type: ignore
        except ImportError as exc:
            await _mark_failed(job_id, f"Separator not available: {exc}")
            raise

        try:
            wrapper = SeparatorWrapper.get(model)
        except FileNotFoundError as exc:
            await _mark_failed(job_id, str(exc))
            raise
        except ImportError as exc:
            await _mark_failed(job_id, str(exc))
            raise
        except (ValueError, RuntimeError) as exc:
            await _mark_failed(job_id, str(exc))
            raise

        try:
            wav_outputs = wrapper.separate(normalized_wav, model=model, stems=stems)
        except FileNotFoundError as exc:
            await _mark_failed(job_id, str(exc))
            raise
        except RuntimeError as exc:
            await _mark_failed(job_id, f"Separation failed: {exc}")
            raise
        except Exception as exc:  # noqa: BLE001
            await _mark_failed(job_id, f"Separation failed: {exc}")
            raise RuntimeError(f"Separation failed: {exc}") from exc

        if not wav_outputs:
            msg = "Separator produced no outputs"
            await _mark_failed(job_id, msg)
            raise RuntimeError(msg)

        # --- Encode mp3 192k ---
        await _mark(job_id, progress=80, stage="encoding")
        try:
            from app.services.ffmpeg import encode_mp3  # type: ignore
        except ImportError as exc:
            await _mark_failed(job_id, f"ffmpeg helpers unavailable: {exc}")
            raise

        mp3_paths: list[str] = []
        for wav in wav_outputs:
            # Put mp3 sibling next to wav in tmpdir for easy upload
            base = Path(wav).stem
            # Preserve stem-ish basename but ensure no path escapes
            safe = "".join(c for c in base if c.isalnum() or c in ("-", "_", ".", " "))[:80].strip() or "stem"
            safe = safe.replace(" ", "_")
            mp3 = str(Path(tmpdir) / f"{safe}.mp3")
            try:
                encode_mp3(wav, mp3, bitrate="192k")
                mp3_paths.append(mp3)
            except RuntimeError as exc:
                # One stem failed to encode — log and continue with the others
                logger.warning("encode_mp3 %s -> %s failed: %s", wav, mp3, exc)
                # Keep the wav as fallback result instead
                mp3_paths.append(wav)

        if not mp3_paths:
            msg = "Encoding produced no outputs"
            await _mark_failed(job_id, msg)
            raise RuntimeError(msg)

        # --- Upload results ---
        results = _upload_results(job_id, mp3_paths)
        # If S3 is configured but no results were uploaded, fail instead of
        # marking done with empty results. Local-dev fallback (S3 not
        # configured) keeps local-path results — do not fail there.
        try:
            from app.storage import is_s3_configured as _is_s3_configured  # type: ignore

            _s3_configured = _is_s3_configured()
        except Exception:
            _s3_configured = False
        if _s3_configured and len(results) == 0:
            await _mark_failed(job_id, "result upload failed")
            raise RuntimeError("result upload failed")

        # --- Mark done + cleanup ---
        now = datetime.now(timezone.utc)
        await _mark(
            job_id,
            status="done",
            progress=100,
            stage="done",
            extra={"results": results, "finishedAt": now, "finished_at": now, "error": None},
        )
        try:
            _cleanup_s3_uploads(job_id)
        except Exception:
            pass

        logger.info("Job %s done: %d stems -> S3 results/%s/", job_id, len(results), job_id)

    except SystemExit:
        # Already marked appropriately — re-raise.
        raise
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)[:2000] if str(exc) else type(exc).__name__
        logger.exception("Job %s failed: %s", job_id, msg)
        try:
            await _mark_failed(job_id, msg)
        except Exception:
            pass
        raise
    finally:
        # Best-effort tmp cleanup — only remove this job's tmpdir.
        # Do NOT glob-sweep /tmp/vocals* etc: on Cloud Run Jobs concurrent
        # executions share /tmp namespace and a global sweep can delete
        # another job's in-flight files (race). Each job owns only its tmpdir.
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Vocal remover Cloud Run Job worker")
    parser.add_argument("--job-id", required=True, help="MongoDB _id / job_id of the job to run")
    args = parser.parse_args()

    # Ensure structured logging mirrors app.logging if available
    try:
        from app.logging import setup_logging  # type: ignore

        setup_logging()
    except Exception:
        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    try:
        asyncio.run(run_job(args.job_id))
    except SystemExit as exc:
        # Return non-zero on failed job so Cloud Run Job execution shows as failed.
        # Keep the message on stderr for logs even when we exit.
        if exc.code and str(exc.code).strip():
            print(f"Job {args.job_id} failed: {exc.code}", flush=True)
        raise


if __name__ == "__main__":
    main()
