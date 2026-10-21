#!/usr/bin/env python3
"""AoE2 Draft Assistant runtime with true live AoE2CM Socket.IO fallback.

AoE2CM's REST /api/draft/:id endpoint serves the persisted JSON file. During an
active draft that file can be missing or lag behind the actual in-memory draft.
AoE2CM's own UI receives the live state over Socket.IO (`draft_state`).

This wrapper keeps the existing server intact, but replaces its draft proxy so
we use REST when available and automatically fall back to the same spectator
Socket.IO snapshot that AoE2CM itself uses for ongoing drafts.
"""

import threading
import time
import urllib.parse

import socketio

import server as base

VERSION = 3.3
SOCKET_WAIT_SECONDS = 6.0
base.VERSION = VERSION
base.Handler.server_version = f"AoE2DraftAssistant/{VERSION}"


def fetch_live_socket_snapshot(draft_id):
    """Return (draft_state, source_event) from AoE2CM's live spectator socket."""
    ready = threading.Event()
    holder = {"data": None, "event": None, "message": None}
    sio = socketio.Client(
        reconnection=False,
        logger=False,
        engineio_logger=False,
        request_timeout=8,
    )

    @sio.on("draft_state")
    def on_draft_state(data):
        holder["data"] = data
        holder["event"] = "draft_state"
        ready.set()

    @sio.on("replay")
    def on_replay(data):
        # Completed/archived drafts are emitted as replay by AoE2CM. Supporting
        # this also lets us validate the socket transport against known drafts.
        holder["data"] = data
        holder["event"] = "replay"
        ready.set()

    @sio.on("message")
    def on_message(message):
        holder["message"] = str(message)
        # A non-existent draft is sent as a message followed by disconnect.
        if "does not exist" in holder["message"].lower():
            ready.set()

    query = urllib.parse.urlencode({"draftId": draft_id})
    url = f"https://aoe2cm.net?{query}"
    connect_error = None
    try:
        # Polling is intentional: it works reliably from hosted Python without
        # requiring a websocket transport and is enough for a short snapshot.
        sio.connect(
            url,
            transports=["polling"],
            wait_timeout=8,
            headers={"User-Agent": f"AoE2DraftAssistant/{VERSION}"},
        )
        ready.wait(SOCKET_WAIT_SECONDS)
    except Exception as exc:
        connect_error = exc
        # Socket.IO may disconnect immediately after emitting a replay. If the
        # callback already captured data, that is still a successful snapshot.
        if holder["data"] is None:
            raise
    finally:
        try:
            if sio.connected:
                sio.disconnect()
        except Exception:
            pass

    if holder["data"] is None:
        detail = holder["message"] or (str(connect_error) if connect_error else "no draft_state event received")
        raise RuntimeError(f"AoE2CM live socket returned no draft state: {detail}")
    if not isinstance(holder["data"], (dict, list)):
        raise RuntimeError("AoE2CM live socket returned an unexpected payload")
    return holder["data"], holder["event"] or "draft_state"


def get_draft_proxy(draft_id):
    """REST first, live Socket.IO second, then last-known-good cache."""
    now = time.time()
    key = draft_id.lower()

    with base.DRAFT_LOCK:
        cached = base.DRAFT_CACHE.get(key)
        if cached and now - cached["time"] < base.DRAFT_CACHE_SECONDS:
            source_mode = cached.get("mode", "draft-api")
            return {
                "ok": True,
                "draftId": draft_id,
                "data": cached["data"],
                "mode": f"{source_mode}-cache",
                "cached": True,
                "stale": False,
                "cacheAgeMs": int((now - cached["time"]) * 1000),
            }, 200

        rest_error = None
        try:
            data = base.fetch_json_retry(
                f"https://aoe2cm.net/api/draft/{draft_id}", timeout=12, attempts=2
            )
            if not isinstance(data, (dict, list)):
                raise RuntimeError("AoE2CM REST endpoint returned an unexpected payload")
            base.DRAFT_CACHE[key] = {"time": time.time(), "data": data, "mode": "draft-api"}
            return {
                "ok": True,
                "draftId": draft_id,
                "data": data,
                "mode": "draft-api",
                "cached": False,
                "stale": False,
            }, 200
        except Exception as exc:
            rest_error = exc

        socket_error = None
        try:
            data, source_event = fetch_live_socket_snapshot(draft_id)
            mode = "draft-live-socket" if source_event == "draft_state" else "draft-socket-replay"
            base.DRAFT_CACHE[key] = {"time": time.time(), "data": data, "mode": mode}
            return {
                "ok": True,
                "draftId": draft_id,
                "data": data,
                "mode": mode,
                "cached": False,
                "stale": False,
                "restFallback": True,
                "restWarning": str(rest_error),
            }, 200
        except Exception as exc:
            socket_error = exc

        cached = base.DRAFT_CACHE.get(key)
        age = (time.time() - cached["time"]) if cached else None
        if cached and age is not None and age < base.DRAFT_STALE_SECONDS:
            source_mode = cached.get("mode", "draft-api")
            return {
                "ok": True,
                "draftId": draft_id,
                "data": cached["data"],
                "mode": f"{source_mode}-cache",
                "cached": True,
                "stale": True,
                "cacheAgeMs": int(age * 1000),
                "warning": f"REST: {rest_error}; live socket: {socket_error}",
            }, 200

        recent = None
        try:
            items = base.fetch_json_retry("https://aoe2cm.net/api/recentdrafts", timeout=10, attempts=2)
            if isinstance(items, list):
                recent = next(
                    (x for x in items if str(x.get("draftId", "")).lower() == key),
                    None,
                )
        except Exception:
            pass

        return {
            "ok": False,
            "draftId": draft_id,
            "ongoing": bool(recent and recent.get("ongoing")),
            "recent": recent,
            "error": f"REST failed: {rest_error}; live socket failed: {socket_error}",
            "mode": "manual-live-fallback",
        }, 502


# Handler.do_GET looks up this module global at request time, so replacing the
# function is enough to upgrade the existing HTTP server without duplicating it.
base.get_draft_proxy = get_draft_proxy


if __name__ == "__main__":
    base.main()
