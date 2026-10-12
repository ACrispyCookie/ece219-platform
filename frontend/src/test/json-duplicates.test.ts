import { expect, it } from 'vitest';
import { parseJSON, parseResultJSON, stringifyJSON } from '../resultJSON';

const duplicates = [
  '{"__proto__":9007199254740993,"__proto__":42}',
  '{"__proto__":42,"__proto__":42}',
  '{"a":1,"a":1,"b":2,"b":2}',
  '{"a":{"n":1},"a":{"n":1}}',
  '{"a":null,"a":null}',
  String.raw`{"__proto__":1,"__p\u0072oto__":1}`,
  String.raw`{"nested":[{"a":1,"\u0061":1}]}`,
  String.raw`{"nested":[{"a\"b":1,"a\u0022b":1}]}`,
  String.raw`{"a\\b":1,"a\u005cb":1}`,
  String.raw`{"😀":1,"\ud83d\ude00":1}`,
  '{"constructor":1,"constructor":1}',
  '{"toString":true,"toString":true}',
];
it.each(duplicates)('rejects decoded duplicate keys before shared parsing: %s', (raw) => {
  expect(() => parseJSON(raw)).toThrow(/Duplicate key/);
});
it.each(duplicates)('rejects ambiguous result drafts: %s', (raw) => {
  expect(() => parseResultJSON(raw)).toThrow(/διπλά κλειδιά/);
});
it('keeps identical keys in separate objects, literal markers and exact integers', () => {
  const raw = '{"items":[{"a":9007199254740993},{"a":9007199254740993}],"__proto__":{"constructor":{"toString":"literal"}},"marker":{"isLosslessNumber":true,"value":"9007199254740993"}}';
  expect(stringifyJSON(parseResultJSON(raw))).toBe(raw);
  const value = parseJSON(raw) as object;
  expect(Object.hasOwn(value, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
});
it('does not normalize distinct Unicode keys or interpret duplicate-looking string content', () => {
  const raw = String.raw`{"é":1,"e\u0301":2,"text":"{\"a\":1,\"a\":1}","source":"9007199254740993","escaped":"quote: \" slash: \\ emoji: \ud83d\ude00"}`;
  expect(parseResultJSON(raw)).toEqual(JSON.parse(raw));
  expect((parseResultJSON(raw) as Record<string, unknown>).source).toBe('9007199254740993');
});
it.each(['null', 'true', 'false', '42', '-42', '0.5', '1e2', '"a"', '[]', '{}', ' \r\n\t {"a": [null, true, false, -1.5e+2]} \n'])(
  'accepts valid JSON syntax without changing values: %s', (raw) => {
    expect(parseResultJSON(raw)).toEqual(JSON.parse(raw));
  },
);
it.each(['', '{', '{"a":1,}', '[1,]', '{"a" 1}', '{a:1}', '{"a":}', '01', '1.', '-.1', '1e', 'true false', String.raw`{"a":"\x00"}`, String.raw`{"a":"\u123"}`, '"unterminated', '"literal\nnewline"', '\u00a0{}'])(
  'rejects invalid syntax with visible validation: %s', (raw) => {
    expect(() => parseResultJSON(raw)).toThrow(/έγκυρο JSON/);
  },
);
it('bounds nesting before downstream recursive parsers without capping integer tokens', () => {
  const integer = '1' + '0'.repeat(400);
  const atLimit = '['.repeat(64) + integer + ']'.repeat(64);
  expect(stringifyJSON(parseResultJSON(atLimit))).toBe(atLimit);
  const tooDeep = '['.repeat(65) + '0' + ']'.repeat(65);
  expect(() => parseJSON(tooDeep)).toThrow(/depth/i);
  expect(() => parseResultJSON('['.repeat(10000) + '0' + ']'.repeat(10000))).toThrow(/έγκυρο JSON/);
});
