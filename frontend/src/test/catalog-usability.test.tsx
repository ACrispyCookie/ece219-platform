// Synthetic-only catalog usability regressions; no live records.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import EvidenceList from '../Evidence';
import Materials from '../Materials';
import Submissions from '../Submissions';
import AssessmentView from '../Assessment';
import { FileMetadata } from '../files';
import Uploads from '../Uploads';
import { DirtyContext, archiveStatus, sourceLabel } from '../ui';
import { readFile } from 'node:fs/promises';
import type { Assessment, Evidence, Exercise, Material, StoredFile, Submission } from '../types';
const labId = 'synthetic-lab',
  teamId = 'synthetic-team';
const exercise: Exercise = {
  id: 'synthetic-ex',
  lab_id: labId,
  title: 'Άσκηση',
  description: '',
  position: 0,
  max_points: '1',
  grading_mode: 'manual',
  grading_instructions: '',
  criteria: [],
  rubric_revision: 1,
  revision: 1,
  archived: false,
};
const file: StoredFile = {
  id: 'synthetic-file',
  lab_id: labId,
  filename: 'notes.txt',
  size: 1024,
  media_type: 'text/plain',
  sha256: 'a'.repeat(64),
  created_at: '2026-01-01T12:00:00Z',
};
const evidence: Evidence = {
  id: 'first',
  revision: 1,
  team_id: teamId,
  exercise_id: exercise.id,
  submission_id: null,
  kind: 'text',
  title: 'Πρώτο τεκμήριο',
  text: 'Ανθρώπινο σχόλιο',
  source: 'agent',
  created_at: file.created_at,
};
const material: Material = {
  id: 'first',
  lab_id: labId,
  revision: 1,
  exercise_id: exercise.id,
  file_id: file.id,
  role: 'handout',
  title: 'Πρώτο υλικό',
  description: '',
};
const submission: Submission = {
  lab_id: labId,
  id: '10000000-1111-2222-3333-444444444444',
  team_id: teamId,
  file_id: file.id,
  filename: 'synthetic.zip',
  sha256: file.sha256,
  created_at: file.created_at,
  archive_status: 'ok',
  archive_errors: [],
};
const assessment: Assessment = {
  id: 'synthetic-grade',
  team_id: teamId,
  exercise_id: exercise.id,
  submission_id: null,
  status: 'draft',
  score: null,
  criterion_scores: {},
  notes: '',
  source: 'human',
  revision: 1,
  rubric_revision: 1,
  rubric_stale: false,
};
const base = `/api/v1/labs/${labId}`;
const eb = `${base}/teams/${teamId}/evidence`;
const mb = `${base}/materials`;
const page = (items: unknown[]) => ({ items, total: items.length, limit: 100, offset: 0 });
const response = (value: unknown) => new Response(JSON.stringify(value));
function fixture(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    [eb]: page([evidence]),
    [eb + '/first']: evidence,
    [mb]: page([material]),
    [mb + '/first']: material,
    [`${base}/files`]: page([file]),
    [`/api/v1/files/${file.id}`]: file,
    [`${base}/exercises`]: page([exercise]),
    [`${base}/teams/${teamId}/assessments/${exercise.id}`]: assessment,
    [`${base}/teams/${teamId}/assessments/${exercise.id}/history`]: page([assessment]),
    [`/api/v1/submissions/${submission.id}`]: submission,
    [`/api/v1/submissions/${submission.id}/members`]: page([
      { path: 'notes.txt', size: 12 },
      { path: 'blocked.txt', status: 'blocked' },
      { path: 'directory/', is_dir: true },
    ]),
    ...overrides,
  };
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    const value = defaults[String(url).split('?')[0]];
    if (typeof value === 'function') return value();
    if (value instanceof Response) return value.clone();
    return response(value ?? page([]));
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const evidenceView = (ex = exercise.id) => (
  <EvidenceList labId={labId} teamId={teamId} exerciseId={ex} submissions={[submission]} />
);
for (const kind of ['evidence', 'material'] as const) {
  const isEvidence = kind === 'evidence';
  const record = isEvidence ? evidence : material;
  const path = isEvidence ? eb : mb;
  const label = isEvidence ? 'Επεξεργασία τεκμηρίου' : 'Επεξεργασία υλικού';
  const titleLabel = isEvidence ? 'Τίτλος τεκμηρίου' : 'Τίτλος υλικού';
  it(`opens ${kind} correction inside the clicked card and focuses its first field`, async () => {
    const scroll = vi.fn();
    const previousScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    fixture({
      [path]: page([record, { ...record, id: 'last', title: 'Τελευταίο' }]),
      [path + '/last']: { ...record, id: 'last', title: 'Τελευταίο' },
    });
    render(isEvidence ? evidenceView() : <Materials labId={labId} />);
    const heading = await screen.findByRole('heading', { name: 'Τελευταίο' });
    const card = heading.closest('article')!;
    await userEvent.click(within(card).getByRole('button', { name: label }));
    const input = await screen.findByLabelText(titleLabel);
    expect(card).toContainElement(input);
    expect(input).toHaveFocus();
    const scrollCalls = [...scroll.mock.calls];
    HTMLElement.prototype.scrollIntoView = previousScroll;
    expect(scrollCalls).toContainEqual([{ block: 'center', inline: 'nearest', behavior: 'instant' }]);
    expect(card).toContainElement(screen.getByRole('button', { name: 'Ακύρωση' }));
  });
  it(`cannot replace ${kind} editing state with a late response after opening a new form`, async () => {
    let release!: (value: Response) => void;
    fixture({
      [path + '/first']: () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    });
    render(isEvidence ? evidenceView() : <Materials labId={labId} />);
    fireEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    const create = screen.getByRole('button', { name: isEvidence ? 'Νέο τεκμήριο' : 'Νέο υλικό' });
    expect(create).toBeDisabled();
    fireEvent.click(create);
    await act(async () => release(response(record)));
    expect(await screen.findByLabelText(titleLabel)).toHaveValue(record.title);
  });
}
it('shows human comments for result/file evidence and keeps exact raw result JSON collapsed', async () => {
  fixture({
    [eb]: page([
      { ...evidence, kind: 'result', data: {}, text: 'Σχόλιο αποτελέσματος' },
      { ...evidence, id: 'file-e', kind: 'file', file_id: file.id, text: 'Σχόλιο αρχείου' },
    ]),
  });
  // Use native raw response to exercise the actual lossless API parser.
  fixture({
    [eb]: new Response(
      `{"items":[{"id":"first","revision":1,"team_id":"${teamId}","exercise_id":"${exercise.id}","submission_id":null,"kind":"result","title":"Αποτέλεσμα","text":"Σχόλιο αποτελέσματος","source":"agent","created_at":"${file.created_at}","data":{"counter":9007199254740993}},{"id":"file-e","revision":1,"team_id":"${teamId}","exercise_id":"${exercise.id}","kind":"file","title":"Αρχείο","file_id":"${file.id}","text":"Σχόλιο αρχείου","source":"human","created_at":"${file.created_at}"}],"total":2,"limit":100,"offset":0}`,
    ),
  });
  render(evidenceView());
  expect(await screen.findByText('Σχόλιο αποτελέσματος')).toBeVisible();
  expect(screen.getByText('Σχόλιο αρχείου')).toBeVisible();
  expect(screen.getByText(/Βοηθός AI/)).toBeVisible();
  const summary = screen.getByText('Δεδομένα αποτελέσματος (JSON)');
  expect(summary.closest('details')).not.toHaveAttribute('open');
  expect(summary.closest('details')!.querySelector('pre')!.textContent).toContain(
    '9007199254740993',
  );
  expect(screen.queryByText('9007199254740992')).not.toBeInTheDocument();
});
it('lets result/file evidence retain editable human comments and readable source choices', async () => {
  fixture({
    [eb]: page([{ ...evidence, kind: 'result', data: {} }]),
    [eb + '/first']: { ...evidence, kind: 'result', data: {} },
  });
  render(evidenceView());
  await userEvent.click(await screen.findByRole('button', { name: 'Επεξεργασία τεκμηρίου' }));
  expect(await screen.findByLabelText('Κείμενο τεκμηρίου')).toHaveValue(evidence.text);
  expect(screen.getByRole('option', { name: 'Βοηθός AI' })).toHaveValue('agent');
});
it('wraps contextual layouts, toolbars and member actions at narrow widths', async () => {
  const css = await readFile('src/styles.css', 'utf8');
  expect(css).toMatch(/\.toolbar\s*\{[^}]*flex-wrap:\s*wrap/s);
  expect(css).toMatch(/\.version-inventory\s*\{[^}]*flex-basis:\s*100%/s);
  expect(css).toMatch(/\.cards\s+\.resource-card\.editing\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
  expect(css).toMatch(/\.member-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
});
it('ignores old evidence edit fetch through an exercise A → B → A transition', async () => {
  let release!: (value: Response) => void;
  fixture({
    [eb + '/first']: () =>
      new Promise<Response>((r) => {
        release = r;
      }),
  });
  const view = render(evidenceView());
  fireEvent.click(await screen.findByRole('button', { name: 'Επεξεργασία τεκμηρίου' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  view.rerender(evidenceView('other'));
  view.rerender(evidenceView());
  await act(async () => release(response(evidence)));
  expect(screen.queryByLabelText('Τίτλος τεκμηρίου')).not.toBeInTheDocument();
});
it('toggles each submission inventory in its own card with collapsed technical metadata', async () => {
  fixture();
  render(
    <Submissions
      labId={labId}
      teamId={teamId}
      items={[submission, { ...submission, id: 'other-version' }]}
      total={2}
      busy={false}
      onMore={() => {}}
      onRefresh={() => {}}
    />,
  );
  const cards = screen.getAllByRole('article');
  const toggle = within(cards[0]).getByRole('button', { name: /Προβολή αρχείων/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(toggle).toHaveAccessibleName(/Απόκρυψη αρχείων/);
  expect(await within(cards[0]).findByText('notes.txt')).toBeVisible();
  expect(within(cards[1]).queryByText('notes.txt')).not.toBeInTheDocument();
  expect(
    within(cards[0])
      .getAllByText(/Μεταδεδομένα παράδοσης/)[0]
      .closest('details'),
  ).not.toHaveAttribute('open');
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
});
it('puts assessment deletion in the actual editor header and names its target clearly', async () => {
  fixture();
  render(
    <AssessmentView labId={labId} teamId={teamId} exercise={exercise} submissions={[submission]} />,
  );
  const heading = await screen.findByRole('heading', { name: 'Αξιολόγηση άσκησης' });
  const header = heading.closest('header');
  expect(header).not.toBeNull();
  expect(header).toContainElement(
    screen.getByRole('button', { name: 'Διαγραφή αξιολόγησης Άσκηση' }),
  );
  expect(
    within(header!).getByRole('button', { name: 'Διαγραφή αξιολόγησης Άσκηση' }),
  ).toHaveTextContent('Διαγραφή αξιολόγησης');
  expect(screen.getAllByText('Προσχέδιο').length).toBeGreaterThan(0);
  expect(screen.getByRole('option', { name: /synthetic.zip/ }).textContent).not.toContain(
    submission.id,
  );
});
it('offers shared preview and separate download on stored file and upload surfaces', async () => {
  fixture();
  const view = render(<FileMetadata fileId={file.id} />);
  await screen.findByText(file.filename);
  expect(screen.getByRole('button', { name: 'Προβολή' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Λήψη' })).toHaveAttribute('download');
  view.unmount();
  render(<Uploads labId={labId} onRemoved={() => {}} />);
  await screen.findByText(file.filename);
  expect(screen.getByRole('button', { name: 'Προβολή' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Λήψη' })).toHaveAttribute('download');
});
it('offers member previews and a separate download only for unblocked non-directories', async () => {
  fixture();
  render(
    <Submissions
      labId={labId}
      teamId={teamId}
      items={[submission]}
      total={1}
      busy={false}
      onMore={() => {}}
      onRefresh={() => {}}
    />,
  );
  // Legacy accessible name remains available while the toggle UX changes.
  fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.includes('Προβολή'))!);
  const member = (await screen.findByText('notes.txt')).closest('li')!;
  expect(within(member).getByRole('button', { name: 'Προβολή' })).toBeVisible();
  expect(within(member).getByRole('link', { name: 'Λήψη' })).toHaveAttribute(
    'href',
    expect.stringContaining('path=notes.txt'),
  );
  for (const name of ['blocked.txt', 'directory/']) {
    const row = screen.getByText(name).closest('li')!;
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
  }
});
it('retains the dirty guard when switching evidence items', async () => {
  const fetcher = fixture();
  const guard = vi.fn(() => false);
  render(
    <DirtyContext.Provider value={{ set: () => {}, guard }}>
      {evidenceView()}
    </DirtyContext.Provider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Επεξεργασία τεκμηρίου' }));
  expect(guard).toHaveBeenCalled();
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/first'))).toHaveLength(0);
});
it('translates actual backend valid/import values without replacing their technical identifiers', () => {
  expect(archiveStatus('valid')).toBe('Έτοιμο για προβολή');
  expect(sourceLabel('import')).toBe('Εισαγωγή');
});
it('shows material exercise titles and keeps exact material identifiers in closed details', async () => {
  fixture();
  render(<Materials labId={labId} />);
  const card = (await screen.findByRole('heading', { name: material.title })).closest('article')!;
  expect(await within(card).findByText('Άσκηση: Άσκηση')).toBeVisible();
  const metadata = within(card).getByText('Μεταδεδομένα υλικού').closest('details')!;
  expect(metadata).not.toHaveAttribute('open');
  expect(metadata).toHaveTextContent(material.id);
  expect(metadata).toHaveTextContent(exercise.id);
});
for (const kind of ['evidence', 'material'] as const) {
  it(`keeps a failed ${kind} edit fetch notice next to the clicked item`, async () => {
    const isEvidence = kind === 'evidence';
    const record = isEvidence ? evidence : material;
    const path = isEvidence ? eb : mb;
    fixture({
      [path + '/first']: new Response(
        JSON.stringify({ code: 'unavailable', message: 'Συνθετικό σφάλμα επεξεργασίας' }),
        { status: 503 },
      ),
    });
    render(isEvidence ? evidenceView() : <Materials labId={labId} />);
    const card = (await screen.findByRole('heading', { name: record.title })).closest('article')!;
    await userEvent.click(
      within(card).getByRole('button', {
        name: isEvidence ? 'Επεξεργασία τεκμηρίου' : 'Επεξεργασία υλικού',
      }),
    );
    expect(card).toContainElement(await screen.findByRole('alert'));
  });
}
for (const kind of ['evidence', 'material'] as const) {
  it(`retains ${kind} correction and save confirmation when the collection refresh fails`, async () => {
    const isEvidence = kind === 'evidence';
    const original = isEvidence ? evidence : material;
    const record = { ...original, revision: 2 };
    const path = isEvidence ? eb : mb;
    let reads = 0;
    const fetcher = fixture({
      [path]: () =>
        ++reads === 1
          ? response(page([original]))
          : new Response(
              JSON.stringify({ code: 'collection_failed', message: 'Αποτυχία ανανέωσης λίστας' }),
              { status: 503 },
            ),
      [path + '/first']: () => response(record),
    });
    // This is a response-only fixture for the display lifecycle, not persistence.
    render(isEvidence ? evidenceView() : <Materials labId={labId} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: isEvidence ? 'Επεξεργασία τεκμηρίου' : 'Επεξεργασία υλικού',
      }),
    );
    const input = await screen.findByLabelText(isEvidence ? 'Τίτλος τεκμηρίου' : 'Τίτλος υλικού');
    // A verified correction PATCH advances revision, followed by its exact GET.
    const saved = { ...record, revision: 3 };
    fetcher.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).split('?')[0] === path + '/first')
        return response(init?.method === 'PATCH' ? saved : saved);
      if (String(url).split('?')[0] === path)
        return new Response(
          JSON.stringify({ code: 'collection_failed', message: 'Αποτυχία ανανέωσης λίστας' }),
          { status: 503 },
        );
      if (String(url).split('?')[0] === `${base}/files`) return response(page([file]));
      if (String(url).includes('/files/')) return response(file);
      return response(page([exercise]));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
    await screen.findByText('Αποτυχία ανανέωσης λίστας');
    expect(input).toBeInTheDocument();
    expect(screen.getByText('Αποθηκεύτηκε και επιβεβαιώθηκε.')).toBeVisible();
  });
  it(`freezes ${kind} draft edits synchronously during another edit fetch and blocks removal`, async () => {
    const isEvidence = kind === 'evidence';
    const record = isEvidence ? evidence : material;
    const path = isEvidence ? eb : mb;
    const label = isEvidence ? 'Επεξεργασία τεκμηρίου' : 'Επεξεργασία υλικού';
    const titleLabel = isEvidence ? 'Τίτλος τεκμηρίου' : 'Τίτλος υλικού';
    let release!: (value: Response) => void;
    const fetcher = fixture({
      [path]: page([record, { ...record, id: 'last', title: 'Τελευταίο' }]),
      [path + '/last']: () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    });
    render(isEvidence ? evidenceView() : <Materials labId={labId} />);
    fireEvent.click((await screen.findAllByRole('button', { name: label }))[0]);
    const input = await screen.findByLabelText(titleLabel);
    fireEvent.change(input, { target: { value: 'Διατήρηση' } });
    act(() => {
      fireEvent.click(screen.getAllByRole('button', { name: label })[1]);
      fireEvent.change(input, { target: { value: 'Αγνοείται εν αναμονή' } });
      fireEvent.click(
        screen.getByRole('button', {
          name: new RegExp(`Διαγραφή ${isEvidence ? 'τεκμηρίου' : 'υλικού'} Τελευταίο`),
        }),
      );
    });
    expect(input).toHaveValue('Διατήρηση');
    expect(input).toBeDisabled();
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes('/deletion-impact')),
    ).toHaveLength(0);
    await act(async () =>
      release(
        new Response(JSON.stringify({ code: 'not_available', message: 'Συνθετική αποτυχία' }), {
          status: 503,
        }),
      ),
    );
    expect(input).toHaveValue('Διατήρηση');
    expect(input).toBeEnabled();
  });
}
