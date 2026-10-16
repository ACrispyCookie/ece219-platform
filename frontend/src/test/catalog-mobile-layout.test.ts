import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('keeps a mobile expanded submission in one column rather than wrapping a full-height inventory sideways', () => {
  const css = readFileSync('src/styles.css', 'utf8');
  expect(css).toMatch(/\.version\s*\{[^}]*flex-direction:\s*column;[^}]*flex-wrap:\s*nowrap;/s);
  expect(css).toMatch(/\.version-inventory\s*\{[^}]*flex-basis:\s*auto;[^}]*width:\s*100%;/s);
});
