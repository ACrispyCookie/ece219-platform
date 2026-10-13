import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import Removal from '../Removal';
import { OperationContext, useOperations } from '../OperationContext';
import { DirtyContext } from '../ui';
const token = 'Ab'.repeat(32);
const impact = {
  dependencies: [],
  unreferenced_files: [],
  unreferenced_files_total: 0,
  cascade_counts: [
    { kind: 'labs', count: 1 },
    { kind: 'assessment_history', count: 987654 },
  ],
  confirmation_token: token,
};
const title = '<img src=x onerror=alert(1)> ' + 'Πολύμεγάλοςτίτλος'.repeat(15);
const calls: { path: string; method: string }[] = [];
let handler: (path: string, method: string) => Promise<Response>;
const removed = vi.fn();
const reply = (status: number, data?: unknown) =>
  new Response(data === undefined ? null : JSON.stringify(data), { status });
function Scope({ children }: { children: ReactNode }) {
  const operations = useOperations();
  return (
    <DirtyContext.Provider value={{ set: () => {}, guard: () => true }}>
      <OperationContext.Provider value={operations}>
        <fieldset disabled={operations.pending}>{children}</fieldset>
      </OperationContext.Provider>
    </DirtyContext.Provider>
  );
}
const control = (path = '/labs/l') => (
  <Scope>
    <Removal path={path} revision={7} title={title} kind="εργαστηρίου" onRemoved={removed} />
  </Scope>
);
const trigger = () => screen.getByRole('button', { name: `Διαγραφή εργαστηρίου ${title}` });
async function open() {
  const button = trigger();
  button.focus();
  fireEvent.click(button);
  return screen.findByRole('dialog');
}
beforeEach(() => {
  calls.length = 0;
  removed.mockClear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  handler = async (path, method) =>
    method === 'DELETE'
      ? reply(204)
      : path.endsWith('/deletion-impact')
        ? reply(200, impact)
        : reply(404);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const path = String(input).replace('/api/v1', '');
      const method = init?.method || 'GET';
      calls.push({ path, method });
      return handler(path, method);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
it('shows escaped named Greek dialog with exact server counts outside locked fieldset and no native confirmation', async () => {
  render(control());
  const dialog = await open();
  expect(dialog).toHaveAccessibleName('Οριστική διαγραφή εργαστηρίου');
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(dialog.closest('fieldset')).toBeNull();
  expect(dialog).toHaveTextContent(title);
  expect(dialog.querySelector('img')).toBeNull();
  expect(within(dialog).getByText('Ιστορικό αξιολογήσεων:')).toBeInTheDocument();
  expect(within(dialog).getByText('987654')).toBeInTheDocument();
  expect(dialog).toHaveTextContent('δεν αναιρείται');
  expect(dialog).toHaveTextContent('κοινόχρηστο αποθηκευμένο περιεχόμενο');
  expect(dialog).toHaveTextContent('Ανεξάρτητα');
  expect(window.confirm).not.toHaveBeenCalled();
  expect(trigger()).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'Ακύρωση διαγραφής' })).toBeEnabled();
  expect(within(dialog).getByRole('button', { name: 'Ακύρωση διαγραφής' })).toHaveFocus();
  expect(calls).toHaveLength(1);
});
it.each(['cancel', 'close', 'escape', 'backdrop'])(
  '%s cancels without DELETE, releases ownership and restores original disabled-fieldset trigger focus',
  async (mode) => {
    render(control());
    const dialog = await open();
    if (mode === 'cancel')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Ακύρωση διαγραφής' }));
    if (mode === 'close')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Κλείσιμο επιβεβαίωσης' }));
    if (mode === 'escape') fireEvent(dialog, new Event('cancel', { cancelable: true }));
    if (mode === 'backdrop') {
      fireEvent.mouseDown(dialog);
      fireEvent.click(dialog);
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(trigger()).toBeEnabled();
    expect(trigger()).toHaveFocus();
    expect(removed).not.toHaveBeenCalled();
    await open();
    expect(calls).toHaveLength(2);
  },
);
it('traps Tab and Shift+Tab within dialog', async () => {
  render(control());
  const dialog = await open();
  const user = userEvent.setup();
  const close = within(dialog).getByRole('button', { name: 'Κλείσιμο επιβεβαίωσης' });
  const confirm = within(dialog).getByRole('button', { name: 'Οριστική διαγραφή' });
  confirm.focus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.tab({ shift: true });
  expect(confirm).toHaveFocus();
});
it.each(['DELETE', 'readback'])(
  'retains busy modal through %s, disables all actions, blocks dismissal and duplicate writes',
  async (stage) => {
    let release!: () => void;
    handler = async (path, method) => {
      if (
        (stage === 'DELETE' && method === 'DELETE') ||
        (stage === 'readback' && path === '/labs/l')
      )
        await new Promise<void>((r) => (release = r));
      return method === 'DELETE'
        ? reply(204)
        : path.endsWith('/deletion-impact')
          ? reply(200, impact)
          : reply(404);
    };
    render(control());
    const dialog = await open();
    const confirm = within(dialog).getByRole('button', { name: 'Οριστική διαγραφή' });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    for (const button of within(dialog).getAllByRole('button')) expect(button).toBeDisabled();
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    expect(dialog).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([
      { path: `/labs/l?cascade=true&confirmation_token=${token}&revision=7`, method: 'DELETE' },
    ]);
    await act(async () => release());
    await waitFor(() => expect(removed).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  },
);
it.each(['change', 'ABA', 'unmount'])(
  '%s while awaiting choice cancels promise, releases shared owner and never deletes old target',
  async (mode) => {
    const view = render(control());
    const dialog = await open();
    const oldConfirm = within(dialog).getByRole('button', { name: 'Οριστική διαγραφή' });
    if (mode === 'unmount')
      view.rerender(
        <Scope>
          <button>Survivor</button>
        </Scope>,
      );
    else {
      view.rerender(control('/labs/new'));
      if (mode === 'ABA') view.rerender(control());
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(oldConfirm);
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(removed).not.toHaveBeenCalled();
    if (mode === 'unmount') expect(screen.getByRole('button', { name: 'Survivor' })).toBeEnabled();
    else {
      expect(trigger()).toBeEnabled();
      await open();
      expect(calls).toHaveLength(2);
    }
  },
);
it('malformed impact never shows modal or writes', async () => {
  handler = async () => reply(200, { ...impact, confirmation_token: 'bad' });
  render(control());
  fireEvent.click(trigger());
  await screen.findByRole('alert');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(calls).toHaveLength(1);
});
it('changed fingerprint closes dialog and retains target until fresh manual confirmation', async () => {
  handler = async (path, method) =>
    method === 'DELETE'
      ? reply(409, { code: 'deletion_changed', message: 'changed' })
      : reply(200, impact);
  render(control());
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Οριστική διαγραφή' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('νέα επιβεβαίωση');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  expect(removed).not.toHaveBeenCalled();
  await open();
  expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
});
