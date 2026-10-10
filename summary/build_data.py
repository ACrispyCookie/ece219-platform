"""CSV-first dashboard data. Saved JSON only enriches document/output previews."""
from pathlib import Path
from datetime import datetime,timezone
from urllib.parse import quote,unquote
from typing import Any
import ast,csv,json,os,re
from archive_cache import recover_archive,safe_member,no_symlinks,digest

HERE=Path(__file__).resolve().parent
ROOT=HERE.parent
SUBMISSIONS=ROOT/'Lab1/submissions'
CACHE=ROOT/'.submission-cache'
EVIDENCE=ROOT/'grading_results'
CSV_FILE=ROOT/'lab1_results_by_student.csv'
SNAPSHOT=HERE/'report-data.json'

def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))

def local_path(stored):
    value=str(stored);marker='/Lab1/submissions/'
    p=Path(value)
    if p.is_absolute():
        for root in [CACHE,EVIDENCE,SUBMISSIONS]:
            if p.is_relative_to(root):
                safe_member(p.relative_to(root).as_posix());return p
    if marker in value:
        relative=value.split(marker,1)[1];safe_member(relative)
        parts=Path(relative).parts
        if parts[0]=='grading_results':return EVIDENCE.joinpath(*parts[1:])
        if len(parts)<2:raise ValueError('Legacy source path has no member')
        return CACHE/parts[0]/'members'/Path(*parts[1:])
    raise ValueError(f'Unsupported evidence path: {value}')

def link(path):
    return '/'.join(quote(part,safe='') for part in Path(os.path.relpath(path,HERE)).parts)

def file_info(stored,with_content=False,fallback=None) -> dict[str,Any]:
    p=local_path(stored);available=p.is_file() and no_symlinks(p)
    provenance='local_evidence'
    if p.is_relative_to(CACHE):
        stem=p.relative_to(CACHE).parts[0]
        archives=[a for a in SUBMISSIONS.iterdir() if a.stem==stem and a.suffix.lower() in ('.zip','.rar')]
        available=available and len(archives)==1 and recover_archive(archives[0],CACHE)['status']=='recovered'
        provenance='original_archive' if available else 'unavailable'
    result=dict(name=p.name,url=link(p),kind=p.suffix.lower().lstrip('.') or 'asm',available=available,provenance=provenance if available else 'unavailable',originalAvailability='available' if available else 'unavailable')
    if available:result['sha256']=digest(p)
    if with_content:
        if available:
            result['content']=p.read_text(encoding='utf-8',errors='replace')
            imported=fallback.get('importedSnapshotContent',fallback.get('content')) if fallback else None
            if imported and imported!=result['content']:
                result.update(snapshotContentMismatch=True,importedSnapshotContent=imported)
        elif fallback and fallback.get('content'):
            result.update(content=fallback['content'],provenance='imported_snapshot',snapshotSourceName=fallback.get('name'),snapshotSourceUrl=fallback.get('url'))
        else:result['content']=None
    return result

def snapshot_versions():
    baseline=CACHE/'.baseline/report-data.original.json'
    source=baseline if baseline.is_file() and no_symlinks(baseline) else SNAPSHOT
    saved=read_json(source) if source.is_file() else {}
    return {(g['id'],v.get('sourceArchive',v['archive'])):v for g in saved.get('groups',[]) for v in g.get('versions',[])}

def document_info(file,pages=()):
    real_pages=[]
    for page in pages:
        try:p=local_path(page)
        except ValueError:continue
        if p.is_file() and no_symlinks(p):real_pages.append(link(p))
    return dict(file,pages=real_pages,pageImagesAvailable=bool(real_pages))

def version_value(value,archives,archive):
    """Split only known archive qualifiers, never ordinary evidence separators."""
    markers=[a+': ' for a in archives]
    if not any(value.startswith(marker) for marker in markers):return value
    marker=archive+': '
    start=value.find(marker)
    if start<0:return ''
    start+=len(marker)
    ends=[value.find(' | '+m,start) for m in markers]
    end=min((i for i in ends if i>=0),default=len(value))
    return value[start:end]

def official_test(raw):
    match=re.match(r'^\s*(\d+)\s{2}(.{24}) (.*?)\s+(\S+)\s+(-?\d+|ERR|None)\s+(PASS|FAIL)(?:\s+(.*))?$',raw)
    if not match:raise ValueError(f'Cannot parse CSV test result: {raw}')
    expected=match[4]
    if '..' in expected:
        left,right=map(int,expected.split('..'));accepted=list(range(left,right+1))
    else:accepted=list(map(int,expected.split('/')))
    return dict(index=int(match[1]),name=match[2].strip(),input=match[3].strip(),expected=accepted,got=int(match[5]) if re.fullmatch(r'-?\d+',match[5]) else None,error=match[7] or '',status=match[6],raw=raw)

