"""HTTPS requests pinned to a validated public address to prevent DNS rebinding."""
import ipaddress
import socket
from urllib.parse import urlsplit
import requests
from requests.adapters import HTTPAdapter
from urllib3 import HTTPSConnectionPool

class PublicHTTPSAdapter(HTTPAdapter):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.pinned_pools = []

    def close(self):
        for pool in self.pinned_pools:
            pool.close()
        super().close()

    def get_connection_with_tls_context(self, request, verify, proxies=None, cert=None):
        parsed = urlsplit(request.url)
        host = parsed.hostname
        if parsed.scheme != "https" or not host or parsed.username or parsed.password or parsed.port not in {None, 443}:
            raise requests.exceptions.InvalidURL("Only public HTTPS sources are supported")
        try:
            addresses = sorted({r[4][0] for r in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}, key=lambda value: (ipaddress.ip_address(value).version, value))
        except OSError:
            raise requests.ConnectionError("The public source could not be resolved") from None
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
            raise requests.exceptions.InvalidURL("Private source addresses are blocked")
        # TLS still verifies the original hostname; only TCP resolution is pinned.
        request.headers["Host"] = host
        pool = HTTPSConnectionPool(addresses[0], port=443, server_hostname=host, assert_hostname=host, maxsize=1, block=True)
        self.pinned_pools.append(pool)
        return pool

def public_get(url, **kwargs):
    if urlsplit(url).scheme != "https":
        raise requests.exceptions.InvalidURL("Only public HTTPS sources are supported")
    session = requests.Session()
    session.trust_env = False
    session.mount("https://", PublicHTTPSAdapter())
    try:
        response = session.get(url, **kwargs)
    except Exception:
        session.close()
        raise
    original_close = response.close
    def close():
        original_close()
        session.close()
    response.close = close
    return response
