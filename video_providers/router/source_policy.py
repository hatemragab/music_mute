"""Public item admission, matching the existing private VideoScale catalog.

No source URLs are fetched here. Changes must keep the shared client catalog,
VideoScale admission and this routing policy aligned.
"""
import math
import re
from urllib.parse import parse_qs, urlsplit, urlunsplit

MAX_BYTES = 100_000_000
MAX_DURATION_SECONDS = 1800


class Failure(Exception):
    def __init__(self, code='IMPORT_DEPENDENCY_FAILED', status=503, retry_after=30):
        self.code = code
        self.status = status
        self.retry_after = retry_after
        super().__init__(code)


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def source_url(value):
    if (not isinstance(value, str) or len(value) > 2048
            or any(c.isspace() or ord(c) < 32 or c == '\\' for c in value)):
        raise Failure('IMPORT_INVALID_URL', 400)
    try:
        p = urlsplit(value)
        if p.scheme != 'https' or p.username or p.password or p.port or p.fragment:
            raise ValueError()
        query = parse_qs(p.query, keep_blank_values=True)
        if p.hostname in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'):
            if p.path == '/playlist':
                raise Failure('IMPORT_SINGLE_ITEM_REQUIRED', 422)
            if p.path in ('/watch', '/watch/') and len(query.get('v', [])) == 1:
                video = query['v'][0]
            elif re.fullmatch(r'/(shorts|embed|live)/[A-Za-z0-9_-]{11}/?', p.path):
                video = p.path.rstrip('/').rsplit('/', 1)[1]
            else:
                raise ValueError()
        elif p.hostname in ('youtu.be', 'www.youtu.be'):
            video = p.path.strip('/')
        else:
            if any(key in query for key in ('list', 'playlist', 'index', 'in')):
                raise Failure('IMPORT_SINGLE_ITEM_REQUIRED', 422)
            return platform_source(p, query)
        ids = query.get('v', [])
        if (not re.fullmatch(r'[A-Za-z0-9_-]{11}', video)
                or len(ids) > 1 or (ids and ids[0] != video)):
            raise ValueError()
        # Playlist/radio context does not change an explicitly selected video.
        return 'https://www.youtube.com/watch?v=' + video
    except ValueError:
        raise Failure('IMPORT_INVALID_URL', 400) from None


def platform_source(p, query):
    host = re.sub(r'^(www|m|web)\.', '', p.hostname or '')
    patterns = {
        'instagram.com': r'/(?:p|reel|reels)/[A-Za-z0-9_-]+/?',
        'tiktok.com': r'/@[A-Za-z0-9_.]+/video/[0-9]+/?',
        'vm.tiktok.com': r'/[A-Za-z0-9]+/?',
        'vt.tiktok.com': r'/[A-Za-z0-9]+/?',
        'vimeo.com': r'/[0-9]+/?',
        'player.vimeo.com': r'/video/[0-9]+/?',
        'soundcloud.com': r'/(?!discover/|charts/|search/|you/|stations/)[A-Za-z0-9_-]+/(?!sets/?$|likes/?$|reposts/?$|tracks/?$)[A-Za-z0-9_-]+/?',
        'on.soundcloud.com': r'/[A-Za-z0-9]+/?',
        'facebook.com': r'/(?:share/(?:v|r)/[A-Za-z0-9]+|reel/[0-9]+|[A-Za-z0-9_.-]+/videos/(?:[A-Za-z0-9_.-]+/)?[0-9]+)/?',
        'mixcloud.com': r'/(?!discover/|categories/|live/)[A-Za-z0-9_-]+/(?!stream/?$|listens/?$|uploads/?$|favorites/?$|playlists/?$)[A-Za-z0-9_-]+/?',
        'hearthis.at': r'/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+/?',
        'clyp.it': r'/[a-z0-9]+/?',
        'vocaroo.com': r'/(?:embed/)?[A-Za-z0-9_]+/?',
        'whyp.it': r'/tracks/(?:[0-9]{5,}/)?[A-Za-z0-9_-]+/?',
    }
    if re.fullmatch(r'[a-z0-9-]+\.bandcamp\.com', host):
        patterns[host] = r'/track/[A-Za-z0-9_-]+/?'
    if host not in patterns:
        raise Failure('IMPORT_UNSUPPORTED_PROVIDER', 422)
    if host == 'facebook.com' and p.path in ('/watch', '/watch/', '/video.php'):
        ids = query.get('v', [])
        if len(ids) == 1 and re.fullmatch(r'[0-9]+', ids[0]):
            return 'https://www.facebook.com/watch?v=' + ids[0]
    elif re.fullmatch(patterns[host], p.path):
        return urlunsplit(('https', host, p.path, '', ''))
    raise Failure('IMPORT_SINGLE_ITEM_REQUIRED', 422)


def route_for(url):
    # source_url canonicalizes only qualified YouTube hosts to this exact host.
    return 'youtube' if urlsplit(url).hostname == 'www.youtube.com' else 'other'
