import { useEffect, useRef, useState } from 'react';
import { api, download, id, labPath } from './api';
import { Empty, Field, LoadState, More, useDirty, useResource } from './ui';
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
    <section className="panel">
      <h3>Περιεχόμενα επιλεγμένης παράδοσης</h3>
      <p className="mono muted">{submissionId}</p>
      <LoadState {...submission} retry={submission.reload}>
        {submission.value && (
          <>
            <div className="actions">
              <a className="button" download href={download(submission.value.file_id)}>
                Λήψη ZIP · {submission.value.filename}
              </a>
              <span className="badge">{submission.value.archive_status}</span>
            </div>
            <p className="small mono muted">SHA-256: {submission.value.sha256}</p>
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
                  {m.is_dir ||
                  m.is_directory ||
                  m.status === 'blocked' ||
                  submission.value?.archive_status === 'blocked' ? (
                    <span>{m.path}</span>
                  ) : (
                    <a
                      download
                      href={`/api/v1/submissions/${id(submissionId)}/members/content?path=${encodeURIComponent(m.path)}`}
                    >
                      {m.path}
                    </a>
                  )}
                  {Array.isArray(m.errors) && m.errors.length > 0 && (
                    <div className="small error">
                      {m.errors.map((error, index) => (
                        <div key={index}>{String(error)}</div>
                      ))}
                    </div>
                  )}
                </span>
                <span className="muted small">{m.size ?? '—'} bytes</span>
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
        Τα αρχεία παρέχονται μόνο για λήψη. Δεν εκτελείται κώδικας φοιτητών.
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
                    <p className="small muted">{s.created_at}</p>
                    <p className="mono small">{s.id}</p>
                    <p className="small mono muted">SHA-256: {s.sha256}</p>
                    <span className="badge">{s.archive_status}</span>
                    {s.archive_errors?.length > 0 && (
                      <p className="warn">Προβλήματα αρχείου · {s.archive_errors.length}</p>
                    )}
                  </div>
                  <div className="actions item-actions">
                    <button
                      aria-label={`Επιλογή παράδοσης ${s.id}`}
                      onClick={() => {
                        if (!operations.locked.current) setSelected(s.id);
                      }}
                    >
                      {selected === s.id ? 'Επιλεγμένη' : 'Προβολή περιεχομένων'}
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
                </article>
              ))}
            </div>
          )}
          {!pending && (
            <More count={items.length} total={total} busy={loadingMore} onMore={onMore} />
          )}
          {selected ? (
            <Inventory key={selected} submissionId={selected} />
          ) : (
            items.length > 0 && (
              <p className="notice">
                Επιλέξτε ρητά μία παράδοση για προβολή περιεχομένων. Δεν επιλέγεται αυτόματα η
                νεότερη ή η καλύτερη.
              </p>
            )
          )}
        </section>
      </fieldset>
    </OperationContext.Provider>
  );
}
