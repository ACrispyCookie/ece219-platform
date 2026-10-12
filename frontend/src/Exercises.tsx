import { useContext, useRef, useState } from 'react';
import { api, id, json, labPath } from './api';
import { compareDecimal, parseDecimal, sumDecimals } from './decimal';
import { DirtyContext, Empty, Field, LoadState, More, SaveForm, usePaged } from './ui';
import type { Exercise } from './types';
export function validateExercise(d: Exercise) {
  if (!d.title.trim()) return 'Συμπληρώστε τίτλο.';
  if (!Number.isInteger(Number(d.position)) || Number(d.position) < 0)
    return 'Η θέση πρέπει να είναι μη αρνητικός ακέραιος.';
  try {
    parseDecimal(d.max_points);
    if (d.grading_mode === 'criteria') {
      if (!d.criteria.length || d.criteria.some((c) => !c.label.trim()))
        return 'Προσθέστε τουλάχιστον ένα κριτήριο με ετικέτα.';
      if (compareDecimal(sumDecimals(d.criteria.map((c) => c.max_points)), d.max_points) !== 0)
        return 'Το άθροισμα των κριτηρίων πρέπει να ισούται ακριβώς με τις μέγιστες μονάδες.';
    }
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
}
function ExerciseEditor({
  labId,
  exercise,
  onSaved,
  onCancel,
}: {
  labId: string;
  exercise?: Exercise;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const resourceId = useRef(exercise?.id);
  const base = `${labPath(labId)}/exercises`;
  const initial: Exercise = exercise || {
    id: '',
    lab_id: labId,
    title: '',
    description: '',
    position: 0,
    max_points: '',
    grading_mode: 'manual',
    grading_instructions: '',
    criteria: [],
    rubric_revision: 0,
    revision: 0,
    archived: false,
  };
  return (
    <SaveForm
      title={exercise ? 'Επεξεργασία άσκησης' : 'Νέα άσκηση'}
      initial={initial}
      validate={validateExercise}
      save={async (d) => {
        const editing = !!resourceId.current;
        const payload = {
          title: d.title,
          description: d.description,
          position: Number(d.position),
          max_points: d.max_points,
          grading_mode: d.grading_mode,
          grading_instructions: d.grading_instructions,
          criteria: d.grading_mode === 'criteria' ? d.criteria : [],
          archived: d.archived,
          ...(editing ? { revision: d.revision } : {}),
        };
        const saved = await api<Exercise>(
          editing ? `${base}/${id(resourceId.current!)}` : base,
          json(editing ? 'PATCH' : 'POST', payload),
        );
        resourceId.current = saved.id;
        return saved;
      }}
      read={() => api<Exercise>(`${base}/${id(resourceId.current!)}`)}
      onSaved={onSaved}
      onCancel={onCancel}
    >
      {(d, set) => (
        <>
          <div className="form-grid">
            <Field label="Τίτλος">
              <input required value={d.title} onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <Field label="Θέση">
              <input
                type="number"
                min="0"
                step="1"
                value={d.position}
                onChange={(e) => set({ position: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field label="Περιγραφή">
            <textarea
              value={d.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
          <div className="form-grid">
            <Field label="Μέγιστες μονάδες">
              <input
                inputMode="decimal"
                required
                value={d.max_points}
                onChange={(e) => set({ max_points: e.target.value })}
              />
            </Field>
            <Field label="Τρόπος βαθμολόγησης">
              <select
                value={d.grading_mode}
                onChange={(e) => set({ grading_mode: e.target.value as Exercise['grading_mode'] })}
              >
                <option value="manual">Χειροκίνητη</option>
                <option value="criteria">Ανά κριτήριο</option>
              </select>
            </Field>
          </div>
          <Field label="Οδηγίες βαθμολόγησης">
            <textarea
              value={d.grading_instructions}
              onChange={(e) => set({ grading_instructions: e.target.value })}
            />
          </Field>
          {resourceId.current && (
            <p className="notice warn">
              Αλλαγές στην κλίμακα, στις ετικέτες ή στις οδηγίες/ορισμούς των κριτηρίων θα
              απαιτήσουν επανέλεγχο προηγούμενων αξιολογήσεων. Οι προηγούμενοι βαθμοί διατηρούνται.
            </p>
          )}
          {d.grading_mode === 'criteria' && (
            <div className="criteria">
              <h3>Κριτήρια αξιολόγησης</h3>
              {d.criteria.map((c, index) => (
                <fieldset key={index}>
                  <legend>
                    Κριτήριο {index + 1}
                    {c.id ? ' · υφιστάμενο' : ''}
                  </legend>
                  <div className="form-grid">
                    <Field label={`Κριτήριο ${index + 1} · ετικέτα`}>
                      <input
                        required
                        value={c.label}
                        onChange={(e) =>
                          set({
                            criteria: d.criteria.map((x, i) =>
                              i === index ? { ...x, label: e.target.value } : x,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label={`Κριτήριο ${index + 1} · μονάδες`}>
                      <input
                        inputMode="decimal"
                        required
                        value={c.max_points}
                        onChange={(e) =>
                          set({
                            criteria: d.criteria.map((x, i) =>
                              i === index ? { ...x, max_points: e.target.value } : x,
                            ),
                          })
                        }
                      />
                    </Field>
                  </div>
                  <Field label={`Κριτήριο ${index + 1} · οδηγίες`}>
                    <textarea
                      value={c.instructions}
                      onChange={(e) =>
                        set({
                          criteria: d.criteria.map((x, i) =>
                            i === index ? { ...x, instructions: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </Field>
                  <button
                    type="button"
                    onClick={() => set({ criteria: d.criteria.filter((_, i) => i !== index) })}
                  >
                    Αφαίρεση κριτηρίου {index + 1}
                  </button>
                </fieldset>
              ))}
              <button
                type="button"
                onClick={() =>
                  set({
                    criteria: [...d.criteria, { label: '', max_points: '', instructions: '' }],
                  })
                }
              >
                Προσθήκη κριτηρίου
              </button>
            </div>
          )}
          {resourceId.current && (
            <label className="check">
              <input
                type="checkbox"
                checked={d.archived}
                onChange={(e) => set({ archived: e.target.checked })}
              />
              Αρχειοθετημένη άσκηση
            </label>
          )}
        </>
      )}
    </SaveForm>
  );
}
export default function Exercises({ labId }: { labId: string }) {
  const list = usePaged<Exercise>(`${labPath(labId)}/exercises`);
  const [editing, setEditing] = useState<Exercise | null | undefined>();
  const context = useContext(DirtyContext);
  let total = '—';
  try {
    total = sumDecimals(list.items.filter((x) => !x.archived).map((x) => x.max_points));
  } catch {
    /* bad API value is not fabricated */
  }
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Ασκήσεις & βαθμολόγηση</h2>
          <p className="muted">
            Σύνολο ενεργών μονάδων {list.items.length < list.total ? '(φορτωμένες ασκήσεις)' : ''}:{' '}
            <strong>{total}</strong>
          </p>
        </div>
        <button
          className="primary"
          onClick={() => {
            if (context.guard()) setEditing(null);
          }}
        >
          Νέα άσκηση
        </button>
      </div>
      {editing !== undefined && (
        <ExerciseEditor
          key={editing?.id || 'new'}
          labId={labId}
          exercise={editing || undefined}
          onSaved={list.reload}
          onCancel={() => {
            if (context.guard()) setEditing(undefined);
          }}
        />
      )}
      <LoadState {...list} retry={list.reload}>
        {!list.items.length ? (
          <Empty>Δεν έχουν οριστεί ασκήσεις. Η κλίμακα του εργαστηρίου είναι δική σας.</Empty>
        ) : (
          <div className="cards">
            {[...list.items]
              .sort((a, b) => a.position - b.position)
              .map((x) => (
                <article className="resource-card" key={x.id}>
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">ΘΕΣΗ {x.position}</span>
                      <h3>{x.title}</h3>
                    </div>
                    <span className="points">
                      {x.max_points} <small>μονάδες</small>
                    </span>
                  </div>
                  <p className="muted">{x.description || 'Χωρίς περιγραφή'}</p>
                  <div className="actions">
                    <span className="badge">
                      {x.grading_mode === 'criteria'
                        ? `${x.criteria.length} κριτήρια`
                        : 'Χειροκίνητη'}
                    </span>
                    {x.archived && <span className="badge warn">Αρχειοθετημένη</span>}
                    <button
                      onClick={() => {
                        if (context.guard()) setEditing(x);
                      }}
                    >
                      Επεξεργασία {x.title}
                    </button>
                  </div>
                </article>
              ))}
          </div>
        )}
        <More count={list.items.length} total={list.total} busy={list.busy} onMore={list.more} />
        {list.moreError && <p role="alert">{list.moreError.message}</p>}
      </LoadState>
    </>
  );
}
