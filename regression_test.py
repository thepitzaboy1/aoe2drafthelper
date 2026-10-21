import json, tempfile, threading, unittest, urllib.request, urllib.error
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
import server, live_server

class Regression(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.store=patch.object(server,'STORE_FILE',Path(self.tmp.name)/'rooms.json');self.store.start()
  self.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);threading.Thread(target=self.http.serve_forever,daemon=True).start()
  self.url='http://127.0.0.1:'+str(self.http.server_port);server.DRAFT_CACHE.clear()
 def tearDown(self):
  self.http.shutdown();self.http.server_close();self.store.stop();self.tmp.cleanup()
 def request(self,path,data=None):
  req=urllib.request.Request(self.url+path,data=json.dumps(data).encode() if data else None,headers={'Content-Type':'application/json'})
  try:
   with urllib.request.urlopen(req) as r:return r.status,json.load(r)
  except urllib.error.HTTPError as e:return e.code,json.load(e)
 def test_simultaneous_room_edits_and_conflict(self):
  self.request('/api/room',{'room':'test','data':{'strategy':{'name':'test'},'draft':{'statuses':{}}}})
  def mark(c):return self.request('/api/room',{'room':'test','patches':[{'path':['draft','statuses',c],'before':None,'value':'our'}]})
  with ThreadPoolExecutor() as pool: self.assertTrue(all(r[0]==200 for r in pool.map(mark,['celts','britons'])))
  _,r=self.request('/api/room?room=test');self.assertEqual(r['data']['draft']['statuses'],{'celts':'our','britons':'our'})
  code,_=self.request('/api/room',{'room':'test','patches':[{'path':['draft','statuses','celts'],'before':None,'value':'ban'}]});self.assertEqual(code,409)
 def test_invalid_and_rf_stats(self):
  self.assertEqual(self.request('/api/draft?url=%25%25%25')[0],400)
  _,r=self.request('/api/mapstats?map=Rage%20Forest');self.assertTrue(r['ok']);self.assertEqual(len(r['rows']),53)
 def test_socket_fallback_stale_cache_and_case_sensitive_ids(self):
  with patch.object(server,'fetch_json_retry',side_effect=RuntimeError('REST down')),patch.object(live_server,'fetch_live_socket_snapshot',return_value=({'events':[]},'draft_state')) as socket:
   r,code=live_server.get_draft_proxy('AbCdE');self.assertEqual(code,200);self.assertEqual(r['mode'],'draft-live-socket')
   r,_=live_server.get_draft_proxy('abcde');self.assertEqual(socket.call_count,2)
  server.DRAFT_CACHE['AbCdE']['time']-=4
  with patch.object(server,'fetch_json_retry',side_effect=RuntimeError('down')),patch.object(live_server,'fetch_live_socket_snapshot',side_effect=RuntimeError('down')):
   r,_=live_server.get_draft_proxy('AbCdE');self.assertTrue(r['stale'])
   r,code=live_server.get_draft_proxy('missing');self.assertEqual(code,502);self.assertFalse(r['ok'])
if __name__=='__main__':unittest.main()
