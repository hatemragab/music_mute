"""Allocate distinct best-effort DataImpulse sticky bindings per attempt."""
from dataclasses import dataclass, field
import os
import threading
import time
from urllib.parse import quote


class ProxyUnavailable(Exception):
    pass


def credential(value):
    return (isinstance(value, str) and 1 <= len(value) <= 1024
            and all(32 < ord(c) < 127 for c in value))


@dataclass(frozen=True)
class ProxyCredentials:
    login: str = field(repr=False)
    password: str = field(repr=False)

    def __post_init__(self):
        if not credential(self.login) or not credential(self.password):
            raise ValueError('Invalid DataImpulse credentials')


class StickySessions:
    """Ports are quarantined for TTL, not immediately recycled after completion.

    Distinct bindings do not guarantee distinct IPs or uninterrupted continuity.
    This allocator is process-local, so the adapter must have one replica.
    """
    def __init__(self, residential, mobile, first=10000, last=20000,
                 minutes=30, clock=time.monotonic):
        if (type(first) is not int or type(last) is not int or not 10000 <= first <= last <= 20000
                or type(minutes) is not int or not 1 <= minutes <= 120):
            raise ValueError('Invalid sticky session settings')
        self.credentials = {'residential': residential, 'mobile': mobile}
        self.first, self.last, self.minutes, self.clock = first, last, minutes, clock
        self.next = first
        self.leases = {}
        self.lock = threading.Lock()

    def allocate(self, attempt):
        if type(attempt) is not int or not 1 <= attempt <= 4:
            raise ValueError('Invalid acquisition attempt')
        pool = 'mobile' if attempt == 4 else 'residential'
        with self.lock:
            now = self.clock()
            leases = self.leases
            for port in tuple(leases):
                if leases[port] <= now:
                    del leases[port]
            for _ in range(self.last - self.first + 1):
                port = self.next
                self.next = self.first if port == self.last else port + 1
                if port not in leases:
                    leases[port] = now + self.minutes * 60
                    break
            else:
                raise ProxyUnavailable('Sticky session capacity unavailable')
        account = self.credentials[pool]
        # Preserve operator country/ASN parameters; set one explicit sticky TTL.
        login = account.login
        if '__' in login:
            base, parameters = login.split('__', 1)
            parameters = [p for p in parameters.split(';') if not p.startswith('sessttl.')]
            login = base + '__' + ';'.join(parameters + [f'sessttl.{self.minutes}'])
        else:
            login += f'__sessttl.{self.minutes}'
        uri = f'http://{quote(login, safe="")}:'
        uri += f'{quote(account.password, safe="")}@gw.dataimpulse.com:{port}'
        return pool, uri

    @property
    def secrets(self):
        return tuple(value for account in self.credentials.values()
                     for value in (account.login, account.password))

    @classmethod
    def from_environment(cls, environment=None):
        env = os.environ if environment is None else environment
        try:
            residential = ProxyCredentials(env['DATAIMPULSE_RESIDENTIAL_LOGIN'],
                                           env['DATAIMPULSE_RESIDENTIAL_PASSWORD'])
            mobile = ProxyCredentials(env['DATAIMPULSE_MOBILE_LOGIN'],
                                      env['DATAIMPULSE_MOBILE_PASSWORD'])
            return cls(residential, mobile, int(env.get('DATAIMPULSE_STICKY_PORT_MIN', '10000')),
                       int(env.get('DATAIMPULSE_STICKY_PORT_MAX', '20000')),
                       int(env.get('DATAIMPULSE_STICKY_MINUTES', '30')))
        except (KeyError, ValueError):
            raise ValueError('Invalid DataImpulse configuration') from None
