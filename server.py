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
from html.parser import HTMLParser
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT=Path(__file__).resolve().parent
STATIC=ROOT/"static"
STORE_FILE=ROOT/"rooms.json"
LOCK=threading.Lock()
DEFAULT_DRAFT="https://aoe2cm.net/draft/OEoDI"
MAP_CACHE={}
CACHE_SECONDS=15*60

CIVS={"armenians","aztecs","bengalis","berbers","bohemians","britons","bulgarians","burgundians","burmese","byzantines","celts","chinese","cumans","danes","dravidians","ethiopians","franks","georgians","goths","gurjaras","hindustanis","huns","incas","italians","japanese","jurchens","khitans","khmer","koreans","lithuanians","magyars","malay","malians","mapuche","mayans","mongols","muisca","persians","poles","portuguese","romans","saracens","saxons","shu","sicilians","slavs","spanish","tatars","teutons","tupi","turks","varangians","vietnamese","vikings","wei","wu"}
ALIASES={"maya":"Mayans"}
SEED_STATS={
 "Arabia":[("Romans",8717,55.8),("Armenians",6371,53.2),("Bulgarians",10265,53.2),("Hindustanis",9078,53.0),("Vikings",10160,53.0),("Franks",29971,52.5),("Malians",6938,52.5),("Sicilians",8008,52.4),("Mayans",10859,52.3),("Persians",17770,52.2),("Mongols",31630,52.1),("Huns",11067,52.0),("Ethiopians",14894,51.9),("Japanese",14251,51.7)],
 "Arena":[("Turks",12230,58.5),("Malay",2924,55.4),("Malians",2338,54.9),("Poles",4627,54.0),("Italians",3967,54.0),("Khmer",8422,53.8),("Cumans",4032,53.7),("Hindustanis",2864,53.4),("Bohemians",9720,53.2)]
}

def load_store():
    with LOCK:
        if not STORE_FILE.exists(): return {}
        try:return json.loads(STORE_FILE.read_text(encoding="utf-8"))
        except Exception:return {}

def save_store(store):
    with LOCK:
        tmp=STORE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(store,ensure_ascii=False,indent=2),encoding="utf-8")
        tmp.replace(STORE_FILE)

def clean_room(value):
    room=re.sub(r"[^A-Za-z0-9_-]","",str(value or ""))[:64]
    return room or "default"

