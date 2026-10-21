// Strategy-first live draft engine.
// v3.2: AoE2CM is authoritative for bans/picks; pick recommendations come only
// from the pinned team strategy (including its selected-map overrides).
window.STRATEGY_LIVE_FIX_VERSION="3.2";

app.autoDraftMeta=app.autoDraftMeta||null;

function emptyDraftMeta(){return{eventCount:0,adminBans:[],hostBans:[],guestBans:[],otherBans:[],hostPicks:[],guestPicks:[],ourPicks:[],oppPicks:[],unknownPicks:[]}}
function uniq(xs){return[...new Set((xs||[]).filter(Boolean))]}
function syncedStatuses(){return app.draft?.syncedStatuses||{}}
function syncedMeta(){return app.autoDraftMeta||app.draft?.syncedMeta||null}

// AoE2CM is authoritative whenever it knows a civ's state. Manual marks are a
// fallback for drafts that are not synced and can never accidentally un-ban an
// admin-banned civilization.
function statusOf(civ){const key=norm(civ);return app.autoStatuses[key]||syncedStatuses()[key]||app.draft.statuses[key]||"available"}

function inferDraftActor(o){
  for(const k of["executingPlayer","player","actor","participant","side","team","user","owner","drafter"]){
    if(!o||o[k]==null)continue;
    const raw=typeof o[k]==="object"?(o[k].name??o[k].id??o[k].value??JSON.stringify(o[k])):o[k];
    const s=String(raw).trim().toLowerCase();
    if(!s)continue;
    if(s.includes("host"))return"host";
    if(s.includes("guest"))return"guest";
    if(s==="none"||s==="admin"||s.includes("administrator")||s.includes("global"))return"admin";
  }
  return"";
}

function persistSyncedDraft(auto,meta,extra={}){
  const previous=JSON.stringify({s:app.draft.syncedStatuses||{},m:app.draft.syncedMeta||null,u:app.draft.draftUrl||"",side:app.draft.ourSide||"host"});
  app.autoStatuses={...auto};
  app.autoDraftMeta=meta;
  app.draft.syncedStatuses={...auto};
  app.draft.syncedMeta=clone(meta);
  Object.assign(app.draft,extra);
  const next=JSON.stringify({s:app.draft.syncedStatuses,m:app.draft.syncedMeta,u:app.draft.draftUrl||"",side:app.draft.ourSide||"host"});
  saveLocal();
  if(previous!==next&&app.room&&typeof pushRoom==="function")pushRoom();
}

function parseDraftObject(root){
  const events=[],seen=new Set();
  function walk(v){
    if(v==null)return;
    if(Array.isArray(v)){v.forEach(walk);return;}
    if(typeof v!=="object"||seen.has(v))return;
    seen.add(v);
    const a=v.action??v.type??v.mode??v.kind??v.actionType;
    if(typeof a==="string"&&/(pick|ban|snipe|steal)/i.test(a)){
      let choice="";
      for(const k of["chosenOptionId","option","civilization","civilisation","civ","choice","selected","selection","draftOption","value","target"]){
        if(v[k]!=null){choice=optionName(v[k]);if(choice)break;}
      }
      if(choice)events.push({action:a.toLowerCase(),choice,actor:inferDraftActor(v)});
    }
    Object.values(v).forEach(walk);
  }
  walk(root);

  const ours=$("#ourSide")?.value||app.draft.ourSide||"host",auto={},meta=emptyDraftMeta();
  meta.eventCount=events.length;
  for(const e of events){
    const key=norm(e.choice);if(!key)continue;
    if(/ban|snipe/.test(e.action)){
      auto[key]="ban";
      if(e.actor==="admin")meta.adminBans.push(e.choice);
      else if(e.actor==="host")meta.hostBans.push(e.choice);
      else if(e.actor==="guest")meta.guestBans.push(e.choice);
      else meta.otherBans.push(e.choice);
      continue;
    }
    if(e.actor!=="host"&&e.actor!=="guest"){
      meta.unknownPicks.push(e.choice);
      continue;
    }
    const st=e.actor===ours?"our":"opp";
    auto[key]=st;
    if(e.actor==="host")meta.hostPicks.push(e.choice);else meta.guestPicks.push(e.choice);
    if(st==="our")meta.ourPicks.push(e.choice);else meta.oppPicks.push(e.choice);
  }
  for(const k of Object.keys(meta))if(Array.isArray(meta[k]))meta[k]=uniq(meta[k]);
  persistSyncedDraft(auto,meta,{ourSide:ours});
  renderLive();
  return events.length;
}