def console_info(row,ex,archives,archive,official,extras):
    value=lambda field:version_value(row.get(ex+'_console_'+field,''),archives,archive)
    if not value('passed'):return None
    by_index={t['index']:t for t in official}
    tests=[]
    for match in re.finditer(r'(\d+): (PASS|FAIL) \(expected=(\[[^\]]*\]), got=(None|-?\d+)\)',value('tests')):
        i=int(match[1]);base=by_index.get(i,{})
        test=dict(index=i,name=base.get('name',f'Test {i}'),input=base.get('input',''),expected=ast.literal_eval(match[3]),got=None if match[4]=='None' else int(match[4]),error='',status=match[2],raw=match[0])
        extra=next((t for t in extras.get((archive,ex),{}).get('tests',[]) if t['index']==i),None)
        # Auxiliary stdout/stderr can enrich, but never override edited CSV outcomes.
        if extra and extra['status']==test['status'] and extra['got']==test['got']:
            test.update(stdout=extra.get('stdout',''),stderr=extra.get('stderr',''))
            if test['status']=='FAIL' and (test['got'] is None or extra.get('returncode',0) not in (None,0)):test['error']=extra.get('stderr','')
        tests.append(test)
    total=int(value('total'))
    if len(tests)!=total:raise ValueError(f'Incomplete console tests in CSV for {archive}/{ex}')
    return dict(passed=int(value('passed')),total=total,method=value('notes'),tests=tests)

def program_info(row,ex,archives,archive,extras,saved=None):
    value=lambda field:version_value(row.get(ex+'_'+field,''),archives,archive)
    status=value('status');total=int(value('total'))
    tests=[official_test(value(f'test_{i:02}')) for i in range(1,total+1)] if status=='TESTED' else []
    imported=(saved or {}).get('exercises',{}).get(ex,{})
    result:dict[str,Any]=dict(status=status,passed=int(value('passed')) if value('passed') else None,total=total,file=file_info(value('file'),True,imported.get('file')) if value('file') else None,function=value('function'),note=value('notes'),log=file_info(value('log'),True) if value('log') else None,tests=tests)
    if (archive,ex) not in extras and imported.get('console'):
        extras=dict(extras);extras[archive,ex]=imported['console']
    result['console']=console_info(row,ex,archives,archive,tests,extras)
    return result

