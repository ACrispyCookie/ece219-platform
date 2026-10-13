import { confirmRemoval, cancelRemoval } from './removal-dialog-helpers';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import Materials from '../Materials';
import EvidenceList from '../Evidence';
import Submissions from '../Submissions';
import Removal from '../Removal';
import { OperationContext, useOperations } from '../OperationContext';
import type { ReactNode } from 'react';
const token = 'c'.repeat(64);
const impact = {
  dependencies: [],
  unreferenced_files: [],
  unreferenced_files_total: 0,
  cascade_counts: [{ kind: 'labs', count: 1 }],
  confirmation_token: token,
};
const material = {
  id: 'm',
  revision: 1,
  lab_id: 'l',
  file_id: 'existing',
  exercise_id: null,
  title: 'Material',
  description: '',
  role: 'handout',
};
const existingFile = {
  id: 'existing',
  lab_id: 'l',
  filename: 'existing.txt',
  sha256: 'a',
  media_type: 'text/plain',
  size: 1,
  created_at: '',
};
const uploadedFile = { ...existingFile, id: 'uploaded', filename: 'new.txt' };
const savedMaterial = { ...material, id: 'new-m', title: 'Draft', file_id: 'uploaded' };
const savedEvidence = {
  id: 'new-e',
  revision: 1,
  title: 'Draft',
  team_id: 't',
  exercise_id: 'x',
  kind: 'text',
  text: 'Text',
  submission_id: null,
  source: 'human',
  created_at: '',
};
const submission = {
  id: 's',
  lab_id: 'l',
  team_id: 't',
  file_id: 'uploaded',
  filename: 'one.zip',
  sha256: 'a',
  archive_status: 'blocked',
  archive_errors: [],
  created_at: '',
};
const reply = (status: number, data?: unknown) =>
  new Response(data === undefined ? null : JSON.stringify(data), { status });
