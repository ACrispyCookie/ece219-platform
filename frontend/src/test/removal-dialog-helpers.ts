import { fireEvent, screen, waitFor, within } from '@testing-library/react';
export async function removalDialog() {
  return screen.findByRole('dialog');
}
export function confirmationText(dialog: HTMLElement) {
  return [
    dialog.textContent,
    ...Array.from(dialog.querySelectorAll('dl > div')).map(
      (row) => `${row.querySelector('dt')?.textContent} ${row.querySelector('dd')?.textContent}`,
    ),
  ].join('\n');
}
// Explicitly choose through the real rendered dialog. Never observe/auto-accept
// mutations globally: each regression test owns its intended user decision.
export async function confirmRemoval() {
  const dialog = await removalDialog();
  const text = confirmationText(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Οριστική διαγραφή' }));
  return text;
}
export async function cancelRemoval() {
  const dialog = await removalDialog();
  const text = confirmationText(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Ακύρωση διαγραφής' }));
  await waitFor(() => {
    if (screen.queryByRole('dialog')) throw new Error('Dialog remains open');
  });
  return text;
}
