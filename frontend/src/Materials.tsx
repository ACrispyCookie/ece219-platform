import { useContext, useRef, useState } from 'react';
import { api, id, json, labPath } from './api';
import { FileMetadata, findSaved, uploadFile } from './files';
import Removal from './Removal';
import Uploads from './Uploads';
import { OperationContext, useOperations } from './OperationContext';
import { DirtyContext, Empty, Field, LoadState, More, useDirty, usePaged } from './ui';
import type { Exercise, Material, StoredFile } from './types';
import { MaterialCorrection } from './CatalogCorrections';
const roles: Record<string, string> = {
  handout: 'Εκφώνηση',
  grader: 'Αρχείο αξιολογητή',
  solution: 'Λύση',
  guidelines: 'Οδηγίες',
  other: 'Άλλο',
};
function MaterialForm({
  labId,
  onSaved,
  onCancel,
}: {
  labId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const operations = useOperations();
  const owner = useRef(Symbol('material-upload'));
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [role, setRole] = useState('handout');
  const [exerciseId, setExerciseId] = useState('');
  const [file, setFile] = useState<File>();
  const uploaded = useRef<StoredFile | undefined>(undefined);
  const [fileInfo, setFileInfo] = useState<StoredFile>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const exercises = usePaged<Exercise>(`${labPath(labId)}/exercises`);
  useDirty(!!title || !!description || role !== 'handout' || !!exerciseId || !!file || busy);
  async function submit() {
    if (!operations.acquireSave(owner.current)) return;
    setError('');
    try {
      if (!title.trim() || !file) {
        setError('Συμπληρώστε τίτλο και επιλέξτε αρχείο.');
        return;
      }
      setBusy(true);
      if (!uploaded.current) {
        uploaded.current = await uploadFile(labId, file);
        setFileInfo(uploaded.current);
      }
      const saved = await api<Material>(
        `${labPath(labId)}/materials`,
        json('POST', {
          file_id: uploaded.current.id,
          role,
          title,
          description,
          exercise_id: exerciseId || null,
        }),
      );
      await findSaved<Material>(`${labPath(labId)}/materials`, saved.id);
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
      <h3>Νέο υλικό</h3>
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
          <Field label="Τίτλος υλικού">
            <input required value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Περιγραφή υλικού">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="form-grid">
            <Field label="Ρόλος υλικού">
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {Object.entries(roles).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Σχετική άσκηση">
              <select value={exerciseId} onChange={(e) => setExerciseId(e.target.value)}>
                <option value="">Όλο το εργαστήριο</option>
                {exercises.items.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title}
                    {x.archived ? ' · αρχείο' : ''}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {exercises.loading && <p role="status">Φόρτωση ασκήσεων…</p>}
          {exercises.error && (
            <p className="notice error" role="alert">
              {exercises.error.message}
              <button type="button" onClick={exercises.reload}>
                Επανάληψη ασκήσεων
              </button>
            </p>
          )}
          {exercises.items.length < exercises.total && (
            <button type="button" disabled={exercises.busy} onClick={exercises.more}>
              Περισσότερες ασκήσεις
            </button>
          )}
          <Field label="Αρχείο υλικού">
            <input
              type="file"
              onChange={(e) => {
                setFile(e.target.files?.[0]);
                uploaded.current = undefined;
                setFileInfo(undefined);
              }}
            />
          </Field>
          <p className="small muted">
            Όλα τα αρχεία προσφέρονται μόνο για λήψη. Αρχεία αξιολογητών δεν εκτελούνται.
          </p>
          {fileInfo && (
            <p className="small muted">
              Αποθηκευμένο αρχείο: {fileInfo.filename} · {fileInfo.id}. Αν αποτύχει η σύνδεση, η
              επανάληψη χρησιμοποιεί αυτό το αρχείο.
            </p>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button className="primary" disabled={busy}>
              {busy ? 'Αποθήκευση…' : 'Αποθήκευση υλικού'}
            </button>
            <button type="button" onClick={onCancel}>
              Ακύρωση υλικού
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
export default function Materials({ labId }: { labId: string }) {
  const operations = useOperations();
  const path = `${labPath(labId)}/materials`;
  const list = usePaged<Material>(path);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Material>();
  const [editVersion, setEditVersion] = useState(0);
  const [loadingEdit, setLoadingEdit] = useState<string>();
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [uploadsVersion, setUploadsVersion] = useState(0);
  const context = useContext(DirtyContext);
  return (
    <OperationContext.Provider value={operations}>
      <fieldset disabled={operations.pending} className="form-fields">
        <div className="section-heading">
          <div>
            <h2>Υλικό εργαστηρίου</h2>
            <p className="muted">Εκφωνήσεις, οδηγίες, λύσεις και αρχεία αξιολόγησης.</p>
          </div>
          <button
            className="primary"
            onClick={() => {
              if (context.guard()) {
                setEditing(undefined);
                setOpen(true);
                setSuccess('');
              }
            }}
          >
            Νέο υλικό
          </button>
        </div>
        {open && (
          <MaterialForm
            labId={labId}
            onSaved={() => {
              setOpen(false);
              setSuccess('Το υλικό αποθηκεύτηκε και επιβεβαιώθηκε.');
              list.reload();
              setUploadsVersion((v) => v + 1);
            }}
            onCancel={() => {
              if (context.guard()) setOpen(false);
            }}
          />
        )}
        {editing && (
          <MaterialCorrection
            key={`${editing.id}-${editVersion}`}
            labId={labId}
            initial={editing}
            onSaved={(saved) => {
              setEditing((current) => (current?.id === saved.id ? saved : current));
              list.reload();
              setUploadsVersion((v) => v + 1);
            }}
            onCancel={() => {
              if (context.guard()) setEditing(undefined);
            }}
          />
        )}
        {success && (
          <p role="status" className="success">
            {success}
          </p>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <LoadState {...list} retry={list.reload}>
          {!list.items.length ? (
            <Empty>Δεν έχει προστεθεί υλικό.</Empty>
          ) : (
            <div className="cards">
              {list.items.map((m) => (
                <article className="resource-card" key={m.id}>
                  <div className="section-heading">
                    <h3>{m.title}</h3>
                    <span className="badge">{roles[m.role] || m.role}</span>
                  </div>
                  <p className="muted preserve">{m.description}</p>
                  <p className="small muted">
                    {m.exercise_id ? `Άσκηση: ${m.exercise_id}` : 'Όλο το εργαστήριο'}
                  </p>
                  <FileMetadata fileId={m.file_id} />
                  <div className="actions item-actions">
                    <button
                      disabled={!!loadingEdit}
                      onClick={async () => {
                        if (!context.guard()) return;
                        setLoadingEdit(m.id);
                        setError('');
                        setSuccess('');
                        try {
                          const current = await api<Material>(`${path}/${id(m.id)}`);
                          if (
                            current.id !== m.id ||
                            current.lab_id !== labId ||
                            current.revision < 1
                          )
                            throw new Error('Δεν επιβεβαιώθηκε το υλικό διακομιστή.');
                          setOpen(false);
                          setEditing(current);
                          setEditVersion((v) => v + 1);
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setLoadingEdit(undefined);
                        }
                      }}
                    >
                      {loadingEdit === m.id ? 'Φόρτωση…' : 'Επεξεργασία υλικού'}
                    </button>
                    <Removal
                      path={`${path}/${id(m.id)}`}
                      revision={m.revision}
                      title={m.title}
                      kind="υλικού"
                      onRemoved={() => {
                        setEditing((current) => (current?.id === m.id ? undefined : current));
                        setSuccess('Το υλικό διαγράφηκε και επιβεβαιώθηκε.');
                        list.reload();
                        setUploadsVersion((v) => v + 1);
                      }}
                    />
                  </div>
                </article>
              ))}
            </div>
          )}
          <More count={list.items.length} total={list.total} busy={list.busy} onMore={list.more} />
          {list.moreError && <p role="alert">{list.moreError.message}</p>}
        </LoadState>
        <Uploads
          key={uploadsVersion}
          labId={labId}
          onRemoved={(fileId) => {
            setEditing((current) => (current?.file_id === fileId ? undefined : current));
            list.reload();
          }}
        />
      </fieldset>
    </OperationContext.Provider>
  );
}
