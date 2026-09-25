"""Constrain the extractor's Python network stack to public Internet addresses."""
import ipaddress
import socket
from urllib.parse import urlsplit


def public_address(host):
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        raise ValueError('NETWORK_ADDRESS_REJECTED') from None
    if (not address.is_global or address.is_multicast or address.is_reserved
            or getattr(address, 'ipv4_mapped', None)
            or getattr(address, 'sixtofour', None)
            or getattr(address, 'teredo', None)
            or address in ipaddress.ip_network('64:ff9b::/96')
            or address in ipaddress.ip_network('64:ff9b:1::/48')):
        raise ValueError('NETWORK_ADDRESS_REJECTED')
    return host


def public_url(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 2048
            or any(c.isspace() or ord(c) < 32 or c == '\\' for c in value)):
        raise ValueError('INVALID_URL')
    p = urlsplit(value)
    if (p.scheme not in {'http', 'https'} or not p.hostname or p.username
            or p.password or p.fragment or p.port):
        raise ValueError('INVALID_URL')
    host = p.hostname.rstrip('.').lower()
    if host == 'localhost' or host.endswith(('.localhost', '.local', '.internal')):
        raise ValueError('INVALID_URL')
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if '.' not in host:
            raise ValueError('INVALID_URL') from None
    else:
        public_address(host)
    return value


def install():
    """Validate DNS results AND pin each socket connect to a checked numeric IP.

    The official Python executable uses urllib, without curl_cffi/external
    downloaders. Deno's EJS runtime has no network permissions. Every redirect
    creates a connection subject to this guard; no second DNS lookup at connect.
    """
    resolve = socket.getaddrinfo
    connect = socket.socket.connect

    def guarded_resolve(*args, **kwargs):
        results = resolve(*args, **kwargs)
        for _, _, _, _, address in results:
            public_address(address[0])
        return results

    def guarded_connect(sock, address):
        if sock.family not in {socket.AF_INET, socket.AF_INET6}:
            raise ValueError('NETWORK_ADDRESS_REJECTED')
        host, port = address[:2]
        try:
            ipaddress.ip_address(host)
        except ValueError:
            candidates = guarded_resolve(host, port, sock.family, sock.type)
            address = candidates[0][4]
        public_address(address[0])
        return connect(sock, address)

    def guarded_connect_ex(sock, address):
        try:
            guarded_connect(sock, address)
            return 0
        except OSError as error:
            return error.errno

    socket.getaddrinfo = guarded_resolve
    socket.socket.connect = guarded_connect
    socket.socket.connect_ex = guarded_connect_ex
