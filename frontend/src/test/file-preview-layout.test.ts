import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('keeps the portal scrollable and sized to the dynamic viewport on mobile, with keyboard focus and reduced motion', () => {
  const css = readFileSync(`${process.cwd()}/src/FilePreview.css`, 'utf8');
  expect(css).toMatch(/100dvh/);
  expect(css).toMatch(/max-width:/);
  expect(css).toMatch(/@media\s*\(max-width: 600px\)/);
  expect(css).toMatch(/min-height:\s*0/);
  expect(css).toMatch(/overflow:\s*auto/);
  expect(css).toMatch(/overscroll-behavior:\s*contain/);
  expect(css).toMatch(/:focus-visible/);
  expect(css).toMatch(/prefers-reduced-motion/);
  expect(css).toMatch(/color:\s*#e2e7ef/);
  expect(css).toMatch(/background:\s*var\(--surface,\s*#171f2b\)/);
  expect(css).toMatch(/border:[^;]*var\(--line,/);
});
