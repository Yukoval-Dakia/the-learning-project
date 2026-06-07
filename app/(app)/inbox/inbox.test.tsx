// YUK-271 — unit coverage for the block_merge inbox card enablement.
//
// Mock boundary: the unit partition runs in the `node` env with no jsdom /
// @testing-library (see vitest.unit.config.ts — existing .test.tsx files use
// renderToString, not a live DOM). So this test statically renders the exported
// BlockMergeProposalCard in isolation and asserts the markup. It imports the
// ./proposal-shared module (a non-route sibling of page.tsx — page.tsx cannot
// re-export components, Next rejects non-reserved page exports); that module only
// pulls @/ui primitives + next/link, so no DB / R2 / AI / browser API is touched.
//
// NOT covered here (no live DOM in the node unit env, would require adding
// jsdom + @testing-library — out of YUK-271's minimal-enable scope): the click →
// acceptMutation dispatch and the stale-accept notice render. Those are behavioural
// and are guarded by the backend DB suite (src/server/proposals/actions.test.ts
// `block_merge proposal lifecycle`, which exercises accept / dedup / idempotent /
// stale end-to-end) plus the §5 manual visual check in the plan.
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  BlockMergeProposalCard,
  type BlockMergeProposalPayload,
  type ProposalInboxRow,
  isBlockMergeStale,
  kindLabel,
} from './proposal-shared';

function makeBlockMergeRow(): ProposalInboxRow & { payload: BlockMergeProposalPayload } {
  const payload: BlockMergeProposalPayload = {
    kind: 'block_merge',
    target: { subject_kind: 'question_block', subject_id: 'blk_primary' },
    reason_md: '两块在分页处断开，应合并为一题。',
    evidence_refs: [],
    proposed_change: {
      primary_block_id: 'blk_primary',
      merge_block_ids: ['blk_tail'],
      ingestion_session_id: 'ses_1',
      continuity_signal: 'page_edge',
      confidence: 0.82,
    },
  };
  return {
    id: 'prop_1',
    kind: 'block_merge',
    target: payload.target,
    payload,
    status: 'pending',
    proposed_at: new Date('2026-06-07T00:00:00Z').toISOString(),
    decided_at: null,
    actor_ref: 'producer:block_merge',
    task_run_id: null,
    cost_micro_usd: null,
    source_action: 'experimental:proposal',
    source_subject_kind: 'question_block',
  };
}

describe('block_merge inbox card (YUK-271)', () => {
  it('kindLabel maps block_merge to its Chinese label, not the raw kind', () => {
    expect(kindLabel('block_merge')).toBe('题块合并');
    expect(kindLabel('block_merge')).not.toBe('block_merge');
  });

  it('renders the 接受 button live (enabled) — not the disabled 待接入 placeholder', () => {
    const html = renderToString(
      <BlockMergeProposalCard
        proposal={makeBlockMergeRow()}
        pending={false}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onRetract={vi.fn()}
      />,
    );
    // The 接受 button is present and the disabled placeholder copy is gone — this
    // is the core YUK-271 change vs the GenericProposalCard fallback.
    expect(html).toContain('接受');
    expect(html).not.toContain('待接入');
    // The accept button must NOT carry a `disabled` attribute when pending=false.
    // react-dom/server omits `disabled` entirely for a falsy value, so its absence
    // proves the button is interactive.
    expect(html).not.toContain('disabled');
    // The card title resolves through kindLabel → 题块合并 (covers the C1 drift fix).
    expect(html).toContain('题块合并');
  });

  it('disables every action button while a mutation is pending', () => {
    const html = renderToString(
      <BlockMergeProposalCard
        proposal={makeBlockMergeRow()}
        pending={true}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
        onRetract={vi.fn()}
      />,
    );
    expect(html).toContain('disabled');
  });

  it('isBlockMergeStale narrows only a stale block_merge accept result', () => {
    // Drives the C3 stale-notice branch in the accept mutation's onSuccess.
    expect(
      isBlockMergeStale({ kind: 'block_merge', stale: true, skip_reason: 'skipped:not_draft' }),
    ).toBe(true);
    // A written/idempotent block_merge accept is NOT stale → no notice.
    expect(isBlockMergeStale({ kind: 'block_merge', rate_event_id: 'ev_1', merged_count: 1 })).toBe(
      false,
    );
    expect(isBlockMergeStale({ kind: 'block_merge', idempotent: true })).toBe(false);
    // Other accept kinds / malformed payloads never trip the notice.
    expect(isBlockMergeStale({ kind: 'knowledge_node', stale: true })).toBe(false);
    expect(isBlockMergeStale(null)).toBe(false);
    expect(isBlockMergeStale(undefined)).toBe(false);
  });
});
