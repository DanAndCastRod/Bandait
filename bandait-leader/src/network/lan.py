"""LAN address selection and follower links (CONTRACT_V3 section 8).

Phones load the follower from the leader over plain HTTP on the stage LAN, so
the leader must advertise an IPv4 address the phones can reach:

1. an explicit override (``BANDAIT_LAN_IP`` env, then leader config / UI choice);
2. the address of the interface that carries the default route, unless that
   interface is virtual (VPN, WSL, Hyper-V, Docker...);
3. the first physical, private, up interface;
4. 127.0.0.1 as a last resort (still useful on the laptop itself).

Loopback and link-local (169.254/16) addresses are never offered. Every other
candidate is exposed so the UI can switch when the laptop has several networks.
"""

from __future__ import annotations

import ipaddress
import os
import re
import socket
from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence, Tuple
from urllib.parse import urlencode

_VIRTUAL_PATTERNS = re.compile(
    r"vethernet|wsl|hyper-v|docker|virtualbox|vbox|vmware|vmnet|vpn|tap-|tun|tailscale|"
    r"zerotier|wireguard|wintun|npcap|loopback|bluetooth|utun|bridge|br-|veth|virbr|nordlynx|"
    r"fortinet|forticlient|globalprotect|pangp|anyconnect|cisco",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class LanCandidate:
    ip: str
    interface: str = ""
    default_route: bool = False
    virtual: bool = False

    @property
    def label(self) -> str:
        parts = [self.ip]
        if self.interface:
            parts.append(f"- {self.interface}")
        tags = []
        if self.default_route:
            tags.append("ruta por defecto")
        if self.virtual:
            tags.append("virtual")
        if tags:
            parts.append(f"({', '.join(tags)})")
        return " ".join(parts)


def is_usable_ipv4(ip: str) -> bool:
    try:
        addr = ipaddress.IPv4Address(ip)
    except (ipaddress.AddressValueError, ValueError):
        return False
    return not (addr.is_loopback or addr.is_link_local or addr.is_unspecified or addr.is_multicast)


def is_virtual_interface(name: str) -> bool:
    return bool(name) and bool(_VIRTUAL_PATTERNS.search(name))


def default_route_ip(probe: Tuple[str, int] = ("8.8.8.8", 80)) -> Optional[str]:
    """IPv4 of the interface the OS would use for the default route.
    A UDP connect sends no packet; it only asks the routing table."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(probe)
            ip = s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return None
    return ip if is_usable_ipv4(ip) else None


def enumerate_interfaces() -> List[Tuple[str, str]]:
    """(interface name, ipv4) for interfaces that are up. Names may be empty if
    psutil is not available."""
    found: List[Tuple[str, str]] = []
    try:
        import psutil

        stats = psutil.net_if_stats()
        for name, addrs in psutil.net_if_addrs().items():
            st = stats.get(name)
            if st is not None and not st.isup:
                continue
            for a in addrs:
                if a.family == socket.AF_INET:
                    found.append((name, a.address))
        return found
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ("", ip) not in found:
                found.append(("", ip))
    except OSError:
        pass
    return found


def build_candidates(
    interfaces: Iterable[Tuple[str, str]], default_ip: Optional[str]
) -> List[LanCandidate]:
    """Usable candidates, best first: default route (physical), physical private,
    other physical, then virtual ones."""
    seen = set()
    cands: List[LanCandidate] = []
    for name, ip in interfaces:
        if ip in seen or not is_usable_ipv4(ip):
            continue
        seen.add(ip)
        cands.append(LanCandidate(ip, name, ip == default_ip, is_virtual_interface(name)))
    if default_ip and default_ip not in seen and is_usable_ipv4(default_ip):
        cands.append(LanCandidate(default_ip, "", True, False))

    def rank(c: LanCandidate):
        private = ipaddress.IPv4Address(c.ip).is_private
        return (c.virtual, not c.default_route, not private)

    return sorted(cands, key=rank)


def select_lan_ip(candidates: Sequence[LanCandidate], override: Optional[str] = None) -> str:
    if override and is_usable_ipv4(override.strip()):
        return override.strip()
    for c in candidates:
        if not c.virtual:
            return c.ip
    return candidates[0].ip if candidates else "127.0.0.1"


def lan_candidates() -> List[LanCandidate]:
    return build_candidates(enumerate_interfaces(), default_route_ip())


def env_lan_override() -> Optional[str]:
    value = os.environ.get("BANDAIT_LAN_IP", "").strip()
    return value or None


def follower_url(ip: str, port: int, session_id: str, director: bool = False) -> str:
    """QR / link URL: http://<ip>:<port>/?ip=<ip>&port=<port>&session=<id>&auto=1[&role=director]"""
    params = [("ip", ip), ("port", str(port)), ("session", session_id), ("auto", "1")]
    if director:
        params.append(("role", "director"))
    return f"http://{ip}:{port}/?{urlencode(params)}"


def qr_matrix(data: str) -> List[List[bool]]:
    """QR modules (True = dark) with a 4-module quiet zone. No image library needed."""
    import qrcode

    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=4)
    qr.add_data(data)
    qr.make(fit=True)
    return [[bool(cell) for cell in row] for row in qr.get_matrix()]
