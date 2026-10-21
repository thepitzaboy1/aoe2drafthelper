import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE=(process.env.TARGET_URL||'https://aoe2-draft-assistant.onrender.com').replace(/\/$/,'');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const CIVS=["Armenians","Aztecs","Bengalis","Berbers","Bohemians","Britons","Bulgarians","Burgundians","Burmese","Byzantines","Celts","Chinese","Cumans","Danes","Dravidians","Ethiopians","Franks","Georgians","Goths","Gurjaras","Hindustanis","Huns","Incas","Italians","Japanese","Jurchens","Khitans","Khmer","Koreans","Lithuanians","Magyars","Malay","Malians","Mapuche","Mayans","Mongols","Muisca","Persians","Poles","Portuguese","Romans","Saracens","Saxons","Shu","Sicilians","Slavs","Spanish","Tatars","Teutons","Tupi","Turks","Varangians","Vietnamese","Vikings","Wei","Wu"];

async function json(path,opts={}){const r=await fetch(BASE+path,opts);const raw=await r.text();let body;try{body=JSON.parse(raw)}catch{body={raw}}return{status:r.status,body}}
async function waitForDeploy(){
  let last='';
  for(let i=0;i<72;i++){
    try{
      const [asset,home,config]=await Promise.all([fetch(BASE+'/strategy-live-fix.js',{cache:'no-store'}),fetch(BASE+'/',{cache:'no-store'}),json('/api/config')]);
      const [a,h]=await Promise.all([asset.text(),home.text()]);
      if(asset.status===200&&a.includes('STRATEGY_LIVE_FIX_VERSION="3.2"')&&h.includes('strategy-live-fix.js')&&h.includes('AoE2 Draft Assistant v3.2')&&config.status===200&&Number(config.body.version)>=3.2)return;
      last=`asset=${asset.status}, marker=${a.includes('STRATEGY_LIVE_FIX_VERSION="3.2"')}, html=${h.includes('AoE2 Draft Assistant v3.2')}, api=${config.body?.version}`;
    }catch(e){last=e.message}
    await sleep(5000);
  }
  throw new Error('v3.2 front/back end did not deploy: '+last);
}
async function liveDraft(path,attempts=6){
  let last;
  for(let i=0;i<attempts;i++){
    last=await json(path);
    if(last.status===200&&last.body?.ok)return last;
    await sleep(1500*(i+1));
  }
  return last;
}
function action(e){return String(e.actionType??e.action??e.type??'').toLowerCase()}
function actor(e){return String(e.executingPlayer??e.player??'').toLowerCase()}
function choice(e){return String(e.chosenOptionId??e.option??e.civ??'')}

