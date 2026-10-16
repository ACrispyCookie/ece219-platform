import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FilePreviewButton from '../FilePreview';

const url = '/api/v1/files/test-file/download';
const bytes = (text: string) => new TextEncoder().encode(text);
const response = (text: string, type = 'application/octet-stream') =>
  new Response(bytes(text), { headers: { 'Content-Type': type } });
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Προβολή' }));
afterEach(() => vi.unstubAllGlobals());

describe('safe file preview dialog', () => {
  it('portals outside a disabled fieldset, focuses close and restores trigger focus', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('hello')));
    const { container } = render(
      <fieldset>
        <FilePreviewButton filename="hello.txt" url={url} />
      </fieldset>,
    );
    const trigger = screen.getByRole('button', { name: 'Προβολή' });
    trigger.focus();
    open();
    container.querySelector('fieldset')!.disabled = true;
    const dialog = screen.getByRole('dialog', { name: 'hello.txt' });
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.closest('fieldset')).toBeNull();
    expect(screen.getByRole('button', { name: 'Κλείσιμο προεπισκόπησης' })).toHaveFocus();
    await screen.findByText('hello');
    container.querySelector('fieldset')!.disabled = false;
    fireEvent.click(screen.getByRole('button', { name: 'Κλείσιμο προεπισκόπησης' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it.each(['attack.html', 'attack.svg', 'notes.md', 'data.json'])(
    'renders %s only as escaped plain text',
    async (filename) => {
      const evil = '<svg onload="alert(1)"><script>window.pwned=1</script></svg>';
      const fetcher = vi.fn().mockResolvedValue(response(evil, 'image/svg+xml'));
      vi.stubGlobal('fetch', fetcher);
      render(<FilePreviewButton filename={filename} url={url} />);
      open();
      expect(await screen.findByText(evil)).toHaveProperty('tagName', 'PRE');
      expect(document.querySelector('iframe,object,embed,script,svg,img')).toBeNull();
      expect(fetcher).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          credentials: 'same-origin',
          redirect: 'error',
          signal: expect.any(AbortSignal),
        }),
      );
      expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
      expect(screen.getByRole('link', { name: 'Λήψη πρωτοτύπου' })).toHaveAttribute('href', url);
    },
  );
  it.each([
    { filename: 'archive.zip' },
    { filename: 'big.pdf', size: 16 * 1024 * 1024 + 1 },
    { filename: 'large.txt', size: 1024 * 1024 + 1 },
  ])('offers download without fetching unsupported or oversized $filename', async (props) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(<FilePreviewButton {...props} url={url} />);
    open();
    expect(screen.getByRole('link', { name: 'Λήψη πρωτοτύπου' })).toHaveAttribute('href', url);
    expect(screen.getByRole('status')).toHaveTextContent(/Δεν είναι διαθέσιμη/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects foreign or arbitrary URLs without rendering an unsafe link', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(<FilePreviewButton filename="x.txt" url="https://evil.test/x" />);
    open();
    expect(screen.getByRole('alert')).toHaveTextContent(/διεύθυνση/);
    expect(screen.queryByRole('link')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('shows errors honestly and retries, dispatching the standard unauthorized event', async () => {
    const unauthorized = vi.fn();
    window.addEventListener('catalog:unauthorized', unauthorized);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(response('recovered'));
    vi.stubGlobal('fetch', fetcher);
    render(<FilePreviewButton filename="test.txt" url={url} />);
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('401');
    expect(unauthorized).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Δοκιμή ξανά' }));
    await screen.findByText('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
    window.removeEventListener('catalog:unauthorized', unauthorized);
  });
  it('contains Tab and Shift+Tab, closes on Escape and aborts the pending fetch', () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetcher);
    render(<FilePreviewButton filename="test.txt" url={url} />);
    open();
    const close = screen.getByRole('button', { name: 'Κλείσιμο προεπισκόπησης' });
    const download = screen.getByRole('link', { name: 'Λήψη πρωτοτύπου' });
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(download).toHaveFocus();
    fireEvent.keyDown(download, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('closes only on a complete backdrop click, not a drag from content', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => new Promise(() => {})),
    );
    render(<FilePreviewButton filename="test.txt" url={url} />);
    open();
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(screen.getByRole('heading'));
    fireEvent.click(dialog);
    expect(dialog).toBeInTheDocument();
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('cancels and ignores a stale fetch after target replacement', async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue(response('new'));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<FilePreviewButton filename="old.txt" url={url} />);
    open();
    view.rerender(<FilePreviewButton filename="new.txt" url="/api/v1/files/new/download" />);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    resolve(response('stale'));
    await waitFor(() => expect(screen.queryByText('stale')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('restores focus only after closing the native top layer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('hello')));
    render(<FilePreviewButton filename="hello.txt" url={url} />);
    const trigger = screen.getByRole('button', { name: 'Προβολή' });
    const modalStates: boolean[] = [];
    const focus = vi.spyOn(trigger, 'focus').mockImplementation(() => {
      modalStates.push(!!document.querySelector('dialog[open]'));
    });
    open();
    await screen.findByText('hello');
    fireEvent.click(screen.getByRole('button', { name: 'Κλείσιμο προεπισκόπησης' }));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(modalStates).toEqual([false]);
  });
  it('rejects forged image content rather than creating a student-origin embed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response('<svg onload="alert(1)"/>', 'image/png')),
    );
    render(<FilePreviewButton filename="attack.png" url={url} />);
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent(/μορφή/);
    expect(document.querySelector('img,iframe,object,embed')).toBeNull();
  });
});
