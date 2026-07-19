// @vitest-environment jsdom

// YUK-718 — VisionTab's BlockEditor rendered <span> visual labels via FieldLabel,
// leaving its editable controls with no accessible name. BlockEditor renders once
// per block (a list), so a real <label htmlFor> would need per-instance ids that
// would collide with YUK-717's queued render work; each control now carries a
// per-control aria-label instead. This renders BlockEditor and asserts every field
// is reachable by its accessible name.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockEditor, type BlockRow, buildBlockForm } from './VisionTab';

afterEach(cleanup);

// A block with no assets/page_spans so BlockImageStrip short-circuits to null and
// no useAssetUrl blob fetch fires.
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

function renderBlockEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const primary = block();
  return render(
    <QueryClientProvider client={qc}>
      <BlockEditor
        primary={primary}
        followers={[]}
        primaryIndex={0}
        canMergeIntoPrev={false}
        form={buildBlockForm(primary)}
        setForm={vi.fn()}
        knowledgeNodes={[]}
        onMergeIntoPrev={vi.fn()}
        onSplitMerge={vi.fn()}
        onRescue={vi.fn()}
        rescuing={false}
      />
    </QueryClientProvider>,
  );
}

describe('VisionTab BlockEditor field labels (YUK-718)', () => {
  it.each(['题面', '参考答案', '错答', '难度', '搜索知识点'])(
    'exposes the "%s" control by its accessible name',
    (name) => {
      renderBlockEditor();
      expect(screen.getByLabelText(name)).toBeTruthy();
    },
  );
});
