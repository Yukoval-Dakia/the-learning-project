// YUK-707 (P0F/3) — TeachingBriefBand SSR render coverage. Locks the contract §8.1/§8.2
// anti-guilt + no-internal-id invariants and the four-block structure that make the brief
// the single "为你而备" delivery, not a backlog/guilt surface. Interaction, focus/aria-live,
// loading/error, and getByRole a11y live in TeachingBrief.interaction.unit.test.tsx.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TeachingBriefBand } from './TeachingBrief';
import type {
  FindingTeachingBrief,
  OutcomeConfirmedTeachingBrief,
  OutcomeRetiredTeachingBrief,
  ProbeReadyTeachingBrief,
  TeachingBrief,
} from './teaching-brief-api';

const FINDING_CLAIM = '你可能在复合层级增加时漏掉内层变化率。';
const BASIS_SUMMARY = '这个模式在最近几次相关作答中重复出现，值得用一道判别题确认。';
const PROBE_TEXT = '求 d/dx sin(x²)，并标出每一层变化率。';

function findingBrief(overrides: Partial<FindingTeachingBrief> = {}): FindingTeachingBrief {
  return {
    brief_id: 'evt_conj_01',
    state: 'finding',
    updated_at: '2026-07-18T15:10:00.000Z',
    expires_at: '2026-07-25T15:10:00.000Z',
    finding: {
      claim_md: FINDING_CLAIM,
      knowledge_id: 'kn_chain_rule',
      cause_category: 'concept_misunderstanding',
    },
    basis: {
      summary_md: BASIS_SUMMARY,
      evidence_trace: [
        { role: 'induction', kind: 'event', id: 'evt_attempt_a' },
        { role: 'induction', kind: 'question', id: 'q_source_b' },
      ],
    },
    prepared_action: {
      kind: 'review_finding',
      proposal_id: 'evt_conj_01',
      probe_preview_md: PROBE_TEXT,
    },
    current_outcome: { status: 'awaiting_decision', summary_md: '这仍是一条待检验的判断。' },
    ...overrides,
  };
}

function probeReadyBrief(
  overrides: Partial<ProbeReadyTeachingBrief> = {},
): ProbeReadyTeachingBrief {
  return {
    brief_id: 'evt_conj_01',
    state: 'probe_ready',
    updated_at: '2026-07-19T01:20:00.000Z',
    expires_at: null,
    finding: {
      claim_md: FINDING_CLAIM,
      knowledge_id: 'kn_chain_rule',
      cause_category: 'concept_misunderstanding',
    },
    basis: {
      summary_md: BASIS_SUMMARY,
      evidence_trace: [
        { role: 'induction', kind: 'event', id: 'evt_attempt_a' },
        { role: 'probe', kind: 'question', id: 'q_probe_01' },
      ],
    },
    prepared_action: {
      kind: 'answer_probe',
      probe_question_id: 'q_probe_01',
      prompt_md: PROBE_TEXT,
    },
    current_outcome: {
      status: 'awaiting_answer',
      summary_md: '判别题已备好；完成后再更新这条判断。',
    },
    ...overrides,
  };
}

function outcomeConfirmedBrief(
  overrides: Partial<OutcomeConfirmedTeachingBrief> = {},
): OutcomeConfirmedTeachingBrief {
  return {
    brief_id: 'evt_conj_01',
    state: 'outcome_confirmed',
    updated_at: '2026-07-19T02:05:00.000Z',
    expires_at: '2026-07-26T02:05:00.000Z',
    finding: {
      claim_md: FINDING_CLAIM,
      knowledge_id: 'kn_chain_rule',
      cause_category: 'concept_misunderstanding',
    },
    basis: {
      summary_md: BASIS_SUMMARY,
      evidence_trace: [
        { role: 'induction', kind: 'event', id: 'evt_attempt_a' },
        { role: 'probe', kind: 'question', id: 'q_probe_01' },
        { role: 'outcome', kind: 'event', id: 'evt_probe_result_01' },
      ],
    },
    prepared_action: { kind: 'none' },
    current_outcome: {
      status: 'confirmed',
      summary_md: '这条判断得到这次探针的支持；下一步可以针对这个点练习。',
      probe_question_id: 'q_probe_01',
      probe_result_event_id: 'evt_probe_result_01',
    },
    ...overrides,
  };
}

function outcomeRetiredBrief(
  overrides: Partial<OutcomeRetiredTeachingBrief> = {},
): OutcomeRetiredTeachingBrief {
  return {
    ...outcomeConfirmedBrief(),
    state: 'outcome_retired',
    current_outcome: {
      status: 'retired',
      summary_md: '这条判断被这次探针排除；原计划可以继续。',
      probe_question_id: 'q_probe_01',
      probe_result_event_id: 'evt_probe_result_01',
    },
    ...overrides,
  };
}

function render(brief: TeachingBrief | null): string {
  const qc = new QueryClient();
  qc.setQueryData(['teaching-brief'], { brief });
  return renderToString(
    <QueryClientProvider client={qc}>
      <TeachingBriefBand />
    </QueryClientProvider>,
  );
}

