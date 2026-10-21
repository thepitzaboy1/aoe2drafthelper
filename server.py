#!/usr/bin/env python3
import argparse
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
STORE_FILE = ROOT / "rooms.json"
LOCK = threading.Lock()

DEFAULT_DRAFT = "https://aoe2cm.net/draft/OEoDI"

def load_store():
    with LOCK:
        if not STORE_FILE.exists():
            return {}
        try:
            return json.loads(STORE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}

def save_store(store):
    with LOCK:
        tmp = STORE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(STORE_FILE)

def clean_room(value):
    room = re.sub(r"[^A-Za-z0-9_-]", "", str(value or ""))[:64]
    return room or "default"

def fetch_json(url, timeout=15):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "AoE2DraftAssistant/2.0", "Accept": "application/json,*/*"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", errors="replace"))

def extract_draft_id(value):
    value = str(value or "").strip()
    m = re.search(r"/draft/([A-Za-z0-9_-]+)", value)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{3,40}", value):
        return value
    raise ValueError("Could not find an AoE2CM draft id.")

class Handler(SimpleHTTPRequestHandler):
    server_version = "AoE2DraftAssistant/2.0"

    def translate_path(self, path):
        parsed = urllib.parse.urlparse(path)
        rel = parsed.path.lstrip("/") or "index.html"
        return str((STATIC / rel).resolve())

    def send_json(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/config":
            return self.send_json({"defaultDraftUrl": DEFAULT_DRAFT})

        if parsed.path == "/api/room":
            room = clean_room((qs.get("room") or ["default"])[0])
            store = load_store()
            return self.send_json({"ok": True, "room": room, "data": store.get(room, {})})

        if parsed.path == "/api/draft":
            try:
                draft_id = extract_draft_id((qs.get("url") or [""])[0])
            except Exception as e:
                return self.send_json({"ok": False, "error": str(e)}, 400)

            try:
                data = fetch_json(f"https://aoe2cm.net/api/draft/{draft_id}")
                return self.send_json({"ok": True, "draftId": draft_id, "data": data, "mode": "draft-api"})
            except Exception as primary_error:
                recent = None
                try:
                    items = fetch_json("https://aoe2cm.net/api/recentdrafts")
                    if isinstance(items, list):
                        recent = next(
                            (x for x in items if str(x.get("draftId", "")).lower() == draft_id.lower()),
                            None,
                        )
                except Exception:
                    pass
                return self.send_json({
                    "ok": False,
                    "draftId": draft_id,
                    "ongoing": bool(recent and recent.get("ongoing")),
                    "recent": recent,
                    "error": str(primary_error),
                    "mode": "manual-live-fallback",
                })

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/room":
            return self.send_json({"ok": False, "error": "Not found"}, 404)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(min(length, 4_000_000))
            payload = json.loads(raw.decode("utf-8"))
            room = clean_room(payload.get("room"))
            data = payload.get("data") or {}
            if not isinstance(data, dict):
                raise ValueError("data must be an object")

            current = load_store()
            prev = current.get(room, {})
            incoming_rev = int(data.get("rev") or 0)
            prev_rev = int(prev.get("rev") or 0)
            data["rev"] = max(incoming_rev, prev_rev + 1)
            data["updatedAt"] = int(time.time() * 1000)
            current[room] = data
            save_store(current)
            return self.send_json({"ok": True, "room": room, "data": data})
        except Exception as e:
            return self.send_json({"ok": False, "error": str(e)}, 400)

def main():
    ap = argparse.ArgumentParser(description="AoE2 category-first live draft assistant")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=int(os.getenv("PORT", "8765")))
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    os.chdir(STATIC)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    local = f"http://127.0.0.1:{args.port}"
    print("\nAoE2 Draft Assistant v2")
    print("======================")
    print("Local:", local)
    print(f"Team/LAN: http://<YOUR-PC-IP>:{args.port}")
    print("Press Ctrl+C to stop.\n")
    if not args.no_browser and os.getenv("RENDER") != "true":
        threading.Timer(0.7, lambda: webbrowser.open(local)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()

if __name__ == "__main__":
    main()
