import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Structural policy checks complement browser verification of computed styles.
const css = readFileSync('src/styles.css', 'utf8');
const sheetElement = document.createElement('style');
type Rule = { rule: CSSStyleRule; media: string[] };
let rules: Rule[];
let keyframes: CSSKeyframesRule[];

beforeAll(() => {
  sheetElement.textContent = css;
  document.head.append(sheetElement);
  rules = [];
  keyframes = [];
  const collect = (list: CSSRuleList, media: string[] = []) => {
    for (const rule of Array.from(list)) {
      if (rule.type === CSSRule.STYLE_RULE) rules.push({ rule: rule as CSSStyleRule, media });
      else if (rule.type === CSSRule.MEDIA_RULE) {
        const group = rule as CSSMediaRule;
        collect(group.cssRules, [...media, group.conditionText]);
      } else if (rule.type === CSSRule.KEYFRAMES_RULE) keyframes.push(rule as CSSKeyframesRule);
    }
  };
  collect(sheetElement.sheet!.cssRules);
});
afterAll(() => sheetElement.remove());

const value = (rule: CSSStyleRule, property: string) => rule.style.getPropertyValue(property);
const selectors = (rule: CSSStyleRule) => rule.selectorText.split(',').map((s) => s.trim());
const timings = (text: string) =>
  [...text.matchAll(/([\d.]+)(ms|s)\b/g)].map((m) => Number(m[1]) * (m[2] === 's' ? 1000 : 1));
const transitionsFor = (selector: string) =>
  rules
    .filter(({ rule, media }) => media.length === 0 && selectors(rule).includes(selector))
    .map(({ rule }) => value(rule, 'transition'))
    .filter(Boolean)
    .join(' ');

function checkSmallTranslation(transform: string) {
  if (transform === 'none') return;
  expect(transform).toMatch(/^translateY\(-?[\d.]+px\)$/);
  expect(Math.abs(Number(transform.match(/-?[\d.]+/)![0]))).toBeLessThanOrEqual(6);
}

