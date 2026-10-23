// Live draft plan engine v3.5
// - AoE2CM bans are hard availability constraints, including admin/global ban lists.
// - Selected strategy categories define the lineup to fill. With none selected,
//   every ranked category in the pinned strategy is used.
// - One civilization can secure only one planned role at a time.
// - Public/map stats are context only and never create or rank a pick.
window.STRATEGY_PLAN_VERSION="3.5";

(function installStrategyPlanV35(){
  if(typeof app==='undefined'||typeof liveCategories!=='function')return;

  function canonicalLiveCiv(value){
    const s=optionName(value);if(!s)return'';
    return liveCivs().find(c=>norm(c)===norm(s))||'';
  }
  function collectKnownCivs(value,out,seen=new Set(),depth=0){
    if(value==null||depth>6)return;
    if(typeof value==='string'||typeof value==='number'){
      const c=canonicalLiveCiv(value);if(c)out.push(c);return;
    }
    if(Array.isArray(value)){value.forEach(v=>collectKnownCivs(v,out,seen,depth+1));return;}
    if(typeof value!=='object'||seen.has(value))return;seen.add(value);
    const direct=canonicalLiveCiv(value);if(direct){out.push(direct);return;}
    for(const k of ['chosenOptionId','civilization','civilisation','civ','option','choice','selected','selection','value','target']){
      if(value[k]!=null)collectKnownCivs(value[k],out,seen,depth+1);
    }
  }
  function collectExplicitAdminBans(root){
    const out=[],seen=new Set();
    function walk(v,depth=0){
      if(v==null||depth>8||typeof v!=='object'||seen.has(v))return;seen.add(v);
      if(Array.isArray(v)){v.forEach(x=>walk(x,depth+1));return;}
      for(const [k,val] of Object.entries(v)){
        const key=norm(k);
        if(/(admin.*ban|global.*ban|preset.*ban|pre.*ban|auto.*ban|default.*ban)/.test(key))collectKnownCivs(val,out,new Set(),0);
        if(val&&typeof val==='object')walk(val,depth+1);
      }
    }
    walk(root);return uniq(out);
  }

  // Replace the permissive parser. A ban with no Host/Guest owner is treated as
  // an admin/global ban; all bans are applied after picks so a ban can never be
  // overwritten by event traversal order.
  parseDraftObject=function(root,extra={}){
    const events=[],seen=new Set();
    function walk(v){
      if(v==null)return;
      if(Array.isArray(v)){v.forEach(walk);return;}
      if(typeof v!=='object'||seen.has(v))return;seen.add(v);
      const a=v.action??v.type??v.mode??v.kind??v.actionType;
      if(typeof a==='string'&&/(pick|ban|snipe|steal)/i.test(a)){
        let choice='';
        for(const k of ['chosenOptionId','option','civilization','civilisation','civ','choice','selected','selection','draftOption','value','target']){
          if(v[k]!=null){choice=optionName(v[k]);if(choice)break;}
        }
        if(choice){
          let actor=inferDraftActor(v);
          if(/ban|snipe/i.test(a)&&actor!=='host'&&actor!=='guest')actor='admin';
          events.push({action:a.toLowerCase(),choice,actor});
        }
      }
      Object.values(v).forEach(walk);
    }
    walk(root);

    const ours=$('#ourSide')?.value||app.draft.ourSide||'host',auto={},meta=emptyDraftMeta(),bans=[];
    meta.eventCount=events.length;
    // Picks first.
    for(const e of events){
      if(!/pick|steal/.test(e.action))continue;
      const key=norm(e.choice);if(!key)continue;
      if(e.actor!=='host'&&e.actor!=='guest'){meta.unknownPicks.push(e.choice);continue;}
      const st=e.actor===ours?'our':'opp';auto[key]=st;
      if(e.actor==='host')meta.hostPicks.push(e.choice);else meta.guestPicks.push(e.choice);
      if(st==='our')meta.ourPicks.push(e.choice);else meta.oppPicks.push(e.choice);
    }
    // Then authoritative event bans.
    for(const e of events){
      if(!/ban|snipe/.test(e.action))continue;
      const key=norm(e.choice);if(!key)continue;bans.push(e.choice);auto[key]='ban';
      if(e.actor==='host')meta.hostBans.push(e.choice);
      else if(e.actor==='guest')meta.guestBans.push(e.choice);
      else meta.adminBans.push(e.choice);
    }
    // Some AoE2CM payload variants expose admin/global bans as collections rather
    // than completed events. Capture those too and keep them authoritative.
    for(const civ of collectExplicitAdminBans(root)){
      auto[norm(civ)]='ban';meta.adminBans.push(civ);
    }
    for(const k of Object.keys(meta))if(Array.isArray(meta[k]))meta[k]=uniq(meta[k]);
    persistSyncedDraft(auto,meta,{...extra,ourSide:ours});renderLive();return events.length;
  };

  function rankedCats(){return liveCategories().filter(c=>liveRankingFor(c).length>0)}
  function targetCats(){
    const all=rankedCats(),ids=(app.draft.needIds||[]).filter(id=>all.some(c=>c.id===id));
    return ids.length?ids.map(id=>all.find(c=>c.id===id)).filter(Boolean):all;
  }
  function relevantPicks(cats,picks){return (picks||[]).filter(p=>cats.some(c=>liveRankingFor(c).includes(p)))}
  function betterAssignment(a,b){return a.count!==b.count?a.count>b.count:a.quality>b.quality}

  // Maximum-cardinality, maximum-preference matching between picked civs and
  // planned roles. This prevents a flexible civ from satisfying several lineup
  // slots simultaneously.
  assignStrategyRoles=function(cats,picks){
    cats=cats||[];picks=relevantPicks(cats,uniq(picks||[]));
    if(!cats.length||!picks.length)return{count:0,quality:0,pairs:[]};
    const memo=new Map();
    function solve(i,mask){
      if(i>=cats.length)return{count:0,quality:0,pairs:[]};
      const key=i+'|'+mask.toString();if(memo.has(key))return memo.get(key);
      let best=solve(i+1,mask);
      best={count:best.count,quality:best.quality,pairs:[...best.pairs]};
      const cat=cats[i],ranking=liveRankingFor(cat);
      for(let j=0;j<picks.length;j++){
        const bit=1n<<BigInt(j);if(mask&bit)continue;
        const civ=picks[j],ri=ranking.indexOf(civ);if(ri<0)continue;
        const next=solve(i+1,mask|bit),cand={count:next.count+1,quality:next.quality+rankScore(civ,cat),pairs:[{cat,civ,rank:ri+1},...next.pairs]};
        if(betterAssignment(cand,best))best=cand;
      }
      memo.set(key,best);return best;
    }
    return solve(0,0n);
  };

  strategyPlan=function(){
    const catalog=rankedCats(),all=targetCats(),ours=ourDraftPicks(),assignment=assignStrategyRoles(all,ours),secured=new Set(assignment.pairs.map(p=>p.cat.id));
    const open=all.filter(c=>!secured.has(c.id)),selected=(app.draft.needIds||[]).filter(id=>catalog.some(c=>c.id===id));
    return{catalog,all,open,secured,focus:new Set(selected),complete:all.length>0&&open.length===0,ours,assignment,explicit:selected.length>0};
  };

  scoreStrategyPicks=function(){
    const plan=strategyPlan();if(!plan.all.length)return[];
    const cats=plan.complete?plan.all:plan.open;if(!cats.length)return[];
    const rows=[];
    for(const civ of availableCivs()){
      const matching=cats.filter(c=>liveRankingFor(c).includes(civ));if(!matching.length)continue;
      const after=assignStrategyRoles(plan.all,[...plan.ours,civ]),gain=after.count-plan.assignment.count;
      if(!plan.complete&&gain<1)continue;
      const pair=after.pairs.find(p=>norm(p.civ)===norm(civ));
      const role=pair?.cat||matching.slice().sort((a,b)=>rankScore(civ,b)-rankScore(civ,a))[0];
      const base=strategyComponent(civ,cats,plan);if(!base)continue;
      const rolePref=role?rankScore(civ,role):base.teamPref,scarcity=role?strategyScarcity(role):base.scarcity;
      // Strategy-only score. No public/map/global-stat signal enters this value.
      const score=clamp(0,100,rolePref*.72+scarcity*.20+base.flex*.08);
      rows.push({...base,score,teamPref:rolePref,scarcity,coverage:gain>0?100:0,coverageGain:gain,fillsRole:role?.name||'',fillsRank:pair?.rank||((role&&liveRankingFor(role).indexOf(civ)+1)||0),planComplete:plan.complete});
    }
    return rows.sort((a,b)=>b.coverageGain-a.coverageGain||b.score-a.score||b.teamPref-a.teamPref||b.scarcity-a.scarcity);
  };

  strategyReasonText=function(x){
    const bits=[];
    if(x.fillsRole)bits.push(`fills ${x.fillsRole}${x.fillsRank?` #${x.fillsRank}`:''}`);
    else if(x.rankDetails?.length)bits.push(x.rankDetails.map(r=>`${r.name} #${r.rank}`).join(' + '));
    if(x.flexCount>1)bits.push(`also fits ${x.flexCount-1} other planned role${x.flexCount>2?'s':''}`);
    if(x.scarcity>=70)bits.push('scarcity high');
    if(x.planComplete)bits.push('plan already covered · depth pick');
    return bits.join(' · ');
  };

  renderStrategyPlanStatus=function(){
    const el=$('#strategyPlanStatus');if(!el)return;const p=strategyPlan();
    if(!p.catalog.length){el.textContent='No ranked categories in the pinned strategy. Add your civ rankings in Strategy Builder first.';return;}
    const names=p.open.map(c=>c.name).join(', ');
    const mode=p.explicit?'Selected pick plan':'All ranked categories';
    el.textContent=p.complete?`${mode}: ${p.assignment.count}/${p.all.length} distinct roles secured. Further recommendations stay inside this strategy only.`:`${mode}: ${p.assignment.count}/${p.all.length} distinct roles secured · open: ${names||'none'}. One civ counts for one role.`;
  };

  // Keep RF/public stats visible as context, but make the table explicit that the
  // recommendation score is entirely derived from the user's strategy plan.
  const renderMapIntelV34=renderMapIntel;
  renderMapIntel=function(){
    renderMapIntelV34();
    const sub=$('#mapIntelSubtitle');if(sub)sub.textContent=`${app.draft.selectedMap} · picks are ranked only by your planned roles + your civ order. Map/RF stats are context only.`;
  };

  function relabelPlanUI(){
    document.title='AoE2 Draft Assistant v3.5';
    const panel=document.querySelector('.needPanel'),head=panel?.querySelector('b');
    if(head){head.innerHTML='Our pick plan <span class="tiny">(strategy roles)</span>';const help=head.nextElementSibling;if(help?.classList.contains('tiny'))help.textContent='Select the categories you actually want to fill in this draft. With none selected, all ranked categories are used. One picked civ can fill only one planned role.';}
    const pickHead=$('#pickRecs')?.previousElementSibling;if(pickHead)pickHead.textContent='Best next pick · your strategy plan';
  }

  relabelPlanUI();renderAll();
})();
