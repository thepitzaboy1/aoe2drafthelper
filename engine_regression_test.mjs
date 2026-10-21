import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const elements=new Map();
const element=q=>{if(!elements.has(q))elements.set(q,{style:{},value:'',textContent:'',className:'',classList:{add(){},remove(){}},innerHTML:''});return elements.get(q)};
const context=vm.createContext({console,window:{},document:{querySelector:element,querySelectorAll:()=>[]},localStorage:{setItem(){}},setInterval:()=>1,clearInterval(){},setTimeout(){},clearTimeout(){},prompt:()=> 'Test copy',confirm:()=>true});
vm.runInContext(fs.readFileSync('static/app.js','utf8'),context);
vm.runInContext('renderAll=()=>{}; renderLive=()=>{}; function clamp(a,b,x){return Math.max(a,Math.min(b,x))}; function rankScore(civ,cat){const list=liveRankingFor(cat),i=list.indexOf(civ);return i<0?0:list.length===1?100:100-i/(list.length-1)*45}; function statFor(){return null}; function mapProfileScore(){return 50}; function publicStatScore(){return 50}; function optionName(v){return String(v)}',context);
const source=fs.readFileSync('static/strategy-live-fix.js','utf8').split('// Migrate the old implicit')[0];vm.runInContext(source,context);vm.runInContext('renderLive=()=>{}',context);
vm.runInContext(`
currentVersion().categories=[{id:'one',name:'One',civs:['Celts','Britons'],mapCivs:{'Rage Forest':['Britons','Celts']}},{id:'two',name:'Two',civs:['Teutons','Celts'],mapCivs:{}}];
app.draft.selectedMap='Rage Forest';app.draft.needIds=[];
`,context);
assert.equal(vm.runInContext('scoreStrategyPicks()[0].civ',context),'Britons');
vm.runInContext(`$('#ourSide').value='host';parseDraftObject({events:[{actionType:'ban',executingPlayer:'NONE',chosenOptionId:'Britons'},{actionType:'pick',executingPlayer:'HOST',chosenOptionId:'Teutons'}]});`,context);
assert.equal(vm.runInContext("statusOf('Britons')",context),'ban');
assert.equal(vm.runInContext("statusOf('Teutons')",context),'our');
vm.runInContext("cycleStatus('Britons')",context);assert.equal(vm.runInContext("statusOf('Britons')",context),'ban');
vm.runInContext("app.autoStatuses={celts:'ban'};app.autoDraftMeta={eventCount:99};app.draft.syncedStatuses={};app.draft.syncedMeta=null",context);
assert.equal(vm.runInContext("statusOf('Celts')",context),'available');assert.equal(vm.runInContext('syncedMeta()',context),null);
vm.runInContext("newVersion();currentVersion().categories[0].civs.push('Romans')",context);
assert.equal(vm.runInContext("draftVersion().categories[0].civs.includes('Romans')",context),false);
vm.runInContext("draftVersion().categories.forEach(c=>{c.civs=[];c.mapCivs={}})",context);assert.equal(vm.runInContext('scoreStrategyPicks().length',context),0);
console.log('PASS: strategy-only candidates, overlap, admin lock, stale runtime state, version isolation, empty strategy');


