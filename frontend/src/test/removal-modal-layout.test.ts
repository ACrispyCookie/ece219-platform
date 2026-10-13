import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('bounds mobile dialog, wraps titles/counts, provides scrim and respects reduced motion', () => {
  const css = readFileSync('src/styles.css', 'utf8');
  expect(css).toMatch(/\.removal-dialog\s*\{[^}]*max-height:\s*calc\(100dvh - 32px\)/s);
  expect(css).toMatch(/\.removal-dialog\s*\{[^}]*overflow-y:\s*auto/s);
  expect(css).toMatch(/\.removal-dialog::backdrop\s*\{[^}]*backdrop-filter:\s*blur/s);
  expect(css).toMatch(/\.removal-dialog-target\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  expect(css).toMatch(
    /\.removal-dialog-counts\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 150px\), 1fr\)\)/s,
  );
  expect(css).toMatch(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.removal-dialog\s*\{\s*animation:\s*none/s,
  );
});
