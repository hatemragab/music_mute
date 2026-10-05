from concurrent.futures import ThreadPoolExecutor
import unittest
from urllib.parse import unquote, urlsplit

from proxy_sessions import ProxyCredentials, ProxyUnavailable, StickySessions


class StickyTests(unittest.TestCase):
    def sessions(self, **kwargs):
        return StickySessions(ProxyCredentials('fixture-res', 'reserved:@/?'),
                              ProxyCredentials('fixture-mobile', 'mobile-fixture'), **kwargs)

    def test_fresh_ports_and_fourth_attempt_mobile(self):
        sessions = self.sessions()
        for attempt in (1, 2, 3):
            pool, uri = sessions.allocate(attempt)
            self.assertEqual(pool, 'residential')
            parsed = urlsplit(uri)
            self.assertEqual(parsed.port, 9999 + attempt)
            self.assertEqual(unquote(parsed.password), 'reserved:@/?')
            self.assertEqual(unquote(parsed.username), 'fixture-res__sessttl.30')
        pool, uri = sessions.allocate(4)
        self.assertEqual(pool, 'mobile')
        self.assertEqual(urlsplit(uri).port, 10003)
        self.assertNotIn('reserved', repr(sessions.credentials['residential']))

    def test_ports_are_quarantined_until_ttl(self):
        now = [0]
        sessions = self.sessions(first=10000, last=10000, clock=lambda: now[0])
        sessions.allocate(1)
        with self.assertRaises(ProxyUnavailable):
            sessions.allocate(2)
        with self.assertRaises(ProxyUnavailable):
            sessions.allocate(4)
        now[0] = 1800
        self.assertEqual(urlsplit(sessions.allocate(3)[1]).port, 10000)

    def test_parallel_attempts_do_not_share_ports(self):
        sessions = self.sessions()
        with ThreadPoolExecutor(max_workers=10) as workers:
            ports = list(workers.map(lambda index: urlsplit(sessions.allocate(index % 4 + 1)[1]).port, range(100)))
        self.assertEqual(len(set(ports)), 100)

    def test_config_failure_does_not_echo_credentials(self):
        with self.assertRaisesRegex(ValueError, '^Invalid DataImpulse configuration$'):
            StickySessions.from_environment({'DATAIMPULSE_RESIDENTIAL_LOGIN': 'secret'})
        with self.assertRaises(ValueError):
            ProxyCredentials('fixture', 'line\nreflection')


if __name__ == '__main__':
    unittest.main()
