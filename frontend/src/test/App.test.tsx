// All data and tokens in this suite are explicitly synthetic HTTP fixtures.
import { confirmRemoval } from './removal-dialog-helpers';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, it, expect, vi } from 'vitest';
import App from '../App';
export const lab = {
  id: 'synthetic-lab',
  title: 'Συνθετικό εργαστήριο',
  description: 'Δοκιμή',
  archived: false,
  revision: 1,
};
export const exercise = {
  id: 'synthetic-ex',
  lab_id: lab.id,
  title: 'Άσκηση Α',
  description: 'Περιγραφή',
  position: 1,
  max_points: '0.3',
  grading_mode: 'manual',
  grading_instructions: 'Οδηγίες',
  criteria: [],
  rubric_revision: 1,
  revision: 1,
  archived: false,
};
export const team = {
  id: 'synthetic-team',
  lab_id: lab.id,
  label: 'Ομάδα δοκιμής',
  members: [{ student_id: '00123', name: 'Συνθετικό μέλος' }],
  membership_complete: false,
  notes: '',
  archived: false,
  revision: 1,
};
export const page = (items: unknown[], total = items.length) => ({
  items,
  total,
  limit: 100,
  offset: 0,
});
export const emptyAssessment = {
  id: null,
  team_id: team.id,
  exercise_id: exercise.id,
  submission_id: null,
  status: 'ungraded',
  score: null,
  criterion_scores: {},
  notes: '',
  source: 'human',
  revision: 0,
  rubric_revision: 1,
  rubric_stale: false,
};
let overrides: Record<string, unknown>;
export function mockAPI(custom: Record<string, unknown> = {}) {
  const handlers = { ...overrides, ...custom };
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    const path = u.replace(/\?.*/, '');
    const key = `${init?.method || 'GET'} ${path}`;
    const value = handlers[key];
    if (value instanceof Response) return value.clone();
    if (typeof value === 'function') return (value as Function)(init, u);
    if (value === undefined)
      return new Response(
        JSON.stringify({ code: 'missing_mock', message: `Missing synthetic mock: ${key}` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  });
}
beforeEach(() => {
  overrides = {
    'GET /api/v1/session': { authenticated: true },
    'GET /api/v1/labs': page([lab]),
    [`GET /api/v1/labs/${lab.id}`]: lab,
    [`GET /api/v1/labs/${lab.id}/exercises`]: page([exercise]),
    [`GET /api/v1/labs/${lab.id}/exercises/${exercise.id}`]: exercise,
    [`GET /api/v1/labs/${lab.id}/teams`]: page([team]),
    [`GET /api/v1/labs/${lab.id}/overview`]: {
      lab,
      exercises: [exercise],
      rows: [
        {
          team,
          submissions_count: 0,
          assessments: [emptyAssessment],
          awarded_points: null,
          total_points: '0.3',
          grade_complete: false,
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
      stats: {},
    },
    [`GET /api/v1/labs/${lab.id}/materials`]: page([]),
    [`GET /api/v1/labs/${lab.id}/files`]: page([]),
    [`GET /api/v1/labs/${lab.id}/teams/${team.id}`]: team,
    [`GET /api/v1/labs/${lab.id}/teams/${team.id}/submissions`]: page([]),
    [`GET /api/v1/labs/${lab.id}/teams/${team.id}/assessments/${exercise.id}`]: emptyAssessment,
    [`GET /api/v1/labs/${lab.id}/teams/${team.id}/assessments/${exercise.id}/history`]: page([]),
    [`GET /api/v1/labs/${lab.id}/teams/${team.id}/evidence`]: page([]),
  };
  vi.stubGlobal('fetch', mockAPI());
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
it('loads cookie session and shows an empty production catalog without demo labs', async () => {
  vi.stubGlobal('fetch', mockAPI({ 'GET /api/v1/labs': page([]) }));
  render(<App />);
  expect(await screen.findByText('Δεν υπάρχουν εργαστήρια ακόμη.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Νέο εργαστήριο' })).toBeVisible();
  expect(fetch).toHaveBeenCalledWith(
    '/api/v1/session',
    expect.objectContaining({ credentials: 'same-origin' }),
  );
});
it('logs in using password field and never stores a token in browser storage', async () => {
  let loggedIn = false;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      'GET /api/v1/session': () => new Response(JSON.stringify({ authenticated: loggedIn })),
      'POST /api/v1/session': () => {
        loggedIn = true;
        return new Response(JSON.stringify({ authenticated: true }));
      },
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  const input = await screen.findByLabelText('Κλειδί πρόσβασης');
  expect(input).toHaveAttribute('type', 'password');
  await user.type(input, 'SYNTHETIC-TEST-TOKEN');
  await user.click(screen.getByRole('button', { name: 'Σύνδεση' }));
  expect(await screen.findByRole('heading', { name: lab.title })).toBeVisible();
  expect(localStorage.length).toBe(0);
});
it('renders dynamic overview with unknown grades, literal student IDs and attention filter', async () => {
  render(<App />);
  expect(await screen.findByRole('columnheader', { name: 'Άσκηση Α' })).toBeVisible();
  expect(screen.getByText('00123')).toBeVisible();
  expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  const user = userEvent.setup();
  await user.click(screen.getByLabelText('Αναζήτηση ομάδας ή ΑΜ'));
  await user.paste('[00123]');
  expect(screen.queryByRole('button', { name: 'Ομάδα δοκιμής' })).toBeNull();
  await user.clear(screen.getByLabelText('Αναζήτηση ομάδας ή ΑΜ'));
  await user.click(screen.getByLabelText('Χρειάζονται προσοχή'));
  expect(screen.getByRole('button', { name: 'Ομάδα δοκιμής' })).toBeVisible();
});
it('uses the same Greek draft label in the overview and assessment editor', async () => {
  const overview = overrides[`GET /api/v1/labs/${lab.id}/overview`] as any;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`GET /api/v1/labs/${lab.id}/overview`]: {
        ...overview,
        rows: [{ ...overview.rows[0], assessments: [{ ...emptyAssessment, status: 'draft' }] }],
      },
    }),
  );
  render(<App />);
  expect(await screen.findByText('Προσχέδιο')).toBeVisible();
});
it('shows a retryable server error rather than invented overview data', async () => {
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`GET /api/v1/labs/${lab.id}/overview`]: new Response(
        JSON.stringify({ message: 'Συνθετική αστοχία', code: 'synthetic' }),
        { status: 500 },
      ),
    }),
  );
  render(<App />);
  expect(await screen.findByText('Συνθετική αστοχία')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Επανάληψη' })).toBeVisible();
});
it('creates a lab and confirms the saved resource by GET', async () => {
  let saved = false;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      'POST /api/v1/labs': () => {
        saved = true;
        return new Response(JSON.stringify({ ...lab, title: 'Νέο συνθετικό' }), { status: 201 });
      },
      'GET /api/v1/labs': () =>
        new Response(JSON.stringify(page(saved ? [{ ...lab, title: 'Νέο συνθετικό' }] : []))),
      [`GET /api/v1/labs/${lab.id}`]: { ...lab, title: 'Νέο συνθετικό' },
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Νέο εργαστήριο' }));
  await user.type(screen.getByLabelText('Τίτλος'), 'Νέο συνθετικό');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(await screen.findByRole('heading', { name: 'Νέο συνθετικό' })).toBeVisible();
  expect(fetch).toHaveBeenCalledWith(
    `/api/v1/labs/${lab.id}`,
    expect.objectContaining({ credentials: 'same-origin' }),
  );
});
it('keeps conflicting lab edits and offers server comparison without silent overwrite', async () => {
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`PATCH /api/v1/labs/${lab.id}`]: new Response(
        JSON.stringify({ code: 'revision_conflict', message: 'Σύγκρουση έκδοσης' }),
        { status: 409 },
      ),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ρυθμίσεις εργαστηρίου' }));
  await user.clear(screen.getByLabelText('Τίτλος'));
  await user.type(screen.getByLabelText('Τίτλος'), 'Μη αποθηκευμένο');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(await screen.findByText('Σύγκρουση έκδοσης')).toBeVisible();
  expect(screen.getByLabelText('Τίτλος')).toHaveValue('Μη αποθηκευμένο');
  await user.click(screen.getByRole('button', { name: 'Σύγκριση με διακομιστή' }));
  expect(await screen.findByRole('heading', { name: 'Έκδοση διακομιστή' })).toBeVisible();
  expect(screen.getByLabelText('Τίτλος')).toHaveValue('Μη αποθηκευμένο');
});
it('guards unsaved lab edits on navigation and refresh', async () => {
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ρυθμίσεις εργαστηρίου' }));
  await user.type(screen.getByLabelText('Τίτλος'), ' αλλαγή');
  await user.click(screen.getByRole('button', { name: 'Νέο εργαστήριο' }));
  expect(window.confirm).toHaveBeenCalled();
  expect(screen.getByLabelText('Τίτλος')).toHaveValue(`${lab.title} αλλαγή`);
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});
it('creates a criterion rubric using exact decimal sums and confirms the saved exercise', async () => {
  let saved: any;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`POST /api/v1/labs/${lab.id}/exercises`]: (init: RequestInit) => {
        saved = {
          ...exercise,
          ...JSON.parse(String(init.body)),
          criteria: JSON.parse(String(init.body)).criteria.map((c: any, i: number) => ({
            ...c,
            id: `synthetic-c${i}`,
          })),
        };
        return new Response(JSON.stringify(saved), { status: 201 });
      },
      [`GET /api/v1/labs/${lab.id}/exercises/${exercise.id}`]: () =>
        new Response(JSON.stringify(saved)),
      [`GET /api/v1/labs/${lab.id}/exercises`]: () =>
        new Response(JSON.stringify(page(saved ? [saved] : [exercise]))),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ασκήσεις & βαθμολόγηση' }));
  await user.click(await screen.findByRole('button', { name: 'Νέα άσκηση' }));
  await user.type(screen.getByLabelText('Τίτλος'), 'Κριτήρια δοκιμής');
  await user.clear(screen.getByLabelText('Μέγιστες μονάδες'));
  await user.type(screen.getByLabelText('Μέγιστες μονάδες'), '0.3');
  await user.selectOptions(screen.getByLabelText('Τρόπος βαθμολόγησης'), 'criteria');
  await user.click(screen.getByRole('button', { name: 'Προσθήκη κριτηρίου' }));
  await user.type(screen.getByLabelText('Κριτήριο 1 · ετικέτα'), 'Α');
  await user.clear(screen.getByLabelText('Κριτήριο 1 · μονάδες'));
  await user.type(screen.getByLabelText('Κριτήριο 1 · μονάδες'), '0.1');
  await user.click(screen.getByRole('button', { name: 'Προσθήκη κριτηρίου' }));
  await user.type(screen.getByLabelText('Κριτήριο 2 · ετικέτα'), 'Β');
  await user.clear(screen.getByLabelText('Κριτήριο 2 · μονάδες'));
  await user.type(screen.getByLabelText('Κριτήριο 2 · μονάδες'), '0.2');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await waitFor(() => expect(saved?.criteria).toHaveLength(2));
  expect(saved.max_points).toBe('0.3');
  expect(await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.')).toBeVisible();
});
it('rejects mismatched criterion totals before making a write request', async () => {
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ασκήσεις & βαθμολόγηση' }));
  await user.click(await screen.findByRole('button', { name: 'Νέα άσκηση' }));
  await user.type(screen.getByLabelText('Τίτλος'), 'Ασυμφωνία');
  await user.type(screen.getByLabelText('Μέγιστες μονάδες'), '1');
  await user.selectOptions(screen.getByLabelText('Τρόπος βαθμολόγησης'), 'criteria');
  await user.click(screen.getByRole('button', { name: 'Προσθήκη κριτηρίου' }));
  await user.type(screen.getByLabelText('Κριτήριο 1 · ετικέτα'), 'Α');
  await user.type(screen.getByLabelText('Κριτήριο 1 · μονάδες'), '0.9');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(
    await screen.findByText(
      'Το άθροισμα των κριτηρίων πρέπει να ισούται ακριβώς με τις μέγιστες μονάδες.',
    ),
  ).toBeVisible();
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('creates a partial team preserving leading-zero IDs and notes', async () => {
  let saved: any;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`POST /api/v1/labs/${lab.id}/teams`]: (init: RequestInit) => {
        saved = { ...team, ...JSON.parse(String(init.body)) };
        return new Response(JSON.stringify(saved), { status: 201 });
      },
      [`GET /api/v1/labs/${lab.id}/teams/${team.id}`]: () =>
        new Response(JSON.stringify(saved || team)),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ομάδες' }));
  await user.click(await screen.findByRole('button', { name: 'Νέα ομάδα' }));
  await user.type(screen.getByLabelText('Ετικέτα ομάδας'), 'Νέα συνθετική ομάδα');
  await user.click(screen.getByRole('button', { name: 'Προσθήκη μέλους' }));
  await user.type(screen.getByLabelText('Μέλος 1 · ΑΜ'), '00007');
  await user.type(screen.getByLabelText('Σημειώσεις ομάδας'), 'Συνθετική σημείωση');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await waitFor(() => expect(saved?.members[0].student_id).toBe('00007'));
  expect(saved.membership_complete).toBe(false);
  expect(saved.notes).toBe('Συνθετική σημείωση');
  expect(await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.')).toBeVisible();
});

async function openTeamExercise() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  await user.click(await screen.findByRole('button', { name: exercise.title }));
  await screen.findByLabelText('Βαθμός');
  return user;
}
it('saves a manual final grade with notes, explicit null archive binding and revision zero then reads history', async () => {
  let saved: any;
  const base = `/api/v1/labs/${lab.id}/teams/${team.id}/assessments/${exercise.id}`;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`PUT ${base}`]: (init: RequestInit) => {
        saved = {
          ...emptyAssessment,
          ...JSON.parse(String(init.body)),
          id: 'synthetic-assessment',
          revision: 1,
        };
        return new Response(JSON.stringify(saved));
      },
      [`GET ${base}`]: () => new Response(JSON.stringify(saved || emptyAssessment)),
      [`GET ${base}/history`]: () => new Response(JSON.stringify(page(saved ? [saved] : []))),
    }),
  );
  render(<App />);
  const user = await openTeamExercise();
  expect(screen.getByLabelText('Σύνδεση με παράδοση')).toHaveValue('');
  await user.type(screen.getByLabelText('Βαθμός'), '0.2');
  await user.type(screen.getByLabelText('Σημειώσεις άσκησης'), 'Δοκιμαστική αξιολόγηση');
  await user.selectOptions(screen.getByLabelText('Κατάσταση αξιολόγησης'), 'final');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.')).toBeVisible();
  expect(saved.score).toBe('0.2');
  expect(saved.submission_id).toBeNull();
  expect(saved.notes).toBe('Δοκιμαστική αξιολόγηση');
  const put = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(String(put?.[1]?.body)).revision).toBe(0);
  await user.click(screen.getByText('Ιστορικό αξιολογήσεων'));
  expect(await screen.findByText('Δοκιμαστική αξιολόγηση', { selector: 'p' })).toBeVisible();
});
it('rejects a final grade outside the exercise range before PUT', async () => {
  render(<App />);
  const user = await openTeamExercise();
  await user.type(screen.getByLabelText('Βαθμός'), '0.4');
  await user.selectOptions(screen.getByLabelText('Κατάσταση αξιολόγησης'), 'final');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(await screen.findByText('Ο βαθμός πρέπει να είναι από 0 έως 0.3.')).toBeVisible();
  expect(vi.mocked(fetch).mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(false);
});
it('does not call a partial criterion grade a total and preserves IDs in score payload', async () => {
  const rubric = {
    ...exercise,
    grading_mode: 'criteria',
    criteria: [
      { id: 'synthetic-c1', label: 'Ακρίβεια', max_points: '0.1', instructions: 'Κείμενο' },
      { id: 'synthetic-c2', label: 'Τεκμηρίωση', max_points: '0.2', instructions: '' },
    ],
  };
  vi.stubGlobal('fetch', mockAPI({ [`GET /api/v1/labs/${lab.id}/exercises`]: page([rubric]) }));
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  await user.click(await screen.findByRole('button', { name: exercise.title }));
  await user.type(await screen.findByLabelText('Ακρίβεια · βαθμός'), '0.1');
  expect(screen.getByText('Ελλιπή κριτήρια — δεν υπάρχει πλήρες σύνολο.')).toBeVisible();
  await user.selectOptions(screen.getByLabelText('Κατάσταση αξιολόγησης'), 'final');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(
    await screen.findByText('Η οριστική αξιολόγηση απαιτεί βαθμό σε όλα τα κριτήρια.'),
  ).toBeVisible();
});
it('retains an assessment draft during 401 and guarded exercise-tab navigation', async () => {
  const base = `/api/v1/labs/${lab.id}/teams/${team.id}/assessments/${exercise.id}`;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`PUT ${base}`]: new Response(
        JSON.stringify({ message: 'Έληξε η συνεδρία', code: 'unauthorized' }),
        { status: 401 },
      ),
    }),
  );
  render(<App />);
  const user = await openTeamExercise();
  await user.type(screen.getByLabelText('Σημειώσεις άσκησης'), 'Να μη χαθεί');
  await user.click(screen.getByRole('button', { name: 'Σύνοψη & παραδόσεις' }));
  expect(window.confirm).toHaveBeenCalled();
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('Να μη χαθεί');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(await screen.findByLabelText('Κλειδί πρόσβασης')).toBeVisible();
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('Να μη χαθεί');
});
it('lists separate ZIP versions and requires explicit inventory selection with inert member downloads', async () => {
  const s = {
    id: 'synthetic-s1',
    lab_id: lab.id,
    team_id: team.id,
    file_id: 'synthetic-f1',
    filename: 'synthetic.zip',
    sha256: 'synthetic-same-hash',
    created_at: '2026-01-01T00:00:00Z',
    archive_status: 'valid',
    archive_errors: [],
  };
  const s2 = { ...s, id: 'synthetic-s2' };
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`GET /api/v1/labs/${lab.id}/teams/${team.id}/submissions`]: page([s, s2]),
      'GET /api/v1/submissions/synthetic-s2': s2,
      'GET /api/v1/submissions/synthetic-s2/members': page([
        { path: 'synthetic/student.asm', size: 12 },
      ]),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  expect((await screen.findAllByRole('button', { name: /Προβολή αρχείων/ }))[0]).toBeVisible();
  expect(screen.getAllByRole('button', { name: /Προβολή αρχείων/ })[1]).toBeVisible();
  expect(screen.queryByText('synthetic/student.asm')).toBeNull();
  await user.click(screen.getAllByRole('button', { name: /Προβολή αρχείων/ })[1]);
  const member = (await screen.findByText('synthetic/student.asm')).closest('li')!;
  const link = within(member).getByRole('link', { name: 'Λήψη' });
  expect(link).toHaveAttribute('download');
  expect(link.getAttribute('href')).toContain('path=synthetic%2Fstudent.asm');
});
it('uploads ZIP then confirms persisted submission metadata', async () => {
  const s = {
    id: 'synthetic-upload',
    lab_id: lab.id,
    team_id: team.id,
    file_id: 'synthetic-file',
    filename: 'saved.zip',
    sha256: 'server-hash',
    created_at: '2026-01-01T00:00:00Z',
    archive_status: 'valid',
    archive_errors: [],
  };
  let uploaded = false;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`POST /api/v1/labs/${lab.id}/teams/${team.id}/submissions`]: () => {
        uploaded = true;
        return new Response(JSON.stringify(s), { status: 201 });
      },
      'GET /api/v1/submissions/synthetic-upload': s,
      [`GET /api/v1/labs/${lab.id}/teams/${team.id}/submissions`]: () =>
        new Response(JSON.stringify(page(uploaded ? [s] : []))),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  await user.upload(
    await screen.findByLabelText('Αρχεία ZIP'),
    new File(['explicitly synthetic bytes'], 'synthetic.zip', { type: 'application/zip' }),
  );
  await user.click(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' }));
  expect(await screen.findByText('saved.zip')).toBeVisible();
  expect(fetch).toHaveBeenCalledWith(
    '/api/v1/submissions/synthetic-upload',
    expect.objectContaining({ credentials: 'same-origin' }),
  );
});
it('validates unsafe evidence URLs and invalid JSON before posting', async () => {
  render(<App />);
  const user = await openTeamExercise();
  await user.click(screen.getByRole('button', { name: 'Νέο τεκμήριο' }));
  await user.type(screen.getByLabelText('Τίτλος τεκμηρίου'), 'Συνθετικό');
  await user.selectOptions(screen.getByLabelText('Είδος τεκμηρίου'), 'link');
  await user.type(screen.getByLabelText('Σύνδεσμος'), 'javascript:alert(1)');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση τεκμηρίου' }));
  expect(await screen.findByText('Επιτρέπονται μόνο σύνδεσμοι http ή https.')).toBeVisible();
  await user.selectOptions(screen.getByLabelText('Είδος τεκμηρίου'), 'result');
  await user.type(screen.getByLabelText('Αποτέλεσμα JSON'), 'not JSON');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση τεκμηρίου' }));
  expect(await screen.findByText('Το αποτέλεσμα πρέπει να είναι έγκυρο JSON.')).toBeVisible();
  expect(vi.mocked(fetch).mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
});
it('uploads a file then creates evidence and shows actual read-back metadata without marking a grade', async () => {
  const f = {
    id: 'synthetic-evidence-file',
    lab_id: lab.id,
    filename: 'server-evidence.txt',
    sha256: 'server-evidence-hash',
    size: 8,
    media_type: 'text/plain',
    created_at: '2026-01-01T00:00:00Z',
  };
  let saved: any;
  const base = `/api/v1/labs/${lab.id}/teams/${team.id}/evidence`;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`POST /api/v1/labs/${lab.id}/files`]: f,
      'GET /api/v1/files/synthetic-evidence-file': f,
      [`POST ${base}`]: (init: RequestInit) => {
        saved = {
          ...JSON.parse(String(init.body)),
          id: 'synthetic-evidence',
          revision: 1,
          created_at: '2026-01-01T00:00:00Z',
          team_id: team.id,
        };
        return new Response(JSON.stringify(saved), { status: 201 });
      },
      [`GET ${base}`]: () => new Response(JSON.stringify(page(saved ? [saved] : []))),
    }),
  );
  render(<App />);
  const user = await openTeamExercise();
  await user.click(screen.getByRole('button', { name: 'Νέο τεκμήριο' }));
  await user.type(screen.getByLabelText('Τίτλος τεκμηρίου'), 'Αρχείο δοκιμής');
  await user.selectOptions(screen.getByLabelText('Είδος τεκμηρίου'), 'file');
  await user.upload(
    screen.getByLabelText('Αρχείο τεκμηρίου'),
    new File(['synthetic'], 'local-name.txt', { type: 'text/plain' }),
  );
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση τεκμηρίου' }));
  expect(
    within(
      (await screen.findByText('server-evidence.txt')).closest('.file-metadata') as HTMLElement,
    ).getByRole('link', { name: 'Λήψη' }),
  ).toBeVisible();
  expect(saved.file_id).toBe(f.id);
  expect(saved.exercise_id).toBe(exercise.id);
  expect(saved.submission_id).toBeNull();
  expect(vi.mocked(fetch).mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(false);
});
it('uploads exercise-associated materials as inert files and confirms saved metadata', async () => {
  const f = {
    id: 'synthetic-material-file',
    lab_id: lab.id,
    filename: 'server-handout.html',
    sha256: 'synthetic-hash',
    size: 12,
    media_type: 'text/html',
    created_at: '2026-01-01T00:00:00Z',
  };
  let saved: any;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`POST /api/v1/labs/${lab.id}/files`]: f,
      'GET /api/v1/files/synthetic-material-file': f,
      [`POST /api/v1/labs/${lab.id}/materials`]: (init: RequestInit) => {
        saved = {
          ...JSON.parse(String(init.body)),
          id: 'synthetic-material',
          lab_id: lab.id,
          revision: 1,
        };
        return new Response(JSON.stringify(saved), { status: 201 });
      },
      [`GET /api/v1/labs/${lab.id}/materials`]: () =>
        new Response(JSON.stringify(page(saved ? [saved] : []))),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Υλικό' }));
  await user.click(screen.getByRole('button', { name: 'Νέο υλικό' }));
  await user.type(screen.getByLabelText('Τίτλος υλικού'), 'Συνθετική εκφώνηση');
  await user.selectOptions(screen.getByLabelText('Σχετική άσκηση'), exercise.id);
  await user.upload(
    screen.getByLabelText('Αρχείο υλικού'),
    new File(['synthetic'], 'local.html', { type: 'text/html' }),
  );
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση υλικού' }));
  expect(
    within(
      (await screen.findByText('server-handout.html')).closest('.file-metadata') as HTMLElement,
    ).getByRole('link', { name: 'Λήψη' }),
  ).toHaveAttribute('download');
  expect(saved.role).toBe('handout');
  expect(saved.exercise_id).toBe(exercise.id);
  expect(screen.queryByRole('button', { name: /Εκτέλεση/ })).toBeNull();
});

