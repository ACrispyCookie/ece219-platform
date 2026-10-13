// Real HTTP, ephemeral CLI and synthetic SQLite only. No live deployment.
import { confirmRemoval, cancelRemoval } from './removal-dialog-helpers';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import App from '../App';
import Removal from '../Removal';

const nativeFetch = globalThis.fetch;
let origin: string;
let token: string;
let server: ChildProcess;
let state: string;
let output = '';
const calls: { path: string; method: string; status: number }[] = [];
let gate:
  | { path: string; method: string; arrived: () => void; wait: Promise<void>; release: () => void }
  | undefined;
let deniedRead: string | undefined;
let failedRead: string | undefined;
let staleRead: { path: string; response: Response } | undefined;

beforeEach(async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  calls.length = 0;
  output = '';
  state = await mkdtemp(resolve(tmpdir(), 'catalog-deletion-'));
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
    if (i === 199) throw new Error('Own deletion CLI readiness: ' + output);
    await new Promise((r) => setTimeout(r, 25));
  }
  token = (await readFile(resolve(state, 'operator-token'), 'utf8')).trim();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), origin);
    const method = init?.method || 'GET';
    const headers = new Headers(init?.headers);
    headers.set(
      'Authorization',
      'Bearer ' +
        (method === 'GET' && deniedRead === url.pathname ? 'invalid-synthetic-token' : token),
    );
    if (method === 'GET' && failedRead === url.pathname)
      throw new TypeError('Synthetic disconnected transport');
    // A cached response, when requested by a test, is an actual earlier native
    // HTTP response. Never manufacture success or persisted data.
    const response =
      method === 'GET' && staleRead?.path === url.pathname
        ? staleRead.response
        : await nativeFetch(url.href, { ...init, headers });
    if (response === staleRead?.response) staleRead = undefined;
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
  gate?.release();
  gate = undefined;
  deniedRead = undefined;
  failedRead = undefined;
  staleRead = undefined;
  globalThis.fetch = nativeFetch;
  window.history.replaceState(null, '', '/');
  if (server && server.exitCode === null) {
    const ended = new Promise<void>((r) => server.once('exit', () => r()));
    server.kill('SIGTERM');
    await ended;
  }
  if (state) await rm(state, { recursive: true, force: true });
});

