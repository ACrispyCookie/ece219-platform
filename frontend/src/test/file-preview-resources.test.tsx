import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FilePreviewButton from '../FilePreview';
import { TEXT_LIMIT } from '../filePreviewHelpers';
const NativeURL = URL;
const createURL = vi.fn(),
  revokeURL = vi.fn();
const url = '/api/v1/submissions/sub-id/members/content?path=dir%2Fimage.png';
// Complete small encoded image; signature-only bytes must now fail validation.
const png = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==',
  'base64',
));
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Προβολή' }));
beforeEach(() => {
  createURL.mockReset().mockReturnValue('blob:synthetic-image');
  revokeURL.mockReset();
  vi.stubGlobal(
    'URL',
    class extends NativeURL {
      static createObjectURL = createURL;
      static revokeObjectURL = revokeURL;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
describe('preview bytes and resource cleanup in React', () => {
  it('uses a validated typed blob, never the original URL as an image source, and revokes on close', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(png, { headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetcher);
    render(<FilePreviewButton filename="image.png" url={url} />);
    open();
    const image = await screen.findByRole('img', { name: 'image.png' });
    expect(image).toHaveAttribute('src', 'blob:synthetic-image');
    expect(createURL.mock.calls[0][0].type).toBe('image/png');
    expect(fetcher.mock.calls[0][0]).toBe(url);
    fireEvent.click(screen.getByRole('button', { name: 'Κλείσιμο προεπισκόπησης' }));
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith('blob:synthetic-image');
  });
  it('surfaces a raster decode failure rather than claiming success; retry revokes the previous blob', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response(png))),
    );
    render(<FilePreviewButton filename="image.png" url={url} />);
    open();
    fireEvent.error(await screen.findByRole('img'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/αποκωδικοποιήθηκε/);
    fireEvent.click(screen.getByRole('button', { name: 'Δοκιμή ξανά' }));
    await screen.findByRole('img');
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith('blob:synthetic-image');
  });
  it('stops an untrusted missing-length text stream at the actual cap, cancels and offers download', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(TEXT_LIMIT + 1).fill(65));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
    render(<FilePreviewButton filename="code.txt" url="/api/v1/files/large/download" />);
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent(/όριο/);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expect(document.querySelector('pre')).toBeNull();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/api/v1/files/large/download');
  });
  it('rejects content-length oversize without reading the body', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { headers: { 'Content-Length': String(TEXT_LIMIT + 1) } }),
        ),
    );
    render(<FilePreviewButton filename="code.txt" url="/api/v1/files/large/download" />);
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent(/όριο/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('aborts and cancels a hanging body on native dialog cancel', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn().mockResolvedValue(new Response(stream));
    vi.stubGlobal('fetch', fetcher);
    render(<FilePreviewButton filename="code.txt" url="/api/v1/files/test/download" />);
    open();
    await waitFor(() => expect(stream.locked).toBe(true));
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(stream.locked).toBe(false));
  });
  it('revokes the image object URL when its owner unmounts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(png)));
    const view = render(<FilePreviewButton filename="image.png" url={url} />);
    open();
    await screen.findByRole('img');
    view.unmount();
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith('blob:synthetic-image');
  });
  it('keeps image decoding visibly busy until load, and stops the indicator on a decode error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response(png))),
    );
    render(<FilePreviewButton filename="image.png" url={url} />);
    open();
    const image = await screen.findByRole('img');
    expect(screen.getByRole('status')).toHaveTextContent('Φόρτωση');
    fireEvent.load(image);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.error(image);
    expect(screen.getByRole('alert')).toHaveTextContent(/αποκωδικοποιήθηκε/);
    expect(screen.queryByRole('status')).toBeNull();
  });
  it.each(['oversized', 'truncated'])('rejects %s image headers before creating a blob or decoder', async (caseName) => {
    const bytes = png.slice();
    if (caseName === 'oversized') new DataView(bytes.buffer).setUint32(16, 0xffffffff);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      caseName === 'truncated' ? bytes.subarray(0, 8) : bytes,
    )));
    render(<FilePreviewButton filename="image.png" url={url} />);
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent(/μορφή/);
    expect(createURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('link')).toHaveAttribute('href', url);
  });
  it('honors an explicit button label', () => {
    render(
      <FilePreviewButton
        filename="x.zip"
        url="/api/v1/files/test/download"
        label="Άνοιγμα προεπισκόπησης"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Άνοιγμα προεπισκόπησης' }));
    expect(screen.getByRole('dialog', { name: 'x.zip' })).toBeInTheDocument();
  });
});
