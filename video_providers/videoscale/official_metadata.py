"""Optional official oEmbed metadata. No scraping, credentials or media requests."""
from collections import OrderedDict
from concurrent.futures import Future
import json
import re
import threading
import time
import unicodedata
from urllib.parse import urlencode, urlsplit


def text_fields(value):
    if not isinstance(value, dict):
        return {}
    result = {}
    for source, target in [('title', 'title'), ('author_name', 'channel')]:
        text = value.get(source)
        if not isinstance(text, str):
            continue
        text = ''.join(c for c in text if unicodedata.category(c) not in ('Cc', 'Cf')).strip()
        if not text or re.search(r'https?://|Bearer\s|Basic\s|X-Amz-|Signature=|<[^>]*>', text, re.I):
            continue
        result[target] = text[:200]
    return result


def endpoint(url):
    """Input is already admitted/canonicalized by source_url; never fetch it directly."""
    p = urlsplit(url)
    if p.hostname == 'www.youtube.com':
        host, path = 'www.youtube.com', '/oembed'
    elif p.hostname == 'tiktok.com':
        host, path = 'www.tiktok.com', '/oembed'
    elif p.hostname in ('vimeo.com', 'player.vimeo.com'):
        host, path = 'vimeo.com', '/api/oembed.json'
        url = 'https://vimeo.com/' + p.path.rstrip('/').rsplit('/', 1)[-1]
    elif p.hostname == 'soundcloud.com':
        host, path = 'soundcloud.com', '/oembed'
    else:
        return None  # No source redirect resolution, including shortened links.
    return host, path + '?' + urlencode({'url': url, 'format': 'json'})


class OfficialMetadata:
    """One daemon lookup at a time; acquisition never waits for its result.

    Bounded memory-only cache. Even stalled DNS cannot accumulate threads or
    block audio. Short socket/elapsed budgets and response caps bound normal IO.
    """
    def __init__(self, connection, clock=time.monotonic):
        self.connection, self.clock = connection, clock
        self.lock = threading.Lock()
        self.cache = OrderedDict()
        self.cooldown = {}
        self.busy = False

    def start(self, url):
        future = Future()
        target = endpoint(url)
        if target is None:
            future.set_result({})
            return future
        with self.lock:
            cached = self.cache.get(target)
            if cached and cached[0] > self.clock():
                self.cache.move_to_end(target)
                future.set_result(dict(cached[1]))
                return future
            if self.busy or self.cooldown.get(target[0], 0) > self.clock():
                future.set_result({})
                return future
            self.busy = True
        try:
            threading.Thread(target=self._run, args=(target, future), daemon=True).start()
        except Exception:
            with self.lock:
                self.busy = False
            future.set_result({})
        return future

    def _run(self, target, future):
        result = {}
        conn = None
        started = self.clock()
        try:
            host, path = target
            conn = self.connection(host, 443, timeout=3)
            conn.request('GET', path, headers={'Accept': 'application/json',
                                             'Accept-Encoding': 'identity'})
            response = conn.getresponse()
            if response.status in (403, 429):
                retry = response.getheader('Retry-After', '')
                seconds = max(300, min(int(retry), 86400)) if retry.isdigit() else 3600
                with self.lock:
                    self.cooldown[host] = self.clock() + seconds
            if (response.status != 200
                    or response.getheader('Content-Encoding', 'identity') != 'identity'):
                return  # Redirects and all errors are nonfatal; never retry.
            payload = bytearray()
            while self.clock() - started < 3:
                chunk = response.read1(16384)
                if self.clock() - started >= 3:
                    break
                if not chunk:
                    result = text_fields(json.loads(payload))
                    break
                payload.extend(chunk)
                if len(payload) > 65536:
                    break
        except Exception:
            pass  # Never expose URLs, raw payloads or exception text.
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
            with self.lock:
                self.cache[target] = (self.clock() + (3600 if result else 60), result)
                self.cache.move_to_end(target)
                while len(self.cache) > 128:
                    self.cache.popitem(last=False)
                self.busy = False
            future.set_result(result)


def merge_metadata(included, future):
    """Reuse existing fields; never wait, fail acquisition, or exceed header cap."""
    result = dict(included)
    if future.done():
        for key, value in future.result().items():
            if key not in result:
                candidate = dict(result, **{key: value})
                # Same serialization as the adapter's base64 header.
                if ((len(json.dumps(candidate).encode()) + 2) // 3) * 4 <= 4096:
                    result = candidate
    return result
