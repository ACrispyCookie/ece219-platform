import { useContext, useEffect, useRef, useState } from 'react';
import { api, APIError } from './api';
import { DirtyContext, useDirty } from './ui';
import { useOperations } from './OperationContext';
import type { Assessment, Page } from './types';
import RemovalDialog from './RemovalDialog';

const dependencyLabels = {
  labs: 'Εργαστήρια',
  exercises: 'Ασκήσεις',
  teams: 'Ομάδες',
  files: 'Αρχεία',
  materials: 'Υλικό',
  submissions: 'Παραδόσεις',
  assessments: 'Αξιολογήσεις',
  assessment_history: 'Ιστορικό αξιολογήσεων',
  evidence: 'Τεκμήρια',
};
type Count = { kind: keyof typeof dependencyLabels; count: number };
type DeletionImpact = {
  dependencies: Count[];
  unreferenced_files: { id: string; filename: string }[];
  unreferenced_files_total: number;
  cascade_counts: Count[];
  confirmation_token: string;
};
// A failed or malformed preview must never be interpreted as an empty closure.
function validCounts(value: unknown): value is Count[] {
  return (
    Array.isArray(value) &&
    value.length <= Object.keys(dependencyLabels).length &&
    value.every(
      (d) =>
        d &&
        Object.hasOwn(dependencyLabels, d.kind) &&
        Number.isSafeInteger(d.count) &&
        d.count > 0,
    ) &&
    new Set(value.map((d) => d.kind)).size === value.length
  );
}
function deletionImpact(value: unknown): DeletionImpact | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as DeletionImpact;
  if (
    !validCounts(data.dependencies) ||
    !validCounts(data.cascade_counts) ||
    !data.cascade_counts.length ||
    typeof data.confirmation_token !== 'string' ||
    !/^[a-fA-F0-9]{64}$/.test(data.confirmation_token) ||
    !Array.isArray(data.unreferenced_files) ||
    data.unreferenced_files.length > 50 ||
    !data.unreferenced_files.every(
      (f) => f && typeof f.id === 'string' && f.id.length > 0 && typeof f.filename === 'string',
    ) ||
    new Set(data.unreferenced_files.map((f) => f.id)).size !== data.unreferenced_files.length ||
    !Number.isSafeInteger(data.unreferenced_files_total) ||
    data.unreferenced_files_total < data.unreferenced_files.length
  )
    return;
  return data;
}
export type RemovalKind =
  | 'εργαστηρίου'
  | 'άσκησης'
  | 'ομάδας'
  | 'υλικού'
  | 'τεκμηρίου'
  | 'παράδοσης'
  | 'αξιολόγησης'
  | 'αρχείου';
