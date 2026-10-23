import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE=(process.env.TARGET_URL||'https://aoe2-draft-assistant.onrender.com').replace(/\/$/,'');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const CIVS=["Armenians","Aztecs","Bengalis","Berbers","Bohemians","Britons","Bulgarians","Burgundians","Burmese","Byzantines","Celts","Chinese","Cumans","Danes","Dravidians","Ethiopians","Franks","Georgians","Goths","Gurjaras","Hindustanis","Huns","Incas","Italians","Japanese","Jurchens","Khitans","Khmer","Koreans","Lithuanians","Magyars","Malay","Malians","Mapuche","Mayans","Mongols","Muisca","Persians","Poles","Portuguese","Romans","Saracens","Saxons","Shu","Sicilians","Slavs","Spanish","Tatars","Teutons","Tupi","Turks","Varangians","Vietnamese","Vikings","Wei","Wu"];

async function getJson(path){const r=await fetch(BASE+path,{cache:'no-store'});const raw=await r.text();let body;try{body=JSON.parse(raw)}catch{body={raw}}return{status:r.status,body}}
async function waitForDeploy(){
  let last='';
  for(let i=0;i<72;i++){
    try{
      const [a,b]=await Promise.all([fetch(BASE+'/strategy-plan-v35.js?v='+Date.now(),{cache:'no-store'}),fetch(BASE+'/aoe2cm-fix.js?v='+Date.now(),{cache:'no-store'})]);
      const [ta,tb]=await Promise.all([a.text(),b.text()]);
      if(a.status===200&&b.status===200&&ta.includes('STRATEGY_PLAN_VERSION="3.5"')&&tb.includes('strategy-plan-v35.js?v=3.5.0'))return;
      last=`plan=${a.status}/${ta.includes('STRATEGY_PLAN_VERSION="3.5"')} loader=${b.status}/${tb.includes('strategy-plan-v35.js?v=3.5.0')}`;
    }catch(e){last=e.message}
    await sleep(5000);
  }
  throw new Error('v3.5 did not deploy: '+last);
}

