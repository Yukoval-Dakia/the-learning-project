// Token checks (T5, T9, A3, I4): contrast of every text/background pair in both themes, glass
// against the worst content behind it, and that nothing escapes the [data-ui-next] scope.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(process.cwd(), 'src/ui-next');
const tokensCss = readFileSync(join(dir, 'tokens.css'), 'utf8');
const componentsCss = readFileSync(join(dir, 'components.css'), 'utf8');

function block(css: string, selectorStart: string): Record<string, string> {
  const at = css.indexOf(selectorStart);
  if (at < 0) throw new Error(`missing block ${selectorStart}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const vars: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--un-[\w-]+):\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

const light = block(tokensCss, '[data-ui-next] {');
const darkExplicit = block(tokensCss, ':root[data-theme="dark"] [data-ui-next]');
const darkSystem = block(tokensCss, ':root:not([data-theme]) [data-ui-next]');
const dark = { ...light, ...darkExplicit };

type Rgb = [number, number, number];
function hex(value: string): Rgb {
  const h = value.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
}
const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  [0, 1, 2].map((i) => a[i] * t + b[i] * (1 - t)) as Rgb;

const SURFACES = ['--un-bg', '--un-bg-raised', '--un-bg-sunk', '--un-bg-hover'];
const TEXT = ['--un-text-1', '--un-text-2', '--un-text-3', '--un-text-4'];
const STATUS = ['--un-accent-strong', '--un-positive', '--un-caution', '--un-critical'];
const ON_SOFT: [string, string][] = [
  ['--un-positive', '--un-positive-soft'],
  ['--un-caution', '--un-caution-soft'],
  ['--un-critical', '--un-critical-soft'],
  ['--un-accent-ink', '--un-accent-soft'],
  ['--un-text-on-accent', '--un-accent-strong'],
];

describe.each([
  ['light', light, dark['--un-text-1']],
  ['dark', dark, light['--un-text-1']],
])('%s theme', (_name, t, oppositeInk) => {
  const c = (fg: string, bg: string) => contrast(hex(t[fg]), hex(t[bg]));

  it('keeps every text and status colour at 4.5:1 on every surface (T5, A3)', () => {
    for (const fg of [...TEXT, ...STATUS]) {
      for (const bg of SURFACES) expect(c(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps status colours readable on their own soft fills (A3)', () => {
    for (const [fg, bg] of ON_SOFT) expect(c(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the focus ring at 3:1 against the page (T5)', () => {
    expect(c('--un-accent-strong', '--un-bg')).toBeGreaterThanOrEqual(3);
  });

  it('keeps secondary text on glass at 4.5:1 over the worst content behind it (A3)', () => {
    const alpha = Number.parseFloat(light['--un-glass-alpha']) / 100;
    const glass = mix(hex(t['--un-bg-raised']), hex(oppositeInk), alpha);
    for (const fg of ['--un-text-1', '--un-text-2', '--un-text-3']) {
      expect(contrast(hex(t[fg]), glass), `${fg} on glass`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('token hygiene', () => {
  it('defines the system-dark theme exactly like the explicit dark theme', () => {
    expect(darkSystem).toEqual(darkExplicit);
  });

  it('prefixes every custom property so none lands in a Tailwind theme namespace (T9)', () => {
    for (const css of [tokensCss, componentsCss]) {
      const names = [...css.matchAll(/(?<![\w-])(--[\w-]+)\s*:/g)].map((m) => m[1]);
      expect(names.filter((n) => !n.startsWith('--un-'))).toEqual([]);
    }
  });

  it('never styles the root, the body or anything outside [data-ui-next] (I4)', () => {
    for (const css of [tokensCss, componentsCss]) {
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const selectors = [...withoutComments.matchAll(/(^|[{}])\s*([^{}@;]+?)\s*\{/g)]
        .map((m) => m[2].trim())
        .filter((s) => !/^(from|to|\d+%)/.test(s) && !s.startsWith('&'));
      for (const selector of selectors) {
        expect(selector, selector).toMatch(/\[data-ui-next\]/);
      }
      expect(withoutComments).not.toMatch(/@layer|@import|url\(|https?:/);
    }
  });
});
