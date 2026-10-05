"""Private stdin-only yt-dlp child. Never writes extractor payloads or secrets.

No extraction retries, video downloads, manifests, FFmpeg, browser cookies,
remote EJS downloads, postprocessing or alternative acquisition tools.
"""
import errno
import json
import math
from pathlib import Path
import re
import sys
import time
import unicodedata
from urllib.parse import unquote, urlsplit

from diagnostics import clean_context, clean_timings, exception_context


MAX_BYTES = 100_000_000
MAX_DURATION_SECONDS = 1800
FORMAT_LIMIT = 12
TEXT_FIELDS = {
    'provider': 64, 'site': 64, 'format_id': 64, 'extension': 16,
    'audio_codec': 64, 'container': 64, 'language': 32, 'title': 200,
    'artist': 200, 'album': 200, 'channel': 200, 'description': 1000,
}
NUMBER_FIELDS = {
    'bitrate_kbps': 10000, 'sample_rate_hz': 384000, 'audio_channels': 32,
    'provider_file_bytes': MAX_BYTES, 'duration_seconds': MAX_DURATION_SECONDS,
    'file_bytes': MAX_BYTES,
}


class ExtractionFailure(Exception):
    def __init__(self, code='IMPORT_DEPENDENCY_FAILED', diagnostics=None, timings_ms=None):
        self.code = code
        self.diagnostics = clean_context(diagnostics)
        self.timings_ms = clean_timings(timings_ms)
        super().__init__(code)


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def clean_metadata(value, secrets=()):
    result = {'schema_version': 1}
    for key, maximum in TEXT_FIELDS.items():
        text = value.get(key)
        if not isinstance(text, str):
            continue
        text = ''.join(char for char in text if unicodedata.category(char) not in ('Cc', 'Cf')).strip()
        if (text and not re.search(r'https?://|Bearer\s|Basic\s|X-Amz-|Signature=|tnl_|jk_', text, re.I)
                and not any(secret and secret in text for secret in secrets)):
            result[key] = text[:maximum]
    for key, maximum in NUMBER_FIELDS.items():
        number = value.get(key)
        if finite(number) and 0 < number <= maximum:
            result[key] = number
    return result


def source_id(url):
    if (not isinstance(url, str)
            or not re.fullmatch(r'https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}', url)):
        raise ExtractionFailure('IMPORT_INVALID_URL')
    return url[-11:]


