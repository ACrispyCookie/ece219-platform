"""Transactional catalog operations independent of HTTP and frontend."""
from datetime import datetime, timezone
from decimal import Decimal
import sqlite3
from uuid import uuid4

from .database import Database
from .files import BlobStore, inspect_zip, safe_filename
from . import schemas as s


class CatalogError(Exception):
    def __init__(self, status, code, message, details=None):
        self.status = status; self.code = code; self.message = message; self.details = details
        super().__init__(message)


def missing():
    raise CatalogError(404, 'not_found', 'Resource not found')


def invalid(message):
    raise CatalogError(422, 'validation', message)


def now():
    return datetime.now(timezone.utc).isoformat()


def identity():
    return str(uuid4())


def decimal_string(value):
    return format(value, 'f').rstrip('0').rstrip('.') if '.' in format(value, 'f') else format(value, 'f')


def page(items, limit, offset):
    return {'items': items[offset:offset + limit], 'total': len(items), 'limit': limit, 'offset': offset}


COLUMNS = {'labs': (), 'exercises': ('lab_id',), 'teams': ('lab_id',), 'files': ('lab_id', 'team_id'), 'materials': ('lab_id', 'exercise_id', 'file_id'), 'submissions': ('lab_id', 'team_id', 'file_id'), 'assessments': ('team_id', 'exercise_id', 'submission_id'), 'evidence': ('lab_id', 'team_id', 'exercise_id', 'submission_id', 'file_id')}
CREATE_MODELS = {'labs': s.LabCreate, 'exercises': s.ExerciseCreate, 'teams': s.TeamCreate}
RUBRIC_FIELDS = ('max_points', 'grading_mode', 'grading_instructions', 'criteria')


def grading_signature(exercise):
    return (Decimal(exercise['max_points']), exercise['grading_mode'], exercise['grading_instructions'], {x['id']: (x['label'], Decimal(x['max_points']), x['instructions']) for x in exercise['criteria']})


