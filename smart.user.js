// ==UserScript==
// @name         Black Ledger OC Smart Role Targets
// @namespace    https://www.torn.com/
// @version      3.1.25
// @description  OC role guidance and opt-out CPR sharing on OC pages, plus personal OC flight protection on the travel page.
// @author       Bendigeidfran
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/organizedcrimes.php*
// @match        https://www.torn.com/page.php?sid=travel*
// @match        https://torn.com/page.php?sid=travel*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      shcecvzxdknpulytekcl.supabase.co
// @connect      tornprobability.com
// @license      MIT
// @noframes
// @downloadURL https://update.greasyfork.org/scripts/596802/Black%20Ledger%20OC%20Smart%20Role%20Targets.user.js
// @updateURL https://update.greasyfork.org/scripts/596802/Black%20Ledger%20OC%20Smart%20Role%20Targets.meta.js
// ==/UserScript==

(function () {
  "use strict";

  // OC travel protection. Reference behaviour: Zonure's Travel Blocker (MIT),
  // https://greasyfork.org/scripts/543904. Uses Torn's read-only travel model.
  function travelGuardModel(raw) {
    if(raw?.success===false || raw?.redirect || raw?.bh_redirect)return null;
    const model=raw && Array.isArray(raw.countries)?raw:raw?.data;
    if(!model || !Array.isArray(model.countries) || !Array.isArray(model.flights) || !Object.prototype.hasOwnProperty.call(model,'ocTime'))return null;
    if(model.ocTime!==null && model.ocTime!==0 && (typeof model.ocTime!=='number' || !Number.isFinite(model.ocTime) || model.ocTime<1000000000))return null;
    return {ocTime:model.ocTime,countries:model.countries,flights:model.flights};
  }

  function travelGuardDecision(model,selection,now) {
    if(!model)return {kind:'unknown',block:true,message:'OC timing is unavailable. Departure is blocked while protection is on. Refresh the check, or check your OC before turning protection off.'};
    if(model.ocTime===null || model.ocTime===0)return {kind:'none',block:false,message:'Torn reports no active OC timer. No OC timing block is applied.'};
    const left=model.ocTime-now;
    if(left<=0)return {kind:'blocked',block:true,message:'Your OC is ready or overdue. Stay in Torn and check your OC before flying.'};
    if(!selection?.countryId || !selection?.flightId)return {kind:'selection',block:true,message:'Choose a destination and flight type to check your return against the OC start.'};
    const countries=model.countries.filter(c=>c && String(c.id)===selection.countryId);
    const country=countries.length===1?countries[0]:null;
    const flights=Array.isArray(country?.flights)?country.flights.filter(f=>f && String(f.id)===selection.flightId):[];
    const flight=flights.length===1?flights[0]:null;
    const duration=flight?.duration;
    if(typeof duration!=='number' || !Number.isFinite(duration) || duration<=0 || duration>7*86400 || !model.flights.some(f=>f && String(f.id)===selection.flightId))return {kind:'unknown',block:true,message:'The selected flight time could not be verified. Departure is blocked while protection is on. Refresh the check; no default flight time has been assumed.'};
    const roundTrip=duration*2;
    const format=seconds=>{const minutes=Math.floor(Math.max(0,seconds)/60);return minutes>=60?Math.floor(minutes/60)+'h '+minutes%60+'m':minutes+'m';};
    const block=left<=roundTrip,warning=!block && left<=86400;
    return {kind:block?'blocked':warning?'warning':'clear',block,warning,flightSeconds:duration,roundTripSeconds:roundTrip,ocSeconds:left,
      message:(block?'Flight blocked: ':'OC travel warning: ')+String(country.name || 'Selected destination')+' · OC starts in '+format(left)+'. Outbound flight '+format(duration)+'; return flight '+format(duration)+'. '+(block?'You cannot complete the round trip before your OC starts.':'That leaves less than '+format(left-roundTrip)+' abroad before you must return.')+' Assumes the same flight type and an immediate return; time spent abroad is extra.'};
  }

  function travelGuardSelection(root) {
    const country=root.querySelector('input[name="destination"]:checked');
    const flight=root.querySelector('input[name="travelType"]:checked');
    return {countryId:country?.value || null,flightId:flight?.value || null};
  }

  function travelGuardDepartureButton(target,root) {
    const button=target?.closest?.('button,a');
    if(!button || !root.contains(button))return null;
    if(/^Travel to /i.test(button.getAttribute('aria-label') || ''))return button;
    if(String(button.textContent || '').trim()!=='Continue')return null;
    const panel=button.closest('[class*="confirmPanel"]');
    const question=panel?.querySelector('[class*="question"]');
    return question && /Are you sure you want to travel to\b/i.test(question.textContent || '')?button:null;
  }

  function travelGuardMarkButton(button,blocked,statusId) {
    const attribute='data-bl-oc-flight-blocked';
    if(blocked){
      if(!button.hasAttribute(attribute)){
        button.setAttribute('data-bl-oc-flight-aria',button.getAttribute('aria-disabled') ?? '');
        button.setAttribute(attribute,'true');
      }
      if(button.getAttribute('aria-disabled')!=='true')button.setAttribute('aria-disabled','true');
      const descriptions=(button.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      if(!descriptions.includes(statusId)){descriptions.push(statusId);button.setAttribute('aria-describedby',descriptions.join(' '));}
    }else if(button.hasAttribute(attribute)){
      const original=button.getAttribute('data-bl-oc-flight-aria');
      if(button.getAttribute('aria-disabled')==='true'){
        if(original)button.setAttribute('aria-disabled',original);else button.removeAttribute('aria-disabled');
      }
      const descriptions=(button.getAttribute('aria-describedby') || '').split(/\s+/).filter(x=>x && x!==statusId);
      if(descriptions.length)button.setAttribute('aria-describedby',descriptions.join(' '));else button.removeAttribute('aria-describedby');
      button.removeAttribute(attribute);button.removeAttribute('data-bl-oc-flight-aria');
    }
    // Native disabled state and text belong to Torn/other scripts; never change them.
  }

  function startOCTravelGuard() {
    const id='black-ledger-oc-travel-guard',statusId=id+'-status';
    let model=null,modelAt=0,attemptAt=0,owner='',settings={enabled:true},busy=false,error='',stopped=false,controller=null,interval=null,observer=null,scheduled=false,acknowledged='';
    const marked=new Set();
    function preferenceKey(){return 'black-ledger-oc-travel-guard-v1:'+owner;}
    function loadSettings(){
      settings={enabled:true};
      try{const saved=typeof GM_getValue==='function'?GM_getValue(preferenceKey(),null):null;
        if(saved && typeof saved.enabled==='boolean')settings={enabled:saved.enabled};
      }catch(_){}
    }
    function saveSettings(){try{if(typeof GM_setValue==='function')GM_setValue(preferenceKey(),{...settings});}catch(_){error='Settings could not be saved; they apply only while this page stays open.';}}
    function inTorn(){return document.body?.dataset.abroad==='false' && document.body?.dataset.traveling==='false';}
    function installStyle(){
      if(document.getElementById(id+'-style'))return;
      const style=document.createElement('style');style.id=id+'-style';style.textContent=`
        #${id}{display:table!important;width:auto!important;max-width:100%!important;box-sizing:border-box;background:#182b37!important;color:#e8f4fc!important;-webkit-text-fill-color:#e8f4fc!important;border:1px solid #72caff!important;border-radius:5px;padding:0 8px;margin:4px 0;font:13px/1.5 Arial,sans-serif!important;overflow-wrap:anywhere}
        #${id} strong,#${id} label,#${id} p,#${id} span{color:#e8f4fc!important;-webkit-text-fill-color:#e8f4fc!important;text-shadow:none!important}
        #${id} .bl-travel-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-top:0}
        #${id} label{background:transparent!important;border:0!important;display:flex;align-items:center;gap:8px;min-height:44px;margin:0!important;font:13px/1.4 Arial,sans-serif!important}
        #${id} input,#${id} button{box-sizing:border-box;color:#fff!important;-webkit-text-fill-color:#fff!important;background:#245679!important;border:1px solid #72caff!important;border-radius:5px!important;min-height:44px!important;padding:8px!important;font:13px/1.4 Arial,sans-serif!important;opacity:1!important;text-shadow:none!important}
        #${id} input[type=checkbox]{appearance:auto!important;-webkit-appearance:checkbox!important;accent-color:#72caff;width:22px!important;height:22px!important;min-height:22px!important;margin:0!important}
        #${id} input[type=number]{width:75px!important;max-width:100%!important}
        #${id} button{cursor:pointer!important;white-space:normal!important}
        #${id} button:hover:not(:disabled){background:#326e96!important}
        #${id} input:focus-visible,#${id} button:focus-visible{outline:2px solid #ffe39c!important;outline-offset:2px!important}
        #${id} button:disabled{color:#bed0db!important;-webkit-text-fill-color:#bed0db!important;background:#263c49!important;border-color:#607c8d!important;cursor:default!important}
        #${id}[data-state=blocked],#${id}[data-state=unknown]{border-color:#ffa98e!important;background:#40282a!important}
        #${id} p[hidden]{display:none!important}
        #${id}[data-state=warning]{border-color:#ffe39c!important}
        #${id} p{margin:8px 0 0!important}
        #travel-root [data-bl-oc-flight-blocked=true]{color:#fbe8e8!important;-webkit-text-fill-color:#fbe8e8!important;background:#693338!important;border:1px solid #ffa98e!important;opacity:1!important;cursor:not-allowed!important;text-shadow:none!important}
        #travel-root [data-bl-oc-flight-blocked=true]:focus-visible{outline:2px solid #ffe39c!important;outline-offset:2px!important}
      `;document.head.appendChild(style);
    }
    function mount(root){
      installStyle();let panel=document.getElementById(id);
      if(panel && !root.contains(panel)){panel.remove();panel=null;}
      if(panel)return panel;
      panel=document.createElement('section');panel.id=id;panel.setAttribute('aria-label','OC travel protection');
      const controls=document.createElement('div');controls.className='bl-travel-controls';
      const toggleLabel=document.createElement('label'),toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=settings.enabled;toggle.setAttribute('aria-label','OC travel protection enabled');toggleLabel.append(toggle,document.createTextNode('OC travel block'));controls.appendChild(toggleLabel);
      toggle.onchange=()=>{settings.enabled=toggle.checked;saveSettings();tick();};
      panel.appendChild(controls);const status=document.createElement('p');status.id=statusId;status.setAttribute('role','status');status.setAttribute('aria-live','polite');panel.appendChild(status);
      root.prepend(panel);return panel;
    }
    async function refreshModel(force=false){
      if(stopped || busy || !inTorn() || document.visibilityState==='hidden' || (!force && Date.now()-attemptAt<30000))return;
      attemptAt=Date.now();
      const viewer=blViewer(),page=typeof unsafeWindow!=='undefined'?unsafeWindow:window;
      if(typeof page.fetch!=='function' || typeof page.addRFC!=='function'){model=null;modelAt=0;error='Torn travel connection is not ready. Reload the travel page.';tick();return;}
      busy=true;error='';controller=new AbortController();const current=controller,timer=setTimeout(()=>current.abort(),10000);
      tick();
      try{
        const url=new URL(page.addRFC('/page.php?sid=travelData&step=travelAgency'),location.origin);
        if(url.origin!==location.origin || url.pathname!=='/page.php')throw Error('Unexpected travel response address.');
        const response=await page.fetch(url.href,{credentials:'same-origin',cache:'no-store',headers:{'X-Requested-With':'XMLHttpRequest'},signal:current.signal});
        if(!response.ok)throw Error('Torn did not return travel timing.');
        const parsed=travelGuardModel(await response.json());if(!parsed)throw Error('Torn travel timing is unreadable.');
        if(stopped || viewer!==blViewer() || current!==controller)return;
        model=parsed;modelAt=Date.now();
      }catch(_){if(!stopped && viewer===blViewer() && current===controller){model=null;modelAt=0;error='Could not refresh Torn travel timing.';}}
      finally{clearTimeout(timer);if(current===controller){busy=false;controller=null;}if(!stopped)tick();}
    }
    function decision(root){
      if(!settings.enabled)return {kind:'off',block:false,message:'OC travel protection is off. Departure timing is not being checked.'};
      if(!inTorn())return {kind:'inactive',block:false,message:'Outbound protection applies while you are in Torn. Return-home travel is not blocked.'};
      const fresh=model && Date.now()-modelAt>=0 && Date.now()-modelAt<=60000;
      const result=travelGuardDecision(fresh?model:null,travelGuardSelection(root),Date.now()/1000);
      if(!fresh && busy)result.message='Checking Torn OC and flight timing. Departure is paused until the check finishes.';
      if(error)result.message+=' '+error;
      return result;
    }
    function tick(){
      if(stopped || !document.body)return;
      const viewer=blViewer();if(viewer!==owner){owner=viewer;model=null;modelAt=0;loadSettings();controller?.abort();}
      const root=document.getElementById('travel-root');if(!root)return;
      const panel=mount(root),result=decision(root),status=panel.querySelector('#'+statusId);
      if(panel.dataset.state!==result.kind)panel.dataset.state=result.kind;
      const show=result.warning || (result.block && result.kind!=='selection');
      if(status.hidden===show)status.hidden=!show;
      if(show && status.textContent!==result.message)status.textContent=result.message;
      const toggle=panel.querySelector('input[type=checkbox]');if(toggle.checked!==settings.enabled)toggle.checked=settings.enabled;
      for(const button of root.querySelectorAll('button,a'))if(travelGuardDepartureButton(button,root)){
        travelGuardMarkButton(button,result.block,statusId);if(result.block)marked.add(button);else marked.delete(button);
      }
      for(const button of marked)if(!root.contains(button) || !travelGuardDepartureButton(button,root)){travelGuardMarkButton(button,false,statusId);marked.delete(button);}
    }
    function gate(event){
      const root=document.getElementById('travel-root');if(!root || !travelGuardDepartureButton(event.target,root))return;
      if(!settings.enabled || !inTorn())return;
      const result=decision(root);tick();
      if(!result.block && result.warning){
        const selection=travelGuardSelection(root),key=JSON.stringify([model?.ocTime,selection.countryId,selection.flightId]);
        if(acknowledged!==key){
          if(!window.confirm(result.message+'\n\nContinue with this flight?')){event.preventDefault();event.stopImmediatePropagation();return;}
          acknowledged=key;
        }
      }
      if(result.block){event.preventDefault();event.stopImmediatePropagation();if(!model || Date.now()-modelAt>30000)refreshModel(true);}
    }
    function schedule(){if(!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;tick();});}}
    function start(){
      if(stopped)return;owner=blViewer();loadSettings();tick();refreshModel(true);
      observer=new MutationObserver(schedule);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['checked','aria-checked','data-abroad','data-traveling']});
      document.addEventListener('change',event=>{if(!event.target.closest?.('#'+id))schedule();},true);
      window.addEventListener('click',gate,true);
      window.addEventListener('keydown',event=>{if(event.key==='Enter' || event.key===' ')gate(event);},true);
      window.addEventListener('focus',()=>{tick();refreshModel(true);});
      document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){tick();refreshModel(true);}});
      interval=setInterval(()=>{tick();refreshModel();},1000);
    }
    window.addEventListener('pagehide',()=>{stopped=true;clearInterval(interval);observer?.disconnect();controller?.abort();for(const button of marked)travelGuardMarkButton(button,false,statusId);marked.clear();});
    window.addEventListener('pageshow',event=>{if(event.persisted && stopped){stopped=false;modelAt=0;attemptAt=0;observer?.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['checked','aria-checked','data-abroad','data-traveling']});interval=setInterval(()=>{tick();refreshModel();},1000);tick();refreshModel(true);}});
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  }

  if(location.pathname==='/page.php' && new URL(location.href).searchParams.get('sid')==='travel'){
    startOCTravelGuard();
    return;
  }
  if(location.pathname==='/page.php')return;


