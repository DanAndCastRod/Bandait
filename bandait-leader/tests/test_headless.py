"""`python -m src.headless`: real process, real socket, graceful stop."""

import asyncio
import os
import re
import signal
import subprocess
import sys
import threading
import uuid
from pathlib import Path

import socketio

LEADER_DIR = Path(__file__).resolve().parents[1]


def test_headless_entrypoint_join_play_and_graceful_stop():
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "src.headless", "--host", "127.0.0.1", "--port", "0", "--quiet",
         "--duration", "60"],
        cwd=str(LEADER_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        creationflags=flags,
    )
    lines = []
    try:
        port_box = {}
        ready = threading.Event()

        def reader():
            for line in proc.stdout:
                lines.append(line)
                m = re.search(r"http://127\.0\.0\.1:(\d+)", line)
                if m and "port" not in port_box:
                    port_box["port"] = int(m.group(1))
                    ready.set()
            ready.set()

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        assert ready.wait(20), "".join(lines)
        assert "port" in port_box, "".join(lines)

        async def phone():
            sio = socketio.AsyncClient(reconnection=False)
            states = asyncio.Queue()
            sio.on("full_state", lambda data: states.put_nowait(data))
            await sio.connect(f"http://127.0.0.1:{port_box['port']}", transports=["websocket"], wait_timeout=5)
            ack = await sio.call(
                "join_session",
                {"session_id": "default", "client_id": str(uuid.uuid4()), "role": "musician",
                 "alias": "Bajo", "protocol_version": 3},
                timeout=5,
            )
            full = await asyncio.wait_for(states.get(), 5)
            play = await sio.call(
                "control_command",
                {"session_id": "default", "command_id": str(uuid.uuid4()), "type": "PLAY",
                 "origin": "director_mobile", "sender_id": "x", "payload": {}},
                timeout=5,
            )
            await sio.disconnect()
            return ack, full, play

        ack, full, play = asyncio.run(asyncio.wait_for(phone(), 20))
        assert ack["status"] == "joined"
        assert [s["song_id"] for s in full["setlist"]] == ["song_01", "song_02", "song_07"]
        # Another leader process: a different instance id (restart detection).
        from src.domain.models import LEADER_INSTANCE_ID

        assert ack["leader_instance_id"] == full["leader_instance_id"] == play["state"]["leader_instance_id"]
        assert ack["leader_instance_id"] != LEADER_INSTANCE_ID
        assert play["accepted"] and play["state"]["status"] == "PLAYING"
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
            try:
                proc.wait(15)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(5)
    assert proc.returncode == 0, "".join(lines)
    assert any("detenido" in line for line in lines), "".join(lines)
