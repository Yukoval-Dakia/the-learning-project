import { describe, expect, it } from 'vitest';

import {
  decideNoteRefineMode,
  patchTouchesVerifiedBlock,
} from '@/capabilities/notes/server/note-refine-policy';
import type { NotePatchT } from '@/core/schema/note-patch';

function verifiedBlock(id: string, text: string): Record<string, unknown> {
  return {
    type: 'semanticBlock',
    attrs: { id, semantic_kind: 'definition', user_verified: true },
    content: [{ type: 'text', text }],
  };
}

function plainBlock(id: string, text: string): Record<string, unknown> {
  return {
    type: 'paragraph',
    attrs: { id },
    content: [{ type: 'text', text }],
  };
}

function doc(...nodes: Record<string, unknown>[]) {
  return { type: 'doc', content: nodes };
}

// decideNoteRefineMode is the count-only gate — it must stay untouched (its
// existing unit semantics are pinned here so a regression in C1a is caught).
describe('decideNoteRefineMode (untouched by C1a)', () => {
  it('mutator when within thresholds', () => {
    expect(decideNoteRefineMode({ ops_count: 3, new_blocks: 2 })).toBe('mutator');
  });
  it('propose when ops exceed threshold', () => {
    expect(decideNoteRefineMode({ ops_count: 4, new_blocks: 0 })).toBe('propose');
  });
  it('propose when new_blocks exceed threshold', () => {
    expect(decideNoteRefineMode({ ops_count: 1, new_blocks: 3 })).toBe('propose');
  });
});

// C1a (YUK-358): pure predicate the job-gate uses to divert a mutator-sized
// patch to propose when it would touch a verified block.
describe('patchTouchesVerifiedBlock (C1a)', () => {
  it('true when a replace_block targets a verified block', () => {
    const body = doc(verifiedBlock('b1', 'human owns'), plainBlock('b2', 'ai'));
    const patch: NotePatchT = {
      ops: [{ kind: 'replace_block', target_block_id: 'b1', block: plainBlock('b1', 'x') }],
    };
    expect(patchTouchesVerifiedBlock(body, patch)).toBe(true);
  });

  // RED-5 (YUK-358 决定7) — source_tier-only verified block (NO user_verified
  // flag) must STILL be protected. Proves the shared isVerifiedBlock口径 (both
  // flag-OR-tier) is what the gate consults, not a flag-only check.
  it('true when a replace_block targets a source_tier:user_verified block (no flag)', () => {
    const tierBlock: Record<string, unknown> = {
      type: 'semanticBlock',
      attrs: { id: 'bt', semantic_kind: 'definition', source_tier: 'user_verified' },
      content: [{ type: 'text', text: 'tier-owned' }],
    };
    const body = doc(tierBlock, plainBlock('b2', 'ai'));
    const patch: NotePatchT = {
      ops: [{ kind: 'replace_block', target_block_id: 'bt', block: plainBlock('bt', 'x') }],
    };
    expect(patchTouchesVerifiedBlock(body, patch)).toBe(true);
  });

  it('true when a delete_block targets a verified block', () => {
    const body = doc(verifiedBlock('b1', 'human owns'), plainBlock('b2', 'ai'));
    const patch: NotePatchT = {
      ops: [{ kind: 'delete_block', target_block_id: 'b1' }],
    };
    expect(patchTouchesVerifiedBlock(body, patch)).toBe(true);
  });

  it('false when replace_block targets a NON-verified block', () => {
    const body = doc(verifiedBlock('b1', 'human owns'), plainBlock('b2', 'ai'));
    const patch: NotePatchT = {
      ops: [{ kind: 'replace_block', target_block_id: 'b2', block: plainBlock('b2', 'x') }],
    };
    expect(patchTouchesVerifiedBlock(body, patch)).toBe(false);
  });

  it('false when insert_after targets a verified block (sibling, does not touch content)', () => {
    const body = doc(verifiedBlock('b1', 'human owns'));
    const patch: NotePatchT = {
      ops: [{ kind: 'insert_after', target_block_id: 'b1', block: plainBlock('b1a', 'sib') }],
    };
    expect(patchTouchesVerifiedBlock(body, patch)).toBe(false);
  });

  it('false on unparseable body_blocks (no crash)', () => {
    const patch: NotePatchT = {
      ops: [{ kind: 'replace_block', target_block_id: 'b1', block: plainBlock('b1', 'x') }],
    };
    expect(patchTouchesVerifiedBlock({ not: 'a doc' }, patch)).toBe(false);
  });
});