function blViewer() {
    try { return String(JSON.parse(document.getElementById('torn-user')?.value || 'null')?.id || ''); }
    catch (_) { return ''; }
  }

function blRoster() {
    try {
      const raw=localStorage.getItem('black-ledger-verified-roster-v1');
      if (!raw) return null;
      const r=JSON.parse(raw);
      if (r.version!==1 || r.ready!==true || r.viewerId!==blViewer() ||
          !/^[1-9]\d*$/.test(r.factionId) || !Array.isArray(r.memberIds) || !r.memberIds.length ||
          r.memberIds.some(id=>typeof id!=='string' || !/^[1-9]\d*$/.test(id)) ||
          new Set(r.memberIds).size!==r.memberIds.length || !r.memberIds.includes(r.viewerId) ||
          !Number.isFinite(r.checkedAt) || r.checkedAt>Date.now()+60000) return false;
      return r;
    } catch (_) { return false; }
  }

function blAllowed(id) {
    const r=blRoster();
    return r===null ? true : !!r && r.memberIds.includes(String(id));
  }

function blRequireRoster() {
    const r=blRoster();
    if (!r || Date.now()-r.checkedAt>15*60000)
      throw new Error('Verify faction members first: Manager > Roster Planner > Torn API > Scan via API (within 15 minutes).');
    return r;
  }

function blFilterMap(value, r) {
    const out={};
    for (const [key,row] of Object.entries(value || {})) {
      const id=String(row?.user_id || key.split('|')[0]);
      if (r.memberIds.includes(id)) out[key]=row;
    }
    return out;
  }

function blFilterStore(key,value, roster) {
    const r=roster===undefined?blRoster():roster;
    if (r===null || !value || typeof value!=='object') return value;
    const scope=r || {memberIds:[]};
    if (['hf-cached-local-oc-data','black-ledger-cpr-member-names-v1','black-ledger-cpr-last-seen-v1',
      'black-ledger-cpr-latest-observations-v1','black-ledger-cpr-sync-queue-v1','black-ledger-cpr-sync-fingerprints-v1'].includes(key))
      return blFilterMap(value,scope);
    if (key==='black-ledger-oc-manager-meta-v2') return {...value,names:blFilterMap(value.names,scope),seen:blFilterMap(value.seen,scope)};
    if (key==='black-ledger-oc-pm-history-v1') return {...value,members:blFilterMap(value.members,scope)};
    if (key==='black-ledger-active-roster-v1') return {...value,member_ids:scope.memberIds.slice(),member_count:scope.memberIds.length};
    if (key==='black-ledger-oc-newsletter-draft-v1') {
      if (!Array.isArray(value.recipients) || value.recipients.some(x=>!scope.memberIds.includes(String(x.id)))) return null;
      return value;
    }
    if (key==='black-ledger-oc-pm-queue-v1') {
      if (!Array.isArray(value.items)) return null;
      const items=value.items.filter(x=>scope.memberIds.includes(String(x.id)));
      const activeId=items.some(x=>String(x.id)===String(value.activeId))?value.activeId:null;
      return {...value,items,activeId,workflowActive:!!activeId && !!value.workflowActive};
    }
    return value;
  }

function blForWrite(key,value) {
    if(blRoster()===false)throw new Error('Membership scope is not verified for this account. Storage left unchanged.');
    return blFilterStore(key,value);
  }

