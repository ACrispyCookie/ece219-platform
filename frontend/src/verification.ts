import { LosslessNumber, compareLosslessNumber } from 'lossless-json';
export const unconfirmed =
  'Η αποθήκευση δεν επιβεβαιώθηκε από την έκδοση διακομιστή. Οι αλλαγές σας διατηρούνται.';
// Compare API values independently of JSON object-key order; arrays remain ordered.
export function sameRecord(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof LosslessNumber || b instanceof LosslessNumber)
    return (
      a instanceof LosslessNumber &&
      b instanceof LosslessNumber &&
      compareLosslessNumber(a, b) === 0
    );
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a),
    right = Object.entries(b);
  return (
    left.length === right.length &&
    left.every(
      ([key, value]) =>
        Object.hasOwn(b, key) && sameRecord(value, (b as Record<string, unknown>)[key]),
    )
  );
}
