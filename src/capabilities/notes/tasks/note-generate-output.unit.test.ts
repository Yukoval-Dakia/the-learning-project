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
});
