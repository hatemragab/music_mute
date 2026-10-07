import errno
import json
import unittest
from urllib.error import HTTPError, URLError

from diagnostics import clean_context, clean_timings, exception_context


SENSITIVE_TEXT = 'sensitive-proxy-password-cookie-token'


class DiagnosticTests(unittest.TestCase):
    def test_nested_http_error_keeps_only_status_and_known_type(self):
        upstream = HTTPError('https://signed.invalid/?token=' + SENSITIVE_TEXT, 429, SENSITIVE_TEXT, {}, None)
        wrapped = RuntimeError('proxy https://login:' + SENSITIVE_TEXT + '@host:10000')
        wrapped.__cause__ = URLError(upstream)
        details = exception_context(wrapped, 'extraction')
        self.assertEqual(details['http_status'], 429)
        self.assertEqual(details['reason'], 'http_rate_limited')
        self.assertEqual(details['exception_type'], 'HTTPError')
        self.assertNotIn(SENSITIVE_TEXT, json.dumps(details))
        self.assertNotIn('url', details)

    def test_network_timeout_disk_and_unknown_error_are_bounded(self):
        timeout = exception_context(TimeoutError(SENSITIVE_TEXT), 'token_generation')
        self.assertEqual(timeout['reason'], 'network_timeout')
        self.assertTrue(timeout['timeout'])
        disk = exception_context(OSError(errno.ENOSPC, SENSITIVE_TEXT), 'transfer')
        self.assertEqual(disk['reason'], 'disk_full')
        self.assertEqual(disk['errno'], errno.ENOSPC)
        unknown_type = type(SENSITIVE_TEXT, (Exception,), {})
        self.assertEqual(exception_context(unknown_type(SENSITIVE_TEXT))['exception_type'], 'other')

    def test_child_dictionary_cannot_smuggle_strings_or_raw_payload(self):
        details = clean_context({'phase': SENSITIVE_TEXT, 'reason': SENSITIVE_TEXT, 'exception_type': SENSITIVE_TEXT,
                                 'format_id': SENSITIVE_TEXT, 'extension': SENSITIVE_TEXT, 'audio_codec': SENSITIVE_TEXT,
                                 'proxy_port': True, 'http_status': 429, 'format_count': 99,
                                 'errno': -1, 'url': SENSITIVE_TEXT, 'stack': SENSITIVE_TEXT, 'proxy': SENSITIVE_TEXT,
                                 'timeout': 'yes', 'bitrate_kbps': float('inf')})
        self.assertEqual(details, {'http_status': 429})
        self.assertEqual(clean_timings({'extraction_ms': 8, 'transfer_ms': float('nan'),
                                       SENSITIVE_TEXT: 1, 'token_generation_ms': -1}), {'extraction_ms': 8})

    def test_exception_cycles_do_not_grow_logs(self):
        error = RuntimeError(SENSITIVE_TEXT)
        error.__cause__ = error
        self.assertLess(len(json.dumps(exception_context(error, 'extraction'))), 200)


if __name__ == '__main__':
    unittest.main()