function blCleanLocal(r, reset) {
    const keys=['hf-cached-local-oc-data','black-ledger-cpr-member-names-v1','black-ledger-cpr-last-seen-v1',
      'black-ledger-cpr-latest-observations-v1','black-ledger-cpr-sync-queue-v1','black-ledger-cpr-sync-fingerprints-v1',
      'black-ledger-oc-manager-meta-v2','black-ledger-active-roster-v1','black-ledger-oc-pm-history-v1',
      'black-ledger-oc-newsletter-draft-v1','black-ledger-oc-pm-queue-v1','black-ledger-cpr-sync-last-result-v1'];
    for (const key of keys) {
      const raw=localStorage.getItem(key); if (!raw) continue;
      if (reset || key==='black-ledger-cpr-sync-last-result-v1') { localStorage.removeItem(key); continue; }
      let value;
      try { value=JSON.parse(raw); } catch (_) { localStorage.removeItem(key); continue; }
      const clean=blFilterStore(key,value,r);
      if (clean===null) localStorage.removeItem(key);
      else if (JSON.stringify(clean)!==raw) localStorage.setItem(key,JSON.stringify(clean));
    }
  }

  /*
   * Black Ledger OC Smart Role Targets
   *
   * Adds OC role guidance and optional faction CPR sharing. Sharing defaults to
   * ON, can be disabled from the CPR settings menu, and never uploads a Torn
   * API key or password.
   */

  /*
CREDITS AND DATA SOURCES

Role-weight data: TornProbability
https://tornprobability.com/
https://tornprobability.com:3000/api/GetRoleWeights

Acknowledgement: JohnNash, author of Torn OC Weights Under Roles,
for the role-weight display inspiration and shared API approach.
https://greasyfork.org/en/scripts/547973-torn-oc-weights-under-roles

Black Ledger fetches JSON weights directly from TornProbability; it does
not load or execute the other userscript. The built-in weights are a
fallback snapshot of that same data source.

Compatibility: reads OC Track CPR's existing local storage format.

These acknowledgements do not claim ownership of third-party data or
imply permission to redistribute third-party code. The MIT metadata
must not be taken as relicensing third-party materials.
*/

  // Same live data source used by Torn OC Weights Under Roles.
  const WEIGHTS_URL = "https://tornprobability.com:3000/api/GetRoleWeights";

  const WEIGHTS_CACHE_KEY = "oc_smart_targets_weights_cache_v2";

  // Shared management policy: the published offset is read-only in member scripts.
  const FACTION_TARGET_URL = 'https://shcecvzxdknpulytekcl.supabase.co/functions/v1/black-ledger-target-policy';
  const FACTION_TARGET_CACHE = 'black-ledger-faction-target-policy-v1';
  const FACTION_TARGET_ID = 50888;
  let factionTargetBusy = false, factionTargetAttempt = 0, factionTargetError = '';
  let factionTargetMemory = null, factionTargetTemporary = false, factionTargetRetry = null, factionTargetReceipt = 0;
  function factionTargetNativeStorage() {
    return typeof PDA_storage !== 'undefined' ? PDA_storage : window.PDA_storage;
  }
  async function loadFactionTargetNativeCache() {
    try {
      const storage = factionTargetNativeStorage();
      if (!storage?.get) return;
      const policy = await storage.get(FACTION_TARGET_CACHE, null);
      const current = cachedFactionTargetPolicy();
      if (validFactionTargetPolicy(policy) && (!current || policy.revision > current.revision)) {
        factionTargetMemory = policy;
        factionTargetTemporary = false;
        broadcastFactionTargetPolicy(policy);
        factionTargetPolicyUIChanged();
      }
    } catch (_) {}
  }
  function validFactionTargetPolicy(policy) {
    return policy?.schema_version === 1 && policy.faction_id === FACTION_TARGET_ID &&
      Number.isInteger(policy.offset) && policy.offset >= -10 && policy.offset <= 10 &&
      Number.isInteger(policy.revision) && policy.revision > 0 &&
      Number.isFinite(Date.parse(policy.updated_at));
  }
  function cachedFactionTargetPolicy() {
    const candidates = [factionTargetMemory];
    try { candidates.push(JSON.parse(localStorage.getItem(FACTION_TARGET_CACHE) || 'null')); } catch (_) {}
    try { if (typeof GM_getValue === 'function') candidates.push(GM_getValue(FACTION_TARGET_CACHE, null)); } catch (_) {}
    return candidates.filter(validFactionTargetPolicy).sort((a,b)=>b.revision-a.revision)[0] || null;
  }
  function factionTargetOffset() { return cachedFactionTargetPolicy()?.offset ?? 0; }
  function broadcastFactionTargetPolicy(policy) {
    try {
      window.dispatchEvent(new CustomEvent('black-ledger-faction-target-policy-updated', {detail:JSON.stringify(policy)}));
    } catch (_) { window.dispatchEvent(new Event('black-ledger-faction-target-policy-updated')); }
  }
  function acceptFactionTargetPolicy(policy, broadcast = true) {
    if (!validFactionTargetPolicy(policy)) throw new Error('Invalid faction target policy. Previous setting retained.');
    const old = cachedFactionTargetPolicy();
    if (old && old.revision > policy.revision) return;
    if (old && old.revision === policy.revision && old.offset !== policy.offset)
      throw new Error('Conflicting target policy. Previous setting retained.');
    factionTargetMemory = policy;
    factionTargetReceipt++;
    let persisted = false;
    try { if (typeof GM_setValue === 'function') { GM_setValue(FACTION_TARGET_CACHE, policy); persisted = validFactionTargetPolicy(GM_getValue(FACTION_TARGET_CACHE, null)); } } catch (_) {}
    try { localStorage.setItem(FACTION_TARGET_CACHE, JSON.stringify(policy)); persisted = true; } catch (_) {}
    factionTargetTemporary = !persisted;
    try {
      const storage = factionTargetNativeStorage();
      if (storage?.set) Promise.resolve(storage.set(FACTION_TARGET_CACHE, policy)).then(() => {
        if (factionTargetMemory?.revision === policy.revision) {
          factionTargetTemporary = false;
          factionTargetPolicyUIChanged();
        }
      }).catch(() => {});
    } catch (_) {}
    if (broadcast) broadcastFactionTargetPolicy(policy);
  }
  async function factionTargetRequest(method = 'GET', body, token = '') {
    const headers = {Accept:'application/json'};
    if (token) headers['x-black-ledger-dashboard-token'] = token;
    if (body) headers['Content-Type'] = 'application/json';
    const attempt = start => new Promise((resolve,reject) => {
      let settled = false, abort;
      const finish = (error,response) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { reject(error); return; }
        // Older mobile bridges can serialise the whole HTTP envelope.
        if (typeof response === 'string') {
          try { response = JSON.parse(response); } catch (_) {}
        }
        const snapshot = {};
        for (const key of ['status','responseText','response','body']) {
          try { if (response?.[key] !== undefined) snapshot[key] = response[key]; } catch (_) {}
        }
        resolve(snapshot);
      };
      const timer = setTimeout(()=>{finish(new Error('Connection timed out'));try{abort?.();}catch(_){}},20000);
      try { abort = start(response=>finish(null,response),error=>finish(error || new Error('Connection failed'))); }
      catch(error) { finish(error); }
    });
    const methods = [];
    const failures = [];
    const add = (name, start) => methods.push({name, run:()=>attempt(start)});
    const nativeGet = typeof PDA_httpGet === 'function' ? PDA_httpGet : window.PDA_httpGet;
    const nativePut = typeof PDA_httpPut === 'function' ? PDA_httpPut : window.PDA_httpPut;
    const native = method === 'GET' ? nativeGet : nativePut;
    if (typeof native === 'function') add('PDA helper',(ok,fail)=>{
      Promise.resolve(native(FACTION_TARGET_URL,headers,...(body ? [JSON.stringify(body)] : []))).then(ok,fail);
    });
    // Call the documented native handler if a helper is absent or returns no HTTP envelope.
    // Resolve bridge availability at call time; mobile document-start injection can precede it.
    if (window.flutter_inappwebview || window.__PDA_platformReadyPromise) add('PDA bridge',(ok,fail)=>{
      (async()=>{
        if (window.__PDA_platformReadyPromise) await window.__PDA_platformReadyPromise;
        const bridge = window.flutter_inappwebview;
        if (typeof bridge?.callHandler !== 'function') throw new Error('PDA bridge unavailable');
        return bridge.callHandler(method === 'GET' ? 'PDA_httpGet' : 'PDA_httpPut',
          FACTION_TARGET_URL,headers,...(body ? [JSON.stringify(body)] : []));
      })().then(ok,fail);
    });
    if (typeof GM_xmlhttpRequest === 'function') add('Userscript',(ok,fail)=>{
      const handle = GM_xmlhttpRequest({method,url:FACTION_TARGET_URL,headers,data:body ? JSON.stringify(body) : undefined,timeout:19000,onload:ok,onerror:fail,ontimeout:()=>fail(new Error('Connection timed out')),onabort:fail});
      if (handle && typeof handle.then === 'function') handle.then(response=>{if(response?.status !== undefined || typeof response === 'string')ok(response);},fail);
      return ()=>handle?.abort?.();
    });
    if (typeof fetch === 'function') add('Browser',(ok,fail)=>{
      const controller = new AbortController();
      fetch(FACTION_TARGET_URL,{method,headers,body:body ? JSON.stringify(body) : undefined,signal:controller.signal,credentials:'omit',cache:'no-store',mode:'cors'})
        .then(async response=>ok({status:response.status,responseText:await response.text()})).catch(fail);
      return ()=>controller.abort();
    });
    for (const transport of methods) {
      let response;
      try { response = await transport.run(); } catch (error) { failures.push(`${transport.name}: ${error?.message === 'Connection timed out' ? 'timeout' : 'connection error'}`); continue; }
      const status = Number(response?.status);
      if (status === 409) throw new Error('Another manager changed targets. Refresh and retry.');
      if ([401,403].includes(status)) throw new Error('This access code is not authorised to publish targets.');
      if (status !== 200) { failures.push(`${transport.name}: ${Number.isFinite(status) && status > 0 ? `HTTP ${status}` : 'no response status'}`); continue; }
      for (const raw of [response.responseText,response.response,response.body]) {
        try {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (data?.ok && validFactionTargetPolicy(data.policy)) return data.policy;
        } catch (_) {}
      }
      failures.push(`${transport.name}: invalid response`);
    }
    throw new Error(`Target policy download failed (${[...new Set(failures)].join(', ') || 'no connection available'}). Previous setting retained; refresh targets to retry.`);
  }
  async function refreshFactionTargetPolicy(force = false) {
    if (document.visibilityState === 'hidden' || factionTargetBusy || (!force && Date.now()-factionTargetAttempt < (factionTargetError ? 30000 : 300000))) return;
    factionTargetBusy = true; factionTargetAttempt = Date.now();
    const receipt = factionTargetReceipt;
    try { acceptFactionTargetPolicy(await factionTargetRequest()); factionTargetError = ''; }
    catch (error) { if (receipt === factionTargetReceipt) factionTargetError = error.message; }
    finally {
      factionTargetBusy = false;
      clearTimeout(factionTargetRetry);
      factionTargetRetry = factionTargetError ? setTimeout(()=>refreshFactionTargetPolicy(),30000) : null;
      factionTargetPolicyUIChanged();
    }
  }
  function factionTargetStatus() {
    const policy = cachedFactionTargetPolicy();
    const value = factionTargetOffset();
    return `Faction targets ${value >= 0 ? '+' : ''}${value} · ${policy ? 'set by management' : 'default; awaiting first download'}${factionTargetTemporary ? ' · active for this session; device storage unavailable' : ''}${factionTargetError ? ' · '+factionTargetError : ''}`;
  }
  function startFactionTargetPolicy() {
    window.addEventListener('black-ledger-faction-target-policy-updated',event=>{
      if (typeof event.detail === 'string') {
        try {
          const policy = JSON.parse(event.detail);
          const current = cachedFactionTargetPolicy();
          if (validFactionTargetPolicy(policy) && (!current || policy.revision >= current.revision)) {
            // Each PDA script has its own native storage; explicitly carry public policy data.
            if (factionTargetMemory?.revision !== policy.revision || factionTargetMemory?.offset !== policy.offset)
              acceptFactionTargetPolicy(policy,false);
            factionTargetError = '';
          }
        } catch (_) {}
      }
      factionTargetPolicyUIChanged();
    });
    window.addEventListener('black-ledger-faction-target-policy-request',()=>{
      const policy = cachedFactionTargetPolicy();
      if (policy) broadcastFactionTargetPolicy(policy);
    });
    window.dispatchEvent(new Event('black-ledger-faction-target-policy-request'));
    loadFactionTargetNativeCache();
    refreshFactionTargetPolicy();
    setInterval(refreshFactionTargetPolicy, 300000);
    window.addEventListener('focus',()=>refreshFactionTargetPolicy());
    document.addEventListener('pointerdown',()=>{if ((!cachedFactionTargetPolicy() || factionTargetError) && Date.now()-factionTargetAttempt > 15000) refreshFactionTargetPolicy(true);}, {passive:true});
    document.addEventListener('visibilitychange',()=>refreshFactionTargetPolicy());
    window.addEventListener('storage',event=>{if(event.key === FACTION_TARGET_CACHE) factionTargetPolicyUIChanged();});
    window.addEventListener('flutterInAppWebViewPlatformReady',()=>refreshFactionTargetPolicy(true));
  }


  const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  const REQUEST_TIMEOUT_MS = 8000;

  const STYLE_ID = "oc-smart-targets-style";

  const BOX_CLASS = "oc-smart-target-box";

  const LEVEL_CLASS = "oc-smart-level-badge";

  const PASS_CLASS = "oc-smart-target-pass";

  const FAIL_CLASS = "oc-smart-target-fail";

  const UNKNOWN_CLASS = "oc-smart-target-unknown";

  /*

============================================================

EXISTING CPR STORAGE



These remain compatible with OC Track CPR.

============================================================
*/

  const CPR_DATA_KEY = "hf-cached-local-oc-data";

  const CPR_LEVEL_KEY = "hf-oc-level-data";

  const CPR_RELOAD_MS = 5000;

  const CPR_QUALIFY = 67;

  /*

============================================================

LOCAL CPR METADATA

============================================================
*/

  const CPR_NAMES_KEY = "black-ledger-cpr-member-names-v1";

  const CPR_SEEN_KEY = "black-ledger-cpr-last-seen-v1";

  const SYNC_QUEUE_KEY = "black-ledger-cpr-sync-queue-v1";

  const SYNC_DEVICE_KEY = "black-ledger-cpr-device-id-v1";

  const SYNC_LAST_RESULT_KEY = "black-ledger-cpr-sync-last-result-v1";

  /* Legacy keys are retained only so an upgrade never deletes existing local data. */
  const SYNC_RECOVERY_MARKER_KEY = "black-ledger-cpr-sync-recovery-v2.8.4";

  /*

Shares observations with the existing Black Ledger ingestion endpoint.
*/

  const BLACK_LEDGER_SYNC_ENDPOINT =
    "https://shcecvzxdknpulytekcl.supabase.co/functions/v1/black-ledger-sync";

  const SYNC_BATCH_SIZE = 100;

  const SYNC_MAX_QUEUE = 5000;

  /*

If the same exact CPR has already been observed,

refresh its timestamp at most every 6 hours.



This keeps faction data fresh later without hammering

the shared database every time somebody reloads Torn.
*/

  const SYNC_REFRESH_MS = 6 * 60 * 60 * 1000;

  /* Roster settings are legacy-only and are not invoked by this public build. */
  const ROSTER_KEY_STORAGE = "black-ledger-tornstats-roster-key-v1";

  const ROSTER_SNAPSHOT_KEY = "black-ledger-active-roster-v1";

  const ROSTER_LAST_RESULT_KEY = "black-ledger-roster-last-result-v1";

  const ROSTER_REFRESH_MS = 6 * 60 * 60 * 1000;

  const TORNSTATS_ROSTER_URL = () => "";

  const SYNC_FLUSH_INTERVAL_MS = 60 * 1000;

  const DIFFICULTY_TIERS = {
    1: "introductory",
    2: "simple",
    3: "intermediate",
    4: "advanced",
    5: "elaborate",
  };

  const SETTINGS_ID = "oc-smart-target-settings";

  const SETTINGS_MENU_CLASS = "oc-smart-settings-menu";

  const SETTINGS_BUTTON_CLASS = "oc-smart-settings-button";

  const SELECTORS = {
    ocRoot: 'div[class^="wrapper___"][data-oc-id],' + 'div[class*=" wrapper___"][data-oc-id]',

    panelTitle: '[class^="panelTitle___"],' + '[class*=" panelTitle___"]',

    roleCards:
      '[class^="contentLayer___"] > [class^="wrapper___"] > [class^="wrapper___"],' +
      '[class*=" contentLayer___"] > [class^="wrapper___"] > [class^="wrapper___"]',

    roleTitle: '[class^="title___"],' + '[class*=" title___"]',

    successChance: '[class^="successChance___"],' + '[class*=" successChance___"]',
  };

  /*

============================================================

OC LEVELS

============================================================
*/

  const OC_LEVELS = {
    "First Aid and Abet": 1,
    "Mob Mentality": 1,
    "Pet Project": 1,

    "Thou Shalt Not Steal": 2,
    "Cash Me If You Can": 2,
    "Best of the Lot": 2,

    "Smoke and Wing Mirrors": 3,
    "Market Forces": 3,
    "Gaslight the Way": 3,

    "Snow Blind": 4,
    "Plucking the Lotus Petal": 4,
    "Stage Fright": 4,

    "Guardian Angels": 5,
    "Honey Trap": 5,
    "Counter Offer": 5,
    "No Reserve": 5,

    "Bidding War": 6,
    "Leave No Trace": 6,
    "Dish It Out": 6,
    "Sneaky Git Grab": 6,

    "Blast From The Past": 7,
    "Window of Opportunity": 7,
    "Cleared for Takeoff": 7,

    "Break the Bank": 8,
    "Clinical Precision": 8,
    "Stacking the Deck": 8,
    "Lock Stock": 8,
    "Manifest Cruelty": 8,

    "Ace in the Hole": 9,
    "Gone Fission": 9,
    "Hostile Takeover": 9,

    "Crane Reaction": 10,
  };

  const TARGET_OVERRIDES = {};

  /*

============================================================

ROLE WEIGHTS

============================================================
*/

  // Snapshot of the shared weights API, refreshed 2 October 2026.
  const FALLBACK_WEIGHTS = {
    "Mob Mentality": {
      Looter1: 33.96650646,
      Looter2: 26.48850715,
      Looter3: 18.36444021,
      Looter4: 21.18054618,
    },
    "Pet Project": {
      Kidnapper: 30.92676727,
      Muscle: 32.62884615,
      Picklock: 36.44438658,
    },
    "First Aid and Abet": {
      Picklock: 26.040303247907904,
      Decoy: 30.73072727408889,
      Pickpocket: 43.228969478003215,
    },
    "Cash Me If You Can": {
      Thief1: 54.18134868,
      Thief2: 28.04221236,
      Lookout: 17.77643896,
    },
    "Best of the Lot": {
      Picklock: 20.73368395,
      CarThief: 19.5328795,
      Muscle: 43.67657367,
      Imitator: 16.05686289,
    },
    "Market Forces": {
      Enforcer: 29.4020952,
      Negotiator: 27.22899702,
      Lookout: 16.36647471,
      Arsonist: 4.456390991,
      Muscle: 22.54604208,
    },
    "Smoke and Wing Mirrors": {
      CarThief: 50.89511253,
      Imitator: 27.10752487,
      Hustler1: 9.000400474,
      Hustler2: 12.99696212,
    },
    "Gaslight the Way": {
      Imitator1: 9.394999578,
      Imitator2: 27.46467248,
      Imitator3: 41.32194207,
      Looter1: 9.394999578,
      Looter2: 0,
      Looter3: 12.42374256,
    },
    "Stage Fright": {
      Enforcer: 15.67090339,
      Muscle1: 20.01365691,
      Muscle2: 2.659259022,
      Muscle3: 9.165081208,
      Lookout: 6.188888612,
      Sniper: 46.30221086,
    },
    "Snow Blind": {
      Hustler: 48.40533937,
      Imitator: 34.56895649,
      Muscle1: 8.512932288,
      Muscle2: 8.512771845,
    },
    "Plucking the Lotus Petal": {
      Robber1: 14.027682053942709,
      Hustler: 14.394494084394903,
      Robber2: 23.680942608167083,
      Muscle: 47.89688125349531,
    },
    "Leave No Trace": {
      Techie: 29.01099583,
      Negotiator: 34.1307307,
      Imitator: 36.85827347,
    },
    "No Reserve": {
      CarThief: 30.50667524,
      Techie: 38.37053402,
      Engineer: 31.12279075,
    },
    "Counter Offer": {
      Robber: 35.94505104,
      Looter: 6.998750427,
      Hacker: 12.1275068,
      Picklock: 16.5353262,
      Engineer: 28.39336554,
    },
    "Guardian Angels": {
      Enforcer: 27.404376861170505,
      Hustler: 42.10252351813381,
      Engineer: 30.49309962016114,
    },
    "Honey Trap": {
      Enforcer: 26.98428598,
      Muscle1: 30.86556191,
      Muscle2: 42.15015211,
    },
    "Bidding War": {
      Robber1: 7.100963041,
      Driver: 12.5356157,
      Robber2: 22.87302433,
      Robber3: 31.67051915,
      Bomber1: 7.846987259,
      Bomber2: 17.97289051,
    },
    "Sneaky Git Grab": {
      Imitator: 17.539756110007634,
      Pickpocket: 50.831934101247086,
      Hacker: 14.481791981545502,
      Techie: 17.146517807199775,
    },
    "Blast From The Past": {
      Picklock1: 10.84876785,
      Hacker: 12.05662038,
      Engineer: 24.0155975,
      Bomber: 15.61710346,
      Muscle: 34.58815764,
      Picklock2: 2.873753178,
    },
    "Break the Bank": {
      Robber: 12.69693448,
      Muscle1: 13.51973049,
      Muscle2: 10.10353513,
      Thief1: 2.930695727,
      Muscle3: 31.65263066,
      Thief2: 29.09647352,
    },
    "Stacking the Deck": {
      CatBurglar: 23.43294188,
      Driver: 2.956670602,
      Hacker: 25.43825688,
      Imitator: 48.17213064,
    },
    "Clinical Precision": {
      Imitator: 43.31533431,
      CatBurglar: 18.93905648,
      Assassin: 16.0581518,
      Cleaner: 21.68745741,
    },
    "Manifest Cruelty": {
      Hacker: 16.32001273063874,
      Interrogator: 23.492099324887565,
      Reviver: 46.27406770738405,
      CatBurglar: 13.913820237089643,
    },
    "Lock Stock": {
      Assassin: 40.26601835937421,
      Smuggler: 17.442378565297464,
      Hacker: 18.407618259403492,
      Muscle1: 11.941992407962427,
      Muscle2: 11.941992407962427,
    },
    "Ace in the Hole": {
      Imitator: 21.07540412,
      Muscle1: 18.29831955,
      Muscle2: 24.65084339,
      Hacker: 28.3434151,
      Driver: 7.632017841,
    },
    "Gone Fission": {
      Hijacker: 24.93974876222353,
      Engineer: 15.565232594311826,
      Pickpocket: 16.53377808965346,
      Imitator: 24.93974876222354,
      Bomber: 18.021491791587643,
    },
    "Hostile Takeover": {
      Hacker: 11.154471089082223,
      Engineer: 15.240409558114203,
      CatBurglar: 16.003004887681396,
      Kidnapper: 12.980809844427426,
      Negotiator: 23.952564641966315,
      Muscle: 20.668739978728432,
    },
    "Cleared for Takeoff": {
      Imitator: 24.939007667714826,
      Techie: 11.316435057348194,
      Pickpocket: 12.032038349844655,
      Lookout: 8.372798960106097,
      Assassin: 18.15580375759352,
      Interrogator: 25.183916207392716,
    },
    "Crane Reaction": {
      Sniper: 40.73886856841122,
      Lookout: 16.623960934255475,
      Engineer: 8.286087919744741,
      Bomber: 15.8901690506963,
      Muscle1: 10.683294142974866,
      Muscle2: 7.777619383917385,
    },
    "Window of Opportunity": {
      Engineer: 14.55335487209706,
      Looter1: 19.544697437213543,
      Looter2: 25.802321762790502,
      Muscle1: 23.086816638821606,
      Muscle2: 17.012809289077286,
    },
    "Thou Shalt Not Steal": {
      Thief: 12.396646686195815,
      Pickpocket: 37.856826197979196,
      Picklock: 49.74652711582499,
    },
    "Dish It Out": {
      Assassin: 37.3380808914086,
      Muscle: 25.243817634035594,
      Saboteur1: 14.639223669899579,
      Saboteur2: 8.911747057590532,
      Engineer: 13.867130747065687,
    },
  };

  const ESTIMATED_FALLBACK_OCS = new Set();

  const levelIndex = normalizeCrimes(OC_LEVELS);

  const targetOverrideIndex = normalizeCrimes(TARGET_OVERRIDES);

  const fallbackWeightIndex = normalizeWeightData(FALLBACK_WEIGHTS);

  let weightIndex = fallbackWeightIndex;

  let weightSourceByCrime = buildFallbackSourceIndex(fallbackWeightIndex);

  let scanQueued = false;

  let settingsDocumentListenerAdded = false;

  let apiLevelIndex = Object.create(null);

  let bestLevelIndex = Object.create(null);

  let cprLoadedAt = 0;

  let cprRawSnapshot = null;

  let syncFlushTimer = null;
  let syncSoonTimer = null;
  let collectorOpenedAt = Date.now();
  let syncInFlight = false;
  const SHARING_TERMS_VERSION = 1;
  const SHARING_CONSENT_KEY = "black-ledger-sharing-consent-v1";

  function sharingEnabled() {
    const viewer = String(getViewerId() || "");
    if (!viewer) return false;
    try {
      const preference = GM_getValue(`${SHARING_CONSENT_KEY}:${viewer}`, undefined);
      // Undefined means the user has never opted out, so sharing defaults to ON.
      // null is retained as the legacy explicit-OFF value.
      return preference === undefined || preference?.version === SHARING_TERMS_VERSION;
    } catch (_) {
      return false;
    }
  }

  function sharingControlReady() {
    const container = document.getElementById(SETTINGS_ID);
    const status = container?.querySelector(".bl-sharing-status");
    const signature = `${String(getViewerId() || "")}|${sharingEnabled()}`;
    return !!status?.isConnected && status.dataset.signature === signature;
  }

  function changeSharing() {
    const viewer = String(getViewerId() || "");
    if (!viewer) {
      alert("Open your OC page first so your account can be identified.");
      return;
    }

    const enabled = sharingEnabled();
    if (
      !enabled &&
      !confirm(
        "Enable Black Ledger CPR sharing?\n\n" +
          "Visible OC member IDs/names, exact crime/role CPR, observation dates, and your observer/device identifiers will be stored persistently in the Black Ledger database hosted by Supabase. Service operators and holders of authorised manager access can read the data; access is not automatically checked against current faction membership. Script check-ins store your player ID, version and first/last seen times for installation support. Used only for faction OC guidance, roster planning and script support. No Torn key or password is uploaded. There is no automatic account/faction-change deletion. Ask your faction manager about removal. Turning sharing off stops future uploads but does not erase earlier server records.",
      )
    )
      return;

    GM_setValue(
      `${SHARING_CONSENT_KEY}:${viewer}`,
      enabled ? null : { version: SHARING_TERMS_VERSION, acceptedAt: Date.now() },
    );

    // Never silently forward observations queued before this explicit choice.
    writeStorageJSON(SYNC_QUEUE_KEY, {});
    observedFingerprints.clear();

    const container = document.getElementById(SETTINGS_ID);
    if (container) renderSharingControls(container);
    scanPage();
  }

  function isViewedOCPage() {
    return (
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (location.pathname === "/organizedcrimes.php" ||
        (location.pathname === "/factions.php" && /tab=crimes(?:&|$)/.test(location.hash)))
    );
  }

  function renderSharingControls(container) {
    if (!container) return;
    let menu = container.querySelector(`.${SETTINGS_MENU_CLASS}`);
    if (!menu) {
      // The management-only target header has no old preset menu. Keep the
      // sharing status and opt-out mounted independently of that removed menu.
      menu = document.createElement('div');
      menu.className = SETTINGS_MENU_CLASS + ' bl-sharing-inline';
      container.appendChild(menu);
    }

    let section = menu.querySelector(".bl-sharing-section");
    if (!section) {
      section = document.createElement("div");
      section.className = "bl-sharing-section";
      section.innerHTML = `
      <div class="bl-sharing-heading">Black Ledger</div>
      <details class="bl-sharing-terms">
        <summary>Data &amp; sharing terms</summary>
        <div class="bl-sharing-terms-body">
          <button type="button" class="bl-sharing-toggle"></button>
          <p><strong>Data stored:</strong> visible OC member IDs/names, exact crime/role CPR, observation dates and observer/device identifiers. While sharing is ON, script check-ins also store your player ID, script version and first/last seen times so managers can help with installation and troubleshooting. CPR/history also remains in local storage.</p>
          <p><strong>Who can access it:</strong> Black Ledger operators and holders of authorised Manager access. Supabase hosts/processes the shared database. Access is not a live faction-permission check.</p>
          <p><strong>Purpose:</strong> faction OC role guidance, team coverage and roster planning. No selling, advertising or real-money charges.</p>
          <p><strong>Keys:</strong> no Torn API key or password is requested or uploaded by this collector. TornProbability receives only the public role-weight request.</p>
          <p>Sharing defaults to ON. Turning it OFF stops future uploads but does not erase earlier server records. Ask your faction manager about removal. Normal hosting connection logs may be recorded.</p>
          <p><a href="https://www.torn.com/api.html" target="_blank" rel="noopener noreferrer">Torn API terms</a> · <a href="https://www.torn.com/rules.php" target="_blank" rel="noopener noreferrer">Torn scripting rules</a></p>
        </div>
      </details>`;
      menu.appendChild(section);

      section.querySelector(".bl-sharing-toggle")?.addEventListener("click", (event) => {
        event.stopPropagation();
        changeSharing();
      });

      section.querySelector(".bl-sharing-terms")?.addEventListener("click", (event) => {
        event.stopPropagation();
      });
    }

    const enabled = sharingEnabled();
    const signature = `${String(getViewerId() || "")}|${enabled}`;
    const toggle = section.querySelector(".bl-sharing-toggle");
    const termsBody=section.querySelector('.bl-sharing-terms-body');
    if(toggle && termsBody && toggle.parentElement!==termsBody)termsBody.insertBefore(toggle,termsBody.firstChild);
    const status =
      section.querySelector(".bl-sharing-status") ||
      (() => {
        const node = document.createElement("div");
        node.className = "bl-sharing-status";
        section.querySelector(".bl-sharing-heading")?.after(node);
        return node;
      })();

    status.dataset.signature = signature;
    const termsSummary=section.querySelector('.bl-sharing-terms > summary');
    if(termsSummary)termsSummary.textContent='Sharing '+(enabled?'ON':'OFF')+' · Terms';
    if(termsBody && status.parentElement!==termsBody)termsBody.insertBefore(status,termsBody.firstChild);
    status.innerHTML = `CPR Sharing: <strong>${enabled ? "ON ✓" : "OFF"}</strong>`;

    if (toggle) {
      toggle.textContent = enabled ? "Turn sharing OFF" : "Turn sharing ON";
      toggle.classList.toggle("sharing-on", enabled);
      toggle.classList.toggle("sharing-off", !enabled);
    }
  }

  window.addEventListener("focus", () => {
    if (document.body) scheduleScan();
  });
  document.addEventListener("visibilitychange", () => {
    if (isViewedOCPage()) scheduleScan();
  });

  // Initial navigation is a manual page interaction; subsequent collection
  // has a 90-second page-opening collection window, then requires recent interaction. Queued uploads do not require interaction.
  let lastOCInteraction = Date.now() - 20000;
  const observedFingerprints = new Map();
