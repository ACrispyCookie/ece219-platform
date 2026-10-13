import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

// Native showModal supplies background inertness and focus containment. Portal
// placement keeps these controls outside the operation scope's disabled fieldset.
export default function RemovalDialog({
  kind,
  title,
  counts,
  busy,
  onChoice,
}: {
  kind: string;
  title: string;
  counts: { label: string; count: number }[];
  busy: boolean;
  onChoice: (confirmed: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const backdropStart = useRef(false);
  const heading = useId(),
    description = useId();
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    cancel.current?.focus();
    return () => {
      if (node.open) node.close();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="removal-dialog"
      aria-modal="true"
      aria-labelledby={heading}
      aria-describedby={description}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onChoice(false);
      }}
      onMouseDown={(event) => {
        backdropStart.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (backdropStart.current && event.target === event.currentTarget && !busy) onChoice(false);
        backdropStart.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        );
        if (!buttons.length) {
          event.preventDefault();
          return;
        }
        const first = buttons[0],
          last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="removal-dialog-panel">
        <header className="removal-dialog-header">
          <span className="removal-dialog-icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" />
            </svg>
          </span>
          <h2 id={heading}>Οριστική διαγραφή {kind}</h2>
          <button
            type="button"
            className="removal-dialog-close"
            aria-label="Κλείσιμο επιβεβαίωσης"
            disabled={busy}
            onClick={() => onChoice(false)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <p className="removal-dialog-target">«{title}»</p>
        <p className="removal-dialog-caption">Θα διαγραφούν οι παρακάτω εγγραφές:</p>
        <dl className="removal-dialog-counts">
          {counts.map(({ label, count }) => (
            <div key={label}>
              <dt>{label}:</dt>
              <dd>{count}</dd>
            </div>
          ))}
        </dl>
        <p id={description} className="removal-dialog-warning">
          Η ενέργεια δεν αναιρείται. Περιλαμβάνονται οι σχετικές σημειώσεις και το ιστορικό
          αξιολογήσεων που αναφέρονται παραπάνω.
        </p>
        <p className="removal-dialog-note">
          Ανεξάρτητα ή κοινόχρηστα δεδομένα άλλων εγγραφών δεν αφαιρούνται. Αφαιρούνται μεταδεδομένα
          αρχείων, όχι το κοινόχρηστο αποθηκευμένο περιεχόμενο· δεν γίνεται ασφαλής διαγραφή των
          bytes.
        </p>
        <footer className="removal-dialog-actions">
          <span role="status" className="removal-dialog-status">
            {busy ? 'Διαγραφή και επιβεβαίωση στον διακομιστή…' : ''}
          </span>
          <button
            ref={cancel}
            type="button"
            aria-label="Ακύρωση διαγραφής"
            disabled={busy}
            onClick={() => onChoice(false)}
          >
            Ακύρωση
          </button>
          <button
            type="button"
            className="removal-dialog-confirm"
            aria-label="Οριστική διαγραφή"
            disabled={busy}
            onClick={() => onChoice(true)}
          >
            {busy ? 'Διαγραφή…' : 'Οριστική διαγραφή'}
          </button>
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}
