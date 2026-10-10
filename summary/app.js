(function(root) {
'use strict';
const labels = {CORRECT:'Σωστή',PARTIAL:'Ελλιπής',INCORRECT:'Λανθασμένη',MISSING:'Λείπει',REVIEW_NEEDED:'Χρειάζεται έλεγχος',TESTED:'Ελέγχθηκε',PASS:'Επιτυχία',FAIL:'Αποτυχία'};
function escapeHTML(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function safeURL(value) { const s=String(value ?? '').trim(); return !s || /[\x00-\x20\\]/.test(s) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(s) ? '#' : s; }
function testName(t) { return Number(t.index)>=23 && Number(t.index)<=25 ? `Πρόσθετο test ${t.index}` : t.name || `Δοκιμή ${t.index}`; }
function statusLabel(status) { return labels[status] || 'Δεν αξιολογήθηκε'; }
function scoreText(p) { return !p || p.status==='MISSING' || p.passed==null ? '—' : `${p.passed} / ${p.total}`; }
function filterTests(tests,mode) { return (tests||[]).filter(t=>mode!=='failed'||t.status==='FAIL'); }
function programs(g) { return (g.versions||[]).flatMap(v=>[v.exercises?.bs,v.exercises?.substr]); }
function missing(g) { return !g.versions?.length || programs(g).some(p=>!p||p.status==='MISSING'); }
function attention(g) { return missing(g) || programs(g).some(p=>p.passed==null||p.passed<p.total) || (g.versions||[]).some(v=>v.theory?.overall!=='CORRECT'); }
function ratio(g) { const p=programs(g); return missing(g)?-1:Math.min(...p.map(x=>x.passed==null||!x.total?-1:x.passed/x.total)); }
function normalize(s) { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('el'); }
function filterGroups(groups,options={}) { return (groups||[]).filter(g=>normalize([g.id,g.label,...g.students||[]].join(' ')).includes(normalize(options.query)) && (!options.theory||(g.versions||[]).some(v=>v.theory?.overall===options.theory)) && (!options.attention || (options.attention==='duplicates'?g.versions?.length>1:options.attention==='missing'?missing(g):attention(g)))).sort((a,b)=>(options.sort==='ratio'?ratio(a)-ratio(b):0)||a.id.localeCompare(b.id,'el',{numeric:true})); }
function validateNotes(value) {
 const record=x=>x && typeof x==='object' && !Array.isArray(x);
 if(value?.schemaVersion!==1 || !record(value.notes)) throw Error('Μη έγκυρο αρχείο σημειώσεων.');
 for(const [id,n] of Object.entries(value.notes)) {
  if(!/^\d+(?:_\d+)*$/.test(id)||!record(n)||typeof n.group!=='string'||!record(n.oral)) throw Error('Μη έγκυρη σημείωση ομάδας.');
  for(const [student,text] of Object.entries(n.oral)) if(!/^\d+$/.test(student)||typeof text!=='string') throw Error('Μη έγκυρη προφορική σημείωση.');
 }
 return value.notes;
}
async function loadData(protocol,fetcher,embedded) {
 const valid=d=>d?.schemaVersion===1 && Array.isArray(d.groups);
 if(protocol==='http:'||protocol==='https:') for(const [url,source] of [['./api/data','api'],['./report-data.json','json']]) {
  try { const r=await fetcher(url,{cache:'no-store'}); if(!r.ok) throw Error('HTTP'); const data=await r.json(); if(valid(data)) return {data,source}; } catch (_) { /* Try read-only fallback. */ }
 }
 if(valid(embedded)) return {data:embedded,source:'embedded'};
 throw Error('Δεν ήταν δυνατή η φόρτωση των δεδομένων. Ελέγξτε τον διακομιστή ή το data.js.');
}
const api={escapeHTML,safeURL,testName,statusLabel,scoreText,filterTests,filterGroups,validateNotes,loadData};
if(typeof module !== 'undefined' && module.exports) module.exports=api;
if(typeof document === 'undefined') return;
const $=id=>document.getElementById(id), e=escapeHTML;
const noteKey='ece219-lab1-notes-v1';
const state={data:null,group:null,archive:null,tab:'overview',method:'grader',testFilter:'all',notes:{},drafts:{},dirty:new Set(),storageError:false};
const badge=s=>`<span class="badge ${Object.hasOwn(labels,s)?s:''}">${e(statusLabel(s))}</span>`;
const link=(url,text,cls='')=>`<a class="${cls}" href="${e(safeURL(url))}" target="_blank" rel="noopener">${e(text)}</a>`;
const empty=(title,text)=>`<div class="empty"><h2>${e(title)}</h2><p>${e(text)}</p></div>`;
function storageWarning(message) { state.storageError=true; $('storage-status').hidden=false; $('storage-status').textContent=message; }
try { const stored=root.localStorage.getItem(noteKey); if(stored) state.notes=validateNotes(JSON.parse(stored)); }
catch (_) { storageWarning('Δεν ήταν δυνατή η ανάγνωση των τοπικών σημειώσεων. Κρατήστε αντίγραφο JSON πριν κλείσετε τη σελίδα.'); }
function writeNotes(notes) {
 try { root.localStorage.setItem(noteKey,JSON.stringify({schemaVersion:1,notes})); state.notes=notes; state.storageError=false; $('storage-status').hidden=true; return true; }
 catch (_) { storageWarning('Η αποθήκευση απέτυχε: οι σημειώσεις δεν αποθηκεύτηκαν στον φυλλομετρητή. Εξαγάγετε αντίγραφο JSON πριν κλείσετε τη σελίδα.'); return false; }
}
function captureDraft() {
 const form=$('note-form'); if(!form||!state.group) return;
 const oral={}; form.querySelectorAll('[data-student]').forEach(input=>{oral[input.dataset.student]=input.value;});
 state.drafts[state.group.id]={group:$('group-note').value,oral};
}
function version() { return state.group?.versions?.find(v=>v.archive===state.archive); }
function overview() {
 const groups=state.data.groups;
 const students=new Set(groups.flatMap(g=>g.students||[])).size;
 const archives=groups.reduce((n,g)=>n+(g.versions||[]).length,0);
 const metrics=[[groups.length,'Ομάδες'],[students,'Φοιτητές'],[archives,'Αρχεία υποβολής'],[groups.filter(attention).length,'Ομάδες για έλεγχο'],[groups.filter(g=>g.versions?.length>1).length,'Πολλαπλές υποβολές']];
 $('metrics').innerHTML=metrics.map(([n,title])=>`<div class="metric"><strong>${n}</strong><span>${title}</span></div>`).join('');
 const filtered=filterGroups(groups,{query:$('query').value,theory:$('theory-filter').value,attention:$('attention-filter').value,sort:$('sort').value});
 $('result-count').textContent=`${filtered.length} από ${groups.length} ομάδες`;
 const scores=(g,key)=>(g.versions||[]).map((v,i)=>`<div class="version-row"><span class="v-number">#${i+1}</span><span class="score">${e(scoreText(v.exercises?.[key]))}</span>${v.exercises?.[key]?.status==='MISSING'?badge('MISSING'):''}</div>`).join('')||'—';
 $('overview-content').innerHTML=filtered.length?`<div class="table-wrap"><table><caption class="meta" style="text-align:left;padding:12px 16px">Αποτελέσματα grader ανά αρχείο υποβολής (#1, #2…). Η σειρά δεν υποδηλώνει χρόνο ή προτεραιότητα.</caption><thead><tr><th scope="col">Ομάδα / φοιτητές</th><th scope="col">Υποβολές</th><th scope="col">Δυαδική αναζήτηση</th><th scope="col">Υποσυμβολοσειρά</th><th scope="col">Θεωρία</th><th scope="col">Έλεγχος</th></tr></thead><tbody>${filtered.map(g=>`<tr><td><a class="group-link" href="group.html?id=${e(encodeURIComponent(g.id))}">${e(g.students?.join(' · ')||g.id)}</a><span class="group-label">${e(g.label)}</span></td><td>${g.versions?.length||0}${g.versions?.length>1?'<span class="group-label">Επιλογή αρχείου στις λεπτομέρειες</span>':''}</td><td>${scores(g,'bs')}</td><td>${scores(g,'substr')}</td><td>${(g.versions||[]).map((v,i)=>`<div class="version-row"><span class="v-number">#${i+1}</span>${badge(v.theory?.overall)}</div>`).join('')||badge('MISSING')}</td><td>${attention(g)?'<span class="attention-text">Χρειάζεται προσοχή</span>':'<span class="meta">Χωρίς ενδείξεις εκκρεμότητας</span>'}<br><a href="group.html?id=${e(encodeURIComponent(g.id))}">Λεπτομέρειες →</a></td></tr>`).join('')}</tbody></table></div>`:empty('Δεν βρέθηκαν ομάδες',groups.length?'Αλλάξτε ή καθαρίστε τα φίλτρα αναζήτησης.':'Δεν υπάρχουν διαθέσιμες υποβολές σε αυτά τα δεδομένα.');
 $('references').innerHTML=(state.data.csvUrl?link(state.data.csvUrl,'Αποτελέσματα CSV'):'')+(state.data.references?.theory?`<details><summary>Σωστές λύσεις θεωρίας</summary><p class="note-text">${e(state.data.references.theory)}</p></details>`:'')+(state.data.references?.limitations?`<details><summary>Περιορισμοί ελέγχου</summary><p class="note-text">${e(state.data.references.limitations)}</p></details>`:'');
}
function renderGroup() {
 const id=new URLSearchParams(root.location.search).get('id');
 state.group=state.data.groups.find(g=>g.id===id);
 if(!state.group) { $('group-heading').innerHTML='<h1>Η ομάδα δεν βρέθηκε</h1>'; $('detail-content').innerHTML=empty('Μη έγκυρη ομάδα','Επιστρέψτε στην επισκόπηση και επιλέξτε μια διαθέσιμη ομάδα.'); $('tabs').innerHTML=''; $('version-control').innerHTML=''; return; }
 const g=state.group, ordered=filterGroups(state.data.groups), index=ordered.findIndex(x=>x.id===g.id);
 document.title=`Lab 1 · ${g.students.join(' / ')}`;
 $('group-heading').innerHTML=`<div><p class="eyebrow">ΕΛΕΓΧΟΣ ΥΠΟΒΟΛΗΣ</p><h1>Ομάδα ${e(g.students.join(' · '))}</h1><p class="subtitle">${e(g.label||'')} · ${g.versions?.length||0} αρχεία υποβολής</p></div><span class="readonly">Χωρίς αυτόματη τελική βαθμολογία</span>`;
 $('group-navigation').innerHTML=[index>0?`<a href="group.html?id=${e(encodeURIComponent(ordered[index-1].id))}">← Προηγούμενη ομάδα</a>`:'',index<ordered.length-1?`<a href="group.html?id=${e(encodeURIComponent(ordered[index+1].id))}">Επόμενη ομάδα →</a>`:''].join('');
 // A multi-archive group requires an explicit choice; no guessed newest version.
 if(g.versions?.length===1) state.archive=g.versions[0].archive;
 else if(!g.versions?.some(v=>v.archive===state.archive)) state.archive=null;
 $('version-control').innerHTML=`<label>Αρχείο υποβολής<select id="version"><option value="">Επιλέξτε αρχείο για έλεγχο…</option>${(g.versions||[]).map((v,i)=>`<option value="${e(v.archive)}"${v.archive===state.archive?' selected':''}>#${i+1} · ${e(v.archive)}</option>`).join('')}</select></label><p>${g.versions?.length>1?'Υπάρχουν πολλαπλές υποβολές. Επιλέξτε συγκεκριμένο αρχείο· κανένα δεν χαρακτηρίζεται αυτόματα ως τελικό ή νεότερο.':'Η προβολή αφορά το συγκεκριμένο αρχείο υποβολής. Τα αποτελέσματα grader και κονσόλας παραμένουν χωριστά.'}</p>`;
 renderTab();
}
function renderTab() {
 const titles={overview:'Επισκόπηση',bs:'Δυαδική αναζήτηση',substr:'Υποσυμβολοσειρά',theory:'Θεωρία',files:'Αρχεία & σημειώσεις'};
 $('tabs').innerHTML=Object.entries(titles).map(([key,title])=>`<button type="button" data-tab="${key}" aria-pressed="${state.tab===key}" aria-controls="detail-content">${title}</button>`).join('');
 const v=version();
 if(state.tab==='files') { $('detail-content').innerHTML=filesView(v); return; }
 if(!v) { $('detail-content').innerHTML=empty(state.group.versions?.length?'Επιλέξτε αρχείο υποβολής':'Δεν υπάρχουν αρχεία υποβολής','Οι σημειώσεις ομάδας είναι διαθέσιμες στην ενότητα «Αρχεία & σημειώσεις».'); return; }
 $('detail-content').innerHTML=state.tab==='overview'?summaryView(v):state.tab==='theory'?theoryView(v):programView(v,state.tab);
}
function summaryView(v) {
 const bs=v.exercises?.bs,sub=v.exercises?.substr,t=v.theory||{};
 return `<div class="detail-grid"><section class="panel"><h2>Συνολική εικόνα αρχείου</h2><p class="meta">${e(v.archive)}</p><table class="summary-table"><thead><tr><th>Άσκηση</th><th>Ακατέργαστο grader</th><th>Συμπληρωματική κονσόλα</th></tr></thead><tbody>${[['Δυαδική αναζήτηση',bs],['Υποσυμβολοσειρά',sub]].map(([title,p])=>`<tr><td>${e(title)}<br>${badge(p?.status||'MISSING')}</td><td>${e(scoreText(p))}</td><td>${p?.console?e(scoreText(p.console)):'Δεν εκτελέστηκε'}</td></tr>`).join('')}</tbody></table><p class="notice">Δεν αποδίδεται τελικός βαθμός. Οι συμπληρωματικές δοκιμές δεν αντικαθιστούν τα αποτελέσματα του grader.</p><div class="actions"><button type="button" data-tab="bs">Δοκιμές δυαδικής αναζήτησης</button><button type="button" data-tab="substr">Δοκιμές υποσυμβολοσειράς</button></div></section><section class="panel"><h2>Έλεγχος θεωρίας</h2>${theoryStatuses(t)}<p class="note-text">${e(t.notes||'Δεν υπάρχουν πρόσθετες σημειώσεις θεωρίας.')}</p><button type="button" data-tab="theory">Θεωρία & τεκμήρια →</button></section></div><section class="panel"><h2>Σχόλια ελέγχου</h2><h3>Δυαδική αναζήτηση</h3><p class="note-text">${e(bs?.note||state.group.notes?.bs||'Δεν υπάρχουν σχόλια.')}</p><h3>Υποσυμβολοσειρά</h3><p class="note-text">${e(sub?.note||state.group.notes?.substr||'Δεν υπάρχουν σχόλια.')}</p><button type="button" data-tab="files">Αρχεία και τοπικές σημειώσεις →</button></section>`;
}
function theoryStatuses(t) { return `<dl>${[['a_status','Ερώτημα α'],['b_status','Ερώτημα β'],['formats_status','Μορφές εντολών'],['overall','Συνολική εκτίμηση']].map(([key,title])=>`<div class="version-row"><dt style="min-width:150px">${title}</dt><dd style="margin:0">${badge(t[key])}</dd></div>`).join('')}</dl>`; }
function documentsView(v) {
 return (v?.documents||[]).map(doc=>`<article class="document"><h3>${doc.available===false?e(doc.name):link(doc.url,doc.name)}</h3>${doc.available===false?'<p class="meta">Το αρχικό έγγραφο δεν είναι διαθέσιμο.</p>':!(doc.pages||[]).length?'<p class="meta">Δεν υπάρχουν διαθέσιμες εικόνες σελίδων· ανοίξτε το αρχικό έγγραφο.</p>':''}<div class="thumbnails">${(doc.pages||[]).map((url,i)=>`<a class="thumbnail" href="${e(safeURL(url))}" target="_blank" rel="noopener"><img src="${e(safeURL(url))}" loading="lazy" alt="${e(doc.name)} — σελίδα ${i+1}"><span>Σελίδα ${i+1} · άνοιγμα εικόνας</span></a>`).join('')}</div></article>`).join('') || '<p class="meta">Δεν υπάρχουν διαθέσιμα έγγραφα ή εικόνες σελίδων.</p>';
}
function theoryView(v) {
 const t=v.theory||{};
 return `<section><h2>Έλεγχος θεωρίας</h2><p class="notice">${e(state.data.references?.theory||'')}</p><div class="theory-grid">${[['a_status','Ερώτημα α'],['b_status','Ερώτημα β'],['formats_status','Μορφές εντολών'],['overall','Συνολική εκτίμηση']].map(([key,title])=>`<div><h3>${title}</h3>${badge(t[key])}</div>`).join('')}</div><div class="detail-grid"><section class="panel"><h2>Σημειώσεις αξιολόγησης</h2><p class="note-text">${e(t.notes||'Δεν υπάρχουν σημειώσεις θεωρίας.')}</p></section><section class="panel"><h2>Τεκμήρια</h2><ul class="evidence">${(t.evidence||[]).map(text=>`<li>${e(text)}</li>`).join('')||'<li>Δεν έχουν καταγραφεί τεκμήρια.</li>'}</ul></section></div><section class="panel"><h2>Έγγραφα υποβολής</h2>${documentsView(v)}</section></section>`;
}
function programView(v,key) {
 const p=v.exercises?.[key],title=key==='bs'?'Δυαδική αναζήτηση':'Υποσυμβολοσειρά';
 if(!p||p.status==='MISSING') return `<h2>${title}</h2>${empty('Λείπει ο κώδικας της άσκησης',p?.note||'Δεν υπάρχει διαθέσιμο πρόγραμμα για αυτό το αρχείο υποβολής.')}`;
 if(state.method==='console'&&!p.console) state.method='grader';
 const result=state.method==='console'?p.console:p,tests=filterTests(result.tests,state.testFilter);
 const showValue=value=>typeof value==='string'?value:JSON.stringify(value??'—');
 return `<section><div class="program-head"><div><h2>${title}</h2><p class="meta">Συνάρτηση: <code>${e(p.function||'—')}</code> · ${badge(p.status)}</p></div><div class="score">${e(scoreText(p))}<small> · ακατέργαστο grader</small></div></div>${p.console?`<p class="notice">Συμπληρωματική κονσόλα: <strong>${e(scoreText(p.console))}</strong> — ξεχωριστή μέθοδος, όχι αντικατάσταση του grader.</p>`:''}<p class="note-text">${e(p.note||'')}</p><div class="program-toolbar"><label>Μέθοδος ελέγχου<select id="method"><option value="grader"${state.method==='grader'?' selected':''}>Ακατέργαστο grader</option>${p.console?`<option value="console"${state.method==='console'?' selected':''}>Συμπληρωματική κονσόλα</option>`:''}</select></label><label>Δοκιμές<select id="test-filter"><option value="all"${state.testFilter==='all'?' selected':''}>Όλες οι δοκιμές</option><option value="failed"${state.testFilter==='failed'?' selected':''}>Μόνο αποτυχίες</option></select></label><p class="meta">${tests.length} από ${(result.tests||[]).length} καταγεγραμμένες δοκιμές</p></div>${state.method==='console'?`<p class="meta">Μέθοδος κονσόλας: ${e(result.method||'Δεν περιγράφεται')}</p>`:''}${tests.length?`<div class="table-wrap"><table class="tests-table"><thead><tr><th scope="col">#</th><th scope="col">Δοκιμή</th><th scope="col">Είσοδος</th><th scope="col">Αναμενόμενο</th><th scope="col">Ελήφθη</th><th scope="col">Αποτέλεσμα / σφάλμα</th></tr></thead><tbody>${tests.map(t=>`<tr><td>${e(t.index)}</td><td>${e(testName(t))}${t.raw||t.stdout||t.stderr?`<details><summary>Ακατέργαστη έξοδος</summary><pre>${e(t.raw||'')}${t.stdout?`\nΈξοδος κονσόλας:\n${e(t.stdout)}`:''}${t.stderr?`\nΣφάλματα κονσόλας:\n${e(t.stderr)}`:''}</pre></details>`:''}</td><td><pre>${e(showValue(t.input))}</pre></td><td><code>${e(showValue(t.expected))}</code></td><td><code>${e(showValue(t.got))}</code></td><td>${badge(t.status)}${t.error?`<span class="error-text">${e(t.error)}</span>`:''}</td></tr>`).join('')}</tbody></table></div>`:empty(state.testFilter==='failed'?'Δεν εμφανίζονται αποτυχίες':'Δεν υπάρχουν καταγεγραμμένες δοκιμές',state.testFilter==='failed'?'Το φίλτρο αφορά μόνο τις καταγεγραμμένες δοκιμές της επιλεγμένης μεθόδου.':'Δείτε το ακατέργαστο αρχείο καταγραφής για περισσότερα στοιχεία.')}<div class="source-block">${p.log?`<details><summary>Πλήρες αρχείο καταγραφής grader</summary><div class="details-content">${p.log.available===false?'<p class="meta">Το αρχικό log δεν είναι διαθέσιμο.</p>':link(p.log.url,'Άνοιγμα αρχείου καταγραφής')}<pre>${e(p.log.content||'Δεν υπάρχει ενσωματωμένο περιεχόμενο.')}</pre></div></details>`:''}${p.file?`<details><summary>Πηγαίος κώδικας · ${e(p.file.name)}</summary><div class="details-content">${p.file.available===false?`<p class="notice">${p.file.provenance==='imported_snapshot'?'Εισαγμένος κώδικας στιγμιοτύπου — το αρχικό αρχείο δεν είναι διαθέσιμο.':'Το αρχικό αρχείο δεν είναι διαθέσιμο.'}</p>`:link(p.file.url,'Άνοιγμα πηγαίου αρχείου')}${p.file.snapshotContentMismatch?'<p class="notice">Ο αρχικός κώδικας διαφέρει από το εισαγμένο στιγμιότυπο. Τα ιστορικά αποτελέσματα δεν επανεκτελέστηκαν.</p>':''}<pre>${e(p.file.content||'Δεν υπάρχει ενσωματωμένο περιεχόμενο.')}</pre></div></details>`:'<p class="meta">Δεν διατίθεται πηγαίο αρχείο.</p>'}</div></section>`;
}
function filesView(v) {
 const g=state.group,n=state.drafts[g.id]||state.notes[g.id]||{group:'',oral:{}};
 return `<div class="detail-grid"><div><section class="panel"><h2>Αρχεία υποβολής</h2>${v?`<p class="meta">${e(v.archive)}</p>${v.archiveFile?.available?`<p>${link(v.archiveFile.url,'Αρχικό archive · '+v.archiveFile.name)}</p>`:''}<ul class="file-list">${(v.files||[]).map(file=>`<li>${link(file.url,file.name)}<span class="meta">${e(({source:'Κώδικας',document:'Έγγραφο',log:'Καταγραφή',image:'Εικόνα',pdf:'PDF'})[file.kind]||'Αρχείο')}</span></li>`).join('')||'<li>Δεν υπάρχουν διαθέσιμα αρχεία.</li>'}</ul>${documentsView(v)}`:'<p class="meta">Επιλέξτε αρχείο υποβολής για να δείτε τα έγγραφά του.</p>'}</section><section class="panel"><h2>Σχόλια ελέγχου ομάδας</h2><h3>Δυαδική αναζήτηση</h3><p class="note-text">${e(g.notes?.bs||'Δεν υπάρχουν σχόλια.')}</p><h3>Υποσυμβολοσειρά</h3><p class="note-text">${e(g.notes?.substr||'Δεν υπάρχουν σχόλια.')}</p></section></div><section class="panel"><h2>Τοπικές σημειώσεις αξιολογητή</h2><p class="meta">Δεν αποστέλλονται στον διακομιστή. Αφορούν την ομάδα, ανεξάρτητα από το επιλεγμένο αρχείο.</p><form id="note-form" class="note-form"><label>Σημειώσεις ομάδας<textarea id="group-note">${e(n.group)}</textarea></label><h3>Προφορική εξέταση (προαιρετική)</h3>${(g.students||[]).map(student=>`<label>Φοιτητής ${e(student)}<textarea data-student="${e(student)}">${e(n.oral?.[student]||'')}</textarea></label>`).join('')}<button class="primary" type="submit">Αποθήκευση σημειώσεων</button><p id="save-status" class="save-status" role="status">${state.dirty.has(g.id)?'Μη αποθηκευμένες αλλαγές.':state.notes[g.id]?'Φορτώθηκαν οι αποθηκευμένες σημειώσεις.':'Δεν έχουν αποθηκευτεί σημειώσεις.'}</p></form><div class="backup"><h3>Αντίγραφο ασφαλείας</h3><div class="actions"><button id="export-notes" type="button">Εξαγωγή JSON</button><label class="button" for="import-notes">Εισαγωγή JSON</label><input id="import-notes" class="file-input" type="file" accept=".json,application/json"></div><p class="meta">Η εισαγωγή αντικαθιστά τις σημειώσεις της ίδιας ομάδας. Πάρτε αντίγραφο πριν την εισαγωγή.</p><p id="backup-status" role="status"></p></div></section></div>`;
}
async function refresh() {
 captureDraft(); const button=$('refresh'); button.disabled=true; $('data-status').textContent='Φόρτωση δεδομένων…';
 try {
  const result=await loadData(root.location.protocol,root.fetch?.bind(root),root.LAB1_DATA); state.data=result.data;
  const date=new Date(state.data.generatedAt),time=Number.isNaN(date.getTime())?'Μη διαθέσιμη ώρα':date.toLocaleString('el-GR');
  $('data-status').textContent=`${state.data.source==='lab1_results_by_student.csv'?'Πηγή: CSV · ':''}Παραγωγή δεδομένων: ${time} · ${result.source==='api'?'Ζωντανή ανάγνωση API':result.source==='json'?'Εφεδρικό JSON — το API δεν είναι διαθέσιμο':'Τοπικό στιγμιότυπο data.js — όχι ζωντανά δεδομένα'}`;
  if(document.body.dataset.page==='overview') overview(); else renderGroup();
 } catch(error) { $('data-status').textContent=error.message; const content=$('overview-content')||$('detail-content'); if(!state.data) content.innerHTML=empty('Αδυναμία φόρτωσης',error.message); }
 finally { button.disabled=false; }
}
// Delegated listeners are registered once, never by refresh or rerender.
document.addEventListener('click',event=>{
 const tab=event.target.closest('[data-tab]');
 if(tab) { captureDraft(); state.tab=tab.dataset.tab; renderTab(); return; }
 if(event.target.closest('#refresh')) { refresh(); return; }
 if(event.target.closest('#print')) { root.print(); return; }
 if(event.target.closest('#export-notes')) {
  captureDraft(); const notes={...state.notes,...state.drafts};
  const blob=new Blob([JSON.stringify({schemaVersion:1,notes},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url; a.download='lab1-notes.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  if($('backup-status')) $('backup-status').textContent='Δημιουργήθηκε αντίγραφο JSON (περιλαμβάνει και τις τρέχουσες αλλαγές).';
 }
});
document.addEventListener('input',event=>{
 if(event.target.closest('#filters')&&state.data) overview();
 if(event.target.closest('#note-form')) { captureDraft(); state.dirty.add(state.group.id); $('save-status').textContent='Μη αποθηκευμένες αλλαγές.'; }
});
document.addEventListener('change',async event=>{
 const target=event.target;
 if(target.closest('#filters')&&state.data) overview();
 if(target.id==='version') { captureDraft(); state.archive=target.value||null; state.method='grader'; renderTab(); }
 if(target.id==='method') { state.method=target.value; renderTab(); }
 if(target.id==='test-filter') { state.testFilter=target.value; renderTab(); }
 if(target.id==='import-notes'&&target.files?.[0]) {
  const file=target.files[0];
  try {
   if(file.size>2*1024*1024) throw Error('Το αρχείο σημειώσεων είναι υπερβολικά μεγάλο (μέγιστο 2 MB).');
   const imported=validateNotes(JSON.parse(await file.text())); captureDraft();
   const notes={...state.notes,...imported};
   if(!writeNotes(notes)) throw Error('Η εισαγωγή δεν αποθηκεύτηκε. Ελέγξτε την πρόσβαση στην τοπική αποθήκευση.');
   for(const id of Object.keys(imported)) { delete state.drafts[id]; state.dirty.delete(id); }
   if(document.body.dataset.page==='group') renderTab();
   if($('backup-status')) $('backup-status').textContent=`Εισήχθησαν και αποθηκεύτηκαν σημειώσεις ${Object.keys(imported).length} ομάδων.`;
  } catch(error) { if($('backup-status')) $('backup-status').textContent=`Σφάλμα εισαγωγής: ${error.message}`; }
  target.value='';
 }
});
document.addEventListener('submit',event=>{
 if(event.target.id==='filters') { event.preventDefault(); return; }
 if(event.target.id==='note-form') { event.preventDefault(); captureDraft(); const id=state.group.id;
  if(writeNotes({...state.notes,[id]:state.drafts[id]})) { state.dirty.delete(id); $('save-status').textContent='Αποθηκεύτηκε τοπικά στον φυλλομετρητή.'; }
  else $('save-status').textContent='Δεν αποθηκεύτηκε. Εξαγάγετε αντίγραφο JSON.';
 }
});
document.addEventListener('reset',event=>{ if(event.target.id==='filters') setTimeout(()=>{if(state.data) overview();},0); });
root.addEventListener('beforeunload',event=>{if(state.dirty.size){event.preventDefault();event.returnValue='';}});
refresh();
})(typeof window !== 'undefined' ? window : globalThis);
