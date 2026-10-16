// Synthetic-only real CLI / SQLite / blob regressions, adapted from quality gate.
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, afterAll, beforeAll, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import EvidenceList from '../Evidence';
import { parseJSON, stringifyJSON } from '../resultJSON';
import Materials from '../Materials';
import AssessmentView from '../Assessment';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Submissions from '../Submissions';
let origin: string;
let token: string;
let server: ChildProcess;
let state: string;
let serverOutput = '';

const nativeFetch = globalThis.fetch;
const calls: { url: string; method: string; body?: string; status: number }[] = [];
let uploadGate: { arrived: () => void; wait: Promise<void> } | undefined;
const observations: unknown[] = [];
beforeAll(async () => {
  const project = resolve(process.cwd(), '..');
  state = await mkdtemp(resolve(tmpdir(), 'frontend-quality-'));
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  origin = `http://127.0.0.1:${port}`;
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
  server.stdout!.on('data', (c) => (serverOutput += String(c)));
  server.stderr!.on('data', (c) => (serverOutput += String(c)));
  for (let i = 0; i < 200; i++) {
    if (server.exitCode !== null) throw new Error(serverOutput);
    try {
      if ((await nativeFetch(origin + '/health')).ok) break;
    } catch {}
    if (i === 199) throw new Error('Own CLI readiness: ' + serverOutput);
    await new Promise((r) => setTimeout(r, 25));
  }
  token = (await readFile(resolve(state, 'operator-token'), 'utf8')).trim();
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = new URL(String(input), origin).href;
    const headers = new Headers(init?.headers);
    headers.set('Authorization', 'Bearer ' + token);
    // Every response is actual native HTTP from the isolated CLI. Only delivery
    // of an already-real upload response can be paused to reproduce slow networks.
    let body = init?.body;
    if (body instanceof FormData) {
      const boundary = 'quality-synthetic-boundary';
      const chunks: Uint8Array[] = [];
      const encoder = new TextEncoder();
      for (const [key, value] of body.entries()) {
        if (typeof value === 'string') {
          chunks.push(
            encoder.encode(
              `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
            ),
          );
        } else {
          const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = reject;
            reader.readAsArrayBuffer(value);
          });
          chunks.push(
            encoder.encode(
              `--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${value.name}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`,
            ),
          );
          chunks.push(new Uint8Array(bytes));
          chunks.push(encoder.encode('\r\n'));
        }
      }
      chunks.push(encoder.encode(`--${boundary}--\r\n`));
      const output = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let pos = 0;
      for (const c of chunks) {
        output.set(c, pos);
        pos += c.length;
      }
      body = output;
      headers.set('Content-Type', 'multipart/form-data; boundary=' + boundary);
    }
    const response = await nativeFetch(url, { ...init, body, headers });
    calls.push({
      url,
      method: init?.method || 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      status: response.status,
    });
    if (
      uploadGate &&
      init?.method === 'POST' &&
      (url.endsWith('/files') || url.endsWith('/submissions'))
    ) {
      const gate = uploadGate;
      uploadGate = undefined;
      gate.arrived();
      await gate.wait;
    }
    return response;
  };
});
afterEach(() => {
  cleanup();
  uploadGate = undefined;
});
afterAll(async () => {
  console.info('Real persisted quality readbacks:', JSON.stringify(observations));
  globalThis.fetch = nativeFetch;
  if (server && server.exitCode === null) {
    const ended = new Promise<void>((r) => server.once('exit', () => r()));
    server.kill('SIGTERM');
    await ended;
  }
  if (state) await rm(state, { recursive: true, force: true });
});
async function req(path: string, method = 'GET', data?: unknown) {
  const r = await fetch('/api/v1' + path, {
    method,
    ...(data === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
  expect(r.ok, await r.clone().text()).toBe(true);
  return r.status === 204 ? undefined : r.json();
}
async function fixture() {
  const lab = await req('/labs', 'POST', { title: 'Synthetic quality UI' });
  const b = '/labs/' + lab.id;
  const team = await req(b + '/teams', 'POST', { label: 'Synthetic' });
  const ex = await req(b + '/exercises', 'POST', { title: 'Synthetic exercise', max_points: '1' });
  return { lab, team, ex, b, ep: b + '/teams/' + team.id + '/evidence' };
}
it('edits a result human comment in its own card and preserves exact JSON through real PATCH/readback/list refresh', async () => {
  const f = await fixture();
  await req(f.ep, 'POST', {
    exercise_id: f.ex.id,
    title: 'Earlier evidence',
    kind: 'text',
    text: 'Earlier',
  });
  const raw = `{"exercise_id":"${f.ex.id}","title":"Last result comment","kind":"result","text":"Human explanation","source":"agent","data":{"counter":9007199254740993}}`;
  const createdResponse = await fetch('/api/v1' + f.ep, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw,
  });
  expect(createdResponse.status).toBe(201);
  const created = await createdResponse.json();
  render(
    <EvidenceList labId={f.lab.id} teamId={f.team.id} exerciseId={f.ex.id} submissions={[]} />,
  );
  const heading = await screen.findByRole('heading', { name: 'Last result comment' });
  const card = heading.closest('article')!;
  expect(within(card).getByText('Human explanation')).toBeVisible();
  const rawDetails = within(card).getByText('Δεδομένα αποτελέσματος (JSON)').closest('details')!;
  expect(rawDetails).not.toHaveAttribute('open');
  expect(rawDetails.querySelector('pre')!.textContent).toContain('9007199254740993');
  const user = userEvent.setup();
  await user.click(within(card).getByRole('button', { name: 'Επεξεργασία τεκμηρίου' }));
  const input = await screen.findByLabelText('Κείμενο τεκμηρίου');
  expect(card).toContainElement(input);
  expect(within(card).getByLabelText('Τίτλος τεκμηρίου')).toHaveFocus();
  await user.clear(input);
  await user.type(input, 'Human correction');
  await user.selectOptions(screen.getByLabelText('Προέλευση τεκμηρίου'), 'human');
  await user.click(within(card).getByRole('button', { name: 'Αποθήκευση' }));
  await within(card).findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  await within(card).findByText('Human correction');
  expect(screen.getByLabelText('Κείμενο τεκμηρίου')).toBe(input);
  expect(input).toHaveValue('Human correction');
  const persisted = await (await fetch('/api/v1' + f.ep + '/' + created.id)).text();
  expect(persisted).toContain('9007199254740993');
  expect(JSON.parse(persisted).text).toBe('Human correction');
  expect(JSON.parse(persisted).source).toBe('human');
  const sent = JSON.parse(calls.filter((c) => c.method === 'PATCH').at(-1)!.body!);
  expect(sent).not.toHaveProperty('data');
  expect(sent.text).toBe('Human correction');
  // A second save can intentionally restore both original values; compare
  // against the latest verified baseline, not the original mount props.
  await user.clear(input);
  await user.type(input, 'Human explanation');
  await user.selectOptions(screen.getByLabelText('Προέλευση τεκμηρίου'), 'agent');
  await user.click(within(card).getByRole('button', { name: 'Αποθήκευση' }));
  await within(card).findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  const restored = await (await fetch('/api/v1' + f.ep + '/' + created.id)).text();
  expect(JSON.parse(restored).source).toBe('agent');
  expect(JSON.parse(restored).text).toBe('Human explanation');
  expect(restored).toContain('9007199254740993');
  expect(JSON.parse(calls.filter((c) => c.method === 'PATCH').at(-1)!.body!)).not.toHaveProperty(
    'data',
  );
}, 20000);
it('metadata-only result title correction must not silently rewrite a large integer in stored evidence', async () => {
  const f = await fixture();
  const originalRaw = `{"exercise_id":"${f.ex.id}","title":"Original result","kind":"result","data":{"counter":9007199254740993}}`;
  const create = await fetch('/api/v1' + f.ep, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: originalRaw,
  });
  expect(create.status).toBe(201);
  const created = await create.json();
  const before = await (await fetch('/api/v1' + f.ep + '/' + created.id)).text();
  expect(before).toContain('9007199254740993');
  render(
    <EvidenceList labId={f.lab.id} teamId={f.team.id} exerciseId={f.ex.id} submissions={[]} />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Επεξεργασία τεκμηρίου' }));
  await user.clear(await screen.findByLabelText('Τίτλος τεκμηρίου'));
  await user.type(screen.getByLabelText('Τίτλος τεκμηρίου'), 'Title corrected only');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  const after = await (await fetch('/api/v1' + f.ep + '/' + created.id)).text();
  observations.push({
    case: 'metadata-only title edit',
    before,
    after,
    patch: calls.filter((c) => c.method === 'PATCH').at(-1),
  });
  expect(after).toContain('9007199254740993');
  expect(JSON.parse(calls.filter((c) => c.method === 'PATCH').at(-1)!.body!)).not.toHaveProperty(
    'data',
  );
}, 20000);
it('choosing a replacement material file during a real pending upload must not save the old file as the new selection', async () => {
  const f = await fixture();
  render(<Materials labId={f.lab.id} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Νέο υλικό' }));
  await user.type(screen.getByLabelText('Τίτλος υλικού'), 'Synthetic document');
  const input = screen.getByLabelText('Αρχείο υλικού') as HTMLInputElement;
  await user.upload(input, new File(['old synthetic bytes'], 'old.txt', { type: 'text/plain' }));
  let release!: () => void;
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  uploadGate = { arrived, wait: new Promise<void>((resolve) => (release = resolve)) };
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση υλικού' }));
  await reached;
  // This would be safe if the form disabled selection while busy. If it accepts
  // the selection instead, the saved record must correspond to that selection.
  await user.upload(
    input,
    new File(['replacement synthetic bytes'], 'new.txt', { type: 'text/plain' }),
  );
  const acceptedNewSelection = input.files?.[0]?.name === 'new.txt';
  observations.push({
    case: 'file selection pending upload',
    effectivelyDisabled: input.matches(':disabled'),
    acceptedNewSelection,
  });
  try {
    for (const label of [
      'Τίτλος υλικού',
      'Περιγραφή υλικού',
      'Ρόλος υλικού',
      'Σχετική άσκηση',
      'Αρχείο υλικού',
    ])
      expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ακύρωση υλικού' })).toBeDisabled();
  } finally {
    release();
  }
  await screen.findByText('Το υλικό αποθηκεύτηκε και επιβεβαιώθηκε.');
  const saved = (await req(f.b + '/materials')).items[0];
  const file = await req('/files/' + saved.file_id);
  observations.push({
    case: 'file selection actual saved record',
    filename: file.filename,
    file_id: file.id,
    material: saved,
  });
  expect(!acceptedNewSelection || file.filename === 'new.txt').toBe(true);
  expect(await (await fetch('/api/v1/files/' + saved.file_id + '/download')).text()).toBe(
    'old synthetic bytes',
  );
}, 20000);
it('literal criterion IDs inherited from Object.prototype must permit saving an empty notes-only draft', async () => {
  const f = await fixture();
  const ex = await req(f.b + '/exercises', 'POST', {
    title: 'Literal criterion',
    max_points: '3',
    grading_mode: 'criteria',
    criteria: ['constructor', 'toString', '__proto__'].map((id) => ({
      id,
      label: 'Literal ' + id,
      max_points: '1',
    })),
  });
  render(<AssessmentView labId={f.lab.id} teamId={f.team.id} exercise={ex} submissions={[]} />);
  const user = userEvent.setup();
  await screen.findByLabelText('Σημειώσεις άσκησης');
  for (const id of ['constructor', 'toString', '__proto__'])
    expect(screen.getByLabelText('Literal ' + id + ' · βαθμός')).toHaveValue('');
  await user.type(screen.getByLabelText('Σημειώσεις άσκησης'), 'Notes only');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  const gp = f.b + '/teams/' + f.team.id + '/assessments/' + ex.id;
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  const state = await req(gp);
  observations.push({
    case: 'literal constructor criterion notes',
    status: screen.getByText('Αποθηκεύτηκε και επιβεβαιώθηκε.').textContent,
    state,
  });
  expect(state.notes).toBe('Notes only');
  expect(state.score).toBeNull();
  expect(state.criterion_scores).toEqual({});
  for (const key of ['constructor', 'toString', '__proto__'])
    await user.type(screen.getByLabelText('Literal ' + key + ' · βαθμός'), '1');
  await user.selectOptions(screen.getByLabelText('Κατάσταση αξιολόγησης'), 'final');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  const graded = await req(gp);
  expect(graded.score).toBe('3');
  expect(Object.keys(graded.criterion_scores)).toEqual(['constructor', 'toString', '__proto__']);
  for (const key of ['constructor', 'toString', '__proto__'])
    expect(screen.getByLabelText('Literal ' + key + ' · βαθμός')).toHaveValue('1');
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  cleanup();
  const lowered = await req(f.b + '/exercises/' + ex.id, 'PATCH', {
    revision: ex.revision,
    max_points: '1.5',
    criteria: ex.criteria.map((c: any) => ({ ...c, max_points: '0.5' })),
  });
  render(
    <AssessmentView labId={f.lab.id} teamId={f.team.id} exercise={lowered} submissions={[]} />,
  );
  await user.type(await screen.findByLabelText('Σημειώσεις άσκησης'), ' retained stale notes');
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  const stale = await req(gp);
  expect(stale.score).toBe('3');
  expect(stale.rubric_stale).toBe(true);
  expect(stale.criterion_scores).toEqual(graded.criterion_scores);
  expect(stale.notes).toContain('retained stale notes');
}, 20000);

it('creates and intentionally edits result integers without rounding in raw persisted HTTP bodies', async () => {
  const f = await fixture();
  const user = userEvent.setup();
  render(
    <EvidenceList labId={f.lab.id} teamId={f.team.id} exerciseId={f.ex.id} submissions={[]} />,
  );
  await user.click(await screen.findByRole('button', { name: 'Νέο τεκμήριο' }));
  await user.type(screen.getByLabelText('Τίτλος τεκμηρίου'), 'Exact result');
  await user.selectOptions(screen.getByLabelText('Είδος τεκμηρίου'), 'result');
  const data = '{"counter":9007199254740993,"nested":[-9007199254740993,42,0.5]}';
  await user.type(
    screen.getByLabelText('Αποτέλεσμα JSON'),
    data.replaceAll('{', '{{').replaceAll('[', '[['),
  );
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση τεκμηρίου' }));
  await screen.findByText('Το τεκμήριο αποθηκεύτηκε και επιβεβαιώθηκε.');
  const saved = (await req(f.ep)).items[0];
  const before = await (await fetch('/api/v1' + f.ep + '/' + saved.id)).text();
  expect(before).toContain('9007199254740993');
  expect(
    calls.filter((c) => c.method === 'POST' && c.url.endsWith('/evidence')).at(-1)!.body,
  ).toContain('9007199254740993');
  await user.click(await screen.findByRole('button', { name: 'Επεξεργασία τεκμηρίου' }));
  expect(await screen.findByLabelText('Αποτέλεσμα JSON')).toHaveValue(
    '{\n  "counter": 9007199254740993,\n  "nested": [\n    -9007199254740993,\n    42,\n    0.5\n  ]\n}',
  );
  await user.clear(screen.getByLabelText('Αποτέλεσμα JSON'));
  const edited = '{"counter":9007199254740995,"nested":[-9007199254740993,42,0.5]}';
  await user.type(
    screen.getByLabelText('Αποτέλεσμα JSON'),
    edited.replaceAll('{', '{{').replaceAll('[', '[['),
  );
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  const after = await (await fetch('/api/v1' + f.ep + '/' + saved.id)).text();
  observations.push({ case: 'intentional result create/edit', before, after });
  expect(after).toContain('9007199254740995');
  expect(after).toContain('-9007199254740993');
  expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body).toContain('9007199254740995');
}, 20000);

it('preserves an incoming large integer in read-only display and the result editor', async () => {
  const f = await fixture();
  const raw = `{"exercise_id":"${f.ex.id}","title":"Display exact","kind":"result","data":{"counter":9007199254740993}}`;
  expect(
    (
      await fetch('/api/v1' + f.ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      })
    ).ok,
  ).toBe(true);
  render(
    <EvidenceList labId={f.lab.id} teamId={f.team.id} exerciseId={f.ex.id} submissions={[]} />,
  );
  await screen.findByRole('button', { name: 'Επεξεργασία τεκμηρίου' });
  expect(document.querySelector('pre')!.textContent).toContain('9007199254740993');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Επεξεργασία τεκμηρίου' }));
  expect(
    ((await screen.findByLabelText('Αποτέλεσμα JSON')) as HTMLTextAreaElement).value,
  ).toContain('9007199254740993');
});

for (const mode of ['create', 'edit'] as const)
  for (const data of [
    '{"__proto__":9007199254740993,"__proto__":42}',
    '{"a":1,"a":1,"b":2,"b":2}',
    String.raw`{"nested":[{"a":1,"\u0061":1}]}`,
  ])
    it(`rejects duplicate result keys before any ${mode} write: ${data}`, async () => {
      const f = await fixture();
      const user = userEvent.setup();
      const original =
        mode === 'edit'
          ? await req(f.ep, 'POST', {
              exercise_id: f.ex.id,
              title: 'Existing result',
              kind: 'result',
              data: { n: 42, source: '9007199254740993' },
            })
          : undefined;
      const before = original
        ? await (await fetch('/api/v1' + f.ep + '/' + original.id)).text()
        : undefined;
      const direct = await fetch('/api/v1' + f.ep + (original ? '/' + original.id : ''), {
        method: original ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: original
          ? `{"revision":${original.revision},"data":${data}}`
          : `{"exercise_id":"${f.ex.id}","title":"Raw duplicate","kind":"result","data":${data}}`,
      });
      expect(direct.status).toBe(422);
      render(
        <EvidenceList labId={f.lab.id} teamId={f.team.id} exerciseId={f.ex.id} submissions={[]} />,
      );
      await user.click(
        await screen.findByRole('button', {
          name: mode === 'create' ? 'Νέο τεκμήριο' : 'Επεξεργασία τεκμηρίου',
        }),
      );
      if (mode === 'create') {
        await user.type(screen.getByLabelText('Τίτλος τεκμηρίου'), 'Duplicate draft');
        await user.selectOptions(screen.getByLabelText('Είδος τεκμηρίου'), 'result');
      }
      const input = await screen.findByLabelText('Αποτέλεσμα JSON');
      await user.clear(input);
      await user.type(input, data.replaceAll('{', '{{').replaceAll('[', '[['));
      const start = calls.length;
      await user.click(
        screen.getByRole('button', {
          name: mode === 'create' ? 'Αποθήκευση τεκμηρίου' : 'Αποθήκευση',
        }),
      );
      // Wait for either outcome so RED reports the integrity failure, not a timeout.
      await waitFor(() =>
        expect(
          screen.queryByRole('alert') ||
            screen.queryByText(
              mode === 'create'
                ? 'Το τεκμήριο αποθηκεύτηκε και επιβεβαιώθηκε.'
                : 'Αποθηκεύτηκε και επιβεβαιώθηκε.',
            ),
        ).toBeTruthy(),
      );
      const writes = calls.slice(start).filter((c) => ['POST', 'PATCH'].includes(c.method));
      const persisted = (await req(f.ep)).items;
      const after = original
        ? await (await fetch('/api/v1' + f.ep + '/' + original.id)).text()
        : undefined;
      observations.push({
        case: 'duplicate result ' + mode,
        input: data,
        directHTTPStatus: direct.status,
        writes,
        before,
        after,
      });
      expect(writes).toHaveLength(0);
      expect(screen.getByRole('alert')).toHaveTextContent(/διπλά κλειδιά/);
      expect(input).toHaveValue(data);
      expect(persisted).toHaveLength(mode === 'create' ? 0 : 1);
      if (original) {
        expect(after).toBe(before);
        expect(persisted[0].revision).toBe(original.revision);
        expect(persisted[0].data).toEqual(original.data);
      }
    }, 20000);

function deferUpload() {
  let release!: () => void;
  let arrived!: () => void;
  const reached = new Promise<void>((r) => (arrived = r));
  uploadGate = { arrived, wait: new Promise<void>((r) => (release = r)) };
  return { reached, release };
}
for (const mode of ['create', 'edit'] as const)
  it(`rejects unsupported decimal precision before any ${mode} write`, async () => {
    const f = await fixture();
    const user = userEvent.setup();
    if (mode === 'edit')
      await req(f.ep, 'POST', {
        exercise_id: f.ex.id,
        title: 'Existing result',
        kind: 'result',
        data: { n: 1 },
      });
    render(
      <EvidenceList labId={f.lab.id} teamId={f.team.id} exerciseId={f.ex.id} submissions={[]} />,
    );
    await user.click(
      await screen.findByRole('button', {
        name: mode === 'create' ? 'Νέο τεκμήριο' : 'Επεξεργασία τεκμηρίου',
      }),
    );
    if (mode === 'create') {
      await user.type(screen.getByLabelText('Τίτλος τεκμηρίου'), 'Precision draft');
      await user.selectOptions(screen.getByLabelText('Είδος τεκμηρίου'), 'result');
    }
    const input = await screen.findByLabelText('Αποτέλεσμα JSON');
    await user.clear(input);
    await user.type(input, '{{"n":0.1234567890123456789}');
    const start = calls.length;
    await user.click(
      screen.getByRole('button', {
        name: mode === 'create' ? 'Αποθήκευση τεκμηρίου' : 'Αποθήκευση',
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/ακρίβεια/);
    expect(calls.slice(start).filter((c) => ['POST', 'PATCH'].includes(c.method))).toHaveLength(0);
    expect(input).toHaveValue('{"n":0.1234567890123456789}');
    const persisted = (await req(f.ep)).items;
    expect(persisted).toHaveLength(mode === 'create' ? 0 : 1);
    if (mode === 'edit') expect(persisted[0].data).toEqual({ n: 1 });
  }, 20000);
it('freezes evidence file selection, metadata, association and cancel during a real upload', async () => {
  const f = await fixture();
  const user = userEvent.setup();
  render(
    <EvidenceList labId={f.lab.id} teamId={f.team.id} exerciseId={f.ex.id} submissions={[]} />,
  );
  await user.click(await screen.findByRole('button', { name: 'Νέο τεκμήριο' }));
  await user.type(screen.getByLabelText('Τίτλος τεκμηρίου'), 'Old evidence');
  await user.selectOptions(screen.getByLabelText('Είδος τεκμηρίου'), 'file');
  const input = screen.getByLabelText('Αρχείο τεκμηρίου') as HTMLInputElement;
  await user.upload(input, new File(['old evidence bytes'], 'old.txt'));
  const gate = deferUpload();
  await user.click(screen.getByRole('button', { name: 'Αποθήκευση τεκμηρίου' }));
  await gate.reached;
  try {
    for (const label of [
      'Αρχείο τεκμηρίου',
      'Τίτλος τεκμηρίου',
      'Είδος τεκμηρίου',
      'Παράδοση τεκμηρίου',
    ])
      expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ακύρωση τεκμηρίου' })).toBeDisabled();
    await user.upload(input, new File(['new evidence bytes'], 'new.txt'));
    expect(input.files?.[0]?.name).toBe('old.txt');
  } finally {
    gate.release();
  }
  await screen.findByText('Το τεκμήριο αποθηκεύτηκε και επιβεβαιώθηκε.');
  const saved = (await req(f.ep)).items[0];
  const file = await req('/files/' + saved.file_id);
  expect(saved.title).toBe('Old evidence');
  expect(file.filename).toBe('old.txt');
  expect(await (await fetch('/api/v1/files/' + saved.file_id + '/download')).text()).toBe(
    'old evidence bytes',
  );
}, 20000);
it('freezes ZIP selection throughout a real pending batch and allows the same file again after reset', async () => {
  const f = await fixture();
  const user = userEvent.setup();
  render(
    <Submissions
      labId={f.lab.id}
      teamId={f.team.id}
      items={[]}
      total={0}
      busy={false}
      onMore={() => {}}
      onRefresh={() => {}}
    />,
  );
  const input = screen.getByLabelText('Αρχεία ZIP') as HTMLInputElement;
  // Empty valid ZIP; stored/imported, never executed.
  const zip = new File([new Uint8Array([80, 75, 5, 6, ...Array(18).fill(0)])], 'old.zip', {
    type: 'application/zip',
  });
  await user.upload(input, zip);
  const gate = deferUpload();
  await user.click(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' }));
  await gate.reached;
  try {
    expect(input).toBeDisabled();
    await user.upload(input, new File([zip], 'new.zip', { type: 'application/zip' }));
    expect(input.files?.[0]?.name).toBe('old.zip');
  } finally {
    gate.release();
  }
  await screen.findByText('1 παραδόσεις αποθηκεύτηκαν και επιβεβαιώθηκαν.');
  const saved = (await req(f.b + '/teams/' + f.team.id + '/submissions')).items;
  expect(saved).toHaveLength(1);
  expect(saved[0].filename).toBe('old.zip');
  expect(input.value).toBe('');
  await user.upload(input, zip);
  await user.click(screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' }));
  await waitFor(async () =>
    expect((await req(f.b + '/teams/' + f.team.id + '/submissions')).total).toBe(2),
  );
}, 20000);
for (const kind of ['material', 'evidence'] as const)
  it(`freezes ${kind} replacement upload and cancel through save/readback`, async () => {
    const f = await fixture();
    const user = userEvent.setup();
    const form = new FormData();
    form.append('file', new File(['initial bytes'], 'initial.txt'));
    if (kind === 'evidence') form.append('team_id', f.team.id);
    const uploaded = await (
      await fetch('/api/v1' + f.b + '/files', { method: 'POST', body: form })
    ).json();
    const base = kind === 'material' ? f.b + '/materials' : f.ep;
    const initial = await req(
      base,
      'POST',
      kind === 'material'
        ? { title: 'Original material', file_id: uploaded.id, role: 'handout' }
        : { title: 'Original evidence', exercise_id: f.ex.id, kind: 'file', file_id: uploaded.id },
    );
    if (kind === 'material') render(<Materials labId={f.lab.id} />);
    else
      render(
        <EvidenceList labId={f.lab.id} teamId={f.team.id} exerciseId={f.ex.id} submissions={[]} />,
      );
    await user.click(
      await screen.findByRole('button', {
        name: kind === 'material' ? 'Επεξεργασία υλικού' : 'Επεξεργασία τεκμηρίου',
      }),
    );
    const label =
      kind === 'material'
        ? 'Αντικατάσταση αρχείου υλικού (προαιρετική)'
        : 'Αντικατάσταση αρχείου τεκμηρίου (προαιρετική)';
    const input = (await screen.findByLabelText(label)) as HTMLInputElement;
    await user.upload(input, new File(['replacement bytes'], 'replacement.txt'));
    const gate = deferUpload();
    await user.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
    await gate.reached;
    try {
      expect(input).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Ακύρωση' })).toBeDisabled();
      expect(screen.getByLabelText('Σχετική άσκηση')).toBeDisabled();
      await user.upload(input, new File(['new bytes'], 'new.txt'));
      expect(input.files?.[0]?.name).toBe('replacement.txt');
    } finally {
      gate.release();
    }
    await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
    const saved = await req(base + '/' + initial.id);
    expect(saved.file_id).not.toBe(uploaded.id);
    expect((await req('/files/' + saved.file_id)).filename).toBe('replacement.txt');
    expect(await (await fetch('/api/v1/files/' + saved.file_id + '/download')).text()).toBe(
      'replacement bytes',
    );
  }, 20000);
