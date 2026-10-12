import { isInteger, isSafeNumber, LosslessNumber, parse } from 'lossless-json';

class DuplicateJSONKeyError extends SyntaxError {}

// Validate tokens before either tree parser can discard duplicate keys. A Set
// per object tracks decoded strings (not values, prototypes or Unicode NFC).
// Numbers are only scanned, never converted; existing lossless policy stays below.
function validateJSONKeys(text: string): void {
  let i = 0;
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  function invalid(): never {
    throw new SyntaxError(`Invalid JSON at position ${i}`);
  }
  function whitespace() {
    while (i < text.length && /[ \t\r\n]/.test(text[i])) i++;
  }
  function eat(token: string) {
    whitespace();
    if (text[i] !== token) invalid();
    i++;
  }
  function string(): string {
    const start = i;
    if (text[i++] !== '"') invalid();
    while (i < text.length) {
      if (text[i] === '\\') i += 2;
      else if (text[i++] === '"') {
        // Native parsing is safe for an individual string token: no object keys
        // or numeric leaves can be erased, and all JSON escapes are validated.
        return JSON.parse(text.slice(start, i)) as string;
      }
    }
    return invalid();
  }
  function value(depth: number): void {
    whitespace();
    const token = text[i];
    if (token === '{' || token === '[') {
      // Bound recursion before calling the downstream parsers (server limit: 64).
      if (depth >= 64) throw new SyntaxError('JSON depth exceeds 64');
      i++;
      whitespace();
      const object = token === '{';
      const close = object ? '}' : ']';
      const keys = new Set<string>();
      if (text[i] !== close) {
        while (true) {
          whitespace();
          if (object) {
            const key = string();
            if (keys.has(key)) throw new DuplicateJSONKeyError(`Duplicate key ${JSON.stringify(key)}`);
            keys.add(key);
            eat(':');
          }
          value(depth + 1);
          whitespace();
          if (text[i] === close) break;
          eat(',');
        }
      }
      eat(close);
    } else if (token === '"') {
      string();
    } else {
      number.lastIndex = i;
      const numeric = number.exec(text);
      if (numeric) i = number.lastIndex;
      else {
        const keyword = ['true', 'false', 'null'].find((k) => text.startsWith(k, i));
        if (!keyword) invalid();
        i += keyword.length;
      }
    }
  }
  value(0);
  whitespace();
  if (i !== text.length) invalid();
}

// Ordinary API counters stay numbers. Unsafe numeric tokens remain exact, not
// fabricated from an already-rounded JS value. This also preserves JSON display.
export function parseJSON(text: string): unknown {
  validateJSONKeys(text);
  const exact = parse(text, undefined, {
    parseNumber: (value) => (isSafeNumber(value) ? Number(value) : new LosslessNumber(value)),
  });
  // lossless-json 4.3.1 assigns __proto__ through the legacy setter. Use native
  // parsing ONLY for object shape/string/boolean/null (never unsafe numbers),
  // then rebuild own keys with the exact numeric leaves from the lossless tree.
  function ownTree(shape: unknown, lossless: unknown): unknown {
    if (!shape || typeof shape !== 'object') return typeof shape === 'number' ? lossless : shape;
    if (Array.isArray(shape))
      return shape.map((item, index) => ownTree(item, (lossless as unknown[])[index]));
    return Object.fromEntries(
      Object.entries(shape).map(([key, item]) => {
        const value =
          key === '__proto__'
            ? Object.getPrototypeOf(lossless)
            : (lossless as Record<string, unknown>)[key];
        // Safe scalar __proto__ values are ignored by the legacy setter. Unsafe
        // numbers are LosslessNumber objects and are retained as the prototype.
        return [
          key,
          key === '__proto__' && typeof item === 'number' && !(value instanceof LosslessNumber)
            ? item
            : ownTree(item, value),
        ];
      }),
    );
  }
  return ownTree(JSON.parse(text), exact);
}
export function stringifyJSON(value: unknown, space?: number): string | undefined {
  // The package serializer duck-types `isLosslessNumber` on user objects.
  // Check actual instances instead, so every literal evidence key stays literal.
  const gap = ' '.repeat(Math.max(0, Math.min(10, space || 0)));
  function encode(current: unknown, depth: number): string | undefined {
    if (current instanceof LosslessNumber) return current.value;
    if (typeof current === 'bigint') return current.toString();
    if (!current || typeof current !== 'object') return JSON.stringify(current);
    const childIndent = gap.repeat(depth + 1);
    const indent = gap.repeat(depth);
    const array = Array.isArray(current);
    const parts = array
      ? current.map((item) => encode(item, depth + 1) ?? 'null')
      : Object.entries(current).flatMap(([key, item]) => {
          const encoded = encode(item, depth + 1);
          return encoded === undefined
            ? []
            : [`${JSON.stringify(key)}:${gap ? ' ' : ''}${encoded}`];
        });
    const [open, close] = array ? ['[', ']'] : ['{', '}'];
    return parts.length === 0
      ? open + close
      : gap
        ? `${open}\n${childIndent}${parts.join(`,\n${childIndent}`)}\n${indent}${close}`
        : open + parts.join(',') + close;
  }
  return encode(value, 0);
}

// The backend preserves arbitrary integer tokens, but decimals/exponents use
// binary64. Reject tokens that cannot round-trip there; exact decimals may be
// supplied as JSON strings. Incoming data is still displayed losslessly.
export function parseResultJSON(text: string): unknown {
  let result: unknown;
  try {
    result = parseJSON(text);
  } catch (error) {
    if (error instanceof DuplicateJSONKeyError)
      throw new Error('Το αποτέλεσμα πρέπει να είναι έγκυρο JSON χωρίς διπλά κλειδιά.');
    throw new Error('Το αποτέλεσμα πρέπει να είναι έγκυρο JSON.');
  }
  function validate(value: unknown): void {
    if (value instanceof LosslessNumber && !isInteger(value.value)) {
      if (!Number.isFinite(Number(value.value)))
        throw new Error('Το αποτέλεσμα πρέπει να είναι έγκυρο JSON με πεπερασμένους αριθμούς.');
      throw new Error(
        'Ο αριθμός χάνει ακρίβεια στον διακομιστή. Χρησιμοποιήστε JSON string για δεκαδικά ακριβούς ακρίβειας ή ακέραιο χωρίς εκθέτη.',
      );
    }
    if (value && typeof value === 'object' && !(value instanceof LosslessNumber))
      Object.values(value).forEach(validate);
  }
  validate(result);
  return result;
}
