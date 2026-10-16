import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';

export const MAX_PDF_PIXELS = 10_000_000;
const MAX_DIMENSION = 16384;
export function boundedPDFViewport(width: number, height: number, zoom: number) {
  if (
    ![width, height, zoom].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(width * height)
  )
    throw new Error('Μη έγκυρες διαστάσεις σελίδας PDF.');
  const scale = Math.min(
    Math.max(0.25, Math.min(3, zoom)),
    Math.sqrt(MAX_PDF_PIXELS / (width * height)),
    MAX_DIMENSION / width,
    MAX_DIMENSION / height,
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}
export interface PreviewPDF {
  numPages: number;
  render(canvas: HTMLCanvasElement, page: number, zoom: number, signal: AbortSignal): Promise<void>;
  destroy(): Promise<void>;
}
const aborted = () => new DOMException('Η προεπισκόπηση ακυρώθηκε.', 'AbortError');

export async function openPreviewPDF(
  data: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<PreviewPDF> {
  // No PDF engine is parsed until a bounded, validated PDF has been requested.
  const engine = await import('pdfjs-dist');
  if (signal.aborted) throw aborted();
  engine.GlobalWorkerOptions.workerSrc = workerURL;
  // v6 removed the old eval implementation entirely. Retain the explicit false
  // guard as defense in depth if this adapter is ever backported to an older API.
  // Derive the options from the public API; v6 doesn't re-export their named type.
  const options: NonNullable<Parameters<typeof engine.getDocument>[0]> & {
    isEvalSupported: false;
  } = {
    data,
    isEvalSupported: false,
    enableXfa: false,
    useWorkerFetch: false,
    useWasm: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    stopAtErrors: true,
    maxImageSize: MAX_PDF_PIXELS,
    canvasMaxAreaInBytes: MAX_PDF_PIXELS * 4,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  };
  const task = engine.getDocument(options);
  let destroyed: Promise<void> | undefined;
  const destroy = () => (destroyed ??= task.destroy());
  const cancelLoading = () => {
    void destroy().catch(() => {});
  };
  signal.addEventListener('abort', cancelLoading, { once: true });
  try {
    const doc = await task.promise;
    if (signal.aborted) throw aborted();
    let queue: Promise<void> = Promise.resolve();
    return {
      numPages: doc.numPages,
      destroy: async () => {
        signal.removeEventListener('abort', cancelLoading);
        await destroy();
      },
      render: (canvas, number, zoom, renderSignal) => {
        // Serialize onto one canvas; cancelled pages must release it before the
        // next page starts. Only one page's resources survive at any time.
        const run = async () => {
          if (renderSignal.aborted || destroyed) throw aborted();
          if (!Number.isInteger(number) || number < 1 || number > doc.numPages)
            throw new Error('Μη έγκυρη σελίδα PDF.');
          let page: PDFPageProxy | undefined, renderTask: RenderTask | undefined;
          const cancelRender = () => renderTask?.cancel();
          renderSignal.addEventListener('abort', cancelRender, { once: true });
          try {
            page = await doc.getPage(number);
            if (renderSignal.aborted || destroyed) throw aborted();
            const base = page.getViewport({ scale: 1 });
            const bounds = boundedPDFViewport(base.width, base.height, zoom);
            canvas.width = bounds.width;
            canvas.height = bounds.height;
            renderTask = page.render({
              canvas,
              viewport: page.getViewport({ scale: bounds.scale }),
              annotationMode: engine.AnnotationMode.DISABLE,
            });
            await renderTask.promise;
            if (renderSignal.aborted || destroyed) throw aborted();
          } catch (error) {
            if (renderSignal.aborted || destroyed) throw aborted();
            throw error;
          } finally {
            renderSignal.removeEventListener('abort', cancelRender);
            page?.cleanup();
          }
        };
        const result = queue.then(run);
        queue = result.catch(() => {});
        return result;
      },
    };
  } catch (error) {
    signal.removeEventListener('abort', cancelLoading);
    await destroy().catch(() => {});
    if (signal.aborted) throw aborted();
    throw error;
  }
}
