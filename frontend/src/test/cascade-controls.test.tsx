import { confirmRemoval, cancelRemoval } from './removal-dialog-helpers';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Removal from '../Removal';
import App from '../App';
import Exercises from '../Exercises';
import Teams from '../Teams';
import TeamDetail from '../TeamDetail';
import Materials from '../Materials';
import EvidenceList from '../Evidence';
import Submissions from '../Submissions';
import AssessmentView from '../Assessment';
import { DirtyContext } from '../ui';
import { OperationContext, useOperations } from '../OperationContext';
import type { ReactNode } from 'react';
import type { Assessment, Exercise, Material, Evidence, Submission, StoredFile } from '../types';

const token = 'a'.repeat(64);
const preview = {
  dependencies: [],
  unreferenced_files: [],
  unreferenced_files_total: 0,
  cascade_counts: [
    { kind: 'labs', count: 1 },
    { kind: 'assessment_history', count: 3 },
  ],
  confirmation_token: token,
};
const calls: { path: string; method: string }[] = [];
const guard = vi.fn(() => true),
  removed = vi.fn();
let handler: (path: string, method: string) => Promise<Response>;
const reply = (status: number, data?: unknown) =>
  new Response(data === undefined ? null : JSON.stringify(data), { status });
const page = (items: unknown[]) => ({ items, total: items.length, limit: 100, offset: 0 });
function Scope({ children }: { children: ReactNode }) {
  const operations = useOperations();
  return (
    <DirtyContext.Provider value={{ set: () => {}, guard }}>
      <OperationContext.Provider value={operations}>
        <fieldset disabled={operations.pending}>{children}</fieldset>
      </OperationContext.Provider>
    </DirtyContext.Provider>
  );
}
beforeEach(() => {
  calls.length = 0;
  removed.mockClear();
  guard.mockReset().mockReturnValue(true);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  handler = async (path, method) =>
    method === 'DELETE'
      ? reply(204)
      : path.endsWith('/deletion-impact')
        ? reply(200, preview)
        : reply(404);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const path = String(input).replace('/api/v1', '');
      const method = init?.method || 'GET';
      calls.push({ path, method });
      return handler(path, method);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
const deletion = () => screen.getByRole('button', { name: 'Διαγραφή εργαστηρίου Δοκιμή' });
const control = () => (
  <Scope>
    <Removal path="/labs/l" revision={2} title="Δοκιμή" kind="εργαστηρίου" onRemoved={removed} />
  </Scope>
);
it('fetches server impact before named confirmation, sends exact cascade token and displayed revision, verifies absence', async () => {
  render(control());
  fireEvent.click(deletion());
  const message = await confirmRemoval();
  await waitFor(() => expect(removed).toHaveBeenCalledOnce());
  expect(calls).toEqual([
    { path: '/labs/l/deletion-impact', method: 'GET' },
    { path: `/labs/l?cascade=true&confirmation_token=${token}&revision=2`, method: 'DELETE' },
    { path: '/labs/l', method: 'GET' },
  ]);
  expect(message).toContain('Ιστορικό αξιολογήσεων: 3');
  expect(window.confirm).not.toHaveBeenCalled();
  expect(message).toContain('Εργαστήρια: 1');
  expect(message).toContain('σημειώσεις');
  expect(message).toContain('δεν αναιρείται');
  expect(message).toContain('κοινόχρηστο');
  expect(message).not.toContain('προστατεύονται');
  expect(deletion()).toHaveClass('compact-delete');
  expect(deletion()).toHaveTextContent(/^Διαγραφή$/);
});
it('cancel after impact performs no DELETE and releases synchronous lock', async () => {
  render(control());
  fireEvent.click(deletion());
  await cancelRemoval();
  expect(calls).toEqual([{ path: '/labs/l/deletion-impact', method: 'GET' }]);
  expect(deletion()).toBeEnabled();
  expect(removed).not.toHaveBeenCalled();
});
it('dirty refusal happens before acquiring ownership or fetching impact', () => {
  guard.mockReturnValue(false);
  render(control());
  fireEvent.click(deletion());
  expect(calls).toEqual([]);
  expect(window.confirm).not.toHaveBeenCalled();
});
it.each([
  {},
  { ...preview, confirmation_token: 'bad' },
  { ...preview, cascade_counts: [{ kind: 'labs', count: 0 }] },
  { ...preview, cascade_counts: [{ kind: 'wrong', count: 1 }] },
  {
    ...preview,
    cascade_counts: [
      { kind: 'labs', count: 1 },
      { kind: 'labs', count: 2 },
    ],
  },
  { ...preview, unreferenced_files_total: -1 },
  {
    ...preview,
    unreferenced_files: Array.from({ length: 51 }, () => ({ id: 'x', filename: 'x' })),
    unreferenced_files_total: 51,
  },
])('malformed impact refuses confirmation and deletion: %j', async (value) => {
  handler = async () => reply(200, value);
  render(control());
  fireEvent.click(deletion());
  expect(await screen.findByRole('alert')).toHaveTextContent('Μη έγκυρη');
  expect(window.confirm).not.toHaveBeenCalled();
  expect(calls).toHaveLength(1);
});
it('deletion_changed preserves target and requires a newly requested preview and manual confirmation', async () => {
  let attempts = 0;
  handler = async (path, method) =>
    method === 'DELETE' && ++attempts === 1
      ? reply(409, { code: 'deletion_changed', message: 'changed' })
      : method === 'DELETE'
        ? reply(204)
        : path.endsWith('/deletion-impact')
          ? reply(200, preview)
          : reply(404);
  render(control());
  fireEvent.click(deletion());
  await confirmRemoval();
  expect(await screen.findByRole('alert')).toHaveTextContent('νέα επιβεβαίωση');
  expect(removed).not.toHaveBeenCalled();
  expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  fireEvent.click(deletion());
  const message = await confirmRemoval();
  await waitFor(() => expect(removed).toHaveBeenCalledOnce());
  expect(window.confirm).not.toHaveBeenCalled();
  expect(calls.filter((c) => c.path.endsWith('/deletion-impact'))).toHaveLength(2);
});
it('impact acquisition excludes sibling submit before any network await', async () => {
  let release!: () => void;
  handler = async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return reply(200, preview);
  };
  render(
    <Scope>
      <Removal path="/labs/l" revision={2} title="Δοκιμή" kind="εργαστηρίου" onRemoved={removed} />
      <Submissions
        labId="l"
        teamId="t"
        items={[]}
        total={0}
        busy={false}
        onMore={() => {}}
        onRefresh={() => {}}
      />
    </Scope>,
  );
  fireEvent.change(screen.getByLabelText('Αρχεία ZIP'), {
    target: { files: [new File(['zip'], 'a.zip')] },
  });
  const upload = screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' });
  act(() => {
    fireEvent.click(deletion());
    fireEvent.click(upload);
  });
  expect(calls).toEqual([{ path: '/labs/l/deletion-impact', method: 'GET' }]);
  await act(async () => release());
  await cancelRemoval();
});
const exercise: Exercise = {
  id: 'x',
  lab_id: 'l',
  title: 'Άσκηση',
  description: '',
  position: 0,
  max_points: '3',
  grading_mode: 'manual',
  grading_instructions: '',
  criteria: [],
  rubric_revision: 1,
  revision: 1,
  archived: false,
};
const grade: Assessment = {
  id: 'a',
  team_id: 't',
  exercise_id: 'x',
  submission_id: null,
  status: 'final',
  score: '2',
  criterion_scores: {},
  notes: 'old notes',
  source: 'human',
  revision: 2,
  rubric_revision: 1,
  rubric_stale: false,
};
const file: StoredFile = {
  id: 'f',
  lab_id: 'l',
  filename: 'upload.txt',
  sha256: '0',
  size: 1,
  media_type: 'text/plain',
  created_at: '',
};
const material: Material = {
  id: 'm',
  revision: 4,
  lab_id: 'l',
  exercise_id: null,
  file_id: 'f',
  role: 'other',
  title: 'Υλικό',
  description: '',
};
const evidence: Evidence = {
  id: 'e',
  revision: 3,
  team_id: 't',
  exercise_id: 'x',
  submission_id: null,
  kind: 'text',
  title: 'Τεκμήριο',
  text: 'text',
  source: 'human',
  created_at: '',
};
const submission: Submission = {
  id: 's',
  lab_id: 'l',
  team_id: 't',
  file_id: 'f',
  filename: 'version.zip',
  sha256: '0',
  created_at: '',
  archive_status: 'valid',
  archive_errors: [],
};
it.each(['material', 'evidence', 'submission', 'file'] as const)(
  'renders %s deletion in trailing item action group and uses scoped path/global immutable readback',
  async (kind) => {
    const paths = {
      material: '/labs/l/materials/m',
      evidence: '/labs/l/teams/t/evidence/e',
      submission: '/labs/l/teams/t/submissions/s',
      file: '/labs/l/files/f',
    };
    const labels = {
      material: 'Διαγραφή υλικού Υλικό',
      evidence: 'Διαγραφή τεκμηρίου Τεκμήριο',
      submission: 'Διαγραφή παράδοσης version.zip',
      file: 'Διαγραφή αρχείου upload.txt',
    };
    let deleted = false;
    handler = async (path, method) => {
      if (method === 'DELETE') {
        deleted = true;
        return reply(204);
      }
      if (path.endsWith('/deletion-impact')) return reply(200, preview);
      if (deleted && [paths[kind], '/files/f', '/submissions/s'].includes(path)) return reply(404);
      if (path.startsWith('/labs/l/materials?'))
        return reply(200, page(deleted && kind === 'material' ? [] : [material]));
      if (path.startsWith('/labs/l/files?'))
        return reply(200, page(deleted && kind === 'file' ? [] : [file]));
      if (path.startsWith('/labs/l/exercises?')) return reply(200, page([exercise]));
      if (path.startsWith('/labs/l/teams/t/evidence?'))
        return reply(200, page(deleted ? [] : [evidence]));
      if (path === '/files/f') return reply(200, file);
      if (path === '/submissions/s') return reply(200, submission);
      if (path.includes('/members?')) return reply(200, page([]));
      return reply(404);
    };
    render(
      <Scope>
        {kind === 'material' || kind === 'file' ? (
          <Materials labId="l" />
        ) : kind === 'evidence' ? (
          <EvidenceList labId="l" teamId="t" exerciseId="x" submissions={[]} />
        ) : (
          <Submissions
            labId="l"
            teamId="t"
            items={[submission]}
            total={1}
            busy={false}
            onMore={() => {}}
            onRefresh={removed}
          />
        )}
      </Scope>,
    );
    const button = await screen.findByRole('button', { name: labels[kind] });
    expect(button.closest('.item-actions')).not.toBeNull();
    expect(button).toHaveClass('compact-delete');
    if (kind === 'submission') {
      fireEvent.click(screen.getByRole('button', { name: 'Επιλογή παράδοσης s' }));
      await screen.findByText('Περιεχόμενα επιλεγμένης παράδοσης');
    }
    fireEvent.click(button);
    await confirmRemoval();
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'GET' &&
            c.path ===
              (kind === 'file'
                ? '/files/f'
                : kind === 'submission'
                  ? '/submissions/s'
                  : paths[kind]) &&
            deleted,
        ),
      ).toBe(true),
    );
    const write = calls.find((c) => c.method === 'DELETE')!;
    expect(write.path).toBe(
      `${paths[kind]}?cascade=true&confirmation_token=${token}${kind === 'material' ? '&revision=4' : kind === 'evidence' ? '&revision=3' : ''}`,
    );
    if (kind === 'submission') {
      await waitFor(() => expect(removed).toHaveBeenCalledOnce());
      expect(screen.queryByText('Περιεχόμενα επιλεγμένης παράδοσης')).not.toBeInTheDocument();
    }
  },
);
it('persisted assessment deletion is outside SaveForm and verifies empty grade plus zero history before resetting editor', async () => {
  let deleted = false;
  handler = async (path, method) => {
    if (method === 'DELETE') {
      deleted = true;
      return reply(204);
    }
    if (path.endsWith('/deletion-impact')) return reply(200, preview);
    if (path === '/labs/l/teams/t/assessments/x')
      return reply(
        200,
        deleted
          ? { ...grade, id: null, revision: 0, score: null, notes: '', status: 'ungraded' }
          : grade,
      );
    return reply(200, page([]));
  };
  render(
    <Scope>
      <AssessmentView labId="l" teamId="t" exercise={exercise} submissions={[]} />
    </Scope>,
  );
  const button = await screen.findByRole('button', { name: 'Διαγραφή αξιολόγησης Άσκηση' });
  expect(button.closest('form')).toBeNull();
  expect(button.closest('.item-actions')).not.toBeNull();
  fireEvent.click(button);
  await confirmRemoval();
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Διαγραφή αξιολόγησης Άσκηση' }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText('Βαθμός')).toHaveValue('');
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('');
  expect(calls).toContainEqual({
    path: '/labs/l/teams/t/assessments/x/history?limit=1&offset=0',
    method: 'GET',
  });
});
it.each(['lab', 'exercise', 'team', 'team-detail'] as const)(
  'places %s removal beside the existing management action',
  async (layer) => {
    const lab = { id: 'l', title: 'Δοκιμή', description: '', archived: false, revision: 1 };
    const team = {
      id: 't',
      lab_id: 'l',
      label: 'Ομάδα',
      members: [],
      membership_complete: false,
      notes: '',
      archived: false,
      revision: 1,
    };
    handler = async (path) => {
      if (path === '/session') return reply(200, { authenticated: true });
      if (path === '/labs/l') return reply(200, lab);
      if (path.startsWith('/labs?')) return reply(200, page([lab]));
      if (path.startsWith('/labs/l/exercises')) return reply(200, page([exercise]));
      if (path === '/labs/l/teams/t') return reply(200, team);
      if (path.startsWith('/labs/l/teams?')) return reply(200, page([team]));
      if (path.includes('/overview')) return reply(200, { rows: [], exercises: [], total: 0 });
      return reply(200, page([]));
    };
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    render(
      layer === 'lab' ? (
        <App />
      ) : layer === 'exercise' ? (
        <Exercises labId="l" />
      ) : layer === 'team' ? (
        <Teams labId="l" onTeam={() => {}} />
      ) : (
        <TeamDetail
          labId="l"
          teamId="t"
          onExercise={() => {}}
          onBack={() => {}}
          onTeam={() => {}}
        />
      ),
    );
    const label =
      layer === 'lab'
        ? 'Διαγραφή εργαστηρίου Δοκιμή'
        : layer === 'exercise'
          ? 'Διαγραφή άσκησης Άσκηση'
          : 'Διαγραφή ομάδας Ομάδα';
    const button = await screen.findByRole('button', { name: label });
    const group = button.closest('.item-actions');
    expect(group).not.toBeNull();
    const sibling =
      layer === 'lab'
        ? 'Ρυθμίσεις εργαστηρίου'
        : layer === 'exercise'
          ? 'Επεξεργασία Άσκηση'
          : layer === 'team'
            ? 'Προβολή ομάδας'
            : 'Επεξεργασία ομάδας';
    expect(group).toContainElement(screen.getByRole('button', { name: sibling }));
  },
);
it.each([
  'persisted',
  'revision',
  'score',
  'status',
  'history-count',
  'history-rows',
  'malformed-history',
  'not-found',
])('assessment %s readback refuses reconciliation and keeps editor changes', async (fault) => {
  let deleted = false;
  handler = async (path, method) => {
    if (method === 'DELETE') {
      deleted = true;
      return reply(204);
    }
    if (path.endsWith('/deletion-impact')) return reply(200, preview);
    if (path === '/labs/l/teams/t/assessments/x') {
      if (!deleted) return reply(200, grade);
      if (fault === 'not-found') return reply(404);
      return reply(200, {
        ...grade,
        id: fault === 'persisted' ? 'a' : null,
        revision: fault === 'revision' ? 1 : 0,
        score: fault === 'score' ? '0' : null,
        status: fault === 'status' ? 'draft' : 'ungraded',
      });
    }
    if (deleted && path.endsWith('/history?limit=1&offset=0'))
      return reply(
        200,
        fault === 'malformed-history'
          ? {}
          : {
              ...page(fault === 'history-rows' ? [grade] : []),
              total: fault === 'history-count' ? 1 : 0,
            },
      );
    return reply(200, page([]));
  };
  render(
    <Scope>
      <AssessmentView labId="l" teamId="t" exercise={exercise} submissions={[]} />
    </Scope>,
  );
  fireEvent.change(await screen.findByLabelText('Σημειώσεις άσκησης'), {
    target: { value: 'Preserved notes' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Διαγραφή αξιολόγησης Άσκηση' }));
  await confirmRemoval();
  expect(await screen.findByRole('alert')).toHaveTextContent('δεν επιβεβαιώθηκε');
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('Preserved notes');
  expect(screen.getByRole('button', { name: 'Διαγραφή αξιολόγησης Άσκηση' })).toBeEnabled();
});
it('unsaved assessment has no removal control', async () => {
  handler = async (path) =>
    reply(
      200,
      path === '/labs/l/teams/t/assessments/x'
        ? { ...grade, id: null, revision: 0, score: null, status: 'ungraded' }
        : page([]),
    );
  render(
    <Scope>
      <AssessmentView labId="l" teamId="t" exercise={exercise} submissions={[]} />
    </Scope>,
  );
  await screen.findByLabelText('Βαθμός');
  expect(screen.queryByRole('button', { name: /Διαγραφή αξιολόγησης/ })).not.toBeInTheDocument();
});
