const test = require('node:test');
const assert = require('node:assert/strict');
let app; try { app = require('./app.js'); } catch (e) { if(e.code !== 'MODULE_NOT_FOUND') throw e; app = {}; }
test('student text is escaped and unsafe document URLs are rejected', () => {
 assert.equal(typeof app.escapeHTML, 'function');
 assert.equal(app.escapeHTML('<img src=x>"&'), '&lt;img src=x&gt;&quot;&amp;');
 assert.equal(app.safeURL('javascript:alert(1)'), '#');
 assert.equal(app.safeURL('//evil.test/x'), '#');
 assert.equal(app.safeURL('files/a.pdf'), 'files/a.pdf');
 assert.equal(app.testName({index:23,name:'offensive raw name'}), 'Πρόσθετο test 23');
 assert.equal(app.statusLabel('CORRECT'), 'Σωστή');
});
const program=(passed,total=10)=>({status:'TESTED',passed,total});
const group=(id,versions)=>({id,students:id.split('_'),label:'Ομάδα Άλφα',versions});
const version=(passed,overall='CORRECT')=>({theory:{overall},exercises:{bs:program(passed),substr:program(10)}});
test('overview filters all versions without declaring one newest or replacing raw scores',()=>{
 assert.equal(typeof app.filterGroups,'function');
 const groups=[group('20_21',[version(10)]),group('10_11',[version(0),version(10)]),group('30_31',[])];
 assert.deepEqual(app.filterGroups(groups,{query:'10',attention:'duplicates'}).map(g=>g.id),['10_11']);
 assert.deepEqual(app.filterGroups(groups,{sort:'ratio'}).map(g=>g.id),['30_31','10_11','20_21']);
 assert.equal(app.filterGroups(groups,{query:'αλφα'}).length,3);
 assert.equal(app.filterGroups(groups,{attention:'missing'}).length,1);
 assert.equal(app.filterGroups(groups,{theory:'CORRECT'}).length,2);
 assert.equal(app.scoreText({status:'MISSING',passed:null,total:25}),'—');
 assert.equal(app.scoreText(program(0,25)),'0 / 25');
 assert.deepEqual(app.filterTests([{status:'PASS'},{status:'FAIL'}],'failed'),[{status:'FAIL'}]);
});
test('notes backups validate plain records and preserve group and oral notes',()=>{
 assert.equal(typeof app.validateNotes,'function');
 const backup={schemaVersion:1,notes:{'10_11':{group:'Σχόλιο',oral:{'10':'Κατανόηση'}}}};
 assert.deepEqual(app.validateNotes(backup),backup.notes);
 assert.throws(()=>app.validateNotes({schemaVersion:2,notes:{}}));
 assert.throws(()=>app.validateNotes({schemaVersion:1,notes:{'x':{group:3,oral:{}}}}));
 assert.throws(()=>app.validateNotes(JSON.parse('{"schemaVersion":1,"notes":{"__proto__":{"group":"x","oral":{}}}}')));
});
test('HTTP loading falls through API then JSON; file mode never fetches', async()=>{
 assert.equal(typeof app.loadData,'function');
 const data={schemaVersion:1,groups:[]}; const calls=[];
 const fetcher=async url=>{calls.push(url); if(url==='./api/data') throw Error('unavailable'); return {ok:true,json:async()=>data};};
 assert.equal((await app.loadData('https:',fetcher,null)).source,'json');
 assert.deepEqual(calls,['./api/data','./report-data.json']); calls.length=0;
 assert.equal((await app.loadData('file:',fetcher,data)).source,'embedded'); assert.equal(calls.length,0);
 await assert.rejects(()=>app.loadData('file:',fetcher,null));
});
test('API success takes priority over embedded data',async()=>{
 const data={schemaVersion:1,groups:[]},calls=[];
 const result=await app.loadData('http:',async url=>{calls.push(url);return {ok:true,json:async()=>data};},{schemaVersion:1,groups:[{id:'old'}]});
 assert.equal(result.source,'api'); assert.equal(result.data,data); assert.deepEqual(calls,['./api/data']);
});
test('invalid API and JSON results use embedded data with a visible source',async()=>{
 const data={schemaVersion:1,groups:[]};
 assert.equal((await app.loadData('http:',async()=>({ok:true,json:async()=>({groups:[]})}),data)).source,'embedded');
 await assert.rejects(()=>app.loadData('http:',async()=>({ok:false}),null));
});
test('test names are sanitized only for tests 23 through 25',()=>{
 for(const index of [23,24,25]) assert.equal(app.testName({index,name:'raw'}),`Πρόσθετο test ${index}`);
 assert.equal(app.testName({index:22,name:'ordinary'}),'ordinary');
 assert.equal(app.testName({index:26,name:'ordinary'}),'ordinary');
});
test('escape helpers protect quotes and schemes while preserving supplied relative paths',()=>{
 assert.equal(app.escapeHTML("'</textarea>"),'&#39;&lt;/textarea&gt;');
 for(const url of ['data:text/html,x','vbscript:x','https://evil.test',' //evil.test','java\nscript:x','\\\\evil.test']) assert.equal(app.safeURL(url),'#');
 assert.equal(app.safeURL('../grading_results/a%20b.log'),'../grading_results/a%20b.log');
 assert.equal(app.safeURL('./pages/1.png'),'./pages/1.png');
});
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./app.js'),'utf8');
async function runtime(page='group',{duplicate=false,failStorage=false,invalid=false,unavailable=false}={}) {
 const elements=new Map();
 for(const id of ['refresh','data-status','storage-status','query','theory-filter','attention-filter','sort','metrics','result-count','overview-content','references','group-heading','detail-content','group-navigation','tabs','version-control','group-note','save-status','backup-status']) elements.set(id,{id,value:'',innerHTML:'',textContent:'',hidden:true,disabled:false});
 const students=[{dataset:{student:'10'},value:''},{dataset:{student:'11'},value:''}];
 const form={id:'note-form',querySelectorAll:()=>students};
 const listeners={};
 const document={title:'',body:{dataset:{page}},getElementById:id=>id==='note-form'?(elements.get('detail-content').innerHTML.includes('id="note-form"')?form:null):elements.get(id)||null,addEventListener:(event,fn)=>{(listeners[event]||=[]).push(fn);}};
 const test={index:23,name:'offensive raw',input:'<script>alert(1)</script>',expected:[1],got:0,error:'<bad>',status:'FAIL',raw:'raw remains'};
 const p={status:'TESTED',passed:0,total:25,file:{name:'source.c',url:'../source.c',content:'<code>'},function:'bs',log:{url:'../raw.log',content:'raw remains'},tests:[test],console:{passed:25,total:25,tests:[{...test,status:'PASS',got:1}],method:'stdin'}};
 const v={archive:'a.zip',theory:{a_status:'CORRECT',b_status:'PARTIAL',formats_status:'CORRECT',overall:'PARTIAL',notes:'<notes>',evidence:['<evidence>']},exercises:{bs:p,substr:p},files:[{name:'x.pdf',url:'../x.pdf',kind:'document'}],documents:[{name:'x.pdf',url:'../x.pdf',pages:['../page.png']}]};
 v.archiveFile={name:'original a.zip',url:'../Lab1/submissions/a.zip',available:true};
 if(unavailable) {p.file.available=false;p.file.provenance='imported_snapshot';p.log.available=false;p.log.content=null;v.documents[0].available=false;v.documents[0].pages=[];}
 const data={schemaVersion:1,generatedAt:'2026-10-08T00:00:00Z',groups:[{id:'10_11',label:'<student>',students:['10','11'],notes:{bs:'<comment>',substr:'note'},versions:duplicate?[v,{...v,archive:'b.zip'}]:[v]}]};
 const saved={}; const window={LAB1_DATA:data,location:{protocol:'file:',search:invalid?'?id=invalid':'?id=10_11'},localStorage:{getItem:()=>null,setItem:(key,value)=>{if(failStorage)throw Error('denied'); saved[key]=value;}},addEventListener:()=>{},print:()=>{}};
 vm.runInNewContext(source,{window,document,URLSearchParams,setTimeout,Blob,URL,console});
 await new Promise(resolve=>setImmediate(resolve));
 const click=async selector=>{await listeners.click[0]({target:{closest:query=>query===selector?(selector==='[data-tab]'?{dataset:{tab:click.tab}}:{}):null}});await new Promise(resolve=>setImmediate(resolve));};
 const tab=async name=>{click.tab=name;await click('[data-tab]');};
 return {elements,listeners,students,form,saved,click,tab,window};
}
test('runtime overview renders actual counts and escaped student content',async()=>{
 const r=await runtime('overview');
 assert.match(r.elements.get('metrics').innerHTML,/<strong>1<\/strong><span>Ομάδες/);
 assert.match(r.elements.get('metrics').innerHTML,/<strong>2<\/strong><span>Φοιτητές/);
 assert.match(r.elements.get('overview-content').innerHTML,/&lt;student&gt;/);
 assert.doesNotMatch(r.elements.get('overview-content').innerHTML,/<student>/);
 r.elements.get('query').value='not found';r.listeners.input[0]({target:{closest:s=>s==='#filters'?{}:null}});
 assert.match(r.elements.get('overview-content').innerHTML,/Δεν βρέθηκαν ομάδες/);
});
test('runtime detail keeps grader and console distinct and escapes tests/source',async()=>{
 const r=await runtime();
 assert.match(r.elements.get('detail-content').innerHTML,/0 \/ 25/);
 assert.match(r.elements.get('detail-content').innerHTML,/25 \/ 25/);
 await r.tab('bs'); const html=r.elements.get('detail-content').innerHTML;
 assert.match(html,/Πρόσθετο test 23/); assert.doesNotMatch(html,/offensive raw/);
 assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;code&gt;/);assert.match(html,/raw remains/);
 await r.tab('theory');assert.match(r.elements.get('detail-content').innerHTML,/loading="lazy"/);
});
test('duplicate groups require explicit archive selection',async()=>{
 const r=await runtime('group',{duplicate:true});
 assert.match(r.elements.get('detail-content').innerHTML,/Επιλέξτε αρχείο υποβολής/);
 await r.listeners.change[0]({target:{id:'version',value:'b.zip',closest:()=>null}});
 assert.match(r.elements.get('detail-content').innerHTML,/b.zip/);
});
test('invalid group routes show an actionable empty state',async()=>{
 const r=await runtime('group',{invalid:true});
 assert.match(r.elements.get('detail-content').innerHTML,/Μη έγκυρη ομάδα/);
});
test('notes save once and remain in memory through refresh without accumulating handlers',async()=>{
 const r=await runtime();await r.tab('files');r.elements.get('group-note').value='local note';r.students[0].value='oral note';
 r.listeners.input[0]({target:{closest:s=>s==='#note-form'?{}:null}});
 await r.listeners.submit[0]({target:r.form,preventDefault:()=>{}});
 assert.match(r.elements.get('save-status').textContent,/Αποθηκεύτηκε/);
 assert.equal(JSON.parse(Object.values(r.saved)[0]).notes['10_11'].oral['10'],'oral note');
 await r.click('#refresh');await r.click('#refresh');
 assert.match(r.elements.get('detail-content').innerHTML,/local note/);
 for(const callbacks of Object.values(r.listeners)) assert.equal(callbacks.length,1);
});
test('storage failure never falsely reports saved notes',async()=>{
 const r=await runtime('group',{failStorage:true});await r.tab('files');r.elements.get('group-note').value='unsaved';
 await r.listeners.submit[0]({target:r.form,preventDefault:()=>{}});
 assert.match(r.elements.get('save-status').textContent,/Δεν αποθηκεύτηκε/);
 assert.equal(r.elements.get('storage-status').hidden,false);
 assert.equal(Object.keys(r.saved).length,0);
});
test('importing another group does not silently save current unsaved notes',async()=>{
 const r=await runtime();await r.tab('files');r.elements.get('group-note').value='draft only';
 r.listeners.input[0]({target:{closest:s=>s==='#note-form'?{}:null}});
 const backup={schemaVersion:1,notes:{'20_21':{group:'Imported',oral:{'20':'Oral'}}}};
 const target={id:'import-notes',value:'backup.json',files:[{size:200,text:async()=>JSON.stringify(backup)}],closest:()=>null};
 await r.listeners.change[0]({target});
 const saved=JSON.parse(Object.values(r.saved)[0]);assert.equal(saved.notes['10_11'],undefined);
 assert.equal(saved.notes['20_21'].group,'Imported');
 assert.match(r.elements.get('detail-content').innerHTML,/draft only/);
 assert.match(r.elements.get('backup-status').textContent,/Εισήχθησαν/);
});
test('reference text is visible safely on overview and theory, not treated as a URL',async()=>{
 const r=await runtime('overview');
 r.window.LAB1_DATA.references={theory:'α = 896; β = 94 <format>',limitations:'CSV-derived evidence'};
 r.window.LAB1_DATA.source='lab1_results_by_student.csv';
 await r.click('#refresh');
 assert.match(r.elements.get('references').innerHTML,/896/);
 assert.match(r.elements.get('references').innerHTML,/&lt;format&gt;/);
 assert.doesNotMatch(r.elements.get('references').innerHTML,/href="#"/);
 assert.match(r.elements.get('data-status').textContent,/CSV/);
 const g=await runtime();g.window.LAB1_DATA.references={theory:'α = 896; β = 94'};
 await g.click('#refresh');await g.tab('theory');
 assert.match(g.elements.get('detail-content').innerHTML,/896/);
 assert.match(g.elements.get('detail-content').innerHTML,/Μορφές εντολών/);
});
test('the overview can filter fully correct theory as well as problem states',()=>{
 assert.match(fs.readFileSync(require.resolve('./index.html'),'utf8'),/<option value="CORRECT">/);
});

