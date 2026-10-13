"""One scoped, deterministic catalog deletion plan for previews and execution.

Plans contain metadata only. Immutable content-addressed blob bytes are retained.
Every ID is computed before any write; execution never rediscovers descendants.
"""
from dataclasses import dataclass
import hashlib
import json
import sqlite3

from .database import TABLES

DELETE_ORDER = ('assessment_history', 'evidence', 'assessments', 'materials',
                'submissions', 'files', 'exercises', 'teams', 'labs')
REFERENCES = {
    'exercises': {'lab_id': 'labs'}, 'teams': {'lab_id': 'labs'},
    'files': {'lab_id': 'labs', 'team_id': 'teams'},
    'materials': {'lab_id': 'labs', 'exercise_id': 'exercises', 'file_id': 'files'},
    'submissions': {'lab_id': 'labs', 'team_id': 'teams', 'file_id': 'files'},
    'assessments': {'team_id': 'teams', 'exercise_id': 'exercises', 'submission_id': 'submissions'},
    'assessment_history': {'assessment_id': 'assessments'},
    'evidence': {'lab_id': 'labs', 'team_id': 'teams', 'exercise_id': 'exercises',
                 'submission_id': 'submissions', 'file_id': 'files'},
}


def scope_conflict():
    from .service import CatalogError
    raise CatalogError(409, 'conflict', 'Deletion has surviving or invalid cross-scope references; no records were deleted')


@dataclass(frozen=True)
class DeletionPlan:
    ids: dict
    confirmation_token: str

    @property
    def counts(self):
        return [{'kind': kind, 'count': len(self.ids[kind])}
                for kind in TABLES if self.ids[kind]]

    def execute(self, c):
        # A capability bound to this connection and these history IDs only.
        # Never disable foreign keys/triggers, including during rollback.
        chunk_size = min(400, c.getlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER))
        with c.allow_history_deletion(self.ids['assessment_history']):
            for table in DELETE_ORDER:
                ids = sorted(self.ids[table])
                for start in range(0, len(ids), chunk_size):
                    chunk = ids[start:start + chunk_size]
                    c.execute(f'DELETE FROM {table} WHERE id IN ({",".join("?" for _ in chunk)})', chunk)


def build_plan(c, table, identifier, lab_id):
    # Read a coherent snapshot, including global file references. SQL columns
    # participate in the fingerprint alongside JSON, so legacy mismatches cannot
    # hide associations. No unrelated objects are returned to the caller.
    rows = {kind: {r['id']: dict(r) for r in c.execute(f'SELECT * FROM {kind}')}
            for kind in TABLES}
    objects = {kind: {key: json.loads(r['data']) for key, r in records.items()}
               for kind, records in rows.items()}
    selected = {kind: set() for kind in TABLES}
    selected[table].add(identifier)

    def add_where(kind, predicate):
        selected[kind].update(key for key, row in rows[kind].items() if predicate(row))

    if table == 'labs':
        for kind in ('exercises', 'teams', 'files', 'materials', 'submissions', 'evidence'):
            add_where(kind, lambda r: r['lab_id'] == identifier)
        add_where('assessments', lambda r: r['team_id'] in selected['teams'] or r['exercise_id'] in selected['exercises'])
    elif table == 'teams':
        for kind in ('files', 'submissions', 'evidence', 'assessments'):
            add_where(kind, lambda r: r['team_id'] == identifier)
    elif table == 'exercises':
        for kind in ('materials', 'evidence', 'assessments'):
            add_where(kind, lambda r: r['exercise_id'] == identifier)
    elif table == 'files':
        for kind in ('materials', 'submissions', 'evidence'):
            add_where(kind, lambda r: r['file_id'] == identifier)

    # Every removed submission induces current OR historically linked grades.
    subs = selected['submissions']
    if subs:
        add_where('evidence', lambda r: r['submission_id'] in subs or objects['evidence'][r['id']].get('submission_id') in subs)
        add_where('assessments', lambda r: r['submission_id'] in subs or objects['assessments'][r['id']].get('submission_id') in subs)
        for key, record in objects['assessment_history'].items():
            if record.get('submission_id') in subs:
                selected['assessments'].add(rows['assessment_history'][key]['assessment_id'])
    add_where('assessment_history', lambda r: r['assessment_id'] in selected['assessments'])

    forced_files = set(selected['files'])
    candidate_files = set(forced_files)
    for kind in ('materials', 'submissions', 'evidence'):
        candidate_files.update(rows[kind][key]['file_id'] for key in selected[kind]
                               if rows[kind][key]['file_id'])
    relevant = {kind: set(keys) for kind, keys in selected.items()}
    relevant['files'].update(candidate_files)
    for file_id in candidate_files:
        surviving = False
        for kind in ('materials', 'submissions', 'evidence'):
            for key, row in rows[kind].items():
                if row['file_id'] == file_id:
                    relevant[kind].add(key)
                    if key not in selected[kind]: surviving = True
        if not surviving and (table != 'teams' or file_id in forced_files):
            selected['files'].add(file_id)
        elif surviving and file_id in forced_files: scope_conflict()

    def owner(kind, key):
        row = rows[kind][key]
        if kind == 'labs': return key
        if kind == 'assessments': return rows['teams'][row['team_id']]['lab_id']
        if kind == 'assessment_history': return owner('assessments', row['assessment_id'])
        return row['lab_id']

    # Reject corrupt/historically FK-valid cross-owner links rather than following
    # them out of the requested lab, or hiding a raw FK failure after partial work.
    for kind, keys in relevant.items():
        for key in keys:
            row, obj = rows[kind][key], objects[kind][key]
            if owner(kind, key) != lab_id: scope_conflict()
            for column, target in REFERENCES.get(kind, {}).items():
                value = row[column]
                if obj.get(column, value) != value: scope_conflict()
                if value is not None and owner(target, value) != lab_id: scope_conflict()
            if kind in ('assessments', 'evidence'):
                sub_id = row['submission_id']
                if sub_id and rows['submissions'][sub_id]['team_id'] != row['team_id']: scope_conflict()
            if kind == 'assessment_history':
                assessment = rows['assessments'][row['assessment_id']]
                for column in ('team_id', 'exercise_id'):
                    if obj.get(column) != assessment[column]: scope_conflict()
                sub_id = obj.get('submission_id')
                if sub_id is not None:
                    sub = rows['submissions'].get(sub_id)
                    if sub is None or sub['lab_id'] != lab_id or sub['team_id'] != assessment['team_id']: scope_conflict()

    # Every surviving SQL FK must remain valid. In particular a team-owned upload
    # cannot be removed underneath a surviving material or another team's record.
    for kind, refs in REFERENCES.items():
        for key, row in rows[kind].items():
            if key not in selected[kind] and any(row[column] in selected[target]
                                                for column, target in refs.items()):
                scope_conflict()
    state = {'root': [table, identifier, lab_id],
             'ids': {kind: sorted(keys) for kind, keys in selected.items()},
             'state': {kind: [dict(rows[kind][key], data=objects[kind][key]) for key in sorted(keys)]
                       for kind, keys in relevant.items()}}
    token = hashlib.sha256(json.dumps(state, sort_keys=True, ensure_ascii=False,
                                    allow_nan=False, separators=(',', ':')).encode()).hexdigest()
    return DeletionPlan({kind: frozenset(keys) for kind, keys in selected.items()}, token)
