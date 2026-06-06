// YUK-164 OC-5 (slice 3) — static-HTML test for the VisionTab AI-prefill badge.
// node-only, renderToString (no jsdom / TanStack mount), per lane plan §5 File B.
//
// We renderToString the exported BlockEditor directly with a resolved `form` prop
// so none of VisionTab's live query / SSE / router wiring runs. This asserts ONLY
// markup-presence: the "AI 预填，可改" badge renders for a block that carries an
// auto_enroll_observation and is absent for a plain block. The seeded VALUES are
// asserted in the pure-fn test (auto-enroll.test.ts), not here.

import type { AutoEnrollObservation } from '@/ui/lib/auto-enroll';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BlockEditor, type BlockRow } from './VisionTab';

function obs(overrides: Partial<AutoEnrollObservation> = {}): AutoEnrollObservation {
  return {
    event_id: 'evt_1',
    outcome: null,
    mode: 'observe',
    route: 'auto',
    confidence: 0.5,
    threshold: 0.6,
    reasoning: null,
    suggested_knowledge_ids: [],
    mistake_draft: null,
    observed_at: '2026-06-06T00:00:00.000Z',
    ...overrides,
  };
}

// A block with NO assets/page_spans so BlockImageStrip short-circuits to null and
// no useAssetUrl hook fires during renderToString.
function block(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'blk_1',
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
    created_at: 1_730_000_000,
    ...overrides,
  };
}

const form = {
  prompt_md: '题面',
  reference_md: '',
  wrong_answer_md: '',
  knowledge_ids: [] as string[],
  cause_primary: '' as const,
  cause_notes: '',
  question_kind: 'short_answer' as const,
  difficulty: 3,
  ignored: false,
};

const noop = () => {};

function renderEditor(primary: BlockRow) {
  return renderToString(
    <BlockEditor
      primary={primary}
      followers={[]}
      primaryIndex={0}
      canMergeIntoPrev={false}
      form={form}
      setForm={noop}
      knowledgeNodes={[]}
      onMergeIntoPrev={noop}
      onSplitMerge={noop}
      onRescue={noop}
      rescuing={false}
    />,
  );
}

describe('VisionTab BlockEditor — AI prefill badge', () => {
  it('renders the "AI 预填，可改" badge for a block carrying an observation', () => {
    const html = renderEditor(
      block({ auto_enroll_observation: obs({ suggested_knowledge_ids: ['k1'] }) }),
    );
    expect(html).toContain('AI 预填，可改');
  });

  it('omits the badge for a plain block with no observation', () => {
    const html = renderEditor(block({ auto_enroll_observation: null }));
    expect(html).not.toContain('AI 预填，可改');
  });
});