function draftSummaryText(meta=syncedMeta()){
  if(!meta||!meta.eventCount)return"No AoE2CM state synced yet.";
  const playerBans=(meta.hostBans?.length||0)+(meta.guestBans?.length||0)+(meta.otherBans?.length||0);
  return `${meta.adminBans?.length||0} admin bans · ${playerBans} player bans · ${meta.ourPicks?.length||0} our picks · ${meta.oppPicks?.length||0} their picks`;
}
function renderDraftSourceSummary(){
  const el=$("#draftSourceSummary");if(!el)return;
  const meta=syncedMeta();
  if(!meta||!meta.eventCount){el.innerHTML='<b>AoE2CM state:</b> not synced. Manual board marks are active.';return;}
  const names=(meta.adminBans||[]).slice(0,14),more=(meta.adminBans?.length||0)-names.length;
  el.innerHTML=`<b>AoE2CM state:</b> ${esc(draftSummaryText(meta))}${names.length?`<span class="draftSummaryBans">Admin banned: ${esc(names.join(", "))}${more>0?` +${more} more`:""}</span>`:""}`;
}

async function syncDraft(silent=false){
  const url=$("#draftUrl").value.trim();
  if(!url)return toast("Enter an AoE2CM draft URL.");
  const ours=$("#ourSide").value||"host";
  if(!silent){$("#draftDot").className="dot warn";$("#draftStatus").textContent="Syncing AoE2CM…";}
  try{
    const j=await(await fetch('/api/draft?url='+encodeURIComponent(url),{cache:'no-store'})).json();
    if(j.ok){
      const n=parseDraftObject(j.data);
      app.draft.draftUrl=url;app.draft.syncedDraftId=j.draftId||"";app.draft.ourSide=ours;saveLocal();
      const meta=syncedMeta()||emptyDraftMeta();
      $("#draftDot").className="dot ok";
      $("#draftStatus").textContent=`AoE2CM live · ${n} actions · ${meta.adminBans.length} admin bans`;
      const h=j.data?.nameHost||j.data?.host?.name||'',g=j.data?.nameGuest||j.data?.guest?.name||'';
      if(h||g)$("#players").textContent=`Host: ${typeof h==='object'?h.name||'':h} · Guest: ${typeof g==='object'?g.name||'':g}`;
      clearInterval(app.draftTimer);
      app.draftTimer=setInterval(()=>{if(app.tab==="live")syncDraft(true)},5000);
      renderLive();
      return;
    }
    const same=url===(app.draft.draftUrl||"");
    if(!same){app.autoStatuses={};app.autoDraftMeta=null;app.draft.syncedStatuses={};app.draft.syncedMeta=null;app.draft.draftUrl=url;saveLocal();}
    renderLive();
    $("#draftDot").className="dot warn";
    $("#draftStatus").textContent=(j.ongoing?"AoE2CM API unavailable · keeping manual board":"Draft actions unavailable · manual board fallback")+(same&&Object.keys(syncedStatuses()).length?" · last synced state retained":"");
    if(j.recent)$("#players").textContent=`Host: ${j.recent.nameHost||'?'} · Guest: ${j.recent.nameGuest||'?'}`;
  }catch(e){
    $("#draftDot").className="dot bad";
    $("#draftStatus").textContent=Object.keys(syncedStatuses()).length?"Live sync retry failed · last synced state retained":"Draft sync failed · manual mode";
  }
}

