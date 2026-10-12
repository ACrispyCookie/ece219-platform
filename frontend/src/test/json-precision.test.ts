import { expect, it } from 'vitest';
import { api, json } from '../api';
import { sameRecord } from '../verification';
import { parseJSON, parseResultJSON, stringifyJSON } from '../resultJSON';

it.each([
  'null',
  'true',
  '"literal"',
  '42',
  '9007199254740993',
  '[9007199254740993]',
  '{"n":9007199254740993}',
])('keeps own __proto__ with literal value %s', (literal) => {
  const raw = `{"__proto__":${literal}}`;
  expect(stringifyJSON(parseJSON(raw))).toBe(raw);
});
it('preserves arbitrary-size integer tokens beyond even binary64 finite range', () => {
  const integer = '1' + '0'.repeat(400);
  expect(stringifyJSON(parseResultJSON(`{"n":${integer},"__proto__":${integer}}`))).toBe(
    `{"n":${integer},"__proto__":${integer}}`,
  );
});
it.each(['1e400', '1e-400', '0.1234567890123456789', '9007199254740993.0', '9007199254740993e0'])(
  'rejects unsupported float precision %s',
  (token) => {
    expect(() => parseResultJSON(`{"n":${token}}`)).toThrow();
  },
);
it('keeps ordinary decimal controls numeric and precise decimal strings literal', () => {
  expect(
    parseResultJSON('{"revision":2,"fraction":0.5,"decimal":"0.1234567890123456789"}'),
  ).toEqual({ revision: 2, fraction: 0.5, decimal: '0.1234567890123456789' });
});
it('preserves literal __proto__ JSON keys without changing object prototypes', () => {
  const raw = '{"__proto__":{"polluted":true},"n":9007199254740993}';
  const value = parseJSON(raw);
  expect(stringifyJSON(value)).toBe(raw);
  expect(Object.hasOwn(value as object, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(value as object)).toBe(Object.prototype);
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
});
it('preserves literal result object keys that resemble lossless-json type markers', () => {
  const raw =
    '{"nested":{"isLosslessNumber":true,"value":"9007199254740993","toString":"literal"},"n":9007199254740993}';
  expect(stringifyJSON(parseJSON(raw))).toBe(raw);
  expect(stringifyJSON(parseResultJSON(raw))).toBe(raw);
});
it('verification distinguishes an exact number from a literal lookalike object', () => {
  const n = parseJSON('9007199254740993');
  expect(sameRecord(n, { isLosslessNumber: true, value: '9007199254740993' })).toBe(false);
});

it('round-trips unsafe incoming JSON integers while ordinary control numbers stay numbers', async () => {
  const { vi } = await import('vitest');
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        '{"revision":2,"total":1,"data":{"n":9007199254740993,"minus":-9007199254740993,"decimal":0.5}}',
      ),
  );
  const value = await api<any>('/synthetic');
  expect(value.revision).toBe(2);
  expect(value.total).toBe(1);
  expect(value.data.decimal).toBe(0.5);
  expect(json('PATCH', value).body).toBe(
    '{"revision":2,"total":1,"data":{"n":9007199254740993,"minus":-9007199254740993,"decimal":0.5}}',
  );
  vi.unstubAllGlobals();
});
it('record verification never confuses an inherited key with an own value', () => {
  expect(sameRecord({ constructor: Object }, { other: 1 })).toBe(false);
});
