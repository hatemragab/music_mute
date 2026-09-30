import io
import json
import threading
import unittest
from concurrent.futures import Future
from unittest.mock import Mock

from official_metadata import OfficialMetadata, endpoint, merge_metadata, text_fields
from service import source_url


class MetadataTests(unittest.TestCase):
    def resolver(self, payload=None, status=200, headers=None):
        response = Mock(status=status)
        response.getheader.side_effect = lambda name, default=None: (headers or {}).get(name, default)
        response.read1 = io.BytesIO(payload if isinstance(payload, bytes) else
                                   json.dumps(payload).encode()).read
        conn = Mock()
        conn.getresponse.return_value = response
        factory = Mock(return_value=conn)
        return OfficialMetadata(factory), factory, conn

    def test_official_hosts_and_canonical_cache_key(self):
        for url, host in [('https://youtu.be/aqz-KE-bpKQ?si=tracker', 'www.youtube.com'),
                          ('https://www.youtube.com/shorts/aqz-KE-bpKQ', 'www.youtube.com')]:
            self.assertEqual(endpoint(source_url(url))[0], host)
        self.assertEqual(endpoint(source_url('https://youtu.be/aqz-KE-bpKQ')),
                         endpoint(source_url('https://www.youtube.com/watch?v=aqz-KE-bpKQ')))
        for url in ['https://instagram.com/reel/test', 'https://vm.tiktok.com/abc',
                    'https://on.soundcloud.com/abc', 'https://example.com/test']:
            self.assertIsNone(endpoint(url))

    def test_success_sanitized_cached_without_credentials(self):
        resolver, factory, conn = self.resolver({'title': '  عنوان\n🎵 ', 'author_name': 'Author',
                                                'html': '<script>secret</script>', 'thumbnail_url': 'secret'})
        url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
        result = resolver.start(url).result(2)
        self.assertEqual(result, {'title': 'عنوان🎵', 'channel': 'Author'})
        self.assertEqual(resolver.start(url).result(2), result)
        self.assertEqual(factory.call_count, 1)
        args, kwargs = conn.request.call_args
        self.assertEqual(args[0], 'GET')
        self.assertNotIn('Authorization', kwargs['headers'])
        conn.close.assert_called_once()

    def test_nonfatal_failures_no_retry_negative_cache(self):
        for payload, status, headers in [(b'bad json', 200, {}), ({}, 302, {}),
                                         ({}, 429, {'Retry-After': '900'}),
                                         ({}, 403, {}), ({}, 500, {}),
                                         (b'x' * 65537, 200, {}),
                                         ({'title': 'ignored'}, 200, {'Content-Encoding': 'gzip'})]:
            with self.subTest(status=status, size=len(payload)):
                resolver, factory, conn = self.resolver(payload, status, headers)
                url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
                self.assertEqual(resolver.start(url).result(2), {})
                self.assertEqual(resolver.start(url).result(2), {})
                self.assertEqual(factory.call_count, 1)
                conn.close.assert_called_once()

    def test_cooldown_covers_other_items(self):
        resolver, factory, _ = self.resolver({}, 429, {'Retry-After': '900'})
        self.assertEqual(resolver.start('https://www.youtube.com/watch?v=aqz-KE-bpKQ').result(2), {})
        self.assertEqual(resolver.start('https://www.youtube.com/watch?v=abcdefghijk').result(2), {})
        self.assertEqual(factory.call_count, 1)

    def test_timeout_never_fails_metadata_or_retries(self):
        resolver, factory, conn = self.resolver({})
        conn.getresponse.side_effect = TimeoutError('secret')
        self.assertEqual(resolver.start('https://www.youtube.com/watch?v=aqz-KE-bpKQ').result(2), {})
        self.assertEqual(factory.call_count, 1)

    def test_stalled_lookup_never_blocks_audio_or_accumulates_workers(self):
        resolver, factory, conn = self.resolver({})
        release = threading.Event()
        response = conn.getresponse.return_value
        conn.getresponse.side_effect = lambda: (release.wait(2), response)[1]
        future = resolver.start('https://www.youtube.com/watch?v=aqz-KE-bpKQ')
        try:
            self.assertEqual(merge_metadata({'provider': 'videoscale'}, future), {'provider': 'videoscale'})
            self.assertEqual(resolver.start('https://vimeo.com/123').result(0.1), {})
            self.assertEqual(factory.call_count, 1)
        finally:
            release.set()
            future.result(2)

    def test_header_bound_and_included_title_precedence(self):
        future = Future()
        future.set_result({'title': '😀' * 200, 'channel': '😀' * 200})
        result = merge_metadata({'schema_version': 1, 'provider': 'videoscale'}, future)
        self.assertLessEqual(((len(json.dumps(result).encode()) + 2) // 3) * 4, 4096)
        self.assertIn('title', result)
        self.assertEqual(merge_metadata({'title': 'Included'}, future)['title'], 'Included')

    def test_text_rejects_urls_secrets_html_and_bounds_unicode(self):
        for title in ['https://secret.test', 'Bearer secret', '<script>x</script>', None]:
            self.assertEqual(text_fields({'title': title}), {})
        self.assertEqual(len(text_fields({'title': '🎵' * 300})['title']), 200)

    def test_cache_is_bounded_and_expires(self):
        resolver, factory, conn = self.resolver({'title': 'Title'})
        now = [0]
        resolver.clock = lambda: now[0]
        # A fresh response stream per request.
        conn.getresponse.return_value.read1 = lambda n: b''
        for number in range(130):
            resolver.start('https://vimeo.com/' + str(number)).result(2)
        self.assertEqual(len(resolver.cache), 128)
        before = factory.call_count
        now[0] = 61
        resolver.start('https://vimeo.com/129').result(2)
        self.assertEqual(factory.call_count, before + 1)