it('does not request private labs before authentication', async () => {
  const spy = mockAPI({
    'GET /api/v1/session': { authenticated: false },
    'GET /api/v1/labs': new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 }),
  });
  vi.stubGlobal('fetch', spy);
  render(<App />);
  await screen.findByLabelText('Κλειδί πρόσβασης');
  expect(spy.mock.calls.some(([path]) => String(path).startsWith('/api/v1/labs'))).toBe(false);
});
it('does not claim success or lose the draft if read-back remains the old assessment revision', async () => {
  const path = `/api/v1/labs/${lab.id}/teams/${team.id}/assessments/${exercise.id}`;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`PUT ${path}`]: {
        ...emptyAssessment,
        id: 'synthetic-assessment',
        revision: 1,
        notes: 'Νέα σημείωση',
      },
    }),
  );
  render(<App />);
  const user = await openTeamExercise();
  await user.type(screen.getByLabelText('Σημειώσεις άσκησης'), 'Νέα σημείωση');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(
    await screen.findByText(
      'Η αποθήκευση δεν επιβεβαιώθηκε από την έκδοση διακομιστή. Οι αλλαγές σας διατηρούνται.',
    ),
  ).toBeVisible();
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('Νέα σημείωση');
  expect(screen.queryByText('Αποθηκεύτηκε και επιβεβαιώθηκε.')).toBeNull();
});
it('supports deep-linked team exercise routes', async () => {
  window.location.hash = `#/labs/${lab.id}/teams/${team.id}/exercises/${exercise.id}`;
  render(<App />);
  expect(await screen.findByLabelText('Σημειώσεις άσκησης')).toBeVisible();
  expect(screen.getByLabelText('Βαθμός')).toHaveValue('');
});
it('loads additional overview pages with accurate totals and flags stale grades', async () => {
  const first = {
    lab,
    exercises: [exercise],
    rows: [
      {
        team,
        submissions_count: 0,
        assessments: [emptyAssessment],
        awarded_points: null,
        total_points: '0.3',
        grade_complete: false,
      },
    ],
    total: 2,
    limit: 1,
    offset: 0,
  };
  const second = {
    ...first,
    rows: [
      {
        ...first.rows[0],
        team: { ...team, id: 'synthetic-team-2', label: 'Δεύτερη ομάδα' },
        assessments: [{ ...emptyAssessment, score: '0.2', status: 'final', rubric_stale: true }],
      },
    ],
    offset: 1,
  };
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`GET /api/v1/labs/${lab.id}/overview`]: (_i: RequestInit, url: string) =>
        new Response(JSON.stringify(url.includes('offset=1') ? second : first)),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await screen.findByRole('columnheader', { name: exercise.title });
  expect(screen.getByText('1 από 2')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Περισσότερα' }));
  expect(await screen.findByRole('button', { name: 'Δεύτερη ομάδα' })).toBeVisible();
  expect(screen.getByText('2 από 2')).toBeVisible();
  expect(screen.getByText('Αλλαγή κριτηρίων')).toBeVisible();
});
it('edits a criterion rubric preserving criterion IDs and archive state with revision', async () => {
  const rubric = {
    ...exercise,
    grading_mode: 'criteria',
    criteria: [
      { id: 'synthetic-criterion', label: 'Α', max_points: '0.3', instructions: 'Οδηγία' },
    ],
  };
  let saved: any;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`GET /api/v1/labs/${lab.id}/exercises`]: page([rubric]),
      [`PATCH /api/v1/labs/${lab.id}/exercises/${exercise.id}`]: (init: RequestInit) => {
        saved = { ...rubric, ...JSON.parse(String(init.body)), revision: 2 };
        return new Response(JSON.stringify(saved));
      },
      [`GET /api/v1/labs/${lab.id}/exercises/${exercise.id}`]: () =>
        new Response(JSON.stringify(saved || rubric)),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ασκήσεις & βαθμολόγηση' }));
  await user.click(await screen.findByRole('button', { name: `Επεξεργασία ${exercise.title}` }));
  expect(screen.getByText(/θα απαιτήσουν επανέλεγχο/)).toBeVisible();
  await user.click(screen.getByLabelText('Αρχειοθετημένη άσκηση'));
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.')).toBeVisible();
  expect(saved.criteria[0].id).toBe('synthetic-criterion');
  expect(saved.archived).toBe(true);
});
it('logs out through DELETE and verifies that the session is unauthenticated', async () => {
  let active = true;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      'GET /api/v1/session': () => new Response(JSON.stringify({ authenticated: active })),
      'DELETE /api/v1/session': () => {
        active = false;
        return new Response(null, { status: 204 });
      },
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Αποσύνδεση' }));
  expect(await screen.findByLabelText('Κλειδί πρόσβασης')).toBeVisible();
  expect(active).toBe(false);
});
it('deletes evidence only after cascade impact confirmation and exact-target absence readback', async () => {
  let items = [
    {
      id: 'synthetic-delete-e',
      revision: 1,
      team_id: team.id,
      exercise_id: exercise.id,
      submission_id: null,
      kind: 'text',
      title: 'Προς διαγραφή',
      text: 'Συνθετικό',
      source: 'human',
      created_at: '2026-01-01',
    },
  ];
  const base = `/api/v1/labs/${lab.id}/teams/${team.id}/evidence`;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`GET ${base}`]: () => new Response(JSON.stringify(page(items))),
      [`GET ${base}/synthetic-delete-e/deletion-impact`]: {
        dependencies: [],
        unreferenced_files: [],
        unreferenced_files_total: 0,
        cascade_counts: [{ kind: 'evidence', count: 1 }],
        confirmation_token: 'a'.repeat(64),
      },
      [`GET ${base}/synthetic-delete-e`]: () =>
        items.length ? new Response(JSON.stringify(items[0])) : new Response(null, { status: 404 }),
      [`DELETE ${base}/synthetic-delete-e`]: () => {
        items = [];
        return new Response(null, { status: 204 });
      },
    }),
  );
  render(<App />);
  const user = await openTeamExercise();
  await user.click(await screen.findByRole('button', { name: 'Διαγραφή τεκμηρίου Προς διαγραφή' }));
  await confirmRemoval();
  expect(await screen.findByText('Το τεκμήριο διαγράφηκε και επιβεβαιώθηκε.')).toBeVisible();
  expect(items).toHaveLength(0);
});
it('keeps the draft if a concurrent writer changes the resource between write and read-back', async () => {
  const path = `/api/v1/labs/${lab.id}/teams/${team.id}/assessments/${exercise.id}`;
  let wrote = false;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`PUT ${path}`]: () => {
        wrote = true;
        return new Response(
          JSON.stringify({
            ...emptyAssessment,
            id: 'synthetic-assessment',
            revision: 1,
            notes: 'Η δική μου σημείωση',
          }),
        );
      },
      [`GET ${path}`]: () =>
        new Response(
          JSON.stringify(
            wrote
              ? {
                  ...emptyAssessment,
                  id: 'synthetic-assessment',
                  revision: 2,
                  notes: 'Σημείωση άλλου χειριστή',
                }
              : emptyAssessment,
          ),
        ),
    }),
  );
  render(<App />);
  const user = await openTeamExercise();
  await user.type(screen.getByLabelText('Σημειώσεις άσκησης'), 'Η δική μου σημείωση');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(
    await screen.findByText(
      'Η αποθήκευση δεν επιβεβαιώθηκε από την έκδοση διακομιστή. Οι αλλαγές σας διατηρούνται.',
    ),
  ).toBeVisible();
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('Η δική μου σημείωση');
  expect(screen.queryByText('Αποθηκεύτηκε και επιβεβαιώθηκε.')).toBeNull();
});
it('does not label an unsaved manual score as the persisted grade', async () => {
  render(<App />);
  const user = await openTeamExercise();
  await user.type(screen.getByLabelText('Βαθμός'), '0.2');
  expect(screen.getByText(/Αποθηκευμένος βαθμός: —/)).toBeVisible();
  expect(screen.queryByText(/Αποθηκευμένος βαθμός: 0.2/)).toBeNull();
});
it('rejects nonfinite parsed result JSON rather than silently changing it to null', async () => {
  render(<App />);
  const user = await openTeamExercise();
  await user.click(screen.getByRole('button', { name: 'Νέο τεκμήριο' }));
  await user.type(screen.getByLabelText('Τίτλος τεκμηρίου'), 'Συνθετικός μεγάλος αριθμός');
  await user.selectOptions(screen.getByLabelText('Είδος τεκμηρίου'), 'result');
  await user.click(screen.getByLabelText('Αποτέλεσμα JSON'));
  await user.paste('{"synthetic":1e10000}');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση τεκμηρίου' }));
  expect(
    await screen.findByText('Το αποτέλεσμα πρέπει να είναι έγκυρο JSON με πεπερασμένους αριθμούς.'),
  ).toBeVisible();
  expect(vi.mocked(fetch).mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
});
it('renders archive directories and blocked members without unsafe download links', async () => {
  const s = {
    id: 'synthetic-unsafe-inventory',
    file_id: 'synthetic-f',
    lab_id: lab.id,
    team_id: team.id,
    filename: 'synthetic.zip',
    sha256: 'synthetic',
    created_at: '2026-01-01',
    archive_status: 'blocked',
    archive_errors: ['Συνθετικό πρόβλημα αρχείου'],
  };
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`GET /api/v1/labs/${lab.id}/teams/${team.id}/submissions`]: page([s]),
      [`GET /api/v1/submissions/${s.id}`]: s,
      [`GET /api/v1/submissions/${s.id}/members`]: page([
        { path: 'synthetic-folder/', size: 0, is_directory: true, status: 'valid', errors: [] },
        {
          path: 'synthetic-bad.asm',
          size: 12,
          is_directory: false,
          status: 'blocked',
          errors: ['Συνθετικό πρόβλημα μέλους'],
        },
      ]),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  await user.click(await screen.findByRole('button', { name: /Προβολή αρχείων/ }));
  expect(await screen.findByText('synthetic-folder/')).toBeVisible();
  expect(screen.queryByRole('link', { name: 'synthetic-folder/' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'synthetic-bad.asm' })).toBeNull();
  expect(screen.getByText('Συνθετικό πρόβλημα μέλους')).toBeVisible();
});
it('shows submission loading without a fabricated empty state', async () => {
  let finish: (r: Response) => void = () => {};
  const deferred = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal(
    'fetch',
    mockAPI({ [`GET /api/v1/labs/${lab.id}/teams/${team.id}/submissions`]: () => deferred }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  await screen.findByLabelText('Αρχεία ZIP');
  expect(screen.queryByText('Δεν υπάρχουν παραδόσεις για αυτή την ομάδα.')).toBeNull();
  await act(async () => {
    finish(new Response(JSON.stringify(page([]))));
    await deferred;
  });
  expect(await screen.findByText('Δεν υπάρχουν παραδόσεις για αυτή την ομάδα.')).toBeVisible();
});
it('saves complete criterion scores with explicit selected submission and uses the server-computed grade', async () => {
  const rubric = {
    ...exercise,
    grading_mode: 'criteria',
    criteria: [
      { id: 'synthetic-c1', label: 'Α', max_points: '0.1', instructions: '' },
      { id: 'synthetic-c2', label: 'Β', max_points: '0.2', instructions: '' },
    ],
  };
  const submission = {
    id: 'synthetic-bound',
    filename: 'synthetic-bound.zip',
    file_id: 'synthetic-f',
    lab_id: lab.id,
    team_id: team.id,
    sha256: 'synthetic',
    created_at: '2026-01-01',
    archive_status: 'valid',
    archive_errors: [],
  };
  const path = `/api/v1/labs/${lab.id}/teams/${team.id}/assessments/${exercise.id}`;
  let sent: any;
  let saved: any;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`GET /api/v1/labs/${lab.id}/exercises`]: page([rubric]),
      [`GET /api/v1/labs/${lab.id}/teams/${team.id}/submissions`]: page([submission]),
      [`PUT ${path}`]: (init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        saved = { ...emptyAssessment, ...sent, id: 'synthetic-score', revision: 1, score: '0.3' };
        return new Response(JSON.stringify(saved));
      },
      [`GET ${path}`]: () => new Response(JSON.stringify(saved || emptyAssessment)),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  await user.click(await screen.findByRole('button', { name: exercise.title }));
  await user.type(await screen.findByLabelText('Α · βαθμός'), '0.1');
  await user.type(screen.getByLabelText('Β · βαθμός'), '0.2');
  await user.selectOptions(screen.getByLabelText('Σύνδεση με παράδοση'), submission.id);
  await user.selectOptions(screen.getByLabelText('Κατάσταση αξιολόγησης'), 'final');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.')).toBeVisible();
  expect(sent.criterion_scores).toEqual({ 'synthetic-c1': '0.1', 'synthetic-c2': '0.2' });
  expect(sent.score).toBeNull();
  expect(sent.submission_id).toBe(submission.id);
  expect(screen.getByText(/Αποθηκευμένος βαθμός: 0.3/)).toBeVisible();
});
it('keeps edits in an assessment conflict and displays the prior rubric for review', async () => {
  const path = `/api/v1/labs/${lab.id}/teams/${team.id}/assessments/${exercise.id}`;
  const stale = {
    ...emptyAssessment,
    id: 'synthetic-old-assessment',
    revision: 3,
    rubric_stale: true,
    rubric_revision: 1,
    score: '0.1',
    rubric_snapshot: { max_points: '0.2' },
  };
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`GET ${path}`]: stale,
      [`PUT ${path}`]: new Response(
        JSON.stringify({ message: 'Συνθετική σύγκρουση αξιολόγησης', code: 'revision_conflict' }),
        { status: 409 },
      ),
    }),
  );
  render(<App />);
  const user = await openTeamExercise();
  expect(screen.getByText('Η κλίμακα άλλαξε — απαιτείται επανέλεγχος.')).toBeVisible();
  await user.type(screen.getByLabelText('Σημειώσεις άσκησης'), 'Διατήρηση σημειώσεων σύγκρουσης');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(await screen.findByText('Συνθετική σύγκρουση αξιολόγησης')).toBeVisible();
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue(
    'Διατήρηση σημειώσεων σύγκρουσης',
  );
  await user.click(screen.getByRole('button', { name: 'Σύγκριση με διακομιστή' }));
  expect(await screen.findByRole('heading', { name: 'Έκδοση διακομιστή' })).toBeVisible();
});

