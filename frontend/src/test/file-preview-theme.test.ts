import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('uses the catalog dark separator token throughout the preview', () => {
  const css = readFileSync('src/FilePreview.css', 'utf8');
  expect(css).not.toContain('var(--border, #cbd5e1)');
  expect(css).toMatch(/border-bottom:\s*1px solid var\(--line/);
  expect(css).toMatch(/border-top:\s*1px solid var\(--line/);
});
