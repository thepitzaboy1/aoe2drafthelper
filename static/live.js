// Send only changed fields, serially, so independent teammate edits survive.
let roomBase={},roomQueue=[],roomSending=false,roomGeneration=0;
function roomDiff(before,after,path=[]){
  if(JSON.stringify(before)===JSON.stringify(after))return [];
  if(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after)){
    return [...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>!['rev','updatedAt'].includes(k)).flatMap(k=>roomDiff(before[k],after[k],[...path,k]));
  }
  return [{path,before:before??null,value:after??null,remove:after===undefined}];
}
async function pushRoom(){
  if(!app.room)return;
  const snapshot=clone(roomPayload());
  roomQueue.push(...roomDiff(roomBase,snapshot));roomBase=snapshot;
  if(roomSending)return;
  roomSending=true;let sendingPatches=[];const generation=roomGeneration,room=app.room;
  try{
    while(roomQueue.length&&generation===roomGeneration){
      const patches=roomQueue.splice(0);sendingPatches=patches;
      const r=await fetch('/api/room',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room,patches})});
      const j=await r.json();if(generation!==roomGeneration)return;
      if(!j.ok){roomQueue=[];app.lastPull=0;toast(j.conflict?'Room edit conflict. Latest shared state restored; please retry your edit.':'Room save failed: '+(j.error||r.status),6000);break;}
      sendingPatches=[];app.rev=j.data.rev;$('#roomDot').className='dot ok';$('#roomStatus').textContent='Shared room connected';
    }
  }catch(e){if(generation===roomGeneration){roomQueue.unshift(...sendingPatches);setTimeout(()=>pushRoom(),2000);}$('#roomDot').className='dot bad';$('#roomStatus').textContent='Room sync failed · retrying';}
  finally{roomSending=false;if(roomQueue.length&&generation!==roomGeneration)pushRoom();}
}
async function pullRoom(){
  if(!app.room||roomSending||roomQueue.length)return;
  const generation=roomGeneration;
  try{
    const j=await(await fetch('/api/room?room='+encodeURIComponent(app.room),{cache:'no-store'})).json();
    if(generation!==roomGeneration||roomSending||roomQueue.length)return;
    if(!j.ok)throw new Error('Room unavailable');
    if(!j.data?.updatedAt){roomBase={};await pushRoom();return;}
    if((j.data.rev||0)<app.rev&&app.lastPull)return;
    if(j.data?.updatedAt&&j.data.updatedAt>app.lastPull){
      const d=j.data;if(d.strategy?.versions?.length)app.strategy=d.strategy;
      if(d.draft)app.draft=clone(d.draft);
      app.autoStatuses={...(app.draft.syncedStatuses||{})};app.autoDraftMeta=app.draft.syncedMeta||null;
      app.rev=d.rev||0;app.lastPull=d.updatedAt;
      if(!currentCategories().some(c=>c.id===app.activeCat))app.activeCat=currentCategories()[0]?.id||'';
      saveLocal();renderAll();if(app.stats.map!==app.draft.selectedMap)loadMapStats();
    }
    roomBase=clone(roomPayload());$('#roomDot').className='dot ok';$('#roomStatus').textContent='Shared room connected';
  }catch(e){$('#roomDot').className='dot bad';$('#roomStatus').textContent='Room sync failed';}
}
function joinRoom(){const room=$('#roomId').value.trim().replace(/[^A-Za-z0-9_-]/g,'').slice(0,64);if(!room)return toast('Enter a room name.');app.room=room;roomGeneration++;roomQueue=[];roomBase=clone(roomPayload());app.lastPull=0;localStorage.setItem('aoe2-room',room);const u=new URL(location.href);u.searchParams.set('room',room);history.replaceState(null,'',u);pullRoom();clearInterval(app.syncTimer);app.syncTimer=setInterval(pullRoom,2000)}
async function copyRoom(){if(!app.room)return toast('Join a room first.');const u=new URL(location.href);u.searchParams.set('room',app.room);try{await navigator.clipboard.writeText(u.toString());toast('Room link copied.')}catch(e){prompt('Copy this room link:',u.toString())}}
function openIO(mode){$('#ioModal').classList.remove('hidden');$('#ioTitle').textContent=mode==='export'?'Export strategy library':'Import strategy library';$('#ioAction').textContent=mode==='export'?'Copy JSON':'Import JSON';$('#ioAction').dataset.mode=mode;$('#ioHelp').textContent=mode==='export'?'Includes every strategy version and map-specific override. Draft room marks are not included.':'Paste JSON exported from this app.';$('#ioText').value=mode==='export'?JSON.stringify({schema:3,strategy:app.strategy},null,2):''}
function doIO(){const mode=$('#ioAction').dataset.mode;if(mode==='export'){navigator.clipboard?.writeText($('#ioText').value);toast('Strategy library JSON copied.')}else{try{const d=JSON.parse($('#ioText').value),s=d.strategy||d;if(!s?.versions?.length)throw new Error('No versions found.');app.strategy=s;app.strategy.activeVersionId=app.strategy.activeVersionId||app.strategy.versions[0].id;app.activeCat=currentVersion().categories[0]?.id||'';if(!app.strategy.versions.some(v=>v.id===app.draft.versionId))app.draft.versionId=currentVersion().id;$('#ioModal').classList.add('hidden');changed()}catch(e){toast('Import failed: '+e.message,4500)}}}
function resetStrategy(){if(!confirm('Reset the strategy library to a new blank v1? Draft marks will remain.'))return;const v=makeVersion('v1 – new');app.strategy={id:'team',name:'Team Strategy',versions:[v],activeVersionId:v.id};app.draft.versionId=v.id;app.draft.needIds=['flank'];app.draft.threatIds=[];app.activeCat='flank';app.builderMap='Base';changed()}

