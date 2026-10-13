// Real HTTP and synthetic SQLite on an owned ephemeral CLI, never a deployment.
import { confirmRemoval } from './removal-dialog-helpers';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import App from '../App';
import Exercises from '../Exercises';
import { useState } from 'react';
import Removal from '../Removal';
import { OperationContext, useOperations } from '../OperationContext';
import { SaveForm } from '../ui';
import { api, json } from '../api';
import type { Exercise } from '../types';

const nativeFetch = globalThis.fetch;
let origin: string;
let token: string;
let server: ChildProcess;
let state: string;
let output = '';
const requests: { path: string; method: string }[] = [];
const responses: { path: string; method: string; status: number }[] = [];
type Gate = {
  path: string;
  method: string;
  arrived: () => void;
  wait: Promise<void>;
  release: () => void;
  parsed: () => void;
};
const gates: Gate[] = [];
let deniedRead: string | undefined;

beforeEach(async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  requests.length = responses.length = gates.length = 0;
  output = '';
  state = await mkdtemp(resolve(tmpdir(), 'catalog-removal-regression-'));
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
    if (i === 199) throw new Error('Own regression CLI readiness: ' + output);
    await new Promise((r) => setTimeout(r, 25));
  }
  token = (await readFile(resolve(state, 'operator-token'), 'utf8')).trim();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), origin);
    const path = url.pathname + url.search;
    const method = init?.method || 'GET';
    requests.push({ path, method }); // Observe initiation before any network await.
    const headers = new Headers(init?.headers);
    headers.set(
      'Authorization',
      'Bearer ' +
        (method === 'GET' && deniedRead === url.pathname ? 'invalid-synthetic-token' : token),
    );
    const index = gates.findIndex(
      (g) =>
        (g.path === path || (method === 'DELETE' && path.startsWith(g.path + '?'))) &&
        g.method === method,
    );
    const gate = index < 0 ? undefined : gates.splice(index, 1)[0];
    const response = await nativeFetch(url.href, { ...init, headers });
    responses.push({ path, method, status: response.status });
    if (gate) {
      const text = response.text.bind(response);
      response.text = async () => {
        try {
          return await text();
        } finally {
          gate.parsed();
        }
      };
      gate.arrived();
      await gate.wait;
    }
    return response;
  };
}, 15000);

