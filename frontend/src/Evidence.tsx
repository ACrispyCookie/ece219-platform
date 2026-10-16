import { useContext, useEffect, useRef, useState } from 'react';
import { api, id, json, labPath } from './api';
import { FileMetadata, findSaved, safeURL, uploadFile } from './files';
import Removal from './Removal';
import { OperationContext, useOperations } from './OperationContext';
import {
  DirtyContext,
  Empty,
  Field,
  LoadState,
  More,
  greekDate,
  sourceLabel,
  submissionLabel,
  useDirty,
  useEditRequest,
  usePaged,
} from './ui';
import type { Evidence, StoredFile, Submission } from './types';
import { EvidenceCorrection } from './CatalogCorrections';
import { parseResultJSON, stringifyJSON } from './resultJSON';
function EvidenceForm({
  labId,
  teamId,
  exerciseId,
  submissions,
  onSaved,
  onCancel,
}: {
  labId: string;
  teamId: string;
  exerciseId: string;
  submissions: Submission[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const operations = useOperations();
  const owner = useRef(Symbol('evidence-upload'));
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<Evidence['kind']>('text');
  const [text, setText] = useState('');
  const [url, setURL] = useState('');
  const [data, setData] = useState('');
  const [submissionId, setSubmissionId] = useState('');
  const [file, setFile] = useState<File>();
  const uploaded = useRef<StoredFile | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fileInfo, setFileInfo] = useState<StoredFile>();
  const base = `${labPath(labId)}/teams/${id(teamId)}/evidence`;
  useDirty(
    !!title || kind !== 'text' || !!text || !!url || !!data || !!submissionId || !!file || busy,
  );
  async function submit() {
    if (!operations.acquireSave(owner.current)) return;
    setError('');
    try {
      if (!title.trim()) {
        setError('Συμπληρώστε τίτλο τεκμηρίου.');
        return;
      }
      if (kind === 'link' && !safeURL(url)) {
        setError('Επιτρέπονται μόνο σύνδεσμοι http ή https.');
        return;
      }
      let parsed: unknown;
      try {
        if (kind === 'result') parsed = parseResultJSON(data);
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      if (kind === 'file' && !file) {
        setError('Επιλέξτε αρχείο τεκμηρίου.');
        return;
      }
      if (kind === 'text' && !text.trim()) {
        setError('Συμπληρώστε κείμενο τεκμηρίου.');
        return;
      }
      setBusy(true);
      if (kind === 'file' && !uploaded.current) {
        uploaded.current = await uploadFile(labId, file!, teamId);
        setFileInfo(uploaded.current);
      }
      const saved = await api<Evidence>(
        base,
        json('POST', {
          exercise_id: exerciseId,
          submission_id: submissionId || null,
          kind,
          title,
          source: 'human',
          ...(kind === 'text' ? { text } : {}),
          ...(kind === 'link' ? { url } : {}),
          ...(kind === 'result' ? { data: parsed } : {}),
          ...(kind === 'file' ? { file_id: uploaded.current!.id } : {}),
        }),
      );
      await findSaved<Evidence>(`${base}?exercise_id=${id(exerciseId)}`, saved.id);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      operations.releaseSave(owner.current);
    }
  }
  return (
    <section className="panel">
      <h3>Νέο τεκμήριο</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset
          disabled={busy || operations.pending}
          className="form-fields"
          onChangeCapture={(e) => {
            if (operations.locked.current || operations.saves.current.has(owner.current))
              e.stopPropagation();
          }}
        >
          <Field label="Τίτλος τεκμηρίου">
            <input value={title} required onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <div className="form-grid">
            <Field label="Είδος τεκμηρίου">
              <select value={kind} onChange={(e) => setKind(e.target.value as Evidence['kind'])}>
                <option value="text">Κείμενο</option>
                <option value="link">Σύνδεσμος</option>
                <option value="file">Αρχείο</option>
                <option value="result">Αποτέλεσμα JSON</option>
              </select>
            </Field>
            <Field label="Παράδοση τεκμηρίου">
              <select value={submissionId} onChange={(e) => setSubmissionId(e.target.value)}>
                <option value="">Χωρίς σύνδεση με παράδοση</option>
                {submissions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {submissionLabel(s)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {kind === 'text' && (
            <Field label="Κείμενο τεκμηρίου">
              <textarea value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          )}
          {kind === 'link' && (
            <Field label="Σύνδεσμος">
              <input value={url} onChange={(e) => setURL(e.target.value)} placeholder="https://…" />
            </Field>
          )}
          {kind === 'result' && (
            <>
              <Field label="Αποτέλεσμα JSON">
                <textarea className="mono" value={data} onChange={(e) => setData(e.target.value)} />
              </Field>
              <p className="notice">
                Το αποτέλεσμα είναι τεκμήριο, όχι βαθμός μαθήματος. Δεν εκτελείται και δεν
                υπολογίζει αυτόματα βαθμό.
              </p>
            </>
          )}
          {kind === 'file' && (
            <Field label="Αρχείο τεκμηρίου">
              <input
                type="file"
                onChange={(e) => {
                  setFile(e.target.files?.[0]);
                  uploaded.current = undefined;
                  setFileInfo(undefined);
                }}
              />
            </Field>
          )}
          {fileInfo && (
            <p className="small muted">
              Το αρχείο έχει αποθηκευτεί: {fileInfo.filename} · {fileInfo.id}. Επαναλάβετε μόνο τη
              σύνδεση τεκμηρίου αν χρειάζεται.
            </p>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button className="primary" disabled={busy}>
              {busy ? 'Αποθήκευση…' : 'Αποθήκευση τεκμηρίου'}
            </button>
            <button type="button" onClick={onCancel}>
              Ακύρωση τεκμηρίου
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
export default function EvidenceList({
  labId,
  teamId,
  exerciseId,
  submissions,
}: {
  labId: string;
  teamId: string;
  exerciseId: string;
  submissions: Submission[];
}) {
  const operations = useOperations();
  const base = `${labPath(labId)}/teams/${id(teamId)}/evidence`;
  const path = `${base}?exercise_id=${id(exerciseId)}`;
  const list = usePaged<Evidence>(path);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Evidence>();
  const [editVersion, setEditVersion] = useState(0);
  const editRequest = useEditRequest(path, operations);
  const loadingEdit = editRequest.loading;
  const [error, setError] = useState('');
  const [editErrorId, setEditErrorId] = useState<string>();
  const [success, setSuccess] = useState('');

  const context = useContext(DirtyContext);
  useEffect(() => {
    setEditing(undefined);
    setOpen(false);
    setError('');
    setSuccess('');
  }, [path]);
  return (
    <OperationContext.Provider value={operations}>
      <fieldset
        disabled={operations.pending || !!loadingEdit}
        className="form-fields"
        onChangeCapture={(e) => {
          if (editRequest.pending.current) e.stopPropagation();
        }}
      >
        <section>
          <div className="section-heading">
            <div>
              <h2>Τεκμήρια άσκησης</h2>
              <p className="muted">
                Κείμενο, σύνδεσμοι, αρχεία και αποτελέσματα — ανεξάρτητα από τον βαθμό.
              </p>
            </div>
            <button
              disabled={!!loadingEdit}
              onClick={() => {
                if (!editRequest.blocked() && context.guard()) {
                  setEditing(undefined);
                  setOpen(true);
                  setSuccess('');
                }
              }}
            >
              Νέο τεκμήριο
            </button>
          </div>
          {open && (
            <EvidenceForm
              labId={labId}
              teamId={teamId}
              exerciseId={exerciseId}
              submissions={submissions}
              onSaved={() => {
                setOpen(false);
                setSuccess('Το τεκμήριο αποθηκεύτηκε και επιβεβαιώθηκε.');
                list.reload();
              }}
              onCancel={() => {
                if (!editRequest.blocked() && context.guard()) setOpen(false);
              }}
            />
          )}

          {success && (
            <p className="success" role="status">
              {success}
            </p>
          )}
          {list.value && list.error && (
            <p className="notice error" role="alert">
              {list.error.message}{' '}
              <button type="button" onClick={list.reload}>
                Επανάληψη ανανέωσης
              </button>
            </p>
          )}
          <LoadState
            {...list}
            error={list.value ? undefined : list.error}
            loading={list.loading && !list.value}
            retry={list.reload}
          >
            {!list.items.length ? (
              <Empty>Δεν υπάρχουν τεκμήρια για αυτή την άσκηση.</Empty>
            ) : (
              <div className="evidence-list">
                {list.items.map((e) => (
                  <article className="resource-card" key={e.id}>
                    <div className="section-heading">
                      <h3>{e.title}</h3>
                      <span className="badge">
                        {
                          {
                            text: 'Κείμενο',
                            link: 'Σύνδεσμος',
                            file: 'Αρχείο',
                            result: 'Αποτέλεσμα JSON',
                          }[e.kind]
                        }
                      </span>
                    </div>
                    <p className="small muted">
                      {greekDate(e.created_at)} · {sourceLabel(e.source)} ·{' '}
                      {e.submission_id
                        ? submissions.find((s) => s.id === e.submission_id)
                          ? submissionLabel(submissions.find((s) => s.id === e.submission_id)!)
                          : `Παράδοση ${e.submission_id.slice(0, 8)}`
                        : 'Χωρίς σύνδεση με παράδοση'}
                    </p>
                    {e.text && <p className="preserve">{e.text}</p>}
                    {e.kind === 'link' &&
                      e.url &&
                      (safeURL(e.url) ? (
                        <a href={e.url} target="_blank" rel="noreferrer noopener">
                          {e.url}
                        </a>
                      ) : (
                        <p className="notice error">Μη ασφαλής σύνδεσμος: {e.url}</p>
                      ))}
                    {e.kind === 'file' && e.file_id && <FileMetadata fileId={e.file_id} />}{' '}
                    {e.kind === 'result' && (
                      <>
                        <details className="result-data">
                          <summary>Δεδομένα αποτελέσματος (JSON)</summary>
                          <pre>{stringifyJSON(e.data, 2)}</pre>
                        </details>
                        <p className="small muted">Αποτέλεσμα τεκμηρίου · όχι βαθμός</p>
                      </>
                    )}
                    <details className="technical-metadata">
                      <summary>Μεταδεδομένα τεκμηρίου</summary>
                      <dl>
                        <dt>ID</dt>
                        <dd className="mono">{e.id}</dd>
                        <dt>Έκδοση</dt>
                        <dd>{e.revision}</dd>
                        <dt>Προέλευση</dt>
                        <dd>{e.source}</dd>
                        <dt>Δημιουργήθηκε</dt>
                        <dd>{e.created_at}</dd>
                        {e.submission_id && (
                          <>
                            <dt>Παράδοση</dt>
                            <dd className="mono">{e.submission_id}</dd>
                          </>
                        )}
                      </dl>
                    </details>
                    <div className="actions item-actions">
                      <button
                        disabled={!!loadingEdit}
                        onClick={async () => {
                          if (editRequest.blocked() || !context.guard()) return;
                          const currentRequest = editRequest.checkpoint();
                          setError('');
                          setEditErrorId(e.id);
                          setSuccess('');
                          await editRequest.run(
                            e.id,
                            async () => {
                              const current = await api<Evidence>(`${base}/${id(e.id)}`);
                              if (!currentRequest()) return;
                              if (
                                current.id !== e.id ||
                                current.team_id !== teamId ||
                                current.revision < 1
                              )
                                throw new Error('Δεν επιβεβαιώθηκε το τεκμήριο διακομιστή.');
                              setOpen(false);
                              setEditing(current);
                              setEditVersion((v) => v + 1);
                            },
                            (err) => setError(err.message),
                          );
                        }}
                      >
                        {loadingEdit === e.id ? 'Φόρτωση…' : 'Επεξεργασία τεκμηρίου'}
                      </button>
                      <Removal
                        path={`${base}/${id(e.id)}`}
                        revision={e.revision}
                        title={e.title}
                        kind="τεκμηρίου"
                        onRemoved={() => {
                          setEditing((current) => (current?.id === e.id ? undefined : current));
                          setSuccess('Το τεκμήριο διαγράφηκε και επιβεβαιώθηκε.');
                          list.reload();
                        }}
                      />
                    </div>
                    {error && editErrorId === e.id && (
                      <p className="notice error" role="alert">
                        {error}
                      </p>
                    )}
                    {editing?.id === e.id && (
                      <EvidenceCorrection
                        key={`${editing.id}-${editVersion}`}
                        labId={labId}
                        teamId={teamId}
                        initial={editing}
                        submissions={submissions}
                        onSaved={(saved) => {
                          setEditing((current) => (current?.id === saved.id ? saved : current));
                          list.reload();
                        }}
                        onCancel={() => {
                          if (!editRequest.blocked() && context.guard()) setEditing(undefined);
                        }}
                      />
                    )}
                  </article>
                ))}
              </div>
            )}
            <More
              count={list.items.length}
              total={list.total}
              busy={list.busy}
              onMore={list.more}
            />
            {list.moreError && <p role="alert">{list.moreError.message}</p>}
          </LoadState>
        </section>
      </fieldset>
    </OperationContext.Provider>
  );
}