export default function Removal({
  path,
  readPath = path,
  revision,
  title,
  kind,
  onRemoved,
}: {
  path: string;
  readPath?: string;
  revision?: number;
  title: string;
  kind: RemovalKind;
  onRemoved: (emptyAssessment?: Assessment) => void;
}) {
  const operations = useOperations();
  const dirty = useContext(DirtyContext);
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const [confirmation, setConfirmation] = useState<{
    impact: DeletionImpact;
    generation: number;
    busy: boolean;
  } | null>(null);
  const choice = useRef<((confirmed: boolean) => void) | null>(null);
  const restoreFocus = useRef<number | null>(null);
  const identity = `${path}|${readPath}|${revision ?? ''}|${kind}|${title}`;
  const target = useRef(identity);
  const epoch = useRef(0);
  if (target.current !== identity) {
    target.current = identity;
    epoch.current++;
  }
  const generation = epoch.current;
  useDirty(operations.pending);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      choice.current?.(false);
      choice.current = null;
    };
  }, []);
  useEffect(() => {
    setError('');
    choice.current?.(false);
    choice.current = null;
    setConfirmation(null);
  }, [identity]);
  useEffect(() => {
    if (!operations.pending && restoreFocus.current !== null) {
      if (mounted.current && restoreFocus.current === epoch.current && trigger.current?.isConnected)
        trigger.current.focus();
      restoreFocus.current = null;
    }
  }, [operations.pending]);
  function decide(confirmed: boolean) {
    if (!choice.current || !current()) return;
    const resolve = choice.current;
    choice.current = null; // Reject duplicate choice before React renders busy state.
    if (confirmed) setConfirmation((value) => value && { ...value, busy: true });
    resolve(confirmed);
  }
  const current = () =>
    mounted.current && target.current === identity && epoch.current === generation;
  function dismiss() {
    if (operations.locked.current || !current()) return;
    setError('');
    trigger.current?.focus();
  }
  async function verifyRemoved() {
    if (kind === 'αξιολόγησης') {
      const empty = await api<Assessment>(readPath);
      if (
        !empty ||
        empty.id !== null ||
        empty.revision !== 0 ||
        empty.score !== null ||
        empty.status !== 'ungraded'
      )
        throw new Error('Η αξιολόγηση εξακολουθεί να υπάρχει στον διακομιστή.');
      const history = await api<Page<Assessment>>(`${readPath}/history?limit=1&offset=0`);
      if (
        !history ||
        history.total !== 0 ||
        !Array.isArray(history.items) ||
        history.items.length !== 0
      )
        throw new Error('Το ιστορικό αξιολογήσεων δεν είναι κενό.');
      return empty;
    }
    try {
      await api(readPath);
      throw new Error('Ο πόρος εξακολουθεί να υπάρχει στον διακομιστή.');
    } catch (e) {
      if (!(e instanceof APIError && e.status === 404)) throw e;
    }
  }
  async function remove() {
    // Synchronous ownership spans preview, manual choice, DELETE and readback.
    if (
      operations.locked.current ||
      operations.saves.current.size ||
      !dirty.guard() ||
      !operations.acquire()
    )
      return;
    setError('');
    let verifying = false;
    try {
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
        throw new Error('Μη έγκυρη έκδοση διαγραφής. Επαναφορτώστε τον πόρο.');
      const impact = deletionImpact(await api(`${path}/deletion-impact`));
      if (!impact) throw new Error('Μη έγκυρη απάντηση εξαρτήσεων από τον διακομιστή.');
      if (!current()) return;
      const confirmed = await new Promise<boolean>((resolve) => {
        choice.current = resolve;
        setConfirmation({ impact, generation, busy: false });
      });
      if (!confirmed) return;
      if (!current()) return;
      const query = `cascade=true&confirmation_token=${impact.confirmation_token}${revision === undefined ? '' : `&revision=${revision}`}`;
      await api(`${path}?${query}`, { method: 'DELETE' });
      verifying = true;
      const empty = await verifyRemoved();
      if (current()) onRemoved(empty);
    } catch (e) {
      if (!current()) return;
      let message = (e as Error).message;
      if (verifying)
        message = `Η διαγραφή δεν επιβεβαιώθηκε. ${message} Η προβολή και οι αλλαγές σας διατηρούνται.`;
      else if (e instanceof APIError && e.status === 409)
        message =
          e.code === 'deletion_changed'
            ? 'Οι εξαρτήσεις άλλαξαν στον διακομιστή. Η διαγραφή δεν έγινε. Δοκιμάστε ξανά για νέα προεπισκόπηση και νέα επιβεβαίωση. Η προβολή και οι αλλαγές σας διατηρούνται.'
            : 'Η έκδοση έχει τροποποιηθεί στον διακομιστή. Η διαγραφή δεν έγινε. Επαναφορτώστε και ελέγξτε τη νέα έκδοση πριν δοκιμάσετε ξανά. Η προβολή και οι αλλαγές σας διατηρούνται.';
      setError(message);
    } finally {
      if (current()) {
        setConfirmation(null);
        restoreFocus.current = generation;
      }
      operations.release();
    }
  }
  return (
    <div className="removal-controls">
      {confirmation && confirmation.generation === generation && (
        <RemovalDialog
          kind={kind}
          title={title}
          counts={confirmation.impact.cascade_counts.map((d) => ({
            label: dependencyLabels[d.kind],
            count: d.count,
          }))}
          busy={confirmation.busy}
          onChoice={decide}
        />
      )}
      <button
        ref={trigger}
        type="button"
        className="compact-delete"
        disabled={operations.pending}
        onClick={() => void remove()}
        aria-label={`Διαγραφή ${kind} ${title}`}
        title={`Διαγραφή ${kind} ${title}`}
      >
        {operations.pending ? 'Διαγραφή…' : 'Διαγραφή'}
      </button>
      {error && (
        <section className="notice warn removal-notice" role="alert">
          <div className="removal-notice-heading">
            <h3>
              <span className="notice-icon" aria-hidden="true">
                !
              </span>
              Η ενέργεια δεν ολοκληρώθηκε
            </h3>
            <button
              type="button"
              className="notice-dismiss"
              aria-label="Κλείσιμο ειδοποίησης"
              disabled={operations.pending}
              onClick={dismiss}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <p>{error}</p>
        </section>
      )}
    </div>
  );
}