async function main(){
  const report={target:BASE,api:{},browser:{}};
  await waitForDeploy();

  // Validate the real AoE2CM sample before touching the UI. The server itself
  // retries and caches; the outer retries make the E2E tolerant of a Render or
  // AoE2CM cold start without hiding a sustained outage.
  const draftPath='/api/draft?url='+encodeURIComponent('https://aoe2cm.net/draft/OEoDI');
  const d=await liveDraft(draftPath);
  assert.equal(d.status,200,`AoE2CM proxy stayed unavailable: ${JSON.stringify(d.body)}`);assert.equal(d.body.ok,true);assert.match(d.body.mode,/^draft-api/);
  const events=d.body.data?.events||[];
  const admin=events.filter(e=>/ban|snipe/.test(action(e))&&actor(e)==='none');
  const hostBans=events.filter(e=>/ban|snipe/.test(action(e))&&actor(e)==='host');
  const guestBans=events.filter(e=>/ban|snipe/.test(action(e))&&actor(e)==='guest');
  const hostPicks=events.filter(e=>/pick|steal/.test(action(e))&&actor(e)==='host');
  const guestPicks=events.filter(e=>/pick|steal/.test(action(e))&&actor(e)==='guest');
  assert.equal(events.length,55,'OEoDI should expose all completed actions');
  assert.equal(admin.length,27,'OEoDI admin bans must be identifiable');
  assert.equal(hostBans.length,2);assert.equal(guestBans.length,2);
  assert.equal(hostPicks.length,12);assert.equal(guestPicks.length,12);
  report.api.aoe2cm={events:events.length,adminBans:admin.length,hostBans:hostBans.length,guestBans:guestBans.length,hostPicks:hostPicks.length,guestPicks:guestPicks.length,proxyMode:d.body.mode};

  // Verify the shared short cache: a second immediate request should succeed and
  // should not require every teammate's browser to hit AoE2CM independently.
  const cached=await json(draftPath);assert.equal(cached.status,200);assert.equal(cached.body.ok,true);assert.match(cached.body.mode,/^draft-api/);report.api.sharedDraftCache='PASS';

  // Seed a deterministic strategy room. Romans is deliberately in the civ pool
  // but not in any category, so a global-stat fallback would be caught.
  const room='strategy-live-'+Date.now();
  const state={rev:1,strategy:{id:'team',name:'Strategy E2E',versions:[{id:'v1',name:'RF strategy',description:'',createdAt:new Date().toISOString(),parentId:null,locked:false,categories:[
    {id:'primary',name:'Primary role',civs:['Khmer','Bohemians','Celts'],mapCivs:{'Rage Forest':['Khmer','Celts','Bohemians'],'Arabia':['Bohemians','Celts','Khmer']}},
    {id:'secondary',name:'Secondary role',civs:['Teutons','Celts'],mapCivs:{'Rage Forest':['Teutons','Celts'],'Arabia':['Teutons','Celts']}}
  ],civs:CIVS}],activeVersionId:'v1'},draft:{statuses:{},needIds:[],threatIds:[],selectedMap:'Rage Forest',versionId:'v1',strategyEngineVersion:2,ourSide:'host'}};
  let r=await json('/api/room',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({room,data:state})});
  assert.equal(r.status,200);assert.equal(r.body.ok,true);

  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(BASE+'/?room='+encodeURIComponent(room),{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.querySelector('#roomStatus')?.textContent.includes('connected'),null,{timeout:20000});
  await page.click('.tab[data-tab="live"]');await page.waitForSelector('#liveView:not(.hidden)');
  assert.match(await page.title(),/v3\.2/);
  assert.equal(await page.locator('#draftMap').inputValue(),'Rage Forest');
  assert.match(await page.locator('#strategyPlanStatus').innerText(),/2 open \/ 2 ranked categories/i);

  // Synthetic authoritative state: one admin ban, one of our picks, one opponent pick.
  await page.evaluate(()=>parseDraftObject({events:[
    {actionType:'ban',player:'NONE',executingPlayer:'NONE',chosenOptionId:'Khmer'},
    {actionType:'pick',player:'HOST',executingPlayer:'HOST',chosenOptionId:'Teutons'},
    {actionType:'pick',player:'GUEST',executingPlayer:'GUEST',chosenOptionId:'Mongols'}
  ]}));
  await page.waitForFunction(()=>document.querySelector('#draftSourceSummary')?.textContent.includes('1 admin bans'));
  assert.match(await page.locator('#boardGrid .civ[data-civ="Khmer"]').innerText(),/ADMIN BAN/);
  assert.match(await page.locator('#boardGrid .civ[data-civ="Teutons"]').innerText(),/OUR PICK/);
  assert.match(await page.locator('#boardGrid .civ[data-civ="Mongols"]').innerText(),/THEIR PICK/);
  assert.match(await page.locator('#strategyPlanStatus').innerText(),/1 open \/ 2 ranked categories/i,'our Teutons pick should secure Secondary role');

  // Admin state must beat any manual click/mark.
  await page.locator('#boardGrid .civ[data-civ="Khmer"]').click();
  assert.match(await page.locator('#boardGrid .civ[data-civ="Khmer"]').innerText(),/ADMIN BAN/);

  // Rage Forest recommendation must come from the map-specific team strategy.
  assert.equal(await page.evaluate(()=>scoreStrategyPicks()[0]?.civ),'Celts');
  let recNames=await page.locator('#pickRecs .recName').allTextContents();
  assert.ok(recNames.length>0);
  assert.ok(recNames.every(x=>['Bohemians','Celts'].includes(x)),`global/unranked suggestion leaked: ${recNames.join(', ')}`);
  assert.ok(!recNames.includes('Romans'),'unranked Romans must never appear even if public stats like it');
  assert.match(await page.locator('#mapIntelSubtitle').innerText(),/strategy-only/i);

  // No opponent-threat selection means no generic/global ban list.
  assert.equal(await page.locator('#banRecs .recRow').count(),0);
  assert.match(await page.locator('#banRecs').innerText(),/Select opponent threat categories/i);
  await page.locator('#threatChips .chip[data-id="primary"]').click();
  await page.waitForSelector('#banRecs .recRow');
  const banNames=await page.locator('#banRecs .recName').allTextContents();
  assert.ok(banNames.every(x=>['Bohemians','Celts'].includes(x)),`ban list escaped selected strategy threat: ${banNames.join(', ')}`);

  // Change map: strategy override, not public/global stats, must change the top pick.
  await page.selectOption('#draftMap','Arabia');
  await page.waitForFunction(()=>scoreStrategyPicks()[0]?.civ==='Bohemians',null,{timeout:10000});
  assert.equal(await page.evaluate(()=>scoreStrategyPicks()[0]?.civ),'Bohemians');
  report.browser.strategyScoring='PASS';

  // If strategy rankings are empty, there must be zero pick rows (no global fallback).
  const blankResult=await page.evaluate(()=>{
    const v=draftVersion(),backup=clone(v.categories);v.categories.forEach(c=>{c.civs=[];c.mapCivs={}});renderLive();
    const count=document.querySelectorAll('#pickRecs .recRow').length,text=document.querySelector('#pickRecs').textContent;
    v.categories=backup;renderLive();return{count,text};
  });
  assert.equal(blankResult.count,0,'empty strategy must not fall back to global recommendations');
  report.browser.noGlobalFallback='PASS';

  // Synced statuses must propagate through the shared room to another browser.
  await page.selectOption('#draftMap','Rage Forest');await sleep(1200);
  const ctx2=await browser.newContext({viewport:{width:1280,height:900}});const page2=await ctx2.newPage();const errors2=[];page2.on('pageerror',e=>errors2.push(e.message));
  await page2.goto(BASE+'/?room='+encodeURIComponent(room),{waitUntil:'domcontentloaded',timeout:90000});
  await page2.waitForFunction(()=>document.querySelector('#roomStatus')?.textContent.includes('connected'),null,{timeout:20000});
  await page2.click('.tab[data-tab="live"]');
  await page2.waitForFunction(()=>document.querySelector('#boardGrid .civ[data-civ="Khmer"]')?.textContent.includes('ADMIN BAN'),null,{timeout:15000});
  assert.equal(await page2.evaluate(()=>scoreStrategyPicks()[0]?.civ),'Celts');
  report.browser.sharedAuthoritativeState='PASS';

  // Reload must retain synced source state, not just manual marks.
  await page.reload({waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>document.querySelector('#roomStatus')?.textContent.includes('connected'),null,{timeout:20000});
  await page.click('.tab[data-tab="live"]');
  await page.waitForFunction(()=>document.querySelector('#boardGrid .civ[data-civ="Khmer"]')?.textContent.includes('ADMIN BAN'),null,{timeout:15000});
  report.browser.reloadPersistence='PASS';

  // Real OEoDI sync: verify admin bans plus Host/Guest attribution end-to-end.
  await page.fill('#draftUrl','https://aoe2cm.net/draft/OEoDI');
  await page.selectOption('#ourSide','host');
  await page.click('#syncDraftBtn');
  await page.waitForFunction(()=>document.querySelector('#draftStatus')?.textContent.includes('AoE2CM live'),null,{timeout:60000});
  assert.match(await page.locator('#draftStatus').innerText(),/27 admin bans/);
  assert.match(await page.locator('#draftSourceSummary').innerText(),/27 admin bans · 4 player bans · 12 our picks · 12 their picks/i);
  const adminCiv=choice(admin[0]),hostPick=choice(hostPicks[0]),guestPick=choice(guestPicks[0]),playerBan=choice(hostBans[0]);
  assert.match(await page.locator(`#boardGrid .civ[data-civ="${adminCiv}"]`).innerText(),/ADMIN BAN/);
  assert.match(await page.locator(`#boardGrid .civ[data-civ="${playerBan}"]`).innerText(),/DRAFT BAN/);
  assert.match(await page.locator(`#boardGrid .civ[data-civ="${hostPick}"]`).innerText(),/OUR PICK/);
  assert.match(await page.locator(`#boardGrid .civ[data-civ="${guestPick}"]`).innerText(),/THEIR PICK/);

  // Flip perspective: real draft picks must invert correctly while bans stay bans.
  await page.selectOption('#ourSide','guest');
  await page.waitForFunction(()=>document.querySelector('#draftStatus')?.textContent.includes('AoE2CM live'),null,{timeout:60000});
  await page.waitForFunction((c)=>document.querySelector(`#boardGrid .civ[data-civ="${c}"]`)?.textContent.includes('THEIR PICK'),hostPick,{timeout:15000});
  assert.match(await page.locator(`#boardGrid .civ[data-civ="${hostPick}"]`).innerText(),/THEIR PICK/);
  assert.match(await page.locator(`#boardGrid .civ[data-civ="${guestPick}"]`).innerText(),/OUR PICK/);
  assert.match(await page.locator(`#boardGrid .civ[data-civ="${adminCiv}"]`).innerText(),/ADMIN BAN/);
  report.browser.realAoE2CM='PASS';

  // Whatever remains after a real draft, every recommendation must still be in
  // the pinned strategy; an empty result is valid if all strategy civs are gone.
  recNames=await page.locator('#pickRecs .recName').allTextContents();
  const strategySet=new Set(['Khmer','Bohemians','Celts','Teutons']);
  assert.ok(recNames.every(x=>strategySet.has(x)),`real sync leaked global recommendations: ${recNames.join(', ')}`);

  assert.deepEqual(errors,[],`page errors: ${errors.join('; ')}`);assert.deepEqual(errors2,[],`second-page errors: ${errors2.join('; ')}`);
  report.browser.console='PASS';
  await ctx2.close();await ctx.close();await browser.close();
  console.log('LIVE STRATEGY E2E PASSED');
  console.log(JSON.stringify(report,null,2));
}

main().catch(e=>{console.error('LIVE STRATEGY E2E FAILED');console.error(e?.stack||e);process.exit(1)});