def media_url(value):
    try:
        if (not isinstance(value, str) or len(value) > 16_384
                or any(char.isspace() or ord(char) < 32 or char == '\\' for char in value)):
            return False
        parsed = urlsplit(value)
        return (parsed.scheme == 'https' and not parsed.username and not parsed.password
                and not parsed.port and not parsed.fragment
                and bool(re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.googlevideo\.com', parsed.hostname or ''))
                and parsed.path == '/videoplayback' and bool(parsed.query))
    except ValueError:
        return False


def _original(fmt):
    note = str(fmt.get('format_note', '')).lower()
    return fmt.get('language_preference') == 10 or '(original)' in note


def eligible_formats(info, max_bytes):
    """Select original-track native audio without implicit yt-dlp fallbacks.

250 is YouTube's usual medium Opus tier, not an audio conversion preset.
Unknown format IDs use actual native bitrate nearest 70 kbps. WebM/Opus is
preferred, then M4A/AAC, with smaller WebM tiers before expensive high tiers.
"""
    formats = info.get('formats')
    if not isinstance(formats, list) or not formats or len(formats) > 4096:
        raise ExtractionFailure()
    originals = [fmt for fmt in formats if isinstance(fmt, dict)
                 and fmt.get('vcodec') == 'none'
                 and fmt.get('acodec') not in ('none', None) and _original(fmt)]
    original_languages = {fmt.get('language') for fmt in originals if fmt.get('language')}
    audio = []
    oversize = False
    unavailable = False
    has_audio = False
    for fmt in formats:
        if not isinstance(fmt, dict) or fmt.get('vcodec') != 'none':
            continue
        has_audio = has_audio or fmt.get('acodec') not in ('none', None)
        if fmt.get('has_drm'):
            continue
        if any(fmt.get(key) not in (None, 0) for key in ('width', 'height', 'vbr')):
            continue
        if (fmt.get('protocol') not in (None, 'https') or not media_url(fmt.get('url'))
                or fmt.get('fragments') or fmt.get('manifest_url')):
            unavailable = unavailable or not fmt.get('url') or bool(fmt.get('fragments') or fmt.get('manifest_url'))
            continue
        extension, codec = fmt.get('ext'), str(fmt.get('acodec', '')).lower()
        if not ((extension == 'webm' and codec == 'opus')
                or (extension == 'm4a' and (codec == 'aac' or codec.startswith('mp4a.')))):
            continue
        if fmt.get('fragments') or fmt.get('requested_formats') or fmt.get('manifest_url'):
            continue
        # Missing PO tokens must be solved, rather than treating known-broken
        # tokenless URLs as quality fallback candidates.
        note = str(fmt.get('format_note', '')).lower()
        if 'missing pot' in note:
            unavailable = True
            continue
        if 'descriptive' in note or 'dubbed' in note or 'auto-dub' in note:
            continue
        size = fmt.get('filesize')
        if finite(size) and size > max_bytes:
            oversize = True
            continue
        # process=False returns raw extractor metadata: yt-dlp normally infers
        # protocol and audio bitrate during process_video_result. Normalize only
        # these missing values after strict native HTTPS audio validation; never
        # invoke processing, extraction again or broaden delivery destinations.
        normalized = {**fmt, 'protocol': 'https'}
        if not finite(normalized.get('abr')) and finite(normalized.get('tbr')):
            normalized['abr'] = normalized['tbr']
        audio.append(normalized)
    if originals:
        # Preserve raw original-track identity even when its first format was
        # filtered for size, codec, transport or unavailable delivery. A smaller
        # default/dubbed stream must never silently replace that original track.
        audio = [fmt for fmt in audio if _original(fmt) or fmt.get('language') in original_languages]
    else:
        # A single unlabeled track is safe. A translated/default language does
        # not prove original identity when multiple track languages are present.
        languages = {fmt.get('language') for fmt in audio if fmt.get('language')}
        if len(languages) > 1:
            raise ExtractionFailure('IMPORT_UNSUPPORTED_AUDIO_SOURCE')
        audio = [fmt for fmt in audio if fmt.get('language_preference') != -10]
    if not audio:
        if oversize:
            raise ExtractionFailure('IMPORT_TOO_LARGE')
        if unavailable or not has_audio:
            # A public extraction with no usable native audio can be a transient
            # challenge/PO/client response. No media was transferred, so keep
            # the service's approved bounded fresh-session retry path available.
            raise ExtractionFailure()
        raise ExtractionFailure('IMPORT_UNSUPPORTED_AUDIO_SOURCE')

    def preference(fmt):
        opus = fmt['ext'] == 'webm'
        itag = str(fmt.get('format_id', '')).split('-')[0]
        bitrate = fmt.get('abr') if finite(fmt.get('abr')) else fmt.get('tbr')
        bitrate = bitrate if finite(bitrate) and bitrate > 0 else {'250': 70, '249': 50, '251': 160, '140': 128}.get(itag, 10000)
        tier = 0 if opus and itag == '250' else 1
        # Original status first so a default dubbed medium never beats the
        # known original high/low stream or original M4A.
        drc = '-drc' in str(fmt.get('format_id', '')) or 'drc' in str(fmt.get('format_note', '')).lower()
        return (0 if _original(fmt) else 1, 0 if opus else 1, tier, int(drc),
                abs(bitrate - 70), bitrate, str(fmt.get('format_id', '')))

    unique = {}
    for fmt in sorted(audio, key=preference):
        unique.setdefault(fmt['url'], fmt)
    return list(unique.values())[:FORMAT_LIMIT]


def validate_info(info, requested_id, max_duration):
    if not isinstance(info, dict) or info.get('_type', 'video') != 'video' or 'entries' in info:
        raise ExtractionFailure('IMPORT_SINGLE_ITEM_REQUIRED')
    if info.get('id') != requested_id:
        raise ExtractionFailure('IMPORT_INVALID_AUDIO')
    if info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming', 'post_live'):
        raise ExtractionFailure('IMPORT_UNSUPPORTED_AUDIO_SOURCE')
    if info.get('availability') in ('private', 'needs_auth', 'subscriber_only', 'premium_only'):
        raise ExtractionFailure('IMPORT_SOURCE_UNAVAILABLE')
    duration = info.get('duration')
    if finite(duration) and duration > max_duration:
        raise ExtractionFailure('IMPORT_TOO_LONG')


class QuietLogger:
    def debug(self, *_):
        pass

    info = warning = error = debug


class ByteBudget:
    """Count received native media across all formats, before file writes."""
    def __init__(self, maximum, deadline):
        self.maximum, self.deadline = maximum, deadline
        self.received = 0
        self.format_start = 0
        self.failure = None

    def check(self):
        if self.failure:
            raise self.failure
        if time.monotonic() >= self.deadline:
            self.failure = ExtractionFailure(diagnostics={'reason': 'attempt_deadline', 'timeout': True})
            raise self.failure

    def remaining(self):
        self.check()
        return self.maximum - self.received

    def accept(self, data):
        self.check()
        self.received += len(data)
        if self.received > self.maximum:
            self.failure = ExtractionFailure('IMPORT_TOO_LARGE')
            raise self.failure
        return data


class BudgetResponse:
    def __init__(self, response, budget):
        self.response, self.budget = response, budget

    def __getattr__(self, name):
        return getattr(self.response, name)

    def read(self, amount=None):
        # At most one extra byte distinguishes EOF from an over-limit stream;
        # over-limit data never reaches the downloader or filesystem.
        remaining = self.budget.remaining()
        amount = min(amount, remaining + 1) if isinstance(amount, int) and amount >= 0 else remaining + 1
        return self.budget.accept(self.response.read(amount))

    def close(self):
        return self.response.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def options(request):
    return {
        'proxy': request['proxy'], 'socket_timeout': 5,
        'js_runtimes': {'deno': {'path': request.get('deno_path', 'deno')}},
        'remote_components': [], 'cachedir': False,
        'extractor_args': {
            'youtube': {'player_client': ['mweb'], 'skip': ['hls', 'dash', 'translated_subs']},
            'youtubepot-bgutilhttp': {'base_url': [request['token_provider_url']]},
        },
        'allowed_extractors': ['youtube'],
        'noplaylist': True, 'extract_flat': True,
        'retries': 0, 'fragment_retries': 0, 'extractor_retries': 0,
        'file_access_retries': 0, 'skip_unavailable_fragments': False,
        'continuedl': False, 'overwrites': True,
        'http_chunk_size': 10 * 1024 * 1024,
        'concurrent_fragment_downloads': 1,
        'buffersize': 64 * 1024, 'noresizebuffer': True,
        'max_filesize': request['max_bytes'],
        'external_downloader': {'default': 'native'},
        'fixup': 'never', 'postprocessors': [],
        'allow_multiple_audio_streams': False, 'allow_multiple_video_streams': False,
        'writeinfojson': False, 'writethumbnail': False,
        'writesubtitles': False, 'writeautomaticsub': False, 'getcomments': False,
        'quiet': True, 'no_warnings': True, 'noprogress': True,
        'logger': QuietLogger(), 'warn_when_outdated': False,
        'geo_bypass': False, 'usenetrc': False,
        'http_headers': {'Accept-Encoding': 'identity'},
    }


def classify(error, phase=None):
    if isinstance(error, ExtractionFailure):
        if phase and 'phase' not in error.diagnostics:
            error.diagnostics.update(clean_context({'phase': phase}))
        return error
    diagnostics = exception_context(error, phase)
    if isinstance(error, OSError) and error.errno in (errno.ENOSPC, errno.EDQUOT):
        return ExtractionFailure('IMPORT_DISK_FULL', diagnostics)
    # Inspect only inside the child; third-party messages never leave it.
    text = str(error).lower()
    if any(marker in text for marker in ('http error 403', 'http error 429', 'sign in to confirm', 'not a bot')):
        return ExtractionFailure('IMPORT_UPSTREAM_REFUSED', diagnostics)
    if any(marker in text for marker in ('private video', 'video unavailable', 'video has been removed', 'not available in your country', 'sign in to confirm your age')):
        return ExtractionFailure('IMPORT_SOURCE_UNAVAILABLE', diagnostics)
    return ExtractionFailure(diagnostics=diagnostics)


def _metadata(info, fmt, size, secrets):
    metadata = {'schema_version': 1, 'provider': 'ytdlp', 'site': 'youtube', 'file_bytes': size}
    for source, target in [('format_id', 'format_id'), ('ext', 'extension'), ('acodec', 'audio_codec'),
                           ('container', 'container'), ('language', 'language'), ('abr', 'bitrate_kbps'),
                           ('asr', 'sample_rate_hz'), ('audio_channels', 'audio_channels'),
                           ('filesize', 'provider_file_bytes')]:
        metadata[target] = fmt.get(source)
    for source, target in [('title', 'title'), ('channel', 'channel'), ('uploader', 'artist'), ('duration', 'duration_seconds')]:
        metadata[target] = info.get(source)
    return clean_metadata(metadata, secrets)


def _clear_files(scratch):
    for path in scratch.glob('audio.*'):
        if path.is_file() or path.is_symlink():
            path.unlink()


def secure_native_transport(downloader, token_url):
    """Keep native urllib transfer guards ahead of redirects/decompression.

The pinned runtime has only urllib installed. Enforce that choice even if
optional request backends are installed later: compressed media must not be
eagerly buffered by a transport before our streaming byte budget can see it.
"""
    import urllib.request
    from yt_dlp.networking._urllib import HTTPHandler, RedirectHandler

    class MediaHTTPHandler(HTTPHandler):
        def http_response(self, req, response):
            if media_url(req.get_full_url()):
                encoding = response.headers.get('Content-Encoding', 'identity').strip().lower()
                if encoding not in ('', 'identity'):
                    response.close()
                    raise ExtractionFailure('IMPORT_INVALID_AUDIO')
            return super().http_response(req, response)

        https_response = http_response

    class MediaRedirectHandler(RedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            origin = req.get_full_url()
            if media_url(origin) and not media_url(newurl):
                fp.close()
                raise ExtractionFailure('IMPORT_UPSTREAM_REFUSED')
            if origin.startswith(token_url.rstrip('/') + '/'):
                fp.close()
                raise ExtractionFailure()
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    director = downloader._request_director
    transport = director.handlers.get('Urllib')
    if transport is None:
        raise ExtractionFailure()
    for name, handler in list(director.handlers.items()):
        if name != 'Urllib':
            handler.close()
            del director.handlers[name]
    original_create = transport._create_instance

    def create(*args, **kwargs):
        native = original_create(*args, **kwargs)
        guarded = urllib.request.OpenerDirector()
        for handler in native.handlers:
            if isinstance(handler, HTTPHandler):
                handler = MediaHTTPHandler(
                    debuglevel=handler._debuglevel, context=handler._context,
                    source_address=handler._source_address,
                )
            elif isinstance(handler, RedirectHandler):
                handler = MediaRedirectHandler()
            guarded.add_handler(handler)
        guarded.addheaders = []
        return guarded

    transport._create_instance = create


def execute(request, youtube_dl=None, progress=None):
    diagnostics = {'phase': 'request_validation'}
    timings = {'token_generation_ms': 0.0}

    def observe(phase, **values):
        diagnostics.update(clean_context({'phase': phase, **values}))
        if progress:
            progress(clean_context(diagnostics), clean_timings(timings))

    def failure(error, phase=None):
        classified = classify(error, phase or diagnostics.get('phase'))
        if 'reason' not in classified.diagnostics:
            classified.diagnostics.update(exception_context(error, phase or diagnostics.get('phase')))
        if classified.diagnostics.get('reason') == 'runtime_error' and diagnostics.get('reason'):
            classified.diagnostics.pop('reason')
        if classified.diagnostics.get('exception_type') in ('other', 'DownloadError', 'ExtractorError') and diagnostics.get('exception_type'):
            classified.diagnostics.pop('exception_type')
        classified.diagnostics = clean_context({**diagnostics, **classified.diagnostics,
                                                'bytes_downloaded': budget.received})
        classified.timings_ms = clean_timings(timings)
        return classified

    requested_id = source_id(request.get('url'))
    maximum, max_duration = request.get('max_bytes'), request.get('max_duration_seconds')
    proxy, token_url = request.get('proxy'), request.get('token_provider_url')
    if (type(maximum) is not int or not 0 < maximum <= MAX_BYTES
            or not finite(max_duration) or not 0 < max_duration <= MAX_DURATION_SECONDS
            or not isinstance(proxy, str) or not proxy or len(proxy) > 4096
            or not finite(request.get('deadline')) or not isinstance(token_url, str)):
        raise ExtractionFailure('IMPORT_INVALID_REQUEST')
    proxy_parts, token_parts = urlsplit(proxy), urlsplit(token_url)
    if (proxy_parts.scheme != 'http' or not proxy_parts.hostname or not proxy_parts.port
            or not proxy_parts.username or not proxy_parts.password or proxy_parts.path not in ('', '/')
            or proxy_parts.query or proxy_parts.fragment
            or token_parts.scheme != 'http' or not token_parts.hostname or not token_parts.port
            or token_parts.username or token_parts.password or token_parts.path not in ('', '/')
            or token_parts.query or token_parts.fragment):
        raise ExtractionFailure('IMPORT_INVALID_REQUEST')
    scratch = Path(request['scratch']).resolve(strict=True)
    budget = ByteBudget(maximum, min(request['deadline'], time.monotonic() + 30))
    budget.check()
    observe('startup')
    real_runtime = youtube_dl is None
    if real_runtime:
        # The installed plugin also advertises one-shot Node/Deno providers.
        # Its HTTP service is the only authorized token provider for this
        # adapter; remove script providers from this isolated child's registry.
        from yt_dlp import YoutubeDL
        from yt_dlp.plugins import load_all_plugins
        from yt_dlp.extractor.youtube.pot._registry import _pot_providers
        load_all_plugins()
        provider = _pot_providers.value.get('BgUtilHTTP')
        if provider is None:
            raise ExtractionFailure()
        for name in list(_pot_providers.value):
            if name != 'BgUtilHTTP':
                del _pot_providers.value[name]
        provider._GETPOT_TIMEOUT = min(5, budget.deadline - time.monotonic())
        provider._GET_SERVER_VSN_TIMEOUT = min(2, budget.deadline - time.monotonic())
        youtube_dl = YoutubeDL
    class PrivateYoutubeDL(youtube_dl):
        def urlopen(self, req):
            budget.check()
            target = getattr(req, 'url', req)
            is_media = media_url(target)
            is_token = target == token_url.rstrip('/') + '/get_pot'
            previous_phase = diagnostics['phase']
            if is_token:
                observe('token_generation')
            started = time.monotonic()
            try:
                response = super().urlopen(req)
            except Exception as error:
                observed = exception_context(error, 'token_generation' if is_token else previous_phase)
                observed['upstream_phase'] = observed.get('phase')
                diagnostics.update(observed)
                if progress:
                    progress(clean_context(diagnostics), clean_timings(timings))
                raise
            finally:
                if is_token:
                    timings['token_generation_ms'] += (time.monotonic() - started) * 1000
                    observe(previous_phase)
            if is_media:
                final_url = getattr(response, 'url', target)
                if not media_url(final_url):
                    response.close()
                    raise ExtractionFailure('IMPORT_UPSTREAM_REFUSED')
                headers = getattr(response, 'headers', {})
                content_type = headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
                if content_type not in (
                    'audio/webm', 'video/webm', 'audio/mp4', 'video/mp4', 'audio/x-m4a',
                    'application/octet-stream', 'binary/octet-stream',
                ):
                    response.close()
                    raise ExtractionFailure('IMPORT_UPSTREAM_REFUSED')
                length = headers.get('Content-Length')
                content_range = headers.get('Content-Range', '')
                too_large = isinstance(length, str) and length.isdigit() and int(length) > budget.remaining()
                ranged = re.fullmatch(r'bytes [0-9]+-[0-9]+/([0-9]+)', content_range)
                if ranged:
                    too_large = too_large or int(ranged.group(1)) > budget.maximum - budget.format_start
                if too_large:
                    response.close()
                    raise ExtractionFailure('IMPORT_TOO_LARGE')
                return BudgetResponse(response, budget)
            return response

    with PrivateYoutubeDL(options(request)) as downloader:
        if real_runtime:
            secure_native_transport(downloader, token_url)
        started = time.monotonic()
        observe('extraction')
        try:
            info = downloader.extract_info(request['url'], download=False, process=False)
        except Exception as error:
            timings['extraction_ms'] = max(0, (time.monotonic() - started) * 1000 - timings['token_generation_ms'])
            raise failure(error) from None
        finally:
            timings['extraction_ms'] = max(0, (time.monotonic() - started) * 1000 - timings['token_generation_ms'])
        observe('source_validation')
        budget.check()
        try:
            validate_info(info, requested_id, max_duration)
            observe('format_selection', format_count=0)
            formats = eligible_formats(info, maximum)
        except Exception as error:
            if isinstance(error, ExtractionFailure) and error.code == 'IMPORT_DEPENDENCY_FAILED':
                diagnostics.setdefault('reason', 'no_native_audio')
            raise failure(error) from None
        observe('format_selection', format_count=len(formats))
        last_failure = ExtractionFailure('IMPORT_UNSUPPORTED_AUDIO_SOURCE')
        started = time.monotonic()
        for ordinal, fmt in enumerate(formats, 1):
            observe('transfer', format_attempt=ordinal, format_id=fmt.get('format_id'),
                    extension=fmt['ext'], audio_codec='opus' if fmt['ext'] == 'webm' else 'aac',
                    bitrate_kbps=fmt.get('abr'))
            budget.check()
            size = fmt.get('filesize')
            if finite(size) and size > budget.remaining():
                last_failure = ExtractionFailure('IMPORT_TOO_LARGE')
                continue
            _clear_files(scratch)
            path = scratch / ('audio.' + fmt['ext'])
            # Copy only data needed by the native downloader. Exclude extracted
            # downloader overrides, manifests, extra URLs and post-extraction
            # callbacks so the selected single native stream stays authoritative.
            selected = {key: fmt[key] for key in (
                'url', 'ext', 'format_id', 'format_note', 'acodec', 'vcodec',
                'protocol', 'filesize', 'filesize_approx', 'abr', 'tbr', 'asr',
                'audio_channels', 'language', 'container', 'http_headers',
            ) if key in fmt}
            selected.update({'id': requested_id, 'title': requested_id, 'is_live': False})
            headers = dict(selected.get('http_headers') or {})
            headers['Accept-Encoding'] = 'identity'
            selected['http_headers'] = headers
            try:
                budget.format_start = budget.received
                success, _ = downloader.dl(str(path), selected)
                budget.check()
                if not success or not path.is_file() or path.is_symlink() or path.stat().st_size <= 0:
                    raise ExtractionFailure('IMPORT_INVALID_AUDIO')
                measured = path.stat().st_size
                if measured > maximum or measured > budget.received:
                    raise ExtractionFailure('IMPORT_TOO_LARGE')
                if finite(size) and measured != size:
                    raise ExtractionFailure('IMPORT_INVALID_AUDIO')
                timings['transfer_ms'] = (time.monotonic() - started) * 1000
                secrets = tuple(unquote(value or '') for value in (proxy_parts.username, proxy_parts.password))
                return {
                    'filename': path.name,
                    'content_type': 'audio/webm' if fmt['ext'] == 'webm' else 'audio/mp4',
                    'metadata': _metadata(info, fmt, measured, secrets),
                    'timings_ms': {key: round(value, 3) for key, value in timings.items()},
                    'bytes_downloaded': budget.received,
                    'diagnostics': clean_context(diagnostics),
                }
            except Exception as error:
                timings['transfer_ms'] = (time.monotonic() - started) * 1000
                try:
                    budget.check()
                except Exception as deadline_error:
                    raise failure(deadline_error) from None
                last_failure = failure(error)
                if last_failure.code == 'IMPORT_DISK_FULL':
                    raise last_failure from None
            finally:
                # A successful native file is retained for the private response;
                # every failed candidate's partial file is removed before fallback.
                if not path.exists() or path.stat().st_size <= 0:
                    _clear_files(scratch)
        _clear_files(scratch)
        raise failure(last_failure)


def main():
    # Use a dedicated protocol stream: library prints are never protocol data.
    output = sys.stdout
    progress_count = 0

    def progress(diagnostics, timings):
        nonlocal progress_count
        # This internal protocol remains bounded even with hostile extractor
        # behavior. The parent retains the last phase when killing at deadline.
        if progress_count >= 64:
            return
        encoded = json.dumps({'progress': clean_context(diagnostics),
                              'timings_ms': clean_timings(timings)}, separators=(',', ':'))
        if len(encoded.encode()) <= 1024:
            output.write(encoded + '\n')
            output.flush()
            progress_count += 1

    try:
        import os
        with open(os.devnull, 'w') as discard:
            sys.stdout = discard
            request = json.loads(sys.stdin.buffer.read(12_289))
            if not isinstance(request, dict):
                raise ExtractionFailure('IMPORT_INVALID_REQUEST')
            result = execute(request, progress=progress)
    except Exception as error:
        classified = classify(error)
        result = {'error': classified.code, 'diagnostics': classified.diagnostics,
                  'timings_ms': classified.timings_ms}
    finally:
        sys.stdout = output
    encoded = json.dumps(result, ensure_ascii=True, separators=(',', ':'))
    if len(encoded.encode()) > 8192:
        encoded = '{"error":"IMPORT_DEPENDENCY_FAILED"}'
    output.write(encoded)
    output.flush()


if __name__ == '__main__':
    main()