// Every internal id that must never reach the DOM (contract §8.2). Anti-guilt tokens the
// wire lock (§8.1) forbids in any state, including inside attributes.
const INTERNAL_IDS = [
  'evt_conj_01',
  'kn_chain_rule',
  'q_source_b',
  'evt_attempt_a',
  'q_probe_01',
  'evt_probe_result_01',
];
const FORBIDDEN_TOKENS = [
  '%',
  'confidence',
  '置信',
  '把握',
  '预测',
  'predicted',
  'baseline',
  'recurrence',
  '反复出现',
  '等待',
  '待裁决',
  '未读',
  'backlog',
  '逾期',
  'action required',
  '你又错了',
  '全部完成',
  '连续',
  '成本',
  'agent note',
  '任务运行',
  'task run',
  'prompt',
  '提示词',
  '投票',
  '争论',
];

function expectClean(html: string): void {
  for (const id of INTERNAL_IDS) expect(html).not.toContain(id);
  for (const token of FORBIDDEN_TOKENS) expect(html).not.toContain(token);
  // evidence is provenance, never a summarized count / multiplier (§8.1 · [裁决 8]).
  expect(html).not.toContain('条证据');
  expect(html).not.toContain('×');
}

describe('TeachingBriefBand — state rendering (SSR)', () => {
  it('finding: claim + basis + probe preview + four headings + double CTA', () => {
    const html = render(findingBrief());
    expect(html).toContain(FINDING_CLAIM);
    expect(html).toContain(BASIS_SUMMARY);
    expect(html).toContain(PROBE_TEXT);
    expect(html).toContain('团队正要问你的一道题');
    // Four real headings: h2 title + h3 per block.
    expect(html).toContain('为你而备');
    expect(html).toContain('教研团在检验什么');
    expect(html).toContain('为什么这么判断');
    expect(html).toContain('已经为你备好');
    expect(html).toContain('当前结果');
    // Double CTA — accept reads as "verify direction", never "确认弱点" / "加进复习".
    expect(html).toContain('就按这个方向验证');
    expect(html).toContain('不太像');
    expect(html).not.toContain('确认弱点');
    expect(html).not.toContain('加进复习');
    expectClean(html);
  });

  it('probe_ready: prompt + single CTA, and NO answer box before reveal', () => {
    const html = render(probeReadyBrief());
    expect(html).toContain(PROBE_TEXT);
    expect(html).toContain('现在就试做这道题');
    // The answer surface (textarea) only appears after the reveal — never inline in SSR.
    expect(html).not.toContain('写下你的解答');
    expectClean(html);
  });

  it('outcome_confirmed: conclusion in 当前结果 region, status icon, NO CTA', () => {
    const brief = outcomeConfirmedBrief();
    const html = render(brief);
    // Structural: the server-owned summary renders (assert the fixture value, not a
    // hardcoded server literal — [裁决 9a]) and there is no actionable button.
    expect(html).toContain(brief.current_outcome.summary_md);
    expect(html).toContain('当前结果');
    expect(html).toContain('tb-outcome-confirmed');
    expect(html).not.toContain('<button');
    expectClean(html);
  });

  it('outcome_retired: conclusion + retired styling, NO CTA', () => {
    const brief = outcomeRetiredBrief();
    const html = render(brief);
    expect(html).toContain(brief.current_outcome.summary_md);
    expect(html).toContain('tb-outcome-retired');
    expect(html).not.toContain('<button');
    expectClean(html);
  });

  it('quiet null: a calm night, not an achievement nag', () => {
    const html = render(null);
    expect(html).toContain('教研团暂无需要交付的新判断。');
    expect(html).not.toContain('全部完成');
    expect(html).not.toContain('全部搞定');
    expect(html).not.toContain('连续');
    expect(html).not.toContain('caught up');
  });
});

describe('TeachingBriefBand — evidence provenance (SSR)', () => {
  it('renders one prose chip per ref, never folded, never ×N', () => {
    // Two same-kind induction refs (different ids) → two identical neutral chips, no ×2.
    const html = render(
      findingBrief({
        basis: {
          summary_md: BASIS_SUMMARY,
          evidence_trace: [
            { role: 'induction', kind: 'event', id: 'evt_1' },
            { role: 'induction', kind: 'event', id: 'evt_2' },
          ],
        },
      }),
    );
    const matches = html.match(/源自一次 AI 判定事件/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(html).not.toContain('×2');
    expect(html).not.toContain('×');
  });

  it('renders evidence as <span>, never a link — even a navigable knowledge ref', () => {
    const html = render(
      findingBrief({
        basis: {
          summary_md: BASIS_SUMMARY,
          evidence_trace: [{ role: 'induction', kind: 'knowledge', id: 'kn_secret_target' }],
        },
      }),
    );
    // The navigable route is deliberately IGNORED (prose-only): neutral label, no link,
    // no href, and the raw id never reaches the DOM.
    expect(html).toContain('源自一个知识点');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
    expect(html).not.toContain('kn_secret_target');
  });
});
