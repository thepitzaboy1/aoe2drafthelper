import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE=(process.env.TARGET_URL||'https://aoe2-draft-assistant.onrender.com').replace(/\/$/,'');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function fetchJson(path, opts={}){
  const r=await fetch(BASE+path,opts);
  let body;
  try{body=await r.json()}catch{body={raw:await r.text()}}
  return {status:r.status,body,headers:r.headers};
}
async function waitForDeploy(){
  let last='';
  for(let i=0;i<36;i++){
    try{
      const {status,body}=await fetchJson('/api/config');
      if(status===200 && Number(body.version)>=3.1) return body;
      last=`status=${status} body=${JSON.stringify(body)}`;
    }catch(e){last=e.message}
    await sleep(5000);
  }
  throw new Error('Render app never became ready: '+last);
}
function optionValueByText(page, selector, text){
  return page.locator(selector+' option').evaluateAll((opts,t)=>opts.find(o=>o.textContent.includes(t))?.value||'',text);
}

async function main(){
  const report={target:BASE,api:{},browser:{},warnings:[]};
  const config=await waitForDeploy();
  report.api.config=config;

  // ---------- HTTP/API contract ----------
  let r=await fetch(BASE+'/');
  assert.equal(r.status,200,'root should return 200');
  const html=await r.text();
  assert.match(html,/AoE2 Draft Assistant v3/i);
  for(const asset of ['/style.css','/light.css','/app.js','/intelligence.js','/live.js']){
    const ar=await fetch(BASE+asset);
    assert.equal(ar.status,200,`${asset} should return 200`);
    assert.ok((await ar.text()).length>100,`${asset} should not be empty`);
  }
  report.api.staticAssets='PASS';

  const rf=await fetchJson('/api/mapstats?map=Rage%20Forest');
  assert.equal(rf.status,200); assert.equal(rf.body.ok,true);
  assert.equal(rf.body.source,'rage-forest-6');
  assert.equal(rf.body.datasetMeta?.matches,127);
  assert.ok(Array.isArray(rf.body.rows) && rf.body.rows.length>=50);
  const bohemians=rf.body.rows.find(x=>x.civ==='Bohemians');
  assert.ok(bohemians,'Bohemians must exist in RF dataset');
  assert.equal(bohemians.games,7);
  assert.equal(bohemians.winRate,71.0);
  assert.equal(bohemians.adjustedWinRate,57.9);
  report.api.rageForest={rows:rf.body.rows.length,matches:rf.body.datasetMeta.matches,source:rf.body.sourceLabel,bohemians};

  const noMap=await fetchJson('/api/mapstats');
  assert.equal(noMap.status,400,'mapstats without a map should reject the request');
  const arabia=await fetchJson('/api/mapstats?map=Arabia');
  assert.equal(arabia.status,200); assert.equal(arabia.body.ok,true); assert.ok(arabia.body.rows.length>=5);
  report.api.arabia={rows:arabia.body.rows.length,source:arabia.body.source};

  const draft=await fetchJson('/api/draft?url='+encodeURIComponent('https://aoe2cm.net/draft/OEoDI'));
  assert.equal(draft.status,200); assert.equal(draft.body.draftId,'OEoDI');
  assert.ok(['draft-api','manual-live-fallback'].includes(draft.body.mode));
  report.api.aoe2cm=draft.body.mode;

  const badDraft=await fetchJson('/api/draft?url='+encodeURIComponent('***'));
  assert.equal(badDraft.status,400);

  // Round-trip shared room state using the actual deployed server.
  const room='e2e-'+Date.now();
  const roomState={rev:1,strategy:{id:'test',name:'Remote E2E',versions:[{id:'remote-v1',name:'Remote v1',description:'',createdAt:new Date().toISOString(),parentId:null,locked:false,categories:[{id:'halbso',name:'Halb + SO',civs:['Bohemians','Celts','Teutons'],mapCivs:{'Rage Forest':['Bohemians','Celts','Teutons']}}],civs:['Bohemians','Celts','Teutons','Mongols','Franks']}],activeVersionId:'remote-v1'},draft:{statuses:{mongols:'our',franks:'opp'},needIds:['halbso'],threatIds:[],selectedMap:'Rage Forest',versionId:'remote-v1'}};
  const post=await fetchJson('/api/room',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({room,data:roomState})});
  assert.equal(post.status,200); assert.equal(post.body.ok,true);
  const get=await fetchJson('/api/room?room='+encodeURIComponent(room));
  assert.equal(get.status,200); assert.equal(get.body.data?.draft?.statuses?.mongols,'our');
  report.api.roomRoundTrip='PASS';

  // ---------- Actual browser/UI ----------
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  const consoleErrors=[]; const pageErrors=[];
  page.on('console',m=>{if(m.type()==='error') consoleErrors.push(m.text())});
  page.on('pageerror',e=>pageErrors.push(e.message));

  await page.goto(BASE+'/',{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForSelector('#builderView:not(.hidden)',{timeout:30000});
  assert.equal(await page.locator('title').textContent(),'AoE2 Draft Assistant v3');

  // Confirm light theme is genuinely light, not just a loaded CSS file.
  const colors=await page.evaluate(()=>({body:getComputedStyle(document.body).backgroundColor,panel:getComputedStyle(document.querySelector('.panel')).backgroundColor,color:getComputedStyle(document.body).color}));
  const rgb=s=>(s.match(/\d+/g)||[]).slice(0,3).map(Number);
  const bodyRgb=rgb(colors.body), panelRgb=rgb(colors.panel);
  assert.ok(panelRgb.reduce((a,b)=>a+b,0)>550,`panel should be light; got ${colors.panel}`);
  report.browser.theme=colors;

  // Rage Forest should be the primary/default builder map.
  assert.equal(await page.locator('#builderMap').inputValue(),'Rage Forest');
  await page.waitForSelector('#builderStatsPanel',{timeout:15000});
  await page.waitForFunction(()=>document.querySelector('#builderStatsSource')?.textContent.includes('Rage Forest 6'),null,{timeout:30000});
  const statsText=await page.locator('#builderStatsPanel').innerText();
  assert.match(statsText,/Rage Forest 6/i);
  assert.match(statsText,/RF adjusted|Adjusted|RF WR|win rate/i);
  report.browser.rfBuilderStats='PASS';

  // Add civs to the current category and ensure RF stats decorate both pool and ranked cards.
  for(const civ of ['Mongols','Teutons']){
    const card=page.locator(`#poolGrid .poolCard[data-civ="${civ}"]`);
    await card.click();
    await page.waitForSelector(`#rankedList .rankCard[data-civ="${civ}"]`);
  }
  const mongolRankText=await page.locator('#rankedList .rankCard[data-civ="Mongols"]').innerText();
  assert.match(mongolRankText,/%|fit|RF/i);

  // New category, ranked civs, and drag reorder.
  page.once('dialog',d=>d.accept('CI Halb + SO'));
  await page.click('#newCatBtn');
  assert.equal((await page.locator('#activeCatTitle').textContent()).trim(),'CI Halb + SO');
  for(const civ of ['Bohemians','Celts','Teutons']) await page.locator(`#poolGrid .poolCard[data-civ="${civ}"]`).click();
  await page.locator('#rankedList .rankCard[data-civ="Celts"]').dragTo(page.locator('#rankedList .rankCard[data-civ="Bohemians"]'));
  const firstRanked=(await page.locator('#rankedList .rankCard').first().getAttribute('data-civ'));
  assert.equal(firstRanked,'Celts','drag reorder should persist in current ranking');
  report.browser.categoryAndDrag='PASS';

  // Versioning flow.
  page.once('dialog',d=>d.accept('CI v2'));
  await page.click('#newVersionBtn');
  assert.match(await page.locator('#versionSelect').innerText(),/CI v2/);
  await page.click('#lockVersionBtn');
  assert.equal(await page.locator('#newCatBtn').isDisabled(),true,'locked strategy should disable category edits');
  await page.click('#lockVersionBtn');
  assert.equal(await page.locator('#newCatBtn').isDisabled(),false);
  report.browser.versioning='PASS';

  // Shared room: browser 1 joins and browser 2 independently receives state.
  await page.fill('#roomId',room);
  await page.click('#joinRoom');
  await page.waitForFunction(()=>document.querySelector('#roomStatus')?.textContent.includes('connected'),null,{timeout:15000});
  const context2=await browser.newContext({viewport:{width:1280,height:900}});
  const page2=await context2.newPage();
  const secondErrors=[]; page2.on('pageerror',e=>secondErrors.push(e.message));
  await page2.goto(BASE+'/?room='+encodeURIComponent(room),{waitUntil:'domcontentloaded',timeout:90000});
  await page2.waitForFunction(()=>document.querySelector('#roomStatus')?.textContent.includes('connected'),null,{timeout:15000});
  await page2.waitForFunction(()=>document.querySelector('#strategyName')?.value==='Remote E2E',null,{timeout:15000});
  report.browser.multiClientRoom='PASS';

  // Use the room-seeded deterministic strategy for live-draft checks on browser 2.
  await page2.click('.tab[data-tab="live"]');
  await page2.waitForSelector('#liveView:not(.hidden)');
  assert.equal(await page2.locator('#draftMap').inputValue(),'Rage Forest');
  await page2.waitForFunction(()=>document.querySelector('#statsStatus')?.textContent.includes('53 civ'),null,{timeout:30000});
  const sourceText=await page2.locator('#statsSource').innerText();
  assert.match(sourceText,/Rage Forest 6/i);

  // Recommendation list should use the RF-specific category ranking.
  const picksText=await page2.locator('#pickRecs').innerText();
  assert.match(picksText,/Bohemians|Celts|Teutons/);

  // Draft-board cycling: available -> our -> opp -> ban -> available.
  const celts=page2.locator('#boardGrid .civ[data-civ="Celts"]');
  await celts.click(); assert.match(await celts.innerText(),/OUR PICK/);
  await celts.click(); assert.match(await celts.innerText(),/THEIR PICK/);
  await celts.click(); assert.match(await celts.innerText(),/BANNED/);
  await celts.click(); assert.match(await celts.innerText(),/AVAILABLE/);

  // Create a scarcity condition: ban 2 of the 3 top choices.
  for(const civ of ['Bohemians','Celts']){
    const card=page2.locator(`#boardGrid .civ[data-civ="${civ}"]`);
    // 3 clicks from available => ban
    await card.click(); await card.click(); await card.click();
  }
  await page2.waitForTimeout(250);
  assert.match(await page2.locator('#scarcityPanel').innerText(),/at risk|Secure soon/i);
  assert.match(await page2.locator('#scarcityPanel').innerText(),/Teutons/i);
  report.browser.scarcity='PASS';

  // Secure the need with Teutons and verify capability matrix.
  await page2.locator('#boardGrid .civ[data-civ="Teutons"]').click();
  await page2.waitForTimeout(250);
  const matrix=await page2.locator('#matrixBody').innerText();
  assert.match(matrix,/Halb \+ SO/);
  assert.match(matrix,/SECURED/);
  assert.match(matrix,/Teutons/);
  report.browser.capabilityMatrix='PASS';

  // AoE2CM live sync button should complete, whether direct API or documented manual fallback.
  await page2.fill('#draftUrl','https://aoe2cm.net/draft/OEoDI');
  await page2.click('#syncDraftBtn');
  await page2.waitForFunction(()=>{const t=document.querySelector('#draftStatus')?.textContent||'';return !t.includes('Syncing') && (t.includes('synced')||t.includes('fallback')||t.includes('unavailable'));},null,{timeout:45000});
  report.browser.aoe2cmStatus=await page2.locator('#draftStatus').innerText();

  // Reload persistence while joined to a room.
  await page2.reload({waitUntil:'domcontentloaded',timeout:90000});
  await page2.waitForFunction(()=>document.querySelector('#roomStatus')?.textContent.includes('connected'),null,{timeout:15000});
  assert.equal(await page2.locator('#strategyName').inputValue(),'Remote E2E');
  report.browser.reloadPersistence='PASS';

  // Responsive sanity check on a phone-size viewport.
  const mobileCtx=await browser.newContext({viewport:{width:390,height:844},isMobile:true});
  const mobile=await mobileCtx.newPage();
  const mobileErrors=[]; mobile.on('pageerror',e=>mobileErrors.push(e.message));
  await mobile.goto(BASE+'/',{waitUntil:'domcontentloaded',timeout:90000});
  await mobile.waitForSelector('#builderView:not(.hidden)');
  const overflow=await mobile.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:window.innerWidth}));
  assert.ok(overflow.scroll<=overflow.width+6,`mobile page has horizontal overflow: ${JSON.stringify(overflow)}`);
  report.browser.mobile={...overflow,status:'PASS'};

  assert.deepEqual(pageErrors,[],`desktop page errors: ${pageErrors.join('; ')}`);
  assert.deepEqual(secondErrors,[],`second client page errors: ${secondErrors.join('; ')}`);
  assert.deepEqual(mobileErrors,[],`mobile page errors: ${mobileErrors.join('; ')}`);
  // Console errors can include upstream/network noise; retain them in the report instead of failing automatically.
  report.browser.consoleErrors=consoleErrors;

  await mobileCtx.close(); await context2.close(); await context.close(); await browser.close();
  console.log('DEPLOYED E2E PASSED');
  console.log(JSON.stringify(report,null,2));
}

main().catch(e=>{console.error('DEPLOYED E2E FAILED');console.error(e?.stack||e);process.exit(1)});
