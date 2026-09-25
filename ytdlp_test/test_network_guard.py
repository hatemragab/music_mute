import subprocess
import sys
import unittest
from pathlib import Path
from network_guard import public_address, public_url


class NetworkTests(unittest.TestCase):
    def test_address_boundary(self):
        for value in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1',
                      '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1',
                      'fc00::1', '::ffff:8.8.8.8', '64:ff9b::a00:1']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                public_address(value)
        self.assertEqual(public_address('8.8.8.8'), '8.8.8.8')

    def test_input_boundary(self):
        for value in ['file:///tmp/a', 'http://localhost/a', 'http://api/a',
                      'https://user:pass@example.org/a', 'https://example.org:8080/a']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                public_url(value)
        self.assertEqual(public_url('https://www.facebook.com/share/v/19duj8sfLg/'),
                         'https://www.facebook.com/share/v/19duj8sfLg/')

    def test_socket_and_dns_rebinding_guards(self):
        code = '''
import socket
from network_guard import install
socket.getaddrinfo = lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 80))]
install()
for action in [lambda: socket.getaddrinfo('public.example.org', 80),
               lambda: socket.socket().connect(('127.0.0.1', 80)),
               lambda: socket.socket().connect(('public.example.org', 80)),
               lambda: socket.socket().connect_ex(('169.254.169.254', 80))]:
    try: action()
    except ValueError: pass
    else: raise AssertionError('Private connection admitted')
'''
        result = subprocess.run([sys.executable, '-c', code], capture_output=True,
                                cwd=Path(__file__).parent)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