function inferActor(o){for(const k of['player','actor','participant','side','team','user','owner','drafter']){if(o&&o[k]!=null){const v=typeof o[k]==='object'?(o[k].name||o[k].id||JSON.stringify(o[k])):o[k],s=String(v).toLowerCase();if(s.includes('host'))return'host';if(s.includes('guest'))return'guest'}}return''}
function optionName(v){if(v==null)return'';if(typeof v==='string'||typeof v==='number')return String(v);if(typeof v==='object')for(const k of['name','label','title','civilization','civilisation','civ','option','value','id'])if(v[k]!=null&&(typeof v[k]==='string'||typeof v[k]==='number'))return String(v[k]);return''}
function parseDraftObject(root){const events=[],seen=new Set();function walk(v){if(v==null)return;if(Array.isArray(v)){v.forEach(walk);return}if(typeof v!=='object'||seen.has(v))return;seen.add(v);const a=v.action??v.type??v.mode??v.kind??v.actionType;if(typeof a==='string'&&/(pick|ban|snipe|steal)/i.test(a)){let choice='';for(const k of['option','civilization','civilisation','civ','choice','selected','selection','draftOption','value','target']){if(v[k]!=null){choice=optionName(v[k]);if(choice)break}}if(choice)events.push({action:a.toLowerCase(),choice,actor:inferActor(v)})}Object.values(v).forEach(walk)}walk(root);const ours=$('#ourSide').value,auto={};events.forEach(e=>{const key=norm(e.choice);if(!key)return;if(/ban|snipe/.test(e.action))auto[key]='ban';else auto[key]=(e.actor&&e.actor!==ours)?'opp':'our'});app.autoStatuses=auto;renderLive();return events.length}
async function syncDraft(){$('#draftDot').className='dot warn';$('#draftStatus').textContent='Syncing…';try{const j=await(await fetch('/api/draft?url='+encodeURIComponent($('#draftUrl').value),{cache:'no-store'})).json();if(j.ok){const n=parseDraftObject(j.data);$('#draftDot').className='dot ok';$('#draftStatus').textContent=`AoE2CM synced · ${n} actions`;const h=j.data?.nameHost||j.data?.host?.name||'',g=j.data?.nameGuest||j.data?.guest?.name||'';if(h||g)$('#players').textContent=`Host: ${typeof h==='object'?h.name||'':h} · Guest: ${typeof g==='object'?g.name||'':g}`}else{app.autoStatuses={};renderLive();$('#draftDot').className='dot warn';$('#draftStatus').textContent=j.ongoing?'Live draft · manual board fallback':'Draft actions unavailable · manual board fallback';if(j.recent)$('#players').textContent=`Host: ${j.recent.nameHost||'?'} · Guest: ${j.recent.nameGuest||'?'}`}}catch(e){$('#draftDot').className='dot bad';$('#draftStatus').textContent='Draft sync failed · manual mode'}}

function bindUI(){
  $$('.tab').forEach(x=>x.onclick=()=>setTab(x.dataset.tab));
  $('#newCatBtn').onclick=newCategory;$('#renameCatBtn').onclick=renameCategory;$('#deleteCatBtn').onclick=deleteCategory;$('#poolSearch').oninput=renderBuilder;$('#addCustomCiv').onclick=addCustomCiv;
  $('#newVersionBtn').onclick=()=>newVersion();$('#restoreVersionBtn').onclick=restoreAsNew;$('#renameVersionBtn').onclick=renameVersion;$('#describeVersionBtn').onclick=describeVersion;$('#lockVersionBtn').onclick=toggleVersionLock;$('#deleteVersionBtn').onclick=deleteVersion;
  $('#versionSelect').onchange=e=>selectVersion(e.target.value);$('#strategyName').onchange=e=>{app.strategy.name=e.target.value.trim()||'Team Strategy';changed()};
  $('#builderMap').onchange=e=>{app.builderMap=e.target.value;saveLocal();renderBuilder()};$('#resetMapOverrideBtn').onclick=resetMapOverride;
  $('#draftVersionSelect').onchange=e=>{app.draft.versionId=e.target.value;const ids=new Set(liveCategories().map(c=>c.id));app.draft.needIds=app.draft.needIds.filter(x=>ids.has(x));app.draft.threatIds=app.draft.threatIds.filter(x=>ids.has(x));changed()};
  $('#draftMap').onchange=e=>{app.draft.selectedMap=e.target.value;app.stats={map:'',rows:{},source:'',fetchedAt:0,error:''};changed();loadMapStats(true)};$('#refreshStatsBtn').onclick=()=>loadMapStats(true);
  $('#exportBtn').onclick=()=>openIO('export');$('#importBtn').onclick=()=>openIO('import');$('#resetBtn').onclick=resetStrategy;$('#ioClose').onclick=()=>$('#ioModal').classList.add('hidden');$('#ioAction').onclick=doIO;
  $('#joinRoom').onclick=joinRoom;$('#copyRoom').onclick=copyRoom;$('#syncDraftBtn').onclick=syncDraft;$('#ourSide').onchange=syncDraft;$('#boardSearch').oninput=renderBoard;$('#boardFilter').onchange=renderBoard;$('#clearDraftBtn').onclick=clearDraft;
}
loadLocal();bindUI();const params=new URLSearchParams(location.search);$('#roomId').value=params.get('room')||localStorage.getItem('aoe2-room')||'';if($('#roomId').value)joinRoom();renderAll();loadMapStats();
