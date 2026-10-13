import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';

const element = document.createElement('style');
const rules: { rule: CSSStyleRule; media: string }[] = [];
beforeAll(() => {
  element.textContent = readFileSync('src/styles.css', 'utf8');
  document.head.append(element);
  function collect(list: CSSRuleList, media = '') {
    for (const rule of Array.from(list)) {
      if (rule.type === CSSRule.STYLE_RULE) rules.push({ rule: rule as CSSStyleRule, media });
      if (rule.type === CSSRule.MEDIA_RULE)
        collect((rule as CSSMediaRule).cssRules, (rule as CSSMediaRule).conditionText);
    }
  }
  collect(element.sheet!.cssRules);
});
afterAll(() => element.remove());
function value(selector: string, property: string, media = '') {
  const match = [...rules].reverse().find(
    ({ rule, media: m }) =>
      m === media &&
      rule.style.getPropertyValue(property) !== '' &&
      rule.selectorText
        .split(',')
        .map((s) => s.trim())
        .includes(selector),
  );
  return match?.rule.style.getPropertyValue(property) || '';
}
it('scopes a compact dismissal header without losing notice spacing or introducing motion', () => {
  expect(value('.removal-notice-heading', 'display')).toBe('flex');
  expect(value('.removal-notice-heading', 'align-items')).toBe('flex-start');
  expect(value('.removal-notice-heading', 'gap')).toBe('12px');
  expect(value('.removal-notice-heading', 'margin-bottom')).toBe('8px');
  expect(Number.parseFloat(value('.removal-notice-heading h3', 'margin')!)).toBe(0);
  expect(Number.parseFloat(value('.removal-notice-heading:last-child', 'margin-bottom')!)).toBe(0);
  expect(value('.removal-notice .notice-dismiss', 'flex-shrink')).toBe('0');
  expect(value('.removal-notice .notice-dismiss', 'flex-grow')).toBe('0');
  expect(value('.removal-notice .notice-dismiss', 'min-width')).toBe('32px');
  for (const selector of ['.removal-notice-heading', '.removal-notice .notice-dismiss']) {
    expect(value(selector, 'animation')).toBe('');
    expect(value(selector, 'transition')).toBe('');
  }
});
it('keeps compact action groups right-aligned and wrapping without motion or width overflow', () => {
  expect(value('.lab-heading', 'grid-template-columns')).toBe('minmax(0, 1fr) auto');
  expect(value('.item-actions', 'justify-content')).toBe('flex-end');
  expect(value('.item-actions', 'flex-wrap')).toBe('wrap');
  expect(Number.parseFloat(value('.item-actions', 'min-width'))).toBe(0);
  expect(value('.compact-delete', 'min-height')).toBe('32px');
  expect(value('.compact-delete', 'background')).toBe('transparent');
  expect(value('.compact-delete:hover', 'color')).toBe('rgb(240, 176, 184)');
  expect(value('.compact-delete', 'animation')).toBe('');
  expect(value('.uploads-list li', 'flex-wrap')).toBe('wrap');
  expect(value('.upload-info', 'overflow-wrap')).toBe('anywhere');
  expect(value('.lab-heading', 'grid-template-columns', '(max-width: 1050px)')).toBe(
    'minmax(0, 1fr)',
  );
});
it('uses real theme borders and keeps ZIP item actions compact on a 390px mobile breakpoint', () => {
  expect(value('.compact-delete', 'border-color')).toBe('var(--line)');
  expect(value('.version .item-actions', 'margin')).toBe('0px');
  expect(Number.parseFloat(value('.version > div:first-child', 'min-width'))).toBe(0);
  expect(value('.version .item-actions', 'width', '(max-width: 700px)')).toBe('100%');
  expect(value('.version .item-actions button', 'width', '(max-width: 700px)')).toBe('auto');
});