test('original archive download and unavailable originals have truthful links',async()=>{
 const r=await runtime('group',{unavailable:true});await r.tab('bs');
 let html=r.elements.get('detail-content').innerHTML;
 assert.match(html,/Εισαγμένος κώδικας στιγμιοτύπου/);
 assert.match(html,/&lt;code&gt;/);
 assert.doesNotMatch(html,/href="\.\.\/source.c"/);
 assert.doesNotMatch(html,/href="\.\.\/raw.log"/);
 await r.tab('theory');html=r.elements.get('detail-content').innerHTML;
 assert.match(html,/Το αρχικό έγγραφο δεν είναι διαθέσιμο/);
 assert.doesNotMatch(html,/href="\.\.\/x.pdf"/);
 await r.tab('files');html=r.elements.get('detail-content').innerHTML;
 assert.match(html,/href="\.\.\/Lab1\/submissions\/a.zip"/);
 assert.match(html,/Αρχικό archive/);
});

test('original-versus-snapshot differences do not imply retested outcomes',async()=>{
 const r=await runtime();
 r.window.LAB1_DATA.groups[0].versions[0].exercises.bs.file.snapshotContentMismatch=true;
 await r.tab('bs');
 assert.match(r.elements.get('detail-content').innerHTML,/Ο αρχικός κώδικας διαφέρει από το εισαγμένο στιγμιότυπο/);
 assert.match(r.elements.get('detail-content').innerHTML,/δεν επανεκτελέστηκαν/);
});

test('invalid import shows feedback and does not write browser storage',async()=>{
 const r=await runtime();await r.tab('files');
 await r.listeners.change[0]({target:{id:'import-notes',files:[{size:200,text:async()=>'{"schemaVersion":9,"notes":{}}'}],closest:()=>null}});
 assert.match(r.elements.get('backup-status').textContent,/Σφάλμα εισαγωγής/);
 assert.equal(Object.keys(r.saved).length,0);
});
