#!/usr/bin/env python3
"""Smoke-test AoE2CM's real Socket.IO spectator feed."""

import json
import urllib.request

from live_server import fetch_live_socket_snapshot


def actor(event):
    return str(event.get("executingPlayer", event.get("player", ""))).lower()


def action(event):
    return str(event.get("actionType", event.get("action", event.get("type", "")))).lower()


def main():
    # Archived sample: AoE2CM emits a replay over the exact same Socket.IO
    # endpoint. This makes the transport deterministic and verifies all events.
    data, source = fetch_live_socket_snapshot("OEoDI")
    events = data.get("events", []) if isinstance(data, dict) else []
    assert len(events) == 55, f"expected 55 OEoDI events over socket, got {len(events)}"
    admin_bans = [e for e in events if ("ban" in action(e) or "snipe" in action(e)) and actor(e) == "none"]
    assert len(admin_bans) == 27, f"expected 27 admin bans, got {len(admin_bans)}"
    print(json.dumps({"archivedSocket": "PASS", "source": source, "events": len(events), "adminBans": len(admin_bans)}))

    # If a public draft is live right now, validate the true in-memory
    # `draft_state` path too. No failure if AoE2CM happens to have no active
    # public draft at this exact moment.
    req = urllib.request.Request(
        "https://aoe2cm.net/api/recentdrafts",
        headers={"User-Agent": "AoE2DraftAssistant/3.3", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=12) as response:
        recent = json.load(response)
    ongoing = next((d for d in recent if d.get("ongoing") and d.get("draftId")), None)
    if not ongoing:
        print(json.dumps({"ongoingSocket": "SKIP", "reason": "no public ongoing draft at probe time"}))
        return

    live, live_source = fetch_live_socket_snapshot(ongoing["draftId"])
    assert live_source == "draft_state", f"ongoing draft should emit draft_state, got {live_source}"
    assert isinstance(live, dict) and isinstance(live.get("events"), list), "ongoing draft state missing events"
    print(json.dumps({"ongoingSocket": "PASS", "draftId": ongoing["draftId"], "events": len(live["events"]), "source": live_source}))


if __name__ == "__main__":
    main()
