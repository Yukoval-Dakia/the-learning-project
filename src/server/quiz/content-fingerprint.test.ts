import { embedHash, questionEmbedText } from '@/server/ai/embed-source';
import { describe, expect, it } from 'vitest';
import {
  canonicalQuestionContentHash,
  combineExactDuplicateKnowledgeIds,
} from './content-fingerprint';

describe('combineExactDuplicateKnowledgeIds', () => {
  it('keeps the supply target first and preserves additional model attribution order', () => {
    expect(combineExactDuplicateKnowledgeIds(['k-model', 'k-extra'], ['k-target'])).toEqual([
      'k-target',
      'k-model',
      'k-extra',
    ]);
    expect(combineExactDuplicateKnowledgeIds(['k-target', 'k-extra'], ['k-target'])).toEqual([
      'k-target',
      'k-extra',
    ]);
  });
});

const base = {
  promptMd: '**求解**：  2 + 2 = ?',
  referenceMd: '4',
  choicesMd: ['3', '4', '5'],
};

describe('canonical question content fingerprint', () => {
  it('normalizes Unicode and whitespace (NFKC + collapse), keeping emphasis spelling', () => {
    // Same emphasis spelling on both sides; only line-ending / whitespace / NFKC differ.
    expect(canonicalQuestionContentHash(base)).toBe(
      canonicalQuestionContentHash({
        ...base,
        promptMd: '**求解**：\r\n2   +  2 = ?  ',
      }),
    );
  });

  it('no longer folds underscore emphasis into asterisk emphasis (LaTeX-subscript safety)', () => {
    // Underscore-emphasis canonicalization was removed so LaTeX subscripts survive; as a consequence
    // `_x_` / `__x__` are now distinct from `*x*` / `**x**` at the identity layer.
    expect(canonicalQuestionContentHash({ ...base, promptMd: '_求解_ 2+2' })).not.toBe(
      canonicalQuestionContentHash({ ...base, promptMd: '*求解* 2+2' }),
    );
    expect(canonicalQuestionContentHash({ ...base, promptMd: '__求解__ 2+2' })).not.toBe(
      canonicalQuestionContentHash({ ...base, promptMd: '**求解** 2+2' }),
    );
  });

  it('preserves LaTeX subscripts and never collides them with emphasis', () => {
    // (a) A genuine subscript must not hash the same as its asterisk-emphasis look-alike.
    expect(canonicalQuestionContentHash({ ...base, referenceMd: '$x_1 = 2$' })).not.toBe(
      canonicalQuestionContentHash({ ...base, referenceMd: '$x*1 = 2*$' }),
    );
    // (b) Distinct subscripts (x_1 vs x_2) are distinct identities.
    expect(canonicalQuestionContentHash({ ...base, referenceMd: '$x_1 = 2$' })).not.toBe(
      canonicalQuestionContentHash({ ...base, referenceMd: '$x_2 = 2$' }),
    );
    // Regression for the exact few-shot answer: the `_1 = 2$，$x_` span was previously rewritten to
    // `*1 = 2$，$x*`, colliding the subscript form with the asterisk form. They must now differ.
    expect(canonicalQuestionContentHash({ ...base, referenceMd: '$x_1 = 2$，$x_2 = 3$' })).not.toBe(
      canonicalQuestionContentHash({ ...base, referenceMd: '$x*1 = 2$，$x*2 = 3$' }),
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
    // Re-pinned in review round 4 when underscore-emphasis folding was removed (no deployed hashes
    // existed, so re-pinning without a version bump is safe); __求解__ now stays verbatim.
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
      'a611df1a5ab92c685ba64b2e2fb0b6b227904cc1f7ed12ea1bab195a9d495763',
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
