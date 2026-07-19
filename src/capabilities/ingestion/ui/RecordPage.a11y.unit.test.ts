// YUK-718 — RecordPage's manual form used <span class="field-label"> visual labels
// with no programmatic association. The single-control fields now use real
// <label htmlFor> (mirror EventDetailPage / DraftReviewPage); the knowledge search
// box (whose label names a chip GROUP) carries a per-control aria-label. Rendering
// the page pulls in TanStack Query + apiJson wiring, so we assert the label⇄id
// pairing at the source level.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('RecordPage field labels (YUK-718)', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/capabilities/ingestion/ui/RecordPage.tsx'),
    'utf8',
  );

  it.each([['record-prompt-md'], ['record-reference-md'], ['record-wrong-answer-md']])(
    'associates a <label htmlFor> with the control id %s',
    (id) => {
      expect(source).toContain(`htmlFor="${id}"`);
      expect(source).toContain(`id="${id}"`);
    },
  );

  it('marks both required (必填) inputs with aria-required', () => {
    // 题面 textarea + 错答 input each carry aria-required right after their id.
    expect(source).toMatch(/id="record-prompt-md"\s+aria-required/);
    expect(source).toMatch(/id="record-wrong-answer-md"\s+aria-required/);
  });

  it('names the knowledge search box with its min-1 requirement + live count', () => {
    expect(source).toContain(
      'aria-label={`知识点搜索（至少 1 个，已选 ${selectedKnowledge.length}）`}',
    );
  });
});
