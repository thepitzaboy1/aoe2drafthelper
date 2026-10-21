#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PORT = 8877
BASE = f"http://127.0.0.1:{PORT}"


def req(path, method="GET", payload=None, timeout=25):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def wait_ready():
    last = None
    for _ in range(40):
        try:
            status, data = req("/api/config", timeout=2)
            if status == 200:
                return data
        except Exception as e:
            last = e
        time.sleep(0.25)
    raise RuntimeError(f"server never became ready: {last}")


def main():
    env = os.environ.copy()
    env["PORT"] = str(PORT)
    proc = subprocess.Popen(
        [sys.executable, "server.py", "--no-browser"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    try:
        config = wait_ready()
        assert config.get("version") == 3, config

        room = "ci-smoke-draft"
        payload = {
            "room": room,
            "data": {
                "rev": 1,
                "strategy": {
                    "name": "CI Tournament Strategy",
                    "versions": [{
                        "id": "v-smoke",
                        "name": "v1 smoke",
                        "description": "Automated smoke-test strategy",
                        "createdAt": "2026-10-21T00:00:00Z",
                        "parentId": None,
                        "locked": True,
                        "civs": ["Mongols", "Franks", "Bohemians", "Celts", "Teutons"],
                        "categories": [
                            {"id": "pocket", "name": "Pocket", "civs": ["Mongols", "Franks", "Teutons"], "mapCivs": {"Black Forest": ["Mongols", "Teutons", "Franks"]}},
                            {"id": "halbso", "name": "Halb + SO", "civs": ["Bohemians", "Celts", "Teutons"], "mapCivs": {"Black Forest": ["Bohemians", "Celts", "Teutons"]}},
                        ],
                    }],
                    "activeVersionId": "v-smoke",
                },
                "draft": {
                    "statuses": {"mongols": "our", "franks": "opp", "bohemians": "ban"},
                    "needIds": ["halbso"],
                    "threatIds": ["pocket"],
                    "selectedMap": "Black Forest",
                    "versionId": "v-smoke",
                },
            },
        }
        status, posted = req("/api/room", "POST", payload)
        assert status == 200 and posted.get("ok") is True, posted

        status, loaded = req("/api/room?room=" + urllib.parse.quote(room))
        assert status == 200 and loaded.get("ok") is True, loaded
        data = loaded.get("data", {})
        assert data.get("draft", {}).get("statuses", {}).get("mongols") == "our", data
        assert data.get("draft", {}).get("selectedMap") == "Black Forest", data
        assert data.get("strategy", {}).get("versions", [])[0].get("locked") is True, data

        # Exercise the map-stats endpoint. Arabia/Arena have a seeded fallback, so
        # this remains deterministic even if the public source is temporarily down.
        status, stats = req("/api/mapstats?map=Arabia")
        assert status == 200 and stats.get("ok") is True, stats
        assert isinstance(stats.get("rows"), list) and len(stats["rows"]) >= 5, stats

        # Exercise the sample draft path supplied for this project. The external
        # AoE2CM service may or may not expose live actions; either way our API
        # must return a well-formed response and never crash the draft assistant.
        status, draft = req("/api/draft?url=" + urllib.parse.quote("https://aoe2cm.net/draft/OEoDI"), timeout=35)
        assert status == 200, draft
        assert draft.get("draftId") == "OEoDI", draft
        assert draft.get("mode") in {"draft-api", "manual-live-fallback"}, draft

        print("SMOKE TEST PASSED")
        print(json.dumps({
            "config": config,
            "room": room,
            "mapStatsRows": len(stats.get("rows", [])),
            "mapStatsSource": stats.get("source"),
            "draftMode": draft.get("mode"),
            "draftOngoing": draft.get("ongoing"),
        }, indent=2))
        return 0
    finally:
        proc.terminate()
        try:
            out, _ = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
        if out:
            print("--- server log ---")
            print(out)


if __name__ == "__main__":
    raise SystemExit(main())
