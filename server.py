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
from shared_store import StrategyStore, Conflict

STRATEGY_STORE = StrategyStore()

ROOT=Path(__file__).resolve().parent
STATIC=ROOT/"static"
DATA_DIR=ROOT/"data"
STORE_FILE=ROOT/"rooms.json"
RF_STATS_FILE=DATA_DIR/"rage_forest_6_2026.json"
LOCK=threading.RLock()
DRAFT_LOCK=threading.Lock()
DEFAULT_DRAFT="https://aoe2cm.net/draft/OEoDI"
MAP_CACHE={}
DRAFT_CACHE={}
CACHE_SECONDS=15*60
DRAFT_CACHE_SECONDS=3.0
DRAFT_STALE_SECONDS=10*60
VERSION=3.2

CIVS={"armenians","aztecs","bengalis","berbers","bohemians","britons","bulgarians","burgundians","burmese","byzantines","celts","chinese","cumans","danes","dravidians","ethiopians","franks","georgians","goths","gurjaras","hindustanis","huns","incas","italians","japanese","jurchens","khitans","khmer","koreans","lithuanians","magyars","malay","malians","mapuche","mayans","mongols","muisca","persians","poles","portuguese","romans","saracens","saxons","shu","sicilians","slavs","spanish","tatars","teutons","tupi","turks","varangians","vietnamese","vikings","wei","wu"}
ALIASES={"maya":"Mayans","inca":"Incas"}
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
    req=urllib.request.Request(url,headers={"User-Agent":f"Mozilla/5.0 AoE2DraftAssistant/{VERSION}","Accept":"text/html,application/json,*/*","Cache-Control":"no-cache"})
    with urllib.request.urlopen(req,timeout=timeout) as r:return r.read(),r.headers.get("Content-Type","")

def fetch_json(url,timeout=15):
    body,_=fetch_bytes(url,timeout)
    return json.loads(body.decode("utf-8",errors="replace"))

def fetch_json_retry(url,timeout=15,attempts=3):
    last=None
    for i in range(max(1,attempts)):
        try:return fetch_json(url,timeout)
        except Exception as e:
            last=e
            if i+1<attempts:time.sleep(0.35*(2**i))
    raise last or RuntimeError("Upstream request failed")

def extract_draft_id(value):
    value=str(value or "").strip();m=re.search(r"/draft/([A-Za-z0-9_-]+)",value)
    if m:return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{3,40}",value):return value
    raise ValueError("Could not find an AoE2CM draft id.")

def get_draft_proxy(draft_id):
    """Fetch one AoE2CM draft reliably without hammering AoE2CM from every browser.

    All team clients share a 3-second server cache. A failed upstream request is
    retried and, if AoE2CM is temporarily unavailable, the last successful copy
    is served for up to 10 minutes. Live clients still poll every five seconds,
    but transient 5xx/DNS failures no longer erase authoritative draft state.
    """
    now=time.time()
    with DRAFT_LOCK:
        cached=DRAFT_CACHE.get(draft_id.lower())
        if cached and now-cached["time"]<DRAFT_CACHE_SECONDS:
            return {"ok":True,"draftId":draft_id,"data":cached["data"],"mode":"draft-api-cache","cached":True,"stale":False,"cacheAgeMs":int((now-cached["time"])*1000)},200
        try:
            data=fetch_json_retry(f"https://aoe2cm.net/api/draft/{draft_id}",timeout=15,attempts=3)
            if not isinstance(data,(dict,list)):raise RuntimeError("AoE2CM returned an unexpected draft payload")
            DRAFT_CACHE[draft_id.lower()]={"time":time.time(),"data":data}
            return {"ok":True,"draftId":draft_id,"data":data,"mode":"draft-api","cached":False,"stale":False},200
        except Exception as primary_error:
            cached=DRAFT_CACHE.get(draft_id.lower())
            age=(time.time()-cached["time"]) if cached else None
            if cached and age is not None and age<DRAFT_STALE_SECONDS:
                return {"ok":True,"draftId":draft_id,"data":cached["data"],"mode":"draft-api-cache","cached":True,"stale":True,"cacheAgeMs":int(age*1000),"warning":str(primary_error)},200
            recent=None
            try:
                items=fetch_json_retry("https://aoe2cm.net/api/recentdrafts",timeout=12,attempts=2)
                if isinstance(items,list):recent=next((x for x in items if str(x.get("draftId","")).lower()==draft_id.lower()),None)
            except Exception:pass
            return {"ok":False,"draftId":draft_id,"ongoing":bool(recent and recent.get("ongoing")),"recent":recent,"error":str(primary_error),"mode":"manual-live-fallback"},502

