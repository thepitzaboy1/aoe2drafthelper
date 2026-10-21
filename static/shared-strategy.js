// One server library for every visitor; rooms continue to hold draft state only.
app.sharedLibraryEnabled=true;
let sharedReady=false,sharedSending=false,sharedConflict=false,sharedRevision=0;
let sharedBase=null,sharedPending=[],sharedRetry=null;
const savedLibrary=clone(app.strategy);
const rankedLibrary=s=>s?.versions?.some(v=>v.categories?.some(c=>(c.civs||[]).length||Object.values(c.mapCivs||{}).some(xs=>xs.length)));
const unsavedLibrary=localStorage.getItem('aoe2-shared-unsaved');
if(unsavedLibrary)localStorage.setItem('aoe2-shared-backup',unsavedLibrary);
else if(!localStorage.getItem('aoe2-shared-connected')&&rankedLibrary(savedLibrary)&&!localStorage.getItem('aoe2-shared-backup'))localStorage.setItem('aoe2-shared-backup',JSON.stringify(savedLibrary));
document.querySelector('.wrap').insertAdjacentHTML('afterbegin',`<div class="panel" style="padding:12px 16px;margin-bottom:14px" id="sharedLibraryBar"><b>Shared strategy library</b> <span id="sharedSaveStatus" role="status" aria-live="polite">Connecting…</span><div class="tiny">Everyone sees this library. Changes save automatically; draft rooms keep their own picks and bans.</div><div class="inline" style="margin-top:8px"><button id="mergeSavedLibrary" class="btn hidden">Add my saved versions</button><button id="sharedExport" class="btn hidden">Export my unsaved changes</button><button id="sharedReload" class="btn hidden">Load latest shared library</button></div></div>`);
function sharedStatus(text){$('#sharedSaveStatus').textContent=text}
function sharedEditing(enabled){$('#builderView').inert=!enabled;$('#draftVersionSelect').disabled=!enabled}
sharedEditing(false);

function sharedDiff(before,after,path=[]){
  if(JSON.stringify(before)===JSON.stringify(after))return [];
  const identified=xs=>Array.isArray(xs)&&xs.every(x=>x&&typeof x==='object'&&typeof x.id==='string');
  if(identified(before)&&identified(after)){
    const a=Object.fromEntries(before.map(x=>[x.id,x])),b=Object.fromEntries(after.map(x=>[x.id,x]));
    return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>sharedDiff(a[k],b[k],[...path,k]));
  }
  if(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after)){
    return [...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>path.length||!['id','activeVersionId'].includes(k)).flatMap(k=>sharedDiff(before[k],after[k],[...path,k]));
  }
  return [{path,before:before??null,value:after??null,remove:after===undefined}];
}

function acceptShared(document){
  const active=app.strategy.activeVersionId;
  app.strategy=clone(document.strategy);
  app.strategy.activeVersionId=app.strategy.versions.some(v=>v.id===active)?active:app.strategy.versions[0].id;
  if(!app.strategy.versions.some(v=>v.id===app.draft.versionId))app.draft.versionId=app.strategy.activeVersionId;
  if(!currentCategories().some(c=>c.id===app.activeCat))app.activeCat=currentCategories()[0]?.id||'';
  sharedRevision=document.revision;sharedBase=clone(app.strategy);sharedReady=true;
  sharedEditing(!sharedConflict);localStorage.setItem('aoe2-shared-connected','1');saveLocal();renderAll();
  sharedStatus(document.durable?'Saved on server · shared with everyone':'Shared on server · permanent storage is not connected');
  $('#mergeSavedLibrary').classList.toggle('hidden',!localStorage.getItem('aoe2-shared-backup'));
}

