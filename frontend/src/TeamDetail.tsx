import { useContext, useState } from 'react';
import { id, labPath } from './api';
import { DirtyContext, Empty, LoadState, usePaged, useResource } from './ui';
import type { Exercise, Submission, Team } from './types';
import { TeamEditor } from './Teams';
import Submissions from './Submissions';
import AssessmentView from './Assessment';
export default function TeamDetail({
  labId,
  teamId,
  exerciseId,
  onExercise,
  onBack,
  onTeam,
}: {
  labId: string;
  teamId: string;
  exerciseId?: string;
  onExercise: (id: string | undefined) => void;
  onBack: () => void;
  onTeam: (id: string) => void;
}) {
  const team = useResource<Team>(`${labPath(labId)}/teams/${id(teamId)}`);
  const teams = usePaged<Team>(`${labPath(labId)}/teams`);
  const exercises = usePaged<Exercise>(`${labPath(labId)}/exercises`);
  const submissions = usePaged<Submission>(`${labPath(labId)}/teams/${id(teamId)}/submissions`);
  const tab = exerciseId || 'summary';
  const setTab = (next: string) => onExercise(next === 'summary' ? undefined : next);
  const [editing, setEditing] = useState(false);
  const context = useContext(DirtyContext);
  const index = teams.items.findIndex((t) => t.id === teamId);
  const navigate = (fn: () => void) => {
    if (context.guard()) fn();
  };
  return (
    <LoadState {...team} retry={team.reload}>
      {team.value && (
        <>
          <div className="team-heading">
            <div>
              <button className="text-button" onClick={() => navigate(onBack)}>
                ← Όλες οι ομάδες
              </button>
              <h2>{team.value.label}</h2>
              <div className="members">
                {team.value.members.map((m) => (
                  <span key={m.student_id}>
                    <span className="student-id">{m.student_id}</span> {m.name}
                  </span>
                ))}
              </div>
              {!team.value.membership_complete && <p className="badge warn">Ελλιπή μέλη ομάδας</p>}
              {team.value.archived && <p className="badge warn">Αρχειοθετημένη ομάδα</p>}
            </div>
            <div className="actions">
              <button
                disabled={index <= 0}
                onClick={() => navigate(() => onTeam(teams.items[index - 1].id))}
              >
                ← Προηγούμενη ομάδα
              </button>
              <button
                disabled={index < 0 || index + 1 >= teams.items.length}
                onClick={() => navigate(() => onTeam(teams.items[index + 1].id))}
              >
                Επόμενη ομάδα →
              </button>
              {teams.items.length < teams.total && (
                <button disabled={teams.busy} onClick={teams.more}>
                  Περισσότερες ομάδες
                </button>
              )}
            </div>
          </div>
          {teams.error && <p role="alert">{teams.error.message}</p>}
          {teams.moreError && <p role="alert">{teams.moreError.message}</p>}
          <nav className="tabs subtabs" aria-label="Καρτέλες ομάδας">
            <button
              aria-current={tab === 'summary' ? 'page' : undefined}
              onClick={() =>
                navigate(() => {
                  setTab('summary');
                  setEditing(false);
                })
              }
            >
              Σύνοψη & παραδόσεις
            </button>
            {[...exercises.items]
              .sort((a, b) => a.position - b.position)
              .map((x) => (
                <button
                  key={x.id}
                  aria-current={tab === x.id ? 'page' : undefined}
                  onClick={() =>
                    navigate(() => {
                      setTab(x.id);
                      setEditing(false);
                    })
                  }
                >
                  {x.title}
                  {x.archived ? ' · αρχείο' : ''}
                </button>
              ))}
          </nav>
          {exercises.loading && <p role="status">Φόρτωση ασκήσεων…</p>}
          {exercises.error && (
            <div className="notice error" role="alert">
              {exercises.error.message}
              <button onClick={exercises.reload}>Επανάληψη ασκήσεων</button>
            </div>
          )}
          {exercises.items.length < exercises.total && (
            <button disabled={exercises.busy} onClick={exercises.more}>
              Περισσότερες καρτέλες ασκήσεων
            </button>
          )}
          {tab === 'summary' ? (
            <>
              <section className="panel">
                <div className="section-heading">
                  <h3>Στοιχεία & σημειώσεις ομάδας</h3>
                  <button onClick={() => navigate(() => setEditing(true))}>
                    Επεξεργασία ομάδας
                  </button>
                </div>
                <p className="preserve muted">{team.value.notes || 'Δεν υπάρχουν σημειώσεις.'}</p>
              </section>
              {editing && (
                <TeamEditor
                  labId={labId}
                  team={team.value}
                  onSaved={(saved) => {
                    team.setValue(saved);
                    teams.reload();
                  }}
                  onCancel={() => navigate(() => setEditing(false))}
                />
              )}
              <LoadState {...submissions} retry={submissions.reload}>
                {null}
              </LoadState>
              <Submissions
                labId={labId}
                teamId={teamId}
                items={submissions.items}
                total={submissions.total}
                pending={submissions.loading || !!submissions.error}
                busy={submissions.busy}
                onMore={submissions.more}
                onRefresh={submissions.reload}
              />
              {submissions.moreError && <p role="alert">{submissions.moreError.message}</p>}
              {!exercises.loading && !exercises.error && !exercises.items.length && (
                <Empty>Δεν υπάρχουν ασκήσεις. Ορίστε πρώτα τη βαθμολογική κλίμακα.</Empty>
              )}
            </>
          ) : exercises.items.find((x) => x.id === tab) ? (
            <>
              <LoadState {...submissions} retry={submissions.reload}>
                {null}
              </LoadState>
              <AssessmentView
                key={tab}
                labId={labId}
                teamId={teamId}
                exercise={exercises.items.find((x) => x.id === tab)!}
                submissions={submissions.items}
              />
              {submissions.items.length < submissions.total && (
                <button disabled={submissions.busy} onClick={submissions.more}>
                  Περισσότερες παραδόσεις για σύνδεση
                </button>
              )}
            </>
          ) : (
            <Empty>Η άσκηση δεν είναι διαθέσιμη.</Empty>
          )}
        </>
      )}
    </LoadState>
  );
}