def nkey(s):return re.sub(r"[^a-z0-9]+","",str(s or "").lower())

def canonical_civ(s):
    raw=str(s or "").strip();key=nkey(raw)
    if key in ALIASES:return ALIASES[key]
    if key in CIVS:return next((c.title() for c in CIVS if c==key),raw)
    return None

def get_rage_forest_stats():
    if not RF_STATS_FILE.exists():
        raise RuntimeError("Rage Forest dataset is missing")
    data=json.loads(RF_STATS_FILE.read_text(encoding="utf-8"))
    prior_games=12.0
    appearances=max(1,int(data.get("civilizationAppearances") or 1))
    rows=[]
    for item in data.get("rows",[]):
        wins=float(item.get("wins") or 0)
        losses=float(item.get("losses") or 0)
        total=int(item.get("total") or (wins+losses))
        raw=float(item.get("winRate") if item.get("winRate") is not None else (100*wins/max(1,total)))
        adjusted=100*((wins+prior_games*.5)/(total+prior_games))
        rows.append({
            "civ":item.get("civ"),
            "wins":int(wins),
            "losses":int(losses),
            "games":total,
            "winRate":round(raw,1),
            "adjustedWinRate":round(adjusted,1),
            "usageShare":round(100*total/appearances,2),
            "dataset":"rf6-2026",
            "scope":"4v4-tournament",
            "sampleType":"civ appearances"
        })
    return {
        "ok":True,
        "rows":rows,
        "source":"rage-forest-6",
        "sourceLabel":"Rage Forest 6 · 4v4 tournament · 127 games · Jul–Aug 2026",
        "sourceUrl":data.get("sourceUrl"),
        "fetchedAt":int(time.time()*1000),
        "fallback":False,
        "datasetMeta":{
            "title":data.get("title"),
            "tournament":data.get("tournament"),
            "format":data.get("format"),
            "underlyingMap":data.get("underlyingMap"),
            "matches":data.get("matches"),
            "civilizationAppearances":data.get("civilizationAppearances"),
            "startDate":data.get("startDate"),
            "endDate":data.get("endDate"),
            "notes":data.get("notes"),
            "shrinkagePriorGames":int(prior_games)
        }
    }

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
            if wr is not None:parsed.append({"civ":civ,"games":games or 0,"winRate":wr,"scope":"1v1-ranked"})
        score=len(parsed)+(30 if "map performance" in table["heading"].lower() else 0)+(5 if parsed and sum(len(r) for r in table["rows"])/max(1,len(table["rows"]))<=3.5 else 0)
        if len(parsed)>=5 and score>best_score:best_score=score;best=parsed
    return best or []

def get_map_stats(map_name):
    if nkey(map_name)=="rageforest":
        return get_rage_forest_stats()
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
        rows=[{"civ":c,"games":g,"winRate":w,"scope":"1v1-ranked"} for c,g,w in seed]
        payload={"ok":True,"rows":rows,"source":"seed","sourceLabel":"Seeded AoE2 Ladder snapshot · 1v1 RM","sourceUrl":url,"fetchedAt":int(time.time()*1000),"fallback":True,"warning":str(e)}
    MAP_CACHE[map_name]={"time":now,"payload":payload};return payload

