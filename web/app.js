/* Dependency-free ECE218 review workspace. Server data is never executable HTML. */
(function (global) {
  'use strict';
  const STATUS = {
    pending: ['Αναμονή ελέγχου', 'neutral'], blocked: ['Μπλοκαρισμένη', 'danger'], draft: ['Προσωρινή έκθεση', 'info'],
    correct: ['Σωστή', 'success'], partial: ['Μερικώς σωστή', 'warning'], incorrect: ['Λανθασμένη', 'danger'],
    missing: ['Απουσιάζει', 'danger'], review_needed: ['Χρειάζεται έλεγχο', 'warning'],
    approved: ['Εγκρίθηκε', 'success'], needs_changes: ['Χρειάζεται αλλαγές', 'warning']
  };
  const list = value => Array.isArray(value) ? value : [];
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const e = escapeHtml;
  function safeUrl(value, origin = global.location?.origin || 'http://localhost') {
    if (typeof value !== 'string' || !value || /[\x00-\x20\\]/.test(value) || value.startsWith('//')) return '';
    if (!(value.startsWith('/') || /^https?:\/\//i.test(value))) return '';
    try {
      const url = new URL(value, origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(origin).origin || url.username || url.password) return '';
      return url.pathname + url.search + url.hash;
    } catch (_) { return ''; }
  }
  function selectVersion(team, id) {
    const versions = list(team?.versions);
    if (id) return versions.find(v => v.id === id) || null;
    return versions.length === 1 ? versions[0] : null;
  }
  function parseRoute(query) {
    const p = new URLSearchParams(query);
    return {lab:p.get('lab') || '',team:p.get('team') || '',version:p.get('version') || ''};
  }
  function routeUrl(route) {
    const p = new URLSearchParams();
    for (const key of ['lab', 'team', 'version']) if (route[key]) p.set(key, route[key]);
    return '?' + p.toString();
  }
  function filterTeams(teams, search = '', status = 'all') {
    const q = search.trim().toLocaleLowerCase('el');
    return list(teams).filter(t => (!q || [t.id, ...list(t.students).map(s => typeof s === 'object' ? JSON.stringify(s) : s), ...list(t.versions).map(v => v.archive)].join(' ').toLocaleLowerCase('el').includes(q)) &&
      (status === 'all' || list(t.versions).some(v => v.status === status) || t.notes?.decision === status));
  }
  async function request(fetcher, url, options) {
    let result;
    try { result = await fetcher(url, {cache:'no-store', ...options}); }
    catch (error) { throw new Error('Αδυναμία σύνδεσης: ' + error.message); }
    if (!result.ok) throw new Error('Το API επέστρεψε HTTP ' + result.status + '.');
    try { return await result.json(); }
    catch (_) { throw new Error('Μη έγκυρη απάντηση JSON από το API.'); }
  }
  function badge(status) {
    const [label, tone] = STATUS[status] || [status || 'Χωρίς έκθεση', 'neutral'];
    return `<span class="badge ${tone}">${e(label)}</span>`;
  }
  function notice(text, tone = 'neutral') {
    return `<div class="notice ${tone}" role="${tone === 'danger' ? 'alert' : 'status'}">${e(text)}</div>`;
  }
  const endpoint = lab => '/api/labs/' + encodeURIComponent(lab);
  const button = (label, action, extra = '', cls = '') => `<button type="button" class="${cls}" data-action="${action}" ${extra}>${e(label)}</button>`;
  function createApp(env) {
    const root = env.root;
    const state = {labs:[],lab:null,route:parseRoute(env.location.search),loading:true,error:'',search:'',filter:'all',message:'',messageTone:'neutral',busy:false,notesDraft:null,notesMessage:'',notesError:false,saving:false,viewer:null};
    let navigationSequence = 0;
    let viewerSequence = 0;
    let actionSequence = 0;
    const url = value => safeUrl(value, env.location.origin);
    const api = (path, options) => request(env.fetch, path, options);
    const teamNow = () => list(state.lab?.teams).find(t => t.id === state.route.team);
    const versionNow = () => selectVersion(teamNow(), state.route.version);
    function link(path, label, cls = '', download = false) {
      const href = url(path);
      return href ? `<a class="${cls}" href="${e(href)}" ${download ? 'download' : 'target="_blank" rel="noopener noreferrer"'}>${e(label)}${download ? '' : '<span class="sr-only"> (νέα καρτέλα)</span>'}</a>` : `<span class="muted">${e(label)} · Μη διαθέσιμος σύνδεσμος</span>`;
    }
    function navLink(team, version, label, cls = '') {
      return `<a class="${cls}" href="${e(routeUrl({lab:state.route.lab,team:team || '',version:version || ''}))}" data-action="navigate" data-team="${e(team || '')}" data-version="${e(version || '')}">${e(label)}</a>`;
    }
    function metrics() {
      const counts = state.lab?.counts || {};
      const fields = counts.confirmedTeams == null ? [['teams','Ομάδες']] : [['confirmedTeams','Ταυτοποιημένες ομάδες'],['unresolved','Χωρίς ταυτοποίηση']];
      return `<div class="metrics" aria-label="Σύνοψη εργαστηρίου">${[...fields,['versions','Εκδόσεις'],['pending','Σε αναμονή'],['reviewed','Με έκθεση'],['blocked','Μπλοκαρισμένες']].map(([key,label]) => `<div class="metric"><span>${e(label)}</span><strong>${e(counts[key] ?? '—')}</strong></div>`).join('')}</div>`;
    }
    function materials() {
      const entries = list(state.lab.materials);
      return `<details class="materials panel"><summary>Υλικό αναφοράς <span class="muted">${entries.length}</span></summary>${entries.length ? `<ul class="material-list">${entries.map(m => `<li><span class="eyebrow">${e(m.role || 'Υλικό')}</span>${link(m.url, m.path || m.role || 'Αρχείο')}</li>`).join('')}</ul>` : '<p class="muted">Δεν υπάρχει διαθέσιμο υλικό αναφοράς.</p>'}</details>`;
    }
    function exerciseChips(version) {
      const exercises = list(state.lab.exercises);
      return `<div class="exercise-chips">${exercises.map(ex => {
        const result = list(version.exercises).find(r => r.id === ex.id);
        return `<span class="exercise-chip"><span>${e(ex.title || ex.id)}</span>${badge(result?.status || (version.status === 'draft' ? 'review_needed' : 'pending'))}</span>`;
      }).join('')}</div>`;
    }
    function evidenceSummary(version) {
      const legacy=version.evidence?.legacy;
      if(!legacy) return '';
      const rawSummary=(name,item)=>{
        if(!item || typeof item!=='object') return '';
        const parts=[];
        if(item.passed!=null && item.total!=null) parts.push(item.passed+'/'+item.total+' tests');
        if(item.score!=null) parts.push('score '+item.score);
        if(item.status || item.overall) parts.push(item.status || item.overall);
        return parts.length ? name+': '+parts.join(' · ') : '';
      };
      const values=Object.entries(legacy.exercises || {}).map(([name,item])=>rawSummary(name,item));
      if(legacy.theory) values.push(rawSummary('Θεωρία',legacy.theory));
      const entries=values.filter(Boolean);
      return entries.length ? `<p class="historical-summary"><span>Αρχικά τεκμήρια:</span> ${e(entries.join(' / '))} <span class="muted">· όχι νέος έλεγχος</span></p>` : '';
    }
    function overview() {
      const teams = filterTeams(state.lab.teams,state.search,state.filter);
      return `<section aria-labelledby="teams-heading"><div class="section-heading"><div><p class="eyebrow">ΕΙΚΟΝΑ ΕΡΓΑΣΤΗΡΙΟΥ</p><h2 id="teams-heading">Ομάδες & υποβολές</h2></div><span class="muted">${teams.length} / ${list(state.lab.teams).length} ομάδες</span></div>
        <div class="filters"><div class="search-field"><label for="team-search">Αναζήτηση ομάδας</label><input type="search" id="team-search" value="${e(state.search)}" placeholder="ΑΜ, ομάδα ή αρχείο…" autocomplete="off"></div><div><label for="status-filter">Κατάσταση</label><select id="status-filter">${[['all','Όλες οι καταστάσεις'],['pending','Αναμονή ελέγχου'],['draft','Προσωρινή έκθεση'],['blocked','Μπλοκαρισμένη'],['approved','Εγκρίθηκε από διδάσκοντα'],['needs_changes','Χρειάζεται αλλαγές']].map(([v,l]) => `<option value="${v}" ${state.filter===v?'selected':''}>${e(l)}</option>`).join('')}</select></div></div>
        ${teams.length ? `<div class="team-list">${teams.map(t => `<article class="team-card panel"><div class="team-card-heading"><div><h3>${navLink(t.id,'',t.id)}</h3><p class="muted students">ΑΜ: ${e(list(t.students).map(s => typeof s === 'object' ? s.name || s.id || JSON.stringify(s) : s).join(' · '))}</p></div><div class="team-meta">${t.mappingNeeded ? '<span class="badge warning">Απαιτείται αντιστοίχιση ΑΜ</span>' : ''}${t.notes?.decision ? badge(t.notes.decision) : ''}${list(t.versions).length > 1 ? '<span class="badge warning">Πολλαπλές εκδόσεις · επιλέξτε ρητά</span>' : ''}</div></div>${list(t.versions).length ? list(t.versions).map(v => `<div class="version-row"><div class="version-top"><div>${navLink(t.id,v.id,v.archive || v.id,'archive-link')}${badge(v.status)}</div>${navLink(t.id,v.id,'Άνοιγμα →','open-link')}</div><p class="version-summary">${e(v.summary || (v.status === 'blocked' ? 'Η υποβολή είναι μπλοκαρισμένη. Ανοίξτε την έκδοση για τα διαθέσιμα στοιχεία.' : 'Δεν υπάρχει ακόμη έκθεση ελέγχου.'))}</p>${exerciseChips(v)}${evidenceSummary(v)}</div>`).join('') : '<p class="empty-inline">Δεν υπάρχουν εκδόσεις για αυτή την ομάδα.</p>'}</article>`).join('')}</div>` : `<div class="empty panel"><h3>${list(state.lab.teams).length ? 'Δεν βρέθηκαν αποτελέσματα' : 'Δεν υπάρχουν ομάδες'}</h3><p>${list(state.lab.teams).length ? 'Δοκιμάστε άλλο ΑΜ ή αλλάξτε το φίλτρο κατάστασης.' : 'Οι υποβολές θα εμφανιστούν όταν προστεθούν στο εργαστήριο.'}</p></div>`}
      </section>`;
    }
    function citation(c, version) {
      const file = [...list(version.files), ...list(version.testEvidence), ...list(state.lab.materials)].find(f => f.path === c.path);
      const base = url(file?.url);
      const positive = value => Number.isInteger(value) && value > 0;
      const label = String(c.path || 'Πηγή') + (positive(c.line) ? ':' + c.line : '') + (positive(c.page) ? ' · σ. ' + c.page : '');
      const source = base ? link(base.split('#')[0] + (positive(c.page) ? '#page=' + c.page : positive(c.line) ? '#L' + c.line : ''),label) : `<span class="source-unavailable">${e(label)} <span class="muted">(χωρίς διαθέσιμο σύνδεσμο)</span></span>`;
      return `<li>${source}${c.quote ? `<blockquote>${e(c.quote)}</blockquote>` : ''}</li>`;
    }
    function agentReport(version) {
      const results = list(version.exercises);
      const descriptors = list(state.lab.exercises);
      const extra = results.filter(r => !descriptors.some(ex => ex.id === r.id)).map(r => ({id:r.id,title:r.id}));
      return `<section class="agent-report" aria-labelledby="agent-heading"><div class="section-heading"><div><p class="eyebrow">AGENT · ΠΡΟΧΕΙΡΟ</p><h2 id="agent-heading">Προσωρινή έκθεση agent</h2></div>${badge(version.status)}</div><p class="muted disclaimer">Ευρήματα προς επαλήθευση, όχι τελική βαθμολογία. Η απόφαση διδάσκοντα καταγράφεται ξεχωριστά.</p>
        <div class="panel report-summary"><h3>Συνολική εικόνα</h3><p>${e(version.summary || 'Δεν υπάρχει ακόμη έκθεση agent για αυτή την έκδοση.')}</p>${list(version.errors).length ? notice('Προβλήματα υποβολής: '+version.errors.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' · '),'danger') : ''}${button('Λήψη πακέτου ελέγχου JSON','bundle','','text-button')}<p class="muted small">Το πακέτο είναι διαθέσιμο μόνο μετά την προετοιμασία· διαφορετικά το API επιστρέφει 404.</p></div>
        <div class="exercise-list">${[...descriptors,...extra].map(ex => {
          const r = results.find(x => x.id === ex.id);
          return `<article class="exercise-card panel"><div class="exercise-heading"><h3>${e(ex.title || ex.id)} <span class="muted exercise-id">${e(ex.id)}</span></h3>${badge(r?.status || (version.status === 'draft' ? 'review_needed' : 'pending'))}</div><p>${e(r?.summary || 'Δεν υπάρχει ακόμη αξιολόγηση για την άσκηση.')}</p>${list(r?.findings).length ? `<ol class="findings">${r.findings.map(f => `<li class="finding"><div class="finding-heading"><span class="severity">${e(({high:'Υψηλή σοβαρότητα',medium:'Μέση σοβαρότητα',low:'Παρατήρηση',critical:'Κρίσιμο'})[f.severity] || f.severity || 'Εύρημα')}</span><p>${e(f.message)}</p></div>${list(f.citations).length ? `<ul class="citations">${f.citations.map(c => citation(c,version)).join('')}</ul>` : '<p class="muted small">Δεν παρέχεται παραπομπή· απαιτείται επαλήθευση.</p>'}</li>`).join('')}</ol>` : r ? '<p class="muted small">Δεν έχουν καταγραφεί συγκεκριμένα ευρήματα.</p>' : ''}${list(r?.oralQuestions).length ? `<details class="oral"><summary>Ερωτήσεις προφορικού ελέγχου (${r.oralQuestions.length})</summary><ul>${r.oralQuestions.map(q => `<li>${e(q)}</li>`).join('')}</ul></details>` : ''}</article>`;
        }).join('')}</div></section>`;
    }
    function rawFields(value, depth = 0) {
      if (value == null) return '<span class="muted">—</span>';
      if (depth > 7) return `<pre class="raw-value">${e(JSON.stringify(value,null,2))}</pre>`;
      if (typeof value !== 'object') return `<span class="raw-value">${e(value)}</span>`;
      if (Array.isArray(value)) return `<ul class="raw-list">${value.map(v => `<li>${rawFields(v,depth+1)}</li>`).join('')}</ul>`;
      return `<dl class="raw-fields">${Object.entries(value).filter(([k]) => !['content','url','file','log','tests'].includes(k)).map(([k,v]) => `<div><dt>${e(({passed:'Επιτυχημένα tests',total:'Σύνολο tests',score:'Αρχική τιμή score',status:'Κατάσταση',notes:'Σημειώσεις',note:'Σημείωση',overall:'Συνολική κατάσταση',function:'Συνάρτηση'})[k] || k)}</dt><dd>${rawFields(v,depth+1)}</dd></div>`).join('')}</dl>`;
    }
    function legacyTests(ex) {
      const tests = list(ex.tests);
      if (!tests.length) return '';
      const rows = entries => `<div class="table-scroll" tabindex="0" role="region" aria-label="Αρχικά αποτελέσματα tests"><table><thead><tr><th>Test</th><th>Input</th><th>Expected</th><th>Got / error</th><th>Result</th></tr></thead><tbody>${entries.map(t => `<tr><th>${e(t.name || t.index)}</th><td><code>${e(typeof t.input === 'object' ? JSON.stringify(t.input) : t.input)}</code></td><td><code>${e(JSON.stringify(t.expected))}</code></td><td><code>${e(t.error || JSON.stringify(t.got))}</code></td><td>${e(t.status)}</td></tr>`).join('')}</tbody></table></div>`;
      const failures = tests.filter(t => t.status !== 'PASS');
      return `${failures.length ? `<h4>Tests χωρίς PASS</h4>${rows(failures)}` : ''}<details><summary>Όλα τα αρχικά tests (${tests.length})</summary>${rows(tests)}</details>`;
    }
    function historical(version) {
      if (!version.evidence) return '';
      const evidence = version.evidence;
      const legacy = evidence.legacy;
      const run = legacy ? evidence.run : evidence;
      const runPanel = run ? `<section class="reviewer-run panel" aria-labelledby="reviewer-run-heading"><p class="eyebrow">ΕΞΩΤΕΡΙΚΟΣ REVIEWER</p><h2 id="reviewer-run-heading">Στοιχεία εκτέλεσης reviewer</h2><p class="muted">Κατάσταση παραγωγής της πρόχειρης έκθεσης — όχι εκτέλεση student code, ιστορικά tests ή βαθμολογία.</p>${rawFields(run)}</section>` : '';
      if (!legacy) return runPanel;
      return `<section class="historical panel" aria-labelledby="historical-heading"><p class="eyebrow">ΑΝΕΞΑΡΤΗΤΗ ΠΗΓΗ</p><h2 id="historical-heading">Ιστορικά τεκμήρια</h2><p class="muted">${e(evidence.source || 'Εισαγόμενα τεκμήρια')} · Αρχικές τιμές και σημειώσεις, όχι νέος έλεγχος ή απόφαση διδάσκοντα.</p>${legacy.archive ? `<p class="small">Αρχικό αρχείο: ${e(legacy.archive)}</p>` : ''}${Object.entries(legacy.exercises || {}).map(([id,ex]) => `<article class="legacy-exercise"><h3>${e(id)}</h3>${rawFields(ex)}${legacyTests(ex)}${ex.log?.content ? `<details><summary>Αρχικό log</summary><pre class="source-code">${e(ex.log.content)}</pre></details>` : ''}</article>`).join('')}${legacy.theory ? `<article class="legacy-exercise"><h3>Θεωρία</h3>${rawFields(legacy.theory)}</article>` : ''}${legacy.notes ? rawFields({notes:legacy.notes}) : ''}</section>${runPanel}`;
    }
    function currentTests(version) {
      const runs = list(version.testEvidence);
      if (!runs.length) return '';
      return `<section class="panel current-tests"><p class="eyebrow">ΚΑΤΑΓΕΓΡΑΜΜΕΝΗ ΕΚΤΕΛΕΣΗ</p><h2>Τρέχοντα callable tests</h2><p class="muted">Ξεχωριστά από την ιστορική κονσόλα και την έκθεση agent. Τα tests δεν αποδίδουν τελικό βαθμό.</p>${runs.map(run => {
        const r = run.result || {};
        const complete = r.status === 'completed' && r.passed != null;
        const failed = list(r.tests).filter(t => t.status !== 'pass');
        return `<article class="legacy-exercise"><h3>${e(r.exercise)} · ${e(r.function || '—')}</h3><p>${complete ? `<strong>${e(r.passed)} / ${e(r.total)}</strong>` : 'Δεν ολοκληρώθηκε έλεγχος'} · ${e(r.status)}</p>${r.error ? notice(r.error,'danger') : ''}<p class="muted small">Πηγή: ${e(run.sourcePath || '')} · ${e(r.adapter?.classification || r.mode || '')}</p>${link(run.url,'Πλήρες JSON εκτέλεσης')}<details><summary>Δοκιμές χωρίς pass (${failed.length})</summary><div class="table-scroll" tabindex="0"><table><thead><tr><th>Test</th><th>Input</th><th>Expected</th><th>Got / error</th><th>Result</th></tr></thead><tbody>${failed.map(t => `<tr><th>${e(t.name || t.index)}</th><td><code>${e(t.display_input || JSON.stringify(t.input))}</code></td><td><code>${e(JSON.stringify(t.expected))}</code></td><td><code>${e(t.error || JSON.stringify(t.got))}</code></td><td>${e(t.status)}</td></tr>`).join('')}</tbody></table></div></details><p class="muted small">Δεν ελέγχθηκαν: ${e(list(r.not_evaluated).join(' · '))}</p></article>`;
      }).join('')}</section>`;
    }
    function filesPanel(version) {
      const files = list(version.files);
      const viewer = state.viewer;
      return `<section class="files-panel panel" aria-labelledby="files-heading"><div class="section-heading"><h2 id="files-heading">Πρωτότυπα αρχεία</h2><span class="muted">${files.length}</span></div>${files.length ? `<ul class="file-list">${files.map(f => {
        const href = url(f.url);
        const isText = isTextFile(f);
        return `<li><div><span class="file-kind">${e(f.kind || 'file')}</span><span class="file-path">${e(f.path)}</span></div><div class="file-actions">${href ? `${isText ? button('Προβολή','file',`data-path="${e(f.path)}"`,'text-button') : ''}${link(href,'Άνοιγμα','text-link')}` : '<span class="muted small">Μη διαθέσιμος σύνδεσμος</span>'}</div></li>`;
      }).join('')}</ul>` : '<p class="muted">Δεν υπάρχουν διαθέσιμα πρωτότυπα αρχεία.</p>'}${viewer ? `<div class="source-viewer"><div class="viewer-heading"><h3>${e(viewer.path)}</h3>${button('Κλείσιμο','close-file','','text-button')}</div>${viewer.loading ? notice('Φόρτωση αρχείου…') : viewer.error ? notice(viewer.error,'danger') : `<pre class="source-code" tabindex="0" aria-label="Κώδικας ${e(viewer.path)}">${e(viewer.text)}</pre>`}</div>` : ''}</section>`;
    }
    function notesForm(team) {
      const notes = state.notesDraft || team.notes || {};
      return `<section class="notes-panel panel" aria-labelledby="notes-heading"><p class="eyebrow">ΑΝΘΡΩΠΙΝΟΣ ΕΛΕΓΧΟΣ</p><h2 id="notes-heading">Απόφαση διδάσκοντα</h2><p class="muted small">Αφορά την ομάδα. Δεν τροποποιεί την έκθεση agent. Αναφέρετε την έκδοση που ελέγξατε στις σημειώσεις.</p><form id="notes-form"><label for="human-decision">Απόφαση</label><select id="human-decision" name="decision">${[['pending','Εκκρεμεί'],['approved','Εγκρίνεται'],['needs_changes','Χρειάζεται αλλαγές']].map(([v,l]) => `<option value="${v}" ${notes.decision === v?'selected':''}>${l}</option>`).join('')}</select><label for="human-notes">Σημειώσεις διδάσκοντα</label><textarea id="human-notes" name="text" rows="6" placeholder="Τι επιβεβαιώθηκε; Τι χρειάζεται διόρθωση;">${e(notes.text || '')}</textarea><label for="human-grade">Βαθμός διδάσκοντα <span class="muted">(προαιρετικός)</span></label><input id="human-grade" name="grade" type="text" value="${e(notes.grade ?? '')}" autocomplete="off" placeholder="Μόνο μετά από δικό σας έλεγχο"><button type="submit" class="primary" ${state.saving?'disabled':''}>${state.saving?'Αποθήκευση & επιβεβαίωση…':'Αποθήκευση απόφασης'}</button><div aria-live="polite">${state.notesMessage ? notice(state.notesMessage,state.notesError?'danger':'success') : ''}</div></form></section>`;
    }
    function detail() {
      const team = teamNow();
      if (!team) return `<div class="empty panel"><h2>Η ομάδα δεν βρέθηκε</h2>${navLink('','','Επιστροφή στις ομάδες')}</div>`;
      const versions = list(team.versions);
      const version = versionNow();
      return `<section aria-labelledby="team-heading"><div class="detail-heading"><div>${navLink('','','← Όλες οι ομάδες','back-link')}<p class="eyebrow">ΟΜΑΔΑ</p><h2 id="team-heading">${e(team.id)}</h2><p class="muted">ΑΜ: ${e(list(team.students).map(s => typeof s === 'object' ? s.name || s.id || JSON.stringify(s) : s).join(' · '))}</p></div><div class="version-select"><label for="version-select">Έκδοση υποβολής</label><select id="version-select"><option value="">${versions.length > 1 ? 'Επιλέξτε έκδοση — καμία προεπιλογή' : 'Επιλέξτε έκδοση'}</option>${versions.map(v => `<option value="${e(v.id)}" ${version?.id===v.id?'selected':''}>${e(v.archive || v.id)}</option>`).join('')}</select></div></div>${!version ? notice(state.route.version ? 'Η ζητούμενη έκδοση δεν βρέθηκε. Επιλέξτε έκδοση από τη λίστα.' : versions.length ? 'Επιλέξτε έκδοση για να δείτε τα αντίστοιχα ευρήματα και τεκμήρια. Δεν επιλέγεται αυτόματα η τελευταία ή η καλύτερη υποβολή.' : 'Δεν υπάρχουν εκδόσεις για την ομάδα.','warning') : `<p class="selected-archive"><span class="eyebrow">ΕΠΙΛΕΓΜΕΝΗ ΕΚΔΟΣΗ</span> ${e(version.archive || version.id)}</p>`}<div class="detail-grid"><div class="detail-main">${version ? agentReport(version)+currentTests(version)+historical(version)+filesPanel(version) : ''}</div><aside>${notesForm(team)}</aside></div></section>`;
    }
    function render() {
      const oldSearch = env.document?.activeElement?.id === 'team-search';
      const cursor = oldSearch ? env.document.activeElement.selectionStart : null;
      root.innerHTML = `<div class="app-shell"><header class="app-header"><a href="?" class="brand" data-action="navigate" data-team="" data-version="" aria-label="ECE218 · Αρχική"><span class="brand-mark" aria-hidden="true">218</span><span><strong>ECE218</strong><span class="brand-subtitle">Αρχιτεκτονική & Οργάνωση Υπολογιστών</span></span></a><span class="workspace-label">Χώρος ελέγχου εργαστηρίων</span></header><main id="main-content"><div class="page-heading"><div><p class="eyebrow">ΕΡΓΑΣΤΗΡΙΑ · REVIEW WORKSPACE</p><h1>Έλεγχος υποβολών</h1><p class="muted">Συνολική εικόνα ανά ομάδα. Τεκμήρια ανά άσκηση. Η τελική απόφαση είναι δική σας.</p></div><div class="lab-switch"><label for="lab-select">Εργαστήριο</label><select id="lab-select" ${state.loading?'disabled':''}>${state.labs.length ? state.labs.map(l => `<option value="${e(l.id)}" ${state.route.lab===l.id?'selected':''}>${e(l.title || l.id)}</option>`).join('') : '<option value="">Δεν υπάρχουν διαθέσιμα εργαστήρια</option>'}</select></div></div>
        ${state.loading ? `<div class="empty panel" aria-busy="true">${notice('Φόρτωση εργαστηρίου…')}</div>` : state.error ? `<div class="empty panel">${notice(state.error,'danger')}<p class="muted">Δεν εμφανίζονται αποθηκευμένα ή δοκιμαστικά δεδομένα. Ελέγξτε το API και δοκιμάστε ξανά.</p>${button('Δοκιμή ξανά','retry','','primary')}</div>` : !state.lab ? '<div class="empty panel"><h2>Δεν υπάρχουν διαθέσιμα εργαστήρια</h2><p>Προσθέστε ένα εργαστήριο στο backend για να ξεκινήσετε.</p></div>' : `${metrics()}<div class="toolbar"><p class="muted small">Οι εκθέσεις agent είναι πάντα προσωρινές.</p><div class="toolbar-actions">${link(endpoint(state.route.lab)+'/report','Λήψη αναφοράς JSON','button-link',true)}<button type="button" class="primary" data-action="prepare" ${state.busy?'disabled':''}>${state.busy?'Προετοιμασία…':'Προετοιμασία πακέτων ελέγχου'}</button></div></div>${state.message ? notice(state.message,state.messageTone) : ''}${materials()}${state.route.team ? detail() : overview()}`}
      </main><footer><span>ECE218 · Εργαστηριακός έλεγχος</span><span>Agent: πρόχειρο · Διδάσκων: απόφαση</span></footer></div>`;
      if (env.document) env.document.title = (state.route.team ? 'Ομάδα '+state.route.team : state.lab?.title || 'Εργαστήρια') + ' · ECE218';
      if (oldSearch) {
        const input = root.querySelector('#team-search');
        if (input) { input.focus(); if (cursor != null) { try { input.setSelectionRange(cursor,cursor); } catch (_) {} } }
      }
    }
    async function start() {
      const sequence = ++navigationSequence;
      state.loading=true;state.error='';state.lab=null;render();
      try {
        const data = await api('/api/labs');
        if (sequence !== navigationSequence) return;
        if (!Array.isArray(data.labs)) throw new Error('Μη έγκυρη λίστα εργαστηρίων από το API.');
        state.labs=data.labs;
        if (!data.labs.length) {state.loading=false;render();return;}
        if (!state.route.lab) state.route.lab=data.labs[0].id;
        await navigate(state.route);
      } catch (error) {
        if (sequence !== navigationSequence) return;
        state.error=error.message;state.loading=false;state.lab=null;render();
      }
    }
    async function navigate(route, options = {}) {
      const sequence = ++navigationSequence;
      ++viewerSequence; ++actionSequence;
      state.route={lab:route.lab || state.route.lab,team:route.team || '',version:route.version || ''};
      state.loading=true;state.error='';state.lab=null;state.viewer=null;state.notesDraft=null;state.notesMessage='';state.message='';state.busy=false;state.saving=false;
      if (!options.pop) env.history?.replaceState(null,'',routeUrl(state.route));
      render();
      try {
        const lab = await api(endpoint(state.route.lab));
        if (sequence !== navigationSequence) return;
        if (!lab || lab.id !== state.route.lab || !Array.isArray(lab.teams)) throw new Error('Μη έγκυρα δεδομένα εργαστηρίου από το API.');
        state.lab=lab;state.loading=false;render();
      } catch (error) {
        if (sequence !== navigationSequence) return;
        state.error=error.message;state.lab=null;state.loading=false;render();
      }
    }
    async function prepare() {
      if (state.busy || !state.lab) return;
      const sequence = actionSequence;
      const labId = state.route.lab;
      state.busy=true;state.message='';render();
      try {
        const data=await api(endpoint(labId)+'/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
        if (sequence !== actionSequence) return;
        if (!Number.isInteger(data.prepared) || data.prepared < 0 || !Array.isArray(data.errors)) throw new Error('Μη έγκυρη απάντηση προετοιμασίας.');
        state.message=`Προετοιμάστηκαν ${data.prepared} πακέτα. Δεν εκτελέστηκε έλεγχος agent. Εκτελέστε τον CLI reviewer ή εισαγάγετε την έκθεσή του στο backend.`;
        if (data.errors.length) state.message+=' Σφάλματα: '+data.errors.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' · ');
        state.messageTone=data.errors.length?'warning':'success';
      } catch (error) {if(sequence === actionSequence){state.message=error.message;state.messageTone='danger';}}
      finally {if(sequence === actionSequence){state.busy=false;render();}}
    }
    async function downloadBundle() {
      const version=versionNow();
      if(!version) return;
      const sequence=actionSequence;
      try {
        const data=await api(endpoint(state.route.lab)+'/bundles/'+encodeURIComponent(version.id));
        if(sequence!==actionSequence) return;
        const name='bundle-'+String(version.id).replace(/[^a-zA-Z0-9_-]/g,'_')+'.json';
        if(env.download) env.download(data,name);
        else {
          const blob=new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'});
          const href=global.URL.createObjectURL(blob);
          const a=env.document.createElement('a');
          a.href=href;a.download=name;env.document.body.appendChild(a);a.click();a.remove();
          global.setTimeout(()=>global.URL.revokeObjectURL(href),1000);
        }
        state.message='Το πακέτο λήφθηκε από τον server. Εκτελέστε τον CLI reviewer· η λήψη δεν αποτελεί έλεγχο.';state.messageTone='success';
      } catch(error) {
        if(sequence!==actionSequence) return;
        state.message=error.message+' Προετοιμάστε πρώτα τα πακέτα ελέγχου.';state.messageTone='danger';
      }
      render();
    }
    async function saveNotes(notes) {
      if (state.saving || !teamNow()) return;
      const sequence = actionSequence;
      const labId=state.route.lab,teamId=state.route.team;
      const payload={text:String(notes.text ?? ''),decision:notes.decision,grade:String(notes.grade ?? '')};
      state.notesDraft=payload;state.notesMessage='';state.notesError=false;
      if (!['pending','approved','needs_changes'].includes(payload.decision)) {state.notesError=true;state.notesMessage='Μη έγκυρη απόφαση.';render();return;}
      state.saving=true;render();
      let posted=false;
      try {
        await api(endpoint(labId)+'/notes/'+encodeURIComponent(teamId),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        posted=true;
        const fresh=await api(endpoint(labId));
        if(sequence !== actionSequence) return;
        const saved=list(fresh.teams).find(t=>t.id===teamId)?.notes;
        if(fresh.id!==labId || !saved || saved.text!==payload.text || saved.decision!==payload.decision || String(saved.grade ?? '')!==payload.grade) throw new Error('Η ανάγνωση του server δεν συμφωνεί με την απόφαση που υποβλήθηκε.');
        state.lab=fresh;state.notesDraft=null;state.notesMessage='Αποθηκεύτηκε και επιβεβαιώθηκε από τον server.';
      } catch(error) {
        if(sequence !== actionSequence) return;
        state.notesError=true;state.notesMessage=(posted?'Δεν επιβεβαιώθηκε η αποθήκευση. ':'Η αποθήκευση απέτυχε. ')+error.message;
      } finally {if(sequence === actionSequence){state.saving=false;render();}}
    }
    async function openFile(path) {
      const version=versionNow();
      const file=list(version?.files).find(f=>f.path===path);
      if(!file) return;
      const sequence=++viewerSequence;
      const href=url(file.url);
      state.viewer={path,loading:true};render();
      try {
        if(!href) throw new Error('Μη διαθέσιμος ή μη ασφαλής σύνδεσμος αρχείου.');
        if(!isTextFile(file)) throw new Error('Ανοίξτε αυτό το αρχείο σε νέα καρτέλα. Η ενσωματωμένη προβολή δέχεται μόνο κείμενο.');
        const result=await env.fetch(href,{cache:'no-store'});
        if(!result.ok) throw new Error('Αποτυχία ανάγνωσης αρχείου (HTTP '+result.status+').');
        const text=await result.text();
        if(sequence!==viewerSequence) return;
        state.viewer={path,text:text.length>600000?text.slice(0,600000)+'\n\n[Η προβολή περιορίστηκε στους 600.000 χαρακτήρες. Ανοίξτε το αρχείο για το πλήρες περιεχόμενο.]':text,loading:false};
      } catch(error) {if(sequence===viewerSequence)state.viewer={path,error:error.message,loading:false};}
      if(sequence===viewerSequence)render();
    }
    root.addEventListener('click',async event=>{
      const target=event.target.closest('[data-action]');
      if(!target) return;
      event.preventDefault();
      const data=target.dataset;
      if(data.action==='navigate') await navigate({lab:state.route.lab,team:data.team,version:data.version});
      if(data.action==='retry') await start();
      if(data.action==='prepare') await prepare();
      if(data.action==='bundle') await downloadBundle();
      if(data.action==='file') await openFile(data.path);
      if(data.action==='close-file'){++viewerSequence;state.viewer=null;render();}
    });
    root.addEventListener('change',async event=>{
      const target=event.target;
      if(target.id==='lab-select'){state.search='';state.filter='all';await navigate({lab:target.value});}
      if(target.id==='version-select') await navigate({...state.route,version:target.value});
      if(target.id==='status-filter'){state.filter=target.value;render();}
    });
    root.addEventListener('input',event=>{
      if(event.target.id==='team-search'){state.search=event.target.value;render();}
      if(['human-notes','human-decision','human-grade'].includes(event.target.id)) {
        const current=state.notesDraft || teamNow()?.notes || {};
        const key={'human-notes':'text','human-decision':'decision','human-grade':'grade'}[event.target.id];
        state.notesDraft={...current,[key]:event.target.value};
        state.notesMessage='';
        const status=root.querySelector('#notes-form [aria-live]');if(status)status.textContent='';
      }
    });
    root.addEventListener('submit',async event=>{
      if(event.target.id!=='notes-form')return;
      event.preventDefault();
      const form=event.target;
      await saveNotes({text:form.elements.text.value,decision:form.elements.decision.value,grade:form.elements.grade.value});
    });
    env.window?.addEventListener('popstate',()=>navigate(parseRoute(env.location.search),{pop:true}));
    return {start,navigate,prepare,downloadBundle,saveNotes,openFile,render,state};
  }
  function isTextFile(file) {
    return ['text','asm','log','source','markdown','json'].includes(file.kind) || /\.(asm|s|txt|log|md|c|h|cpp|py|json|csv|v|sv)$/i.test(file.path || '');
  }
  const exported={escapeHtml,safeUrl,selectVersion,parseRoute,routeUrl,filterTeams,request,createApp,isTextFile};
  if(typeof module!=='undefined' && module.exports) module.exports=exported;
  else {
    global.ECEReview=exported;
    const mount=()=>{const root=global.document.getElementById('app');if(root){const app=createApp({root,fetch:global.fetch.bind(global),location:global.location,history:global.history,document:global.document,window:global});global.eceReviewApp=app;app.start();}};
    if(global.document.readyState==='loading')global.document.addEventListener('DOMContentLoaded',mount);else mount();
  }
})(typeof window!=='undefined'?window:globalThis);
