import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  classifyPreview,
  imageMIME,
  previewLimit,
  readPreviewBytes,
  safePreviewURL,
  validatePreviewBytes,
} from './filePreviewHelpers';
import { openPreviewPDF, type PreviewPDF } from './filePreviewPDF';
import './FilePreview.css';

export type FilePreviewButtonProps = {
  filename: string;
  url: string;
  size?: number;
  label?: string;
};
export default function FilePreviewButton({
  filename,
  url,
  size,
  label = 'Προβολή',
}: FilePreviewButtonProps) {
  const [target, setTarget] = useState<{ filename: string; url: string } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const shown = target?.filename === filename && target.url === url;
  // Target replacement invalidates even an A -> B -> A sequence.
  useEffect(() => {
    setTarget(null);
  }, [filename, url]);
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="file-preview-button"
        onClick={() => setTarget({ filename, url })}
      >
        {label}
      </button>
      {shown && (
        <PreviewDialog
          filename={filename}
          url={url}
          size={size}
          onClose={() => setTarget(null)}
          restoreFocus={() => {
            if (trigger.current?.isConnected) trigger.current.focus();
          }}
        />
      )}
    </>
  );
}
export { FilePreviewButton };

type Content =
  | { kind: 'text'; text: string }
  | { kind: 'image'; src: string }
  | { kind: 'pdf'; pdf: PreviewPDF };
function PreviewDialog({
  filename,
  url,
  size,
  onClose,
  restoreFocus,
}: Omit<FilePreviewButtonProps, 'label'> & { onClose: () => void; restoreFocus: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const heading = useId(),
    description = useId();
  const backdrop = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const safeURL = safePreviewURL(url),
    kind = classifyPreview(filename);
  const unavailable = !kind || (size !== undefined && size > previewLimit(kind));
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    closeButton.current?.focus();
    return () => {
      if (node.open) node.close();
      restoreFocus();
    };
  }, []);
  useEffect(() => {
    if (!safeURL || !kind || unavailable) return;
    const controller = new AbortController();
    let active = true,
      objectURL: string | undefined,
      pdf: PreviewPDF | undefined;
    setContent(null);
    setError('');
    setImageLoading(false);
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(safeURL, {
          credentials: 'same-origin',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!active) {
          void response.body?.cancel().catch(() => {});
          return;
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          if (response.status === 401) window.dispatchEvent(new Event('catalog:unauthorized'));
          throw new Error(`Σφάλμα HTTP ${response.status}. Η προεπισκόπηση δεν φορτώθηκε.`);
        }
        const data = await readPreviewBytes(response, previewLimit(kind), controller.signal);
        if (!active) return;
        validatePreviewBytes(data, kind);
        if (kind === 'text') setContent({ kind: 'text', text: new TextDecoder().decode(data) });
        else if (kind === 'pdf') {
          const loaded = await openPreviewPDF(data, controller.signal);
          if (!active) {
            void loaded.destroy().catch(() => {});
            return;
          }
          pdf = loaded;
          setContent({ kind: 'pdf', pdf });
        } else {
          objectURL = URL.createObjectURL(new Blob([data], { type: imageMIME(kind) }));
          setImageLoading(true);
          setContent({ kind: 'image', src: objectURL });
        }
      } catch (cause) {
        if (active && !controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Αδυναμία φόρτωσης προεπισκόπησης.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
      if (pdf) void pdf.destroy().catch(() => {});
    };
  }, [safeURL, kind, unavailable, attempt]);
  return createPortal(
    <dialog
      ref={dialog}
      className="file-preview-dialog"
      aria-modal="true"
      aria-labelledby={heading}
      aria-describedby={description}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onMouseDown={(event) => {
        backdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (backdrop.current && event.target === event.currentTarget) onClose();
        backdrop.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled),a[href],pre[tabindex]',
          ),
        );
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <div className="file-preview-panel">
        <header className="file-preview-header">
          <h2 id={heading}>{filename}</h2>
          <button
            type="button"
            ref={closeButton}
            aria-label="Κλείσιμο προεπισκόπησης"
            onClick={onClose}
          >
            Κλείσιμο <span aria-hidden="true">×</span>
          </button>
        </header>
        <p id={description} className="file-preview-description">
          Ασφαλής προεπισκόπηση · το πρωτότυπο παραμένει διαθέσιμο για λήψη.
        </p>
        <div className="file-preview-content" aria-busy={loading || imageLoading}>
          {!safeURL ? (
            <p role="alert">Μη έγκυρη διεύθυνση αρχείου.</p>
          ) : unavailable ? (
            <p role="status">
              Δεν είναι διαθέσιμη προεπισκόπηση για αυτή τη μορφή ή το μέγεθος. Χρησιμοποιήστε τη
              λήψη πρωτοτύπου.
            </p>
          ) : (
            <>
              {(loading || imageLoading) && <p role="status">Φόρτωση προεπισκόπησης…</p>}
              {error && (
                <div>
                  <p role="alert">{error}</p>
                  <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                    Δοκιμή ξανά
                  </button>
                </div>
              )}
              {!error && content?.kind === 'text' && (
                <pre
                  className="file-preview-text"
                  tabIndex={0}
                  aria-label="Περιεχόμενο ως απλό κείμενο"
                >
                  {content.text}
                </pre>
              )}
              {!error && content?.kind === 'pdf' && (
                <PDFCanvas pdf={content.pdf} onError={setError} />
              )}
              {!error && content?.kind === 'image' && (
                <img
                  className="file-preview-image"
                  src={content.src}
                  alt={filename}
                  onLoad={() => setImageLoading(false)}
                  onError={() => {
                    setImageLoading(false);
                    setError('Η εικόνα δεν αποκωδικοποιήθηκε. Χρησιμοποιήστε τη λήψη πρωτοτύπου.');
                  }}
                />
              )}
            </>
          )}
        </div>
        <footer className="file-preview-footer">
          {safeURL && (
            <a href={safeURL} download={filename}>
              Λήψη πρωτοτύπου
            </a>
          )}
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}