def fetch_bytes(url,timeout=18):
    req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0 AoE2DraftAssistant/3.0","Accept":"text/html,application/json,*/*"})
    with urllib.request.urlopen(req,timeout=timeout) as r:return r.read(),r.headers.get("Content-Type","")

def fetch_json(url,timeout=15):
    body,_=fetch_bytes(url,timeout)
    return json.loads(body.decode("utf-8",errors="replace"))

def extract_draft_id(value):
    value=str(value or "").strip();m=re.search(r"/draft/([A-Za-z0-9_-]+)",value)
    if m:return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{3,40}",value):return value
    raise ValueError("Could not find an AoE2CM draft id.")

def nkey(s):return re.sub(r"[^a-z0-9]+","",str(s or "").lower())

def canonical_civ(s):
    raw=str(s or "").strip();key=nkey(raw)
    if key in ALIASES:return ALIASES[key]
    if key in CIVS:return next((c.title() for c in CIVS if c==key),raw)
    return None

class TableParser(HTMLParser):
    def __init__(self):
        super().__init__();self.tables=[];self.last_heading="";self.in_heading=False;self.heading_buf=[];self.table=None;self.row=None;self.cell=None;self.cell_buf=[]
    def handle_starttag(self,tag,attrs):
        tag=tag.lower()
        if tag in ("h1","h2","h3","h4"):self.in_heading=True;self.heading_buf=[]
        elif tag=="table":self.table={"heading":self.last_heading,"rows":[]}
        elif tag=="tr" and self.table is not None:self.row=[]
        elif tag in ("td","th") and self.row is not None:self.cell=tag;self.cell_buf=[]
    def handle_data(self,data):
        if self.in_heading:self.heading_buf.append(data)
        if self.cell is not None:self.cell_buf.append(data)
    def handle_endtag(self,tag):
        tag=tag.lower()
        if tag in ("h1","h2","h3","h4") and self.in_heading:
            self.last_heading=" ".join("".join(self.heading_buf).split());self.in_heading=False
        elif tag in ("td","th") and self.cell is not None:
            self.row.append(" ".join("".join(self.cell_buf).split()));self.cell=None;self.cell_buf=[]
        elif tag=="tr" and self.row is not None:
            if any(self.row):self.table["rows"].append(self.row)
            self.row=None
        elif tag=="table" and self.table is not None:
            self.tables.append(self.table);self.table=None

def parse_map_stats(html):
    p=TableParser();p.feed(html)
    best=None;best_score=-1
    for table in p.tables:
        parsed=[]
        for cells in table["rows"]:
            if not cells:continue
            civ=canonical_civ(cells[0])
            if not civ:continue
            wr=None;games=None
            for cell in cells[1:]:
                if "%" in cell:
                    m=re.search(r"(-?\d+(?:\.\d+)?)\s*%",cell)
                    if m:wr=float(m.group(1))
                elif games is None:
                    m=re.fullmatch(r"[\d,]+",cell.strip())
                    if m:games=int(cell.replace(",",""))
            if wr is not None:parsed.append({"civ":civ,"games":games or 0,"winRate":wr})
        score=len(parsed)+(30 if "map performance" in table["heading"].lower() else 0)+(5 if parsed and sum(len(r) for r in table["rows"])/max(1,len(table["rows"]))<=3.5 else 0)
        if len(parsed)>=5 and score>best_score:best_score=score;best=parsed
    return best or []

def get_map_stats(map_name):
    now=time.time();cached=MAP_CACHE.get(map_name)
    if cached and now-cached["time"]<CACHE_SECONDS:return cached["payload"]
    url="https://aoe2ladder.com/statistics?"+urllib.parse.urlencode({"map":map_name})
    try:
        body,_=fetch_bytes(url,20);rows=parse_map_stats(body.decode("utf-8",errors="replace"))
        if not rows:raise RuntimeError("No map-performance table found")
        payload={"ok":True,"rows":rows,"source":"aoe2ladder","sourceLabel":"AoE2 Ladder · 1v1 RM public map stats","sourceUrl":url,"fetchedAt":int(time.time()*1000),"fallback":False}
    except Exception as e:
        seed=SEED_STATS.get(map_name,[])
        if not seed:raise RuntimeError(str(e))
        rows=[{"civ":c,"games":g,"winRate":w} for c,g,w in seed]
        payload={"ok":True,"rows":rows,"source":"seed","sourceLabel":"Seeded AoE2 Ladder snapshot · 1v1 RM","sourceUrl":url,"fetchedAt":int(time.time()*1000),"fallback":True,"warning":str(e)}
    MAP_CACHE[map_name]={"time":now,"payload":payload};return payload

class Handler(SimpleHTTPRequestHandler):
    server_version="AoE2DraftAssistant/3.0"
    def translate_path(self,path):
        parsed=urllib.parse.urlparse(path);rel=parsed.path.lstrip("/") or "index.html"
        return str((STATIC/rel).resolve())
    def send_json(self,payload,status=200):
        raw=json.dumps(payload,ensure_ascii=False).encode("utf-8");self.send_response(status);self.send_header("Content-Type","application/json; charset=utf-8");self.send_header("Content-Length",str(len(raw)));self.send_header("Cache-Control","no-store");self.end_headers();self.wfile.write(raw)
    def log_message(self,fmt,*args):print("[%s] %s"%(self.log_date_time_string(),fmt%args))
    def do_GET(self):
        parsed=urllib.parse.urlparse(self.path);qs=urllib.parse.parse_qs(parsed.query)
        if parsed.path=="/api/config":return self.send_json({"defaultDraftUrl":DEFAULT_DRAFT,"version":3})
        if parsed.path=="/api/room":
            room=clean_room((qs.get("room") or ["default"])[0]);store=load_store();return self.send_json({"ok":True,"room":room,"data":store.get(room,{})})
        if parsed.path=="/api/mapstats":
            map_name=(qs.get("map") or [""])[0].strip()[:80]
            if not map_name:return self.send_json({"ok":False,"error":"Map is required"},400)
            try:return self.send_json(get_map_stats(map_name))
            except Exception as e:return self.send_json({"ok":False,"error":str(e),"rows":[]},502)
        if parsed.path=="/api/draft":
            try:draft_id=extract_draft_id((qs.get("url") or [""])[0])
            except Exception as e:return self.send_json({"ok":False,"error":str(e)},400)
            try:
                data=fetch_json(f"https://aoe2cm.net/api/draft/{draft_id}");return self.send_json({"ok":True,"draftId":draft_id,"data":data,"mode":"draft-api"})
            except Exception as primary_error:
                recent=None
                try:
                    items=fetch_json("https://aoe2cm.net/api/recentdrafts")
                    if isinstance(items,list):recent=next((x for x in items if str(x.get("draftId","")).lower()==draft_id.lower()),None)
                except Exception:pass
                return self.send_json({"ok":False,"draftId":draft_id,"ongoing":bool(recent and recent.get("ongoing")),"recent":recent,"error":str(primary_error),"mode":"manual-live-fallback"})
        return super().do_GET()
    def do_POST(self):
        parsed=urllib.parse.urlparse(self.path)
        if parsed.path!="/api/room":return self.send_json({"ok":False,"error":"Not found"},404)
        try:
            length=int(self.headers.get("Content-Length","0"));raw=self.rfile.read(min(length,6_000_000));payload=json.loads(raw.decode("utf-8"));room=clean_room(payload.get("room"));data=payload.get("data") or {}
            if not isinstance(data,dict):raise ValueError("data must be an object")
            current=load_store();prev=current.get(room,{});data["rev"]=max(int(data.get("rev") or 0),int(prev.get("rev") or 0)+1);data["updatedAt"]=int(time.time()*1000);current[room]=data;save_store(current);return self.send_json({"ok":True,"room":room,"data":data})
        except Exception as e:return self.send_json({"ok":False,"error":str(e)},400)

def main():
    ap=argparse.ArgumentParser(description="AoE2 versioned map-aware draft assistant");ap.add_argument("--host",default="0.0.0.0");ap.add_argument("--port",type=int,default=int(os.getenv("PORT","8765")));ap.add_argument("--no-browser",action="store_true");args=ap.parse_args();os.chdir(STATIC);httpd=ThreadingHTTPServer((args.host,args.port),Handler);local=f"http://127.0.0.1:{args.port}";print("\nAoE2 Draft Assistant v3\n======================\nLocal:",local);print(f"Team/LAN: http://<YOUR-PC-IP>:{args.port}\nPress Ctrl+C to stop.\n")
    if not args.no_browser and os.getenv("RENDER")!="true":threading.Timer(.7,lambda:webbrowser.open(local)).start()
    try:httpd.serve_forever()
    except KeyboardInterrupt:pass
    finally:httpd.server_close()
if __name__=="__main__":main()
