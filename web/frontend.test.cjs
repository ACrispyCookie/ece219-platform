'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ui = require('./app.js');
const fixture = () => ({id:'Lab1',title:'Εργαστήριο 1',exercises:[{id:'bs',title:'Binary search'},{id:'substr',title:'Substring'}],materials:[{role:'Εκφώνηση',path:'lab.pdf',url:'/files/lab.pdf'}],counts:{teams:2,versions:3,pending:2,reviewed:1,blocked:0},teams:[{id:'001_002',students:['001','002'],notes:null,versions:[{id:'one',archive:'first.zip',status:'pending',summary:'',exercises:[],files:[{path:'main.asm',url:'/files/main.asm',kind:'text'}],evidence:null},{id:'two',archive:'second.zip',status:'draft',summary:'Needs boundary checks',exercises:[{id:'bs',status:'incorrect',summary:'Off-by-one',findings:[{severity:'high',message:'<script>alert(1)</script>',citations:[{path:'main.asm',line:7,quote:'bgt $t0,$t1,end'}]}],oralQuestions:['Why this branch?']}],files:[{path:'main.asm',url:'/files/main.asm',kind:'text'}],evidence:{source:'legacy CSV',legacy:{exercises:{bs:{passed:3,total:8,notes:'Wrong boundaries'},substr:{score:0,notes:'Missing exit'}},theory:{score:5,notes:'Explain stack'}}}}]},{id:'003_004',students:['003','004'],notes:null,versions:[{id:'only',archive:'single.zip',status:'blocked',summary:'Extraction failed',exercises:[],files:[]}]}]});
function harness(fetcher,query='') {
 const listeners={}; const root={innerHTML:'',addEventListener:(name,fn)=>listeners[name]=fn,querySelector:()=>null};
 const history={replaceState(_state,_title,url){this.url=url;}}; const downloads=[];
 const app=ui.createApp({root,fetch:fetcher,location:{search:query,origin:'http://localhost'},history,document:{title:''},download:(value,name)=>downloads.push([value,name])});
 return {root,app,listeners,history,downloads};
}
function response(data,status=200){return {ok:status>=200&&status<300,status,json:async()=>data,text:async()=>typeof data==='string'?data:JSON.stringify(data)};}
function fetchFor(lab=fixture()) {return async url => url==='/api/labs'?response({labs:[{id:lab.id,title:lab.title,counts:lab.counts}]}):response(lab);}
test('escape all HTML and attribute metacharacters',()=>assert.equal(ui.escapeHtml('<img src=x onerror="x"> & \'test\''),'&lt;img src=x onerror=&quot;x&quot;&gt; &amp; &#39;test&#39;'));
test('only safe same-origin server links are accepted',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,x','//evil.test/x','https://evil.test/x','/\\evil.test/x','/files/\nx','http://user:pass@localhost/a']) assert.equal(ui.safeUrl(url,'http://localhost'),'');
 assert.equal(ui.safeUrl('/files/a%20b.asm','http://localhost'),'/files/a%20b.asm');
 assert.equal(ui.safeUrl('http://localhost/files/a.pdf','http://localhost'),'/files/a.pdf');
});
test('duplicate archives require explicit version and invalid selection never falls back',()=>{
 const team=fixture().teams[0]; assert.equal(ui.selectVersion(team,''),null); assert.equal(ui.selectVersion(team,'bogus'),null); assert.equal(ui.selectVersion(team,'one').id,'one');
 assert.equal(ui.selectVersion(fixture().teams[1],'').id,'only');
});
test('query routes preserve exact identifiers without guessing',()=>{
 assert.deepEqual(ui.parseRoute('?lab=Lab%20A&team=a%2Fb&version=v%261'),{lab:'Lab A',team:'a/b',version:'v&1'});
 assert.equal(ui.routeUrl({lab:'Lab A',team:'a/b',version:'v&1'}),'?lab=Lab+A&team=a%2Fb&version=v%261');
});
test('team filters search students and match any archive status',()=>{
 assert.equal(ui.filterTeams(fixture().teams,'002','draft').length,1); assert.equal(ui.filterTeams(fixture().teams,'','blocked')[0].id,'003_004'); assert.equal(ui.filterTeams(fixture().teams,'nobody','all').length,0);
});
test('request rejects HTTP, malformed JSON and network failures',async()=>{
 await assert.rejects(ui.request(async()=>response({error:'denied'},403),'/api/labs'),/403/);
 await assert.rejects(ui.request(async()=>({ok:true,json:async()=>{throw Error('bad');}}),'/api/labs'),/JSON/);
 await assert.rejects(ui.request(async()=>{throw Error('offline');},'/api/labs'),/offline/);
});
test('mount shows loading then real lab metrics, summaries, materials and exercise statuses',async()=>{
 const h=harness(fetchFor());const pending=h.app.start();assert.match(h.root.innerHTML,/Φόρτωση/); await pending;
 assert.match(h.root.innerHTML,/Εργαστήριο 1/);assert.match(h.root.innerHTML,/Needs boundary checks/);assert.match(h.root.innerHTML,/Λανθασμένη/);assert.match(h.root.innerHTML,/first.zip/);assert.match(h.root.innerHTML,/second.zip/);assert.match(h.root.innerHTML,/\/files\/lab.pdf/);assert.match(h.root.innerHTML,/Προσωριν/);assert.doesNotMatch(h.root.innerHTML,/<script>alert/);
});
test('overview labels historical raw test counts separately while agent review remains pending',async()=>{
 const h=harness(fetchFor());await h.app.start();assert.match(h.root.innerHTML,/Αρχικά τεκμήρια/);assert.match(h.root.innerHTML,/bs: 3\/8/);assert.match(h.root.innerHTML,/substr: score 0/);assert.match(h.root.innerHTML,/Θεωρία: score 5/);assert.match(h.root.innerHTML,/Αναμονή ελέγχου/);
});
test('pending reports show no fabricated scores or final grades',async()=>{
 const h=harness(fetchFor(),'?lab=Lab1&team=001_002&version=one'); await h.app.start();
 assert.match(h.root.innerHTML,/Δεν υπάρχει ακόμη/);assert.doesNotMatch(h.root.innerHTML,/100%|0\/0|10\/10|Τελικός βαθμός/);assert.match(h.root.innerHTML,/Απόφαση διδάσκοντα/);
});
test('duplicate detail asks for selection and never displays another version findings',async()=>{
 const h=harness(fetchFor(),'?lab=Lab1&team=001_002');await h.app.start(); assert.match(h.root.innerHTML,/Επιλέξτε έκδοση/);assert.doesNotMatch(h.root.innerHTML,/Off-by-one|Wrong boundaries/);
 await h.app.navigate({lab:'Lab1',team:'001_002',version:'two'}); assert.match(h.root.innerHTML,/Off-by-one/);assert.match(h.root.innerHTML,/&lt;script&gt;/); assert.match(h.root.innerHTML,/main.asm:7/);assert.match(h.root.innerHTML,/Why this branch/);
});
test('historical evidence is separate and preserves raw zero scores, theory and notes',async()=>{
 const h=harness(fetchFor(),'?lab=Lab1&team=001_002&version=two');await h.app.start();assert.match(h.root.innerHTML,/Ιστορικά τεκμήρια/);assert.match(h.root.innerHTML,/legacy CSV/);assert.match(h.root.innerHTML,/Wrong boundaries/);assert.match(h.root.innerHTML,/Missing exit/);assert.match(h.root.innerHTML,/Explain stack/);assert.match(h.root.innerHTML,/>0</);assert.match(h.root.innerHTML,/>8</);
});
test('API connection error clears loaded data instead of showing stale defaults',async()=>{
 let offline=false;const h=harness(async url=>{if(offline)throw Error('offline');return fetchFor()(url);});await h.app.start();offline=true;await h.app.navigate({lab:'Lab2',team:'',version:''});assert.match(h.root.innerHTML,/offline/);assert.doesNotMatch(h.root.innerHTML,/first.zip|Needs boundary checks/);
});
test('empty lab and invalid team routes have explicit empty states',async()=>{
 const lab=fixture();lab.teams=[];const h=harness(fetchFor(lab));await h.app.start();assert.match(h.root.innerHTML,/Δεν υπάρχουν ομάδες/);
 await h.app.navigate({lab:'Lab1',team:'missing',version:''});assert.match(h.root.innerHTML,/Η ομάδα δεν βρέθηκε/);
});
test('prepare posts to actual API and distinguishes bundle preparation from review execution',async()=>{
 const calls=[];const h=harness(async(url,opts)=>{calls.push([url,opts]);if(opts?.method==='POST')return response({prepared:3,errors:['one archive blocked']});return fetchFor()(url);});await h.app.start();await h.app.prepare();
 const call=calls.find(x=>x[1]?.method==='POST');assert.equal(call[0],'/api/labs/Lab1/prepare');assert.equal(call[1].body,'{}');assert.match(h.root.innerHTML,/3/);assert.match(h.root.innerHTML,/CLI/);assert.match(h.root.innerHTML,/one archive blocked/);assert.doesNotMatch(h.root.innerHTML,/agent running/);
});
test('human notes success requires exact server readback and stays separate from agent reports',async()=>{
 const lab=fixture();const notes={text:'Human-only note',decision:'needs_changes',grade:'7.5'};let saved=false;let readback=0;
 const h=harness(async(url,opts)=>{if(opts?.method==='POST'){assert.equal(url,'/api/labs/Lab1/notes/001_002');assert.deepEqual(JSON.parse(opts.body),notes);saved=true;return response({ok:true});}if(url==='/api/labs/Lab1'&&saved){readback++;lab.teams[0].notes=notes;}return fetchFor(lab)(url);},'?lab=Lab1&team=001_002&version=two');await h.app.start();await h.app.saveNotes(notes);assert.equal(readback,1);assert.match(h.root.innerHTML,/Αποθηκεύτηκε και επιβεβαιώθηκε/);assert.match(h.root.innerHTML,/Human-only note/);assert.match(h.root.innerHTML,/Off-by-one/);
});
test('POST success with failed or mismatched readback never claims save success',async()=>{
 for(const mode of ['failed','mismatch']){
 let saved=false;const h=harness(async(url,opts)=>{if(opts?.method==='POST'){saved=true;return response({ok:true});}if(saved&&mode==='failed')throw Error('readback offline');return fetchFor()(url);},'?lab=Lab1&team=001_002&version=one');await h.app.start();await h.app.saveNotes({text:'note',decision:'approved',grade:''});assert.doesNotMatch(h.root.innerHTML,/Αποθηκεύτηκε και επιβεβαιώθηκε/);assert.match(h.root.innerHTML,/Δεν επιβεβαιώθηκε/);
 }
});
test('save HTTP failure is visible and keeps unsaved human draft',async()=>{
 const h=harness(async(url,opts)=>opts?.method==='POST'?response({},500):fetchFor()(url),'?lab=Lab1&team=001_002&version=one');await h.app.start();await h.app.saveNotes({text:'unsaved text',decision:'pending',grade:''});assert.match(h.root.innerHTML,/500/);assert.match(h.root.innerHTML,/unsaved text/);assert.doesNotMatch(h.root.innerHTML,/Αποθηκεύτηκε και επιβεβαιώθηκε/);
});
test('text viewer fetches server file URL and escapes source code',async()=>{
 const h=harness(async url=>url==='/files/main.asm'?response('<script>bad</script>\naddi $t0,$zero,1'):fetchFor()(url),'?lab=Lab1&team=001_002&version=one');await h.app.start();await h.app.openFile('main.asm');assert.match(h.root.innerHTML,/&lt;script&gt;bad/);assert.match(h.root.innerHTML,/addi \$t0/);assert.doesNotMatch(h.root.innerHTML,/<script>bad/);
});
test('unsafe source and material URLs never become links or fetches',async()=>{
 const lab=fixture();lab.materials[0].url='javascript:alert(1)';lab.teams[0].versions[0].files[0].url='//evil.test/source';let dangerous=false;
 const h=harness(async url=>{if(url.includes('evil'))dangerous=true;return fetchFor(lab)(url);},'?lab=Lab1&team=001_002&version=one');await h.app.start();await h.app.openFile('main.asm');assert.equal(dangerous,false);assert.doesNotMatch(h.root.innerHTML,/href="javascript:|href="\/\/evil/);assert.match(h.root.innerHTML,/Μη διαθέσιμος/);
});
test('delegated keyboard-friendly actions update route and filter rendered teams',async()=>{
 const h=harness(fetchFor());await h.app.start();await h.listeners.change({target:{id:'status-filter',value:'blocked'}});assert.doesNotMatch(h.root.innerHTML,/first.zip/);assert.match(h.root.innerHTML,/single.zip/);
 await h.listeners.click({target:{closest:()=>({dataset:{action:'navigate',team:'003_004',version:'only'}})},preventDefault(){}});assert.match(h.history.url,/team=003_004/);assert.match(h.root.innerHTML,/Extraction failed/);
});
test('blocked detail exposes actual extraction errors without pretending to have an agent finding',async()=>{
 const lab=fixture();lab.teams[1].versions[0].errors=['Unsupported archive format','<img onerror=bad>'];const h=harness(fetchFor(lab),'?lab=Lab1&team=003_004');await h.app.start();assert.match(h.root.innerHTML,/Unsupported archive format/);assert.match(h.root.innerHTML,/&lt;img onerror=bad&gt;/);assert.doesNotMatch(h.root.innerHTML,/<img onerror/);
});
test('missing bundle produces a visible 404 error without claiming a download',async()=>{
 const h=harness(async url=>url.endsWith('/bundles/one')?response({},404):fetchFor()(url),'?lab=Lab1&team=001_002&version=one');await h.app.start();await h.app.downloadBundle();assert.match(h.root.innerHTML,/404/);assert.doesNotMatch(h.root.innerHTML,/Το πακέτο λήφθηκε/);
});
test('successful bundle download uses exactly the fetched server payload',async()=>{
 const payload={versionId:'one',instructions:'real prepared bundle'};const h=harness(async url=>url.endsWith('/bundles/one')?response(payload):fetchFor()(url),'?lab=Lab1&team=001_002&version=one');await h.app.start();await h.app.downloadBundle();assert.deepEqual(h.downloads[0][0],payload);assert.match(h.downloads[0][1],/one.*json/);assert.match(h.root.innerHTML,/Το πακέτο λήφθηκε/);
});
test('late navigation responses cannot replace the currently selected lab',async()=>{
 let resolve;const delayed=new Promise(r=>resolve=r);const other={...fixture(),id:'Lab2',title:'Second lab',teams:[]};const h=harness(async url=>url==='/api/labs/Lab2'?delayed:fetchFor()(url));await h.app.start();const pending=h.app.navigate({lab:'Lab2'});await h.app.navigate({lab:'Lab1'});resolve(response(other));await pending;assert.equal(h.app.state.lab.id,'Lab1');assert.match(h.root.innerHTML,/first.zip/);assert.doesNotMatch(h.root.innerHTML,/Second lab/);
});
test('historical tests show actual failed input, expected and got separately from source notes',async()=>{
 const lab=fixture();lab.teams[0].versions[1].evidence.legacy.exercises.bs.tests=[{name:'boundary',input:'N=1',expected:[-1],got:0,status:'FAIL',error:''}];const h=harness(fetchFor(lab),'?lab=Lab1&team=001_002&version=two');await h.app.start();assert.match(h.root.innerHTML,/N=1/);assert.match(h.root.innerHTML,/\[-1\]/);assert.match(h.root.innerHTML,/FAIL/);assert.match(h.root.innerHTML,/Tests χωρίς PASS/);
});
test('HTML shell is Greek, accessible, local-assets-only and responsive styles cover reduced motion',()=>{
 const html=fs.readFileSync(__dirname+'/index.html','utf8');const css=fs.readFileSync(__dirname+'/styles.css','utf8');assert.match(html,/lang="el"/);assert.match(html,/name="viewport"/);assert.match(html,/id="app"/);assert.doesNotMatch(html,/https?:\/\/|cdn\./);assert.match(css,/:focus-visible/);assert.match(css,/@media/);assert.match(css,/prefers-reduced-motion/);
});
test('confirmed team counts and unresolved identities are displayed separately',async()=>{
 const lab=fixture();lab.counts.confirmedTeams=1;lab.counts.unresolved=1;lab.teams[1].mappingNeeded=true;lab.teams[1].students=[];
 const h=harness(fetchFor(lab));await h.app.start();
 assert.match(h.root.innerHTML,/Ταυτοποιημένες ομάδες/);assert.match(h.root.innerHTML,/Χωρίς ταυτοποίηση/);assert.match(h.root.innerHTML,/Απαιτείται αντιστοίχιση ΑΜ/);
});
test('current callable evidence displays real failures separately and links citations',async()=>{
 const lab=fixture();const version=lab.teams[0].versions[1];
 version.testEvidence=[{path:'runs/two/hash.json',url:'/api/labs/Lab1/runs/two/hash.json',sourcePath:'main.asm',result:{exercise:'bs',function:'entry',status:'completed',passed:0,total:1,mode:'function',adapter:{classification:'default_callable'},suite:{sha256:'abcd'},tests:[{name:'boundary',input:{N:1},expected:[-1],got:0,status:'fail'}],not_evaluated:['ABI preservation','console behaviour','numeric final marks']}}];
 version.exercises[0].findings.push({severity:'warning',message:'Recorded run',citations:[{path:'runs/two/hash.json',line:3}]});
 const h=harness(fetchFor(lab),'?lab=Lab1&team=001_002&version=two');await h.app.start();
 assert.match(h.root.innerHTML,/Τρέχοντα callable tests/);assert.match(h.root.innerHTML,/0 \/ 1/);assert.match(h.root.innerHTML,/Ιστορικά τεκμήρια/);assert.match(h.root.innerHTML,/\[-1\]/);assert.match(h.root.innerHTML,/href="\/api\/labs\/Lab1\/runs\/two\/hash.json#L3"/);
});
test('adapter errors never display an invented zero functional score',async()=>{
 const lab=fixture();lab.teams[0].versions[0].testEvidence=[{path:'runs/one/hash.json',url:'/api/labs/Lab1/runs/one/hash.json',result:{exercise:'bs',status:'adapter_error',passed:null,total:19,tests:[],error:'label absent'}}];
 const h=harness(fetchFor(lab),'?lab=Lab1&team=001_002&version=one');await h.app.start();
 assert.match(h.root.innerHTML,/label absent/);assert.match(h.root.innerHTML,/Δεν ολοκληρώθηκε έλεγχος/);assert.doesNotMatch(h.root.innerHTML,/0 \/ 19/);
});