class Catalog:
    def __init__(self, root):
        self.db = Database(root)
        self.blobs = BlobStore(self.db.root)

    def get(self, c, table, identifier, lab_id=None):
        rows = self.db.rows(c, table, 'id=?', (identifier,))
        if not rows: missing()
        obj = rows[0]
        if lab_id is not None and obj.get('lab_id') != lab_id: missing()
        return obj

    def reference(self, c, table, identifier, lab_id, team_id=None):
        rows = self.db.rows(c, table, 'id=?', (identifier,))
        if not rows or rows[0].get('lab_id') != lab_id:
            invalid('Reference must belong to the same lab')
        obj = rows[0]
        if team_id is not None and obj.get('team_id') not in (None, team_id):
            invalid('Reference must belong to this team or be a shared lab file')
        return obj

    def list(self, table, lab_id=None):
        with self.db.connect() as c:
            if lab_id is not None: self.get(c, 'labs', lab_id)
            items = self.db.rows(c, table, 'lab_id=?' if lab_id else '', (lab_id,) if lab_id else ())
            return sorted(items, key=lambda x: (x['position'], x['created_at'], x['id'])) if table == 'exercises' else items

    def read(self, table, identifier, lab_id=None):
        with self.db.connect() as c:
            if lab_id is not None: self.get(c, 'labs', lab_id)
            return self.get(c, table, identifier, lab_id)

    def create(self, table, body, lab_id=None):
        stamp = now()
        obj = {**body.model_dump(), 'id': identity(), 'revision': 1, 'created_at': stamp, 'updated_at': stamp}
        if lab_id: obj['lab_id'] = lab_id
        if table == 'exercises': obj['rubric_revision'] = 1
        with self.db.connect(write=True) as c:
            if lab_id: self.get(c, 'labs', lab_id)
            self.db.save(c, table, obj, COLUMNS[table])
        return obj

    def patch(self, table, identifier, body, lab_id=None):
        with self.db.connect(write=True) as c:
            old = self.get(c, table, identifier, lab_id)
            if body.revision != old['revision']:
                raise CatalogError(409, 'conflict', 'Revision conflict', {'current_revision': old['revision']})
            changes = body.model_dump(exclude_unset=True); changes.pop('revision')
            new = {**old, **changes}
            validated = CREATE_MODELS[table].model_validate({key: new[key] for key in CREATE_MODELS[table].model_fields})
            new.update(validated.model_dump())
            new['revision'] += 1; new['updated_at'] = now()
            if table == 'exercises' and grading_signature(old) != grading_signature(new):
                new['rubric_revision'] += 1
            self.db.save(c, table, new, COLUMNS[table], update=True)
            return new

    def delete(self, table, identifier, lab_id=None):
        try:
            with self.db.connect(write=True) as c:
                self.get(c, table, identifier, lab_id)
                c.execute(f'DELETE FROM {table} WHERE id=?', (identifier,))
        except sqlite3.IntegrityError:
            raise CatalogError(409, 'conflict', 'Resource has dependents; archive instead of deleting') from None

    def upload(self, lab_id, team_id, filename, stream, media_type, submission=False):
        try: safe_filename(filename)
        except ValueError as e: invalid(str(e))
        sha = None; created = False
        # A write lock covers blob creation and metadata commit: duplicate content is
        # shared safely, and a failed transaction removes only its new blob.
        try:
            with self.db.connect(write=True) as c:
                self.get(c, 'labs', lab_id)
                if team_id: self.get(c, 'teams', team_id, lab_id)
                sha, size, created = self.blobs.put(stream)
                f = {'id': identity(), 'lab_id': lab_id, 'team_id': team_id, 'filename': filename, 'sha256': sha, 'size': size, 'media_type': (media_type or 'application/octet-stream')[:200], 'created_at': now()}
                self.db.save(c, 'files', f, COLUMNS['files'])
                if submission:
                    data = self.blobs.read(sha, size)
                    obj = {'id': identity(), 'lab_id': lab_id, 'team_id': team_id, 'file_id': f['id'], 'filename': filename, 'sha256': sha, 'created_at': now(), **inspect_zip(data)}
                    self.db.save(c, 'submissions', obj, COLUMNS['submissions'])
                    return obj
                return f
        except BaseException:
            if sha and created:
                # Rollback releases its lock. Reacquire it before removing a blob,
                # since another upload may have committed the same content meanwhile.
                with self.db.connect(write=True) as cleanup:
                    referenced = cleanup.execute("SELECT 1 FROM files WHERE json_extract(data,'$.sha256')=? LIMIT 1", (sha,)).fetchone()
                    if not referenced: self.blobs.discard(sha)
            raise

    def material(self, lab_id, body):
        obj = {**body.model_dump(), 'id': identity(), 'lab_id': lab_id, 'revision': 1, 'updated_at': now()}
        with self.db.connect(write=True) as c:
            self.get(c, 'labs', lab_id)
            f = self.reference(c, 'files', body.file_id, lab_id)
            if f['team_id'] is not None: invalid('Lab materials require a shared lab file')
            if body.exercise_id: self.reference(c, 'exercises', body.exercise_id, lab_id)
            self.db.save(c, 'materials', obj, COLUMNS['materials'])
        return obj

    def read_evidence(self, lab_id, team_id, evidence_id):
        with self.db.connect() as c:
            self.get(c, 'teams', team_id, lab_id)
            obj = self.get(c, 'evidence', evidence_id, lab_id)
            if obj['team_id'] != team_id: missing()
            return obj

    def patch_record(self, table, lab_id, identifier, body, team_id=None):
        model = s.MaterialCreate if table == 'materials' else s.EvidenceCreate
        with self.db.connect(write=True) as c:
            self.get(c, 'labs', lab_id)
            if team_id is not None: self.get(c, 'teams', team_id, lab_id)
            old = self.get(c, table, identifier, lab_id)
            if team_id is not None and old['team_id'] != team_id: missing()
            if body.revision != old['revision']:
                raise CatalogError(409, 'conflict', 'Revision conflict', {'current_revision': old['revision']})
            changes = body.model_dump(exclude_unset=True); changes.pop('revision')
            new = {**old, **changes}
            validated = model.model_validate({key: new[key] for key in model.model_fields})
            if validated.exercise_id: self.reference(c, 'exercises', validated.exercise_id, lab_id)
            if validated.file_id:
                f = self.reference(c, 'files', validated.file_id, lab_id, team_id)
                if table == 'materials' and f['team_id'] is not None: invalid('Lab materials require a shared lab file')
            if isinstance(validated, s.EvidenceCreate) and validated.submission_id:
                self.reference(c, 'submissions', validated.submission_id, lab_id, team_id)
            new.update(validated.model_dump())
            new['revision'] += 1; new['updated_at'] = now()
            self.db.save(c, table, new, COLUMNS[table], update=True)
            return new

    def team_list(self, table, lab_id, team_id, exercise_id=None):
        with self.db.connect() as c:
            self.get(c, 'teams', team_id, lab_id)
            if exercise_id: self.get(c, 'exercises', exercise_id, lab_id)
            return self.db.rows(c, table, 'team_id=?' + (' AND exercise_id=?' if exercise_id else ''), (team_id, exercise_id) if exercise_id else (team_id,))

    @staticmethod
    def snapshot(exercise):
        return {key: exercise[key] for key in (*RUBRIC_FIELDS, 'rubric_revision')}

    def assessment(self, c, team_id, exercise):
        records = self.db.rows(c, 'assessments', 'team_id=? AND exercise_id=?', (team_id, exercise['id']))
        if records:
            obj = records[0]
            return {**obj, 'rubric_stale': obj['rubric_revision'] != exercise['rubric_revision']}
        return {'id': None, 'team_id': team_id, 'exercise_id': exercise['id'], 'submission_id': None, 'status': 'ungraded', 'score': None, 'criterion_scores': {}, 'notes': '', 'source': 'human', 'revision': 0, 'rubric_revision': exercise['rubric_revision'], 'rubric_snapshot': self.snapshot(exercise), 'rubric_stale': False, 'created_at': None, 'updated_at': None}

    def get_assessment(self, lab_id, team_id, exercise_id):
        with self.db.connect() as c:
            self.get(c, 'teams', team_id, lab_id)
            exercise = self.get(c, 'exercises', exercise_id, lab_id)
            return self.assessment(c, team_id, exercise)

    def put_assessment(self, lab_id, team_id, exercise_id, body):
        with self.db.connect(write=True) as c:
            self.get(c, 'teams', team_id, lab_id)
            exercise = self.get(c, 'exercises', exercise_id, lab_id)
            old = self.assessment(c, team_id, exercise)
            if old['revision'] != body.revision:
                raise CatalogError(409, 'conflict', 'Revision conflict', {'current_revision': old['revision']})
            if exercise['rubric_revision'] != body.rubric_revision:
                raise CatalogError(409, 'conflict', 'Loaded rubric revision conflict', {'current_rubric_revision': exercise['rubric_revision']})
            if body.submission_id: self.reference(c, 'submissions', body.submission_id, lab_id, team_id)
            same_scores = {k: Decimal(v) for k, v in old['criterion_scores'].items()} == {k: Decimal(v) for k, v in body.criterion_scores.items()}
            same_score = (old['score'] is None and body.score is None) or (old['score'] is not None and body.score is not None and Decimal(old['score']) == Decimal(body.score))
            if old['rubric_snapshot']['grading_mode'] == 'criteria' and body.score is None:
                same_score = True  # Criteria editors let the server compute the aggregate.
            unchanged = old['status'] == body.status and old['submission_id'] == body.submission_id and same_scores and same_score
            if old['rubric_stale'] and not unchanged and not body.confirm_rubric_change:
                raise CatalogError(409, 'rubric_review_required', 'Confirm review against the current rubric before changing grading values')
            retain_stale = old['rubric_stale'] and unchanged and not body.confirm_rubric_change
            rules = old['rubric_snapshot'] if retain_stale else exercise
            score = body.score
            if rules['grading_mode'] == 'manual':
                if body.criterion_scores: invalid('Manual assessment cannot have criterion scores')
            else:
                rubric = {x['id']: x for x in rules['criteria']}
                supplied = set(body.criterion_scores)
                if not supplied <= set(rubric): invalid('Unknown criterion id')
                if any(Decimal(value) > Decimal(rubric[key]['max_points']) for key, value in body.criterion_scores.items()): invalid('Criterion score exceeds maximum')
                complete = supplied == set(rubric)
                if not complete:
                    if body.status == 'final' or score is not None: invalid('Complete criterion scores are required for an aggregate score or final assessment')
                else:
                    computed = sum((Decimal(x) for x in body.criterion_scores.values()), Decimal(0))
                    if score is not None and Decimal(score) != computed: invalid('Score must equal criterion score sum')
                    score = decimal_string(computed)
                if body.status == 'ungraded' and supplied: invalid('Ungraded assessment cannot have criterion scores')
            if score is not None and Decimal(score) > Decimal(rules['max_points']): invalid('Score exceeds exercise maximum')
            if body.status == 'final' and score is None: invalid('Final assessment requires an actual score')
            if body.status == 'ungraded' and score is not None: invalid('Ungraded assessment cannot have a score')
            stamp = now()
            obj = {**body.model_dump(exclude={'confirm_rubric_change'}), 'id': old['id'] or identity(), 'team_id': team_id, 'exercise_id': exercise_id, 'score': score, 'revision': old['revision'] + 1, 'rubric_revision': exercise['rubric_revision'], 'rubric_snapshot': self.snapshot(exercise), 'rubric_stale': False, 'created_at': old['created_at'] or stamp, 'updated_at': stamp}
            if retain_stale:
                obj.update({key: old[key] for key in ('score', 'criterion_scores', 'rubric_revision', 'rubric_snapshot', 'rubric_stale')})
            self.db.save(c, 'assessments', obj, COLUMNS['assessments'], update=bool(old['id']))
            import json
            c.execute('INSERT INTO assessment_history(id,assessment_id,data) VALUES(?,?,?)', (identity(), obj['id'], json.dumps(obj, ensure_ascii=False, allow_nan=False)))
            return obj

    def history(self, lab_id, team_id, exercise_id):
        with self.db.connect() as c:
            self.get(c, 'teams', team_id, lab_id)
            exercise = self.get(c, 'exercises', exercise_id, lab_id)
            assessment = self.assessment(c, team_id, exercise)
            records = self.db.rows(c, 'assessment_history', 'assessment_id=?', (assessment['id'],)) if assessment['id'] else []
            return [{**x, 'rubric_stale': x['rubric_revision'] != exercise['rubric_revision']} for x in records]

    def evidence(self, lab_id, team_id, body):
        with self.db.connect(write=True) as c:
            self.get(c, 'teams', team_id, lab_id)
            self.reference(c, 'exercises', body.exercise_id, lab_id)
            if body.submission_id: self.reference(c, 'submissions', body.submission_id, lab_id, team_id)
            if body.file_id: self.reference(c, 'files', body.file_id, lab_id, team_id)
            stamp = now()
            obj = {**body.model_dump(), 'id': identity(), 'lab_id': lab_id, 'team_id': team_id, 'created_at': stamp, 'updated_at': stamp, 'revision': 1}
            self.db.save(c, 'evidence', obj, COLUMNS['evidence'])
            return obj

    def delete_evidence(self, lab_id, team_id, evidence_id):
        with self.db.connect(write=True) as c:
            self.get(c, 'teams', team_id, lab_id)
            obj = self.get(c, 'evidence', evidence_id, lab_id)
            if obj['team_id'] != team_id: missing()
            c.execute('DELETE FROM evidence WHERE id=?', (evidence_id,))

    def overview(self, lab_id, limit, offset):
        with self.db.connect() as c:
            lab = self.get(c, 'labs', lab_id)
            exercises = sorted(self.db.rows(c, 'exercises', 'lab_id=?', (lab_id,)), key=lambda x: (x['position'], x['created_at'], x['id']))
            active = [x for x in exercises if not x['archived']]
            teams = self.db.rows(c, 'teams', 'lab_id=?', (lab_id,))
            total_points = decimal_string(sum((Decimal(x['max_points']) for x in active), Decimal(0)))
            rows = []
            for team in teams:
                grades = [self.assessment(c, team['id'], x) for x in exercises]
                current = [g for g in grades if g['exercise_id'] in {x['id'] for x in active}]
                finalized = [g for g in current if g['status'] == 'final' and not g['rubric_stale'] and g['score'] is not None]
                rows.append({'team': team, 'submissions_count': len(self.db.rows(c, 'submissions', 'team_id=?', (team['id'],))), 'assessments': grades, 'awarded_points': decimal_string(sum((Decimal(g['score']) for g in finalized), Decimal(0))), 'total_points': total_points, 'grade_complete': bool(active) and len(finalized) == len(active)})
            return {'lab': lab, 'exercises': exercises, 'rows': rows[offset:offset + limit], 'total': len(rows), 'limit': limit, 'offset': offset, 'stats': {'teams': len(teams), 'active_teams': sum(not x['archived'] for x in teams), 'active_exercises': len(active), 'complete_teams': sum(x['grade_complete'] for x in rows), 'submissions': sum(x['submissions_count'] for x in rows)}}

    def export(self, lab_id):
        with self.db.connect() as c:
            result = {'schema_version': 1, 'lab': self.get(c, 'labs', lab_id)}
            for table in ('exercises', 'teams', 'files', 'materials', 'submissions', 'evidence'):
                result[table] = self.db.rows(c, table, 'lab_id=?', (lab_id,))
            exercises = {x['id']: x for x in result['exercises']}
            assessments = self.db.rows(c, 'assessments', 'team_id IN (SELECT id FROM teams WHERE lab_id=?)', (lab_id,))
            history = self.db.rows(c, 'assessment_history', 'assessment_id IN (SELECT id FROM assessments WHERE team_id IN (SELECT id FROM teams WHERE lab_id=?))', (lab_id,))
            for key, items in [('assessments', assessments), ('assessment_history', history)]:
                result[key] = [{**x, 'rubric_stale': x['rubric_revision'] != exercises[x['exercise_id']]['rubric_revision']} for x in items]
            return result
