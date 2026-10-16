import { useEffect, useRef, useState } from 'react';
import { api, download, id, labPath } from './api';
import {
  Empty,
  Field,
  LoadState,
  More,
  archiveStatus,
  fileSize,
  greekDate,
  useDirty,
  useResource,
} from './ui';
import { FilePreviewButton } from './FilePreview';
import type { ArchiveMember, Page, Submission } from './types';
import Removal from './Removal';
import { OperationContext, useOperations } from './OperationContext';
function Inventory({ submissionId }: { submissionId: string }) {
  const submission = useResource<Submission>(`/submissions/${id(submissionId)}`);
  const inventory = useResource<
    Page<ArchiveMember> | ArchiveMember[] | { members: ArchiveMember[] }
  >(`/submissions/${id(submissionId)}/members?limit=100&offset=0`);
  const [extra, setExtra] = useState<ArchiveMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const value = inventory.value;
  const entries = Array.isArray(value)
    ? value
    : value && 'items' in value
      ? value.items
      : value?.members || [];
  const members = [...entries, ...extra];
  const total = value && !Array.isArray(value) && 'total' in value ? value.total : members.length;
  return (
    <section className="panel submission-inventory">
      <h3>Περιεχόμενα επιλεγμένης παράδοσης</h3>
      <LoadState {...submission} retry={submission.reload}>
        {submission.value && (
          <>
            <div className="actions">
              <a className="button" download href={download(submission.value.file_id)}>
                Λήψη ZIP · {submission.value.filename}
              </a>
              <span className="badge">{archiveStatus(submission.value.archive_status)}</span>
            </div>

            {submission.value.archive_errors?.length > 0 && (
              <div className="notice error">
                <h4>Προβλήματα αρχείου</h4>
                <pre>{JSON.stringify(submission.value.archive_errors, null, 2)}</pre>
              </div>
            )}
          </>
        )}
      </LoadState>
      <LoadState {...inventory} retry={inventory.reload}>
        {members.length === 0 ? (
          <Empty>Δεν υπάρχουν διαθέσιμα μέλη αρχείου.</Empty>
        ) : (
          <ul className="inventory">
            {members.map((m, index) => (
              <li key={`${m.path}-${index}`}>
                <span>
                  <span>{m.path}</span>
                  {Array.isArray(m.errors) && m.errors.length > 0 && (
                    <div className="small error">
                      {m.errors.map((error, index) => (
                        <div key={index}>{String(error)}</div>
                      ))}
                    </div>
                  )}
                </span>
                <span className="member-actions">
                  <span
                    className="muted small"
                    title={m.size === undefined ? undefined : `${m.size} bytes`}
                  >
                    {fileSize(m.size)}
                  </span>
                  {!m.is_dir &&
                    !m.is_directory &&
                    m.status !== 'blocked' &&
                    submission.value &&
                    submission.value.archive_status !== 'blocked' && (
                      <>
                        <FilePreviewButton
                          filename={m.path}
                          url={`/api/v1/submissions/${id(submissionId)}/members/content?path=${encodeURIComponent(m.path)}`}
                          size={m.size}
                        />
                        <a
                          className="button"
                          download
                          href={`/api/v1/submissions/${id(submissionId)}/members/content?path=${encodeURIComponent(m.path)}`}
                        >
                          Λήψη
                        </a>
                      </>
                    )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <More
          count={members.length}
          total={total}
          busy={busy}
          onMore={async () => {
            setBusy(true);
            try {
              const p = await api<Page<ArchiveMember>>(
                `/submissions/${id(submissionId)}/members?limit=100&offset=${members.length}`,
              );
              setExtra((x) => [...x, ...p.items]);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
        {error && <p role="alert">{error}</p>}
      </LoadState>
      <p className="small muted">
        Προεπισκόπηση υποστηριζόμενων αρχείων ή λήψη του πρωτοτύπου. Δεν εκτελείται κώδικας
        φοιτητών.
      </p>
    </section>
  );
}
export default function Submissions({
  labId,
  teamId,
  items,
  total,
  busy: loadingMore,
  pending = false,
  onMore,
  onRefresh,
}: {
  labId: string;
  teamId: string;
  items: Submission[];
  total: number;
  busy: boolean;
  pending?: boolean;
  onMore: () => void;
  onRefresh: () => void;
}) {
  const operations = useOperations();
  const owner = useRef(Symbol('submissions-upload'));
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  useDirty(files.length > 0 || busy);
  useEffect(() => {
    if (!pending && selected && !items.some((s) => s.id === selected)) setSelected(undefined);
  }, [items, pending, selected]);
  async function upload() {
    if (!operations.acquireSave(owner.current)) return;
    const selectedFiles = files;
    let completed = 0;
    try {
      if (!selectedFiles.length) return;
      setBusy(true);
      setError('');
      setSuccess('');
      for (const file of selectedFiles) {
        const form = new FormData();
        form.append('file', file);
        const result = await api<Submission>(`${labPath(labId)}/teams/${id(teamId)}/submissions`, {
          method: 'POST',
          body: form,
        });
        const saved = await api<Submission>(`/submissions/${id(result.id)}`);
        if (saved.id !== result.id) throw new Error('Η παράδοση δεν επιβεβαιώθηκε.');
        completed++;
      }
      setFiles([]);
      if (fileInput.current) fileInput.current.value = '';
      setSuccess(`${completed} παραδόσεις αποθηκεύτηκαν και επιβεβαιώθηκαν.`);
    } catch (e) {
      setFiles(selectedFiles.slice(completed));
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onRefresh();
      operations.releaseSave(owner.current);
    }
  }
  return (
    <OperationContext.Provider value={operations}>
      <fieldset disabled={operations.pending} className="form-fields">
        <section>
          <div className="section-heading">
            <div>
              <h2>Παραδόσεις ZIP</h2>
              <p className="muted">
                Κάθε μεταφόρτωση είναι ξεχωριστή έκδοση — ακόμη και με ίδιο αποτύπωμα.
              </p>
            </div>
          </div>
          <div className="panel upload-panel">
            <Field label="Αρχεία ZIP">
              <input
                ref={fileInput}
                disabled={busy}
                type="file"
                accept=".zip,application/zip"
                multiple
                onChange={(e) => {
                  if (operations.locked.current || operations.saves.current.has(owner.current))
                    return;
                  setFiles(Array.from(e.target.files || []));
                  setSuccess('');
                }}
              />
            </Field>
            <button
              className="primary"
              disabled={busy || files.length === 0}
              onClick={() => void upload()}
            >
              {busy ? 'Μεταφόρτωση…' : 'Μεταφόρτωση ZIP'}
            </button>
            {files.length > 0 && (
              <p className="small muted">{files.map((f) => f.name).join(' · ')}</p>
            )}
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            {success && (
              <p role="status" className="success">
                {success}
              </p>
            )}
          </div>
          {pending && items.length === 0 ? null : items.length === 0 ? (
            <Empty>Δεν υπάρχουν παραδόσεις για αυτή την ομάδα.</Empty>
          ) : (
            <div className="versions">
              {items.map((s) => (
                <article className={selected === s.id ? 'version selected' : 'version'} key={s.id}>
                  <div>
                    <h3>{s.filename}</h3>
                    <p className="small muted">
                      {greekDate(s.created_at)} · Έκδοση {s.id.slice(0, 8)}
                    </p>
                    <span className="badge">{archiveStatus(s.archive_status)}</span>
                    <details className="technical-metadata">
                      <summary>Μεταδεδομένα παράδοσης</summary>
                      <dl>
                        <dt>ID</dt>
                        <dd className="mono">{s.id}</dd>
                        <dt>SHA-256</dt>
                        <dd className="mono">{s.sha256}</dd>
                        <dt>Δημιουργήθηκε</dt>
                        <dd>{s.created_at}</dd>
                        <dt>Κατάσταση</dt>
                        <dd>{s.archive_status}</dd>
                      </dl>
                    </details>
                    {s.archive_errors?.length > 0 && (
                      <p className="warn">Προβλήματα αρχείου · {s.archive_errors.length}</p>
                    )}
                  </div>
                  <div className="actions item-actions">
                    <button
                      aria-label={`${selected === s.id ? 'Απόκρυψη αρχείων' : 'Προβολή αρχείων'} · ${s.filename} · ${s.id.slice(0, 8)}`}
                      aria-expanded={selected === s.id}
                      aria-controls={`inventory-${s.id}`}
                      onClick={() => {
                        if (!operations.locked.current)
                          setSelected((current) => (current === s.id ? undefined : s.id));
                      }}
                    >
                      {selected === s.id ? 'Απόκρυψη αρχείων' : 'Προβολή αρχείων'}
                    </button>
                    <Removal
                      path={`${labPath(labId)}/teams/${id(teamId)}/submissions/${id(s.id)}`}
                      readPath={`/submissions/${id(s.id)}`}
                      title={s.filename}
                      kind="παράδοσης"
                      onRemoved={() => {
                        setSelected((current) => (current === s.id ? undefined : current));
                        onRefresh();
                      }}
                    />
                  </div>
                  {selected === s.id && (
                    <div id={`inventory-${s.id}`} className="version-inventory">
                      <Inventory key={s.id} submissionId={s.id} />
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
          {!pending && (
            <More count={items.length} total={total} busy={loadingMore} onMore={onMore} />
          )}
          {!selected && items.length > 0 && (
            <p className="notice">
              Επιλέξτε ρητά μία παράδοση για προβολή περιεχομένων. Δεν επιλέγεται αυτόματα η νεότερη
              ή η καλύτερη.
            </p>
          )}
        </section>
      </fieldset>
    </OperationContext.Provider>
  );
}
