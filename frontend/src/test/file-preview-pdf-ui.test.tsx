import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FilePreviewButton from '../FilePreview';
const fake = vi.hoisted(() => ({ openPreviewPDF: vi.fn() }));
vi.mock('../filePreviewPDF', () => fake);
const url = '/api/v1/files/pdf/download';
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Προβολή' }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      return Promise.resolve(
        new Response(new TextEncoder().encode('%PDF-1.7\nsynthetic engine fixture')),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
describe('PDF preview controls and lifecycle', () => {
  it('renders one page at a time with previous/next/count and bounded zoom, then destroys on close', async () => {
    const renderPage = vi.fn().mockResolvedValue(undefined),
      destroy = vi.fn().mockResolvedValue(undefined);
    fake.openPreviewPDF.mockResolvedValue({ numPages: 3, render: renderPage, destroy });
    render(<FilePreviewButton filename="test.pdf" url={url} />);
    open();
    await screen.findByRole('img', { name: 'Σελίδα 1 από 3' });
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll('canvas')).toHaveLength(1);
    expect(document.querySelector('iframe,object,embed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Προηγούμενη σελίδα' })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Επόμενη σελίδα' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Επόμενη σελίδα' }));
    await screen.findByRole('img', { name: 'Σελίδα 2 από 3' });
    await waitFor(() => expect(renderPage.mock.calls.at(-1)![1]).toBe(2));
    for (let i = 0; i < 15; i++) {
      const zoom = screen.getByRole('button', { name: 'Μεγέθυνση' });
      await waitFor(() => expect(screen.getByRole('status')).not.toHaveTextContent('Απόδοση'));
      if (!zoom.hasAttribute('disabled')) fireEvent.click(zoom);
    }
    await waitFor(() => expect(screen.getByRole('button', { name: 'Μεγέθυνση' })).toBeDisabled());
    expect(Math.max(...renderPage.mock.calls.map((c) => c[2]))).toBeLessThanOrEqual(3);
    expect(screen.getByRole('img', { name: 'Σελίδα 2 από 3' })).toHaveStyle({ width: '300%' });
    fireEvent.click(screen.getByRole('button', { name: 'Κλείσιμο προεπισκόπησης' }));
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(fake.openPreviewPDF.mock.calls[0][1].aborted).toBe(true);
  });
  it('reports PDF engine errors with retry and original download, never a blank success', async () => {
    fake.openPreviewPDF.mockRejectedValue(new Error('Invalid PDF structure'));
    render(<FilePreviewButton filename="broken.pdf" url={url} />);
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid PDF structure');
    expect(screen.getByRole('button', { name: 'Δοκιμή ξανά' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Λήψη πρωτοτύπου' })).toHaveAttribute('href', url);
  });
  it('reports rendering errors, aborts the page task and frees the canvas on unmount', async () => {
    const renderPage = vi.fn().mockRejectedValue(new Error('Page rendering failed'));
    const destroy = vi.fn().mockResolvedValue(undefined);
    fake.openPreviewPDF.mockResolvedValue({ numPages: 1, render: renderPage, destroy });
    const view = render(<FilePreviewButton filename="broken.pdf" url={url} />);
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Page rendering failed');
    await waitFor(() => expect(renderPage.mock.calls[0][3].aborted).toBe(true));
    view.unmount();
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
  });
  it('destroys a PDF that finishes loading after close rather than publishing stale content', async () => {
    let resolve!: (value: unknown) => void;
    fake.openPreviewPDF.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    render(<FilePreviewButton filename="slow.pdf" url={url} />);
    open();
    await waitFor(() => expect(fake.openPreviewPDF).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Κλείσιμο προεπισκόπησης' }));
    const destroy = vi.fn().mockResolvedValue(undefined);
    await act(async () => resolve({ numPages: 1, render: vi.fn(), destroy }));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