async function main(){
  await waitForDeploy();
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(BASE+'/?v35='+Date.now(),{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(()=>window.STRATEGY_PLAN_VERSION==='3.5',null,{timeout:30000});
  await page.click('.tab[data-tab="live"]');await page.waitForSelector('#liveView:not(.hidden)');
  assert.match(await page.title(),/v3\.5/);

  await page.evaluate((CIVS)=>{
    const v={id:'plan-v1',name:'Plan E2E',description:'',createdAt:new Date().toISOString(),parentId:null,locked:false,categories:[
      {id:'primary',name:'Primary',civs:['Khmer','Celts','Bohemians'],mapCivs:{'Rage Forest':['Khmer','Celts','Bohemians']}},
      {id:'secondary',name:'Secondary',civs:['Teutons','Celts'],mapCivs:{'Rage Forest':['Teutons','Celts']}}
    ],civs:CIVS};
    app.strategy={id:'team',name:'Plan E2E',versions:[v],activeVersionId:v.id};
    app.draft={statuses:{},needIds:[],threatIds:[],selectedMap:'Rage Forest',versionId:v.id,strategyEngineVersion:2,ourSide:'host',syncedStatuses:{},syncedMeta:null};
    app.autoStatuses={};app.autoDraftMeta=null;renderAll();
  },CIVS);

  // Admin ban must be authoritative before any strategy scoring.
  await page.evaluate(()=>parseDraftObject({events:[{actionType:'ban',player:'NONE',executingPlayer:'NONE',chosenOptionId:'Khmer'}]}));
  assert.equal(await page.evaluate(()=>statusOf('Khmer')),'ban');
  assert.match(await page.locator('#boardGrid .civ[data-civ="Khmer"]').innerText(),/ADMIN BAN/);
  assert.notEqual(await page.evaluate(()=>scoreStrategyPicks()[0]?.civ),'Khmer');

  // Admin/global ban collections outside events must also be consumed.
  await page.evaluate(()=>parseDraftObject({globalBans:['Khmer'],events:[{actionType:'pick',player:'HOST',executingPlayer:'HOST',chosenOptionId:'Celts'}]}));
  assert.equal(await page.evaluate(()=>statusOf('Khmer')),'ban');
  assert.ok(await page.evaluate(()=>syncedMeta().adminBans.includes('Khmer')));

  // Celts belongs to both roles. It must secure exactly ONE slot, not both.
  const plan=await page.evaluate(()=>{const p=strategyPlan();return{count:p.assignment.count,total:p.all.length,open:p.open.map(c=>c.name),secured:[...p.secured]}});
  assert.equal(plan.count,1,'one civ must secure one role only');assert.equal(plan.total,2);assert.equal(plan.open.length,1);
  assert.match(await page.locator('#strategyPlanStatus').innerText(),/1\/2 distinct roles secured/i);

  // No global fallback: Romans is intentionally unranked. With Khmer banned and
  // Celts already picked, the next pick must fill the remaining strategy role.
  await page.evaluate(()=>{app.stats={map:'Rage Forest',rows:{romans:{civ:'Romans',winRate:100,adjustedWinRate:100,games:9999,scope:'4v4-tournament'}},source:'poisoned test stats',fetchedAt:Date.now(),error:''};renderLive()});
  const names=await page.locator('#pickRecs .recName').allTextContents();
  assert.ok(names.length>0);assert.ok(!names.includes('Romans'),'global/stat civ leaked into strategy recommendations');
  const open=plan.open[0];
  if(open==='Primary')assert.ok(names.every(x=>['Bohemians'].includes(x)),`unexpected Primary recommendation: ${names.join(',')}`);
  if(open==='Secondary')assert.ok(names.every(x=>['Teutons'].includes(x)),`unexpected Secondary recommendation: ${names.join(',')}`);

  // Selected plan categories are exact scope, not merely a soft global weight.
  await page.evaluate(()=>{app.draft.syncedStatuses={};app.draft.syncedMeta=null;app.autoStatuses={};app.draft.needIds=['primary'];app.draft.statuses={};renderLive()});
  const primaryNames=await page.locator('#pickRecs .recName').allTextContents();
  assert.ok(primaryNames.length>0);assert.ok(primaryNames.every(x=>['Khmer','Celts','Bohemians'].includes(x)));assert.ok(!primaryNames.includes('Teutons'));
  assert.match(await page.locator('#strategyPlanStatus').innerText(),/Selected pick plan/i);

  // Explicit empty strategy means no suggestions, never a global fallback.
  const empty=await page.evaluate(()=>{const v=draftVersion(),backup=clone(v.categories);v.categories.forEach(c=>{c.civs=[];c.mapCivs={}});renderLive();const out={count:document.querySelectorAll('#pickRecs .recRow').length,text:document.querySelector('#pickRecs').textContent};v.categories=backup;renderLive();return out});
  assert.equal(empty.count,0);assert.match(empty.text,/No available civ|No ranked|strategy/i);

  // Real AoE2CM regression: sample must still expose admin bans and attribution.
  await page.fill('#draftUrl','https://aoe2cm.net/draft/OEoDI');await page.selectOption('#ourSide','host');await page.click('#syncDraftBtn');
  await page.waitForFunction(()=>/AoE2CM (synced|replay|cached)/.test(document.querySelector('#draftStatus')?.textContent||''),null,{timeout:60000});
  assert.match(await page.locator('#draftStatus').innerText(),/27 admin bans/);
  assert.match(await page.locator('#draftSourceSummary').innerText(),/27 admin bans · 4 player bans · 12 our picks · 12 their picks/i);
  const realNames=await page.locator('#pickRecs .recName').allTextContents();
  assert.ok(realNames.every(x=>['Khmer','Celts','Bohemians'].includes(x)),`real draft escaped selected strategy plan: ${realNames.join(',')}`);

  assert.deepEqual(errors,[],`page errors: ${errors.join('; ')}`);
  console.log('LIVE PLAN V3.5 E2E PASSED');
  console.log(JSON.stringify({adminBan:'PASS',explicitAdminCollection:'PASS',distinctRoleMatching:'PASS',selectedPlanScope:'PASS',noGlobalFallback:'PASS',realAoE2CM:'PASS',realRecommendations:realNames},null,2));
  await browser.close();
}
main().catch(e=>{console.error('LIVE PLAN V3.5 E2E FAILED');console.error(e?.stack||e);process.exit(1)});