class Handler(SimpleHTTPRequestHandler):
    server_version=f"AoE2DraftAssistant/{VERSION}"
    def translate_path(self,path):
        parsed=urllib.parse.urlparse(path);rel=parsed.path.lstrip("/") or "index.html"
        base=STATIC.resolve();target=(STATIC/rel).resolve()
        if target!=base and base not in target.parents:return str(base/"__not_found__")
        return str(target)
    def send_json(self,payload,status=200):
        raw=json.dumps(payload,ensure_ascii=False).encode("utf-8");self.send_response(status);self.send_header("Content-Type","application/json; charset=utf-8");self.send_header("Content-Length",str(len(raw)));self.send_header("Cache-Control","no-store");self.end_headers();self.wfile.write(raw)
    def log_message(self,fmt,*args):print("[%s] %s"%(self.log_date_time_string(),fmt%args))
    def do_GET(self):
        parsed=urllib.parse.urlparse(self.path);qs=urllib.parse.parse_qs(parsed.query)
        if parsed.path=="/api/config":return self.send_json({"defaultDraftUrl":DEFAULT_DRAFT,"version":VERSION})
        if parsed.path in ('/api/strategy', '/api/strategy/history'):
            try:
                data = STRATEGY_STORE.history() if parsed.path.endswith('/history') else STRATEGY_STORE.read()
                return self.send_json({'ok': True, 'data': data})
            except Exception:
                return self.send_json({'ok': False, 'error': 'Shared strategy storage is unavailable. Your saved library has not been replaced.'}, 503)
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
            payload,status=get_draft_proxy(draft_id);return self.send_json(payload,status)
        return super().do_GET()
    def do_POST(self):
        parsed=urllib.parse.urlparse(self.path)
        if parsed.path == '/api/strategy':
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length <= 0 or length > 6_000_000:
                    return self.send_json({'ok': False, 'error': 'Invalid request size'}, 413)
                payload = json.loads(self.rfile.read(length))
                return self.send_json({'ok': True, 'data': STRATEGY_STORE.update(payload.get('patches'))})
            except Conflict as exc:
                return self.send_json({'ok': False, 'conflict': True, 'error': str(exc)}, 409)
            except (ValueError, TypeError, AttributeError) as exc:
                return self.send_json({'ok': False, 'error': str(exc)}, 400)
            except Exception:
                return self.send_json({'ok': False, 'error': 'Strategy save failed. Changes are queued for retry.'}, 503)
        if parsed.path!="/api/room":return self.send_json({"ok":False,"error":"Not found"},404)
        try:
            length=int(self.headers.get("Content-Length","0"));raw=self.rfile.read(min(length,6_000_000));payload=json.loads(raw.decode("utf-8"));room=clean_room(payload.get("room"));data=payload.get("data") or {}
            if not isinstance(data,dict):raise ValueError("data must be an object")
            with LOCK:
                current=load_store();prev=current.get(room,{})
                if "patches" in payload:
                    data=json.loads(json.dumps(prev))
                    for patch in payload["patches"]:
                        path=patch.get("path",[])
                        if not path or path[0] not in ("strategy","draft") or any(not isinstance(k,str) or k in ("__proto__","constructor","prototype") for k in path):
                            raise ValueError("Invalid room patch")
                        target=data
                        for key in path[:-1]:
                            if not isinstance(target.get(key),dict):target[key]={}
                            target=target[key]
                        key=path[-1];old=target.get(key)
                        if old!=patch.get("before") and old!=patch.get("value"):
                            return self.send_json({"ok":False,"conflict":True,"error":"Shared field changed; reload and retry"},409)
                        if patch.get("remove"):target.pop(key,None)
                        else:target[key]=patch.get("value")
                data["rev"]=int(prev.get("rev") or 0)+1
                data["updatedAt"]=max(int(time.time()*1000),int(prev.get("updatedAt") or 0)+1)
                current[room]=data;save_store(current)
            return self.send_json({"ok":True,"room":room,"data":data})
        except Exception as e:return self.send_json({"ok":False,"error":str(e)},400)

def main():
    ap=argparse.ArgumentParser(description="AoE2 versioned map-aware draft assistant");ap.add_argument("--host",default="0.0.0.0");ap.add_argument("--port",type=int,default=int(os.getenv("PORT","8765")));ap.add_argument("--no-browser",action="store_true");args=ap.parse_args();os.chdir(STATIC);httpd=ThreadingHTTPServer((args.host,args.port),Handler);local=f"http://127.0.0.1:{args.port}";print(f"\nAoE2 Draft Assistant v{VERSION}\n========================\nLocal:",local);print(f"Team/LAN: http://<YOUR-PC-IP>:{args.port}\nPress Ctrl+C to stop.\n")
    if not args.no_browser and os.getenv("RENDER")!="true":threading.Timer(.7,lambda:webbrowser.open(local)).start()
    try:httpd.serve_forever()
    except KeyboardInterrupt:pass
    finally:httpd.server_close()
if __name__=="__main__":main()
