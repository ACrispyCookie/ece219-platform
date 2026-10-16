import { useEffect, useMemo, useRef, useState } from 'react';
import { api, json, labPath } from './api';
import { DirtyContext, Empty, Field, LoadState, More, SaveForm, usePaged, useResource } from './ui';
import type { Lab, Overview } from './types';
import Exercises from './Exercises';
import Removal from './Removal';
import { OperationContext, useOperations } from './OperationContext';
import Teams from './Teams';
import TeamDetail from './TeamDetail';
import Materials from './Materials';
import { parseRoute, routeHash } from './routes';
function Login({ onLogin, overlay = false }: { onLogin: () => void; overlay?: boolean }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className={overlay ? 'auth-overlay' : 'login-page'}>
      <section className="login-card">
        <div className="brand-mark">LC</div>
        <p className="eyebrow">LAB CATALOG</p>
        <h1>Πλατφόρμα εργαστηρίων</h1>
        <p className="muted">Ένας χώρος για ομάδες, παραδόσεις και αξιολόγηση.</p>
        {overlay && <p>Η συνεδρία έληξε. Οι μη αποθηκευμένες αλλαγές διατηρούνται.</p>}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await api('/session', json('POST', { token }));
              const session = await api<{ authenticated: boolean }>('/session');
              if (!session.authenticated) throw new Error('Η σύνδεση δεν επιβεβαιώθηκε.');
              setToken('');
              onLogin();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Κλειδί πρόσβασης">
            <input
              autoComplete="current-password"
              type="password"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            Σύνδεση
          </button>
        </form>
        <p className="small muted">Κοινό κλειδί χειριστή · ασφαλής συνεδρία cookie</p>
      </section>
    </div>
  );
}
function LabEditor({
  lab,
  onSaved,
  onCancel,
}: {
  lab?: Lab;
  onSaved: (saved: Lab) => void;
  onCancel: () => void;
}) {
  const createdRef = useRef<string | undefined>(lab?.id);
  const initial: Lab = lab || { id: '', title: '', description: '', archived: false, revision: 0 };
  return (
    <SaveForm
      title={lab ? 'Ρυθμίσεις εργαστηρίου' : 'Νέο εργαστήριο'}
      initial={initial}
      validate={(d) => (!d.title.trim() ? 'Συμπληρώστε τίτλο.' : undefined)}
      save={async (d) => {
        const editing = !!createdRef.current;
        const payload = {
          title: d.title,
          description: d.description,
          archived: d.archived,
          ...(editing ? { revision: d.revision } : {}),
        };
        const result = await api<Lab>(
          editing ? labPath(createdRef.current!) : '/labs',
          json(editing ? 'PATCH' : 'POST', payload),
        );
        createdRef.current = result.id;
        return result;
      }}
      read={() => api<Lab>(labPath(createdRef.current || ''))}
      onSaved={onSaved}
      onCancel={onCancel}
    >
      {(d, set) => (
        <>
          <Field label="Τίτλος">
            <input required value={d.title} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label="Περιγραφή">
            <textarea
              value={d.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
          {lab && (
            <label className="check">
              <input
                type="checkbox"
                checked={d.archived}
                onChange={(e) => set({ archived: e.target.checked })}
              />
              Αρχειοθετημένο εργαστήριο
            </label>
          )}
        </>
      )}
    </SaveForm>
  );
}
function OverviewView({ labId, onTeam }: { labId: string; onTeam: (id: string) => void }) {
  const result = useResource<Overview>(`${labPath(labId)}/overview?limit=100&offset=0`);
  const [extra, setExtra] = useState<Overview['rows']>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [attention, setAttention] = useState(false);
  const rows = [...(result.value?.rows || []), ...extra];
  const visible = rows.filter(
    (r) =>
      (r.team.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()) ||
        r.team.members.some((m) => m.student_id.includes(search))) &&
      (!attention ||
        !r.grade_complete ||
        !r.team.membership_complete ||
        r.submissions_count === 0 ||
        r.assessments.some((a) => a.rubric_stale)),
  );
  return (
    <LoadState {...result} retry={result.reload}>
      <section>
        <div className="section-heading">
          <div>
            <h2>Εικόνα εργαστηρίου</h2>
            <p className="muted">Ομάδες × ασκήσεις · ενημερωμένη κατάσταση API</p>
          </div>
          <a className="button" href={`/api/v1${labPath(labId)}/export`} download>
            Εξαγωγή JSON
          </a>
        </div>
        <div className="metrics">
          <div>
            <span>Ομάδες</span>
            <strong>{result.value?.total ?? '—'}</strong>
          </div>
          <div>
            <span>Ασκήσεις</span>
            <strong>{result.value?.exercises.length ?? '—'}</strong>
          </div>
          <div>
            <span>Ολοκληρωμένες / φορτωμένες</span>
            <strong>
              {rows.filter((r) => r.grade_complete).length} / {rows.length}
            </strong>
          </div>
        </div>
        <div className="toolbar">
          <Field label="Αναζήτηση ομάδας ή ΑΜ">
            <input
              type="search"
              placeholder="Ετικέτα ομάδας ή ακριβές τμήμα ΑΜ"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={attention}
              onChange={(e) => setAttention(e.target.checked)}
            />
            Χρειάζονται προσοχή
          </label>
        </div>
        {rows.length === 0 ? (
          <Empty>Δεν υπάρχουν ομάδες. Προσθέστε την πρώτη από την καρτέλα Ομάδες.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ομάδα / μέλη</th>
                    <th>Παραδόσεις</th>
                    {result.value?.exercises.map((x) => (
                      <th key={x.id}>{x.title}</th>
                    ))}
                    <th>Σύνολο</th>
                    <th>Κατάσταση</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.team.id}>
                      <td>
                        <button className="text-button" onClick={() => onTeam(r.team.id)}>
                          {r.team.label}
                        </button>
                        <div className="small muted">
                          {r.team.members.map((m) => (
                            <span className="student-id" key={m.student_id}>
                              {m.student_id}
                            </span>
                          ))}
                        </div>
                        {!r.team.membership_complete && (
                          <span className="badge warn">Ελλιπή μέλη</span>
                        )}
                      </td>
                      <td>{r.submissions_count}</td>
                      {result.value?.exercises.map((x) => {
                        const a = r.assessments.find((a) => a.exercise_id === x.id);
                        return (
                          <td key={x.id}>
                            <span>{a?.score ?? '—'}</span>
                            <div className="small muted">
                              {a?.status === 'final'
                                ? 'Οριστική'
                                : a?.status === 'draft'
                                  ? 'Προσχέδιο'
                                  : 'Χωρίς βαθμό'}
                            </div>
                            {a?.rubric_stale && (
                              <span className="badge warn">Αλλαγή κριτηρίων</span>
                            )}
                          </td>
                        );
                      })}
                      <td>
                        {r.awarded_points ?? '—'} <span className="muted">/ {r.total_points}</span>
                      </td>
                      <td>
                        <span className={`badge ${r.grade_complete ? 'good' : 'warn'}`}>
                          {r.grade_complete ? 'Ολοκληρωμένη' : 'Εκκρεμεί'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {visible.length === 0 && <Empty>Καμία ομάδα στα φορτωμένα αποτελέσματα.</Empty>}
          </>
        )}
        {rows.length < (result.value?.total || 0) && (
          <p className="muted small">
            Η αναζήτηση και το φίλτρο αφορούν τις φορτωμένες ομάδες. Φορτώστε περισσότερες για πλήρη
            αναζήτηση.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <More
          count={rows.length}
          total={result.value?.total || 0}
          busy={busy}
          onMore={async () => {
            setBusy(true);
            setError('');
            try {
              const next = await api<Overview>(
                `${labPath(labId)}/overview?limit=100&offset=${rows.length}`,
              );
              setExtra((x) => [...x, ...next.rows]);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      </section>
    </LoadState>
  );
}
export default function App() {
  const removal = useOperations();
  const [removedLabs, setRemovedLabs] = useState<Set<string>>(() => new Set());
  const session = useResource<{ authenticated: boolean }>('/session');
  const [authenticated, setAuthenticated] = useState(false);
  const [expired, setExpired] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(
    () => parseRoute(window.location.hash).labId,
  );
  const [tab, setTab] = useState(() => parseRoute(window.location.hash).tab);
  const [editor, setEditor] = useState<'new' | 'edit' | null>(null);
  const [teamId, setTeamId] = useState<string | undefined>(
    () => parseRoute(window.location.hash).teamId,
  );
  const [teamExercise, setTeamExercise] = useState<string | undefined>(
    () => parseRoute(window.location.hash).exerciseId,
  );
  const lastHash = useRef(window.location.hash);
  const scrollRoute = useRef(routeHash(parseRoute(window.location.hash)));
  useEffect(() => {
    if (!authenticated) return;
    const next = routeHash({ labId: selected, tab, teamId, exerciseId: teamExercise });
    if (next !== scrollRoute.current) {
      scrollRoute.current = next;
      window.scrollTo(0, 0);
    }
  }, [authenticated, selected, tab, teamId, teamExercise]);
  const [logoutError, setLogoutError] = useState('');
  const dirty = useRef(new Set<string>());
  const dirtyContext = useMemo(
    () => ({
      set: (key: string, value: boolean) => {
        if (value) dirty.current.add(key);
        else dirty.current.delete(key);
      },
      guard: () =>
        !removal.locked.current &&
        (!dirty.current.size ||
          window.confirm('Υπάρχουν μη αποθηκευμένες αλλαγές. Θέλετε να τις απορρίψετε;')),
    }),
    [removal.locked],
  );
  useEffect(() => {
    if (session.value?.authenticated) setAuthenticated(true);
  }, [session.value]);
  useEffect(() => {
    const handler = () => setExpired(true);
    const before = (e: BeforeUnloadEvent) => {
      if (dirty.current.size || removal.locked.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('catalog:unauthorized', handler);
    window.addEventListener('beforeunload', before);
    return () => {
      window.removeEventListener('catalog:unauthorized', handler);
      window.removeEventListener('beforeunload', before);
    };
  }, [removal.locked]);
  useEffect(() => {
    if (!authenticated) return;
    const hash = routeHash({ labId: selected, tab, teamId, exerciseId: teamExercise });
    if (hash !== window.location.hash) {
      lastHash.current = hash;
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${hash}`,
      );
    }
  }, [authenticated, selected, tab, teamId, teamExercise]);
  useEffect(() => {
    const changed = () => {
      if (window.location.hash === lastHash.current) return;
      if (!dirtyContext.guard()) {
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}${lastHash.current}`,
        );
        return;
      }
      const route = parseRoute(window.location.hash);
      lastHash.current = window.location.hash;
      setSelected(route.labId);
      setTab(route.tab);
      setTeamId(route.teamId);
      setTeamExercise(route.exerciseId);
      setEditor(null);
    };
    window.addEventListener('hashchange', changed);
    window.addEventListener('popstate', changed);
    return () => {
      window.removeEventListener('hashchange', changed);
      window.removeEventListener('popstate', changed);
    };
  }, [dirtyContext]);
  const labs = usePaged<Lab>(authenticated ? '/labs' : null);
  const availableLabs = labs.items.filter((l) => !removedLabs.has(l.id));
  const lab = useResource<Lab>(selected ? labPath(selected) : null);
  useEffect(() => {
    const next = labs.items.find((l) => !removedLabs.has(l.id));
    if (authenticated && !selected && next) setSelected(next.id);
  }, [authenticated, selected, labs.items, removedLabs]);
  function navigate(action: () => void) {
    if (dirtyContext.guard()) action();
  }
  if (session.loading)
    return (
      <div className="loading" role="status">
        Φόρτωση συνεδρίας…
      </div>
    );
  if (session.error && !authenticated)
    return (
      <LoadState {...session} retry={session.reload}>
        {null}
      </LoadState>
    );
  if (!authenticated)
    return (
      <Login
        onLogin={() => {
          setAuthenticated(true);
          labs.reload();
        }}
      />
    );
  return (
    <DirtyContext.Provider value={dirtyContext}>
      <OperationContext.Provider value={removal}>
        <fieldset disabled={removal.pending} className="form-fields">
          <div className="app-shell">
            <aside className="sidebar">
              <div className="brand">
                <div className="brand-mark">LC</div>
                <div>
                  <strong>Lab Catalog</strong>
                  <span>Πλατφόρμα εργαστηρίων</span>
                </div>
              </div>
              <div className="sidebar-heading">ΕΡΓΑΣΤΗΡΙΑ</div>
              <LoadState {...labs} retry={labs.reload}>
                <nav aria-label="Εργαστήρια">
                  {availableLabs.map((l) => (
                    <button
                      className={selected === l.id ? 'lab-link active' : 'lab-link'}
                      key={l.id}
                      onClick={() =>
                        navigate(() => {
                          setSelected(l.id);
                          setTab('overview');
                          setTeamId(undefined);
                          setTeamExercise(undefined);
                          setEditor(null);
                        })
                      }
                    >
                      <span>{l.title}</span>
                      {l.archived && <span className="small muted">Αρχείο</span>}
                    </button>
                  ))}
                </nav>
                <More
                  count={labs.items.length}
                  total={labs.total}
                  busy={labs.busy}
                  onMore={labs.more}
                />
              </LoadState>
              <button className="new-lab" onClick={() => navigate(() => setEditor('new'))}>
                Νέο εργαστήριο
              </button>
              <div className="sidebar-footer">
                <a href="/docs" target="_blank" rel="noreferrer noopener">
                  API / τεκμηρίωση ↗
                </a>
                <button
                  onClick={() =>
                    navigate(async () => {
                      try {
                        await api('/session', { method: 'DELETE' });
                        const s = await api<{ authenticated: boolean }>('/session');
                        if (s.authenticated) throw new Error('Η αποσύνδεση δεν επιβεβαιώθηκε.');
                        setAuthenticated(false);
                        setSelected(undefined);
                        setEditor(null);
                        setTeamId(undefined);
                      } catch (e) {
                        setLogoutError((e as Error).message);
                      }
                    })
                  }
                >
                  Αποσύνδεση
                </button>
                {logoutError && <p role="alert">{logoutError}</p>}
              </div>
            </aside>
            <main>
              <header className="topbar">
                <span className="eyebrow">ΠΛΑΤΦΟΡΜΑ ΕΡΓΑΣΤΗΡΙΩΝ</span>
                <span className="session-indicator">Συνεδρία χειριστή</span>
              </header>
              <div className="content">
                {editor ? (
                  <LabEditor
                    key={editor === 'new' ? 'new' : selected}
                    lab={editor === 'edit' ? lab.value : undefined}
                    onCancel={() => navigate(() => setEditor(null))}
                    onSaved={(saved) => {
                      setSelected(saved.id);
                      lab.setValue(saved);
                      labs.reload();
                      setEditor(null);
                    }}
                  />
                ) : !selected ? (
                  <Empty>Δεν υπάρχουν εργαστήρια ακόμη.</Empty>
                ) : (
                  <LoadState {...lab} retry={lab.reload}>
                    {lab.value && (
                      <>
                        <div className="page-heading lab-heading">
                          <div>
                            <p className="eyebrow">
                              ΕΡΓΑΣΤΗΡΙΟ {lab.value.archived ? '· ΑΡΧΕΙΟ' : ''}
                            </p>
                            <h1>{lab.value.title}</h1>
                            <p className="muted">
                              {lab.value.description ||
                                'Ομάδες, ασκήσεις και τεκμήρια σε έναν κατάλογο.'}
                            </p>
                          </div>
                          <div className="actions item-actions manage-actions">
                            <button onClick={() => navigate(() => setEditor('edit'))}>
                              Ρυθμίσεις εργαστηρίου
                            </button>
                            <Removal
                              key={lab.value.id}
                              path={labPath(lab.value.id)}
                              revision={lab.value.revision}
                              title={lab.value.title}
                              kind="εργαστηρίου"
                              onRemoved={() => {
                                setRemovedLabs((old) => new Set([...old, selected]));
                                setSelected(undefined);
                                setTab('overview');
                                setEditor(null);
                                setTeamId(undefined);
                                setTeamExercise(undefined);
                                lab.setValue(undefined);
                                labs.setValue(undefined);
                                labs.reload();
                              }}
                            />
                          </div>
                        </div>
                        <nav className="tabs" aria-label="Καρτέλες εργαστηρίου">
                          {[
                            ['overview', 'Επισκόπηση'],
                            ['exercises', 'Ασκήσεις & βαθμολόγηση'],
                            ['teams', 'Ομάδες'],
                            ['materials', 'Υλικό'],
                          ].map(([key, label]) => (
                            <button
                              key={key}
                              aria-current={tab === key ? 'page' : undefined}
                              onClick={() =>
                                navigate(() => {
                                  setTab(key);
                                  setTeamId(undefined);
                                  setTeamExercise(undefined);
                                })
                              }
                            >
                              {label}
                            </button>
                          ))}
                        </nav>
                        {tab === 'overview' && (
                          <OverviewView
                            key={selected}
                            labId={selected}
                            onTeam={(id) =>
                              navigate(() => {
                                setTeamId(id);
                                setTab('teams');
                              })
                            }
                          />
                        )}
                        {tab === 'exercises' && <Exercises key={selected} labId={selected} />}
                        {tab === 'teams' &&
                          (teamId ? (
                            <TeamDetail
                              key={`${selected}/${teamId}`}
                              labId={selected}
                              teamId={teamId}
                              exerciseId={teamExercise}
                              onExercise={setTeamExercise}
                              onBack={() => {
                                setTeamId(undefined);
                                setTeamExercise(undefined);
                              }}
                              onTeam={setTeamId}
                            />
                          ) : (
                            <Teams key={selected} labId={selected} onTeam={(id) => setTeamId(id)} />
                          ))}
                        {tab === 'materials' && <Materials key={selected} labId={selected} />}
                      </>
                    )}
                  </LoadState>
                )}
              </div>
            </main>
          </div>
        </fieldset>
        {expired && <Login overlay onLogin={() => setExpired(false)} />}
      </OperationContext.Provider>
    </DirtyContext.Provider>
  );
}