function rankedStrategyCategories(){return liveCategories().filter(c=>liveRankingFor(c).length>0)}
function ourDraftPicks(){return liveCivs().filter(c=>statusOf(c)==="our")}
function strategyPlan(){
  const all=rankedStrategyCategories(),ours=ourDraftPicks(),focus=new Set((app.draft.needIds||[]).filter(id=>all.some(c=>c.id===id)));
  const secured=new Set(all.filter(cat=>ours.some(c=>liveRankingFor(cat).includes(c))).map(c=>c.id));
  let open=all.filter(c=>!secured.has(c.id));
  const complete=open.length===0&&all.length>0;
  if(complete)open=all;
  return{all,open,secured,focus,complete};
}
function planCategoryWeight(cat,plan){return plan.focus.has(cat.id)?1.55:1}
function strategyScarcity(cat){
  const top=liveRankingFor(cat).slice(0,5),left=top.filter(c=>statusOf(c)==="available").length;
  return left<=1?100:left===2?88:left===3?70:left===4?48:28;
}
function strategyComponent(civ,cats,plan=strategyPlan()){
  const matches=cats.filter(c=>liveRankingFor(c).includes(civ));if(!matches.length)return null;
  let rankSum=0,rankWeight=0,matchedWeight=0,totalWeight=0;
  for(const cat of cats){const w=planCategoryWeight(cat,plan);totalWeight+=w;if(matches.includes(cat)){rankSum+=rankScore(civ,cat)*w;rankWeight+=w;matchedWeight+=w;}}
  const teamPref=rankWeight?rankSum/rankWeight:0,coverage=totalWeight?100*matchedWeight/totalWeight:0;
  const scarcity=Math.max(...matches.map(strategyScarcity));
  const flexCount=matches.length,flex=clamp(20,100,25+flexCount*25);
  const score=clamp(0,100,teamPref*.62+coverage*.18+scarcity*.15+flex*.05);
  const row=statFor(civ),pScore=mapProfileScore(civ),sScore=publicStatScore(civ),hasStats=!!row,isRF=row?.scope==="4v4-tournament"||app.draft.selectedMap==="Rage Forest";
  const mapSignal=hasStats?(isRF?sScore*.85+pScore*.15:sScore*.7+pScore*.3):pScore;
  const mapOverride=matches.some(c=>Array.isArray(c.mapCivs?.[app.draft.selectedMap]));
  return{civ,score,teamPref,coverage,flex,scarcity,mapSignal,denial:0,matches:matches.map(c=>c.name),matchIds:matches.map(c=>c.id),flexCount,stat:row,confidence:mapOverride?"Strategy map override":"Strategy ranking",rankDetails:matches.map(c=>({name:c.name,rank:liveRankingFor(c).indexOf(civ)+1})),priority:matches.some(c=>plan.focus.has(c.id))};
}
function scoreStrategyPicks(){
  const plan=strategyPlan();if(!plan.all.length)return[];
  let cats=plan.open;
  let rows=availableCivs().map(c=>strategyComponent(c,cats,plan)).filter(Boolean);
  // If every open category is exhausted, stay strategy-only and look at any
  // remaining civ from the pinned strategy rather than falling back globally.
  if(!rows.length&&cats.length!==plan.all.length){cats=plan.all;rows=availableCivs().map(c=>strategyComponent(c,cats,plan)).filter(Boolean);}
  return rows.sort((a,b)=>b.score-a.score||b.teamPref-a.teamPref||b.scarcity-a.scarcity);
}
function scoreStrategyBans(){
  const ids=(app.draft.threatIds||[]),cats=ids.map(liveCategoryById).filter(c=>c&&liveRankingFor(c).length);if(!cats.length)return[];
  const plan={...strategyPlan(),focus:new Set(ids)};
  return availableCivs().map(c=>strategyComponent(c,cats,plan)).filter(Boolean).sort((a,b)=>b.score-a.score||b.teamPref-a.teamPref);
}
function strategyReasonText(x){
  const ranks=x.rankDetails.map(r=>`${r.name} #${r.rank}`).join(" + "),bits=[ranks];
  if(x.priority)bits.push("priority category");
  if(x.flexCount>1)bits.push(`covers ${x.flexCount} open strategy roles`);
  if(x.scarcity>=70)bits.push("scarcity high");
  return bits.filter(Boolean).join(" · ");
}
function strategyRecHtml(items,emptyText){
  if(!items.length)return `<div class="muted tiny" style="padding:12px 2px">${esc(emptyText)}</div>`;
  return items.slice(0,7).map((x,i)=>{const s=Math.round(x.score),cls=s>=80?"green":s>=65?"amber":"";return `<div class="recRow" data-rec-civ="${esc(x.civ)}"><div class="recRank">${i+1}</div><div><div class="recName">${esc(x.civ)}</div><div class="recWhy">${esc(strategyReasonText(x))}</div></div><div class="recScore ${cls}">${s}</div></div>`}).join("");
}
function renderStrategyPlanStatus(){
  const el=$("#strategyPlanStatus");if(!el)return;const p=strategyPlan();
  if(!p.all.length){el.textContent="No ranked categories in this strategy. Add civ rankings in Strategy Builder first.";return;}
  const open=p.all.filter(c=>!p.secured.has(c.id));
  el.textContent=p.complete?`Strategy coverage complete: ${p.all.length}/${p.all.length} ranked categories covered. Recommendations stay inside the strategy for depth.`:`Auto plan: ${open.length} open / ${p.all.length} ranked categories · ${p.secured.size} already covered by our picks${p.focus.size?` · ${p.focus.size} priority`:""}.`;
}
function renderRecs(){
  const picks=scoreStrategyPicks(),bans=scoreStrategyBans();
  const flex=[...picks].filter(x=>x.flexCount>1).sort((a,b)=>b.flexCount-a.flexCount||b.score-a.score);
  $("#pickRecs").innerHTML=strategyRecHtml(picks,"No available civ remains in the pinned strategy. Update the strategy or verify the synced draft state.");
  $("#banRecs").innerHTML=strategyRecHtml(bans,"Select opponent threat categories to get strategy-based ban recommendations.");
  $("#flexRecs").innerHTML=strategyRecHtml(flex,"No multi-role strategy pick is currently available.");
  renderStrategyPlanStatus();
}
function renderScarcity(){
  const p=strategyPlan(),alerts=[];
  for(const cat of p.all){
    if(p.secured.has(cat.id))continue;
    const top5=liveRankingFor(cat).slice(0,5),left=top5.filter(c=>statusOf(c)==="available"),best=liveRankingFor(cat).find(c=>statusOf(c)==="available");
    const priority=p.focus.has(cat.id)?"Priority ":"";
    if(left.length<=2)alerts.push({level:"danger",text:`${priority}${cat.name} at risk: only ${left.length}/${Math.min(5,top5.length||5)} preferred options remain${best?`. Best strategy option: ${best}.`:"."}`});
    else if(left.length===3)alerts.push({level:"warn",text:`${priority}${cat.name}: 3 top options remain. Best strategy option: ${best||"none"}.`});
  }
  const el=$("#scarcityPanel");
  if(!alerts.length){el.innerHTML=`<span class="tiny">${p.complete?"All ranked strategy categories are covered by our picks.":"No urgent strategy-category scarcity detected."}</span>`;el.classList.remove("hot");return;}
  el.classList.add("hot");el.innerHTML=alerts.map(a=>`<div class="draftAlert ${a.level}"><b>${a.level==='danger'?'⚠ Secure soon':'Watch'}</b><span>${esc(a.text)}</span></div>`).join("");
}
function renderMapIntel(){
  const rows=scoreStrategyPicks().slice(0,12),p=profileForMap();
  $("#mapIntelSubtitle").textContent=`${app.draft.selectedMap} · recommendation score is strategy-only. Public/RF stats below are context and do not choose the pick.`;
  const source=$("#statsSource");source.textContent=app.stats?.source?`Context only: ${app.stats.source} · ${app.stats.fetchedAt?new Date(app.stats.fetchedAt).toLocaleString():""}`:"No public stats loaded · strategy-only ranking";
  $("#intelBody").innerHTML=rows.map(x=>`<tr><td><b>${esc(x.civ)}</b></td><td><b>${Math.round(x.score)}</b></td><td>${Math.round(x.teamPref)}</td><td title="Context only; excluded from recommendation score">${Math.round(x.mapSignal)}</td><td>${Math.round(x.coverage)}</td><td>${Math.round(x.flex)}</td><td>${Math.round(x.scarcity)}</td><td>${esc(x.confidence)}</td></tr>`).join("")||'<tr><td colspan="8" class="muted">No available strategy-ranked civilization. The engine does not fall back to global suggestions.</td></tr>';
}

