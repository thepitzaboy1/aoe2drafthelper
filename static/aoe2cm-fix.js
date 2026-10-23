// AoE2CM's draft API records completed choices as events with `chosenOptionId`.
// Keep this parser separate so the integration is easy to regression-test when the
// upstream payload shape evolves.
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
      for(const k of ["chosenOptionId","option","civilization","civilisation","civ","choice","selected","selection","draftOption","value","target"]){
        if(v[k]!=null){choice=optionName(v[k]);if(choice)break;}
      }
      if(choice)events.push({action:a.toLowerCase(),choice,actor:inferActor(v)});
    }
    Object.values(v).forEach(walk);
  }
  walk(root);
  const ours=$("#ourSide").value,auto={};
  events.forEach(e=>{
    const key=norm(e.choice);if(!key)return;
    if(/ban|snipe/.test(e.action))auto[key]="ban";
    else auto[key]=(e.actor&&e.actor!==ours)?"opp":"our";
  });
  app.autoStatuses=auto;
  renderLive();
  return events.length;
}

// v3.5 is intentionally loaded after all synchronous live-draft modules so its
// admin-ban parser and lineup optimizer are the final runtime definitions.
window.addEventListener('DOMContentLoaded',()=>{
  if(document.querySelector('script[data-strategy-plan-v35]'))return;
  const s=document.createElement('script');
  s.src='strategy-plan-v35.js?v=3.5.0';
  s.dataset.strategyPlanV35='1';
  s.onerror=()=>console.error('Failed to load strategy plan v3.5');
  document.body.appendChild(s);
});
