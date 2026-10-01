"""sync_request latency bench, idle vs PLAYING (dev tool, not part of the app).

    cd bandait-leader
    python scripts/sync_latency_bench.py              # in-process headless leader
    python scripts/sync_latency_bench.py --port 4040  # an already running leader

In-process mode reproduces ``python -m src.headless`` (Qt loop + ClockService
ticker in the main thread, server on its own thread) and also reports the
server-side handler latency (engine.io message arrival -> ack written) and the
asyncio loop lag. It hooks private python-socketio internals for timing only.

Reported per phase: client RTT and server handler latency (median, p95, MAD,
max, in ms) and the MAD of the NTP offset samples (the follower's jitter metric).
"""

import argparse
import asyncio
import random
import statistics
import sys
import threading
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import socketio  # noqa: E402


def summarize(xs):
    if not xs:
        return "n=0"
    s = sorted(xs)
    med = statistics.median(s)
    mad = statistics.median([abs(x - med) for x in s])
    p95 = s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))]
    return f"median={med:.3f} p95={p95:.3f} MAD={mad:.3f} max={s[-1]:.3f} (n={len(s)})"


async def run_client(port, n, server_samples=None, lag_samples=None):
    results = {}

    async def command(sio, type_, payload=None):
        await sio.call("control_command", {"session_id": "default", "command_id": str(uuid.uuid4()),
                                           "type": type_, "origin": "hub", "sender_id": "bench",
                                           "payload": payload or {}}, timeout=5)

    async def burst(sio, count):
        if server_samples is not None:
            server_samples.clear()
        if lag_samples is not None:
            lag_samples.clear()
        rtts, offsets = [], []
        for _ in range(count):
            t0 = time.perf_counter_ns()
            ack = await sio.call("sync_request", {"client_send_ms": t0 / 1e6}, timeout=5)
            t3 = time.perf_counter_ns()
            rtts.append((t3 - t0) / 1e6)
            offsets.append(ack["leader_time_ns"] / 1e6 - (t0 + t3) / 2e6)
            await asyncio.sleep(random.uniform(0.005, 0.025))  # random phase vs leader clock ticks
        return rtts, offsets, list(server_samples or []), list(lag_samples or [])

    sio = socketio.AsyncClient(reconnection=False)
    await sio.connect(f"http://127.0.0.1:{port}", transports=["websocket"], wait_timeout=5)
    await sio.call("join_session", {"session_id": "default", "client_id": str(uuid.uuid4()),
                                    "role": "musician", "alias": "bench", "protocol_version": 3}, timeout=5)
    await command(sio, "STOP")
    await burst(sio, 20)  # warm-up
    results["IDLE"] = await burst(sio, n)
    await command(sio, "JUMP_SONG", {"order_index": 0})
    await command(sio, "TEMPO_NUDGE", {"delta_bpm": 260})  # clamps to 260 bpm: most beacons
    await asyncio.sleep(0.6)
    results["PLAYING"] = await burst(sio, n)
    await command(sio, "STOP")
    await sio.disconnect()
    return results


def print_results(results):
    for label in ("IDLE", "PLAYING"):
        rtts, offsets, srv, lag = results[label]
        mad = statistics.median([abs(o - statistics.median(offsets)) for o in offsets])
        print(f"{label:8s} client RTT ms      : {summarize(rtts)}")
        if srv:
            print(f"{label:8s} server handler ms  : {summarize(srv)}")
        if lag:
            print(f"{label:8s} asyncio loop lag ms: {summarize(lag)}")
        print(f"{label:8s} offset MAD ms      : {mad:.3f}")


def in_process(n):
    from PySide6.QtCore import QCoreApplication, Qt

    from src.headless import demo_setlist
    from src.network.server import BandaitServer
    from src.sync.clock_service import ClockService

    app = QCoreApplication.instance() or QCoreApplication([])
    clock = ClockService()
    clock.start()
    server = BandaitServer(clock, host="127.0.0.1", port=0)
    server.signals.state_changed.connect(clock.apply_update, Qt.QueuedConnection)
    server.set_setlist(demo_setlist())
    if not server.start():
        raise SystemExit(server.status_message)
    sio_srv = server._sio
    arrivals, server_samples, lag_samples = {}, [], []
    orig_send = sio_srv._send_packet
    orig_msg = sio_srv.eio.handlers["message"]

    async def timed_msg(eio_sid, data):
        if isinstance(data, str) and "sync_request" in data:
            arrivals[eio_sid] = time.perf_counter_ns()
        return await orig_msg(eio_sid, data)

    async def timed_send(eio_sid, pkt):
        t = arrivals.pop(eio_sid, None)
        result = await orig_send(eio_sid, pkt)
        if t is not None and pkt.packet_type == 3:  # ACK
            server_samples.append((time.perf_counter_ns() - t) / 1e6)
        return result

    sio_srv.eio.handlers["message"] = timed_msg
    sio_srv._send_packet = timed_send
    stop = threading.Event()

    async def lag_probe():
        loop = asyncio.get_running_loop()
        while not stop.is_set():
            t = time.perf_counter_ns()
            fut = loop.create_future()
            loop.call_soon(fut.set_result, None)
            await fut
            lag_samples.append((time.perf_counter_ns() - t) / 1e6)
            await asyncio.sleep(0.005)

    asyncio.run_coroutine_threadsafe(lag_probe(), server._loop)
    box = {}

    def client():
        box["results"] = asyncio.run(asyncio.wait_for(
            run_client(server.port, n, server_samples, lag_samples), 300))

    t = threading.Thread(target=client)
    t.start()
    while t.is_alive():
        app.processEvents()
        time.sleep(0.002)
    stop.set()
    time.sleep(0.05)
    server.stop()
    clock.stop()
    return box["results"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, help="bench an already running leader (RTT and offset only)")
    parser.add_argument("-n", type=int, default=200)
    args = parser.parse_args()
    from src.sync.leader_clock import CLOCK_NAME, measured_resolution_ns

    print(f"leader clock: {CLOCK_NAME} (step {measured_resolution_ns()} ns)  N={args.n}")
    if args.port:
        results = asyncio.run(asyncio.wait_for(run_client(args.port, args.n), 300))
    else:
        results = in_process(args.n)
    print_results(results)


if __name__ == "__main__":
    main()