function PDFCanvas({ pdf, onError }: { pdf: PreviewPDF; onError: (error: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(1),
    [zoom, setZoom] = useState(1),
    [busy, setBusy] = useState(true);
  useEffect(() => {
    const node = canvas.current!;
    const controller = new AbortController();
    setBusy(true);
    void pdf
      .render(node, page, zoom, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setBusy(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          onError(error instanceof Error ? error.message : 'Αδυναμία απόδοσης σελίδας PDF.');
      });
    return () => {
      controller.abort();
      node.width = 0;
      node.height = 0;
    };
  }, [pdf, page, zoom, onError]);
  return (
    <section className="file-preview-pdf" aria-label="Προεπισκόπηση PDF">
      <div className="file-preview-pdf-tools" role="group" aria-label="Σελίδες και μεγέθυνση PDF">
        <button
          type="button"
          aria-label="Προηγούμενη σελίδα"
          disabled={busy || page <= 1}
          onClick={() => setPage((n) => Math.max(1, n - 1))}
        >
          ← Προηγούμενη
        </button>
        <span role="status">
          {busy ? 'Απόδοση σελίδας… ' : ''}Σελίδα {page} από {pdf.numPages}
        </span>
        <button
          type="button"
          aria-label="Επόμενη σελίδα"
          disabled={busy || page >= pdf.numPages}
          onClick={() => setPage((n) => Math.min(pdf.numPages, n + 1))}
        >
          Επόμενη →
        </button>
        <button
          type="button"
          aria-label="Σμίκρυνση"
          disabled={busy || zoom <= 0.25}
          onClick={() => setZoom((n) => Math.max(0.25, n - 0.25))}
        >
          −
        </button>
        <span aria-label="Ποσοστό μεγέθυνσης">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label="Μεγέθυνση"
          disabled={busy || zoom >= 3}
          onClick={() => setZoom((n) => Math.min(3, n + 0.25))}
        >
          +
        </button>
      </div>
      <canvas
        ref={canvas}
        style={{ width: `${zoom * 100}%` }}
        role="img"
        aria-label={`Σελίδα ${page} από ${pdf.numPages}`}
        aria-busy={busy}
      >
        Η σελίδα PDF αποδίδεται ως εικόνα. Για το πλήρες προσβάσιμο έγγραφο χρησιμοποιήστε τη λήψη
        πρωτοτύπου.
      </canvas>
      <p className="file-preview-pdf-note">
        Μόνο εικόνα σελίδας · χωρίς ενεργούς συνδέσμους, φόρμες ή σενάρια. Η ανάλυση περιορίζεται
        για ασφαλή χρήση μνήμης.
      </p>
    </section>
  );
}
