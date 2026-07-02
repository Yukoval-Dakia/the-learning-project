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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlockEditor,
  type BlockRow,
  SSETimeline,
  TextLineCompletePanel,
  buildBlockForm,
} from './VisionTab';

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

// YUK-277 — seeding resilience + import fallback. buildBlockForm is the shared
// path the seeding effect and the import handler both use; the durable invariant
// is that it NEVER throws (a single bad block used to abort the whole batch's
// seed updater, leaving every block permanently form-missing, and then the import
// threw `form missing` on the first such block — the owner's 17-block text-line
// wipeout).
describe('VisionTab buildBlockForm — seeding resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('seeds OCR text fields + defaults for an observation-less block', () => {
    const form = buildBlockForm(
      block({
        extracted_prompt_md: '题面文本',
        reference_md: '参考答案',
        wrong_answer_md: null,
        auto_enroll_observation: null,
      }),
    );
    expect(form.prompt_md).toBe('题面文本');
    expect(form.reference_md).toBe('参考答案');
    expect(form.wrong_answer_md).toBe('');
    expect(form.knowledge_ids).toEqual([]);
    expect(form.cause_primary).toBe('');
    expect(form.question_kind).toBe('short_answer');
    expect(form.difficulty).toBe(3);
    expect(form.ignored).toBe(false);
  });

  it('maps a well-shaped observation into the seeded form', () => {
    const form = buildBlockForm(
      block({
        extracted_prompt_md: '题面',
        auto_enroll_observation: obs({
          suggested_knowledge_ids: ['k1', 'k2'],
          mistake_draft: {
            wrong_answer: 'failure',
            difficulty: 4,
            cause: { primary_category: 'concept', analysis_md: '概念混淆' },
          },
        }),
      }),
    );
    expect(form.knowledge_ids).toEqual(['k1', 'k2']);
    expect(form.cause_primary).toBe('concept');
    expect(form.cause_notes).toBe('概念混淆');
    expect(form.difficulty).toBe(4);
  });

  it('degrades to a usable default form WITHOUT throwing on a malformed observation', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A wire-shape regression: suggested_knowledge_ids is not an array, so
    // seedBlockForm's `[...obs.suggested_knowledge_ids]` spread would throw.
    const malformed = obs();
    // biome-ignore lint/suspicious/noExplicitAny: deliberately fabricating a malformed wire shape
    (malformed as any).suggested_knowledge_ids = null;
    const bad = block({
      extracted_prompt_md: '坏块题面',
      auto_enroll_observation: malformed,
    });

    // The invariant: it does not throw — the owner's batch import would otherwise
    // abort on the first bad block.
    expect(() => buildBlockForm(bad)).not.toThrow();
    const form = buildBlockForm(bad);
    // OCR text still seeds; AI fields fall back to defaults.
    expect(form.prompt_md).toBe('坏块题面');
    expect(form.knowledge_ids).toEqual([]);
    expect(form.cause_primary).toBe('');
    expect(form.difficulty).toBe(3);
    expect(form.ignored).toBe(false);
    // And it logs the failing block id for diagnosability.
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(bad.id);
  });
});

// YUK-277 — text-line SSE UX. The text line (DOCX → pandoc) produces blocks
// synchronously with no async extraction job, so the "抽取进度 · SSE · 等待事件…
// /closed" timeline is misleading. TextLineCompletePanel replaces it with a
// direct-completion summary.
describe('VisionTab TextLineCompletePanel — text-line UX', () => {
  // renderToString injects `<!-- -->` markers around interpolated values, so the
  // number and the 块 unit are not a contiguous substring — assert each piece.
  it('renders 文本直抽完成 with the loaded block count', () => {
    const html = renderToString(<TextLineCompletePanel events={[]} blockCount={17} />);
    expect(html).toContain('文本直抽');
    expect(html).toContain('文本直抽完成');
    expect(html).toContain('>17<');
    expect(html).toContain(' 块');
    // It must NOT carry the misleading SSE-waiting framing.
    expect(html).not.toContain('等待事件');
    expect(html).not.toContain('SSE · ');
  });

  it('falls back to the extraction_completed event count before blocks load', () => {
    const html = renderToString(
      <TextLineCompletePanel
        events={[
          {
            event_id: 2,
            event_type: 'ingestion.extraction_completed',
            payload: { block_count: 5, layout_quality: 'structured' },
          },
        ]}
        blockCount={0}
      />,
    );
    expect(html).toContain('>5<');
    expect(html).toContain(' 块');
  });
});

// YUK-541 (ocr-vlm-fallback-ladder) — the fallback ladder persists a non-fatal
// degrade warning (e.g. "fell back to GLM structure") on
// ingestion.extraction_completed, but the SSE timeline never rendered
// payload.warnings. This pins the new render arm.
describe('VisionTab SSETimeline — fallback warning render', () => {
  it('renders payload.warnings on an extraction_completed row', () => {
    const html = renderToString(
      <SSETimeline
        events={[
          {
            event_id: 1,
            event_type: 'ingestion.extraction_completed',
            payload: {
              block_count: 2,
              layout_quality: 'structured',
              warnings: [
                'StructureTask unavailable (timeout); fell back to GLM structure',
                'GLM fallback: page-level standalone, no sub-question split',
              ],
            },
          },
        ]}
        status="closed"
      />,
    );
    expect(html).toContain('fell back to GLM structure');
    expect(html).toContain('no sub-question split');
  });

  it('omits the warning line when payload.warnings is absent/empty', () => {
    const emptyHtml = renderToString(
      <SSETimeline
        events={[
          {
            event_id: 1,
            event_type: 'ingestion.extraction_completed',
            payload: { block_count: 2, layout_quality: 'structured', warnings: [] },
          },
        ]}
        status="closed"
      />,
    );
    expect(emptyHtml).not.toContain('sse-warn');

    const absentHtml = renderToString(
      <SSETimeline
        events={[
          {
            event_id: 1,
            event_type: 'ingestion.extraction_completed',
            payload: { block_count: 2, layout_quality: 'structured' },
          },
        ]}
        status="closed"
      />,
    );
    expect(absentHtml).not.toContain('sse-warn');
  });
});
