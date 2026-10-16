import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boundedPDFViewport, openPreviewPDF, MAX_PDF_PIXELS } from '../filePreviewPDF';
const fake = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' },
  AnnotationMode: { DISABLE: 0 },
}));
vi.mock('pdfjs-dist', () => fake);
const viewport = (width = 600, height = 800) => ({
  getViewport: ({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale }),
});
beforeEach(() => vi.clearAllMocks());
describe('bounded PDF.js adapter', () => {
  it('bounds dimensions, total pixels and zoom even for enormous pages', () => {
    expect(MAX_PDF_PIXELS).toBe(10_000_000);
    for (const [width, height] of [
      [600, 800],
      [1000000, 1000000],
      [1, 100000000],
    ]) {
      for (const zoom of [0.01, 1, 1000]) {
        const size = boundedPDFViewport(width, height, zoom);
        expect(size.width * size.height).toBeLessThanOrEqual(MAX_PDF_PIXELS);
        expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(16384);
        expect(size.width).toBeGreaterThan(0);
        expect(size.height).toBeGreaterThan(0);
      }
    }
  });
  it.each([0, -1, Infinity, NaN])('rejects invalid page dimensions %s', (width) =>
    expect(() => boundedPDFViewport(width, 800, 1)).toThrow(),
  );
  it('passes typed bytes only with scripting/XFA/fetch/annotation hardening, using the self-hosted worker', async () => {
    const render = vi.fn().mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
    const cleanup = vi.fn();
    const destroy = vi.fn().mockResolvedValue(undefined);
    const page = { ...viewport(), render, cleanup };
    const getPage = vi.fn().mockResolvedValue(page);
    fake.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 2, getPage }),
      destroy,
    });
    const data = new Uint8Array([37, 80, 68, 70, 45]);
    const signal = new AbortController().signal;
    const pdf = await openPreviewPDF(data, signal);
    expect(pdf.numPages).toBe(2);
    expect(fake.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        data,
        isEvalSupported: false,
        enableXfa: false,
        useWorkerFetch: false,
        disableAutoFetch: true,
        disableStream: true,
        maxImageSize: 10_000_000,
        canvasMaxAreaInBytes: 40_000_000,
      }),
    );
    const options = fake.getDocument.mock.calls[0][0];
    expect(options.url).toBeUndefined();
    expect(options.docBaseUrl).toBeUndefined();
    expect(fake.GlobalWorkerOptions.workerSrc).toMatch(/pdf\.worker.*\.mjs/);
    expect(fake.GlobalWorkerOptions.workerSrc).not.toMatch(/^https?:\/\/[^/]*(cdn|unpkg)/);
    const canvas = document.createElement('canvas');
    await pdf.render(canvas, 2, 1, signal);
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(getPage).toHaveBeenCalledWith(2);
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ canvas, annotationMode: 0 }));
    expect(cleanup).toHaveBeenCalledTimes(1);
    await pdf.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
  it('destroys failed loading tasks', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    fake.getDocument.mockReturnValue({ promise: Promise.reject(new Error('corrupt')), destroy });
    await expect(openPreviewPDF(new Uint8Array(), new AbortController().signal)).rejects.toThrow(
      'corrupt',
    );
    expect(destroy).toHaveBeenCalledTimes(1);
  });
  it('destroys an in-flight loading task immediately on abort', async () => {
    let reject!: (error: Error) => void;
    const destroy = vi.fn().mockImplementation(() => {
      reject(new Error('destroyed'));
      return Promise.resolve();
    });
    fake.getDocument.mockReturnValue({
      promise: new Promise((_resolve, r) => {
        reject = r;
      }),
      destroy,
    });
    const control = new AbortController();
    const result = openPreviewPDF(new Uint8Array(), control.signal);
    await vi.waitFor(() => expect(fake.getDocument).toHaveBeenCalled());
    control.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(destroy).toHaveBeenCalledTimes(1);
  });
  it('cancels page rendering on abort and cleans its page without rendering other pages', async () => {
    let reject!: (error: Error) => void;
    const cancel = vi.fn().mockImplementation(() => reject(new Error('cancelled')));
    const cleanup = vi.fn();
    const page = {
      ...viewport(),
      cleanup,
      render: vi.fn().mockReturnValue({
        promise: new Promise((_r, j) => {
          reject = j;
        }),
        cancel,
      }),
    };
    const destroy = vi.fn().mockResolvedValue(undefined);
    fake.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 8, getPage: vi.fn().mockResolvedValue(page) }),
      destroy,
    });
    const pdf = await openPreviewPDF(new Uint8Array(), new AbortController().signal);
    const controller = new AbortController();
    const result = pdf.render(document.createElement('canvas'), 1, 1, controller.signal);
    await vi.waitFor(() => expect(page.render).toHaveBeenCalled());
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await pdf.destroy();
  });
  it('rejects out-of-range pages without getting a page', async () => {
    const getPage = vi.fn();
    fake.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 2, getPage }),
      destroy: vi.fn().mockResolvedValue(undefined),
    });
    const pdf = await openPreviewPDF(new Uint8Array(), new AbortController().signal);
    await expect(
      pdf.render(document.createElement('canvas'), 3, 1, new AbortController().signal),
    ).rejects.toThrow();
    expect(getPage).not.toHaveBeenCalled();
    await pdf.destroy();
  });
});
