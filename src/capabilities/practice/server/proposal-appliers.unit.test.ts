// ADR-0032 D6-B (YUK-203 lane L6) — pure-function unit cover for the
// question_edit mini verify gate (applyQuestionEdit). No DB: applyQuestionEdit is
// IO-free, so this runs in the fast (no-DB) car. The acceptQuestionEditProposal
// integration paths (version conflict, set_node_kind, 404/409/422 status codes)
// live in proposal-appliers.db.test.ts; this file locks the gate branches that
// the 4 narrow ops can NOT naturally reach from a valid tree — specifically
// `invalid_structure` (gate part 3: the post-edit whole tree must still satisfy
// the recursive StructuredQuestion schema).

import { applyQuestionEdit } from '@/capabilities/practice/server/proposal-appliers';
import type { QuestionEditOpT } from '@/core/schema/proposal';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import { describe, expect, it } from 'vitest';

describe('applyQuestionEdit verify gate (pure)', () => {
  it('rejects with invalid_structure when the post-edit tree breaks the StructuredQuestion invariant', () => {
    // A structurally-INVALID input tree: a `sub` node illegally carries
    // sub_questions (the StructuredQuestion schema refines "only stem may have
    // sub_questions"). The 4 narrow ops can never PRODUCE this from a valid tree,
    // so we hand-construct it to drive the gate's part-3 re-parse. The op targets
    // the (valid-shaped) stem, but the whole-tree safeParse still fails because the
    // malformed `sub` node remains — proving the gate re-validates the ENTIRE tree,
    // not just the edited node, and refuses to persist a corrupt invariant.
    const malformed: StructuredQuestionT = {
      id: 'n_stem',
      role: 'stem',
      prompt_text: '阅读下面文段，回答问题。',
      sub_questions: [
        {
          id: 'n_bad_sub',
          role: 'sub', // not a stem...
          prompt_text: '子题',
          // ...but illegally carries its own sub_questions → schema-invalid.
          sub_questions: [{ id: 'n_grand', role: 'sub', prompt_text: '孙题' }],
        },
      ],
    };
    // Sanity: confirm the precondition that the 4 ops can't otherwise reach — the
    // input tree is itself schema-invalid, so the gate's re-parse of the proposed
    // (edited) tree must fail.
    const edit: QuestionEditOpT = {
      op: 'edit_node_text',
      node_id: 'n_stem',
      prompt_text: '阅读下面文段（修订），回答问题。',
    };

    const result = applyQuestionEdit(malformed, edit, 'agent:copilot');
    expect('failure' in result).toBe(true);
    if (!('failure' in result)) throw new Error('unreachable');
    expect(result.failure).toBe('invalid_structure');
  });

  it('rejects node_not_found before the structure re-parse (target id absent)', () => {
    const tree: StructuredQuestionT = {
      id: 'n_stem',
      role: 'stem',
      prompt_text: '题面',
      sub_questions: [{ id: 'n_sub', role: 'sub', prompt_text: '子题' }],
    };
    const result = applyQuestionEdit(
      tree,
      { op: 'edit_node_text', node_id: 'n_missing', prompt_text: 'x' },
      'agent:copilot',
    );
    expect('failure' in result).toBe(true);
    if (!('failure' in result)) throw new Error('unreachable');
    expect(result.failure).toBe('node_not_found');
  });
});
