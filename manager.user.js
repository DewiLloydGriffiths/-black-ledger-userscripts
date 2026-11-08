// ==UserScript==
// @name         Black Ledger OC Manager
// @namespace    https://www.torn.com/
// @version      1.9.21
// @description  Leadership companion for Black Ledger OC Smart Role Targets. Planner with selectable crime levels, available-now assignments and spawn advice, with personal-message preparation. Launcher is restricted to OC pages; it also captures anonymous completed OC history.
// @author       Black Ledger
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/organizedcrimes.php*
// @match        https://www.torn.com/messages.php*
// @match        https://torn.com/factions.php*
// @match        https://torn.com/organizedcrimes.php*
// @match        https://torn.com/messages.php*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      api.torn.com
// @connect      www.tornstats.com
// @connect      shcecvzxdknpulytekcl.supabase.co
// @license      MIT
// @noframes
// @downloadURL https://update.greasyfork.org/scripts/598010/Black%20Ledger%20OC%20Manager.user.js
// @updateURL https://update.greasyfork.org/scripts/598010/Black%20Ledger%20OC%20Manager.meta.js
// ==/UserScript==

(function () {
  "use strict";
  // Set up the launcher before any optional service or storage code executes.
  const MANAGER_DIAGNOSTIC = false;
  const managerDiagnostic = { stage: "A: script entered", errors: [] };
  setInterval(recoverManagerLauncher, 1500);
  window.addEventListener('hashchange', recoverManagerLauncher);
  window.addEventListener('popstate', recoverManagerLauncher);
  setTimeout(recoverManagerLauncher, 0);
  const PLANNER_KEY = 'black-ledger-oc-planner-api-key-v1';
  const API_USAGE_KEY='black-ledger-manager-api-usage-v1';
  const API_COOLDOWN_KEY='black-ledger-manager-api-cooldown-v1';
  let apiNextAt=0;
  // History sync also runs on compose pages, which return before planner setup.
  let plannerState = null;
  // Shared, device-local membership contract. Never infer departures from OC slots.
  // Recover only replaceable caches; never delete Torn data, CPR observations,
  // message queues, sent receipts, membership verification or preferences.
  function blSessionKey(key) {
    return key === 'black-ledger-oc-newsletter-draft-v1' || key === 'black-ledger-oc-pm-queue-v1' || /^black-ledger-oc-pm-shared-v1:[1-9]\d*:[1-9]\d*:(request|status)$/.test(key);
  }
  function blSessionStored(key) {
    try { return blSessionKey(key) && sessionStorage.getItem('bl-mail-fallback:'+key)!==null; } catch (_) { return false; }
  }
  function blStorageGet(key) {
    // Manager-private bookkeeping is shared by this userscript across its pages.
    // Never put helper-visible queues or sent receipts in private GM storage.
    if(/^black-ledger-workspace-sync-v1:[1-9]\d*:[1-9]\d*(?::conflict)?$/.test(key) && typeof GM_getValue==='function') {
      const value=GM_getValue('bl-storage-fallback:'+key,null);if(typeof value==='string')return value;
    }
    if (blSessionKey(key)) {
      try { const value=sessionStorage.getItem('bl-mail-fallback:'+key); if(value!==null)return value; } catch (_) {}
    }
    return localStorage.getItem(key);
  }
  function blStorageRemove(key) {
    if(/^black-ledger-workspace-sync-v1:[1-9]\d*:[1-9]\d*(?::conflict)?$/.test(key)) {
      try { if(typeof GM_getValue('bl-storage-fallback:'+key,null)==='string') {
        GM_setValue('bl-storage-fallback:'+key,null);
        if(GM_getValue('bl-storage-fallback:'+key,null)!==null)throw new Error('Workspace storage removal failed.');
      } } catch(error) { if(typeof GM_getValue==='function')throw error; }
    }
    if(blSessionKey(key))try{sessionStorage.removeItem('bl-mail-fallback:'+key);}catch(_){}
    localStorage.removeItem(key);
  }

  function blStorageSet(key, value) {
    const privateKey=/^black-ledger-workspace-sync-v1:[1-9]\d*:[1-9]\d*(?::conflict)?$/.test(key);
    const savePrivate=()=>{
      GM_setValue('bl-storage-fallback:'+key,value);
      if(GM_getValue('bl-storage-fallback:'+key,null)!==value)throw new Error('Workspace storage write could not be verified.');
      // Remove the old duplicate only after the durable replacement is verified.
      try{localStorage.removeItem(key);}catch(_){}
    };
    let privateStored=false;
    if(privateKey && typeof GM_getValue==='function')privateStored=typeof GM_getValue('bl-storage-fallback:'+key,null)==='string';
    if(privateStored){savePrivate();return;}
    if(blSessionKey(key)) {
      try { if(sessionStorage.getItem('bl-mail-fallback:'+key)!==null) { sessionStorage.setItem('bl-mail-fallback:'+key,value);return; } } catch (_) {}
    }
    const quota = error => error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22 || error.code === 1014);
    try { localStorage.setItem(key, value); return; }
    catch (error) { if (!quota(error)) throw error; }
    const caches = [];
    for (let i=0; i<localStorage.length; i++) {
      const candidate=localStorage.key(i);
      if (candidate !== key && (/^black-ledger-planner-snapshot-v1:[1-9]\d*$/.test(candidate) || candidate === 'oc_smart_targets_weights_cache_v2'))
        caches.push(candidate);
    }
    caches.sort((a,b)=>(localStorage.getItem(b) || '').length-(localStorage.getItem(a) || '').length);
    for (const cache of caches) {
      localStorage.removeItem(cache);
      try { localStorage.setItem(key,value); return; }
      catch (error) { if (!quota(error)) throw error; }
    }
    if(blSessionKey(key)) {
      try { sessionStorage.setItem('bl-mail-fallback:'+key,value);return; } catch (_) {}
    }
    if(privateKey) {
      try { savePrivate();return; } catch (_) {}
    }
    const record=privateKey?'workspace sync state':key==='black-ledger-oc-planner-options-v1'?'planner settings':key.startsWith('black-ledger-spawn-review-v1:')?'spawn review':key==='black-ledger-verified-roster-v1'?'membership verification':/^black-ledger-oc-pm-shared-v1:[1-9]\d*:[1-9]\d*$/.test(key)?'sent message history':key==='black-ledger-oc-newsletter-draft-v1'?'message draft':key==='black-ledger-oc-pm-queue-v1'?'message queue':'required local data';
    throw new Error('Device storage is full while saving '+record+'. OC data and message history have been preserved. This operation could not finish.');
  }

  function blCleanupOldLocalData(now = Date.now()) {
    const cutoff = now - 6 * 86400000;
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
      for (const key of keys) {
        if (!(/^black-ledger-planner-snapshot-v1:[1-9]\d*$/.test(key) ||
              /^black-ledger-spawn-review-v1:/.test(key) ||
              key === 'black-ledger-oc-newsletter-draft-v1')) continue;
        try {
          const row = JSON.parse(localStorage.getItem(key));
          const at = row?.scannedAt ?? row?.snapshot?.scannedAt ?? row?.createdAt ?? row?.expiresAt;
          if (Number.isFinite(at) && at > 0 && at < cutoff) blStorageRemove(key);
        } catch (_) {} // Unknown/corrupt records are not proof of age.
      }
    } catch (_) {} // Storage restrictions must not prevent the launcher loading.
  }
  blCleanupOldLocalData();

  function blViewer() {
    try { return String(JSON.parse(document.getElementById('torn-user')?.value || 'null')?.id || ''); }
    catch (_) { return ''; }
  }
  let blRosterMemo = null;
  function blRoster() {
    try {
      const raw=blStorageGet('black-ledger-verified-roster-v1');
      const viewer=blViewer();
      if (blRosterMemo?.raw===raw && blRosterMemo.viewer===viewer) return blRosterMemo.value;
      let value=null;
      if (raw) {
        const r=JSON.parse(raw);
        value=(r.version!==1 || r.ready!==true || r.viewerId!==viewer ||
          !/^[1-9]\d*$/.test(r.factionId) || !Array.isArray(r.memberIds) || !r.memberIds.length ||
          r.memberIds.some(id=>typeof id!=='string' || !/^[1-9]\d*$/.test(id)) ||
          new Set(r.memberIds).size!==r.memberIds.length || !r.memberIds.includes(r.viewerId) ||
          !Number.isFinite(r.checkedAt) || r.checkedAt>Date.now()+60000) ? false : r;
      }
      blRosterMemo={raw,viewer,value};
      return value;
    } catch (_) { blRosterMemo=null; return false; }
  }
  function blAllowed(id) {
    const r=blRoster();
    return r===null ? true : !!r && r.memberIds.includes(String(id));
  }
  function blRequireRoster() {
    const r=blRoster();
    if (!r || Date.now()-r.checkedAt>15*60000)
      throw new Error('Verify faction members first: Refresh roster sync, or complete the membership check, within 15 minutes.');
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
      const raw=blStorageGet(key); if (!raw) continue;
      if (reset || key==='black-ledger-cpr-sync-last-result-v1') { blStorageRemove(key); continue; }
      let value;
      try { value=JSON.parse(raw); } catch (_) { blStorageRemove(key); continue; }
      const clean=blFilterStore(key,value,r);
      if (clean===null) blStorageRemove(key);
      else if (JSON.stringify(clean)!==raw) blStorageSet(key,JSON.stringify(clean));
    }
  }


  function workspaceFingerprint(value) {
    const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
    return plannerReviewDigest(JSON.stringify(canonical(value)));
  }
  // Synchronise deliberate workflow state only, under the existing Manager access.
  function workspaceValues(s) {
    const read=(key,fallback=null)=>{const raw=blStorageGet(key);return raw?JSON.parse(raw):fallback;};
    const result={},prefs=read('black-ledger-oc-planner-options-v1',{});
    for(const field of ['levels','includeStale','management','messageScope','spawnBudget','pendingScan'])result['pref:'+field]=prefs[field] ?? null;
    for(const name of ['builder','specialist','coverage'])result['filter:'+name]=read('black-ledger-'+name+'-levels-v1');
    const decisions=read('black-ledger-invitation-decisions-v1:'+s.viewerId+':'+s.factionId,{});
    for(const [id,value] of Object.entries(decisions))if(/^[1-9]\d{0,14}$/.test(id))result['invitation:'+id]=value;
    const scoped=value=>value?.viewerId===s.viewerId && String(value.factionId)===s.factionId?value:null;
    const draft=scoped(read('black-ledger-oc-newsletter-draft-v1'));
    let queue=scoped(read('black-ledger-oc-pm-queue-v1'));
    if(queue){queue={...queue};for(const key of ['activeId','openedAt','sendAttempt','workflowActive'])delete queue[key];}
    result.workflow=draft || queue?{draft,queue}:null;
    const review=scoped(read('black-ledger-spawn-review-v1:'+s.viewerId+':'+s.factionId));
    result.review=review?.signature && review.expiresAt>Date.now()?review:null;
    return result;
  }
  function applyWorkspaceValue(s,key,value) {
    const read=(k,f={})=>{const raw=blStorageGet(k);return raw?JSON.parse(raw):f;};
    const write=(k,v)=>{if(v===null)blStorageRemove(k);else blStorageSet(k,JSON.stringify(v));};
    if(key.startsWith('pref:')){
      const k='black-ledger-oc-planner-options-v1',prefs=read(k),field=key.slice(5);
      if(value===null)delete prefs[field];else prefs[field]=value;write(k,prefs);
    }else if(key.startsWith('filter:'))write('black-ledger-'+key.slice(7)+'-levels-v1',value);
    else if(key.startsWith('invitation:')){
      const k='black-ledger-invitation-decisions-v1:'+s.viewerId+':'+s.factionId,decisions=read(k),id=key.slice(11);
      if(value===null)delete decisions[id];else decisions[id]=value;write(k,decisions);
    }else if(key==='review')write('black-ledger-spawn-review-v1:'+s.viewerId+':'+s.factionId,value);
    else if(key==='workflow'){
      const old=read('black-ledger-oc-pm-queue-v1',null);
      if(old?.sendAttempt)throw new Error('Another device updated messages while this device is sending. Sync again after the send finishes.');
      write('black-ledger-oc-newsletter-draft-v1',value?.draft || null);
      write('black-ledger-oc-pm-queue-v1',value?.queue?{...value.queue,activeId:null,openedAt:null,workflowActive:false}:null);
    }
  }
  async function syncWorkspace(s,token,sameScope) {
    const metaKey='black-ledger-workspace-sync-v1:'+s.viewerId+':'+s.factionId;
    const meta=JSON.parse(blStorageGet(metaKey)||'{"entries":{}}');
    const entries=meta.entries || {};
    // Older versions stored the entire workflow as the change fingerprint.
    // Hash it in place before any network request, preserving dirty detection.
    let migrated=false;
    for(const entry of Object.values(entries))if(typeof entry.local==='string' && !/^sha256:[0-9a-f]{64}$/.test(entry.local)){
      entry.local=plannerReviewDigest(entry.local);migrated=true;
    }
    if(migrated)blStorageSet(metaKey,JSON.stringify({entries}));
    const before=workspaceValues(s);
    const remote=await messageHistoryRequest('GET',undefined,token,s.viewerId,'0','workspace');sameScope();
    const server=new Map();
    for(const row of remote.records){
      if(typeof row.key!=='string' || !/^(pref:(levels|includeStale|management|messageScope|spawnBudget|pendingScan)|filter:(builder|specialist|coverage)|invitation:[1-9]\d{0,14}|workflow|review)$/.test(row.key) || !Number.isSafeInteger(row.revision) || row.revision<1 || server.has(row.key))throw new Error('Invalid shared Manager state.');
      server.set(row.key,row);
    }
    const pending=[];let changed=false,conflict=false;
    // Capture edits made while GET was in flight, too.
    const local=workspaceValues(s);
    for(const key of new Set([...Object.keys(local),...Object.keys(entries),...server.keys()])){
      const value=local[key] ?? null,text=workspaceFingerprint(value),old=entries[key],row=server.get(key);
      const editedDuringDownload=workspaceFingerprint(before[key] ?? null)!==text;
      if(row && text===workspaceFingerprint(row.value)){entries[key]={revision:row.revision,local:text};continue;}
      const dirty=old?text!==old.local:editedDuringDownload || !row && value!==null;
      if(dirty){pending.push({key,value,base_revision:old?.revision || (editedDuringDownload?row?.revision || 0:0),mutation_id:crypto.randomUUID()});continue;}
      if(row && (!old || row.revision>old.revision)){
        // A first download adopts canonical state instead of uploading an old device cache.
        if(text!==workspaceFingerprint(row.value)){applyWorkspaceValue(s,key,row.value);changed=true;}
        entries[key]={revision:row.revision,local:workspaceFingerprint(row.value)};
      }else if(!old)entries[key]={revision:0,local:text};
    }
    blStorageSet(metaKey,JSON.stringify({entries}));
    for(let start=0;start<pending.length;start+=50){
      const batch=pending.slice(start,start+50);
      const result=await messageHistoryRequest('PUT',{faction_id:50888,sender_id:s.viewerId,records:batch},token,s.viewerId,'0','workspace');sameScope();
      if(!Array.isArray(result.conflicts) || !Array.isArray(result.accepted) || result.conflicts.length+result.accepted.length!==batch.length)throw new Error('Incomplete shared Manager update.');
      for(const row of [...result.accepted,...result.conflicts]){
        const sent=batch.find(r=>r.key===row.key);
        if(!sent || !Number.isSafeInteger(row.revision) || row.revision<1)throw new Error('Invalid Manager update confirmation.');
        const current=workspaceValues(s)[row.key] ?? null;
        if(result.conflicts.some(r=>r.key===row.key)){
          // Preserve the losing edit for recovery, but never overwrite newer shared state.
          blStorageSet(metaKey+':conflict',JSON.stringify({at:Date.now(),key:row.key,local:current,shared:row.value}));
          if(workspaceFingerprint(current)!==workspaceFingerprint(sent.value))throw new Error('Manager state changed during a sync conflict. Retry sync.');
          applyWorkspaceValue(s,row.key,row.value);changed=true;conflict=true;
        }
        entries[row.key]={revision:row.revision,local:workspaceFingerprint(row.value)};
      }
      blStorageSet(metaKey,JSON.stringify({entries}));
    }
    if(changed){
      document.dispatchEvent(new Event('black-ledger-workspace-updated'));
      if(location.pathname!=='/messages.php'){inlinePlannerCachedState=null;inlinePlannerCachedModel=null;renderPlannerIfOpen();}
    }
    if(conflict)throw new Error('Another device changed the same Manager state. Its newer version was loaded; your local edit is retained in the sync conflict backup. Review before sending.');
  }

  function installMessageSendClaims() {
    let busy=false;
    async function poll(){
      if(busy)return;
      const roster=blRoster();if(!roster || String(roster.factionId)!=='50888' || Date.now()-roster.checkedAt>15*60000)return;
      const key='black-ledger-message-claim-v1:'+roster.viewerId+':'+roster.factionId;
      let request,status;try{request=JSON.parse(blStorageGet(key+':request')||'null');status=JSON.parse(blStorageGet(key+':status')||'null');}catch(_){return;}
      if(!request || request.id===status?.id || Date.now()-request.at>30000)return;
      busy=true;
      try{
        const token=String(GM_getValue('black-ledger-manager-read-token-v1:'+roster.viewerId,'')).trim();
        if(!token)throw new Error('Configure Manager access on this device.');
        const result=await messageHistoryRequest('PUT',{faction_id:50888,sender_id:roster.viewerId,recipient_id:request.recipient,assignment_key:request.assignment,claim_id:request.id},token,roster.viewerId,'0','claim');
        const current=blRoster();if(current?.viewerId!==roster.viewerId || current?.factionId!==roster.factionId || token!==String(GM_getValue('black-ledger-manager-read-token-v1:'+roster.viewerId,'')).trim())throw new Error('Account or access changed during send check.');
        const ok=result.accepted.includes(request.id);
        blStorageSet(key+':status',JSON.stringify({id:request.id,ok,message:ok?'Send reserved on this device.':'Another device is sending to this member, or this assignment is already sent. Wait, sync and check Torn before retrying.'}));
      }catch(error){blStorageSet(key+':status',JSON.stringify({id:request.id,ok:false,message:error.message || 'Cross-device send check failed.'}));}
      finally{busy=false;}
    }
    document.addEventListener('black-ledger-message-claim',()=>poll());setInterval(poll,1000);
  }

  // Runs on OC and compose pages; credentials stay in the Manager's private storage.
  function installMessageHistorySync() {
    let busy=false,lastAttempt=0,lastPending='',lastScope='';
    function scope() {
      const r=blRoster();
      if(!r || String(r.factionId)!=='50888' || Date.now()-r.checkedAt>15*60000)return null;
      return {viewerId:r.viewerId,factionId:r.factionId};
    }
    function key(s){return 'black-ledger-oc-pm-shared-v1:'+s.viewerId+':'+s.factionId;}
    function load(s) {
      const raw=blStorageGet(key(s));
      const h=raw?JSON.parse(raw):{version:1,...s,members:{},pending:{}};
      if(h.version!==1 || h.viewerId!==s.viewerId || h.factionId!==s.factionId || !h.members || !h.pending)throw new Error('Message history is unreadable.');
      return h;
    }
    function valid(row) {
      if(!row || !/^[1-9]\d{0,14}$/.test(String(row.recipient_id)) || !Number.isSafeInteger(row.sent_at) || row.sent_at<1 || row.sent_at>Date.now()+60000 || !/^[0-9a-f-]{36}$/.test(row.event_id) || typeof row.assignment_key!=='string')return false;
      try {
        const keys=JSON.parse(row.assignment_key);
        if (row.retired === true) return Array.isArray(keys) && keys.length === 0;
        return Array.isArray(keys) && keys.length>0 && keys.length<=50 && JSON.stringify([...new Set(keys)].sort())===row.assignment_key && keys.every(k=>{const p=JSON.parse(k);return p.length===2 && /^[1-9]\d{0,14}$/.test(p[0]) && typeof p[1]==='string' && p[1].trim() && p[1].length<=80;});
      }catch(_){return false;}
    }
    async function sync(request=null) {
      if(busy)return;
      const s=scope();if(!s)return;
      if(request && (request.viewerId!==s.viewerId || request.factionId!==s.factionId))return;
      const token=String(GM_getValue('black-ledger-manager-read-token-v1:'+s.viewerId,'')).trim();
      const statusKey=key(s)+':status';
      function status(ok,message,at=0){
        const previous=JSON.parse(blStorageGet(statusKey)||'null'),syncing=message==='Syncing sent assignments…';
        const lastError=ok?null:syncing?(previous?.lastError || (previous?.ok===false && previous.message!=='Syncing sent assignments…'?previous.message:null)):message;
        blStorageSet(statusKey,JSON.stringify({...s,ok,message,at,lastError,requestId:request?.id || previous?.requestId || null}));
      }
      if(!token){status(false,'Configure shared CPR Manager access on this device.');return;}
      busy=true;lastAttempt=Date.now();lastScope=key(s);lastPending=JSON.stringify(load(s).pending);status(false,'Syncing sent assignments…');
      try {
        const sameScope=()=>{const current=scope();if(!current || current.viewerId!==s.viewerId || current.factionId!==s.factionId || token!==String(GM_getValue('black-ledger-manager-read-token-v1:'+s.viewerId,'')).trim())throw new Error('Account or membership changed during message sync.');};
        await syncWorkspace(s,token,sameScope);
        // Re-read after every await: another tab or the helper may add a receipt.
        for(let round=0;round<3;round++) {
          const pending=Object.values(load(s).pending);
          for(let start=0;start<pending.length;start+=100) {
            const batch=pending.slice(start,start+100);
            if(batch.some(row=>!valid(row)))throw new Error('Invalid local sent assignment.');
            const result=await messageHistoryRequest('PUT',{faction_id:50888,sender_id:s.viewerId,records:batch},token,s.viewerId);
            sameScope();
            if(result.accepted.length!==batch.length || batch.some(row=>!result.accepted.includes(row.event_id)))throw new Error('Incomplete message upload confirmation.');
            const latest=load(s);
            for(const row of batch)if(latest.pending[row.recipient_id]?.event_id===row.event_id)delete latest.pending[row.recipient_id];
            blStorageSet(key(s),JSON.stringify(latest));
          }
          if (typeof plannerMessageCleanupCandidates === 'function' && typeof plannerState !== 'undefined') {
            const state = plannerState, current = load(s);
            const queue = JSON.parse(blStorageGet('black-ledger-oc-pm-queue-v1') || 'null');
            const candidates = queue?.sendAttempt ? [] : plannerMessageCleanupCandidates(state, current, s);
            for (let start = 0; start < candidates.length; start += 100) {
              const batch = candidates.slice(start, start + 100);
              await messageHistoryRequest('PUT', {faction_id:50888, sender_id:s.viewerId, records:batch}, token, s.viewerId, '0', 'cleanup');
              sameScope();
            }
          }
          const downloaded={};let after='0';
          do {
            const result=await messageHistoryRequest('GET',undefined,token,s.viewerId,after);sameScope();
            if(result.next!==null && (!/^[1-9]\d{0,14}$/.test(result.next) || Number(result.next)<=Number(after)))throw new Error('Invalid message download cursor.');
            for(const row of result.records) {
              if(!valid(row) || Number(row.recipient_id)<=Number(after) || downloaded[row.recipient_id])throw new Error('Invalid shared sent assignment.');
              downloaded[row.recipient_id]=row;
            }
            after=result.next;
          }while(after);
          const latest=load(s);
          for(const [id,row]of Object.entries(downloaded)) {
            const old=latest.members[id];
            if (row.retired === true) {
              if (!latest.pending[id] && old && (row.sent_at > old.sentAt || (row.sent_at === old.sentAt && row.event_id >= String(old.eventId || '')))) {
                const decisionKey = 'black-ledger-invitation-decisions-v1:'+s.viewerId+':'+s.factionId;
                const decisions = JSON.parse(blStorageGet(decisionKey) || '{}');
                if (decisions[id]?.fingerprint === JSON.stringify([old.key, old.sentAt])) {
                  delete decisions[id]; blStorageSet(decisionKey, JSON.stringify(decisions));
                }
                delete latest.members[id];
              }
              continue;
            }
            if(!old || row.sent_at>old.sentAt || (row.sent_at===old.sentAt && row.event_id>String(old.eventId || '')))
              latest.members[id]={key:row.assignment_key,sentAt:row.sent_at,eventId:row.event_id};
          }
          const complete=Object.keys(latest.pending).length===0;
          if(complete)latest.lastSyncedAt=Date.now();
          blStorageSet(key(s),JSON.stringify(latest));
          if(complete){status(true,'Manager, invitations and messages synced across your devices.',latest.lastSyncedAt);return;}
        }
        throw new Error('New sent assignments are awaiting upload. Retry sync.');
      }catch(error){status(false,String(error.message || 'Message sync failed. Local receipts retained.'));}
      finally{busy=false;}
    }
    function poll(force=false) {
      try {
        if(busy || document.visibilityState==='hidden')return;
        const s=scope();if(!s)return;
        const request=JSON.parse(blStorageGet(key(s)+':request')||'null');
        const status=JSON.parse(blStorageGet(key(s)+':status')||'null');
        const asked=request && request.id!==status?.requestId && Date.now()-request.at<90000;
        const pendingRows=load(s).pending,pending=Object.keys(pendingRows).length>0;
        const changed=pending && JSON.stringify(pendingRows)!==lastPending;
        if(asked || force || changed || lastScope!==key(s) || (Date.now()-lastAttempt>=(pending?5000:10000)))sync(asked?request:null).catch(()=>{});
      }catch(_){}
    }
    document.addEventListener('black-ledger-workspace-dirty',()=>poll(true));
    setInterval(poll,1000);
    window.addEventListener('focus',()=>poll(true));
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')poll(true);});
    setTimeout(()=>poll(true),2000);
  }
  async function messageHistoryRequest(method = 'GET', body, token = '', sender = '', after = '0', area = 'history-v2') {
    const historyURL = 'https://shcecvzxdknpulytekcl.supabase.co/functions/v1/black-ledger-message-history?sender_id=' + encodeURIComponent(sender) + (method === 'GET' ? '&after=' + encodeURIComponent(after) : '') + (['workspace','claim','cleanup','history-v2'].includes(area)?'&area='+area:'');
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
      if ([401,403].includes(status)) throw new Error('This access code is not authorised to sync sent assignments.');
      if (status !== 200) { failures.push(`${transport.name}: ${Number.isFinite(status) && status > 0 ? `HTTP ${status}` : 'no response status'}`); continue; }
      for (const raw of [response.responseText,response.response,response.body]) {
        try {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (data?.ok && data.faction_id === 50888 && data.sender_id === sender && (method === 'GET' ? Array.isArray(data.records) : Array.isArray(data.accepted))) return data;
        } catch (_) {}
      }
      failures.push(`${transport.name}: invalid response`);
    }
    throw new Error(`Message sync failed (${[...new Set(failures)].join(', ') || 'no connection available'}). Local receipts retained; retry message sync.`);
  }

  async function plannerSnapshotRequest(method = 'GET', body, token = '') {
    const historyURL = 'https://shcecvzxdknpulytekcl.supabase.co/functions/v1/black-ledger-planner-snapshot';
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
    const preferred=plannerSnapshotRequest.preferred?.[method];
    if(preferred)methods.sort((a,b)=>Number(b.name===preferred)-Number(a.name===preferred));
    for (const transport of methods) {
      let response;
      try { response = await transport.run(); } catch (error) { failures.push(`${transport.name}: ${error?.message === 'Connection timed out' ? 'timeout' : 'connection error'}`); continue; }
      const status = Number(response?.status);
      if ([401,403].includes(status)) throw new Error('This access code is not authorised to sync planner snapshots.');
      if (status !== 200) { failures.push(`${transport.name}: ${Number.isFinite(status) && status > 0 ? `HTTP ${status}` : 'no response status'}`); continue; }
      for (const raw of [response.responseText,response.response,response.body]) {
        try {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (data?.ok && data.faction_id === 50888 && Object.prototype.hasOwnProperty.call(data,'snapshot') && (method === 'GET' || !!data.snapshot)) {
            plannerSnapshotRequest.preferred={...plannerSnapshotRequest.preferred,[method]:transport.name};
            return data;
          }
        } catch (_) {}
      }
      failures.push(`${transport.name}: invalid response`);
    }
    throw new Error(`Shared planner connection failed (${[...new Set(failures)].join(', ') || 'no connection available'}). Retry the shared scan.`);
  }

  // A snapshot pins OC membership, server CPR, weights, settings and reference time.
  let sharedPlannerBusy=false,sharedPlannerPullBusy=false,plannerInputContext=null;
  const sharedPlannerProfileMemo=new WeakMap();
  async function tornOCPageRequest(step,fields) {
    if(!['crimeList','usersNotInvolved','metaData'].includes(step))throw new Error('Unsupported OC read request.');
    const page=typeof unsafeWindow!=='undefined'?unsafeWindow:window;
    if(typeof page.addRFC!=='function' || typeof page.fetch!=='function')throw new Error('Torn page connection is not ready. Reload Torn and retry.');
    const url=new URL(page.addRFC('/page.php?sid=organizedCrimesData&step='+step),location.origin);
    if(url.origin!==location.origin || url.pathname!=='/page.php')throw new Error('Invalid Torn OC request.');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    const body=fields?new FormData():undefined;
    if(fields)for(const [key,value]of Object.entries(fields))body.append(key,String(value));
    try {
      const response=await page.fetch(url.href,{method:body?'POST':'GET',body,credentials:'same-origin',cache:'no-store',headers:{'X-Requested-With':'XMLHttpRequest'},signal:controller.signal});
      if(!response.ok)throw new Error('Torn OC page HTTP '+response.status);
      const data=await response.json();
      if(data?.success!==true || data.redirect || data.bh_redirect)throw new Error('Torn could not provide a fresh OC list. Reload Torn and retry.');
      return data;
    }finally{clearTimeout(timer);}
  }
  function plannerPageMembers(data) {
    if(!Array.isArray(data.users))throw new Error('Unassigned member list is incomplete.');
    const result=data.users.map(row=>({id:String(row.userID),name:String(row.name || row.userID),is_in_oc:false,ocEligible:true}));
    if(result.some(m=>!/^[1-9]\d*$/.test(m.id)) || new Set(result.map(m=>m.id)).size!==result.length)throw new Error('Unassigned member list is invalid.');
    return result.sort((a,b)=>Number(a.id)-Number(b.id));
  }
  function plannerPageCrime(raw,secondsPerSlot=0) {
    if(!/^[1-9]\d*$/.test(String(raw?.ID)) || !raw.scenario?.name || !Number.isInteger(Number(raw.scenario.level)) || !Array.isArray(raw.playerSlots) || !raw.playerSlots.length)throw new Error('An OC record is incomplete.');
    if(['failed','success','expired'].includes(raw.phaseStatus))return null;
    if(!['recruiting','active','paused','initiating','member-unavailable','item-missing','expiring','in-progress'].includes(raw.phaseStatus))throw new Error('Unknown OC phase.');
    const slots=raw.playerSlots.map(slot=>{
      if(typeof slot.name!=='string' || !slot.name.trim() || slot.player===undefined)throw new Error('An OC role is unreadable.');
      const user=slot.player===null?null:{id:String(slot.player.ID || slot.player.userID || slot.player.id || ''),name:String(slot.player.name || slot.player.username || slot.player.ID || '')};
      if(user && !/^[1-9]\d*$/.test(user.id))throw new Error('An OC occupant is unreadable.');
      return {position:slot.name,position_info:{label:slot.name},user,planningPercent:user && typeof slot.player.spentPercent==='number' && Number.isFinite(slot.player.spentPercent) && slot.player.spentPercent>=0 && slot.player.spentPercent<=100?slot.player.spentPercent:null,planningState:typeof slot.type==='string'?slot.type:null};
    });
    const full=slots.every(s=>s.user!==null),end=plannerEpoch(raw.endTime);
    // Retain running crews as occupied, without forecasting their release.
    if(raw.phaseStatus==='in-progress' && !full)throw new Error('An in-progress OC has unreadable occupancy. Retry the scan.');
    return {id:String(raw.ID),name:raw.scenario.name,difficulty:Number(raw.scenario.level),status:full?'planning':'recruiting',isExpiring:raw.phaseStatus==='expiring',planningPhase:raw.phaseStatus,planningSecondsPerSlot:secondsPerSlot,planningObservedAt:Date.now(),slots,pageScan:true,ready_at:full && ['active','initiating'].includes(raw.phaseStatus)?end:0,expired_at:!full && end>0?(raw.phaseStatus==='expiring'?end:secondsPerSlot>0?Math.max(0,end-slots.filter(s=>!s.user).length*secondsPerSlot):0):0};
  }
  async function collectFreshPlannerPage() {
    const roster=blRequireRoster(),viewer=String(getViewerId() || ''),startedAt=Date.now();
    if(roster.viewerId!==viewer || roster.factionId!=='50888')throw new Error('Verify Black Ledger membership first.');
    const [metadata,beforeData]=await Promise.all([tornOCPageRequest('metaData'),tornOCPageRequest('usersNotInvolved')]);
    const secondsPerSlot=Number(metadata.data?.secondsPerSlot);
    if(!Number.isFinite(secondsPerSlot) || secondsPerSlot<=0)throw new Error('OC timer metadata is unavailable.');
    const before=plannerPageMembers(beforeData);
    async function collect() {
      const results=await Promise.all(['Recruiting','Planning'].map(async group=>{
        const crimes=new Map();
        let startFrom=0;const cursors=new Set();
        for(let page=0;page<30;page++) {
          if(cursors.has(startFrom))throw new Error('OC pagination repeated. Retry the scan.');cursors.add(startFrom);
          const result=await tornOCPageRequest('crimeList',{group,startFrom});
          if(!Array.isArray(result.data))throw new Error('An OC page is incomplete.');
          for(const raw of result.data) {
            const crime=plannerPageCrime(raw,secondsPerSlot);if(!crime)continue;
            const existing=crimes.get(crime.id);
            if(existing && JSON.stringify(existing)!==JSON.stringify(crime))throw new Error('An OC changed during the scan. Retry.');
            crimes.set(crime.id,crime);
          }
          if(!result.data.length)break;
          const next=Number(result.nextStartFrom);
          if(!Number.isSafeInteger(next) || next<=startFrom)throw new Error('OC pagination is incomplete. Retry the scan.');
          startFrom=next;
          if(page===29)throw new Error('Too many OC pages. No partial scan was used.');
        }
        return [...crimes.values()];
      }));
      const crimes=new Map();
      for(const crime of results.flat()){
        const existing=crimes.get(crime.id);
        if(existing && JSON.stringify(existing)!==JSON.stringify(crime))throw new Error('An OC changed during the scan. Retry.');
        crimes.set(crime.id,crime);
      }
      return [...crimes.values()].sort((a,b)=>Number(a.id)-Number(b.id));
    }
    const first=await collect();
    // Re-read occupancy while allowing member progress to advance normally.
    const crimes=await collect(),after=plannerPageMembers(await tornOCPageRequest('usersNotInvolved'));
    const identity=rows=>JSON.stringify(rows.map(({planningPhase,planningSecondsPerSlot,planningObservedAt,...crime})=>({...crime,slots:crime.slots.map(({planningPercent,planningState,...slot})=>slot),planningPhase})));
    if(identity(first)!==identity(crimes) || JSON.stringify(before.map(m=>m.id))!==JSON.stringify(after.map(m=>m.id)))throw new Error('OC membership changed during the scan. Retry; no partial plan was published.');
    if(Date.now()-startedAt>60000)throw new Error('The scan took too long. Retry for fresh data.');
    const latest=blRequireRoster();if(latest.viewerId!==viewer || latest.factionId!==roster.factionId || latest.memberIds.slice().sort().join(',')!==roster.memberIds.slice().sort().join(','))throw new Error('Faction membership changed during the scan. Retry.');
    const members=new Map(after.map(m=>[m.id,m])),occupied=new Set();
    for(const crime of crimes)for(const slot of crime.slots)if(slot.user) {
      if(members.has(slot.user.id) || occupied.has(slot.user.id))throw new Error('Conflicting OC occupancy. Retry the scan.');
      occupied.add(slot.user.id);members.set(slot.user.id,{...slot.user,is_in_oc:true,ocEligible:true});
    }
    const live=getRosterSnapshot(),positions=live?.members || [];
    for(const member of positions)if(/^recruit$/i.test(member.position) && !members.has(String(member.id)))members.set(String(member.id),{id:String(member.id),name:member.name || String(member.id),is_in_oc:false,ocEligible:false});
    const missing=roster.memberIds.filter(id=>!members.has(id)),extra=[...members.keys()].filter(id=>!roster.memberIds.includes(id));
    if(missing.length || extra.length)throw new Error(`The full OC list and verified faction roster disagree. Verified: ${roster.memberIds.length}; accounted for: ${members.size} (${after.length} unassigned, ${occupied.size} occupied, ${members.size-after.length-occupied.size} excluded recruits). Missing IDs: ${missing.join(', ') || 'none'}. Outside-roster IDs: ${extra.join(', ') || 'none'}. Refresh membership and retry. No partial plan was used.`);
    return {version:1,complete:true,scannedAt:Date.now(),scanStartedAt:startedAt,source:'Fresh Torn page requests · both lists checked twice',members:[...members.values()].sort((a,b)=>Number(a.id)-Number(b.id)),crimes};
  }
  async function sharedPlannerRequest(method='GET',body) {
    const roster=blRequireRoster(),viewer=String(getViewerId() || ''),token=sharedToken();
    if(!token || roster.factionId!=='50888')throw new Error('Configure shared CPR Manager access and verify Black Ledger membership first.');
    const response=await plannerSnapshotRequest(method,body,token);
    if(viewer!==String(getViewerId() || '') || token!==sharedToken() || blRequireRoster().factionId!==roster.factionId)throw new Error('Account changed during shared scan.');
    return response;
  }
  function sharedPlannerObservation(memberId,crime,role,includeStale=false) {
    const state=plannerInputContext;
    let index=sharedPlannerProfileMemo.get(state);
    if(!index){
      index=new Map();
      for(const profile of state.profiles){
        const key=String(profile.user_id)+'|'+normalize(profile.crime);
        if(!index.has(key))index.set(key,[]);
        index.get(key).push(profile);
      }
      sharedPlannerProfileMemo.set(state,index);
    }
    const rows=index.get(String(memberId)+'|'+normalize(crime)) || [];
    const wanted=normalize(role);
    let row=rows.find(p=>normalize(p.role)===wanted),estimated=false;
    if(!row && /\d+$/.test(wanted)){row=rows.find(p=>normalize(p.role)===wanted.replace(/\d+$/,''));estimated=!!row;}
    if(!row || row.latest_cpr===null)return null;
    const cpr=Number(row.latest_cpr),time=Date.parse(row.last_observed_at),age=state.scannedAt-time;
    if(!Number.isFinite(cpr) || cpr<0 || cpr>100 || !Number.isFinite(age) || age<0)return null;
    const stale=age>PLANNER_MAX_AGE;if(stale&&!includeStale)return null;
    return {cpr,source:'Shared server CPR',kind:estimated?'Estimated':'Observed',seen:time,stale,confidence:stale?'Low · stale':estimated?'Low':age>14*86400000?'Medium':'High'};
  }
  function acceptSharedPlanner(row) {
    if(!row || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision)<1 || !row.snapshot?.complete || row.snapshot.version!==1 || !Array.isArray(row.snapshot.members) || !Array.isArray(row.snapshot.crimes) || !Array.isArray(row.snapshot.profiles) || !row.snapshot.prefs || !row.snapshot.weights || !row.snapshot.targetPolicy || !Number.isFinite(row.snapshot.scannedAt) || row.snapshot.scannedAt>Date.now()+60000)throw new Error('Shared scan is unreadable.');
    const viewer=String(getViewerId() || ''),roster=blRequireRoster();
    if(roster.factionId!=='50888' || row.snapshot.members.map(m=>String(m.id)).sort().join(',')!==roster.memberIds.slice().sort().join(','))throw new Error('Shared scan membership differs from this device. Refresh roster sync and retry.');
    const previousState=plannerState;
    plannerState={...row.snapshot,shared:true,revision:Number(row.revision),factionId:'50888',viewerId:viewer,factionName:'Shared Scan'};
    if(typeof refreshAutomaticInvitationReleases==='function')plannerState.autoReleasedInvitations=refreshAutomaticInvitationReleases(plannerState,previousState);
    refreshPlannerSpawnReview(plannerState,{...plannerState.prefs,spawnBudget:applyLiveScopeBudget(plannerState.prefs)});
    const savedPrefs=readJSON(PLANNER_PREFS,{});
    if(!savedPrefs.pendingScan)blStorageSet(PLANNER_PREFS,JSON.stringify({...savedPrefs,...row.snapshot.prefs}));
    // The shared service owns the snapshot; keep the accepted revision in memory.
    // No code reads a persistent duplicate, and saving it can exhaust PDA storage.
    plannerError='';
    if(typeof prunePlanningItemsCache==='function')prunePlanningItemsCache(plannerState.crimes);
  }
  async function refreshSharedPlanner(preferences=null) {
    if(sharedPlannerBusy)return;
    if(!preferences && readJSON(PLANNER_PREFS,{}).pendingScan)preferences=readJSON(PLANNER_PREFS,{});
    if(!managerPageActive())throw new Error('Open and focus the OC page before scanning.');
    sharedPlannerBusy=true;plannerBusy=true;plannerError='';renderPlannerIfOpen();
    try {
      if(readJSON(PLANNER_PREFS,{}).management!==true)throw new Error('Enable roster planning in Settings to confirm that you manage faction OCs.');
      if(typeof PLANNER_KEY!=='undefined' && /^[a-zA-Z0-9]{16}$/.test(String(GM_getValue(PLANNER_KEY,'')).trim()) && !recentPlannerMembership())await refreshTornMembership(true);
      const current=await sharedPlannerRequest();
      // A user-requested fresh scan must observe spawns even within the shared cache window.
      const fresh=await collectFreshPlannerPage();
      const prefs=preferences || current.snapshot?.snapshot.prefs || readJSON(PLANNER_PREFS,{});
      fresh.prefs={levels:plannerSelectedLevels(prefs).sort((a,b)=>a-b),includeStale:prefs.includeStale===true,spawnBudget:applyLiveScopeBudget(prefs,fresh.crimes)};
      fresh.weights=current.snapshot?.snapshot.weights || plannerWeights();fresh.targetPolicy=current.snapshot?.snapshot.targetPolicy || mainTargetPolicy();
      const result=await sharedPlannerRequest('PUT',{base_revision:Number(current.snapshot?.revision || 0),snapshot:fresh});
      blStorageSet(PLANNER_PREFS,JSON.stringify({...readJSON(PLANNER_PREFS,{}),pendingScan:false}));
      acceptSharedPlanner(result.snapshot);
    }catch(error){plannerState=null;plannerError=String(error.message || 'Shared scan failed. No partial plan shown.');}
    finally{sharedPlannerBusy=false;plannerBusy=false;renderPlannerIfOpen();}
  }
  async function pullSharedPlanner() {
    if(sharedPlannerPullBusy || sharedPlannerBusy || plannerBusy || !managerPageActive() || !sharedToken() || !blRoster() || readJSON(PLANNER_PREFS,{}).management!==true)return;
    sharedPlannerPullBusy=true;
    try {const result=await sharedPlannerRequest();if(sharedPlannerBusy || plannerBusy)return;if(result.snapshot && Date.now()-result.snapshot.snapshot.scannedAt<5*60000 && (!plannerState?.shared || Number(result.snapshot.revision)>plannerState.revision)){acceptSharedPlanner(result.snapshot);renderPlannerIfOpen();}}catch(_){}finally{sharedPlannerPullBusy=false;}
  }

  installMessageHistorySync();
  installMessageSendClaims();
  // Keep membership checks running while mailing, even when the OC tab is closed.
  function installComposeMembershipRefresh() {
    let busy=false,lastAttempt=0;
    const commit=(viewer,factionId,ids,source='torn-api')=>{
      if(viewer!==blViewer())throw new Error('Account changed during membership check.');
      const old=blRoster(),r={version:1,ready:false,viewerId:viewer,factionId:String(factionId),memberIds:ids,checkedAt:Date.now(),source};
      blStorageSet('black-ledger-verified-roster-v1',JSON.stringify(r));
      blCleanLocal(r,!!old && old.factionId!==r.factionId);
      r.ready=true;blStorageSet('black-ledger-verified-roster-v1',JSON.stringify(r));
      window.dispatchEvent(new Event('black-ledger-roster-updated'));
    };
    async function refresh(){
      if(busy || document.visibilityState!=='visible' || !document.hasFocus() || Date.now()-lastAttempt<60000)return;
      const key=String(GM_getValue(PLANNER_KEY,'')).trim(),old=blRoster();
      if(old && Date.now()-old.checkedAt<300000)return;
      busy=true;lastAttempt=Date.now();
      try{
        if(/^[a-zA-Z0-9]{16}$/.test(key)){await verifyMembershipOnly(commit);return;}
        const rosterKey=String(GM_getValue('black-ledger-tornstats-roster-key-v1','')).trim();
        const factionId=String(GM_getValue('black-ledger-tornstats-faction-v1','') || old?.factionId || '');
        if(!rosterKey || GM_getValue('black-ledger-manager-roster-terms-v1',null)?.version!==1 || !/^[1-9]\d*$/.test(factionId))return;
        const viewer=blViewer();if(!viewer)return;
        const data=await new Promise((resolve,reject)=>GM_xmlhttpRequest({method:'GET',url:`https://www.tornstats.com/api/v2/${encodeURIComponent(rosterKey)}/spy/faction/${factionId}`,headers:{Accept:'application/json'},timeout:15000,onload:r=>{
          try{const data=typeof r.responseText==='string'?JSON.parse(r.responseText):r.response;
            if(r.status<200 || r.status>=300 || data?.status!==true)throw new Error('Membership request failed.');resolve(data);
          }catch(error){reject(error);}},onerror:()=>reject(new Error('Membership connection failed.')),ontimeout:()=>reject(new Error('Membership request timed out.'))}));
        if(String(GM_getValue('black-ledger-tornstats-roster-key-v1','')).trim()!==rosterKey || GM_getValue('black-ledger-manager-roster-terms-v1',null)?.version!==1 || blViewer()!==viewer || String(GM_getValue('black-ledger-tornstats-faction-v1','') || blRoster()?.factionId || '')!==factionId)throw new Error('Membership settings changed.');
        commit(viewer,factionId,tornStatsLiveRoster(data,factionId,viewer).map(m=>m.id).sort(),'tornstats-live-v2');
      }catch(_){/* Retain the last roster; the mailing guard blocks expired verification. */}
      finally{busy=false;}
    }
    refresh();setInterval(refresh,60000);
    window.addEventListener('focus',refresh);
    document.addEventListener('visibilitychange',refresh);
  }
  if(location.pathname==='/messages.php'){installComposeMembershipRefresh();return;}

  function drawDiagnostic() {
    if (!MANAGER_DIAGNOSTIC || !document.body || !isOcRouteForLauncher() || !useFloatingManagerLauncher()) return;
    if(!document.getElementById('blom-startup-diagnostic-style')) {
      const style=document.createElement('style');style.id='blom-startup-diagnostic-style';
      style.textContent='#blom-startup-diagnostic{color:#fff!important;-webkit-text-fill-color:#fff!important;background:#152b40!important;border:1px solid #78baff!important;min-height:44px!important;text-shadow:none!important;cursor:pointer}#blom-startup-diagnostic:hover:not(:disabled){background:#306d94!important}#blom-startup-diagnostic:focus-visible{outline:2px solid #ffe39c!important;outline-offset:2px!important}#blom-startup-diagnostic:disabled{color:#b7c9d5!important;-webkit-text-fill-color:#b7c9d5!important;background:#263c49!important;border-color:#607c8d!important}';
      (document.head || document.body).appendChild(style);
    }
    let badge = document.getElementById("blom-startup-diagnostic");
    if (!badge) {
      badge = document.createElement("button");
      badge.id = "blom-startup-diagnostic";
      badge.type = "button";
      badge.style.cssText = "position:fixed;left:8px;top:8px;z-index:2147483647;background:#152b40;color:#fff;-webkit-text-fill-color:#fff;padding:8px;border:1px solid #78baff;border-radius:6px;min-height:44px;max-width:calc(100vw - 16px);font:bold 11px/1.3 sans-serif";
      badge.onclick = () => alert("Black Ledger 1.8.27 diagnostics\n" + managerDiagnostic.stage + "\n" + (managerDiagnostic.errors.join("\n") || "No captured errors"));
      document.body.appendChild(badge);
    }
    const label = "BL 1.8.27 · " + managerDiagnostic.stage + (managerDiagnostic.errors.length ? " / ERROR" : "");
    if (badge.textContent !== label) badge.textContent = label;
    const host=document.getElementById('black-ledger-oc-manager-mobile-host');
    if(host && badge.parentElement!==host)host.appendChild(badge);
    if(host)Object.assign(badge.style,{position:'static',margin:'4px',maxWidth:'100%'});
  }
  function checkpoint(stage) { managerDiagnostic.stage = stage; drawDiagnostic(); }
  function reportManagerError(stage, error) {
    const message = stage + ": " + String(error && error.message || error);
    if (managerDiagnostic.errors.indexOf(message) < 0) managerDiagnostic.errors.push(message);
    console.error("[Black Ledger OC Manager]", message);
    drawDiagnostic();
  }
  if (MANAGER_DIAGNOSTIC) {
    window.addEventListener("error", event => {
      if (event.filename && event.filename.indexOf("black-ledger-manager") >= 0) reportManagerError("runtime", event.error || event.message);
    });
    setTimeout(drawDiagnostic, 0);
  }


  /*
   * PDA-safe emergency launcher.
   *
   * This is deliberately self-contained and does not depend on Manager state,
   * storage, roster/API setup or Smart Role Targets. If this userscript runs at
   * all, the button is created. The normal launcher code can later move this
   * same button beside CPR: Balanced.
   */
  function isOcRouteForLauncher() {
    try {
      if (location.pathname === "/organizedcrimes.php") return true;
      if (location.pathname !== "/factions.php") return false;
      const route = `${location.search} ${location.hash}`.toLowerCase();
      return /(?:tab=crimes|organizedcrimes|organized-crimes|organized crimes|oc=)/.test(route) ||
        !!document.getElementById("oc-smart-target-settings") ||
        !!document.querySelector('[data-oc-id]');
    } catch (_) {
      return false;
    }
  }

  function useFloatingManagerLauncher() {
    return !!(window.flutter_inappwebview || window.__PDA_platformReadyPromise ||
      typeof PDA_httpGet === 'function' || typeof window.PDA_httpGet === 'function' ||
      /Torn\s*PDA/i.test(navigator.userAgent || '') ||
      window.matchMedia?.('(max-width: 600px)').matches);
  }

  function forcePdaLauncher() {
    try {
      if (!document.body) return;
      if (document.getElementById("black-ledger-oc-manager-panel")) return;
      if (!isOcRouteForLauncher()) {
        document.getElementById("black-ledger-oc-manager-launcher")?.remove();
        document.getElementById("black-ledger-oc-manager-mobile-host")?.remove();
        document.getElementById("blom-startup-diagnostic")?.remove();
        return;
      }
      let button = document.getElementById("black-ledger-oc-manager-launcher");
      if (!button) {
        button = document.createElement("button");
        button.id = "black-ledger-oc-manager-launcher";
        button.type = "button";
        button.textContent = "📊 OC Manager";
        button.setAttribute("aria-label", "Open Black Ledger OC Manager");
        button.addEventListener("click", () => {
          try {
            openManager();
          } catch (error) {
            const message = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
            reportManagerError("open panel", error);
            alert("Black Ledger OC Manager error:\n\n" + message);
          }
        });
      }
      if (!button.isConnected) document.body.appendChild(button);
      Object.assign(button.style, {
        position: "fixed",
        right: "12px",
        bottom: "calc(84px + env(safe-area-inset-bottom, 0px))",
        zIndex: "2147483647",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        visibility: "visible",
        opacity: "1",
        border: "1px solid rgba(74,144,226,.9)",
        borderRadius: "14px",
        padding: "7px 11px",
        background: "rgba(25,64,98,.96)",
        color: "#fff",
        webkitTextFillColor: "#fff",
        minHeight: "44px",
        maxWidth: "calc(100vw - 24px)",
        fontSize: "12px",
        fontWeight: "700",
        lineHeight: "1.2",
        cursor: "pointer"
      });
      if(useFloatingManagerLauncher()) {
        // Prefer normal page flow: fixed positioning can fall below the visible
        // area of PDA's zoomed/embedded webview or behind its native toolbar.
        const settings=document.getElementById('oc-smart-target-settings');
        const crime=document.querySelector('[data-oc-id]');
        const visible=el=>!!(el && el.getClientRects?.().length &&
          (!window.getComputedStyle || window.getComputedStyle(el).visibility!=='hidden'));
        const anchor=visible(settings)?settings:visible(crime)?crime:null;
        if(anchor && anchor.parentElement) {
          let host=document.getElementById('black-ledger-oc-manager-mobile-host');
          if(!host){host=document.createElement('div');host.id='black-ledger-oc-manager-mobile-host';}
          host.style.cssText='display:flex!important;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px;box-sizing:border-box;width:100%;padding:6px 0;clear:both;background:#182126;color:#fff;-webkit-text-fill-color:#fff;border:1px solid #385769;border-radius:6px;margin:8px 0';
          if(host.parentElement!==anchor.parentElement || host.nextSibling!==anchor)anchor.parentElement.insertBefore(host,anchor);
          if(button.parentElement!==host)host.appendChild(button);
          Object.assign(button.style,{position:'static',right:'auto',bottom:'auto',margin:'4px'});
        } else if(button.parentElement!==document.body) {
          document.body.appendChild(button);
        }
        drawDiagnostic();
      }
    } catch (error) { reportManagerError("launcher", error); }
  }

  // Register recovery before storage, roster and network startup can fail.
  // A PDA route rebuild must not depend on init() reaching its final timers.
  function recoverManagerLauncher() {
    try { launcherBootstrap(); }
    catch (_) { forcePdaLauncher(); }
    drawDiagnostic();
  }
  /*
   * Black Ledger OC Manager
   *
   * Leadership companion for Smart Role Targets. It reads local/shared CPR and
   * loaded OC data for roster planning; it also captures anonymous completed OC history.
   */

  const CPR_DATA_KEY =
    "hf-cached-local-oc-data";

  const CPR_LEVEL_KEY =
    "hf-oc-level-data";

  const MANAGER_META_KEY =
    "black-ledger-oc-manager-meta-v2";

  const MANAGER_ENABLED_KEY =
    "black-ledger-oc-manager-enabled-v1";

  const STYLE_ID =
    "black-ledger-oc-manager-style";

  const PANEL_ID =
    "black-ledger-oc-manager-panel";

  const LAUNCHER_ID =
    "black-ledger-oc-manager-launcher";

  const FALLBACK_HOST_ID =
    "black-ledger-oc-manager-host";

  /*
   * This is the ID used by the current
   * Black Ledger OC Smart Role Targets script.
   */
  const SMART_SETTINGS_ID =
    "oc-smart-target-settings";

  /*
   * Launcher bootstrap.
   *
   * Torn PDA can expose the OC page before the rest of this large manager has
   * finished initialising. Older builds only created the launcher near the end
   * of init(), so any unrelated startup error could leave the Manager usable
   * in theory but with no button. Start a tiny, self-healing launcher loop as
   * soon as the script itself begins. Function declarations are hoisted, so
   * placeLauncher/openManager are safe to reference here.
   */
  const launcherBootstrap = () => {
    try { placeLauncher(); } catch (error) {
      reportManagerError("launcher placement", error);
      forcePdaLauncher();
    }
  };

  const DEFAULT_TARGET = 60;

  const ROSTER_KEY_STORAGE =
    "black-ledger-tornstats-roster-key-v1";
  const ROSTER_SNAPSHOT_KEY =
    "black-ledger-active-roster-v1";
  const ROSTER_LAST_RESULT_KEY =
    "black-ledger-roster-last-result-v1";
  const ROSTER_REFRESH_MS =
    5 * 60 * 1000;
  const SYNC_QUEUE_KEY =
    "black-ledger-cpr-sync-queue-v1";
  const SYNC_DEVICE_KEY =
    "black-ledger-cpr-device-id-v1";
  const SYNC_LAST_RESULT_KEY =
    "black-ledger-cpr-sync-last-result-v1";
  const SYNC_FINGERPRINT_KEY =
    "black-ledger-cpr-sync-fingerprints-v1";
  const SYNC_ENDPOINT =
    "https://shcecvzxdknpulytekcl.supabase.co/functions/v1/black-ledger-sync";
  const SYNC_BATCH_SIZE = 100;

  const MAX_Z_INDEX =
    2147483647;

  const DIFFICULTY_TIERS = {
    1: "introductory",
    2: "simple",
    3: "intermediate",
    4: "advanced",
    5: "elaborate"
  };

  const BAD_NAMES =
    new Set([
      "view profile",
      "profile",
      "view",
      "member",
      "player",
      "user",
      "details",
      "open profile",
      "unknown member",
      "avatar",
      "user avatar",
      "player avatar",
      "profile picture"
    ]);

  /*
   * ============================================================
   * LEVEL 7 / 8 CRIMES
   * ============================================================
   */

  const OC_DEFS = {
  "Blast From The Past": {
    "level": 7,
    "roles": {
      "Picklock1": 10.84876785,
      "Hacker": 12.05662038,
      "Engineer": 24.0155975,
      "Bomber": 15.61710346,
      "Muscle": 34.58815764,
      "Picklock2": 2.873753178
    }
  },
  "Window of Opportunity": {
    "level": 7,
    "roles": {
      "Engineer": 14.55335487209706,
      "Looter1": 19.544697437213543,
      "Looter2": 25.802321762790502,
      "Muscle1": 23.086816638821606,
      "Muscle2": 17.012809289077286
    }
  },
  "Cleared for Takeoff": {
    "level": 7,
    "roles": {
      "Imitator": 24.939007667714826,
      "Techie": 11.316435057348194,
      "Pickpocket": 12.032038349844655,
      "Lookout": 8.372798960106097,
      "Assassin": 18.15580375759352,
      "Interrogator": 25.183916207392716
    }
  },
  "Break the Bank": {
    "level": 8,
    "roles": {
      "Robber": 12.69693448,
      "Muscle1": 13.51973049,
      "Muscle2": 10.10353513,
      "Thief1": 2.930695727,
      "Muscle3": 31.65263066,
      "Thief2": 29.09647352
    }
  },
  "Clinical Precision": {
    "level": 8,
    "roles": {
      "Imitator": 43.31533431,
      "CatBurglar": 18.93905648,
      "Assassin": 16.0581518,
      "Cleaner": 21.68745741
    }
  },
  "Stacking the Deck": {
    "level": 8,
    "roles": {
      "CatBurglar": 23.43294188,
      "Driver": 2.956670602,
      "Hacker": 25.43825688,
      "Imitator": 48.17213064
    }
  },
  "Lock Stock": {
    "level": 8,
    "roles": {
      "Assassin": 40.26601835937421,
      "Smuggler": 17.442378565297464,
      "Hacker": 18.407618259403492,
      "Muscle1": 11.941992407962427,
      "Muscle2": 11.941992407962427
    }
  },
  "Manifest Cruelty": {
    "level": 8,
    "roles": {
      "Hacker": 16.32001273063874,
      "Interrogator": 23.492099324887565,
      "Reviver": 46.27406770738405,
      "CatBurglar": 13.913820237089643
    }
  }
};

  /*
   * ============================================================
   * STATE
   * ============================================================
   */

  /* Role-weight snapshot: TornProbability; shared API approach inspired by
   * JohnNash, Torn OC Weights Under Roles (Greasy Fork script 547973). */
  const PLANNER_OC_DEFS = {
  "Mob Mentality": {
    "level": 1,
    "roles": {
      "Looter1": 33.96650646,
      "Looter2": 26.48850715,
      "Looter3": 18.36444021,
      "Looter4": 21.18054618
    }
  },
  "Pet Project": {
    "level": 1,
    "roles": {
      "Kidnapper": 30.92676727,
      "Muscle": 32.62884615,
      "Picklock": 36.44438658
    }
  },
  "First Aid and Abet": {
    "level": 1,
    "roles": {
      "Picklock": 26.040303247907904,
      "Decoy": 30.73072727408889,
      "Pickpocket": 43.228969478003215
    }
  },
  "Cash Me If You Can": {
    "level": 2,
    "roles": {
      "Thief1": 54.18134868,
      "Thief2": 28.04221236,
      "Lookout": 17.77643896
    }
  },
  "Best of the Lot": {
    "level": 2,
    "roles": {
      "Picklock": 20.73368395,
      "CarThief": 19.5328795,
      "Muscle": 43.67657367,
      "Imitator": 16.05686289
    }
  },
  "Market Forces": {
    "level": 3,
    "roles": {
      "Enforcer": 29.4020952,
      "Negotiator": 27.22899702,
      "Lookout": 16.36647471,
      "Arsonist": 4.456390991,
      "Muscle": 22.54604208
    }
  },
  "Smoke and Wing Mirrors": {
    "level": 3,
    "roles": {
      "CarThief": 50.89511253,
      "Imitator": 27.10752487,
      "Hustler1": 9.000400474,
      "Hustler2": 12.99696212
    }
  },
  "Gaslight the Way": {
    "level": 3,
    "roles": {
      "Imitator1": 9.394999578,
      "Imitator2": 27.46467248,
      "Imitator3": 41.32194207,
      "Looter1": 9.394999578,
      "Looter2": 0,
      "Looter3": 12.42374256
    }
  },
  "Stage Fright": {
    "level": 4,
    "roles": {
      "Enforcer": 15.67090339,
      "Muscle1": 20.01365691,
      "Muscle2": 2.659259022,
      "Muscle3": 9.165081208,
      "Lookout": 6.188888612,
      "Sniper": 46.30221086
    }
  },
  "Snow Blind": {
    "level": 4,
    "roles": {
      "Hustler": 48.40533937,
      "Imitator": 34.56895649,
      "Muscle1": 8.512932288,
      "Muscle2": 8.512771845
    }
  },
  "Plucking the Lotus Petal": {
    "level": 4,
    "roles": {
      "Robber1": 14.027682053942709,
      "Hustler": 14.394494084394903,
      "Robber2": 23.680942608167083,
      "Muscle": 47.89688125349531
    }
  },
  "Leave No Trace": {
    "level": 6,
    "roles": {
      "Techie": 29.01099583,
      "Negotiator": 34.1307307,
      "Imitator": 36.85827347
    }
  },
  "No Reserve": {
    "level": 5,
    "roles": {
      "CarThief": 30.50667524,
      "Techie": 38.37053402,
      "Engineer": 31.12279075
    }
  },
  "Counter Offer": {
    "level": 5,
    "roles": {
      "Robber": 35.94505104,
      "Looter": 6.998750427,
      "Hacker": 12.1275068,
      "Picklock": 16.5353262,
      "Engineer": 28.39336554
    }
  },
  "Guardian Angels": {
    "level": 5,
    "roles": {
      "Enforcer": 27.404376861170505,
      "Hustler": 42.10252351813381,
      "Engineer": 30.49309962016114
    }
  },
  "Honey Trap": {
    "level": 5,
    "roles": {
      "Enforcer": 26.98428598,
      "Muscle1": 30.86556191,
      "Muscle2": 42.15015211
    }
  },
  "Bidding War": {
    "level": 6,
    "roles": {
      "Robber1": 7.100963041,
      "Driver": 12.5356157,
      "Robber2": 22.87302433,
      "Robber3": 31.67051915,
      "Bomber1": 7.846987259,
      "Bomber2": 17.97289051
    }
  },
  "Sneaky Git Grab": {
    "level": 6,
    "roles": {
      "Imitator": 17.539756110007634,
      "Pickpocket": 50.831934101247086,
      "Hacker": 14.481791981545502,
      "Techie": 17.146517807199775
    }
  },
  "Blast From The Past": {
    "level": 7,
    "roles": {
      "Picklock1": 10.84876785,
      "Hacker": 12.05662038,
      "Engineer": 24.0155975,
      "Bomber": 15.61710346,
      "Muscle": 34.58815764,
      "Picklock2": 2.873753178
    }
  },
  "Break the Bank": {
    "level": 8,
    "roles": {
      "Robber": 12.69693448,
      "Muscle1": 13.51973049,
      "Muscle2": 10.10353513,
      "Thief1": 2.930695727,
      "Muscle3": 31.65263066,
      "Thief2": 29.09647352
    }
  },
  "Ship Happens": {
    "level": 8,
    "roles": {
      "Assassin": 10.3,
      "Engineer": 13.3,
      "Hustler": 19.7,
      "Interrogator": 31.3,
      "Spy": 25.4
    }
  },
  "Stacking the Deck": {
    "level": 8,
    "roles": {
      "CatBurglar": 23.43294188,
      "Driver": 2.956670602,
      "Hacker": 25.43825688,
      "Imitator": 48.17213064
    }
  },
  "Clinical Precision": {
    "level": 8,
    "roles": {
      "Imitator": 43.31533431,
      "CatBurglar": 18.93905648,
      "Assassin": 16.0581518,
      "Cleaner": 21.68745741
    }
  },
  "Manifest Cruelty": {
    "level": 8,
    "roles": {
      "Hacker": 16.32001273063874,
      "Interrogator": 23.492099324887565,
      "Reviver": 46.27406770738405,
      "CatBurglar": 13.913820237089643
    }
  },
  "Lock Stock": {
    "level": 8,
    "roles": {
      "Assassin": 40.26601835937421,
      "Smuggler": 17.442378565297464,
      "Hacker": 18.407618259403492,
      "Muscle1": 11.941992407962427,
      "Muscle2": 11.941992407962427
    }
  },
  "Ace in the Hole": {
    "level": 9,
    "roles": {
      "Imitator": 21.07540412,
      "Muscle1": 18.29831955,
      "Muscle2": 24.65084339,
      "Hacker": 28.3434151,
      "Driver": 7.632017841
    }
  },
  "Gone Fission": {
    "level": 9,
    "roles": {
      "Hijacker": 24.93974876222353,
      "Engineer": 15.565232594311826,
      "Pickpocket": 16.53377808965346,
      "Imitator": 24.93974876222354,
      "Bomber": 18.021491791587643
    }
  },
  "Hostile Takeover": {
    "level": 9,
    "roles": {
      "Hacker": 11.154471089082223,
      "Engineer": 15.240409558114203,
      "CatBurglar": 16.003004887681396,
      "Kidnapper": 12.980809844427426,
      "Negotiator": 23.952564641966315,
      "Muscle": 20.668739978728432
    }
  },
  "Cleared for Takeoff": {
    "level": 7,
    "roles": {
      "Imitator": 24.939007667714826,
      "Techie": 11.316435057348194,
      "Pickpocket": 12.032038349844655,
      "Lookout": 8.372798960106097,
      "Assassin": 18.15580375759352,
      "Interrogator": 25.183916207392716
    }
  },
  "Crane Reaction": {
    "level": 10,
    "roles": {
      "Sniper": 40.73886856841122,
      "Lookout": 16.623960934255475,
      "Engineer": 8.286087919744741,
      "Bomber": 15.8901690506963,
      "Muscle1": 10.683294142974866,
      "Muscle2": 7.777619383917385
    }
  },
  "Window of Opportunity": {
    "level": 7,
    "roles": {
      "Engineer": 14.55335487209706,
      "Looter1": 19.544697437213543,
      "Looter2": 25.802321762790502,
      "Muscle1": 23.086816638821606,
      "Muscle2": 17.012809289077286
    }
  },
  "Thou Shalt Not Steal": {
    "level": 2,
    "roles": {
      "Thief": 12.396646686195815,
      "Pickpocket": 37.856826197979196,
      "Picklock": 49.74652711582499
    }
  },
  "Dish It Out": {
    "level": 6,
    "roles": {
      "Assassin": 37.3380808914086,
      "Muscle": 25.243817634035594,
      "Saboteur1": 14.639223669899579,
      "Saboteur2": 8.911747057590532,
      "Engineer": 13.867130747065687
    }
  }
};

  const SHARED_TOKEN_KEY='black-ledger-manager-read-token-v1';
  const SHARED_CACHE_KEY='black-ledger-manager-shared-cache-v1';
  const SHARED_REFRESH_MS=5*60000;
  const SHARED_EXPORT_URL='https://shcecvzxdknpulytekcl.supabase.co/functions/v1/black-ledger-export';
  let sharedBusy=false, sharedError='', sharedCache=null, sharedLastAttempt=0;
  function sharedViewer() {return String(getViewerId() || '');}
  function sharedToken() {return String(GM_getValue(`${SHARED_TOKEN_KEY}:${sharedViewer()}`,'')).trim();}
  let sharedFilterMemo=null;
  function currentSharedCache() {
    const viewer=sharedViewer();
    if(!viewer) return null;
    if(sharedCache?.viewerId!==viewer) sharedCache=GM_getValue(`${SHARED_CACHE_KEY}:${viewer}`,null);
    if(sharedCache?.viewerId!==viewer) return null;
    const roster=blRoster();
    if(sharedFilterMemo?.cache===sharedCache && sharedFilterMemo.index===sharedCache.index &&
       sharedFilterMemo.roster===roster) return sharedFilterMemo.value;
    const index=roster===null ? sharedCache.index : blFilterMap(sharedCache.index,roster || {memberIds:[]});
    const value={...sharedCache,index,count:Object.keys(index || {}).length};
    sharedFilterMemo={cache:sharedCache,index:sharedCache.index,roster,value};
    return value;
  }
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
    try { candidates.push(JSON.parse(blStorageGet(FACTION_TARGET_CACHE) || 'null')); } catch (_) {}
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
    try { blStorageSet(FACTION_TARGET_CACHE, JSON.stringify(policy)); persisted = true; } catch (_) {}
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
  function factionTargetPolicyUIChanged() {
    plannerObservationMembers = null;
    renderPlannerIfOpen();
    if (document.querySelector(`#${PANEL_ID} [data-tab="builder"].active`)) {
      document.querySelector(`#${PANEL_ID} .blom-body`)?.blomRefreshTargets?.();
    }
  }
  function mainTargetOffset() { return factionTargetOffset(); }
  async function saveManagerTargetOffset(value) {
    const text = String(value).trim(), offset = Number(text);
    if (!text || !Number.isInteger(offset) || offset < -10 || offset > 10) return 'Enter a whole number from -10 to +10.';
    if (factionTargetBusy) return 'A policy request is running. Retry in a moment.';
    const token = sharedToken(), viewer = sharedViewer();
    if (!token) return 'Configure shared CPR with an authorised Manager code first.';
    factionTargetBusy = true;
    try {
      const current = cachedFactionTargetPolicy() || await factionTargetRequest();
      const policy = await factionTargetRequest('PUT',{faction_id:FACTION_TARGET_ID,offset,revision:current.revision},token);
      if (token !== sharedToken() || viewer !== sharedViewer()) throw new Error('Account or access code changed. Refresh targets to check the published setting.');
      acceptFactionTargetPolicy(policy); factionTargetError = '';
      return null;
    } catch (error) { factionTargetError = error.message; return error.message; }
    finally { factionTargetBusy = false; }
  }
  function mainTargetPolicy() {
    if(typeof plannerInputContext!=='undefined' && plannerInputContext?.shared)return {...plannerInputContext.targetPolicy,bases:{low:67,middle:67,high:67},overrides:{}};
    const policy=readJSON('black-ledger-target-policy-v1',null);
    if(policy?.schema_version===1 && policy.bases && Number.isFinite(policy.min) && Number.isFinite(policy.max)) return {...policy,bases:{low:67,middle:67,high:67},overrides:{},offset:mainTargetOffset()};
    return {schema_version:1,collector_version:'3.0.4 compatible fallback',offset:mainTargetOffset(),
      bases:{low:67,middle:67,high:67},lowMax:5,middleMax:8,min:50,max:75,overrides:{}};
  }
  function mainScriptTarget(crime,level,weight,roleCount,role) {
    // A shared snapshot fixes definitions and target policy. Matching checks the
    // same role for many people and spawn alternatives; calculate its target once.
    const state=typeof plannerInputContext!=='undefined' && plannerInputContext?.shared?plannerInputContext:null;
    const memo=mainScriptTarget.memo || (mainScriptTarget.memo=new WeakMap());
    let targets;
    const cacheKey=JSON.stringify([crime,level,weight,roleCount,role]);
    if(state){
      targets=memo.get(state);
      if(!targets){targets=new Map();memo.set(state,targets);}
      if(targets.has(cacheKey))return targets.get(cacheKey);
    }
    const target=calculate();
    if(targets)targets.set(cacheKey,target);
    return target;
    function calculate() {
      const policy=mainTargetPolicy();
      const defs=typeof plannerWeights==='function'?plannerWeights():{};
      const definition=Object.entries(defs).find(([name])=>normalize(name)===normalize(crime))?.[1];
      const weights=definition?.roles;

      const base = clamp(67 + policy.offset, 50, 75);
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
  }
  function sharedProfileIndex() {
    return currentSharedCache()?.index || {};
  }
  const recordMemo = new Map();
  function cachedRecordStore(key) {
    const raw=blStorageGet(key) || '{}', roster=blRoster(), old=recordMemo.get(key);
    if(old?.raw===raw && old.roster===roster) return old.data;
    let data;try{data=JSON.parse(raw);}catch(_){data={};}
    data=blFilterStore(key,data,roster);recordMemo.set(key,{raw,roster,data});return data;
  }
  function localLatestObservation(id,crime,role) {
    return cachedRecordStore('black-ledger-cpr-latest-observations-v1')[seenKey(id,crime,role)] || null;
  }
  function freshestCpr(id,crime,role,legacy) {
    const key=seenKey(id,crime,role), remote=sharedProfileIndex()[key], local=localLatestObservation(id,crime,role);
    let datedLocal=local;
    if(!datedLocal) {
      const seen=cachedRecordStore('black-ledger-cpr-last-seen-v1')[key] || meta.seen?.[key];
      const time=typeof seen==='object'?Number(seen?.timestamp_ms)||Date.parse(seen?.observed_at):Date.parse(seen);
      if(Number.isFinite(time)) datedLocal={cpr:Number(legacy),timestamp_ms:time,observed_at:new Date(time).toISOString(),legacy:true};
    }
    if(remote && (!datedLocal || Date.parse(remote.last_observed_at)>Number(datedLocal.timestamp_ms)))
      return {cpr:Number(remote.latest_cpr),timestamp_ms:Date.parse(remote.last_observed_at),observed_at:remote.last_observed_at,source:'Shared',count:remote.observation_count};
    return datedLocal ? {...datedLocal,source:datedLocal.legacy?'Local recorded high':'Local'} : {cpr:Number(legacy),source:'Local recorded high'};
  }
  function mergeManagerMembers(local) {
    const merged=JSON.parse(JSON.stringify(local));
    for(const row of Object.values(sharedProfileIndex())) {
      const id=String(row.user_id), crimes=merged[id] || (merged[id]={});
      const crimeKey=Object.keys(crimes).find(k=>normalize(k)===normalize(row.crime)) || row.crime;
      const roles=crimes[crimeKey] || (crimes[crimeKey]={});
      const roleKey=Object.keys(roles).find(k=>normalize(k)===normalize(row.role)) || row.role;
      roles[roleKey]=freshestCpr(id,crimeKey,roleKey,roles[roleKey]).cpr;
    }
    const latest=cachedRecordStore('black-ledger-cpr-latest-observations-v1');
    for(const [id,crimes] of Object.entries(merged)) for(const [crime,roles] of Object.entries(crimes)) for(const role of Object.keys(roles))
      if(latest[seenKey(id,crime,role)]) roles[role]=freshestCpr(id,crime,role,roles[role]).cpr;
    return merged;
  }
  function sharedTimedAttempt(start,label,timeoutMs=20000) {
    return new Promise((resolve,reject)=>{
      let settled=false,abort=null;
      const timer=setTimeout(()=>{ if(settled)return;settled=true;try{abort?.();}catch(_){}reject(new Error(`${label} timed out`)); },timeoutMs);
      const finish=(error,value)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        if(error){reject(error);return;}
        // Tampermonkey response fields can be non-enumerable getters.
        const snapshot={transport:label};
        for(const key of ['status','responseText','response','body']) {
          try {if(value && value[key]!==undefined)snapshot[key]=value[key];}catch(_){}
        }
        resolve(snapshot);
      };
      try {abort=start(value=>finish(null,value),error=>finish(new Error(`${label}: ${error?.message || String(error || 'connection failed')}`)));}
      catch(error){finish(error);}
    });
  }
  async function requestSharedProfiles(token) {
    const headers={Accept:'application/json','x-black-ledger-dashboard-token':token};
    const native=typeof PDA_httpGet==='function'?PDA_httpGet:typeof window.PDA_httpGet==='function'?window.PDA_httpGet:null;
    const methods=[];
    // Prefer PDA's documented native HTTP bridge over an emulated GM request.
    if(native) methods.push(()=>sharedTimedAttempt((ok,fail)=>{
      Promise.resolve(native(SHARED_EXPORT_URL,headers)).then(ok,fail);
    },'Torn PDA'));
    else if(typeof GM_xmlhttpRequest==='function') methods.push(()=>sharedTimedAttempt((ok,fail)=>{
      const handle=GM_xmlhttpRequest({method:'GET',url:SHARED_EXPORT_URL,headers,timeout:20000,
        onload:ok,onerror:fail,ontimeout:()=>fail(new Error('request timeout')),onabort:()=>fail(new Error('request aborted'))});
      // Some mobile GM implementations also return a Promise.
      if(handle && typeof handle.then==='function') handle.then(value=>{if(value?.status!==undefined)ok(value);},fail);
      return ()=>handle?.abort?.();
    },'Userscript connection'));
    if(typeof fetch==='function') methods.push(()=>sharedTimedAttempt((ok,fail)=>{
      const controller=new AbortController();
      fetch(SHARED_EXPORT_URL,{method:'GET',headers,mode:'cors',credentials:'omit',cache:'no-store',signal:controller.signal})
        .then(async response=>ok({status:response.status,responseText:await response.text()})).catch(fail);
      return ()=>controller.abort();
    },'Browser connection'));
    const failures=[];
    for(let i=0;i<methods.length;i++) {
      if(i){sharedError='First connection failed; trying browser connection…';renderPlannerIfOpen();}
      try {
        const response=await methods[i]();
        if(!(Number(response?.status)>0))throw new Error('No HTTP response received');
        if(Number(response.status)!==200)return response;
        // GM wrappers may expose JSON via response instead of responseText.
        // A status-only response is not a completed download; try the fallback.
        let data;
        for(const body of [response.responseText,response.response,response.body]) {
          if(body && typeof body==='object'){data=body;break;}
          if(typeof body==='string' && body.trim() && body.trim()!=='undefined') {
            try{data=JSON.parse(body);if(data && typeof data==='object')break;}catch(_){}
          }
        }
        if(!data || typeof data!=='object')throw new Error('Connection returned no readable shared CPR data');
        if(data.ok!==true || data.complete!==true || !Array.isArray(data.profiles) || data.count!==data.profiles.length)
          throw new Error('Connection returned incomplete shared CPR data');
        return {...response,data};
      }
      catch(error){failures.push(String(error.message || error));}
    }
    throw new Error(failures.length?`${failures.join('; ')}. Previous shared data retained.`:'No supported connection method. Previous shared data retained.');
  }
  async function refreshSharedData(force=false) {
    if(document.visibilityState!=='visible' || !document.hasFocus())return false;
    if(sharedBusy || !sharedViewer() || !sharedToken()) return false;
    const cache=currentSharedCache(),now=Date.now();
    if(!force && (now-sharedLastAttempt<SHARED_REFRESH_MS || cache && now-cache.fetchedAt<SHARED_REFRESH_MS)) return false;
    const viewer=sharedViewer(),token=sharedToken();sharedBusy=true;sharedError='';sharedLastAttempt=now;renderPlannerIfOpen();
    try {
      const response=await requestSharedProfiles(token);
      if(Number(response.status)!==200) throw new Error(Number(response.status)===401?'Private access code rejected. Configure shared CPR access again.':`Shared CPR HTTP ${response.status}`);
      const data=response.data;
      if(data.ok!==true || data.complete!==true || !Array.isArray(data.profiles) || data.count!==data.profiles.length) throw new Error('Incomplete shared CPR response. Previous cache retained.');
      const index={};
      for(const row of data.profiles) {
        const time=Date.parse(row.last_observed_at),cpr=Number(row.latest_cpr);
        if(!/^\d+$/.test(String(row.user_id)) || !row.crime || !row.role || row.latest_cpr===null || !Number.isFinite(cpr) || cpr<0 || cpr>100 || !Number.isFinite(time) || time>Date.now()+300000) throw new Error('Invalid shared CPR profile. Previous cache retained.');
        if(!blAllowed(row.user_id))continue;
        const key=seenKey(String(row.user_id),row.crime,row.role);
        if(index[key])throw new Error('Duplicate shared profile. Previous cache retained.');index[key]=row;
      }
      if(viewer!==sharedViewer() || token!==sharedToken()) throw new Error('Account or access code changed during refresh.');
      const next={viewerId:viewer,index,fetchedAt:Date.now(),exportedAt:data.exported_at,count:data.count,transport:response.transport};
      GM_setValue(`${SHARED_CACHE_KEY}:${viewer}`,next);sharedCache=next;
      for(const row of Object.values(index)) if(row.user_name && isValidName(row.user_name))meta.names[String(row.user_id)]=row.user_name;
      saveMeta();return true;
    }catch(error){sharedError=String(error.message || 'Shared CPR connection failed. Previous cache retained.');return false;}
    finally{sharedBusy=false;renderPlannerIfOpen();}
  }

  function configureSharedAccess() {
    showTermsDialog('Shared CPR access',managerDataTerms(),()=>configureSharedAccessInput());
  }
  function configureSharedAccessInput() {
    const token=prompt('Paste your private Black Ledger Manager access code (not a Torn API key). Leave blank to disconnect. Keep this code out of the public script.','');
    if(token===null) return;
    const viewer=sharedViewer();if(!viewer){alert('Open Torn while signed in first.');return;}
    GM_setValue(`${SHARED_TOKEN_KEY}:${viewer}`,token.trim());
    if(!token.trim()){GM_setValue(`${SHARED_CACHE_KEY}:${viewer}`,null);sharedCache=null;sharedError='Shared CPR disconnected.';renderPlannerIfOpen();return;}
    sharedCache=null;sharedLastAttempt=0;refreshSharedData(true);
  }
  function sharedStatusText() {
    const cache=currentSharedCache();
    if(sharedBusy) return sharedError || 'Refreshing shared CPR…';
    if(sharedError) return sharedError;
    if(!sharedToken()) return 'Shared CPR disconnected. Configure private access once to receive daily uploads.';
    if(!cache) return 'Shared CPR access configured; no successful download yet.';
    return `${cache.count} shared crime/role records${cache.transport?' · via '+cache.transport:''} · downloaded ${new Date(cache.fetchedAt).toLocaleString('en-GB', {timeZone:'Europe/London', hour12:false})}${Date.now()-cache.fetchedAt>15*60000?' · download is stale':''}. Observation age is checked separately.`;
  }

  // Roster Planner is a read-only Manager feature. Its API key is stored only
  // in this userscript's private GM storage and sent only to api.torn.com.
  const PLANNER_PREFS = 'black-ledger-oc-planner-options-v1';
  const PLANNER_NEWSLETTER_DRAFT_KEY = 'black-ledger-oc-newsletter-draft-v1';
  const PLANNER_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  const PLANNER_FORECAST_HOURS = 24;
  const PLANNER_FORECAST_MS = PLANNER_FORECAST_HOURS * 60 * 60 * 1000;
  let plannerBusy = false;
  let plannerError = '';

  function managerPageActive() {
    return document.visibilityState==='visible' && document.hasFocus() &&
      (location.pathname==='/organizedcrimes.php' ||
       (location.pathname==='/factions.php' && /tab=crimes(?:&|$)/.test(location.hash)));
  }
  function managerTermsTable(storage,sharing,purpose,key,access) {
    return `<div style="overflow-x:auto"><table class="blom-planner-table blom-terms"><thead><tr><th>Data storage</th><th>Data sharing</th><th>Purpose of use</th><th>Key storage &amp; sharing</th><th>Key access level</th></tr></thead><tbody><tr>${[storage,sharing,purpose,key,access].map(v=>`<td>${v}</td>`).join('')}</tr></tbody></table></div>`;
  }
  function managerDataTerms() {
    return managerTermsTable('Verified API scans remove non-members from local data. Shared observations remain on the server; server-side deletion is separate.',
      'Black Ledger operators and holders of authorised manager access. Supabase hosts/processes the database. Access is not a live faction-permission check.',
      'Faction advantage: OC guidance, team coverage and roster planning. No data sales, advertising or real-money charges.',
      'Private manager code stored on this device and sent only to Black Ledger. Torn API keys are never sent to Black Ledger.', 'No Torn API key required.')+
      '<p>The Manager downloads shared member CPR. It also uploads anonymous completed OC history (crime, role CPR, role weights and team outcome) to faction storage when authorised manager access is configured; player identities are excluded. Fresh shared scans upload member IDs/names, OC IDs/roles/occupancy, known finish/expiry times, manually entered Scope balance/reserve/costs and planner settings to faction storage. Spawn advice uses shared historical outcome evidence; historical success is not a prediction for a particular crew. Server CPR is attached to each snapshot so devices use identical inputs; Torn session tokens stay on the device. Confirmed OC messages also sync sender/recipient IDs, OC IDs, roles and send times across your devices; prepared assignment drafts and message queues sync across your devices through Manager access. API keys and active compose/send attempts stay on this device. The collector defaults to sharing ON with a visible Stop sharing control; previous opt-outs are honoured. Ask your faction manager about record removal. Disconnecting clears this device\u2019s shared cache/code, not earlier server records. Script activity stores member player IDs, script versions and first/last seen times for installation support while collector sharing is ON. Never seen is unconfirmed installation. Normal hosting connection logs may be recorded.</p>';
  }
  function plannerAPITerms() {
    return managerTermsTable('Verified membership IDs are retained locally to exclude departed members. A successful API verification or reviewed two-page check deletes non-member CPR, names and PM records on this device. Recommendations expire after five minutes; preparing PMs requires verification within 15 minutes.', 'Nobody: these API responses are not uploaded to Black Ledger or TornStats.',
      'Check current membership for cleanup and PM recipients. OC roles and timers are read from the page.', 'Stored in userscript storage on this device; sent only to Torn using HTTPS. Clear key removes it.',
      'Public access: user basic, user faction and faction members. No faction API permission needed for membership verification. The optional full OC API scan additionally needs faction positions/crimes permissions.');
  }
  async function plannerRequest(path,key) {
    const wait=Math.max(0,apiNextAt-Date.now());apiNextAt=Math.max(Date.now(),apiNextAt)+3500;
    if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
    if(String(GM_getValue(PLANNER_KEY,'')).trim()!==key)throw new Error('API key changed or cleared.');
    const now=Date.now();const cooldown=Number(GM_getValue(API_COOLDOWN_KEY,0));
    if(now<cooldown)throw new Error('Torn API cooling down. Try again later.');
    const history=(GM_getValue(API_USAGE_KEY,[]) || []).filter(t=>Number.isFinite(t) && now-t<60000);
    if(history.length>=20)throw new Error('This Manager has reached its 20-request/minute budget. Try again later; other tools also use your Torn quota.');
    GM_setValue(API_USAGE_KEY,[...history,now]);
    return new Promise((resolve,reject)=>GM_xmlhttpRequest({method:'GET',url:`https://api.torn.com/v2/${path}`,
      headers:{Authorization:`ApiKey ${key}`,Accept:'application/json'},timeout:20000,
      onload:response=>{try{
        if(Number(response.status)===401){if(String(GM_getValue(PLANNER_KEY,'')).trim()===key)GM_setValue(PLANNER_KEY,'');throw new Error('Torn API rejected authentication; saved key removed.');}
        if(response.status===429){GM_setValue(API_COOLDOWN_KEY,Date.now()+60000);throw new Error('Torn API rate limit: paused for at least one minute.');}
        if(response.status<200 || response.status>=300)throw new Error(`Torn API HTTP ${response.status}`);
        const body=response.responseText ?? response.response;
        const data=typeof body==='string'?JSON.parse(body):body;
        if(!data || typeof data!=='object')throw new Error('Torn API returned no readable data.');
        if(data.error){const code=Number(data.error.code);
          if([1,2,10,13,18].includes(code)) {
            if(String(GM_getValue(PLANNER_KEY,'')).trim()===key)GM_setValue(PLANNER_KEY,'');
            throw new Error(`Torn API ${code}: key invalid or disabled; saved key removed. Configure a working key before retrying.`);
          }
          if([5,8,9].includes(code))GM_setValue(API_COOLDOWN_KEY,Date.now()+60000);
          const messages={5:'Rate limit reached; wait at least one minute.',7:'Faction API access or entity permission missing.',8:'Temporary IP block; wait before retrying.',9:'Torn API unavailable; wait before retrying.',16:'Key lacks a required selection.',27:'Faction must use OC 2.0.'};
          throw new Error(`Torn API ${code}: ${messages[code] || 'Request rejected; no automatic retry.'}`);
        }
        resolve(data);
      }catch(error){reject(error);}},onerror:()=>reject(new Error('Torn API network error. No automatic retry.')),
      ontimeout:()=>reject(new Error('Torn API timed out. No automatic retry.'))}));
  }

  function plannerCanManage(faction, positions) {
    if (!faction?.id || !faction.position) return false;
    const name = normalize(faction.position);
    if (name === 'leader' || name === 'coleader') return true;
    return (positions || []).some(p => normalize(p.name) === name &&
      Array.isArray(p.abilities) && p.abilities.includes('Organised Crimes'));
  }


  function blValidateMembers(response, viewer) {
    if (response?.error || response?.complete===false || response?._metadata?.links?.next ||
        !Array.isArray(response?.members) || !response.members.length)
      throw new Error('Incomplete faction membership response. No data deleted.');
    const ids=response.members.map(m=>String(m?.id || ''));
    if(ids.some(id=>!/^[1-9]\d*$/.test(id)) || new Set(ids).size!==ids.length || !ids.includes(viewer))
      throw new Error('Invalid faction membership response. No data deleted.');
    for(const count of [response.count,response.total,response._metadata?.total])
      if(count!==undefined && Number(count)!==ids.length) throw new Error('Membership count mismatch. No data deleted.');
    return ids.sort();
  }
  function blCommitRoster(viewer,factionId,ids,source='torn-api') {
    if(viewer!==blViewer() || !/^[1-9]\d*$/.test(String(factionId)) || !ids.includes(viewer))
      throw new Error('Account or faction changed. No data deleted.');
    let old=null;
    try { old=JSON.parse(blStorageGet('black-ledger-verified-roster-v1') || 'null'); } catch (_) {}
    const reset=!!old && (old.viewerId!==viewer || old.factionId!==String(factionId));
    const changed=reset || !old || old.memberIds?.slice().sort().join(',')!==ids.slice().sort().join(',');
    const r={version:1,viewerId:viewer,factionId:String(factionId),memberIds:ids,checkedAt:Date.now(),ready:false,source};
    // Save a deny-all checkpoint before deletion; interrupted cleanup cannot expose old data.
    blStorageSet('black-ledger-verified-roster-v1',JSON.stringify(r));
    try {
      blCleanLocal(r,reset);
      meta=reset?{names:{},seen:{},importedAt:null}:blFilterStore(MANAGER_META_KEY,meta,r);
      const cache=sharedCache?.viewerId===viewer?sharedCache:GM_getValue(`${SHARED_CACHE_KEY}:${viewer}`,null);
      if(cache) {
        cache.index=reset?{}:blFilterMap(cache.index,r);cache.count=Object.keys(cache.index).length;
        GM_setValue(`${SHARED_CACHE_KEY}:${viewer}`,cache);sharedCache=cache;
      }
      if(reset && old?.viewerId && old.viewerId!==viewer) GM_setValue(`${SHARED_CACHE_KEY}:${old.viewerId}`,null);
      recordMemo.clear();plannerObservationMembers=null;
      if(changed){plannerState=null;plannerError='Faction membership changed. Fresh shared scan required before planning or mailing.';}
      plannerPageCrimes.clear();plannerUnassignedCache=null;plannerPendingZeroAt=null;
      r.ready=true;blStorageSet('black-ledger-verified-roster-v1',JSON.stringify(r));
      window.dispatchEvent(new Event('black-ledger-roster-updated'));
    } catch(error) {
      throw new Error('Membership cleanup could not finish. Old records are blocked. Retry Verify members & scan page. '+String(error.message || error));
    }
  }

  async function refreshPlannerAPI() {
    if (plannerBusy) return;
    if(!managerPageActive()){plannerError='Open and focus the OC page before scanning.';renderPlannerIfOpen();return;}
    plannerBusy = true; plannerError = ''; plannerState = null;
    renderPlannerIfOpen();
    try {
      const key = typeof GM_getValue === 'function' ? String(GM_getValue(PLANNER_KEY, '')).trim() : '';
      if (!key) throw new Error('Enter a Torn API key first. It needs user basic/faction, faction members, positions and crimes access.');
      if(key.length!==16 || !/^[a-zA-Z0-9]+$/.test(key)){GM_setValue(PLANNER_KEY,'');throw new Error('Torn API keys must be 16 letters/numbers. Saved invalid key removed.');}
      const basic = await plannerRequest('user/basic', key);
      const viewer = String(getViewerId() || '');
      if (!viewer || String(basic.profile?.id) !== viewer) throw new Error('This API key must belong to the Torn account currently signed in.');
      const own = await plannerRequest('user/faction', key);
      const positions = await plannerRequest('faction/positions', key);
      if (!plannerCanManage(own.faction, positions.positions)) throw new Error('Roster Planner is restricted to the leader, co-leader or a faction position with Organised Crimes permission.');
      const roster = await plannerRequest('faction/members', key);
      const firstIds=blValidateMembers(roster,viewer);
      const crimes = []; const ids = new Set();
      // Read every available crime page; never silently use a partial roster.
      for (let page = 0; ; page++) {
        if (page >= 30) throw new Error('Too many OC pages to complete this scan. No partial plan has been shown.');
        const result = await plannerRequest(`faction/crimes?cat=available&limit=100&offset=${page * 100}&sort=ASC`, key);
        if (!Array.isArray(result.crimes)) throw new Error('The OC response was incomplete.');
        for (const crime of result.crimes) {
          if (!crime.id || ids.has(String(crime.id))) throw new Error('The OC list changed during pagination. Refresh the planner again.');
          ids.add(String(crime.id)); crimes.push(crime);
        }
        if (result.crimes.length < 100 && !result._metadata?.links?.next) break;
        if (!result.crimes.length) throw new Error('The OC pagination response was inconsistent.');
      }
      const refreshedRoster = await plannerRequest('faction/members', key);
      const finalIds=blValidateMembers(refreshedRoster,viewer);
      const finalOwn=await plannerRequest('user/faction',key);
      if(String(finalOwn.faction?.id)!==String(own.faction?.id) || firstIds.join(',')!==finalIds.join(','))
        throw new Error('Faction membership changed during the scan. Retry; no data deleted.');
      blCommitRoster(viewer,own.faction.id,finalIds);
      plannerState = { factionId: own.faction.id, factionName: own.faction.name,
        members: refreshedRoster.members, crimes:blSafeCrimes(crimes), scannedAt: Date.now(), viewerId: viewer };
    } catch (error) { plannerState = null; plannerError = String(error.message || 'Could not refresh the planner.'); }
    finally { plannerBusy = false; renderPlannerIfOpen(); }
  }

  // Observe only responses Torn already requests. No extra authenticated page requests.
  const plannerPageCrimes = new Map();
  let plannerPageViewer = '';
  let plannerUnassignedCache=null;
  let plannerPendingZeroAt=null;
  function plannerResetPageViewer(viewer) {
    if(viewer!==plannerPageViewer){plannerPageCrimes.clear();plannerUnassignedCache=null;plannerPendingZeroAt=null;plannerPageViewer=viewer;}
  }
  function plannerSeconds(text) {
    const value=String(text || '').trim();
    const four=value.match(/(?:^|[^0-9:])(\d{1,3}):(\d{2}):(\d{2}):(\d{2})(?![0-9:])/);
    if(four && +four[2]<24 && +four[3]<60 && +four[4]<60)
      return +four[1]*86400 + +four[2]*3600 + +four[3]*60 + +four[4];
    const clock=value.match(/(?:^|[^0-9:])(\d{1,3}):(\d{2}):(\d{2})(?![0-9:])/);
    if(clock && +clock[2]<60 && +clock[3]<60) return +clock[1]*3600 + +clock[2]*60 + +clock[3];
    let total=0,found=false;
    for(const match of value.matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      found=true;total+=+match[1]*({d:86400,h:3600,m:60,s:1}[match[2][0].toLowerCase()]);
    }
    return found?total:null;
  }
  function plannerEpoch(value) {
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(value);
    if (Number.isFinite(n) && n > 1000000000) return n > 100000000000 ? n/1000 : n;
    // Do not interpret an undocumented number as a duration.
    if (typeof value !== 'string' || !/\d{4}-\d{2}-\d{2}/.test(value)) return 0;
    return Date.parse(value)/1000 || 0;
  }
  function capturePlannerResponse(data) {
    if(!managerPageActive())return;
    const viewer = String(getViewerId() || '');
    if (!viewer) return;
    plannerResetPageViewer(viewer);
    if (!Array.isArray(data?.data)) return;
    for (const raw of data.data) {
      if (!raw?.scenario?.name || !Array.isArray(raw.playerSlots)) continue;
      const id = String(raw.ID || raw.id || raw.crimeID || '');
      if (!id) continue;
      const status = String(raw.status || raw.state || '').toLowerCase();
      const slots = raw.playerSlots.map(slot => ({position: String(slot.name || ''),
        user: slot.player?.ID ? {id: slot.player.ID, name: slot.player.name || slot.player.username} : slot.player === null ? null : undefined}));
      plannerPageCrimes.set(id, {id, name:raw.scenario.name, difficulty:Number(raw.scenario.level), status,
        slots, pageScan:true, ready_at:plannerEpoch(raw.ready_at || raw.readyAt), expired_at:plannerEpoch(raw.expired_at || raw.expiredAt), capturedAt:Date.now()});
    }
  }
  function plannerProfile(link) {
    const id=link?.getAttribute('href')?.match(/[?&]XID=(\d+)/i)?.[1];
    if(!id) return null;
    const image=link.querySelector('img');
    const candidates=[link.textContent.trim(),link.getAttribute('title'),link.getAttribute('aria-label'),image?.getAttribute('alt'),image?.getAttribute('title'),meta.names[id]];
    const name=candidates.find(value=>value && isValidName(value)) || meta.names[id] || id;
    return {id,name};
  }
  function plannerUnassignedMembers() {
    if(!managerPageActive())return {members:new Map(),expected:null};
    const members=new Map();let expected=null;
    const headingPattern=/(?:members? (?:who are )?(?:aren['\u2019]t|are not|isn['\u2019]t|is not|not) (?:currently )?participating in (?:any )?scenarios?|not (?:currently )?in (?:an? |any )?(?:oc|organi[sz]ed crime)|without (?:an? |any )?(?:oc|crime)|unassigned members)/i;
    for(const heading of document.querySelectorAll('h1,h2,h3,h4,div,span')) {
      if(heading.closest(`#${PANEL_ID}`) || heading.closest('[data-oc-id]'))continue;
      const text=heading.textContent.trim();if(text.length>180 || !headingPattern.test(text))continue;
      const count=text.match(/^(?:There are\s+)?(\d+)\s+(?:faction\s+)?members?\b/i);const declared=count?Number(count[1]):null;
      if(declared!==null)expected=declared;
      let container=heading,best=[];
      for(let depth=0;container && depth<5;depth++,container=container.parentElement) {
        if(container.querySelector('[data-oc-id]') || container.id===PANEL_ID)break;
        const found=new Map();
        for(const link of container.querySelectorAll('a[href*="XID="]')) {
          if(link.closest(`#${PANEL_ID}`) || link.closest('[data-oc-id]'))continue;
          const member=plannerProfile(link);if(member)found.set(member.id,member);
        }
        if(declared!==null && found.size>declared)break;
        if(found.size>best.length)best=[...found.values()];
        if(declared!==null && found.size===declared)break;
      }
      for(const member of best)members.set(member.id,{...member,is_in_oc:false});
    }
    return {members,expected};
  }
  function plannerReadUnassigned(now) {
    const current=plannerUnassignedMembers();
    // A count alone is not a readable roster. Preserve the last actual IDs
    // through Torn's transient empty or hidden DOM, without renewing their age.
    const recentNonzero=plannerUnassignedCache?.members.size>0 && now-plannerUnassignedCache.capturedAt<5*60000;
    // Torn can briefly render a zero during loading. Require it to remain
    // readable on a second observation before replacing a known roster.
    if(current.expected===0 && recentNonzero) {
      if(plannerPendingZeroAt===null)plannerPendingZeroAt=now;
      if(now-plannerPendingZeroAt<1500) {
        setTimeout(schedulePlannerPageCapture,1600);
        return {...plannerUnassignedCache,members:new Map(plannerUnassignedCache.members),cached:true};
      }
    } else plannerPendingZeroAt=null;
    if(current.members.size>0 || current.expected===0) {
      plannerUnassignedCache={members:new Map(current.members),expected:current.expected,capturedAt:now};
      return {...current,capturedAt:now,cached:false};
    }
    if(plannerUnassignedCache && now-plannerUnassignedCache.capturedAt<5*60000)
      return {...plannerUnassignedCache,members:new Map(plannerUnassignedCache.members),cached:true};
    return {...current,capturedAt:now,cached:false};
  }
  function plannerCardRole(card,def) {
    const title=card.querySelector('[class*="title___"]');
    if(!title)return '';
    // Success chance and injected badges can sit inside the title node.
    const clone=title.cloneNode(true);
    for(const badge of clone.querySelectorAll('[class*="successChance___"],.oc-smart-target-box,.oc-smart-level-badge'))badge.remove();
    const name=clone.textContent.trim();
    const known=Object.keys(def.roles).find(role=>normalize(role)===normalize(name));
    if(known)return known;
    const base=normalize(name).replace(/\d+$/,'');
    return Object.keys(def.roles).some(role=>normalize(role).replace(/\d+$/,'')===base)?name:'';
  }
  // Anonymous completed teams are separate from current member CPR observations.
  const COMPLETED_HISTORY_KEY = 'oc-manager-completed-history-v1';
  let completedHistoryMemory = null, completedHistoryTimer = null, completedHistoryUploadTimer = null, completedHistoryError = '';
  function completedHistoryStore() {
    if (!completedHistoryMemory) {
      try {
        const stored = typeof GM_getValue === 'function' ? GM_getValue(COMPLETED_HISTORY_KEY, null) : null;
        completedHistoryMemory = stored || JSON.parse(blStorageGet(COMPLETED_HISTORY_KEY) || 'null');
      } catch (_) {}
    }
    if (completedHistoryMemory?.version !== 1 || !completedHistoryMemory.records)
      completedHistoryMemory = {version:1, records:{}};
    // Retain six days of completed evidence; never age out current OCs or CPR.
    // Use completion time when known, otherwise the original capture time.
    let removed = false;
    for (const [id, record] of Object.entries(completedHistoryMemory.records)) {
      const at = Date.parse(record.completed_at || record.captured_at);
      if (Number.isFinite(at) && at > 0 && Date.now() - at > 6 * 86400000) {
        delete completedHistoryMemory.records[id]; removed = true;
      }
    }
    if (removed) {
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(COMPLETED_HISTORY_KEY, completedHistoryMemory);
          // Remove a legacy local duplicate after the private write succeeds.
          blStorageRemove(COMPLETED_HISTORY_KEY);
          const checkpoint = COMPLETED_HISTORY_KEY + ':uploaded:50888';
          const old = typeof GM_getValue === 'function' ? GM_getValue(checkpoint, {}) : {};
          GM_setValue(checkpoint, Object.fromEntries(Object.entries(old || {}).filter(([id]) => completedHistoryMemory.records[id])));
        } else blStorageSet(COMPLETED_HISTORY_KEY, JSON.stringify(completedHistoryMemory));
      } catch (_) { completedHistoryError = 'Old history cleanup could not be saved; it will retry when history is opened.'; }
    }
    return completedHistoryMemory;
  }
  async function completedHistoryRequest(method = 'GET', body, token = '', after = '0') {
    const historyURL = 'https://shcecvzxdknpulytekcl.supabase.co/functions/v1/black-ledger-completed-history' + (method === 'GET' ? '?after=' + encodeURIComponent(after) : '');
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
      if (status === 409) throw new Error('Another manager changed targets. Refresh and retry.');
      if ([401,403].includes(status)) throw new Error('This access code is not authorised to sync faction history.');
      if (status !== 200) { failures.push(`${transport.name}: ${Number.isFinite(status) && status > 0 ? `HTTP ${status}` : 'no response status'}`); continue; }
      for (const raw of [response.responseText,response.response,response.body]) {
        try {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (data?.ok && data.faction_id === 50888 && (method === 'GET' ? Array.isArray(data.records) : Array.isArray(data.accepted))) return data;
        } catch (_) {}
      }
      failures.push(`${transport.name}: invalid response`);
    }
    throw new Error(`History sync failed (${[...new Set(failures)].join(', ') || 'no connection available'}). Local history retained; retry history sync.`);
  }
  let completedHistoryBusy = false, completedHistorySyncAt = 0, completedHistorySyncStatus = 'Not synced yet';
  async function syncCompletedHistory(force = false) {
    if (completedHistoryBusy || document.visibilityState === 'hidden' ||
        (!force && Date.now() - completedHistorySyncAt < 300000)) return;
    const roster = blRoster();
    if (!sharedToken() || !roster || String(roster.factionId) !== '50888') {
      if (force) {
        completedHistorySyncStatus = 'Configure shared CPR manager access and verify faction membership before syncing history.';
        const label = document.querySelector('[data-history-sync-status]');
        if (label) label.textContent = completedHistorySyncStatus;
      }
      return;
    }
    completedHistoryBusy = true; completedHistorySyncAt = Date.now();
    const store = completedHistoryStore(), token = sharedToken();
    const checkpointKey = COMPLETED_HISTORY_KEY + ':uploaded:50888';
    let acknowledged;
    try { acknowledged = GM_getValue(checkpointKey, {}); } catch (_) { acknowledged = {}; }
    if(!acknowledged || typeof acknowledged!=='object' || Array.isArray(acknowledged))acknowledged={};
    completedHistorySyncStatus='Syncing online history…';
    function updateStatus() {
      const label=document.querySelector('[data-history-sync-status]');if(label)label.textContent=completedHistorySyncStatus;
      const last=document.querySelector('[data-history-last-sync]');
      if(last)last.textContent=Number.isFinite(store.lastSyncedAt)?`Last synced: ${new Date(store.lastSyncedAt).toLocaleString('en-GB', {timeZone:'Europe/London', hour12:false})}`:'Last synced: not yet verified';
      const button=document.querySelector('[data-history-sync]');
      if(button){button.disabled=completedHistoryBusy;button.textContent=completedHistoryBusy?'Syncing…':'Sync online history';button.setAttribute('aria-busy',String(completedHistoryBusy));}
      const count=document.querySelector('[data-history-count]');
      if(count){const rows=Object.values(store.records),successes=rows.filter(r=>r.outcome==='success').length;count.textContent=`${rows.length} anonymous teams saved: ${successes} successes, ${rows.length-successes} failures.`;}
    }
    updateStatus();
    try {
      captureCompletedHistory();
      let serverIds=new Set(),complete=false;
      // Capture can add records while requests await. Reconcile against actual server
      // IDs rather than equating the changing local count with a completed upload.
      for(let round=0;round<3;round++) {
        let pending=Object.values(store.records).filter(record=>round===0?!acknowledged[record.oc_id]:!serverIds.has(record.oc_id));
        for(let start=0;start<pending.length;start+=100) {
          const batch=pending.slice(start,start+100);
          completedHistorySyncStatus=`Uploading completed teams: ${start}/${pending.length} confirmed in this batch…`;updateStatus();
          const result=await completedHistoryRequest('PUT',{faction_id:50888,records:batch},token);
          if(result.accepted.length!==batch.length || batch.some(record=>!result.accepted.includes(record.oc_id)))
            throw new Error('Incomplete history upload confirmation');
          for(const id of result.accepted)acknowledged[id]=true;
          try{GM_setValue(checkpointKey,acknowledged);}catch(_){}
        }
        let after='0';serverIds=new Set();
        do {
          const result=await completedHistoryRequest('GET',undefined,token,after);
          if(result.next!==null && (!/^[1-9]\d*$/.test(result.next) || Number(result.next)<=Number(after)))throw new Error('Invalid history download cursor');
          for(const record of result.records) {
            if(!record || !/^[1-9]\d*$/.test(record.oc_id) || !Array.isArray(record.roles) || !['success','failure'].includes(record.outcome) || Number(record.oc_id)<=Number(after) || serverIds.has(record.oc_id))
              throw new Error('Invalid downloaded history');
            serverIds.add(record.oc_id);
            // The first accepted online record is canonical on every device.
            store.records[record.oc_id]=record;acknowledged[record.oc_id]=true;
          }
          after=result.next;
          completedHistorySyncStatus=`Checking online history: ${serverIds.size} teams downloaded…`;updateStatus();
        }while(after);
        persistCompletedHistory();
        complete=Object.keys(store.records).every(id=>serverIds.has(id));
        if(complete)break;
      }
      try{GM_setValue(checkpointKey,acknowledged);}catch(_){}
      const pending=Object.keys(store.records).filter(id=>!serverIds.has(id)).length;
      if(complete){store.lastSyncedAt=Date.now();persistCompletedHistory();}
      completedHistorySyncStatus=complete?`Online sync verified: ${serverIds.size} teams online and on this device.`:
        `${serverIds.size} teams confirmed online; ${pending} local teams still awaiting upload. Retrying shortly.`;
      if(!complete && !completedHistoryUploadTimer)completedHistoryUploadTimer=setTimeout(()=>{completedHistoryUploadTimer=null;syncCompletedHistory(true);},1500);
    }catch(_) {
      completedHistorySyncStatus='Online sync incomplete. Local history retained; use Sync online history to retry.';
    }finally{completedHistoryBusy=false;}
    updateStatus();
  }

  function persistCompletedHistory() {
    const store = completedHistoryStore();
    let saved = false;
    try { if (typeof GM_setValue === 'function') {GM_setValue(COMPLETED_HISTORY_KEY, store); saved = true;} } catch (_) {}
    if (!saved) try {blStorageSet(COMPLETED_HISTORY_KEY, JSON.stringify(store)); saved = true;} catch (_) {}
    completedHistoryError = saved ? '' : 'Storage failed. Export this session before closing the page.';
  }
  function completedCardRecord(root, defs) {
    // Exact banner text only: role failure icons and narrative text are not team outcomes.
    const outcomes = new Set([...root.querySelectorAll('[class*="scenario___"] [class*="phase___"] [class*="title___"]')]
      .map(node => node.textContent.trim().toUpperCase()).filter(text => /^(SUCCESS|FAILED)$/.test(text)));
    if (outcomes.size !== 1) return null;
    const id = root.getAttribute('data-oc-id');
    if (!id || !/^[1-9]\d*$/.test(id)) return null;
    const title = root.querySelector('[class*="panelTitle___"]');
    const text = title?.textContent.replace(/OC Level\s*\d+/ig,'').trim() || '';
    const crime = Object.keys(defs).find(name => normalize(name) === normalize(text));
    if (!crime) return null;
    let cards = [...root.querySelectorAll('[class*="contentLayer___"] > [class*="wrapper___"] > [class*="wrapper___"]')];
    if (!cards.length) cards = [...root.querySelectorAll('.oc-smart-target-box')].map(box => box.parentElement);
    const roles = cards.map(card => {
      const role = plannerCardRole(card, defs[crime]);
      const chance = card.querySelector('[class*="successChance___"]');
      const raw = chance?.textContent.trim() || '';
      const cpr = /^\d+(?:\.\d+)?%?$/.test(raw) ? Number(raw.replace('%','')) : null;
      const weightKey = Object.keys(defs[crime].roles).find(key => normalize(key) === normalize(role));
      return {role, cpr, weight: weightKey ? defs[crime].roles[weightKey] : null};
    });
    // Partial/ambiguous cards are retried after Torn finishes rendering.
    if (roles.length !== Object.keys(defs[crime].roles).length ||
        new Set(roles.map(slot => normalize(slot.role))).size !== roles.length ||
        roles.some(slot => !slot.role || slot.cpr === null || slot.cpr < 0 || slot.cpr > 100 || !Number.isFinite(slot.weight))) return null;
    return {oc_id:id, crime, level:defs[crime].level, outcome:[...outcomes][0] === 'SUCCESS' ? 'success' : 'failure',
      roles, completed_at:null, captured_at:new Date().toISOString(), weight_source:'manager role weights at capture'};
  }
  function captureCompletedHistory() {
    if (document.visibilityState === 'hidden') return;
    const store = completedHistoryStore(), defs = plannerWeights();
    let added = 0;
    for (const root of document.querySelectorAll('[data-oc-id]')) {
      if (root.closest(`#${PANEL_ID}`)) continue;
      // Completed records are immutable: skip before reading roles or cloning titles.
      const existingId = root.getAttribute('data-oc-id');
      if (existingId && store.records[existingId]) continue;
      const record = completedCardRecord(root, defs);
      if (!record || store.records[record.oc_id]) continue;
      store.records[record.oc_id] = record; added++;
    }
    if (!added) return;
    persistCompletedHistory();
    completedHistorySyncStatus='New completed teams saved locally; awaiting online upload.';
    const label=document.querySelector('[data-history-sync-status]');if(label)label.textContent=completedHistorySyncStatus;
    // Batch new cards after scrolling pauses, without waiting for the five-minute poll.
    if(completedHistoryUploadTimer)clearTimeout(completedHistoryUploadTimer);
    completedHistoryUploadTimer=setTimeout(()=>{completedHistoryUploadTimer=null;syncCompletedHistory(true);},1500);
  }
  function scheduleCompletedHistory() {
    // Throttle rather than debounce so continuous scrolling still captures virtualized cards.
    if (completedHistoryTimer) return;
    completedHistoryTimer = setTimeout(() => {completedHistoryTimer = null; captureCompletedHistory();}, 100);
  }
  function historyNotice(text, kind='info', persistent=false) {
    let notice=document.getElementById('blom-history-notice');
    if(!notice){notice=document.createElement('div');notice.id='blom-history-notice';document.body.appendChild(notice);}
    if(notice.dismissTimer)clearTimeout(notice.dismissTimer);
    notice.replaceChildren();notice.setAttribute('role',kind==='error'?'alert':'status');
    notice.setAttribute('aria-live',kind==='error'?'assertive':'polite');
    notice.style.cssText='position:fixed;left:12px;right:12px;bottom:100px;margin:0 auto;max-width:650px;box-sizing:border-box;z-index:2147483647;background:#1d2c35;color:#e8f3fa;border:1px solid '+(kind==='error'?'#ff9c90':kind==='success'?'#65d699':'#72caff')+';border-radius:10px;padding:14px;box-shadow:0 8px 28px #0008;font:14px/1.5 sans-serif;display:flex;align-items:center;gap:14px';
    const message=document.createElement('span');message.textContent=text;message.style.cssText='flex:1;overflow-wrap:anywhere';notice.appendChild(message);
    const close=document.createElement('button');close.type='button';close.textContent='Dismiss';close.style.cssText='background:#245679;color:white;border:1px solid #72caff;border-radius:6px;padding:10px;min-height:44px;font:inherit';
    close.onclick=()=>{clearTimeout(notice.dismissTimer);notice.remove();};notice.appendChild(close);
    if(!persistent)notice.dismissTimer=setTimeout(()=>notice.remove(),9000);
  }
  function renderCompletedHistory(body) {
    captureCompletedHistory();
    const history=completedHistoryStore();
    const records = Object.values(history.records);
    const successes = records.filter(record => record.outcome === 'success').length;
    const card = document.createElement('div'); card.className = 'blom-card blom-completed-history';
    card.innerHTML = `<div class="blom-card-title">Completed OC history</div>
      <p data-history-count>${records.length} anonymous teams saved: ${successes} successes, ${records.length-successes} failures.</p>
      <p>Open Completed and scroll through older results once. Newly loaded results are captured automatically, even with the manager panel closed. Player names and IDs are not saved. Local completed records are deleted after six days, using completion time when known or capture time otherwise. History syncs across authorised manager devices when shared CPR access is configured.</p>
      <p>Historical role-header CPR is saved separately from current CPR. Weights use the current role definitions; completion dates are left blank when unavailable.</p>
      <p>${escapeHtml(completedHistoryError)}</p><p data-history-sync-status role="status" aria-live="polite">${escapeHtml(completedHistorySyncStatus)}</p>
      <p data-history-last-sync class="blom-muted">${Number.isFinite(history.lastSyncedAt)?`Last synced: ${escapeHtml(new Date(history.lastSyncedAt).toLocaleString('en-GB', {timeZone:'Europe/London', hour12:false}))}`:'Last synced: not yet verified'}</p>
      <div class="blom-toolbar"><button type="button" data-history-sync ${completedHistoryBusy?'disabled':''}>${completedHistoryBusy?'Syncing…':'Sync online history'}</button>
      <button type="button" data-history-refresh>Scan loaded OC results</button></div>
      <details class="blom-inline-details"><summary>Backup / analysis</summary>
        <p>Download the saved completed OC history as JSON for backup or analysis.</p>
        <button type="button" data-history-export>Export history backup</button>
      </details>`;
    body.appendChild(card);
    card.querySelector('[data-history-sync]').onclick = async () => {
      if(completedHistoryBusy){historyNotice('An online history sync is already running.','info',true);return;}
      historyNotice('Syncing completed OC history — uploading and checking online records…','info',true);
      await syncCompletedHistory(true);
      historyNotice(completedHistorySyncStatus,/^Online sync verified:/.test(completedHistorySyncStatus)?'success':'error');
    };
    card.querySelector('[data-history-refresh]').onclick = async () => {
      const button=card.querySelector('[data-history-refresh]');button.disabled=true;button.textContent='Scanning…';
      historyNotice('Scanning the completed OC cards currently loaded…','info',true);
      try {
        // Yield once so the busy state is visible before reading the loaded cards.
        await new Promise(resolve=>setTimeout(resolve,0));
        const before=Object.keys(completedHistoryStore().records).length;
        captureCompletedHistory();
        const rows=Object.values(completedHistoryStore().records),successes=rows.filter(r=>r.outcome==='success').length;
        card.querySelector('[data-history-count]').textContent=`${rows.length} anonymous teams saved: ${successes} successes, ${rows.length-successes} failures.`;
        const added=rows.length-before;
        historyNotice(added?`Added ${added} completed OC${added===1?'':'s'}. ${rows.length} saved; online upload will follow automatically.`:
          `Scan complete: no new completed OCs in the loaded cards. ${rows.length} already saved. Open Completed and load older results to collect more.`,'success');
      }catch(error){historyNotice('Could not scan loaded results. Existing history is retained.','error');}
      finally{button.disabled=false;button.textContent='Scan loaded OC results';}
    };
    card.querySelector('[data-history-export]').onclick = async () => {
      const button=card.querySelector('[data-history-export]');button.disabled=true;button.textContent='Preparing export…';
      historyNotice('Preparing your completed OC history export…','info',true);
      try {
        await new Promise(resolve=>setTimeout(resolve,0));
        const store=completedHistoryStore();downloadJSON(store,'completed-oc-history.json');
        historyNotice(`Export prepared: ${Object.keys(store.records).length} completed OCs. Your browser or PDA handles saving completed-oc-history.json.`,'success');
      }catch(error){historyNotice('Could not prepare the export. Existing history is retained.','error');}
      finally{button.disabled=false;button.textContent='Export history backup';}
    };
  }
  function plannerRootTimer(root) {
    const values=new Set();
    // Torn renders the scenario countdown as DD:HH:MM:SS, often in an
    // unlabelled banner. Nested timer elements are deduplicated by value.
    for(const node of root.querySelectorAll('time,span,div,[data-timestamp]')) {
      if(node.closest('.oc-smart-target-box'))continue;
      const text=node.textContent.trim();
      if(!/^\d{1,3}:\d{2}:\d{2}(?::\d{2})?$/.test(text))continue;
      const seconds=plannerSeconds(text);if(seconds!==null)values.add(seconds);
    }
    return values.size===1?[...values][0]:null;
  }
  function readPlannerOCPage(crimes,now) {
    if(!managerPageActive())return {scannedRoots:0,readableTimers:0,unknownRoles:0};
    let scannedRoots=0,readableTimers=0,unknownRoles=0;
    const defs=plannerWeights();
    for(const root of document.querySelectorAll('[data-oc-id]')) {
      if(root.closest(`#${PANEL_ID}`)) continue;
      // Completed teams belong to history, not the live roster forecast.
      if ([...root.querySelectorAll('[class*="scenario___"] [class*="phase___"] [class*="title___"]')]
          .some(node => /^(success|failed)$/i.test(node.textContent.trim()))) continue;
      const id=root.getAttribute('data-oc-id');
      const title=root.querySelector('[class*="panelTitle___"]');
      const titleText=title?.textContent.replace(/OC Level\s*\d+/ig,'').trim() || '';
      const name=Object.keys(defs).find(n=>normalize(titleText)===normalize(n));
      if(!name) continue;
      const cached=crimes.get(id);
      let cards=[...root.querySelectorAll('[class*="contentLayer___"] > [class*="wrapper___"] > [class*="wrapper___"]')];
      // Collector decorations give a second structural anchor if Torn changes wrappers.
      if(!cards.length)cards=[...root.querySelectorAll('.oc-smart-target-box')].map(box=>box.parentElement);
      if(!cards.length && !cached?.slots?.length){unknownRoles++;continue;}
      let slots=cards.map(card=>{
        const position=plannerCardRole(card,defs[name]);
        const member=plannerProfile(card.querySelector('a[href*="XID="]'));
        const joinControl=[...card.querySelectorAll('button,a,input,span,[role="button"],[class*="join"],[class*="Join"]')].some(node=>/^join(?:\s|$)/i.test((node.textContent || node.value || node.getAttribute('aria-label') || '').trim()));
        const empty=!member && (joinControl || /\bempty\b|\bvacant\b|\bavailable slot\b/i.test(card.textContent));
        return {position,user:member || (empty?null:undefined)};
      }).filter(slot=>slot.position && Object.keys(defs[name].roles).some(r=>normalize(r).replace(/\d+$/,'')===normalize(slot.position).replace(/\d+$/,'')));
      if(!slots.length && cached?.slots?.length)slots=cached.slots;
      if(!slots.length){unknownRoles++;continue;}
      scannedRoots++;
      const text=root.textContent;
      let status=cached?.status || '';
      if(/\bplanning\b/i.test(text)) status='planning';
      else if(/\brecruiting\b/i.test(text) || slots.some(s=>s.user===null)) status='recruiting';
      const duration=plannerRootTimer(root);
      if(duration!==null)readableTimers++;
      if(duration!==null && slots.length && slots.every(slot=>slot.user?.id))status='planning';
      crimes.set(id,{id,name,difficulty:defs[name].level,status,slots,
        ready_at:status==='planning' && duration!==null ? (now/1000+duration) : cached?.ready_at || 0,
        expired_at:status==='recruiting' && duration!==null ? (now/1000+duration) : cached?.expired_at || 0,
        capturedAt:now,pageScan:true});
    }
    return {scannedRoots,readableTimers,unknownRoles};
  }
  let plannerCaptureTimer=null;
  function schedulePlannerPageCapture() {
    if(!managerPageActive())return;
    clearTimeout(plannerCaptureTimer);
    plannerCaptureTimer=setTimeout(()=>{
      if(!managerPageActive())return;
      const viewer=String(getViewerId() || '');if(!viewer)return;
      plannerResetPageViewer(viewer);
      const now=Date.now();
      const crimes=new Map([...plannerPageCrimes].filter(([,c])=>now-c.capturedAt<5*60000));
      readPlannerOCPage(crimes,now);
      invalidateReviewForObservedOCs([...crimes.values()]);
      plannerReadUnassigned(now);
      plannerPageCrimes.clear();for(const [id,crime] of crimes)plannerPageCrimes.set(id,crime);
    },250);
  }

  // Two page roster check. A manually confirmed live faction count is an
  // independent completeness check; OC pages alone cannot prove an absence.
  function pageRosterSession() {
    try {
      const s=JSON.parse(sessionStorage.getItem('bl-two-page-roster-v1') || 'null');
      if(!s || s.viewer!==String(getViewerId() || '') || !/^[1-9]\d*$/.test(String(s.factionId)) || !Number.isSafeInteger(s.expected) || s.expected<1 || !Number.isFinite(s.startedAt) || Date.now()-s.startedAt>5*60000 || Date.now()<s.startedAt)return null;
      return s;
    }catch(_){return null;}
  }
  function pageRosterRead(kind) {
    if(!managerPageActive())throw new Error('Open the faction OC page first.');
    const crimes=new Map(),now=Date.now();
    const roots=[...document.querySelectorAll('[data-oc-id]')].filter(n=>!n.closest(`#${PANEL_ID}`));
    const ids=new Set(roots.map(n=>n.getAttribute('data-oc-id')));
    const diagnostics=readPlannerOCPage(crimes,now),defs=plannerWeights();
    if(diagnostics.unknownRoles || crimes.size!==ids.size)throw new Error('Some OC cards are unreadable. Expand every OC and load the whole list before recording it.');
    const members=[],seen=new Set();
    for(const crime of crimes.values()) {
      if(!/^[1-9]\d*$/.test(String(crime.id)) || crime.slots.length!==Object.keys(defs[crime.name]?.roles || {}).length || crime.slots.some(slot=>slot.user===undefined))
        throw new Error('Some roles or occupants are unreadable. Expand every OC before recording.');
      if(kind==='planning' && crime.slots.some(slot=>slot.user===null))throw new Error('This looks like Recruiting. Open Planning before recording Planning.');
      for(const slot of crime.slots)if(slot.user) {
        const id=String(slot.user.id);
        if(!/^[1-9]\d*$/.test(id) || seen.has(id))throw new Error('An invalid or repeated occupant was found. Refresh this page and retry.');
        seen.add(id);members.push({...slot.user,id,is_in_oc:true});
      }
      crime.status=kind;
    }
    let unassigned=[];
    if(kind==='recruiting') {
      const u=plannerUnassignedMembers();
      if(u.expected===null || u.members.size!==u.expected)throw new Error('The complete unassigned list is not readable. Scroll to the bottom of Recruiting and load it before recording.');
      unassigned=[...u.members.values()].map(m=>({...m,id:String(m.id)}));
      for(const m of unassigned){if(seen.has(m.id))throw new Error('A member appears both assigned and unassigned. Refresh and retry.');seen.add(m.id);members.push(m);}
    }
    const rows=[...crimes.values()];
    const signature=JSON.stringify({ids:[...seen].sort(),unassigned:unassigned.map(m=>m.id).sort(),crimes:rows.map(c=>[String(c.id),c.slots.map(s=>[s.position,s.user?.id || null])]).sort((a,b)=>a[0].localeCompare(b[0]))});
    return {members,unassigned,crimes:rows,signature,at:now};
  }
  // Membership comes from the full faction list; absence from OC pages is
  // unknown availability, never evidence that a member has left the faction.
  function pageMemberListRead() {
    const url=new URL(location.href),viewer=String(getViewerId() || '');
    const factionId=url.searchParams.get('ID');
    if(url.pathname!=='/factions.php' || url.searchParams.get('step')!=='profile' || !/^[1-9]\d*$/.test(factionId || '') || !viewer)
      throw new Error('Open your faction profile and its full member list first.');
    const lists=[...document.querySelectorAll('.members-list')];
    if(lists.length!==1)throw new Error('The faction member list is not readable yet.');
    const list=lists[0],match=list.textContent.match(/(\d+)\s*\/\s*\d+\s+Faction Members/i);
    if(!match)throw new Error('The faction member total is not readable.');
    const expected=Number(match[1]),members=[],seen=new Set();
    for(const row of list.querySelectorAll('li.table-row')) {
      const links=row.querySelectorAll('a[aria-label^="View profile of "][href*="profiles.php"]');
      if(!links.length)continue; // Non-member rows inserted by other extensions.
      if(links.length!==1)throw new Error('A faction member row is ambiguous.');
      const link=links[0],id=new URL(link.href,location.href).searchParams.get('XID');
      const position=row.querySelector('.position .ellipsis');
      if(!/^[1-9]\d*$/.test(id || '') || seen.has(id) || !position)throw new Error('A member ID or position is unreadable or repeated.');
      seen.add(id);members.push({id,name:link.getAttribute('aria-label').replace(/^View profile of /,''),position:position.textContent.trim(),ocEligible:!/^recruit$/i.test(position.textContent.trim())});
    }
    if(!expected || members.length!==expected || !seen.has(viewer))throw new Error('Load the complete, unfiltered member list for your own faction before recording it.');
    return {viewer,factionId,expected,members,at:Date.now()};
  }
  function pageMemberListSnapshot(s) {
    let r;try{r=JSON.parse(blStorageGet('bl-page-member-list-v1') || 'null');}catch(_){return null;}
    if(!r)return null;
    if(r.viewer!==s.viewer || String(r.factionId)!==String(s.factionId) || r.expected!==s.expected || !Number.isFinite(r.at) || Date.now()<r.at || Date.now()-r.at>5*60000)
      throw new Error('The full member list is stale or belongs to a different account, faction or total. Record it again.');
    if(!Array.isArray(r.members) || r.members.length!==s.expected || new Set(r.members.map(m=>String(m.id))).size!==s.expected || r.members.some(m=>!/^[1-9]\d*$/.test(String(m.id))) || !r.members.some(m=>String(m.id)===s.viewer))
      throw new Error('The saved full member list is incomplete or invalid. Record it again.');
    return r;
  }
  function attachMemberListRecorder() {
    const url=new URL(location.href);
    if(url.pathname!=='/factions.php' || url.searchParams.get('step')!=='profile')return;
    const list=document.querySelector('.members-list');
    if(!list || document.getElementById('bl-member-list-record'))return;
    const button=document.createElement('button');button.id='bl-member-list-record';button.textContent='Black Ledger: Record full member list';
    button.style.cssText='color:#fff;background:#245679;border:1px solid #72caff;border-radius:6px;padding:10px 14px;margin:8px;font-weight:bold;font-size:14px;cursor:pointer';
    button.onclick=async()=>{
      if(button.disabled)return;button.disabled=true;
      try {
        if(!confirm('Confirm this is your own faction and the complete, unfiltered member list is loaded. Recording saves membership locally; it does not delete anything.'))return;
        const first=pageMemberListRead(),route=location.href;
        await new Promise(resolve=>setTimeout(resolve,1600));
        const second=pageMemberListRead();
        const signature=r=>JSON.stringify([r.viewer,r.factionId,r.expected,r.members.map(m=>[m.id,m.position]).sort((a,b)=>a[0].localeCompare(b[0]))]);
        if(location.href!==route || signature(first)!==signature(second))throw new Error('The member list is still changing. Wait and record again.');
        blStorageSet('bl-page-member-list-v1',JSON.stringify(second));
        button.textContent=`Recorded ${second.expected} faction members — return to OC Manager`;
      }catch(e){alert(String(e.message || e));}finally{button.disabled=false;}
    };
    list.prepend(button);
  }
  function pageRosterCombined(s) {
    if(!s || s.viewer!==String(getViewerId() || '') || Date.now()-s.startedAt>5*60000)throw new Error('Check expired. Start again and record both pages within five minutes.');
    if(!s.recruiting || !s.planning)throw new Error('Record both Recruiting and Planning first.');
    const members=[...s.recruiting.members,...s.planning.members].map(m=>({...m}));
    let ids=members.map(m=>String(m.id));
    if(new Set(ids).size!==ids.length)throw new Error('A member moved between lists or appeared twice. Start a new check.');
    const crimeIds=[...s.recruiting.crimes,...s.planning.crimes].map(c=>String(c.id));
    if(new Set(crimeIds).size!==crimeIds.length)throw new Error('An OC appears on both pages. Start a new check.');
    const full=pageMemberListSnapshot(s);
    if(full) {
      const roster=new Map(full.members.map(m=>[String(m.id),m]));
      if(ids.some(id=>!roster.has(id)))throw new Error('An OC member is absent from the full member list. Membership changed; record all lists again.');
      for(const m of members)if(roster.get(String(m.id)).ocEligible===false)m.ocEligible=false;
      for(const m of full.members)if(!ids.includes(String(m.id)))members.push({...m,id:String(m.id),is_in_oc:undefined});
      ids=members.map(m=>String(m.id));
    }
    if(ids.length!==s.expected)throw new Error(`Found ${ids.length} OC-page members; faction total is ${s.expected}. Open your faction profile and click "Black Ledger: Record full member list", then return here within five minutes. Recruits count as members but are not assumed available. Nothing deleted.`);
    if(!ids.includes(s.viewer) || ids.some(id=>!/^[1-9]\d*$/.test(id)))throw new Error('The roster does not include your signed-in account, or contains an invalid ID. Nothing deleted.');
    return {members,ids:ids.sort(),fullList:!!full,crimes:[...s.recruiting.crimes,...s.planning.crimes]};
  }
  async function verifyMembershipOnly(commit=blCommitRoster) {
    const key=String(GM_getValue(PLANNER_KEY,'')).trim();
    if(!/^[a-zA-Z0-9]{16}$/.test(key))throw new Error('Save a 16-character Torn public-access key to verify membership.');
    const viewer=String(getViewerId() || '');
    const basic=await plannerRequest('user/basic',key);
    if(!viewer || String(basic.profile?.id)!==viewer)throw new Error('The key must belong to the signed-in Torn account.');
    const own=await plannerRequest('user/faction',key);
    if(!/^[1-9]\d*$/.test(String(own.faction?.id || '')))throw new Error('Could not identify your current faction.');
    const first=blValidateMembers(await plannerRequest('faction/members',key),viewer);
    const finalMembers=await plannerRequest('faction/members',key);
    const second=blValidateMembers(finalMembers,viewer);
    const finalOwn=await plannerRequest('user/faction',key);
    if(String(finalOwn.faction?.id)!==String(own.faction.id) || first.join(',')!==second.join(','))
      throw new Error('Membership changed during verification. Retry; no data deleted.');
    if(String(GM_getValue(PLANNER_KEY,'')).trim()!==key || String(getViewerId() || '')!==viewer)
      throw new Error('Account or key changed during verification. No data deleted.');
    commit(viewer,own.faction.id,second);
    return {viewerId:viewer,factionId:String(own.faction.id),member_ids:second,member_count:second.length,
      members:finalMembers.members.map(m=>({id:String(m.id),name:String(m.name || m.id),position:typeof m.position==='string'?m.position:null})),
      fetched_at:new Date().toISOString(),source:'torn-api'};
  }
  async function refreshPlanner() {
    return refreshSharedPlanner();
  }
  function plannerWeights() {
    if(typeof plannerInputContext!=='undefined' && plannerInputContext?.shared)return plannerInputContext.weights;
    const raw = readJSON('oc_smart_targets_weights_cache_v2', null);
    let weights = PLANNER_OC_DEFS;
    if (raw?.data && Date.now() - Number(raw.savedAt) >= 0 && Date.now() - Number(raw.savedAt) < 7 * 86400000) {
      weights = Object.fromEntries(Object.entries(PLANNER_OC_DEFS).map(([name, def]) => [name, { level: def.level, roles: {...def.roles} }]));
      for (const [crime, roles] of Object.entries(raw.data)) {
        const entry = Object.keys(weights).find(name => normalize(name) === normalize(crime));
        if (!entry || !roles || typeof roles !== 'object') continue;
        for (const [role, rawWeight] of Object.entries(roles)) {
          if (typeof rawWeight !== 'number') continue;
          const value = rawWeight < 0 && rawWeight >= -0.001 ? 0 : rawWeight;
          if (Number.isFinite(value) && value >= 0 && value <= 100) weights[entry].roles[role] = value;
        }
      }
    }
    const actual=readJSON('black-ledger-role-weights-v1',null);
    if(actual?.schema_version===1 && actual.weights) {
      weights=JSON.parse(JSON.stringify(weights));
      for(const [crime,def] of Object.entries(weights)) for(const role of Object.keys(def.roles)) {
        const value=actual.weights[normalize(crime)]?.[normalize(role)];
        if(Number.isFinite(value) && value>=0 && value<=100) def.roles[role]=value;
      }
    }
    return weights;
  }

  function plannerDefinition(name, defs) {
    return Object.entries(defs).find(([n]) => normalize(n) === normalize(name))?.[1] || null;
  }

  function plannerObservation(memberId, crime, role, includeStale = false) {
    if(typeof plannerInputContext!=='undefined' && plannerInputContext?.shared)return sharedPlannerObservation(memberId,crime,role,includeStale);
    const crimes = (plannerObservationMembers || getMembers())[String(memberId)];
    const roles = findCrimeRoles(crimes, crime);
    if (!roles) return null;
    const wanted = normalize(role);
    let match = Object.entries(roles).find(([r]) => normalize(r) === wanted);
    let estimated = false;
    if (!match && /\d+$/.test(wanted)) {
      // An unnumbered observation can be offered as an explicit estimate.
      // Never borrow CPR from a different numbered role or another crime.
      match = Object.entries(roles).find(([r]) => normalize(r) === wanted.replace(/\d+$/, ''));
      estimated = !!match;
    }
    if (!match || match[1] === null || match[1] === '' || typeof match[1] === 'boolean') return null;
    const fresh = freshestCpr(String(memberId),crime,match[0],match[1]);
    const cpr = Number(fresh.cpr);
    if (!Number.isFinite(cpr) || cpr < 0 || cpr > 100) return null;
    const key = seenKey(String(memberId), crime, match[0]);
    const time = Number(fresh.timestamp_ms) || NaN;
    const age = Date.now() - time;
    const dated = Number.isFinite(age) && age >= 0;
    const stale = dated && age > PLANNER_MAX_AGE;
    if (stale && !includeStale) return null;
    return { cpr, source:fresh.source, kind: estimated ? 'Estimated' : fresh.source === 'Local recorded high' ? 'Recorded high' : 'Observed', seen: dated ? time : null, stale,
      confidence: stale ? 'Low · stale' : estimated || !dated || fresh.source === 'Local recorded high' ? 'Low' : age > 14 * 86400000 ? 'Medium' : 'High' };
  }

  function plannerSimilarRoleNote(memberId,plan,prefs) {
    // Show manual leads only where no provisional destination estimate exists.
    const rows=[],base=role=>normalize(String(role).replace(/[\s#\d]+$/,''));
    const minimum=plannerLevelFloor(String(memberId),prefs).minimum;
    for(const slot of plan.active.open || []){
      if(slot.level<minimum || plannerObservation(String(memberId),slot.crime,slot.role,true) || typeof plannerEstimatedRole==='function' && plannerEstimatedRole(String(memberId),slot))continue;
      let best=null;
      for(const [crime,def] of Object.entries(plan.defs)){
        if(crime===slot.crime || Number(def.level)!==Number(slot.level))continue;
        for(const role of Object.keys(def.roles || {})){
          if(base(role)!==base(slot.role))continue;
          const observed=plannerObservation(String(memberId),crime,role,false);
          if(!observed || observed.kind!=='Observed' || !observed.seen || observed.stale)continue;
          if(!best || observed.cpr<best.cpr)best={...observed,crime,role};
        }
      }
      if(best)rows.push(`<div class="blom-placement-note">Manual CPR check: L${slot.level} ${escapeHtml(slot.crime)} #${escapeHtml(slot.crimeId)} · ${escapeHtml(prettyRole(slot.role))} — target ${mainScriptTarget(slot.crime,slot.level,slot.weight,slot.roleCount,slot.role)}%. Same-level evidence: ${escapeHtml(best.crime)} · ${escapeHtml(prettyRole(best.role))} ${formatCpr(best.cpr)}%. Destination CPR unknown; check this role on Torn.${slot.openingUnsupported?' A distinct qualifying follow-on member is still needed before starting.':''}</div>`);
    }
    return rows.join('');
  }

  function plannerSelectedLevels(prefs = {}) {
    const levels = Array.isArray(prefs.levels) ? prefs.levels : [1,2,3,4,5,6,7,8,9,10];
    return [...new Set(levels.filter(level => Number.isInteger(level) && level >= 1 && level <= 10))];
  }
  function plannerManagedLevel(level, prefs = {}) { return plannerSelectedLevels(prefs).includes(Number(level)); }

  function plannerProgressCoverage(crime,asOf) {
    const duration=crime.planningSecondsPerSlot,observed=crime.planningObservedAt;
    if(!['active','recruiting'].includes(crime.planningPhase) || !Number.isFinite(duration) || duration<=0 || duration>7*86400 || !Number.isSafeInteger(observed) || !Number.isFinite(asOf) || observed>asOf || asOf-observed>60000 || !Array.isArray(crime.slots) || !crime.slots.length)return null;
    let completed=0,queued=0,current=null,remaining=0,gap=false,started=false,vacancies=0;
    for(const slot of crime.slots){
      if(slot.user===null){gap=true;vacancies++;continue;}
      const percent=slot.planningPercent;
      // Returned stage order must be a completed prefix, one current stage,
      // queued zero-percent stages, then vacancies. Do not infer missing data.
      if(!slot.user || gap || slot.planningState!=='planning' || typeof percent!=='number' || !Number.isFinite(percent) || percent<0 || percent>100)return null;
      if(percent===100){if(started)return null;completed++;continue;}
      if(percent>0){if(started)return null;current=percent;started=true;}
      else {if(!started){current=0;started=true;}else queued++;}
      remaining+=(1-percent/100)*duration*1000;
    }
    return {source:'member-progress',completed,current,queued,vacancies,secondsPerSlot:duration,deadline:vacancies?observed+remaining:null};
  }

  function plannerPausedStaffingGap(crime,asOf) {
    // A paused all-completed prefix followed by vacancies has no queued coverage.
    // Recognise the gap without extrapolating any paused percentage as a timer.
    if(crime.status!=='recruiting' || crime.isExpiring!==false || crime.planningPhase!=='paused' || !Number.isSafeInteger(crime.planningObservedAt) || crime.planningObservedAt>asOf || asOf-crime.planningObservedAt>60000 || !Array.isArray(crime.slots) || !crime.slots.length)return false;
    let occupied=0,vacant=0;
    for(const slot of crime.slots){
      if(slot.user===null){vacant++;continue;}
      if(!slot.user?.id || vacant || slot.planningState!=='planning' || slot.planningPercent!==100)return false;
      occupied++;
    }
    return occupied>0 && vacant>0;
  }

  function plannerSlots(crimes, defs, now) {
    const occupied = new Set(); const open = []; const soon = new Map();
    for (const crime of crimes) {
      const status = String(crime.status).toLowerCase();
      if (!['recruiting', 'planning'].includes(status) || !Array.isArray(crime.slots)) continue;
      const def = plannerDefinition(crime.name, defs);
      const counts = {};
      for (const slot of crime.slots) {
        const base = normalize(slot.position);
        counts[base] = (counts[base] || 0) + 1;
      }
      const emptySlots=crime.slots.filter(s=>s.user===null).length;
      const completedGap=crime.stallDeadline && typeof plannerPausedStaffingGap==='function' && plannerPausedStaffingGap(crime,now);
      const progress=crime.stallDeadline?(plannerProgressCoverage(crime,now) || (completedGap?{deadline:now}:null)):null;
      const occurrence = {};
      crime.slots.forEach((slot, index) => {
        const base = normalize(slot.position);
        occurrence[base] = (occurrence[base] || 0) + 1;
        const label = slot.position_info?.label;
        const labelKey = label && def && Object.keys(def.roles).find(r => normalize(r) === normalize(label));
        const role = labelKey || (counts[base] > 1 ? `${slot.position}${occurrence[base]}` : slot.position);
        const person = slot.user?.id;
        if (person) occupied.add(String(person));
        const ready = Number(crime.ready_at) * 1000;
        if (person && status === 'planning' && crime.isExpiring!==true && !['paused','member-unavailable','item-missing','expiring','in-progress'].includes(crime.planningPhase) && Number(crime.ready_at) > 0 && ready >= now && ready <= now + PLANNER_FORECAST_MS) {
          const id = String(person);
          if (!soon.has(id) || soon.get(id).readyAt < ready) soon.set(id, { readyAt: ready, crime: crime.name, role, crimeId: crime.id });
        }
        const expiresKnown = Number.isFinite(progress?.deadline) || Number(crime.expired_at) > 0;
        const expires = progress?.deadline ?? (Number(crime.expired_at)>0 ? Number(crime.expired_at)*1000 : crime.pageScan ? Infinity : 0);
        if (!person && slot.user === null && status === 'recruiting' && (expires > now || crime.stallDeadline) && def) {
          const weight = Object.entries(def.roles).find(([r]) => normalize(r) === normalize(role))?.[1];
          if (Number.isFinite(weight)) open.push({ key: `${crime.id}:${index}`, crimeId: crime.id, crime: crime.name,
            role, level: Number(crime.difficulty) || def.level, weight, roleCount: crime.slots.length,
            opening:crime.slots.every(s=>s.user===null),startable:crime.slots.every(s=>s.user===null) && crime.planningPhase==='recruiting' && crime.isExpiring===false,
            expiresAt: crime.stallDeadline?Infinity:expires, expiresKnown, stallAt:crime.stallDeadline && expiresKnown?expires:null, coverageSource:completedGap?'completed-stage-gap':progress?'member-progress':'countdown-fallback', emptySlots, filledSlots:crime.slots.length-emptySlots, itemId: slot.item_requirement?.id || null });
        }
      });
    }
    return { occupied, open, soon };
  }

  function plannerReleaseTimeline(state,asOf) {
    const counts={planning:0,recruiting:0},rows=[],owners=new Map(),duplicates=new Set();
    const blocked=new Set(['paused','member-unavailable','item-missing','expiring','in-progress']);
    for(const crime of state.crimes || []){
      const status=String(crime.status).toLowerCase();
      if(!['planning','recruiting'].includes(status))continue;
      counts[status]++;
      const slots=crime.slots || [],ids=slots.filter(slot=>slot.user?.id).map(slot=>String(slot.user.id));
      for(const id of ids){if(owners.has(id))duplicates.add(id);else owners.set(id,String(crime.id));}
      const vacancies=slots.filter(slot=>slot.user===null).length;
      const row={crimeId:String(crime.id),crime:crime.name,status,memberIds:[...new Set(ids)],memberCount:new Set(ids).size,vacancies,expectedAt:null,kind:'unknown',reason:'A readable current timer is required.'};
      const ready=Number(crime.ready_at)*1000;
      if(status==='planning' && crime.isExpiring!==true && slots.length && ids.length===slots.length && !blocked.has(crime.planningPhase) && Number.isFinite(ready) && ready>0){
        row.expectedAt=ready;row.kind=ready>=asOf?'scanned':'overdue';
        row.reason=row.kind==='scanned'?'Scanned full-crew timer; release remains conditional until Torn confirms the OC has finished.':'Timer elapsed; verify initiation/completion and scan again. Members remain occupied.';
      }else if(status==='recruiting' && crime.isExpiring===false && vacancies && slots.every(slot=>slot.user===null || slot.user?.id)){
        const empty=vacancies===slots.length && crime.planningPhase==='recruiting';
        const progress=plannerProgressCoverage(crime,asOf);
        const paused=typeof plannerPausedStaffingGap==='function' && plannerPausedStaffingGap(crime,asOf);
        const gap=empty?asOf:progress?.deadline ?? (paused?asOf:!blocked.has(crime.planningPhase) && Number(crime.expired_at)>0?Number(crime.expired_at)*1000:null);
        const duration=Number(crime.planningSecondsPerSlot)>0?Number(crime.planningSecondsPerSlot)*1000:24*3600000;
        if(Number.isFinite(gap)){
          row.expectedAt=Math.max(asOf,gap)+vacancies*duration;row.kind='conditional';
          row.reason=(empty?'If the first member joins now':'If each remaining role joins before its uncovered stage')+', the earliest planning finish is shown. Later staffing is unresolved; this is not available crew supply.';
        }
      }
      rows.push(row);
    }
    for(const row of rows)if(row.memberIds.some(id=>duplicates.has(id))){row.kind='unknown';row.expectedAt=null;row.reason='Conflicting member occupancy across scanned OCs; rescan before forecasting releases.';}
    rows.sort((a,b)=>(a.expectedAt ?? Infinity)-(b.expectedAt ?? Infinity) || a.crimeId.localeCompare(b.crimeId));
    return {counts,rows,next:rows.find(row=>row.kind==='scanned') || null};
  }

  function renderPlannerReleaseTimeline(state,plan) {
    const timeline=plan.active.releases;
    if(!timeline)return '';
    const names=new Map((state.members || []).map(member=>[String(member.id),member.name || member.id]));
    const next=timeline.next;
    return `<details class="blom-section" data-bl-disclosure-key="crew-release-timeline" open><summary><span>OC conveyor / crew releases</span><span class="blom-mini-badge">${timeline.counts.planning} planning · ${timeline.counts.recruiting} recruiting</span></summary><div class="blom-section-body"><p class="blom-placement-note">${next?`Next scanned crew timer ends in ${escapeHtml(plannerTime(next.expectedAt))}: ${escapeHtml(next.crime)} #${escapeHtml(next.crimeId)} · ${next.memberCount} joined members.`:'No full-crew release time is verified in this scan.'} A timer is an expected initiation/completion point, not proof that anyone is free. Only scanned full-crew timers within 24h feed the allocation forecast.</p>${timeline.rows.map(row=>{
      const routes=[...plan.next].filter(([id])=>row.memberIds.includes(String(id)));
      return `<div class="blom-placement-note"><strong>${escapeHtml(row.crime)} #${escapeHtml(row.crimeId)}</strong> · ${row.memberCount} actually joined · ${row.vacancies} vacancies<br>${row.kind==='scanned'?'Expected crew timer end':row.kind==='conditional'?'Conditional earliest planning finish':row.kind==='overdue'?'Timer elapsed':'Timing unverified'}${row.expectedAt?': '+escapeHtml(new Date(row.expectedAt).toLocaleString('en-GB',{timeZone:'Europe/London',hour12:false}))+' · '+escapeHtml(plannerTime(row.expectedAt)):''}<br>${escapeHtml(row.reason)}${routes.length?routes.map(([id,fit])=>`<div class="blom-placement-meta">${escapeHtml(names.get(String(id)) || id)} → L${fit.level} ${escapeHtml(fit.crime)} #${escapeHtml(fit.crimeId)} · ${escapeHtml(prettyRole(fit.role))} · join by ${escapeHtml(plannerTime(fit.joinByAt))}</div>`).join(''):row.kind==='scanned'?'<div class="blom-placement-meta">No next-role allocation for this release yet; role CPR, timing and commitments still apply.</div>':''}</div>`;
    }).join('')}</div></details>`;
  }

  function plannerSpareAction(member,plan,assessment,prefs) {
    if(assessment.needed.trackingError)return {kind:'needs-review',text:assessment.needed.trackingError};
    const id=String(member.id),crews=assessment.needed.crews.filter(crew=>crew.ids.includes(id));
    if(crews.length)return {kind:'new-start',text:'Proposed new-OC candidate: '+[...new Set(crews.map(crew=>crew.label))].join(', ')+'. Review Scope and spawn one, then scan its actual roles; this is conditional until the OC exists.'};
    if(assessment.releaseStart?.currentIds.includes(id)){
      const forecast=assessment.releaseStart,when=new Date(forecast.startAt).toLocaleString('en-GB',{timeZone:'Europe/London',hour12:false});
      return {kind:forecast.scopeReady?'new-start':'needs-review',text:'Conditional new-start candidate after crew release at '+when+': reassess one '+forecast.label+' OC using the free members and qualifying finishers. Confirm completion, run Fresh shared scan and recheck Scope first. Exact roles depend on the actual random outcome; this is not an existing-role assignment.'+(!forecast.scopeReady?' Scope/policy review: '+forecast.scopeReason:'')};
    }
    const fits=(plan.active.open || []).filter(slot=>plannerFit(id,slot,prefs));
    const used=new Set([...plan.now.values(),...plan.next.values()].map(fit=>fit.key));
    if(fits.some(slot=>!slot.openingUnsupported && !used.has(slot.key)))return {kind:'next-review',text:'Qualifying role evidence exists, but this role is held by opening support or unresolved timing checks. Review the OC timer and starter/follower support, then rescan.'};
    if(fits.some(slot=>!slot.openingUnsupported)){
      const names=new Map([...(plan.available || []),...(plan.upcoming || [])].map(member=>[String(member.id),member.name || String(member.id)]));
      const owners=fits.filter(slot=>!slot.openingUnsupported).map(slot=>{
        const entry=[...plan.now,...plan.next].find(([,fit])=>fit.key===slot.key);
        if(!entry)return null;const [owner]=entry;
        return prettyRole(slot.role)+' → '+(names.get(String(owner)) || String(owner))+' ('+(plan.mailedHeld?.has(String(owner))?'sent invitation':plan.next.has(String(owner))?'unsent forecast':'current recommendation')+')';
      }).filter(Boolean);
      return {kind:'next-review',text:'Qualifying roles are allocated: '+owners.join('; ')+'. No qualifying rearrangement was found without displacing a sent invitation, breaking staffing support or leaving another free member idle. Review another suitable vacancy or supported start.'};
    }
    if(plannerLevelFloor(id,prefs).highest>=7 && plan.idleL8Fallback?.issues.has(id))return {kind:'needs-fit',text:plan.idleL8Fallback.issues.get(id)};
    const held=fits.find(slot=>!used.has(slot.key) && slot.openingUnsupported);
    if(held)return {kind:'held',text:held.openingHoldReason || 'A suitable role exists, but this empty OC lacks a distinct timely follower. Review the starter/follower pair.'};
    if(assessment.needed.fulfilled)return {kind:'needs-review',text:'The previous spawn request is accounted for. Review the actual new OCs and scan after joins; another new start is not currently requested for this pool.'};
    if(assessment.needed.highEndHold && plannerLevelFloor(id,prefs).highest>=8)return {kind:'needs-fit',text:'L8 capacity is already in use. No qualifying existing L7/L8 role was found for this member under current CPR and level settings. Review missing role CPR or a suitable existing L7 opening; another random L7–8 spawn can create a second L8.'};
    if(plan.spawningBlocked)return {kind:'needs-review',text:'No qualifying existing-role allocation. New-start advice is held by unassessed OCs or an unresolved invitation conflict; review those checks.'};
    return {kind:'needs-fit',text:'No eligible next-role or supported new-start pair found in this scan. Check selected levels, exact-role CPR and distinct follower availability; no destination has been invented.'};
  }

  function plannerMemberWorkOrders(plan,assessment,prefs) {
    return plan.available.map(member=>{
      const id=String(member.id),fit=plan.now.get(id);
      if(fit){
        const priority=fit.idleL8Fallback || fit.idleExistingFallback?4:(fit.assignmentPriority || 1);
        return {member,priority,kind:'assigned',text:(priority===4?(fit.idleExistingFallback?'Last-resort existing OC placement':'Last-resort L8 placement'):priority===3?'Start an existing OC':priority===2?'Cover an existing stage within 48 hours':'Cover an urgent existing gap')+': '+fit.crime+' — '+prettyRole(fit.role)+'. Review and join the assigned role.'};
      }
      if(plan.mailedHeld?.has(id))return {member,priority:5,kind:'manager-action',text:'Manager action required: review the outstanding invitation for this member before issuing a different assignment.'};
      if(member.status?.state && member.status.state!=='Okay')return {member,priority:5,kind:'manager-action',text:'Manager action required: member is currently '+member.status.state+'. Resolve availability and rescan before assigning a role.'};
      const action=plannerSpareAction(member,plan,assessment,prefs);
      return {member,priority:action.kind==='new-start'?3:5,kind:action.kind==='new-start'?'new-start':'manager-action',text:(action.kind==='new-start'?'':'Manager action required: ')+action.text};
    }).sort((a,b)=>a.priority-b.priority || String(a.member.name || a.member.id).localeCompare(String(b.member.name || b.member.id)));
  }

  // Completion is a staffing assessment, never a probability of success.
  // Joined people stay in their actual roles; only verified free/near-term
  // candidates can cover vacancies. Unique crews share one remaining pool.
  function plannerCompletionAssessment(state,defs,members,prefs,readiness=new Map(),commitments=new Map(),held=new Set(),timingSlots=[]) {
    const claimed=new Set([...held].map(String)),rows=[];
    let highCommitted=state.crimes.some(c=>(Number(c.difficulty)||defs[c.name]?.level)===8 && ['recruiting','planning'].includes(c.status) && c.slots?.some(s=>s.user?.id)) || [...commitments.values()].some(f=>f.level===8);
    const crimes=state.crimes.filter(c=>['recruiting','planning'].includes(String(c.status).toLowerCase()));
    const urgency=crime=>Math.min(Infinity,...timingSlots.filter(t=>String(t.crimeId)===String(crime.id)).map(t=>Number.isFinite(t.stallAt)?t.stallAt:t.expiresAt));
    const ordered=[...crimes].sort((a,b)=>Number(urgency(a)>(prefs.asOf||Date.now())+24*3600000)-Number(urgency(b)>(prefs.asOf||Date.now())+24*3600000) || urgency(a)-urgency(b) || Number(b.slots?.some(s=>s.user?.id))-Number(a.slots?.some(s=>s.user?.id)) ||
      (Number(b.difficulty)||defs[b.name]?.level||0)-(Number(a.difficulty)||defs[a.name]?.level||0) || String(a.id).localeCompare(String(b.id)));
    for(const crime of ordered){
      const def=plannerDefinition(crime.name,defs),slots=crime.slots || [],issues=[],allowed=new Map();
      const counts={},seen={};let occupied=0,qualified=0;
      for(const slot of slots)counts[normalize(slot.position)]=(counts[normalize(slot.position)]||0)+1;
      const vacancies=[];
      slots.forEach((slot,index)=>{
        const base=normalize(slot.position);seen[base]=(seen[base]||0)+1;
        const label=slot.position_info?.label;
        const role=Object.keys(def?.roles || {}).find(r=>normalize(r)===normalize(label || '')) || (counts[base]>1?`${slot.position}${seen[base]}`:slot.position);
        const weight=Object.entries(def?.roles || {}).find(([r])=>normalize(r)===normalize(role))?.[1];
        const target=def && Number.isFinite(weight)?mainScriptTarget(crime.name,Number(crime.difficulty)||def.level,weight,slots.length,role):null;
        if(slot.user?.id){
          occupied++;
          const obs=plannerObservation(String(slot.user.id),crime.name,role,false);
          if(target!==null && obs && obs.kind==='Observed' && obs.seen && !obs.stale && obs.cpr>=target-((Number(crime.difficulty)||def.level)===8?3:0))qualified++;
          else issues.push(`${prettyRole(role)}: ${obs && target!==null && obs.cpr<target?obs.cpr+'% CPR / '+target+'% target':'CPR needs verification'}`);
        }else if(slot.user===null && target!==null)vacancies.push({key:`${crime.id}:${index}`,crimeId:crime.id,crime:crime.name,role,weight,level:Number(crime.difficulty)||def.level,roleCount:slots.length,expiresAt:Number(crime.expired_at)>0?Number(crime.expired_at)*1000:Infinity,expiresKnown:true});
        else issues.push(`${prettyRole(role)}: role or occupancy unknown`);
      });
      const level=Number(crime.difficulty)||def?.level;
      const ownsHigh=slots.some(s=>s.user?.id) || [...commitments.values()].some(f=>String(f.crimeId)===String(crime.id));
      if(level===8 && highCommitted && !ownsHigh)issues.push('One L8 at a time — existing or selected L8 has priority');
      if(!def || !slots.length || slots.length!==Object.keys(def?.roles || {}).length)issues.push('Complete role definition required');
      const fixed=new Map([...commitments].filter(([,fit])=>String(fit.crimeId)===String(crime.id)));
      const fixedKeys=new Set([...fixed.values()].map(f=>f.key));
      const managed=!Array.isArray(prefs.levels) || prefs.levels.includes(level);
      const pool=members.filter(m=>managed && !claimed.has(String(m.id)) && !commitments.has(String(m.id)));
      const pending=vacancies.filter(v=>!fixedKeys.has(v.key)).map(v=>({...v,...timingSlots.find(t=>t.key===v.key)}));
      const matched=timingSlots.length?plannerAssignStaged(pool,pending,{...prefs,maxOpeningStages:0},readiness,fixed):plannerAssign(pool,pending,prefs,readiness);
      const reliable=fit=>fit.kind==='Observed' && fit.seen && !fit.stale;
      for(const [id,fit] of [...fixed,...matched]){
        if(!reliable(fit) || fit.cpr<fit.target && !fit.l8Shortfall){issues.push(`${prettyRole(fit.role)}: provisional or below-target candidate`);continue;}
        allowed.set(fit.key,String(id));
      }
      const missing=vacancies.filter(v=>!allowed.has(v.key)).map(v=>prettyRole(v.role));
      if(missing.length)issues.push('Missing suitable members: '+missing.join(', '));
      const complete=issues.length===0 && qualified+allowed.size===slots.length;
      if(complete && managed){for(const id of allowed.values())claimed.add(id);if(level===8)highCommitted=true;}
      rows.push({crimeId:String(crime.id),crime:crime.name,level:Number(crime.difficulty)||def?.level,total:slots.length,occupied,qualified,covered:qualified+allowed.size,complete,issues,allowed});
    }
    return rows;
  }

  function plannerOpeningSupport(slots,members,prefs,mailedHeld=new Set(),readiness=new Map(),commitments=new Map()) {
    const groups=new Map();
    for(const slot of slots)if(slot.opening){const id=String(slot.crimeId);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(slot);}
    const support=new Map();
    for(const [id,roles] of groups){
      const available=members.filter(m=>!mailedHeld.has(String(m.id)) && (!readiness.has(String(m.id)) || !Number.isFinite(roles[0].expiresAt) || roles[0].expiresAt>readiness.get(String(m.id))));
      const matched=plannerAssign(available,roles.map(s=>({...s,stallAt:null,expiresAt:Infinity})),{...prefs,rescueExisting:false,urgentFirst:false});
      const committedRoles=new Set([...commitments.values()].filter(f=>String(f.crimeId)===id).map(f=>f.key));
      const remainingRoles=roles.filter(r=>!committedRoles.has(r.key));
      const additional=committedRoles.size?plannerAssign(available,remainingRoles.map(s=>({...s,stallAt:null,expiresAt:Infinity})),{...prefs,rescueExisting:false,urgentFirst:false}):matched;
      const count=committedRoles.size+additional.size,required=Math.min(2,roles[0].roleCount);
      support.set(id,{continuationCount:count,continuationRatio:count/roles[0].roleCount,openingUnsupported:count<required});
    }
    // This faction can sustain one L8 at a time. Occupants and sent mail
    // keep ownership; never start a competing empty belt with spare specialists.
    const committed=new Set((prefs.highEndCommittedIds || []).map(String));
    for(const fit of commitments.values())if(fit.level===8)committed.add(String(fit.crimeId));
    const openings=[...groups.entries()].filter(([,roles])=>roles[0].level===8)
      .sort((a,b)=>Number(support.get(a[0]).openingUnsupported)-Number(support.get(b[0]).openingUnsupported) || support.get(b[0]).continuationCount-support.get(a[0]).continuationCount || String(a[0]).localeCompare(String(b[0])));
    const chosen=committed.size?null:openings.find(([id])=>!support.get(id).openingUnsupported)?.[0];
    for(const [id] of openings)if(!committed.has(id) && id!==chosen)
      support.set(id,{...support.get(id),openingUnsupported:true,openingHoldReason:'Hold starting this L8 — support the existing or selected L8 first. This faction is limited to one L8 at a time.'});
    return slots.map(slot=>slot.openingUnsupported?slot:support.has(String(slot.crimeId))?{...slot,...support.get(String(slot.crimeId))}:slot);
  }

  function plannerLevelFloor(id,prefs={}) {
    if(typeof plannerWeights!=='function')return {highest:0,minimum:1};
    // Capability protection uses recorded experience even when older observations
    // are excluded from current role eligibility. Deselected levels still count.
    const context=typeof plannerInputContext!=='undefined' && plannerInputContext?.shared?plannerInputContext:prefs;
    const cache=plannerLevelFloor.cache || (plannerLevelFloor.cache=new WeakMap());
    if(!cache.has(context))cache.set(context,new Map());
    const members=cache.get(context),key=String(id);if(members.has(key))return members.get(key);
    let highest=0;const averages=new Map();
    for(const [crime,def] of Object.entries(plannerWeights())){
      const entries=Object.entries(def.roles || {}),level=Number(def.level);
      if(!Number.isInteger(level) || level<1 || level>10)continue;
      for(const [role,weight] of entries){
        const observation=plannerObservation(key,crime,role,true);
        if(!observation || !Number.isFinite(observation.cpr) || observation.cpr<0 || observation.cpr>100)continue;
        if(!averages.has(level))averages.set(level,[]);averages.get(level).push(observation.cpr);
        if(observation.cpr>=mainScriptTarget(crime,level,weight,entries.length,role))highest=Math.max(highest,level);
      }
    }
    // Honour the Member best level shown in the Manager as well as exact-role fits.
    for(const [level,values] of averages)if(values.reduce((a,b)=>a+b,0)/values.length>=67)highest=Math.max(highest,level);
    const result={highest,minimum:Math.max(1,highest-1)};members.set(key,result);return result;
  }

  function plannerLowerLevelTrial(memberId,slot) {
    // Cross-role trials need measured paired evidence and a qualifying role one
    // level higher. They are never observations or speculative spawn support.
    const state=typeof plannerInputContext!=='undefined'?plannerInputContext:null;
    if(!state?.shared || slot.crimeId==null || !Number.isInteger(Number(slot.level)) || Number(slot.level)<1 || Number(slot.level)>=8)return null;
    if(plannerObservation(String(memberId),slot.crime,slot.role,true))return null;
    const cache=plannerLowerLevelTrial.cache || (plannerLowerLevelTrial.cache=new WeakMap());
    if(!cache.has(state))cache.set(state,new Map());
    const memo=cache.get(state),key=JSON.stringify([String(memberId),slot.crime,slot.role,slot.level]);
    if(memo.has(key))return memo.get(key);
    const measured=value=>value?.kind==='Observed' && value.seen && !value.stale && Number.isFinite(value.cpr) && value.cpr>=0 && value.cpr<=100;
    const peers=[...new Set((state.members || []).map(member=>String(member.id)))].filter(id=>id!==String(memberId));
    const candidates=[];
    for(const [crime,def] of Object.entries(plannerWeights())){
      if(Number(def.level)!==Number(slot.level)+1)continue;
      const roles=Object.entries(def.roles || {});
      for(const [role,weight] of roles){
        const observed=plannerObservation(String(memberId),crime,role,false);
        if(!measured(observed) || observed.cpr<mainScriptTarget(crime,Number(def.level),weight,roles.length,role))continue;
        const differences=[];let seen=observed.seen;
        for(const id of peers){
          const from=plannerObservation(id,crime,role,false),to=plannerObservation(id,slot.crime,slot.role,false);
          if(!measured(from) || !measured(to) || Math.abs(from.cpr-observed.cpr)>10)continue;
          differences.push(to.cpr-from.cpr);seen=Math.min(seen,from.seen,to.seen);
        }
        differences.sort((a,b)=>a-b);
        if(differences.length<3 || differences.at(-1)-differences[0]>10)continue;
        const adjustment=differences[Math.floor((differences.length-1)*0.25)]-2;
        const cpr=Math.max(0,Math.min(100,observed.cpr+adjustment));
        candidates.push({cpr,kind:'Estimated',seen,stale:false,confidence:'Low · provisional trial',trialPlacement:true,
          source:`Provisional L${slot.level} role trial from qualifying L${def.level} ${crime} / ${role}: ${observed.cpr}%; ${differences.length} measured paired peers within 10 source CPR points, lower-quartile difference ${adjustment+2} minus 2-point margin. Different role skills may vary. Check actual destination CPR after joining, collect it and run a fresh shared scan.`,
          estimatedFrom:{crime,role,level:Number(def.level),cpr:observed.cpr,method:'lower-level-peer-trial',peerCount:differences.length,adjustment,allowance:2}});
      }
    }
    // Do not select the most optimistic source when several bridges disagree.
    candidates.sort((a,b)=>a.cpr-b.cpr || b.estimatedFrom.peerCount-a.estimatedFrom.peerCount || a.source.localeCompare(b.source));
    const result=candidates[0] || null;memo.set(key,result);return result;
  }

  function plannerEstimatedRole(memberId,slot) {
    // Estimates are transient planning evidence, never uploaded as observations.
    // Keep known destination data authoritative, even when stale/below target.
    if(plannerObservation(String(memberId),slot.crime,slot.role,true))return null;
    const base=role=>normalize(String(role).replace(/[\s#\d]+$/,''));
    const candidates=[];
    for(const [crime,def] of Object.entries(plannerWeights())){
      const delta=Number(slot.level)-Number(def.level);
      if(Math.abs(delta)>1)continue;
      for(const role of Object.keys(def.roles || {})){
        if(normalize(crime)===normalize(slot.crime) && normalize(role)===normalize(slot.role) || base(role)!==base(slot.role))continue;
        const observed=plannerObservation(String(memberId),crime,role,false);
        if(!observed || observed.kind!=='Observed' || !observed.seen || observed.stale)continue;
        // Heuristic allowances, not a calibrated prediction: 2 points at the
        // same/lower destination level, 7 points when stepping up one level.
        const allowance=delta>0?7:2;
        // Calibrate against distinct peers with measured readings at both ends.
        // Use nearby source scores and a conservative lower quartile of deltas;
        // a small or inconsistent sample retains the explicit heuristic fallback.
        const peers=typeof plannerInputContext!=='undefined' && plannerInputContext?.shared?plannerInputContext.members || []:[];
        const differences=[],seenPeers=new Set();
        for(const peer of peers){
          const id=String(peer.id);if(id===String(memberId) || seenPeers.has(id))continue;seenPeers.add(id);
          const from=plannerObservation(id,crime,role,false),to=plannerObservation(id,slot.crime,slot.role,false);
          const measured=value=>value?.kind==='Observed' && value.seen && !value.stale && Number.isFinite(value.cpr) && value.cpr>=0 && value.cpr<=100;
          if(!measured(from) || !measured(to) || Math.abs(from.cpr-observed.cpr)>10)continue;
          differences.push(to.cpr-from.cpr);
        }
        differences.sort((a,b)=>a-b);
        const calibrated=differences.length>=3 && differences.at(-1)-differences[0]<=10;
        const adjustment=calibrated?differences[Math.floor((differences.length-1)*0.25)]-2:-allowance;
        const cpr=Math.max(0,Math.min(100,observed.cpr+adjustment));
        const evidence=calibrated?`${differences.length} paired peers within 10 source CPR points; lower-quartile destination difference ${adjustment+2}, minus 2-point planning margin`:`heuristic minus ${allowance} points (insufficient consistent paired peer evidence)`;
        candidates.push({cpr,source:`Provisional estimate from L${def.level} ${crime} / ${role}: ${observed.cpr}%; ${evidence}; verify destination CPR after joining`,kind:'Estimated',seen:observed.seen,stale:false,confidence:'Low · provisional',estimatedFrom:{crime,role,level:Number(def.level),cpr:observed.cpr,allowance,method:calibrated?'paired-peers':'heuristic',peerCount:differences.length,adjustment}});
      }
    }
    // Prefer the closest level; use the lowest estimate when sources disagree.
    candidates.sort((a,b)=>Math.abs(a.estimatedFrom.level-slot.level)-Math.abs(b.estimatedFrom.level-slot.level) || a.cpr-b.cpr);
    return candidates[0] || (typeof plannerLowerLevelTrial==='function'?plannerLowerLevelTrial(memberId,slot):null);
  }

  function plannerFit(id, slot, prefs, honourSentInvitation=false) {
    const observation = plannerObservation(id, slot.crime, slot.role, prefs.includeStale) ||
      (slot.crimeId!=null && typeof plannerEstimatedRole==='function' ? plannerEstimatedRole(id,slot) : null);
    const target = mainScriptTarget(slot.crime, slot.level, slot.weight, slot.roleCount, slot.role);
    // L8 uses the strongest available role fit, allowing a small shortfall.
    // Targets and recorded observations remain unchanged; larger gaps fail.
    const l8Shortfall=Number(slot.level)===8 && observation?Math.max(0,target-observation.cpr):0;
    if (!observation || observation.cpr < target && (Number(slot.level)!==8 || l8Shortfall>3)) return null;
    let levelRescue=false;
    if(!honourSentInvitation){
      const capability=plannerLevelFloor(id,prefs);
      // Apply the same one-level limit to existing roles and every spawn outcome.
      const minimum=capability.minimum;
      // Urgency changes allocation order, never a member's minimum level.
      if(Number(slot.level)<minimum)return null;
    }
    return { ...slot, ...observation, target, margin: observation.cpr - target, l8Shortfall, levelRescue, capabilityLevel: plannerLevelFloor(id,prefs).highest };
  }

  function plannerCapability(id, defs, prefs) {
    const qualifying = [];
    let recorded = 0, excludedStale = false;
    for (const [crime, def] of Object.entries(defs)) {
      const roles = Object.entries(def.roles);
      for (const [role, weight] of roles) {
        const observation = plannerObservation(String(id), crime, role, prefs.includeStale);
        if (!observation) {
          if (!prefs.includeStale && plannerObservation(String(id), crime, role, true)?.stale) excludedStale = true;
          continue;
        }
        recorded++;
        const target = mainScriptTarget(crime, def.level, weight, roles.length, role);
        if (observation.cpr >= target) qualifying.push({crime,role,level:Number(def.level),weight,roleCount:roles.length,...observation,target,margin:observation.cpr-target});
      }
    }
    qualifying.sort((a,b) => b.level-a.level || plannerOrder(a,b));
    return {best:qualifying[0] || null,recorded,excludedStale};
  }

  function plannerOrder(a, b) {
    const deadlineA=Number.isFinite(a.stallAt)?a.stallAt:Infinity,deadlineB=Number.isFinite(b.stallAt)?b.stallAt:Infinity;
    return deadlineA-deadlineB || (Number.isFinite(a.stallAt) && Number.isFinite(b.stallAt)?a.emptySlots-b.emptySlots:0) || (a.level===8 && b.level===8?b.cpr-a.cpr:0) || Number(a.kind === 'Estimated') - Number(b.kind === 'Estimated') ||
      Number(a.stale) - Number(b.stale) || b.level - a.level || b.margin - a.margin ||
      b.weight - a.weight || (a.crime>b.crime?1:a.crime<b.crime?-1:0) || (a.role>b.role?1:a.role<b.role?-1:0) || (String(a.crimeId || '')>String(b.crimeId || '')?1:String(a.crimeId || '')<String(b.crimeId || '')?-1:0) || (String(a.key || '')>String(b.key || '')?1:String(a.key || '')<String(b.key || '')?-1:0);
  }

  function plannerAssign(members, slots, prefs, readiness = new Map()) {
    // Visit the highest selected vacancies first. Augmenting paths keep those
    // slots covered while finding placements for constrained lower-level members.
    const candidates=new Map(slots.map(slot=>[slot.key,members
      .filter(m=>!readiness.has(String(m.id))
        ? slot.expiresAt>(prefs.asOf || Date.now())
        : slot.expiresKnown!==false && (prefs.stallPriority && Number.isFinite(slot.stallAt)?slot.stallAt:slot.expiresAt)>readiness.get(String(m.id)))
      .filter(m=>!readiness.has(String(m.id)) || !Number.isFinite(prefs.maxQueueWaitHours) || (slot.startable || Number.isFinite(slot.stallAt) && Math.max(0,slot.stallAt-readiness.get(String(m.id)))<=prefs.maxQueueWaitHours*3600000))
      .map(m=>({id:String(m.id),fit:plannerFit(String(m.id),slot,prefs)})).filter(x=>x.fit)]));
    const breadth=new Map(),highest=new Map();
    for(const list of candidates.values())for(const {id,fit} of list){
      breadth.set(id,(breadth.get(id)||0)+1);
      highest.set(id,Math.max(highest.get(id)||0,fit.level));
    }
    // Use members with lower ceilings first, preserving the more capable member
    // when either can fill the same role. CPR thresholds still decide eligibility.
    for(const list of candidates.values())list.sort((a,b)=>(a.fit.level===8 && b.fit.level===8?b.fit.cpr-a.fit.cpr:0) || Number(a.fit.kind==='Estimated')-Number(b.fit.kind==='Estimated') || Math.abs((a.fit.capabilityLevel ?? highest.get(a.id))-a.fit.level)-Math.abs((b.fit.capabilityLevel ?? highest.get(b.id))-b.fit.level) || breadth.get(a.id)-breadth.get(b.id) || plannerOrder(a.fit,b.fit) || (a.id>b.id?1:a.id<b.id?-1:0));
    const owner=new Map();
    function placeSlot(key,seen){
      for(const candidate of candidates.get(key)){
        if(seen.has(candidate.id))continue;seen.add(candidate.id);
        const old=owner.get(candidate.id);
        if(!old || placeSlot(old.fit.key,seen)){owner.set(candidate.id,candidate);return true;}
      }
      return false;
    }
    for(const slot of [...slots].sort((a,b)=>(prefs.capabilityFirst?Number((b.stallAt ?? b.expiresAt)<=(prefs.asOf || Date.now())+24*3600000)-Number((a.stallAt ?? a.expiresAt)<=(prefs.asOf || Date.now())+24*3600000):0) || (prefs.urgentFirst && (!prefs.capabilityFirst || Math.min(a.stallAt ?? a.expiresAt,b.stallAt ?? b.expiresAt)<=(prefs.asOf || Date.now())+24*3600000)?(Number.isFinite(a.stallAt)?a.stallAt:Number.isFinite(a.expiresAt)?a.expiresAt:Infinity)-(Number.isFinite(b.stallAt)?b.stallAt:Number.isFinite(b.expiresAt)?b.expiresAt:Infinity):0) || b.level-a.level || plannerOrder({...a,kind:'Observed',margin:0,stale:false},{...b,kind:'Observed',margin:0,stale:false})))placeSlot(slot.key,new Set());
    return new Map([...owner].map(([id,row])=>[id,row.fit]));
  }

  function plannerStagedDeadline(slot,earlierJoins,asOf) {
    // Ordinary planning is covered sequentially. True expiry never extends.
    if(slot.startable && Number.isFinite(slot.planningStartAt))return slot.planningStartAt+earlierJoins*24*3600000;
    return Number.isFinite(slot.stallAt)?Math.max(asOf || Date.now(),slot.stallAt)+earlierJoins*24*3600000:slot.expiresAt;
  }
  function plannerAssignStaged(members,slots,prefs,readiness,prior=new Map()) {
    const result=new Map(),counts=new Map(),used=new Set(),anchors=new Map();
    for(const [id,fit] of prior){used.add(id);counts.set(String(fit.crimeId),(counts.get(String(fit.crimeId))||0)+1);if(fit.startable && Number.isFinite(fit.planningStartAt))anchors.set(String(fit.crimeId),fit.planningStartAt);}
    let remaining=slots.map(slot=>anchors.has(String(slot.crimeId))?{...slot,planningStartAt:anchors.get(String(slot.crimeId))}:slot);
    while(remaining.length){
      const adjusted=remaining.filter(slot=>!slot.startable || !prefs.maxOpeningStages || (counts.get(String(slot.crimeId))||0)<prefs.maxOpeningStages).map(slot=>({...slot,stallAt:Number.isFinite(slot.stallAt)?plannerStagedDeadline(slot,counts.get(String(slot.crimeId))||0,prefs.asOf):slot.stallAt}));
      const batch=plannerAssign(members.filter(m=>!used.has(String(m.id))),adjusted,prefs,readiness);
      if(!batch.size)break;
      const keys=new Set();
      for(const [id,fit] of [...batch].sort((a,b)=>(readiness.get(a[0]) || prefs.asOf)-(readiness.get(b[0]) || prefs.asOf) || a[0].localeCompare(b[0]))){
        const original=remaining.find(s=>s.key===fit.key);
        if(original.startable && prefs.maxOpeningStages && (counts.get(String(fit.crimeId))||0)>=prefs.maxOpeningStages)continue;
        const stageAt=plannerStagedDeadline(original,counts.get(String(fit.crimeId))||0,prefs.asOf);
        if(readiness.has(id) && Number.isFinite(prefs.maxQueueWaitHours) && (!Number.isFinite(stageAt) || stageAt-readiness.get(id)>prefs.maxQueueWaitHours*3600000))continue;
        result.set(id,{...fit,stallAt:original.stallAt,joinByAt:plannerStagedDeadline(original,counts.get(String(fit.crimeId))||0,prefs.asOf),conditionalPlanning:true,queueWaitHours:Math.max(0,(plannerStagedDeadline(original,counts.get(String(fit.crimeId))||0,prefs.asOf)-(readiness.get(id) || prefs.asOf))/3600000)});
        used.add(id);keys.add(fit.key);counts.set(String(fit.crimeId),(counts.get(String(fit.crimeId))||0)+1);
      }
      if(!keys.size)break;
      remaining=remaining.filter(s=>!keys.has(s.key));
    }
    return result;
  }

  function plannerConveyorAssign(members,slots,prefs,readiness=new Map(),prior=new Map()) {
    // Cover each next join, optionally adding one timely follow-on per OC.
    // An invitation is conditional coverage, not an actual join.
    const counts=new Map(),keys=new Set(),anchors=new Map();
    for(const fit of prior.values()){counts.set(String(fit.crimeId),(counts.get(String(fit.crimeId))||0)+1);keys.add(fit.key);if(fit.startable && Number.isFinite(fit.planningStartAt))anchors.set(String(fit.crimeId),fit.planningStartAt);}
    const groups=new Map();
    for(let slot of slots){
      if(keys.has(slot.key) || slot.openingUnsupported)continue;
      const crime=String(slot.crimeId),ordinary=slot.startable || Number.isFinite(slot.stallAt) || slot.expiresKnown===false;
      const count=counts.get(crime)||0;
      if((prefs.conveyorFollowOn || prefs.conveyorWindowHours) && ordinary){
        // Empty openings and forecast followers retain the initial pair cap.
        // Running current-member stages may extend only to the explicit window.
        if(((slot.opening || !prefs.conveyorWindowHours) && count>=2) || (slot.startable && !anchors.has(crime)))continue;
        const original=anchors.has(crime)?{...slot,planningStartAt:anchors.get(crime)}:slot;
        const stageAt=plannerStagedDeadline(original,count,prefs.asOf);
        if(!Number.isFinite(stageAt))continue;
        slot={...slot,startable:false,stallAt:stageAt,expiresKnown:true,planningStartAt:anchors.get(crime)};
      }else if(ordinary && (count>0 || (!slot.startable && Number.isFinite(slot.stallAt) && slot.stallAt>(prefs.asOf || Date.now())+24*3600000)))continue;
      const groupKey=ordinary?'coverage:'+crime:slot.key;
      if(!groups.has(groupKey))groups.set(groupKey,[]);groups.get(groupKey).push(slot);
    }
    const candidates=new Map();
    for(const [key,alternatives] of groups){
      const list=[];
      for(const member of members){
        const id=String(member.id);if(prior.has(id))continue;
        const options=alternatives.filter(slot=>{
          const stageAt=plannerStagedDeadline(slot,0,prefs.asOf);
          if(!readiness.has(id))return !(prefs.conveyorFollowOn || prefs.conveyorWindowHours) || stageAt<=(prefs.asOf || Date.now())+(prefs.conveyorWindowHours || 24)*3600000;
          const ready=readiness.get(id);
          return (slot.startable || slot.expiresKnown!==false && (Number.isFinite(slot.stallAt)?stageAt>=ready:stageAt>ready)) &&
            (!Number.isFinite(prefs.maxQueueWaitHours) || stageAt-ready<=prefs.maxQueueWaitHours*3600000);
        }).map(slot=>plannerFit(id,slot,prefs)).filter(Boolean).sort(plannerOrder);
        if(options[0])list.push({id,fit:options[0],group:key});
      }
      candidates.set(key,list);
    }
    const breadth=new Map();for(const list of candidates.values())for(const row of list)breadth.set(row.id,(breadth.get(row.id)||0)+1);
    for(const list of candidates.values())list.sort((a,b)=>(a.fit.level===8 && b.fit.level===8?b.fit.cpr-a.fit.cpr:0) || Number(a.fit.kind==='Estimated')-Number(b.fit.kind==='Estimated') || Number(!!a.fit.levelRescue)-Number(!!b.fit.levelRescue) || breadth.get(a.id)-breadth.get(b.id) || plannerOrder(a.fit,b.fit) || a.id.localeCompare(b.id));
    const owner=new Map();
    function place(key,seen){for(const row of candidates.get(key) || []){if(seen.has(row.id))continue;seen.add(row.id);const old=owner.get(row.id);if(!old || place(old.group,seen)){owner.set(row.id,row);return true;}}return false;}
    for(const [key] of [...groups].sort((a,b)=>{const x=a[1][0],y=b[1][0];return Number(!!x.opening)-Number(!!y.opening) || (x.opening && y.opening?(y.continuationRatio || 0)-(x.continuationRatio || 0):0) || (prefs.urgentFirst?(Number.isFinite(x.stallAt)?x.stallAt:x.expiresAt)-(Number.isFinite(y.stallAt)?y.stallAt:y.expiresAt):0) || y.level-x.level || plannerOrder({...x,margin:0},{...y,margin:0});}))place(key,new Set());
    return new Map([...owner].map(([id,row])=>[id,{...row.fit,joinByAt:row.fit.startable?(readiness.get(id) || prefs.asOf):plannerStagedDeadline(row.fit,0,prefs.asOf),planningStartAt:row.fit.startable?(readiness.get(id) || prefs.asOf):row.fit.planningStartAt,conditionalPlanning:Number.isFinite(row.fit.stallAt)}]));
  }

  function plannerSpawnCrew(members, slots, fits, breadth, preferredIds = new Set()) {
    // Maximum-cardinality, minimum-cost matching. Quality comes first, then preserve
    // versatile members instead of consuming the only useful specialist unnecessarily.
    const people=[...new Map(members.map(m=>[String(m.id),m])).values()];
    const source=0,firstPerson=1,firstSlot=1+people.length,sink=firstSlot+slots.length;
    const graph=Array.from({length:sink+1},()=>[]);
    function edge(from,to,cost,fit=null,id=null) {
      const forward={to,rev:graph[to].length,cap:1,cost,fit,id};
      const reverse={to:from,rev:graph[from].length,cap:0,cost:-cost};
      graph[from].push(forward);graph[to].push(reverse);
    }
    people.forEach((member,i)=>{
      const id=String(member.id);edge(source,firstPerson+i,0);
      slots.forEach((slot,j)=>{
        const fit=fits.get(id)?.get(slot.key);if(!fit)return;
        const uncertain=fit.kind==='Estimated' || fit.kind==='Recorded high' || !fit.seen || fit.stale;
        const quality=fit.level===8?Math.round((100-fit.cpr)*100000)+(fit.stale?1000:0)+(uncertain?100:0):(fit.stale?1000000:0)+(uncertain?100000:0);
        edge(firstPerson+i,firstSlot+j,quality+(fit.level===8?0:(breadth.get(id)||0)*100-Math.min(100,Math.max(0,fit.margin)))-(preferredIds.has(id)?10000000:0),fit,id);
      });
    });
    slots.forEach((_,j)=>edge(firstSlot+j,sink,0));
    while(true) {
      const distance=Array(graph.length).fill(Infinity),previous=Array(graph.length).fill(null);
      distance[source]=0;
      for(let pass=0;pass<graph.length-1;pass++) {
        let changed=false;
        for(let node=0;node<graph.length;node++) {
          if(!Number.isFinite(distance[node]))continue;
          graph[node].forEach((e,index)=>{
            if(e.cap && distance[node]+e.cost<distance[e.to]) {
              distance[e.to]=distance[node]+e.cost;previous[e.to]=[node,index];changed=true;
            }
          });
        }
        if(!changed)break;
      }
      if(!previous[sink])break;
      for(let node=sink;node!==source;) {
        const [from,index]=previous[node],e=graph[from][index];e.cap--;graph[node][e.rev].cap++;node=from;
      }
    }
    const assigned=new Map();
    people.forEach((_,i)=>graph[firstPerson+i].forEach(e=>{if(e.fit && e.cap===0)assigned.set(e.id,e.fit);}));
    return assigned;
  }

  function plannerDailyCrew(nowMembers,horizons,crime,def,prefs) {
    const pool=new Map(nowMembers.map(m=>[String(m.id),{member:m,hours:0}]));
    for(const horizon of horizons)for(const member of horizon.members){
      const id=String(member.id),exact=prefs.memberReadyHours?.[id],hours=Number.isFinite(exact)?exact:horizon.hours;
      if(hours>=0 && hours<=24 && (!pool.has(id) || hours<pool.get(id).hours))pool.set(id,{member,hours});
    }
    const roles=Object.entries(def.roles);
    if(roles.length>16)return {assigned:new Map(),schedule:[],complete:false,nextDeadline:0,unsupported:true};
    const required=Math.min(2,roles.length);
    const preferFuture=prefs.preferFutureFollower===true || def.level===8;
    function compareCrew(a,b){
      const uncertain=crew=>crew.filter(r=>r.fit.kind==='Estimated' || r.fit.kind==='Recorded high' || !r.fit.seen || r.fit.stale).length;
      return (def.level===8?b.reduce((sum,row)=>sum+row.fit.cpr,0)-a.reduce((sum,row)=>sum+row.fit.cpr,0):0) || uncertain(a)-uncertain(b) || (prefs.releasePreferredIds?b.filter(r=>prefs.releasePreferredIds.includes(r.id)).length-a.filter(r=>prefs.releasePreferredIds.includes(r.id)).length:0) || a.filter(r=>r.availableHours===0).length-b.filter(r=>r.availableHours===0).length || (a.at(-1)?.availableHours || 0)-(b.at(-1)?.availableHours || 0);
    }
    const states=new Map([[0,[]]]);
    for(const {member,hours} of [...pool.values()].sort((a,b)=>a.hours-b.hours || Number(a.member.id)-Number(b.member.id))){
      if(member.ocEligible===false || (member.status?.state && member.status.state!=='Okay'))continue;
      const fits=roles.map(([role,weight],index)=>plannerFit(String(member.id),{key:`spawn:${crime}:${index}`,crime,role,weight,level:def.level,roleCount:roles.length,expiresAt:Infinity,expiresKnown:true},prefs));
      // A member is considered once. State masks retain the earliest feasible
      // arrival sequence for each set of filled roles, preventing greedy role traps.
      for(const [mask,crew] of [...states]){
        if(crew.length>=required)continue;
        const deadline=crew.length*24;if(hours>deadline)continue;
        for(let i=0;i<roles.length;i++)if(!(mask & (1<<i)) && fits[i]){
          const next=mask | (1<<i),candidate=[...crew,{id:String(member.id),fit:fits[i],availableHours:hours,joinByHours:deadline}];
          if(states.has(next) && (!preferFuture || compareCrew(candidate,states.get(next))>=0))continue;
          states.set(next,candidate);
        }
      }
    }
    const schedule=[...states.values()].sort((a,b)=>b.length-a.length || (preferFuture?compareCrew(a,b):0) || (a.at(-1)?.availableHours || 0)-(b.at(-1)?.availableHours || 0))[0];
    return {schedule,assigned:new Map(schedule.map(row=>[row.id,row.fit])),complete:required>0 && schedule.length===required,fullCrewComplete:schedule.length===roles.length,required,remainingRoles:Math.max(0,roles.length-schedule.length),nextDeadline:schedule.length*24};
  }

  function plannerSpawnNeeded(members,defs,prefs,protectedHigh=new Map(),horizons=[]) {
    prefs={...prefs,preferFutureFollower:true,initialStages:2};
    let remaining=[...new Map(members.map(m=>[String(m.id),m])).values()];
    const reserved=new Set(),groups=new Map(),crews=[];
    const budget=prefs.spawnBudget;
    const budgetKnown=budget && Number.isSafeInteger(budget.balance) && Number.isSafeInteger(budget.reserve ?? 50) && (budget.reserve ?? 50)>=0 && Number.isFinite(budget.updatedAt) && Date.now()-budget.updatedAt>=0 && Date.now()-budget.updatedAt<=15*60000;
    let spendable=budgetKnown?Math.max(0,budget.balance-(budget.reserve ?? 50)):Infinity;
    let assessment=null;
    function initialOutcomes(current,arrivals,outcomes) {
      const assess=pool=>outcomes.map(o=>{
        const daily=plannerDailyCrew(pool,arrivals,o.crime,defs[o.crime],prefs);
        return {...o,daily,plannedCrew:daily.assigned,plannedUncertain:daily.schedule.filter(row=>row.fit.kind==='Estimated' || row.fit.kind==='Recorded high' || !row.fit.seen || row.fit.stale).length};
      });
      const all=assess(current),supported=rows=>rows.length>0 && rows.every(o=>o.daily.complete && o.plannedUncertain===0);
      if(!supported(all) || current.length>12)return all;
      // Minimise the current pool held across random outcomes. This avoids one
      // speculative draw reserving most free people for alternative starter roles.
      for(let size=1;size<=2;size++){
        let best=null,bestCount=Infinity;
        for(let i=0;i<current.length;i++)for(let j=size===1?i:i+1;j<(size===1?i+1:current.length);j++){
          const rows=assess(size===1?[current[i]]:[current[i],current[j]]);if(!supported(rows))continue;
          const count=new Set(rows.flatMap(o=>o.daily.schedule.map(row=>row.id))).size;
          if(count<bestCount){best=rows;bestCount=count;}
        }
        if(best)return best;
      }
      return all;
    }
    while(remaining.length || assessment===null){
      const future=horizons.map(h=>({...h,members:h.members.filter(m=>!reserved.has(String(m.id)))}));
      const high=plannerPreparation(remaining,future,defs,{...prefs,spawnBrackets:true,levels:plannerSelectedLevels(prefs).filter(l=>l>=7)});
      const lower=plannerPreparation(remaining.filter(m=>!protectedHigh.has(String(m.id))),future.map(h=>({...h,members:h.members.filter(m=>!protectedHigh.has(String(m.id)))})),defs,{...prefs,spawnBrackets:true,levels:plannerSelectedLevels(prefs).filter(l=>l<7)});
      const options=[...high.levels,...lower.levels].map(l=>{const low=l.level<7;const current=low?remaining.filter(m=>!protectedHigh.has(String(m.id))):remaining;const arrivals=low?future.map(h=>({...h,members:h.members.filter(m=>!protectedHigh.has(String(m.id)))})):future;const outcomes=initialOutcomes(current,arrivals,l.outcomes);return {...l,outcomes,dailyCovered:outcomes.filter(o=>o.daily.complete).length,historyWeak:(prefs.learning || []).length>0 && l.outcomes.some(o=>plannerHistoryAssessment(o.crime,prefs.learning).weak)};});
      // Require a distinct starter and next join for every random outcome.
      // Partial evidence remains visible, but cannot create another spend request.
      const viable=options.filter(l=>!(l.level>=7 && (prefs.highEndSpawnBlocked || crews.some(c=>c.level>=7))) && !prefs.spawningBlocked && l.outcomes.every(o=>o.plannedUncertain===0) && l.outcomes.length>0 && l.dailyCovered===l.outcomes.length && l.seeded>0 && !l.historyWeak && plannerScopeCost(l)<=spendable);
      const full=viable.filter(l=>l.dailyCovered===l.outcomes.length).sort((a,b)=>a.readyHours-b.readyHours || b.level-a.level)[0];
      if(assessment===null)assessment={levels:options,best:full || null};
      const bracket=[...viable].sort((a,b)=>b.dailyCovered/b.outcomes.length-a.dailyCovered/a.outcomes.length || b.level-a.level)[0];if(!bracket)break;
      const first=bracket.outcomes.find(o=>o.daily.schedule.length);
      const arrival=first?.daily.schedule[0];if(!arrival)break;
      const starter={id:arrival.id,fit:arrival.fit,outcome:first};
      // Alternative crimes share a reservation; different proposed OCs do not.
      const ids=new Set(bracket.outcomes.flatMap(o=>o.daily.schedule.map(row=>row.id)));
      const currentIds=remaining.filter(m=>ids.has(String(m.id))).map(m=>String(m.id));
      const label=plannerSpawnLabel(bracket),partial=bracket.dailyCovered!==bracket.outcomes.length;
      if(!groups.has(label))groups.set(label,{level:bracket.level,label,count:0,partial:0,members:0});
      const group=groups.get(label);group.count++;group.members+=currentIds.length;if(partial)group.partial++;
      spendable-=plannerScopeCost(bracket);
      crews.push({label,level:bracket.level,ids:[...ids],partial,readyHours:bracket.readyHours,outcomes:bracket.outcomes,starter:{id:starter.id,crime:starter.outcome.crime,role:starter.fit.role,cpr:starter.fit.cpr},starterCoverage:bracket.seeded+'/'+bracket.outcomes.length});
      for(const id of ids)reserved.add(id);
      remaining=remaining.filter(m=>!reserved.has(String(m.id)));
    }
    return {groups:[...groups.values()].sort((a,b)=>a.level-b.level),crews,remaining,assessment};
  }

  // A manual best-fit alternative when the spare pool cannot cover every
  // random outcome. Never add it to supported quantities or reserve its people.
  function plannerSpawnOpportunity(assessment,members,state,plan,prefs) {
    const current=new Set(members.filter(m=>m.ocEligible!==false && (!m.status?.state || m.status.state==='Okay')).map(m=>String(m.id)));
    const reserved=new Set([...(plan.now?.keys() || []),...(plan.next?.keys() || []),...(plan.coverageReservations?.keys() || []),...(plan.mailedHeld || [])].map(String));
    const candidates=(assessment?.levels || []).map(level=>{
      const supported=level.outcomes.filter(o=>o.daily?.complete && o.plannedUncertain===0 &&
        o.daily.schedule.length>0 && current.has(String(o.daily.schedule[0].id)) &&
        o.daily.schedule.every(row=>!reserved.has(String(row.id))));
      const ids=new Set(supported.flatMap(o=>o.daily.schedule.filter(row=>current.has(String(row.id))).map(row=>String(row.id))));
      const distance=supported.flatMap(o=>o.daily.schedule.filter(row=>current.has(String(row.id))).map(row=>Math.abs((row.fit.capabilityLevel || row.fit.level)-row.fit.level)));
      return {...level,supported,ids:[...ids],coverage:supported.length/level.outcomes.length,
        capabilityDistance:distance.length?distance.reduce((a,b)=>a+b,0)/distance.length:Infinity,
        unsupported:level.outcomes.filter(o=>!supported.includes(o)).map(o=>o.crime)};
    }).filter(level=>level.supported.length>0 && level.supported.length<level.outcomes.length && !level.historyWeak);
    for(const level of candidates){
      level.decision={allowed:false,reason:'Hold spawning — this bracket has unsupported crime outcomes. Torn chooses the crime; a starter and a distinct next join are required for every outcome; later staffing is reassessed.'};
      if(!state.shared || !Number.isFinite(state.scannedAt) || Date.now()-state.scannedAt<0 || Date.now()-state.scannedAt>5*60000)
        level.decision={allowed:false,reason:'Fresh shared scan required before considering a spawn.'};
    }
    candidates.sort((a,b)=>Number(b.decision.allowed)-Number(a.decision.allowed) || b.coverage-a.coverage || b.ids.length-a.ids.length || a.capabilityDistance-b.capabilityDistance || b.level-a.level);
    return candidates[0] || null;
  }

  function plannerSpawnLabel(level) {return level?.bracket?`L${level.bracket[0]}–${level.bracket[1]}`:`L${level?.level}`;}
  function plannerSpawnAdvice(members,defs,prefs,minLevel,maxLevel,preferredIds = new Set()) {
    if(prefs.spawnBrackets){const selected=plannerSelectedLevels(prefs);prefs={...prefs,levels:[...new Set(selected.flatMap(l=>{const low=2*Math.floor((l-1)/2)+1;return [low,low+1];}))]};}
    members=[...new Map(members.filter(m=>m.ocEligible!==false && (!m.status?.state || m.status.state==='Okay')).map(m=>[String(m.id),m])).values()];
    const levels=new Map(),fits=new Map(members.map(m=>[String(m.id),new Map()])),breadth=new Map();
    const crimes=Object.entries(defs).filter(([,def])=>plannerManagedLevel(def.level,prefs) && def.level>=minLevel && def.level<=maxLevel).map(([crime,def])=>{
      const roles=Object.entries(def.roles);
      const slots=roles.map(([role,weight],index)=>({key:`spawn:${crime}:${index}`,crime,role,weight,
        level:def.level,roleCount:roles.length,expiresAt:Infinity,expiresKnown:true}));
      for(const member of members)for(const slot of slots) {
        const id=String(member.id),fit=plannerFit(id,slot,prefs);
        if(fit){fits.get(id).set(slot.key,fit);breadth.set(id,(breadth.get(id)||0)+1);}
      }
      return {crime,def,slots};
    });
    for(const {crime,def,slots} of crimes) {
      const assigned=plannerSpawnCrew(members,slots,fits,breadth,preferredIds);
      const used=new Set([...assigned.values()].map(f=>f.role));
      const candidates=slots.map(slot=>({slot,count:members.filter(m=>fits.get(String(m.id)).has(slot.key)).length}));
      const complete=assigned.size===slots.length;
      const margins=[...assigned.values()].map(f=>Number(f.margin)||0);
      // Two candidates per role alone is insufficient: shared specialists can still
      // leave no valid unique crew. Verify resilience to losing any assigned person.
      const vulnerable=complete?[...assigned.keys()].filter(id=>plannerSpawnCrew(members.filter(m=>String(m.id)!==id),slots,fits,breadth).size<slots.length):[];
      const uncertain=[...assigned.values()].filter(f=>f.kind==='Estimated' || f.kind==='Recorded high' || !f.seen || f.stale).length;
      const outcome={crime,total:slots.length,filled:assigned.size,assigned,
        minCandidates:candidates.length?Math.min(...candidates.map(x=>x.count)):0,
        weakRoles:candidates.filter(x=>x.count<=1).map(x=>x.slot.role),vulnerableCount:vulnerable.length,
        weakestMargin:margins.length?Math.min(...margins):0,
        avgMargin:margins.length?margins.reduce((a,b)=>a+b,0)/margins.length:0,
        missing:slots.map(s=>s.role).filter(r=>!used.has(r)),uncertain,complete};
      outcome.robust=complete && vulnerable.length===0;
      outcome.level=def.level;
      const group=prefs.spawnBrackets?2*Math.floor((def.level-1)/2)+1:def.level;
      if(!levels.has(group))levels.set(group,[]);
      levels.get(group).push(outcome);
    }
    return [...levels].map(([level,outcomes])=>({level,outcomes,bracket:prefs.spawnBrackets?[level,level+1]:null,
      qualifiedMembers:new Set(outcomes.flatMap(o=>members.filter(m=>[...fits.get(String(m.id)).values()].some(f=>f.crime===o.crime)).map(m=>String(m.id)))).size,
      worst:Math.min(...outcomes.map(o=>o.filled/o.total)),
      minFilled:Math.min(...outcomes.map(o=>o.filled)),maxFilled:Math.max(...outcomes.map(o=>o.filled)),
      full:outcomes.filter(o=>o.complete).length,
      robust:outcomes.filter(o=>o.robust).length,
      fullRate:outcomes.filter(o=>o.complete).length/outcomes.length,
      robustRate:outcomes.filter(o=>o.robust).length/outcomes.length
    })).sort((a,b)=>b.fullRate-a.fullRate || b.robustRate-a.robustRate || b.level-a.level);
  }

  function plannerSpawnSummary(members,defs,prefs) {
    // A level does not identify the actual crime. Do not reserve an imaginary crew
    // or multiply best-case examples into a claimed multi-spawn capacity.
    const recommendation=plannerSpawnRecommendation(members,defs,prefs),next=recommendation.best;
    if(!next)return {groups:[],picks:[],remaining:members.length};
    const pick={level:next.level,outcome:next.best,robust:next.best.robust};
    return {groups:[{levels:new Set([next.level]),count:1,crimes:new Set([next.best.crime]),picks:[pick]}],picks:[pick],remaining:Math.max(0,members.length-next.best.total)};
  }

  function plannerHistoryAssessment(crime,learning=[]) {
    const row=learning.find(r=>normalize(r.crime)===normalize(crime));
    const successes=Number(row?.successes),failures=Number(row?.failures),n=successes+failures;
    if(!Number.isSafeInteger(successes)||successes<0||!Number.isSafeInteger(failures)||failures<0||!n)return {n:0,weak:false,text:'No shared outcome evidence'};
    const p=successes/n,z=1.96,denom=1+z*z/n;
    const radius=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n));
    const upper=(p+z*z/(2*n)+radius)/denom;
    // Cautious empirical screen, not a calibrated prediction for a particular crew.
    const weak=n>=20 && upper<0.75;
    return {n,weak,rate:p,upper,text:`${successes}/${n} recorded successes · ${n<20?'limited evidence':weak?'weak historical results':'history available'} · historical crews, not this crew\u2019s success probability`};
  }
  function readVisibleScopeBalance() {
    if(!managerPageActive())return null;
    const values=new Set();
    function number(node){
      if(!node || node.closest('#'+PANEL_ID+',#blom-inline-scan,.blom-inline-slot,[data-oc-id]'))return;
      const text=node.textContent.trim();if(!/^\d[\d,]*$/.test(text))return;
      const value=Number(text.replace(/,/g,''));if(Number.isSafeInteger(value) && value>=0)values.add(value);
    }
    // First use explicit Scope labels, then the balance beside the spawn controls.
    for(const node of document.querySelectorAll('[class*="scope" i],[data-scope],[aria-label*="scope" i],[title*="scope" i]')){
      if(node.children.length===0)number(node);
      else for(const child of node.querySelectorAll('span,strong,b'))if(child.children.length===0)number(child);
    }
    if(values.size===0)for(const button of document.querySelectorAll('button,[role="button"],a')){
      if(!/^spawn(?:\s|$)/i.test(button.textContent.trim()) || button.closest('#'+PANEL_ID))continue;
      let parent=button.parentElement;
      for(let depth=0;parent && depth<4;depth++,parent=parent.parentElement){
        if(!/difficulty|new scenario|operations/i.test(parent.textContent))continue;
        for(const node of parent.querySelectorAll('span,strong,b,div')){
          if(node.children.length || button.contains(node) || node.closest('button,[role="button"]'))continue;
          // A separate number within the SPAWN control is its cost, not the bank.
          if(/^spawn/i.test(node.parentElement?.textContent.trim() || ''))continue;
          number(node);
        }
        break;
      }
    }
    return values.size===1?[...values][0]:null;
  }
  function liveScopeBank() {
    const roster=blRoster();if(!roster)return null;
    const bank=readJSON('black-ledger-scope-bank-v1:'+roster.viewerId+':'+roster.factionId,null);
    return bank && Number.isSafeInteger(bank.balance) && Date.now()-bank.observedAt<15*60000?bank:null;
  }
  function captureScopeBank() {
    const roster=blRoster();if(!roster || roster.viewerId!==String(getViewerId() || ''))return;
    const balance=readVisibleScopeBalance();if(balance===null)return;
    const key='black-ledger-scope-bank-v1:'+roster.viewerId+':'+roster.factionId,old=readJSON(key,null);
    const delta=old?balance-old.balance:0;
    const events=old?.events || [];
    if(delta)events.push({at:Date.now(),delta,balance});
    blStorageSet(key,JSON.stringify({balance,observedAt:Date.now(),events:events.slice(-50)}));
    if(delta<0){refreshPlannerSpawnReview(null,{});plannerState=null;plannerError='Scope spent on Torn. Scan Recruiting + Planning to refresh OC placements.';renderPlannerIfOpen();}
    else if(delta>0)renderPlannerIfOpen();
  }
  function applyLiveScopeBudget(prefs,crimes=null) {
    const bank=liveScopeBank();if(!bank)return prefs.spawnBudget || null;
    const costs=Object.fromEntries(Array.from({length:10},(_,i)=>[i+1,Math.ceil((i+1)/2)]));
    return {...prefs.spawnBudget,balance:bank.balance,reserve:prefs.spawnBudget?.reserve ?? 50,costs,updatedAt:bank.observedAt,knownCrimeIds:crimes?crimes.map(c=>String(c.id)):prefs.spawnBudget?.knownCrimeIds || []};
  }

  function plannerScopeCost(level) {
    const value=Number(typeof level==='object'?(level.bracket?.[0] ?? level.level):level);
    return Number.isInteger(value) && value>=1 && value<=10?Math.ceil(value/2):null;
  }
  function plannerSpawnDecision(level,state,plan,prefs,forecast=false) {
    if(!state.shared)return {allowed:true,reason:''};
    if(plan.spawningBlocked)return {allowed:false,reason:'Hold spawning — resolve unassessed OCs or invitation conflicts before using the remaining pool.'};
    if(!level)return {allowed:false,reason:'Hold spawning — no supported starter / next-join pair.'};
    if(level.level>=7 && (state.crimes || []).some(c=>(Number(c.difficulty) || plan.defs?.[c.name]?.level || (typeof plannerWeights==='function'?plannerWeights()[c.name]?.level:0))===8 && ['recruiting','planning'].includes(c.status)))return {allowed:false,reason:'Hold L7–8 spawning — an L8 OC already exists. Support it first; this faction is limited to one L8 at a time. A random L7–8 spawn can create another L8.'};
    if(level.allReliable===false)return {allowed:false,reason:'Verify crew CPR before spending Scope: this level depends on estimated, stale or undated readings.'};
    if(plan.assignmentConflicts?.some(issue=>!issue.id || !plan.mailedHeld?.has(String(issue.id))))return {allowed:false,reason:'Review the assignment / spawn trade-offs first. A conflict could not be isolated to a held member.'};

    const weak=level.outcomes.filter(o=>plannerHistoryAssessment(o.crime,prefs.learning || []).weak);
    if(weak.length)return {allowed:false,reason:`Hold this level — weak recorded results for ${weak.map(o=>o.crime).join(', ')}. Torn may spawn any of these crimes. Review the evidence before spending Scope.`};
    if(forecast)return {allowed:false,reason:'Prepare the crew, then wait until its members are actually free. Future staffing does not justify spending Scope yet.'};
    const budget=prefs.spawnBudget,cost=plannerScopeCost(level),reserve=budget?.reserve ?? 50;
    if(!budget || !Number.isSafeInteger(budget.balance) || !Number.isSafeInteger(cost) || cost<=0 || !Number.isFinite(budget.updatedAt) || Math.max(prefs.asOf || 0,Date.now())-budget.updatedAt<0 || Math.max(prefs.asOf || 0,Date.now())-budget.updatedAt>15*60000)return {allowed:false,reason:`Crew is staffable; Scope budget is unverified or over 15 minutes old. Update the live balance before spending. Bracket costs are fixed at 1–5 Scope. Default reserve: ${reserve} Scope. Future success rewards are not counted.`};
    if(!Array.isArray(budget.knownCrimeIds) || state.crimes.some(c=>!budget.knownCrimeIds.includes(String(c.id))))return {allowed:false,reason:'An OC appeared since the Scope balance was entered. Update the live balance before recommending another spend; the old balance may already have been used.'};
    const remaining=budget.balance-cost;
    if(remaining<reserve)return {allowed:false,reason:`Hold spawning — ${plannerSpawnLabel(level)} costs ${cost} Scope and would leave ${remaining}, below the ${reserve}-Scope reserve. Unearned rewards are not counted.`};
    return {allowed:true,reason:`Consider one spawn: cost ${cost} Scope; ${remaining} remain against a ${reserve}-Scope reserve. Balance comes from the latest observed or entered Scope bank. Confirm it on Torn and rescan after spawning.`};
  }
  function plannerSpawnQuantityDecision(needed,state,plan,prefs) {
    const crew=needed.crews[0];
    if(!crew)return {allowed:false,reason:'No additional supported spawn from the unreserved pool.'};
    const reserved=new Set([...(plan.now?.keys() || []),...(plan.next?.keys() || []),...(plan.coverageReservations?.keys() || []),...(plan.mailedHeld || [])]);
    if(crew.ids.some(id=>reserved.has(String(id))) || !plan.available?.some(m=>String(m.id)===crew.starter?.id))return {allowed:false,reason:'Hold spawning — this crew overlaps an existing reservation or lacks a current starter.'};
    if(!crew.outcomes.length || crew.outcomes.some(o=>!o.daily?.complete || o.plannedUncertain>0) || !crew.starter?.id)return {allowed:false,reason:'Hold spawning — a reliable starter and next-stage candidate are missing.'};
    // A current starter plus independently reserved conditional arrivals is the
    // quantity policy; the whole crew does not need to be free at once.
    const level={level:crew.level,outcomes:crew.outcomes,allReliable:true};
    const decision=plannerSpawnDecision(level,state,plan,prefs,false);
    return {...decision,reason:decision.allowed?'Consider one '+crew.label+' spawn from the spare pool. '+decision.reason+' Later arrivals remain conditional; spawn one and rescan.':decision.reason};
  }

  function configurePlannerSpawnBudget() {
    const localPrefs=readJSON(PLANNER_PREFS,{});
    const saved=localPrefs.pendingScan?localPrefs:plannerState?.shared?plannerState.prefs:localPrefs,old=saved.spawnBudget;
    captureScopeBank();
    const live=liveScopeBank();
    const raw=live?String(live.balance):prompt('Scope display could not be read. Current faction OC Scope balance:',old?.balance ?? '');if(raw===null)return;
    const reserveRaw=prompt('Minimum Scope reserve:',old?.reserve ?? 50);if(reserveRaw===null)return;
    const balance=Number(raw),reserve=Number(reserveRaw),costs={};
    if(!raw.trim() || !reserveRaw.trim() || !Number.isSafeInteger(balance)||balance<0||!Number.isSafeInteger(reserve)||reserve<0){alert('Enter whole, non-negative balance and reserve values.');return;}
    for(let level=1;level<=10;level++)costs[level]=plannerScopeCost(level);
    blStorageSet(PLANNER_PREFS,JSON.stringify({...readJSON(PLANNER_PREFS,{}),...saved,pendingScan:true,spawnBudget:{balance,reserve,costs,updatedAt:Date.now(),knownCrimeIds:(plannerState?.crimes || []).map(c=>String(c.id))}}));
    renderPlannerIfOpen();
  }

  function plannerSpawnRecommendation(members,defs,prefs) {
    const levels=plannerSpawnAdvice(members,defs,prefs,1,10);
    const ranked=levels.map(level=>{
      const complete=level.outcomes.filter(o=>o.complete);
      const best=[...complete].sort((a,b)=>a.uncertain-b.uncertain || Number(b.robust)-Number(a.robust) ||
        b.weakestMargin-a.weakestMargin || a.total-b.total || (a.crime>b.crime?1:a.crime<b.crime?-1:0))[0] || null;
      const allComplete=complete.length===level.outcomes.length;
      const allReliable=allComplete && level.outcomes.every(o=>o.uncertain===0);
      const className=allComplete?(level.robustRate===1 && allReliable?'strong':'limit'):'risk';
      // Staffing coverage dominates level. Complete reliable choices precede an
      // uncertain or partial high-level option. No invented success probability.
      return {...level,best,allComplete,allReliable,className,
        weakestMargin:complete.length?Math.min(...complete.map(o=>o.weakestMargin)):0,
        gaps:level.outcomes.filter(o=>!o.complete)};
    }).sort((a,b)=>Number(b.allComplete)-Number(a.allComplete) ||
      Number(b.allReliable)-Number(a.allReliable) || b.fullRate-a.fullRate ||
      b.robustRate-a.robustRate || b.level-a.level || b.weakestMargin-a.weakestMargin);
    for(const level of ranked)level.historyWeak=!!prefs.learning && level.outcomes.some(o=>plannerHistoryAssessment(o.crime,prefs.learning).weak);
    const candidates=ranked.filter(x=>x.allComplete && !x.historyWeak);
    // Within reliable, affordable options prefer the highest qualifying level.
    // Cost gates spending; a cheaper lower level does not outrank a higher one.
    if(prefs.spawnBudget)candidates.sort((a,b)=>{
      const ca=plannerScopeCost(a),cb=plannerScopeCost(b);
      const affordable=c=>Number.isSafeInteger(c)&&c>0&&prefs.spawnBudget.balance-c>=(prefs.spawnBudget.reserve ?? 50);
      return Number(b.allReliable)-Number(a.allReliable) || Number(affordable(cb))-Number(affordable(ca)) || b.level-a.level || b.robustRate-a.robustRate || b.weakestMargin-a.weakestMargin;
    });
    return {best:candidates[0]||null,levels:ranked};
  }

  function plannerPreparation(nowMembers, horizons, defs, prefs) {
    if(prefs.initialStages===2){
      const selected=plannerSelectedLevels(prefs),levels=new Map();
      for(const [crime,def] of Object.entries(defs)){
        const level=2*Math.floor((def.level-1)/2)+1;
        if(!selected.some(value=>2*Math.floor((value-1)/2)+1===level))continue;
        const daily=plannerDailyCrew(nowMembers,horizons,crime,def,prefs),current=plannerDailyCrew(nowMembers,[],crime,def,prefs);
        const used=new Set([...daily.assigned.values()].map(f=>f.role));
        const outcome={crime,level:def.level,total:Object.keys(def.roles).length,filled:current.assigned.size,
          assigned:current.assigned,missing:Object.keys(def.roles).filter(role=>!used.has(role)),daily,
          readyHours:daily.complete?(daily.schedule.at(-1)?.availableHours || 0):null,
          plannedCrew:daily.assigned,plannedRobust:false,plannedUncertain:daily.schedule.filter(row=>row.fit.kind==='Estimated' || row.fit.kind==='Recorded high' || !row.fit.seen || row.fit.stale).length};
        if(!levels.has(level))levels.set(level,[]);levels.get(level).push(outcome);
      }
      const rows=[...levels].map(([level,outcomes])=>({level,bracket:[level,level+1],outcomes,
        seeded:outcomes.filter(o=>o.filled>0).length,dailyCovered:outcomes.filter(o=>o.daily.complete).length,
        readyHours:Math.max(0,...outcomes.map(o=>o.readyHours || 0))}));
      return {levels:rows,best:rows.find(l=>l.outcomes.length>0 && l.dailyCovered===l.outcomes.length) || null};
    }
    const nowIds=new Set(nowMembers.map(m=>String(m.id)));
    const current=plannerSpawnAdvice(nowMembers,defs,prefs,1,10);
    const forecastCache=new Map();
    const forecasts=horizons.map(({hours,members})=>{
      const pool=[...nowMembers,...members],key=pool.map(m=>String(m.id)).sort().join(',');
      if(!forecastCache.has(key))forecastCache.set(key,plannerSpawnAdvice(pool,defs,prefs,1,10,nowIds));
      return {hours,levels:forecastCache.get(key)};
    });
    const levels=current.map(level=>{
      const outcomes=level.outcomes.map(outcome=>{
        const future=forecasts.map(f=>({hours:f.hours,outcome:f.levels.find(l=>l.level===level.level)?.outcomes.find(o=>o.crime===outcome.crime)}));
        const possible=future.filter(f=>f.outcome?.complete && [...f.outcome.assigned.keys()].some(id=>nowIds.has(id)));
        const coverage=(level.level>=7?possible.find(f=>f.outcome.uncertain===0 && f.outcome.robust):null)||possible[0];
        return {...outcome,readyHours:outcome.complete?0:coverage?.hours??null,
          plannedCrew:outcome.complete?outcome.assigned:coverage?.outcome.assigned||outcome.assigned,
          plannedRobust:outcome.complete?outcome.robust:coverage?.outcome.robust||false,
          plannedUncertain:outcome.complete?outcome.uncertain:coverage?.outcome.uncertain||0};
      });
      const seeded=outcomes.filter(o=>o.filled>0).length;
      const covered=outcomes.filter(o=>o.filled>0 && o.readyHours!==null).length;
      const allCovered=outcomes.length>0 && covered===outcomes.length;
      const covered24=outcomes.filter(o=>o.filled>0 && o.readyHours!==null && o.readyHours<=24).length;
      const careful=level.level<7 || outcomes.every(o=>o.plannedUncertain===0 && o.plannedRobust);
      return {...level,outcomes,seeded,covered,covered24,allCovered,careful,
        readyHours:allCovered?Math.max(...outcomes.map(o=>o.readyHours)):null};
    }).sort((a,b)=>Number(b.allCovered)-Number(a.allCovered) ||
      (a.readyHours??Infinity)-(b.readyHours??Infinity) || b.covered/b.outcomes.length-a.covered/a.outcomes.length ||
      b.seeded/b.outcomes.length-a.seeded/a.outcomes.length || b.level-a.level);
    return {levels,best:levels.find(l=>l.allCovered && l.readyHours>0 && l.readyHours<=24 && l.careful)||null};
  }

  function plannerAssignmentGroups(assignments,members) {
    const byId=new Map(members.map(m=>[String(m.id),m]));
    const groups=new Map();
    for(const [id,fit] of assignments) {
      const key=String(fit.crimeId || fit.crime);
      if(!groups.has(key))groups.set(key,{crimeId:fit.crimeId||'',crime:fit.crime,level:fit.level,rows:[]});
      groups.get(key).rows.push({member:byId.get(String(id))||{id,name:id},fit});
    }
    return [...groups.values()].sort((a,b)=>b.level-a.level || (String(a.crime)>String(b.crime)?1:String(a.crime)<String(b.crime)?-1:0) || (String(a.crimeId)>String(b.crimeId)?1:String(a.crimeId)<String(b.crimeId)?-1:0));
  }

  function plannerAssignmentText(groups,title='Black Ledger OC assignments',future=false) {
    const lines=[title,''];
    for(const group of groups) {
      lines.push(`LEVEL ${group.level} — ${group.crime}${group.crimeId?` (#${group.crimeId})`:''}`);
      for(const row of group.rows.sort((a,b)=>(String(a.fit.role)>String(b.fit.role)?1:String(a.fit.role)<String(b.fit.role)?-1:0)))
        lines.push(`• ${row.member.name} [${row.member.id}] — ${prettyRole(row.fit.role)}`);
      lines.push('');
    }
    lines.push(future?'Once your current OC has finished, please join the assigned OC/role shown above. This is your next assignment; wait until your current OC is complete before joining.':'Please join the assigned OC/role when available.');
    return lines.join('\n');
  }

  function plannerTime(time) {
    const delta = Math.max(0, time - Date.now());
    return delta ? `${Math.floor(delta / 3600000)}h ${Math.ceil(delta % 3600000 / 60000)}m` : 'Due now · may be delayed';
  }

  let plannerObservationMembers=null;
  function blSafeCrimes(crimes) {
    return crimes.map(c=>({...c,slots:(c.slots || []).map(slot=>slot.user?.id && !blAllowed(slot.user.id)?{...slot,user:undefined}:slot)}));
  }
  function invalidateReviewForObservedOCs(crimes) {
    if(!plannerState?.shared || plannerBusy)return;
    if(crimes.some(c=>['recruiting','planning'].includes(c.status) && !plannerState.crimes.some(old=>String(old.id)===String(c.id)))){
      refreshPlannerSpawnReview(null,{});
      plannerState=null;
      plannerError='New OC observed. Run a fresh shared scan and review spawning before preparing more mail.';
      renderPlannerIfOpen();
    }
  }
  function plannerSpawnReviewKey(roster) {
    return 'black-ledger-spawn-review-v1:'+roster.viewerId+':'+roster.factionId;
  }
  function plannerReviewDigest(text) {
    // Synchronous SHA-256 over UTF-8: review checks must remain synchronous.
    const bytes=[];
    for(const char of text){
      let cp=char.codePointAt(0);if(cp>=0xd800 && cp<=0xdfff)cp=0xfffd;
      if(cp<0x80)bytes.push(cp);
      else if(cp<0x800)bytes.push(0xc0|(cp>>>6),0x80|(cp&63));
      else if(cp<0x10000)bytes.push(0xe0|(cp>>>12),0x80|((cp>>>6)&63),0x80|(cp&63));
      else bytes.push(0xf0|(cp>>>18),0x80|((cp>>>12)&63),0x80|((cp>>>6)&63),0x80|(cp&63));
    }
    const length=bytes.length;
    bytes.push(0x80);while(bytes.length%64!==56)bytes.push(0);
    const high=Math.floor(length/0x20000000),low=(length*8)>>>0;
    for(let shift=24;shift>=0;shift-=8)bytes.push((high>>>shift)&255);
    for(let shift=24;shift>=0;shift-=8)bytes.push((low>>>shift)&255);
    const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],w=new Int32Array(64);
    const rotate=(value,bits)=>(value>>>bits)|(value<<(32-bits));
    for(let offset=0;offset<bytes.length;offset+=64){
      for(let i=0;i<16;i++){const p=offset+i*4;w[i]=(bytes[p]<<24)|(bytes[p+1]<<16)|(bytes[p+2]<<8)|bytes[p+3];}
      for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(rotate(x,7)^rotate(x,18)^(x>>>3))+w[i-7]+(rotate(y,17)^rotate(y,19)^(y>>>10)))|0;}
      let [a,b,c,d,e,f,g,j]=h;
      for(let i=0;i<64;i++){
        const t1=(j+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+k[i]+w[i])|0;
        const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))|0;
        j=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      [a,b,c,d,e,f,g,j].forEach((value,i)=>{h[i]=(h[i]+value)|0;});
    }
    return 'sha256:'+h.map(value=>(value>>>0).toString(16).padStart(8,'0')).join('');
  }

  function plannerSpawnReviewSignature(state,prefs) {
    function canonical(value){
      if(Array.isArray(value))return value.map(canonical);
      if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
      return value;
    }
    const roster=blRoster();
    const sortRows=rows=>[...(rows || [])].sort((a,b)=>JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));
    return plannerReviewDigest(JSON.stringify(canonical({planningStrategy:'l8-placement-first-v30',
      crimes:sortRows((state.crimes || []).map(c=>({id:c.id,name:c.name,difficulty:c.difficulty,status:c.status,isExpiring:c.isExpiring,ready_at:c.ready_at,expired_at:c.expired_at,slots:c.slots}))),
      members:sortRows(state.members),profiles:sortRows(state.profiles),weights:state.weights,targetPolicy:state.targetPolicy,learning:state.learning,
      levels:plannerSelectedLevels(prefs).sort((a,b)=>a-b),includeStale:prefs.includeStale===true,
      budget:prefs.spawnBudget?{balance:prefs.spawnBudget.balance,reserve:prefs.spawnBudget.reserve}:null,
      decisions:roster?readJSON(plannerInvitationDecisionsKey(roster),{}):{}
    })));
  }
  function refreshPlannerSpawnReview(state,prefs) {
    const roster=blRoster();
    if(!roster)return {approved:false};
    const key=plannerSpawnReviewKey(roster),old=readJSON(key,null);
    const fresh=state?.shared && state.viewerId===roster.viewerId && Date.now()-state.scannedAt>=0 && Date.now()-state.scannedAt<300000 && !readJSON(PLANNER_PREFS,{}).pendingScan;
    const signature=fresh?plannerSpawnReviewSignature(state,prefs):null;
    const approved=!!fresh && old?.approved===true && old.signature===signature && old.expiresAt>Date.now();
    const review={version:1,viewerId:roster.viewerId,factionId:roster.factionId,signature,approved,expiresAt:fresh?state.scannedAt+300000:Date.now()};
    if(JSON.stringify(old)!==JSON.stringify(review)){
      blStorageSet(key,JSON.stringify(review));
      if(!approved){
        const draft=readJSON(PLANNER_NEWSLETTER_DRAFT_KEY,null);
        if(draft?.viewerId===roster.viewerId && draft?.factionId===roster.factionId)blStorageRemove(PLANNER_NEWSLETTER_DRAFT_KEY);
      }
    }
    return review;
  }
  function requirePlannerSpawnReview(state,prefs) {
    const review=refreshPlannerSpawnReview(state,prefs);
    if(!review.approved)throw new Error('Review spawning first. Spawn one and rescan, or choose No more spawning for this plan before preparing mail.');
    return review.signature;
  }
  function approvePlannerSpawnReview() {
    const roster=blRequireRoster(),state=plannerState;
    const prefs={...state?.prefs,spawnBrackets:true,spawnBudget:applyLiveScopeBudget(state?.prefs || {})};
    const review=refreshPlannerSpawnReview(state,prefs);
    if(!review.signature)throw new Error('Run a fresh shared scan before completing spawn review.');
    if(!confirm('Have you finished reviewing spawning for this plan?\n\nIf you want to spawn, do that first and rescan the actual crime. Confirming enables message preparation for this OC lineup; it does not spawn or send anything.'))return;
    if(plannerState!==state || plannerSpawnReviewSignature(state,{...prefs,spawnBudget:applyLiveScopeBudget(state.prefs)})!==review.signature || Date.now()>=review.expiresAt)throw new Error('The plan changed. Review again.');
    blStorageSet(plannerSpawnReviewKey(roster),JSON.stringify({...review,approved:true}));
    renderPlannerIfOpen();
  }

  function completeSpawnReviewAndShowMessages(body) {
    const prefs=()=>({...plannerState?.prefs,spawnBudget:applyLiveScopeBudget(plannerState?.prefs || {})});
    if(!refreshPlannerSpawnReview(plannerState,prefs()).approved)approvePlannerSpawnReview();
    // Approval can be cancelled, or invalidated while the confirmation is open.
    if(!refreshPlannerSpawnReview(plannerState,prefs()).approved)return;
    const section=body.querySelector('.blom-main-section');
    if(section){section.open=true;section.scrollIntoView({block:'start'});}
    body.querySelector('#blom-prepare-newsletter')?.focus({preventScroll:true});
  }

  function plannerInvitationDecisionsKey(roster) {
    return 'black-ledger-invitation-decisions-v1:'+roster.viewerId+':'+roster.factionId;
  }
  function plannerInvitationDecisionFingerprint(row) {
    return JSON.stringify([row.key,row.sentAt]);
  }
  function resolvePlannerInvitation(id,mode,expectedFingerprint=null) {
    if(!['release','keep'].includes(mode))throw new Error('Unknown invitation decision.');
    const roster=blRequireRoster();
    if(!plannerState?.shared || plannerState.viewerId!==roster.viewerId || Date.now()-plannerState.scannedAt>=300000 || readJSON(PLANNER_PREFS,{}).pendingScan)throw new Error('Run a fresh shared scan before deciding.');
    const history=readJSON('black-ledger-oc-pm-shared-v1:'+roster.viewerId+':'+roster.factionId,null),row=history?.members?.[id];
    if(!row || !blAllowed(id))throw new Error('Invitation or membership changed. Refresh and review again.');
    if(expectedFingerprint!==null && plannerInvitationDecisionFingerprint(row)!==expectedFingerprint)throw new Error('This invitation changed. Refresh and review the latest invitation before releasing it.');
    const decisionState=plannerState;
    const previous=plannerInputContext;plannerInputContext=plannerState;
    let issue;
    try{const plan=plannerPlan(plannerState,{...plannerState.prefs,spawnBrackets:true,spawnBudget:applyLiveScopeBudget(plannerState.prefs),learning:plannerState.learning || []});issue=plan.assignmentConflicts.find(c=>c.id===id) || (mode==='release'?plan.acceptedInvitations?.find(c=>c.id===id):null);}
    finally{plannerInputContext=previous;}
    // A normal invitation or a member already occupying another role can be released too.
    if(!issue && mode==='release'){
      let pairs;try{pairs=JSON.parse(row.key).map(k=>JSON.parse(k));}catch(_){pairs=[];}
      const destinations=Array.isArray(pairs)?pairs.filter(pair=>Array.isArray(pair) && pair.length===2 && plannerState.crimes.some(c=>String(c.id)===String(pair[0]) && c.status==='recruiting')).map(pair=>({crime:plannerState.crimes.find(c=>String(c.id)===String(pair[0])).name,crimeId:String(pair[0]),role:String(pair[1])})):[];
      const old=readJSON(plannerInvitationDecisionsKey(roster),{})[id];
      if(destinations.length && !(old?.mode==='release' && old.fingerprint===plannerInvitationDecisionFingerprint(row)))issue={id,destinations};
    }
    if(!issue || (mode==='keep' && !issue.canKeep))throw new Error('This invitation is no longer eligible for that decision. Rescan and review.');
    const queueKey='black-ledger-oc-pm-queue-v1',queue=readJSON(queueKey,null);
    if(queue?.viewerId===roster.viewerId && queue?.factionId===roster.factionId && queue.sendAttempt)throw new Error('Wait for the current mail send to finish before changing an invitation.');
    const names=issue.destinations.map(d=>d.crime+' #'+d.crimeId+' — '+d.role).join('; ');
    const name=plannerState.members.find(m=>String(m.id)===id)?.name || id;
    const question=mode==='release'
      ? 'Release '+name+' from the planning reservation for '+names+'?\n\nThe sent history stays intact. This does not cancel the message or change a Torn signup. Tell the member their old invitation no longer applies before sending a replacement. Prepared messages will be cleared across your synced devices.'
      : 'Keep '+name+' invited to '+names+' despite the below-target CPR?\n\nThis accepts this specific invitation for planning across your devices. Other CPR requirements stay unchanged. Prepared messages on this device will be cleared; this does not send a message or join the OC.';
    if(!confirm(question))return false;
    const currentRow=readJSON('black-ledger-oc-pm-shared-v1:'+roster.viewerId+':'+roster.factionId,null)?.members?.[id];
    const currentQueue=readJSON(queueKey,null);
    if(plannerState!==decisionState || Date.now()-plannerState.scannedAt>=300000 || !currentRow || plannerInvitationDecisionFingerprint(currentRow)!==plannerInvitationDecisionFingerprint(row) || (currentQueue?.viewerId===roster.viewerId && currentQueue?.factionId===roster.factionId && currentQueue.sendAttempt))throw new Error('The scan, invitation or mail queue changed. Review again before deciding.');
    const decisions=readJSON(plannerInvitationDecisionsKey(roster),{});
    decisions[id]={fingerprint:plannerInvitationDecisionFingerprint(row),mode,target:issue.target,cpr:issue.cpr,at:Date.now()};
    blStorageSet(plannerInvitationDecisionsKey(roster),JSON.stringify(decisions));
    blStorageRemove(PLANNER_NEWSLETTER_DRAFT_KEY);
    if(queue?.viewerId===roster.viewerId && queue?.factionId===roster.factionId)blStorageRemove(queueKey);
    inlinePlannerCachedState=null;inlinePlannerCachedModel=null;
    renderPlannerIfOpen();
    document.dispatchEvent(new Event('black-ledger-workspace-dirty'));
    return true;
  }

  function plannerMessageCleanupCandidates(state, history, roster, now = Date.now()) {
    if (!state?.shared || !state.complete || state.viewerId !== roster?.viewerId || state.factionId !== roster?.factionId ||
        !Number.isFinite(state.scannedAt) || now < state.scannedAt || now - state.scannedAt >= 300000 ||
        history?.viewerId !== roster.viewerId || history?.factionId !== roster.factionId) return [];
    const candidates = [];
    for (const [id, row] of Object.entries(history.members || {})) {
      if (history.pending?.[id] || !Number.isFinite(row?.sentAt) || row.sentAt <= 0 || row.sentAt > (state.scanStartedAt ?? state.scannedAt) || !row.eventId) continue;
      let pairs;
      try { pairs = JSON.parse(row.key).map(k => JSON.parse(k)); } catch (_) { continue; }
      if (!pairs.length || pairs.some(p => !Array.isArray(p) || p.length !== 2 || !/^[1-9]\d{0,14}$/.test(String(p[0])) || typeof p[1] !== 'string')) continue;
      // All destinations must be resolved: bundled future invitations may span OCs.
      const resolved = pairs.every(([crimeId, role]) => {
        const crime = state.crimes.find(c => String(c.id) === String(crimeId));
        if (!crime) return true; // Complete Recruiting + Planning scan proves absence.
        const slots = crime.slots.filter(slot => normalize(prettyRole(slot.position_info?.label || slot.position)) === normalize(role));
        return slots.length === 1 && String(slots[0].user?.id || '') === id;
      });
      if (resolved) candidates.push({recipient_id:id, assignment_key:row.key, sent_at:row.sentAt, event_id:row.eventId});
    }
    return candidates;
  }

  function plannerInvitationOccupancyRelease(state,previous,id,row) {
    const now=Date.now();
    if(!state?.shared || !state.complete || !Number.isFinite(state.scannedAt) || now<state.scannedAt || now-state.scannedAt>=300000 || !Number.isFinite(row?.sentAt) || row.sentAt<=0 || row.sentAt>state.scannedAt)return null;
    let pairs;try{pairs=JSON.parse(row.key).map(k=>JSON.parse(k));}catch(_){return null;}
    if(pairs.length!==1 || !Array.isArray(pairs[0]) || pairs[0].length!==2)return null;
    const [crimeId,role]=pairs[0],destination=state.crimes.find(crime=>String(crime.id)===String(crimeId));
    if(!destination)return null;
    const roleName=slot=>normalize(prettyRole(slot.position_info?.label || slot.position));
    const target=destination.slots.filter(slot=>roleName(slot)===normalize(role));
    if(target.length!==1)return null;
    const occupant=target[0].user?.id;
    if(occupant && String(occupant)!==String(id))return 'Mailed role taken by '+(target[0].user.name || String(occupant))+'.';
    if(occupant && String(occupant)===String(id))return 'Member joined the assigned role.';
    const occupied=scan=>scan.crimes.flatMap(crime=>crime.slots.filter(slot=>String(slot.user?.id || '')===String(id)).map(slot=>({crimeId:String(crime.id),role:roleName(slot)})));
    const actual=occupied(state);if(actual.length!==1)return null;
    if(actual[0].crimeId===String(crimeId))return 'Member joined a different role in the assigned OC.';
    // Future invitations may deliberately target a member still in their original
    // OC. Release only after a fresh before/after observation proves a new join.
    if(previous?.shared && previous.complete && previous.viewerId===state.viewerId && previous.factionId===state.factionId && previous.scannedAt<state.scannedAt && previous.scannedAt>=row.sentAt-300000 && state.scannedAt-previous.scannedAt<=300000){
      const before=occupied(previous);
      if(before.length===0 || (before.length===1 && JSON.stringify(before[0])!==JSON.stringify(actual[0])))return 'Member joined a different OC after the invitation.';
    }
    return null;
  }
  function refreshAutomaticInvitationReleases(state,previous) {
    const roster=blRoster();if(!roster || roster.viewerId!==state.viewerId || roster.factionId!==state.factionId)return [];
    const queue=readJSON('black-ledger-oc-pm-queue-v1',null);if(queue?.sendAttempt)return [];
    const history=readJSON('black-ledger-oc-pm-shared-v1:'+roster.viewerId+':'+roster.factionId,null);
    if(history?.version!==1 || history.viewerId!==roster.viewerId || history.factionId!==roster.factionId)return [];
    const key=plannerInvitationDecisionsKey(roster),decisions={...readJSON(key,{})},released=[];
    for(const [id,row] of Object.entries(history.members || {})){
      if(!row || typeof row.key!=='string' || !Number.isFinite(row.sentAt) || !state.members.some(member=>String(member.id)===id))continue;
      const fingerprint=plannerInvitationDecisionFingerprint(row);
      if(decisions[id]?.mode==='release' && decisions[id].fingerprint===fingerprint)continue;
      const reason=plannerInvitationOccupancyRelease(state,previous,id,row);if(!reason)continue;
      decisions[id]={mode:'release',fingerprint,at:Date.now(),automatic:true,reason};
      released.push({id,reason});
    }
    if(released.length){
      blStorageSet(key,JSON.stringify(decisions));
      if(typeof document!=='undefined' && typeof Event==='function')document.dispatchEvent(new Event('black-ledger-workspace-dirty'));
    }
    return released;
  }

  function plannerMailedReservations(state, slots, members, prefs, readiness) {
    const held=new Set(),heldKeys=new Set(),now=new Map(),next=new Map(),issues=[],accepted=[];
    const roster=blRoster();
    if(!roster || typeof readJSON!=='function')return {held,heldKeys,now,next,issues,accepted};
    const history=readJSON('black-ledger-oc-pm-shared-v1:'+roster.viewerId+':'+roster.factionId,null);
    if(!history || history.version!==1 || history.viewerId!==roster.viewerId || history.factionId!==roster.factionId)return {held,heldKeys,now,next,issues,accepted};
    const decisions=readJSON(plannerInvitationDecisionsKey(roster),{});
    const used=new Set(),stageCounts=new Map(),stageStarts=new Map(),byId=new Map(members.map(m=>[String(m.id),m]));
    for(const [id,row] of Object.entries(history.members || {}).sort((a,b)=>(readiness.get(a[0]) || prefs.asOf)-(readiness.get(b[0]) || prefs.asOf) || b[1].sentAt-a[1].sentAt || a[0].localeCompare(b[0]))){
      if(!state.members.some(m=>String(m.id)===id) || !Number.isFinite(row.sentAt) || row.sentAt>Date.now()+60000)continue;
      const decision=decisions[id]?.fingerprint===plannerInvitationDecisionFingerprint(row)?decisions[id]:null;
      if(decision?.mode==='release')continue;
      let pairs;try{pairs=JSON.parse(row.key).map(k=>JSON.parse(k));}catch(_){continue;}
      // A missing/completed destination is no longer a live invitation.
      const live=pairs.filter(pair=>Array.isArray(pair) && pair.length===2 && state.crimes.some(c=>String(c.id)===String(pair[0]) && c.status==='recruiting'));
      if(!live.length)continue;
      // Sent commitments reserve the destination even when the member is
      // outside the forecast horizon or needs CPR/timing review.
      for(const slot of slots)if(live.some(pair=>String(pair[0])===String(slot.crimeId) && normalize(pair[1])===normalize(prettyRole(slot.role))))heldKeys.add(slot.key);
      if(!byId.has(id))continue;
      held.add(id);
      const matches=slots.filter(slot=>live.some(pair=>String(pair[0])===String(slot.crimeId) && normalize(pair[1])===normalize(prettyRole(slot.role))));
      const slot=matches.length===1?matches[0]:null;
      let fit=slot && plannerFit(id,slot,prefs,true);
      const ready=readiness.get(id);
      const destinations=live.map(pair=>{
        const crime=state.crimes.find(c=>String(c.id)===String(pair[0]));
        return {crime:crime.name,crimeId:String(pair[0]),role:String(pair[1])};
      });
      let reason='',action='',canKeep=false,target=null;
      const observation=slot && plannerObservation(id,slot.crime,slot.role,prefs.includeStale);
      if(slot)target=mainScriptTarget(slot.crime,slot.level,slot.weight,slot.roleCount,slot.role);
      const starting=slot?.startable && !(stageCounts.get(String(slot.crimeId))||0);
      const joinBy=starting?Math.max(prefs.asOf || Date.now(),ready || 0):slot?plannerStagedDeadline({...slot,planningStartAt:stageStarts.get(String(slot.crimeId))},stageCounts.get(String(slot.crimeId))||0,prefs.asOf):null;
      const timingOkay= (starting || ready===undefined || (slot?.expiresKnown!==false && joinBy>ready));
      if(!fit && slot && observation && observation.cpr<target && matches.length===1 && live.length===1 && !used.has(slot.key) && timingOkay && decision?.mode==='keep' && decision.target===target && decision.cpr===observation.cpr){
        fit={...slot,...observation,target,margin:observation.cpr-target,manualInvitation:true};
        accepted.push({id,destinations,target,cpr:observation.cpr});
      }
      if(matches.length>1 || live.length>1){
        reason='The saved invitation matches more than one destination or open role.';
        action='Check the original message and identify the intended OC and exact role.';
      }else if(!slot){
        const destination=destinations[0],crime=state.crimes.find(c=>String(c.id)===destination.crimeId);
        const raw=crime.slots.filter(s=>normalize(prettyRole(s.position_info?.label || s.position))===normalize(destination.role));
        const occupied=raw.filter(s=>s.user?.id);
        if(occupied.length){
          reason='The invited role is now occupied by '+occupied.map(s=>s.user.name || state.members.find(m=>String(m.id)===String(s.user.id))?.name || String(s.user.id)).join(', ')+'.';
          action='Check who joined and whether this member still needs a different assignment.';
        }else if(!plannerManagedLevel(crime.difficulty,prefs)){
          reason='The destination OC level is excluded from the selected planner levels.';
          action='Include that level and rescan if the invitation should still be honoured.';
        }else{
          reason='The invited role is not a uniquely identifiable, eligible vacancy in this scan.';
          action='Check the exact role and expiry on Torn, then rescan.';
        }
      }else if(!fit){
        canKeep=!!observation && observation.cpr<target && !used.has(slot.key) && timingOkay;
        reason=observation?`Recorded role CPR is ${observation.cpr}%; the current target is ${target}%.`:'No usable CPR reading is available for this exact role under the current settings.';
        action='Review the role CPR and target before issuing another invitation.';
      }else if(used.has(slot.key)){
        reason='Another recorded sent invitation already reserves this same role.';
        action='Check both invitations and decide which member should join.';
      }else if(ready!==undefined && slot.expiresKnown===false){
        reason='The member is still in an OC, but the destination deadline is unknown.';
        action='Check the destination timer and rescan; arrival before its deadline cannot be verified.';
      }else if(!starting && ready!==undefined && joinBy<=ready){
        reason='The member\u2019s current OC finishes at or after the destination '+(Number.isFinite(slot.stallAt)?'next uncovered planning stage':'expiry')+' deadline.';
        action='Use an earlier available member, or review whether the original invitation is still appropriate.';
      }
      if(reason){
        issues.push({id,destinations,reason,action,canKeep,target,cpr:observation?.cpr});continue;
      }
      if(starting)stageStarts.set(String(slot.crimeId),joinBy);
      used.add(slot.key);stageCounts.set(String(slot.crimeId),(stageCounts.get(String(slot.crimeId))||0)+1);
      (ready===undefined?now:next).set(id,{...fit,joinByAt:joinBy,planningStartAt:stageStarts.get(String(slot.crimeId)),conditionalPlanning:Number.isFinite(slot.stallAt)});
    }
    return {held,heldKeys,now,next,issues,accepted};
  }

  function plannerJointSpawnReserve(members, defs, prefs, state, readiness) {
    const held=new Map();
    const budget=prefs.spawnBudget,time=Math.max(prefs.asOf || 0,Date.now());
    if(!budget || !Number.isSafeInteger(budget.balance) || !Number.isSafeInteger(budget.reserve ?? 50) || (budget.reserve ?? 50)<0 || !Number.isFinite(budget.updatedAt) || time-budget.updatedAt<0 || time-budget.updatedAt>15*60000 || !Array.isArray(budget.knownCrimeIds) || state.crimes.some(c=>!budget.knownCrimeIds.includes(String(c.id))))return {held,level:null};
    const current=members.filter(m=>!readiness.has(String(m.id)));
    const horizons=[12,24].map(hours=>({hours,members:members.filter(m=>readiness.has(String(m.id)) && readiness.get(String(m.id))<=(prefs.asOf || time)+hours*3600000)}));
    const quantities=plannerSpawnNeeded(current,defs,{...prefs,highEndSpawnBlocked:state.crimes.some(c=>(Number(c.difficulty) || defs[c.name]?.level)===8 && ['recruiting','planning'].includes(c.status)),levels:plannerSelectedLevels(prefs).filter(l=>l>=7)},new Map(),horizons);
    const supported=quantities.crews.filter(crew=>!crew.partial && crew.outcomes.every(o=>o.daily.complete && o.plannedUncertain===0));
    for(const crew of supported)for(const outcome of crew.outcomes)for(const [id,fit] of outcome.daily.assigned){
      if(!held.has(id))held.set(id,[]);held.get(id).push(fit);
    }
    const first=supported[0];
    const level=first?quantities.assessment.levels.find(l=>l.level===first.level):null;
    return {held,level,count:supported.length,starterOnly:true};
  }

  function plannerRebalanceIdleMembers(state,plan,prefs) {
    const result={placements:new Map(),removedForecast:new Set()};
    if(!state.shared || !Number.isFinite(state.scannedAt) || Date.now()-state.scannedAt<0 || Date.now()-state.scannedAt>300000)return result;
    const current=new Map(plan.now),future=new Map(plan.next),held=plan.mailedHeld;
    const available=plan.available.filter(m=>m.ocEligible!==false && (!m.status?.state || m.status.state==='Okay') && !held.has(String(m.id)));
    const idle=available.filter(m=>!current.has(String(m.id)) && !future.has(String(m.id)));
    if(!idle.length)return result;
    const upcoming=plan.upcoming.filter(m=>!current.has(String(m.id)) && !future.has(String(m.id)) && !held.has(String(m.id)));
    const memberReadyHours=Object.fromEntries(upcoming.map(m=>[String(m.id),Math.max(0,(plan.active.soon.get(String(m.id)).readyAt-prefs.asOf)/3600000)]));
    const highEndSpawnBlocked=state.crimes.some(crime=>(Number(crime.difficulty) || plan.defs[crime.name]?.level)===8 && ['recruiting','planning'].includes(crime.status));
    let needed=plannerSpawnNeeded(idle,plan.defs,{...prefs,spawningBlocked:plan.spawningBlocked,highEndSpawnBlocked,memberReadyHours},plan.protectedHigh,[{hours:24,members:upcoming}]);
    needed=plannerTrackSpawnDemand(needed,state,plan,prefs);
    const protectedStarts=new Set();
    for(const crew of needed.crews)if(plannerSpawnQuantityDecision({...needed,crews:[crew]},state,plan,prefs).allowed)
      for(const id of crew.ids)protectedStarts.add(String(id));
    const slots=plan.active.open.filter(slot=>slot.level<8 && !slot.opening && !slot.openingUnsupported && Number.isFinite(slot.stallAt) && slot.expiresAt>prefs.asOf);
    const byKey=new Map(slots.map(slot=>[slot.key,slot]));
    for(const member of idle){
      const root=String(member.id);if(protectedStarts.has(root) || current.has(root))continue;
      const owners=new Map([...current,...future].map(([id,fit])=>[fit.key,{id,fit,future:future.has(id)}]));
      const fixed=new Set([...plan.coverageReservations.values()].map(fit=>fit.key));
      for(const [id,fit] of [...current,...future])if(held.has(id) || !byKey.has(fit.key))fixed.add(fit.key);
      const counts=new Map();for(const fit of [...current.values(),...future.values(),...plan.coverageReservations.values()])counts.set(String(fit.crimeId),(counts.get(String(fit.crimeId))||0)+1);
      const seenMembers=new Set(),seenSlots=new Set();
      function find(id){
        if(seenMembers.has(id))return null;seenMembers.add(id);
        const options=slots.filter(slot=>!fixed.has(slot.key) && !seenSlots.has(slot.key)).map(slot=>{
          const owner=owners.get(slot.key),fit=plannerFit(id,slot,prefs);if(!fit)return null;
          const stageAt=owner?.fit.joinByAt ?? plannerStagedDeadline(slot,counts.get(String(slot.crimeId))||0,prefs.asOf);
          if(!Number.isFinite(stageAt))return null;
          return {owner,fit:{...fit,joinByAt:stageAt,conditionalPlanning:true,queueWaitHours:Math.max(0,(stageAt-prefs.asOf)/3600000),assignmentPriority:owner?.fit.assignmentPriority || 4,idleExistingFallback:stageAt>prefs.asOf+48*3600000,rebalancedExisting:true}};
        }).filter(Boolean).sort((a,b)=>Number(!!a.owner)-Number(!!b.owner) || b.fit.level-a.fit.level || a.fit.joinByAt-b.fit.joinByAt || plannerOrder(a.fit,b.fit));
        for(const option of options){
          const {owner,fit}=option;seenSlots.add(fit.key);
          if(!owner)return {moves:new Map([[id,fit]]),removed:null};
          if(owner.future)return {moves:new Map([[id,fit]]),removed:owner.id};
          const chain=find(owner.id);
          if(chain){chain.moves.set(id,fit);return chain;}
        }
        return null;
      }
      const chain=find(root);if(!chain)continue;
      if(chain.removed){future.delete(chain.removed);result.removedForecast.add(chain.removed);}
      for(const [id,fit] of chain.moves){current.set(id,fit);result.placements.set(id,fit);}
    }
    return result;
  }

  function plannerIdleExistingFallback(state,plan,prefs) {
    const result={placements:new Map(),spawnProtected:new Set()};
    if(!state.shared || !Number.isFinite(state.scannedAt) || Date.now()-state.scannedAt<0 || Date.now()-state.scannedAt>300000)return result;
    const committed=new Map([...plan.now,...plan.next,...plan.coverageReservations]);
    const idle=plan.available.filter(member=>!committed.has(String(member.id)) && !plan.mailedHeld.has(String(member.id)) && member.ocEligible!==false && (!member.status?.state || member.status.state==='Okay'));
    const used=new Set([...committed.values()].map(fit=>fit.key));
    // This exception extends existing running queues only. Empty openings retain
    // their initial pair cap; L8 retains its separate single-OC fallback.
    const slots=plan.active.open.filter(slot=>slot.level<8 && !slot.opening && !slot.openingUnsupported && !used.has(slot.key) && Number.isFinite(slot.stallAt) && slot.expiresAt>prefs.asOf);
    if(!idle.length || !slots.length)return result;
    const future=plan.upcoming.filter(member=>!committed.has(String(member.id)) && !plan.mailedHeld.has(String(member.id)));
    const memberReadyHours=Object.fromEntries(future.map(member=>[String(member.id),Math.max(0,(plan.active.soon.get(String(member.id)).readyAt-prefs.asOf)/3600000)]));
    const highEndSpawnBlocked=state.crimes.some(crime=>(Number(crime.difficulty) || plan.defs[crime.name]?.level)===8 && ['recruiting','planning'].includes(crime.status));
    let needed=plannerSpawnNeeded(idle,plan.defs,{...prefs,spawningBlocked:plan.spawningBlocked,highEndSpawnBlocked,memberReadyHours},plan.protectedHigh,[{hours:24,members:future}]);
    needed=plannerTrackSpawnDemand(needed,state,plan,prefs);
    for(const crew of needed.crews)if(plannerSpawnQuantityDecision({...needed,crews:[crew]},state,plan,prefs).allowed)
      for(const id of crew.ids)result.spawnProtected.add(String(id));
    const candidates=idle.filter(member=>!result.spawnProtected.has(String(member.id)));
    const matched=plannerAssignStaged(candidates,slots,{...prefs,maxOpeningStages:2},new Map(),committed);
    for(const [id,fit] of matched)result.placements.set(id,{...fit,idleExistingFallback:true,assignmentPriority:4});
    return result;
  }

  function plannerIdleL8Fallback(state,plan,prefs) {
    const result={placements:new Map(),spawnProtected:new Set(),issues:new Map(),crimeId:null};
    if(!state.shared || !Number.isFinite(state.scannedAt) || Date.now()-state.scannedAt<0 || Date.now()-state.scannedAt>300000)return result;
    const committed=new Map([...plan.now,...plan.next,...plan.coverageReservations]);
    const idle=plan.available.filter(member=>!committed.has(String(member.id)) && !plan.mailedHeld.has(String(member.id)) && member.ocEligible!==false && (!member.status?.state || member.status.state==='Okay'));
    if(!idle.length)return result;
    const used=new Set([...committed.values()].map(fit=>fit.key));
    const highCrimes=(state.crimes || []).filter(crime=>(Number(crime.difficulty) || plan.defs[crime.name]?.level)===8 && ['recruiting','planning'].includes(crime.status));
    const owners=new Set(highCrimes.filter(crime=>crime.slots?.some(slot=>slot.user?.id)).map(crime=>String(crime.id)));
    for(const fit of committed.values())if(fit.level===8)owners.add(String(fit.crimeId));
    const vacancies=plan.active.open.filter(slot=>slot.level===8 && !slot.openingUnsupported && !used.has(slot.key));
    const destinations=owners.size?owners:new Set(vacancies.map(slot=>String(slot.crimeId)));
    if(destinations.size!==1)return result;
    const destination=[...destinations][0],slots=vacancies.filter(slot=>String(slot.crimeId)===destination);
    result.crimeId=destination;
    if(!slots.length){for(const member of idle)result.issues.set(String(member.id),'The single existing L8 has no unreserved eligible vacancy. Review a suitable L7 next join or a supported new start; do not create a second L8.');return result;}
    // The legacy idle pass preserves supported starts. The first-priority
    // pass reserves L8 candidates before any speculative spawn reservation.
    if(!prefs.l8PlacementPriority){
      const future=plan.upcoming.filter(member=>!committed.has(String(member.id)) && !plan.mailedHeld.has(String(member.id)));
      const readyHours=Object.fromEntries(future.map(member=>[String(member.id),Math.max(0,(plan.active.soon.get(String(member.id)).readyAt-prefs.asOf)/3600000)]));
      let needed=plannerSpawnNeeded(idle,plan.defs,{...prefs,spawningBlocked:plan.spawningBlocked,highEndSpawnBlocked:highCrimes.length>0,memberReadyHours:readyHours},plan.protectedHigh,[{hours:24,members:future}]);
      needed=plannerTrackSpawnDemand(needed,state,plan,prefs);
      for(const crew of needed.crews)if(plannerSpawnQuantityDecision({...needed,crews:[crew]},state,plan,prefs).allowed)
        for(const id of crew.ids)result.spawnProtected.add(String(id));
    }
    const candidates=idle.filter(member=>!result.spawnProtected.has(String(member.id)));
    const matched=plannerAssignStaged(candidates,slots,{...prefs,capabilityFirst:true,maxOpeningStages:prefs.l8PlacementPriority?2:0},new Map(),committed);
    const crime=highCrimes.find(row=>String(row.id)===destination);
    const actual=crime?.slots?.filter(slot=>slot.user?.id).length || 0;
    const initial=[...committed.values()].filter(fit=>String(fit.crimeId)===destination).length;
    // An unstarted empty L8 still needs its distinct initial pair.
    if(actual || initial+matched.size>=Math.min(2,crime?.slots?.length || 2))
      for(const [id,fit] of matched)result.placements.set(id,{...fit,...(prefs.l8PlacementPriority?{l8PlacementPriority:true,assignmentPriority:1}:{idleL8Fallback:true})});
    for(const member of candidates){
      const id=String(member.id);if(result.placements.has(id))continue;
      const minimum=plannerLevelFloor(id,prefs).minimum;
      const details=slots.map(slot=>{
        const target=mainScriptTarget(slot.crime,slot.level,slot.weight,slot.roleCount,slot.role);
        const observed=plannerObservation(id,slot.crime,slot.role,prefs.includeStale) || plannerEstimatedRole(id,slot);
        return prettyRole(slot.role)+': '+(minimum>8?'outside recorded level protection':observed?observed.cpr+'% CPR / '+target+'% target':'no usable exact-role or same-role estimate');
      });
      result.issues.set(id,'Last-resort L8 review for '+(crime?.name || destination)+' #'+destination+': '+details.join('; ')+'. No additional role was allocated; suitable roles may already be assigned to another member.');
    }
    return result;
  }

  function plannerPlan(state, prefs) {
    const asOf=state.shared?state.scannedAt:Date.now();
    prefs={...prefs,asOf,stallPriority:true,urgentFirst:true,rescueExisting:state.shared===true,maxOpeningStages:2,highEndCommittedIds:state.crimes.filter(c=>(Number(c.difficulty) || plannerWeights()[c.name]?.level)===8 && ['recruiting','planning'].includes(c.status) && c.slots?.some(s=>s.user?.id)).map(c=>String(c.id))};
    if(state.shared)state={...state,crimes:state.crimes.map(c=>({...c,stallDeadline:c.status==='recruiting' && c.isExpiring===false}))};
    const syncedRoster=state.shared?null:getRosterSnapshot();
    const useSynced=syncedRoster?.source==='tornstats-live-v2' && syncedRoster.viewerId===String(getViewerId() || '') && syncedRoster.factionId===blRoster()?.factionId && Date.now()-Date.parse(syncedRoster.fetched_at)>=0 && Date.now()-Date.parse(syncedRoster.fetched_at)<=15*60000;
    const positions=new Map(useSynced? syncedRoster.members.map(m=>[m.id,m.position]):[]);
    if(!state.shared)state={...state,members:state.members.filter(m=>blAllowed(m.id)).map(m=>positions.has(String(m.id))?{...m,ocEligible:!/^recruit$/i.test(positions.get(String(m.id)))}:m),crimes:blSafeCrimes(state.crimes)};
    plannerObservationMembers=state.shared?null:getMembers();
    const defs = plannerWeights();
    const active = plannerSlots(state.crimes, defs, asOf);
    active.releases=plannerReleaseTimeline(state,asOf);
    // Only a scanned, fully joined OC supplies release candidates. Partial
    // planning-finish estimates remain visible without reserving their members.
    if(state.shared){
      active.soon=new Map();
      for(const release of active.releases.rows)if(release.kind==='scanned' && release.expectedAt<=asOf+24*3600000){
        const crime=state.crimes.find(row=>String(row.id)===release.crimeId);
        for(const id of release.memberIds){
          const slot=crime.slots.find(row=>String(row.user?.id)===id);
          active.soon.set(id,{readyAt:release.expectedAt,crime:release.crime,role:slot.position,crimeId:release.crimeId});
        }
      }
    }
    // Track occupancy at every level; assign selected vacancies to available members first.
    active.open = active.open.filter(slot => plannerManagedLevel(slot.level,prefs));
    const available = state.members.filter(m => m.ocEligible !== false && m.is_in_oc === false && !active.occupied.has(String(m.id)));
    const eligible = available.filter(m => !m.status?.state || m.status.state === 'Okay');
    // Preserve selected L7+ capability before considering lower-level vacancies.
    const protectedHigh = new Map();
    for (const member of [...eligible,...state.members.filter(m=>m.ocEligible!==false && m.is_in_oc===true && active.soon.has(String(m.id)))]) {
      const id=String(member.id),roles=[];
      for (const [crime,def] of Object.entries(defs)) {
        if (def.level<7 || !plannerManagedLevel(def.level,prefs)) continue;
        const entries=Object.entries(def.roles);
        for (const [role,weight] of entries) {
          const fit=plannerFit(id,{crime,role,weight,level:def.level,roleCount:entries.length},prefs);
          if(fit)roles.push(fit);
        }
      }
      if(roles.length)protectedHigh.set(id,roles.sort((a,b)=>b.level-a.level || plannerOrder(a,b)));
    }
    function assignPriority(members,slots,readiness=new Map()) {
      return plannerAssign(members,slots,prefs,readiness);
    }
    const deferred=state.shared?active.open.filter(slot=>!slot.startable && Number.isFinite(slot.stallAt) && slot.stallAt>asOf+48*3600000):[];
    const deferredKeys=new Set(deferred.map(slot=>slot.key));
    const dueSlots=active.open.filter(slot=>!deferredKeys.has(slot.key));
    const upcoming = state.members.filter(m => m.ocEligible !== false && m.is_in_oc === true && active.soon.has(String(m.id)) && active.soon.get(String(m.id)).readyAt<=asOf+24*3600000 && (!m.status?.state || m.status.state==='Okay')).sort((a,b) => active.soon.get(String(a.id)).readyAt - active.soon.get(String(b.id)).readyAt || String(a.id).localeCompare(String(b.id)));
    const readiness = new Map(upcoming.map(m=>[String(m.id),Math.max(asOf,active.soon.get(String(m.id)).readyAt)]));
    let now,next,spawnReservation=null,assignmentConflicts=[],mailedHeld=new Set(),acceptedInvitations=[];
    if(state.shared){
      const mailed=plannerMailedReservations(state,active.open,[...eligible,...upcoming],prefs,readiness);
      mailedHeld=mailed.held;assignmentConflicts=mailed.issues;acceptedInvitations=mailed.accepted;
      const acceptedKeys=new Set([...mailed.now.values(),...mailed.next.values()].map(f=>f.key));
      active.open=active.open.filter(slot=>!mailed.heldKeys?.has(slot.key) || acceptedKeys.has(slot.key));
      // Existing roles can accept suitable joiners before every later role has
      // a verified candidate. Initial-pair and single-L8 checks remain below.
      if(typeof plannerOpeningSupport==='function')active.open=plannerOpeningSupport(active.open,[...eligible,...upcoming],prefs,mailedHeld,readiness,new Map([...mailed.now,...mailed.next]));
      const occupiedKeys=new Set([...mailed.now.values(),...mailed.next.values()].map(f=>f.key));
      const dueKeys=new Set(dueSlots.map(s=>s.key));
      const freeSlots=active.open.filter(s=>dueKeys.has(s.key) && !occupiedKeys.has(s.key));
      const freeNow=eligible.filter(m=>!mailedHeld.has(String(m.id))),freeSoon=upcoming.filter(m=>!mailedHeld.has(String(m.id)));
      // Existing crew gaps take priority over starting empty OCs.
      const promised=new Map([...mailed.now,...mailed.next]);
      // Reserve scarce qualifying current members for the single L8 before
      // lower-level urgency, queue windows or speculative parallel starts.
      // Actual occupancy and mailed commitments remain fixed.
      const l8Priority=plannerIdleL8Fallback(state,{
        now:mailed.now,next:mailed.next,coverageReservations:new Map(),
        available:freeNow,upcoming:freeSoon,mailedHeld,active,defs,protectedHigh
      },{...prefs,l8PlacementPriority:true});
      const l8Prior=new Map([...promised,...l8Priority.placements]);
      const urgentSlots=freeSlots.filter(slot=>!slot.opening || !slot.startable);
      const urgent=plannerConveyorAssign(freeNow.filter(member=>!l8Prior.has(String(member.id))),urgentSlots,prefs,new Map(),l8Prior);
      for(const [id,fit] of urgent)urgent.set(id,{...fit,assignmentPriority:1});
      const existingNow=new Map([...l8Priority.placements,...urgent]);
      // Match successive stages within 48h in rounds across OCs. Each planned
      // join adds one stage, so the fifth person is never queued five days away.
      while(true){
        const prior=new Map([...promised,...existingNow]);
        const batch=plannerConveyorAssign(freeNow.filter(member=>!prior.has(String(member.id))),
          active.open.filter(slot=>!slot.opening),{...prefs,conveyorWindowHours:48},new Map(),prior);
        if(!batch.size)break;
        for(const [id,fit] of batch)existingNow.set(id,{...fit,assignmentPriority:2});
      }
      const existingCommitments=new Map([...promised,...existingNow]);
      const remaining=freeNow.filter(member=>!existingCommitments.has(String(member.id)));
      if(typeof plannerOpeningSupport==='function'){
        const reset=active.open.map(slot=>{if(!slot.opening)return slot;const {openingUnsupported,openingHoldReason,continuationCount,continuationRatio,...base}=slot;return base;});
        active.open=plannerOpeningSupport(reset,[...remaining,...freeSoon],prefs,mailedHeld,readiness,existingCommitments);
      }
      const starters=plannerConveyorAssign(remaining,active.open.filter(slot=>slot.opening),prefs,new Map(),existingCommitments);
      for(const [id,fit] of starters)existingNow.set(id,{...fit,assignmentPriority:3});
      const initial=new Map([...promised,...existingNow]);
      const existingNext=plannerConveyorAssign(freeSoon,active.open,{...prefs,conveyorFollowOn:true,maxQueueWaitHours:24},readiness,initial);
      now=new Map([...mailed.now,...existingNow]);next=new Map([...mailed.next,...existingNext]);
      const committedPair=new Map([...now,...next]);
      // If no forecast follower covers an empty start, add one current follower.
      // Empty openings retain at most a starter and one timely follower.
      const openingFollowers=plannerConveyorAssign(freeNow.filter(m=>!committedPair.has(String(m.id))),
        active.open.filter(slot=>slot.opening),{...prefs,conveyorFollowOn:true},new Map(),committedPair);
      for(const [id,fit] of openingFollowers)now.set(id,{...fit,assignmentPriority:3});
      // Report remaining crew risk after real recommendations; this assessment
      // must not veto placements or bind members to a speculative full crew.
      active.completion=plannerCompletionAssessment(state,defs,[...eligible,...upcoming],prefs,readiness,new Map([...now,...next]),mailedHeld,active.open);
      spawnReservation={held:new Map(),level:null,count:0};
      protectedHigh.clear();
    }else{
      now=assignPriority(eligible,dueSlots);
      const reserved=new Set([...now.values()].map(slot=>slot.key));
      next=assignPriority(upcoming,dueSlots.filter(slot=>!reserved.has(slot.key)),readiness);
    }
    if(state.shared){
      const planned=[...now.values(),...next.values()],used=new Set(planned.map(f=>f.key));
      for(const slot of active.open)if(Number.isFinite(slot.stallAt) && !used.has(slot.key) && !deferred.some(s=>s.key===slot.key) && planned.some(f=>String(f.crimeId)===String(slot.crimeId)))deferred.push({...slot,coveragePlanned:true});
    }
    const cutoff12=asOf+12*3600000, cutoff24=asOf+24*3600000;
    const forecast={
      within12:upcoming.filter(m=>active.soon.get(String(m.id)).readyAt<=cutoff12),
      within24:upcoming.filter(m=>{const t=active.soon.get(String(m.id)).readyAt;return t>cutoff12&&t<=cutoff24;}),
      within48:upcoming.filter(m=>active.soon.get(String(m.id)).readyAt>cutoff24)
    };
    // Near-term followers are explicit assignments. No hidden multi-day holds.
    const committed=new Map([...now,...next]);
    const coverageReservations=new Map();
    const coveredKeys=new Set([...committed.values(),...coverageReservations.values()].map(f=>f.key));
    const staffingRisks=active.open.filter(s=>!coveredKeys.has(s.key));
    const unassessedExisting=state.crimes.filter(c=>c.status==='recruiting' && c.slots?.some(s=>s.user===null) && (!plannerManagedLevel(c.difficulty,prefs) || !plannerDefinition(c.name,defs)));
    // A named invitation issue already holds its member out of every new pool.
    // Only unisolated conflicts or unassessed OCs block independent spare crews.
    const spawningBlocked=unassessedExisting.length>0 || assignmentConflicts.some(issue=>!issue.id || !mailedHeld.has(String(issue.id)));
    const plan={ available, now, upcoming, next, active, defs, forecast, protectedHigh, deferred, spawnReservation, assignmentConflicts, mailedHeld, acceptedInvitations, coverageReservations, staffingRisks, unassessedExisting, spawningBlocked };
    if(state.shared){
      if(typeof plannerIdleExistingFallback==='function'){
        plan.idleExistingFallback=plannerIdleExistingFallback(state,plan,prefs);
        for(const [id,fit] of plan.idleExistingFallback.placements)now.set(id,fit);
      }
      plan.idleL8Fallback=plannerIdleL8Fallback(state,plan,prefs);
      for(const [id,fit] of plan.idleL8Fallback.placements)now.set(id,fit);
      if(typeof plannerRebalanceIdleMembers==='function'){
        plan.rebalanced=plannerRebalanceIdleMembers(state,plan,prefs);
        for(const id of plan.rebalanced.removedForecast)next.delete(id);
        for(const [id,fit] of plan.rebalanced.placements)now.set(id,fit);
      }
      if([...now.values()].some(fit=>fit.l8PlacementPriority) || plan.idleL8Fallback.placements.size || plan.idleExistingFallback?.placements.size || plan.rebalanced?.placements.size){
        const filled=new Set([...now.values(),...next.values()].map(fit=>fit.key));
        plan.deferred=deferred.filter(slot=>!filled.has(slot.key));
        plan.staffingRisks=staffingRisks.filter(slot=>!filled.has(slot.key));
        active.completion=plannerCompletionAssessment(state,defs,[...eligible,...upcoming],prefs,readiness,new Map([...now,...next]),mailedHeld,active.open);
      }
    }
    return plan;
  }

  function plannerRescueTransfers(state,plan,prefs,now=Date.now()) {
    const report={options:[],stale:false,unreadableDonors:0};
    // Percentages must still describe the member's actual stage now, not five minutes ago.
    if(!state?.shared || !Number.isFinite(state.scannedAt) || now<state.scannedAt || now-state.scannedAt>60000){report.stale=true;return report;}
    const hour=3600000,buffer=hour;
    const assigned=new Set([...plan.now.values(),...plan.next.values()].map(f=>f.key));
    const targets=plan.active.open.filter(s=>!s.startable && Number.isFinite(s.stallAt) && s.stallAt<=now+hour && !assigned.has(s.key));
    const committed=new Set([...plan.now.keys(),...plan.next.keys(),...plan.coverageReservations.keys(),...plan.mailedHeld]);
    const replacements=[...plan.available.filter(m=>m.ocEligible!==false && (!m.status?.state || m.status.state==='Okay')).map(m=>({member:m,readyAt:now})),...plan.upcoming.map(m=>({member:m,readyAt:plan.active.soon.get(String(m.id)).readyAt}))].filter(row=>!committed.has(String(row.member.id)));
    const reliable=fit=>fit && fit.kind==='Observed' && !fit.stale && Number.isFinite(fit.seen);
    for(const donor of state.crimes){
      if(donor.isExpiring!==false || !['recruiting','planning'].includes(donor.status) || donor.planningPhase!=='active')continue;
      const coverage=plannerProgressCoverage(donor,now);
      if(!coverage){report.unreadableDonors++;continue;}
      const duration=donor.planningSecondsPerSlot*1000,observed=donor.planningObservedAt;
      const occupied=donor.slots.filter(s=>s.user);
      const total=occupied.reduce((n,s)=>n+(1-s.planningPercent/100)*duration,0);
      const firstActive=donor.slots.findIndex(s=>s.user && s.planningPercent<100);
      if(firstActive<0)continue;
      let before=0;
      for(let index=0;index<donor.slots.length;index++){
        const slot=donor.slots[index];
        if(!slot.user)continue;
        const startsAt=observed+before;
        before+=(1-slot.planningPercent/100)*duration;
        if(index<=firstActive || slot.planningPercent!==0 || startsAt<=now+buffer)continue;
        const id=String(slot.user.id),member=state.members.find(m=>String(m.id)===id);
        if(!member || member.ocEligible===false || member.status?.state && member.status.state!=='Okay')continue;
        const gapAfter=observed+total-duration;
        if(gapAfter<=now+buffer)continue;
        const def=plannerDefinition(donor.name,plan.defs);
        if(!def)continue;
        const raw=normalize(slot.position),same=donor.slots.filter(s=>normalize(s.position)===raw);
        const label=slot.position_info?.label;
        const exactLabel=label && Object.keys(def.roles).find(r=>normalize(r)===normalize(label));
        const occurrence=donor.slots.slice(0,index+1).filter(s=>normalize(s.position)===raw).length;
        const wanted=exactLabel || (same.length>1?`${slot.position}${occurrence}`:slot.position);
        const role=Object.keys(def.roles).find(r=>normalize(r)===normalize(wanted));
        if(!role || exactLabel && donor.slots.filter(s=>normalize(s.position_info?.label)===normalize(label)).length!==1)continue;
        const donorSlot={key:String(donor.id)+':'+index,crimeId:String(donor.id),crime:donor.name,role,level:Number(donor.difficulty),weight:def.roles[role],roleCount:donor.slots.length,stallAt:gapAfter,expiresAt:Infinity,expiresKnown:true};
        const replacementOptions=replacements.filter(row=>String(row.member.id)!==id && String(plan.active.soon.get(String(row.member.id))?.crimeId || '')!==String(donor.id)).map(row=>({...row,fit:plannerFit(String(row.member.id),donorSlot,{...prefs,asOf:now,rescueExisting:false})})).filter(row=>row.readyAt<gapAfter-buffer && reliable(row.fit)).sort((a,b)=>a.readyAt-b.readyAt || String(a.member.id).localeCompare(String(b.member.id)));
        for(const target of targets){
          if(String(target.crimeId)===String(donor.id))continue;
          const fit=plannerFit(id,target,{...prefs,asOf:now,rescueExisting:true});
          if(!reliable(fit))continue;
          report.options.push({id,name:member.name || slot.user.name || id,from:{id:String(donor.id),name:donor.name,role},to:{id:String(target.crimeId),name:target.crime,role:target.role,deadline:target.stallAt},cpr:fit.cpr,target:fit.target,levelRescue:fit.levelRescue,startsAt,gapAfter,donorCoverageHours:(gapAfter-now)/hour,replacement:replacementOptions[0]?{id:String(replacementOptions[0].member.id),name:replacementOptions[0].member.name || replacementOptions[0].member.id,readyAt:replacementOptions[0].readyAt,cpr:replacementOptions[0].fit.cpr,target:replacementOptions[0].fit.target}:null});
        }
      }
    }
    report.options.sort((a,b)=>Number(!a.replacement)-Number(!b.replacement) || a.to.deadline-b.to.deadline || b.gapAfter-a.gapAfter || a.id.localeCompare(b.id));
    return report;
  }

  function plannerBestRescue(report) {
    if(report.stale)return null;
    return report.options.filter(r=>r.replacement).sort((a,b)=>a.to.deadline-b.to.deadline || b.gapAfter-a.gapAfter || a.id.localeCompare(b.id))[0] || null;
  }
  function renderPlannerRescueTransfers(report) {
    const row=plannerBestRescue(report);
    if(!row)return '';
    const link=(id,name)=>`<a href="https://www.torn.com/factions.php?step=your&amp;type=12#/tab=crimes&amp;crimeId=${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)} #${escapeHtml(id)}</a>`;
    return `<div class="blom-section blom-rescue-panel"><div class="blom-section-body"><div class="blom-alert"><strong>Possible stall rescue: ${escapeHtml(row.name)} could move to ${link(row.to.id,row.to.name)} · ${escapeHtml(prettyRole(row.to.role))}.</strong><p>From ${link(row.from.id,row.from.name)} · donor retains ${row.donorCoverageHours.toFixed(1)} hours. Possible replacement: ${escapeHtml(row.replacement.name)} (conditional).</p><p>Manual suggestion: verify they are still waiting at 0%, then rescan after one move. No member is moved automatically.</p></div></div></div>`;
  }

  let plannerTimerSignature=null;
  function plannerTimerFingerprint() {
    if(!plannerState)return null;
    const now=Date.now();
    return JSON.stringify([
      typeof blRoster==='function' && typeof readJSON==='function' && blRoster()?readJSON('black-ledger-oc-pm-shared-v1:'+blRoster().viewerId+':'+blRoster().factionId,null):null,
      now-plannerState.scannedAt<(5*60000),
      now-plannerState.scannedAt<=60000,
      (plannerState.crimes || []).map(c=>Number.isSafeInteger(c.planningObservedAt) && now-c.planningObservedAt<=60000),
      !plannerState.unassignedAt || now-plannerState.unassignedAt<5*60000,
      (plannerState.crimes || []).map(c=>{
        const ready=Number(c.ready_at)*1000,expires=Number(c.expired_at)*1000;
        return [String(c.id),[0,12,24,48].map(h=>Number.isFinite(ready) && ready>0 && ready<=now+h*3600000),Number.isFinite(expires) && expires>0 && expires<=now];
      })
    ]);
  }
  function plannerTimerRefresh() {
    if(!plannerState || document.visibilityState!=='visible' || !document.hasFocus() || !document.querySelector(`#${PANEL_ID} [data-tab="planner"].active`))return;
    refreshPlannerSpawnReview(plannerState,{...plannerState.prefs,spawnBudget:applyLiveScopeBudget(plannerState.prefs)});
    const signature=plannerTimerFingerprint();
    if(signature!==plannerTimerSignature)renderPlannerIfOpen();
  }
  // Repeated summaries belong to separate disclosures. Explicit keys survive
  // changing row order; occurrence keys keep other duplicate labels independent.
  function plannerDisclosureEntries(body) {
    const counts=new Map();
    return [...body.querySelectorAll('details')].map(node=>{
      const summary=node.querySelector('summary');
      const label=node.dataset.blDisclosureKey || summary?.querySelector('span')?.textContent || summary?.textContent || '';
      const occurrence=counts.get(label) || 0;
      counts.set(label,occurrence+1);
      return {node,key:JSON.stringify([label,occurrence])};
    });
  }
  function renderPlannerIfOpen() {
    if(document.getElementById('black-ledger-oc-manager-pm')?.dataset.blPreparationBusy==='1' || document.getElementById('blom-prepare-newsletter')?.dataset.blPreparationPending==='1')return;
    if(document.visibilityState!=='visible' || !document.hasFocus())return;
    const settingsOpen = !!document.querySelector(`#${PANEL_ID} [data-tab="settings"].active`);
    if (!settingsOpen && !document.querySelector(`#${PANEL_ID} [data-tab="planner"].active`))return;
    const body=document.querySelector(`#${PANEL_ID} .blom-body`);if(!body)return;
    const top=body.scrollTop,left=body.scrollLeft;
    const tables=[...body.querySelectorAll('.blom-planner-scroll')].map(n=>({top:n.scrollTop,left:n.scrollLeft}));
    const details=new Map(plannerDisclosureEntries(body).map(({node,key})=>[key,node.open]));
    const fields=['blom-planner-key'].map(id=>{const n=body.querySelector('#'+id);return n?{id,value:n.value,checked:n.checked}:null;}).filter(Boolean);
    const focus=document.activeElement?.id;
    const selection=focus==='blom-planner-key'?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:null;
    if (settingsOpen) renderSettings(body); else renderPlanner(body);
    [...body.querySelectorAll('.blom-planner-scroll')].forEach((n,i)=>{if(tables[i]){n.scrollTop=tables[i].top;n.scrollLeft=tables[i].left;}});
    for(const {node,key} of plannerDisclosureEntries(body)){if(details.has(key))node.open=details.get(key);}
    // Collapsed defaults can temporarily shrink the body; restore scroll only
    // once the original disclosure layout has been restored.
    body.scrollTop=top;body.scrollLeft=left;
    for(const field of fields){const input=body.querySelector('#'+field.id);if(input){input.value=field.value;if(input.type==='checkbox')input.checked=field.checked;}}
    const focused=focus && document.getElementById(focus);
    if(focused){focused.focus({preventScroll:true});if(selection)focused.setSelectionRange(...selection);}
  }

  function showManagerTab(tab) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
    renderTab(tab);
  }
  function renderSettings(body) {
    const saved = readJSON(PLANNER_PREFS, {});
    const prefs = {includeStale: saved.includeStale === true};
    body.innerHTML = `<h2 style="color:#66cfff;margin:0 0 12px;">Settings</h2>      <div class="blom-settings-panel">
        <details class="blom-inline-details" open><summary>Faction CPR target adjustment</summary><div class="blom-detail-content">
          <p>Raise or lower standard required CPR targets by a fixed number of percentage points. Recorded CPR stays unchanged. For example, 66 becomes 68 with +2 or 63 with -3. The normal target limits still apply; fixed crime targets receive the adjustment too.</p>
          <div class="blom-api-key-field"><label for="blom-target-offset">Faction adjustment (-10 to +10)</label>
            <div class="blom-target-stepper">
              <input id="blom-target-offset" type="number" min="-10" max="10" step="1" value="${mainTargetOffset()}" />
              <button id="blom-target-increase" type="button" aria-label="Increase faction adjustment by 1" title="Increase by 1">&#8593;</button>
              <button id="blom-target-decrease" type="button" aria-label="Decrease faction adjustment by 1" title="Decrease by 1">&#8595;</button>
            </div>
          </div>
          <div class="blom-setting-actions"><button id="blom-target-save" type="button">Publish to faction</button><button id="blom-target-reset" type="button">Publish 0</button><button id="blom-target-refresh" type="button">Refresh targets</button></div>
          <p id="blom-target-error" role="status" aria-live="polite"></p>
          <p class="blom-muted">${escapeHtml(factionTargetStatus())}</p><p class="blom-muted">Publishing changes targets for members using the updated Smart Role Targets script. Only an authorised management code can publish. Members refresh automatically while Torn is active, normally within five minutes. Older script versions keep their personal presets.</p>
        </div></details>
        <details class="blom-inline-details"><summary>Other settings</summary><div class="blom-detail-content">
        <label class="blom-toggle-row"><input id="blom-planner-management" type="checkbox" ${saved.management===true?'checked':''} /><span><strong>Enable roster planner</strong><small>Share planning settings across your devices</small></span></label>
        <label class="blom-toggle-row"><input id="blom-planner-stale" type="checkbox" ${prefs.includeStale?'checked':''} /><span><strong>Include older CPR</strong><small>Include observations over 30 days old</small></span></label>
        <div class="blom-setting-actions"><button id="blom-shared-refresh" ${sharedBusy?'disabled':''}>↻ Refresh shared CPR</button><button id="blom-shared-configure">Configure shared CPR</button></div>
        <div class="blom-settings-status">${escapeHtml(sharedStatusText())}</div>
        <div class="blom-setting-actions"><button id="blom-settings-roster-refresh">Refresh membership</button><button id="blom-settings-roster-configure">Configure automatic membership</button></div>
        <div class="blom-settings-status">Automatic membership uses TornStats. Refreshes every five minutes while Torn is visible and focused.</div>
        <details class="blom-inline-details"><summary>Advanced: optional Torn API fallback</summary><div class="blom-detail-content"><p>Only needed if you choose to use Torn API checks instead of automatic TornStats membership. Normal page scans need no Torn API key.</p><details><summary>Data &amp; key details</summary><div class="blom-detail-content">${plannerAPITerms()}</div></details><label class="blom-api-key-field">Torn API key <input id="blom-planner-key" type="password" autocomplete="off" placeholder="16-character key" /></label><div class="blom-setting-actions"><button id="blom-planner-save" ${plannerBusy ? 'disabled' : ''}>Save</button><button id="blom-planner-clear" ${plannerBusy ? 'disabled' : ''}>Clear</button><button id="blom-planner-api" ${plannerBusy ? 'disabled' : ''}>Verify members &amp; scan page</button></div><details><summary>Full shared OC scan</summary><div class="blom-detail-content"><p>Requests all OC pages through your Torn login and publishes the shared snapshot. No Torn API key required.</p><button id="blom-planner-full-api" ${plannerBusy ? 'disabled' : ''}>Full shared OC scan</button></div></details></div></details>
        <details class="blom-inline-details"><summary>Privacy &amp; sharing terms</summary><div class="blom-detail-content">${managerDataTerms()}</div></details>
        </div></details>
      </div>`;
    const applyOffset = async value => {
      const publish = body.querySelector('#blom-target-save'), reset = body.querySelector('#blom-target-reset');
      publish.disabled = reset.disabled = true;
      body.querySelector('#blom-target-error').textContent = 'Publishing…';
      const error = await saveManagerTargetOffset(value);
      renderPlannerIfOpen();
      const feedback = body.querySelector('#blom-target-error');
      if (feedback) feedback.textContent = error || 'Published to faction. Updated member scripts will pick this up automatically.';
    };
    const stepOffset = direction => {
      const input = body.querySelector('#blom-target-offset');
      const value = input.value.trim() === '' ? mainTargetOffset() : Number(input.value);
      input.value = String(clamp(Math.round(Number.isFinite(value) ? value : mainTargetOffset()) + direction, -10, 10));
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
    };
    body.querySelector('#blom-target-increase').onclick = () => stepOffset(1);
    body.querySelector('#blom-target-decrease').onclick = () => stepOffset(-1);
    body.querySelector('#blom-target-save').onclick = () => applyOffset(body.querySelector('#blom-target-offset').value);
    body.querySelector('#blom-target-reset').onclick = () => applyOffset(0);
    body.querySelector('#blom-target-refresh').onclick = () => refreshFactionTargetPolicy(true);
    body.querySelector('#blom-planner-save').onclick = () => {
      const key = body.querySelector('#blom-planner-key').value.trim();
      if (!key) return;
      if(!/^[a-zA-Z0-9]{16}$/.test(key)){plannerError='Enter a 16-character Torn API key, not the Black Ledger private code.';renderPlannerIfOpen();return;}
      GM_setValue(PLANNER_KEY, key); body.querySelector('#blom-planner-key').value='';
      plannerState=null; plannerError='Membership key saved. Use Scan & verify. Only public-access selections are requested.'; renderPlannerIfOpen();
    };
    body.querySelector('#blom-planner-clear').onclick = () => {GM_setValue(PLANNER_KEY,'');plannerState=null;plannerError='Key cleared.';renderPlannerIfOpen();};
    body.querySelector('#blom-planner-api').onclick=()=>{ showManagerTab('planner'); refreshPlanner(); };
    body.querySelector('#blom-planner-full-api').onclick=()=>{ showManagerTab('planner'); refreshPlanner(); };
    body.querySelector('#blom-settings-roster-refresh').onclick=()=>refreshRoster(true,showRosterStatus);
    body.querySelector('#blom-settings-roster-configure').onclick=configureRosterSync;
    body.querySelector('#blom-shared-configure').onclick=configureSharedAccess;
    body.querySelector('#blom-shared-refresh').onclick=()=>refreshSharedData(true);
    const update = () => {
      blStorageSet(PLANNER_PREFS,JSON.stringify({...saved,includeStale:body.querySelector('#blom-planner-stale').checked,management:body.querySelector('#blom-planner-management').checked}));
      renderPlannerIfOpen();
    };
    body.querySelector('#blom-planner-management').onchange=() => { plannerState=null; update(); };
    body.querySelector('#blom-planner-stale').onchange=()=>{update();blStorageSet(PLANNER_PREFS,JSON.stringify({...readJSON(PLANNER_PREFS,{}),pendingScan:true}));};
  }


  // Inline views reuse the snapshot and the whole-faction allocation engine.
  // Same Member best metric as Smart Role Targets: average recorded role CPR
  // per crime level, highest level averaging at least 67%; descriptive only.
  function inlineMemberBestIndex(state) {
    const levels=new Map(Object.entries(state.weights).map(([name,def])=>[normalize(name),Number(def.level)]));
    const members=new Map();
    for(const row of state.profiles){
      const level=levels.get(normalize(row.crime)),cpr=Number(row.latest_cpr);
      if(row.latest_cpr===null || !Number.isFinite(level) || !Number.isFinite(cpr) || cpr<0 || cpr>100)continue;
      const id=String(row.user_id);if(!members.has(id))members.set(id,new Map());
      const buckets=members.get(id);if(!buckets.has(level))buckets.set(level,[]);buckets.get(level).push(cpr);
    }
    const result=new Map();
    for(const [id,buckets] of members)for(const [level,values] of buckets){
      const cpr=values.reduce((sum,value)=>sum+value,0)/values.length;
      if(cpr>=67 && (!result.has(id) || level>result.get(id).level))result.set(id,{level,cpr});
    }
    return result;
  }
  function inlineMemberBestText(model,id) {
    const best=model?.memberBest.get(String(id));
    return best?`Member best: L${best.level} (${Math.round(best.cpr)}%)`:'Member best: unknown';
  }
  function styleInlineRecruitingButtons() {
    if(document.getElementById('blom-inline-button-styles'))return;
    const style=document.createElement('style');style.id='blom-inline-button-styles';
    style.textContent=`
      #blom-inline-spawn {box-sizing:border-box!important;max-width:100%!important;margin:8px 0!important;padding:12px!important;background:#3a3020!important;border:1px solid #ac8550!important;border-radius:8px!important;overflow-wrap:anywhere!important;}
      #blom-inline-spawn,#blom-inline-spawn p,#blom-inline-spawn strong {color:#ffdb9a!important;-webkit-text-fill-color:#ffdb9a!important;text-shadow:none!important;font:13px/1.5 sans-serif!important;}
      #blom-inline-spawn strong {color:#ffcb70!important;-webkit-text-fill-color:#ffcb70!important;font-weight:700!important;}
      #blom-inline-spawn p {margin:6px 0!important;}
      #blom-inline-scan {display:grid !important;grid-template-columns:minmax(0,1fr) minmax(0,1fr) !important;gap:6px !important;align-items:stretch !important;padding:6px !important;}
      #blom-inline-scan > button {grid-row:1!important;grid-column:auto!important;margin:0 !important;padding:8px !important;min-height:44px !important;box-sizing:border-box !important;}
      #blom-inline-scan .blom-shared-scan-card {grid-column:1 / -1!important;grid-row:2!important;display:flex !important;flex-direction:column !important;justify-content:center !important;gap:1px !important;min-width:0 !important;padding:6px 9px !important;box-sizing:border-box !important;background:linear-gradient(135deg,#263f50,#20333f) !important;border:1px solid #638da7 !important;border-radius:6px !important;color:#eaf5fc !important;font:11px/1.25 sans-serif !important;}
      #blom-inline-scan .blom-shared-scan-card strong {color:#8bd8ff !important;font:700 12px/1.25 sans-serif !important;}
      #blom-inline-scan .blom-shared-scan-card time {display:block !important;color:#eaf5fc !important;font:500 11px/1.25 sans-serif !important;font-variant-numeric:tabular-nums !important;}
      #blom-inline-scan .blom-shared-scan-card time span {display:inline-block !important;white-space:nowrap !important;margin-right:5px !important;}
      #blom-inline-scan .blom-shared-scan-card[data-state="error"] {border-color:#d99b80 !important;}
      @media(max-width:320px) {#blom-inline-scan > button {font-size:11px!important;}}
      #blom-inline-scan button, .blom-inline-slot button {
        appearance:none !important; background:#245679 !important; background-image:none !important;
        color:#fff !important; -webkit-text-fill-color:#fff !important; text-shadow:none !important;
        border:1px solid #8bd8ff !important; border-radius:6px !important;
        font:600 12px/1.4 sans-serif !important; text-align:center !important;
      }
      #blom-inline-scan button:hover:not(:disabled), .blom-inline-slot button:hover:not(:disabled) {background:#326f98 !important;}
      #blom-inline-scan button:focus-visible, .blom-inline-slot button:focus-visible {outline:2px solid #ffe39c !important; outline-offset:2px !important;}
      #blom-inline-scan button:disabled, .blom-inline-slot button:disabled {background:#374b59 !important; color:#d3dde5 !important; -webkit-text-fill-color:#d3dde5 !important; border-color:#708694 !important; cursor:wait !important;}
      .blom-inline-slot button {width:100% !important; box-sizing:border-box !important;}
      .blom-inline-rescue {margin:7px 0 !important;padding:7px !important;box-sizing:border-box !important;background:#253642 !important;border:1px solid #8bd8ff !important;border-radius:6px !important;color:#eaf5fc !important;-webkit-text-fill-color:#eaf5fc !important;font:12px/1.4 sans-serif !important;overflow-wrap:anywhere !important;}
      #faction-crimes .blom-member-mail-cell {height:auto!important;min-height:54px!important;box-sizing:border-box!important;padding-bottom:5px!important;}
      #faction-crimes .blom-member-mail-badge {display:block!important;position:static!important;box-sizing:border-box!important;width:fit-content!important;max-width:100%!important;margin:4px auto 0!important;padding:3px 5px!important;background:#203f36!important;border:1px solid #81caaa!important;border-radius:4px!important;color:#e7fff3!important;-webkit-text-fill-color:#e7fff3!important;text-shadow:none!important;font:600 11px/1.4 sans-serif!important;text-align:center!important;white-space:normal!important;overflow-wrap:anywhere!important;}
      #faction-crimes .blom-member-mail-badge[data-kind="review"] {background:#4a391e!important;border-color:#d9b578!important;color:#fff0cc!important;-webkit-text-fill-color:#fff0cc!important;}
      .blom-inline-rescue strong, .blom-inline-rescue div {color:#eaf5fc !important;-webkit-text-fill-color:#eaf5fc !important;}
      .blom-inline-rescue a {display:block !important;min-height:44px !important;padding:6px 2px !important;box-sizing:border-box !important;background:#20333f !important;border:1px solid #638da7 !important;border-radius:4px !important;color:#8bd8ff !important;-webkit-text-fill-color:#8bd8ff !important;text-decoration:underline !important;white-space:normal !important;overflow-wrap:anywhere !important;}
      .blom-inline-rescue a:hover {background:#304b5c !important;color:#fff !important;-webkit-text-fill-color:#fff !important;}
      .blom-inline-rescue a:focus-visible {outline:2px solid #ffe39c !important;outline-offset:2px !important;}


      #blom-controls-row{display:flex!important;flex-wrap:wrap!important;align-items:center!important;justify-content:flex-start!important;gap:5px 8px!important;margin:5px 0!important;padding:0!important;border:0!important;background:transparent!important}
      #blom-controls-row>#${SMART_SETTINGS_ID},#blom-controls-row>#blom-inline-scan{flex:0 1 auto!important;width:auto!important;margin:0!important;justify-content:flex-start!important}
      #blom-controls-row>#blom-planning-items-report{flex:1 0 100%!important;width:100%!important;margin:0!important}
      #blom-controls-row>#blom-inline-scan:has(.blom-scan-details[open]){flex-basis:100%!important}
      /* Quiet inline controls; full Manager remains available on demand. */
      #${SMART_SETTINGS_ID}{display:flex!important;flex-wrap:wrap!important;justify-content:flex-start!important;align-items:center!important;gap:5px!important;padding:0!important;margin:4px 0!important;border:0!important;background:transparent!important;box-shadow:none!important}
      #${SMART_SETTINGS_ID}>.oc-smart-settings-button,#${SMART_SETTINGS_ID}>#${LAUNCHER_ID},#${SMART_SETTINGS_ID} .bl-sharing-terms>summary{width:auto!important;min-height:32px!important;height:auto!important;padding:5px 10px!important;font:600 12px/1.3 sans-serif!important;border:1px solid #49616e!important;border-radius:16px!important;background:#202c34!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;box-shadow:none!important;text-shadow:none!important;white-space:normal!important}
      #${SMART_SETTINGS_ID}>.bl-sharing-inline,#${SMART_SETTINGS_ID} .bl-sharing-terms{width:auto!important;min-width:0!important;flex:0 1 auto!important}
      #${SMART_SETTINGS_ID} .bl-sharing-inline .bl-sharing-section{width:auto!important;display:block!important}
      #${SMART_SETTINGS_ID}>#${LAUNCHER_ID}:hover:not(:disabled),#${SMART_SETTINGS_ID}>.oc-smart-settings-button:hover:not(:disabled),#${SMART_SETTINGS_ID} .bl-sharing-terms>summary:hover{background:#304958!important}
      #${SMART_SETTINGS_ID}>#${LAUNCHER_ID}:focus-visible,#${SMART_SETTINGS_ID}>.oc-smart-settings-button:focus-visible{outline:2px solid #8bd8ff!important;outline-offset:2px!important}
      #${SMART_SETTINGS_ID}>button:disabled{background:#27353e!important;color:#bdcbd4!important;-webkit-text-fill-color:#bdcbd4!important;border-color:#607681!important;opacity:1!important}
      #blom-inline-scan{display:flex!important;flex-wrap:wrap!important;justify-content:flex-start!important;align-items:center!important;gap:5px!important;margin:4px 0!important;padding:0!important;background:transparent!important;border:0!important;box-shadow:none!important}
      #blom-inline-scan>button,#blom-inline-scan>.blom-scan-details>summary{display:inline-flex!important;align-items:center!important;min-height:32px!important;max-width:100%!important;box-sizing:border-box!important;margin:0!important;padding:5px 10px!important;font:600 12px/1.3 sans-serif!important;background:#202c34!important;background-image:none!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;border:1px solid #49616e!important;border-radius:16px!important;white-space:normal!important;overflow-wrap:anywhere!important;text-shadow:none!important;cursor:pointer!important}
      #blom-inline-scan>button{order:0!important;width:auto!important;flex:0 1 auto!important}
      #blom-inline-scan>.blom-scan-details{order:1!important;max-width:100%!important}
      #blom-inline-scan>.blom-scan-details[open]{flex-basis:100%!important}
      #blom-inline-scan>.blom-scan-details>summary{list-style:none!important}
      #blom-inline-scan>.blom-scan-details>summary::before{content:'▸';margin-right:5px}
      #blom-inline-scan>.blom-scan-details[open]>summary::before{content:'▾'}
      #blom-inline-scan>.blom-scan-details>summary::-webkit-details-marker{display:none!important}
      #blom-inline-scan>button:hover:not(:disabled),#blom-inline-scan>.blom-scan-details>summary:hover{background:#304958!important}
      #blom-inline-scan>button:focus-visible,#blom-inline-scan>.blom-scan-details>summary:focus-visible{outline:2px solid #8bd8ff!important;outline-offset:2px!important}
      #blom-inline-scan>button:disabled{background:#27353e!important;color:#bdcbd4!important;-webkit-text-fill-color:#bdcbd4!important;border-color:#607681!important;cursor:wait!important;opacity:1!important}
      #blom-inline-scan>.blom-scan-details[data-attention="true"]>summary{color:#ffdb9a!important;-webkit-text-fill-color:#ffdb9a!important;border-color:#ac8550!important}
      #blom-inline-scan .blom-scan-details .blom-shared-scan-card{margin-top:5px!important;padding:8px!important;font-size:12px!important;background:#202c34!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;border:1px solid #49616e!important}
      #blom-planning-items-report{padding:0!important;margin:4px 0!important;background:transparent!important;border:0!important;font:12px/1.5 sans-serif!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important}
      #blom-planning-items-report>summary{display:flex!important;align-items:center!important;box-sizing:border-box!important;min-height:32px!important;padding:5px 8px!important;border:1px solid #49616e!important;border-radius:5px!important;background:#202c34!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;cursor:pointer!important}
      #blom-planning-items-report>summary:hover{background:#304958!important}
      #blom-planning-items-report>summary:focus-visible{outline:2px solid #8bd8ff!important;outline-offset:2px!important}
      /* One restrained toolbar, with emphasis reserved for the main actions. */
      #blom-controls-row{gap:6px 10px!important;padding:7px 8px!important;margin:7px 0!important;background:#1b2329!important;border:1px solid #344650!important;border-radius:8px!important}
      #blom-controls-row>#${SMART_SETTINGS_ID},#blom-controls-row>#blom-inline-scan{gap:6px!important}
      #${SMART_SETTINGS_ID}>.oc-smart-settings-button,#${SMART_SETTINGS_ID}>#${LAUNCHER_ID},#${SMART_SETTINGS_ID} .bl-sharing-terms>summary,#blom-inline-scan>button,#blom-inline-scan>.blom-scan-details>summary{border-radius:5px!important;padding:6px 10px!important;font-weight:500!important;background:#202d35!important;border-color:#405662!important}
      #${SMART_SETTINGS_ID}>#${LAUNCHER_ID}{order:-1!important;background:#294d64!important;border-color:#638fa8!important;font-weight:700!important}
      #${SMART_SETTINGS_ID}>#${LAUNCHER_ID}:hover:not(:disabled){background:#365f79!important}
      #${SMART_SETTINGS_ID}>.oc-smart-settings-button{background:transparent!important;border-color:transparent!important;color:#c4d2db!important;-webkit-text-fill-color:#c4d2db!important;padding:6px 4px!important}
      #${SMART_SETTINGS_ID} .bl-sharing-terms>summary{background:transparent!important;border-color:transparent!important;color:#bed3df!important;-webkit-text-fill-color:#bed3df!important}
      #${SMART_SETTINGS_ID} .bl-sharing-terms>summary:hover{background:#304958!important}
      #blom-inline-scan>button:first-of-type{background:#294d64!important;border-color:#638fa8!important;font-weight:700!important}
      #blom-inline-scan>button:first-of-type:hover:not(:disabled){background:#365f79!important}
      #blom-inline-scan>.blom-scan-details>summary{background:transparent!important;border-color:transparent!important;color:#b9cbd7!important;-webkit-text-fill-color:#b9cbd7!important}
      #blom-inline-scan>.blom-scan-details[data-attention="true"]>summary{background:#3a3020!important;border-color:#ac8550!important;color:#ffdb9a!important;-webkit-text-fill-color:#ffdb9a!important}
      #blom-inline-scan>button:disabled,#${SMART_SETTINGS_ID}>#${LAUNCHER_ID}:disabled{background:#27353e!important;border-color:#607681!important;color:#bdcbd4!important;-webkit-text-fill-color:#bdcbd4!important}
      #blom-controls-row>#blom-planning-items-report{flex:0 1 auto!important;width:auto!important;margin:0!important}
      #blom-controls-row>#blom-planning-items-report[open]{flex-basis:100%!important}
      #blom-planning-items-report>summary{background:transparent!important;border-color:transparent!important;border-radius:5px!important;padding:6px 8px!important;color:#c4d2db!important;-webkit-text-fill-color:#c4d2db!important;font-size:12px!important;list-style:none!important}
      #blom-planning-items-report>summary::-webkit-details-marker{display:none!important}
      #blom-planning-items-report>summary::before{content:'▸';margin-right:6px!important;color:#a6bdcc!important;-webkit-text-fill-color:#a6bdcc!important}
      #blom-planning-items-report[open]>summary::before{content:'▾'}
      #blom-planning-items-report[data-item-state="ready"]>summary::before{content:'✓';color:#9ed7b2!important;-webkit-text-fill-color:#9ed7b2!important}
      #blom-planning-items-report[data-item-state="missing"]>summary{background:#3a3020!important;border-color:#ac8550!important;color:#ffdb9a!important;-webkit-text-fill-color:#ffdb9a!important}
      #blom-planning-items-report>summary:hover{background:#304958!important}
      /* Reserve transient label space; wrap whole controls on narrow screens. */
      #blom-inline-scan>button,#blom-inline-scan>.blom-scan-details>summary,#blom-planning-items-report>summary{white-space:nowrap!important;overflow-wrap:normal!important;flex-shrink:0!important}
      #blom-inline-scan>button:last-of-type{min-width:calc(14ch + 20px)!important}
      #blom-planning-items-report>summary{min-width:calc(18ch + 16px)!important}
      /* Keep actions adjacent to their matching status, with shared treatments. */
      #blom-inline-scan>button:first-of-type{order:0!important}
      #blom-inline-scan>.blom-scan-details{order:1!important}
      #blom-inline-scan>button:last-of-type{order:2!important;margin-left:6px!important}
      #blom-controls-row #blom-inline-scan>button{background:#294d64!important;border:1px solid #638fa8!important;border-radius:5px!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;font-weight:700!important}
      #blom-controls-row #blom-inline-scan>button:hover:not(:disabled){background:#365f79!important}
      #blom-controls-row #blom-inline-scan>button:disabled{background:#27353e!important;border-color:#607681!important;color:#bdcbd4!important;-webkit-text-fill-color:#bdcbd4!important}
      #blom-controls-row #blom-inline-scan>.blom-scan-details>summary,#blom-controls-row #blom-planning-items-report>summary{min-height:32px!important;padding:5px 7px!important;background:#202d35!important;border:1px solid #405662!important;border-radius:12px!important;color:#c4d2db!important;-webkit-text-fill-color:#c4d2db!important;font:500 12px/1.3 sans-serif!important}
      #blom-controls-row #blom-inline-scan>.blom-scan-details>summary:hover,#blom-controls-row #blom-planning-items-report>summary:hover{background:#304958!important}
      #blom-controls-row #blom-inline-scan>.blom-scan-details>summary::before,#blom-controls-row #blom-planning-items-report>summary::before{content:'▸';margin-right:5px!important;color:#a6bdcc!important;-webkit-text-fill-color:#a6bdcc!important}
      #blom-controls-row #blom-inline-scan>.blom-scan-details[open]>summary::before,#blom-controls-row #blom-planning-items-report[open]>summary::before{content:'▾'}
      #blom-controls-row #blom-inline-scan>.blom-scan-details[data-attention="true"]>summary,#blom-controls-row #blom-planning-items-report[data-item-state="missing"]>summary{background:#3a3020!important;border-color:#ac8550!important;color:#ffdb9a!important;-webkit-text-fill-color:#ffdb9a!important}
      @media(max-width:600px),(pointer:coarse){#blom-controls-row #blom-inline-scan>.blom-scan-details>summary,#blom-controls-row #blom-planning-items-report>summary{min-height:44px!important}}
      #blom-controls-row>#blom-inline-scan:has(.blom-scan-details[open]){flex-basis:auto!important}
      #blom-controls-row #blom-inline-scan>.blom-scan-details[open]{flex:0 0 auto!important}
      #blom-controls-row>#blom-planning-items-report[open]{flex:0 0 auto!important;width:auto!important}
      #blom-controls-row #blom-inline-scan>.blom-scan-details>summary::before,#blom-controls-row #blom-planning-items-report>summary::before{display:inline-block!important;width:8px!important;flex:0 0 8px!important;text-align:center!important}
      .blom-toolbar-detail-body{box-sizing:border-box!important;margin:5px 0!important;padding:10px 12px!important;background:#202d35!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;border:1px solid #405662!important;border-radius:7px!important;font:12px/1.5 sans-serif!important;overflow-wrap:anywhere!important}
      .blom-toolbar-detail-body[hidden]{display:none!important}
      #blom-scan-details-body .blom-shared-scan-card{display:flex!important;flex-direction:column!important;gap:4px!important;background:transparent!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;border:0!important;padding:0!important}
      .blom-toolbar-detail-body summary{box-sizing:border-box!important;min-height:32px!important;padding:6px 8px!important;background:#202d35!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;border:1px solid #405662!important;border-radius:5px!important;cursor:pointer!important}
      .blom-toolbar-detail-body summary:hover{background:#304958!important}
      .blom-toolbar-detail-body summary:focus-visible{outline:2px solid #8bd8ff!important;outline-offset:2px!important}
      @media(max-width:600px),(pointer:coarse){.blom-toolbar-detail-body summary{min-height:44px!important}}
      #blom-scan-details-body time span{margin-right:6px!important}
      /* Centre the complete control group while preserving action/status pairs. */
      #blom-controls-row{justify-content:center!important}
      #blom-controls-row>#${SMART_SETTINGS_ID},#blom-controls-row>#blom-inline-scan{justify-content:center!important}
      @media(min-width:601px){
        #blom-controls-row:not(:has(details[open])){flex-wrap:nowrap!important;overflow-x:auto!important}
        #blom-controls-row>#${SMART_SETTINGS_ID},#blom-controls-row>#blom-inline-scan{flex:0 0 auto!important;flex-wrap:nowrap!important;gap:4px!important}
        #blom-controls-row{gap:6px!important;padding:6px!important}
        #${SMART_SETTINGS_ID}>#${LAUNCHER_ID},#${SMART_SETTINGS_ID} .bl-sharing-terms>summary,#blom-inline-scan>button,#blom-inline-scan>.blom-scan-details>summary{padding-left:7px!important;padding-right:7px!important;white-space:nowrap!important}
        #blom-inline-scan>button:last-of-type{min-width:calc(12ch + 14px)!important}
        #blom-controls-row>#blom-planning-items-report{flex:0 0 auto!important}
        #blom-planning-items-report>summary{min-width:0!important;padding-left:5px!important;padding-right:5px!important}
        #blom-controls-row>#blom-planning-items-report[open]{flex:0 0 auto!important}
      }
      @media(max-width:600px),(pointer:coarse){
        #${SMART_SETTINGS_ID}>.oc-smart-settings-button,#${SMART_SETTINGS_ID}>#${LAUNCHER_ID},#${SMART_SETTINGS_ID} .bl-sharing-terms>summary,#blom-inline-scan>button,#blom-inline-scan>.blom-scan-details>summary,#blom-planning-items-report>summary{min-height:44px!important}
      }
      /* Match inter-control gaps, including boundaries between the two groups. */
      #blom-controls-row{column-gap:6px!important;row-gap:6px!important}
      #blom-controls-row>#${SMART_SETTINGS_ID},#blom-controls-row>#blom-inline-scan{column-gap:6px!important;row-gap:6px!important}
      #blom-controls-row #blom-inline-scan>button:last-of-type{margin-left:0!important}
      #blom-controls-row>#${SMART_SETTINGS_ID}>*,#blom-controls-row>#blom-inline-scan>*{margin-left:0!important;margin-right:0!important}
      /* PDA: stable action/status pairs instead of centred, intrinsic-width rows. */
      @media(max-width:600px){
        #blom-controls-row{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;align-items:stretch!important;box-sizing:border-box!important;width:100%!important;min-width:0!important;padding:6px!important;gap:6px!important}
        #blom-controls-row>#${SMART_SETTINGS_ID}{grid-column:1 / -1!important;grid-row:1!important;display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,.7fr) minmax(0,1.3fr)!important;width:100%!important;min-width:0!important;gap:4px!important;align-items:stretch!important}
        #blom-controls-row>#${SMART_SETTINGS_ID}>#${LAUNCHER_ID}{grid-column:1!important;grid-row:1!important}
        #blom-controls-row>#${SMART_SETTINGS_ID}>.oc-smart-settings-button{grid-column:2!important;grid-row:1!important}
        #blom-controls-row>#${SMART_SETTINGS_ID}>.bl-sharing-inline{grid-column:3!important;grid-row:1!important;min-width:0!important;width:100%!important}
        #blom-controls-row>#${SMART_SETTINGS_ID}>button,#blom-controls-row #${SMART_SETTINGS_ID} .bl-sharing-terms>summary{box-sizing:border-box!important;min-width:0!important;width:100%!important;min-height:44px!important;height:100%!important;padding:6px 4px!important;white-space:normal!important;overflow-wrap:anywhere!important;font-size:11px!important;line-height:1.3!important;display:flex!important;align-items:center!important;justify-content:center!important;text-align:center!important}
        #blom-controls-row #${SMART_SETTINGS_ID} .bl-sharing-terms{width:100%!important;height:100%!important}
        #blom-controls-row>#blom-inline-scan{display:contents!important}
        #blom-controls-row #blom-inline-scan>button:first-of-type{grid-column:1!important;grid-row:2!important}
        #blom-controls-row #blom-inline-scan>.blom-scan-details{grid-column:2!important;grid-row:2!important;min-width:0!important;width:100%!important}
        #blom-controls-row #blom-inline-scan>button:last-of-type{grid-column:1!important;grid-row:3!important}
        #blom-controls-row>#blom-planning-items-report,#blom-controls-row>#blom-planning-items-report[open]{grid-column:2!important;grid-row:3!important;min-width:0!important;width:100%!important}
        #blom-controls-row #blom-inline-scan>button,#blom-controls-row #blom-inline-scan>.blom-scan-details>summary,#blom-controls-row #blom-planning-items-report>summary{display:flex!important;align-items:center!important;justify-content:center!important;box-sizing:border-box!important;width:100%!important;min-width:0!important;min-height:44px!important;height:100%!important;padding:6px!important;white-space:normal!important;overflow-wrap:anywhere!important;text-align:center!important;font-size:12px!important;line-height:1.3!important}
        #blom-inline-spawn,.blom-toolbar-detail-body{box-sizing:border-box!important;min-width:0!important;max-width:100%!important}
      }
    `;document.head.appendChild(style);
  }
  let inlinePlannerCachedState=null,inlinePlannerCachedModel=null;
  function inlinePlannerModel() {
    const saved=readJSON(PLANNER_PREFS,{}),state=plannerState;
    if(saved.management!==true || saved.pendingScan || !state?.shared || state.viewerId!==String(getViewerId() || '') || Date.now()-state.scannedAt>=300000 || !blRoster())return null;
    const receipts=readJSON('black-ledger-oc-pm-shared-v1:'+blRoster().viewerId+':'+blRoster().factionId,null);
    const receiptSignature=JSON.stringify([receipts?.members || {},readJSON(plannerInvitationDecisionsKey(blRoster()),{})]);
    if(inlinePlannerCachedState===state && inlinePlannerCachedModel?.receiptSignature===receiptSignature)return inlinePlannerCachedModel;
    const previous=plannerInputContext;plannerInputContext=state;
    try{inlinePlannerCachedState=state;return inlinePlannerCachedModel={state,receiptSignature,plan:plannerPlan(state,{...state.prefs,spawnBrackets:true,spawnBudget:applyLiveScopeBudget(state.prefs),learning:state.learning || []}),memberBest:inlineMemberBestIndex(state)};}
    finally{plannerInputContext=previous;}
  }
  function plannerPlacementMailStatus(id,fit,history,decisions={}) {
    if(!history || history.version!==1 || !history.members)return {kind:'unknown',text:'Mail status unavailable'};
    const row=history.members[String(id)];
    if(!row)return {kind:'unsent',text:fit?'Not mailed — no recorded send':'No recorded mail'};
    if(!Number.isFinite(row.sentAt) || row.sentAt<=0 || row.sentAt>Date.now()+60000)return {kind:'unknown',text:'Mail status unavailable'};
    let pairs;try{pairs=JSON.parse(row.key).map(k=>JSON.parse(k));if(!pairs.length || pairs.some(p=>!Array.isArray(p) || p.length!==2))throw Error();}catch(_){return {kind:'unknown',text:'Mail status unavailable'};}
    const decision=decisions[String(id)];
    if(decision?.mode==='release' && decision.fingerprint===plannerInvitationDecisionFingerprint(row))return {kind:'unsent',text:decision.automatic?(fit?'Old assignment automatically released — replacement not mailed':'Old assignment automatically released'):(fit?'Invitation released — review replacement':'Invitation released'),sentAt:row.sentAt};
    if(!fit)return {kind:'previous',text:'Previous invitation recorded',sentAt:row.sentAt};
    const matches=pairs.some(pair=>String(pair[0])===String(fit.crimeId) && normalize(pair[1])===normalize(prettyRole(fit.role)));
    return {kind:matches?'mailed':'update',text:matches?'Mailed — this OC and role':'Update needed — different assignment mailed',sentAt:row.sentAt,pending:!!history.pending?.[String(id)]};
  }

  function plannerMemberMailBadge(id,model,history,decisions={}) {
    if(!model || !history || history.viewerId!==model.state.viewerId || history.factionId!==model.state.factionId)return null;
    const fit=model.plan.now.get(String(id)) || model.plan.next.get(String(id));
    const status=plannerPlacementMailStatus(id,fit,history,decisions);
    if(!['mailed','update','previous'].includes(status.kind))return null;
    const row=history.members[String(id)];
    const pairs=JSON.parse(row.key).map(k=>JSON.parse(k));
    const live=pairs.map(([crimeId,role])=>{
      const crime=model.state.crimes.find(c=>String(c.id)===String(crimeId) && c.status==='recruiting');
      return crime?{crime,role}:null;
    }).filter(Boolean);
    if(!live.length)return null;
    const issue=model.plan.assignmentConflicts?.find(item=>String(item.id)===String(id));
    const review=model.mailScanExpired===true || !!issue || status.kind!=='mailed';
    const destinations=live.map(({crime,role})=>crime.name+' #'+crime.id+' — '+role).join('; ');
    return {kind:review?'review':'mailed',text:model.mailScanExpired?'✉ Mail · rescan':review?'✉ Mail · review':'✉ Mailed',
      title:(model.mailScanExpired?'Scan expired or settings changed — refresh before relying on this assignment. ':'' )+status.text+' · '+destinations+' · Sent '+new Date(status.sentAt).toLocaleString('en-GB',{timeZone:'Europe/London',hour12:false})+(issue?' · '+issue.reason:'')+(status.pending?' · Sync pending':'')+'. Mail recorded; this does not mean the member has joined or read it.'};
  }
  function renderUnassignedMailBadges(model) {
    const roster=blRoster(),history=roster?readJSON('black-ledger-oc-pm-shared-v1:'+roster.viewerId+':'+roster.factionId,null):null;
    const decisions=roster?readJSON(plannerInvitationDecisionsKey(roster),{}):{};
    if(!model && typeof inlinePlannerCachedModel!=='undefined' && inlinePlannerCachedModel?.state===plannerState && roster?.viewerId===plannerState?.viewerId && roster?.factionId===plannerState?.factionId)model={...inlinePlannerCachedModel,mailScanExpired:true};
    const visited=new Set();
    // Torn's native bottom list only; never decorate chat, sidebar or OC occupants.
    for(const link of document.querySelectorAll('#faction-crimes ul li > a[class*="member___"][href*="XID="]')){
      if(link.closest('[data-oc-id]') || link.closest('#'+PANEL_ID))continue;
      const cell=link.parentElement,id=link.getAttribute('href')?.match(/[?&]XID=(\d+)/i)?.[1];
      const badge=id?plannerMemberMailBadge(id,model,history,decisions):null;
      let node=cell.querySelector('.blom-member-mail-badge');
      if(!badge){node?.remove();cell.classList.remove('blom-member-mail-cell');continue;}
      cell.classList.add('blom-member-mail-cell');
      if(!node){node=document.createElement('span');node.className='blom-member-mail-badge';cell.appendChild(node);}
      visited.add(node);
      const signature=JSON.stringify(badge);if(node.dataset.signature===signature)continue;
      node.dataset.signature=signature;node.dataset.kind=badge.kind;node.textContent=badge.text;node.title=badge.title;
      node.setAttribute('aria-label',badge.title);
    }
    for(const node of document.querySelectorAll('.blom-member-mail-badge'))if(!visited.has(node)){
      node.parentElement?.classList.remove('blom-member-mail-cell');node.remove();
    }
  }

  function inlineSentMembers(crimeId,role,batch={}) {
    // A render pass uses one fresh history snapshot across every card. Never
    // retain this index across passes: releases and new receipts must appear.
    if(!batch.index){
      batch.index=new Map();
      const roster=blRoster();if(!roster)return [];
      const h=readJSON('black-ledger-oc-pm-shared-v1:'+roster.viewerId+':'+roster.factionId,{});
      const decisions=readJSON(plannerInvitationDecisionsKey(roster),{});
      const now=Date.now();
      for(const [id,row] of Object.entries(h.members || {})){
        if(!blAllowed(id) || !Number.isFinite(row.sentAt) || row.sentAt>now+60000)continue;
        const decision=decisions[id];
        if(decision?.mode==='release' && decision.fingerprint===JSON.stringify([row.key,row.sentAt]))continue;
        let pairs;try{pairs=JSON.parse(row.key).map(k=>JSON.parse(k));if(pairs.some(pair=>!Array.isArray(pair) || pair.length!==2))continue;}catch(_){continue;}
        const keys=new Set(pairs.map(pair=>JSON.stringify([String(pair[0]),String(pair[1]).trim().replace(/\s+/g,' ').toLowerCase()])));
        for(const key of keys){if(!batch.index.has(key))batch.index.set(key,[]);batch.index.get(key).push({id,...row});}
      }
    }
    return batch.index.get(JSON.stringify([String(crimeId),prettyRole(role).trim().replace(/\s+/g,' ').toLowerCase()])) || [];
  }
  function inlineSlotEmpty(card) {
    if(card.querySelector('a[href*="XID="]'))return false;
    const clone=card.cloneNode(true);for(const node of clone.querySelectorAll('.blom-inline-slot'))node.remove();
    return [...clone.querySelectorAll('button,a,input,span,[role="button"]')].some(n=>/^join(?:\s|$)/i.test((n.textContent || n.value || n.getAttribute('aria-label') || '').trim())) || /\bempty\b|\bvacant\b|\bavailable slot\b/i.test(clone.textContent);
  }
  async function prepareInlineInvitation(card,crimeId,slotKey,memberId) {
    const model=inlinePlannerModel();if(!model || !card.isConnected || !inlineSlotEmpty(card))throw new Error('Slot or scan changed. Scan Recruiting + Planning again.');
    const fit=model.plan.now.get(memberId) || model.plan.next.get(memberId);
    if(!fit || String(fit.crimeId)!==crimeId || fit.key!==slotKey)throw new Error('Recommendation changed. Review the refreshed slot.');
    const fresh=await collectFreshPlannerPage();
    const occupancy=crimes=>JSON.stringify(crimes.map(c=>[String(c.id),c.slots.map(s=>[s.position,s.user?.id || null])]).sort((a,b)=>Number(a[0])-Number(b[0])));
    if(inlinePlannerModel()?.state!==model.state || !card.isConnected || !inlineSlotEmpty(card) || occupancy(fresh.crimes)!==occupancy(model.state.crimes) || fresh.members.some(m=>model.state.members.find(old=>String(old.id)===String(m.id))?.is_in_oc!==m.is_in_oc))throw new Error('OC availability changed. Scan Recruiting + Planning again before mailing.');
    const spawnReviewSignature=requirePlannerSpawnReview(model.state,{...model.state.prefs,spawnBudget:applyLiveScopeBudget(model.state.prefs)});
    const membership=blRequireRoster();if(!blAllowed(memberId))throw new Error('Membership changed. Refresh your roster.');
    const groups=plannerAssignmentGroups(new Map([[memberId,fit]]),model.state.members),future=!model.plan.now.has(memberId);
    blStorageSet(PLANNER_NEWSLETTER_DRAFT_KEY,JSON.stringify({version:1,viewerId:membership.viewerId,factionId:membership.factionId,createdAt:Date.now(),expiresAt:Date.now()+1800000,title:'OC Assignments',spawnReviewSignature,messageScope:future?'future':'now',text:plannerAssignmentText(groups,'Black Ledger OC assignments',future),recipients:groups.flatMap(g=>g.rows.map(r=>({id:String(r.member.id),name:String(r.member.name || r.member.id)}))),nativeGroupExact:false}));
    document.dispatchEvent(new Event('black-ledger-inline-invitation'));
    historyNotice('Invitation prepared. The updated Message Helper opens the message for review; install Helper 1.8.14 if it does not open.');
  }
  function renderInlineMemberBest(card,model,assignment,sent,level) {
    const target=card.querySelector('.oc-smart-target-box');
    const existing=card.querySelector('.blom-inline-member-best');
    const person=assignment?{id:assignment[0]}:[...sent].sort((a,b)=>b.sentAt-a.sentAt)[0];
    if(!target || !model || !person){if(existing)existing.remove();return;}
    const id=String(person.id),best=model.memberBest.get(id),underPlaced=best && best.level>level;
    const name=model.state.members.find(m=>String(m.id)===id)?.name || id;
    const value=best?`${underPlaced?'▲ ':''}L${best.level} (${Math.round(best.cpr)}%)`:'—';
    const title=`${assignment?'Recommended member':'Most recently mailed member'}: ${name}. Average recorded role CPR per level; highest level averaging at least 67%.`;
    let row=existing;
    if(!row || row.parentElement!==target){if(row)row.remove();row=document.createElement('div');target.appendChild(row);}
    row.className='oc-smart-row oc-smart-member blom-inline-member-best'+(underPlaced?' oc-smart-underplaced':'');
    row.title=title;
    if(row.dataset.value===value)return;
    row.dataset.value=value;row.replaceChildren();
    const label=document.createElement('span');label.textContent='Member best';
    const strong=document.createElement('strong');strong.textContent=value;row.append(label,strong);
  }

  let planningItemsBusy=false,planningItemsReport=null;

  let planningItemsAttemptAt=0,planningItemsScope='',planningItemsCards='';
  function planningItemsCacheKey() {
    const roster=blRoster();return roster && roster.viewerId===String(getViewerId() || '')?'black-ledger-planning-items-v1:'+roster.viewerId+':'+roster.factionId:null;
  }
  function savePlanningItemsCache(crimes,rows,at) {
    const key=planningItemsCacheKey();if(!key)return;
    // Replace from a complete verified list; completed OCs cannot accumulate.
    const entries=Object.fromEntries(crimes.map(crime=>[crime.id,{at,crimeId:crime.id,crime:crime.name,pending:rows.some(row=>row.crimeId===crime.id && row.status==='unknown'),rows:rows.filter(row=>row.crimeId===crime.id)}]));
    blStorageSet(key,JSON.stringify({version:1,at,entries}));
  }
  function prunePlanningItemsCache(crimes) {
    const key=planningItemsCacheKey();if(!key)return;
    const cache=readJSON(key,null),old=cache?.version===1?cache.entries || {}:{};
    const entries={},added=[];
    for(const crime of crimes.filter(c=>c.status==='planning')){
      const previous=old[crime.id];
      const signature=JSON.stringify(crime.slots.map(s=>[s.position,String(s.user?.id || '')]));
      const oldSignature=previous?JSON.stringify(previous.rows.map(r=>[r.role,String(r.memberId)])):null;
      if(previous && oldSignature===signature)entries[crime.id]=previous;
      else{
        entries[crime.id]={at:null,crimeId:crime.id,crime:crime.name,pending:true,rows:crime.slots.map(slot=>({crime:crime.name,crimeId:crime.id,role:slot.position,memberId:String(slot.user?.id || ''),name:slot.user?.name || '',status:'unknown',item:'',reason:previous?'Crew changed — item check pending':'New Planning OC — item check pending'}))};
        if(!previous && cache?.version===1)added.push(crime);
      }
    }
    if(JSON.stringify(entries)!==JSON.stringify(old)){
      blStorageSet(key,JSON.stringify({version:1,at:cache?.at || null,entries}));
      planningItemsCards='';
      if(!planningItemsBusy){restorePlanningItemsCache();if(document.getElementById('blom-inline-scan'))showPlanningItemsReport(false);}
      if(added.length)historyNotice('New Planning OC'+(added.length===1?'':'s')+': '+added.map(c=>c.name+' #'+c.id).join(', ')+'. Item checks pending.');
    }
  }
  async function refreshPlanningItemCacheRoster() {
    if(planningItemsBusy || Date.now()-planningItemsAttemptAt<300000)return;
    planningItemsAttemptAt=Date.now();planningItemsBusy=true;const scope=planningItemsCacheKey();
    try{const crimes=await planningItemRoster();if(managerPageActive() && scope===planningItemsCacheKey())prunePlanningItemsCache(crimes);}
    catch(error){console.warn('[Black Ledger] Planning cache check:',error);}
    finally{planningItemsBusy=false;restorePlanningItemsCache();if(document.getElementById('blom-inline-scan'))showPlanningItemsReport(false);}
  }
  function restorePlanningItemsCache() {
    const key=planningItemsCacheKey();if(!key)return;
    const cache=readJSON(key,null);if(cache?.version!==1 || !cache.entries)return;
    planningItemsReport={at:cache.at,crimes:Object.keys(cache.entries).length,rows:Object.values(cache.entries).flatMap(e=>e.rows || []),error:'',cached:true,pending:Object.values(cache.entries).filter(e=>e.pending).length};
  }
  function planningCardsShown() {
    return [...document.querySelectorAll('[data-oc-id]')].some(root=>root.querySelector('[class*="phase___"] [aria-label="active"],[class*="phase___"] [aria-label="item-missing"],[class*="phase___"] [aria-label="paused"]'));
  }
  function autoPlanningItems(force=false) {
    if(!managerPageActive() || !blRoster() || plannerBusy || planningItemsBusy)return;
    if(!planningCardsShown()){refreshPlanningItemCacheRoster();return;}
    const scope=planningItemsCacheKey();if(scope!==planningItemsScope){planningItemsScope=scope;planningItemsReport=null;planningItemsAttemptAt=0;planningItemsCards='';}
    if(!planningItemsReport){restorePlanningItemsCache();if(planningItemsReport)showPlanningItemsReport(false);}
    const cards=[...document.querySelectorAll('[data-oc-id]')].map(r=>r.getAttribute('data-oc-id')+':'+r.querySelectorAll('button[class*="slotHeader___"]').length).sort().join('|');
    if(!force && Date.now()-planningItemsAttemptAt<300000 && cards===planningItemsCards)return;
    if(Date.now()-planningItemsAttemptAt<10000)return;planningItemsCards=cards;
    if(!document.getElementById('blom-inline-scan'))return;
    if(!planningItemsReport){restorePlanningItemsCache();if(planningItemsReport)showPlanningItemsReport(false);}
    refreshAutomaticPlanningItems().catch(error=>console.warn('[Black Ledger] Item check:',error));
  }
  function planningItemNeedsCheck(crime,cache,automatic) {
    const entry=cache?.entries?.[crime.id];
    // Inventory changes do not change crew occupancy. Verified results expire
    // so a previously missing (or available) item cannot persist indefinitely.
    return !automatic || !entry || !!entry.pending || !Number.isFinite(entry.at) || entry.at<=0 || Date.now()-entry.at>=300000;
  }
  function planningItemHeaders(root,crime) {
    const headers=[...root.querySelectorAll('button[class*="slotHeader___"]')];
    if(headers.length!==crime.slots.length)return null;
    const roles=headers.map(header=>{
      const title=header.querySelector('[class*="title___"]');
      if(!title)return '';
      const clone=title.cloneNode(true);
      // Torn includes the numeric checkpoint chance inside the role title.
      for(const badge of clone.querySelectorAll('[class*="successChance___"],.oc-smart-target-box,.oc-smart-level-badge'))badge.remove();
      return normalize(clone.textContent.trim());
    });
    const ordered=crime.slots.map(slot=>{
      const matches=headers.filter((header,i)=>roles[i]===normalize(slot.position));
      return matches.length===1?matches[0]:null;
    });
    return ordered.every(Boolean) && new Set(ordered).size===headers.length?ordered:null;
  }
  async function refreshAutomaticPlanningItems() {
    planningItemsBusy=true;planningItemsAttemptAt=Date.now();const scope=planningItemsCacheKey();
    try {
      const crimes=await planningItemRoster();
      if(!managerPageActive() || scope!==planningItemsCacheKey())return;
      prunePlanningItemsCache(crimes);restorePlanningItemsCache();
    } finally {planningItemsBusy=false;}
    if(!managerPageActive() || scope!==planningItemsCacheKey())return;
    showPlanningItemsReport(false);
    const cache=readJSON(planningItemsCacheKey(),null);
    if(Object.values(cache?.entries || {}).some(entry=>planningItemNeedsCheck({id:entry.crimeId},cache,true)))await scanPlanningItems({silent:true,automatic:true});
  }
  function silentPlanningItemStyle(enable) {
    document.getElementById('blom-silent-item-style')?.remove();
    if(!enable)return;
    const style=document.createElement('style');style.id='blom-silent-item-style';
    style.textContent='[role="tooltip"] {visibility:hidden !important;opacity:0 !important;pointer-events:none !important;}';document.head.appendChild(style);
  }

  function parsePlanningItemLabel(label) {
    const text=String(label || '').trim();
    const match=text.match(/(?:Used|Required) item:\s*(.+?)\s*[-–—]\s*(not available|unavailable|missing|available)(?:[.!]|$)/i);
    if(match)return {status:/^(available)$/i.test(match[2])?'available':'missing',item:match[1].trim()};
    if(/(?:no (?:item|items) (?:required|needed)|no required item)/i.test(text))return {status:'none',item:''};
    // A readable role tooltip without an item section means no required item.
    if(/checkpoint pass rate:/i.test(text) && !/(?:Used|Required) item:/i.test(text))return {status:'none',item:''};
    return {status:'unknown',item:''};
  }
  async function planningItemRoster() {
    const crimes=new Map(),cursors=new Set();let startFrom=0;
    for(let page=0;page<30;page++){
      if(cursors.has(startFrom))throw new Error('Planning pagination repeated.');cursors.add(startFrom);
      const result=await tornOCPageRequest('crimeList',{group:'Planning',startFrom});
      if(!Array.isArray(result.data))throw new Error('Planning list is incomplete.');
      for(const raw of result.data){
        const crime=plannerPageCrime(raw);if(!crime || crime.status!=='planning')continue;
        if(crimes.has(crime.id) && JSON.stringify(crimes.get(crime.id))!==JSON.stringify(crime))throw new Error('A Planning crew changed during the check.');
        crimes.set(crime.id,crime);
      }
      if(!result.data.length)return [...crimes.values()];
      const next=Number(result.nextStartFrom);if(!Number.isSafeInteger(next) || next<=startFrom)throw new Error('Planning pagination incomplete.');startFrom=next;
    }
    throw new Error('Too many Planning pages.');
  }
  function planningItemCrimeLink(item) {
    const link=document.createElement('a');link.textContent=String(item.crime)+' #'+String(item.crimeId);
    if(/^[1-9]\d*$/.test(String(item.crimeId)))link.href='/factions.php?step=your&type=12#/tab=crimes&crimeId='+encodeURIComponent(String(item.crimeId));
    link.style.cssText='color:#8bd8ff;text-decoration:underline;font-weight:600';
    link.title='Open this OC on Torn';return link;
  }
  function planningItemsSummary(report) {
    if(!report)return 'Awaiting item check';
    const missing=report.rows.filter(r=>r.status==='missing'),unknown=report.rows.filter(r=>r.status==='unknown');
    if(missing.length)return missing.length+' missing item'+(missing.length===1?'':'s')+(unknown.length?' · '+unknown.length+' unchecked roles':'');
    if(report.error)return 'Check incomplete';
    if(unknown.length)return unknown.length+' roles awaiting check';
    return report.crimes?'All required items present'+(report.cached?' · cached':''):'No Planning OCs';
  }
  function mountInlineDetailBody(disclosure,id) {
    const anchor=(id==='blom-items-details-body'?document.getElementById('blom-scan-details-body'):null) || document.getElementById('blom-controls-row') || document.getElementById('blom-inline-scan');
    if(!anchor)return;
    let body=document.getElementById(id);
    if(!body){body=document.createElement('div');body.id=id;body.className='blom-toolbar-detail-body';anchor.after(body);}
    body.replaceChildren(...[...disclosure.children].filter(node=>node.tagName!=='SUMMARY'));
    body.hidden=!disclosure.open;
    disclosure.setAttribute('aria-controls',id);
    // The native summary stays in the toolbar; only its content is below it.
    if(!disclosure.blomBodyToggle){
      disclosure.blomBodyToggle=true;
      disclosure.addEventListener('toggle',()=>{
        if(!disclosure.isConnected)return;
        const target=document.getElementById(id);if(target)target.hidden=!disclosure.open;
      });
    }
  }
  function showPlanningItemsReport(expand=false) {
    let panel=document.getElementById('blom-planning-items-report');
    if(!panel){panel=document.createElement('details');panel.id='blom-planning-items-report';panel.style.cssText='background:#1d2c35;color:#eaf5fc;padding:12px;margin:8px 0;border:1px solid #638da7;border-radius:8px;font:13px/1.5 sans-serif';document.getElementById('blom-inline-scan')?.after(panel);}
    // Background results update the warning, never override the user's disclosure choice.
    panel.open=panel.open || expand;panel.replaceChildren();
    const summary=document.createElement('summary');
    const fullSummary='Planning items · '+planningItemsSummary(planningItemsReport);
    const itemRows=planningItemsReport?.rows || [];
    const allClear=!!planningItemsReport && !planningItemsReport.error && itemRows.length>0 && itemRows.every(row=>row.status==='available' || row.status==='none');
    panel.dataset.itemState=itemRows.some(row=>row.status==='missing')?'missing':allClear?'ready':'pending';
    summary.textContent=planningItemsBusy?'Items · checking':allClear?'Items · all present':panel.dataset.itemState==='missing'?'Items · missing':planningItemsReport?.error?'Items · check failed':'Items · not verified';summary.title=fullSummary;panel.appendChild(summary);
    if(!planningItemsReport){const text=document.createElement('p');text.textContent=planningItemsBusy?'Checking Planning crews…':'No cached item results yet. Open Planning to run the automatic check.';panel.appendChild(text);mountInlineDetailBody(panel,'blom-items-details-body');return;}
    const report=planningItemsReport,missing=report.rows.filter(r=>r.status==='missing'),unknown=report.rows.filter(r=>r.status==='unknown');
    const info=document.createElement('p');info.textContent=`${report.cached?'Cached results':'Checked'} ${report.at?new Date(report.at).toLocaleString('en-GB', {timeZone:'Europe/London', hour12:false}):'not yet checked'} · ${report.crimes} OCs · ${missing.length} missing · ${unknown.length} unknown · ${report.rows.filter(r=>r.status==='available').length} available · ${report.rows.filter(r=>r.status==='none').length} no item required${report.error?' · '+report.error:''}`;panel.appendChild(info);
    function row(item,parent){const line=document.createElement('div');line.style.cssText='padding:8px 0;border-top:1px solid #344650;overflow-wrap:anywhere';line.appendChild(planningItemCrimeLink(item));line.appendChild(document.createTextNode(` · ${item.role} · ${item.name} [${item.memberId}] · ${item.status==='missing'?'MISSING: ':item.status==='available'?'Available: ':item.status==='none'?'No required item':'UNKNOWN — '}${item.item || item.reason || ''}`));if(item.status==='missing')line.style.color='#ffb3a7';parent.appendChild(line);}
    if(!missing.length && !unknown.length && !report.error){const text=document.createElement('p');text.textContent=report.crimes?'All required items present in the checked Planning crews.':'No Planning OCs in the last verified list.';panel.appendChild(text);}
    for(const item of [...missing,...unknown])row(item,panel);
    const detail=document.createElement('details'),heading=document.createElement('summary');heading.textContent='All checked roles';detail.appendChild(heading);for(const item of report.rows)row(item,detail);panel.appendChild(detail);mountInlineDetailBody(panel,'blom-items-details-body');
  }
  async function closePlanningItemTooltip(header) {
    let cleanup=header.blomPlanningTooltipCleanup;
    if(!cleanup){
      const tips=new Map();
      const remember=()=>{
        for(const id of (header.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)){
          const tip=document.getElementById(id);
          if(tip?.getAttribute('role')==='tooltip' && !tips.has(tip))tips.set(tip,
            ['visibility','pointer-events'].map(name=>({name,value:tip.style.getPropertyValue(name),priority:tip.style.getPropertyPriority(name)})));
        }
      };
      const hide=()=>{remember();for(const tip of tips.keys()){
        tip.style.setProperty('visibility','hidden','important');
        tip.style.setProperty('pointer-events','none','important');
      }};
      const restore=event=>{
        if(!event.isTrusted)return;
        remember();for(const [tip,styles] of tips)for(const style of styles){
          if(style.value)tip.style.setProperty(style.name,style.value,style.priority);
          else tip.style.removeProperty(style.name);
        }
      };
      cleanup={remember,hide};header.blomPlanningTooltipCleanup=cleanup;
      header.addEventListener('pointerenter',restore);
      header.addEventListener('focusin',restore);
      header.addEventListener('pointerleave',hide);
      header.addEventListener('mouseleave',hide);
      header.addEventListener('focusout',hide);
    }
    // Capture the portal BEFORE leave events: Torn may clear aria-describedby
    // immediately while retaining the visible popup node.
    cleanup.remember();
    header.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));
    header.dispatchEvent(new MouseEvent('mouseleave',{bubbles:false,relatedTarget:document.body}));
    header.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body}));
    header.dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,relatedTarget:document.body}));
    header.blur();
    cleanup.hide();
    await new Promise(resolve=>setTimeout(resolve,25));
    cleanup.hide();
  }
  async function scanPlanningItems(options={}) {
    const silent=options.silent!==false;
    if(planningItemsBusy)return;
    planningItemsBusy=true;planningItemsAttemptAt=Date.now();if(!options.automatic){planningItemsReport=null;showPlanningItemsReport();}
    silentPlanningItemStyle(silent);
    let rows=[],crimes=[],error='';const viewer=String(getViewerId() || ''),position=window.scrollY;
    const sameScope=()=>{if(!managerPageActive() || String(getViewerId() || '')!==viewer)throw new Error('Check paused: return to the focused OC page and try again.');blRequireRoster();};
    try {
      sameScope();crimes=await planningItemRoster();sameScope();prunePlanningItemsCache(crimes);
      const planning=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Planning');if(planning && !silent)planning.click();
      const cache=readJSON(planningItemsCacheKey(),null);
      const needsCheck=crime=>planningItemNeedsCheck(crime,cache,options.automatic);
      const toCheck=crimes.filter(needsCheck);
      rows=crimes.filter(crime=>!needsCheck(crime)).flatMap(crime=>cache.entries[crime.id].rows || []);
      const pending=new Map(toCheck.map(c=>[c.id,c]));
      for(let pass=0;pass<30 && pending.size;pass++){
        await new Promise(resolve=>setTimeout(resolve,25));sameScope();let checked=0;
        for(const root of document.querySelectorAll('[data-oc-id]')){
          const crime=pending.get(root.getAttribute('data-oc-id'));if(!crime)continue;
          const headers=planningItemHeaders(root,crime);if(!headers)continue;
          for(let i=0;i<headers.length;i++){
            sameScope();const header=headers[i],slot=crime.slots[i];
            const entry={crime:crime.name,crimeId:crime.id,role:slot.position,memberId:String(slot.user.id),name:slot.user.name,status:'unknown',item:'',reason:'Item tooltip unreadable'};
            if(!silent)header.scrollIntoView({block:'nearest'});
            try {
            if(header.getAttribute('data-is-tooltip-opened')!=='true')header.click();
            // Read immediately when Torn renders synchronously; otherwise poll
            // quickly while retaining the previous 1.2-second readiness budget.
            for(let attempt=0;attempt<=48;attempt++){
              if(attempt)await new Promise(resolve=>setTimeout(resolve,25));sameScope();
              const id=header.getAttribute('aria-describedby'),tooltip=id?document.getElementById(id):null;
              if(header.getAttribute('data-is-tooltip-opened')==='true' && tooltip?.getAttribute('role')==='tooltip'){
                const label=tooltip.querySelector('[aria-label]')?.getAttribute('aria-label') || tooltip.getAttribute('aria-label') || '';
                const item=parsePlanningItemLabel(label);Object.assign(entry,item);if(item.status!=='unknown'){entry.reason='';break;}
              }
            }
            } finally {await closePlanningItemTooltip(header);}
            rows.push(entry);
          }
          pending.delete(crime.id);checked++;
        }
        if(pending.size){if(silent)break;const roots=[...document.querySelectorAll('[data-oc-id]')];roots.at(-1)?.scrollIntoView({block:'end'});if(!checked && pass>8)break;}
      }
      for(const crime of pending.values())for(const slot of crime.slots)rows.push({crime:crime.name,crimeId:crime.id,role:slot.position,memberId:slot.user.id,name:slot.user.name,status:'unknown',item:'',reason:'Planning card not loaded or role order changed'});
      const after=await planningItemRoster();sameScope();
      const occupancy=list=>JSON.stringify(list.map(c=>[c.id,c.slots.map(s=>[s.position,s.user.id])]).sort((a,b)=>Number(a[0])-Number(b[0])));
      if(occupancy(crimes)!==occupancy(after))throw new Error('Planning crews changed during the check. Results are unverified; run again.');
      if(rows.length && rows.every(row=>row.status==='unknown'))throw new Error('No Planning roles could be checked. Open Planning and load the OC cards, then refresh items. Previous cache retained.');
      savePlanningItemsCache(crimes,rows,Date.now());
    }catch(e){error=String(e.message || e);rows=rows.map(r=>({...r,status:'unknown',reason:error}));}
    finally{silentPlanningItemStyle(false);planningItemsBusy=false;planningItemsReport={at:Date.now(),rows,crimes:crimes.length,error};showPlanningItemsReport(false);renderInlineRecruiting();if(!silent)window.scrollTo({top:position});}
  }

  function inlineCrimeScanMessage(model,crimeId) {
    return model && !model.state.crimes.some(crime=>String(crime.id)===String(crimeId))
      ? 'New OC detected — run Scan OCs to allocate its actual roles.' : null;
  }

  function inlineScanMessage() {
    if(plannerBusy)return 'Shared scan in progress…';
    if(plannerError)return 'Shared scan unavailable: '+plannerError;
    const saved=readJSON(PLANNER_PREFS,{});
    if(saved.pendingScan)return 'Settings changed — rescan to apply them';
    if(plannerState && Date.now()-plannerState.scannedAt>=300000)return 'Shared scan expired — refresh recommendations';
    return 'Scan required for recommendations';
  }
  function reconcileInlineSlots(roots,visited,model) {
    for(const root of roots)for(const box of root.querySelectorAll('.blom-inline-slot')){
      if(visited.has(box))continue;
      const message=model?'Role card could not be matched to the shared scan — expand or reload this OC':inlineScanMessage();
      if(box.textContent!==message){box.replaceChildren(document.createTextNode(message));delete box.dataset.signature;}
      box.parentElement?.querySelector('.blom-inline-member-best')?.remove();
    }
  }
  function renderInlineRescue(roots,model) {
    const previous=[...document.querySelectorAll('.blom-inline-rescue')];
    const row=model?plannerBestRescue(plannerRescueTransfers(model.state,model.plan,{...model.state.prefs,learning:model.state.learning || []})):null;
    let keep=null;
    if(row)for(const root of roots){
      if(String(root.getAttribute('data-oc-id'))!==row.from.id)continue;
      const crime=model.state.crimes.find(c=>String(c.id)===row.from.id),def=crime && plannerDefinition(crime.name,model.plan.defs);
      if(!def)continue;
      const cards=[...new Set([...root.querySelectorAll('[class*="contentLayer___"] > [class*="wrapper___"] > [class*="wrapper___"]'),...[...root.querySelectorAll('.oc-smart-target-box')].map(b=>b.parentElement)])];
      for(const card of cards){
        const member=[...card.querySelectorAll('a[href*="XID="]')].some(a=>String(a.getAttribute('href') || '').match(/[?&]XID=(\d+)/i)?.[1]===row.id);
        if(!member || normalize(plannerCardRole(card,def))!==normalize(row.from.role))continue;
        let box=card.querySelector('.blom-inline-rescue');
        if(!box){box=document.createElement('div');box.className='blom-inline-rescue';card.appendChild(box);}
        keep=box;const signature=JSON.stringify(row);
        if(box.dataset.signature===signature)break;
        box.dataset.signature=signature;box.replaceChildren();
        const label=document.createElement('strong');label.textContent='Possible stall rescue';box.appendChild(label);
        const link=document.createElement('a');link.href='https://www.torn.com/factions.php?step=your&type=12#/tab=crimes&crimeId='+encodeURIComponent(row.to.id);link.target='_blank';link.rel='noopener noreferrer';link.textContent=row.to.name+' #'+row.to.id+' · '+prettyRole(row.to.role);box.appendChild(link);
        const detail=document.createElement('div');detail.textContent='Donor retains '+row.donorCoverageHours.toFixed(1)+'h. Replacement: '+row.replacement.name+' (conditional).';box.appendChild(detail);
        const note=document.createElement('div');note.textContent='Verify waiting at 0%; move manually, then rescan.';box.appendChild(note);
        break;
      }
    }
    for(const box of previous)if(box!==keep)box.remove();
  }

  function inlineSyncStatus(status) {
    const syncing=status?.message==='Syncing sent assignments…';
    const error=status?.ok===false?(syncing?status.lastError:status.message):null;
    return {attention:!!error,text:error && syncing?error+' Retrying…':status?.message || 'Manager device sync pending — configure Manager access on each device.'};
  }
  function plannerTrackSpawnDemand(needed,state,plan,prefs) {
    if(!state.shared || !/^[1-9]\d*$/.test(String(state.viewerId)) || !/^[1-9]\d*$/.test(String(state.factionId)))return needed;
    const key='black-ledger-spawn-demand-v1:'+state.viewerId+':'+state.factionId;
    const signature=plannerReviewDigest(JSON.stringify({
      levels:plannerSelectedLevels(prefs).sort((a,b)=>a-b),
      members:state.members.map(m=>[String(m.id),m.is_in_oc,m.ocEligible,m.status?.state || 'Okay']).sort((a,b)=>a[0].localeCompare(b[0]))
    }));
    try{
      const read=()=>typeof GM_getValue==='function'?GM_getValue(key,null):blStorageGet(key);
      const raw=read();let saved=raw?JSON.parse(raw):null;
      if(!saved || saved.signature!==signature){
        if(!needed.crews.length || !plannerSpawnQuantityDecision(needed,state,plan,prefs).allowed)return needed;
        saved={signature,known:state.crimes.map(c=>String(c.id)),counts:Object.fromEntries(needed.groups.map(g=>[g.level,g.count])),consumed:{}};
      }
      const known=new Set(saved.known);
      for(const crime of state.crimes)if(!known.has(String(crime.id))){
        const level=Number(crime.difficulty)||plan.defs?.[crime.name]?.level;
        // An unidentified new OC must be assessed before another spend.
        if(!Number.isInteger(level) || level<1 || level>10)return {...needed,crews:[],groups:[],trackingError:'New OC needs a fresh scan before another spawn.'};
        const bracket=2*Math.floor((level-1)/2)+1;
        saved.consumed[bracket]=(saved.consumed[bracket]||0)+1;known.add(String(crime.id));
      }
      saved.known=[...known];
      const value=JSON.stringify(saved);
      if(value!==raw){
        if(typeof GM_setValue==='function')GM_setValue(key,value);else blStorageSet(key,value);
        if(read()!==value)throw new Error('Spawn tracking could not be saved.');
      }
      const left=new Map(Object.entries(saved.counts).map(([level,count])=>[Number(level),Math.max(0,count-(saved.consumed[level]||0))]));
      const crews=needed.crews.filter(crew=>{const n=left.get(crew.level)||0;if(!n)return false;left.set(crew.level,n-1);return true;});
      const groups=needed.groups.map(g=>({...g,count:crews.filter(c=>c.level===g.level).length})).filter(g=>g.count);
      return {...needed,crews,groups,fulfilled:needed.crews.length>crews.length};
    }catch(error){return {...needed,crews:[],groups:[],trackingError:'Spawn tracking could not be saved. Resolve storage or sync, then scan again.'};}
  }

  function plannerSpawnSummaryCard(needed,state,plan,prefs,releaseStart=null) {
    if(!needed.crews.length && !needed.trackingError && releaseStart)return '<strong>Wait for crew release — reassess one '+escapeHtml(releaseStart.label)+' start</strong><p>Earliest assessed start: '+escapeHtml(new Date(releaseStart.startAt).toLocaleString('en-GB',{timeZone:'Europe/London',hour12:false}))+'. Confirm completion, run Fresh shared scan and recheck Scope first. This forecast does not authorise spending or assign hypothetical roles.</p>';
    const decision=plannerSpawnQuantityDecision(needed,state,plan,prefs);
    const quantity=(needed.groups || []).map(g=>`${g.count} × ${g.label}`).join(' · ');
    const title=needed.trackingError?'Wait — scan before spawning':needed.crews.length?(decision.allowed?'Spawn ':'Wait — ')+quantity:'No new OCs to spawn now';
    const reason=needed.trackingError || (needed.crews.length && decision.allowed?'Spawn one, then Scan OCs. The remaining quantity updates after the scan.':needed.crews.length?decision.reason.split(/\.(?:\s|$)/)[0]+'.':needed.fulfilled?'The previous spawn request is covered.': 'No additional bracket has confirmed crew coverage.');
    return '<strong>'+escapeHtml(title)+'</strong><p>'+escapeHtml(reason)+'</p>';
  }

  function plannerReleaseStart(state,plan,prefs,unusedNow,unusedSoon) {
    const asOf=state.scannedAt,hour=3600000;
    if(!state.shared || !state.complete || !Number.isFinite(asOf) || Date.now()<asOf || Date.now()-asOf>=300000 || plan.spawningBlocked || !unusedNow.length)return null;
    const reserved=new Set([...plan.now.keys(),...plan.next.keys(),...(plan.coverageReservations?.keys() || []),...(plan.mailedHeld || [])].map(String));
    const current=unusedNow.filter(member=>member.is_in_oc===false && member.ocEligible!==false && (!member.status?.state || member.status.state==='Okay') && !reserved.has(String(member.id)));
    const releases=(plan.active.releases?.rows || []).filter(row=>row.kind==='scanned' && Number.isFinite(row.expectedAt) && row.expectedAt>=asOf && row.expectedAt<=asOf+24*hour);
    const arrivals=unusedSoon.map(member=>({member,ready:plan.active.soon.get(String(member.id))})).filter(({member,ready})=>member.is_in_oc===true && member.ocEligible!==false && (!member.status?.state || member.status.state==='Okay') && !reserved.has(String(member.id)) && ready && releases.some(release=>release.crimeId===String(ready.crimeId) && release.expectedAt===ready.readyAt && release.memberIds.includes(String(member.id))));
    if(!current.length || !arrivals.length)return null;
    const cache=plannerReleaseStart.cache || (plannerReleaseStart.cache=new WeakMap());
    if(!cache.has(state))cache.set(state,new Map());
    const budgetAge=Math.max(asOf,Date.now())-Number(prefs.spawnBudget?.updatedAt);
    const memo=cache.get(state),memoKey=JSON.stringify([prefs.levels,prefs.includeStale,prefs.spawnBudget,budgetAge>=0 && budgetAge<=15*60000,prefs.learning,[...reserved].sort(),current.map(member=>String(member.id)),arrivals.map(row=>[String(row.member.id),row.ready.readyAt])]);
    if(memo.has(memoKey))return memo.get(memoKey);
    const highEndBlocked=(state.crimes || []).some(crime=>(Number(crime.difficulty) || plan.defs[crime.name]?.level)===8 && ['recruiting','planning'].includes(crime.status));
    const preferred=current.map(member=>String(member.id));
    const maxAge=typeof PLANNER_MAX_AGE==='number'?PLANNER_MAX_AGE:30*86400000;
    for(const startAt of [...new Set(arrivals.map(row=>row.ready.readyAt))].sort((a,b)=>a-b)){
      const ready=current.concat(arrivals.filter(row=>row.ready.readyAt<=startAt).map(row=>row.member));
      const later=arrivals.filter(row=>row.ready.readyAt>startAt);
      const futureHours=Object.fromEntries(later.map(row=>[String(row.member.id),(row.ready.readyAt-startAt)/hour]));
      const options=plannerPreparation(ready,[{hours:24,members:later.map(row=>row.member)}],plan.defs,{...prefs,asOf:startAt,initialStages:2,spawnBrackets:true,preferFutureFollower:true,releasePreferredIds:preferred,memberReadyHours:futureHours});
      const candidates=[];
      for(const level of options.levels){
        if(level.level>=7 && highEndBlocked || !level.outcomes.length || level.outcomes.some(outcome=>!outcome.daily?.complete || outcome.plannedUncertain!==0 || plannerHistoryAssessment(outcome.crime,prefs.learning || []).weak || outcome.daily.schedule.some(row=>reserved.has(String(row.id)) || row.fit.kind!=='Observed' || !row.fit.seen || row.fit.stale || startAt+row.availableHours*hour-row.fit.seen>maxAge)))continue;
        const ids=[...new Set(level.outcomes.flatMap(outcome=>outcome.daily.schedule.map(row=>String(row.id))))];
        const currentIds=preferred.filter(id=>ids.includes(id));if(!currentIds.length)continue;
        const policy=plannerSpawnDecision({...level,allReliable:true},state,plan,prefs,false);
        const neededReleases=releases.filter(release=>release.memberIds.some(id=>ids.includes(id)));
        candidates.push({startAt,level:level.level,label:plannerSpawnLabel(level),ids,currentIds,scopeReady:policy.allowed,scopeReason:policy.reason,canSpendNow:false,conditional:true,
          releases:neededReleases.map(release=>({crimeId:release.crimeId,crime:release.crime,expectedAt:release.expectedAt,memberIds:release.memberIds.filter(id=>ids.includes(id))})),
          outcomes:level.outcomes.map(outcome=>({crime:outcome.crime,level:outcome.level,schedule:outcome.daily.schedule.map(row=>({...row,expectedJoinAt:startAt+row.availableHours*hour,joinByAt:startAt+row.joinByHours*hour,currentlyFree:preferred.includes(String(row.id)),name:state.members.find(member=>String(member.id)===String(row.id))?.name || String(row.id)}))}))});
      }
      candidates.sort((a,b)=>Number(b.scopeReady)-Number(a.scopeReady) || b.currentIds.length-a.currentIds.length || b.level-a.level);
      if(candidates.length){memo.set(memoKey,candidates[0]);return candidates[0];}
    }
    memo.set(memoKey,null);return null;
  }

  function plannerReleaseStartCard(forecast) {
    if(!forecast)return '';
    const date=time=>new Date(time).toLocaleString('en-GB',{timeZone:'Europe/London',hour12:false});
    return `<div class="blom-alert blom-release-start"><strong>Conditional start after crew release: one ${escapeHtml(forecast.label)} OC</strong><p>Earliest assessed start: ${escapeHtml(date(forecast.startAt))}. Expected crew releases: ${forecast.releases.map(row=>escapeHtml(row.crime)+' #'+escapeHtml(row.crimeId)+' ('+escapeHtml(date(row.expectedAt))+')').join('; ')}. Before considering a spawn, confirm a qualifying first person is free, run Fresh shared scan and recheck Scope. Later candidates must finish their OCs before joining.</p><p>${forecast.outcomes.length}/${forecast.outcomes.length} possible crimes have two distinct qualifying candidates (one for a single-role OC). The first person may join any qualifying position. Later staffing remains unresolved. The random outcome may leave some current candidates without a role; these are alternatives, not confirmed assignments.</p>${!forecast.scopeReady?`<p class="blom-spawn-warning">Scope/policy review: ${escapeHtml(forecast.scopeReason)}</p>`:''}<details class="blom-inline-details"><summary>Candidate pairs by possible crime</summary>${forecast.outcomes.map(outcome=>`<p><strong>${escapeHtml(outcome.crime)}</strong>: ${outcome.schedule.map(row=>escapeHtml(row.name)+' → '+escapeHtml(prettyRole(row.fit.role))+' ('+formatCpr(row.fit.cpr)+' CPR / '+row.fit.target+'% target; '+(row.currentlyFree?'free now, candidate join from ':'expected free by ')+escapeHtml(date(row.expectedJoinAt))+')').join('; ')}</p>`).join('')}</details></div>`;
  }

  function plannerSpareSpawnAssessment(plan,state,prefs) {
    const unusedNow=plan.available.filter(m=>!plan.coverageReservations?.has(String(m.id)) && !plan.mailedHeld?.has(String(m.id)) && !plan.now.has(String(m.id)) && (!m.status?.state || m.status.state==='Okay'));
    const unusedSoon=plan.upcoming.filter(m=>!plan.coverageReservations?.has(String(m.id)) && !plan.mailedHeld?.has(String(m.id)) && !plan.next.has(String(m.id)) && (!m.status?.state || m.status.state==='Okay'));
    const unusedById=new Map(unusedSoon.map(m=>[String(m.id),m]));
    const unused12=plan.forecast.within12.filter(m=>unusedById.has(String(m.id)));
    const unused24=plan.forecast.within24.filter(m=>unusedById.has(String(m.id)));
        const prepHorizons=[
      {hours:12,members:unused12},
      {hours:24,members:[...unused12,...unused24]}
    ];
    let needed=plannerSpawnNeeded(unusedNow,plan.defs,{...prefs,spawningBlocked:plan.spawningBlocked,highEndSpawnBlocked:(state.crimes || []).some(c=>(Number(c.difficulty) || plan.defs[c.name]?.level)===8 && ['recruiting','planning'].includes(c.status)),memberReadyHours:Object.fromEntries(unusedSoon.map(m=>[String(m.id),Math.max(0,(plan.active.soon.get(String(m.id)).readyAt-(prefs.asOf ?? state.scannedAt))/3600000)]))},plan.protectedHigh,prepHorizons);
    needed=plannerTrackSpawnDemand(needed,state,plan,prefs);
    const preparation=needed.assessment;
    needed.highEndHold=(state.crimes || []).some(c=>(Number(c.difficulty) || plan.defs[c.name]?.level)===8 && ['recruiting','planning'].includes(c.status));
    const spawnOpportunity=!needed.crews.length?plannerSpawnOpportunity(preparation,unusedNow,state,plan,prefs):null;
    const releaseStart=!needed.crews.length && !needed.trackingError && typeof plannerReleaseStart==='function'?plannerReleaseStart(state,plan,prefs,unusedNow,unusedSoon):null;
    return {unusedNow,unusedSoon,needed,preparation,spawnOpportunity,releaseStart};
  }

  function renderInlineSpawn(model,anchor,unscanned) {
    let box=document.getElementById('blom-inline-spawn');
    if(!box){box=document.createElement('section');box.id='blom-inline-spawn';anchor.after(box);}
    if(box.previousElementSibling!==anchor)anchor.after(box);
    let html='<strong>New OC suggestions</strong>';
    if(plannerBusy || plannerError || !model || unscanned){
      html+='<p>'+escapeHtml(unscanned?'New OC detected — scan both lists again before spawning.':inlineScanMessage())+'</p>';
    }else{
      const prefs={...model.state.prefs,asOf:model.state.scannedAt,spawnBrackets:true,spawnBudget:applyLiveScopeBudget(model.state.prefs),learning:model.state.learning || []};
      const signature=JSON.stringify(prefs.spawnBudget);
      if(model.spawnBudgetSignature!==signature || !model.spawnAssessment){model.spawnAssessment=plannerSpareSpawnAssessment(model.plan,model.state,prefs);model.spawnBudgetSignature=signature;}
      const {needed,releaseStart}=model.spawnAssessment;
      html=plannerSpawnSummaryCard(needed,model.state,model.plan,prefs,releaseStart);

    }
    if(box.innerHTML!==html)box.innerHTML=html;
  }

  function plannerCompletionText(row) {
    if(!row)return 'Completion unverified — run Scan OCs for current staffing checks.';
    return `${row.complete?'Completion supported':'Later staffing unresolved · suitable joins can still be recommended'} — ${row.occupied}/${row.total} occupied; ${row.qualified}/${row.occupied} occupied roles meet planning policy; ${row.covered}/${row.total} roles supported.`+
      (row.issues.length?' '+row.issues.join('; '):' Future arrivals remain conditional. Staffing coverage is not a success prediction.');
  }

  function renderInlineCompletion(root,model,crimeId) {
    const id='blom-inline-completion-'+crimeId;
    let box=document.getElementById(id);
    if(!box){box=document.createElement('section');box.id=id;box.dataset.crimeId=String(crimeId);box.className='blom-inline-completion';box.setAttribute('role','status');}
    // Outside Torn's card: its native first-child effects can tint/overlay our notice.
    if(box.nextElementSibling!==root)root.before(box);
    const row=model?.plan.active.completion?.find(r=>r.crimeId===String(crimeId));
    const text=plannerCompletionText(row);
    if(box.textContent!==text)box.textContent=text;
    const colour=row?.complete?'#8be0ac':'#ffd08a';
    box.style.cssText=`display:block!important;box-sizing:border-box!important;margin:8px!important;padding:10px!important;background:#20303a!important;background-image:none!important;opacity:1!important;filter:none!important;box-shadow:none!important;isolation:isolate!important;position:relative!important;color:${colour}!important;-webkit-text-fill-color:${colour}!important;border:1px solid ${colour}!important;border-radius:6px!important;font:13px/1.5 sans-serif!important;white-space:normal!important;overflow-wrap:anywhere!important;`;
  }

  function renderInlineRecruiting() {
    if(!managerPageActive())return;
    styleInlineRecruitingButtons();
    const roots=[...document.querySelectorAll('[data-oc-id]')].filter(r=>!r.closest('#'+PANEL_ID));
    const visibleIds=new Set(roots.map(root=>root.getAttribute('data-oc-id')));
    for(const notice of document.querySelectorAll('.blom-inline-completion'))if(!visibleIds.has(notice.dataset.crimeId))notice.remove();
    const pageAnchor=roots[0] || document.getElementById(SMART_SETTINGS_ID);
    if(!pageAnchor)return;
    let toolbar=document.getElementById('blom-inline-scan');
    if(!toolbar){toolbar=document.createElement('div');toolbar.id='blom-inline-scan';toolbar.style.cssText='padding:10px;margin:8px 0;background:#1d2c35;color:#d8e9f2;border:1px solid #53778b;border-radius:8px;font:13px/1.5 sans-serif';pageAnchor.before(toolbar);}
    const smartControls=document.getElementById(SMART_SETTINGS_ID);
    if(smartControls){
      let row=document.getElementById('blom-controls-row');
      if(!row){row=document.createElement('div');row.id='blom-controls-row';smartControls.before(row);}
      if(smartControls.parentElement!==row)row.appendChild(smartControls);
      if(toolbar.parentElement!==row)row.appendChild(toolbar);
      const report=document.getElementById('blom-planning-items-report');
      if(report && report.parentElement!==row)row.appendChild(report);
    }
    const scanModel=inlinePlannerModel(),unscanned=scanModel && roots.some(root=>inlineCrimeScanMessage(scanModel,root.getAttribute('data-oc-id')));
    const status=plannerBusy?'Scanning both lists…':plannerError || (unscanned?'New OC detected — run Scan OCs to allocate its actual roles.':scanModel?`Shared Scan · ${new Date(plannerState.scannedAt).toLocaleString('en-GB', {timeZone:'Europe/London', hour12:false})}`:'Scan required · suggestions expire after five minutes');
    const bank=liveScopeBank();
    const syncRoster=blRoster(),syncStatus=syncRoster?readJSON('black-ledger-oc-pm-shared-v1:'+syncRoster.viewerId+':'+syncRoster.factionId+':status',null):null;
    const syncDisplay=inlineSyncStatus(syncStatus),syncText=syncDisplay.text;
    const signature=status+plannerBusy+planningItemsBusy+(bank?.balance ?? "")+syncText;
    const itemScope=planningItemsCacheKey();
    if(itemScope!==planningItemsScope){planningItemsScope=itemScope;planningItemsReport=null;planningItemsAttemptAt=0;planningItemsCards='';document.getElementById('blom-planning-items-report')?.remove();}
    if(!planningItemsReport)restorePlanningItemsCache();
    if(!document.getElementById('blom-planning-items-report'))showPlanningItemsReport(false);
    // Torn/PDA can retain title popups after these controls are replaced.
    // Keep descriptions accessible without registering host-page hover tooltips.
    if(toolbar.dataset.signature!==signature){const previousDetails=toolbar.querySelector('.blom-scan-details');if(previousDetails)toolbar.dataset.detailsOpen=String(previousDetails.open);toolbar.dataset.signature=signature;toolbar.replaceChildren();const button=document.createElement('button');button.type='button';button.textContent='Scan OCs';button.setAttribute('aria-description','Scan Recruiting + Planning');button.disabled=plannerBusy;button.style.cssText='padding:10px;margin-right:10px;min-height:44px;cursor:pointer';button.onclick=async()=>{const work=refreshPlanner();renderInlineRecruiting();await work;renderInlineRecruiting();autoPlanningItems(true);};const card=document.createElement('div');card.className='blom-shared-scan-card';card.setAttribute('role','status');card.setAttribute('aria-live','polite');
      const label=document.createElement('strong');label.textContent='Shared Scan';card.appendChild(label);
      if(!plannerBusy && !plannerError && !unscanned && scanModel){
        const date=new Date(plannerState.scannedAt),time=document.createElement('time');time.dateTime=date.toISOString();
        for(const text of [date.toLocaleDateString('en-GB', {timeZone:'Europe/London'}),date.toLocaleTimeString('en-GB', {timeZone:'Europe/London', hour12:false})]){const line=document.createElement('span');line.textContent=text;time.appendChild(line);}card.appendChild(time);
      }else{card.dataset.state=plannerError?'error':'pending';const detail=document.createElement('span');detail.textContent=status;card.appendChild(detail);}
      if(bank){const scope=document.createElement('span');scope.textContent='Scope bank: '+bank.balance;card.appendChild(scope);}
      const syncLine=document.createElement('span');syncLine.textContent=syncText;syncLine.style.cssText='color:#eaf5fc;-webkit-text-fill-color:#eaf5fc;overflow-wrap:anywhere';card.appendChild(syncLine);
      const info=document.createElement('details');info.className='blom-scan-details';
      const summary=document.createElement('summary');summary.textContent=plannerBusy?'Scanning…':plannerError?'Scan needs attention':syncDisplay.attention?'Sync needs attention':unscanned?'New OC · scan required':scanModel?'Scan up to date':'Scan required';
      if(plannerError || syncDisplay.attention)info.dataset.attention='true';
      info.open=toolbar.dataset.detailsOpen==='true';
      info.addEventListener('toggle',()=>{if(info.isConnected)toolbar.dataset.detailsOpen=String(info.open);});
      info.append(summary,card);toolbar.append(button,info);mountInlineDetailBody(info,'blom-scan-details-body');
      const items=document.createElement('button');items.type='button';items.textContent=planningItemsBusy?'Checking items…':'Refresh items';items.setAttribute('aria-description','Refresh Planning items');items.disabled=planningItemsBusy;items.style.cssText='grid-column:1 / -1;min-height:44px;padding:8px';items.onclick=()=>scanPlanningItems({silent:true});toolbar.appendChild(items);}
    const model=scanModel,visited=new Set(),sentBatch={};
    if(typeof renderUnassignedMailBadges==='function')renderUnassignedMailBadges(model);
    const previous=plannerInputContext;plannerInputContext=model?.state || null;
    try {
      const defs=plannerWeights();
      renderInlineSpawn(model,document.getElementById('blom-controls-row') || toolbar,unscanned);
      if(typeof renderInlineRescue==='function')renderInlineRescue(roots,model);
      for(const root of roots){
        if([...root.querySelectorAll('[class*="phase___"] [class*="title___"]')].some(n=>/^(success|failed)$/i.test(n.textContent.trim())))continue;
        const crimeId=root.getAttribute('data-oc-id'),crime=model?.state.crimes.find(c=>String(c.id)===crimeId);
        renderInlineCompletion(root,model,crimeId);
        const title=root.querySelector('[class*="panelTitle___"]')?.textContent.replace(/OC Level\s*\d+/ig,'').trim();
        const definition=plannerDefinition(crime?.name || title || '',defs);
        const name=Object.keys(defs).find(n=>defs[n]===definition);if(!name)continue;
        let cards=[...root.querySelectorAll('[class*="contentLayer___"] > [class*="wrapper___"] > [class*="wrapper___"]')];
        cards=[...new Set([...cards,...[...root.querySelectorAll('.oc-smart-target-box')].map(b=>b.parentElement)])];
        for(const card of cards){
          let box=card.querySelector('.blom-inline-slot');
          const role=plannerCardRole(card,defs[name]);
          if(!role || !inlineSlotEmpty(card)){if(box)box.remove();card.querySelector('.blom-inline-member-best')?.remove();continue;}
          const slots=crime?.slots.map((slot,index)=>({slot,index})).filter(x=>normalize(x.slot.position)===normalize(role)) || [];
          // Ambiguous repeated role labels cannot safely identify a slot.
          const slot=slots.length===1 && slots[0].slot.user===null?slots[0]:null;
          const key=slot?`${crimeId}:${slot.index}`:null;
          const assignment=model && key?[...model.plan.now,...model.plan.next].find(([,fit])=>fit.key===key):null;
          const sent=inlineSentMembers(crimeId,role,sentBatch);
          renderInlineMemberBest(card,model,assignment,sent,defs[name].level);
          const rows=sent.map(r=>{const member=model?.state.members.find(m=>String(m.id)===r.id);const obs=model?sharedPlannerObservation(r.id,name,role,true):null;
            const occupied=crime?.slots.find(s=>String(s.user?.id || '')===r.id);
            const status=occupied?'Mailed — already in this OC as '+prettyRole(occupied.position)+'. Old invitation can be released: ':'Mailed — awaiting join: ';
            return `${status}${member?.name || meta.names[r.id] || r.name || r.id}${obs?` · Role CPR ${obs.cpr}%${obs.stale?' (stale)':''}`:''} · ${new Date(r.sentAt).toLocaleString('en-GB', {timeZone:'Europe/London', hour12:false})}${assignment && assignment[0]===r.id?'':' · '+inlineMemberBestText(model,r.id)}`;});
          for(const issue of model?.plan.assignmentConflicts || [])if(issue.id && sent.some(r=>r.id===issue.id))rows.push('Invitation review: '+issue.reason+' '+(issue.action || ''));
          if(assignment){const [id,fit]=assignment,member=model.state.members.find(m=>String(m.id)===id);rows.push(`Recommended: ${member?.name || id} · ${fit.kind==='Estimated'?'PROVISIONAL estimated CPR':'Role CPR'} ${fit.cpr}%${fit.estimatedFrom?' · '+fit.source:''} · Target ${fit.target}%${fit.stale?' · STALE CPR':''} · ${model.plan.now.has(id)?'Available now':'Expected in '+plannerTime(model.plan.active.soon.get(id).readyAt)}`);}
          const conflict=model?.plan.assignmentConflicts?.find(c=>c.slot?.key===key);
          if(conflict)rows.push('Management decision needed: '+conflict.reason);
          const deferred=model?.plan.deferred?.find(f=>f.key===key);
          if(!rows.length)rows.push(inlineCrimeScanMessage(model,crimeId) || (slot && model?.plan.active.open.find(s=>s.key===key)?.openingUnsupported?(model.plan.active.open.find(s=>s.key===key).openingHoldReason || 'Hold starting this OC — no distinct qualifying follow-on candidate within 24h'):deferred?(deferred.coveragePlanned?'Next join covered conditionally. No additional eligible free member allocated to this role; future coverage depends on actual joins.':`Fill later · next stall in ${plannerTime(deferred.stallAt)}${deferred.coverageSource==='member-progress'?' · member progress':' · countdown fallback'}. No eligible free member allocated; future arrivals remain conditional.`):model?(slot?'No qualifying member allocated for this role':'Slot needs an exact role match'):inlineScanMessage()));
          const sig=JSON.stringify([rows,key,assignment?.[0],!!model]);
          if(box?.dataset.signature===sig){visited.add(box);continue;}
          if(!box){box=document.createElement('div');box.className='blom-inline-slot';card.appendChild(box);}
          visited.add(box);box.dataset.signature=sig;box.title='Member best uses average recorded role CPR per level (67% minimum), from this shared scan. It is descriptive; placement uses exact role targets and the existing planner rules.';box.style.cssText='margin:8px 0;padding:9px;border:1px dashed #7190a1;border-radius:7px;background:#253642;color:#c6d5df;-webkit-text-fill-color:#c6d5df;overflow-wrap:anywhere;font:12px/1.5 sans-serif';box.replaceChildren();
          for(const text of rows){const line=document.createElement('div');line.textContent=text;box.appendChild(line);}
          for(const receipt of sent){
            const button=document.createElement('button');button.type='button';button.textContent='Release invitation';
            button.title='Release the old planning reservation across your devices. Sent history and Torn signup stay intact.';
            button.style.cssText='margin-top:6px;padding:8px;min-height:44px;width:100%;white-space:normal;overflow-wrap:anywhere;cursor:pointer';
            button.disabled=!model;
            if(!model)button.title='Run a Fresh shared scan before releasing this invitation.';
            button.onclick=()=>{button.disabled=true;try{if(resolvePlannerInvitation(receipt.id,'release',plannerInvitationDecisionFingerprint(receipt)))renderInlineRecruiting();}catch(e){historyNotice(e.message,'error');}finally{if(button.isConnected)button.disabled=!inlinePlannerModel();}};
            box.appendChild(button);
          }
          if(assignment && !sent.some(r=>r.id===assignment[0])){const button=document.createElement('button');button.type='button';button.textContent='Mail invitation';button.style.cssText='margin-top:6px;padding:8px;min-height:44px;cursor:pointer';button.onclick=async()=>{button.disabled=true;button.textContent='Checking availability…';try{await prepareInlineInvitation(card,crimeId,key,assignment[0]);}catch(e){historyNotice(e.message,'error');}finally{button.disabled=false;button.textContent='Mail invitation';}};box.appendChild(button);}
        }
      }
    }finally{reconcileInlineSlots(roots,visited,model);plannerInputContext=previous;}
  }

  function renderPlanner(body) {
    const previousContext=typeof plannerInputContext!=='undefined'?plannerInputContext:null;
    if(typeof plannerInputContext!=='undefined')plannerInputContext=plannerState?.shared?plannerState:null;
    try {
    plannerTimerSignature=plannerTimerFingerprint();
    const saved = readJSON(PLANNER_PREFS, {});
    const prefs = plannerState?.shared?{...plannerState.prefs,asOf:plannerState.scannedAt,learning:plannerState.learning || []}:{includeStale: saved.includeStale === true, levels:plannerSelectedLevels(saved)};
    prefs.spawnBrackets=true;
    prefs.spawnBudget=applyLiveScopeBudget(prefs);
    // Access expires with the scan; recommendations are not shown indefinitely.
    refreshPlannerSpawnReview(plannerState,prefs);
    const verified = !saved.pendingScan && plannerState && Date.now() - plannerState.scannedAt < (5*60000) && (!plannerState.unassignedAt || Date.now()-plannerState.unassignedAt<5*60000) && String(getViewerId()) === plannerState.viewerId && (!plannerState.shared || plannerState.members.map(m=>String(m.id)).sort().join(',')===blRoster()?.memberIds.slice().sort().join(','));
    const sharedNow=currentSharedCache();
    const syncRoster=blRoster(),syncStatus=syncRoster?readJSON('black-ledger-oc-pm-shared-v1:'+syncRoster.viewerId+':'+syncRoster.factionId+':status',null):null;
    body.innerHTML = `<div class="blom-planner-controlbar">
      <div class="blom-placement-note">${blRoster() ? (blRoster().source==='two-page'?'Two-page roster checked ':'Membership last verified ')+new Date(blRoster().checkedAt).toLocaleString('en-GB', {timeZone:'Europe/London', hour12:false}) : 'Set up automatic membership sync in Data → Configure roster sync.'}</div>
      <button id="blom-planner-refresh" class="blom-primary blom-scan-main" ${plannerBusy ? 'disabled' : ''}>${plannerBusy ? 'Scanning…' : '↻ Fresh shared scan'}</button>
      <button id="blom-spawn-budget" type="button" class="blom-budget-button">Set spawn Scope budget</button>
      <span class="blom-control-chip ${saved.management===true?'blom-control-good':'blom-control-warn'}">${saved.management===true?'✓ Manager':'Manager off'}</span>
      <span class="blom-control-chip">CPR ${sharedNow?.count ?? '—'}</span>
      <span class="blom-control-chip">${escapeHtml(factionTargetStatus())}</span>

    </div>
    <p class="blom-placement-note" role="status">${escapeHtml(syncStatus?.message || 'Manager device sync pending — configure Manager access on each device.')}</p>
    ${plannerError ? `<div class="blom-alert blom-alert-bad">${escapeHtml(plannerError)}</div>` : ''}
    <fieldset style="border:1px solid #344650;border-radius:8px;margin:12px 0;padding:10px 12px;">
      <legend>Plan crime levels</legend><p class="blom-muted">Change selections, then tap Fresh shared scan to apply them. Scans are manual.</p><div style="display:flex;flex-wrap:wrap;gap:10px 16px;">
        ${Array.from({length:10},(_,i)=>i+1).map(level=>`<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-planner-level="${level}" ${(saved.pendingScan?plannerSelectedLevels(saved):prefs.levels).includes(level)?'checked':''} ${plannerBusy?'disabled':''}>Level ${level}</label>`).join('')}
      </div></fieldset>
    <div id="blom-planner-results"></div>`;
    body.querySelector('#blom-planner-refresh').onclick=refreshPlanner;
    const budgetButton=body.querySelector('#blom-spawn-budget');if(budgetButton && typeof configurePlannerSpawnBudget==='function')budgetButton.onclick=configurePlannerSpawnBudget;
    for (const control of body.querySelectorAll('[data-planner-level]')) control.onchange = () => {
      const levels = [...body.querySelectorAll('[data-planner-level]')].filter(input=>input.checked).map(input=>Number(input.dataset.plannerLevel));
      blStorageSet(PLANNER_PREFS, JSON.stringify({...readJSON(PLANNER_PREFS,{}),levels,pendingScan:true}));
      renderPlanner(body);
    };
    const results = body.querySelector('#blom-planner-results');
    if (!verified) {results.innerHTML=`<div class="blom-empty-card"><strong>${saved.pendingScan?'Settings changed — scan to apply':'Ready to scan'}</strong><span>Tap <b>Fresh shared scan</b> to refresh the shared faction snapshot.</span><small>Both Recruiting and Planning lists are requested in full through your Torn login. Shared Manager access and a recent verified roster are required. Snapshots expire after five minutes.</small></div>`;return;}
    const plan = plannerPlan(plannerState,prefs);
    const rescuePanel=typeof plannerRescueTransfers==='function'?renderPlannerRescueTransfers(plannerRescueTransfers(plannerState,plan,prefs)):'';
    const unassessed=(plannerState.crimes || []).filter(c=>c.status==='recruiting' && plannerManagedLevel(c.difficulty,prefs) && c.slots.some(s=>s.user===null) && !plannerDefinition(c.name,plan.defs));
    const unassessedNotice=unassessed.length?`<div class="blom-alert blom-alert-bad"><strong>${unassessed.length} existing OCs were not assessed.</strong> Role definitions are unavailable for: ${unassessed.map(c=>escapeHtml(c.name)+' #'+escapeHtml(c.id)).join(', ')}. Zero assignments does not establish that these OCs have no suitable members. Check their roles and CPR on Torn; no weights have been guessed.</div>`:'';
    const stallRows=plannerState.shared?plannerState.crimes.filter(c=>c.status==='recruiting' && c.isExpiring===false && c.slots.some(s=>s.user===null)).map(c=>{
      const completedGap=typeof plannerPausedStaffingGap==='function' && plannerPausedStaffingGap(c,plannerState.scannedAt);
      const progress=plannerProgressCoverage(c,plannerState.scannedAt);
      const deadline=completedGap?plannerState.scannedAt:progress?.deadline ?? Number(c.expired_at)*1000,empty=c.slots.filter(s=>s.user===null).length;
      const fits=[...plan.now.values(),...plan.next.values()].filter(f=>String(f.crimeId)===String(c.id));
      const unstarted=c.planningPhase==='recruiting' && c.isExpiring===false && c.slots.every(s=>s.user===null);
      return {crime:c,deadline,empty,progress,completedGap,unstarted,covered:fits.length,conditionalUntil:deadline && fits.length?Math.max(plannerState.scannedAt,deadline)+fits.length*24*3600000:null};
    }).sort((a,b)=>(a.deadline||Infinity)-(b.deadline||Infinity) || a.empty-b.empty || (String(a.crime.id)>String(b.crime.id)?1:-1)):[];
    const stallPanel=stallRows.length?`<details class="blom-section" data-bl-disclosure-key="planning-coverage"><summary><span>Planning coverage / next join</span><span class="blom-mini-badge">${stallRows.length} OCs with vacancies</span></summary><div class="blom-section-body">${stallRows.map(r=>`<div class="blom-placement-note"><strong>${escapeHtml(r.crime.name)} #${escapeHtml(r.crime.id)}</strong> · ${r.crime.slots.length-r.empty} actually joined · ${r.empty} vacancies · ${r.progress?`Member progress: ${r.progress.completed} completed · ${r.progress.current===null?'no active stage':r.progress.current+'% current stage'} · ${r.progress.queued} queued`:r.completedGap?'All joined stages complete · next role empty':'Countdown fallback · member progress unavailable or inconsistent'} · ${r.unstarted?'Not started — first join starts planning':r.deadline?r.deadline<=plannerState.scannedAt?'Currently stalled — a join is needed':'Next uncovered stage in '+escapeHtml(plannerTime(r.deadline)):'Actual remaining coverage unknown'} · ${r.covered}/${r.empty} vacancies have planned joins${r.conditionalUntil?' · If all planned joins happen in time, next uncovered stage in '+escapeHtml(plannerTime(r.conditionalUntil)):''}${r.covered<r.empty?' · Later-stage candidates are conditional until actual joins':''}</div>`).join('')}</div></details>`:'';
    function person(member) {return `<a class="blom-member-link" target="_blank" rel="noopener noreferrer" href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(member.id)}"><span class="blom-member-name">${escapeHtml(member.name)}</span> <span class="blom-member-id">[${escapeHtml(member.id)}]</span></a>`;}
    function suggestion(fit, member) {
      if (!fit) {
        const reserved=plan.coverageReservations?.get(String(member.id));
        if(reserved)return `<div class="blom-placement-title">Reserved conditionally for a later stage</div><div class="blom-placement-meta">${escapeHtml(reserved.crime)} #${escapeHtml(reserved.crimeId)} · ${escapeHtml(prettyRole(reserved.role))}</div><div class="blom-placement-note">Join by ${escapeHtml(plannerTime(reserved.joinByAt))}, conditional on earlier joins. Wait for a fresh scan before inviting; this member is excluded from new spawn crews.</div>`;
        const protectedRoles=plan.protectedHigh?.get(String(member.id));
        if(protectedRoles?.length) {
          const best=protectedRoles[0];
          return `<div class="blom-placement-title">Preserve for Level 7+ OCs</div><div class="blom-placement-meta">L${best.level} · ${escapeHtml(best.crime)} · ${escapeHtml(prettyRole(best.role))} · ${formatCpr(best.cpr)} CPR / target ${best.target}%</div><div class="blom-placement-note">Not allocated to a lower OC: this member is reserved for a viable higher-level spawn crew. Available for that crew or management review. Review the crew plan before assigning elsewhere.</div>`;
        }
        const capability = plannerCapability(member.id,plan.defs,prefs), best = capability.best;
        if (!best) return `<div class="blom-placement-title">${capability.recorded?'No recorded role meets its CPR target yet':'Highest qualifying level unknown'}</div><div class="blom-placement-note">${capability.recorded?'Recorded CPR is below the target for each known role.':capability.excludedStale?'Only stale CPR is available; enable stale data to assess it.':'Not enough recorded CPR to assess this member.'}</div>`;
        const deferredKeys=new Set((plan.deferred || []).map(s=>s.key));
        const matching=(plan.active.open || []).filter(s=>plannerFit(String(member.id),s,prefs));
        const deferredFits=matching.filter(s=>deferredKeys.has(s.key));
        const allocationNote=plan.mailedHeld?.has(String(member.id))?'An existing sent invitation reserves this member. Review that invitation before assigning elsewhere.':deferredFits.length && deferredFits.length===matching.length?'Qualifying existing roles are deferred: '+[...new Set(deferredFits.map(s=>s.crime+' — '+prettyRole(s.role)))].join('; ')+'. Keep these later conveyor slots open for future finishers; next joins are covered conditionally or are not due yet.':matching.length?'Qualifying role evidence exists; check the work order and role owners below for remaining allocation blockers.':'No recorded exact-role CPR qualifies for a currently needed, assessed vacancy. The highest known level shown above refers to other recorded roles.';
        return `<div class="blom-placement-title">Highest known qualifying level: L${best.level}</div>
          <div class="blom-placement-meta">${escapeHtml(best.crime)} · ${escapeHtml(prettyRole(best.role))}</div>
          <div class="blom-placement-meta"><strong>${formatCpr(best.cpr)} CPR</strong> · target ${best.target}% · ${best.kind} · confidence ${best.confidence}</div>
          <div class="blom-placement-note">${escapeHtml(allocationNote)}${best.stale?' · STALE':''}</div>${plannerSimilarRoleNote(String(member.id),plan,prefs)}`;
      }
      return `<div class="blom-placement-title">L${fit.level} · ${escapeHtml(fit.crime)} · ${escapeHtml(prettyRole(fit.role))}</div>
        <div class="blom-placement-meta">Existing OC #${escapeHtml(fit.crimeId)} · slot ${Number(fit.key.split(':')[1])+1}</div>
        <div class="blom-placement-meta"><strong>${formatCpr(fit.cpr)} CPR</strong> · target ${fit.target}% · ${fit.kind} · ${escapeHtml(fit.source || 'Local')} · confidence ${fit.confidence}</div>
        <div class="blom-placement-note">${fit.seen ? `Last observed ${new Date(fit.seen).toLocaleDateString('en-GB', {timeZone:'Europe/London'})}` : 'Observation date unknown'}${fit.stale?' · STALE':''}
        ${fit.kind==='Estimated'?(fit.trialPlacement?' · PROVISIONAL ROLE TRIAL: destination CPR unverified; check and collect actual CPR after joining':fit.estimatedFrom?' · PROVISIONAL: destination CPR unverified; check after joining':' · Based on an unnumbered version of this role'):''}
        ${plannerState.source?' · Check member status and slot availability on Torn':''}
        ${fit.expiresKnown===false?' · Slot expiry unknown; available-now suggestion only':''}</div>
        ${fit.startable?`<div class="blom-placement-note">Start this unstarted OC when available. Follow-on stages depend on that first join; later staffing remains conditional.</div>`:''}
        ${!fit.startable && fit.conditionalPlanning && Number.isFinite(fit.joinByAt)?`<div class="blom-placement-note">Next conveyor join; future-assignment members must finish their current OC first. Latest planned join: ${escapeHtml(new Date(fit.joinByAt).toLocaleString('en-GB',{timeZone:'Europe/London',hour12:false}))}. Depends on earlier planned joins happening; rescan after each join.</div>`:''}
        ${Number.isFinite(fit.queueWaitHours)?`<div class="blom-placement-note">Expected queue wait after becoming available: ${fit.queueWaitHours.toFixed(1)} hours. Stage timing is conditional on earlier joins.</div>`:''}
        ${fit.l8Shortfall?`<div class="blom-placement-note">L8 near-target allowance: ${formatCpr(fit.cpr)}% CPR / ${fit.target}% target · ${fit.l8Shortfall} point(s) below, within the 3-point allowance.</div>`:''}
        ${fit.rebalancedExisting?`<div class="blom-placement-note">Unsent recommendations rebalanced to give a qualifying free member work. Sent invitations and actual occupants are preserved.</div>`:''}
        ${fit.idleExistingFallback?`<div class="blom-placement-note">Last-resort existing OC placement: no supported spendable new start is reserved for this member. Join this qualifying role now; the queue may exceed 48 hours. Estimated stage wait: ${Number.isFinite(fit.queueWaitHours)?fit.queueWaitHours.toFixed(1)+' hours':'unknown'}. Timing depends on earlier joins; rescan after joining.</div>`:''}
        ${fit.l8PlacementPriority?`<div class="blom-placement-note">Priority L8 placement: qualifying members are reserved before lower-level work and new starts. Estimated planning queue wait: ${Number.isFinite(fit.queueWaitHours)?fit.queueWaitHours.toFixed(1)+' hours':'check the OC timer'}.</div>`:''}
        ${fit.idleL8Fallback?`<div class="blom-placement-note">Last-resort L8 placement: no supported spendable new start was reserved for this member. Estimated planning queue wait: ${Number.isFinite(fit.queueWaitHours)?fit.queueWaitHours.toFixed(1)+' hours':'unknown; check the OC timer'}. This intentionally uses a later L8 role instead of leaving the member idle.</div>`:''}
        ${fit.itemId?`<div class="blom-placement-note blom-item-warning">Check required item #${escapeHtml(fit.itemId)}</div>`:''}`;
    }
    const mailRoster=blRoster();
    const rawMailHistory=mailRoster?readJSON('black-ledger-oc-pm-shared-v1:'+mailRoster.viewerId+':'+mailRoster.factionId,null):null;
    const mailHistory=rawMailHistory?.viewerId===mailRoster?.viewerId && rawMailHistory?.factionId===mailRoster?.factionId?rawMailHistory:null;
    const mailDecisions=mailRoster?readJSON(plannerInvitationDecisionsKey(mailRoster),{}):{};
    function mailStatus(fit,member){
      const status=plannerPlacementMailStatus(String(member.id),fit,mailHistory,mailDecisions);
      return `<div class="blom-mail-status blom-mail-${status.kind}"><strong>${escapeHtml(status.text)}</strong>${status.sentAt?`<span>Last recorded send: ${escapeHtml(new Date(status.sentAt).toLocaleString('en-GB',{timeZone:'Europe/London',hour12:false}))}${status.pending?' · sync pending':''}</span>`:''}</div>`;
    }
    function rows(members, fits, future) {return members.map(member=>{
      const id=String(member.id); const info=plan.active.soon.get(id);
      const held=!future && member.status?.state && member.status.state!=='Okay';
      const fit=held?null:fits.get(id);
      const levelRange=plannerLevelFloor(id,prefs);
      return `<tr><td class="blom-member-cell">${person(member)}</td>
        ${future?`<td><div class="blom-current-oc">${escapeHtml(info.crime)}</div><div class="blom-placement-note">Expected in ${escapeHtml(plannerTime(info.readyAt))}</div></td>`:''}
        <td>${held?'<div class="blom-hold">Hold: member is currently unavailable.</div>':suggestion(fit,member)}${levelRange.highest>2?`<div class="blom-placement-note">Level protection: recorded capability L${levelRange.highest}; new recommendations stay at L${levelRange.minimum} or above. Urgency does not bypass this minimum. Existing sent invitations are honoured.</div>`:''}${mailStatus(fit,member)}</td></tr>`;
    }).join('');}
    const spawnAnalyses=new Map();
    function spawnAnalysis(members) {
      const key=members.map(m=>String(m.id)).sort().join(',');
      if(!spawnAnalyses.has(key)){
        const high=plannerSpawnRecommendation(members,plan.defs,{...prefs,levels:prefs.levels.filter(l=>l>=7)});
        const lower=plannerSpawnRecommendation(members.filter(m=>!plan.protectedHigh?.has(String(m.id))),plan.defs,{...prefs,levels:prefs.levels.filter(l=>l<7)});
        spawnAnalyses.set(key,{best:high.best||lower.best,levels:[...high.levels,...lower.levels]});
      }
      return spawnAnalyses.get(key);
    }
    function spawnAssessment(members,title,forecast=false) {
      const recommendation=spawnAnalysis(members),next=recommendation.best;
      const selected=plannerSelectedLevels(prefs);
      const badge=next?`<span class="blom-mini-badge blom-${next.className==='strong'?'good':'warn'}">${plannerSpawnLabel(next)} ${next.className==='strong'?(plannerState.shared?'STAFFABLE':'READY'):!next.allReliable?'VERIFY CPR':'LIMITED BACKUP'}</span>`:'<span class="blom-mini-badge">Hold · no complete level</span>';
      const decision=plannerState.shared?plannerSpawnDecision(next,plannerState,plan,prefs,forecast):{allowed:true};
      const headline=next?`<div class="blom-spawn-hero"><div><strong>${plannerState.shared?(decision.allowed?'Consider spawning one':'Review staffable'):'Spawn one'} ${plannerSpawnLabel(next)} OC</strong><span>Every defined crime in this bracket has a qualifying unique crew</span></div><div class="blom-spawn-score">${next.full}/${next.outcomes.length}<small>crime types staffable</small></div></div>`+
        `<div class="blom-spawn-example">${members.length} unassigned members checked · ${next.robust}/${next.outcomes.length} crime types can tolerate one member becoming unavailable.</div>`+
        `${next.allReliable?'':`<div class="blom-spawn-warning">Some crews depend on estimated, undated, stale or recorded-high CPR. Verify those readings before spawning.</div>`}`+
        `<details class="blom-inline-details"><summary>Example crew — ${escapeHtml(next.best.crime)}</summary>${[...next.best.assigned].map(([id,fit])=>{const member=members.find(m=>String(m.id)===id);return `<div class="blom-placement-meta">${escapeHtml(prettyRole(fit.role))} · ${escapeHtml(member?.name || id)} · ${formatCpr(fit.cpr)} CPR / target ${fit.target}% · ${escapeHtml(fit.confidence || fit.kind)}</div>`;}).join('')}</details>`:'';
      const comparisons=[...recommendation.levels].sort((a,b)=>a.level-b.level).map(level=>`<tr><td>${plannerSpawnLabel(level)}</td><td>${level.qualifiedMembers}</td><td>${level.full}/${level.outcomes.length}</td><td>${level.robust}/${level.outcomes.length}</td><td>${level.historyWeak?'Hold — weak history':level.allComplete?(level.allReliable?'Staffable':'Verify CPR'):level.full?'Risk — some crimes cannot be filled':'No complete crew'}${plannerState.shared?`<details><summary>Shared outcome evidence</summary>${level.outcomes.map(o=>`<div>${escapeHtml(o.crime)}: ${escapeHtml(plannerHistoryAssessment(o.crime,prefs.learning || []).text)}</div>`).join('')}</details>`:''}${level.gaps.length?`<details><summary>Staffing gaps</summary>${level.gaps.map(o=>`<div>${escapeHtml(o.crime)}: ${o.filled}/${o.total} roles filled${o.missing.length?` · unmatched: ${o.missing.map(prettyRole).map(escapeHtml).join(', ')}`:''}</div>`).join('')}</details>`:''}</td></tr>`).join('');
      const poolNote=`<div class="blom-spawn-example">${plan.available.length} members currently unassigned · ${plan.now.size} recommended for existing OC vacancies · ${unusedNow.length} left for a new OC now.${forecast?` This forecast checks ${members.length} members after reserving existing OC placements.`:''} Recommendations reserve people in this planner; they have not signed up until they join on Torn.</div>`;
      const body=!selected.length?'<div class="blom-empty-state">Select at least one crime level above.</div>':!members.length?'<div class="blom-empty-state">No unassigned available members in this group.</div>':
        (headline || (plannerState.shared?'<div class="blom-empty-state">Hold spawning — no selected bracket clears both staffing and shared outcome review. Check the evidence and gaps below.</div>':'<div class="blom-empty-state">Hold spawning — the remaining members do not have a qualifying unique crew for every possible crime at any selected bracket. Review existing OC placements and the staffing gaps below. Missing or excluded stale CPR can also prevent a crew from qualifying.</div>'))+
        `<div style="overflow-x:auto"><table class="blom-planner-table"><thead><tr><th>Spawn bracket</th><th>Qualifying people</th><th>Crime types staffable</th><th>With backup</th><th>Assessment</th></tr></thead><tbody>${comparisons}</tbody></table></div>`+
        `<div class="blom-placement-note">If you choose to spawn, spawn one and scan again: Torn chooses the actual crime. These counts describe staffing, not success probability. Sent invitations and existing high-level placements are reserved first; existing deadlines take priority over prospective spawn crews.${forecast?' This is a future forecast; wait until those members are actually free.':''} Only selected brackets are assessed. Missing CPR is treated as unknown.</div>`;
      return `<details class="blom-section blom-spawn-section"><summary><span>${escapeHtml(title)}</span>${badge}</summary><div class="blom-section-body">${poolNote}${plannerState.shared?`<div class="blom-spawn-warning">${escapeHtml(decision.reason)}</div>`:''}${body}</div></details>`;
    }
    const {unusedNow,unusedSoon,needed,preparation,spawnOpportunity,releaseStart}=plannerSpareSpawnAssessment(plan,plannerState,prefs);
    const workOrders=plannerMemberWorkOrders(plan,{needed,releaseStart},prefs);
    const newStartCandidates=workOrders.filter(row=>row.kind==='new-start').length;
    const managerActions=workOrders.filter(row=>row.kind==='manager-action').length;
    function spareMemberOptions(member) {
      const options=[];
      const existing=[];
      for(const slot of plan.active.open || []){
        const fit=plannerFit(String(member.id),slot,prefs);
        if(!fit)continue;
        const completion=plan.active.completion?.find(row=>row.crimeId===String(slot.crimeId));
        const assigned=[...plan.now.values(),...plan.next.values()].some(row=>row.key===slot.key);
        const reason=assigned?'Already allocated to another member':slot.openingUnsupported?(slot.openingHoldReason || 'Hold starting this OC — no distinct qualifying follow-on candidate within 24h'):completion && !completion.complete?'Later staffing unresolved — '+completion.issues.join('; ')+'. Suitable roles remain eligible; review current allocations and stage coverage.':'Review reservations and stage coverage before assigning';
        existing.push(`<div class="blom-placement-meta">Existing OC: L${fit.level} · ${escapeHtml(fit.crime)} #${escapeHtml(fit.crimeId)} · ${escapeHtml(prettyRole(fit.role))} · ${fit.kind==='Estimated'?'Provisional ~':''}${formatCpr(fit.cpr)} CPR / ${fit.target}% target</div><div class="blom-placement-note">${escapeHtml(reason)}</div>`);
      }
      for(const bracket of preparation.levels)for(const outcome of bracket.outcomes){
        if(!outcome.daily.complete || outcome.plannedUncertain!==0)continue;
        const placement=outcome.daily.schedule.find(row=>String(row.id)===String(member.id));
        if(!placement)continue;
        options.push(`<div class="blom-placement-meta">Possible new OC: L${outcome.level} · ${escapeHtml(outcome.crime)} · ${escapeHtml(prettyRole(placement.fit.role))} · ${formatCpr(placement.fit.cpr)} CPR / ${placement.fit.target}% target</div>`);
      }
      return existing.join('')+`<div class="blom-placement-note">${options.length?'Possible starter / next-join roles for a new OC; later roles remain unresolved. Review the spawn assessment for Scope, capacity and unsupported outcomes before spawning. Torn chooses the crime; scan the actual outcome before assigning.':'No supported starter / next-join role found in the selected spawn brackets. Review exact-role CPR, selected levels and the spawn assessment blockers.'}</div>${options.join('')}`;
    }
    function preparationSection() {
      const levels=[...preparation.levels].sort((a,b)=>a.level-b.level);
      const quantities=new Map(needed.groups.map(g=>[g.level,g]));
      const rows=levels.map(l=>{
        const quantity=quantities.get(l.level),plans=needed.crews.filter(c=>c.level===l.level);
        const assessment=needed.highEndHold && l.level>=7?'Hold — one L8 at a time':plan.spawningBlocked?'Hold — existing OCs need attention':l.historyWeak?'Hold — weak history':l.seeded===0?'Wait — no qualifying starter now':l.seeded<l.outcomes.length?`Hold spawning — starters cover only ${l.seeded}/${l.outcomes.length} outcomes`:l.dailyCovered===l.outcomes.length?(l.outcomes.some(o=>o.plannedUncertain)?'Starter + next join supported · verify CPR':'Starter + next join supported'):'Hold spawning — starter + next join not covered for every outcome';
        const outcomeDetails=outcomes=>outcomes.map(o=>`<div style="padding:8px 0;border-top:1px solid #344650"><strong>${escapeHtml(o.crime)}</strong> · ${o.filled}/${o.total} roles now · ${o.daily.complete?'Crew of '+o.daily.required+' stage'+(o.daily.required===1?'':'s')+' supported':`Next unfilled deadline: +${o.daily.nextDeadline}h`} · ${o.daily.remainingRoles} later roles unresolved${o.missing.length?` · gaps now: ${o.missing.map(prettyRole).map(escapeHtml).join(', ')}`:''}${[...o.plannedCrew].map(([id,fit])=>{const member=[...unusedNow,...unusedSoon].find(m=>String(m.id)===id),soon=plan.active.soon.get(id);return `<div class="blom-placement-meta">${escapeHtml(prettyRole(fit.role))} · ${escapeHtml(member?.name || id)} · ${unusedNow.some(m=>String(m.id)===id)?'Available now':soon?'Expected free in '+escapeHtml(plannerTime(soon.readyAt)):'Future availability unknown'} · join by +${o.daily.schedule.find(row=>row.id===String(id))?.joinByHours ?? '?'}h · ${formatCpr(fit.cpr)} CPR / target ${fit.target}%</div>`;}).join('')}${l.level>=7?`<div class="blom-placement-note">${o.plannedRobust?'Backup crew available':'No confirmed backup crew'}</div>`:''}${o.plannedUncertain?'<div class="blom-spawn-warning">Verify CPR: estimated, stale or undated readings.</div>':''}</div>`).join('');
        return `<tr><td><strong>${plannerSpawnLabel(l)}</strong></td><td><strong>${quantity?'× '+quantity.count:'—'}</strong>${quantity?.partial?`<div class="blom-placement-note">${quantity.partial} conditional</div>`:''}${plans.length?`<details data-bl-disclosure-key="spawn-${l.level}-starters"><summary>Planned starters</summary>${plans.map(c=>{const m=unusedNow.find(m=>String(m.id)===c.starter.id);return `<div>${escapeHtml(m?.name || c.starter.id)} · ${escapeHtml(c.starter.crime)} · ${escapeHtml(prettyRole(c.starter.role))} · ${formatCpr(c.starter.cpr)} CPR</div>`;}).join('')}</details>`:''}</td><td>${plannerScopeCost(l)}</td><td>${l.seeded}/${l.outcomes.length}</td><td>${l.dailyCovered}/${l.outcomes.length}</td><td>${assessment}<details data-bl-disclosure-key="spawn-${l.level}-arrivals"><summary>Starter crews and expected arrivals</summary>${outcomeDetails(l.outcomes)}</details>${plans.length>1?`<details data-bl-disclosure-key="spawn-${l.level}-additional"><summary>Additional planned OCs (${plans.length-1})</summary>${plans.slice(1).map((c,i)=>`<strong>OC ${i+2}${c.partial?' · conditional':''}</strong>${outcomeDetails(c.outcomes)}`).join('')}</details>`:''}</td></tr>`;
      }).join('');
      return `<section class="blom-section blom-spawn-section"><div class="blom-section-body blom-spawn-summary">${plannerSpawnSummaryCard(needed,plannerState,plan,prefs,releaseStart)}</div><details class="blom-inline-details"><summary>Staffing details</summary><details class="blom-section" open><summary><span>Prepare new OCs</span><span class="blom-mini-badge ${needed.crews.some(c=>c.partial)?'blom-warn':''}">${needed.crews.length?needed.crews.length+' estimated · '+(needed.crews.some(c=>c.partial)?'review gaps':'review Scope'):releaseStart?'Conditional crew-release plan':spawnOpportunity?'Best-fit option · review risk':'No supported start'}</span></summary><div class="blom-section-body">
        ${needed.highEndHold?'<p class="blom-placement-note">L7–8 spawning held: an L8 already exists. Support that OC first; one L8 at a time.</p>':''}
        <details class="blom-inline-details" data-bl-disclosure-key="spawn-reservations"><summary>Existing reservations</summary><div class="blom-placement-note">${plan.available.filter(m=>plan.coverageReservations?.has(String(m.id))).length} free members and ${[...(plan.coverageReservations?.keys() || [])].filter(id=>!plan.available.some(m=>String(m.id)===id)).length} future arrivals reserved for later stages in existing OCs. These reservations are excluded from new crews.</div>${[...(plan.coverageReservations || new Map())].map(([id,fit])=>`<div class="blom-placement-note">${escapeHtml(plan.upcoming.find(m=>String(m.id)===id)?.name || id)} · L${fit.level} ${escapeHtml(fit.crime)} #${escapeHtml(fit.crimeId)} · ${escapeHtml(prettyRole(fit.role))} · conditional join by ${escapeHtml(plannerTime(fit.joinByAt))}</div>`).join('')}</details>
        ${plan.spawningBlocked?'<div class="blom-alert blom-alert-bad"><strong>Hold new spawns — unresolved checks.</strong> '+(plan.unassessedExisting.length?plan.unassessedExisting.length+' OCs need their levels or definitions checked. ':'')+'Resolve checks that cannot be isolated to held members, then rescan.</div>':plan.assignmentConflicts?.length?'<p class="blom-placement-note">'+plan.assignmentConflicts.length+' invitation issues need review. Affected members remain held out; these new-start plans use only independent spare candidates.</p>':''}
        ${typeof plannerReleaseStartCard==='function'?plannerReleaseStartCard(releaseStart):''}
        ${spawnOpportunity?`<div class="blom-alert blom-spawn-advice"><strong>${spawnOpportunity.decision.allowed?'Best fit to consider: one '+plannerSpawnLabel(spawnOpportunity)+' OC':'Partial coverage now: '+plannerSpawnLabel(spawnOpportunity)+' — hold spawning'}</strong><p>${spawnOpportunity.supported.length}/${spawnOpportunity.outcomes.length} possible crimes have a starter and next join. ${spawnOpportunity.ids.length} of ${unusedNow.length} spare members have initial roles across those alternatives: ${unusedNow.filter(m=>spawnOpportunity.ids.includes(String(m.id))).map(m=>escapeHtml(m.name || m.id)).join(', ')}.</p><p class="blom-spawn-warning"><strong>Risk:</strong> no verified starter / next-join pair for ${spawnOpportunity.unsupported.map(escapeHtml).join(', ')}. These counts are coverage, not odds.</p><p>${spawnOpportunity.decision.allowed?'Manual choice: spawn one, then Fresh shared scan to assign the actual roles. Stop and review if the outcome is unsupported.':escapeHtml(spawnOpportunity.decision.reason)}</p><details class="blom-inline-details" data-bl-disclosure-key="spawn-best-fit-roles"><summary>Candidate positions by possible crime</summary>${spawnOpportunity.supported.map(o=>`<p><strong>${escapeHtml(o.crime)}</strong>: ${o.daily.schedule.map(row=>{const member=[...unusedNow,...unusedSoon].find(m=>String(m.id)===String(row.id));return `${escapeHtml(member?.name || row.id)} → ${escapeHtml(prettyRole(row.fit.role))} (${formatCpr(row.fit.cpr)} CPR / ${row.fit.target}% target${unusedNow.some(m=>String(m.id)===String(row.id))?' · now':' · conditional arrival'})`;}).join('; ')}</p>`).join('')}</details></div>`:!needed.crews.length && !releaseStart?'<p class="blom-spawn-warning">No supported spawn recommendation. Open the bracket comparison for blockers.</p>':''}
        ${typeof plannerSpawnQuantityDecision==='function' && needed.crews.length?`<div class="blom-alert blom-spawn-advice">${escapeHtml(plannerSpawnQuantityDecision(needed,plannerState,plan,prefs).reason)}</div>`:''}
        <p><strong>${plan.now.size} assigned to existing OCs · ${unusedNow.length} spare now.</strong> After spawning, scan to assign the actual roles.</p>
        ${unusedNow.length?`<details class="blom-inline-details" data-bl-disclosure-key="spawn-spare-capabilities"><summary>Spare members and recorded levels (${unusedNow.length})</summary>${unusedNow.map(m=>{const capability=plannerLevelFloor(String(m.id),prefs);const options=preparation.levels.filter(l=>l.outcomes.some(o=>o.daily.schedule.some(row=>row.id===String(m.id))));return `<p><strong>${escapeHtml(m.name || m.id)}</strong> · ${capability.highest?'recorded L'+capability.highest:'level unknown'} · ${options.length?'candidate in '+options.map(plannerSpawnLabel).join(', '):'no qualifying initial role — check exact-role CPR'}</p>${plannerSimilarRoleNote(String(m.id),plan,prefs)}`;}).join('')}</details>`:''}
        <details class="blom-inline-details" data-bl-disclosure-key="spawn-compare"><summary>Compare all spawn brackets</summary><div class="blom-planner-scroll"><table class="blom-planner-table"><thead><tr><th>Spawn bracket</th><th>OCs needed</th><th>Scope / OC</th><th>Crime types with starters now</th><th>Initial stages supported</th><th>Preparation plan</th></tr></thead><tbody>${rows || '<tr><td colspan="6">Select at least one crime level and scan to assess new starts.</td></tr>'}</tbody></table></div></details>
        ${needed.crews.length?`<p class="blom-placement-note">Current candidate pool for the proposed spawn${needed.crews.length===1?'':'s'}: ${unusedNow.filter(m=>needed.crews.some(c=>c.ids.includes(String(m.id)))).map(m=>escapeHtml(m.name || m.id)).join(', ')}. Exact roles depend on the crime Torn creates.</p>`:''}
        ${needed.remaining.length?`<p class="blom-spawn-unplaced">${needed.remaining.length} members still need a placement: ${needed.remaining.map(m=>escapeHtml(m.name || m.id)).join(', ')}. ${releaseStart?'Conditional release-based plan above; confirm completion and scan before spawning and assigning.':spawnOpportunity?'Best-fit option above; exact assignments follow the actual spawn and scan.':'Check candidate positions and CPR in the details.'}</p>`:''}
        <details class="blom-inline-details" data-bl-disclosure-key="spawn-explanation"><summary>How this assessment works</summary>
        <p class="blom-placement-note">Each row\u2019s coverage assesses the first OC from the same remaining pool; unselected rows are alternatives, not extra spawn requests. Each proposed OC requires a distinct qualifying member for every role in every possible outcome, with a starter now and verified arrivals within 24 hours. Crew coverage remains conditional until members join. Join deadlines still follow consecutive planning stages; candidates do not all need to join before the first gap. Future assignments use arrivals within 24 hours and at most 36 hours of queue waiting after release. Additional soft reservations remain limited to joins within 24 hours; longer waits remain unresolved.</p>

        <p class="blom-muted">Existing sent invitations remain commitments. Cover the next required join, prefer timely finishers as followers, and spread other free members across supported starts. Prefer supported starts and timely finishers; otherwise-idle members may join qualifying existing queues with their wait shown. Quantities account for a starter and one distinct next join per OC; later roles remain unresolved and future arrivals are conditional. Forecasts are conditional and not permission to spend Scope. Partial starter coverage is evidence only and adds zero to OCs needed. Torn may choose a crime these starters cannot join; do not keep spawning to obtain a particular crime. Spawn one, check its actual roles and rescan before the next. Future completion times may change.</p>
        </details>
      </div></details></details></section>`;
    }
    const exactGroups=plannerAssignmentGroups(plan.now,plan.available);
    const futureGroups=plannerAssignmentGroups(plan.next,plan.upcoming);
    const allAssignmentGroups=[...exactGroups,...futureGroups];
    const messageFuture = saved.messageScope === 'future';
    const messageGroups = messageFuture ? futureGroups : exactGroups;
    const assignedNowIds=new Set(exactGroups.flatMap(group=>group.rows.map(row=>String(row.member.id))));
    const assignedFutureIds=new Set(futureGroups.flatMap(group=>group.rows.map(row=>String(row.member.id))));
    const assignedAllIds=new Set(messageGroups.flatMap(group=>group.rows.map(row=>String(row.member.id))));
    const availableIds=new Set(plan.available.map(member=>String(member.id)));
    const nativeExtra=[...availableIds].filter(id=>!assignedNowIds.has(id)).length;
    const nativeGroupExact=!messageFuture && nativeExtra===0 && assignedNowIds.size===availableIds.size;
    const recipientNames=messageGroups.flatMap(group=>group.rows).map(row=>`${row.member.name} [${row.member.id}]`);
    function assignmentCards(groups, future = false) {
      if (!groups.length) return `<p>${future?'No future placements qualify for the scanned vacancies.':'No current placements allocated, so there are no assignment messages to prepare. Unassigned members may fit later stages or different crimes; check their reasons below and any unassessed-OC warning.'}</p>`;
      return [...new Set(groups.map(group=>group.level))].sort((a,b)=>b-a).map(level=>
        `<h3>Level ${level}</h3><div class="blom-assignment-grid">` + groups.filter(group=>group.level===level).map(group=>
          `<div class="blom-assignment-card"><div class="blom-assignment-title"><span class="blom-level-badge">L${group.level}</span><span>${escapeHtml(group.crime)}</span><span class="blom-crime-id">#${escapeHtml(group.crimeId)}</span></div><div class="blom-assignment-rows">${group.rows.sort((a,b)=>String(a.fit.role).localeCompare(String(b.fit.role))).map(row=>
            `<div class="blom-assignment-row"><span class="blom-role-label">${escapeHtml(prettyRole(row.fit.role))}</span><span class="blom-assignee">${person(row.member)}${future?`<small class="blom-placement-note">Expected free in ${escapeHtml(plannerTime(plan.active.soon.get(String(row.member.id)).readyAt))}</small>`:''}</span><span class="blom-cpr-pill">${row.fit.trialPlacement?'Provisional trial ~':row.fit.kind==='Estimated'?'Provisional ~':''}${formatCpr(row.fit.cpr)} CPR</span>${row.fit.estimatedFrom?`<small class="blom-placement-note">${escapeHtml(row.fit.source)}</small>`:''}${row.fit.l8Shortfall?`<small class="blom-placement-note">L8 near target: ${row.fit.l8Shortfall} point(s) below ${row.fit.target}% target · accepted within 3 points</small>`:''}${row.fit.l8PlacementPriority?`<small class="blom-placement-note">Priority L8 · estimated queue wait ${Number.isFinite(row.fit.queueWaitHours)?row.fit.queueWaitHours.toFixed(1)+'h':'unknown'}</small>`:''}${row.fit.idleL8Fallback?`<small class="blom-placement-note">Last-resort L8 · estimated queue wait ${Number.isFinite(row.fit.queueWaitHours)?row.fit.queueWaitHours.toFixed(1)+'h':'unknown'}</small>`:''}</div>`).join('')}</div></div>`).join('')+'</div>').join('');
    }
    const availableCount=plannerState.diagnostics && plannerState.diagnostics.expectedUnassigned!==0 && plannerState.diagnostics.foundUnassigned===0?'?':plan.available.length;
    const topSpawn=needed.crews.length?needed.assessment?.levels.find(l=>l.level===needed.crews[0].level) || null:null;
    const spawnReview=refreshPlannerSpawnReview(plannerState,prefs);
    results.innerHTML=`
      <div class="blom-spawn-review"><strong>1. Review spawning before mailing</strong><p>${spawnReview.approved?'Spawn review complete for this plan. Review the final assignments below.':'Message preparation is locked until you settle the spawn decision. Review crew coverage, Scope and conflicts below. If you spawn, spawn one OC and run a fresh shared scan before deciding again.'}</p><p>${topSpawn?`Bracket to review: ${escapeHtml(plannerSpawnLabel(topSpawn))}. Staffing coverage is not permission to spend; check the Scope and conflict guidance.`:'No new OCs to spawn now. Check Staffing details for the reasons.'}</p><button type="button" id="blom-review-spawning">Show spawn assessment</button> <button type="button" id="blom-confirm-spawn-review">${spawnReview.approved?'Review messages →':'No more spawning for this plan → review messages'}</button></div>

      <div class="blom-planner-dashboard">
        <div class="blom-stat"><strong>${availableCount}</strong><span>Unassigned now</span></div>
        <div class="blom-stat"><strong>${plan.forecast.within12.length+plan.forecast.within24.length}</strong><span>Free ≤24h</span></div>
        <div class="blom-stat"><strong>${allAssignmentGroups.length}</strong><span>OCs to fill</span></div>
        <div class="blom-stat blom-stat-accent"><strong>${topSpawn?plannerSpawnLabel(topSpawn):'—'}</strong><span>${needed.crews.length?'New OCs supported':'No new spawn needed'}</span></div>
      </div>
      ${renderPlannerReleaseTimeline(plannerState,plan)}
      ${unassessedNotice}${stallPanel}${rescuePanel}
      ${plan.acceptedInvitations?.length?`<div class="blom-alert"><strong>Invitations kept by management</strong>${plan.acceptedInvitations.map(c=>`<p>${escapeHtml(plannerState.members?.find(m=>String(m.id)===c.id)?.name || c.id)} · ${c.destinations.map(d=>`${escapeHtml(d.crime)} #${escapeHtml(d.crimeId)} · ${escapeHtml(d.role)}`).join("; ")} · ${c.cpr}% CPR / ${c.target}% target. Original invitation honoured across your devices; member and role remain reserved. <button type="button" data-invitation-member="${escapeHtml(c.id)}" data-invitation-decision="release">Release invitation and replan</button></p>`).join("")}</div>`:""}
      ${plan.active.completion?.length?`<div class="blom-alert"><strong>Can we complete the current OCs?</strong><p>This report checks complete crew coverage using distinct available members or verified arrivals within 24 hours. L8 accepts the best available CPR within 3 points below target; other levels keep their normal target. Missing later coverage is a warning; suitable existing roles can still receive join recommendations. Joined members stay in their roles; sent invitations remain commitments.</p>${plan.active.completion.map(row=>`<p><strong>${escapeHtml(row.crime)} #${escapeHtml(row.crimeId)} — ${row.complete?'Completion supported':'Later staffing unresolved'}</strong><br>${row.occupied}/${row.total} occupied · ${row.qualified}/${row.occupied} occupied roles meet planning policy · ${row.covered}/${row.total} roles supported.${row.issues.length?'<br>'+row.issues.map(escapeHtml).join('; '):''}</p>`).join('')}</div>`:''}
      ${plan.spawnReservation?.level?`<div class="blom-alert">Preserving ${plan.protectedHigh.size} members across ${plan.spawnReservation.count || 1} supported high-level start(s), including ${escapeHtml(plannerSpawnLabel(plan.spawnReservation.level))}. Each has a starter now and a distinct next join by 24h. Later roles and backup remain to be reassessed; this is not full-crew coverage. Spawn one and rescan.</div>`:''}
      ${plannerState.autoReleasedInvitations?.length?`<p class="blom-placement-note">Automatically released ${plannerState.autoReleasedInvitations.length} outdated invitation reservation(s) after confirmed joins. Sent history is retained; replacement messages still need review and sending.</p>`:''}
      ${plan.assignmentConflicts?.length?`<div class="blom-alert blom-alert-bad"><strong>Assignment / spawn trade-offs</strong>${plan.assignmentConflicts.map(c=>`<p>${c.destinations?.length?`<strong>Sent invitation: ${c.destinations.map(d=>`${escapeHtml(d.crime)} #${escapeHtml(d.crimeId)} · ${escapeHtml(d.role)}`).join('; ')}</strong><br>`:''}${c.slot?`${escapeHtml(c.slot.crime)} #${escapeHtml(c.slot.crimeId)} · ${escapeHtml(prettyRole(c.slot.role))}: `:''}${escapeHtml(c.reason)}${(c.ids || (c.id?[c.id]:[])).length?` Members: ${(c.ids || [c.id]).map(id=>escapeHtml(plannerState.members?.find(m=>String(m.id)===id)?.name || id)).join(', ')}.`:''}${c.action?`<br>Next step: ${escapeHtml(c.action)}<br>This member is held out of new assignments and spawn crews. Independent spare-member starts remain eligible; this invitation still needs review.`:''}${c.id && c.destinations?.length?`<br><button type="button" data-invitation-member="${escapeHtml(c.id)}" data-invitation-decision="release">Release invitation and replan</button>${c.canKeep?` <button type="button" data-invitation-member="${escapeHtml(c.id)}" data-invitation-decision="keep">Keep this invitation</button>`:''}<br><small>Decision syncs across your devices. Sent history is preserved; no message is sent.</small>`:''}</p>`).join('')}</div>`:''}
      ${plannerState.diagnostics?.expectedUnassigned>plan.available.length?'<div class="blom-alert blom-alert-bad">⚠ Scan incomplete — some listed members were not identified.</div>':''}
      <details class="blom-section blom-info-section"><summary><span>Scan details</span><span class="blom-summary-hint">${escapeHtml(plannerState.factionName)} · ${new Date(plannerState.scannedAt).toLocaleTimeString('en-GB', {timeZone:'Europe/London', hour12:false})}</span></summary><div class="blom-section-body">
        <p>${escapeHtml(plannerState.source || 'Optional Torn API')} · ${plan.active.open.length} open slots${plan.deferred?.length?` · ${plan.deferred.length} roles left for later stages`:""} · ${plannerState.shared?'server CPR, shared weights and target policy':'targets from the main script'}.</p>
        ${plannerState.shared?`<p>Shared Scan · ${new Date(plannerState.scannedAt).toLocaleString('en-GB', {timeZone:'Europe/London', hour12:false})} · scan checked ${new Date(plannerState.scanStartedAt).toLocaleTimeString('en-GB', {timeZone:'Europe/London', hour12:false})}–${new Date(plannerState.scannedAt).toLocaleTimeString('en-GB', {timeZone:'Europe/London', hour12:false})}. Both devices use this snapshot. Expires after five minutes; new revisions appear automatically while the OC page is focused.</p>`:''}
        ${plannerState.diagnostics?`<p class="blom-scan-status">${plannerState.diagnostics.foundUnassigned} unassigned read${plannerState.diagnostics.expectedUnassigned!==null?' / '+plannerState.diagnostics.expectedUnassigned+' listed':''} · ${plannerState.diagnostics.scannedRoots} OC cards · ${plannerState.diagnostics.readableTimers} timers.${plannerState.diagnostics.unknownRoles?' '+plannerState.diagnostics.unknownRoles+' OCs need roles expanded.':''}</p>`:''}
        ${plannerState.unassignedCached?`<p>Using cached unassigned list from ${new Date(plannerState.unassignedAt).toLocaleTimeString('en-GB', {timeZone:'Europe/London', hour12:false})} (expires after five minutes).</p>`:''}
        ${plannerState.diagnostics?.assignmentConflicts?'<p>Newer unassigned data overrode older conflicting OC assignments.</p>':''}
        <p class="blom-muted">Suggestions only. Unknown CPR is never invented. Confidence means freshness/exact role matching — not guaranteed success.</p>
      </div></details>

      <details class="blom-section blom-main-section" tabindex="-1" open>
        <summary><span>Optimised assignments</span><span class="blom-mini-badge blom-good">${allAssignmentGroups.length} OC${allAssignmentGroups.length===1?'':'s'}</span></summary>
        <div class="blom-section-body">
          <div class="blom-section-intro">${plan.available.length} free now: ${plan.now.size} assigned roles · ${newStartCandidates} proposed new-start candidates · ${managerActions} manager actions required. ${plan.next.size} future assignments are members still in other OCs. Priority: urgent existing gaps → existing stages within 48 hours → supported starts → qualifying existing queue fallback → single-L8 fallback. Every free member has a work order below. Only actual allocated roles are included in messages; new starts require Scope review, spawning and a fresh scan.</div>
          <label>Prepare messages for <select id="blom-planner-message-scope"><option value="now" ${!messageFuture?'selected':''}>Assigned now (${plan.now.size} recipients)</option><option value="future" ${messageFuture?'selected':''}>Future assignments (${plan.next.size} recipients)</option></select></label>
          ${messageGroups.length?`<div class="blom-newsletter-card"><div class="blom-newsletter-head"><div><strong>Newsletter</strong><span>${assignedAllIds.size} ${messageFuture?'future':'assigned-now'} message recipient${assignedAllIds.size===1?'':'s'}</span></div><span class="blom-mini-badge ${nativeGroupExact?'blom-good':'blom-warn'}">${nativeGroupExact?'Native group matches':'Exact list needed'}</span></div>
          <div class="blom-newsletter-note">${nativeGroupExact?`All ${availableIds.size} scanned available members have assignments. Recheck Torn\u2019s current recipient list before using its Not in an Organized Crime filter.`:`The scanned available-now list (${availableIds.size}) ${nativeExtra?`contains ${nativeExtra} extra member${nativeExtra===1?'':'s'}`:'does not include future-assignment members'}. For an exact send, use the copied recipient list rather than trusting that native filter.`}</div>
          <div class="blom-newsletter-actions"><button id="blom-prepare-newsletter" class="blom-primary" ${spawnReview.approved?'':'disabled'}>${spawnReview.approved?'Prepare newsletter':'Review spawning before preparing messages'}</button><button id="blom-copy-recipients">Copy recipients (${assignedAllIds.size})</button></div></div>`:''}
          <div data-planner-selected-assignments>
            <h3>${messageFuture?'Future placements':'Assign now'}</h3>
            ${messageFuture?'<p class="blom-placement-note">These members are still in an OC. Check the expected availability time before asking them to join.</p>':''}
            ${assignmentCards(messageGroups,messageFuture)}
          </div>
          ${workOrders.length?`<details class="blom-inline-details" data-bl-disclosure-key="assignment-spare-options" open><summary>Work order for every free member (${workOrders.length})</summary><p class="blom-placement-note">Match individual CPR and level first. Cover urgent gaps, then uncovered stages within 48 hours, then supported starts, then qualifying existing queue placements for otherwise idle members. Blocked placements require manager action; they are not completed assignments. New-crime alternatives share the same pool.</p><div class="blom-planner-scroll"><table class="blom-planner-table"><thead><tr><th>Member</th><th>Priority and next action</th></tr></thead><tbody>${workOrders.map(row=>`<tr><td class="blom-member-cell">${person(row.member)}</td><td><div class="blom-placement-title">${row.priority===5?'Action required':'Priority '+row.priority}</div><div class="blom-placement-note">${escapeHtml(row.text)}</div>${row.kind==='assigned'?suggestion(plan.now.get(String(row.member.id)),row.member):suggestion(null,row.member)+spareMemberOptions(row.member)}</td></tr>`).join('')}</tbody></table></div></details>`:''}
        </div>
      </details>

      <details class="blom-section">
        <summary><span>Unassigned now</span><span class="blom-mini-badge">${availableCount}</span></summary>
        <div class="blom-section-body"><div class="blom-planner-scroll"><table class="blom-planner-table"><thead><tr><th>Member</th><th>Best placement</th></tr></thead><tbody>${rows(plan.available,plan.now,false)||(plannerState.diagnostics?.expectedUnassigned!==0?'<tr><td colspan="2">Unassigned list not recognised. Scroll to it, then rescan.</td></tr>':'<tr><td colspan="2">Nobody is currently unassigned.</td></tr>')}</tbody></table></div></div>
      </details>

      <details class="blom-section">
        <summary><span>Finishing between now and 24 hours</span><span class="blom-mini-badge">${plan.forecast.within12.length+plan.forecast.within24.length}</span></summary>
        <div class="blom-section-body">
          <div class="blom-forecast-chips"><span>≤12h <b>${plan.forecast.within12.length}</b></span><span>12–24h <b>${plan.forecast.within24.length}</b></span></div>
          <div class="blom-planner-scroll"><table class="blom-planner-table"><thead><tr><th>Member</th><th>Free in</th><th>Best placement</th></tr></thead><tbody>${rows([...plan.forecast.within12,...plan.forecast.within24],plan.next,true)||'<tr><td colspan="3">No recognised OC completions due within 24 hours.</td></tr>'}</tbody></table></div>

          <div class="blom-muted">Slots shown here are forecasts and may be filled before the member becomes free.</div>
        </div>
      </details>

      <div class="blom-spawn-stack">
        ${preparationSection()}
        <div class="blom-spawn-review blom-spawn-review-finish"><strong>Finished checking the spawn assessment?</strong><p>If you spawned an OC, run a fresh shared scan first. Otherwise continue to the final assignments and messages.</p><button type="button" id="blom-finish-spawn-review">${spawnReview.approved?'Review messages →':'Spawn review complete → review messages'}</button></div>
      </div>`;
    body.querySelector('#blom-planner-message-scope').onchange = event => {
      blStorageSet(PLANNER_PREFS,JSON.stringify({...readJSON(PLANNER_PREFS,{}),messageScope:event.target.value}));
      renderPlanner(body);
    };
    const confirmReview=body.querySelector('#blom-confirm-spawn-review');
    const finishReview=()=>{try{completeSpawnReviewAndShowMessages(body);}catch(error){alert(error.message || String(error));}};
    if(confirmReview)confirmReview.onclick=finishReview;
    const finishAssessment=body.querySelector('#blom-finish-spawn-review');
    if(finishAssessment)finishAssessment.onclick=finishReview;
    const showAssessment=body.querySelector('#blom-review-spawning');
    if(showAssessment)showAssessment.onclick=()=>{const section=body.querySelector('.blom-spawn-section');if(section){section.open=true;section.scrollIntoView({block:'start'});}};
    const prepareNewsletter=body.querySelector('#blom-prepare-newsletter');
    if(prepareNewsletter)prepareNewsletter.onclick=async()=>{
      if(prepareNewsletter.dataset.blPreparationPending==='1')return;
      delete prepareNewsletter.dataset.blPreparationError;
      prepareNewsletter.dataset.blPreparationPending="1";
      prepareNewsletter.dataset.blPreparationStage="Preparing current assignments…";
      try {
        if(typeof PLANNER_KEY!=='undefined' && /^[a-zA-Z0-9]{16}$/.test(String(GM_getValue(PLANNER_KEY,'')).trim()))await verifyMessageMembership(prepareNewsletter);
        prepareNewsletter.dataset.blPreparationStage='Saving current assignment draft…';
        if(!plannerState)throw new Error('Membership changed. Fresh shared scan required before preparing messages.');
        const membership=blRequireRoster();
        if(Date.now()-plannerState.scannedAt>(5*60000))throw new Error('Rescan before preparing assignments.');
        if(messageGroups.some(g=>g.rows.some(row=>!blAllowed(row.member.id))))throw new Error('Membership changed. Rescan before preparing messages.');
        const spawnReviewSignature=requirePlannerSpawnReview(plannerState,{...plannerState.prefs,spawnBudget:applyLiveScopeBudget(plannerState.prefs)});
        const text=plannerAssignmentText(messageGroups,'Black Ledger OC assignments',messageFuture);
        const recipients=messageGroups.flatMap(group=>group.rows).map(row=>({
          id:String(row.member.id),
          name:String(row.member.name || row.member.id)
        }));
        const uniqueRecipients=[...new Map(recipients.map(item=>[item.id,item])).values()];
        const draft={
          version:1,
          viewerId:membership.viewerId,factionId:membership.factionId,
          createdAt:Date.now(),
          expiresAt:Date.now()+(30*60*1000),
          title:'OC Assignments',
          spawnReviewSignature,
          messageScope:messageFuture?'future':'now',
          text,
          recipients:uniqueRecipients,
          nativeGroupExact,
          nativeGroupLabel:nativeGroupExact?`Not in an Organized Crime (${availableIds.size})`:null
        };
        blStorageSet(PLANNER_NEWSLETTER_DRAFT_KEY,JSON.stringify(draft));
        prepareNewsletter.textContent=`Ready ✓ (${uniqueRecipients.length})`;
        prepareNewsletter.title='Assignment newsletter saved and queued for device sync. No page navigation or sending occurs in Stage 1.';
        setTimeout(()=>{prepareNewsletter.textContent='Prepare newsletter';},2200);
      } catch(error) {
        prepareNewsletter.dataset.blPreparationError=String(error.message || error);
        console.error('[Black Ledger OC Manager] Could not prepare newsletter draft',error);
        alert(String(error.message || error));
      } finally { delete prepareNewsletter.dataset.blPreparationPending;delete prepareNewsletter.dataset.blPreparationStage; }
    };
    for(const button of body.querySelectorAll('[data-invitation-decision]'))button.onclick=()=>{
      try{resolvePlannerInvitation(button.dataset.invitationMember,button.dataset.invitationDecision);}
      catch(error){alert(error.message || String(error));}
    };
    document.dispatchEvent(new Event('black-ledger-manager-rendered'));
    const copyRecipients=body.querySelector('#blom-copy-recipients');
    if(copyRecipients)copyRecipients.onclick=async()=>{
      const text=recipientNames.join('\n');
      try{await navigator.clipboard.writeText(text);copyRecipients.textContent='Recipients copied ✓';setTimeout(()=>{copyRecipients.textContent=`Copy recipients (${assignedAllIds.size})`;},1800);}
      catch(_){prompt('Copy these recipients:',text);}
    };
    }finally{if(typeof plannerInputContext!=='undefined')plannerInputContext=previousContext;}
  }


  // If this userscript itself is enabled, the Manager launcher is enabled.
  // Older builds had a second internal enable/disable flag, which could leave
  // the Manager hidden even though the userscript manager showed it as ON.
  // Ignore that stale flag from v1.6.3 onward.
  let managerEnabled = true;
  try { blStorageSet(MANAGER_ENABLED_KEY, "1"); } catch (_) {}

  let meta =
    readJSON(
      MANAGER_META_KEY,
      {
        names: {},
        seen: {},
        importedAt: null
      }
    );

  window.addEventListener('storage',event=>{
    if(event.key!=='black-ledger-verified-roster-v1')return;
    meta=blFilterStore(MANAGER_META_KEY,meta);recordMemo.clear();sharedCache=null;
    plannerState=null;plannerPageCrimes.clear();plannerUnassignedCache=null;plannerPendingZeroAt=null;
    renderPlannerIfOpen();
  });

  let lockedScrollY =
    0;

  let oldBodyStyles =
    null;

  let oldHtmlStyles =
    null;

  /* Retained only as an inert compatibility shim for old page instances.
   * init() deliberately never calls the legacy collector below. */
  let fetchHooked = false;

  /*
   * ============================================================
   * STARTUP
   * ============================================================
   */

  // PDA-safe: do not monkey-patch Torn fetch/XMLHttpRequest.
  // Planner falls back to DOM/page data plus explicit API verification.

  try { repairStoredNames(); } catch (error) { console.warn("[Black Ledger OC Manager] stored-name repair skipped:", error); }

  try { registerMenus(); } catch (error) { console.warn("[Black Ledger OC Manager] userscript menu unavailable:", error); }

  let managerStarted = false;
  const safeInit = () => {
    if (managerStarted || !document.body) return;
    managerStarted = true;
    checkpoint("C: DOM ready");
    forcePdaLauncher();
    try {
      init();
      checkpoint("D: Manager ready");
    } catch (error) {
      reportManagerError("startup", error);
      forcePdaLauncher();
    }
  };

  function init() {

    // Make the launcher visible before any roster/network/planner startup work.
    launcherBootstrap();
    injectStyles();
    startFactionTargetPolicy();
    window.addEventListener('focus',()=>{schedulePlannerPageCapture();scanVisibleNames();renderPlannerIfOpen();refreshSharedData();refreshRoster();});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible' && document.hasFocus()){schedulePlannerPageCapture();renderPlannerIfOpen();refreshRoster();}});

    scanVisibleNames();
    schedulePlannerPageCapture();
    scheduleCompletedHistory();
    setTimeout(() => syncCompletedHistory(), 5000);
    setInterval(() => syncCompletedHistory(), 300000);

    refreshRoster();

    setInterval(
      refreshRoster,
      ROSTER_REFRESH_MS
    );

    refreshSharedData();
    setInterval(refreshSharedData,SHARED_REFRESH_MS);
    window.addEventListener("black-ledger-target-policy-updated",()=>{plannerObservationMembers=null;renderPlannerIfOpen();});

    placeLauncher();

    // Torn rebuilds the OC page dynamically, especially on mobile. Keep a very
    // light attachment check so the launcher is restored if its host is replaced.
    // Recovery timer and route listeners are registered before init().

    setInterval(plannerTimerRefresh, 5000);
    setInterval(pullSharedPlanner,5000);
    setInterval(()=>{try{captureScopeBank();renderInlineRecruiting();autoPlanningItems();}catch(error){console.warn("[Black Ledger] Inline slots:",error);}},1500);
    window.addEventListener('focus',()=>pullSharedPlanner());
    pullSharedPlanner();
    window.addEventListener('storage', event => { if ([CPR_DATA_KEY, 'black-ledger-cpr-last-seen-v1','black-ledger-cpr-latest-observations-v1','oc_smart_targets_offset_v1','black-ledger-target-policy-v1','black-ledger-role-weights-v1'].includes(event.key)) renderPlannerIfOpen(); });

    const observer =
      new MutationObserver(
        mutations => {

          const relevant =
            mutations.some(
              mutation => {

                const element =
                  mutation.target?.nodeType ===
                  Node.ELEMENT_NODE
                    ? mutation.target
                    : mutation.target
                        ?.parentElement;

                if (!element) {
                  return false;
                }

                if (
                  element.closest?.(
                    `#${PANEL_ID}`
                  )
                ) {
                  return false;
                }

                return true;
              }
            );

          if (!relevant) {
            return;
          }

          scheduleVisibleNameScan();
          schedulePlannerPageCapture();
          scheduleCompletedHistory();

          placeLauncher();
        }
      );

    observer.observe(
      document.body,
      {
        childList: true,
        subtree: true
      }
    );
  }

  /*
   * ============================================================
   * LAUNCHER
   * ============================================================
   */

  function placeLauncher() {

    if (document.getElementById(PANEL_ID)) return;

    if (
      !managerEnabled ||
      !document.body
    ) {
      removeLauncher();
      return;
    }

    /*
     * Only show the Manager when we're actually
     * around Organized Crimes.
     */

    const smartSettings =
      document.getElementById(
        SMART_SETTINGS_ID
      );

    const firstCrime =
      document.querySelector(
        '[data-oc-id]'
      );

    /*
     * Torn PDA can render the OC shell before either the Smart Targets control
     * or the first crime card exists. Do not give up in that state: create a
     * temporary fixed launcher on the OC page, then move it into the settings
     * row as soon as that row appears.
     */

    const onOcPage = isOcRouteForLauncher();

    if (!onOcPage) {
      removeLauncher();
      return;
    }

    // Mobile settings rows can be collapsed, clipped or replaced by Torn.
    // Mount at body level so the launcher remains reachable on PDA.
    if (useFloatingManagerLauncher() && (!smartSettings || !smartSettings.getClientRects?.().length)) {
      forcePdaLauncher();
      return;
    }

    if (!smartSettings && !firstCrime && !onOcPage) {
      return;
    }

    let button =
      document.getElementById(
        LAUNCHER_ID
      );

    if (!button) {

      button =
        document.createElement(
          "button"
        );

      button.id =
        LAUNCHER_ID;

      button.type =
        "button";

      button.textContent =
        "📊 OC Manager";

      button.dataset.blackLedgerManager = "1";

      // Inline essentials make the launcher resilient to Torn/PDA stylesheet
      // changes and to a partially rejected stylesheet block.
      Object.assign(button.style, {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 auto",
        position: "static",
        visibility: "visible",
        opacity: "1",
        border: "1px solid rgba(74,144,226,.65)",
        borderRadius: "14px",
        padding: "5px 10px",
        background: "rgba(47,111,165,.18)",
        color: "#fff",
        webkitTextFillColor: "#fff",
        fontSize: "11px",
        fontWeight: "700",
        lineHeight: "1.2",
        cursor: "pointer"
      });

      button.addEventListener(
        "click",
        openManager
      );
    }

    /*
     * Preferred location:
     *
     * Put the Manager button directly inside the
     * same settings row as CPR: Balanced.
     */

    if (smartSettings) {

      const fallback =
        document.getElementById(
          FALLBACK_HOST_ID
        );

      if (
        button.parentElement !==
        smartSettings
      ) {
        const menu = smartSettings.querySelector('.oc-smart-settings-menu');
        if (menu) {
          smartSettings.insertBefore(button, menu);
        } else {
          smartSettings.appendChild(button);
        }
      }

      if (
        fallback &&
        !fallback.children.length
      ) {
        fallback.remove();
      }

      if(useFloatingManagerLauncher())button.style.setProperty("min-height", "44px", "important");
      document.getElementById("black-ledger-oc-manager-mobile-host")?.remove();
      document.getElementById("blom-startup-diagnostic")?.remove();
      Object.assign(button.style, {
        display: "inline-flex",
        position: "static",
        right: "",
        bottom: "",
        zIndex: "",
        visibility: "visible",
        opacity: "1"
      });

      return;
    }

    /*
     * Fallback:
     *
     * Older Smart Role Targets versions might not have
     * #oc-smart-target-settings.
     *
     * In that case, put the Manager in the page flow
     * immediately before the first OC.
     */

    if (firstCrime) {

      let host =
        document.getElementById(
          FALLBACK_HOST_ID
        );

      if (!host) {

        host =
          document.createElement(
            "div"
          );

        host.id =
          FALLBACK_HOST_ID;

        firstCrime.parentElement
          ?.insertBefore(
            host,
            firstCrime
          );
      }

      if (
        host &&
        button.parentElement !==
        host
      ) {
        host.appendChild(
          button
        );
      }

      button.style.display =
        "";
      return;
    }

    // Last-resort PDA fallback while Torn is still loading/rebuilding crimes.
    // This proves the Manager script is alive and remains usable even if Torn's
    // dynamic OC markup changes. It is automatically moved into the CPR row
    // on the next launcher pass once Smart Role Targets appears.
    if (onOcPage) {
      if (button.parentElement !== document.body) document.body.appendChild(button);
      Object.assign(button.style, {
        position: "fixed",
        right: "12px",
        bottom: "84px",
        zIndex: "2147483647",
        display: "inline-flex",
        visibility: "visible",
        opacity: "1"
      });
    }
  }

  function hideLauncher() {

    const button =
      document.getElementById(
        LAUNCHER_ID
      );

    if (button) {
      button.style.display =
        "none";
    }
  }

  function removeLauncher() {
    document.getElementById("black-ledger-oc-manager-mobile-host")?.remove();
    document.getElementById("blom-startup-diagnostic")?.remove();

    document
      .getElementById(
        LAUNCHER_ID
      )
      ?.remove();

    document
      .getElementById(
        FALLBACK_HOST_ID
      )
      ?.remove();
  }

  /*
   * ============================================================
   * USERSCRIPT MENU
   * ============================================================
   */

  function registerMenus() {

    if (
      typeof GM_registerMenuCommand !==
      "function"
    ) {
      return;
    }

    GM_registerMenuCommand(
      "Open Black Ledger OC Manager",

      () => {

        managerEnabled =
          true;

        blStorageSet(
          MANAGER_ENABLED_KEY,
          "1"
        );

        openManager();
      }
    );

    GM_registerMenuCommand(
      "Configure TornStats roster sync",
      configureRosterSync
    );

    GM_registerMenuCommand(
      "Black Ledger roster sync status",
      () => refreshRoster(true, showRosterStatus)
    );

    GM_registerMenuCommand(
      "Black Ledger faction sync status",
      showSyncStatus
    );
  }

  /* Roster access belongs to the leadership-only Manager. The key is kept
   * in the userscript's private storage and is sent only to TornStats. */
  function showTermsDialog(title,html,onContinue) {
    const old=document.getElementById('blom-terms-dialog');if(old)old.remove();
    const panel=document.querySelector(`#${PANEL_ID}`) || document.body;
    const dialog=document.createElement('div');dialog.id='blom-terms-dialog';
    Object.assign(dialog.style,{position:'fixed',inset:'10%',zIndex:'2147483647',overflow:'auto',background:'#20272c',color:'#eee',padding:'20px',border:'2px solid #65c5fa',borderRadius:'8px'});
    dialog.innerHTML=`<h3>${title}</h3>${html}<p><button type="button" data-continue>Continue</button> <button type="button" data-cancel>Cancel</button></p>`;
    for(const button of dialog.querySelectorAll('button')) {
      for(const [property,value] of Object.entries({color:'#ffffff',background:'#245679',border:'1px solid #72caff','border-radius':'6px',padding:'10px 16px','min-height':'42px','font-size':'15px','font-weight':'700',margin:'8px 8px 0 0',cursor:'pointer'}))button.style.setProperty(property,value,'important');
    }
    panel.appendChild(dialog);dialog.querySelector('[data-cancel]').onclick=()=>dialog.remove();
    dialog.querySelector('[data-continue]').onclick=()=>{dialog.remove();onContinue();};
    dialog.querySelector('[data-continue]').focus({preventScroll:true});
  }
  const ROSTER_TERMS_KEY='black-ledger-manager-roster-terms-v1';
  function configureRosterSync() {
    showTermsDialog('Optional TornStats roster integration',managerTermsTable('Roster IDs/count/date stored persistently on this device until cleared.',
      'Roster response stays on this device. TornStats receives its own dedicated service key and handles data under its terms.',
      'Exclude former members from local OC guidance.', 'Dedicated TornStats service key stored in this userscript; sent only to TornStats. Do not paste a Torn API key here.', 'TornStats service key with faction-roster permission.')+
      '<p><a href="https://www.tornstats.com/tos" target="_blank" rel="noopener noreferrer">TornStats terms</a>. Automated roster checks start only after you choose Continue and configure a key. Blank input disconnects and clears the local roster.</p>',()=>configureRosterSyncInput());
  }
  function configureRosterSyncInput() {
    const current = typeof GM_getValue === "function"
      ? GM_getValue(ROSTER_KEY_STORAGE, "") : "";
    const key = prompt("Paste a TornStats API key with faction roster access. It stays in this browser's Manager only.", current || "");
    if (key === null) return;
    if (!String(key).trim()) {
      if (typeof GM_setValue === "function") GM_setValue(ROSTER_KEY_STORAGE, "");
      GM_setValue('black-ledger-tornstats-faction-v1','');GM_setValue(ROSTER_TERMS_KEY,null);blStorageRemove(ROSTER_SNAPSHOT_KEY);blStorageRemove(ROSTER_LAST_RESULT_KEY);
      alert("Roster sync key and local roster cleared.");
      return;
    }
    if (typeof GM_setValue === "function") GM_setValue(ROSTER_KEY_STORAGE, String(key).trim());
    GM_setValue(ROSTER_TERMS_KEY,{version:1,acceptedAt:Date.now()});
    const existing=blRoster();
    const factionId=prompt('Enter your Torn faction ID for automatic membership sync:',GM_getValue('black-ledger-tornstats-faction-v1','') || existing?.factionId || '');
    if(factionId===null)return;
    if(!/^[1-9]\d*$/.test(factionId.trim())){alert('Enter a valid faction ID. No roster was changed.');return;}
    GM_setValue('black-ledger-tornstats-faction-v1',factionId.trim());
    rosterAttemptAt=0;
    refreshRoster(true, showRosterStatus);
  }

  function getRosterSnapshot() {
    return readJSON(ROSTER_SNAPSHOT_KEY, null);
  }

  function hasRoster() {
    return Array.isArray(getRosterSnapshot()?.member_ids);
  }

  function isCurrentRosterMember(id) {
    if(blRoster()!==null)return blAllowed(id);
    const snapshot = getRosterSnapshot();
    return !Array.isArray(snapshot?.member_ids) || snapshot.member_ids.includes(String(id));
  }

  let rosterBusy=false,rosterAttemptAt=0;
  function rosterRequestError(status,data,key) {
    let message=String(data?.message || data?.error?.message || (typeof data?.error==='string'?data.error:'')).trim();
    for(const secret of [String(key || ''),encodeURIComponent(String(key || ''))])if(secret)message=message.split(secret).join('[redacted]');
    message=message.replace(/https?:\/\/\S+/gi,'[URL omitted]').slice(0,300);
    if([401,403].includes(Number(status)))return `TornStats HTTP ${Number(status)}: ${message || 'Access denied. Check the service key and roster permissions.'} Saved key retained.`;
    if(data?.status===false)return `TornStats request failed (HTTP ${Number(status)}): ${message || 'No reason supplied.'} Saved key retained.`;
    return null;
  }
  let tornMembershipBusy=null,tornMembershipAttemptAt=0;
  function recentPlannerMembership() {
    const roster=blRoster(),age=Date.now()-Number(roster?.checkedAt);
    return !!roster && Number.isFinite(age) && age>=0 && age<5*60000;
  }
  async function verifyMessageMembership(control) {
    // Reuse a recently verified roster, while preserving the normal 15-minute
    // membership guard and the separate five-minute assignment scan guard.
    if(recentPlannerMembership())return;
    control.dataset.blPreparationStage='Verifying faction members with Torn…';
    await refreshTornMembership(true);
    blRequireRoster();
  }
  async function refreshTornMembership(force=false) {
    const key=String(GM_getValue(PLANNER_KEY,'')).trim();
    if(!/^[a-zA-Z0-9]{16}$/.test(key))return false;
    if(tornMembershipBusy)return tornMembershipBusy;
    if(document.visibilityState!=='visible' || !document.hasFocus())return false;
    const roster=blRoster();
    if(!force && roster?.source==='torn-api' && Date.now()-roster.checkedAt<ROSTER_REFRESH_MS)return true;
    if(!force && Date.now()-tornMembershipAttemptAt<60000)return false;
    tornMembershipAttemptAt=Date.now();
    tornMembershipBusy=(async()=>{
      try {
        const snapshot=await verifyMembershipOnly();
        const r=blRequireRoster();
        if(snapshot && snapshot.viewerId===r.viewerId && snapshot.factionId===r.factionId && snapshot.member_ids.join(',')===r.memberIds.slice().sort().join(','))
          blStorageSet(ROSTER_SNAPSHOT_KEY,JSON.stringify(snapshot));
        blStorageSet(ROSTER_LAST_RESULT_KEY,JSON.stringify({ok:true,count:r.memberIds.length,endpoint:'Torn faction/members',at:new Date().toISOString()}));
        renderPlannerIfOpen();return true;
      }catch(error){
        blStorageSet(ROSTER_LAST_RESULT_KEY,JSON.stringify({ok:false,error:String(error.message || error),at:new Date().toISOString()}));
        throw error;
      }finally{tornMembershipBusy=null;}
    })();
    return tornMembershipBusy;
  }
  function refreshRoster(force = false, done = null) {
    if(typeof PLANNER_KEY!=='undefined' && /^[a-zA-Z0-9]{16}$/.test(String(GM_getValue(PLANNER_KEY,'')).trim())) {
      refreshTornMembership(force).catch(()=>{}).finally(()=>done?.());return;
    }
    if(document.visibilityState!=='visible' || !document.hasFocus() || rosterBusy || Date.now()-rosterAttemptAt<60000 || GM_getValue(ROSTER_TERMS_KEY,null)?.version!==1){done?.();return;}
    const key = typeof GM_getValue === "function" ? GM_getValue(ROSTER_KEY_STORAGE, "") : "";
    const previous = getRosterSnapshot();
    if (!key) { if (typeof done === "function") done(); return; }
    if (!force && previous?.fetched_at && Date.now() - Date.parse(previous.fetched_at) < ROSTER_REFRESH_MS) { if (typeof done === "function") done(); return; }
    if (typeof GM_xmlhttpRequest !== "function") { if (typeof done === "function") done(); return; }
    rosterBusy=true;rosterAttemptAt=Date.now();
    const membership=blRoster(),viewer=String(getViewerId() || '');
    const configuredFaction=String(GM_getValue('black-ledger-tornstats-faction-v1','') || membership?.factionId || '');
    if(!viewer || !/^[1-9]\d*$/.test(configuredFaction)){rosterBusy=false;blStorageSet(ROSTER_LAST_RESULT_KEY,JSON.stringify({ok:false,error:'Open Data > Configure roster sync and enter your TornStats key and faction ID.',at:new Date().toISOString()}));if(done)done();return;}
    const factionId=configuredFaction;
    const finish=error=>{
      rosterBusy=false;
      blStorageSet(ROSTER_LAST_RESULT_KEY,JSON.stringify({ok:false,error,at:new Date().toISOString()}));
      if(done)done();
    };
    GM_xmlhttpRequest({method:'GET',url:`https://www.tornstats.com/api/v2/${encodeURIComponent(key)}/spy/faction/${factionId}`,headers:{Accept:'application/json'},timeout:15000,
      onload:response=>{try {
        if(String(GM_getValue(ROSTER_KEY_STORAGE,''))!==String(key) || GM_getValue(ROSTER_TERMS_KEY,null)?.version!==1 || String(getViewerId() || '')!==viewer || String(GM_getValue('black-ledger-tornstats-faction-v1','') || blRoster()?.factionId || '')!==factionId)throw new Error('Account or roster settings changed during the request.');
        let data;
        for(const body of [response.responseText,response.response,response.body]){try{const parsed=typeof body==='string'?JSON.parse(body):body;if(parsed && typeof parsed==='object'){data=parsed;break;}}catch(_) {}}
        const failure=rosterRequestError(response.status,data,key);
        if(failure)throw new Error(failure);
        if(response.status<200 || response.status>=300 || !data)throw new Error(`Unsuccessful roster response (HTTP ${Number(response.status)}).`);
        const members=tornStatsLiveRoster(data,factionId,viewer);
        const ids=members.map(m=>m.id).sort(),now=new Date().toISOString();
        const snapshot={viewerId:viewer,factionId,member_ids:ids,member_count:ids.length,members,fetched_at:now,source:'tornstats-live-v2'};
        // A validated complete roster also removes departed members from local data and queues.
        blCommitRoster(viewer,factionId,ids,snapshot.source);
        blStorageSet(ROSTER_SNAPSHOT_KEY,JSON.stringify(snapshot));
        recordMemo.clear();plannerObservationMembers=null;
        blStorageSet(ROSTER_LAST_RESULT_KEY,JSON.stringify({ok:true,count:ids.length,endpoint:'v2 spy/faction',at:now}));
        rosterBusy=false;
        window.dispatchEvent(new Event('black-ledger-roster-updated'));
        renderPlannerIfOpen();
        if(done)done();
      }catch(error){finish(String(error.message || 'Roster response could not be read.'));}},
      onerror:()=>finish('Could not reach TornStats. Previous roster retained.'),ontimeout:()=>finish('TornStats did not reply within 15 seconds. Previous roster retained.')});
  }

  function tornStatsLiveRoster(data,factionId,viewer) {
    if(data?.status!==true || String(data?.faction?.ID)!==String(factionId))throw new Error('TornStats did not confirm the requested faction.');
    if(data.complete===false || data._metadata?.links?.next || data.faction._metadata?.links?.next)throw new Error('Incomplete TornStats roster.');
    const raw=data.faction.members;
    if(!raw || typeof raw!=='object' || Array.isArray(raw))throw new Error('TornStats did not return a member map.');
    const members=Object.entries(raw).map(([id,m])=>{
      if(!/^[1-9]\d*$/.test(id) || !m || typeof m!=='object' || (m.id!=null && String(m.id)!==id) || typeof m.name!=='string' || !m.name.trim())throw new Error('TornStats returned an invalid member record.');
      return {id,name:m.name,position:typeof m.position==='string'?m.position:null,days_in_faction:Number.isFinite(m.days_in_faction)?m.days_in_faction:null};
    });
    for(const count of [data.member_count,data.faction.member_count,data.faction.members_count])if(count!==undefined && Number(count)!==members.length)throw new Error('TornStats member count mismatch.');
    if(members.some(m=>m.position===null))throw new Error('TornStats returned members without faction positions.');
    if(!members.length || !members.some(m=>m.id===viewer))throw new Error('The returned roster does not include your Torn account.');
    return members;
  }
  let liveRosterTestBusy=false;
  function tornStatsCprSummary(data,roster) {
    if(data?.status!==true || !data.members || typeof data.members!=='object' || Array.isArray(data.members)) {
      const fields=Object.keys(data || {}).filter(k=>! /key|token|secret|auth/i.test(k)).slice(0,12).map(k=>k.replace(/[^a-zA-Z0-9_]/g,'').slice(0,40));
      const type=value=>Array.isArray(value)?`array (${value.length} entries)`:value===null?'null':typeof value;
      throw new Error(`Expected a successful response with a members object. Status type: ${type(data?.status)}; members: ${type(data?.members)}; data: ${type(data?.data)}. Top-level fields: ${fields.join(', ') || '(none)'}.`);
    }
    if(data.complete===false || data._metadata?.links?.next)throw new Error('TornStats reports an incomplete or paginated result.');
    const allowed=new Set(roster.memberIds),covered=new Set(),crimes=new Set();
    let records=0,invalid=0,outside=0;
    for(const [id,rows] of Object.entries(data.members)) {
      if(!/^[1-9]\d*$/.test(id) || !allowed.has(id)){outside++;continue;}
      if(!rows || typeof rows!=='object' || Array.isArray(rows)){invalid++;continue;}
      for(const [crime,roles] of Object.entries(rows)) {
        if(!roles || typeof roles!=='object' || Array.isArray(roles)){invalid++;continue;}
        for(const [role,value] of Object.entries(roles)) {
          if(!crime.trim() || !role.trim() || typeof value!=='number' || !Number.isFinite(value) || value<0 || value>100){invalid++;continue;}
          records++;covered.add(id);crimes.add(crime);
        }
      }
    }
    return {members:covered.size,roster:allowed.size,records,crimes:crimes.size,invalid,outside};
  }
  function tornStatsCrimesShape(data,roster) {
    const crimes=data?.crimes;
    if(!crimes || typeof crimes!=='object' || Array.isArray(crimes))return 'The crimes field is missing or is not an object.';
    const entries=Object.entries(crimes);
    if(!entries.length)return 'The crimes object is empty: no CPR values were returned.';
    const numeric=entries.every(([id])=>/^[1-9]\d*$/.test(id));
    if(numeric) {
      const s=tornStatsCprSummary({status:true,members:crimes},roster);
      return `The crimes field is indexed by numeric IDs. ${s.members} verified members have ${s.records} valid crime/role values across ${s.crimes} crimes; ${s.outside} IDs are outside your roster and ${s.invalid} entries were excluded. Member identity still needs confirmation before importing.`;
    }
    let records=0,invalid=0,validCrimes=0;
    for(const [,roles] of entries) {
      if(!roles || typeof roles!=='object' || Array.isArray(roles)){invalid++;continue;}
      let valid=0;
      for(const value of Object.values(roles)) {
        if(typeof value==='number' && Number.isFinite(value) && value>=0 && value<=100){records++;valid++;}else invalid++;
      }
      if(valid)validCrimes++;
    }
    return `The crimes field has a crime → role → CPR structure, without member IDs. ${records} valid values across ${validCrimes} crimes; ${invalid} other entries. This matches the documented personal CPR format. These values cannot be assigned to faction members from this response alone.`;
  }

  function testTornStatsCpr() {
    if(liveRosterTestBusy)return;
    const key=GM_getValue(ROSTER_KEY_STORAGE,''),roster=blRoster();
    if(!key || !roster){alert('Configure automatic membership first, then retry this CPR test.');return;}
    if(Date.now()-roster.checkedAt>15*60000){alert('Refresh membership first, then retry this CPR test.');return;}
    liveRosterTestBusy=true;
    const finish=message=>{liveRosterTestBusy=false;alert(message);};
    GM_xmlhttpRequest({method:'GET',url:`https://www.tornstats.com/api/v2/${encodeURIComponent(key)}/faction/cpr`,headers:{Accept:'application/json'},timeout:15000,
      onload:response=>{try {
        if(String(GM_getValue(ROSTER_KEY_STORAGE,''))!==String(key) || blRoster()?.viewerId!==roster.viewerId || blRoster()?.factionId!==roster.factionId)throw new Error('Account or settings changed during the test.');
        let data;
        for(const body of [response.responseText,response.response,response.body]){try{const parsed=typeof body==='string'?JSON.parse(body):body;if(parsed && typeof parsed==='object'){data=parsed;break;}}catch(_) {}}
        const failure=rosterRequestError(response.status,data,key);
        if(failure)throw new Error(failure);
        if(response.status<200 || response.status>=300 || !data)throw new Error(`Unsuccessful CPR response (HTTP ${Number(response.status)}).`);
        if(!data.members && Object.prototype.hasOwnProperty.call(data,'crimes')) {
          finish('TornStats CPR response received (HTTP '+Number(response.status)+').\n\n'+tornStatsCrimesShape(data,roster)+'\n\nObservation age and member ownership remain unverified. Your key is saved; no data was imported or changed.');
          return;
        }
        const s=tornStatsCprSummary(data,roster);
        finish(`TornStats faction CPR test\n${s.members} of ${s.roster} verified faction members have usable CPR.\n${s.records} crime/role records across ${s.crimes} crimes.\n${s.outside} returned member IDs outside your verified roster.\n${s.invalid} invalid or unrecognised entries excluded.\n\nObservation age is unverified: this endpoint's documented CPR values have no observation timestamps. Download time does not establish freshness.\nNo CPR, membership or message data was changed.`);
      }catch(error){
        const safe=rosterRequestError(200,{status:false,message:String(error.message || 'Response could not be read.')},key).replace('TornStats request failed (HTTP 200): ','');
        finish('TornStats CPR diagnostic: '+safe+'\n\nYour key is still saved. No data was imported or changed.');
      }},
      onerror:()=>finish('CPR test could not reach TornStats.'),ontimeout:()=>finish('CPR test timed out after 15 seconds.')});
  }

  function testTornStatsLiveRoster() {
    if(liveRosterTestBusy)return;
    const key=GM_getValue(ROSTER_KEY_STORAGE,'');
    if(!key){alert('Configure roster sync first so the Manager has your existing TornStats key.');return;}
    const known=blRoster();
    const factionId=prompt('Torn faction ID to test (read-only):',known?.factionId || plannerState?.factionId || '');
    if(factionId===null)return;
    if(!/^[1-9]\d*$/.test(factionId.trim())){alert('Enter a valid Torn faction ID.');return;}
    const viewer=String(getViewerId() || '');
    if(!viewer){alert('Could not identify your Torn account.');return;}
    liveRosterTestBusy=true;
    const finish=message=>{liveRosterTestBusy=false;alert(message);};
    GM_xmlhttpRequest({method:'GET',url:`https://www.tornstats.com/api/v2/${encodeURIComponent(key)}/spy/faction/${factionId.trim()}`,headers:{Accept:'application/json'},timeout:15000,
      onload:response=>{try {
        let data;
        for(const body of [response.responseText,response.response,response.body]){try{const parsed=typeof body==='string'?JSON.parse(body):body;if(parsed && typeof parsed==='object'){data=parsed;break;}}catch(_) {}}
        const failure=rosterRequestError(response.status,data,key);
        if(failure)throw new Error(failure);
        if(response.status<200 || response.status>=300 || !data)throw new Error(`Unreadable or unsuccessful response (HTTP ${Number(response.status)}).`);
        const members=tornStatsLiveRoster(data,factionId.trim(),viewer);
        const ids=new Set(members.map(m=>m.id));
        const comparable=known && known.viewerId===viewer && known.factionId===factionId.trim();
        const missing=comparable?known.memberIds.filter(id=>!ids.has(id)).length:null;
        const extra=comparable?members.filter(m=>!known.memberIds.includes(m.id)).length:null;
        finish(`TornStats live-roster test: faction ${factionId.trim()}\n${members.length} members returned; your account is included.\n${members.filter(m=>/^recruit$/i.test(m.position || '')).length} marked Recruit; ${members.filter(m=>m.position===null).length} missing position.\n${comparable?`Compared with saved verification: ${missing} missing, ${extra} additional. Saved verification may be older.`:'No comparable saved verification available.'}\n\nThis is a connection test. Completeness and freshness still need comparison with Torn. No membership or PM records were changed.`);
      }catch(error){finish('Live-roster test failed: '+String(error.message || 'Response could not be read.'));}},
      onerror:()=>finish('Live-roster test could not reach TornStats.'),ontimeout:()=>finish('Live-roster test timed out after 15 seconds.')});
  }

  function rosterMemberIds(data) {
    const candidates = [
      data?.members,
      data?.roster,
      data?.faction?.members,
      data?.data?.members,
      data?.data?.roster,
      data?.data
    ];
    const ids = new Set();
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        candidate.forEach(member => {
          const id = member?.id || member?.player_id || member?.ID || member?.user_id;
          if (/^\d+$/.test(String(id || ""))) ids.add(String(id));
        });
      } else if (candidate && typeof candidate === "object") {
        Object.entries(candidate).forEach(([memberId, member]) => {
          const id = member?.id || member?.player_id || member?.ID || member?.user_id || memberId;
          if (/^\d+$/.test(String(id || ""))) ids.add(String(id));
        });
      }
    }
    return [...ids];
  }

  function showRosterStatus() {
    const result = readJSON(ROSTER_LAST_RESULT_KEY, null);
    const snapshot = getRosterSnapshot();
    if (result?.ok) alert(`Roster sync is active: ${result.count ?? snapshot?.member_ids?.length ?? blRoster()?.memberIds.length ?? 0} current members. Updated ${new Date(result.at || snapshot?.fetched_at).toLocaleString('en-GB', {timeZone:'Europe/London', hour12:false})}.\n\nMembership refreshes every five minutes while Torn is visible and focused. OC availability comes from Fresh shared scan.`);
    else if (typeof GM_getValue === "function" && GM_getValue(ROSTER_KEY_STORAGE, "")) alert(`Roster sync needs attention. The last saved roster is retained; PM preparation requires verification within 15 minutes.${result?.error ? `\n\nLast error: ${result.error}` : ""}`);
    else alert("Roster sync is not configured. Choose Configure TornStats roster sync in the userscript menu.");
  }

  function showSyncStatus() {alert(`Black Ledger shared CPR\n\n${sharedStatusText()}\n\nThe Manager is read-only. Member uploads default to ON and are controlled by the collector's CPR settings-menu sharing control.`);}

  /*
   * ============================================================
   * MANAGER WINDOW
   * ============================================================
   */

  function openManager() {
    meta=readJSON(MANAGER_META_KEY,{names:{},seen:{},importedAt:null});

    if (!document.body) {
      return;
    }

    scanVisibleNames();

    /*
     * Remove any previous panel without touching
     * the current page scroll.
     */

    document
      .getElementById(
        PANEL_ID
      )
      ?.remove();

    lockPageScroll();

    hideLauncher();

    const members =
      getMembers();

    const panel =
      document.createElement(
        "div"
      );

    panel.id =
      PANEL_ID;

    panel.innerHTML = `

      <div class="blom-shell">

        <div class="blom-header">

          <div>

            <div class="blom-title">
              Black Ledger OC Manager
            </div>

            <div class="blom-subtitle">
              ${
                Object.keys(
                  members
                ).length
              } members with saved CPR data (not the faction total)
            </div>

          </div>

          <button
            class="blom-close"
            type="button"
          >
            ✕
          </button>

        </div>

        <div class="blom-tabs">

          <button data-tab="planner" class="active">Roster Planner</button>

          <button data-tab="builder">OC Builder</button>

          <button
            data-tab="specialists"
          >
            Specialists
          </button>

          <button
            data-tab="coverage"
          >
            Coverage
          </button>

          <button
            data-tab="members"
          >
            Members
          </button>

          <button
            data-tab="data"
          >
            Data
          </button>

          <button data-tab="settings">Settings</button>

          <button data-tab="help" title="Help / How to use">Help</button>

        </div>

        <div class="blom-body">
        </div>

      </div>
    `;

    document.body.appendChild(
      panel
    );

    panel
      .querySelector(
        ".blom-close"
      )
      .addEventListener(
        "click",
        closeManager
      );

    panel.addEventListener(
      "click",
      event => {

        if (
          event.target ===
          panel
        ) {
          closeManager();
        }
      }
    );

    panel
      .querySelectorAll(
        ".blom-tabs button"
      )
      .forEach(
        button => {

          button.addEventListener(
            "click",
            () => {

              panel
                .querySelectorAll(
                  ".blom-tabs button"
                )
                .forEach(
                  item =>
                    item.classList.remove(
                      "active"
                    )
                );

              button.classList.add(
                "active"
              );

              renderTab(
                button.dataset.tab
              );
            }
          );
        }
      );

    renderTab(
      "planner"
    );
    checkpoint("E: panel opened");
  }

  function closeManager() {

    document
      .getElementById(
        PANEL_ID
      )
      ?.remove();

    unlockPageScroll();

    placeLauncher();
  }

  /*
   * ============================================================
   * SCROLL LOCK
   * ============================================================
   */

  function lockPageScroll() {

    if (
      !document.body ||
      !document.documentElement
    ) {
      return;
    }

    lockedScrollY =
      window.scrollY ||
      document.documentElement
        .scrollTop ||
      0;

    oldBodyStyles = {

      position:
        document.body.style.position,

      top:
        document.body.style.top,

      left:
        document.body.style.left,

      right:
        document.body.style.right,

      width:
        document.body.style.width,

      overflow:
        document.body.style.overflow
    };

    oldHtmlStyles = {

      overflow:
        document.documentElement
          .style
          .overflow,

      overscrollBehavior:
        document.documentElement
          .style
          .overscrollBehavior
    };

    document.body.style.position =
      "fixed";

    document.body.style.top =
      `-${lockedScrollY}px`;

    document.body.style.left =
      "0";

    document.body.style.right =
      "0";

    document.body.style.width =
      "100%";

    document.body.style.overflow =
      "hidden";

    document.documentElement
      .style
      .overflow =
      "hidden";

    document.documentElement
      .style
      .overscrollBehavior =
      "none";
  }

  function unlockPageScroll() {

    if (
      !oldBodyStyles ||
      !oldHtmlStyles
    ) {
      return;
    }

    document.body.style.position =
      oldBodyStyles.position;

    document.body.style.top =
      oldBodyStyles.top;

    document.body.style.left =
      oldBodyStyles.left;

    document.body.style.right =
      oldBodyStyles.right;

    document.body.style.width =
      oldBodyStyles.width;

    document.body.style.overflow =
      oldBodyStyles.overflow;

    document.documentElement
      .style
      .overflow =
      oldHtmlStyles.overflow;

    document.documentElement
      .style
      .overscrollBehavior =
      oldHtmlStyles
        .overscrollBehavior;

    const restoreY =
      lockedScrollY;

    oldBodyStyles =
      null;

    oldHtmlStyles =
      null;

    requestAnimationFrame(
      () => {

        window.scrollTo(
          0,
          restoreY
        );
      }
    );
  }

  /*
   * ============================================================
   * TABS
   * ============================================================
   */

  function renderTab(tab) {

    const body =
      document.querySelector(
        `#${PANEL_ID} .blom-body`
      );

    if (!body) {
      return;
    }

    if (
      tab ===
      "builder"
    ) {
      renderBuilder(
        body
      );
    }

    else if (tab === "planner") {
      renderPlanner(body);
    }

    else if (
      tab ===
      "specialists"
    ) {
      renderSpecialists(
        body
      );
    }

    else if (
      tab ===
      "coverage"
    ) {
      renderCoverage(
        body
      );
    }

    else if (
      tab ===
      "members"
    ) {
      renderMembers(
        body
      );
    }

    else if (tab === "settings") {
      renderSettings(body);
    }

    else if (tab === "help") {
      renderHelp(body);
    }

    else {
      renderData(
        body
      );
    }

    body.scrollTop =
      0;
  }

  /*
   * ============================================================
   * OC BUILDER
   * ============================================================
   */

  function renderBuilder(body) {
    const definitions = plannerWeights();
    const levels = [...new Set(Object.values(definitions).map(def => Number(def.level)))].sort((a, b) => a - b);
    const storageKey = 'black-ledger-builder-levels-v1';
    const saved = readJSON(storageKey, null);
    let selected = new Set((Array.isArray(saved) ? saved : levels).filter(level => levels.includes(level)));
    const crimes =
      Object.entries(definitions).sort(
        (a, b) =>
          a[1].level -
            b[1].level ||
          a[0].localeCompare(
            b[0]
          )
      );

    const visibleCrimes = () => crimes.filter(([, def]) => selected.has(Number(def.level)));
    body.innerHTML = `
      <fieldset style="border:1px solid #344650;border-radius:8px;margin:0 0 16px;padding:10px 12px;">
        <legend>Show crime levels</legend>
        <div style="display:flex;flex-wrap:wrap;gap:10px 16px;">
          ${levels.map(level => `<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-builder-level="${level}" ${selected.has(level) ? 'checked' : ''}>Level ${level}</label>`).join('')}
        </div>
      </fieldset>
      <div class="blom-toolbar">

        <label>

          Crime

          <select
            id="blom-crime-select"
          >

            ${
              visibleCrimes()
                .map(
                  ([name, def]) =>
                    `
                    <option
                      value="${escapeAttr(name)}"
                    >
                      L${def.level} — ${escapeHtml(name)}
                    </option>
                    `
                )
                .join("")
            }

          </select>

        </label>

        <span id="blom-builder-policy" class="blom-control-chip" role="status">${escapeHtml(factionTargetStatus())}</span>

        <span class="blom-muted">Teams build automatically. Role targets include the management adjustment and role weight.</span>

      </div>

      <div
        id="blom-build-results"
      >
      </div>
    `;

    const select =
      body.querySelector(
        "#blom-crime-select"
      );

    const build =
      () => {
        body.querySelector('#blom-builder-policy').textContent = factionTargetStatus();
        const empty = !select.value;
        select.disabled = empty;
        if (empty) {
          body.querySelector('#blom-build-results').innerHTML = '<p class="blom-muted">Select one or more levels to choose a crime.</p>';
          return;
        }

        const minimum = mainScriptTarget(select.value, definitions[select.value].level, 0, 1);

        renderBuildResults(

          body.querySelector(
            "#blom-build-results"
          ),

          select.value,

          minimum,

          true
        );

      };

    select.addEventListener(
      "change",
      build
    );

    body.querySelectorAll('[data-builder-level]').forEach(input => {
      input.addEventListener('change', () => {
        selected = new Set([...body.querySelectorAll('[data-builder-level]:checked')].map(box => Number(box.dataset.builderLevel)));
        try { blStorageSet(storageKey, JSON.stringify([...selected])); } catch (_) {}
        const previous = select.value;
        select.innerHTML = visibleCrimes().map(([name, def]) => `<option value="${escapeAttr(name)}">L${def.level} — ${escapeHtml(name)}</option>`).join('');
        if (visibleCrimes().some(([name]) => name === previous)) select.value = previous;
        build();
      });
    });
    body.blomRefreshTargets = build;
    build();
  }

  function renderBuildResults(
    container,
    crimeName,
    baseTarget,
    weighted
  ) {

    const def = plannerDefinition(crimeName,plannerWeights()) || OC_DEFS[crimeName];

    if (!def) {
      return;
    }

    const roleCount =
      Object.keys(
        def.roles
      ).length;

    const roles =
      Object.entries(
        def.roles
      ).map(
        ([role, weight]) => ({

          role,
          weight,

          target: weighted ? mainScriptTarget(crimeName,def.level,weight,roleCount,role) : baseTarget
        })
      );

    const assignments =
      buildAssignments(
        crimeName,
        roles
      );

    const good =
      roles.filter(
        role =>

          assignments[
            role.role
          ] &&

          assignments[
            role.role
          ].cpr >=
            role.target
      ).length;

    const mobileCards =
      roles
        .map(
          role =>
            renderRoleCard(
              crimeName,
              role,
              assignments[
                role.role
              ]
            )
        )
        .join("");

    container.innerHTML = `

      <div class="blom-summary">

        <div>

          <strong>
            L${def.level}
            — ${escapeHtml(crimeName)}
          </strong>

        </div>

        <div>
          ${good}/${roles.length}
          roles meet target with unique members
        </div>

      </div>

      <div class="blom-role-list">
        ${mobileCards}
      </div>
    `;
  }

  function renderRoleCard(
    crimeName,
    role,
    assignment
  ) {

    const alternatives =
      getAlternatives(
        crimeName,
        role.role,
        assignment
      );

    return `

      <div class="blom-role-card">

        <div class="blom-role-top">

          <div>

            <div class="blom-role-name">
              ${prettyRole(role.role)}
            </div>

            <div class="blom-role-meta">

              Weight:
              ${role.weight.toFixed(1)}%

              · Target:

              <strong>
                ${role.target}
              </strong>

            </div>

          </div>

          ${
            assignment
              ? stateBadge(
                  assignment.cpr,
                  role.target
                )
              : ""
          }

        </div>

        ${
          assignment
            ? `

              <div class="blom-selected-member">

                <div>
                  ${memberLink(
                    assignment.id
                  )}
                </div>

                <div class="blom-big-cpr">

                  ${formatCpr(
                    assignment.cpr
                  )}

                </div>

              </div>
            `

            : `

              <div class="blom-no-member">
                No recorded candidate
              </div>
            `
        }

        ${
          alternatives.length

            ? `

              <div class="blom-alt-heading">
                Alternatives
              </div>

              <div class="blom-alt-list">

                ${
                  alternatives
                    .map(
                      candidate => `

                        <div class="blom-alt-item">

                          <span>

                            ${escapeHtml(
                              memberLabel(
                                candidate.id
                              )
                            )}

                          </span>

                          <strong>

                            ${formatCpr(
                              candidate.cpr
                            )}

                          </strong>

                        </div>
                      `
                    )
                    .join("")
                }

              </div>
            `

            : ""
        }

      </div>
    `;
  }

  function getAlternatives(
    crimeName,
    roleName,
    assignment
  ) {

    return getCandidates(
      crimeName,
      roleName
    )

      .filter(
        candidate =>
          !assignment ||
          candidate.id !==
            assignment.id
      )

      .slice(
        0,
        3
      );
  }

  function buildAssignments(
    crimeName,
    roles
  ) {

    const sortedRoles =
      [
        ...roles
      ].sort(
        (a, b) =>
          b.weight -
            a.weight ||
          b.target -
            a.target
      );

    const used =
      new Set();

    const result =
      {};

    for (
      const role
      of sortedRoles
    ) {

      const candidates =
        getCandidates(
          crimeName,
          role.role
        )

          .filter(
            candidate =>
              !used.has(
                candidate.id
              )
          )

          .sort(
            (a, b) =>
              candidateScore(
                b,
                role
              ) -
              candidateScore(
                a,
                role
              )
          );

      if (
        candidates.length
      ) {

        const chosen =
          candidates[0];

        used.add(
          chosen.id
        );

        result[
          role.role
        ] =
          chosen;
      }
    }

    return result;
  }

  function candidateScore(
    candidate,
    role
  ) {

    const surplus =
      candidate.cpr -
      role.target;

    return (
      candidate.cpr *
        100 +

      surplus *
        role.weight
    );
  }

  /*
   * ============================================================
   * SPECIALISTS
   * ============================================================
   */

  function renderSpecialists(body) {
    const definitions = plannerWeights();
    const crimes = Object.entries(definitions).sort((a, b) => a[1].level - b[1].level || a[0].localeCompare(b[0]));
    const levels = [...new Set(crimes.map(([, def]) => Number(def.level)))];
    const storageKey = 'black-ledger-specialist-levels-v1';
    const saved = readJSON(storageKey, null);
    let selected = new Set((Array.isArray(saved) ? saved : levels).filter(level => levels.includes(level)));
    const visibleCrimes = () => crimes.filter(([, def]) => selected.has(Number(def.level)));
    const cachedResults = new Map();
    let members;
    body.innerHTML = `
      <fieldset style="border:1px solid #344650;border-radius:8px;margin:0 0 16px;padding:10px 12px;">
        <legend>Show crime levels</legend>
        <div style="display:flex;flex-wrap:wrap;gap:10px 16px;">
          ${levels.map(level => `<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-specialist-level="${level}" ${selected.has(level) ? 'checked' : ''}>Level ${level}</label>`).join('')}
        </div>
      </fieldset>

      <div class="blom-toolbar">

        <label>

          Crime

          <select
            id="blom-specialist-crime"
          >

            ${
              visibleCrimes()
                .map(
                  ([name, def]) =>
                    `
                    <option
                      value="${escapeAttr(name)}"
                    >
                      L${def.level} — ${escapeHtml(name)}
                    </option>
                    `
                )
                .join("")
            }

          </select>

        </label>

      </div>

      <div
        id="blom-specialist-results"
      >
      </div>
    `;

    const select =
      body.querySelector(
        "#blom-specialist-crime"
      );

    const render =
      () => {

        const def = definitions[select.value];
        const results = body.querySelector('#blom-specialist-results');
        select.disabled = !def;
        if (!def) {
          results.innerHTML = '<p class="blom-muted">Select one or more levels to choose a crime.</p>';
          return;
        }
        if (cachedResults.has(select.value)) {
          results.innerHTML = cachedResults.get(select.value);
          return;
        }
        members ??= getMembers();
        const html =
          Object.entries(
            def.roles
          )

            .map(
              ([role, weight]) => {

                const top =
                  getCandidates(
                    select.value,
                    role,
                    members
                  )
                    .slice(
                      0,
                      10
                    );

                return `

                  <div class="blom-card">

                    <div class="blom-card-title">

                      <span>
                        ${prettyRole(role)}
                      </span>

                      <span>
                        ${weight.toFixed(1)}%
                      </span>

                    </div>

                    ${
                      top.length

                        ? top
                            .map(
                              (
                                candidate,
                                index
                              ) => `

                                <div class="blom-rank">

                                  <span>

                                    <span class="blom-rank-number">
                                      #${index + 1}
                                    </span>

                                    ${memberLink(
                                      candidate.id
                                    )}

                                  </span>

                                  <strong>

                                    ${formatCpr(
                                      candidate.cpr
                                    )}

                                  </strong>

                                </div>
                              `
                            )
                            .join("")

                        : `

                          <div class="blom-muted">
                            No CPR recorded for this role yet.
                          </div>
                        `
                    }

                  </div>
                `;
              }
            )

            .join("");

        body
          .querySelector(
            "#blom-specialist-results"
          )
          .innerHTML = `

            <div class="blom-grid">
              ${html}
            </div>
          `;
        cachedResults.set(select.value, results.innerHTML);
      };

    body.querySelectorAll('[data-specialist-level]').forEach(input => {
      input.addEventListener('change', () => {
        selected = new Set([...body.querySelectorAll('[data-specialist-level]:checked')].map(box => Number(box.dataset.specialistLevel)));
        try { blStorageSet(storageKey, JSON.stringify([...selected])); } catch (_) {}
        const previous = select.value;
        select.innerHTML = visibleCrimes().map(([name, def]) => `<option value="${escapeAttr(name)}">L${def.level} — ${escapeHtml(name)}</option>`).join('');
        if (visibleCrimes().some(([name]) => name === previous)) select.value = previous;
        render();
      });
    });
    select.addEventListener(
      "change",
      render
    );

    render();
  }

  /*
   * ============================================================
   * COVERAGE
   * ============================================================
   */

  function renderCoverage(body, selectedLevels) {
    const definitions = plannerWeights();
    const levels = [...new Set(Object.values(definitions).map(def => Number(def.level)))].sort((a, b) => a - b);
    const storageKey = 'black-ledger-coverage-levels-v1';
    const saved = selectedLevels ?? readJSON(storageKey, null);
    const selected = new Set((Array.isArray(saved) ? saved : levels).filter(level => levels.includes(level)));

    const levelCards = new Map();
    let members;
    const renderLevel = level => {
      members ??= getMembers();
      const cards =
      Object.entries(definitions)
        .filter(([, def]) => Number(def.level) === level)
        .sort(([, a], [, b]) => a.level - b.level)
        .map(
          ([crime, originalDef]) => {
            const def = originalDef;
            const roleRows =
              Object.entries(
                def.roles
              )

                .map(
                  ([role, weight]) => {

                    const target =
                      mainScriptTarget(crime,def.level,weight,Object.keys(def.roles).length,role);

                    const qualified =
                      getCandidates(
                        crime,
                        role,
                        members
                      )

                        .filter(
                          candidate =>
                            candidate.cpr >=
                              target
                        );

                    return {
                      role,
                      target,
                      qualified
                    };
                  }
                );

            const covered =
              roleRows.filter(
                row =>
                  row.qualified
                    .length >
                  0
              ).length;

            const pct =
              Math.round(
                (
                  covered /
                  roleRows.length
                ) *
                  100
              );

            const weak =
              roleRows.filter(
                row =>
                  row.qualified
                    .length <
                  2
              );

            return `

              <div class="blom-card">

                <div class="blom-card-title">

                  <span>

                    L${def.level}
                    — ${escapeHtml(crime)}

                  </span>

                  <span>
                    ${pct}%
                  </span>

                </div>

                <div class="blom-meter">

                  <span
                    style="width:${pct}%"
                  >
                  </span>

                </div>

                <div class="blom-muted">

                  ${covered}/${roleRows.length}
                  roles have at least one member at target.

                </div>

                ${
                  weak.length

                    ? `

                      <div class="blom-warning">

                        <strong>
                          Thin coverage:
                        </strong>

                        ${
                          weak
                            .map(
                              row =>
                                `${prettyRole(
                                  row.role
                                )} (${row.qualified.length})`
                            )
                            .join(
                              ", "
                            )
                        }

                      </div>
                    `

                    : `

                      <div class="blom-good">

                        All roles have at least
                        two qualifying members.

                      </div>
                    `
                }

              </div>
            `;
          }
        )

        .join("");
      return `<section style="margin-bottom:20px;"><h3 style="color:#66cfff;margin:0 0 10px;">Level ${level}</h3><div class="blom-grid">${cards}</div></section>`;
    };
    const renderSelected = selected => [...selected].sort((a, b) => a - b).map(level => {
      if (!levelCards.has(level)) levelCards.set(level, renderLevel(level));
      return levelCards.get(level);
    }).join('') || '<p class="blom-muted">Select one or more levels to show coverage.</p>';

    body.innerHTML = `
      <fieldset style="border:1px solid #344650;border-radius:8px;margin:0 0 16px;padding:10px 12px;">
        <legend>Show crime levels</legend>
        <div style="display:flex;flex-wrap:wrap;gap:10px 16px;">
          ${levels.map(level => `<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" data-coverage-level="${level}" ${selected.has(level) ? 'checked' : ''}>Level ${level}</label>`).join('')}
        </div>
      </fieldset>
      <div id="blom-coverage-results">${renderSelected(selected)}</div>
    `;
    body.querySelectorAll('[data-coverage-level]').forEach(input => {
      input.addEventListener('change', () => {
        const next = [...body.querySelectorAll('[data-coverage-level]:checked')].map(box => Number(box.dataset.coverageLevel));
        try { blStorageSet(storageKey, JSON.stringify(next)); } catch (_) {}
        body.querySelector('#blom-coverage-results').innerHTML = renderSelected(next);
      });
    });
  }

  /*
   * ============================================================
   * MEMBER LOOKUP
   * ============================================================
   */

  function renderMembers(body) {

    const members =
      getMembers();

    const options =
      Object.keys(
        members
      )

        .sort(
          (a, b) =>
            memberLabel(a)
              .localeCompare(
                memberLabel(b)
              )
        )

        .map(
          id => `

            <option
              value="${escapeAttr(id)}"
            >

              ${escapeHtml(
                memberLabel(id)
              )}

            </option>
          `
        )

        .join("");

    body.innerHTML = `

      <div class="blom-toolbar">

        <label>

          Member

          <select
            id="blom-member-select"
          >

            ${options}

          </select>

        </label>

      </div>

      <div
        id="blom-member-results"
      >
      </div>
    `;

    const select =
      body.querySelector(
        "#blom-member-select"
      );

    const render =
      () => {

        const id =
          select.value;

        const crimes =
          members[id] ||
          {};

        const rows =
          [];

        for (
          const [
            crime,
            roles
          ]
          of Object.entries(
            crimes
          )
        ) {

          for (
            const [
              role,
              cpr
            ]
            of Object.entries(
              roles ||
              {}
            )
          ) {

            const observation = freshestCpr(id, crime, role, cpr);
            const observedTime = Number(observation.timestamp_ms) || Date.parse(observation.observed_at);
            const seen = Number.isFinite(observedTime) && observedTime > 0 && observedTime <= Date.now()
              ? new Date(observedTime).toISOString() : null;
            rows.push({

              crime,
              role,

              cpr:
                Number(
                  observation.cpr
                ),

              level:
                getCrimeLevel(
                  crime
                ),

              seen
            });
          }
        }

        rows.sort(
          (a, b) =>
            (
              b.level ||
              0
            ) -
              (
                a.level ||
                0
              ) ||

            b.cpr -
              a.cpr
        );

        // Rows are already ordered by level and CPR: the first row in each
        // group gives its best score, keeping strong OCs near the top.
        const groups = new Map();
        for (const row of rows) {
          if (!groups.has(row.crime)) groups.set(row.crime, []);
          groups.get(row.crime).push(row);
        }
        body.querySelector("#blom-member-results").innerHTML = rows.length ? `
          <div class="blom-summary">
            <div>${memberLink(id)}</div>
            <div>${groups.size} OCs · ${rows.length} recorded role CPRs</div>
          </div>
          <div class="blom-member-list">
            ${[...groups].map(([crime, roles]) => `
              <section class="blom-member-crime">
                <h3 class="blom-member-crime-title">${roles[0].level ? `L${roles[0].level}` : '—'} · ${escapeHtml(crime)}</h3>
                <table class="blom-member-role-table" aria-label="${escapeAttr(crime)} role CPRs">
                  <thead><tr><th scope="col">Role</th><th scope="col">CPR</th><th scope="col">Observed</th></tr></thead>
                  <tbody>${roles.map(row => `<tr>
                    <th scope="row">${escapeHtml(prettyRole(row.role))}</th>
                    <td class="blom-member-score">${formatCpr(row.cpr)}</td>
                    <td class="blom-member-observed">${row.seen ? `<span class="blom-member-row-date"><span class="blom-member-date-label">Observed </span>${formatDate(row.seen)}</span>` : '—'}</td>
                  </tr>`).join('')}</tbody>
                </table>
              </section>`).join('')}
          </div>` : '<div class="blom-muted">No CPR records for this member.</div>';
      };

    select.addEventListener(
      "change",
      render
    );

    if (
      select.value
    ) {
      render();
    }
  }

  /*
   * ============================================================
   * DATA
   * ============================================================
   */

  function renderHelp(body) {
    body.innerHTML = `
      <div class="blom-help">
        <h2>Manager: quick setup</h2>
        <p>Install and enable OC Manager and Smart Role Targets in the same browser or Torn PDA profile. Sign in to Torn, open Faction → Organised Crimes, then tap <strong>OC Manager</strong>.</p>
        <ol>
          <li><strong>Connect membership.</strong> Choose <b>Configure automatic membership</b>, read the terms and continue. Enter your <b>TornStats service key with faction-roster access</b>, then your numeric <b>Torn faction ID</b>. Obtain the key from your TornStats account or the person managing your faction\u2019s integration. Check the returned roster count against Torn.
            <p><button id="blom-help-roster" type="button">Configure automatic membership</button> <button id="blom-help-roster-check" type="button">Check membership</button></p>
          </li>
          <li><strong>Connect shared CPR.</strong> Choose <b>Configure shared CPR</b>, read the terms and enter the <b>private shared-CPR Manager access code</b> supplied by the administrator of your faction\u2019s shared-CPR service. This code is issued by the shared-CPR service administrator; you do not create it on Torn or TornStats. If it has not been supplied, ask that administrator before connecting. This is separate from both API keys.
            <p><button id="blom-help-shared" type="button">Configure shared CPR</button> <button id="blom-help-shared-check" type="button">Check shared CPR</button></p>
          </li>
          <li><strong>Enable planning.</strong> In <b>Settings</b>, tick <b>Enable roster planner</b>. Tap <b>Fresh shared scan</b> on the OC page. It requests every Recruiting and Planning page through your Torn login, checks them twice, and publishes a shared snapshot. No Torn API key is required.
            <p><button id="blom-help-settings" type="button">Open Settings</button></p>
          </li>
        </ol>
        <p class="blom-muted">Setup is saved on this device. Repeat it for another browser or PDA installation. You can reopen these controls to change a connection without reinstalling.</p>

        <h3>Which key goes where?</h3>
        <div style="overflow-x:auto;"><table class="blom-planner-table"><thead><tr><th>Credential</th><th>Where to enter it</th><th>Used for</th></tr></thead><tbody>
          <tr><td>TornStats service key</td><td>Configure automatic membership / Data → Configure roster sync</td><td>Current faction membership; sent to TornStats.</td></tr>
          <tr><td>Private shared-CPR Manager code</td><td>Configure shared CPR</td><td>Download faction CPR; sent to the shared-CPR service.</td></tr>
          <tr><td>Torn API key (optional)</td><td>Settings → Advanced: optional Torn API fallback</td><td>Alternative membership or full OC checks; sent to Torn.</td></tr>
        </tbody></table></div>
        <p>Keep credentials private. Enter them in the setup prompts, never in the script source or a screenshot.</p>

        <details><summary><strong>Background collection: what needs to be running?</strong></summary>
          <p><b>Smart Role Targets collects and uploads CPR</b> from OC roles it can read. Keep it enabled and use the OC page with Torn visible and focused. Its sharing control must be ON for uploads; earlier opt-outs are preserved. Expand OCs to expose their roles. Collection/uploads pause when Torn is closed, unfocused or has had no interaction for 30 seconds. Scroll, tap or use the OC page to resume.</p>
          <p><b>Manager downloads shared CPR and refreshes membership</b> about every five minutes while Torn is visible and focused. The Manager panel can be closed. It also saves anonymous completed teams and syncs their historical role CPR, weights and team outcomes to faction storage using authorised manager access. Connecting membership does not provide faction-wide CPR from TornStats.</p>
          <p>Use <b>Settings → Refresh shared CPR</b> or <b>Refresh membership</b> for an immediate check. A recent download can still contain older observations.</p>
        </details>
        <details><summary><strong>Everyday use</strong></summary>
          <ul>
            <li><b>Roster Planner:</b> scan before allocating members. Suggestions use the shared snapshot: available members, all current OCs, server CPR, role weights, targets and selected crime levels. Prepare new OCs checks a starter and one distinct timely follower for every possible crime. Later roles stay open for members finishing other OCs. Whole-crew coverage is advisory; do not fill multi-day queues. Known finish times support the 24-hour forecast; paused or unreadable timers remain unknown. Planning coverage shows the next uncovered stage; successive on-time joins extend coverage by 24 hours. Recommendations are conditional until members join. Existing stall deadlines take priority over crime level and new spawns. Urgent existing stages due within 24 hours may use higher-level specialists with qualifying role CPR. Stalled OCs remain fillable, while true expiring OCs retain their expiry limit. CPR targets remain required. Set the spawn Scope budget using the live faction Scope balance and actual level costs; the default reserve is 50 Scope. Staffing is shown separately from spending advice. Shared completed-outcome evidence flags consistently weak options once sufficient observations exist; it does not predict this crew\u2019s success or change CPR targets. Rescan after changes; shared snapshots expire after five minutes and are checked for updates every five seconds while Torn is focused.</li>
            <li><b>OC Builder:</b> tick levels, choose a crime, then review the proposed unique-member team. Teams build automatically when you choose a crime. Role targets follow Smart Role Targets and adjust for role weight.</li>
            <li><b>Specialists:</b> tick levels and choose a crime to see the top recorded members for each role.</li>
            <li><b>Coverage:</b> tick levels to see which roles have qualifying members and where backup is thin.</li>
            <li><b>Member Lookup:</b> view recorded CPR by member. \u201cObserved\u201d shows an available record date; undated records have no date line.</li>
          </ul>
          <p>Planner level selections and older-CPR settings are shared with the snapshot. Other tabs keep their own level selections. CPR is recorded evidence, not a guarantee of current availability. Keep <b>Include older CPR</b> off unless you want observations over 30 days old included in planning.</p>
        </details>
        <details><summary><strong>If something is missing or fails</strong></summary>
          <ul>
            <li><b>No shared CPR:</b> check shared CPR above. A rejected code needs the correct private Manager code from your shared-CPR service administrator. For a connection error, keep Torn focused and retry <b>Refresh shared CPR</b>; a failed refresh retains previous shared data.</li>
            <li><b>Membership fails:</b> check the TornStats key\u2019s roster access and the faction ID. Use <b>Check membership</b> and compare the result with Torn.</li>
            <li><b>No suggestions:</b> enable the planner, open the recruiting/planning lists, expand OCs and rescan. The scan covers readable page data, so unopened lists may be absent.</li>
            <li><b>CPR count differs from faction size:</b> the header counts members with saved CPR, not everyone in the faction. Missing roles need new observations from the collector.</li>
            <li><b>Chrome or PDA shows no launcher:</b> check the script is enabled for www.torn.com, reload the OC page and check your userscript/PDA script settings. A new browser/profile needs its own setup.</li>
          </ul>
        </details>
        <details><summary><strong>Faction CPR target adjustment</strong></summary>
          <p>Open <b>Settings → Faction CPR target adjustment</b>. Enter a whole-number offset from -10 to +10, then <b>Publish to faction</b>; <b>Publish 0</b> restores the default. +2 raises the 67 baseline to 69; -3 lowers it to 64, within the normal target limits. All crime levels use baseline 67. Fixed role weights balance requirements above and below it, by up to four points; the role targets average to the baseline plus this adjustment. Missing or incomplete weights use the baseline. No Reserve follows the same rule. Recorded CPR is unchanged.</p>
          <p>Publishing requires a Manager access code authorised by the service administrator. Updated member scripts automatically download the faction setting within about five minutes while Torn is visible and focused. Personal CPR presets are removed in the updated member script. If a download fails, the last downloaded setting is retained; before the first download, the offset is 0. Older installations must be updated to follow the faction policy.</p>
        </details>
        <details><summary><strong>Advanced: optional Torn API and messages</strong></summary>
          <p>The normal TornStats membership + page-scan setup needs no Torn API key. For the API fallback, use a <b>16-character key belonging to the signed-in Torn account</b>. Membership checks use user basic/faction and faction members access. A full OC API scan also needs faction positions and crimes access plus a faction position allowed to manage OCs. Read the key details in Planner settings before enabling it.</p>
          <p>Message Helper remains a separate installation. Install Manager v1.8.19 and Message Helper v1.8.15 on each device, with shared CPR Manager access and verified membership. Confirmed sent assignments sync across devices for the same Torn account. Preparing or sending checks shared history first: unchanged OC IDs/roles are skipped; changed assignments receive an update. Review and send each message using the helper. Connection failures pause sending and retain local receipts for retry. Use Sync sent history or Refresh queue to check an open queue.</p>
        </details>
      </div>`;
    body.querySelector('#blom-help-roster').onclick = configureRosterSync;
    body.querySelector('#blom-help-roster-check').onclick = () => refreshRoster(true, showRosterStatus);
    body.querySelector('#blom-help-shared').onclick = configureSharedAccess;
    body.querySelector('#blom-help-shared-check').onclick = () => alert(sharedStatusText());
    body.querySelector('#blom-help-settings').onclick = () => showManagerTab('settings');
  }

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

  function scriptPresenceRows(records, roster, now = Date.now()) {
    if (!Array.isArray(records) || records.some(row => !row || !/^[1-9]\d*$/.test(String(row.user_id)) || !['check-in','legacy-upload'].includes(row.source) || !Number.isFinite(Date.parse(row.first_seen_at)) || !Number.isFinite(Date.parse(row.last_seen_at)) || Date.parse(row.last_seen_at) < Date.parse(row.first_seen_at) || typeof row.script_version !== 'string') || new Set(records.map(row => String(row.user_id))).size !== records.length) throw new Error('Incomplete or invalid script activity response. Refresh again.');
    const byId = new Map(records.map(row => [String(row.user_id), row]));
    return roster.memberIds.map(id => {
      const record = byId.get(id);
      return {id, record, status: !record ? 'Never seen' : record.source === 'legacy-upload' ? 'Previous CPR upload' : now - Date.parse(record.last_seen_at) <= 7 * 86400000 ? 'Seen in last 7 days' : 'Previously seen'};
    });
  }
  let scriptPresencePollTimer = null;
  function mountScriptPresence(body) {
    const section = document.createElement('div');
    section.className = 'blom-card blom-script-presence';
    section.innerHTML = '<div class="blom-card-title">Member script activity</div><p class="blom-presence-explanation">Sharing ON is required. <strong>Never seen</strong> means unconfirmed installation. <strong>Previous CPR upload</strong> shows historical evidence, not a current check-in.</p><button type="button">Refresh script activity</button><div class="blom-presence-results" aria-live="polite">Activity loads automatically and refreshes every 30 seconds while this tab is open.</div>';
    body.prepend(section);
    section.querySelector('button').onclick = async () => {
      const button = section.querySelector('button'), output = section.querySelector('.blom-presence-results');
      if (button.disabled) return;
      button.disabled = true; if (!output.querySelector?.('table')) output.textContent = 'Loading script activity…';
      try {
        const roster = blRequireRoster(), viewer = blViewer(), token = sharedToken();
        if (roster.factionId !== '50888') throw new Error('Script activity is configured for Black Ledger faction 50888.');
        if (!token) throw new Error('Configure shared Manager access in Settings first.');
        const data = await scriptPresenceRequest('GET', undefined, token);
        if (viewer !== blViewer() || token !== sharedToken()) throw new Error('Account or access changed. Refresh again.');
        const current = blRequireRoster();
        if (current.factionId !== '50888') throw new Error('Faction changed. Refresh again.');
        const rows = scriptPresenceRows(data.records, current).sort((a,b) => memberLabel(a.id).localeCompare(memberLabel(b.id), undefined, {sensitivity:'base',numeric:true}) || a.id.localeCompare(b.id));
        const seen = rows.filter(row => row.record).length;
        const listOpen = output.querySelector?.('.blom-presence-list')?.open === true;
        output.innerHTML = `<p><strong>${seen} / ${rows.length}</strong> members seen · <strong>${rows.length - seen}</strong> never seen. Refreshed ${escapeHtml(new Date().toLocaleString('en-GB', {timeZone:'Europe/London', hour12:false}))}.</p><details class="blom-presence-list"${listOpen ? ' open' : ''}><summary>View member list (${rows.length})</summary><div style="overflow-x:auto"><table class="blom-planner-table"><thead><tr><th>Member</th><th>Evidence</th><th>Version</th><th>First seen</th><th>Last evidence</th></tr></thead><tbody>${rows.map(row => `<tr><td><a href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(row.id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(memberLabel(row.id))}</a></td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.record?.script_version || '—')}</td><td>${row.record ? escapeHtml(new Date(row.record.first_seen_at).toLocaleString('en-GB', {timeZone:'Europe/London', hour12:false})) : '—'}</td><td>${row.record ? escapeHtml(new Date(row.record.last_seen_at).toLocaleString('en-GB', {timeZone:'Europe/London', hour12:false})) : '—'}</td></tr>`).join('')}</tbody></table></div></details>`;
      } catch(error) { output.textContent = error.message || 'Script activity unavailable. Refresh again.'; }
      finally { button.disabled = false; }
    };
    if (scriptPresencePollTimer) clearInterval(scriptPresencePollTimer);
    setTimeout(() => { if (section.isConnected) section.querySelector('button').onclick(); }, 0);
    scriptPresencePollTimer = setInterval(() => {
      if (!section.isConnected) { clearInterval(scriptPresencePollTimer); scriptPresencePollTimer = null; return; }
      if (document.visibilityState === 'visible' && document.hasFocus() && document.querySelector(`#${PANEL_ID} [data-tab="data"].active`)) section.querySelector('button').onclick();
    }, 30000);
  }

  function renderData(body) {

    const members =
      getMembers();

    const rowCount =
      countRows(
        members
      );

    const knownNames =
      Object.keys(
        members
      )
        .filter(
          id =>
            hasRealName(
              id
            )
        )
        .length;

    body.innerHTML = `

      <div class="blom-data-actions">

        <div class="blom-card">

          <div class="blom-card-title">

            <span>
              Local database
            </span>

          </div>

          <div class="blom-stat">

            <strong>

              ${
                Object.keys(
                  members
                ).length
              }

            </strong>

            members

          </div>

          <div class="blom-stat">

            <strong>
              ${rowCount}
            </strong>

            CPR records

          </div>

          <div class="blom-stat">

            <strong>
              ${knownNames}
            </strong>

            usernames identified

          </div>

          <div
            class="blom-muted blom-data-info"
          >

            CPR is collected by Black Ledger OC Smart Role Targets.
            This Manager reads that shared local data and, after a successful
            roster sync, automatically excludes former faction members.

          </div>

        </div>

        <button
          id="blom-roster-status"
          type="button"
        >
          👥 Roster sync status
        </button>

        <button id="blom-cpr-test" type="button">Test TornStats CPR (read-only)</button>

        <button
          id="blom-roster-configure"
          type="button"
        >
          🔐 Configure roster sync
        </button>

        <button
          id="blom-faction-sync"
          type="button"
        >
          🛰 Faction sync status
        </button>

        <button
          id="blom-refresh-names"
          type="button"
        >
          🔄 Scan Torn page for usernames
        </button>

        <button
          id="blom-repair-names"
          type="button"
        >
          🧹 Repair saved usernames
        </button>

        <button
          id="blom-export"
          class="blom-primary"
          type="button"
        >
          Export merged CPR JSON
        </button>

        <button id="blom-export-planner" class="blom-primary" type="button">Export planner diagnostic JSON</button>
        <p class="blom-muted">Includes the fresh scan, dated scores, vacancies, recommendations and invitation holds for troubleshooting.</p>

        <button
          id="blom-import"
          type="button"
        >
          Import / merge CPR JSON
        </button>

        <input
          id="blom-import-file"
          type="file"
          accept="application/json,.json"
          hidden
        >

      </div>

      <div class="blom-note">

        Imported CPR never lowers an existing value.

        If the same member / crime / role exists
        in both datasets, the highest CPR is kept.

      </div>
    `;

    mountScriptPresence(body);

    body
      .querySelector(
        "#blom-refresh-names"
      )
      .addEventListener(
        "click",
        () => {

          scanVisibleNames();

          alert(
            "Username scan complete."
          );

          renderData(
            body
          );
        }
      );

    body.querySelector("#blom-roster-status")
      .addEventListener("click", () => refreshRoster(true, showRosterStatus));

    body.querySelector("#blom-cpr-test").addEventListener("click", testTornStatsCpr);

    body.querySelector("#blom-roster-configure")
      .addEventListener("click", configureRosterSync);

    body.querySelector("#blom-faction-sync")
      .addEventListener("click", () => { alert(sharedStatusText()); });

    body
      .querySelector(
        "#blom-repair-names"
      )
      .addEventListener(
        "click",
        () => {

          repairStoredNames();

          alert(
            "Saved username repair complete."
          );

          renderData(
            body
          );
        }
      );

    body
      .querySelector(
        "#blom-export"
      )
      .addEventListener(
        "click",
        exportMergedData
      );

    body.querySelector('#blom-export-planner').addEventListener('click',exportPlannerDiagnostic);

    const input =
      body.querySelector(
        "#blom-import-file"
      );

    body
      .querySelector(
        "#blom-import"
      )
      .addEventListener(
        "click",
        () =>
          input.click()
      );

    input.addEventListener(
      "change",
      async () => {

        const file =
          input.files?.[0];

        if (!file) {
          return;
        }

        try {

          const parsed =
            JSON.parse(
              await file.text()
            );

          const stats =
            importMergedData(
              parsed
            );

          alert(

            `Black Ledger CPR merge complete.\n\n` +

            `Added/updated: ${stats.updated}\n` +

            `Ignored lower/equal: ${stats.ignored}`
          );

          renderData(
            body
          );

        } catch (
          error
        ) {

          alert(

            `Could not import CPR file:\n` +

            error.message
          );
        }
      }
    );
    renderCompletedHistory(body);
  }

  /*
   * ============================================================
   * CPR CANDIDATES
   * ============================================================
   */

  function getCandidates(crimeName, roleKey, members = getMembers()) {
    const wanted = normalize(roleKey), candidates = [];
    for (const [id, crimes] of Object.entries(members)) {
      const roles = findCrimeRoles(crimes, crimeName);
      if (!roles) continue;
      let match = Object.entries(roles).find(([role]) => normalize(role) === wanted);
      // An unnumbered role may estimate a numbered role; another numbered role cannot.
      if (!match && /\d+$/.test(wanted))
        match = Object.entries(roles).find(([role]) => normalize(role) === wanted.replace(/\d+$/, ''));
      if (!match || match[1] === null || match[1] === undefined || match[1] === '' || typeof match[1] === 'boolean') continue;
      const cpr = Number(match[1]);
      if (Number.isFinite(cpr) && cpr >= 0 && cpr <= 100) candidates.push({id, cpr});
    }
    return candidates.sort((a,b) => b.cpr-a.cpr || memberLabel(a.id).localeCompare(memberLabel(b.id)));
  }

  function findCrimeRoles(
    crimes,
    crimeName
  ) {

    const wanted =
      normalize(
        crimeName
      );

    for (
      const [
        crime,
        roles
      ]
      of Object.entries(
        crimes ||
        {}
      )
    ) {

      if (
        normalize(
          crime
        ) ===
        wanted
      ) {
        return roles;
      }
    }

    return null;
  }

  /*
   * ============================================================
   * TARGET MODEL
   * ============================================================
   */

  function roleTarget(
    base,
    weight,
    roleCount
  ) {

    const equalShare =
      100 /
      Math.max(
        1,
        roleCount
      );

    const relative =
      weight /
      equalShare;

    let bonus =
      0;

    if (
      relative >=
      2.5
    ) {
      bonus =
        5;
    }

    else if (
      relative >=
      2.0
    ) {
      bonus =
        3;
    }

    else if (
      relative >=
      1.5
    ) {
      bonus =
        2;
    }

    else if (
      relative >=
      1.25
    ) {
      bonus =
        1;
    }

    return clamp(
      base +
        bonus,

      50,
      100
    );
  }

  function baseTargetForLevel(level) {
    const numeric = Number(level);
    if (numeric <= 5) return 60;
    if (numeric <= 8) return 66;
    return 65;
  }

  /*
   * ============================================================
   * LEGACY CRIME LIST COMPATIBILITY
   *
   * Kept for upgrade safety, but never invoked. CPR collection is owned by
   * My OC Smart Role Targets.
   * ============================================================
   */

  function hookCrimeListFetch() {

    if (
      fetchHooked
    ) {
      return;
    }

    const target =
      typeof unsafeWindow !==
      "undefined"
        ? unsafeWindow
        : window;

    if (
      typeof target.fetch !==
      "function"
    ) {
      return;
    }

    const originalFetch =
      target.fetch;

    if (
      originalFetch
        .blackLedgerManagerHooked
    ) {

      fetchHooked =
        true;

      return;
    }

    const hookedFetch =
      function (
        ...args
      ) {

        const promise =
          originalFetch.apply(
            this,
            args
          );

        const input =
          args[0];

        const url =
          typeof input ===
          "string"

            ? input

            : input?.url ||
              String(
                input ||
                ""
              );

        if (
          url.includes(
            "crimeList"
          )
        ) {

          promise
            .then(
              response =>
                response
                  .clone()
                  .json()
            )

            .then(
              recordCrimeList
            )

            .catch(
              error =>

                console.warn(
                  "[Black Ledger OC Manager] " +
                  "Could not record crimeList:",
                  error
                )
            );
        }

        return promise;
      };

    hookedFetch
      .blackLedgerManagerHooked =
      true;

    target.fetch =
      hookedFetch;

    fetchHooked =
      true;
  }

  function recordCrimeList(data) {

    const crimes =
      data?.data;

    if (
      !Array.isArray(
        crimes
      )
    ) {
      return;
    }

    const members =
      getMembers(true);

    const levels =
      readJSON(
        CPR_LEVEL_KEY,
        {}
      );

    const viewerId =
      getViewerId();

    let cprChanged =
      false;

    let metaChanged =
      false;

    for (
      const crime
      of crimes
    ) {

      const scenario =
        crime?.scenario;

      const crimeName =
        scenario?.name;

      if (!crimeName) {
        continue;
      }

      const roles =
        [];

      for (
        const slot
        of crime.playerSlots ||
        []
      ) {

        const role =
          slot?.name;

        if (!role) {
          continue;
        }

        if (
          !roles.includes(
            role
          )
        ) {
          roles.push(
            role
          );
        }

        const actualMemberId =
          slot?.player?.ID;

        /*
         * Filled slot:
         * use that member.
         *
         * Empty slot:
         * Torn exposes the viewing player's CPR,
         * so record it against the viewer.
         */

        const memberId =
          actualMemberId ||
          viewerId;

        const cpr =
          Number(
            slot?.successChance
          );

        if (
          memberId &&
          Number.isFinite(
            cpr
          )
        ) {

          const id =
            String(
              memberId
            );

          const memberCrimes =
            (
              members[
                id
              ] ??=
                {}
            );

          const crimeRoles =
            (
              memberCrimes[
                crimeName
              ] ??=
                {}
            );

          const existing =
            Number(
              crimeRoles[
                role
              ]
            );

          /*
           * Preserve highest observed CPR,
           * same behaviour as Smart Role Targets.
           */

          if (
            !Number.isFinite(
              existing
            ) ||
            cpr >
              existing
          ) {

            crimeRoles[
              role
            ] =
              cpr;

            cprChanged =
              true;
          }

          meta.seen[
            seenKey(
              id,
              crimeName,
              role
            )
          ] =
            new Date()
              .toISOString();

          metaChanged =
            true;
        }

        /*
         * Real member names only exist on
         * occupied slots.
         */

        if (
          actualMemberId
        ) {

          const id =
            String(
              actualMemberId
            );

          const candidateName =
            firstValidName(

              slot?.player?.name,

              slot?.player?.username,

              slot?.player?.playerName
            );

          if (
            candidateName &&
            meta.names[
              id
            ] !==
              candidateName
          ) {

            meta.names[
              id
            ] =
              candidateName;

            metaChanged =
              true;
          }
        }
      }

      if (
        Number.isFinite(
          Number(
            scenario?.level
          )
        )
      ) {

        levels[
          crimeName
        ] = {

          ...(
            levels[
              crimeName
            ] ||
            {}
          ),

          level:
            Number(
              scenario.level
            ),

          difficulty:
            DIFFICULTY_TIERS[
              scenario
                ?.difficultyTier
            ] ||
            levels[
              crimeName
            ]?.difficulty ||
            null,

          roles
        };
      }
    }

    if (
      cprChanged
    ) {

      blStorageSet(
        CPR_DATA_KEY,
        JSON.stringify(
          blForWrite(CPR_DATA_KEY,members)
        )
      );
    }

    blStorageSet(
      CPR_LEVEL_KEY,
      JSON.stringify(
        levels
      )
    );

    if (
      metaChanged
    ) {
      saveMeta();
    }
  }

  function getViewerId() {

    try {

      return (
        JSON.parse(
          document
            .getElementById(
              "torn-user"
            )
            ?.value ||
          "null"
        )?.id ||
        null
      );

    } catch (_) {

      return null;
    }
  }

  /*
   * ============================================================
   * USERNAME COLLECTION
   * ============================================================
   */

  let visibleNameScanTimer = null;
  function scheduleVisibleNameScan() {
    // Batch Torn's many DOM updates instead of scanning all profile links for each one.
    if (visibleNameScanTimer) return;
    visibleNameScanTimer = setTimeout(() => {visibleNameScanTimer = null; scanVisibleNames();}, 1000);
  }
  function scanVisibleNames() {
    if(document.visibilityState!=='visible' || !document.hasFocus())return;

    if (!document.body) {
      return;
    }

    let changed =
      false;

    document
      .querySelectorAll(
        'a[href*="XID="]'
      )

      .forEach(
        link => {

          if (
            link.closest(
              `#${PANEL_ID}`
            ) ||

            link.dataset
              .blomGenerated ===
              "1"
          ) {
            return;
          }

          const href =
            link.getAttribute(
              "href"
            ) ||
            "";

          const match =
            href.match(
              /XID=(\d+)/
            );

          if (!match) {
            return;
          }

          const id =
            match[1];

          /*
           * Don't replace a valid username with
           * weaker page text.
           */

          if (
            hasRealName(
              id
            )
          ) {
            return;
          }

          const name =
            getBestNameFromLink(
              link
            );

          if (name) {

            meta.names[
              id
            ] =
              name;

            changed =
              true;
          }
        }
      );

    if (
      changed
    ) {
      saveMeta();
    }
  }

  function getBestNameFromLink(
    link
  ) {

    const candidates = [

      link.getAttribute(
        "data-user-name"
      ),

      link.getAttribute(
        "data-name"
      ),

      link.getAttribute(
        "aria-label"
      ),

      cleanText(
        link.textContent
      ),

      link.querySelector(
        "img"
      )?.getAttribute(
        "alt"
      )
    ];

    const parent =
      link.parentElement;

    if (parent) {

      const nameNodes =
        parent.querySelectorAll(

          '[class*="name"],' +

          '[class*="user"],' +

          '[class*="player"]'
        );

      for (
        const node
        of nameNodes
      ) {

        if (
          node.closest(
            `#${PANEL_ID}`
          )
        ) {
          continue;
        }

        candidates.push(
          cleanText(
            node.textContent
          )
        );
      }
    }

    return firstValidName(
      ...candidates
    );
  }

  function firstValidName(
    ...values
  ) {

    for (
      const value
      of values
    ) {

      const cleaned =
        normaliseUsernameCandidate(
          value
        );

      if (
        isValidName(
          cleaned
        )
      ) {
        return cleaned;
      }
    }

    return null;
  }

  function normaliseUsernameCandidate(
    value
  ) {

    let text =
      cleanText(
        value
      );

    if (!text) {
      return "";
    }

    text = text.replace(/^name\s*:\s*/i, "");

    text =
      text.replace(
        /^view\s+profile\s+of\s+/i,
        ""
      );

    text =
      text.replace(
        /^view\s+profile\s*[:\-]\s*/i,
        ""
      );

    text =
      text.replace(
        /^profile\s+of\s+/i,
        ""
      );

    text =
      text.replace(
        /^open\s+profile\s+of\s+/i,
        ""
      );

    text =
      text.replace(
        /\s*\[\d+\]\s*$/,
        ""
      );

    return cleanText(
      text
    );
  }

  function isValidName(value) {

    if (!value) {
      return false;
    }

    const text =
      cleanText(
        value
      );

    if (
      text.length <
        2 ||

      text.length >
        32
    ) {
      return false;
    }

    if (
      /^\d+$/.test(
        text
      )
    ) {
      return false;
    }

    if (
      /^torn\s+id\s+\d+$/i
        .test(
          text
        )
    ) {
      return false;
    }

    if (
      /^member\s+\d+$/i
        .test(
          text
        )
    ) {
      return false;
    }

    if (
      BAD_NAMES.has(
        text.toLowerCase()
      )
    ) {
      return false;
    }

    if (
      /^(online|offline|okay|hospital|traveling|federal)$/i
        .test(
          text
        )
    ) {
      return false;
    }

    return true;
  }

  function repairStoredNames() {

    let changed =
      false;

    for (
      const [
        id,
        rawName
      ]
      of Object.entries(
        meta.names ||
        {}
      )
    ) {

      const repaired =
        normaliseUsernameCandidate(
          rawName
        );

      if (
        !isValidName(
          repaired
        )
      ) {

        delete meta.names[
          id
        ];

        changed =
          true;

        continue;
      }

      if (
        repaired !==
        rawName
      ) {

        meta.names[
          id
        ] =
          repaired;

        changed =
          true;
      }
    }

    if (
      changed
    ) {
      saveMeta();
    }
  }

  /*
   * ============================================================
   * IMPORT / EXPORT
   * ============================================================
   */

  function plannerDiagnosticExport(state,plan,prefs,assessment,now=Date.now()) {
    if(!state?.shared || !state.complete || !Number.isFinite(state.scannedAt) || now<state.scannedAt || now-state.scannedAt>=300000)throw new Error('Run Fresh shared scan on the OC page, then export the planner diagnostic within five minutes.');
    // Explicit field selection: never serialize browser storage, access codes,
    // API keys, session data, message bodies or arbitrary snapshot properties.
    const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]===null || ['string','number','boolean'].includes(typeof value?.[key])).map(key=>[key,typeof value[key]==='number' && !Number.isFinite(value[key])?String(value[key]):value[key]]));
    const slotKeys=['key','crimeId','crime','role','level','weight','roleCount','opening','startable','openingUnsupported','openingHoldReason','expiresAt','expiresKnown','stallAt','coverageSource','emptySlots','filledSlots','itemId'];
    const fit=value=>({...pick(value,[...slotKeys,'cpr','target','kind','source','seen','stale','confidence','margin','joinByAt','planningStartAt','queueWaitHours','conditionalPlanning','capabilityLevel','assignmentPriority','trialPlacement','idleExistingFallback','idleL8Fallback','l8PlacementPriority','rebalancedExisting','l8Shortfall']),...(value?.estimatedFrom?{estimatedFrom:pick(value.estimatedFrom,['crime','role','level','cpr','method','peerCount','adjustment','allowance'])}:{})});
    const assignments=map=>[...(map || new Map())].map(([id,value])=>({member_id:String(id),fit:fit(value)}));
    const owners=new Map([...plan.now,...plan.next].map(([id,value])=>[value.key,{member_id:String(id),future:plan.next.has(id),sent:plan.mailedHeld.has(String(id))}]));
    const eligibility=plan.available.flatMap(member=>(plan.active.open || []).map(slot=>{
      const id=String(member.id),observed=plannerObservation(id,slot.crime,slot.role,true),estimated=observed?null:plannerEstimatedRole(id,slot),match=plannerFit(id,slot,prefs);
      return {member_id:id,slot_key:slot.key,target:mainScriptTarget(slot.crime,slot.level,slot.weight,slot.roleCount,slot.role),level_floor:plannerLevelFloor(id,prefs),observed:observed?fit(observed):null,estimated:estimated?fit(estimated):null,eligible:!!match,owner:owners.get(slot.key) || null};
    }));
    return {format:'black-ledger-planner-diagnostic-v1',manager_version:typeof GM_info!=='undefined'?String(GM_info.script?.version || '1.9.21'):'1.9.21',exported_at:new Date(now).toISOString(),
      snapshot:{...pick(state,['version','complete','shared','revision','scannedAt','scanStartedAt','factionId','viewerId']),
        members:(state.members || []).map(m=>({...pick(m,['id','name','is_in_oc','ocEligible']),status:pick(m.status,['state'])})),
        crimes:(state.crimes || []).map(crime=>({...pick(crime,['id','name','difficulty','status','isExpiring','ready_at','expired_at','pageScan','planningPhase','planningSecondsPerSlot','planningObservedAt']),slots:(crime.slots || []).map(slot=>({...pick(slot,['position','planningPercent','planningState']),position_info:pick(slot.position_info,['label']),user:slot.user===null?null:slot.user?pick(slot.user,['id','name']):undefined,item_requirement:pick(slot.item_requirement,['id'])}))})),
        profiles:(state.profiles || []).map(profile=>pick(profile,['user_id','crime','role','latest_cpr','last_observed_at'])),
        weights:Object.fromEntries(Object.entries(state.weights || {}).map(([crime,def])=>[crime,{level:Number(def.level),roles:Object.fromEntries(Object.entries(def.roles || {}).filter(([,weight])=>typeof weight==='number' && Number.isFinite(weight)))}])),
        targetPolicy:pick(state.targetPolicy,['schema_version','offset','min','max']),learning:(state.learning || []).map(row=>pick(row,['crime','successes','failures']))},
      preferences:{levels:plannerSelectedLevels(prefs),includeStale:prefs.includeStale===true,asOf:prefs.asOf,spawnBrackets:true,spawnBudget:{...pick(prefs.spawnBudget,['balance','reserve','updatedAt']),knownCrimeIds:(prefs.spawnBudget?.knownCrimeIds || []).map(String).filter(id=>/^\d+$/.test(id))}},
      plan:{available:plan.available.map(member=>String(member.id)),now:assignments(plan.now),next:assignments(plan.next),coverageReservations:assignments(plan.coverageReservations),mailedHeld:[...plan.mailedHeld].map(String),open:(plan.active.open || []).map(fit),deferred:(plan.deferred || []).map(fit),releases:(plan.active.releases?.rows || []).map(row=>({...pick(row,['crimeId','crime','status','expectedAt','kind','reason','memberCount','vacancies']),memberIds:(row.memberIds || []).map(String)})),spawningBlocked:!!plan.spawningBlocked,assignmentConflicts:(plan.assignmentConflicts || []).map(issue=>({...pick(issue,['id','reason','action','canKeep','target','cpr']),destinations:(issue.destinations || []).map(destination=>pick(destination,['crimeId','crime','role']))})),
        workOrders:plannerMemberWorkOrders(plan,assessment,prefs).map(row=>({member_id:String(row.member.id),kind:row.kind,priority:row.priority,text:row.text})),eligibility},
      releaseStart:assessment.releaseStart?{...pick(assessment.releaseStart,['startAt','level','label','scopeReady','scopeReason','canSpendNow','conditional']),currentIds:assessment.releaseStart.currentIds.map(String),releases:assessment.releaseStart.releases.map(row=>({...pick(row,['crimeId','crime','expectedAt']),memberIds:row.memberIds.map(String)})),outcomes:assessment.releaseStart.outcomes.map(outcome=>({crime:outcome.crime,level:outcome.level,schedule:outcome.schedule.map(row=>({...pick(row,['id','name','availableHours','joinByHours','expectedJoinAt','joinByAt','currentlyFree']),fit:fit(row.fit)}))}))}:null,
      spawn:{crews:(assessment.needed.crews || []).map(crew=>({...pick(crew,['label','level','partial','readyHours']),ids:(crew.ids || []).map(String)})),brackets:(assessment.preparation?.levels || []).map(level=>({...pick(level,['level','dailyCovered','seeded']),outcomes:(level.outcomes || []).map(outcome=>({crime:outcome.crime,complete:outcome.daily?.complete===true,uncertain:outcome.plannedUncertain,schedule:(outcome.daily?.schedule || []).map(row=>({member_id:String(row.id),availableHours:row.availableHours,joinByHours:row.joinByHours,fit:fit(row.fit)}))}))}))}};
  }

  function plannerDiagnosticSummary(diagnostic) {
    const snapshot=diagnostic.snapshot,plan=diagnostic.plan,names=new Map(snapshot.members.map(member=>[String(member.id),member.name || String(member.id)]));
    const blocked=plan.workOrders.filter(row=>row.kind!=='assigned'),slots=new Map(plan.open.map(slot=>[slot.key,slot]));
    const lines=[`Black Ledger planner diagnostic · Manager ${diagnostic.manager_version}`,`Revision ${snapshot.revision} · scan ${new Date(snapshot.scannedAt).toISOString()}`,`${plan.available.length} free · ${plan.now.length} assigned · ${plan.next.length} forecast · ${plan.workOrders.filter(row=>row.kind==='manager-action').length} actions required · ${plan.workOrders.filter(row=>row.kind==='new-start').length} conditional new-start candidates`,`${snapshot.profiles.length} score records; ${snapshot.profiles.filter(row=>row.last_observed_at).length} dated`,
      'Selected levels: '+diagnostic.preferences.levels.join(', ')];
    for(const release of plan.releases || [])if(release.kind==='scanned')lines.push('Expected full-crew release: '+release.crime+' #'+release.crimeId+' · '+new Date(release.expectedAt).toISOString()+' · '+release.memberIds.map(id=>names.get(String(id)) || id).join(', ')+' · confirm completion before use');
    if(diagnostic.releaseStart)lines.push('Conditional next start: '+diagnostic.releaseStart.label+' from '+new Date(diagnostic.releaseStart.startAt).toISOString()+'; verify release, Fresh shared scan and Scope before spawning.');
    for(const row of blocked){
      const id=String(row.member_id);lines.push('',`${names.get(id) || id} [${id}]`,row.text);
      for(const profile of snapshot.profiles.filter(profile=>String(profile.user_id)===id))lines.push(`Recorded: ${profile.crime} / ${profile.role}: ${profile.latest_cpr}% · ${profile.last_observed_at || 'undated'}`);
      for(const check of plan.eligibility.filter(check=>check.member_id===id)){
        const slot=slots.get(check.slot_key);if(!slot || slot.level<check.level_floor.minimum)continue;
        const evidence=check.observed || check.estimated;
        const owner=check.owner?` · held by ${names.get(check.owner.member_id) || check.owner.member_id} (${check.owner.sent?'sent':check.owner.future?'forecast':'unsent current'})`:'';
        lines.push(`L${slot.level} ${slot.crime} #${slot.crimeId} / ${slot.role}: ${evidence?evidence.cpr+'% '+evidence.kind:'no usable score/estimate'} / target ${check.target}%${owner}${slot.openingUnsupported?' · opening held':''}`);
        if(evidence?.source)lines.push('  '+evidence.source);
      }
    }
    return lines.join('\n');
  }

  function showPlannerDiagnostic(diagnostic,filename) {
    const button=document.getElementById('blom-export-planner');
    if(!button)throw new Error('Open the Data tab and export again.');
    document.getElementById('blom-planner-diagnostic-result')?.remove();
    const box=document.createElement('section');box.id='blom-planner-diagnostic-result';box.className='blom-planner-diagnostic-result';
    const heading=document.createElement('strong');heading.textContent='Planner diagnostic ready';box.appendChild(heading);
    const description=document.createElement('p');description.textContent='If PDA does not save the download, copy the summary below and paste it into this chat. You can also share the full JSON file when supported.';box.appendChild(description);
    const status=document.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');box.appendChild(status);
    const summary=document.createElement('textarea');summary.readOnly=true;summary.rows=10;summary.setAttribute('aria-label','Planner diagnostic summary');summary.value=plannerDiagnosticSummary(diagnostic);
    const actions=document.createElement('div');actions.className='blom-diagnostic-actions';box.appendChild(actions);
    const action=(label,fn)=>{const node=document.createElement('button');node.type='button';node.className='blom-primary';node.textContent=label;node.addEventListener('click',fn);actions.appendChild(node);return node;};
    action('Copy diagnostic summary',async()=>{
      try{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText(summary.value);status.textContent='Summary copied. Paste it into this chat.';}
      catch(_){summary.focus();summary.select();summary.setSelectionRange(0,summary.value.length);status.textContent='Summary selected. Use your device Copy command, then paste it into this chat.';}
    });
    const download=()=>{try{downloadJSON(diagnostic,filename);status.textContent='Diagnostic ready; download requested. If no file appears in PDA, use Copy diagnostic summary.';}catch(_){status.textContent='This app could not download the file. Use Copy diagnostic summary below.';}};
    action('Download JSON again',download);
    try{
      const file=typeof File==='function'?new File([JSON.stringify(diagnostic,null,2)],filename,{type:'application/json'}):null;
      if(file && typeof navigator.share==='function' && typeof navigator.canShare==='function' && navigator.canShare({files:[file]}))action('Share JSON file',async()=>{
        try{await navigator.share({files:[file],title:'Black Ledger planner diagnostic'});status.textContent='File shared. You can attach it to this chat.';}
        catch(error){status.textContent=error?.name==='AbortError'?'Sharing cancelled. The diagnostic is still available below.':'Sharing is unavailable here. Use Copy diagnostic summary.';}
      });
    }catch(_){}
    box.appendChild(summary);button.insertAdjacentElement('afterend',box);download();
    box.scrollIntoView({block:'nearest'});
  }

  function exportPlannerDiagnostic() {
    const model=inlinePlannerModel();
    if(!model){alert('Run Fresh shared scan on the OC page, then export the planner diagnostic within five minutes.');return;}
    const previous=plannerInputContext;plannerInputContext=model.state;
    try{
      const prefs={...model.state.prefs,asOf:model.state.scannedAt,spawnBrackets:true,spawnBudget:applyLiveScopeBudget(model.state.prefs),learning:model.state.learning || []};
      const assessment=plannerSpareSpawnAssessment(model.plan,model.state,prefs);
      const diagnostic=plannerDiagnosticExport(model.state,model.plan,prefs,assessment);
      showPlannerDiagnostic(diagnostic,'black_ledger_planner_diagnostic_'+new Date().toISOString().slice(0,10)+'.json');
    }catch(error){alert('Could not export planner diagnostic: '+String(error.message || error));}
    finally{plannerInputContext=previous;}
  }

  function exportMergedData() {

    const members =
      getMembers();

    const levels =
      readJSON(
        CPR_LEVEL_KEY,
        {}
      );

    const rows =
      [];

    for (
      const [
        userId,
        crimes
      ]
      of Object.entries(
        members
      )
    ) {

      for (
        const [
          crime,
          roles
        ]
        of Object.entries(
          crimes ||
          {}
        )
      ) {

        for (
          const [
            role,
            cpr
          ]
          of Object.entries(
            roles ||
            {}
          )
        ) {

          rows.push({

            user_id:
              Number(
                userId
              ),

            user_name:
              hasRealName(
                userId
              )
                ? meta.names[
                    userId
                  ]
                : null,

            crime,

            role,

            cpr:
              Number(
                cpr
              ),

            crime_level:
              levels[
                crime
              ]?.level ??
              getCrimeLevel(
                crime
              ),

            last_seen:
              getSeen(
                userId,
                crime,
                role
              ),

            source:
              "black-ledger-manager"
          });
        }
      }
    }

    downloadJSON(

      {

        format:
          "black-ledger-oc-manager-v5",

        exported_at:
          new Date()
            .toISOString(),

        member_count:
          Object.keys(
            members
          ).length,

        row_count:
          rows.length,

        rows
      },

      `black_ledger_cpr_${
        new Date()
          .toISOString()
          .slice(
            0,
            10
          )
      }.json`
    );
  }

  function importMergedData(
    payload
  ) {

    const rows =
      Array.isArray(
        payload
      )
        ? payload
        : payload?.rows;

    if (
      !Array.isArray(
        rows
      )
    ) {

      throw new Error(
        "No rows array found in this JSON file."
      );
    }

    const members =
      getMembers(true);

    const levels =
      readJSON(
        CPR_LEVEL_KEY,
        {}
      );

    let updated =
      0;

    let ignored =
      0;

    for (
      const row
      of rows
    ) {

      const id =
        row?.user_id ??
        row?.userId ??
        row?.id;

      const crime =
        row?.crime;

      const role =
        row?.role;

      const cpr =
        Number(
          row?.cpr ??
          row?.successChance
        );

      if (
        !id ||
        !crime ||
        !role ||
        !Number.isFinite(
          cpr
        )
      ) {
        continue;
      }

      const userId =
        String(
          id
        );

      const memberCrimes =
        (
          members[
            userId
          ] ??=
            {}
        );

      const crimeRoles =
        (
          memberCrimes[
            crime
          ] ??=
            {}
        );

      const existing =
        Number(
          crimeRoles[
            role
          ]
        );

      if (
        !Number.isFinite(
          existing
        ) ||
        cpr >
          existing
      ) {

        crimeRoles[
          role
        ] =
          cpr;

        updated++;

      } else {

        ignored++;
      }

      const importedName =
        firstValidName(

          row?.user_name,

          row?.userName,

          row?.name
        );

      if (
        importedName
      ) {

        meta.names[
          userId
        ] =
          importedName;
      }

      if (
        row?.last_seen
      ) {

        meta.seen[
          seenKey(
            userId,
            crime,
            role
          )
        ] =
          row.last_seen;
      }

      if (
        Number.isFinite(
          Number(
            row?.crime_level
          )
        )
      ) {

        levels[
          crime
        ] = {

          ...(
            levels[
              crime
            ] ||
            {}
          ),

          level:
            Number(
              row.crime_level
            )
        };
      }
    }

    blStorageSet(
      CPR_DATA_KEY,
      JSON.stringify(
        blForWrite(CPR_DATA_KEY,members)
      )
    );

    blStorageSet(
      CPR_LEVEL_KEY,
      JSON.stringify(
        levels
      )
    );

    meta.importedAt =
      new Date()
        .toISOString();

    saveMeta();

    return {
      updated,
      ignored
    };
  }

  /*
   * ============================================================
   * DATA HELPERS
   * ============================================================
   */

  function getMembers(includeFormer = false) {

    const members = blFilterStore(CPR_DATA_KEY,mergeManagerMembers(readJSON(
      CPR_DATA_KEY,
      {}
    )));

    /* Until a roster has successfully loaded, preserve the existing local
     * view. Once it has, all planning, exports and sync use active members. */
    const roster=getRosterSnapshot();
    const rosterAge=Date.now()-Date.parse(roster?.fetched_at);
    if (blRoster()!==null || includeFormer || !hasRoster() || !Number.isFinite(rosterAge) || rosterAge<0 || rosterAge>ROSTER_REFRESH_MS) {
      return members;
    }

    return Object.fromEntries(
      Object.entries(members).filter(
        ([id]) => isCurrentRosterMember(id)
      )
    );
  }

  function getCrimeLevel(
    crimeName
  ) {

    const known =
      Object.entries(
        OC_DEFS
      )

        .find(
          ([name]) =>
            normalize(
              name
            ) ===
            normalize(
              crimeName
            )
        );

    if (known) {
      return known[1]
        .level;
    }

    const levels =
      readJSON(
        CPR_LEVEL_KEY,
        {}
      );

    for (
      const [
        crime,
        info
      ]
      of Object.entries(
        levels
      )
    ) {

      if (
        normalize(
          crime
        ) ===
          normalize(
            crimeName
          ) &&

        Number.isFinite(
          Number(
            info?.level
          )
        )
      ) {

        return Number(
          info.level
        );
      }
    }

    return null;
  }

  function getSeen(
    id,
    crime,
    role
  ) {

    return (
      meta.seen[
        seenKey(
          id,
          crime,
          role
        )
      ] ||
      null
    );
  }

  function seenKey(
    id,
    crime,
    role
  ) {

    return (
      `${id}|` +
      `${normalize(crime)}|` +
      `${normalize(role)}`
    );
  }

  function saveMeta() {
    if(blRoster()===false)return;
    const saved=readJSON(MANAGER_META_KEY,{names:{},seen:{}});
    meta=blForWrite(MANAGER_META_KEY,{...meta,names:{...saved.names,...meta.names},seen:{...saved.seen,...meta.seen}});

    // Do not restore rejected labels from the saved metadata during merging.
    for(const [id,name] of Object.entries(meta.names || {})) {
      if(!isValidName(name))delete meta.names[id];
    }
    blStorageSet(
      MANAGER_META_KEY,
      JSON.stringify(
        meta
      )
    );
  }

  /*
   * ============================================================
   * DISPLAY HELPERS
   * ============================================================
   */

  function hasRealName(id) {

    return isValidName(
      meta.names[
        id
      ]
    );
  }

  function memberLabel(id) {

    if (
      hasRealName(
        id
      )
    ) {

      return meta.names[
        id
      ];
    }

    return `Torn ID ${id}`;
  }

  function memberLink(id) {

    const label =
      memberLabel(
        id
      );

    return `

      <a
        class="blom-member"
        href="https://www.torn.com/profiles.php?XID=${encodeURIComponent(id)}"
        target="_blank"
        rel="noopener noreferrer"
        data-blom-generated="1"
      >

        ${escapeHtml(label)}

      </a>
    `;
  }

  function stateBadge(
    cpr,
    target
  ) {

    const pass =
      cpr >=
      target;

    return `

      <span
        class="${
          pass
            ? "blom-pass"
            : "blom-fail"
        }"
      >

        ${
          pass
            ? "PASS"
            : "LOW"
        }

      </span>
    `;
  }

  function prettyRole(role) {

    return String(
      role
    )

      .replace(
        /([a-z])([A-Z])/g,
        "$1 $2"
      )

      .replace(
        /(\D)(\d+)$/,
        "$1 $2"
      );
  }

  function formatCpr(value) {

    const number =
      Number(
        value
      );

    if (
      !Number.isFinite(
        number
      )
    ) {
      return "—";
    }

    return Number.isInteger(
      number
    )
      ? `${number}%`
      : `${number.toFixed(1)}%`;
  }

  function formatDate(value) {

    const date =
      new Date(
        value
      );

    return Number.isNaN(
      date.getTime()
    )
      ? "Unknown"
      : date.toLocaleDateString('en-GB', {timeZone:'Europe/London'});
  }

  function countRows(
    members
  ) {

    let count =
      0;

    for (
      const crimes
      of Object.values(
        members
      )
    ) {

      for (
        const roles
        of Object.values(
          crimes ||
          {}
        )
      ) {

        count +=
          Object.keys(
            roles ||
            {}
          ).length;
      }
    }

    return count;
  }

  /*
   * ============================================================
   * GENERIC HELPERS
   * ============================================================
   */

  function readJSON(
    key,
    fallback
  ) {

    try {

      const parsed =
        JSON.parse(
          blStorageGet(
            key
          ) ||
          "null"
        );

      return (
        parsed &&
        typeof parsed ===
          "object"
      )
        ? blFilterStore(key,parsed)
        : fallback;

    } catch (_) {

      return fallback;
    }
  }

  function downloadJSON(
    data,
    filename
  ) {

    const url =
      URL.createObjectURL(

        new Blob(
          [
            JSON.stringify(
              data,
              null,
              2
            )
          ],

          {
            type:
              "application/json"
          }
        )
      );

    const link =
      document.createElement(
        "a"
      );

    link.href =
      url;

    link.download =
      filename;

    document.body.appendChild(
      link
    );

    link.click();

    link.remove();

    setTimeout(
      () =>
        URL.revokeObjectURL(
          url
        ),
      1000
    );
  }

  function normalize(value) {

    return String(
      value ||
      ""
    )

      .normalize(
        "NFKD"
      )

      .replace(
        /[\u0300-\u036f]/g,
        ""
      )

      .toLowerCase()

      .replace(
        /[^a-z0-9]/g,
        ""
      );
  }

  function cleanText(value) {

    return String(
      value ||
      ""
    )

      .replace(
        /\s+/g,
        " "
      )

      .trim();
  }

  function clamp(
    value,
    minimum,
    maximum
  ) {

    return Math.min(
      maximum,

      Math.max(
        minimum,
        value
      )
    );
  }

  function escapeHtml(value) {

    return String(
      value ??
      ""
    )

      .replace(
        /&/g,
        "&amp;"
      )

      .replace(
        /</g,
        "&lt;"
      )

      .replace(
        />/g,
        "&gt;"
      )

      .replace(
        /"/g,
        "&quot;"
      )

      .replace(
        /'/g,
        "&#039;"
      );
  }

  function escapeAttr(value) {

    return escapeHtml(
      value
    );
  }

  /*
   * ============================================================
   * CSS
   * ============================================================
   */

  function injectStyles() {

    if (
      document.getElementById(
        STYLE_ID
      )
    ) {
      return;
    }

    const style =
      document.createElement(
        "style"
      );

    style.id =
      STYLE_ID;

    style.textContent = `

      /*
       * ========================================================
       * IN-PAGE LAUNCHER
       * ========================================================
       */

      #${SMART_SETTINGS_ID}
      #${LAUNCHER_ID} {

        position:
          static !important;

        flex:
          0 0 auto !important;

        margin-left:
          7px !important;

        border:
          1px solid
          rgba(
            87,
            199,
            255,
            .7
          ) !important;

        border-radius:
          14px !important;

        padding:
          5px 10px !important;

        background:
          rgba(
            47,
            111,
            165,
            .18
          ) !important;

        color:
          inherit !important;

        font-size:
          11px !important;

        font-weight:
          700 !important;

        line-height:
          1.2 !important;

        cursor:
          pointer !important;

        box-shadow:
          none !important;
      }

      #${SMART_SETTINGS_ID}
      #${LAUNCHER_ID}:hover {

        background:
          rgba(
            47,
            111,
            165,
            .3
          ) !important;
      }

      /*
       * Old-script fallback position.
       */

      #${FALLBACK_HOST_ID} {

        display:
          flex !important;

        justify-content:
          flex-end !important;

        align-items:
          center !important;

        margin:
          0 0 10px !important;
      }

      #${FALLBACK_HOST_ID}
      #${LAUNCHER_ID} {

        position:
          static !important;

        border:
          1px solid
          rgba(
            87,
            199,
            255,
            .7
          ) !important;

        border-radius:
          14px !important;

        padding:
          5px 10px !important;

        background:
          rgba(
            47,
            111,
            165,
            .18
          ) !important;

        color:
          inherit !important;

        font-size:
          11px !important;

        font-weight:
          700 !important;

        cursor:
          pointer !important;
      }

      /*
       * ========================================================
       * MODAL
       * ========================================================
       */

      #${PANEL_ID},
      #${PANEL_ID} * {

        box-sizing:
          border-box !important;
      }

      #${PANEL_ID} {

        position:
          fixed !important;

        inset:
          0 !important;

        width:
          100vw !important;

        height:
          100dvh !important;

        z-index:
          ${MAX_Z_INDEX} !important;

        isolation:
          isolate !important;

        background:
          rgba(
            0,
            0,
            0,
            .88
          ) !important;

        display:
          flex !important;

        align-items:
          center !important;

        justify-content:
          center !important;

        padding:
          20px !important;

        color:
          #e8eef2 !important;

        overflow:
          hidden !important;

        overscroll-behavior:
          none !important;

        touch-action:
          none !important;
      }

      #${PANEL_ID}
      button,

      #${PANEL_ID}
      select,

      #${PANEL_ID}
      input {

        font:
          inherit !important;
      }

      .blom-shell {

        position:
          relative !important;

        z-index:
          1 !important;

        width:
          min(
            1180px,
            96vw
          ) !important;

        height:
          min(
            820px,
            92dvh
          ) !important;

        min-height:
          0 !important;

        background:
          #171a1d !important;

        color:
          #e8eef2 !important;

        border:
          1px solid
          #3d4b55 !important;

        border-radius:
          12px !important;

        overflow:
          hidden !important;

        display:
          flex !important;

        flex-direction:
          column !important;

        box-shadow:
          0 18px 60px
          rgba(
            0,
            0,
            0,
            .75
          ) !important;

        touch-action:
          manipulation !important;
      }

      .blom-header {

        flex:
          0 0 auto !important;

        display:
          flex !important;

        align-items:
          center !important;

        justify-content:
          space-between !important;

        padding:
          14px 18px !important;

        background:
          #20262b !important;

        border-bottom:
          1px solid
          #364049 !important;
      }

      .blom-title {

        color:
          #57c7ff !important;

        font-size:
          20px !important;

        font-weight:
          900 !important;
      }

      .blom-subtitle {

        margin-top:
          2px !important;

        color:
          #b8c1c8 !important;

        font-size:
          11px !important;
      }

      .blom-close {

        border:
          0 !important;

        background:
          transparent !important;

        color:
          #ddd !important;

        font-size:
          20px !important;

        cursor:
          pointer !important;
      }

      /* Roster Planner readability polish */
      #${PANEL_ID} a,
      #${PANEL_ID} a:visited,
      #${PANEL_ID} a:hover,
      #${PANEL_ID} a:active {
        color:#69d0ff !important;
        text-decoration-color:rgba(105,208,255,.55) !important;
      }
      #${PANEL_ID} a:hover { color:#ffffff !important; }
      #${PANEL_ID} a, #${PANEL_ID} a:visited, #${PANEL_ID} .blom-member-link, #${PANEL_ID} .blom-member-link:visited { color:#65d2ff !important; }
      #${PANEL_ID} .blom-member-link {
        font-weight:800 !important;
        line-height:1.3 !important;
        text-decoration-thickness:1px !important;
        text-underline-offset:2px !important;
      }
      #${PANEL_ID} .blom-member-id { color:#9edfff !important; font-weight:600 !important; }
      #${PANEL_ID} .blom-member-cell { min-width:150px !important; width:28% !important; }
      #${PANEL_ID} .blom-assignment-card {
        margin:10px 0 !important; padding:0 !important; overflow:hidden !important;
        border:1px solid #3f5665 !important; border-radius:9px !important;
        background:#1b2227 !important; box-shadow:0 3px 12px rgba(0,0,0,.22) !important;
      }
      #${PANEL_ID} .blom-assignment-title {
        display:flex !important; align-items:center !important; gap:8px !important; flex-wrap:wrap !important;
        padding:9px 11px !important; background:#222d34 !important; border-bottom:1px solid #344956 !important;
        font-size:13px !important; font-weight:850 !important; color:#f3f7f9 !important;
      }
      #${PANEL_ID} .blom-level-badge {
        display:inline-block !important; padding:2px 7px !important; border-radius:999px !important;
        background:#2f6fa5 !important; color:#fff !important; font-size:11px !important; font-weight:900 !important;
      }
      #${PANEL_ID} .blom-crime-id { color:#aab7c0 !important; font-size:11px !important; font-weight:650 !important; }
      #${PANEL_ID} .blom-assignment-rows { padding:4px 10px 7px !important; }
      #${PANEL_ID} .blom-assignment-row {
        display:grid !important; grid-template-columns:minmax(88px,auto) minmax(0,1fr) auto !important;
        gap:8px !important; align-items:center !important; padding:6px 0 !important;
        border-bottom:1px solid #2d3941 !important; line-height:1.35 !important;
      }
      #${PANEL_ID} .blom-assignment-row:last-child { border-bottom:0 !important; }
      #${PANEL_ID} .blom-role-label { color:#dbe4e9 !important; font-weight:750 !important; }
      #${PANEL_ID} .blom-assignee { min-width:0 !important; }
      #${PANEL_ID} .blom-cpr-pill {
        white-space:nowrap !important; padding:2px 6px !important; border-radius:5px !important;
        background:#26343c !important; color:#dff5ff !important; font-size:10px !important; font-weight:800 !important;
      }
      #${PANEL_ID} .blom-placement-title { color:#f2f6f8 !important; font-weight:850 !important; margin-bottom:3px !important; }
      #${PANEL_ID} .blom-placement-meta { color:#d5dde2 !important; font-size:11px !important; line-height:1.45 !important; }
      #${PANEL_ID} .blom-placement-note { color:#9fadb6 !important; font-size:10px !important; line-height:1.4 !important; margin-top:2px !important; }
      #${PANEL_ID} .blom-placement-empty { color:#b9c4ca !important; font-style:italic !important; }
      #${PANEL_ID} .blom-current-oc { color:#ecf3f6 !important; font-weight:750 !important; }
      #${PANEL_ID} .blom-hold { color:#ffd08a !important; font-weight:750 !important; }
      #${PANEL_ID} .blom-item-warning { color:#ffd08a !important; }
      #${PANEL_ID} .blom-planner-dashboard {
        display:grid !important; grid-template-columns:repeat(4,minmax(0,1fr)) !important;
        gap:7px !important; margin:2px 0 12px !important;
      }
      #${PANEL_ID} .blom-stat {
        min-width:0 !important; padding:9px 7px !important; text-align:center !important;
        background:#1d272d !important; border:1px solid #344955 !important; border-radius:9px !important;
      }
      #${PANEL_ID} .blom-stat strong { display:block !important; color:#f6fbfd !important; font-size:20px !important; line-height:1.05 !important; }
      #${PANEL_ID} .blom-stat span { display:block !important; margin-top:4px !important; color:#aebbc3 !important; font-size:9px !important; line-height:1.15 !important; }
      #${PANEL_ID} .blom-stat-accent { border-color:#4caee2 !important; background:#20303a !important; }
      #${PANEL_ID} .blom-release-start{color:#eef7ff!important;-webkit-text-fill-color:#eef7ff!important;background:#233641!important;border:1px solid #7daecb!important;overflow-wrap:anywhere!important}
      #${PANEL_ID} .blom-release-start p,#${PANEL_ID} .blom-release-start strong{color:#eef7ff!important;-webkit-text-fill-color:#eef7ff!important}
      #${PANEL_ID} .blom-release-start>details>summary{box-sizing:border-box!important;min-height:44px!important;padding:8px!important;color:#eef7ff!important;-webkit-text-fill-color:#eef7ff!important;background:#20303a!important;border:1px solid #607f92!important}
      #${PANEL_ID} .blom-release-start>details>summary:hover{background:#304958!important}
      #${PANEL_ID} .blom-release-start>details>summary:focus-visible{outline:2px solid #ffe39c!important;outline-offset:2px!important}
      #${PANEL_ID} .blom-planner-diagnostic-result{display:block!important;box-sizing:border-box!important;width:100%!important;margin:10px 0!important;padding:12px!important;color:#eef7ff!important;-webkit-text-fill-color:#eef7ff!important;background:#1d2c35!important;border:1px solid #67b7e4!important;border-radius:8px!important;overflow-wrap:anywhere!important}
      #${PANEL_ID} .blom-planner-diagnostic-result p,#${PANEL_ID} .blom-planner-diagnostic-result strong{color:#eef7ff!important;-webkit-text-fill-color:#eef7ff!important}
      #${PANEL_ID} .blom-diagnostic-actions{display:flex!important;gap:8px!important;flex-wrap:wrap!important;margin:10px 0!important}
      #${PANEL_ID} .blom-diagnostic-actions button{min-height:44px!important;white-space:normal!important;color:#eef7ff!important;-webkit-text-fill-color:#eef7ff!important;background:#245b7c!important;border:1px solid #67b7e4!important}
      #${PANEL_ID} .blom-diagnostic-actions button:hover{background:#307395!important}
      #${PANEL_ID} .blom-diagnostic-actions button:focus-visible,#${PANEL_ID} .blom-planner-diagnostic-result textarea:focus-visible{outline:2px solid #ffe39c!important;outline-offset:2px!important}
      #${PANEL_ID} .blom-diagnostic-actions button:disabled{color:#d3dde5!important;-webkit-text-fill-color:#d3dde5!important;background:#374b59!important;border-color:#708694!important;opacity:1!important}
      #${PANEL_ID} .blom-planner-diagnostic-result textarea{display:block!important;box-sizing:border-box!important;width:100%!important;max-width:100%!important;min-height:180px!important;padding:9px!important;background:#101d25!important;color:#eef7ff!important;-webkit-text-fill-color:#eef7ff!important;border:1px solid #6b8a9d!important;white-space:pre-wrap!important;font:12px/1.5 monospace!important}
      #${PANEL_ID} #blom-export-planner{color:#eef7ff!important;-webkit-text-fill-color:#eef7ff!important;background:#245b7c!important;border:1px solid #67b7e4!important;min-height:44px!important;white-space:normal!important;overflow-wrap:anywhere!important}
      #${PANEL_ID} #blom-export-planner:hover{background:#307395!important}
      #${PANEL_ID} #blom-export-planner:focus-visible{outline:2px solid #ffe39c!important;outline-offset:2px!important}
      #${PANEL_ID} #blom-export-planner:disabled{color:#d3dde5!important;-webkit-text-fill-color:#d3dde5!important;background:#374b59!important;border-color:#708694!important;opacity:1!important}
      #${PANEL_ID} .blom-section {
        margin:9px 0 !important; border:1px solid #344955 !important; border-radius:9px !important;
        background:#182025 !important; overflow:hidden !important;
      }
      #${PANEL_ID} .blom-section > summary {
        list-style:none !important; cursor:pointer !important; display:flex !important; align-items:center !important;
        justify-content:space-between !important; gap:8px !important; padding:10px 11px !important;
        background:#202b32 !important; color:#f1f6f8 !important; font-weight:850 !important; font-size:13px !important;
      }
      #${PANEL_ID} .blom-section > summary::-webkit-details-marker { display:none !important; }
      #${PANEL_ID} .blom-section > summary::after { content:'›' !important; color:#72d3ff !important; font-size:19px !important; transform:rotate(90deg) !important; transition:transform .12s ease !important; margin-left:auto !important; }
      #${PANEL_ID} .blom-section:not([open]) > summary::after { transform:rotate(0deg) !important; }
      #${PANEL_ID} .blom-section-body { padding:10px !important; }
      #${PANEL_ID} .blom-main-section { border-color:#42687c !important; }
      #${PANEL_ID} .blom-main-section > summary { background:#233641 !important; }
      #${PANEL_ID} .blom-info-section > summary { background:#1b2429 !important; color:#c9d4da !important; }
      #${PANEL_ID} .blom-summary-hint { color:#93a4ae !important; font-size:9px !important; font-weight:600 !important; white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important; }
      #${PANEL_ID} .blom-mini-badge { display:inline-flex !important; align-items:center !important; padding:2px 7px !important; border-radius:999px !important; background:#33434c !important; color:#d9e5ea !important; font-size:9px !important; font-weight:850 !important; white-space:nowrap !important; }
      #${PANEL_ID} .blom-mini-badge.blom-good { background:#174c3a !important; color:#aef0d1 !important; }
      #${PANEL_ID} .blom-mini-badge.blom-warn { background:#59421c !important; color:#ffe0a3 !important; }
      #${PANEL_ID} .blom-spawn-section summary { color:#eaf5fc !important; -webkit-text-fill-color:#eaf5fc !important; background:#20303a !important; border:1px solid #49616e !important; border-radius:5px !important; min-height:44px !important; box-sizing:border-box !important; padding:10px !important; white-space:normal !important; overflow-wrap:anywhere !important; cursor:pointer !important; font-size:14px !important; line-height:1.5 !important; }
      #${PANEL_ID} .blom-spawn-section summary:hover { background:#2c4352 !important; }
      #${PANEL_ID} .blom-spawn-section summary:focus-visible { outline:2px solid #72caff !important; outline-offset:2px !important; }
      #${PANEL_ID} .blom-spawn-advice { font-size:14px !important; line-height:1.5 !important; color:#f5f9fc !important; -webkit-text-fill-color:#f5f9fc !important; }
      #${PANEL_ID} .blom-spawn-advice p { font-size:14px !important; font-weight:400 !important; line-height:1.5 !important; }
      #${PANEL_ID} .blom-spawn-unplaced { font-size:14px !important; line-height:1.5 !important; color:#ffcb70 !important; -webkit-text-fill-color:#ffcb70 !important; }
      #${PANEL_ID} .blom-spawn-advice > strong { font-size:16px !important; }
      #${PANEL_ID} .blom-spawn-advice .blom-spawn-warning { color:#ffcb70 !important; -webkit-text-fill-color:#ffcb70 !important; }
      #${PANEL_ID} .blom-spawn-review { padding:14px !important; margin:10px 0 !important; color:#f5f9fc !important; background:#203c50 !important; border:1px solid #72caff !important; border-radius:8px !important; line-height:1.5 !important; }
      #${PANEL_ID} .blom-spawn-review button { color:#f5f9fc !important; -webkit-text-fill-color:#f5f9fc !important; background:#245679 !important; background-image:none !important; border:1px solid #72caff !important; border-radius:6px !important; padding:10px 14px !important; white-space:normal !important; overflow-wrap:anywhere !important; line-height:1.4 !important; text-shadow:none !important; cursor:pointer !important; }
      #${PANEL_ID} .blom-spawn-review button:hover:not(:disabled) { background:#306d94 !important; }
      #${PANEL_ID} .blom-spawn-review button:focus-visible { outline:2px solid #fff !important; outline-offset:2px !important; }
      #${PANEL_ID} .blom-spawn-review button:disabled { color:#bdcbd4 !important; -webkit-text-fill-color:#bdcbd4 !important; background:#27353e !important; border-color:#607681 !important; opacity:1 !important; cursor:default !important; }
      #${PANEL_ID} .blom-spawn-review button { margin:6px 8px 0 0 !important; min-height:44px !important; max-width:100% !important; box-sizing:border-box !important; }
      #${PANEL_ID} .blom-mail-status { display:flex !important; flex-direction:column !important; gap:3px !important; margin-top:8px !important; padding:7px 9px !important; border:1px solid #6e899a !important; border-radius:6px !important; background:#263744 !important; color:#f5f9fc !important; line-height:1.45 !important; overflow-wrap:anywhere !important; }
      #${PANEL_ID} .blom-mail-status span { color:#dce7ef !important; font-size:11px !important; }
      #${PANEL_ID} .blom-mail-mailed { background:#203f32 !important; border-color:#6dba94 !important; }
      #${PANEL_ID} .blom-mail-update, #${PANEL_ID} .blom-mail-unsent { background:#443923 !important; border-color:#c9a960 !important; }
      /* Default controls must stay readable even when Torn supplies black text. */
      #${PANEL_ID} :where(button) {
        appearance:none !important; color:#f5f9fc !important;
        -webkit-text-fill-color:currentColor !important; background:#245679 !important;
        background-image:none !important; text-shadow:none !important;
        border:1px solid #72caff !important; border-radius:6px !important;
        min-height:36px !important; padding:8px 12px !important;
        font:inherit !important; line-height:1.4 !important; white-space:normal !important;
        cursor:pointer !important;
      }
      #${PANEL_ID} :where(button):focus-visible { outline:2px solid #fff !important; outline-offset:3px !important; }
      #${PANEL_ID} :where(button):disabled { color:#d7e1e8 !important; background:#344650 !important; opacity:1 !important; cursor:default !important; }
      #${PANEL_ID} button[data-invitation-decision] {
        display:inline-flex !important; align-items:center !important; justify-content:center !important;
        color:#f5f9fc !important; -webkit-text-fill-color:#f5f9fc !important;
        background:#245679 !important; border:1px solid #72caff !important;
        margin:8px 8px 8px 0 !important; min-height:44px !important;
        max-width:100% !important; box-sizing:border-box !important; text-align:center !important;
      }
      #${PANEL_ID} button[data-invitation-decision]:hover:not(:disabled) { background:#306d94 !important; }
      #${PANEL_ID} button[data-invitation-decision]:disabled { color:#d7e1e8 !important; -webkit-text-fill-color:#d7e1e8 !important; background:#344650 !important; }
      #${PANEL_ID} .blom-alert { padding:8px 10px !important; border-radius:8px !important; margin:8px 0 !important; font-size:11px !important; font-weight:750 !important; }
      #${PANEL_ID} .blom-rescue-panel > summary { min-height:44px !important; box-sizing:border-box !important; background:#253642 !important; color:#eaf5fc !important; -webkit-text-fill-color:#eaf5fc !important; border:1px solid #638da7 !important; overflow-wrap:anywhere; }
      #${PANEL_ID} .blom-rescue-panel > summary:hover { background:#304b5c !important; }
      #${PANEL_ID} .blom-rescue-panel > summary:focus-visible { outline:2px solid #ffe39c !important; outline-offset:2px !important; }
      #${PANEL_ID} .blom-rescue-panel .blom-alert { background:#253642 !important; border:1px solid #638da7 !important; color:#eaf5fc !important; -webkit-text-fill-color:#eaf5fc !important; overflow-wrap:anywhere; }
      #${PANEL_ID} .blom-rescue-panel .blom-alert p, #${PANEL_ID} .blom-rescue-panel .blom-alert strong { color:#eaf5fc !important; -webkit-text-fill-color:#eaf5fc !important; }
      #${PANEL_ID} .blom-rescue-panel a { color:#8bd8ff !important; -webkit-text-fill-color:#8bd8ff !important; text-decoration:underline !important; }
      #${PANEL_ID} .blom-rescue-panel a:hover, #${PANEL_ID} .blom-rescue-panel a:focus-visible { color:#fff !important; -webkit-text-fill-color:#fff !important; outline-color:#ffe39c !important; }
      #${PANEL_ID} .blom-spawn-advice { background:#253642 !important; border:1px solid #638da7 !important; color:#eaf5fc !important; -webkit-text-fill-color:#eaf5fc !important; overflow-wrap:anywhere; }
      #${PANEL_ID} .blom-alert-bad { background:#4a2424 !important; border:1px solid #875050 !important; color:#ffd1d1 !important; -webkit-text-fill-color:#ffd1d1 !important; }
      #${PANEL_ID} .blom-alert-bad strong { color:#ffd1d1 !important; -webkit-text-fill-color:#ffd1d1 !important; }
      #${PANEL_ID} .blom-placement-note { -webkit-text-fill-color:#9fadb6 !important; overflow-wrap:anywhere; }
      #${PANEL_ID} .blom-section-intro { color:#aebbc3 !important; font-size:10px !important; margin:0 0 7px !important; }
      #${PANEL_ID} .blom-assignment-grid { display:grid !important; grid-template-columns:repeat(2,minmax(0,1fr)) !important; gap:8px !important; }
      #${PANEL_ID} .blom-assignment-grid .blom-assignment-card { margin:0 !important; }
      #${PANEL_ID} .blom-wide-action { width:100% !important; margin-top:9px !important; }
      #${PANEL_ID} .blom-forecast-chips { display:flex !important; gap:6px !important; flex-wrap:wrap !important; margin:0 0 8px !important; }
      #${PANEL_ID} .blom-forecast-chips span { padding:5px 8px !important; background:#25323a !important; border-radius:7px !important; color:#b9c7ce !important; font-size:10px !important; }
      #${PANEL_ID} .blom-forecast-chips b { color:#eef8fc !important; }
      #${PANEL_ID} .blom-muted { color:#90a0aa !important; font-size:9px !important; line-height:1.35 !important; }
      #${PANEL_ID} .blom-spawn-summary { background:#3a3020 !important; border:1px solid #ac8550 !important; border-radius:8px !important; color:#ffdb9a !important; -webkit-text-fill-color:#ffdb9a !important; overflow-wrap:anywhere !important; }
      #${PANEL_ID} .blom-spawn-summary > strong { color:#ffcb70 !important; -webkit-text-fill-color:#ffcb70 !important; }
      #${PANEL_ID} .blom-spawn-summary > p { color:#ffdb9a !important; -webkit-text-fill-color:#ffdb9a !important; }
      #${PANEL_ID} .blom-spawn-stack { margin-top:9px !important; }
      #${PANEL_ID} .blom-spawn-hero { display:flex !important; align-items:center !important; justify-content:space-between !important; gap:10px !important; padding:9px !important; background:#202c33 !important; border-radius:8px !important; }
      #${PANEL_ID} .blom-spawn-hero strong { display:block !important; color:#f2f8fb !important; font-size:14px !important; }
      #${PANEL_ID} .blom-spawn-hero span { display:block !important; color:#aebbc3 !important; font-size:9px !important; margin-top:2px !important; }
      #${PANEL_ID} .blom-spawn-score { color:#7ed7ff !important; font-size:20px !important; font-weight:900 !important; text-align:right !important; }
      #${PANEL_ID} .blom-spawn-score small { display:block !important; color:#90a0aa !important; font-size:8px !important; font-weight:650 !important; }
      #${PANEL_ID} .blom-spawn-example, #${PANEL_ID} .blom-spawn-warning { margin-top:7px !important; font-size:10px !important; color:#bac7cd !important; }
      #${PANEL_ID} .blom-spawn-warning { color:#ffd08a !important; }
      #${PANEL_ID} .blom-capacity-grid { display:grid !important; grid-template-columns:repeat(2,minmax(0,1fr)) !important; gap:6px !important; margin-top:8px !important; }
      #${PANEL_ID} .blom-capacity-card { padding:7px 8px !important; background:#1e292f !important; border:1px solid #30414a !important; border-radius:7px !important; }
      #${PANEL_ID} .blom-capacity-card strong { display:block !important; color:#dff5ff !important; font-size:11px !important; }
      #${PANEL_ID} .blom-capacity-card span { display:block !important; color:#93a4ad !important; font-size:8px !important; margin-top:2px !important; line-height:1.3 !important; }
      #${PANEL_ID} .blom-inline-details { margin-top:8px !important; color:#9fadb6 !important; font-size:9px !important; }
      #${PANEL_ID} .blom-inline-details summary { cursor:pointer !important; color:#86d9ff !important; }
      #${PANEL_ID} .blom-membership-check { font-size:14px !important; line-height:1.55 !important; padding:14px !important; border:1px solid #42525c !important; border-radius:8px !important; }
      #${PANEL_ID} .blom-membership-check summary { font-size:16px !important; font-weight:700 !important; }
      #${PANEL_ID} .blom-membership-check p { margin:12px 0 !important; }
      #${PANEL_ID} .blom-membership-check small { display:block !important; font-size:13px !important; line-height:1.5 !important; margin-top:10px !important; }
      #${PANEL_ID} .blom-membership-check label { display:inline-flex !important; align-items:center !important; flex-wrap:wrap !important; gap:8px !important; margin:6px 14px 6px 0 !important; }
      #${PANEL_ID} .blom-membership-check input[type="number"] { font-size:16px !important; padding:7px !important; width:120px !important; max-width:100% !important; color:#f3f7f9 !important; background:#202b32 !important; border:1px solid #71838e !important; border-radius:4px !important; }
      #${PANEL_ID} .blom-membership-check input[type="checkbox"] { width:18px !important; height:18px !important; flex-shrink:0 !important; }

      #${PANEL_ID} .blom-help { max-width:1050px; line-height:1.5; }
      #${PANEL_ID} .blom-help h2, #${PANEL_ID} .blom-help h3 { color:#66cfff; margin:0 0 10px; }
      #${PANEL_ID} .blom-help h3 { margin-top:20px; }
      #${PANEL_ID} .blom-help li { margin:0 0 10px; }
      #${PANEL_ID} .blom-help details { border:1px solid #344650; border-radius:8px; padding:12px; margin:12px 0; }
      #${PANEL_ID} .blom-help summary { cursor:pointer; }
      #${PANEL_ID} .blom-help ol { list-style:decimal outside !important; padding-left:24px !important; margin:12px 0 !important; }
      #${PANEL_ID} .blom-help ul { list-style:disc outside !important; padding-left:22px !important; margin:12px 0 !important; }
      #${PANEL_ID} .blom-help li { display:list-item !important; }
      #${PANEL_ID} .blom-help button {
        margin:3px 6px 3px 0 !important; padding:10px 14px !important;
        border:1px solid #72caff !important; border-radius:7px !important;
        background:#245679 !important; color:#fff !important; font-size:14px !important;
        font-weight:700 !important; line-height:1.4 !important; cursor:pointer !important;
      }
      #${PANEL_ID} .blom-help button:hover { background:#306d94 !important; }
      #${PANEL_ID} .blom-help button:focus-visible { outline:2px solid #fff !important; outline-offset:2px !important; }
      #${PANEL_ID} .blom-empty-state { padding:9px !important; border-radius:7px !important; background:#20282d !important; color:#aebbc3 !important; font-size:10px !important; }
      #${PANEL_ID} #blom-planner-results h3 {
        display:block !important;position:static !important;float:none !important;
        width:auto !important;height:auto !important;min-height:0 !important;
        margin:22px 0 10px !important;padding:8px 10px !important;line-height:1.3 !important;
        font-size:18px !important;color:#f2f7fa !important;background:#1d272d !important;
        border-left:4px solid #57c7ff !important;border-radius:0 6px 6px 0 !important;
        white-space:normal !important;transform:none !important;
      }
      #${PANEL_ID} #blom-planner-results p {
        position:static !important;height:auto !important;margin:12px 0 !important;
        padding:0 !important;line-height:1.5 !important;color:#e8eef2 !important;
      }
      #${PANEL_ID} .blom-planner-table {
        display:table !important;width:100% !important;border-collapse:collapse !important;
        line-height:1.5 !important;color:#e8eef2 !important;table-layout:auto !important;
      }
      #${PANEL_ID} .blom-planner-table th, #${PANEL_ID} .blom-planner-table td {
        position:static !important;float:none !important;height:auto !important;
        padding:10px 11px !important;border-bottom:1px solid #394852 !important;
        text-align:left !important;vertical-align:top !important;line-height:1.45 !important;
        color:#e8eef2 !important;background:#182025 !important;white-space:normal !important;
      }
      #${PANEL_ID} .blom-planner-table th {
        background:#22303a !important; color:#dff4ff !important; font-size:11px !important;
        font-weight:850 !important; letter-spacing:.15px !important; border-bottom:1px solid #4a6170 !important;
      }
      #${PANEL_ID} .blom-planner-table tbody tr:nth-child(even) td { background:#1b242a !important; }
      #${PANEL_ID} .blom-planner-table tbody tr:hover td { background:#202d35 !important; }
      #${PANEL_ID} .blom-planner-scroll {
        border:1px solid #354650 !important; border-radius:8px !important; overflow:auto !important;
        background:#182025 !important; margin-bottom:12px !important;
      }
      #${PANEL_ID} .blom-planner-scroll {display:block !important;clear:both !important;overflow-x:auto !important;}
      .blom-planner-scroll { overflow-x: auto; }
      .blom-planner-table { width: 100%; border-collapse: collapse; }
      .blom-planner-table th, .blom-planner-table td { padding: 12px; border-bottom: 1px solid #657080; text-align: left; vertical-align: top; }
      #blom-planner-key { max-width: 240px; }
      .blom-tabs {

        flex:
          0 0 auto !important;

        display:
          flex !important;

        gap:
          4px !important;

        padding:
          8px 10px !important;

        background:
          #1c2125 !important;

        border-bottom:
          1px solid
          #343d44 !important;

        overflow-x:
          auto !important;

        overflow-y:
          hidden !important;

        -webkit-overflow-scrolling:
          touch !important;

        overscroll-behavior-x:
          contain !important;

        touch-action:
          pan-x !important;
      }

      .blom-tabs button,
      .blom-toolbar button,
      .blom-data-actions button {

        border:
          1px solid
          #44545f !important;

        border-radius:
          6px !important;

        background:
          #252d33 !important;

        color:
          #e8eef2 !important;

        padding:
          7px 10px !important;

        cursor:
          pointer !important;
      }

      .blom-tabs button.active,
      .blom-primary {

        background:
          #2f6fa5 !important;

        border-color:
          #4a90e2 !important;

        color:
          #fff !important;

        font-weight:
          800 !important;
      }

      .blom-body {

        flex:
          1 1 auto !important;

        min-height:
          0 !important;

        overflow-x:
          hidden !important;

        overflow-y:
          auto !important;

        -webkit-overflow-scrolling:
          touch !important;

        overscroll-behavior:
          contain !important;

        touch-action:
          pan-y !important;

        padding:
          14px !important;

        background:
          #151a1e !important;

        color:
          #e8eef2 !important;
      }

      /*
       * ========================================================
       * TOOLBAR
       * ========================================================
       */

      .blom-toolbar {

        display:
          flex !important;

        flex-wrap:
          wrap !important;

        gap:
          10px !important;

        align-items:
          end !important;

        margin-bottom:
          12px !important;
      }

      .blom-toolbar label {

        display:
          flex !important;

        flex-direction:
          column !important;

        gap:
          4px !important;

        color:
          #dce4e9 !important;

        font-size:
          11px !important;
      }

      .blom-toolbar select,
      .blom-toolbar input {

        background:
          #101518 !important;

        color:
          #f2f5f7 !important;

        border:
          1px solid
          #46535d !important;

        border-radius:
          5px !important;

        padding:
          7px 8px !important;
      }

      .blom-toolbar
      .blom-check {

        flex-direction:
          row !important;

        align-items:
          center !important;

        padding-bottom:
          7px !important;
      }

      /*
       * ========================================================
       * GENERAL CARDS
       * ========================================================
       */

      .blom-summary {

        display:
          flex !important;

        justify-content:
          space-between !important;

        gap:
          10px !important;

        padding:
          10px 12px !important;

        margin-bottom:
          10px !important;

        border:
          1px solid
          #35566d !important;

        border-radius:
          8px !important;

        background:
          #1b2a34 !important;

        color:
          #e8eef2 !important;
      }

      .blom-grid {

        display:
          grid !important;

        grid-template-columns:
          repeat(
            auto-fit,
            minmax(
              260px,
              1fr
            )
          ) !important;

        gap:
          10px !important;
      }

      .blom-card {

        padding:
          11px !important;

        border:
          1px solid
          #39454d !important;

        border-radius:
          8px !important;

        background:
          #1e2428 !important;

        color:
          #e8eef2 !important;
      }

      .blom-card-title {

        display:
          flex !important;

        justify-content:
          space-between !important;

        gap:
          10px !important;

        margin-bottom:
          8px !important;

        color:
          #8fd9ff !important;

        font-weight:
          900 !important;
      }

      .blom-muted {

        color:
          #9da8af !important;

        font-size:
          11px !important;
      }

      /*
       * ========================================================
       * BUILDER ROLE CARDS
       * ========================================================
       */

      .blom-role-list {

        display:
          flex !important;

        flex-direction:
          column !important;

        gap:
          10px !important;
      }

      .blom-role-card {

        padding:
          12px !important;

        border:
          1px solid
          #394a55 !important;

        border-radius:
          10px !important;

        background:
          #1c2328 !important;

        color:
          #e8eef2 !important;
      }

      .blom-role-top {

        display:
          flex !important;

        justify-content:
          space-between !important;

        align-items:
          flex-start !important;

        gap:
          10px !important;
      }

      .blom-role-name {

        color:
          #8fd9ff !important;

        font-size:
          16px !important;

        font-weight:
          900 !important;
      }

      .blom-role-meta {

        margin-top:
          3px !important;

        color:
          #aeb8be !important;

        font-size:
          11px !important;
      }

      .blom-selected-member {

        display:
          flex !important;

        justify-content:
          space-between !important;

        align-items:
          center !important;

        gap:
          10px !important;

        margin-top:
          10px !important;

        padding:
          10px !important;

        border-radius:
          8px !important;

        background:
          #142b37 !important;
      }

      .blom-big-cpr {

        color:
          #fff !important;

        font-size:
          22px !important;

        font-weight:
          900 !important;
      }

      .blom-no-member {

        margin-top:
          10px !important;

        padding:
          10px !important;

        border-radius:
          8px !important;

        background:
          #38201f !important;

        color:
          #ff9c95 !important;
      }

      .blom-alt-heading {

        margin-top:
          10px !important;

        margin-bottom:
          4px !important;

        color:
          #929da4 !important;

        font-size:
          10px !important;

        font-weight:
          800 !important;

        text-transform:
          uppercase !important;
      }

      .blom-alt-list {

        border-top:
          1px solid
          rgba(
            255,
            255,
            255,
            .08
          ) !important;
      }

      .blom-alt-item {

        display:
          flex !important;

        justify-content:
          space-between !important;

        gap:
          10px !important;

        padding:
          6px 0 !important;

        color:
          #dce4e9 !important;

        border-bottom:
          1px solid
          rgba(
            255,
            255,
            255,
            .05
          ) !important;
      }

      .blom-alt-item strong {

        color:
          #7fd9ff !important;
      }

      /*
       * ========================================================
       * PASS / FAIL
       * ========================================================
       */

      .blom-pass,
      .blom-fail {

        display:
          inline-block !important;

        min-width:
          38px !important;

        text-align:
          center !important;

        border-radius:
          10px !important;

        padding:
          3px 6px !important;

        font-size:
          9px !important;

        line-height:
          1.2 !important;

        font-weight:
          900 !important;
      }

      .blom-pass {

        background:
          #175333 !important;

        color:
          #88f4ae !important;

        border:
          1px solid
          #237343 !important;
      }

      .blom-fail {

        background:
          #60231f !important;

        color:
          #ffaaa3 !important;

        border:
          1px solid
          #87312b !important;
      }

      /*
       * ========================================================
       * SPECIALISTS
       * ========================================================
       */

      .blom-rank {

        display:
          flex !important;

        justify-content:
          space-between !important;

        gap:
          10px !important;

        padding:
          6px 0 !important;

        color:
          #e8eef2 !important;

        border-top:
          1px solid
          rgba(
            255,
            255,
            255,
            .07
          ) !important;
      }

      .blom-rank-number {

        display:
          inline-block !important;

        min-width:
          24px !important;

        color:
          #89949b !important;
      }

      .blom-member {

        color:
          #66d3ff !important;

        text-decoration:
          none !important;

        font-weight:
          800 !important;
      }

      /*
       * ========================================================
       * COVERAGE
       * ========================================================
       */

      .blom-meter {

        height:
          7px !important;

        background:
          #101518 !important;

        border-radius:
          10px !important;

        overflow:
          hidden !important;

        margin:
          8px 0 !important;
      }

      .blom-meter span {

        display:
          block !important;

        height:
          100% !important;

        background:
          #2f89c4 !important;
      }

      .blom-good {

        color:
          #7fe5a2 !important;

        margin-top:
          7px !important;

        font-size:
          11px !important;
      }

      .blom-warning {

        color:
          #f3c46b !important;

        margin-top:
          7px !important;

        font-size:
          11px !important;
      }

      /*
       * ========================================================
       * MEMBER LOOKUP
       * ========================================================
       */

      .blom-member-list {

        display:
          flex !important;

        flex-direction:
          column !important;

        gap:
          6px !important;
      }

      #${PANEL_ID} .blom-member-crime {
        min-width:0 !important; border:1px solid #425865 !important;
        border-radius:8px !important; overflow:hidden !important;
        background:#1c2226 !important; color:#e8eef2 !important;
        -webkit-text-fill-color:#e8eef2 !important;
      }
      #${PANEL_ID} .blom-member-crime-title {
        margin:0 !important; padding:10px 12px !important;
        background:#233742 !important; border-bottom:1px solid #425865 !important;
        color:#9be1ff !important; -webkit-text-fill-color:#9be1ff !important;
        font:700 14px/1.4 sans-serif !important; overflow-wrap:anywhere !important;
      }
      #${PANEL_ID} .blom-member-role-table {
        width:100% !important; table-layout:fixed !important;
        border-collapse:collapse !important; margin:0 !important;
        background:#1c2226 !important;
      }
      #${PANEL_ID} .blom-member-role-table th,
      #${PANEL_ID} .blom-member-role-table td {
        padding:7px 12px !important; border:0 !important;
        border-bottom:1px solid #34414a !important; text-align:left !important;
        background:#1c2226 !important; color:#e8eef2 !important;
        -webkit-text-fill-color:#e8eef2 !important;
        font:400 13px/1.4 sans-serif !important; overflow-wrap:anywhere !important;
      }
      #${PANEL_ID} .blom-member-role-table thead th {
        background:#192b35 !important; color:#c3d5df !important;
        -webkit-text-fill-color:#c3d5df !important; font-weight:700 !important;
      }
      #${PANEL_ID} .blom-member-role-table th:first-child { width:48% !important; }
      #${PANEL_ID} .blom-member-role-table th:nth-child(2) { width:18% !important; }
      #${PANEL_ID} .blom-member-role-table .blom-member-score {
        color:#77d7ff !important; -webkit-text-fill-color:#77d7ff !important;
        font-weight:800 !important; font-variant-numeric:tabular-nums !important;
      }
      #${PANEL_ID} .blom-member-role-table .blom-member-row-date {
        color:#c0cbd2 !important; -webkit-text-fill-color:#c0cbd2 !important;
        font-size:12px !important;
      }
      #${PANEL_ID} .blom-member-date-label { display:none !important; }
      #${PANEL_ID} .blom-member-role-table tbody tr:last-child > * { border-bottom:0 !important; }
      @media(max-width:480px) {
        #${PANEL_ID} .blom-member-role-table th,
        #${PANEL_ID} .blom-member-role-table td { padding:7px 6px !important; }
        #${PANEL_ID} .blom-member-role-table th:first-child { width:42% !important; }
      }

      /*
       * ========================================================
       * DATA
       * ========================================================
       */

      #${PANEL_ID} .blom-script-presence {
        margin-bottom: 10px !important;
        padding: 11px !important;
        color: #f1f5f9 !important;
        font-size: 13px !important;
        line-height: 1.4 !important;
      }
      #${PANEL_ID} .blom-script-presence .blom-card-title {
        font-size: 15px !important;
        line-height: 1.4 !important;
        color: #9bdeff !important;
      }
      #${PANEL_ID} .blom-script-presence p {
        margin: 5px 0 8px !important;
        color: #f1f5f9 !important;
        font-size: 13px !important;
        line-height: 1.4 !important;
      }
      #${PANEL_ID} .blom-script-presence button {
        display: inline-block !important;
        min-height: 34px !important;
        padding: 7px 12px !important;
        margin: 2px 0 8px !important;
        border: 1px solid #77caff !important;
        border-radius: 7px !important;
        background: #245e88 !important;
        color: #ffffff !important;
        font-size: 13px !important;
        font-weight: 700 !important;
        line-height: 1.4 !important;
        text-shadow: none !important;
        cursor: pointer !important;
      }
      #${PANEL_ID} .blom-script-presence button:hover:not(:disabled) { background: #3076a6 !important; }
      #${PANEL_ID} .blom-script-presence button:focus-visible { outline: 3px solid #a6e2ff !important; outline-offset: 3px !important; }
      #${PANEL_ID} .blom-script-presence button:disabled { opacity: .7 !important; cursor: wait !important; }
      #${PANEL_ID} .blom-presence-results { color: #f1f5f9 !important; font-size: 13px !important; line-height: 1.4 !important; }
      #${PANEL_ID} .blom-presence-list > summary {
        cursor: pointer !important;
        padding: 7px 10px !important;
        color: #9bdeff !important;
        background: #252d33 !important;
        border: 1px solid #44545f !important;
        border-radius: 6px !important;
        font-weight: 700 !important;
      }
      #${PANEL_ID} .blom-presence-list[open] > summary { margin-bottom: 8px !important; }
      #${PANEL_ID} .blom-script-presence table { font-size: 12px !important; }
      #${PANEL_ID} .blom-script-presence th, #${PANEL_ID} .blom-script-presence td {
        padding: 6px 8px !important;
        color: #f1f5f9 !important;
        line-height: 1.5 !important;
      }
      #${PANEL_ID} .blom-script-presence td a { color: #9bdeff !important; text-decoration: underline !important; }

      .blom-data-actions {

        display:
          flex !important;

        flex-direction:
          column !important;

        gap:
          10px !important;

        max-width:
          520px !important;
      }

      .blom-stat {

        margin:
          5px 0 !important;

        color:
          #dce4e9 !important;
      }

      .blom-stat strong {

        color:
          #68d2ff !important;

        font-size:
          18px !important;
      }

      .blom-data-info {

        margin-top:
          8px !important;
      }

      .blom-note {

        margin-top:
          12px !important;

        padding:
          10px !important;

        border-radius:
          8px !important;

        background:
          #262d32 !important;

        color:
          #b7c1c7 !important;

        font-size:
          11px !important;
      }

      /*
       * ========================================================
       * MOBILE
       * ========================================================
       */

      @media
      (
        max-width:
        700px
      ) {

        #${SMART_SETTINGS_ID} {

          flex-wrap:
            wrap !important;

          gap:
            6px !important;
        }

        #${SMART_SETTINGS_ID}
        #${LAUNCHER_ID} {

          margin-left:
            0 !important;
        }

        #${PANEL_ID} {

          padding:
            4px !important;

          align-items:
            stretch !important;
        }

        .blom-shell {

          width:
            100% !important;

          height:
            calc(
              100dvh - 8px
            ) !important;

          max-height:
            calc(
              100dvh - 8px
            ) !important;

          border-radius:
            6px !important;
        }

        .blom-header {

          padding:
            10px 12px !important;
        }

        .blom-title {

          font-size:
            16px !important;
        }

        .blom-tabs {

          padding:
            6px !important;
        }

        .blom-tabs button {

          white-space:
            nowrap !important;

          font-size:
            11px !important;
        }

        .blom-body {

          padding:
            8px !important;

          padding-bottom:
            calc(
              20px +
              env(
                safe-area-inset-bottom
              )
            ) !important;
        }

        .blom-toolbar {

          align-items:
            stretch !important;
        }

        .blom-toolbar label {

          flex:
            1 1 145px !important;
        }

        .blom-toolbar select,
        .blom-toolbar input {

          width:
            100% !important;
        }

        .blom-toolbar
        .blom-check {

          flex:
            1 1 100% !important;
        }

        #${PANEL_ID} .blom-planner-dashboard { grid-template-columns:repeat(2,minmax(0,1fr)) !important; }
        #${PANEL_ID} .blom-assignment-grid { grid-template-columns:1fr !important; }
        #${PANEL_ID} .blom-capacity-grid { grid-template-columns:1fr !important; }
        #${PANEL_ID} .blom-section > summary { padding:10px !important; }
        #${PANEL_ID} .blom-section-body { padding:8px !important; }
        #${PANEL_ID} .blom-summary-hint { max-width:43% !important; }
        #${PANEL_ID} .blom-assignment-row {
          grid-template-columns:1fr auto !important; gap:4px 8px !important;
        }
        #${PANEL_ID} .blom-role-label { grid-column:1 / -1 !important; color:#aebbc3 !important; font-size:10px !important; }
        #${PANEL_ID} .blom-member-cell { min-width:130px !important; width:34% !important; }
        #${PANEL_ID} .blom-planner-table th, #${PANEL_ID} .blom-planner-table td { padding:9px !important; }
        #${PANEL_ID} #blom-copy-assignments { width:100% !important; padding:9px 12px !important; }

        .blom-summary {

          flex-direction:
            column !important;
        }
      }


      /* v1.7.4 compact Planner controls */
      #${PANEL_ID} .blom-planner-controlbar { display:flex !important; flex-wrap:wrap !important; gap:7px !important; align-items:center !important; margin-bottom:10px !important; }
      #${PANEL_ID} .blom-budget-button { appearance:none !important; display:inline-flex !important; align-items:center !important; min-height:36px !important; padding:7px 12px !important; border:1px solid #7996a8 !important; border-radius:7px !important; background:#293c48 !important; color:#f1f6fa !important; -webkit-text-fill-color:#f1f6fa !important; font:inherit !important; font-size:12px !important; font-weight:700 !important; line-height:1.4 !important; white-space:normal !important; text-align:center !important; cursor:pointer !important; }
      #${PANEL_ID} .blom-budget-button:hover { background:#365262 !important; border-color:#a8d9f4 !important; }
      #${PANEL_ID} .blom-budget-button:focus-visible { outline:2px solid #72caff !important; outline-offset:3px !important; }
      #${PANEL_ID} .blom-scan-main { min-height:34px !important; padding:7px 12px !important; }
      #${PANEL_ID} .blom-control-chip { display:inline-flex !important; align-items:center !important; min-height:30px !important; padding:4px 9px !important; border:1px solid #42525c !important; border-radius:999px !important; background:#182126 !important; color:#dce5ea !important; font-size:11px !important; font-weight:700 !important; white-space:nowrap !important; }
      #${PANEL_ID} .blom-control-good { border-color:#2d7d55 !important; color:#b9f3d1 !important; }
      #${PANEL_ID} .blom-control-warn { border-color:#8c6d2f !important; color:#ffe0a0 !important; }
      #${PANEL_ID} .blom-settings-drawer { position:relative !important; margin-left:auto !important; }
      #${PANEL_ID} .blom-settings-drawer > summary { list-style:none !important; cursor:pointer !important; padding:7px 10px !important; border:1px solid #42525c !important; border-radius:7px !important; background:#1d272c !important; color:#eef3f5 !important; font-weight:700 !important; }
      #${PANEL_ID} .blom-settings-drawer > summary::-webkit-details-marker { display:none !important; }
      #${PANEL_ID} .blom-settings-panel { margin-top:8px !important; padding:10px !important; border:1px solid #3d4c55 !important; border-radius:8px !important; background:#11181c !important; display:grid !important; gap:8px !important; }
      #${PANEL_ID} .blom-settings-panel { min-width:0 !important; }
      #${PANEL_ID} .blom-settings-panel details {
        min-width:0 !important; margin:4px 0 !important; border:1px solid #3d4c55 !important;
        border-radius:8px !important; background:#192227 !important; overflow:hidden !important;
        color:#dce5eb !important; font-size:12px !important; line-height:1.5 !important;
      }
      #${PANEL_ID} .blom-settings-panel details > summary {
        display:flex !important; align-items:center !important; gap:9px !important;
        padding:10px 12px !important; background:#22303a !important; color:#86d9ff !important;
        font-size:13px !important; font-weight:700 !important; cursor:pointer !important; list-style:none !important;
      }
      #${PANEL_ID} .blom-settings-panel details > summary::-webkit-details-marker { display:none !important; }
      #${PANEL_ID} .blom-settings-panel details > summary::before { content:'▸'; flex:none; }
      #${PANEL_ID} .blom-settings-panel details[open] > summary::before { content:'▾'; }
      #${PANEL_ID} .blom-settings-panel details[open] > summary { border-bottom:1px solid #3d4c55 !important; }
      #${PANEL_ID} .blom-settings-panel details > summary:hover { background:#2a3c48 !important; }
      #${PANEL_ID} .blom-settings-panel details > summary:focus-visible { outline:2px solid #66cfff !important; outline-offset:-3px !important; }
      #${PANEL_ID} .blom-detail-content { padding:12px !important; min-width:0 !important; }
      #${PANEL_ID} .blom-detail-content p { margin:0 0 12px !important; line-height:1.5 !important; }
      #${PANEL_ID} .blom-detail-content p:last-child { margin-bottom:0 !important; }
      #${PANEL_ID} .blom-api-key-field {
        display:flex !important; flex-direction:column !important; align-items:flex-start !important;
        gap:6px !important; margin:12px 0 !important; font-size:12px !important; font-weight:700 !important;
      }
      #${PANEL_ID} #blom-planner-key,
      #${PANEL_ID} #blom-target-offset {
        box-sizing:border-box !important; width:320px !important; max-width:100% !important;
        padding:10px 12px !important; border:1px solid #617985 !important; border-radius:6px !important;
        background:#111a20 !important; color:#eef5f9 !important; font-size:16px !important; line-height:1.3 !important;
      }
      #${PANEL_ID} .blom-target-stepper {
        display:grid !important; grid-template-columns:minmax(0,1fr) 44px 44px !important;
        gap:6px !important; width:320px !important; max-width:100% !important;
      }
      #${PANEL_ID} .blom-target-stepper #blom-target-offset {
        width:100% !important; min-width:0 !important; min-height:44px !important; appearance:textfield !important;
      }
      #${PANEL_ID} #blom-target-offset::-webkit-inner-spin-button,
      #${PANEL_ID} #blom-target-offset::-webkit-outer-spin-button { -webkit-appearance:none !important; margin:0 !important; }
      #${PANEL_ID} .blom-target-stepper button {
        display:flex !important; align-items:center !important; justify-content:center !important;
        min-height:44px !important; padding:0 !important; font-size:22px !important; touch-action:manipulation !important;
      }
      #${PANEL_ID} #blom-planner-key::placeholder { color:#9aadb8 !important; opacity:1 !important; }
      #${PANEL_ID} #blom-planner-key:focus { outline:2px solid #66cfff !important; outline-offset:2px !important; }
      #${PANEL_ID} .blom-detail-content .blom-terms { min-width:650px !important; margin:0 0 12px !important; }
      #${PANEL_ID} .blom-detail-content .blom-terms th,
      #${PANEL_ID} .blom-detail-content .blom-terms td { padding:10px !important; font-size:12px !important; line-height:1.5 !important; vertical-align:top !important; }
      #${PANEL_ID} .blom-settings-drawer[open] { flex:1 1 100% !important; margin-left:0 !important; }
      #${PANEL_ID} .blom-toggle-row { display:grid !important; grid-template-columns:auto 1fr !important; gap:8px !important; align-items:center !important; padding:7px !important; border-radius:7px !important; background:#182126 !important; color:#f0f4f6 !important; }
      #${PANEL_ID} .blom-toggle-row input { width:auto !important; margin:0 !important; }
      #${PANEL_ID} .blom-toggle-row span { display:flex !important; flex-direction:column !important; gap:1px !important; }
      #${PANEL_ID} .blom-toggle-row small, #${PANEL_ID} .blom-settings-status { color:#95a5ae !important; font-size:10px !important; line-height:1.35 !important; }
      #${PANEL_ID} .blom-setting-actions { display:flex !important; flex-wrap:wrap !important; gap:7px !important; }
      /* Explicit colours keep Torn's button styles from hiding these controls. */
      #${PANEL_ID} .blom-settings-panel button,
      #${PANEL_ID} .blom-inline-details button {
        color:#f5f9fc !important; background:#245679 !important; background-image:none !important;
        border:1px solid #72caff !important; border-radius:6px !important;
        min-height:36px !important; padding:8px 12px !important;
        font-size:13px !important; font-weight:700 !important; line-height:1.3 !important;
        text-shadow:none !important; cursor:pointer !important;
      }
      #${PANEL_ID} .blom-settings-panel button:hover:not(:disabled),
      #${PANEL_ID} .blom-inline-details button:hover:not(:disabled) { background:#306d94 !important; }
      #${PANEL_ID} .blom-settings-panel button:focus-visible,
      #${PANEL_ID} .blom-inline-details button:focus-visible { outline:2px solid #fff !important; outline-offset:2px !important; }
      #${PANEL_ID} .blom-settings-panel button:disabled,
      #${PANEL_ID} .blom-inline-details button:disabled { color:#bdcbd4 !important; background:#27353e !important; border-color:#607681 !important; cursor:default !important; opacity:1 !important; }

      #${PANEL_ID} .blom-empty-card { display:flex !important; flex-direction:column !important; gap:4px !important; padding:14px !important; border:1px dashed #42525c !important; border-radius:9px !important; background:#11181c !important; color:#eef3f5 !important; }
      #${PANEL_ID} .blom-empty-card span { color:#c8d2d7 !important; }
      #${PANEL_ID} .blom-empty-card small { color:#8fa0a9 !important; }
      #${PANEL_ID} .blom-newsletter-card { margin:0 0 10px !important; padding:10px !important; border:1px solid #3f5663 !important; border-radius:9px !important; background:#142027 !important; }
      #${PANEL_ID} .blom-newsletter-head { display:flex !important; justify-content:space-between !important; gap:8px !important; align-items:center !important; }
      #${PANEL_ID} .blom-newsletter-head > div { display:flex !important; flex-direction:column !important; gap:1px !important; }
      #${PANEL_ID} .blom-newsletter-head strong { color:#62c7ff !important; font-size:13px !important; }
      #${PANEL_ID} .blom-newsletter-head span { font-size:10px !important; color:#aebbc3 !important; }
      #${PANEL_ID} .blom-newsletter-note { margin-top:7px !important; color:#c7d1d6 !important; font-size:10px !important; line-height:1.4 !important; }
      #${PANEL_ID} .blom-newsletter-actions { display:flex !important; gap:7px !important; margin-top:8px !important; }
      #${PANEL_ID} .blom-newsletter-actions button { flex:1 1 0 !important; padding:8px 9px !important; }
      @media (max-width: 600px) {
        #${PANEL_ID} .blom-planner-controlbar { display:grid !important; grid-template-columns:1fr auto auto !important; }
        #${PANEL_ID} .blom-scan-main { grid-column:1 / -1 !important; width:100% !important; }
        #${PANEL_ID} .blom-settings-drawer { margin-left:0 !important; }
        #${PANEL_ID} .blom-settings-drawer[open] { grid-column:1 / -1 !important; }
        #${PANEL_ID} .blom-newsletter-actions { flex-direction:column !important; }
      }
    `;

    style.textContent += `
      /* One shared header: targets + Manager, then sharing controls. */
      #${SMART_SETTINGS_ID}{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;gap:6px!important;align-items:center!important;margin:6px 0!important}
      #${SMART_SETTINGS_ID}>.oc-smart-settings-button{grid-column:1!important;grid-row:1!important;min-width:0!important;white-space:normal!important;text-align:left!important;box-sizing:border-box!important;padding:6px 9px!important;font:600 11px/1.3 sans-serif!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;background:#1d2c35!important;border:1px solid #53778b!important;border-radius:6px!important}
      #${SMART_SETTINGS_ID}>#${LAUNCHER_ID}{grid-column:2!important;grid-row:1!important;margin:0!important;padding:6px 10px!important;min-height:44px!important;border-radius:6px!important;font:700 12px/1.3 sans-serif!important;background:#245679!important;color:#fff!important;-webkit-text-fill-color:#fff!important}
      #${SMART_SETTINGS_ID}>.bl-sharing-inline{grid-column:1 / -1!important;grid-row:2!important;width:100%!important;min-width:0!important}
      #${SMART_SETTINGS_ID} .bl-sharing-section{width:100%!important;flex-wrap:wrap!important;justify-content:flex-start!important;gap:6px!important}
      #${SMART_SETTINGS_ID} .bl-sharing-status{font-size:11px!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important}
      #${SMART_SETTINGS_ID} .bl-sharing-toggle,#${SMART_SETTINGS_ID} .bl-sharing-terms>summary{color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;background:#1d2c35!important;border:1px solid #53778b!important;border-radius:6px!important;text-shadow:none!important}
      #${SMART_SETTINGS_ID} .bl-sharing-toggle:hover:not(:disabled),#${SMART_SETTINGS_ID} .bl-sharing-terms>summary:hover{background:#306d94!important}
      #${SMART_SETTINGS_ID} .bl-sharing-toggle:focus-visible,#${SMART_SETTINGS_ID} .bl-sharing-terms>summary:focus-visible{outline:2px solid #ffe39c!important;outline-offset:2px!important}
      #${SMART_SETTINGS_ID} .bl-sharing-toggle:disabled{color:#b7c9d5!important;-webkit-text-fill-color:#b7c9d5!important;background:#263c49!important;border-color:#607c8d!important}
      #${SMART_SETTINGS_ID} .bl-sharing-toggle,#${SMART_SETTINGS_ID} .bl-sharing-terms>summary{box-sizing:border-box!important;min-height:44px!important;display:inline-flex!important;align-items:center!important;padding:5px 8px!important;font-size:11px!important}
      #${LAUNCHER_ID}{color:#fff!important;-webkit-text-fill-color:#fff!important;background:#194062!important;background-image:none!important;border:1px solid #72caff!important;text-shadow:none!important;visibility:visible!important;opacity:1!important;min-height:36px!important}
      #${LAUNCHER_ID}:hover:not(:disabled){background:#306d94!important}
      #${LAUNCHER_ID}:focus-visible{outline:2px solid #ffe39c!important;outline-offset:2px!important}
      #${LAUNCHER_ID}:disabled{color:#b7c9d5!important;-webkit-text-fill-color:#b7c9d5!important;background:#263c49!important;border-color:#607c8d!important}
      @media(max-width:600px),(pointer:coarse){#${LAUNCHER_ID}{min-height:44px!important}}
    `;
    style.textContent += `
      #${SMART_SETTINGS_ID}{grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;gap:6px!important;padding:6px!important;box-sizing:border-box!important;border:1px solid #496779!important;border-radius:8px!important;background:#19272f!important;margin:8px 0!important;align-items:stretch!important}
      #${SMART_SETTINGS_ID}>.oc-smart-settings-button,#${SMART_SETTINGS_ID}>#${LAUNCHER_ID},#${SMART_SETTINGS_ID} .bl-sharing-status,#${SMART_SETTINGS_ID} .bl-sharing-terms>summary{box-sizing:border-box!important;width:100%!important;min-height:50px!important;margin:0!important;padding:8px 10px!important;border:1px solid #557a90!important;border-radius:6px!important;display:flex!important;align-items:center!important;justify-content:center!important;text-align:center!important;font:600 12px/1.3 sans-serif!important;white-space:normal!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;background:#223743!important;box-shadow:none!important}
      #${SMART_SETTINGS_ID}>#${LAUNCHER_ID}{background:#245679!important;border-color:#72b8df!important}
      #${SMART_SETTINGS_ID} .bl-sharing-inline .bl-sharing-section{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;gap:6px!important;align-items:stretch!important}
      #${SMART_SETTINGS_ID} .bl-sharing-status{gap:4px!important}
      #${SMART_SETTINGS_ID} .bl-sharing-terms{min-width:0!important;width:100%!important}
      #${SMART_SETTINGS_ID} .bl-sharing-terms>summary{list-style:none!important;cursor:pointer!important}
      #${SMART_SETTINGS_ID} .bl-sharing-terms>summary::-webkit-details-marker{display:none!important}
      #${SMART_SETTINGS_ID} .bl-sharing-terms[open]>summary{border-color:#8bd8ff!important;background:#2a485b!important}
      #${SMART_SETTINGS_ID}>#${LAUNCHER_ID}:hover:not(:disabled),#${SMART_SETTINGS_ID} .bl-sharing-terms>summary:hover{background:#306d94!important}
      #blom-inline-scan{background:#19272f!important;border:1px solid #496779!important;border-radius:8px!important;margin:8px 0!important}
      #blom-inline-scan>button{min-height:50px!important;padding:8px 10px!important;font:600 12px/1.3 sans-serif!important;border:1px solid #72b8df!important}
      #blom-inline-scan .blom-shared-scan-card{background:#223743!important;border:1px solid #557a90!important;padding:8px 10px!important;border-radius:6px!important}
      #blom-planning-items-report{background:#19272f!important;border:1px solid #496779!important;border-radius:8px!important;padding:10px!important;margin:8px 0!important}
    `;
    style.textContent += `
      #${SMART_SETTINGS_ID}{grid-template-columns:repeat(3,minmax(0,1fr))!important;padding:4px!important;gap:4px!important;margin:6px 0!important}
      #${SMART_SETTINGS_ID}>.bl-sharing-inline{grid-column:3!important;grid-row:1!important}
      #${SMART_SETTINGS_ID} .bl-sharing-inline .bl-sharing-section{display:block!important;width:100%!important}
      #${SMART_SETTINGS_ID}>.oc-smart-settings-button,#${SMART_SETTINGS_ID}>#${LAUNCHER_ID},#${SMART_SETTINGS_ID} .bl-sharing-terms>summary{min-height:44px!important;height:100%!important;padding:6px!important;font-size:11px!important}
      #${SMART_SETTINGS_ID} .bl-sharing-terms-body .bl-sharing-status{min-height:0!important;padding:4px 0 8px!important;border:0!important;background:transparent!important;height:auto!important;justify-content:flex-start!important}
      #blom-inline-scan{padding:4px!important;gap:4px!important;margin:6px 0!important}
      #blom-inline-scan>button{min-height:44px!important;padding:6px!important}
      #blom-inline-scan .blom-shared-scan-card{padding:6px 8px!important}
    `;
    style.textContent += `
      #${PANEL_ID} .blom-tabs{align-items:center!important;gap:4px!important;padding:4px 6px!important;min-height:0!important}
      #${PANEL_ID} .blom-tabs>button{flex:0 0 auto!important;width:auto!important;min-width:0!important;height:44px!important;min-height:44px!important;max-height:44px!important;white-space:nowrap!important;overflow-wrap:normal!important;word-break:normal!important;padding:6px 10px!important;font:600 12px/1.2 sans-serif!important;box-sizing:border-box!important;border:1px solid #557a90!important;border-radius:5px!important;background:#223743!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;text-shadow:none!important}
      #${PANEL_ID} .blom-tabs>button.active{background:#245679!important;border-color:#8bd8ff!important}
      #${PANEL_ID} .blom-tabs>button:hover:not(:disabled){background:#306d94!important}
      #${PANEL_ID} .blom-tabs>button:focus-visible{outline:2px solid #ffe39c!important;outline-offset:-3px!important}
      #${PANEL_ID} .blom-tabs>button:disabled{background:#263c49!important;color:#b7c9d5!important;-webkit-text-fill-color:#b7c9d5!important;border-color:#607c8d!important}
      #${PANEL_ID} .blom-toolbar button,#${PANEL_ID} .blom-data-actions button,#${PANEL_ID} .blom-budget-button,#${PANEL_ID} .blom-scan-main{box-sizing:border-box!important;min-height:44px!important;padding:6px 10px!important;font:600 12px/1.3 sans-serif!important;color:#eaf5fc!important;-webkit-text-fill-color:#eaf5fc!important;border-radius:5px!important}
    `;
    document.head.appendChild(
      style
    );
  }

  checkpoint("B: declarations ready");
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", safeInit, { once: true });
  }
  // Also handles delayed/missed DOMContentLoaded in embedded browsers.
  const bodyPoll = setInterval(() => {
    if (document.body) { clearInterval(bodyPoll); safeInit(); }
  }, 100);
  setTimeout(safeInit, 0);

})();