const page = (items: unknown[]) => ({ items, total: items.length, limit: 100, offset: 0 });
const calls: { path: string; method: string }[] = [];
let handler: (path: string, method: string) => Promise<Response>;
let hold: string | undefined, release: (() => void) | undefined;
const refresh = vi.fn();
function Scope({ children }: { children: ReactNode }) {
  const operations = useOperations();
  return <OperationContext.Provider value={operations}>{children}</OperationContext.Provider>;
}
function Owner({ layer, unmount = false }: { layer: string; unmount?: boolean }) {
  const [show, setShow] = useState(true);
  return (
    <Scope>
      <Removal path="/labs/l" revision={1} kind="εργαστηρίου" title="Lab" onRemoved={() => {}} />
      {unmount && <button onClick={() => setShow(false)}>Unmount form</button>}
      {show &&
        (layer === 'material' ? (
          <Materials labId="l" />
        ) : layer === 'evidence' ? (
          <EvidenceList labId="l" teamId="t" exerciseId="x" submissions={[]} />
        ) : (
          <Submissions
            labId="l"
            teamId="t"
            items={[]}
            total={0}
            busy={false}
            onMore={() => {}}
            onRefresh={refresh}
          />
        ))}
    </Scope>
  );
}
beforeEach(() => {
  calls.length = 0;
  hold = undefined;
  release = undefined;
  refresh.mockClear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  handler = async (path, method) => {
    if (path.endsWith('/deletion-impact')) return reply(200, impact);
    if (method === 'DELETE') return reply(409, { code: 'deletion_changed', message: 'changed' });
    if (path === '/labs/l/files' && method === 'POST') return reply(201, uploadedFile);
    if (path === '/files/uploaded') return reply(200, uploadedFile);
    if (path === '/files/existing') return reply(200, existingFile);
    if (path === '/labs/l/materials/m') return reply(200, material);
    if (path === '/labs/l/materials' && method === 'POST') return reply(201, savedMaterial);
    if (path.startsWith('/labs/l/materials?'))
      return reply(200, page(path.includes('limit=200') ? [savedMaterial] : [material]));
    if (path.startsWith('/labs/l/files?')) return reply(200, page([existingFile]));
    if (path === '/labs/l/teams/t/evidence' && method === 'POST') return reply(201, savedEvidence);
    if (path.startsWith('/labs/l/teams/t/evidence?'))
      return reply(200, page(path.includes('limit=200') ? [savedEvidence] : []));
    if (path === '/labs/l/teams/t/submissions' && method === 'POST') return reply(201, submission);
    if (path === '/submissions/s') return reply(200, submission);
    return reply(200, page([]));
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const path = String(input).replace('/api/v1', ''),
        method = init?.method || 'GET';
      calls.push({ path, method });
      if (hold && `${method} ${path}`.startsWith(hold))
        await new Promise<void>((r) => {
          release = r;
        });
      return handler(path, method);
    }),
  );
});
afterEach(() => {
  release?.();
  vi.unstubAllGlobals();
});
const deletion = () => screen.getByRole('button', { name: 'Διαγραφή εργαστηρίου Lab' });
async function form(layer: string) {
  if (layer === 'material') {
    fireEvent.click(await screen.findByRole('button', { name: 'Νέο υλικό' }));
    fireEvent.change(screen.getByLabelText('Τίτλος υλικού'), { target: { value: 'Draft' } });
    fireEvent.change(screen.getByLabelText('Αρχείο υλικού'), {
      target: { files: [new File(['text'], 'new.txt')] },
    });
  } else if (layer === 'evidence') {
    fireEvent.click(await screen.findByRole('button', { name: 'Νέο τεκμήριο' }));
    fireEvent.change(screen.getByLabelText('Τίτλος τεκμηρίου'), { target: { value: 'Draft' } });
    fireEvent.change(screen.getByLabelText('Κείμενο τεκμηρίου'), { target: { value: 'Text' } });
  } else
    fireEvent.change(screen.getByLabelText('Αρχεία ZIP'), {
      target: { files: [new File(['zip'], 'one.zip')] },
    });
  return layer === 'submission'
    ? screen.getByRole('button', { name: 'Μεταφόρτωση ZIP' })
    : screen
        .getByRole('button', {
          name: layer === 'material' ? 'Αποθήκευση υλικού' : 'Αποθήκευση τεκμηρίου',
        })
        .closest('form')!;
}
function submit(node: HTMLElement, layer: string) {
  if (layer === 'submission') fireEvent.click(node);
  else fireEvent.submit(node);
}
it.each(['material', 'evidence', 'submission'])(
  '%s custom save owns mutation before upload, excludes duplicate submit/removal through exact readback',
  async (layer) => {
    render(<Owner layer={layer} />);
    const node = await form(layer);
    calls.length = 0;
    hold =
      layer === 'material'
        ? 'GET /files/uploaded'
        : layer === 'evidence'
          ? 'GET /labs/l/teams/t/evidence?'
          : 'GET /submissions/s';
    act(() => {
      submit(node, layer);
      fireEvent.click(deletion());
      submit(node, layer);
    });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    const before = calls.length;
    fireEvent.click(deletion());
    expect(calls).toHaveLength(before);
    expect(calls.some((c) => c.path.endsWith('/deletion-impact'))).toBe(false);
    const writes = calls.filter((c) => c.method === 'POST');
    expect(writes).toHaveLength(1);
    await act(async () => {
      hold = undefined;
      release!();
    });
    await screen.findByText(
      layer === 'material'
        ? 'Το υλικό αποθηκεύτηκε και επιβεβαιώθηκε.'
        : layer === 'evidence'
          ? 'Το τεκμήριο αποθηκεύτηκε και επιβεβαιώθηκε.'
          : '1 παραδόσεις αποθηκεύτηκαν και επιβεβαιώθηκαν.',
    );
    fireEvent.click(deletion());
    await confirmRemoval();
    expect(await screen.findByRole('alert')).toHaveTextContent('νέα επιβεβαίωση');
  },
);
it.each(['material', 'evidence', 'submission'])(
  '%s submit cannot enter while sibling preview owns removal',
  async (layer) => {
    render(<Owner layer={layer} />);
    const node = await form(layer);
    calls.length = 0;
    hold = 'GET /labs/l/deletion-impact';
    act(() => {
      fireEvent.click(deletion());
      submit(node, layer);
      fireEvent.click(deletion());
    });
    expect(calls).toEqual([{ path: '/labs/l/deletion-impact', method: 'GET' }]);
    await act(async () => {
      hold = undefined;
      release!();
    });
    await cancelRemoval();
    expect(calls.some((c) => c.method === 'POST' || c.method === 'DELETE')).toBe(false);
  },
);
it.each(['material', 'evidence', 'submission'])(
  '%s unmounted form holds ownership until verification returns',
  async (layer) => {
    render(<Owner layer={layer} unmount />);
    const node = await form(layer);
    hold =
      layer === 'material'
        ? 'GET /files/uploaded'
        : layer === 'evidence'
          ? 'GET /labs/l/teams/t/evidence?'
          : 'GET /submissions/s';
    submit(node, layer);
    await waitFor(() => expect(release).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Unmount form' }));
    calls.length = 0;
    fireEvent.click(deletion());
    expect(calls).toEqual([]);
    await act(async () => {
      hold = undefined;
      release!();
    });
    fireEvent.click(deletion());
    await confirmRemoval();
    await screen.findByRole('alert');
    expect(calls).toContainEqual({ path: '/labs/l/deletion-impact', method: 'GET' });
  },
);
it.each(['material', 'evidence', 'submission'])(
  '%s draft rejects synthetic changes after synchronous sibling removal acquisition',
  async (layer) => {
    render(<Owner layer={layer} />);
    await form(layer);
    hold = 'GET /labs/l/deletion-impact';
    act(() => {
      fireEvent.click(deletion());
      if (layer === 'submission')
        fireEvent.change(screen.getByLabelText('Αρχεία ZIP'), {
          target: { files: [new File(['changed'], 'changed.zip')] },
        });
      else
        fireEvent.change(
          screen.getByLabelText(layer === 'material' ? 'Τίτλος υλικού' : 'Τίτλος τεκμηρίου'),
          { target: { value: 'Must not change' } },
        );
    });
    if (layer === 'submission') expect(screen.queryByText('changed.zip')).not.toBeInTheDocument();
    else
      expect(
        screen.getByLabelText(layer === 'material' ? 'Τίτλος υλικού' : 'Τίτλος τεκμηρίου'),
      ).toHaveValue('Draft');
    await act(async () => {
      hold = undefined;
      release!();
    });
    await cancelRemoval();
  },
);
it('unrelated material and evidence forms save concurrently without admitting removal', async () => {
  render(
    <Scope>
      <Removal path="/labs/l" revision={1} kind="εργαστηρίου" title="Lab" onRemoved={() => {}} />
      <Materials labId="l" />
      <EvidenceList labId="l" teamId="t" exerciseId="x" submissions={[]} />
    </Scope>,
  );
  const materialForm = await form('material'),
    evidenceForm = await form('evidence');
  calls.length = 0;
  hold = 'GET /files/uploaded';
  submit(materialForm, 'material');
  await waitFor(() => expect(release).toBeTypeOf('function'));
  submit(evidenceForm, 'evidence');
  await screen.findByText('Το τεκμήριο αποθηκεύτηκε και επιβεβαιώθηκε.');
  expect(calls).toContainEqual({ path: '/labs/l/teams/t/evidence', method: 'POST' });
  fireEvent.click(deletion());
  expect(calls.some((c) => c.path.endsWith('/deletion-impact'))).toBe(false);
  await act(async () => {
    hold = undefined;
    release!();
  });
  await screen.findByText('Το υλικό αποθηκεύτηκε και επιβεβαιώθηκε.');
});
it.each(['material', 'evidence'])(
  '%s validation refusal releases its save owner before subsequent removal',
  async (layer) => {
    render(<Owner layer={layer} />);
    const node = await form(layer);
    fireEvent.change(
      screen.getByLabelText(layer === 'material' ? 'Τίτλος υλικού' : 'Τίτλος τεκμηρίου'),
      { target: { value: '' } },
    );
    calls.length = 0;
    submit(node, layer);
    await screen.findByRole('alert');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.click(deletion());
    await waitFor(() =>
      expect(calls).toContainEqual({ path: '/labs/l/deletion-impact', method: 'GET' }),
    );
  },
);
it('verified material replacement refreshes standalone uploads and deleting its new file closes the matching editor', async () => {
  const original = handler;
  let current = material;
  let uploaded = false,
    deleted = false;
  handler = async (path, method) => {
    if (method === 'DELETE') {
      deleted = true;
      return reply(204);
    }
    if (path === '/labs/l/files' && method === 'POST') uploaded = true;
    if (path === '/labs/l/materials/m' && method === 'PATCH') {
      current = { ...material, revision: 2, file_id: 'uploaded' };
      return reply(200, current);
    }
    if (path === '/labs/l/materials/m') return deleted ? reply(404) : reply(200, current);
    if (path.startsWith('/labs/l/materials?')) return reply(200, page(deleted ? [] : [current]));
    if (path.startsWith('/labs/l/files?'))
      return reply(200, page(uploaded && !deleted ? [existingFile, uploadedFile] : [existingFile]));
    if (path === '/files/uploaded' && deleted) return reply(404);
    return original(path, method);
  };
  render(<Materials labId="l" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Επεξεργασία υλικού' }));
  fireEvent.change(await screen.findByLabelText('Αντικατάσταση αρχείου υλικού (προαιρετική)'), {
    target: { files: [new File(['replacement'], 'new.txt')] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }));
  await screen.findByText('Αποθηκεύτηκε και επιβεβαιώθηκε.');
  const removeFile = await screen.findByRole('button', { name: 'Διαγραφή αρχείου new.txt' });
  fireEvent.click(removeFile);
  await confirmRemoval();
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Διαγραφή αρχείου new.txt' }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.queryByLabelText('Τίτλος υλικού')).not.toBeInTheDocument();
});
it('deleting an unrelated standalone upload preserves a different material editor draft', async () => {
  const otherFile = { ...existingFile, id: 'other', filename: 'unrelated.txt' };
  const original = handler;
  let deleted = false;
  handler = async (path, method) => {
    if (method === 'DELETE') {
      deleted = true;
      return reply(204);
    }
    if (path.startsWith('/labs/l/files?')) return reply(200, page(deleted ? [] : [otherFile]));
    return path === '/files/other' ? reply(404) : original(path, method);
  };
  render(<Materials labId="l" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Επεξεργασία υλικού' }));
  fireEvent.change(await screen.findByLabelText('Τίτλος υλικού'), {
    target: { value: 'Unrelated draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Διαγραφή αρχείου unrelated.txt' }));
  await confirmRemoval();
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Διαγραφή αρχείου unrelated.txt' }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText('Τίτλος υλικού')).toHaveValue('Unrelated draft');
});
