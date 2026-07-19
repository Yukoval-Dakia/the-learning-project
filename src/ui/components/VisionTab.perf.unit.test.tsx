// @vitest-environment jsdom

// YUK-717 — editing one field of one block used to replace the shared blockForms
// record and re-render EVERY BlockEditor (20-40 of them, each with ~30 knowledge
// chips + an image strip). The fix wraps BlockEditor in React.memo and hands each
// block a per-id stable setForm (ref-cached factory) plus hoisted, referentially
// stable knowledgeNodes / subjectRows / merge+rescue callbacks — so a single-field
// edit re-renders only the edited block.
//
// This harness mirrors VisionTab's block-list wiring exactly: a shared blockForms
// record where a per-block updater replaces only that block's entry (leaving the
// other entries' object identity intact), the same ref-cached getSetForm, and
// stable primary / knowledgeNodes / subjectRows / callback references. That prop
// contract is the invariant the memo relies on, so testing it here tests the real
// optimization.
//
// Render-count probe: formatRelTime() is called exactly once per BlockEditor render
// with new Date(primary.created_at * 1000), so counting calls bucketed by that
// timestamp is a faithful per-block render counter.

import type { ApiSubject } from '@/ui/hooks/useSubjects';
import { formatRelTime } from '@/ui/lib/utils';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockEditor, type BlockFormState, type BlockRow, buildBlockForm } from './VisionTab';

vi.mock('@/ui/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/lib/utils')>();
  return { ...actual, formatRelTime: vi.fn(actual.formatRelTime) };
});

const formatRelTimeSpy = vi.mocked(formatRelTime);

afterEach(() => {
  cleanup();
  formatRelTimeSpy.mockClear();
});

// Stable module-level empties so their identity never changes between renders.
const EMPTY_FOLLOWERS: BlockRow[] = [];
const EMPTY_KNOWLEDGE: { id: string; name: string; effective_domain: string | null }[] = [];
const EMPTY_SUBJECTS: ApiSubject[] = [];

function block(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'blk',
    ingestion_session_id: 'sess_1',
    source_asset_ids: [],
    page_spans: [],
    extracted_prompt_md: '题面',
    structured: null,
    reference_md: null,
    wrong_answer_md: null,
    image_refs: [],
    layout_quality: 'structured',
    extraction_confidence: 0.9,
    status: 'draft',
    knowledge_hint: null,
    auto_enroll_observation: null,
    created_at: 1000,
    ...overrides,
  };
}

// Two stable block rows; created_at (in seconds) distinguishes them in the probe.
const BLOCK_A = block({ id: 'a', created_at: 1000, extracted_prompt_md: 'A 题面' });
const BLOCK_B = block({ id: 'b', created_at: 2000, extracted_prompt_md: 'B 题面' });
const ROWS = [BLOCK_A, BLOCK_B];

// formatRelTime is called with new Date(created_at * 1000); bucket calls by ms.
function rendersFor(createdAtSec: number): number {
  const ms = createdAtSec * 1000;
  return formatRelTimeSpy.mock.calls.filter((c) => c[0] instanceof Date && c[0].getTime() === ms)
    .length;
}

// Faithful mirror of VisionTab's block-list wiring: shared blockForms record,
// per-id stable setForm (ref cache), stable primary/knowledgeNodes/subjectRows and
// stable callbacks. Only the edited block's form entry gets a new identity.
function Harness() {
  const [blockForms, setBlockForms] = useState<Record<string, BlockFormState>>(() => ({
    a: buildBlockForm(BLOCK_A),
    b: buildBlockForm(BLOCK_B),
  }));

  const setFormByBlockRef = useRef(
    new Map<string, (updater: (cur: BlockFormState) => BlockFormState) => void>(),
  );
  const getSetForm = useCallback((blockId: string) => {
    const cache = setFormByBlockRef.current;
    let fn = cache.get(blockId);
    if (!fn) {
      fn = (updater) =>
        setBlockForms((prev) => {
          const cur = prev[blockId];
          if (!cur) return prev;
          return { ...prev, [blockId]: updater(cur) };
        });
      cache.set(blockId, fn);
    }
    return fn;
  }, []);

  const onMergeIntoPrev = useCallback(() => {}, []);
  const onSplitMerge = useCallback(() => {}, []);
  const onRescue = useCallback(() => {}, []);

  return (
    <>
      {ROWS.map((b, i) => (
        <BlockEditor
          key={b.id}
          primary={b}
          followers={EMPTY_FOLLOWERS}
          primaryIndex={i}
          canMergeIntoPrev={false}
          form={blockForms[b.id]}
          setForm={getSetForm(b.id)}
          knowledgeNodes={EMPTY_KNOWLEDGE}
          subjectRows={EMPTY_SUBJECTS}
          onMergeIntoPrev={onMergeIntoPrev}
          onSplitMerge={onSplitMerge}
          onRescue={onRescue}
          rescuing={false}
        />
      ))}
    </>
  );
}

describe('VisionTab BlockEditor single-field edit re-renders only its own block (YUK-717)', () => {
  it('editing block A does not re-render block B', () => {
    render(<Harness />);

    // Each block renders once on mount.
    expect(rendersFor(1000)).toBe(1);
    expect(rendersFor(2000)).toBe(1);

    // Edit block A's 题面 (both blocks expose the same accessible name; [0] = A).
    const promptA = screen.getAllByLabelText('题面（已识别，可修改）')[0];
    fireEvent.change(promptA, { target: { value: 'A 题面 · 已改' } });

    // A re-rendered (its form entry got a new identity)…
    expect(rendersFor(1000)).toBe(2);
    // …B did NOT (its form entry + every other prop kept identity ⇒ memo bailed).
    expect(rendersFor(2000)).toBe(1);
  });
});
