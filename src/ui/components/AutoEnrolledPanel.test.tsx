// YUK-164 OC-5 — static-HTML tests for the AutoEnrolledPanel presentational body.
// node-only, renderToString (no jsdom / TanStack mount), per lane plan §5 File B.
// We renderToString the PURE `PanelBody` (and the EmptyState the container passes)
// — the live query/mutation/two-step-confirm wiring is NOT unit-tested here (it
// can't be on the node-only stack; the revert SERVICE is covered by the DB test).

import type { AutoEnrollObservation } from '@/ui/lib/auto-enroll';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type ObservedRow, PanelBody } from './AutoEnrolledPanel';

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

const noop = () => {};

function renderBody(overrides: Partial<Parameters<typeof PanelBody>[0]> = {}) {
  return renderToString(
    <PanelBody
      observedRows={[]}
      showBanner={false}
      knowledgeNameById={new Map()}
      confirmingBlockId={null}
      reverting={false}
      revertErrorText={null}
      onRevertClick={noop}
      onRevertConfirm={noop}
      onRevertCancel={noop}
      {...overrides}
    />,
  );
}

describe('AutoEnrolledPanel — empty state copy', () => {
  it('renders the verbatim observe-empty EmptyState copy', () => {
    // This is the exact EmptyState the container hands to <Stateful empty={…}>.
    const html = renderToString(
      <EmptyState
        icon="eye"
        title="AI 正在观察，尚未自动录入"
        text="开启 auto-enroll 后，AI 拟录入的错题 / 记录会列在这里，每项可一键撤销。"
      />,
    );
    expect(html).toContain('AI 正在观察，尚未自动录入');
    expect(html).toContain('每项可一键撤销');
  });
});

describe('PanelBody — observe banner derivation', () => {
  it('renders the observe-only banner when showBanner is true', () => {
    const html = renderBody({ showBanner: true });
    expect(html).toContain('data-testid="observe-banner"');
    expect(html).toContain('observe-only');
    expect(html).toContain('WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED = OFF');
  });

  it('omits the banner when showBanner is false (flag ON / some block enrolled)', () => {
    const html = renderBody({ showBanner: false });
    expect(html).not.toContain('data-testid="observe-banner"');
  });
});

describe('PanelBody — populated rows', () => {
  const rows: ObservedRow[] = [
    {
      blockId: 'blk_a',
      status: 'auto_enrolled',
      observation: obs({
        route: 'auto',
        confidence: 0.91,
        suggested_knowledge_ids: ['k1'],
        reasoning: '与错因匹配',
      }),
    },
    {
      blockId: 'blk_b',
      status: 'draft',
      observation: obs({ route: 'review', confidence: 0.42, suggested_knowledge_ids: ['k2'] }),
    },
  ];
  const names = new Map([
    ['k1', '一次函数'],
    ['k2', '勾股定理'],
  ]);

  it('renders route text labels (auto / review) as the non-color cue', () => {
    const html = renderBody({ observedRows: rows, knowledgeNameById: names });
    expect(html).toContain('>auto<');
    expect(html).toContain('>review<');
  });

  it('renders mono `confidence X.XX` per row', () => {
    const html = renderBody({ observedRows: rows, knowledgeNameById: names });
    expect(html).toContain('confidence 0.91');
    expect(html).toContain('confidence 0.42');
  });

  it('renders resolved knowledge names as chips (falls back to id when unknown)', () => {
    const html = renderBody({ observedRows: rows, knowledgeNameById: names });
    expect(html).toContain('一次函数');
    expect(html).toContain('勾股定理');

    const unknownHtml = renderBody({
      observedRows: [
        {
          blockId: 'blk_c',
          status: 'draft',
          observation: obs({ suggested_knowledge_ids: ['k_missing'] }),
        },
      ],
      knowledgeNameById: new Map(),
    });
    expect(unknownHtml).toContain('k_missing');
  });

  it('renders the status pill text for each block (draft / auto_enrolled)', () => {
    const html = renderBody({ observedRows: rows, knowledgeNameById: names });
    expect(html).toContain('data-status="auto_enrolled"');
    expect(html).toContain('data-status="draft"');
  });
});

describe('PanelBody — revert affordance gated on status', () => {
  it('renders the 撤销 control only for an auto_enrolled row', () => {
    const html = renderBody({
      observedRows: [
        {
          blockId: 'blk_a',
          status: 'auto_enrolled',
          observation: obs(),
        },
      ],
    });
    expect(html).toContain('撤销</button>');
    expect(html).not.toContain('data-testid="no-revert-hint"');
  });

  it('omits 撤销 for a draft row and shows the observe-only hint instead', () => {
    const html = renderBody({
      observedRows: [
        {
          blockId: 'blk_b',
          status: 'draft',
          observation: obs(),
        },
      ],
    });
    // The revert BUTTON renders its label as `…撤销</button>`; the no-revert hint
    // text "无可撤销项" also contains 撤销 as a substring, so assert on the
    // button-specific markup, not the bare substring.
    expect(html).not.toContain('撤销</button>');
    expect(html).toContain('data-testid="no-revert-hint"');
    expect(html).toContain('仅观察 · 无可撤销项');
  });

  it('shows the two-step confirm control when a row is confirming', () => {
    const html = renderBody({
      observedRows: [{ blockId: 'blk_a', status: 'auto_enrolled', observation: obs() }],
      confirmingBlockId: 'blk_a',
    });
    expect(html).toContain('确认撤销');
    expect(html).toContain('取消');
  });
});
