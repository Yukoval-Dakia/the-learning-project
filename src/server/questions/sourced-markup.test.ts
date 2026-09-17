import { describe, expect, it } from 'vitest';
import { sanitizeSourcedMarkup } from './sourced-markup';

// Real production fixture — question s6xkn5p91ekx54s9bdds2fty (2015·上海 高考,
// jyeoo web_sourced). Option B/C/D carry the MathJye markup family: fraction
// tables, image-sprite radicals, and a radical-nested-inside-denominator.
const JYEOO_SQRT = `<table cellspacing="-1" cellpadding="-1"><tr><td style="font-size: 0px"><div hassize="7"><div style="width:6px;background: url('http://img.jyeoo.net/images/formula/part/8730U.png') repeat-y; height: 1px;overflow: hidden" muststretch="v"></div><div style="width:6px;background: url('http://img.jyeoo.net/images/formula/part/8730D.png') no-repeat; height: 7px; overflow: hidden"></div></div></td><td style="padding:0;padding-left: 2px; border-top: 1px solid black;line-height:normal;padding-top:1px">CONTENT</td></tr></table>`;

const JYEOO_FRAC = (num: string, den: string) =>
  `<table cellpadding="-1" cellspacing="-1" style="margin-right:1px"><tr><td style="border-bottom:1px solid black;padding-bottom:1px;font-size:90%">${num}</td></tr><tr><td style="padding-top:1px;font-size:90%">${den}</td></tr></table>`;

describe('sanitizeSourcedMarkup', () => {
  it('passes plain markdown through byte-identical', () => {
    const clean = '已知 $a>0$，求 $\\frac{a+b}{2}$ 的最小值。\n\n解析：直接套公式。';
    expect(sanitizeSourcedMarkup(clean)).toBe(clean);
  });

  it('converts a MathJye radical table to $\\sqrt{…}$ without img.jyeoo.net residue', () => {
    const option = `B．<span dealflag="1" class="MathJye" mathtag="math" style="whiteSpace:nowrap">${JYEOO_SQRT.replace('CONTENT', 'ab')}</span>有最小值`;
    const out = sanitizeSourcedMarkup(option);
    expect(out).toBe('B．$\\sqrt{ab}$有最小值');
    expect(out).not.toContain('img.jyeoo.net');
    expect(out).not.toContain('<');
  });

  it('converts MathJye fraction tables to $\\frac{…}{…}$', () => {
    const option = `C．<span class="MathJye" mathtag="math">${JYEOO_FRAC('1', 'a')}+${JYEOO_FRAC('1', 'b')}</span>有最大值`;
    expect(sanitizeSourcedMarkup(option)).toBe('C．$\\frac{1}{a}+\\frac{1}{b}$有最大值');
  });

  it('handles a radical nested inside a fraction denominator (prod option D)', () => {
    const den = `${JYEOO_SQRT.replace('CONTENT', 'a')}+${JYEOO_SQRT.replace('CONTENT', 'b')}`;
    const option = `D．<span dealflag="1" class="MathJye">${JYEOO_FRAC('1', den)}</span>有最大值`;
    expect(sanitizeSourcedMarkup(option)).toBe('D．$\\frac{1}{\\sqrt{a}+\\sqrt{b}}$有最大值');
  });

  it('converts <sup>/<sub> to unicode script with ^{x}/_{x} fallback', () => {
    expect(sanitizeSourcedMarkup('A．a<sup>2</sup>+b<sup>2</sup>有最小值')).toBe(
      'A．a²+b²有最小值',
    );
    expect(sanitizeSourcedMarkup('x<sub>n+1</sub>')).toBe('xₙ₊₁');
    expect(sanitizeSourcedMarkup('x<sub>月</sub>')).toBe('x_{月}');
    expect(sanitizeSourcedMarkup('2<sup>n</sup>')).toBe('2ⁿ');
  });

  it('keeps textual table content when it is not a fraction/radical shape', () => {
    const table = '<table><tr><td>仅</td><td>①</td></tr><tr><td>②</td><td>③</td></tr></table>';
    expect(sanitizeSourcedMarkup(table)).toBe('仅①②③');
  });

  it('decodes HTML entities and drops script/style content', () => {
    expect(sanitizeSourcedMarkup('a&lt;b&nbsp;&amp;&nbsp;c&gt;d')).toBe('a<b & c>d');
    expect(sanitizeSourcedMarkup('x<script>alert(1)</script>y')).toBe('xy');
  });

  it('is idempotent over already-sanitized output', () => {
    const once = sanitizeSourcedMarkup(
      `D．<span class="MathJye">${JYEOO_FRAC('1', JYEOO_SQRT.replace('CONTENT', 'a'))}</span>`,
    );
    expect(sanitizeSourcedMarkup(once)).toBe(once);
  });
});
