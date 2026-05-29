import { describe, expect, it } from 'vitest';

import { noteBodyBlockContractFailure } from '@/server/boss/handlers/note_verify';

describe('note body block verifier contract', () => {
  it('returns a needs_review result when atomic notes miss required semantic kinds', () => {
    const bodyBlocks = {
      type: 'doc',
      content: [
        {
          type: 'semanticBlock',
          attrs: { id: 'def_1', semantic_kind: 'definition' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '定义' }] }],
        },
      ],
    };

    expect(noteBodyBlockContractFailure('note_atomic', bodyBlocks)).toMatchObject({
      verdict: 'needs_review',
      issues: [
        {
          block_id: null,
          severity: 'error',
          category: 'coverage',
        },
      ],
    });
  });

  it('does not force the atomic semantic-kind contract on long notes', () => {
    const bodyBlocks = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '综合长文' }] }],
    };

    expect(noteBodyBlockContractFailure('note_long', bodyBlocks)).toBeNull();
  });
});
