// Real HTTP, ephemeral CLI and synthetic SQLite only. No live deployment.
import { confirmRemoval } from './removal-dialog-helpers';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

async function seed() {
  const lab = await req('/labs', 'POST', { title: 'Cascade UI lab' });
  const base = '/labs/' + lab.id;
  const exercise = await req(base + '/exercises', 'POST', {
    title: 'Cascade UI exercise',
    max_points: '3',
  });
  const team = await req(base + '/teams', 'POST', { label: 'Cascade UI team' });
  const teamPath = base + '/teams/' + team.id;
  async function upload(path: string, filename: string) {
    const boundary = 'cascade-synthetic-http';
    const r = await nativeFetch(origin + '/api/v1' + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
      },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\nsynthetic immutable upload bytes\r\n--${boundary}--\r\n`,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    return r.json();
  }
  const file = await upload(base + '/files', 'standalone.txt');
  const material = await req(base + '/materials', 'POST', {
    title: 'Cascade UI material',
    file_id: file.id,
    role: 'handout',
    exercise_id: exercise.id,
  });
  const submission = await upload(teamPath + '/submissions', 'version.zip');
  const evidence = await req(teamPath + '/evidence', 'POST', {
    title: 'Cascade UI evidence',
    kind: 'text',
    text: 'Independent evidence',
    exercise_id: exercise.id,
  });
  const linked = await req(teamPath + '/evidence', 'POST', {
    title: 'Linked evidence',
    kind: 'text',
    text: 'Submission evidence',
    exercise_id: exercise.id,
    submission_id: submission.id,
  });
  const assessmentPath = teamPath + '/assessments/' + exercise.id;
  let assessment;
  for (let revision = 0; revision < 2; revision++)
    assessment = await req(assessmentPath, 'PUT', {
      revision,
      rubric_revision: 1,
      score: '2',
      status: 'final',
      notes: 'Historical notes ' + revision,
      submission_id: submission.id,
    });
  return {
    lab,
    base,
    exercise,
    team,
    teamPath,
    file,
    material,
    submission,
    evidence,
    linked,
    assessment,
    assessmentPath,
  };
}
async function absent(path: string) {
  const r = await nativeFetch(origin + '/api/v1' + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(r.status, await r.clone().text()).toBe(404);
}

const writes = () => calls.filter((c) => c.method !== 'GET');
it.each(['material', 'evidence', 'submission', 'assessment', 'file'] as const)(
  'real UI %s cascade is confirmed, scoped and verified against actual HTTP',
  async (kind) => {
    const f = await seed();
    const paths = {
      material: f.base + '/materials/' + f.material.id,
      evidence: f.teamPath + '/evidence/' + f.evidence.id,
      submission: f.teamPath + '/submissions/' + f.submission.id,
      assessment: f.assessmentPath,
      file: f.base + '/files/' + f.file.id,
    };
    const globalPath =
      kind === 'submission'
        ? '/submissions/' + f.submission.id
        : kind === 'file'
          ? '/files/' + f.file.id
          : paths[kind];
    const label = {
      material: 'Διαγραφή υλικού Cascade UI material',
      evidence: 'Διαγραφή τεκμηρίου Cascade UI evidence',
      submission: 'Διαγραφή παράδοσης version.zip',
      assessment: 'Διαγραφή αξιολόγησης Cascade UI exercise',
      file: 'Διαγραφή αρχείου standalone.txt',
    }[kind];
    const route =
      kind === 'material' || kind === 'file'
        ? f.base + '/materials'
        : kind === 'submission'
          ? f.teamPath
          : f.teamPath + '/exercises/' + f.exercise.id;
    window.history.replaceState(null, '', '/#' + route);
    render(<App />);
    const button = await screen.findByRole('button', { name: label });
    expect(button.closest('.item-actions')).not.toBeNull();
    if (kind === 'submission') {
      await userEvent.click(
        screen.getByRole('button', { name: 'Επιλογή παράδοσης ' + f.submission.id }),
      );
      await screen.findByRole('heading', { name: 'Περιεχόμενα επιλεγμένης παράδοσης' });
    }
    if (kind === 'material' || kind === 'evidence') {
      await userEvent.click(
        within(button.closest('article')!).getByRole('button', {
          name: kind === 'material' ? 'Επεξεργασία υλικού' : 'Επεξεργασία τεκμηρίου',
        }),
      );
      await screen.findByLabelText(kind === 'material' ? 'Τίτλος υλικού' : 'Τίτλος τεκμηρίου');
    }
    const impact = await req(paths[kind] + '/deletion-impact');
    calls.length = 0;
    await userEvent.click(button);
    const message = await confirmRemoval();
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'GET' &&
            c.path === '/api/v1' + globalPath &&
            c.status === (kind === 'assessment' ? 200 : 404),
        ),
      ).toBe(true),
    );
    const revision =
      kind === 'material'
        ? f.material.revision
        : kind === 'evidence'
          ? f.evidence.revision
          : kind === 'assessment'
            ? f.assessment.revision
            : undefined;
    expect(writes()).toEqual([
      {
        path:
          '/api/v1' +
          paths[kind] +
          '?cascade=true&confirmation_token=' +
          impact.confirmation_token +
          (revision === undefined ? '' : '&revision=' + revision),
        method: 'DELETE',
        status: 204,
      },
    ]);
    expect(message).toContain('δεν αναιρείται');
    expect(window.confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    if (kind === 'assessment') {
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument(),
      );
      expect(await req(f.assessmentPath)).toMatchObject({
        id: null,
        revision: 0,
        score: null,
        status: 'ungraded',
      });
      expect(await req(f.assessmentPath + '/history')).toMatchObject({ total: 0, items: [] });
      expect(screen.getByLabelText('Βαθμός')).toHaveValue('');
      expect(screen.getByLabelText('Σημειώσεις άσκησης')).toHaveValue('');
      expect((await req(f.teamPath + '/evidence/' + f.evidence.id)).id).toBe(f.evidence.id);
      expect((await req(f.teamPath + '/evidence/' + f.linked.id)).id).toBe(f.linked.id);
    } else {
      await absent(globalPath);
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument(),
      );
    }
    if (kind === 'submission') {
      expect(
        screen.queryByRole('heading', { name: 'Περιεχόμενα επιλεγμένης παράδοσης' }),
      ).not.toBeInTheDocument();
      await absent(f.teamPath + '/evidence/' + f.linked.id);
      expect((await req(f.assessmentPath)).id).toBe(null);
      expect((await req(f.assessmentPath + '/history')).total).toBe(0);
    }
    if (kind === 'material' || kind === 'evidence')
      expect(
        screen.queryByLabelText(kind === 'material' ? 'Τίτλος υλικού' : 'Τίτλος τεκμηρίου'),
      ).not.toBeInTheDocument();
    if (kind === 'file') await absent(f.base + '/materials/' + f.material.id);
    expect((await req(f.base)).id).toBe(f.lab.id);
    expect((await req(f.teamPath)).id).toBe(f.team.id);
    expect((await req(f.base + '/exercises/' + f.exercise.id)).id).toBe(f.exercise.id);
    expect(await readFile(resolve(state, 'blobs', f.file.sha256), 'utf8')).toBe(
      'synthetic immutable upload bytes',
    );
  },
  15000,
);
