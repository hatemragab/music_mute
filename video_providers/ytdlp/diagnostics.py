"""Allowlisted internal diagnostics. Raw third-party text never leaves the child."""
import errno
import math
import re


PHASES = frozenset({
    'request_validation', 'admission', 'scratch', 'proxy_session', 'startup',
    'extraction', 'token_generation', 'source_validation', 'format_selection',
    'transfer', 'response_validation', 'response_stream', 'child_protocol',
})
REASONS = frozenset({
    'attempt_deadline', 'acquisition_deadline', 'caller_disconnected', 'proxy_pool_exhausted',
    'socket_timeout', 'network_timeout', 'proxy_error', 'dns_failure',
    'connection_failed', 'http_forbidden', 'http_rate_limited', 'http_error',
    'challenge_required', 'source_unavailable', 'disk_full', 'no_native_audio',
    'token_provider_error', 'child_protocol_invalid', 'child_exit',
    'runtime_error', 'byte_limit', 'audio_invalid', 'unsupported_source',
})
EXCEPTION_TYPES = frozenset({
    'TimeoutError', 'ConnectionError', 'ConnectionAbortedError',
    'ConnectionResetError', 'BrokenPipeError', 'OSError', 'RuntimeError',
    'ValueError', 'HTTPError', 'URLError', 'DownloadError', 'ExtractorError',
    'TransportError', 'ProxyError', 'CertificateVerifyError', 'gaierror',
    'ExtractionFailure', 'AcquisitionError', 'Failure', 'other',
})
TIMINGS = frozenset({'extraction_ms', 'token_generation_ms', 'transfer_ms'})
CODES = frozenset({'IMPORT_INVALID_URL', 'IMPORT_INVALID_REQUEST', 'IMPORT_SINGLE_ITEM_REQUIRED',
                   'IMPORT_UNSUPPORTED_AUDIO_SOURCE', 'IMPORT_TOO_LARGE', 'IMPORT_TOO_LONG',
                   'IMPORT_INVALID_AUDIO', 'IMPORT_UPSTREAM_REFUSED', 'IMPORT_SOURCE_UNAVAILABLE',
                   'IMPORT_DEPENDENCY_FAILED', 'IMPORT_DISK_FULL', 'IMPORT_ACQUISITION_EXHAUSTED'})


def clean_context(value):
    """Revalidate every child field, including strings that resemble enum names."""
    if not isinstance(value, dict):
        return {}
    result = {}
    for key, choices in (('phase', PHASES), ('upstream_phase', PHASES), ('reason', REASONS),
                         ('exception_type', EXCEPTION_TYPES), ('upstream_error_code', CODES)):
        if isinstance(value.get(key), str) and value[key] in choices:
            result[key] = value[key]
    for key, maximum in (('http_status', 599), ('errno', 65535), ('proxy_port', 65535),
                         ('format_count', 12), ('format_attempt', 12), ('bytes_downloaded', 100_000_000),
                         ('phase_elapsed_ms', 31_000)):
        number = value.get(key)
        minimum = 100 if key == 'http_status' else 0
        if type(number) is int and minimum <= number <= maximum:
            result[key] = number
    for key in ('timeout', 'child_killed'):
        if type(value.get(key)) is bool:
            result[key] = value[key]
    itag = value.get('format_id')
    if isinstance(itag, str) and re.fullmatch(r'[0-9]{1,5}(?:-drc)?', itag):
        result['format_id'] = itag
    for key, choices in (('extension', ('webm', 'm4a')), ('audio_codec', ('opus', 'aac'))):
        if value.get(key) in choices:
            result[key] = value[key]
    bitrate = value.get('bitrate_kbps')
    if type(bitrate) in (int, float) and math.isfinite(bitrate) and 0 < bitrate <= 10000:
        result['bitrate_kbps'] = round(bitrate, 3)
    return result


def clean_timings(value):
    if not isinstance(value, dict):
        return {}
    return {key: round(number, 3) for key, number in value.items()
            if key in TIMINGS and type(number) in (int, float) and math.isfinite(number)
            and 0 <= number <= 31_000}


def exception_context(error, phase=None):
    """Inspect a bounded exception chain locally; export only enum/numeric facts."""
    context = {'phase': phase, 'reason': 'runtime_error', 'exception_type': 'other'}
    seen, errors = set(), [error]
    for _ in range(8):
        if not errors:
            break
        current = errors.pop(0)
        if not isinstance(current, BaseException) or id(current) in seen:
            continue
        seen.add(id(current))
        name = type(current).__name__
        if name in EXCEPTION_TYPES:
            context['exception_type'] = name
        for key in ('status', 'code'):
            status = getattr(current, key, None)
            if type(status) is int and 100 <= status <= 599:
                context['http_status'] = status
        number = getattr(current, 'errno', None)
        if type(number) is int and 0 <= number <= 65535:
            context['errno'] = number
        # Only fixed markers are retained, never the original message or URL.
        text = str(current).lower()
        code_reason = {'IMPORT_TOO_LARGE': 'byte_limit', 'IMPORT_INVALID_AUDIO': 'audio_invalid',
                       'IMPORT_SOURCE_UNAVAILABLE': 'source_unavailable', 'IMPORT_DISK_FULL': 'disk_full',
                       'IMPORT_UNSUPPORTED_AUDIO_SOURCE': 'unsupported_source'}
        if isinstance(getattr(current, 'code', None), str) and current.code in code_reason:
            context['reason'] = code_reason[current.code]
        status = re.search(r'http(?: error|error)?[ :]+([1-5][0-9]{2})\b', text)
        if status and 'http_status' not in context:
            context['http_status'] = int(status.group(1))
        if isinstance(current, TimeoutError) or any(marker in text for marker in ('timed out', 'timeout')):
            context.update(reason='network_timeout', timeout=True)
        elif number in (errno.ENOSPC, errno.EDQUOT):
            context['reason'] = 'disk_full'
        elif name == 'gaierror':
            context['reason'] = 'dns_failure'
        elif name == 'ProxyError' or 'proxy error' in text:
            context['reason'] = 'proxy_error'
        elif isinstance(current, ConnectionError):
            context['reason'] = 'connection_failed'
        elif any(marker in text for marker in ('sign in to confirm', 'not a bot')):
            context['reason'] = 'challenge_required'
        elif any(marker in text for marker in ('private video', 'video unavailable', 'video has been removed', 'not available in your country')):
            context['reason'] = 'source_unavailable'
        for child in (getattr(current, '__cause__', None), getattr(current, '__context__', None),
                      getattr(current, 'reason', None)):
            if isinstance(child, BaseException):
                errors.append(child)
        info = getattr(current, 'exc_info', None)
        if isinstance(info, tuple) and len(info) > 1 and isinstance(info[1], BaseException):
            errors.append(info[1])
    if context.get('http_status') in (403, 429):
        context['reason'] = 'http_forbidden' if context['http_status'] == 403 else 'http_rate_limited'
    elif 'http_status' in context and context['reason'] == 'runtime_error':
        context['reason'] = 'http_error'
    return clean_context(context)
