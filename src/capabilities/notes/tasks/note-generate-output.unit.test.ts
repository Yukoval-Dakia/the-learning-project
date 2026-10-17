import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNoteGenerateOutput } from './note-tasks';

const note = readFileSync(new URL('./fixtures/yuk-981-conic-note.txt', import.meta.url), 'utf8');

function storedText(block: Record<string, unknown>): string {
  const attrs = block.attrs;
  if (!attrs || typeof attrs !== 'object') return '';
  const source = (attrs as { source_markdown?: unknown }).source_markdown;
  return typeof source === 'string' ? source : '';
}

describe('parseNoteGenerateOutput', () => {
  // @invariant data: a generated math note keeps the model's LaTeX commands and quotation marks in the stored body
  // @fails-if parseNoteGenerateOutput JSON.parses the model document, so a raw \sqrt is rejected or a legal \frac becomes a control character before the note is stored
  it('stores LaTeX from a note document that JSON.parse cannot read', () => {
    expect(() => JSON.parse(note)).toThrow();
    const broken = '{"text":"$\\sqrt{a^2-b^2}$"}';
    expect(() => JSON.parse(broken)).toThrow(/position|Bad escaped/);
    expect(() => parseNoteGenerateOutput(broken, 'note_atomic')).toThrow(/NOTE v1/);

    const parsed = parseNoteGenerateOutput(note, 'note_atomic');
    const stored = parsed.body_blocks.content.map((block) => storedText(block)).join('\n');
    expect(stored).toContain('$\\sqrt{a^2-b^2}$');
    expect(stored).toContain('\\frac{x^2}{a^2}');
    expect(stored).toContain('"距离之和为 $a$"');
    expect(parsed.sections_count).toBe(5);
    expect(parsed.body_blocks.content.map((block) => storedText(block).length > 0)).not.toContain(
      false,
    );
  });

  // @invariant security: compiling a note cannot stall the worker on an unclosed formula
  // @fails-if the inline-math matcher retries every split of a backslash run, so a few dozen backslashes block the event loop
  it('returns within milliseconds for an unclosed formula with hundreds of backslashes', () => {
    const line = `$$\\begin{aligned}${'\\'.repeat(400)}`;
    const inline = `$\\sqrt{${'\\'.repeat(400)}`;
    const text = `NOTE v1
@type note_atomic

@definition
d

@mechanism
m

@example
e

@pitfall
p

@check
${line}
\\end{aligned}
$$
${inline}
@end
`;
    const started = performance.now();
    const parsed = parseNoteGenerateOutput(text, 'note_atomic', 'end_turn');
    expect(performance.now() - started).toBeLessThan(100);
    expect(parsed.blocks_count).toBeGreaterThan(0);
  }, 1_000);

  // @invariant data: a truncated generation is not stored as a finished atomic or long note
  // @fails-if a note cut off before @end, or stopped for max_tokens or length, is accepted
  it('rejects a truncated atomic note and a truncated long note', () => {
    const atomicCut = `NOTE v1
@type note_atomic

@definition
椭圆定义 $c=\\sqrt{a^2-b^2}$。

@mechanism
机制

@example
例子

@pitfall
易错

@check
若 $e=\\frac{\\sqrt{3}}{2}$`;
    const longDone = `NOTE v1
@type note_long

@body
离心率 $e=\\sqrt{1-\\frac{b^2}{a^2}}$。

$$
\\begin{aligned}
e &= \\sqrt{1-\\frac{b^2}{a^2}}
\\end{aligned}
$$
@end
`;
    expect(() => parseNoteGenerateOutput(atomicCut, 'note_atomic', 'end_turn')).toThrow(/@end/);
    expect(() =>
      parseNoteGenerateOutput(longDone.replace('@end\n', ''), 'note_long', 'end_turn'),
    ).toThrow(/@end/);
    expect(() => parseNoteGenerateOutput(atomicCut, 'note_atomic', 'max_tokens')).toThrow(
      /max_tokens/,
    );
    expect(() => parseNoteGenerateOutput(longDone, 'note_long', 'length')).toThrow(/length/);
    expect(parseNoteGenerateOutput(longDone, 'note_long', 'end_turn').blocks_count).toBeGreaterThan(
      0,
    );
  });
});
