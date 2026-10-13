// Isolated synthetic state and real HTTP only; never a deployed server.
import { confirmRemoval, cancelRemoval } from './removal-dialog-helpers';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import App from '../App';
import Teams from '../Teams';
import TeamDetail from '../TeamDetail';
import Removal from '../Removal';
import { DirtyContext } from '../ui';
import { OperationContext, useOperations } from '../OperationContext';

const nativeFetch = globalThis.fetch;
let origin: string, token: string, state: string;
let server: ChildProcess;
let output = '';
const calls: { path: string; method: string; status: number }[] = [];
let gate:
  | { path: string; method: string; arrived: () => void; wait: Promise<void>; release: () => void }
  | undefined;
let cachedRead: { path: string; response: Response } | undefined;
let pausedRelease: (() => void) | undefined;
beforeEach(async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  calls.length = 0;
  output = '';
  state = await mkdtemp(
    resolve(process.env.TMPDIR || '/home/jason/.hermes/cache/scratch', 'team-removal-'),
  );
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  origin = `http://127.0.0.1:${port}`;
  const project = resolve(process.cwd(), '..');
  server = spawn(
    resolve(project, '.venv/bin/python'),
    ['-m', 'lab_catalog', 'serve', '--data-dir', state, '--port', String(port)],
    {
      cwd: project,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: resolve(project, 'backend'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout!.on('data', (c) => (output += String(c)));
  server.stderr!.on('data', (c) => (output += String(c)));
  for (let i = 0; i < 200; i++) {
    if (server.exitCode !== null) throw new Error(output);
    try {
      if ((await nativeFetch(origin + '/health')).ok) break;
    } catch {}
    if (i === 199) throw new Error('Own team deletion CLI readiness: ' + output);
    await new Promise((r) => setTimeout(r, 25));
  }
  token = (await readFile(resolve(state, 'operator-token'), 'utf8')).trim();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), origin);
    const method = init?.method || 'GET';
    const headers = new Headers(init?.headers);
    headers.set('Authorization', 'Bearer ' + token);
    const response =
      method === 'GET' && cachedRead?.path === url.pathname
        ? cachedRead.response
        : await nativeFetch(url.href, { ...init, headers });
    if (response === cachedRead?.response) cachedRead = undefined;
    calls.push({ path: url.pathname + url.search, method, status: response.status });
    if (gate?.method === method && gate.path === url.pathname) {
      const paused = gate;
      gate = undefined;
      paused.arrived();
      await paused.wait;
    }
    return response;
  };
}, 15000);
afterEach(async () => {
  cleanup();
  pausedRelease?.();
  pausedRelease = undefined;
  gate = undefined;
  cachedRead = undefined;
  globalThis.fetch = nativeFetch;
  window.history.replaceState(null, '', '/');
  if (server && server.exitCode === null) {
    const ended = new Promise<void>((r) => server.once('exit', () => r()));
    server.kill('SIGTERM');
    await ended;
  }
  if (state) await rm(state, { recursive: true, force: true });
});
async function response(path: string, method = 'GET', data?: unknown) {
  return nativeFetch(origin + '/api/v1' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
async function req(path: string, method = 'GET', data?: unknown) {
  const r = await response(path, method, data);
  expect(r.ok, await r.clone().text()).toBe(true);
  return r.status === 204 ? undefined : r.json();
}
async function seed() {
  const lab = await req('/labs', 'POST', { title: 'Δοκιμαστικό εργαστήριο' });
  const base = '/labs/' + lab.id;
  const team = await req(base + '/teams', 'POST', {
    label: 'Ομάδα προς διαγραφή',
    members: [{ student_id: '00123', name: 'Μέλος' }],
    notes: 'Σημειώσεις που αφαιρούνται',
  });
  return { lab, base, team, path: base + '/teams/' + team.id };
}
async function fixture(detail = false) {
  const f = await seed();
  window.history.replaceState(null, '', '/#' + f.base + '/teams' + (detail ? '/' + f.team.id : ''));
  render(<App />);
  await screen.findByRole(detail ? 'heading' : 'button', { name: f.team.label }, { timeout: 5000 });
  return f;
}
const deletion = () => screen.getByRole('button', { name: 'Διαγραφή ομάδας Ομάδα προς διαγραφή' });
const closeNotice = () => screen.getByRole('button', { name: 'Κλείσιμο ειδοποίησης' });
const writes = () => calls.filter((c) => c.method !== 'GET');
function pause(path: string, method: string) {
  let release!: () => void, arrived!: () => void;
  const reached = new Promise<void>((r) => (arrived = r));
  gate = {
    path: '/api/v1' + path,
    method,
    arrived,
    wait: new Promise<void>((r) => (release = r)),
    release,
  };
  pausedRelease = release;
  return { release, reached };
}
async function upload(base: string, teamId: string, submission = false) {
  const boundary = 'team-removal-synthetic';
  const target = submission ? base + '/teams/' + teamId + '/submissions' : base + '/files';
  const owner = submission
    ? ''
    : `--${boundary}\r\nContent-Disposition: form-data; name="team_id"\r\n\r\n${teamId}\r\n`;
  const r = await nativeFetch(origin + '/api/v1' + target, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
    },
    body: `${owner}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="orphan.txt"\r\nContent-Type: text/plain\r\n\r\nsynthetic retained bytes\r\n--${boundary}--\r\n`,
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return r.json();
}
async function blockers(f: Awaited<ReturnType<typeof seed>>) {
  const exercise = await req(f.base + '/exercises', 'POST', {
    title: 'Βαθμολόγηση',
    max_points: '3',
  });
  const submission = await upload(f.base, f.team.id, true);
  const file = await req('/files/' + submission.file_id);
  await req(f.path + '/evidence', 'POST', {
    title: 'Τεκμήριο',
    kind: 'text',
    text: 'Διατηρείται',
    exercise_id: exercise.id,
  });
  for (const revision of [0, 1])
    await req(f.path + '/assessments/' + exercise.id, 'PUT', {
      revision,
      rubric_revision: 1,
      score: '2',
      status: 'final',
      notes: 'Ιστορικό ' + revision,
    });
  return { exercise, file };
}

it.each([false, true])(
  'cancel team deletion has zero writes and names the target (detail=%s)',
  async (detail) => {
    const f = await fixture(detail);
    await userEvent.click(deletion());
    const message = await cancelRemoval();
    expect(message).toContain(f.team.label);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(await req(f.path)).toEqual(f.team);
  },
);
it.each([false, true])(
  'empty team deletion verifies exact GET404 before list return (detail=%s)',
  async (detail) => {
    const f = await fixture(detail);
    const paused = pause(f.path, 'GET');
    await userEvent.click(deletion());
    const message = await confirmRemoval();
    await paused.reached;
    try {
      expect(deletion()).toBeDisabled();
      expect(screen.queryByRole('heading', { name: 'Ομάδες' })).toBe(
        detail ? null : screen.getByRole('heading', { name: 'Ομάδες' }),
      );
      if (detail) expect(window.location.hash).toContain(f.team.id);
      expect(writes()).toEqual([{ path: deletePath(f.path), method: 'DELETE', status: 204 }]);
    } finally {
      paused.release();
    }
    await screen.findByRole('heading', { name: 'Ομάδες' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: f.team.label })).not.toBeInTheDocument(),
    );
    expect(calls).toContainEqual({ path: '/api/v1' + f.path, method: 'GET', status: 404 });
    expect(window.location.hash).toBe('#' + f.base + '/teams');
    expect((await response(f.path)).status).toBe(404);
    expect(message).toContain('σημειώσεις');
    expect(message).toContain('δεν αναιρείται');
    expect(message).toContain('μεταδεδομένα');
    expect(message).toContain('αποθηκευμένο περιεχόμενο');
  },
);
it.each([false, true])(
  'orphan upload metadata does not prevent team deletion and blob is retained (detail=%s)',
  async (detail) => {
    const f = await fixture(detail);
    const file = await upload(f.base, f.team.id);
    const stored = await readFile(resolve(state, 'blobs', file.sha256));
    await userEvent.click(deletion());
    const message = await confirmRemoval();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: f.team.label })).not.toBeInTheDocument(),
    );
    await screen.findByRole('heading', { name: 'Ομάδες' });
    expect((await response('/files/' + file.id)).status).toBe(404);
    expect(await readFile(resolve(state, 'blobs', file.sha256))).toEqual(stored);
    expect(writes()).toHaveLength(1);
  },
);
it.each([false, true])(
  'populated team confirmation reports truthful cascade counts and removes grades/history (detail=%s)',
  async (detail) => {
    const f = await fixture(detail);
    const records = await blockers(f);
    const truth = await req(f.path + '/deletion-impact');
    await userEvent.click(deletion());
    const message = await confirmRemoval();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: f.team.label })).not.toBeInTheDocument(),
    );
    await screen.findByRole('heading', { name: 'Ομάδες' });
    for (const [kind, label] of [
      ['submissions', 'Παραδόσεις'],
      ['assessments', 'Αξιολογήσεις'],
      ['assessment_history', 'Ιστορικό αξιολογήσεων'],
      ['evidence', 'Τεκμήρια'],
    ]) {
      const count = truth.cascade_counts.find((d: { kind: string }) => d.kind === kind)?.count;
      expect(count).toBeGreaterThan(0);
      expect(message).toContain(label + ': ' + count);
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect((await req(f.base + '/exercises/' + records.exercise.id)).id).toBe(records.exercise.id);
  },
);