async function req(path: string, method = 'GET', data?: unknown) {
  const response = await nativeFetch(origin + '/api/v1' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.status === 204 ? undefined : response.json();
}
async function fixture(exercise = false) {
  const lab = await req('/labs', 'POST', { title: 'Εργαστήριο προς διαγραφή' });
  const base = '/labs/' + lab.id;
  const ex = exercise
    ? await req(base + '/exercises', 'POST', { title: 'Άσκηση προς διαγραφή', max_points: '3.25' })
    : undefined;
  window.history.replaceState(null, '', '/#' + base + (exercise ? '/exercises' : ''));
  render(<App />);
  await screen.findByRole('heading', { name: lab.title, level: 1 });
  if (ex) await screen.findByRole('heading', { name: ex.title, level: 3 });
  return { lab, base, ex, path: ex ? base + '/exercises/' + ex.id : base };
}
function pause(path: string, method: string) {
  let release!: () => void;
  let arrived!: () => void;
  const reached = new Promise<void>((r) => (arrived = r));
  gate = {
    path: '/api/v1' + path,
    method,
    arrived,
    wait: new Promise<void>((r) => (release = r)),
    release,
  };
  return { release, reached };
}
const deleteLab = () =>
  screen.getByRole('button', { name: 'Διαγραφή εργαστηρίου Εργαστήριο προς διαγραφή' });
const deleteExercise = () =>
  screen.getByRole('button', { name: 'Διαγραφή άσκησης Άσκηση προς διαγραφή' });
const writes = () => calls.filter((c) => c.method !== 'GET');

it.each([false, true])(
  'cancel named deletion makes zero writes (exercise=%s)',
  async (exercise) => {
    const f = await fixture(exercise);
    await userEvent.click(exercise ? deleteExercise() : deleteLab());
    const message = await cancelRemoval();
    expect(message).toContain(exercise ? f.ex.title : f.lab.title);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect((await req(f.path)).id).toBe(exercise ? f.ex.id : f.lab.id);
  },
);

async function orphanUpload(base: string) {
  // jsdom Files are not Node/undici Blob streams; encode only this fixture.
  const boundary = 'deletion-synthetic-upload';
  const response = await nativeFetch(origin + '/api/v1' + base + '/files', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
    },
    body: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="gpgpu.txt"\r\nContent-Type: text/plain\r\n\r\nsynthetic orphan bytes\r\n--${boundary}--\r\n`,
  });
  expect(response.status).toBe(201);
  return response.json();
}

it('populated lab confirmation lists the real closure and removes dependencies without a blocker notice', async () => {
  const f = await fixture();
  await req(f.base + '/teams', 'POST', { label: 'Dependent team' });
  const uploaded = await orphanUpload(f.base);
  const impact = await req(f.base + '/deletion-impact');
  await userEvent.click(deleteLab());
  const message = await confirmRemoval();
  await screen.findByText('Δεν υπάρχουν εργαστήρια ακόμη.');
  for (const d of impact.cascade_counts) expect(message).toContain(String(d.count));
  expect(message).toContain('Ομάδες: 1');
  expect(message).toContain('Αρχεία: 1');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(writes()).toEqual([{ path: deletePath(f.base), method: 'DELETE', status: 204 }]);
  expect(await readFile(resolve(state, 'blobs', uploaded.sha256), 'utf8')).toBe(
    'synthetic orphan bytes',
  );
});
it('changed closure after preview delivery requires a fresh manual confirmation and leaves UI intact', async () => {
  const f = await fixture();
  const paused = pause(f.path + '/deletion-impact', 'GET');
  await userEvent.click(deleteLab());
  await paused.reached;
  await req(f.base + '/teams', 'POST', { label: 'Concurrent dependent' });
  await act(async () => paused.release());
  await confirmRemoval();
  expect(await screen.findByRole('alert')).toHaveTextContent('νέα επιβεβαίωση');
  expect(writes()).toEqual([{ path: deletePath(f.path), method: 'DELETE', status: 409 }]);
  expect((await req(f.path)).id).toBe(f.lab.id);
  expect(screen.getByRole('heading', { name: f.lab.title })).toBeInTheDocument();
  await userEvent.click(deleteLab());
  const message = await confirmRemoval();
  await screen.findByText('Δεν υπάρχουν εργαστήρια ακόμη.');
  expect(window.confirm).not.toHaveBeenCalled();
  expect(writes().map((c) => c.status)).toEqual([409, 204]);
});

it('orphan-only lab deletes directly with metadata cleanup and unchanged blob bytes', async () => {
  const f = await fixture();
  const uploaded = await orphanUpload(f.base);
  expect(await req(f.base + '/deletion-impact')).toMatchObject({
    dependencies: [],
    unreferenced_files: [{ id: uploaded.id, filename: uploaded.filename }],
    unreferenced_files_total: 1,
  });
  calls.length = 0;
  await userEvent.click(deleteLab());
  const message = await confirmRemoval();
  await screen.findByText('Δεν υπάρχουν εργαστήρια ακόμη.');
  expect(writes()).toEqual([{ path: deletePath(f.base), method: 'DELETE', status: 204 }]);
  expect(calls).toContainEqual({ path: '/api/v1' + f.base, method: 'GET', status: 404 });
  const missing = await nativeFetch(origin + '/api/v1/files/' + uploaded.id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(missing.status).toBe(404);
  expect(await readFile(resolve(state, 'blobs', uploaded.sha256), 'utf8')).toBe(
    'synthetic orphan bytes',
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('deletes last lab only after exact GET404 and clears the route/sidebar', async () => {
  const f = await fixture();
  const paused = pause(f.path, 'GET');
  await userEvent.click(deleteLab());
  await confirmRemoval();
  await paused.reached;
  try {
    expect(screen.getByRole('heading', { name: f.lab.title, level: 1 })).toBeInTheDocument();
    expect(deleteLab()).toBeDisabled();
  } finally {
    paused.release();
  }
  await screen.findByText('Δεν υπάρχουν εργαστήρια ακόμη.');
  await waitFor(() => expect(window.location.hash).not.toContain(f.lab.id));
  expect(screen.queryByRole('button', { name: f.lab.title })).not.toBeInTheDocument();
  const deletion = calls.findIndex((c) => c.method === 'DELETE');
  expect(calls[deletion]).toEqual({
    path: deletePath(f.path),
    method: 'DELETE',
    status: 204,
  });
  expect(
    calls
      .slice(deletion + 1)
      .some((c) => c.path === '/api/v1' + f.path && c.method === 'GET' && c.status === 404),
  ).toBe(true);
});

it('lab deletion selects a real remaining lab and drops old team/exercise route state', async () => {
  const lab = await req('/labs', 'POST', { title: 'Εργαστήριο προς διαγραφή' });
  const remaining = await req('/labs', 'POST', { title: 'Νόμιμο υπόλοιπο' });
  const path = '/labs/' + lab.id;
  window.history.replaceState(null, '', '/#' + path + '/teams/obsolete/exercises/obsolete');
  render(<App />);
  await screen.findByRole('heading', { name: lab.title, level: 1 });
  await userEvent.click(deleteLab());
  await confirmRemoval();
  await screen.findByRole('heading', { name: remaining.title, level: 1 });
  expect(window.location.hash).toBe('#/labs/' + remaining.id + '/overview');
  expect(screen.queryByRole('button', { name: lab.title })).not.toBeInTheDocument();
});

it('exercise deletion closes its editor and refreshes count and active total', async () => {
  const f = await fixture(true);
  await req(f.base + '/exercises', 'POST', { title: 'Διατηρούμενη άσκηση', max_points: '2.75' });
  // The new row is deliberately added after load; reload after deletion must find it.
  await userEvent.click(screen.getByRole('button', { name: 'Επεξεργασία ' + f.ex.title }));
  expect(screen.getByRole('heading', { name: 'Επεξεργασία άσκησης' })).toBeInTheDocument();
  await userEvent.click(deleteExercise());
  await confirmRemoval();
  await screen.findByRole('heading', { name: 'Διατηρούμενη άσκηση' });
  expect(screen.queryByRole('heading', { name: 'Επεξεργασία άσκησης' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: f.ex.title })).not.toBeInTheDocument();
  expect(screen.getByText('2.75', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.getAllByText('1 από 1').length).toBeGreaterThan(0);
  expect(writes()).toEqual([{ path: deletePath(f.path), method: 'DELETE', status: 204 }]);
});

it('dirty refusal preserves the exercise draft and prevents destructive confirmation/write', async () => {
  const f = await fixture(true);
  await userEvent.click(screen.getByRole('button', { name: 'Επεξεργασία ' + f.ex.title }));
  await userEvent.type(screen.getByLabelText('Τίτλος'), ' αλλαγές');
  vi.mocked(window.confirm).mockReturnValue(false);
  await userEvent.click(deleteExercise());
  expect(window.confirm).toHaveBeenCalledTimes(1);
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('μη αποθηκευμένες'));
  expect(screen.getByLabelText('Τίτλος')).toHaveValue(f.ex.title + ' αλλαγές');
  expect(writes()).toEqual([]);
});

it('confirmed dirty removal freezes the draft, blocks repeated calls and rejects navigation while pending', async () => {
  const f = await fixture(true);
  const remaining = await req('/labs', 'POST', { title: 'Other lab' });
  await userEvent.click(screen.getByRole('button', { name: 'Επεξεργασία ' + f.ex.title }));
  await userEvent.type(screen.getByLabelText('Τίτλος'), ' αλλαγές');
  const paused = pause(f.path, 'DELETE');
  await userEvent.click(deleteExercise());
  await confirmRemoval();
  await paused.reached;
  try {
    expect(screen.getByLabelText('Τίτλος')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Αποθήκευση' })).toBeDisabled();
    expect(
      screen
        .getAllByRole('button', { name: 'Ακύρωση' })
        .every((button) => button.matches(':disabled')),
    ).toBe(true);
    expect(deleteExercise()).toBeDisabled();
    fireEvent.click(deleteExercise());
    fireEvent.click(screen.getByRole('button', { name: 'Επισκόπηση' }));
    const previous = window.location.hash;
    act(() => {
      window.location.hash = '#/labs/' + remaining.id + '/overview';
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(window.location.hash).toBe(previous);
    expect(writes()).toHaveLength(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
  } finally {
    paused.release();
  }
  await screen.findByText('Δεν έχουν οριστεί ασκήσεις. Η κλίμακα του εργαστηρίου είναι δική σας.');
  expect(window.location.hash).toContain(f.lab.id);
});

it.each([false, true])(
  'confirmed populated root removes dependent evidence instead of blocking (exercise=%s)',
  async (exercise) => {
    const f = await fixture(exercise);
    const x =
      f.ex ||
      (await req(f.base + '/exercises', 'POST', { title: 'Dependent exercise', max_points: '1' }));
    const team = await req(f.base + '/teams', 'POST', { label: 'Dependent synthetic team' });
    const ev = await req(f.base + '/teams/' + team.id + '/evidence', 'POST', {
      title: 'Evidence',
      kind: 'text',
      exercise_id: x.id,
      text: 'inert',
    });
    await userEvent.click(exercise ? deleteExercise() : deleteLab());
    const message = await confirmRemoval();
    if (exercise)
      await screen.findByText(
        'Δεν έχουν οριστεί ασκήσεις. Η κλίμακα του εργαστηρίου είναι δική σας.',
      );
    else await screen.findByText('Δεν υπάρχουν εργαστήρια ακόμη.');
    const absent = await nativeFetch(
      origin + '/api/v1' + f.base + '/teams/' + team.id + '/evidence/' + ev.id,
      { headers: { Authorization: 'Bearer ' + token } },
    );
    expect(absent.status).toBe(404);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(message).toContain('Τεκμήρια: 1');
    if (exercise) expect((await req(f.base + '/teams/' + team.id)).id).toBe(team.id);
  },
);

it.each([false, true])(
  'stale displayed revision409 leaves resource intact without automatic retry (exercise=%s)',
  async (exercise) => {
    const f = await fixture(exercise);
    await req(f.path, 'PATCH', { revision: 1, title: 'External revision' });
    await userEvent.click(exercise ? deleteExercise() : deleteLab());
    await confirmRemoval();
    expect(await screen.findByRole('alert')).toHaveTextContent(/έκδοση|τροποποι/i);
    expect((await req(f.path)).revision).toBe(2);
    expect(writes()).toEqual([{ path: deletePath(f.path), method: 'DELETE', status: 409 }]);
    expect(exercise ? deleteExercise() : deleteLab()).toBeEnabled();
  },
);

it.each(['unauthorized', 'network'])(
  'non404 verification %s is explicit and does not reset UI or discard draft',
  async (failure) => {
    const f = await fixture(true);
    await userEvent.click(screen.getByRole('button', { name: 'Επεξεργασία ' + f.ex.title }));
    await userEvent.type(screen.getByLabelText('Τίτλος'), ' διατηρείται');
    if (failure === 'unauthorized') deniedRead = '/api/v1' + f.path;
    else failedRead = '/api/v1' + f.path;
    await userEvent.click(deleteExercise());
    await confirmRemoval();
    expect(await screen.findByRole('alert')).toHaveTextContent('δεν επιβεβαιώθηκε');
    expect(screen.getByLabelText('Τίτλος')).toHaveValue(f.ex.title + ' διατηρείται');
    expect(screen.getByRole('heading', { name: f.ex.title })).toBeInTheDocument();
    expect(window.location.hash).toContain(f.lab.id);
    const persisted = await nativeFetch(origin + '/api/v1' + f.path, {
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(persisted.status).toBe(404);
  },
);

it('a pending save cannot race with exercise deletion', async () => {
  const f = await fixture(true);
  await userEvent.click(screen.getByRole('button', { name: 'Επεξεργασία ' + f.ex.title }));
  await userEvent.type(screen.getByLabelText('Τίτλος'), ' αποθηκεύεται');
  const paused = pause(f.path, 'PATCH');
  await userEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await paused.reached;
  try {
    await userEvent.click(deleteExercise());
    expect(writes().filter((c) => c.method === 'DELETE')).toEqual([]);
  } finally {
    paused.release();
  }
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
});

it('an actual cached GET200 is not a deletion verification', async () => {
  const f = await fixture(true);
  const response = await nativeFetch(origin + '/api/v1' + f.path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(response.status).toBe(200);
  staleRead = { path: '/api/v1' + f.path, response };
  await userEvent.click(deleteExercise());
  await confirmRemoval();
  expect(await screen.findByRole('alert')).toHaveTextContent('δεν επιβεβαιώθηκε');
  expect(screen.getByRole('heading', { name: f.ex.title })).toBeInTheDocument();
  const actual = await nativeFetch(origin + '/api/v1' + f.path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(actual.status).toBe(404);
});

it('cancel after accepting the dirty guard still preserves the draft and writes nothing', async () => {
  const f = await fixture(true);
  await userEvent.click(screen.getByRole('button', { name: 'Επεξεργασία ' + f.ex.title }));
  await userEvent.type(screen.getByLabelText('Τίτλος'), ' μη αποθηκευμένο');
  vi.mocked(window.confirm).mockReturnValueOnce(true);
  await userEvent.click(deleteExercise());
  await cancelRemoval();
  expect(window.confirm).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Τίτλος')).toHaveValue(f.ex.title + ' μη αποθηκευμένο');
  expect(writes()).toEqual([]);
});

it('verified exercise deletion preserves a different editor rather than resetting it', async () => {
  const f = await fixture(true);
  await userEvent.click(screen.getByRole('button', { name: 'Νέα άσκηση' }));
  await userEvent.type(screen.getByLabelText('Τίτλος'), 'Νέα μη αποθηκευμένη άσκηση');
  await userEvent.click(deleteExercise());
  await confirmRemoval();
  await screen.findByText('Δεν έχουν οριστεί ασκήσεις. Η κλίμακα του εργαστηρίου είναι δική σας.');
  expect(screen.getByLabelText('Τίτλος')).toHaveValue('Νέα μη αποθηκευμένη άσκηση');
});

it('delayed lab DELETE locks sidebar, settings and route until verified reconciliation', async () => {
  const f = await fixture();
  const paused = pause(f.path, 'DELETE');
  await userEvent.click(deleteLab());
  await confirmRemoval();
  await paused.reached;
  try {
    expect(deleteLab()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ρυθμίσεις εργαστηρίου' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Νέο εργαστήριο' })).toBeDisabled();
    expect(screen.getByRole('button', { name: f.lab.title })).toBeDisabled();
    fireEvent.click(deleteLab());
    expect(writes()).toHaveLength(1);
    const previous = window.location.hash;
    act(() => {
      window.location.hash = '#/labs/nonexistent/teams/other';
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(window.location.hash).toBe(previous);
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
  } finally {
    paused.release();
  }
  await screen.findByText('Δεν υπάρχουν εργαστήρια ακόμη.');
});

it('synchronous repeated clicks acquire one deletion lock before React renders', async () => {
  const f = await fixture();
  const paused = pause(f.path, 'DELETE');
  const button = deleteLab();
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  await confirmRemoval();
  await paused.reached;
  try {
    expect(writes()).toHaveLength(1);
    expect(window.confirm).not.toHaveBeenCalled();
  } finally {
    paused.release();
  }
  await screen.findByText('Δεν υπάρχουν εργαστήρια ακόμη.');
});

it('an old pending removal cannot invoke callbacks for a newly rendered target', async () => {
  const first = await req('/labs', 'POST', { title: 'Old synthetic target' });
  const second = await req('/labs', 'POST', { title: 'New synthetic target' });
  const oldRemoved = vi.fn();
  const newRemoved = vi.fn();
  const path = '/labs/' + first.id;
  const paused = pause(path, 'DELETE');
  const view = render(
    <Removal
      path={path}
      revision={1}
      title={first.title}
      kind="εργαστηρίου"
      onRemoved={oldRemoved}
    />,
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Διαγραφή εργαστηρίου ' + first.title }),
  );
  await confirmRemoval();
  await paused.reached;
  try {
    view.rerender(
      <Removal
        path={'/labs/' + second.id}
        revision={1}
        title={second.title}
        kind="εργαστηρίου"
        onRemoved={newRemoved}
      />,
    );
  } finally {
    paused.release();
  }
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Διαγραφή εργαστηρίου ' + second.title }),
    ).toBeEnabled(),
  );
  expect(oldRemoved).not.toHaveBeenCalled();
  expect(newRemoved).not.toHaveBeenCalled();
  expect((await req('/labs/' + second.id)).id).toBe(second.id);
  expect(
    calls.some((c) => c.path === '/api/v1' + path && c.method === 'GET' && c.status === 404),
  ).toBe(true);
});

it('unmounting a pending removal never resets another view', async () => {
  const lab = await req('/labs', 'POST', { title: 'Unmounted synthetic target' });
  const path = '/labs/' + lab.id;
  const removed = vi.fn();
  const paused = pause(path, 'DELETE');
  const view = render(
    <Removal path={path} revision={1} title={lab.title} kind="εργαστηρίου" onRemoved={removed} />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Διαγραφή εργαστηρίου ' + lab.title }));
  await confirmRemoval();
  await paused.reached;
  try {
    view.unmount();
  } finally {
    paused.release();
  }
  await waitFor(() =>
    expect(
      calls.some((c) => c.path === '/api/v1' + path && c.method === 'GET' && c.status === 404),
    ).toBe(true),
  );
  expect(removed).not.toHaveBeenCalled();
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
