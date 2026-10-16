import { useRef, useState } from 'react';
import { api, id, json, labPath } from './api';
import { FileMetadata, safeURL, uploadFile } from './files';
import { Field, SaveForm, sourceLabel, submissionLabel, useDirty, usePaged } from './ui';
import type { Evidence, Exercise, Material, StoredFile, Submission } from './types';
import { sameRecord as same, unconfirmed } from './verification';
import { parseResultJSON, stringifyJSON } from './resultJSON';
function useCorrection<T extends { id: string; revision: number }>(path: string, initial: T) {
  const written = useRef<T | undefined>(undefined);
  return {
    async save(payload: Record<string, unknown>) {
      written.current = undefined;
      const saved = await api<T>(path, json('PATCH', payload));
      if (
        saved.id !== initial.id ||
        saved.revision !== Number(payload.revision) + 1 ||
        Object.entries(payload).some(
          ([key, value]) =>
            key !== 'revision' && !same(value, (saved as Record<string, unknown>)[key]),
        )
      )
        throw new Error(unconfirmed);
      written.current = saved;
      return saved;
    },
    async read() {
      const saved = await api<T>(path);
      if (written.current && !same(saved, written.current)) throw new Error(unconfirmed);
      return saved;
    },
    compareRead: () => api<T>(path),
  };
}
function useReplacement(labId: string, teamId?: string) {
  const [file, setFile] = useState<File>();
  const uploaded = useRef<StoredFile | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  useDirty(!!file);
  return {
    input,
    file,
    select(value?: File) {
      setFile(value);
      uploaded.current = undefined;
    },
    async upload() {
      if (!file) return undefined;
      if (!uploaded.current) uploaded.current = await uploadFile(labId, file, teamId);
      return uploaded.current.id;
    },
    clear() {
      setFile(undefined);
      uploaded.current = undefined;
      if (input.current) input.current.value = '';
    },
  };
}
function ExerciseAssociation({
  labId,
  value,
  clearable,
  onChange,
}: {
  labId: string;
  value: string | null;
  clearable?: boolean;
  onChange: (value: string | null) => void;
}) {
  const list = usePaged<Exercise>(`${labPath(labId)}/exercises`);
  return (
    <>
      <Field label="Σχετική άσκηση">
        <select value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
          {clearable && <option value="">Όλο το εργαστήριο</option>}
          {value && !list.items.some((x) => x.id === value) && (
            <option value={value}>Άσκηση {value} (δεν έχει φορτωθεί)</option>
          )}
          {list.items.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
              {x.archived ? ' · αρχείο' : ''}
            </option>
          ))}
        </select>
      </Field>
      {list.error && (
        <p role="alert">
          {list.error.message}
          <button type="button" onClick={list.reload}>
            Επανάληψη ασκήσεων
          </button>
        </p>
      )}
      {list.items.length < list.total && (
        <button type="button" onClick={list.more} disabled={list.busy}>
          Περισσότερες ασκήσεις
        </button>
      )}
      {list.moreError && <p role="alert">{list.moreError.message}</p>}
    </>
  );
}
export function MaterialCorrection({
  labId,
  initial,
  onSaved,
  onCancel,
}: {
  labId: string;
  initial: Material;
  onSaved: (saved: Material) => void;
  onCancel: () => void;
}) {
  const correction = useCorrection(`${labPath(labId)}/materials/${id(initial.id)}`, initial);
  const replacement = useReplacement(labId);
  return (
    <SaveForm
      title="Επεξεργασία υλικού"
      focusOnMount
      initial={initial}
      validate={(d) => (!d.title.trim() ? 'Συμπληρώστε τίτλο υλικού.' : undefined)}
      save={async (d) => {
        const fileId = await replacement.upload();
        return correction.save({
          revision: d.revision,
          title: d.title,
          description: d.description,
          role: d.role,
          exercise_id: d.exercise_id,
          ...(fileId ? { file_id: fileId } : {}),
        });
      }}
      read={correction.read}
      compareRead={correction.compareRead}
      onReload={(saved) => {
        replacement.clear();
        onSaved(saved);
      }}
      onSaved={(saved) => {
        replacement.clear();
        onSaved(saved);
      }}
      onCancel={onCancel}
    >
      {(d, set) => (
        <>
          <Field label="Τίτλος υλικού">
            <input required value={d.title} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label="Περιγραφή υλικού">
            <textarea
              value={d.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
          <div className="form-grid">
            <Field label="Ρόλος υλικού">
              <select value={d.role} onChange={(e) => set({ role: e.target.value })}>
                {!['handout', 'grader', 'solution', 'guidelines', 'other'].includes(d.role) && (
                  <option value={d.role}>{d.role}</option>
                )}
                <option value="handout">Εκφώνηση</option>
                <option value="grader">Αρχείο αξιολογητή</option>
                <option value="solution">Λύση</option>
                <option value="guidelines">Οδηγίες</option>
                <option value="other">Άλλο</option>
              </select>
            </Field>
            <ExerciseAssociation
              labId={labId}
              value={d.exercise_id}
              clearable
              onChange={(exercise_id) => set({ exercise_id })}
            />
          </div>
          <FileMetadata fileId={d.file_id} />
          <Field label="Αντικατάσταση αρχείου υλικού (προαιρετική)">
            <input
              ref={replacement.input}
              type="file"
              onChange={(e) => replacement.select(e.target.files?.[0])}
            />
          </Field>
          <p className="small muted">
            Χωρίς επιλογή διατηρείται το υπάρχον αρχείο. Η αντικατάσταση δημιουργεί νέο αρχείο, δεν
            αλλάζει το παλιό. Αρχεία αξιολογητών δεν εκτελούνται.
          </p>
          <p className="small muted">
            ID {d.id} · Έκδοση {d.revision}
          </p>
        </>
      )}
    </SaveForm>
  );
}
type EvidenceDraft = Evidence & { resultJSON: string; storedKind: Evidence['kind'] };
export function EvidenceCorrection({
  labId,
  teamId,
  initial,
  submissions,
  onSaved,
  onCancel,
}: {
  labId: string;
  teamId: string;
  initial: Evidence;
  submissions: Submission[];
  onSaved: (saved: Evidence) => void;
  onCancel: () => void;
}) {
  const correction = useCorrection(
    `${labPath(labId)}/teams/${id(teamId)}/evidence/${id(initial.id)}`,
    initial,
  );
  const replacement = useReplacement(labId, teamId);
  const draft: EvidenceDraft = {
    ...initial,
    storedKind: initial.kind,
    resultJSON: initial.data === undefined ? '' : stringifyJSON(initial.data, 2)!,
  };
  const asDraft = (e: Evidence): EvidenceDraft => ({
    ...e,
    storedKind: e.kind,
    resultJSON: e.data === undefined ? '' : stringifyJSON(e.data, 2)!,
  });
  const resultChanged = (d: EvidenceDraft) =>
    d.kind !== d.storedKind ||
    d.resultJSON !== (d.data === undefined ? '' : stringifyJSON(d.data, 2));
  function validate(d: EvidenceDraft) {
    if (!d.title.trim()) return 'Συμπληρώστε τίτλο τεκμηρίου.';
    if (d.kind === 'text' && !d.text?.trim()) return 'Συμπληρώστε κείμενο τεκμηρίου.';
    if (d.kind === 'link' && !safeURL(d.url || ''))
      return 'Επιτρέπονται μόνο σύνδεσμοι http ή https.';
    if (d.kind === 'file' && !d.file_id && !replacement.file) return 'Επιλέξτε αρχείο τεκμηρίου.';
    if (d.kind === 'result' && resultChanged(d)) {
      try {
        parseResultJSON(d.resultJSON);
      } catch (e) {
        return (e as Error).message;
      }
    }
    return undefined;
  }
  return (
    <SaveForm
      title="Επεξεργασία τεκμηρίου"
      focusOnMount
      initial={draft}
      validate={validate}
      save={async (d) => {
        const fileId = d.kind === 'file' ? await replacement.upload() : undefined;
        return asDraft(
          await correction.save({
            revision: d.revision,
            exercise_id: d.exercise_id,
            submission_id: d.submission_id,
            kind: d.kind,
            title: d.title,
            ...(d.source !== initial.source ? { source: d.source } : {}),
            ...(d.kind === 'text' || d.text !== initial.text ? { text: d.text } : {}),
            ...(d.kind === 'link' ? { url: d.url } : {}),
            ...(d.kind === 'result' && resultChanged(d)
              ? { data: parseResultJSON(d.resultJSON) }
              : {}),
            ...(fileId ? { file_id: fileId } : {}),
          }),
        );
      }}
      read={async () => asDraft(await correction.read())}
      compareRead={async () => asDraft(await correction.compareRead())}
      onReload={(saved) => {
        replacement.clear();
        onSaved(saved);
      }}
      onSaved={(saved) => {
        replacement.clear();
        onSaved(saved);
      }}
      onCancel={onCancel}
    >
      {(d, set) => (
        <>
          <Field label="Τίτλος τεκμηρίου">
            <input required value={d.title} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <div className="form-grid">
            <Field label="Είδος τεκμηρίου">
              <select
                value={d.kind}
                onChange={(e) => set({ kind: e.target.value as Evidence['kind'] })}
              >
                <option value="text">Κείμενο</option>
                <option value="link">Σύνδεσμος</option>
                <option value="result">Αποτέλεσμα JSON</option>
                <option value="file">Αρχείο</option>
              </select>
            </Field>
            <Field label="Παράδοση τεκμηρίου">
              <select
                value={d.submission_id || ''}
                onChange={(e) => set({ submission_id: e.target.value || null })}
              >
                <option value="">Χωρίς σύνδεση με παράδοση</option>
                {d.submission_id && !submissions.some((s) => s.id === d.submission_id) && (
                  <option value={d.submission_id}>
                    Παράδοση {d.submission_id} (δεν έχει φορτωθεί)
                  </option>
                )}
                {submissions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {submissionLabel(s)}
                  </option>
                ))}
              </select>
            </Field>
            <ExerciseAssociation
              labId={labId}
              value={d.exercise_id}
              onChange={(exercise_id) => {
                if (exercise_id) set({ exercise_id });
              }}
            />
          </div>
          <Field label="Κείμενο τεκμηρίου">
            <textarea value={d.text || ''} onChange={(e) => set({ text: e.target.value })} />
          </Field>
          {d.kind === 'link' && (
            <Field label="Σύνδεσμος">
              <input value={d.url || ''} onChange={(e) => set({ url: e.target.value })} />
            </Field>
          )}
          {d.kind === 'result' && (
            <>
              <Field label="Αποτέλεσμα JSON">
                <textarea
                  className="mono"
                  value={d.resultJSON}
                  onChange={(e) => set({ resultJSON: e.target.value })}
                />
              </Field>
              <p className="notice">Το αποτέλεσμα είναι τεκμήριο, όχι βαθμός. Δεν εκτελείται.</p>
            </>
          )}
          {d.kind === 'file' && (
            <>
              {d.file_id && <FileMetadata fileId={d.file_id} />}
              <Field label="Αντικατάσταση αρχείου τεκμηρίου (προαιρετική)">
                <input
                  ref={replacement.input}
                  type="file"
                  onChange={(e) => replacement.select(e.target.files?.[0])}
                />
              </Field>
              <p className="small muted">
                Χωρίς επιλογή διατηρείται το υπάρχον αρχείο. Η αντικατάσταση δεν αλλάζει το παλιό.
              </p>
            </>
          )}
          <p className="small muted">
            Έκδοση {d.revision} · Προέλευση {sourceLabel(d.source)}
          </p>
          <Field label="Προέλευση τεκμηρίου">
            <select value={d.source} onChange={(e) => set({ source: e.target.value })}>
              {!['human', 'agent', 'import'].includes(d.source) && (
                <option value={d.source}>{sourceLabel(d.source)}</option>
              )}
              <option value="human">Διδάσκων</option>
              <option value="agent">Βοηθός AI</option>
              <option value="import">Εισαγωγή</option>
            </select>
          </Field>
        </>
      )}
    </SaveForm>
  );
}