it('stale team revision refuses deletion and dismiss does not reload, archive or change a draft', async () => {
  const f = await fixture(true);
  await userEvent.click(screen.getByRole('button', { name: 'Επεξεργασία ομάδας' }));
  fireEvent.change(screen.getByLabelText('Ετικέτα ομάδας'), {
    target: { value: 'Πρόχειρη ετικέτα' },
  });
  const changed = await req(f.path, 'PATCH', { revision: 1, notes: 'Concurrent' });
  await userEvent.click(deletion());
  await confirmRemoval();
  expect(await screen.findByRole('alert')).toHaveTextContent('Η έκδοση έχει τροποποιηθεί');
  expect(writes()).toEqual([{ path: deletePath(f.path), method: 'DELETE', status: 409 }]);
  expect(await req(f.path)).toEqual(changed);
  calls.length = 0;
  await userEvent.click(closeNotice());
  expect(calls).toEqual([]);
  expect(screen.getByLabelText('Ετικέτα ομάδας')).toHaveValue('Πρόχειρη ετικέτα');
  expect(deletion()).toHaveFocus();
});
it('dirty draft refusal makes zero deletion writes and retains literal student IDs', async () => {
  const f = await fixture(true);
  await userEvent.click(screen.getByRole('button', { name: 'Επεξεργασία ομάδας' }));
  fireEvent.change(screen.getByLabelText('Ετικέτα ομάδας'), {
    target: { value: 'Πρόχειρη ετικέτα' },
  });
  vi.mocked(window.confirm).mockClear().mockReturnValue(false);
  await userEvent.click(deletion());
  expect(writes()).toEqual([]);
  expect(window.confirm).toHaveBeenCalledTimes(1);
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('μη αποθηκευμένες αλλαγές'));
  expect(screen.getByLabelText('Ετικέτα ομάδας')).toHaveValue('Πρόχειρη ετικέτα');
  expect(screen.getByLabelText('Μέλος 1 · ΑΜ')).toHaveValue('00123');
  expect(await req(f.path)).toEqual(f.team);
});
it.each(['list', 'detail'])(
  'standalone %s shares synchronous save/deletion ownership in both event orders',
  async (view) => {
    const f = await seed();
    await blockers(f);
    const guard = vi.fn(() => true),
      navigate = vi.fn();
    const rendered = render(
      <DirtyContext.Provider value={{ set: () => {}, guard }}>
        {view === 'list' ? (
          <Teams labId={f.lab.id} onTeam={navigate} />
        ) : (
          <TeamDetail
            labId={f.lab.id}
            teamId={f.team.id}
            onBack={navigate}
            onTeam={navigate}
            onExercise={navigate}
          />
        )}
      </DirtyContext.Provider>,
    );
    await screen.findByRole(view === 'list' ? 'button' : 'heading', { name: f.team.label });
    await userEvent.click(
      screen.getByRole('button', { name: view === 'list' ? 'Νέα ομάδα' : 'Επεξεργασία ομάδας' }),
    );
    if (view === 'list')
      fireEvent.change(screen.getByLabelText('Ετικέτα ομάδας'), {
        target: { value: 'Νέα ομάδα με κυριολεκτική ετικέτα' },
      });
    const form = screen.getByRole('button', { name: 'Αποθήκευση' }).closest('form')!;
    const savePath = view === 'list' ? f.base + '/teams' : f.path;
    const saved = pause(savePath, view === 'list' ? 'POST' : 'PATCH');
    act(() => {
      fireEvent.submit(form);
      fireEvent.click(deletion());
      fireEvent.submit(form);
    });
    await saved.reached;
    try {
      expect(writes()).toHaveLength(1);
      expect(writes()[0].method).toBe(view === 'list' ? 'POST' : 'PATCH');
    } finally {
      await act(async () => {
        saved.release();
      });
    }
    await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
    if (view === 'list')
      await screen.findByRole('button', { name: 'Νέα ομάδα με κυριολεκτική ετικέτα' });
    await screen.findByRole('button', { name: 'Διαγραφή ομάδας Ομάδα προς διαγραφή' });
    // Use current refreshed revision after saving. Both children must still use
    // the standalone parent's operation scope when deletion wins this batch.
    calls.length = 0;
    navigate.mockClear();
    const paused = pause(f.path, 'DELETE');
    act(() => {
      fireEvent.click(deletion());
      fireEvent.submit(form);
      fireEvent.click(deletion());
      fireEvent.click(
        screen.getByRole('button', { name: view === 'list' ? f.team.label : '← Όλες οι ομάδες' }),
      );
    });
    await confirmRemoval();
    await paused.reached;
    try {
      expect(writes()).toHaveLength(1);
      expect(writes()[0].method).toBe('DELETE');
      expect(navigate).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Ετικέτα ομάδας')).toBeDisabled();
      expect(deletion()).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Ετικέτα ομάδας'), {
        target: { value: 'Must not mutate' },
      });
      expect(screen.getByLabelText('Ετικέτα ομάδας')).not.toHaveValue('Must not mutate');
    } finally {
      await act(async () => {
        paused.release();
      });
    }
    await waitFor(() => expect(screen.getByRole('button', { name: 'Αποθήκευση' })).toBeEnabled());
    rendered.unmount();
  },
  15000,
);
it('detail freezes save, navigation and duplicate deletion through exact absence verification', async () => {
  const f = await fixture(true);
  await userEvent.click(screen.getByRole('button', { name: 'Επεξεργασία ομάδας' }));
  const paused = pause(f.path, 'GET');
  await userEvent.click(deletion());
  await confirmRemoval();
  await paused.reached;
  try {
    const hash = window.location.hash;
    for (const name of [
      '← Όλες οι ομάδες',
      'Επεξεργασία ομάδας',
      'Σύνοψη & παραδόσεις',
      'Αποθήκευση',
    ])
      expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByLabelText('Ετικέτα ομάδας')).toBeDisabled();
    act(() => {
      fireEvent.click(deletion());
      fireEvent.submit(screen.getByRole('button', { name: 'Αποθήκευση' }).closest('form')!);
      fireEvent.click(screen.getByRole('button', { name: '← Όλες οι ομάδες' }));
    });
    expect(window.location.hash).toBe(hash);
    expect(writes()).toHaveLength(1);
  } finally {
    paused.release();
  }
  await screen.findByRole('heading', { name: 'Ομάδες' });
});
it('failed exact verification preserves detail and allows dismiss without writes', async () => {
  const f = await fixture(true);
  cachedRead = { path: '/api/v1' + f.path, response: await response(f.path) };
  await userEvent.click(deletion());
  await confirmRemoval();
  expect(await screen.findByRole('alert')).toHaveTextContent('Η διαγραφή δεν επιβεβαιώθηκε');
  expect(screen.getByRole('heading', { name: f.team.label })).toBeInTheDocument();
  expect(window.location.hash).toContain(f.team.id);
  calls.length = 0;
  await userEvent.click(closeNotice());
  expect(calls).toEqual([]);
  expect(deletion()).toHaveFocus();
});
it('an existing notice cannot dismiss during a synchronous shared lock or receive an old response after target ABA', async () => {
  const f = await seed();
  await req(f.path, 'PATCH', { revision: 1, notes: 'Concurrent' });
  const removed = vi.fn();
  const target = (path: string) => (
    <Removal path={path} revision={1} title={f.team.label} kind="ομάδας" onRemoved={removed} />
  );
  const rendered = render(target(f.path));
  await userEvent.click(deletion());
  await confirmRemoval();
  await screen.findByRole('alert');
  const close = closeNotice();
  const paused = pause(f.path, 'DELETE');
  act(() => {
    fireEvent.click(deletion());
    fireEvent.click(close);
  });
  await confirmRemoval();
  await paused.reached;
  rendered.rerender(target(f.base + '/teams/other'));
  rendered.rerender(target(f.path));
  await act(async () => {
    paused.release();
  });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(removed).not.toHaveBeenCalled();
  await userEvent.click(deletion());
  await confirmRemoval();
  expect(await screen.findByRole('alert')).toHaveTextContent('Η έκδοση έχει τροποποιηθεί');
});
it.each(['εργαστηρίου', 'άσκησης'] as const)(
  'existing %s notices also dismiss locally without writes or navigation',
  async (kind) => {
    const f = await seed();
    const x = await req(f.base + '/exercises', 'POST', { title: 'Άσκηση', max_points: '3' });
    await req(f.path + '/evidence', 'POST', {
      title: 'Συσχέτιση',
      kind: 'text',
      text: 'Διατηρείται',
      exercise_id: x.id,
    });
    await req(kind === 'εργαστηρίου' ? f.base : f.base + '/exercises/' + x.id, 'PATCH', {
      revision: 1,
      title: 'Concurrent',
    });
    const removed = vi.fn();
    render(
      <Removal
        path={kind === 'εργαστηρίου' ? f.base : f.base + '/exercises/' + x.id}
        revision={1}
        title="Δοκιμή"
        kind={kind}
        onRemoved={removed}
      />,
    );
    const trigger = screen.getByRole('button', { name: `Διαγραφή ${kind} Δοκιμή` });
    await userEvent.click(trigger);
    await confirmRemoval();
    await screen.findByRole('alert');
    calls.length = 0;
    await userEvent.click(closeNotice());
    expect(calls).toEqual([]);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(removed).not.toHaveBeenCalled();
  },
);

