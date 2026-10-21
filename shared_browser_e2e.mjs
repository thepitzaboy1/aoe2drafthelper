import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// All mutations target a disposable local instance, never the public library.
const port=18876,base=`http://127.0.0.1:${port}`;
const temp=await mkdtemp(join(tmpdir(),'draft-library-'));
let server,browser,errors=[];
async function start(){
  server=spawn(process.env.PYTHON||'python',['server.py','--no-browser','--host','127.0.0.1','--port',String(port)],{env:{...process.env,DATABASE_URL:'',STRATEGY_DB_PATH:join(temp,'strategies.sqlite3'),REQUIRE_DURABLE_STRATEGIES:'0'}});
  for(let i=0;i<100;i++){
    try{if((await fetch(base+'/api/strategy')).ok)return}catch{}
    if(server.exitCode!==null)throw new Error('Test server exited');
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('Local server not ready');
}
async function stop(){if(server&&server.exitCode===null){const exited=new Promise(r=>server.once('exit',r));server.kill();await exited}}
async function ready(page){await page.waitForFunction(()=>typeof sharedReady==='boolean'&&sharedReady)}
async function saved(page){await page.waitForFunction(()=>!sharedSending&&!sharedPending.length&&!sharedConflict)}
async function add(page,civ){await page.locator(`#poolGrid [data-civ="${civ}"]`).click();await saved(page)}
async function newPage(){const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await ready(page);return page}

try{
  await start();browser=await chromium.launch({headless:true});
  const one=await newPage(),two=await newPage();
  await one.waitForFunction(()=>document.querySelector('#builderStatsSource')?.textContent.includes('Rage Forest 6'));
  await one.locator('#builderStatsRefresh').click();
  await one.waitForFunction(()=>document.querySelectorAll('#poolGrid .builderPoolStats').length===document.querySelectorAll('#poolGrid .poolCard').length);
  await add(one,'Britons');
  await two.locator('#rankedList [data-civ="Britons"]').waitFor();
  console.log('PASS: fresh browser receives server strategy without a room or browser backup');

  // Native version dialogs, server save, and per-visitor editor selection.
  one.once('dialog',d=>d.accept('Tournament v2'));await one.locator('#newVersionBtn').click();await saved(one);
  const version=await one.locator('#versionSelect').inputValue();
  one.once('dialog',d=>d.accept('Shared tournament'));await one.locator('#renameVersionBtn').click();await saved(one);
  one.once('dialog',d=>d.accept('Team notes'));await one.locator('#describeVersionBtn').click();await saved(one);
  await one.locator('#lockVersionBtn').click();await saved(one);assert.equal(await one.locator('#newCatBtn').isDisabled(),true);
  await one.locator('#lockVersionBtn').click();await saved(one);
  one.once('dialog',d=>d.accept('Restored copy'));await one.locator('#restoreVersionBtn').click();await saved(one);
  await one.locator('#versionSelect').selectOption(version);
  await two.waitForFunction(id=>[...document.querySelectorAll('#versionSelect option')].some(o=>o.value===id),version);
  assert.equal(await two.locator('#versionSelect').inputValue(),'shared-v1');
  console.log('PASS: create, rename, notes, restore, lock/unlock; local selection stays independent');

  await two.locator('#versionSelect').selectOption(version);
  await one.locator('#catList [data-id="halbso"]').click();
  // Two editors start from the same revision but edit distinct categories.
  await Promise.all([one.locator('#poolGrid [data-civ="Celts"]').click(),two.locator('#poolGrid [data-civ="Mayans"]').click()]);
  await saved(one);await saved(two);
  await one.locator('#catList [data-id="flank"]').click();
  await one.locator('#rankedList [data-civ="Mayans"]').waitFor();
  await two.locator('#catList [data-id="halbso"]').click();await two.locator('#rankedList [data-civ="Celts"]').waitFor();
  console.log('PASS: simultaneous changes to different categories merge');

  // Draft rooms share the library without sharing each other's picks.
  for(const [page,room] of [[one,'one'],[two,'two']]){await page.locator('#roomId').fill(room);await page.locator('#joinRoom').click();await page.locator('.tab[data-tab="live"]').click();await page.locator('#draftVersionSelect').selectOption(version)}
  await one.locator('#boardGrid [data-civ="Celts"]').click();
  assert.match(await one.locator('#boardGrid [data-civ="Celts"]').innerText(),/OUR PICK/);
  assert.match(await two.locator('#boardGrid [data-civ="Celts"]').innerText(),/AVAILABLE/);
  assert.match(await one.locator('#matrixBody').innerText(),/SECURED/);
  const recs=await one.locator('#pickRecs .recName').allTextContents();
  assert.ok(recs.every(c=>['Britons','Mayans','Celts'].includes(c)));
  await one.locator('#draftMap').selectOption('Arabia');assert.equal(await one.locator('#pickRecs .recRow').count(),0);
  console.log('PASS: draft rooms stay independent; pinned strategy, capability updates and strategy-only candidates');

  await one.locator('.tab[data-tab="builder"]').click();
  await one.locator('#exportBtn').click();const exported=JSON.parse(await one.locator('#ioText').inputValue());await one.locator('#ioClose').click();
  await one.locator('#importBtn').click();await one.locator('#ioText').fill(JSON.stringify(exported));await one.locator('#ioAction').click();await saved(one);
  // Another server process + a completely empty browser profile verifies durable storage.
  await stop();await start();const fresh=await newPage();
  await fresh.locator('#versionSelect').selectOption(version);
  await fresh.locator('#catList [data-id="halbso"]').click();await fresh.locator('#rankedList [data-civ="Celts"]').waitFor();
  assert.match(await fresh.locator('#versionMeta').innerText(),/Team notes/);
  console.log('PASS: exported/imported versions preserved; process restart + fresh browser retain server library');
  assert.deepEqual(errors,[]);console.log('SHARED STRATEGY BROWSER E2E PASSED');
}finally{
  if(browser)await browser.close();await stop();await rm(temp,{recursive:true,force:true});
}
