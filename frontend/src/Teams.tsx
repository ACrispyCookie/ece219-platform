import { useContext, useRef, useState } from 'react';
import { api, id, json, labPath } from './api';
import { DirtyContext, Empty, Field, LoadState, More, SaveForm, usePaged } from './ui';
import type { Team } from './types';
export function TeamEditor({
  labId,
  team,
  onSaved,
  onCancel,
}: {
  labId: string;
  team?: Team;
  onSaved: (saved: Team) => void;
  onCancel: () => void;
}) {
  const resourceId = useRef(team?.id);
  const base = `${labPath(labId)}/teams`;
  const initial: Team = team || {
    id: '',
    lab_id: labId,
    label: '',
    members: [],
    membership_complete: false,
    notes: '',
    archived: false,
    revision: 0,
  };
  return (
    <SaveForm
      title={team ? 'Στοιχεία ομάδας' : 'Νέα ομάδα'}
      initial={initial}
      validate={(d) =>
        !d.label.trim()
          ? 'Συμπληρώστε ετικέτα ομάδας.'
          : d.members.some((m) => !m.student_id.trim())
            ? 'Κάθε μέλος χρειάζεται ΑΜ.'
            : new Set(d.members.map((m) => m.student_id)).size !== d.members.length
              ? 'Οι ΑΜ πρέπει να είναι μοναδικοί.'
              : undefined
      }
      save={async (d) => {
        const editing = !!resourceId.current;
        const payload = {
          label: d.label,
          members: d.members,
          membership_complete: d.membership_complete,
          notes: d.notes,
          archived: d.archived,
          ...(editing ? { revision: d.revision } : {}),
        };
        const saved = await api<Team>(
          editing ? `${base}/${id(resourceId.current!)}` : base,
          json(editing ? 'PATCH' : 'POST', payload),
        );
        resourceId.current = saved.id;
        return saved;
      }}
      read={() => api<Team>(`${base}/${id(resourceId.current!)}`)}
      onSaved={onSaved}
      onCancel={onCancel}
    >
      {(d, set) => (
        <>
          <Field label="Ετικέτα ομάδας">
            <input required value={d.label} onChange={(e) => set({ label: e.target.value })} />
          </Field>
          <h3>Μέλη</h3>
          <p className="muted small">Ο ΑΜ διατηρείται ως κείμενο, μαζί με τα αρχικά μηδενικά.</p>
          {d.members.map((m, index) => (
            <fieldset key={index}>
              <legend>Μέλος {index + 1}</legend>
              <div className="form-grid">
                <Field label={`Μέλος ${index + 1} · ΑΜ`}>
                  <input
                    required
                    value={m.student_id}
                    onChange={(e) =>
                      set({
                        members: d.members.map((x, i) =>
                          i === index ? { ...x, student_id: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
                <Field label={`Μέλος ${index + 1} · όνομα (προαιρετικό)`}>
                  <input
                    value={m.name}
                    onChange={(e) =>
                      set({
                        members: d.members.map((x, i) =>
                          i === index ? { ...x, name: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
              </div>
              <button
                type="button"
                onClick={() => set({ members: d.members.filter((_, i) => i !== index) })}
              >
                Αφαίρεση μέλους {index + 1}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            onClick={() => set({ members: [...d.members, { student_id: '', name: '' }] })}
          >
            Προσθήκη μέλους
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={d.membership_complete}
              onChange={(e) => set({ membership_complete: e.target.checked })}
            />
            Η σύνθεση της ομάδας είναι πλήρης
          </label>
          <Field label="Σημειώσεις ομάδας">
            <textarea value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
          {resourceId.current && (
            <label className="check">
              <input
                type="checkbox"
                checked={d.archived}
                onChange={(e) => set({ archived: e.target.checked })}
              />
              Αρχειοθετημένη ομάδα
            </label>
          )}
        </>
      )}
    </SaveForm>
  );
}
export default function Teams({ labId, onTeam }: { labId: string; onTeam: (id: string) => void }) {
  const list = usePaged<Team>(`${labPath(labId)}/teams`);
  const [create, setCreate] = useState(false);
  const [search, setSearch] = useState('');
  const context = useContext(DirtyContext);
  const visible = list.items.filter(
    (t) =>
      t.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()) ||
      t.members.some((m) => m.student_id.includes(search)),
  );
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Ομάδες</h2>
          <p className="muted">Μέλη, παραδόσεις και τεκμηριωμένη αξιολόγηση.</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            if (context.guard()) setCreate(true);
          }}
        >
          Νέα ομάδα
        </button>
      </div>
      {create && (
        <TeamEditor
          labId={labId}
          onSaved={() => list.reload()}
          onCancel={() => {
            if (context.guard()) setCreate(false);
          }}
        />
      )}
      <Field label="Αναζήτηση ομάδων">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Ετικέτα ή ΑΜ"
        />
      </Field>
      <LoadState {...list} retry={list.reload}>
        {!visible.length ? (
          <Empty>Δεν βρέθηκαν ομάδες στα φορτωμένα αποτελέσματα.</Empty>
        ) : (
          <div className="cards">
            {visible.map((t) => (
              <article className="resource-card" key={t.id}>
                <h3>
                  <button
                    className="text-button"
                    onClick={() => {
                      if (context.guard()) onTeam(t.id);
                    }}
                  >
                    {t.label}
                  </button>
                </h3>
                <div className="members">
                  {t.members.map((m) => (
                    <div key={m.student_id}>
                      <span className="student-id">{m.student_id}</span>{' '}
                      <span className="muted">{m.name}</span>
                    </div>
                  ))}
                </div>
                <div className="actions">
                  <span className={`badge ${t.membership_complete ? 'good' : 'warn'}`}>
                    {t.membership_complete ? 'Πλήρη μέλη' : 'Ελλιπή μέλη'}
                  </span>
                  {t.archived && <span className="badge warn">Αρχειοθετημένη</span>}
                </div>
              </article>
            ))}
          </div>
        )}
        {list.items.length < list.total && (
          <p className="small muted">Η αναζήτηση αφορά τις φορτωμένες ομάδες.</p>
        )}
        <More count={list.items.length} total={list.total} busy={list.busy} onMore={list.more} />
        {list.moreError && <p role="alert">{list.moreError.message}</p>}
      </LoadState>
    </>
  );
}