def build_data() -> dict[str,Any]:
    with CSV_FILE.open(encoding='utf-8-sig',newline='') as f:
        reader=csv.DictReader(f)
        required={'student_id','group_ids','archives','theory_overall','bs_status','substr_status'}
        if not required.issubset(reader.fieldnames or []):raise ValueError('CSV is missing required dashboard columns')
        rows=list(reader)
    grouped={}
    for row in rows:
        group=grouped.setdefault(row['group_ids'],dict(row=row,students=[],rows=[]))
        if row['student_id'] in group['students']:raise ValueError('Duplicate student ID in CSV')
        group['students'].append(row['student_id'])
        marked=row.get('individual_submission','')
        if marked and marked!=row['student_id']:raise ValueError('Incorrect individual submission attribution')
        disagreement=any(v!=group['row'].get(k,'') for k,v in row.items() if k!='student_id')
        if disagreement and not (marked and group['row'].get('individual_submission')==group['row']['student_id']):raise ValueError('Partner rows disagree in CSV: '+row['group_ids'])
        group['rows'].append(row)
    imported_versions=snapshot_versions()
    manifest=read_json(EVIDENCE/'manifest.json') if (EVIDENCE/'manifest.json').is_file() else []
    documents_by_archive={m['archive']:m for m in manifest}
    extra_rows=[]
    for filename in ['console_results.json','substr_console_results.json']:
        if (EVIDENCE/filename).is_file():extra_rows.extend(read_json(EVIDENCE/filename))
    extras={(r['archive'],r['exercise']):r for r in extra_rows}
    individual_extras=read_json(EVIDENCE/'individual_results.json') if (EVIDENCE/'individual_results.json').is_file() else {}
    groups=[];archive_count=0
    for key,item in grouped.items():
        row=item['row'];archives=row['archives'].split(' | ');archive_count+=len(archives)
        group:dict[str,Any]=dict(id=key,students=sorted(item['students'],key=int),label=archives[0].split(' - ',1)[-1].rsplit('.',1)[0],notes={ex:row.get(ex+'_notes','') for ex in ['bs','substr']},versions=[])
        individual=bool(row.get('individual_submission'))
        version_rows=item['rows'] if individual else [row]
        if individual:group['notes']={ex:'Χωριστές λύσεις ανά φοιτητή στο ίδιο ZIP. Επιλέξτε ΑΜ για τα δικά του αποτελέσματα.' for ex in ['bs','substr']}
        for current in version_rows:
            if current['archives']!=row['archives']:raise ValueError('Individual partners disagree on source archive')
            for archive in archives:
                value=lambda field:version_value(current.get(field,''),archives,archive)
                review={dest:value('theory_'+source) for dest,source in [('a_status','a'),('b_status','b'),('formats_status','formats'),('overall','overall'),('notes','notes')]}
                review['evidence']=value('theory_evidence').split(' | ')
                safe_member(archive)
                if len(Path(archive).parts)!=1:raise ValueError('Archive must be an exact filename')
                recovery=recover_archive(SUBMISSIONS/archive,CACHE)
                saved=imported_versions.get((key,archive),{})
                metadata=documents_by_archive.get(archive,{})
                files=[file_info(CACHE/Path(archive).stem/'members'/f['path']) for f in recovery['files']]
                pages_by_name={Path(d['file']).name:d.get('images',[]) for d in metadata.get('theory',[])}
                docs=[document_info(f,pages_by_name.get(f['name'],[])) for f in files if f['kind'] in ('pdf','docx','doc','odt','jpg','jpeg','png','webp') and not f['name'].startswith('.') and '/__MACOSX/' not in unquote(f['url'])]
                if not docs and recovery['status']!='recovered':
                    # Snapshot metadata describes unavailable originals, not recovered bytes.
                    for d in saved.get('documents',[]):
                        url=unquote(d.get('url',''))
                        if url.startswith('../'+Path(archive).stem+'/'):
                            original=file_info('/legacy/Lab1/submissions/'+url[3:])
                            docs.append(document_info(original))
                # CSV outcomes stay primary; an explicit AEM creates a separate selectable view.
                label=archive+' — ΑΜ '+current['student_id'] if individual else archive
                version_extras=dict(extras)
                if individual:
                    for ex,check in individual_extras.get(current['student_id'],{}).get('console',{}).items():version_extras[archive,ex]=check
                archive_file=file_info(SUBMISSIONS/archive)
                version=dict(archive=label,archiveFile=archive_file,recovery=recovery,theory=review,exercises={ex:program_info(current,ex,archives,archive,version_extras,saved) for ex in ['bs','substr']},files=files,documents=docs)
                if individual:version.update(sourceArchive=archive,studentId=current['student_id'])
                group['versions'].append(version)
        groups.append(group)
    return dict(schemaVersion=1,generatedAt=datetime.now(timezone.utc).isoformat(),source='lab1_results_by_student.csv',sourceProvenance=dict(kind='current_csv',url=link(CSV_FILE),sha256=digest(CSV_FILE)),counts=dict(groups=len(groups),students=len(rows),archives=archive_count),groups=sorted(groups,key=lambda g:tuple(map(int,g['students']))),csvUrl=link(CSV_FILE),references=dict(theory='Σωστές απαντήσεις: α = 896 εντολές μηδενικών καταχωρητών, β = 94 εντολές ενός καταχωρητή. Formats: opcode6 + reg5 + reg5, opcode11 + reg5, opcode16. Αποδεκτή και η ισοδύναμη ιεραρχική κωδικοποίηση.',limitations='Πηγή αποτελεσμάτων: το CSV. Τα scores είναι αποτελέσματα tests, όχι τελικοί βαθμοί. Ο grader ελέγχει callable συναρτήσεις με συγκεκριμένο interface· τα console tests είναι συμπληρωματικά και δεν ελέγχουν συμμόρφωση ABI. Δεν πιστοποιούνται επίδοση, πρωτοτυπία, διατήρηση καταχωρητών ή κατανόηση. Το negative K είναι οριακή περίπτωση του grader, όχι ρητή απαίτηση της εκφώνησης.'))

def write_snapshot():
    if SNAPSHOT.is_file():
        backup=CACHE/'.baseline/report-data.original.json'
        if not no_symlinks(backup):raise ValueError('Symlinked baseline backup rejected')
        backup.parent.mkdir(parents=True,exist_ok=True)
        if not backup.exists():
            original=SNAPSHOT.read_bytes()
            with backup.open('xb') as f:f.write(original)
            if backup.read_bytes()!=original:raise OSError('Baseline backup verification failed')
    data=build_data();text=json.dumps(data,ensure_ascii=False,indent=2)
    (HERE/'report-data.json').write_text(text,encoding='utf-8')
    (HERE/'data.js').write_text('/* Generated from CSV; update with python3 build_data.py. */\nwindow.LAB1_DATA = '+text+';\n',encoding='utf-8')
    return data

if __name__=='__main__':print(json.dumps(write_snapshot()['counts'],ensure_ascii=False))