function syncedBanKind(civ){const m=syncedMeta();if(!m)return"";const k=norm(civ);if((m.adminBans||[]).some(x=>norm(x)===k))return"ADMIN BAN";if([...(m.hostBans||[]),...(m.guestBans||[]),...(m.otherBans||[])].some(x=>norm(x)===k))return"DRAFT BAN";return""}
function renderBoard(){
  const q=norm($("#boardSearch").value),f=$("#boardFilter").value,list=liveCivs().filter(civ=>{const st=statusOf(civ);return(!q||norm(civ).includes(q))&&(f==="all"||st===f)}),badge={available:"AVAILABLE",our:"OUR PICK",opp:"THEIR PICK",ban:"BANNED"};
  $("#boardGrid").innerHTML=list.map(civ=>{const st=statusOf(civ),cats=civCategoryNames(civ),b=st==="ban"?(syncedBanKind(civ)||badge[st]):badge[st];return `<div class="civ ${st}" data-civ="${esc(civ)}"><div class="civName">${esc(civ)}</div><div class="civCats">${cats.length?esc(cats.join(" · ")):"Uncategorized"}</div><div class="stateBadge">${b}</div></div>`}).join("");
  $$("#boardGrid .civ").forEach(el=>el.onclick=()=>cycleStatus(el.dataset.civ));
}
function cycleStatus(civ){
  const key=norm(civ);if(app.autoStatuses[key]||syncedStatuses()[key])return toast("This state comes from AoE2CM and is authoritative.");
  const seq=["available","our","opp","ban"],cur=app.draft.statuses[key]||"available";app.draft.statuses[key]=seq[(seq.indexOf(cur)+1)%seq.length];changed();
}
function clearDraft(){
  if(!confirm("Clear manual draft marks? Synced AoE2CM bans and picks will remain."))return;
  app.draft.statuses={};changed();
}
function renderLive(){
  renderVersionControls();renderMapSelectors();
  if(app.draft.draftUrl&&document.activeElement!==$("#draftUrl"))$("#draftUrl").value=app.draft.draftUrl;
  if(app.draft.ourSide)$("#ourSide").value=app.draft.ourSide;
  renderChips();renderDraftSourceSummary();renderRecs();renderScarcity();renderMapIntel();renderMatrix();renderBoard();
}

// Migrate the old implicit "Flank" default into the new automatic strategy
// plan. Existing non-default selections remain useful as priority categories.
if(!app.draft.strategyEngineVersion){
  if((app.draft.needIds||[]).length===1&&app.draft.needIds[0]==="flank")app.draft.needIds=[];
  app.draft.strategyEngineVersion=2;
  app.draft.ourSide=app.draft.ourSide||$("#ourSide")?.value||"host";
  saveLocal();
}
if(app.draft.syncedStatuses&&!Object.keys(app.autoStatuses||{}).length)app.autoStatuses={...app.draft.syncedStatuses};
if(app.draft.syncedMeta&&!app.autoDraftMeta)app.autoDraftMeta=clone(app.draft.syncedMeta);
$("#syncDraftBtn").onclick=()=>syncDraft(false);
$("#ourSide").onchange=()=>{app.draft.ourSide=$("#ourSide").value;syncDraft(false)};
$("#clearDraftBtn").onclick=clearDraft;
renderAll();
