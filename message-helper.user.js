// ==UserScript==
// @name         Black Ledger OC Message Helper
// @namespace    https://www.torn.com/
// @version      1.8.25
// @description  Prepare personal OC assignment messages from the Manager draft. Review and send each through Torn.
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/599035/Black%20Ledger%20OC%20Message%20Helper.user.js
// @updateURL https://update.greasyfork.org/scripts/599035/Black%20Ledger%20OC%20Message%20Helper.meta.js
// ==/UserScript==
(function () {
  'use strict';
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
    if (blSessionKey(key)) {
      try { const value=sessionStorage.getItem('bl-mail-fallback:'+key); if(value!==null)return value; } catch (_) {}
    }
    return localStorage.getItem(key);
  }
  function blStorageRemove(key) {
    if(blSessionKey(key))try{sessionStorage.removeItem('bl-mail-fallback:'+key);}catch(_){}
    localStorage.removeItem(key);
  }

  function blStorageSet(key, value) {
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
    throw new Error('Device storage is full. OC data and message history have been preserved. Free browser storage, then prepare private messages again.');
  }

  function blViewer() {
    try { return String(JSON.parse(document.getElementById('torn-user')?.value || 'null')?.id || ''); }
    catch (_) { return ''; }
  }
  function blRoster() {
    try {
      const raw=blStorageGet('black-ledger-verified-roster-v1');
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
      throw new Error('Verify faction members first: complete the Manager two-page roster check or optional membership API check (within 15 minutes).');
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

  // Quiet during normal startup; keep actionable failures visible.
  function startupStatus(text) {
    if(!document.body || !['/factions.php','/organizedcrimes.php','/messages.php'].includes(location.pathname))return;
    var marker=document.getElementById('black-ledger-pm-diagnostic');
    if(!marker){marker=document.createElement('div');marker.id='black-ledger-pm-diagnostic';marker.style.cssText='position:fixed;left:8px;right:8px;bottom:90px;z-index:2147483647;background:#542a20;color:white;border:1px solid #ffb875;padding:9px;font:14px sans-serif';document.body.appendChild(marker);}
    marker.textContent='OC Message Helper: '+text;
  }
  function boot() {
    if (!document.body) { setTimeout(boot,250); return; }
    try {
      (function () {
        'use strict';
        var draftKey = 'black-ledger-oc-newsletter-draft-v1';
        var queueKey = 'black-ledger-oc-pm-queue-v1';
        var historyKey = 'black-ledger-oc-pm-history-v1';
        var panelId = 'black-ledger-oc-message-panel';
        var launcherId = 'black-ledger-oc-message-launcher';
        var maxAge = 3600000;
        var filledId = null;
        var sendError = '';
        var sendTimeout = 45000;
        var closed = false, lastUrl = '', renderedSig = '', preparationError = '', preparationBusy = false, preparationStage = '', toolbarActionBusy = false;
        var buttonCss = 'background:#245679;color:#fff;-webkit-text-fill-color:#fff;border:1px solid #72caff;border-radius:6px;padding:8px 12px;margin:0;min-height:44px;font:bold 13px sans-serif';
        function read(key) { var raw = blStorageGet(key); return raw ? blFilterStore(key,JSON.parse(raw)) : null; }
        function write(q) { blStorageSet(queueKey, JSON.stringify(blForWrite(queueKey,q))); document.dispatchEvent(new Event('black-ledger-workspace-dirty')); }
        function fresh(d) { return d && Number(d.createdAt) > 0 && Date.now() - Number(d.createdAt) <= maxAge && Date.now() <= Number(d.expiresAt || Number(d.createdAt) + maxAge); }
        function getDraft() { var d = read(draftKey); return fresh(d) && Array.isArray(d.recipients) && d.recipients.length && d.text ? d : null; }
        function getQueue() { var q = read(queueKey); return fresh(q) && Array.isArray(q.items) ? q : null; }
        function ocUrl(id) { return 'https://www.torn.com/factions.php?step=your&type=12#/tab=crimes&crimeId=' + id; }
        function heading(line) { return String(line).match(/^\s*LEVEL\s+(\d+)\s+[\u2014-]\s+(.+?)\s+\(#(\d+)\)\s*$/i); }
        function sharedHistoryKey() {
          var r=blRequireRoster();
          return 'black-ledger-oc-pm-shared-v1:'+r.viewerId+':'+r.factionId;
        }
        function historyRead() {
          var r=blRequireRoster(),raw=blStorageGet(sharedHistoryKey());
          var h=raw?JSON.parse(raw):{version:1,viewerId:r.viewerId,factionId:r.factionId,members:{},pending:{}};
          if(h.version!==1 || h.viewerId!==r.viewerId || h.factionId!==r.factionId || !h.members || !h.pending)
            throw new Error('Message history is unreadable. Nothing changed.');
          return h;
        }
        function historySyncStatus() {
          try{var status=JSON.parse(blStorageGet(sharedHistoryKey()+':status') || 'null');
            if(Object.keys(historyRead().pending).length && (!status || status.ok))return Object.assign({},status,{ok:false,message:'Sent locally; awaiting upload to your other devices.'});
            return status;
          }catch(_){return null;}
        }
        async function refreshMessageHistory() {
          var r=blRequireRoster(),key=sharedHistoryKey(),id=crypto.randomUUID();
          blStorageSet(key+':request',JSON.stringify({id:id,at:Date.now(),viewerId:r.viewerId,factionId:r.factionId}));
          for(var i=0;i<900;i++) {
            await new Promise(function(resolve){setTimeout(resolve,100);});
            if(key!==sharedHistoryKey())throw new Error('Account or faction changed. Prepare messages again.');
            var status=historySyncStatus();
            if(status && status.requestId===id && status.message!=='Syncing sent assignments…') {
              if(!status.ok)throw new Error(status.message+' Sending paused until sync succeeds.');
              return;
            }
          }
          throw new Error('Message sync did not respond. Install Manager v1.8.50 and configure shared CPR Manager access on this device.');
        }
        function requireSyncedAssignment(item) {
          var status=historySyncStatus();
          if(!status || !status.ok || Date.now()-status.at>15000)
            throw new Error('Refresh sent history with the helper Send button before sending.');
          var history=historyRead(),r=blRequireRoster();
          var previous=history.members[item.id];
          if(previous && previous.key===itemKey(item))
            throw new Error('This assignment was already sent on one of your devices. Prepare or refresh the queue to skip it.');
          var decisions=read('black-ledger-invitation-decisions-v1:'+r.viewerId+':'+r.factionId) || {};
          var wanted=JSON.parse(itemKey(item) || '[]');
          for(var id of Object.keys(history.members)){
            if(String(id)===String(item.id))continue;
            var row=history.members[id],decision=decisions[id];
            if(decision?.mode==='release' && decision.fingerprint===JSON.stringify([row.key,row.sentAt]))continue;
            var keys;try{keys=JSON.parse(row.key);}catch(_){throw new Error('Sent role history is unreadable. Review invitations in Manager before sending.');}
            if(!Array.isArray(keys))throw new Error('Sent role history is unreadable. Review invitations in Manager before sending.');
            if(keys.some(function(key){return wanted.indexOf(key)>=0;}))throw new Error('This OC role already has a sent invitation for member '+id+'. Review and release that invitation in Manager before assigning someone else.');
          }
        }
        function assignmentKey(assignments) {
          var keys = assignments.map(function (p) {
            if (!/^\d+$/.test(String(p.crimeId)) || !String(p.role || '').trim()) throw new Error('Cannot identify an assignment.');
            return JSON.stringify([String(p.crimeId),String(p.role).trim().replace(/\s+/g,' ').toLowerCase()]);
          });
          keys = keys.filter(function (key,index) { return keys.indexOf(key) === index; }).sort();
          return keys.length ? JSON.stringify(keys) : null;
        }
        function itemKey(item) {
          if (Array.isArray(item.assignments) && item.assignments.length) return assignmentKey(item.assignments);
          var placements = [], current = null;
          String(item.text || '').split('\n').forEach(function (line) {
            var h = heading(line), r = line.match(/^Your role:\s*(.+)$/i);
            if (h) current = h[3];
            if (r && current) { placements.push({crimeId:current,role:r[1]}); current = null; }
          });
          return assignmentKey(placements);
        }
        function recordSent(item,at) {
          blRequireRoster();
          if(!blAllowed(item.id))throw new Error('This member is no longer in the verified roster.');
          var key=itemKey(item);
          if(!key)throw new Error('Cannot save assignment history for '+item.name);
          var h=historyRead(),eventId=crypto.randomUUID();
          h.members[String(item.id)]={key:key,name:item.name,sentAt:at,eventId:eventId};
          h.pending[String(item.id)]={recipient_id:String(item.id),assignment_key:key,sent_at:at,event_id:eventId};
          blStorageSet(sharedHistoryKey(),JSON.stringify(h));
          // Receipt is durable before any network operation or navigation.
        }
        function importSentQueue() {
          // Only migrate receipts whose queue explicitly identifies this sender/faction.
          var r=blRequireRoster(),q=read(queueKey),h=historyRead(),changed=false;
          if(!q || q.viewerId!==r.viewerId || q.factionId!==r.factionId || !Array.isArray(q.items))return;
          q.items.forEach(function(item){
            if(item.status!=='sent' || !blAllowed(item.id))return;
            var at=Number(item.markedAt || q.createdAt),key=itemKey(item),old=h.members[String(item.id)];
            if(key && at>0 && at<=Date.now()+60000 && (!old || at>Number(old.sentAt))) {
              var eventId=crypto.randomUUID();
              h.members[String(item.id)]={key:key,name:item.name,sentAt:at,eventId:eventId};
              h.pending[String(item.id)]={recipient_id:String(item.id),assignment_key:key,sent_at:at,event_id:eventId};
              changed=true;
            }
          });
          if(changed)blStorageSet(sharedHistoryKey(),JSON.stringify(h));
        }
        function newerDraft(q,d) { return d && Number(d.createdAt) !== Number(q.draftCreatedAt); }
        function checkSpawnReview(d) {
          var r=blRequireRoster(),status=read('black-ledger-spawn-review-v1:'+r.viewerId+':'+r.factionId);
          if(!status && !d.spawnReviewSignature)return; // Older Manager compatibility.
          if(!status || status.viewerId!==r.viewerId || status.factionId!==r.factionId || !status.approved || Date.now()>=status.expiresAt || !d.spawnReviewSignature || status.signature!==d.spawnReviewSignature)
            throw new Error('Spawn review expired or the OC plan changed. Return to Manager, rescan, review spawning and prepare fresh messages.');
        }
        function checkDraft(q) {
          var r=blRequireRoster();
          if(q && (q.viewerId!==r.viewerId || q.factionId!==r.factionId || q.items.some(function(i){return !blAllowed(i.id);})))throw new Error("Membership changed. Prepare a new queue in Manager.");
          if (!q || !fresh(q)) throw new Error('Queue expired. Prepare fresh assignments.');
          checkSpawnReview(q);
          if (newerDraft(q,getDraft())) throw new Error('New assignments are ready. Tap Refresh queue first.');
        }
        function buildQueue(d) {
          var r=blRequireRoster();
          if(!d || d.viewerId!==r.viewerId || d.factionId!==r.factionId || d.recipients.some(function(i){return !blAllowed(i.id);}))throw new Error("Prepare a verified draft in the updated Manager.");
          if (!fresh(d)) throw new Error('Assignment draft expired. Prepare a fresh draft in OC Manager.');
          checkSpawnReview(d);
          importSentQueue();
          var history = historyRead();
          var byId = {}, placements = {}, order = [];
          d.recipients.forEach(function (r) {
            var id = String(r.id), name = String(r.name || '').trim();
            if (!/^\d+$/.test(id) || !name) throw new Error('A draft recipient has an invalid ID or name.');
            if (byId[id] && byId[id] !== name) throw new Error('Conflicting recipient names for ID ' + id);
            if (!byId[id]) order.push(id);
            byId[id] = name; placements[id] = [];
          });
          var current = null;
          String(d.text).replace(/\r\n?/g, '\n').split('\n').forEach(function (line) {
            var h = heading(line);
            if (h) { current = {level:h[1],crime:h[2],id:h[3]}; return; }
            if (/^\s*LEVEL\s+/i.test(line)) { current = null; return; }
            var row = line.match(/^\s*[\u2022*-]\s+(.+?)\s+\[(\d+)\]\s+[\u2014-]\s+(.+?)\s*$/);
            if (!row) return;
            if (!current) throw new Error('An assignment has no recognised OC ID. Prepare a fresh draft.');
            if (!byId[row[2]] || byId[row[2]] !== row[1].trim()) throw new Error('Assignment and recipient list disagree for ' + row[2]);
            var assignment = {level:current.level,crime:current.crime,crimeId:current.id,role:row[3]};
            var duplicate = placements[row[2]].some(function (p) { return p.crimeId === assignment.crimeId && p.role === assignment.role; });
            if (!duplicate) placements[row[2]].push(assignment);
          });
          var items = order.map(function (id) {
            if (!placements[id].length) throw new Error('No assignment found for ' + byId[id] + ' [' + id + '].');
            var key = assignmentKey(placements[id]), previous = history.members[id];
            var unchanged = previous && previous.key === key, updated = previous && !unchanged;
            var lines = ['Hi ' + byId[id] + ',', '', 'Your ' + (updated ? 'updated ' : '') + 'Black Ledger OC assignment' + (placements[id].length > 1 ? 's:' : ':')];
            placements[id].forEach(function (p) {
              lines.push('', 'LEVEL ' + p.level + ' \u2014 ' + p.crime + ' (#' + p.crimeId + ')', 'Your role: ' + p.role);
            });
            if (updated) lines.push('', 'This replaces my previous OC assignment message.');
            lines.push('', d.messageScope === 'future' ? 'Once your current OC has finished, please join the assigned OC/role shown above. This is your next assignment; wait until your current OC is complete before joining.' : 'Please join the assigned OC/role when available.', '', 'Thanks!');
            return {id:id,name:byId[id],title:'Black Ledger \u2014 ' + (updated ? 'Updated OC assignment' : 'Your OC assignment'),text:lines.join('\n'),assignments:placements[id],assignmentKey:key,updated:!!updated,status:unchanged ? 'skipped' : 'pending'};
          });
          return {version:2,viewerId:r.viewerId,factionId:r.factionId,createdAt:Date.now(),expiresAt:Math.min(Number(d.expiresAt || Number(d.createdAt) + maxAge),Number(d.createdAt) + maxAge),draftCreatedAt:d.createdAt,spawnReviewSignature:d.spawnReviewSignature,items:items,activeId:null,openedAt:null};
        }
        function currentItem(q) { return q && q.items.filter(function (item) { return item.id === q.activeId; })[0]; }
        function composeId() { var match = location.hash.match(/(?:[?&])XID=(\d+)(?:&|$)/i); return match ? match[1] : null; }
        function onCompose() { return location.pathname === '/messages.php' && /(?:^#\/?|[&])p=compose(?:&|$)/i.test(location.hash); }
        function setStatus(text) { var el = document.getElementById('bl-pm-status'); if (el) el.textContent = text; }
        function report(error) {
          var text = 'Message Helper: ' + (error.message || String(error)); sendError=text;renderedSig='';setStatus(text);
          var button = document.getElementById(launcherId); if (button) button.textContent = text;
        }
        function element(tag, text) { var el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; }
        function action(parent, title, handler) {
          var button = element('button',title); button.type = 'button'; button.style.cssText = buttonCss;
          button.onclick = function () {
            if(button.disabled || toolbarActionBusy)return;
            try {
              var result=handler();
              if(result && typeof result.then==='function'){
                toolbarActionBusy=true;renderedSig='';
                if(document.getElementById(panelId))render();
                return Promise.resolve(result).catch(report).finally(function(){
                  toolbarActionBusy=false;renderedSig='';
                  if(document.getElementById(panelId))render();
                });
              }
            } catch (error) { report(error); }
          };
          parent.appendChild(button); return button;
        }
        function openItem(q, item) {
          checkDraft(q);
          q.activeId = item.id; q.openedAt = Date.now(); q.workflowActive = true; write(q);
          location.href = 'https://' + location.hostname + '/messages.php#/p=compose&XID=' + item.id;
        }
        function openNext(q) {
          checkDraft(q);
          var item = q.items.filter(function (i) { return i.status === 'pending'; })[0];
          if (!item) { setStatus('All members are marked sent by you.'); return; }
          openItem(q,item);
        }
        function all(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }
        function available(el) {
          if (el.closest('#' + panelId)) return false;
          var r = el.getBoundingClientRect(); return r.width > 20 && r.height > 12;
        }
        function tinyFor(editor) {
            var api = window.tinymce || window.tinyMCE, match = null;
            if (!api) return null;
            if (editor && editor.id && api.get) { var byId = api.get(editor.id); if (byId && byId.getBody) match = byId; }
            if (!match && api.editors) Array.prototype.forEach.call(api.editors, function (ed) {
              if (ed.getBody && ed.getBody() === editor) match = ed;
            });
            return match;
          }
          function editorFind() {
            // Rich editing surfaces take priority over larger backing textareas.
            var fields = all('[contenteditable="true"],[contenteditable="plaintext-only"]');
            var best = null, size = 0;
            fields.forEach(function (el) { var r = el.getBoundingClientRect(); if (available(el) && r.height > 70 && r.width * r.height > size) { best = el; size = r.width * r.height; } });
            if (best) return best;
            var frames = all('iframe');
            frames.forEach(function (frame) {
              if (best || !available(frame)) return;
              try {
                var doc = frame.contentDocument, body = doc && doc.body;
                if (body && (body.isContentEditable || body.getAttribute('contenteditable') === 'true' || doc.designMode === 'on')) best = body;
              } catch (ignored) {}
            });
            if (best) return best;
            var textareas = all('textarea[name="message"],textarea');
            textareas.forEach(function (el) {
              if (best || el.closest('#' + panelId)) return;
              var ed = tinyFor(el), body = ed && ed.getBody();
              if (body) best = body;
            });
            if (best) return best;
            // Do not push plain text into Torn's backing HTML source field.
            return null;
          }
          function subjectFind() {
          return all('input.subject,input[name="subject"],input[placeholder*="Subject"],input[placeholder*="subject"],input[class*="titleField"]').filter(available)[0] || null;
        }
        function setValue(el, value) {
          var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var desc = Object.getOwnPropertyDescriptor(proto,'value');
          if (desc && desc.set) desc.set.call(el,value); else el.value = value;
          el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
        }
        function bodyNodes(text) {
          var container = element('div');
          String(text).split('\n').forEach(function (line) {
            var row = element('div'), h = heading(line);
            if (h) { var a = element('a',line); a.href = ocUrl(h[3]); a.style.color = '#62c7ff'; a.style.textDecoration = 'underline'; row.appendChild(a); }
            else row.textContent = line || '\u00a0';
            container.appendChild(row);
          });
          return container;
        }
        function fillCurrent() {
          var q = getQueue(), item = currentItem(q);
          checkDraft(q);
          if (!item || item.status !== 'pending') throw new Error('No pending selected member. Open the next PM from the queue.');
          if (!onCompose() || composeId() !== item.id) throw new Error('This compose page does not target ' + item.name + ' [' + item.id + ']. Use Open next PM.');
          var editor = editorFind(), subject = subjectFind();
          if (!editor || !subject) throw new Error('Rich message editor not ready. Wait briefly and tap Fill this PM again. If this persists, tap Page details.');
          var nodes = bodyNodes(item.text);
          if (editor.tagName === 'TEXTAREA') {
            setValue(editor,item.text.split('\n').map(function (line) { var h = heading(line); return h ? line + '\n' + ocUrl(h[3]) : line; }).join('\n'));
          } else {
            var tiny = tinyFor(editor);
            if (tiny) { tiny.setContent(nodes.innerHTML); tiny.fire('change'); tiny.fire('input'); if (tiny.save) tiny.save(); }
            else {
              editor.focus(); while (editor.firstChild) editor.removeChild(editor.firstChild);
              while (nodes.firstChild) editor.appendChild(nodes.firstChild);
              editor.dispatchEvent(new Event('input',{bubbles:true})); editor.dispatchEvent(new Event('change',{bubbles:true}));
            }
          }
          setValue(subject,item.title);
          filledId=item.id;
          sendError = ''; renderedSig = ''; render();
        }
        function signature(q,d) { return JSON.stringify([location.href,q,d && d.createdAt,closed]); }
        function markAndNext(expectedId) {
          var latest = getQueue(), current = currentItem(latest);
          if (!current || current.status !== 'pending' || current.id !== expectedId || (onCompose() && composeId() !== current.id)) throw new Error('Selected member changed or queue expired.');
          var at = Date.now();
          recordSent(current,at);
          current.status = 'sent'; current.markedAt = at; latest.activeId = null; latest.workflowActive = latest.items.some(function (i) { return i.status === 'pending'; }); write(latest);
          if (!newerDraft(latest,getDraft()) && latest.items.some(function (i) { return i.status === 'pending'; })) openNext(latest);
          else { renderedSig = ''; render(); }
        }
        function skipPreviouslySent(expectedId) {
          var q=getQueue(),item=currentItem(q);
          checkDraft(q);
          if(!item || item.id!==expectedId || item.status!=='pending' || !onCompose() || composeId()!==item.id)throw new Error('Open the correct pending recipient before skipping.');
          if(!confirm('Have you already sent this exact OC assignment to '+item.name+' ['+item.id+']?\n\n'+item.text+'\n\nConfirm only after checking the sender and latest assignment in Previous Conversation. An older matching message followed by a different assignment needs an update. This records the current assignment in shared sent history and skips it without sending.'))return;
          checkDraft(getQueue());
          var latest=getQueue(),current=currentItem(latest);
          if(!current || current.id!==expectedId || itemKey(current)!==itemKey(item))throw new Error('Assignment changed. Review again.');
          recordSent(current,Date.now());
          current.status='skipped';current.markedAt=Date.now();latest.activeId=null;
          latest.workflowActive=latest.items.some(function(i){return i.status==='pending';});write(latest);
          if(latest.workflowActive)openNext(latest);else{renderedSig='';render();}
        }
        async function rebuild() {
          await refreshMessageHistory();
          var d = getDraft();
          if (!d) throw new Error('Prepare fresh assignments in OC Manager first.');
          write(buildQueue(d)); renderedSig = ''; render();
        }
        function pageDetails() {
          var ed = editorFind();
          setStatus('v1.8 | ' + location.href + '\nEditor: ' + (ed ? ed.tagName + ' #' + (ed.id || '') : 'not found'));
        }
        function nativeSendFind() {
          return all('button,input[type="submit"],input[type="button"],a').filter(function (el) {
            return available(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
              /^send(?: message)?$/i.test(String(el.textContent || el.value || '').trim());
          })[0] || null;
        }
        function successMarkers() {
          // Only Torn's explicit receipt is evidence; route changes alone are not.
          return all('div,p,li').filter(function (el) {
            return !el.closest('#' + panelId) && !el.querySelector('div,p,li') &&
              /^message sent to\s+/i.test(String(el.textContent || '').trim());
          });
        }
        function successFor(item, attempt) {
          return successMarkers().some(function (el) {
            var text=String(el.textContent || '').trim();
            if ((attempt.previousReceipts || []).includes(text)) return false;
            var links=Array.prototype.slice.call(el.querySelectorAll('a[href]'));
            var idMatch=links.some(function (link) {
              return new RegExp('(?:[?&])XID=' + item.id + '(?:&|$)', 'i').test(link.getAttribute('href') || '');
            });
            // PDA may render the receipt without a link, but includes [numeric ID].
            return idMatch || text.includes('[' + item.id + ']');
          });
        }
        function rateLimitWarning() {
          return Array.prototype.some.call(document.querySelectorAll('div,p,li'),function(el){
            return !el.closest('#'+panelId) && /^You can only send a message every 10 seconds\.?$/.test(String(el.textContent || '').trim());
          });
        }
        var conversationReview=null;
        function conversationAssignmentKey(text) {
          var placements=[],pattern=/LEVEL\s+\d+\s+[—-]\s+[^\n]*?\(#(\d+)\)\s*(?:https?:\/\/[^\s]+\s*)?Your role:\s*([^\n]+)/gi,match;
          while((match=pattern.exec(text)))placements.push({crimeId:match[1],role:match[2].trim()});
          return placements.length?assignmentKey(placements):null;
        }
        function conversationWarning(item) {
          if(!item || !onCompose() || composeId()!==item.id)return null;
          var wanted=itemKey(item);if(!wanted)return null;
          var editor=editorFind(),subject=subjectFind(),roots=[];
          document.querySelectorAll('th,h2,h3,h4,div,span').forEach(function(node){
            if(node.children.length>1 || String(node.textContent || '').trim()!=='Previous Conversation')return;
            var root=node.closest('table') || node.parentElement;
            for(var i=0;root && i<4;i++,root=root.parentElement){
              if(root===document.body || root===document.documentElement || root.contains(editor) || root.contains(subject))break;
              if(/Your role:/i.test(root.innerText || root.textContent || '')){if(roots.indexOf(root)<0)roots.push(root);break;}
            }
          });
          var names=[];try{var viewer=JSON.parse(document.getElementById('torn-user')?.value || 'null');[viewer?.name,viewer?.username].forEach(function(n){if(n)names.push(String(n).toLowerCase());});}catch(_){}
          document.querySelectorAll('a[href*="XID="]').forEach(function(a){if(a.getAttribute('href')?.match(/[?&]XID=(\d+)/i)?.[1]===String(blViewer())){var n=String(a.textContent || '').trim().toLowerCase();if(n)names.push(n);}});
          var messages=[];
          roots.forEach(function(root){var rows=Array.from(root.querySelectorAll('tr'));if(!rows.length)rows=Array.from(root.children);rows.slice(0,200).forEach(function(row){
            var text=String(row.innerText || row.textContent || '').replace(/\r/g,'').trim(),key=conversationAssignmentKey(text);if(!key)return;
            // Require the greeting for this recipient, never match the compose editor.
            if(text.toLowerCase().indexOf(('Hi '+item.name+',').toLowerCase())<0)return;
            var author=text.match(/^([^\n:]+):/),own=!!author && names.indexOf(author[1].trim().toLowerCase())>=0;
            var d=text.match(/(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{2,4})\s*$/),time=d?Date.UTC(Number(d[6])+(d[6].length===2?2000:0),Number(d[5])-1,Number(d[4]),Number(d[1]),Number(d[2]),Number(d[3])):null;
            messages.push({key:key,own:own,time:time,text:text});
          });});
          var datedOwn=messages.filter(function(m){return m.own && m.time!==null;}).sort(function(a,b){return b.time-a.time;});
          if(datedOwn.length){var latest=datedOwn[0];if(latest.key!==wanted)return null;return {fingerprint:item.id+'|'+wanted+'|'+latest.text,message:'Matching latest outgoing assignment is visible in Previous Conversation. Check it before sending again.'};}
          var match=messages.find(function(m){return m.key===wanted;});
          return match?{fingerprint:item.id+'|'+wanted+'|'+match.text,message:'Possible duplicate assignment in Previous Conversation. Check sender and date before sending.'}:null;
        }
        function reviewConversationSend() {
          var q=getQueue(),item=currentItem(q);checkDraft(q);
          var warning=conversationWarning(item);if(!warning)return;
          if(!confirm(warning.message+'\n\nSend this assignment again anyway? No message is sent by this confirmation.'))return;
          conversationReview=warning.fingerprint;sendError='';renderedSig='';render();
        }

        function armSend(q, item) {
          checkDraft(q);
          if (!item || item.status !== 'pending' || !onCompose() || composeId() !== item.id || filledId !== item.id)
            throw new Error('Fill and review this recipient\u2019s message first.');
          requireSyncedAssignment(item);
          var warning=typeof conversationWarning==='function'?conversationWarning(item):null;
          if(warning && conversationReview!==warning.fingerprint)throw new Error(warning.message+' Use Already sent—record and skip, or review explicitly before sending again.');
          if (q.sendAttempt && Date.now()-q.sendAttempt.at < sendTimeout)
            throw new Error('Waiting for Torn to confirm the previous send.');
          if(Number(q.cooldownUntil || 0)>Date.now())throw new Error('Wait for the send countdown to finish.');
          var editor=editorFind(), subject=subjectFind();
          if (!editor || !String(editor.textContent || '').trim() || !subject || !subject.value.trim())
            throw new Error('The message and subject must both contain text.');
          q.sendAttempt={id:item.id,key:itemKey(item),at:Date.now(),previousRateWarning:rateLimitWarning(),previousReceipts:successMarkers().map(function(el){return String(el.textContent || '').trim();})};
          q.cooldownUntil=Date.now()+10000;
          write(q);sendError='';renderedSig='';
        }
        async function claimMessageSend(item) {
          var r=blRequireRoster(),id=crypto.randomUUID(),key='black-ledger-message-claim-v1:'+r.viewerId+':'+r.factionId;
          blStorageSet(key+':request',JSON.stringify({id:id,at:Date.now(),recipient:item.id,assignment:itemKey(item)}));
          document.dispatchEvent(new Event('black-ledger-message-claim'));
          for(var i=0;i<300;i++){
            await new Promise(function(resolve){setTimeout(resolve,100);});
            var current=blRequireRoster();if(current.viewerId!==r.viewerId || current.factionId!==r.factionId)throw new Error('Account changed during send check.');
            var raw=blStorageGet(key+':status'),status=raw?JSON.parse(raw):null;
            if(status?.id===id){if(!status.ok)throw new Error(status.message);return;}
          }
          throw new Error('Cross-device send check timed out. Install Manager v1.8.50 on this device and retry after checking Torn.');
        }
        async function sendCurrent() {
          setStatus('Syncing Manager and messages across your devices…');
          await refreshMessageHistory();
          var q=getQueue(),item=currentItem(q),button=nativeSendFind();
          if (!button) throw new Error('Torn Send is not ready. Wait briefly and try again.');
          if(!item)throw new Error('No pending assignment is selected.');
          var expectedId=item.id,expectedKey=itemKey(item);
          await claimMessageSend(item);
          q=getQueue();item=currentItem(q);
          if(!item || item.id!==expectedId || itemKey(item)!==expectedKey)throw new Error('Assignment changed during cross-device send check. Review again.');
          // Torn may remount compose controls while sync/claim requests are in flight.
          button=nativeSendFind();
          if(!button || button.isConnected===false)throw new Error('Torn Send is not ready. Your message has not been sent.');
          armSend(q,item);
          // Trigger Torn's normal form workflow; never call a messaging API.
          button.click(); render();
        }
        function confirmSend() {
          var q=getQueue(),item=currentItem(q),attempt=q && q.sendAttempt;
          if (!attempt || !item || item.status!=='pending' || attempt.id!==item.id || attempt.key!==itemKey(item))return;
          checkDraft(q);
          if (!attempt.previousRateWarning && rateLimitWarning() && !successFor(item,attempt)) {
            delete q.sendAttempt;q.cooldownUntil=Date.now()+10000;write(q);
            sendError='';renderedSig='';return;
          }
          if (Date.now()-attempt.at>sendTimeout) {
            delete q.sendAttempt;write(q);sendError='Send not confirmed. Check Torn before trying again.';renderedSig='';return;
          }
          if (!successFor(item,attempt))return;
          recordSent(item,Date.now());item.status='sent';item.markedAt=Date.now();
          delete q.sendAttempt;q.cooldownUntil=Date.now()+10000;write(q);filledId=null;sendError='';renderedSig='';
        }
        function skipCurrent() {
          var q=getQueue(),item=currentItem(q);checkDraft(q);
          if (!item || item.status!=='pending' || q.sendAttempt)throw new Error('Cannot skip while a send is awaiting confirmation.');
          // Skipping does not claim that a message was sent or alter sent history.
          item.status='deferred';q.activeId=null;delete q.sendAttempt;write(q);filledId=null;
          if(q.items.some(function(i){return i.status==='pending';}))openNext(q);
          renderedSig='';render();
        }
        function mountToolbar(panel) {
          var subject=subjectFind(),editor=editorFind(),surface=editor;
          if(editor && editor.ownerDocument!==document)surface=editor.ownerDocument.defaultView.frameElement;
          var anchor=subject;
          while(anchor && surface && !anchor.contains(surface))anchor=anchor.parentElement;
          if(anchor && anchor!==document.body && anchor!==document.documentElement && anchor.parentElement) {
            panel.style.position='sticky';panel.style.top='8px';panel.style.bottom='auto';panel.style.right='auto';panel.style.width='100%';panel.style.maxWidth='none';panel.style.maxHeight='none';panel.style.overflow='visible';
            if(panel.nextSibling!==anchor)anchor.before(panel);
          } else {
            // Place the post-send controls inside the Messages content column,
            // below its title. Never insert into Torn's outer sidebar row.
            var heading=Array.prototype.find.call(document.querySelectorAll('h1,h2,h3,h4,.content-title'),function(el){
              return !el.closest('#'+panelId) && /^Messages$/i.test(String(el.textContent || '').trim());
            });
            var title=heading && (heading.closest('.content-title') || heading);
            if(title && title.parentElement && title.parentElement!==document.body && title.parentElement!==document.documentElement) {
              panel.style.position='relative';panel.style.top='auto';panel.style.bottom='auto';panel.style.right='auto';panel.style.width='100%';panel.style.maxWidth='none';panel.style.maxHeight='none';panel.style.overflow='visible';
              if(title.nextSibling!==panel)title.after(panel);
            } else {
              // During route loading, keep the temporary fallback below the mail controls.
              panel.style.position='fixed';panel.style.top='auto';panel.style.bottom='80px';panel.style.right='16px';panel.style.width='calc(100% - 32px)';panel.style.maxWidth='650px';panel.style.maxHeight='45vh';panel.style.overflow='auto';
              if(panel.parentElement!==document.body)document.body.prepend(panel);
            }
          }
        }
        function patchMessageToolbar(old,panel) {
          var children=Array.from(panel.childNodes);
          children.forEach(function(next,index){
            var current=old.childNodes[index];
            if(current && /(?:^| )bl-pm-actions(?: |$)/.test(current.className || '') && current.className===next.className){
              var wanted=Array.from(next.children),keys=new Set(wanted.map(function(b){return b.dataset.action;}));
              Array.from(current.children).forEach(function(b){if(!keys.has(b.dataset.action))b.remove();});
              wanted.forEach(function(button,i){
                var existing=Array.from(current.children).find(function(b){return b.dataset.action===button.dataset.action;});
                if(!existing){current.insertBefore(button,current.children[i] || null);return;}
                // Keep the actual tapped element attached during background redraws.
                if(existing.textContent!==button.textContent)existing.textContent=button.textContent;
                existing.onclick=button.onclick;existing.disabled=button.disabled;
                existing.className=button.className;existing.style.cssText=button.style.cssText;existing.title=button.title;
                if(current.children[i]!==existing)current.insertBefore(existing,current.children[i] || null);
              });
            }else if(current)old.replaceChild(next,current);else old.appendChild(next);
          });
          while(old.childNodes.length>children.length)old.lastChild.remove();
        }

        function render() {
          var q=getQueue(),d=getDraft(),item=currentItem(q);
          var ready=!!(item && item.status==='pending' && onCompose() && composeId()===item.id);
          var sending=!!(q && q.sendAttempt) || toolbarActionBusy,newer=q && newerDraft(q,d);
          var cooldown=Math.max(0,Math.ceil((Number(q && q.cooldownUntil || 0)-Date.now())/1000));
          var syncState=historySyncStatus();
          // Background sync timestamps/request IDs do not change the visible toolbar.
          var syncDisplay=syncState?{ok:syncState.ok,message:syncState.message}:null;
          var sig=signature(q,d)+JSON.stringify([syncDisplay,filledId,!!editorFind(),!!subjectFind(),!!nativeSendFind(),sendError,cooldown]);
          var conversation=typeof conversationWarning==='function'?conversationWarning(item):null;
          sig+='|'+(conversation?.fingerprint || '');
          var duplicateBlocked=!!conversation && conversationReview!==conversation.fingerprint;
          var old=document.getElementById(panelId);
          if(old && sig===renderedSig){mountToolbar(old);return;}
          renderedSig=sig;
          var panel=element('div');panel.id=panelId;
          panel.style.cssText='position:sticky;top:8px;z-index:10000;box-sizing:border-box;width:100%;background:#142027;color:#fff;border:1px solid #62c7ff;border-radius:7px;padding:12px;margin:10px 0;font:13px sans-serif';
          var bar=element('div');bar.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap';
          bar.appendChild(element('strong','OC private messages'));
          bar.appendChild(element('span',q?counts(q):'No active queue'));panel.appendChild(bar);
          var recipient=element('div',item?item.name+(item.updated?' · updated assignment':''):'');recipient.hidden=!item;recipient.style.cssText='color:#72caff;-webkit-text-fill-color:#72caff;margin:6px 0;font-weight:bold';panel.appendChild(recipient);
          var toolbarStyle=element('style',`
            #black-ledger-oc-message-panel .bl-pm-actions{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:6px!important;margin:0!important}
            #black-ledger-oc-message-panel .bl-pm-tools{grid-template-columns:repeat(3,minmax(0,1fr))!important;margin-top:6px!important}
            #black-ledger-oc-message-panel .bl-pm-actions button{box-sizing:border-box!important;width:100%!important;min-width:0!important;height:44px!important;min-height:44px!important;max-height:44px!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:6px 8px!important;margin:0!important;font:600 12px/1.2 sans-serif!important;white-space:normal!important;overflow-wrap:anywhere!important;touch-action:manipulation!important;color:#fff!important;-webkit-text-fill-color:#fff!important;background:#245679!important;border:1px solid #72caff!important;border-radius:5px!important;text-shadow:none!important;cursor:pointer}
            #black-ledger-oc-message-panel .bl-pm-actions button.bl-pm-send{background:#23683e!important}
            #black-ledger-oc-message-panel .bl-pm-actions button:hover:not(:disabled){background:#326e96!important}
            #black-ledger-oc-message-panel .bl-pm-actions button.bl-pm-send:hover:not(:disabled){background:#2e8050!important}
            #black-ledger-oc-message-panel .bl-pm-actions button:focus-visible{outline:2px solid #ffe39c!important;outline-offset:2px!important}
            #black-ledger-oc-message-panel .bl-pm-actions button:disabled{color:#b7c9d5!important;-webkit-text-fill-color:#b7c9d5!important;background:#263c49!important;border-color:#607c8d!important;opacity:1!important;cursor:default}
            @media(max-width:600px),(pointer:coarse){#black-ledger-oc-message-panel .bl-pm-actions button{height:44px!important;min-height:44px!important;max-height:44px!important;padding:6px!important;font-size:12px!important;max-width:100%!important}}
          `);panel.appendChild(toolbarStyle);
          var primary=element('div');primary.className='bl-pm-actions';panel.appendChild(primary);
          function control(label,handler,enabled){var b=action(primary,label,handler);b.dataset.action=label.replace(/ \(\d+s\)/,'');b.disabled=!enabled;if(!enabled)b.style.opacity='.45';return b;}
          control('Fill message',fillCurrent,ready && !sending && !newer && !!editorFind() && !!subjectFind());
          var send=control(cooldown?'Send ('+cooldown+'s)':'Send',sendCurrent,ready && !cooldown && !sending && !newer && !duplicateBlocked && filledId===item.id && !!nativeSendFind());
          send.className='bl-pm-send';send.style.background='#23683e';
          control('Next →',function(){openNext(getQueue());},!!q && !newer && !sending && (!item || item.status==='sent') && q.items.some(function(i){return i.status==='pending';}));
          control('Skip',skipCurrent,ready && !sending && !newer);
          var tools=element('div');tools.className='bl-pm-actions bl-pm-tools';panel.appendChild(tools);
          primary=tools;
          var already=control('Already sent',function(){skipPreviouslySent(item.id);},ready && !sending && !newer);already.title='Record this exact assignment as already sent and skip it, after confirmation.';
          control('Refresh queue',rebuild,!!q && !sending);
          var status=element('div');status.id='bl-pm-status';status.setAttribute('aria-live','polite');status.style.cssText='margin-top:8px;white-space:pre-wrap;color:#ffe39c;overflow-wrap:anywhere';panel.appendChild(status);
          var sync=historySyncStatus(),syncLabel=element('div',sync?sync.message:'Sent history needs sync.');syncLabel.style.cssText='margin-top:8px;color:#a9c9da';panel.appendChild(syncLabel);
          control('Sync',async function(){await refreshMessageHistory();renderedSig='';render();},!sending).title='Sync Manager and messages across your devices';
          if(conversation){var review=control('Reviewed—allow resend',reviewConversationSend,ready && !sending && !newer && duplicateBlocked);review.style.gridColumn='1 / -1';}
          // Keep the in-flow shell attached: removing it first can clamp PDA's
          // scroll position while the user is reading Previous Conversation.
          if(old){patchMessageToolbar(old,panel);panel=old;}
          mountToolbar(panel);
          setStatus((duplicateBlocked?conversation.message+' Use Already sent—record and skip after checking it.':null) || (ready && !sending && cooldown?'Wait '+cooldown+' seconds before sending. Your message is ready.':sendError) || (newer?'New assignments available. Refresh the queue.':sending?(toolbarActionBusy?'Working… please wait.':'Sending · waiting for Torn confirmation…'):item && item.status==='sent'?'Message sent. Select Next for the next recipient.':ready?(filledId===item.id?'Review the message, then select Send.':'Select Fill message to prepare this recipient\u2019s assignment.'):'Select Next to open the next recipient.'));
        }
        function isOcContext() {
          if (location.pathname === '/organizedcrimes.php') return true;
          if (location.pathname !== '/factions.php') return false;
          var route = String(location.search || '') + ' ' + String(location.hash || '');
          return /tab=crimes|organizedcrimes|organized-crimes|organized crimes|oc=/i.test(route) ||
            !!document.getElementById('oc-smart-target-settings') || !!document.querySelector('[data-oc-id]');
        }
        function counts(q) {
          return q.items.filter(function (i) { return i.status === 'pending'; }).length + ' to send | ' +
            q.items.filter(function (i) { return i.status === 'sent'; }).length + ' sent | ' +
            q.items.filter(function (i) { return i.status === 'skipped'; }).length + ' unchanged' + (q.items.some(function(i){return i.status==='deferred';}) ? ' | ' + q.items.filter(function(i){return i.status==='deferred';}).length + ' skipped' : '');
        }
        function mountManagerControl() {
          var id = 'black-ledger-oc-manager-pm', root = document.getElementById(id);
          if (!isOcContext()) { if (root) root.remove(); return; }
          var manager = document.getElementById('black-ledger-oc-manager-panel');
          var prepare = manager && manager.querySelector('#blom-prepare-newsletter');
          if (!prepare) { if (root) root.remove(); return; }
          var card = prepare.closest('.blom-newsletter-card');
          if (!card)return;
          var diagnostic=document.getElementById('black-ledger-pm-diagnostic');if(diagnostic)diagnostic.remove();
          prepare.style.display = 'none';
          var copy = card.querySelector('#blom-copy-recipients'); if (copy) copy.style.display = 'none';
          var title = card.querySelector('.blom-newsletter-head strong'); if (title) title.textContent = 'Private messages';
          var badge = card.querySelector('.blom-mini-badge'); if (badge) badge.style.display = 'none';
          var note = card.querySelector('.blom-newsletter-note');
          if (note) note.textContent = 'Messages go only to allocated members in the selected scope. The prepared queue below may be from an earlier scan or a single slot invitation; prepare again to use the current assignments. Identical latest sent assignments are skipped.';
          if (!root || !card.contains(root)) {
            if (root) root.remove();
            root = element('div'); root.id = id;
            root.style.cssText = 'margin-top:7px';
            var status = element('div'); status.id = 'black-ledger-oc-manager-pm-status';
            status.style.cssText = 'color:#ffe39c;-webkit-text-fill-color:#ffe39c;background:#142129;font-size:11px;line-height:1.5;overflow-wrap:anywhere;margin-bottom:5px'; root.appendChild(status);
            var actions = element('div'); actions.className = 'blom-newsletter-actions'; root.appendChild(actions);
            var preparePm=action(actions,'Prepare private messages',async function () {
              if(preparationBusy)return;
              preparationBusy=true;preparationError='';preparationStage='Checking sent assignments…';
              root.dataset.blPreparationBusy='1';
              mountManagerControl();
              try {
                if (!isOcContext() || !document.documentElement.contains(prepare)) throw new Error('Reopen the Manager planner first.');
                preparationError='';
                importSentQueue();
                await refreshMessageHistory();
                if(!isOcContext() || !document.documentElement.contains(prepare))throw new Error('The planner changed. Prepare again from the current assignments.');
                if(prepare.disabled)throw new Error('Review spawning before preparing messages.');
                preparationStage='Preparing current assignments…';mountManagerControl();
                var before = blStorageGet(draftKey), started = Date.now();
                // PDA may isolate userscript JS properties. Dispatch the normal
                // button click instead of reading/calling another script's onclick.
                prepare.click();
                var after = blStorageGet(draftKey), d = getDraft();
                for(var attempt=0;attempt<900 && (!d || before===after || Number(d.createdAt)<started);attempt++){
                  if(prepare.dataset.blPreparationError)throw new Error(prepare.dataset.blPreparationError);
                  preparationStage=(prepare.dataset.blPreparationStage || 'Waiting for the Manager draft…')+(attempt>=50?' ('+Math.floor(attempt/10)+'s)':'');
                  mountManagerControl();
                  await new Promise(function(resolve){setTimeout(resolve,100);});
                  after=blStorageGet(draftKey);d=getDraft();
                }
                if(prepare.dataset.blPreparationError)throw new Error(prepare.dataset.blPreparationError);
                if (!d || before === after || Number(d.createdAt) < started) throw new Error('The Manager did not finish preparing within 90 seconds. Verify members and rescan, then prepare again.');
                preparationStage='Building private messages…';mountManagerControl();
                var next = buildQueue(d); write(next);
              } catch (error) { preparationError=error.message || String(error); }
              finally { preparationBusy=false;preparationStage='';delete root.dataset.blPreparationBusy;mountManagerControl(); }
            });
            preparePm.id='black-ledger-oc-manager-pm-prepare';
            var compose = action(actions,'Compose next PM',function () {
              try { openNext(getQueue()); } catch (error) { preparationError=error.message || String(error);status.textContent=preparationError; }
            });
            compose.id = 'black-ledger-oc-manager-pm-compose';
            card.appendChild(root);
          }
          var q = getQueue(), d = getDraft(), status = document.getElementById('black-ledger-oc-manager-pm-status');
          var compose = document.getElementById('black-ledger-oc-manager-pm-compose');
          var sync=historySyncStatus();
          var preparePm=document.getElementById('black-ledger-oc-manager-pm-prepare');
          if(root) { if(preparationBusy)root.dataset.blPreparationBusy='1';else delete root.dataset.blPreparationBusy; }
          if(preparePm){preparePm.disabled=preparationBusy || prepare.disabled;preparePm.textContent=preparationBusy?'Preparing…':'Prepare private messages';preparePm.style.cssText=buttonCss+(preparePm.disabled?';background:#263b49;color:#c6d5df;-webkit-text-fill-color:#c6d5df;border-color:#607d90;opacity:1;cursor:wait':'');}
          if(preparationBusy){if(status)status.textContent=preparationStage;if(compose)compose.style.display='none';return;}
          if (status) status.textContent = preparationError || (q ? 'Last prepared queue ('+q.items.length+' recipients): '+counts(q) + (newerDraft(q,d) ? ' - prepare again to refresh' : '') : 'Prepare messages from these scanned assignments.')+' · '+(sync?sync.message:'Sent history needs sync.');
          if(status && !preparationError && (blSessionStored(draftKey) || blSessionStored(queueKey)))status.textContent+=' · Draft/queue saved in this tab. Keep this tab open until finished.';
          if (compose) compose.style.display = q && !newerDraft(q,d) && q.items.some(function (i) { return i.status === 'pending'; }) ? '' : 'none';
        }
        function onPmWorkflow(q) {
          var roster=blRoster();
          if (!roster || !q || q.viewerId!==roster.viewerId || q.factionId!==roster.factionId || location.pathname !== '/messages.php' || !(q.workflowActive || q.activeId)) return false;
          var item = currentItem(q);
          if (!item || !['pending','sent'].includes(item.status)) return false;
          if (onCompose()) return composeId() === item.id;
          return /^#\/?p=inbox(?:[&/]|$)/i.test(location.hash || '') || !location.hash;
        }
        function guardFilledMessage(event) {
          if(!filledId || !onCompose() || composeId()!==filledId)return;
          if(event && event.type==='click') {
            var button=event.target.closest && event.target.closest('button,input[type="submit"],a');
            if(!button || button.closest('#'+panelId) || !/^send(?: message)?$/i.test(String(button.textContent || button.value || '').trim()))return;
          }
          try {
            blRequireRoster();
            if(!blAllowed(filledId))throw new Error('Recipient is no longer in the verified faction roster.');
            if(event){var q=getQueue();if(q && !q.sendAttempt)armSend(q,currentItem(q));}
          } catch(error) {
            if(event) {event.preventDefault();event.stopImmediatePropagation();}
            if(!blAllowed(filledId)) {
              var ed=editorFind(),subject=subjectFind(),tiny=ed && tinyFor(ed);
              if(tiny){tiny.setContent('');tiny.fire('change');if(tiny.save)tiny.save();}
              else if(ed){if(ed.tagName==='TEXTAREA')setValue(ed,'');else {ed.textContent='';ed.dispatchEvent(new Event('input',{bubbles:true}));}}
              if(subject)setValue(subject,'');
              filledId=null;
            }
            report(error);
          }
        }
        document.addEventListener('click',guardFilledMessage,true);
        document.addEventListener('submit',guardFilledMessage,true);
        window.addEventListener('black-ledger-roster-updated',function(){guardFilledMessage();tick();});
        window.addEventListener('storage',function(event){if(event.key==='black-ledger-verified-roster-v1'){guardFilledMessage();tick();}});
        function tick() {
          if (!document.body) return;
          try {
            var launcher = document.getElementById(launcherId); if (launcher) launcher.remove();
            mountManagerControl();
            if (lastUrl !== location.href) { lastUrl = location.href; closed = false; renderedSig = ''; }
            confirmSend();
            if (onPmWorkflow(getQueue())) render();
            else { var panel = document.getElementById(panelId); if (panel) panel.remove(); renderedSig = ''; }
          } catch (error) {
            startupStatus(error.message || String(error));
            var status = document.getElementById('black-ledger-oc-manager-pm-status');
            if (status) status.textContent = error.message || String(error);
            else if (location.pathname === '/messages.php' && read(queueKey) && read(queueKey).activeId) report(error);
          }
        }
        try{importSentQueue();}catch(_){}
        document.addEventListener('black-ledger-workspace-updated',function(){renderedSig='';render();});
        document.addEventListener('black-ledger-inline-invitation',async function () {
          try {
            if(!isOcContext())throw new Error('Open the OC page to prepare an invitation.');
            var draft=getDraft();if(!draft || draft.recipients.length!==1)throw new Error('Prepare one inline invitation first.');
            var initial=blStorageGet(draftKey);
            await refreshMessageHistory();
            if(initial!==blStorageGet(draftKey))throw new Error('Draft changed during sync. Click the invitation again.');
            var queue=buildQueue(draft);write(queue);openNext(queue);
          }catch(error){report(error);}
        });
        document.addEventListener('black-ledger-manager-rendered',function(){try{mountManagerControl();}catch(_) {}});
        tick(); setInterval(tick,750);
      })();

    } catch (error) {
      if (location.pathname !== '/factions.php' && location.pathname !== '/organizedcrimes.php' && location.pathname !== '/messages.php') return;
      var marker = document.createElement('div'); marker.id = 'black-ledger-pm-startup';
      marker.style.cssText = 'position:fixed;left:8px;right:8px;bottom:85px;z-index:2147483647;background:#542a20;color:white;border:1px solid #ffb875;padding:8px;font:12px sans-serif';
      marker.textContent = 'OC PM v1.8: ' + (error.message || String(error)); document.body.appendChild(marker);
    }
  }
  boot();
})();