function blCollectorRosterChanged(event) {
  if(event.type==='storage' && event.key!=='black-ledger-verified-roster-v1')return;
  for(const key of observedFingerprints.keys())if(!blAllowed(key.split('|')[0]))observedFingerprints.delete(key);
  bestLevelIndex={};cprRawSnapshot='';cprLoadedAt=0;
  scheduleScan();
}
  window.addEventListener("storage",blCollectorRosterChanged);
  window.addEventListener("black-ledger-roster-updated",blCollectorRosterChanged);
  function isActiveOCPage() {
    return (
      isViewedOCPage() &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (Date.now() - collectorOpenedAt < 90000 || Date.now() - lastOCInteraction < 30000) &&
      (location.pathname === "/organizedcrimes.php" ||
        (location.pathname === "/factions.php" && /tab=crimes(?:&|$)/.test(location.hash)))
    );
  }
  for (const event of ["pointerdown", "keydown", "touchstart", "wheel"]) {
    document.addEventListener(
      event,
      (e) => {
        if (e.isTrusted) lastOCInteraction = Date.now();
      },
      { capture: true, passive: true },
    );
  }

  window.addEventListener('hashchange',()=>{
    if(isViewedOCPage()){collectorOpenedAt=Date.now();scheduleImmediateSync();}
  });
  function scheduleImmediateSync() {
    if(syncSoonTimer)return;
    syncSoonTimer=setTimeout(()=>{syncSoonTimer=null;flushSyncQueue();},1000);
  }

  /*

Hook Torn's crime list as early as possible.
*/

  hookCrimeListFetch();

  registerMenu();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, {
      once: true,
    });
  } else {
    init();
  }

  function init() {
    publishManagerTargetPolicy();
    startFactionTargetPolicy();
    injectStyles();

    // Cached weights are ready immediately; refresh from the shared source
    // once per page load. Keep role-by-role fallbacks for incomplete responses.
    const cached = readCachedWeights();
    if (cached) {
      weightIndex = mergeWeights(fallbackWeightIndex, cached.weights);
      weightSourceByCrime = mergeSourceIndexes(
        buildFallbackSourceIndex(fallbackWeightIndex),
        buildSourceIndex(cached.weights, "cached"),
      );
    }

    start();

    loadBestWeights()
      .then((best) => {
        if (!best) return;
        weightIndex = mergeWeights(fallbackWeightIndex, best.weights);
        weightSourceByCrime = mergeSourceIndexes(
          buildFallbackSourceIndex(fallbackWeightIndex),
          best.sources,
        );
        scheduleScan();
      })
      .catch((error) => {
        console.warn("[OC Smart Targets] Could not refresh role weights:", error);
      });
  }

  function start() {
    // Automatic forwarding retries queued observations while actively browsing.
    scheduleSyncFlush();

    scanPage();

    const observer = new MutationObserver((mutations) => {
      if (mutations.some(isRelevantMutation)) {
        scheduleScan();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    window.addEventListener(
      "pagehide",
      () => {
        observer.disconnect();
      },
      {
        once: true,
      },
    );
  }

  /*

============================================================

TARGET MODEL

============================================================
*/

  // Share the actual target policy with the companion Manager on this Torn origin.
  function publishManagerTargetPolicy() {
    try {
    const weights = JSON.stringify({ schema_version: 1, weights: weightIndex });
    if (localStorage.getItem("black-ledger-role-weights-v1") !== weights) {
      localStorage.setItem("black-ledger-role-weights-v1", weights);
      window.dispatchEvent(new Event("black-ledger-target-policy-updated"));
    }
    const policy = JSON.stringify({
      schema_version: 1,
      collector_version: "3.1.25",
      offset: getStrictnessOffset(),
      bases: { low: 67, middle: 67, high: 67 },
      lowMax: 5,
      middleMax: 8,
      min: 50,
      max: 75,
      overrides: TARGET_OVERRIDES,
    });
    if (localStorage.getItem("black-ledger-target-policy-v1") === policy) return;
    localStorage.setItem("black-ledger-target-policy-v1", policy);
    window.dispatchEvent(new Event("black-ledger-target-policy-updated"));
    } catch (_) { /* A full WebView store must not prevent target display. */ }
  }

  function calculateTarget(level, weight, roleCount, weights, role) {
    const base = clamp(67 + getStrictnessOffset(), 50, 75);
    const entries = Object.entries(weights || {}).map(([key,value]) => ({key: normalize(key), weight:Number(value)}));
    const key = normalize(role || '');
    if (!key || entries.length !== roleCount || entries.some(r => !Number.isFinite(r.weight) || r.weight < 0 || r.weight > 100) || new Set(entries.map(r=>r.key)).size !== entries.length) return base;
    const total = entries.reduce((sum,r)=>sum+r.weight,0);
    if (total <= 0 || !entries.some(r=>r.key===key)) return base;
    const mean = total / entries.length;
    const spread = Math.max(...entries.map(r=>Math.abs(r.weight-mean)));
    if (spread < 0.000001) return base;
    const limit = Math.min(4, base-50, 75-base);
    // Integer targets preserve the baseline average; all roles share one fixed weight model.
    const rows = entries.map(r => {
      const raw = base + limit * (r.weight-mean)/Math.max(mean,spread);
      const floor = Math.floor(raw+0.000000001);
      return {...r, target:floor, remainder:raw-floor};
    });
    const remaining = Math.round(base*rows.length-rows.reduce((sum,r)=>sum+r.target,0));
    rows.sort((a,b)=>b.remainder-a.remainder || (a.key<b.key?-1:a.key>b.key?1:0));
    for (let i=0;i<remaining;i++) rows[i].target++;
    return rows.find(r=>r.key===key).target;
  }

  /*

============================================================

PAGE DECORATION

============================================================
*/

  function scanPage() {
    if (!isViewedOCPage()) return;

    publishManagerTargetPolicy();

    const roots = [...document.querySelectorAll(SELECTORS.ocRoot)];

    if (!roots.length) {
      return;
    }

    loadCprData();

    addSettingsControl(roots[0]);

    roots.forEach(decorateOC);
  }

  function addSettingsControl(firstRoot) {
    let container = document.getElementById(SETTINGS_ID);

    if (container) {
      updateSettingsButton(container);
      renderSharingControls(container);

      return;
    }

    container = document.createElement("div");

    container.id = SETTINGS_ID;

    const button = document.createElement("span");
    button.setAttribute("role", "status");

    button.className = SETTINGS_BUTTON_CLASS;

    button.title = 'CPR targets are controlled by faction management. Refreshes automatically.';
    container.append(button);
    renderSharingControls(container);

    const parent = firstRoot.parentElement;

    if (parent) {
      parent.insertBefore(container, firstRoot);
    } else {
      firstRoot.before(container);
    }

    updateSettingsButton(container);

  }

  function getRosterKey() {
    try {
      return String(GM_getValue(ROSTER_KEY_STORAGE, "") || "").trim();
    } catch (_) {
      return "";
    }
  }

  function getRosterSnapshot() {
    const snapshot = readStorageJSON(ROSTER_SNAPSHOT_KEY);

    return Array.isArray(snapshot.member_ids) ? snapshot : null;
  }

  function hasLiveRoster() {
    const snapshot = getRosterSnapshot();

    return !!(snapshot && Number(snapshot.fetched_at_ms) > 0 && snapshot.member_ids.length);
  }

  function isCurrentRosterMember(userId) {
    if(blRoster()!==null)return blAllowed(userId);
    const snapshot = getRosterSnapshot();

    /* Until a roster is successfully loaded, never hide or discard data. */
    if (!snapshot) {
      return true;
    }

    return snapshot.member_ids.includes(String(userId));
  }

  function pruneFormerMembersFromQueue() {
    if (!hasLiveRoster()) {
      return;
    }

    const queue = readStorageJSON(SYNC_QUEUE_KEY);

    let changed = false;

    for (const [key, observation] of Object.entries(queue)) {
      if (observation?.user_id && !isCurrentRosterMember(observation.user_id)) {
        delete queue[key];
        changed = true;
      }
    }

    if (changed) {
      writeStorageJSON(SYNC_QUEUE_KEY, queue);
    }
  }

  function refreshRoster(force = false, done = null) {
    done?.({ ok: false, error: "Roster checks belong to the Manager." });
  }
  function configureRosterSync() {
    alert("Use the Manager for optional roster checks. The collector never requests an API key.");
  }

  function showRosterStatus() {
    const snapshot = getRosterSnapshot();

    if (!getRosterKey()) {
      alert(
        "Roster sync is not configured. Use Configure roster sync to paste a dedicated TornStats roster key on this device.",
      );
      return;
    }

    if (!snapshot) {
      const result = readStorageJSON(ROSTER_LAST_RESULT_KEY);
      alert(
        result?.error
          ? `Roster sync failed: ${result.error}`
          : "Roster sync is configured, but no successful roster has been received yet.",
      );
      return;
    }

    alert(
      `Live faction roster\n\n` +
        `Active members: ${snapshot.member_count}\n` +
        `Last checked: ${snapshot.fetched_at}\n\n` +
        `Former members are excluded from new collection, queued sync, and CPR exports. Their historical data is retained locally.`,
    );
  }

  function getSyncMenuLabel() {
    const count = getSyncQueueCount();

    if (BLACK_LEDGER_SYNC_ENDPOINT) {
      return `📡 Faction sync (${count} queued)`;
    }

    return `📡 Sync ready (${count} queued)`;
  }

  function showSyncStatus() {
    if (!sharingEnabled()) {
      alert(
        "CPR sharing is OFF. Enable it from the CPR settings menu. Local guidance remains active.",
      );
      return;
    }

    const count = getSyncQueueCount();

    if (BLACK_LEDGER_SYNC_ENDPOINT) {
      const result = readStorageJSON(SYNC_LAST_RESULT_KEY);

      const detail = describeSyncResult(result);

      alert(
        `Black Ledger faction sync\n\n` +
          `Queued observations: ${count}\n\n` +
          `${detail}\n\n` +
          `Tap Faction sync, wait 20 seconds, then open this status again.`,
      );

      return;
    }

    alert(
      `Black Ledger faction sync\n\n` +
        `Queued observations: ${count}\n\n` +
        `The collector is working automatically.\n\n` +
        `Shared uploading will begin once the faction backend is connected in Step 2.`,
    );
  }

  function describeSyncResult(result) {
    if (!result || !Object.keys(result).length) {
      return "No sync attempt has completed yet.";
    }

    if (result.ok) {
      return (
        `Last sync: confirmed (${result.processed || 0} new, ` +
        `${result.duplicates || 0} already stored).`
      );
    }

    if (result.pending) {
      return "Sync request is in progress…";
    }

    if (result.error === "unconfirmed-response") {
      return (
        "Last sync: server did not confirm the batch.\n" +
        `HTTP: ${result.status || "unknown"}\n` +
        `Response: ${result.response || "empty"}`
      );
    }

    if (result.error) {
      return (
        `Last sync error: ${result.error}` + (result.detail ? `\nDetail: ${result.detail}` : "")
      );
    }

    return (
      "Last sync was rejected.\n" +
      `HTTP: ${result.status || "unknown"}\n` +
      `Response: ${result.response || "empty"}`
    );
  }

  function updateSettingsButton(container) {
    const button = container.querySelector(`.${SETTINGS_BUTTON_CLASS}`);

    if (!button) {
      return;
    }

    const value=factionTargetOffset();
    const policy=cachedFactionTargetPolicy();
    button.textContent='Targets '+(value>=0?'+':'')+value+(!policy?' · pending':factionTargetError?' · sync issue':'');
    button.title = factionTargetStatus()+'. Read-only; management publishes adjustments through OC Manager.';
  }

  function decorateOC(root) {
    const title = root.querySelector(SELECTORS.panelTitle);

    if (!title) {
      return;
    }

    const crimeName = cleanText(title.textContent.replace(/OC Level\s*\d+/i, ""));

    const crimeKey = normalize(crimeName);

    const displayedLevel=title.textContent.match(/OC Level\s*(\d+)/i);
    const level = levelIndex[crimeKey] ?? apiLevelIndex[crimeKey] ?? (displayedLevel?Number(displayedLevel[1]):undefined);

    const weights = weightIndex[crimeKey];

    if (!Number.isFinite(level)) {
      return;
    }

    addOrUpdateLevelBadge(title, level);

    const cards = [...root.querySelectorAll(SELECTORS.roleCards)];

    const roles = cards
      .map((card) => ({
        card,

        name: cleanText(card.querySelector(SELECTORS.roleTitle)?.textContent),
      }))

      .filter((role) => role.name);

    const totals = Object.create(null);

    for (const role of roles) {
      const base = normalize(role.name).replace(/\d+$/, "");

      totals[base] = (totals[base] || 0) + 1;
    }

    const occurrences = Object.create(null);

    const source = weightSourceByCrime[crimeKey] || "fallback";

    for (const role of roles) {
      const rawKey = normalize(role.name);

      const base = rawKey.replace(/\d+$/, "");

      occurrences[base] = (occurrences[base] || 0) + 1;

      const numberedKey = totals[base] > 1 ? `${base}${occurrences[base]}` : base;

      const roleKey = Number.isFinite(weights?.[rawKey]) ? rawKey : numberedKey;

      const weight = weights?.[roleKey];
      const standardOnly=!Number.isFinite(weight);

      const target = calculateTarget(level, weight, roles.length, weights, roleKey);

      const estimated = !standardOnly && source === "estimated";

      const memberId = getSlotMemberId(role.card);

      addOrUpdateRoleBox(
        role.card,

        level,

        standardOnly?null:weight,

        target,

        standardOnly?"faction-standard":source,

        estimated,

        memberId,

        memberId && blAllowed(memberId) ? bestLevelIndex[memberId] : null,
      );

      applyCardColour(role.card, target);
    }
  }

  function applyCardColour(card, target) {
    const shownElement = card.querySelector(SELECTORS.successChance);

    if (!shownElement) {
      setCardState(card, null);

      return;
    }

    const match = cleanText(shownElement.textContent).match(/-?\d+(?:\.\d+)?/);

    if (!match) {
      setCardState(card, UNKNOWN_CLASS);

      return;
    }

    const shown = Number(match[0]);

    setCardState(
      card,

      shown >= target ? PASS_CLASS : FAIL_CLASS,
    );
  }

  function setCardState(card, stateClass) {
    for (const cls of [PASS_CLASS, FAIL_CLASS, UNKNOWN_CLASS]) {
      if (cls !== stateClass && card.classList.contains(cls)) {
        card.classList.remove(cls);
      }
    }

    if (stateClass && !card.classList.contains(stateClass)) {
      card.classList.add(stateClass);
    }
  }

  function addOrUpdateLevelBadge(title, level) {
    let badge = title.querySelector(`.${LEVEL_CLASS}`);

    if (!badge) {
      badge = document.createElement("span");

      badge.className = LEVEL_CLASS;

      title.appendChild(badge);
    }

    const text = `OC Level ${level}`;

    if (badge.textContent !== text) {
      badge.textContent = text;
    }
  }

  function addOrUpdateRoleBox(
    card,
    level,
    weight,
    target,
    source,
    estimated,
    memberId,
    memberBest,
  ) {
    let box = card.querySelector(`.${BOX_CLASS}`);

    if (!box) {
      box = document.createElement("div");

      box.className = BOX_CLASS;

      card.appendChild(box);
    }

    const underPlaced = !!memberBest && memberBest.level > level;

    const renderKey = [
      Number.isFinite(weight)?weight.toFixed(1):"unknown",

      target,

      estimated,

      memberId || "",

      memberBest ? `${memberBest.level}:${Math.round(memberBest.cpr)}` : "",

      underPlaced,
    ].join("|");

    if (box.dataset.renderKey === renderKey) {
      return;
    }

    box.dataset.renderKey = renderKey;

    const memberRow = memberId
      ? `
      <div
        class="oc-smart-row oc-smart-member${underPlaced ? " oc-smart-underplaced" : ""}"
      >

        <span>
          Member best
        </span>

        <strong>

          ${
            memberBest
              ? `${underPlaced ? "▲ " : ""}` +
                `L${memberBest.level} ` +
                `(${Math.round(memberBest.cpr)}%)`
              : "—"
          }

        </strong>

      </div>
    `
      : "";

    box.innerHTML = `

  <div class="oc-smart-row">

    <span>
      Role weight${estimated ? "*" : ""}
    </span>

    <strong>
      ${Number.isFinite(weight)?weight.toFixed(1)+"%":"—"}
    </strong>

  </div>

  <div class="oc-smart-row oc-smart-target">

    <span>
      Target CPR
    </span>

    <strong>
      ${target}
    </strong>

  </div>

  ${memberRow}

  ${
    source === "faction-standard"
      ? `<div class="oc-smart-note">Faction standard · role weight unavailable</div>`
      : estimated
      ? `
        <div class="oc-smart-note">
          * Equal-weight estimate
        </div>
      `
      : ""
  }
`;
  }

  /*

============================================================

WEIGHTS

============================================================
*/

  async function loadBestWeights() {
    const cached = readCachedWeights();

    try {
      const live = await requestLiveWeights();

      writeWeightsCache(live.raw);

      return {
        weights: live.normalized,

        sources: buildSourceIndex(live.normalized, "live"),
      };
    } catch (error) {
      console.warn(
        "[OC Smart Targets] " + "Live weights unavailable; " + "using cached or built-in data:",

        error,
      );

      if (cached) {
        return {
          weights: cached.weights,

          sources: buildSourceIndex(cached.weights, "cached"),
        };
      }

      return null;
    }
  }

  function requestLiveWeights() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",

        url: WEIGHTS_URL,

        timeout: REQUEST_TIMEOUT_MS,

        headers: {
          Accept: "application/json",
        },

        onload: (response) => {
          try {
            if (response.status < 200 || response.status >= 300) {
              throw new Error(`HTTP ${response.status}`);
            }

            const raw = JSON.parse(response.responseText || "{}");

            const normalized = normalizeWeightData(raw);

            if (!Object.keys(normalized).length) {
              throw new Error("Empty weight response");
            }

            resolve({
              raw,
              normalized,
            });
          } catch (error) {
            reject(error);
          }
        },

        onerror: () => reject(new Error("Network error")),

        ontimeout: () => reject(new Error("Request timed out")),
      });
    });
  }

  function writeWeightsCache(raw) {
    try {
      localStorage.setItem(
        WEIGHTS_CACHE_KEY,

        JSON.stringify({
          savedAt: Date.now(),

          data: raw,
        }),
      );
    } catch (error) {
      console.warn(
        "[OC Smart Targets] " + "Could not save weights cache:",

        error,
      );
    }
  }

  function readCachedWeights() {
    try {
      const parsed = JSON.parse(localStorage.getItem(WEIGHTS_CACHE_KEY) || "null");

      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      const age = Date.now() - Number(parsed.savedAt || 0);

      if (!Number.isFinite(age) || age < 0 || age > CACHE_MAX_AGE_MS) {
        return null;
      }

      const weights = normalizeWeightData(parsed.data);

      return Object.keys(weights).length
        ? {
            weights,
          }
        : null;
    } catch (_) {
      return null;
    }
  }

  function buildFallbackSourceIndex(weights) {
    const sources = Object.create(null);

    for (const crime of Object.keys(weights)) {
      sources[crime] = ESTIMATED_FALLBACK_OCS.has(crime) ? "estimated" : "fallback";
    }

    return sources;
  }

  function buildSourceIndex(weights, source) {
    const sources = Object.create(null);

    for (const crime of Object.keys(weights)) {
      sources[crime] = source;
    }

    return sources;
  }

  function mergeSourceIndexes(base, updates) {
    return {
      ...base,
      ...(updates || {}),
    };
  }

  function normalizeCrimes(source) {
    const result = Object.create(null);

    for (const [crime, value] of Object.entries(source)) {
      result[normalize(crime)] = value;
    }

    return result;
  }

  function normalizeWeightData(source) {
    const result = Object.create(null);

    if (!source || typeof source !== "object") {
      return result;
    }

    for (const [crime, roles] of Object.entries(source)) {
      if (!roles || typeof roles !== "object") {
        continue;
      }

      const roleIndex = Object.create(null);

      for (const [role, rawWeight] of Object.entries(roles)) {
        // Preserve precision. Treat tiny negative regression noise as zero;
        // reject malformed values and materially negative percentages.
        if (typeof rawWeight !== "number" && typeof rawWeight !== "string") continue;
        if (typeof rawWeight === "string" && !rawWeight.trim()) continue;
        const parsedWeight = Number(rawWeight);
        const weight = parsedWeight < 0 && parsedWeight >= -0.001 ? 0 : parsedWeight;

        if (Number.isFinite(weight) && weight >= 0 && weight <= 100) {
          roleIndex[normalize(role)] = weight;
        }
      }

      if (Object.keys(roleIndex).length) {
        result[normalize(crime)] = roleIndex;
      }
    }

    return result;
  }

  function mergeWeights(base, updates) {
    const merged = Object.create(null);

    for (const [crime, roles] of Object.entries(base)) {
      merged[crime] = {
        ...roles,
      };
    }

    for (const [crime, roles] of Object.entries(updates || {})) {
      merged[crime] = {
        ...(merged[crime] || {}),

        ...roles,
      };
    }

    return merged;
  }

  /*

============================================================

CPR RECORDING

============================================================
*/

  function hookCrimeListFetch() {
    const target = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    if (typeof target.fetch !== "function" || target.fetch.ocSmartHooked) {
      return;
    }

    const originalFetch = target.fetch;

    const hookedFetch = function (...args) {
      const promise = originalFetch.apply(this, args);

      const input = args[0];

      const url = typeof input === "string" ? input : input?.url || String(input || "");

      if (isActiveOCPage() && url.includes("crimeList")) {
        promise
          .then((response) => response.clone().json())

          .then(recordCrimeList)

          .catch((error) =>
            console.warn(
              "[OC Smart Targets] " + "Could not record crimeList CPR:",

              error,
            ),
          );
      }

      return promise;
    };

    hookedFetch.ocSmartHooked = true;

    target.fetch = hookedFetch;
  }

  function recordCrimeList(data) {
    if (!isActiveOCPage()) return;

    const crimes = data?.data;

    if (!Array.isArray(crimes)) {
      return;
    }

    const viewerId = getViewerId();
    if (!viewerId) return;

    const members = readStorageJSON(CPR_DATA_KEY);

    const levels = readStorageJSON(CPR_LEVEL_KEY);

    const names = readStorageJSON(CPR_NAMES_KEY);

    const seen = readStorageJSON(CPR_SEEN_KEY);

    const now = new Date();

    const nowIso = now.toISOString();

    const nowMs = now.getTime();
    const latest = readStorageJSON("black-ledger-cpr-latest-observations-v1");

    for (const crime of crimes) {
      const scenario = crime?.scenario;

      const crimeName = scenario?.name;

      if (!crimeName) {
        continue;
      }

      const roles = [];

      for (const slot of crime.playerSlots || []) {
        const position = slot?.name;

        if (!position) {
          continue;
        }

        if (!roles.includes(position)) {
          roles.push(position);
        }

        const occupiedId = slot.player?.ID;

        const userId = occupiedId || viewerId;

        if (
          slot.successChance === null ||
          slot.successChance === undefined ||
          String(slot.successChance).trim() === ""
        )
          continue;
        const cpr = Number(slot.successChance);
        if(!blAllowed(userId))continue;

        if (!userId || !Number.isFinite(cpr) || cpr < 0 || cpr > 100) {
          continue;
        }

        const id = String(userId);

        /*
         * Try to learn the occupied member's username.
         */

        if (occupiedId) {
          const username = firstValidUsername(
            slot.player?.name,

            slot.player?.username,

            slot.player?.playerName,
          );

          if (username) {
            names[id] = username;
          }
        }

        const observationKey = makeObservationKey(id, crimeName, position);
        latest[observationKey] = { cpr, observed_at: nowIso, timestamp_ms: nowMs };
        const fingerprint = `${cpr}|${names[id] || ""}`;
        const lastUpload = observedFingerprints.get(observationKey);
        if (
          !lastUpload ||
          lastUpload.fingerprint !== fingerprint ||
          nowMs - lastUpload.at >= SYNC_REFRESH_MS
        ) {
          enqueueSyncObservation({
            user_id: Number(id),
            user_name: names[id] || null,
            crime: crimeName,
            role: position,
            cpr,
            crime_level: Number(scenario.level) || null,
            crime_difficulty: DIFFICULTY_TIERS[scenario.difficultyTier] || null,
            observed_at: nowIso,
            observer_id: Number(viewerId),
            device_id: ensureSyncDeviceId(),
            source: occupiedId ? "occupied-slot" : "viewer-open-slot",
          });
          observedFingerprints.set(observationKey, { fingerprint, at: nowMs });
        }

        const memberCrimes = (members[id] ??= {});

        const crimeRoles = (memberCrimes[crimeName] ??= {});

        const previousCpr = Number(crimeRoles[position]);

        const seenKey = makeObservationKey(id, crimeName, position);

        const previousSeen = Number(seen[seenKey]?.timestamp_ms || 0);

        const isNewHigh = !Number.isFinite(previousCpr) || cpr > previousCpr;

        /*
         * Keep highest recorded CPR in the existing
         * OC Track CPR-compatible store.
         */

        if (isNewHigh) {
          crimeRoles[position] = cpr;
        }

        /*
         * Store freshness separately.
         */

        seen[seenKey] = {
          observed_at: nowIso,

          timestamp_ms: nowMs,

          cpr: Math.max(
            Number.isFinite(previousCpr) ? previousCpr : cpr,

            cpr,
          ),
        };
      }

      if (Number.isInteger(Number(scenario.level)) && Number(scenario.level)>0) {
        levels[crimeName] = {
          level: scenario.level,

          difficulty: DIFFICULTY_TIERS[scenario.difficultyTier],

          roles,
        };
      }
    }

    writeStorageJSON("black-ledger-cpr-latest-observations-v1", latest);
    writeStorageJSON(CPR_DATA_KEY, members);

    writeStorageJSON(CPR_LEVEL_KEY, levels);

    writeStorageJSON(CPR_NAMES_KEY, names);

    writeStorageJSON(CPR_SEEN_KEY, seen);

    loadCprData(true);

    scheduleScan();
  }

  /*

============================================================

SYNC OUTBOX

============================================================
*/

  /*
   * Rebuild the outbox once from the CPR stores that predate faction sync.
   * Records are keyed in exactly the same way as normal observations, so a
   * recovery never duplicates a newer queued value.  Its client ID is derived
   * from the historical observation data rather than generated randomly: a
   * retry therefore sends the same deduplication ID every time.
   */
  function runSyncRecoveryMigration(viewerId) {
    if (!viewerId) {
      return;
    }

    try {
      if (localStorage.getItem(SYNC_RECOVERY_MARKER_KEY)) {
        return;
      }

      const members = readStorageJSON(CPR_DATA_KEY);

      const levels = readStorageJSON(CPR_LEVEL_KEY);

      const names = readStorageJSON(CPR_NAMES_KEY);

      const seen = readStorageJSON(CPR_SEEN_KEY);

      const queue = readStorageJSON(SYNC_QUEUE_KEY);

      const nowIso = new Date().toISOString();

      let rebuilt = 0;

      for (const [userId, crimeData] of Object.entries(members)) {
        const numericUserId = Number(userId);

        if (!numericUserId || !crimeData || typeof crimeData !== "object") {
          continue;
        }

        for (const [crime, roleData] of Object.entries(crimeData)) {
          if (!roleData || typeof roleData !== "object") {
            continue;
          }

          for (const [role, storedCpr] of Object.entries(roleData)) {
            const cpr = Number(storedCpr);

            if (!crime || !role || !Number.isFinite(cpr)) {
              continue;
            }

            const key = makeObservationKey(String(numericUserId), crime, role);

            const seenEntry = seen[key] || {};

            const observedAt =
              validObservedAt(seenEntry.observed_at) ||
              validObservedAt(
                Number(seenEntry.timestamp_ms)
                  ? new Date(Number(seenEntry.timestamp_ms)).toISOString()
                  : null,
              ) ||
              nowIso;

            const levelInfo = levels[crime] || {};

            const recoveryObservation = {
              user_id: numericUserId,

              user_name: names[String(numericUserId)] || null,

              crime,

              role,

              cpr,

              crime_level: Number.isFinite(Number(levelInfo.level))
                ? Number(levelInfo.level)
                : (levelIndex[normalize(crime)] ?? null),

              crime_difficulty: levelInfo.difficulty || null,

              observed_at: observedAt,

              observer_id: Number(viewerId),

              device_id: ensureSyncDeviceId(),

              source: numericUserId === Number(viewerId) ? "viewer-open-slot" : "occupied-slot",

              collector_version: "3.0.2",

              client_observation_id: makeRecoveryObservationId(
                numericUserId,
                crime,
                role,
                cpr,
                observedAt,
                viewerId,
                ensureSyncDeviceId(),
              ),
            };

            const existing = queue[key];

            /* Do not overwrite a current observation with older recovery data. */
            if (existing && Number(existing.cpr) > cpr) {
              continue;
            }

            if (existing && existing.client_observation_id) {
              recoveryObservation.client_observation_id = existing.client_observation_id;
            }

            queue[key] = recoveryObservation;

            rebuilt++;
          }
        }
      }

      trimSyncQueue(queue);

      writeStorageJSON(SYNC_QUEUE_KEY, queue);

      localStorage.setItem(
        SYNC_RECOVERY_MARKER_KEY,
        JSON.stringify({
          completed_at: nowIso,
          rebuilt,
        }),
      );

      writeSyncResult({
        ok: true,
        recovery: true,
        rebuilt,
        remaining: Object.keys(queue).length,
        at: nowIso,
      });
    } catch (error) {
      /* No marker is written: a later page load can safely retry the rebuild. */
      writeSyncResult({
        ok: false,
        recovery: true,
        error: "recovery-failed",
        detail: String(error?.message || error).slice(0, 300),
        at: new Date().toISOString(),
      });
    }
  }

  function validObservedAt(value) {
    if (!value || !Number.isFinite(Date.parse(value))) {
      return null;
    }

    return new Date(value).toISOString();
  }

  function makeRecoveryObservationId(userId, crime, role, cpr, observedAt, viewerId, deviceId) {
    const material = [
      "black-ledger-recovery-v2.8.4",
      userId,
      normalize(crime),
      normalize(role),
      cpr,
      observedAt,
      viewerId,
      deviceId,
    ].join("|");

    let first = 2166136261;

    let second = 0x9e3779b9;

    for (let index = 0; index < material.length; index++) {
      const code = material.charCodeAt(index);

      first = Math.imul(first ^ code, 16777619);

      second = Math.imul(second ^ code, 2246822519);
    }

    return "recovery-" + (first >>> 0).toString(36) + "-" + (second >>> 0).toString(36);
  }

  function enqueueSyncObservation(observation) {
    if (!isActiveOCPage() || !sharingEnabled() || !blAllowed(observation?.user_id)) return;

    if (
      !observation?.user_id ||
      !observation?.crime ||
      !observation?.role ||
      !Number.isFinite(Number(observation?.cpr))
    ) {
      return;
    }

    const queue = readStorageJSON(SYNC_QUEUE_KEY);

    const key = makeObservationKey(
      String(observation.user_id),

      observation.crime,

      observation.role,
    );

    const existing = queue[key];

    if (existing) {
      // Keep the newest real observation. The backend tracks best CPR separately.
      if (Date.parse(existing.observed_at) > Date.parse(observation.observed_at)) return;

      /*
       * Preserve a known username.
       */

      observation.user_name = observation.user_name || existing.user_name || null;
    }

    if (!observation.client_observation_id) {
      observation.client_observation_id = createObservationId();
    }

    observation.collector_version = "3.1.25";
    queue[key] = observation;

    trimSyncQueue(queue);

    writeStorageJSON(SYNC_QUEUE_KEY, queue);
    scheduleImmediateSync();
  }

  function trimSyncQueue(queue) {
    const entries = Object.entries(queue);

    if (entries.length <= SYNC_MAX_QUEUE) {
      return;
    }

    entries.sort((a, b) => {
      const aTime = Date.parse(a[1]?.observed_at || "") || 0;

      const bTime = Date.parse(b[1]?.observed_at || "") || 0;

      return bTime - aTime;
    });

    for (const [key] of entries.slice(SYNC_MAX_QUEUE)) {
      delete queue[key];
    }
  }

  function getSyncQueueCount() {
    return Object.keys(readStorageJSON(SYNC_QUEUE_KEY)).length;
  }

  function scheduleSyncFlush() {
    if (syncFlushTimer) {
      clearInterval(syncFlushTimer);
    }

    syncFlushTimer = setInterval(() => {
      if (BLACK_LEDGER_SYNC_ENDPOINT) {
        flushSyncQueue();
      }
    }, SYNC_FLUSH_INTERVAL_MS);

    if (BLACK_LEDGER_SYNC_ENDPOINT) {
      for(const delay of [1000,5000,15000,30000,60000])setTimeout(flushSyncQueue,delay);
    }
  }

  /*

Upload queued CPR observations to the shared faction backend.
*/

  async function scriptPresenceRequest(method = 'GET', body, token = '') {
    const historyURL = 'https://shcecvzxdknpulytekcl.supabase.co/functions/v1/black-ledger-script-presence';
    const headers = {Accept:'application/json'};
    if (token) headers['x-black-ledger-dashboard-token'] = token;
    if (body) headers['Content-Type'] = 'application/json';
    const attempt = start => new Promise((resolve,reject) => {
      let settled = false, abort;
      const finish = (error,response) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { reject(error); return; }
        // Older mobile bridges can serialise the whole HTTP envelope.
        if (typeof response === 'string') {
          try { response = JSON.parse(response); } catch (_) {}
        }
        const snapshot = {};
        for (const key of ['status','responseText','response','body']) {
          try { if (response?.[key] !== undefined) snapshot[key] = response[key]; } catch (_) {}
        }
        resolve(snapshot);
      };
      const timer = setTimeout(()=>{finish(new Error('Connection timed out'));try{abort?.();}catch(_){}},20000);
      try { abort = start(response=>finish(null,response),error=>finish(error || new Error('Connection failed'))); }
      catch(error) { finish(error); }
    });
    const methods = [];
    const failures = [];
    const add = (name, start) => methods.push({name, run:()=>attempt(start)});
    const nativeGet = typeof PDA_httpGet === 'function' ? PDA_httpGet : window.PDA_httpGet;
    const nativePut = typeof PDA_httpPut === 'function' ? PDA_httpPut : window.PDA_httpPut;
    const native = method === 'GET' ? nativeGet : nativePut;
    if (typeof native === 'function') add('PDA helper',(ok,fail)=>{
      Promise.resolve(native(historyURL,headers,...(body ? [JSON.stringify(body)] : []))).then(ok,fail);
    });
    // Call the documented native handler if a helper is absent or returns no HTTP envelope.
    // Resolve bridge availability at call time; mobile document-start injection can precede it.
    if (window.flutter_inappwebview || window.__PDA_platformReadyPromise) add('PDA bridge',(ok,fail)=>{
      (async()=>{
        if (window.__PDA_platformReadyPromise) await window.__PDA_platformReadyPromise;
        const bridge = window.flutter_inappwebview;
        if (typeof bridge?.callHandler !== 'function') throw new Error('PDA bridge unavailable');
        return bridge.callHandler(method === 'GET' ? 'PDA_httpGet' : 'PDA_httpPut',
          historyURL,headers,...(body ? [JSON.stringify(body)] : []));
      })().then(ok,fail);
    });
    if (typeof GM_xmlhttpRequest === 'function') add('Userscript',(ok,fail)=>{
      const handle = GM_xmlhttpRequest({method,url:historyURL,headers,data:body ? JSON.stringify(body) : undefined,timeout:19000,onload:ok,onerror:fail,ontimeout:()=>fail(new Error('Connection timed out')),onabort:fail});
      if (handle && typeof handle.then === 'function') handle.then(response=>{if(response?.status !== undefined || typeof response === 'string')ok(response);},fail);
      return ()=>handle?.abort?.();
    });
    if (typeof fetch === 'function') add('Browser',(ok,fail)=>{
      const controller = new AbortController();
      fetch(historyURL,{method,headers,body:body ? JSON.stringify(body) : undefined,signal:controller.signal,credentials:'omit',cache:'no-store',mode:'cors'})
        .then(async response=>ok({status:response.status,responseText:await response.text()})).catch(fail);
      return ()=>controller.abort();
    });
    for (const transport of methods) {
      let response;
      try { response = await transport.run(); } catch (error) { failures.push(`${transport.name}: ${error?.message === 'Connection timed out' ? 'timeout' : 'connection error'}`); continue; }
      const status = Number(response?.status);
      if ([401,403].includes(status)) throw new Error('Manager access is required to read script activity.');
      if (status !== 200) { failures.push(`${transport.name}: ${Number.isFinite(status) && status > 0 ? `HTTP ${status}` : 'no response status'}`); continue; }
      for (const raw of [response.responseText,response.response,response.body]) {
        try {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (data?.ok && data.faction_id === 50888 && (method === 'GET' ? Array.isArray(data.records) : data.recorded === true)) return data;
        } catch (_) {}
      }
      failures.push(`${transport.name}: invalid response`);
    }
    throw new Error(`Script activity request failed (${[...new Set(failures)].join(', ') || 'no connection available'}). Retry script activity refresh.`);
  }

  let presenceBusy = false;
  let presenceAttempt = 0;
  async function checkInScriptPresence(force = false) {
    if (presenceBusy) return 'A check-in is already running.';
    if (!isViewedOCPage() || document.visibilityState !== 'visible' || !document.hasFocus()) return 'Open the Torn OC page and keep it in focus.';
    if (!sharingEnabled()) return 'Sharing is OFF. Enable sharing in the CPR settings menu to check in.';
    if (!sharingControlReady()) return 'The CPR sharing control is not ready yet. Wait for the OC page to finish loading and retry.';
    const viewer = String(getViewerId() || '');
    if (!/^[1-9]\d*$/.test(viewer)) return 'Waiting for your Torn player ID.';
    const key = 'black-ledger-script-presence-v1:' + viewer + ':3.1.25';
    const last = Number(GM_getValue(key, 0));
    if (!force && ((last <= Date.now() && Date.now() - last < 15 * 60 * 1000) || Date.now() - presenceAttempt < 60000)) return 'Check-in already sent recently; automatic check-ins run every fifteen minutes.';
    presenceBusy = true; presenceAttempt = Date.now();
    try {
      await scriptPresenceRequest('PUT', {faction_id:50888, user_id:viewer, script_version:'3.1.25'});
      GM_setValue(key, Date.now());
      return 'Check-in confirmed for Torn ID ' + viewer + ' using Smart Role Targets 3.1.25. Refresh script activity in the Manager.';
    } catch (error) { return error.message || 'Check-in failed. It will retry automatically.'; }
    finally { presenceBusy = false; }
  }
  setInterval(checkInScriptPresence, 5000);
  setTimeout(checkInScriptPresence, 5000);
  window.addEventListener('focus', () => checkInScriptPresence());
  window.addEventListener('hashchange', () => checkInScriptPresence());
  document.addEventListener('visibilitychange', () => checkInScriptPresence());

  function flushSyncQueue() {
    if (
      !isViewedOCPage() ||
      !sharingEnabled() ||
      !sharingControlReady() ||
      syncInFlight ||
      typeof GM_xmlhttpRequest !== "function"
    )
      return;

    if (!BLACK_LEDGER_SYNC_ENDPOINT) {
      return;
    }

    const viewerId = getViewerId();

    const deviceId = ensureSyncDeviceId();

    /*

Do not upload until Torn has told us

who the current viewer actually is.
*/

    if (!viewerId || !deviceId) {
      return;
    }

    const queue = readStorageJSON(SYNC_QUEUE_KEY);

    const entries = Object.entries(queue);

    if (!entries.length) {
      return;
    }

    /*

Upgrade records created by v2.8.0.



This means the hundreds of CPR records already

sitting in your queue are NOT lost.
*/

    let queueChanged = false;

    for (const [key, observation] of entries) {
      if (!observation) {
        continue;
      }

      if (!observation.client_observation_id) {
        observation.client_observation_id = createObservationId();

        queueChanged = true;
      }

      if (!observation.observer_id) {
        observation.observer_id = Number(viewerId);

        queueChanged = true;
      }

      if (!observation.device_id) {
        observation.device_id = deviceId;

        queueChanged = true;
      }

      if (!observation.collector_version) {
        observation.collector_version = "legacy-unknown";

        queueChanged = true;
      }

      queue[key] = observation;
    }

    if (queueChanged) {
      writeStorageJSON(SYNC_QUEUE_KEY, queue);
    }

    /*

Only upload observations belonging to this

browser/player combination.
*/

    const compatibleEntries = Object.entries(queue)

      .filter(
        ([, observation]) =>
          Number(observation?.observer_id) === Number(viewerId) &&
          observation?.device_id === deviceId &&
          !!observation?.client_observation_id,
      );

    if (!compatibleEntries.length) {
      return;
    }

    const batch = compatibleEntries.slice(0, SYNC_BATCH_SIZE);

    const keys = batch.map((item) => item[0]);

    const observations = batch.map((item) => item[1]);

    const payload = {
      schema_version: 1,

      sent_at: new Date().toISOString(),

      device_id: deviceId,

      observer_id: Number(viewerId),

      observations,
    };

    writeSyncResult({
      ok: false,
      pending: true,
      sent: observations.length,
      at: new Date().toISOString(),
    });

    syncInFlight = true;
    GM_xmlhttpRequest({
      method: "POST",

      url: BLACK_LEDGER_SYNC_ENDPOINT,

      headers: {
        "Content-Type": "application/json",

        Accept: "application/json",
      },

      data: JSON.stringify(payload),

      timeout: 15000,

      onload: (response) => {
        syncInFlight = false;

        if (response.status < 200 || response.status >= 300) {
          writeSyncResult({
            ok: false,

            status: response.status,

            response: String(response.responseText || "").slice(0, 500),

            at: new Date().toISOString(),
          });

          console.warn(
            "[OC Smart Targets] " + "Black Ledger sync rejected:",
            response.status,
            response.responseText,
          );

          return;
        }

        let serverResult = null;

        try {
          serverResult = JSON.parse(response.responseText || "{}");
        } catch (_) {
          serverResult = null;
        }

        const processed = Number(serverResult?.processed);

        const duplicates = Number(serverResult?.duplicates);

        /*
         * A duplicate is an explicit server acknowledgement that this exact
         * idempotent observation was received earlier.  It is therefore just as
         * safe to remove as a newly processed record; this avoids an outbox being
         * permanently stuck after a retry or a recovered first upload.
         */
        const confirmed = processed + duplicates;

        if (
          !serverResult ||
          serverResult.ok !== true ||
          !Number.isInteger(processed) ||
          !Number.isInteger(duplicates) ||
          processed < 0 ||
          duplicates < 0 ||
          confirmed !== observations.length
        ) {
          writeSyncResult({
            ok: false,
            error: "unconfirmed-response",
            status: response.status,
            sent: observations.length,
            response: String(response.responseText || "").slice(0, 500),
            at: new Date().toISOString(),
          });

          console.warn(
            "[OC Smart Targets] " + "Black Ledger sync was not confirmed; queue retained.",
            serverResult,
          );

          return;
        }

        const current = readStorageJSON(SYNC_QUEUE_KEY);

        for (let index = 0; index < keys.length; index++) {
          const key = keys[index];

          const currentItem = current[key];

          const sentItem = observations[index];

          /*
           * Only remove the exact observation
           * which was successfully sent.
           *
           * If something newer has replaced it
           * while the request was travelling,
           * preserve the newer record.
           */

          if (currentItem && currentItem.client_observation_id === sentItem.client_observation_id) {
            delete current[key];
          }
        }

        writeStorageJSON(SYNC_QUEUE_KEY, current);

        writeSyncResult({
          ok: true,

          sent: observations.length,

          processed,

          duplicates,

          skipped: Number(serverResult?.skipped) || 0,

          remaining: Object.keys(current).length,

          at: new Date().toISOString(),
        });

        /*
         * More than one batch?
         * Send the next one shortly afterwards.
         */

        if (Object.keys(current).length) {
          setTimeout(flushSyncQueue, 1200);
        }
      },

      onerror: () => {
        syncInFlight = false;

        writeSyncResult({
          ok: false,

          error: "network",

          at: new Date().toISOString(),
        });
      },

      ontimeout: () => {
        syncInFlight = false;

        writeSyncResult({
          ok: false,

          error: "timeout",

          at: new Date().toISOString(),
        });
      },
    });
  }

  function createObservationId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    return (
      "obs-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2) +
      "-" +
      Math.random().toString(36).slice(2)
    );
  }

  function writeSyncResult(result) {
    if(result && typeof result==="object"){result={...result};delete result.response;}
    writeStorageJSON(SYNC_LAST_RESULT_KEY, result);
  }

  function ensureSyncDeviceId() {
    try {
      let id = localStorage.getItem(SYNC_DEVICE_KEY);

      if (id) {
        return id;
      }

      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        id = crypto.randomUUID();
      } else {
        id = "bl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      }

      localStorage.setItem(SYNC_DEVICE_KEY, id);

      return id;
    } catch (_) {
      return "unknown-device";
    }
  }

  function makeObservationKey(userId, crime, role) {
    return `${userId}|` + `${normalize(crime)}|` + `${normalize(role)}`;
  }

  function firstValidUsername(...values) {
    for (const value of values) {
      let name = cleanText(value);

      if (!name) {
        continue;
      }

      name = name.replace(/^view\s+profile\s+of\s+/i, "");

      name = name.replace(/^profile\s+of\s+/i, "");

      if (name.length < 2 || name.length > 32) {
        continue;
      }

      if (/^\d+$/.test(name) || /^torn\s+id\s+\d+$/i.test(name) || /^view\s+profile$/i.test(name)) {
        continue;
      }

      return name;
    }

    return null;
  }

  /*

============================================================

BEST MEMBER LEVEL

============================================================
*/

  function loadCprData(force = false) {
    const membershipScope=blViewer()+"|"+JSON.stringify(blRoster());
    if(loadCprData.blScope!==membershipScope){force=true;loadCprData.blScope=membershipScope;}
    if (!force && Date.now() - cprLoadedAt < CPR_RELOAD_MS) {
      return;
    }

    cprLoadedAt = Date.now();

    let membersRaw = "";

    let levelsRaw = "";

    try {
      membersRaw = localStorage.getItem(CPR_DATA_KEY) || "";

      levelsRaw = localStorage.getItem(CPR_LEVEL_KEY) || "";
    } catch (_) {
      return;
    }

    // Compare full strings: equal lengths/tails can hide a CPR change.
    if (!force && cprRawSnapshot?.members === membersRaw && cprRawSnapshot?.levels === levelsRaw) {
      return;
    }

    cprRawSnapshot = { members: membersRaw, levels: levelsRaw };

    const members = blFilterStore(CPR_DATA_KEY,parseObject(membersRaw));

    const levels = parseObject(levelsRaw);

    const apiLevels = Object.create(null);

    for (const [crime, info] of Object.entries(levels)) {
      const level = Number(info?.level);

      if (Number.isFinite(level) && level > 0) {
        apiLevels[normalize(crime)] = level;
      }
    }

    const best = Object.create(null);

    for (const [userId, crimes] of Object.entries(members)) {
      const byLevel = Object.create(null);

      for (const [crime, roles] of Object.entries(crimes || {})) {
        const crimeKey = normalize(crime);

        const level = apiLevels[crimeKey] ?? levelIndex[crimeKey];

        if (!Number.isFinite(level)) {
          continue;
        }

        for (const value of Object.values(roles || {})) {
          const cpr = Number(value);

          if (Number.isFinite(cpr)) {
            (byLevel[level] ??= []).push(cpr);
          }
        }
      }

      let memberBest = null;

      for (const [rawLevel, values] of Object.entries(byLevel)) {
        const level = Number(rawLevel);

        const average = values.reduce((sum, value) => sum + value, 0) / values.length;

        if (average >= CPR_QUALIFY && (!memberBest || level > memberBest.level)) {
          memberBest = {
            level,
            cpr: average,
          };
        }
      }

      if (memberBest) {
        best[userId] = memberBest;
      }
    }

    apiLevelIndex = apiLevels;

    bestLevelIndex = best;
  }

  /*

============================================================

MEMBER / VIEWER

============================================================
*/

  function getSlotMemberId(card) {
    const link = card.querySelector('a[href*="XID="]');

    const match = link?.getAttribute("href")?.match(/XID=(\d+)/);

    return match ? match[1] : null;
  }

  function getViewerId() {
    try {
      return JSON.parse(document.getElementById("torn-user")?.value || "null")?.id || null;
    } catch (_) {
      return null;
    }
  }

  /*

============================================================

EXPORT

============================================================
*/

  function exportCprData() {
    const members = readStorageJSON(CPR_DATA_KEY);

    const levels = readStorageJSON(CPR_LEVEL_KEY);

    const names = readStorageJSON(CPR_NAMES_KEY);

    const seen = readStorageJSON(CPR_SEEN_KEY);

    const rows = [];

    for (const [userId, crimes] of Object.entries(members)) {
      for (const [crime, roles] of Object.entries(crimes || {})) {
        for (const [role, cpr] of Object.entries(roles || {})) {
          const key = makeObservationKey(userId, crime, role);

          rows.push({
            user_id: Number(userId),

            user_name: names[userId] || null,

            crime,

            role,

            cpr: Number(cpr),

            crime_level: levels[crime]?.level ?? levelIndex[normalize(crime)] ?? null,

            crime_difficulty: levels[crime]?.difficulty ?? null,

            last_seen: seen[key]?.observed_at || null,

            source: "local",
          });
        }
      }
    }

    const payload = {
      exported_at: new Date().toISOString(),

      member_count: new Set(rows.map((row) => row.user_id)).size,

      row_count: rows.length,

      sync_queue_count: getSyncQueueCount(),

      rows,
    };

    const url = URL.createObjectURL(
      new Blob(
        [JSON.stringify(payload, null, 2)],

        {
          type: "application/json",
        },
      ),
    );

    const link = document.createElement("a");

    link.href = url;

    link.download = "cpr_export.json";

    document.body.appendChild(link);

    link.click();

    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /*

============================================================

STORAGE

============================================================
*/

  function readStorageJSON(key) {
    try {
      return blFilterStore(key,parseObject(localStorage.getItem(key)));
    } catch (_) {
      return {};
    }
  }

  function writeStorageJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(blForWrite(key,value)));
    } catch (error) {
      console.warn(
        "[OC Smart Targets] " + `Could not save ${key}:`,

        error,
      );
    }
  }

  function parseObject(raw) {
    try {
      const parsed = JSON.parse(raw || "null");

      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  /*

============================================================

PAGE OBSERVER

============================================================
*/

  function scheduleScan() {
    if (scanQueued) {
      return;
    }

    scanQueued = true;

    requestAnimationFrame(() => {
      scanQueued = false;

      scanPage();
    });
  }

  function isRelevantMutation(mutation) {
    const element =
      mutation.target?.nodeType === Node.ELEMENT_NODE
        ? mutation.target
        : mutation.target?.parentElement;

    if (!element || element.closest?.(`.${BOX_CLASS}`) || element.closest?.(`#${SETTINGS_ID}`)) {
      return false;
    }

    return (
      !!element.closest?.("[data-oc-id]") ||
      !!element.querySelector?.(
        "[data-oc-id]," +
          '[class^="panelTitle___"],' +
          '[class^="title___"],' +
          '[class^="successChance___"]',
      )
    );
  }

  /*

============================================================

USERSCRIPT MENU

============================================================
*/

  function factionTargetPolicyUIChanged() { scheduleScan(); }
  function registerMenu() {
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Toggle CPR sharing', changeSharing);
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Script check-in: retry / status', async () => alert(await checkInScriptPresence(true)));
  }
  function getStrictnessOffset() { return factionTargetOffset(); }

  /*

============================================================

STYLES

============================================================
*/

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");

    style.id = STYLE_ID;

    style.textContent = `
#${SETTINGS_ID} { flex-wrap: wrap; gap: 6px; align-items: center; }

  .bl-sharing-section {
    margin-top: 5px;
    padding-top: 7px;
    border-top: 1px solid rgba(255,255,255,.12);
    color: #ddd;
    font-size: 11px;
  }

  #${SETTINGS_ID} > .${SETTINGS_BUTTON_CLASS} { order: 0 !important; }
  #${SETTINGS_ID} > .bl-sharing-inline { order: 1 !important; }
  #${SETTINGS_ID} > #black-ledger-oc-manager-launcher {
    order: 2 !important;
    flex: 0 0 auto !important;
  }

  #${SETTINGS_ID} .bl-sharing-inline {
    position: static !important;
    display: inline-flex !important;
    flex: 0 1 auto !important;
    min-width: 0 !important;
    width: auto !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
  }
  #${SETTINGS_ID} .bl-sharing-inline .bl-sharing-section {
    display: flex !important;
    align-items: center !important;
    flex-wrap: wrap !important;
    gap: 6px !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
  }
  #${SETTINGS_ID} .bl-sharing-inline .bl-sharing-heading { display: none !important; }
  #${SETTINGS_ID} .bl-sharing-inline .bl-sharing-status {
    padding: 5px 0 !important;
    white-space: nowrap !important;
  }
  #${SETTINGS_ID} .bl-sharing-inline .bl-sharing-toggle {
    width: auto !important;
    margin: 0 !important;
    padding: 5px 9px !important;
    border: 1px solid #44545f !important;
    border-radius: 14px !important;
    background: #252d33 !important;
    color: #e8eef2 !important;
    font-size: 11px !important;
    line-height: 1.2 !important;
    white-space: nowrap !important;
    cursor: pointer !important;
  }
  #${SETTINGS_ID} .bl-sharing-inline .sharing-off { color: #ffb0b0 !important; }
  #${SETTINGS_ID} .bl-sharing-inline .bl-sharing-terms {
    position: relative !important;
    margin: 0 !important;
  }
  #${SETTINGS_ID} .bl-sharing-inline .bl-sharing-terms-body {
    position: absolute !important;
    right: 0 !important;
    top: calc(100% + 6px) !important;
    width: 285px !important;
    max-width: calc(100vw - 32px) !important;
    max-height: 55vh !important;
    overflow-y: auto !important;
    box-sizing: border-box !important;
    padding: 10px !important;
    border: 1px solid #44545f !important;
    border-radius: 8px !important;
    background: #222 !important;
    color: #e8eef2 !important;
    box-shadow: 0 4px 15px rgba(0,0,0,.35) !important;
    z-index: 1000 !important;
  }

  #${SETTINGS_ID} .bl-sharing-inline .bl-sharing-terms {position:static!important}
  #${SETTINGS_ID} .bl-sharing-terms-body .bl-sharing-toggle {
    display:inline-flex!important;align-items:center!important;justify-content:center!important;
    min-height:44px!important;box-sizing:border-box!important;padding:8px 12px!important;margin:0 0 8px!important;
    color:#fff!important;-webkit-text-fill-color:#fff!important;background:#245679!important;background-image:none!important;
    border:1px solid #72caff!important;border-radius:6px!important;font:600 12px/1.3 sans-serif!important;text-shadow:none!important;white-space:normal!important;cursor:pointer!important;
  }
  #${SETTINGS_ID} .bl-sharing-terms-body .bl-sharing-toggle:hover:not(:disabled){background:#306d94!important}
  #${SETTINGS_ID} .bl-sharing-terms-body .bl-sharing-toggle:focus-visible{outline:2px solid #ffe39c!important;outline-offset:2px!important}
  #${SETTINGS_ID} .bl-sharing-terms-body .bl-sharing-toggle:disabled{color:#b7c9d5!important;-webkit-text-fill-color:#b7c9d5!important;background:#263c49!important;border-color:#607c8d!important}

  .bl-sharing-heading {
    padding: 2px 9px 4px;
    font-weight: 700;
    color: #fff;
  }

  .bl-sharing-status {
    padding: 2px 9px 5px;
    color: #bbb;
  }

  .bl-sharing-status strong { color: #57c7ff; }

  .bl-sharing-section .bl-sharing-toggle {
    border-top: 0 !important;
    margin-top: 0 !important;
  }

  .bl-sharing-section .bl-sharing-toggle.sharing-off {
    color: #ffb0b0;
  }

  .bl-sharing-terms {
    margin: 2px 9px 4px;
    color: #bbb;
    line-height: 1.35;
  }

  .bl-sharing-terms summary {
    cursor: pointer;
    color: #65c5fa;
    user-select: none;
  }

  .bl-sharing-terms-body {
    width: 285px;
    max-width: min(72vw, 320px);
    padding: 5px 0 1px;
    white-space: normal;
  }

  .bl-sharing-terms-body p {
    margin: 5px 0;
    height: auto;
    white-space: normal;
  }

  .bl-sharing-terms-body a { color: #65c5fa; }

  #${SETTINGS_ID} {

    position:
      relative;

    display:
      flex;

    justify-content:
      flex-end;

    margin:
      0 0 10px;

    z-index:
      50;
  }

  .${SETTINGS_BUTTON_CLASS} {

    appearance:
      none;

    border:
      1px solid
      rgba(
        74,
        144,
        226,
        .65
      );

    border-radius:
      14px;

    padding:
      5px 10px;

    background:
      rgba(
        47,
        111,
        165,
        .18
      );

    color:
      inherit;

    font-size:
      11px;

    font-weight:
      700;

    line-height:
      1.2;

    cursor:
      pointer;
  }

  .${SETTINGS_BUTTON_CLASS}:hover {

    background:
      rgba(
        47,
        111,
        165,
        .3
      );
  }

  .${SETTINGS_MENU_CLASS} {

    position:
      absolute;

    top:
      calc(
        100% + 5px
      );

    right:
      0;

    min-width:
      235px;

    padding:
      5px;

    border:
      1px solid
      rgba(
        255,
        255,
        255,
        .15
      );

    border-radius:
      8px;

    background:
      #222;

    box-shadow:
      0 4px 15px
      rgba(
        0,
        0,
        0,
        .35
      );

    z-index:
      999;
  }

  .${SETTINGS_MENU_CLASS}[hidden] {

    display:
      none;
  }

  .${SETTINGS_MENU_CLASS} button {

    display:
      block;

    width:
      100%;

    margin:
      0;

    padding:
      7px 9px;

    border:
      0;

    border-radius:
      5px;

    background:
      transparent;

    color:
      #ddd;

    font-size:
      11px;

    text-align:
      left;

    cursor:
      pointer;
  }

  .${SETTINGS_MENU_CLASS} button:hover {

    background:
      rgba(
        255,
        255,
        255,
        .08
      );
  }

  .${SETTINGS_MENU_CLASS} button.selected {

    background:
      rgba(
        47,
        111,
        165,
        .35
      );

    color:
      #57c7ff;

    font-weight:
      700;
  }

  .${SETTINGS_MENU_CLASS}
  button.selected::after {

    content:
      " ✓";
  }

  .${SETTINGS_MENU_CLASS}
  button.oc-smart-menu-action {

    margin-top:
      4px;

    border-top:
      1px solid
      rgba(
        255,
        255,
        255,
        .12
      );

    border-radius:
      0 0 5px 5px;
  }

  .${LEVEL_CLASS} {

    display:
      inline-block;

    margin-left:
      8px;

    padding:
      2px 7px;

    border-radius:
      10px;

    background:
      #2f6fa5;

    color:
      white;

    font-size:
      11px;

    font-weight:
      700;

    vertical-align:
      middle;
  }

  .${BOX_CLASS} {

    margin-top:
      6px;

    padding:
      6px 7px;

    border:
      1px solid
      rgba(
        74,
        144,
        226,
        .55
      );

    border-radius:
      7px;

    background:
      rgba(
        47,
        111,
        165,
        .12
      );

    font-size:
      11px;
  }

  .${BOX_CLASS}
  .oc-smart-row {

    display:
      flex;

    align-items:
      center;

    justify-content:
      space-between;

    gap:
      6px;
  }

  .${BOX_CLASS}
  .oc-smart-row strong {

    font-size:
      13px;
  }

  .${BOX_CLASS}
  .oc-smart-target {

    margin-top:
      4px;

    padding-top:
      4px;

    border-top:
      1px solid
      rgba(
        255,
        255,
        255,
        .15
      );
  }

  .${BOX_CLASS}
  .oc-smart-target strong {

    color:
      #57c7ff;

    font-size:
      17px;
  }

  .${BOX_CLASS}
  .oc-smart-member {

    margin-top:
      4px;

    padding-top:
      4px;

    border-top:
      1px solid
      rgba(
        255,
        255,
        255,
        .15
      );
  }

  .${BOX_CLASS}
  .oc-smart-underplaced strong {

    color:
      #c58cff;
  }

  .${BOX_CLASS}
  .oc-smart-note {

    margin-top:
      3px;

    font-size:
      9px;

    opacity:
      .7;

    text-align:
      center;
  }

  .${PASS_CLASS} {

    border:
      4px double
      #18a558 !important;

    border-radius:
      10px !important;
  }

  .${FAIL_CLASS} {

    border:
      4px double
      #e03c31 !important;

    border-radius:
      10px !important;
  }

  .${UNKNOWN_CLASS} {

    border:
      4px double
      #e6a700 !important;

    border-radius:
      10px !important;
  }
`;

    document.head.appendChild(style);
  }

  /*

============================================================

GENERIC HELPERS

============================================================
*/

  function normalize(value) {
    return String(value || "")
      .normalize("NFKD")

      .replace(/[\u0300-\u036f]/g, "")

      .toLowerCase()

      .replace(/[^a-z0-9]/g, "");
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")

      .trim();
  }

  function clamp(value, minimum, maximum) {
    return Math.min(
      maximum,

      Math.max(minimum, value),
    );
  }
})();