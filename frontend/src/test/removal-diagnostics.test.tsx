// Synthetic transport faults complement the native-HTTP cascade suites.
import { confirmRemoval } from './removal-dialog-helpers';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Removal from '../Removal';
import { DirtyContext, Field, SaveForm } from '../ui';
import { OperationContext, useOperations } from '../OperationContext';
const path = '/labs/lab%2Fname';
const token = 'b'.repeat(64);
const impact = {
  dependencies: [],
  unreferenced_files: [],
  unreferenced_files_total: 0,
  cascade_counts: [{ kind: 'labs', count: 1 }],
  confirmation_token: token,
};
const calls: { path: string; method: string }[] = [];
const removed = vi.fn(),
  guard = vi.fn(() => true);
const reply = (status: number, data?: unknown) =>
  new Response(data === undefined ? null : JSON.stringify(data), { status });
let handler: (path: string, method: string) => Promise<Response>;
function Harness({
  target = path,
  readPath = target,
  revision = 1,
  form = false,
  sibling = false,
}: {
  target?: string;
  readPath?: string;
  revision?: number;
  form?: boolean;
  sibling?: boolean;
}) {
  const operations = useOperations();
  return (
    <DirtyContext.Provider value={{ set: () => {}, guard }}>
      <OperationContext.Provider value={operations}>
        <fieldset disabled={operations.pending}>
          <Removal
            path={target}
            readPath={readPath}
            revision={revision}
            title="Δοκιμή"
            kind="εργαστηρίου"
            onRemoved={removed}
          />
          {sibling && (
            <Removal
              path="/labs/other"
              revision={1}
              title="Άλλο"
              kind="εργαστηρίου"
              onRemoved={() => {}}
            />
          )}
          {form && (
            <SaveForm
              title="Επεξεργασία"
              initial={{ title: 'Πρόχειρο' }}
              save={async () => {
                await fetch('/save', { method: 'PATCH' });
                return { title: 'Πρόχειρο' };
              }}
              read={async () => ({ title: 'Πρόχειρο' })}
              onSaved={() => {}}
            >
              {(draft, set) => (
                <Field label="Τίτλος">
                  <input value={draft.title} onChange={(e) => set({ title: e.target.value })} />
                </Field>
              )}
            </SaveForm>
          )}
        </fieldset>
      </OperationContext.Provider>
    </DirtyContext.Provider>
  );
}
const deletion = () => screen.getByRole('button', { name: 'Διαγραφή εργαστηρίου Δοκιμή' });
const close = () => screen.getByRole('button', { name: 'Κλείσιμο ειδοποίησης' });
beforeEach(() => {
  calls.length = 0;
  removed.mockClear();
  guard.mockReset().mockReturnValue(true);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  handler = async (target, method) =>
    target.endsWith('/deletion-impact')
      ? reply(200, impact)
      : method === 'DELETE'
        ? reply(409, { code: 'deletion_changed', message: 'changed' })
        : reply(404);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const target = String(input),
        method = init?.method || 'GET';
      calls.push({ path: target, method });
      return handler(target, method);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
it.each([401, 403, 404, 503])(
  'preview HTTP%s preserves draft and performs no confirmation or writes',
  async (status) => {
    handler = async () => reply(status, { message: 'preview refused' });
    render(<Harness form />);
    fireEvent.change(screen.getByLabelText('Τίτλος'), { target: { value: 'Διατηρείται' } });
    fireEvent.click(deletion());
    expect(await screen.findByRole('alert')).toHaveTextContent('preview refused');
    expect(window.confirm).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(screen.getByLabelText('Τίτλος')).toHaveValue('Διατηρείται');
  },
);
it.each([200, 401, 403, 500])(
  'non404 verification HTTP%s never claims removal or discards a draft',
  async (status) => {
    handler = async (target, method) =>
      target.endsWith('/deletion-impact')
        ? reply(200, impact)
        : method === 'DELETE'
          ? reply(204)
          : reply(status, { message: 'read refused' });
    render(<Harness form />);
    fireEvent.change(screen.getByLabelText('Τίτλος'), { target: { value: 'Διατηρείται' } });
    fireEvent.click(deletion());
    await confirmRemoval();
    expect(await screen.findByRole('alert')).toHaveTextContent('δεν επιβεβαιώθηκε');
    expect(removed).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Τίτλος')).toHaveValue('Διατηρείται');
    expect(deletion()).toBeEnabled();
  },
);
it.each(['preview', 'delete', 'verify'])(
  'network failure during %s releases ownership and preserves draft',
  async (phase) => {
    handler = async (target, method) => {
      if (
        (phase === 'preview' && target.endsWith('/deletion-impact')) ||
        (phase === 'delete' && method === 'DELETE') ||
        (phase === 'verify' && method === 'GET' && !target.endsWith('/deletion-impact'))
      )
        throw new TypeError('offline');
      return target.endsWith('/deletion-impact') ? reply(200, impact) : reply(204);
    };
    render(<Harness form />);
    fireEvent.click(deletion());
    if (phase !== 'preview') await confirmRemoval();
    expect(await screen.findByRole('alert')).toHaveTextContent('Αδυναμία σύνδεσης');
    expect(deletion()).toBeEnabled();
    expect(removed).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Τίτλος')).toHaveValue('Πρόχειρο');
  },
);
it('conflict notice dismisses by keyboard locally and restores trigger focus', async () => {
  render(<Harness />);
  fireEvent.click(deletion());
  await confirmRemoval();
  await screen.findByRole('alert');
  const notice = screen.getByRole('alert');
  expect(notice).toHaveClass('removal-notice');
  expect(close()).toHaveAttribute('type', 'button');
  expect(close().querySelector('[aria-hidden=true]')).toHaveTextContent('×');
  calls.length = 0;
  close().focus();
  await userEvent.keyboard('{Enter}');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(deletion()).toHaveFocus();
  expect(calls).toEqual([]);
});
it('sibling preview/verification synchronously excludes dismissal and does not steal keyboard focus', async () => {
  render(<Harness sibling />);
  fireEvent.click(deletion());
  await confirmRemoval();
  await screen.findByRole('alert');
  let release!: () => void;
  handler = async (target, method) => {
    if (target === '/api/v1/labs/other')
      await new Promise<void>((r) => {
        release = r;
      });
    return target.endsWith('/deletion-impact')
      ? reply(200, impact)
      : method === 'DELETE'
        ? reply(204)
        : reply(404);
  };
  close().focus();
  const dismiss = close();
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Διαγραφή εργαστηρίου Άλλο' }));
    fireEvent.click(dismiss);
  });
  expect(dismiss).toHaveFocus();
  expect(screen.getByRole('alert')).toBeInTheDocument();
  await confirmRemoval();
  await waitFor(() => expect(release).toBeTypeOf('function'));
  expect(close()).toBeDisabled();
  fireEvent.click(close());
  expect(screen.getByRole('alert')).toBeInTheDocument();
  await act(async () => release());
  await waitFor(() => expect(close()).toBeEnabled());
  calls.length = 0;
  fireEvent.click(close());
  expect(deletion()).toHaveFocus();
  expect(calls).toEqual([]);
});
it.each(['preview', 'verification'])(
  'old %s response cannot act after target ABA',
  async (phase) => {
    let release!: () => void;
    handler = async (target, method) => {
      if (
        (phase === 'preview' && target.endsWith('/deletion-impact')) ||
        (phase === 'verification' && target === '/api/v1' + path)
      )
        await new Promise<void>((r) => {
          release = r;
        });
      return target.endsWith('/deletion-impact')
        ? reply(200, impact)
        : method === 'DELETE'
          ? reply(204)
          : reply(404);
    };
    const view = render(<Harness />);
    fireEvent.click(deletion());
    if (phase === 'verification') await confirmRemoval();
    await waitFor(() => expect(release).toBeTypeOf('function'));
    view.rerender(<Harness target="/labs/other" />);
    view.rerender(<Harness />);
    await act(async () => release());
    expect(removed).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    if (phase === 'preview') expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  },
);
it.each(['revision', 'readPath', 'unmount'])(
  'late preview cannot authorize a changed %s',
  async (change) => {
    let release!: () => void;
    handler = async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return reply(200, impact);
    };
    const view = render(<Harness />);
    fireEvent.click(deletion());
    if (change === 'revision') view.rerender(<Harness revision={2} />);
    else if (change === 'readPath') view.rerender(<Harness readPath="/different-read" />);
    else view.unmount();
    await act(async () => release());
    expect(window.confirm).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(removed).not.toHaveBeenCalled();
  },
);