it('supports unsaved-change tracking on plain HTTP where crypto.randomUUID is unavailable', async () => {
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    throw new Error('Unavailable on insecure HTTP');
  });
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ρυθμίσεις εργαστηρίου' }));
  await user.type(screen.getByLabelText('Τίτλος'), ' HTTP');
  expect(screen.getByText('Μη αποθηκευμένες αλλαγές')).toBeVisible();
});
it('does not create duplicate labs when POST succeeded but confirmation GET failed', async () => {
  let created = false;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      'GET /api/v1/labs': page([]),
      'POST /api/v1/labs': () => {
        created = true;
        return new Response(JSON.stringify(lab), { status: 201 });
      },
      [`GET /api/v1/labs/${lab.id}`]: new Response(
        JSON.stringify({ message: 'Συνθετική αποτυχία επιβεβαίωσης' }),
        { status: 500 },
      ),
      [`PATCH /api/v1/labs/${lab.id}`]: new Response(
        JSON.stringify({
          message: 'Συνθετική σύγκρουση μετά τη δημιουργία',
          code: 'revision_conflict',
        }),
        { status: 409 },
      ),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Νέο εργαστήριο' }));
  await user.type(screen.getByLabelText('Τίτλος'), 'Δημιουργία δοκιμής');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(await screen.findByText('Συνθετική αποτυχία επιβεβαίωσης')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(await screen.findByText('Συνθετική σύγκρουση μετά τη δημιουργία')).toBeVisible();
  expect(created).toBe(true);
  expect(
    vi.mocked(fetch).mock.calls.filter(([p, i]) => p === '/api/v1/labs' && i?.method === 'POST'),
  ).toHaveLength(1);
});

it('preserves selected ZIPs and failure feedback after server rejection and list refresh', async () => {
  const base = `/api/v1/labs/${lab.id}/teams/${team.id}/submissions`;
  let loads = 0;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`POST ${base}`]: new Response(
        JSON.stringify({ code: 'size_limit', message: 'Συνθετικό όριο μεγέθους' }),
        { status: 413 },
      ),
      [`GET ${base}`]: () => {
        loads++;
        return loads > 1
          ? new Promise<Response>((resolve) =>
              setTimeout(() => resolve(new Response(JSON.stringify(page([])))), 80),
            )
          : new Response(JSON.stringify(page([])));
      },
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  await user.upload(
    await screen.findByLabelText('Αρχεία ZIP'),
    new File(['synthetic'], 'retry-synthetic.zip', { type: 'application/zip' }),
  );
  await user.click(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' })).toBeEnabled(),
  );
  expect(screen.getByText('retry-synthetic.zip')).toBeVisible();
  expect(screen.getByText('Συνθετικό όριο μεγέθους')).toBeVisible();
});
it('keeps confirmed ZIP upload success visible after refreshing versions', async () => {
  const s = {
    id: 'synthetic-confirmed-upload',
    lab_id: lab.id,
    team_id: team.id,
    file_id: 'synthetic-file',
    filename: 'saved-synthetic.zip',
    sha256: 'synthetic-server-hash',
    created_at: '2026-01-01',
    archive_status: 'valid',
    archive_errors: [],
  };
  let uploaded = false;
  const path = `/api/v1/labs/${lab.id}/teams/${team.id}/submissions`;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`POST ${path}`]: () => {
        uploaded = true;
        return new Response(JSON.stringify(s), { status: 201 });
      },
      [`GET ${path}`]: () =>
        uploaded
          ? new Promise<Response>((resolve) =>
              setTimeout(() => resolve(new Response(JSON.stringify(page([s])))), 80),
            )
          : new Response(JSON.stringify(page([]))),
      [`GET /api/v1/submissions/${s.id}`]: s,
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  await user.upload(
    await screen.findByLabelText('Αρχεία ZIP'),
    new File(['synthetic'], 'synthetic.zip', { type: 'application/zip' }),
  );
  await user.click(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' }));
  expect(await screen.findByText('saved-synthetic.zip')).toBeVisible();
  expect(screen.getByText('1 παραδόσεις αποθηκεύτηκαν και επιβεβαιώθηκαν.')).toBeVisible();
});
it('does not let a slow response clobber the selected lab', async () => {
  let finish: (r: Response) => void = () => {};
  const slow = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const other = { ...lab, id: 'synthetic-other', title: 'Δεύτερο συνθετικό εργαστήριο' };
  vi.stubGlobal(
    'fetch',
    mockAPI({
      'GET /api/v1/labs': page([lab, other]),
      [`GET /api/v1/labs/${lab.id}`]: () => slow,
      [`GET /api/v1/labs/${other.id}`]: other,
      [`GET /api/v1/labs/${other.id}/overview`]: {
        lab: other,
        exercises: [],
        rows: [],
        total: 0,
        limit: 100,
        offset: 0,
        stats: {},
      },
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: other.title }));
  expect(await screen.findByRole('heading', { name: other.title })).toBeVisible();
  await act(async () => {
    finish(new Response(JSON.stringify(lab)));
    await slow;
  });
  expect(screen.getByRole('heading', { name: other.title })).toBeVisible();
  expect(screen.queryByRole('heading', { name: lab.title })).toBeNull();
});
it('guards external hash navigation while an assessment has unsaved notes', async () => {
  render(<App />);
  const user = await openTeamExercise();
  await user.type(screen.getByLabelText('Σημειώσεις άσκησης'), 'Απροστάτευτες σημειώσεις');
  const oldHash = window.location.hash;
  await act(async () => {
    window.location.hash = `#/labs/${lab.id}/materials`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(window.confirm).toHaveBeenCalled();
  expect(window.location.hash).toBe(oldHash);
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('Απροστάτευτες σημειώσεις');
});
it('reuploads the same ZIP as distinct confirmed versions without remounting the input', async () => {
  const path = `/api/v1/labs/${lab.id}/teams/${team.id}/submissions`;
  const versions: any[] = [];
  const confirmed: string[] = [];
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`POST ${path}`]: (init: RequestInit) => {
        const file = (init.body as FormData).get('file') as File;
        const saved = {
          id: `synthetic-repeat-${versions.length + 1}`,
          lab_id: lab.id,
          team_id: team.id,
          file_id: 'synthetic-file',
          filename: file.name,
          sha256: 'synthetic-identical-hash',
          created_at: '2026-01-01',
          archive_status: 'valid',
          archive_errors: [],
        };
        versions.push(saved);
        return new Response(JSON.stringify(saved), { status: 201 });
      },
      [`GET ${path}`]: () => new Response(JSON.stringify(page(versions))),
      ...Object.fromEntries(
        [1, 2].map((n) => [
          `GET /api/v1/submissions/synthetic-repeat-${n}`,
          () => {
            confirmed.push(`synthetic-repeat-${n}`);
            return new Response(JSON.stringify(versions[n - 1]));
          },
        ]),
      ),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  const input = (await screen.findByLabelText('Αρχεία ZIP')) as HTMLInputElement;
  const file = new File(['explicitly synthetic identical bytes'], 'same-synthetic.zip', {
    type: 'application/zip',
  });
  await user.upload(input, file);
  await user.click(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' }));
  await screen.findByText('1 παραδόσεις αποθηκεύτηκαν και επιβεβαιώθηκαν.');
  expect(screen.getByLabelText('Αρχεία ZIP')).toBe(input);
  expect(input.value).toBe('');
  expect(input.files).toHaveLength(0);
  await user.upload(input, file);
  expect(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' }));
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: /Προβολή αρχείων/ })).toHaveLength(2),
  );
  expect(versions.map((v) => v.id)).toEqual(['synthetic-repeat-1', 'synthetic-repeat-2']);
  expect(confirmed).toEqual(['synthetic-repeat-1', 'synthetic-repeat-2']);
  expect(
    vi.mocked(fetch).mock.calls.filter(([p, i]) => p === path && i?.method === 'POST'),
  ).toHaveLength(2);
});
it('retries only unconfirmed ZIPs after a partial batch failure and keeps the dirty guard', async () => {
  const path = `/api/v1/labs/${lab.id}/teams/${team.id}/submissions`;
  const posted: string[] = [];
  let reject = true;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`POST ${path}`]: (init: RequestInit) => {
        const name = ((init.body as FormData).get('file') as File).name;
        posted.push(name);
        if (name === 'second.zip' && reject)
          return new Response(JSON.stringify({ message: 'Synthetic batch failure' }), {
            status: 500,
          });
        return new Response(JSON.stringify({ id: name }));
      },
      'GET /api/v1/submissions/first.zip': { id: 'first.zip' },
      'GET /api/v1/submissions/second.zip': { id: 'second.zip' },
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  const input = (await screen.findByLabelText('Αρχεία ZIP')) as HTMLInputElement;
  await user.upload(
    input,
    ['first.zip', 'second.zip'].map(
      (name) => new File(['synthetic'], name, { type: 'application/zip' }),
    ),
  );
  await user.click(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' }));
  await screen.findByText('Synthetic batch failure');
  expect(input.value).not.toBe('');
  await user.click(screen.getByRole('button', { name: 'Υλικό' }));
  expect(window.confirm).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' })).toBeEnabled();
  reject = false;
  await user.click(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' }));
  await screen.findByText('1 παραδόσεις αποθηκεύτηκαν και επιβεβαιώθηκαν.');
  expect(posted).toEqual(['first.zip', 'second.zip', 'second.zip']);
  expect(input.value).toBe('');
});
it('resets scroll after accepted team and exercise route navigation', async () => {
  render(<App />);
  const user = userEvent.setup();
  const teamButton = await screen.findByRole('button', { name: team.label });
  vi.mocked(window.scrollTo).mockClear();
  await user.click(teamButton);
  await screen.findByLabelText('Αρχεία ZIP');
  expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  vi.mocked(window.scrollTo).mockClear();
  await user.click(await screen.findByRole('button', { name: exercise.title }));
  await screen.findByLabelText('Σημειώσεις άσκησης');
  expect(window.scrollTo).toHaveBeenCalledTimes(1);
});
it('resets scroll after accepted external hash navigation but not a repeated route event', async () => {
  render(<App />);
  await screen.findByRole('button', { name: team.label });
  vi.mocked(window.scrollTo).mockClear();
  await act(async () => {
    window.history.pushState(null, '', `#/labs/${lab.id}/materials`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await screen.findByRole('button', { name: 'Νέο υλικό' });
  expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  vi.mocked(window.scrollTo).mockClear();
  await act(async () => window.dispatchEvent(new HashChangeEvent('hashchange')));
  expect(window.scrollTo).not.toHaveBeenCalled();
});
it('preserves scroll and draft on rejected navigation and confirmed same-route saves', async () => {
  const path = `/api/v1/labs/${lab.id}/teams/${team.id}/assessments/${exercise.id}`;
  let saved: any;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`PUT ${path}`]: (init: RequestInit) => {
        saved = {
          ...emptyAssessment,
          ...JSON.parse(String(init.body)),
          id: 'synthetic-scroll-grade',
          revision: 1,
        };
        return new Response(JSON.stringify(saved));
      },
      [`GET ${path}`]: () => new Response(JSON.stringify(saved || emptyAssessment)),
    }),
  );
  render(<App />);
  const user = await openTeamExercise();
  await user.type(screen.getByLabelText('Σημειώσεις άσκησης'), 'Keep draft and scroll');
  vi.mocked(window.scrollTo).mockClear();
  await user.click(screen.getByRole('button', { name: 'Σύνοψη & παραδόσεις' }));
  await act(async () => {
    window.history.pushState(null, '', `#/labs/${lab.id}/materials`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('Keep draft and scroll');
  expect(window.scrollTo).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  expect(window.scrollTo).not.toHaveBeenCalled();
});
it('preserves ZIP selection and the dirty guard when confirmation GET fails', async () => {
  const path = `/api/v1/labs/${lab.id}/teams/${team.id}/submissions`;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`POST ${path}`]: { id: 'synthetic-unconfirmed-zip' },
      'GET /api/v1/submissions/synthetic-unconfirmed-zip': new Response(
        JSON.stringify({ message: 'Synthetic confirmation failure' }),
        { status: 500 },
      ),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  const input = (await screen.findByLabelText('Αρχεία ZIP')) as HTMLInputElement;
  const file = new File(['synthetic'], 'unconfirmed.zip', { type: 'application/zip' });
  await user.upload(input, file);
  await user.click(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' }));
  await screen.findByText('Synthetic confirmation failure');
  expect(input.files?.[0]).toBe(file);
  expect(input.value).not.toBe('');
  expect(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Υλικό' }));
  expect(window.confirm).toHaveBeenCalled();
  expect(screen.getByLabelText('Αρχεία ZIP')).toBe(input);
});
it('confirms partial criterion drafts with a null aggregate without losing the missing criterion', async () => {
  const rubric = {
    ...exercise,
    grading_mode: 'criteria',
    criteria: [
      { id: 'synthetic-partial-c1', label: 'Α', max_points: '0.1', instructions: '' },
      { id: 'synthetic-partial-c2', label: 'Β', max_points: '0.2', instructions: '' },
    ],
  };
  const path = `/api/v1/labs/${lab.id}/teams/${team.id}/assessments/${exercise.id}`;
  let sent: any;
  let saved: any;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`GET /api/v1/labs/${lab.id}/exercises`]: page([rubric]),
      [`PUT ${path}`]: (init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        saved = {
          ...emptyAssessment,
          ...sent,
          id: 'synthetic-partial-grade',
          revision: 1,
          score: null,
        };
        return new Response(JSON.stringify(saved));
      },
      [`GET ${path}`]: () => new Response(JSON.stringify(saved || emptyAssessment)),
    }),
  );
  render(<App />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: team.label }));
  await user.click(await screen.findByRole('button', { name: exercise.title }));
  await user.type(await screen.findByLabelText('Α · βαθμός'), '0.1');
  await user.selectOptions(screen.getByLabelText('Κατάσταση αξιολόγησης'), 'draft');
  vi.mocked(window.scrollTo).mockClear();
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  expect(sent).toMatchObject({
    status: 'draft',
    score: null,
    criterion_scores: { 'synthetic-partial-c1': '0.1' },
  });
  expect(Object.keys(sent.criterion_scores)).toEqual(['synthetic-partial-c1']);
  expect(screen.getByLabelText('Α · βαθμός')).toHaveValue('0.1');
  expect(screen.getByLabelText('Β · βαθμός')).toHaveValue('');
  expect(screen.getByText(/Αποθηκευμένος βαθμός: —/)).toBeVisible();
  expect(screen.getByText('Ελλιπή κριτήρια — δεν υπάρχει πλήρες σύνολο.')).toBeVisible();
  expect(window.scrollTo).not.toHaveBeenCalled();
});
it('reuses uploaded evidence file when association fails and preserves the draft', async () => {
  const f = {
    id: 'synthetic-retry-file',
    lab_id: lab.id,
    filename: 'synthetic-retry.txt',
    sha256: 'synthetic-hash',
    size: 1,
    media_type: 'text/plain',
    created_at: '2026-01-01',
  };
  const files = `/api/v1/labs/${lab.id}/files`;
  const evidence = `/api/v1/labs/${lab.id}/teams/${team.id}/evidence`;
  vi.stubGlobal(
    'fetch',
    mockAPI({
      [`POST ${files}`]: f,
      [`GET /api/v1/files/${f.id}`]: f,
      [`POST ${evidence}`]: new Response(
        JSON.stringify({ code: 'validation_error', message: 'Συνθετική απόρριψη σύνδεσης' }),
        { status: 422 },
      ),
    }),
  );
  render(<App />);
  const user = await openTeamExercise();
  await user.click(screen.getByRole('button', { name: 'Νέο τεκμήριο' }));
  await user.type(screen.getByLabelText('Τίτλος τεκμηρίου'), 'Διατηρημένο τεκμήριο');
  await user.selectOptions(screen.getByLabelText('Είδος τεκμηρίου'), 'file');
  await user.upload(
    screen.getByLabelText('Αρχείο τεκμηρίου'),
    new File(['synthetic'], 'synthetic.txt', { type: 'text/plain' }),
  );
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση τεκμηρίου' }));
  expect(await screen.findByText('Συνθετική απόρριψη σύνδεσης')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση τεκμηρίου' }));
  await waitFor(() =>
    expect(
      vi.mocked(fetch).mock.calls.filter(([p, i]) => p === evidence && i?.method === 'POST'),
    ).toHaveLength(2),
  );
  expect(
    vi.mocked(fetch).mock.calls.filter(([p, i]) => p === files && i?.method === 'POST'),
  ).toHaveLength(1);
  expect(screen.getByLabelText('Τίτλος τεκμηρίου')).toHaveValue('Διατηρημένο τεκμήριο');
});
