"""Bounded private acquisition metadata sanitation shared by router and adapters."""
import base64
import json
import re
import unicodedata

from source_policy import MAX_BYTES, MAX_DURATION_SECONDS, finite

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


def clean_metadata(encoded, secrets):
    if (not isinstance(encoded, str) or len(encoded) > 4096
            or not re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', encoded)):
        return None
    try:
        raw = json.loads(base64.b64decode(encoded, validate=True).decode('utf-8'))
        if not isinstance(raw, dict) or type(raw.get('schema_version')) is not int or raw['schema_version'] != 1:
            return None
        clean = {'schema_version': 1}
        for key, maximum in TEXT_FIELDS.items():
            field = raw.get(key)
            if not isinstance(field, str):
                continue
            field = ''.join(c for c in field if unicodedata.category(c) not in ('Cc', 'Cf')).strip()[:maximum]
            if (not field or re.search(r'https?://|Bearer\s|Basic\s|X-Amz-|Signature=|tnl_|jk_', field, re.I)
                    or any(secret in field for secret in secrets)):
                continue
            clean[key] = field
        for key, maximum in NUMBER_FIELDS.items():
            field = raw.get(key)
            if finite(field) and 0 < field <= maximum:
                clean[key] = field
        if len(clean) == 1:
            return None
        output = base64.b64encode(json.dumps(clean, ensure_ascii=True, separators=(',', ':')).encode()).decode()
        return output if len(output) <= 4096 else None
    except (ValueError, UnicodeError, RecursionError):
        return None
