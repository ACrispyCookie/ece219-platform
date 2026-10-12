"""SQLite catalog, per-operation connections and explicit atomic transactions."""
from contextlib import contextmanager
from pathlib import Path
import json
import sqlite3


TABLES = ('labs', 'exercises', 'teams', 'files', 'materials', 'submissions', 'assessments', 'assessment_history', 'evidence')


def reject_symlinks(path):
    path = Path(path).absolute()
    for parent in [path, *path.parents]:
        if parent.is_symlink():
            raise ValueError('symlink paths are not permitted')
    return path


class Database:
    def __init__(self, root):
        self.root = reject_symlinks(root)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = reject_symlinks(self.root / 'catalog.sqlite3')
        for name in ('catalog.sqlite3-wal', 'catalog.sqlite3-shm'):
            reject_symlinks(self.root / name)
        with self.connect(write=True) as c:
            version = c.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1, 2):
                raise ValueError('unsupported database schema version')
            if version == 0:
                c.executescript('''
                BEGIN IMMEDIATE;
                CREATE TABLE labs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE exercises(id TEXT PRIMARY KEY, lab_id TEXT NOT NULL REFERENCES labs(id), data TEXT NOT NULL);
                CREATE TABLE teams(id TEXT PRIMARY KEY, lab_id TEXT NOT NULL REFERENCES labs(id), data TEXT NOT NULL);
                CREATE TABLE files(id TEXT PRIMARY KEY, lab_id TEXT NOT NULL REFERENCES labs(id), team_id TEXT REFERENCES teams(id), data TEXT NOT NULL);
                CREATE TABLE materials(id TEXT PRIMARY KEY, lab_id TEXT NOT NULL REFERENCES labs(id), exercise_id TEXT REFERENCES exercises(id), file_id TEXT NOT NULL REFERENCES files(id), data TEXT NOT NULL);
                CREATE TABLE submissions(id TEXT PRIMARY KEY, lab_id TEXT NOT NULL REFERENCES labs(id), team_id TEXT NOT NULL REFERENCES teams(id), file_id TEXT NOT NULL REFERENCES files(id), data TEXT NOT NULL);
                CREATE TABLE assessments(id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), exercise_id TEXT NOT NULL REFERENCES exercises(id), submission_id TEXT REFERENCES submissions(id), data TEXT NOT NULL, UNIQUE(team_id,exercise_id));
                CREATE TABLE assessment_history(id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id), data TEXT NOT NULL);
                CREATE TABLE evidence(id TEXT PRIMARY KEY, lab_id TEXT NOT NULL REFERENCES labs(id), team_id TEXT NOT NULL REFERENCES teams(id), exercise_id TEXT NOT NULL REFERENCES exercises(id), submission_id TEXT REFERENCES submissions(id), file_id TEXT REFERENCES files(id), data TEXT NOT NULL);
                CREATE INDEX exercise_lab ON exercises(lab_id);
                CREATE INDEX team_lab ON teams(lab_id);
                CREATE INDEX file_lab ON files(lab_id);
                CREATE INDEX submission_team ON submissions(team_id);
                CREATE INDEX history_assessment ON assessment_history(assessment_id);
                CREATE INDEX evidence_team_exercise ON evidence(team_id,exercise_id);
                CREATE TRIGGER history_no_update BEFORE UPDATE ON assessment_history BEGIN SELECT RAISE(ABORT,'immutable assessment history'); END;
                CREATE TRIGGER history_no_delete BEFORE DELETE ON assessment_history BEGIN SELECT RAISE(ABORT,'immutable assessment history'); END;
                PRAGMA user_version=1;
                COMMIT;
                ''')
                version = 1
            if version == 1:
                # Add correction revisions atomically; unknown historic update
                # times stay null rather than inventing dates during migration.
                if not c.in_transaction: c.execute('BEGIN IMMEDIATE')
                for table in ('materials', 'evidence'):
                    c.execute(f"UPDATE {table} SET data=json_set(data, '$.revision', COALESCE(json_extract(data,'$.revision'),1), '$.updated_at', json_extract(data,'$.updated_at'))")
                c.execute('PRAGMA user_version=2')

    @contextmanager
    def connect(self, write=False):
        reject_symlinks(self.path)
        for name in ('catalog.sqlite3-wal', 'catalog.sqlite3-shm'):
            reject_symlinks(self.root / name)
        c = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA foreign_keys=ON')
        c.execute('PRAGMA journal_mode=WAL')
        try:
            c.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield c
            c.commit()
        except BaseException:
            c.rollback()
            raise
        finally:
            c.close()

    @staticmethod
    def rows(c, table, where='', args=()):
        assert table in TABLES
        query = f'SELECT data FROM {table}' + (' WHERE ' + where if where else '') + ' ORDER BY rowid'
        return [json.loads(r['data']) for r in c.execute(query, args)]

    @staticmethod
    def save(c, table, obj, columns=(), update=False):
        assert table in TABLES
        values = {key: obj.get(key) for key in columns}
        values['data'] = json.dumps(obj, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        if update:
            sql = f'UPDATE {table} SET ' + ','.join(f'{key}=?' for key in values) + ' WHERE id=?'
            c.execute(sql, [*values.values(), obj['id']])
        else:
            values = {'id': obj['id'], **values}
            c.execute(f'INSERT INTO {table} ({",".join(values)}) VALUES ({",".join("?" for _ in values)})', list(values.values()))
