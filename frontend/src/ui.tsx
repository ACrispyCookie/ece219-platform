import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, APIError } from './api';
import type { Page } from './types';
import { sameRecord, unconfirmed } from './verification';
import { stringifyJSON } from './resultJSON';
export const DirtyContext = createContext<{
  set: (key: string, dirty: boolean) => void;
  guard: () => boolean;
}>({ set: () => {}, guard: () => true });
export function useDirty(dirty: boolean) {
  const key = useId();
  const context = useContext(DirtyContext);
  useEffect(() => {
    context.set(key, dirty);
    return () => context.set(key, false);
  }, [dirty, context]);
}
export function useResource<T>(path: string | null) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<Error>();
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const previousPath = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    if (previousPath.current !== path) setValue(undefined);
    previousPath.current = path;
    setError(undefined);
    setLoading(true);
    if (!path) {
      setLoading(false);
      return;
    }
    api<T>(path, { signal: abort.signal })
      .then((v) => {
        if (active) setValue(v);
      })
      .catch((e) => {
        if (active) setError(e);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [path, version]);
  return { value, error, loading, reload: () => setVersion((v) => v + 1), setValue };
}
export function usePaged<T>(path: string | null) {
  const resource = useResource<Page<T>>(
    path ? `${path}${path.includes('?') ? '&' : '?'}limit=100&offset=0` : null,
  );
  const [extra, setExtra] = useState<T[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setExtra([]);
    setError(undefined);
  }, [path, resource.value]);
  const items = [...(resource.value?.items || []), ...extra];
  async function more() {
    if (!path) return;
    const current = epoch.current;
    setBusy(true);
    setError(undefined);
    try {
      const next = await api<Page<T>>(
        `${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${items.length}`,
      );
      if (current === epoch.current) setExtra((x) => [...x, ...next.items]);
    } catch (e) {
      if (current === epoch.current) setError(e as Error);
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }
  return { ...resource, items, total: resource.value?.total || 0, more, busy, moreError: error };
}
export function LoadState({
  loading,
  error,
  retry,
  children,
}: {
  loading: boolean;
  error?: Error;
  retry: () => void;
  children: ReactNode;
}) {
  if (loading)
    return (
      <div className="loading" role="status">
        Φόρτωση…
      </div>
    );
  if (error)
    return (
      <div className="notice error" role="alert">
        <p>{error.message}</p>
        <button onClick={retry}>Επανάληψη</button>
      </div>
    );
  return <>{children}</>;
}
export function More({
  count,
  total,
  busy,
  onMore,
}: {
  count: number;
  total: number;
  busy: boolean;
  onMore: () => void;
}) {
  return (
    <div className="pagination">
      <span>
        {count} από {total}
      </span>
      {count < total && (
        <button disabled={busy} onClick={onMore}>
          {busy ? 'Φόρτωση…' : 'Περισσότερα'}
        </button>
      )}
    </div>
  );
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function SaveForm<T extends object>({
  initial,
  save,
  read,
  onSaved,
  validate,
  children,
  title,
  onCancel,
  compareRead,
  onReload,
  renderServer,
}: {
  initial: T;
  save: (draft: T) => Promise<unknown>;
  read: () => Promise<T>;
  onSaved: (saved: T) => void;
  validate?: (draft: T) => string | undefined;
  children: (draft: T, set: (patch: Partial<T>) => void) => ReactNode;
  title: string;
  onCancel?: () => void;
  compareRead?: () => Promise<T>;
  onReload?: (saved: T) => void;
  renderServer?: (saved: T) => ReactNode;
}) {
  const [draft, setDraft] = useState<T>(initial);
  const [baseline, setBaseline] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const [server, setServer] = useState<T>();
  const [success, setSuccess] = useState(false);
  const dirty = !sameRecord(draft, baseline);
  useDirty(dirty || busy);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const patch = (p: Partial<T>) => {
    if (busy) return;
    setDraft((d) => ({ ...d, ...p }));
    setSuccess(false);
  };
  async function submit() {
    if (busy) return;
    setError(undefined);
    setSuccess(false);
    const invalid = validate?.(draft);
    if (invalid) {
      setError(new Error(invalid));
      return;
    }
    setBusy(true);
    try {
      const written = await save(draft);
      const saved = await read();
      if (!sameRecord(written, saved)) throw new Error(unconfirmed);
      if (
        'revision' in saved &&
        'revision' in draft &&
        typeof saved.revision === 'number' &&
        typeof draft.revision === 'number' &&
        (saved.revision <= draft.revision ||
          (written &&
            typeof written === 'object' &&
            'revision' in written &&
            typeof written.revision === 'number' &&
            saved.revision !== written.revision))
      )
        throw new Error(
          'Η αποθήκευση δεν επιβεβαιώθηκε από την έκδοση διακομιστή. Οι αλλαγές σας διατηρούνται.',
        );
      if (!mounted.current) return;
      setDraft(saved);
      setBaseline(saved);
      setServer(undefined);
      setSuccess(true);
      onSaved(saved);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>{title}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy} className="form-fields">
          {children(draft, patch)}
        </fieldset>
        {error && (
          <div role="alert" className="notice error">
            <p>{error.message}</p>
            {error instanceof APIError && error.status === 409 && (
              <>
                <p>Οι αλλαγές σας διατηρούνται. Δεν έγινε αντικατάσταση.</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void (compareRead || read)().then(setServer).catch(setError);
                  }}
                >
                  Σύγκριση με διακομιστή
                </button>
              </>
            )}
            {error instanceof APIError && error.details != null && (
              <details>
                <summary>Λεπτομέρειες διακομιστή</summary>
                <pre>{stringifyJSON(error.details, 2)}</pre>
              </details>
            )}
          </div>
        )}
        {server && (
          <div className="notice">
            <h3>Έκδοση διακομιστή</h3>
            <pre>{stringifyJSON(server, 2)}</pre>
            {renderServer?.(server)}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    'Αντικατάσταση των μη αποθηκευμένων αλλαγών με την έκδοση διακομιστή;',
                  )
                ) {
                  setDraft(server);
                  setBaseline(server);
                  setServer(undefined);
                  setError(undefined);
                  onReload?.(server);
                }
              }}
            >
              Επαναφόρτωση από διακομιστή
            </button>
          </div>
        )}
        {success && (
          <p role="status" className="success">
            Αποθηκεύτηκε και επιβεβαιώθηκε.
          </p>
        )}
        <div className="actions">
          <button className="primary" disabled={busy} type="submit">
            {busy ? 'Αποθήκευση…' : 'Αποθήκευση'}
          </button>
          {dirty && <span className="muted">Μη αποθηκευμένες αλλαγές</span>}
          {onCancel && (
            <button type="button" disabled={busy} onClick={onCancel}>
              Ακύρωση
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