it('a sibling removal disables notice dismissal through verification, including a same-batch close', async () => {
  const f = await seed();
  await req(f.path, 'PATCH', { revision: 1, notes: 'Concurrent' });
  const other = await req(f.base + '/teams', 'POST', { label: 'Άλλη ομάδα' });
  const otherPath = f.base + '/teams/' + other.id;
  function Harness() {
    const operations = useOperations();
    return (
      <OperationContext.Provider value={operations}>
        <Removal
          path={f.path}
          revision={1}
          title={f.team.label}
          kind="ομάδας"
          onRemoved={() => {}}
        />
        <Removal
          path={otherPath}
          revision={1}
          title={other.label}
          kind="ομάδας"
          onRemoved={() => {}}
        />
      </OperationContext.Provider>
    );
  }
  render(<Harness />);
  await userEvent.click(deletion());
  await confirmRemoval();
  await screen.findByRole('alert');
  const paused = pause(otherPath, 'GET');
  const close = closeNotice();
  close.focus();
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Διαγραφή ομάδας Άλλη ομάδα' }));
    fireEvent.click(close);
    expect(close).toHaveFocus();
  });
  await confirmRemoval();
  await paused.reached;
  try {
    expect(closeNotice()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Η έκδοση έχει τροποποιηθεί');
    fireEvent.click(closeNotice());
    expect(screen.getByRole('alert')).toBeInTheDocument();
  } finally {
    await act(async () => {
      paused.release();
    });
  }
  await waitFor(() => expect(closeNotice()).toBeEnabled());
  calls.length = 0;
  await userEvent.click(closeNotice());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(deletion()).toHaveFocus();
  expect(calls).toEqual([]);
});
// Assert the actual cascade contract, including an opaque server fingerprint.
function deletePath(path: string, revision = 1) {
  return expect.stringMatching(
    new RegExp(
      '^/api/v1' +
        path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '\\?cascade=true&confirmation_token=[a-fA-F0-9]{64}&revision=' +
        revision +
        '$',
    ),
  );
}
