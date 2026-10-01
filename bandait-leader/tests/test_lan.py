"""LAN IP selection, follower URLs and QR content (CONTRACT_V3 section 8)."""

from src.network.lan import (
    LanCandidate,
    build_candidates,
    follower_url,
    is_virtual_interface,
    qr_matrix,
    select_lan_ip,
)
from src.network.server import BandaitServer
from src.sync.clock_service import ClockService

# The interfaces of the coordinator's laptop on 2026-09-30.
THIS_MACHINE = [
    ("Ethernet 2", "10.251.200.6"),
    ("Ethernet", "169.254.241.237"),
    ("Wi-Fi", "192.168.1.5"),
    ("Conexión de red Bluetooth", "169.254.48.104"),
    ("vEthernet (WSL (Hyper-V firewall))", "172.31.32.1"),
    ("Loopback Pseudo-Interface 1", "127.0.0.1"),
]


def test_default_route_interface_wins_and_junk_is_excluded():
    cands = build_candidates(THIS_MACHINE, default_ip="10.251.200.6")
    ips = [c.ip for c in cands]
    assert ips[0] == "10.251.200.6" and cands[0].default_route
    assert "127.0.0.1" not in ips and not any(ip.startswith("169.254.") for ip in ips)
    assert ips[-1] == "172.31.32.1" and cands[-1].virtual  # WSL vEthernet listed last
    assert select_lan_ip(cands) == "10.251.200.6"
    assert set(ips) == {"10.251.200.6", "192.168.1.5", "172.31.32.1"}  # all exposed to the UI


def test_virtual_default_route_is_skipped():
    cands = build_candidates(
        [("Wi-Fi", "192.168.1.5"), ("NordLynx VPN", "10.5.0.2"), ("vEthernet (Default Switch)", "172.20.0.1")],
        default_ip="10.5.0.2",
    )
    assert select_lan_ip(cands) == "192.168.1.5"


def test_override_and_fallbacks():
    cands = build_candidates(THIS_MACHINE, default_ip="10.251.200.6")
    assert select_lan_ip(cands, override="192.168.1.5") == "192.168.1.5"
    assert select_lan_ip(cands, override="not-an-ip") == "10.251.200.6"
    assert select_lan_ip(cands, override="127.0.0.1") == "10.251.200.6"  # loopback is never advertised
    assert select_lan_ip([]) == "127.0.0.1"
    only_virtual = build_candidates([("vEthernet (WSL)", "172.31.32.1")], default_ip=None)
    assert select_lan_ip(only_virtual) == "172.31.32.1"
    no_names = build_candidates([("", "192.168.0.10")], default_ip=None)
    assert select_lan_ip(no_names) == "192.168.0.10"


def test_virtual_name_detection():
    for name in ("vEthernet (WSL)", "Hyper-V Virtual Ethernet", "Docker Desktop", "TAP-Windows Adapter",
                 "Tailscale", "ZeroTier One", "VirtualBox Host-Only", "VMware Network Adapter VMnet8"):
        assert is_virtual_interface(name), name
    for name in ("Wi-Fi", "Ethernet", "Ethernet 2", "en0", "wlan0", "eth0"):
        assert not is_virtual_interface(name), name


def test_follower_urls_follow_the_contract():
    assert follower_url("192.168.1.5", 4040, "default") == (
        "http://192.168.1.5:4040/?ip=192.168.1.5&port=4040&session=default&auto=1"
    )
    assert follower_url("192.168.1.5", 4040, "default", director=True) == (
        "http://192.168.1.5:4040/?ip=192.168.1.5&port=4040&session=default&auto=1&role=director"
    )
    assert "session=gira+2026%2Fbar" in follower_url("10.0.0.2", 4040, "gira 2026/bar")


def test_server_lan_ip_precedence(monkeypatch):
    server = BandaitServer(ClockService(), host="0.0.0.0", port=4040, lan_ip="192.168.1.5")
    monkeypatch.setattr(
        server, "lan_candidates",
        lambda refresh=False: build_candidates(THIS_MACHINE, default_ip="10.251.200.6"),
    )
    assert server.lan_ip() == "192.168.1.5"  # config
    monkeypatch.setenv("BANDAIT_LAN_IP", "10.251.200.6")
    assert server.lan_ip() == "10.251.200.6"  # env beats config
    server.set_lan_ip("172.31.32.1")
    assert server.lan_ip() == "172.31.32.1"  # explicit UI choice beats both
    server.set_lan_ip(None)
    monkeypatch.delenv("BANDAIT_LAN_IP")
    assert server.follower_url().startswith("http://192.168.1.5:4040/?ip=192.168.1.5&port=4040")
    assert server.director_url().endswith("&role=director")


def test_qr_matrix_encodes_the_url():
    import qrcode

    url = follower_url("192.168.1.5", 4040, "default", director=True)
    matrix = qr_matrix(url)
    n = len(matrix)
    assert n >= 29 and all(len(row) == n for row in matrix)
    assert not any(matrix[0]) and not any(row[0] for row in matrix)  # quiet zone
    ref = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=4)
    ref.add_data(url)
    ref.make(fit=True)
    assert matrix == [[bool(c) for c in row] for row in ref.get_matrix()]


def test_connect_dialog_switches_ip_and_copies(qapp, monkeypatch):
    from PySide6.QtWidgets import QApplication

    from src.ui.dialogs.connect_musicians import ConnectMusiciansDialog

    server = BandaitServer(ClockService(), host="0.0.0.0", port=4040)
    monkeypatch.setattr(
        server, "lan_candidates",
        lambda refresh=False: build_candidates(THIS_MACHINE, default_ip="10.251.200.6"),
    )
    chosen = []
    dialog = ConnectMusiciansDialog(server, on_ip_selected=chosen.append)
    assert dialog.ip_combo.isEnabled() and dialog.ip_combo.count() == 4  # auto + 3 candidates
    assert "10.251.200.6" in dialog.musicians.url.text()
    wifi = next(i for i in range(dialog.ip_combo.count()) if dialog.ip_combo.itemData(i) == "192.168.1.5")
    dialog.ip_combo.setCurrentIndex(wifi)
    assert chosen == ["192.168.1.5"]
    assert dialog.musicians.url.text() == follower_url("192.168.1.5", 4040, "default")
    assert dialog.director.url.text() == follower_url("192.168.1.5", 4040, "default", director=True)
    assert not dialog.musicians.qr.pixmap().isNull()
    dialog.director.copy_btn.click()
    assert QApplication.clipboard().text() == dialog.director.url.text()
    assert "servidor de red no está activo" in dialog.warning.text()
    dialog.close()


def test_candidate_labels_are_readable():
    c = LanCandidate("10.251.200.6", "Ethernet 2", default_route=True)
    assert c.label == "10.251.200.6 - Ethernet 2 (ruta por defecto)"
