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

  it('pins the canonical hash for a fixture (locale-independent key ordering)', () => {
    // Regression guard for hash determinism: this constant must not drift with the
    // host locale/ICU collation. Bump only alongside CANONICAL_QUESTION_CONTENT_VERSION.
    const fixture = {
      promptMd: '__求解__：\r\n2   +  2 = ?  ',
      referenceMd: '4',
      choicesMd: ['3', '4', '5'],
      rubricJson: {
        keywords: ['a_b_c'],
        criteria: [{ name: 'correctness', weight: 1, descriptor: '选对即满分' }],
        reference_solution: {
          final_answer: '1_000_000',
          expected_signals: ['x_1'],
          answer_equivalents: [],
        },
      },
    };
    expect(canonicalQuestionContentHash(fixture)).toBe(
      '9bedaa3c23781e74f04ee9e8526832a753612545c4dd863abac8b4af3eb3e229',
    );
  });

  it('canonicalizes rubric object key order without regard to insertion order', () => {
    const a = canonicalQuestionContentHash({
      ...base,
      rubricJson: { keywords: ['甲'], criteria: [{ name: 'c', weight: 1, descriptor: 'd' }] },
    });
    const b = canonicalQuestionContentHash({
      ...base,
      rubricJson: { criteria: [{ descriptor: 'd', weight: 1, name: 'c' }], keywords: ['甲'] },
    });
    expect(a).toBe(b);
  });

  it('does not run the Markdown pipeline over rubric string values (NFKC only)', () => {
    // Rubric carries exact-match tokens; underscores must survive as literals rather
    // than being rewritten to Markdown emphasis or having whitespace collapsed.
    expect(
      canonicalQuestionContentHash({ ...base, rubricJson: { final_answer: 'a_b_c' } }),
    ).not.toBe(canonicalQuestionContentHash({ ...base, rubricJson: { final_answer: 'a*b*c' } }));
    expect(canonicalQuestionContentHash({ ...base, rubricJson: { note: 'x    y' } })).not.toBe(
      canonicalQuestionContentHash({ ...base, rubricJson: { note: 'x y' } }),
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