afterEach(async () => {
  cleanup();
  gates.forEach((g) => g.release());
  deniedRead = undefined;
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
function pause(path: string, method: string) {
  let release!: () => void;
  let arrived!: () => void;
  let parsed!: () => void;
  const reached = new Promise<void>((r) => (arrived = r));
  const delivered = new Promise<void>((r) => (parsed = r));
  gates.push({
    path: '/api/v1' + path,
    method,
    arrived,
    parsed,
    wait: new Promise<void>((r) => (release = r)),
    release,
  });
  return { release, reached, delivered };
}
async function fixture(standalone = false) {
  const lab = await req('/labs', 'POST', { title: 'Regression lab' });
  const base = '/labs/' + lab.id;
  const ex = await req(base + '/exercises', 'POST', {
    title: 'Regression exercise',
    max_points: '3.25',
  });
  window.history.replaceState(null, '', '/#' + base + '/exercises');
  const view = render(standalone ? <Exercises labId={lab.id} /> : <App />);
  await screen.findByRole('heading', { name: ex.title, level: 3 });
  return { lab, base, ex, path: base + '/exercises/' + ex.id, view };
}
const deleteExercise = () =>
  screen.getByRole('button', { name: 'Διαγραφή άσκησης Regression exercise' });
const saveButton = () => screen.getByRole('button', { name: 'Αποθήκευση' });
const writes = () => requests.filter((c) => c.method !== 'GET');
async function edit(f: Awaited<ReturnType<typeof fixture>>) {
  await userEvent.click(screen.getByRole('button', { name: 'Επεξεργασία ' + f.ex.title }));
  await userEvent.type(screen.getByLabelText('Τίτλος'), ' saved');
}

it('refresh after verified removal transfers pagination busy ownership and rejects obsolete rows', async () => {
  const lab = await req('/labs', 'POST', { title: 'Regression lab' });
  const base = '/labs/' + lab.id;
  const ex = await req(base + '/exercises', 'POST', {
    title: 'Regression exercise',
    max_points: '3.25',
    position: 0,
  });
  for (let i = 0; i < 101; i++) {
    await req(base + '/exercises', 'POST', {
      title: 'Pagination row ' + i,
      max_points: '1',
      position: i + 1,
    });
  }
  window.history.replaceState(null, '', '/#' + base + '/exercises');
  render(<App />);
  await screen.findByRole('heading', { name: ex.title, level: 3 });
  expect(screen.getByText('100 από 102')).toBeInTheDocument();
  const old = pause(base + '/exercises?limit=100&offset=100', 'GET');
  await userEvent.click(screen.getByRole('button', { name: 'Περισσότερα' }));
  await old.reached;
  let fresh: ReturnType<typeof pause> | undefined;
  try {
    await userEvent.click(deleteExercise());
    await confirmRemoval();
    await screen.findByText('100 από 101');
    expect(screen.queryByRole('heading', { name: ex.title })).not.toBeInTheDocument();
    expect(responses).toContainEqual({
      path: deletePath(base + '/exercises/' + ex.id),
      method: 'DELETE',
      status: 204,
    });
    expect(responses).toContainEqual({
      path: '/api/v1' + base + '/exercises/' + ex.id,
      method: 'GET',
      status: 404,
    });
    await waitFor(() =>
      expect(screen.getByText('100 από 101').parentElement!.querySelector('button')).toBeEnabled(),
    );
    fresh = pause(base + '/exercises?limit=100&offset=100', 'GET');
    await userEvent.click(screen.getByRole('button', { name: 'Περισσότερα' }));
    await fresh.reached;
    await act(async () => {
      old.release();
      await old.delivered;
    });
    // Old completion must neither append its two rows nor unlock the fresh request.
    expect(screen.getByText('100 από 101').parentElement!.querySelector('button')).toBeDisabled();
    expect(screen.queryByRole('heading', { name: 'Pagination row 100' })).not.toBeInTheDocument();
    await act(async () => {
      fresh!.release();
      await fresh!.delivered;
    });
    await screen.findByText('101 από 101');
    expect(screen.getAllByRole('heading', { name: 'Pagination row 99' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'Pagination row 100' })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: ex.title })).not.toBeInTheDocument();
    expect(requests.filter((c) => c.path.endsWith('offset=100'))).toHaveLength(2);
  } finally {
    old.release();
    fresh?.release();
  }
}, 30000);

it.each([false, true])(
  'same-batch save then removal starts only PATCH (standalone=%s)',
  async (standalone) => {
    const f = await fixture(standalone);
    await edit(f);
    const paused = pause(f.path, 'PATCH');
    act(() => {
      fireEvent.click(saveButton());
      fireEvent.click(deleteExercise());
    });
    await paused.reached;
    try {
      expect(writes()).toEqual([{ path: '/api/v1' + f.path, method: 'PATCH' }]);
      expect(window.confirm).not.toHaveBeenCalled();
    } finally {
      paused.release();
    }
    await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
    expect((await req(f.path)).title).toBe(f.ex.title + ' saved');
  },
);

it.each([false, true])(
  'same-batch removal then submit starts only DELETE (standalone=%s)',
  async (standalone) => {
    const f = await fixture(standalone);
    await edit(f);
    const form = saveButton().closest('form')!;
    const paused = pause(f.path, 'DELETE');
    act(() => {
      fireEvent.click(deleteExercise());
      fireEvent.submit(form);
    });
    await confirmRemoval();
    await paused.reached;
    try {
      expect(writes()).toEqual([{ path: deletePath(f.path), method: 'DELETE' }]);
      expect(screen.getByLabelText('Τίτλος')).toHaveValue(f.ex.title + ' saved');
      expect(screen.getByLabelText('Τίτλος')).toBeDisabled();
    } finally {
      paused.release();
    }
    await screen.findByText(
      'Δεν έχουν οριστεί ασκήσεις. Η κλίμακα του εργαστηρίου είναι δική σας.',
    );
    expect(responses).toContainEqual({ path: '/api/v1' + f.path, method: 'GET', status: 404 });
  },
);