describe('restrained catalog motion policy', () => {
  it('gives mounted content, forms, card collections and notices a short single entrance', () => {
    const entrances = rules.filter(
      ({ rule }) =>
        /\b(?!none\b)\w+\s+[\d.]+m?s\b/.test(value(rule, 'animation')) &&
        !selectors(rule).includes('.loading:before'),
    );
    const targets = entrances.flatMap(({ rule }) => selectors(rule));
    for (const selector of [
      '.content',
      '.panel',
      '.cards',
      '.evidence-list',
      '.login-card',
      '.notice',
      '.success',
    ]) {
      expect(targets, `${selector} should have an entrance`).toContain(selector);
    }
    for (const { rule } of entrances) {
      const animation = value(rule, 'animation');
      expect(animation).not.toMatch(/infinite|alternate|forwards|both/);
      expect(timings(animation).length).toBeGreaterThan(0);
      for (const time of timings(animation)) expect(time).toBeLessThanOrEqual(220);
      // Animate the collection, never hundreds of rows or individual cards.
      for (const selector of selectors(rule))
        expect(selector).not.toMatch(/\btr\b|\btd\b|\bli\b|\.resource-card|\.version\b/);
    }
  });

  it('smooths controls using only short, explicit visual-property transitions', () => {
    for (const selector of ['button', '.button', 'a', 'input', 'select', 'textarea']) {
      const transition = transitionsFor(selector);
      expect(transition, `${selector} should transition`).not.toBe('');
      expect(transition).not.toMatch(/\ball\b|width|height|padding|margin/);
      expect(timings(transition).length).toBeGreaterThan(0);
      for (const time of timings(transition)) expect(time).toBeLessThanOrEqual(220);
    }
    expect(transitionsFor('button')).toContain('background-color');
    expect(transitionsFor('button')).toContain('border-color');
    expect(transitionsFor('a')).toContain('color');
    expect(transitionsFor('input')).toContain('border-color');
  });

  it('retains immediate keyboard focus rings with a subtle field-border response', () => {
    const focusRules = rules.filter(({ rule }) => selectors(rule).includes('input:focus-visible'));
    expect(focusRules.some(({ rule }) => value(rule, 'outline'))).toBe(true);
    expect(focusRules.some(({ rule }) => value(rule, 'border-color'))).toBe(true);
    expect(transitionsFor('input')).not.toContain('outline');
  });

  it('limits hover translation to fine hover pointers, enabled controls and normal motion', () => {
    const hoverMotion = rules.filter(
      ({ rule }) => rule.selectorText.includes(':hover') && value(rule, 'transform'),
    );
    expect(hoverMotion.length).toBeGreaterThan(0);
    for (const { rule, media } of hoverMotion) {
      expect(media.join(' ')).toContain('(hover: hover)');
      expect(media.join(' ')).toContain('(pointer: fine)');
      expect(media.join(' ')).toContain('(prefers-reduced-motion: no-preference)');
      checkSmallTranslation(value(rule, 'transform'));
      for (const selector of selectors(rule)) {
        if (selector.startsWith('button')) expect(selector).toContain(':not(:disabled)');
        expect(selector).toContain(":not([aria-disabled='true'])");
      }
    }
  });

  it('keeps entrance keyframes to opacity and at most six pixels, without transforming overlay ancestors', () => {
    const entranceFrames = keyframes.filter((rule) => rule.name !== 'spin');
    expect(entranceFrames.length).toBeGreaterThan(0);
    for (const animation of entranceFrames) {
      for (const frame of Array.from(animation.cssRules) as CSSKeyframeRule[]) {
        for (const property of Array.from(frame.style))
          expect(['opacity', 'transform']).toContain(property);
        const transform = frame.style.getPropertyValue('transform');
        if (transform) checkSmallTranslation(transform);
      }
    }
    for (const ancestor of ['.app-shell', '.content', '.login-page', '.auth-overlay']) {
      for (const { rule } of rules.filter(({ rule }) => selectors(rule).includes(ancestor))) {
        expect(value(rule, 'transform')).toBe('');
        const animation = value(rule, 'animation').split(/\s+/)[0];
        const frames = keyframes.find((frame) => frame.name === animation);
        if (frames) {
          for (const frame of Array.from(frames.cssRules) as CSSKeyframeRule[]) {
            expect(frame.style.getPropertyValue('transform')).toBe('');
          }
        }
      }
    }
    expect(css).not.toMatch(/will-change|animation-delay/);
  });

  it('keeps deletion notices separated and full-row without squeezing the lab heading', () => {
    const find = (selector: string) =>
      rules.find(({ rule, media }) => !media.length && selectors(rule).includes(selector))!.rule;
    expect(value(find('.removal-controls'), 'display')).toBe('contents');
    expect(parseFloat(value(find('.item-actions'), 'min-width'))).toBe(0);
    expect(value(find('.lab-heading'), 'grid-template-columns')).toBe('minmax(0, 1fr) auto');
    expect(value(find('.lab-heading .removal-controls'), 'display')).toBe('contents');
    expect(value(find('.lab-heading .removal-notice'), 'grid-column')).toBe('1 / -1');
    expect(value(find('.removal-controls .removal-notice'), 'max-width')).toBe('780px');
    expect(parseFloat(value(find('.removal-controls .removal-notice p'), 'margin'))).toBe(0);
    expect(value(find('.removal-controls .removal-notice'), 'white-space')).toBe('pre-wrap');
    expect(value(find('.uploads-list li'), 'flex-wrap')).toBe('wrap');
    expect(
      rules.some(
        ({ rule, media }) =>
          media.includes('(max-width: 1050px)') &&
          selectors(rule).includes('.lab-heading') &&
          value(rule, 'grid-template-columns') === 'minmax(0, 1fr)',
      ),
    ).toBe(true);
  });

  it('disables every animation and transition, including spinner pseudo-elements, for reduced motion', () => {
    const reducedRules = rules.filter(({ media }) =>
      media.includes('(prefers-reduced-motion: reduce)'),
    );
    for (const selector of ['*', '*::before', '*::after']) {
      const override = reducedRules.find(({ rule }) => selectors(rule).includes(selector));
      expect(override, `${selector} should honor reduced motion`).toBeDefined();
      expect(value(override!.rule, 'animation')).toBe('none');
      expect(value(override!.rule, 'transition')).toBe('none');
      expect(override!.rule.style.getPropertyPriority('animation')).toBe('important');
      expect(override!.rule.style.getPropertyPriority('transition')).toBe('important');
    }
    expect(rules.at(-1)!.media).toContain('(prefers-reduced-motion: reduce)');
  });
});
