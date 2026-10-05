import errno
import json
import unittest
from urllib.error import HTTPError, URLError

from diagnostics import clean_context, clean_timings, exception_context


SECRET = 'sensitive-proxy-password-cookie-token'


class DiagnosticTests(unittest.TestCase):
    def test_nested_http_error_keeps_only_status_and_known_type(self):
        upstream = HTTPError('https://signed.invalid/?token=' + SECRET, 429, SECRET, {}, None)
        wrapped = RuntimeError('proxy https://login:' + SECRET + '@host:10000')
        wrapped.__cause__ = URLError(upstream)
        details = exception_context(wrapped, 'extraction')
        self.assertEqual(details['http_status'], 429)
        self.assertEqual(details['reason'], 'http_rate_limited')
        self.assertEqual(details['exception_type'], 'HTTPError')
        self.assertNotIn(SECRET, json.dumps(details))
        self.assertNotIn('url', details)

    def test_network_timeout_disk_and_unknown_error_are_bounded(self):
        timeout = exception_context(TimeoutError(SECRET), 'token_generation')
        self.assertEqual(timeout['reason'], 'network_timeout')
        self.assertTrue(timeout['timeout'])
        disk = exception_context(OSError(errno.ENOSPC, SECRET), 'transfer')
        self.assertEqual(disk['reason'], 'disk_full')
        self.assertEqual(disk['errno'], errno.ENOSPC)
        unknown_type = type(SECRET, (Exception,), {})
        self.assertEqual(exception_context(unknown_type(SECRET))['exception_type'], 'other')

    def test_child_dictionary_cannot_smuggle_strings_or_raw_payload(self):
        details = clean_context({'phase': SECRET, 'reason': SECRET, 'exception_type': SECRET,
                                 'format_id': SECRET, 'extension': SECRET, 'audio_codec': SECRET,
                                 'proxy_port': True, 'http_status': 429, 'format_count': 99,
                                 'errno': -1, 'url': SECRET, 'stack': SECRET, 'proxy': SECRET,
                                 'timeout': 'yes', 'bitrate_kbps': float('inf')})
        self.assertEqual(details, {'http_status': 429})
        self.assertEqual(clean_timings({'extraction_ms': 8, 'transfer_ms': float('nan'),
                                       SECRET: 1, 'token_generation_ms': -1}), {'extraction_ms': 8})

    def test_exception_cycles_do_not_grow_logs(self):
        error = RuntimeError(SECRET)
        error.__cause__ = error
        self.assertLess(len(json.dumps(exception_context(error, 'extraction'))), 200)


if __name__ == '__main__':
    unittest.main()
