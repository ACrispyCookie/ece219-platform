// Only synthetic records; no uploaded content or provider execution.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import AssessmentView from '../Assessment';
import Exercises from '../Exercises';
import Materials from '../Materials';
import EvidenceList from '../Evidence';
import type { Assessment, Evidence, Exercise, Material, StoredFile } from '../types';
const x: Exercise = {
  id: 'synthetic-ex',
  lab_id: 'synthetic-lab',
  title: 'Άσκηση',
  description: '',
  position: 0,
  max_points: '10',
  grading_mode: 'manual',
  grading_instructions: 'Αρχικές οδηγίες',
  criteria: [],
  rubric_revision: 2,
  revision: 2,
  archived: false,
};
const a: Assessment = {
  id: null,
  team_id: 'synthetic-team',
  exercise_id: x.id,
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
const exPath = `/api/v1/labs/${x.lab_id}/exercises/${x.id}`;
const assessmentPath = `/api/v1/labs/${x.lab_id}/teams/${a.team_id}/assessments/${x.id}`;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const page = (items: unknown[]) => ({ items, total: items.length, limit: 100, offset: 0 });
function mock(handlers: Record<string, unknown>) {
  const defaults = {
    [`GET ${assessmentPath}`]: a,
    [`GET ${assessmentPath}/history`]: page([]),
    [`GET /api/v1/labs/${x.lab_id}/teams/${a.team_id}/evidence`]: page([]),
    [`GET /api/v1/labs/${x.lab_id}/exercises`]: page([x]),
    ...handlers,
  };
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method || 'GET'} ${String(url).split('?')[0]}`;
    const value = defaults[key as keyof typeof defaults];
    if (typeof value === 'function') return value(init);
    if (value instanceof Response) return value.clone();
    return value === undefined
      ? response({ code: 'missing_mock', message: key }, 404)
      : response(value);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
function assessment(exercise = x) {
  render(
    <AssessmentView labId={x.lab_id} teamId={a.team_id} exercise={exercise} submissions={[]} />,
  );
}
beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
const file: StoredFile = {
  id: 'synthetic-file',
  lab_id: x.lab_id,
  filename: 'synthetic.txt',
  sha256: 'synthetic-hash',
  size: 9,
  media_type: 'text/plain',
  created_at: '2026-01-01',
};
const material: Material = {
  id: 'synthetic-material',
  lab_id: x.lab_id,
  revision: 1,
  exercise_id: x.id,
  file_id: file.id,
  role: 'handout',
  title: 'Υλικό',
  description: 'Αρχική περιγραφή',
};
const evidence: Evidence = {
  id: 'synthetic-evidence',
  revision: 1,
  team_id: a.team_id,
  exercise_id: x.id,
  submission_id: null,
  kind: 'text',
  title: 'Τεκμήριο',
  text: 'Αρχικό κείμενο',
  source: 'agent',
  created_at: '2026-01-01',
};
const materialBase = `/api/v1/labs/${x.lab_id}/materials`;
const evidenceBase = `/api/v1/labs/${x.lab_id}/teams/${a.team_id}/evidence`;
function correctionMock(kind: 'material' | 'evidence', overrides: Record<string, unknown> = {}) {
  const record = kind === 'material' ? material : evidence;
  const base = kind === 'material' ? materialBase : evidenceBase;
  return mock({
    [`GET ${base}`]: page([record]),
    [`GET ${base}/${record.id}`]: record,
    [`GET /api/v1/files/${file.id}`]: file,
    ...overrides,
  });
}
async function openCorrection(kind: 'material' | 'evidence') {
  if (kind === 'material') render(<Materials labId={x.lab_id} />);
  else
    render(<EvidenceList labId={x.lab_id} teamId={a.team_id} exerciseId={x.id} submissions={[]} />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', {
      name: kind === 'material' ? 'Επεξεργασία υλικού' : 'Επεξεργασία τεκμηρίου',
    }),
  );
  await screen.findByLabelText(kind === 'material' ? 'Τίτλος υλικού' : 'Τίτλος τεκμηρίου');
  return user;
}
it('corrects material role, title, description and association with stable ID/current revision, retaining the immutable file', async () => {
  let saved = material;
  let sent: any;
  const spy = correctionMock('material', {
    [`GET ${materialBase}/${material.id}`]: () => response(saved),
    [`PATCH ${materialBase}/${material.id}`]: (init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      saved = { ...material, ...sent, revision: 2 };
      return response(saved);
    },
  });
  const user = await openCorrection('material');
  await user.clear(screen.getByLabelText('Τίτλος υλικού'));
  await user.type(screen.getByLabelText('Τίτλος υλικού'), 'Διορθωμένο υλικό');
  await user.clear(screen.getByLabelText('Περιγραφή υλικού'));
  await user.type(screen.getByLabelText('Περιγραφή υλικού'), 'Διόρθωση');
  await user.selectOptions(screen.getByLabelText('Ρόλος υλικού'), 'guidelines');
  await user.selectOptions(screen.getByLabelText('Σχετική άσκηση'), '');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  expect(sent).toEqual({
    revision: 1,
    title: 'Διορθωμένο υλικό',
    description: 'Διόρθωση',
    role: 'guidelines',
    exercise_id: null,
  });
  expect(saved.file_id).toBe(file.id);
  expect(saved.id).toBe(material.id);
  expect(
    spy.mock.calls.filter(([, init]) => ['DELETE', 'POST'].includes(init?.method || '')),
  ).toHaveLength(0);
  expect(spy.mock.calls.filter(([url]) => url === `${materialBase}/${material.id}`)).toHaveLength(
    3,
  );
});
it('corrects evidence text/title/submission without changing ID, exercise or source', async () => {
  const initial = { ...evidence, submission_id: 'synthetic-original-submission' };
  let saved = initial;
  let sent: any;
  correctionMock('evidence', {
    [`GET ${evidenceBase}/${evidence.id}`]: () => response(saved),
    [`PATCH ${evidenceBase}/${evidence.id}`]: (init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      saved = { ...initial, ...sent, revision: 2 };
      return response(saved);
    },
  });
  const user = await openCorrection('evidence');
  expect(screen.getByLabelText('Παράδοση τεκμηρίου')).toHaveValue(initial.submission_id);
  await user.clear(screen.getByLabelText('Τίτλος τεκμηρίου'));
  await user.type(screen.getByLabelText('Τίτλος τεκμηρίου'), 'Διόρθωση τεκμηρίου');
  await user.clear(screen.getByLabelText('Κείμενο τεκμηρίου'));
  await user.type(screen.getByLabelText('Κείμενο τεκμηρίου'), 'Διορθωμένο κείμενο');
  await user.selectOptions(screen.getByLabelText('Παράδοση τεκμηρίου'), '');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  expect(sent).toEqual({
    revision: 1,
    exercise_id: x.id,
    submission_id: null,
    kind: 'text',
    title: 'Διόρθωση τεκμηρίου',
    text: 'Διορθωμένο κείμενο',
  });
  expect(saved.id).toBe(evidence.id);
  expect(saved.source).toBe('agent');
});
for (const kind of ['material', 'evidence'] as const) {
  const base = kind === 'material' ? materialBase : evidenceBase;
  const record = kind === 'material' ? material : evidence;
  const title = kind === 'material' ? 'Τίτλος υλικού' : 'Τίτλος τεκμηρίου';
  for (const status of [409, 422])
    it(`preserves ${kind} correction on HTTP ${status} and never recreates records`, async () => {
      const spy = correctionMock(kind, {
        [`PATCH ${base}/${record.id}`]: response(
          {
            code: status === 409 ? 'revision_conflict' : 'validation_error',
            message: 'Συνθετική απόρριψη',
          },
          status,
        ),
      });
      const user = await openCorrection(kind);
      await user.type(screen.getByLabelText(title), ' Μη αποθηκευμένο');
      await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
      await screen.findByText('Συνθετική απόρριψη');
      expect(screen.getByLabelText(title)).toHaveValue(`${record.title} Μη αποθηκευμένο`);
      if (status === 409) {
        await user.click(screen.getByRole('button', { name: 'Σύγκριση με διακομιστή' }));
        await screen.findByRole('heading', { name: 'Έκδοση διακομιστή' });
        expect(screen.getByLabelText(title)).toHaveValue(`${record.title} Μη αποθηκευμένο`);
      }
      expect(
        spy.mock.calls.some(([, init]) => ['POST', 'DELETE'].includes(init?.method || '')),
      ).toBe(false);
    });
  for (const changed of ['id', 'revision', 'title'])
    it(`rejects ${kind} readback with mismatched ${changed} and retains unsaved correction`, async () => {
      let saved: any;
      correctionMock(kind, {
        [`GET ${base}/${record.id}`]: () =>
          response(
            saved
              ? { ...saved, [changed]: changed === 'revision' ? 3 : 'synthetic-mismatch' }
              : record,
          ),
        [`PATCH ${base}/${record.id}`]: (init: RequestInit) => {
          saved = { ...record, ...JSON.parse(String(init.body)), revision: 2 };
          return response(saved);
        },
      });
      const user = await openCorrection(kind);
      await user.type(screen.getByLabelText(title), ' Διόρθωση');
      await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
      await screen.findByText(
        'Η αποθήκευση δεν επιβεβαιώθηκε από την έκδοση διακομιστή. Οι αλλαγές σας διατηρούνται.',
      );
      expect(screen.getByLabelText(title)).toHaveValue(`${record.title} Διόρθωση`);
      expect(screen.queryByText('Αποθηκεύτηκε και επιβεβαιώθηκε.')).toBeNull();
    });
  it(`optionally replaces the ${kind} file using a new file record and retained metadata ID`, async () => {
    const initial =
      kind === 'material' ? material : { ...evidence, kind: 'file', file_id: file.id };
    const replacement = { ...file, id: 'synthetic-replacement', filename: 'replacement.txt' };
    let saved: any;
    let sent: any;
    correctionMock(kind, {
      [`GET ${base}/${record.id}`]: () => response(saved || initial),
      [`POST /api/v1/labs/${x.lab_id}/files`]: replacement,
      [`GET /api/v1/files/${replacement.id}`]: replacement,
      [`PATCH ${base}/${record.id}`]: (init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        saved = { ...initial, ...sent, revision: 2 };
        return response(saved);
      },
    });
    const user = await openCorrection(kind);
    await user.upload(
      screen.getByLabelText(
        kind === 'material'
          ? 'Αντικατάσταση αρχείου υλικού (προαιρετική)'
          : 'Αντικατάσταση αρχείου τεκμηρίου (προαιρετική)',
      ),
      new File(['synthetic'], 'local.txt', { type: 'text/plain' }),
    );
    await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
    await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
    expect(sent.file_id).toBe(replacement.id);
    expect(saved.id).toBe(record.id);
    expect(file.filename).toBe('synthetic.txt');
  });
}
for (const kind of ['link', 'result', 'file'] as const)
  it(`edits existing ${kind} evidence with safe kind-specific content and retains file if not replaced`, async () => {
    const initial = {
      ...evidence,
      kind,
      url: 'https://example.invalid/original',
      data: { synthetic: 'old' },
      file_id: file.id,
    };
    let saved = initial;
    let sent: any;
    const spy = correctionMock('evidence', {
      [`GET ${evidenceBase}/${evidence.id}`]: () => response(saved),
      [`PATCH ${evidenceBase}/${evidence.id}`]: (init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        saved = { ...initial, ...sent, revision: 2 };
        return response(saved);
      },
    });
    const user = await openCorrection('evidence');
    if (kind === 'link') {
      await user.clear(screen.getByLabelText('Σύνδεσμος'));
      await user.type(screen.getByLabelText('Σύνδεσμος'), 'https://example.invalid/corrected');
    } else if (kind === 'result') {
      await user.clear(screen.getByLabelText('Αποτέλεσμα JSON'));
      await user.click(screen.getByLabelText('Αποτέλεσμα JSON'));
      await user.paste('{"synthetic":"new"}');
    } else await user.type(screen.getByLabelText('Τίτλος τεκμηρίου'), ' Διόρθωση');
    await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
    await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
    if (kind === 'link') expect(sent.url).toBe('https://example.invalid/corrected');
    if (kind === 'result') expect(sent.data).toEqual({ synthetic: 'new' });
    if (kind === 'file') {
      expect(sent.file_id).toBeUndefined();
      expect(saved.file_id).toBe(file.id);
    }
    expect(spy.mock.calls.some(([url]) => String(url).startsWith('https://'))).toBe(false);
  });
for (const manual of [false, true])
  it(`adds new ID-less rubric criteria to an existing ${manual ? 'manual' : 'criteria'} exercise and retains server-generated IDs`, async () => {
    const initial = manual
      ? x
      : {
          ...x,
          grading_mode: 'criteria',
          criteria: [
            { id: 'synthetic-existing-c', label: 'Παλαιό', max_points: '10', instructions: '' },
          ],
        };
    let saved: any;
    let sent: any;
    mock({
      [`GET /api/v1/labs/${x.lab_id}/exercises`]: page([initial]),
      [`PATCH ${exPath}`]: (init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        saved = {
          ...initial,
          ...sent,
          revision: sent.revision + 1,
          rubric_revision: (saved?.rubric_revision || initial.rubric_revision) + 1,
          criteria: sent.criteria.map((c: any) => ({ ...c, id: c.id || 'synthetic-generated-c' })),
        };
        return response(saved);
      },
      [`GET ${exPath}`]: () => response(saved || initial),
    });
    render(<Exercises labId={x.lab_id} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: `Επεξεργασία ${x.title}` }));
    expect(screen.getByText(/ετικέτες.*οδηγίες/)).toBeVisible();
    if (manual) await user.selectOptions(screen.getByLabelText('Τρόπος βαθμολόγησης'), 'criteria');
    else {
      await user.clear(screen.getByLabelText('Κριτήριο 1 · μονάδες'));
      await user.type(screen.getByLabelText('Κριτήριο 1 · μονάδες'), '5');
    }
    await user.click(screen.getByRole('button', { name: 'Προσθήκη κριτηρίου' }));
    const index = manual ? 1 : 2;
    await user.type(screen.getByLabelText(`Κριτήριο ${index} · ετικέτα`), 'Νέο');
    await user.type(screen.getByLabelText(`Κριτήριο ${index} · μονάδες`), manual ? '10' : '5');
    await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
    await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
    expect(sent.criteria[index - 1].id).toBeUndefined();
    if (!manual) expect(sent.criteria[0].id).toBe('synthetic-existing-c');
    await user.type(screen.getByLabelText(`Κριτήριο ${index} · οδηγίες`), 'Νέος ορισμός');
    await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
    await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
    expect(sent.criteria[index - 1].id).toBe('synthetic-generated-c');
  });

it('rejects exercise readback that substitutes criterion IDs at the same revision', async () => {
  const rubric: Exercise = {
    ...x,
    grading_mode: 'criteria',
    criteria: [{ id: 'synthetic-retained', label: 'Ορισμός', max_points: '10', instructions: '' }],
  };
  let saved: any;
  mock({
    [`GET /api/v1/labs/${x.lab_id}/exercises`]: page([rubric]),
    [`PATCH ${exPath}`]: (init: RequestInit) => {
      saved = { ...rubric, ...JSON.parse(String(init.body)), revision: 3 };
      return response(saved);
    },
    [`GET ${exPath}`]: () =>
      response(
        saved ? { ...saved, criteria: [{ ...saved.criteria[0], id: 'synthetic-wrong' }] } : rubric,
      ),
  });
  render(<Exercises labId={x.lab_id} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: `Επεξεργασία ${x.title}` }));
  await user.type(screen.getByLabelText('Κριτήριο 1 · οδηγίες'), 'Αλλαγή ορισμού');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText(
    'Η αποθήκευση δεν επιβεβαιώθηκε από την έκδοση διακομιστή. Οι αλλαγές σας διατηρούνται.',
  );
  expect(screen.getByLabelText('Κριτήριο 1 · οδηγίες')).toHaveValue('Αλλαγή ορισμού');
});
it('rejects assessment readback with different saved fields despite a matching revision', async () => {
  let saved: any;
  mock({
    [`PUT ${assessmentPath}`]: (init: RequestInit) => {
      const { confirm_rubric_change: _confirmation, ...body } = JSON.parse(String(init.body));
      saved = { ...a, ...body, id: 'synthetic-grade', revision: 1 };
      return response(saved);
    },
    [`GET ${assessmentPath}`]: () => response(saved ? { ...saved, notes: 'Σημείωση άλλου' } : a),
  });
  assessment();
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Σημειώσεις άσκησης'), 'Δική μου σημείωση');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText(
    'Η αποθήκευση δεν επιβεβαιώθηκε από την έκδοση διακομιστή. Οι αλλαγές σας διατηρούνται.',
  );
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('Δική μου σημείωση');
});

for (const mode of ['criteria', 'manual'] as const)
  it(`preserves stale ${mode} grade snapshot on notes-only save across grading-mode changes`, async () => {
    const previous: Assessment = {
      ...a,
      id: 'synthetic-old-grade',
      revision: 4,
      status: 'final',
      score: '15',
      criterion_scores: mode === 'criteria' ? { 'synthetic-old-c': '15' } : {},
      rubric_stale: true,
      rubric_snapshot: { grading_mode: mode, max_points: '20' },
    };
    const current: Exercise =
      mode === 'criteria'
        ? x
        : {
            ...x,
            grading_mode: 'criteria',
            criteria: [{ id: 'synthetic-new-c', label: 'Νέο', max_points: '10', instructions: '' }],
          };
    let saved = previous;
    let sent: any;
    mock({
      [`GET ${assessmentPath}`]: () => response(saved),
      [`PUT ${assessmentPath}`]: (init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        saved = { ...previous, notes: sent.notes, revision: 5 };
        return response(saved);
      },
    });
    assessment(current);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Σημειώσεις άσκησης'), 'Μόνο σημειώσεις');
    await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
    await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
    expect(sent).toMatchObject({
      score: '15',
      criterion_scores: previous.criterion_scores,
      rubric_revision: 2,
      confirm_rubric_change: false,
    });
    expect(saved.rubric_snapshot).toEqual(previous.rubric_snapshot);
    expect(saved.rubric_revision).toBe(1);
  });
for (const kind of ['material', 'evidence'] as const)
  it(`uses the latest exact ${kind} GET rather than stale list metadata when opening the editor`, async () => {
    const base = kind === 'material' ? materialBase : evidenceBase;
    const record = kind === 'material' ? material : evidence;
    let saved = { ...record, revision: 4, title: 'Τρέχων τίτλος' };
    let sent: any;
    correctionMock(kind, {
      [`GET ${base}/${record.id}`]: () => response(saved),
      [`PATCH ${base}/${record.id}`]: (init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        saved = { ...saved, ...sent, revision: 5 };
        return response(saved);
      },
    });
    const user = await openCorrection(kind);
    const title = kind === 'material' ? 'Τίτλος υλικού' : 'Τίτλος τεκμηρίου';
    expect(screen.getByLabelText(title)).toHaveValue('Τρέχων τίτλος');
    await user.type(screen.getByLabelText(title), ' Διόρθωση');
    await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
    await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
    expect(sent.revision).toBe(4);
  });
it('corrects evidence exercise association, kind and source explicitly while keeping its identity', async () => {
  const other = { ...x, id: 'synthetic-other-ex', title: 'Άλλη άσκηση' };
  let saved = evidence;
  let sent: any;
  correctionMock('evidence', {
    [`GET /api/v1/labs/${x.lab_id}/exercises`]: page([x, other]),
    [`GET ${evidenceBase}/${evidence.id}`]: () => response(saved),
    [`PATCH ${evidenceBase}/${evidence.id}`]: (init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      saved = { ...evidence, ...sent, revision: 2 };
      return response(saved);
    },
  });
  const user = await openCorrection('evidence');
  await user.selectOptions(screen.getByLabelText('Σχετική άσκηση'), other.id);
  await user.selectOptions(screen.getByLabelText('Είδος τεκμηρίου'), 'link');
  await user.type(screen.getByLabelText('Σύνδεσμος'), 'https://example.invalid/corrected');
  await user.clear(screen.getByLabelText('Προέλευση τεκμηρίου'));
  await user.type(screen.getByLabelText('Προέλευση τεκμηρίου'), 'human');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  expect(sent).toMatchObject({
    exercise_id: other.id,
    kind: 'link',
    url: 'https://example.invalid/corrected',
    source: 'human',
  });
  expect(sent.text).toBeUndefined();
  expect(saved.id).toBe(evidence.id);
});
for (const kind of ['material', 'evidence'] as const)
  it(`reuses the replacement ${kind} file after PATCH rejection and preserves its draft`, async () => {
    const base = kind === 'material' ? materialBase : evidenceBase;
    const record = kind === 'material' ? material : { ...evidence, kind: 'file', file_id: file.id };
    const replacement = { ...file, id: 'synthetic-retry-replacement' };
    const spy = correctionMock(kind, {
      [`GET ${base}/${record.id}`]: record,
      [`POST /api/v1/labs/${x.lab_id}/files`]: replacement,
      [`GET /api/v1/files/${replacement.id}`]: replacement,
      [`PATCH ${base}/${record.id}`]: response(
        { message: 'Συνθετική απόρριψη αρχείου', code: 'validation_error' },
        422,
      ),
    });
    const user = await openCorrection(kind);
    await user.upload(
      screen.getByLabelText(
        kind === 'material'
          ? 'Αντικατάσταση αρχείου υλικού (προαιρετική)'
          : 'Αντικατάσταση αρχείου τεκμηρίου (προαιρετική)',
      ),
      new File(['synthetic'], 'synthetic.txt', { type: 'text/plain' }),
    );
    await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
    await screen.findByText('Συνθετική απόρριψη αρχείου');
    await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
    await screen.findByText('Συνθετική απόρριψη αρχείου');
    expect(spy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(spy.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(2);
  });

for (const kind of ['material', 'evidence'] as const)
  it(`reopening the same ${kind} correction loads current fields and revision after cancelling an unsaved draft`, async () => {
    const base = kind === 'material' ? materialBase : evidenceBase;
    const record = kind === 'material' ? material : evidence;
    let current: any = record;
    correctionMock(kind, { [`GET ${base}/${record.id}`]: () => response(current) });
    const user = await openCorrection(kind);
    const title = kind === 'material' ? 'Τίτλος υλικού' : 'Τίτλος τεκμηρίου';
    await user.type(screen.getByLabelText(title), ' Μη αποθηκευμένο');
    current = { ...record, revision: 2, title: 'Τίτλος άλλου χειριστή' };
    await user.click(
      screen.getByRole('button', {
        name: kind === 'material' ? 'Επεξεργασία υλικού' : 'Επεξεργασία τεκμηρίου',
      }),
    );
    await waitFor(() => expect(screen.getByLabelText(title)).toHaveValue('Τίτλος άλλου χειριστή'));
  });

it('uses the rendered Exercise rubric revision even on first save, never the assessment snapshot revision', async () => {
  let sent: any;
  let saved = a;
  mock({
    [`PUT ${assessmentPath}`]: (init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      saved = { ...a, ...sent, id: 'synthetic-grade', revision: 1 };
      return response(saved);
    },
    [`GET ${assessmentPath}`]: () => response(saved),
  });
  assessment();
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Σημειώσεις άσκησης'), 'Πρώτη σημείωση');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  expect(sent).toEqual({
    revision: 0,
    rubric_revision: 2,
    confirm_rubric_change: false,
    submission_id: null,
    status: 'ungraded',
    score: null,
    criterion_scores: {},
    notes: 'Πρώτη σημείωση',
    source: 'human',
  });
});
it('saves stale notes only without confirmation or revalidating old points against new rules', async () => {
  const stale: Assessment = {
    ...a,
    id: 'synthetic-grade',
    revision: 3,
    status: 'final',
    score: '15',
    rubric_stale: true,
    rubric_snapshot: { max_points: '20' },
  };
  let saved = stale;
  let sent: any;
  mock({
    [`GET ${assessmentPath}`]: () => response(saved),
    [`PUT ${assessmentPath}`]: (init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      saved = { ...stale, notes: sent.notes, revision: 4 };
      return response(saved);
    },
  });
  assessment();
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Σημειώσεις άσκησης'), 'Διόρθωση σημείωσης');
  const confirm = screen.getByLabelText('Επανέλεγξα τον βαθμό με την τρέχουσα κλίμακα');
  expect(confirm).not.toBeChecked();
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  expect(sent).toMatchObject({
    rubric_revision: 2,
    confirm_rubric_change: false,
    score: '15',
    status: 'final',
  });
  expect(screen.getByText('Η κλίμακα άλλαξε — απαιτείται επανέλεγχος.')).toBeVisible();
  expect(confirm).not.toBeChecked();
});
it('requires deliberate stale-grade acknowledgement before changed grading values can be sent', async () => {
  const stale = {
    ...a,
    id: 'synthetic-grade',
    revision: 3,
    status: 'final' as const,
    score: '8',
    rubric_stale: true,
  };
  let saved = stale;
  let sent: any;
  const spy = mock({
    [`GET ${assessmentPath}`]: () => response(saved),
    [`PUT ${assessmentPath}`]: (init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      saved = { ...stale, ...sent, revision: 4, rubric_stale: false };
      return response(saved);
    },
  });
  assessment();
  const user = userEvent.setup();
  await user.clear(await screen.findByLabelText('Βαθμός'));
  await user.type(screen.getByLabelText('Βαθμός'), '7');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  expect(
    await screen.findByText(
      'Επιβεβαιώστε τον επανέλεγχο πριν αλλάξετε τον βαθμό ή τη σύνδεσή του.',
    ),
  ).toBeVisible();
  expect(spy.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  await user.click(screen.getByLabelText('Επανέλεγξα τον βαθμό με την τρέχουσα κλίμακα'));
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  expect(sent).toMatchObject({ rubric_revision: 2, confirm_rubric_change: true, score: '7' });
});
it('preserves a rubric-conflicting draft and reloads both current exercise rules and assessment only after consent', async () => {
  const current = {
    ...x,
    max_points: '5',
    grading_mode: 'criteria' as const,
    criteria: [
      {
        id: 'synthetic-new-c',
        label: 'Νέος ορισμός',
        max_points: '5',
        instructions: 'Νέα κριτήρια',
      },
    ],
    grading_instructions: 'Νέες οδηγίες',
    rubric_revision: 3,
    revision: 3,
  };
  const spy = mock({
    [`PUT ${assessmentPath}`]: response(
      { code: 'rubric_conflict', message: 'Η κλίμακα ενημερώθηκε' },
      409,
    ),
    [`GET ${exPath}`]: current,
  });
  assessment();
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Σημειώσεις άσκησης'), 'Μην χαθεί');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Η κλίμακα ενημερώθηκε');
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('Μην χαθεί');
  const put = spy.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(String(put?.[1]?.body)).rubric_revision).toBe(2);
  await user.click(screen.getByRole('button', { name: 'Σύγκριση με διακομιστή' }));
  expect(await screen.findByRole('heading', { name: 'Τρέχουσα κλίμακα διακομιστή' })).toBeVisible();
  expect(screen.getByText('Νέος ορισμός · έως 5')).toBeVisible();
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('Μην χαθεί');
  await user.click(screen.getByRole('button', { name: 'Επαναφόρτωση από διακομιστή' }));
  expect(await screen.findByLabelText('Νέος ορισμός · βαθμός')).toBeVisible();
  expect(screen.queryByLabelText('Βαθμός')).toBeNull();
  expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('');
  expect(screen.getAllByText('Νέες οδηγίες').length).toBeGreaterThan(0);
  expect(spy.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
});
