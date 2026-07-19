import { embedHash, questionEmbedText } from '@/server/ai/embed-source';
import { describe, expect, it } from 'vitest';
import { canonicalQuestionContentHash } from './content-fingerprint';

const base = {
  promptMd: '**求解**：  2 + 2 = ?',
  referenceMd: '4',
  choicesMd: ['3', '4', '5'],
};

describe('canonical question content fingerprint', () => {
  it('normalizes Unicode/whitespace and equivalent emphasis Markdown', () => {
    expect(canonicalQuestionContentHash(base)).toBe(
      canonicalQuestionContentHash({
        ...base,
        promptMd: '__求解__：\r\n2   +  2 = ?  ',
      }),
    );
  });

  it('ignores Markdown image URL churn while preserving the image semantic slot', () => {
    const a = canonicalQuestionContentHash({
      ...base,
      promptMd: `${base.promptMd}\n![triangle](https://cdn-a.example/a.png?ts=1)`,
    });
    const b = canonicalQuestionContentHash({
      ...base,
      promptMd: `${base.promptMd}\n![triangle](https://cdn-b.example/b.png?ts=999)`,
    });
    expect(a).toBe(b);
    expect(a).not.toBe(
      canonicalQuestionContentHash({ ...base, promptMd: `${base.promptMd}\n![circle](URL)` }),
    );
  });

  it('treats choice ordering and changed answers as identity changes', () => {
    expect(canonicalQuestionContentHash(base)).not.toBe(
      canonicalQuestionContentHash({ ...base, choicesMd: ['4', '3', '5'] }),
    );
    expect(canonicalQuestionContentHash(base)).not.toBe(
      canonicalQuestionContentHash({ ...base, referenceMd: '四' }),
    );
  });

  it('does not fold source URLs/timestamps and is explicitly distinct from embed_content_hash', () => {
    const withUnstableEnvelope = {
      ...base,
      sourceUrl: 'https://source.example/v1',
      fetchedAt: '2026-07-19T00:00:00Z',
    };
    expect(canonicalQuestionContentHash(withUnstableEnvelope)).toBe(
      canonicalQuestionContentHash({
        ...withUnstableEnvelope,
        sourceUrl: 'https://source.example/v2',
        fetchedAt: '2027-01-01T00:00:00Z',
      }),
    );
    expect(canonicalQuestionContentHash(base)).not.toBe(
      embedHash(
        questionEmbedText({
          prompt_md: base.promptMd,
          reference_md: base.referenceMd,
          choices_md: base.choicesMd,
        }),
      ),
    );
  });
});