it('repeated synchronous submits start just one save and verification', async () => {
  const f = await fixture();
  await edit(f);
  const form = saveButton().closest('form')!;
  const paused = pause(f.path, 'PATCH');
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  await paused.reached;
  try {
    expect(writes()).toEqual([{ path: '/api/v1' + f.path, method: 'PATCH' }]);
  } finally {
    paused.release();
  }
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
});

it('validation refusal releases save ownership so removal remains usable', async () => {
  const f = await fixture();
  await edit(f);
  fireEvent.change(screen.getByLabelText('Τίτλος'), { target: { value: '' } });
  fireEvent.submit(saveButton().closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('Συμπληρώστε τίτλο.');
  expect(writes()).toEqual([]);
  await userEvent.click(deleteExercise());
  await confirmRemoval();
  await screen.findByText('Δεν έχουν οριστεί ασκήσεις. Η κλίμακα του εργαστηρίου είναι δική σας.');
});

it.each(['conflict', 'verification'])(
  'failed save releases ownership and preserves the draft (%s)',
  async (failure) => {
    const f = await fixture();
    await edit(f);
    if (failure === 'conflict')
      await req(f.path, 'PATCH', { revision: 1, title: 'External change' });
    else deniedRead = '/api/v1' + f.path;
    await userEvent.click(saveButton());
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Τίτλος')).toHaveValue(f.ex.title + ' saved');
    expect(saveButton()).toBeEnabled();
    deniedRead = undefined;
    const paused = pause(f.path, 'DELETE');
    await userEvent.click(deleteExercise());
    await confirmRemoval();
    await paused.reached;
    try {
      expect(writes().map((c) => c.method)).toEqual(['PATCH', 'DELETE']);
    } finally {
      paused.release();
    }
    await waitFor(() =>
      expect(
        screen.getAllByRole('alert').some((node) => node.textContent?.includes('έκδοση')),
      ).toBe(true),
    );
  },
);

it('unmounted save releases shared ownership only after its request settles', async () => {
  const f = await fixture();
  f.view.unmount();
  const onSaved = vi.fn();
  function Owner() {
    const removal = useOperations();
    const [show, setShow] = useState(true);
    return (
      <OperationContext.Provider value={removal}>
        <button onClick={() => setShow(false)}>Unmount editor</button>
        {show && (
          <SaveForm<Exercise>
            title="Unmounted editor"
            initial={f.ex}
            save={(d) => api(f.path, json('PATCH', { title: d.title, revision: d.revision }))}
            read={() => api<Exercise>(f.path)}
            onSaved={onSaved}
          >
            {(d, set) => (
              <input
                aria-label="Draft"
                value={d.title}
                onChange={(e) => set({ title: e.target.value })}
              />
            )}
          </SaveForm>
        )}
        <Removal path={f.path} revision={1} title={f.ex.title} kind="άσκησης" onRemoved={vi.fn()} />
      </OperationContext.Provider>
    );
  }
  render(<Owner />);
  const paused = pause(f.path, 'PATCH');
  await userEvent.click(saveButton());
  await paused.reached;
  const verification = pause(f.path, 'GET');
  try {
    await userEvent.click(screen.getByRole('button', { name: 'Unmount editor' }));
    await userEvent.click(deleteExercise());
    expect(writes().map((c) => c.method)).toEqual(['PATCH']);
    paused.release();
    await verification.reached;
    await act(async () => {
      verification.release();
      await verification.delivered;
    });
  } finally {
    paused.release();
    verification.release();
  }
  await userEvent.click(deleteExercise());
  await confirmRemoval();
  expect(await screen.findByRole('alert')).toHaveTextContent('έκδοση');
  expect(writes().map((c) => c.method)).toEqual(['PATCH', 'DELETE']);
  expect(onSaved).not.toHaveBeenCalled();
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