async function pullShared(){
  if(sharedSending||sharedPending.length||sharedConflict)return;
  // Do not replace text while a teammate is typing into a field.
  if(sharedReady&&$('#builderView').contains(document.activeElement)&&['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))return;
  try{
    const response=await fetch('/api/strategy',{cache:'no-store'}),result=await response.json();
    if(sharedSending||sharedPending.length||sharedConflict)return;
    if(!response.ok||!result.ok)throw new Error('unavailable');
    if(!sharedReady||result.data.revision>sharedRevision)acceptShared(result.data);
  }catch(error){sharedStatus(sharedReady?'Connection lost · your library is preserved':'Cannot connect to the shared library · retrying');}
}

async function saveShared(){
  if(sharedSending||sharedConflict||!sharedPending.length)return;
  sharedSending=true;clearTimeout(sharedRetry);
  try{
    while(sharedPending.length){
      const batch=sharedPending.slice();
      sharedStatus('Saving changes…');
      const response=await fetch('/api/strategy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patches:batch})});
      const result=await response.json();
      if(!response.ok||!result.ok){
        if(response.status===409||response.status===400){
          sharedConflict=true;localStorage.setItem('aoe2-shared-unsaved',JSON.stringify(app.strategy));localStorage.setItem('aoe2-shared-backup',JSON.stringify(app.strategy));
          sharedStatus(result.error||'An edit conflict needs your attention. Your work has been preserved.');
          $('#sharedExport').classList.remove('hidden');$('#sharedReload').classList.remove('hidden');sharedEditing(false);return;
        }
        throw new Error('unavailable');
      }
      sharedPending.splice(0,batch.length);
      if(!sharedPending.length){acceptShared(result.data);localStorage.removeItem('aoe2-shared-unsaved');}
    }
  }catch(error){sharedStatus('Not saved yet · reconnecting and retrying');sharedRetry=setTimeout(saveShared,2500);}
  finally{sharedSending=false;}
}

const beforeSharedChanged=changed;
changed=function(push=true){
  beforeSharedChanged(push);
  if(!sharedReady||sharedConflict)return;
  const patches=sharedDiff(sharedBase,app.strategy);
  if(patches.length){sharedPending.push(...patches);sharedBase=clone(app.strategy);localStorage.setItem('aoe2-shared-unsaved',JSON.stringify(app.strategy));saveShared();}
};

function mergeSharedVersions(library){
  if(!sharedReady||sharedConflict)throw new Error('Connect to the shared library first');
  if(!Array.isArray(library?.versions)||!library.versions.length)throw new Error('No strategy versions found');
  const valid=library.versions.every(v=>v&&typeof v.id==='string'&&typeof v.name==='string'&&Array.isArray(v.civs)&&v.civs.every(c=>typeof c==='string')&&Array.isArray(v.categories)&&v.categories.length&&v.categories.every(c=>c&&typeof c.id==='string'&&typeof c.name==='string'&&Array.isArray(c.civs)&&c.civs.every(x=>typeof x==='string')&&(!c.mapCivs||(typeof c.mapCivs==='object'&&Object.values(c.mapCivs).every(xs=>Array.isArray(xs)&&xs.every(x=>typeof x==='string')))))&&new Set(v.categories.map(c=>c.id)).size===v.categories.length);
  if(!valid||new Set(library.versions.map(v=>v.id)).size!==library.versions.length)throw new Error('Invalid strategy library; no changes were made');
  const additions=[],ids={};
  for(const source of library.versions){
    const existing=app.strategy.versions.find(v=>v.id===source.id);
    if(existing&&JSON.stringify(existing)===JSON.stringify(source)){ids[source.id]=source.id;continue;}
    const version=clone(source);if(existing)version.id=uid('import');ids[source.id]=version.id;additions.push(version);
  }
  for(const version of additions)if(ids[version.parentId])version.parentId=ids[version.parentId];
  app.strategy.versions.push(...additions);
  if(additions.length){app.strategy.activeVersionId=additions[0].id;app.activeCat=currentCategories()[0]?.id||'';changed();}
  else toast('These versions are already in the shared library.');
}

$('#mergeSavedLibrary').onclick=()=>{
  try{mergeSharedVersions(JSON.parse(localStorage.getItem('aoe2-shared-backup')));localStorage.removeItem('aoe2-shared-backup');$('#mergeSavedLibrary').classList.add('hidden');}
  catch(error){toast(error.message,5000)}
};
const beforeSharedIO=doIO;
doIO=function(){
  if($('#ioAction').dataset.mode==='export')return beforeSharedIO();
  try{const imported=JSON.parse($('#ioText').value);mergeSharedVersions(imported.strategy||imported);$('#ioModal').classList.add('hidden');}
  catch(error){toast('Import failed: '+error.message,5000)}
};
$('#ioAction').onclick=doIO;
$('#sharedExport').onclick=()=>{openIO('export');const saved=localStorage.getItem('aoe2-shared-unsaved')||localStorage.getItem('aoe2-shared-backup');if(saved)$('#ioText').value=JSON.stringify({schema:3,strategy:JSON.parse(saved)},null,2)};
$('#sharedReload').onclick=()=>{sharedPending=[];sharedConflict=false;sharedReady=false;sharedRevision=0;$('#sharedReload').classList.add('hidden');sharedEditing(false);pullShared()};
window.addEventListener('online',()=>{if(sharedPending.length)saveShared();else pullShared()});
window.addEventListener('beforeunload',event=>{if(sharedPending.length){event.preventDefault();event.returnValue=''}});
pullShared();setInterval(pullShared,2000);

function offerLegacyLibrary(library){
  if(rankedLibrary(library)&&!localStorage.getItem('aoe2-shared-backup')){
    localStorage.setItem('aoe2-shared-backup',JSON.stringify(library));
    $('#mergeSavedLibrary').classList.remove('hidden');
  }
}
