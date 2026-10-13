import { useState } from 'react';
import { api, id, json, labPath } from './api';
import { compareDecimal, sumDecimals } from './decimal';
import { Empty, Field, LoadState, More, SaveForm, usePaged, useResource } from './ui';
import type { Assessment, Exercise, Submission } from './types';
import EvidenceList from './Evidence';
import Removal from './Removal';
import { OperationContext, useOperations } from './OperationContext';
const criterionScore = (scores: Assessment['criterion_scores'], key: string) =>
  Object.hasOwn(scores, key) ? scores[key] : undefined;
export function validateAssessment(d: Assessment, x: Exercise) {
  try {
    if (x.grading_mode === 'manual') {
      if (d.score !== null && d.score !== '' && compareDecimal(d.score, x.max_points) > 0)
        return `Ο βαθμός πρέπει να είναι από 0 έως ${x.max_points}.`;
      if (d.status === 'final' && (d.score === null || d.score === ''))
        return 'Η οριστική αξιολόγηση απαιτεί βαθμό.';
    } else {
      for (const c of x.criteria) {
        const score = criterionScore(d.criterion_scores, c.id!);
        if (score != null && score !== '' && compareDecimal(score, c.max_points) > 0)
          return `Ο βαθμός για ${c.label} πρέπει να είναι από 0 έως ${c.max_points}.`;
      }
      if (
        d.status === 'final' &&
        x.criteria.some(
          (c) =>
            criterionScore(d.criterion_scores, c.id!) == null ||
            criterionScore(d.criterion_scores, c.id!) === '',
        )
      )
        return 'Η οριστική αξιολόγηση απαιτεί βαθμό σε όλα τα κριτήρια.';
    }
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
}
function History({ path }: { path: string }) {
  const list = usePaged<Assessment>(`${path}/history`);
  return (
    <details className="panel history">
      <summary>Ιστορικό αξιολογήσεων</summary>
      <LoadState {...list} retry={list.reload}>
        {!list.items.length ? (
          <Empty>Δεν υπάρχει ιστορικό ακόμη.</Empty>
        ) : (
          <ol className="history-list">
            {list.items.map((a, index) => (
              <li key={`${a.revision}-${index}`}>
                <div className="actions">
                  <strong>Έκδοση {a.revision}</strong>
                  <span className="badge">{a.status}</span>
                  <span>{a.score ?? '—'} μονάδες</span>
                </div>
                <p className="small muted">
                  {a.updated_at || a.created_at || 'Χωρίς χρονική σήμανση'} · {a.source} · Κλίμακα{' '}
                  {a.rubric_revision}
                </p>
                <p className="preserve">{a.notes}</p>
                <details>
                  <summary>Πλήρες στιγμιότυπο</summary>
                  <pre>{JSON.stringify(a, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ol>
        )}
        <More count={list.items.length} total={list.total} busy={list.busy} onMore={list.more} />
        {list.moreError && <p role="alert">{list.moreError.message}</p>}
      </LoadState>
    </details>
  );
}
function AssessmentEditor({
  path,
  initial,
  exercise,
  submissions,
  onSaved,
  exercisePath,
  onExerciseReload,
}: {
  path: string;
  initial: Assessment;
  exercise: Exercise;
  submissions: Submission[];
  onSaved: (saved: Assessment) => void;
  exercisePath: string;
  onExerciseReload: (exercise: Exercise) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [serverExercise, setServerExercise] = useState<Exercise>();
  const unchangedGrade = (d: Assessment) =>
    d.status === initial.status &&
    d.submission_id === initial.submission_id &&
    d.score === initial.score &&
    JSON.stringify(d.criterion_scores) === JSON.stringify(initial.criterion_scores);
  return (
    <SaveForm
      title="Αξιολόγηση άσκησης"
      initial={initial}
      validate={(d) => {
        if (initial.rubric_stale && !confirmed) {
          if (unchangedGrade(d)) return undefined;
          return 'Επιβεβαιώστε τον επανέλεγχο πριν αλλάξετε τον βαθμό ή τη σύνδεσή του.';
        }
        return validateAssessment(d, exercise);
      }}
      save={(d) => {
        const criteria = Object.fromEntries(
          exercise.criteria
            .filter(
              (c) =>
                criterionScore(d.criterion_scores, c.id!) != null &&
                criterionScore(d.criterion_scores, c.id!) !== '',
            )
            .map((c) => [c.id!, criterionScore(d.criterion_scores, c.id!)]),
        );
        const preserve = initial.rubric_stale && !confirmed && unchangedGrade(d);
        return api(
          path,
          json('PUT', {
            revision: d.revision,
            rubric_revision: exercise.rubric_revision,
            confirm_rubric_change: confirmed,
            submission_id: d.submission_id,
            status: d.status,
            score: preserve
              ? d.score
              : exercise.grading_mode === 'manual'
                ? d.score === ''
                  ? null
                  : d.score
                : null,
            criterion_scores: preserve
              ? d.criterion_scores
              : exercise.grading_mode === 'criteria'
                ? criteria
                : {},
            notes: d.notes,
            source: 'human',
          }),
        );
      }}
      read={() => api<Assessment>(path)}
      compareRead={async () => {
        const [current, currentExercise] = await Promise.all([
          api<Assessment>(path),
          api<Exercise>(exercisePath),
        ]);
        setServerExercise(currentExercise);
        return current;
      }}
      renderServer={() =>
        serverExercise && (
          <div>
            <h3>Τρέχουσα κλίμακα διακομιστή</h3>
            <p>
              Κλίμακα {exercise.rubric_revision} → {serverExercise.rubric_revision} · Μέγιστες
              μονάδες {exercise.max_points} → {serverExercise.max_points}
            </p>
            <p>{serverExercise.grading_mode === 'criteria' ? 'Ανά κριτήριο' : 'Χειροκίνητη'}</p>
            <p className="preserve">{serverExercise.grading_instructions}</p>
            {serverExercise.criteria.map((c) => (
              <div key={c.id}>
                <strong>
                  {c.label} · έως {c.max_points}
                </strong>
                <p className="preserve">{c.instructions}</p>
              </div>
            ))}
          </div>
        )
      }
      onReload={(current) => {
        if (serverExercise) onExerciseReload(serverExercise);
        setConfirmed(false);
        onSaved(current);
      }}
      onSaved={(saved) => {
        setConfirmed(false);
        onSaved(saved);
      }}
    >
      {(d, set) => {
        const complete = exercise.criteria.every(
          (c) =>
            criterionScore(d.criterion_scores, c.id!) != null &&
            criterionScore(d.criterion_scores, c.id!) !== '',
        );
        let total = '—';
        try {
          if (complete)
            total = sumDecimals(
              exercise.criteria.map((c) => criterionScore(d.criterion_scores, c.id!)!),
            );
        } catch {
          /* invalid draft displays no fabricated total */
        }
        return (
          <>
            {d.rubric_stale && (
              <div className="notice warn">
                <strong>Η κλίμακα άλλαξε — απαιτείται επανέλεγχος.</strong>
                <p>
                  Ο προηγούμενος βαθμός {initial.score ?? '—'} διατηρείται. Οι αλλαγές μόνο στις
                  σημειώσεις διατηρούν την προηγούμενη κλίμακα και την ένδειξη επανελέγχου.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  Επανέλεγξα τον βαθμό με την τρέχουσα κλίμακα
                </label>
                <details>
                  <summary>Προηγούμενη κλίμακα</summary>
                  <pre>{JSON.stringify(d.rubric_snapshot, null, 2)}</pre>
                </details>
              </div>
            )}
            <div className="form-grid">
              <Field label="Σύνδεση με παράδοση">
                <select
                  value={d.submission_id || ''}
                  onChange={(e) => set({ submission_id: e.target.value || null })}
                >
                  <option value="">Χωρίς σύνδεση με παράδοση</option>
                  {d.submission_id && !submissions.some((s) => s.id === d.submission_id) && (
                    <option value={d.submission_id}>
                      Συνδεδεμένη παράδοση {d.submission_id} (δεν έχει φορτωθεί)
                    </option>
                  )}
                  {submissions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.filename} · {s.id} · {s.created_at}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Κατάσταση αξιολόγησης">
                <select
                  value={d.status}
                  onChange={(e) => set({ status: e.target.value as Assessment['status'] })}
                >
                  <option value="ungraded">Χωρίς βαθμό</option>
                  <option value="draft">Πρόχειρη</option>
                  <option value="final">Οριστική</option>
                </select>
              </Field>
            </div>
            {exercise.grading_mode === 'manual' ? (
              <Field label="Βαθμός">
                <input
                  inputMode="decimal"
                  value={d.score ?? ''}
                  onChange={(e) => set({ score: e.target.value || null })}
                />
              </Field>
            ) : (
              <div className="criteria">
                {exercise.criteria.map((c) => (
                  <fieldset key={c.id}>
                    <legend>
                      {c.label} · έως {c.max_points}
                    </legend>
                    <p className="muted preserve">{c.instructions}</p>
                    <Field label={`${c.label} · βαθμός`}>
                      <input
                        inputMode="decimal"
                        value={criterionScore(d.criterion_scores, c.id!) ?? ''}
                        onChange={(e) =>
                          set({
                            criterion_scores: { ...d.criterion_scores, [c.id!]: e.target.value },
                          })
                        }
                      />
                    </Field>
                  </fieldset>
                ))}
                <p className="notice">
                  {complete
                    ? `Προεπισκόπηση πλήρους συνόλου: ${total} / ${exercise.max_points}. Ο τελικός υπολογισμός γίνεται από τον διακομιστή.`
                    : 'Ελλιπή κριτήρια — δεν υπάρχει πλήρες σύνολο.'}
                </p>
              </div>
            )}
            <Field label="Σημειώσεις άσκησης">
              <textarea value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
            <p className="small muted">
              Αποθηκευμένος βαθμός: {initial.score ?? '—'} · Έκδοση αξιολόγησης {d.revision} ·
              Κλίμακα {d.rubric_revision} · Τρέχουσα κλίμακα {exercise.rubric_revision}
            </p>
          </>
        );
      }}
    </SaveForm>
  );
}
export default function AssessmentView({
  labId,
  teamId,
  exercise: loadedExercise,
  submissions,
}: {
  labId: string;
  teamId: string;
  exercise: Exercise;
  submissions: Submission[];
}) {
  const operations = useOperations();
  const [exercise, setExercise] = useState(loadedExercise);
  const path = `${labPath(labId)}/teams/${id(teamId)}/assessments/${id(exercise.id)}`;
  const assessment = useResource<Assessment>(path);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [editorVersion, setEditorVersion] = useState(0);
  return (
    <OperationContext.Provider value={operations}>
      <fieldset disabled={operations.pending} className="form-fields">
        <section className="exercise-brief">
          <div className="section-heading">
            <h2>{exercise.title}</h2>
            <span className="points">
              {exercise.max_points} <small>μονάδες</small>
            </span>
          </div>
          <p className="preserve muted">{exercise.description}</p>
          <div className="notice">
            <h3>Οδηγίες βαθμολόγησης</h3>
            <p className="preserve">
              {exercise.grading_instructions || 'Δεν έχουν οριστεί οδηγίες.'}
            </p>
          </div>
          {exercise.archived && <p className="notice warn">Αρχειοθετημένη άσκηση</p>}
        </section>
        {assessment.value?.id != null && (
          <div className="actions item-actions assessment-actions">
            <Removal
              path={path}
              revision={assessment.value.revision}
              title={exercise.title}
              kind="αξιολόγησης"
              onRemoved={(empty) => {
                assessment.setValue(empty);
                setHistoryVersion((v) => v + 1);
                setEditorVersion((v) => v + 1);
              }}
            />
          </div>
        )}
        <LoadState {...assessment} retry={assessment.reload}>
          {assessment.value && (
            <AssessmentEditor
              key={editorVersion}
              path={path}
              initial={assessment.value}
              exercise={exercise}
              submissions={submissions}
              exercisePath={`${labPath(labId)}/exercises/${id(exercise.id)}`}
              onExerciseReload={setExercise}
              onSaved={(saved) => {
                assessment.setValue(saved);
                setHistoryVersion((v) => v + 1);
              }}
            />
          )}
        </LoadState>
        <History key={historyVersion} path={path} />
        <EvidenceList
          labId={labId}
          teamId={teamId}
          exerciseId={exercise.id}
          submissions={submissions}
        />
      </fieldset>
    </OperationContext.Provider>
  );
}
