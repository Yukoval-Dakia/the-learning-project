// A5 S4 (YUK-531 PR-5) — static-HTML coverage for MisconceptionList. Pure presentational
// (renderToString, node env, no jsdom — mirrors FrontierRail.unit.test.tsx). Pins: the honest
// empty state, loading + error NOT folded into empty (S2 CodeRabbit), the confirmed vs candidate
// two-segment distinction (status badge vs 猜想/候选 tag + card class), source band-chip, the
// qualitative 置信 {conf} + 复现 {seen} 次, the trace evidence event-回链 chips (gated on the
// trace toggle), the optimistic「已纠偏」verdict card, and the three action onClicks (navigate /
// trace toggle / 判错了 veto). ⑥ red line: no bare probability / % leaks through any card.

import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  MisconceptionCardView,
  MisconceptionList,
  applyVeto,
  misconceptionPracticeHref,
} from './MisconceptionList';
import type { MisconceptionRow } from './knowledge-api';

const KNOWLEDGE_ID = 'kc/判断句';

/** Recursively collect every onClick handler in a React element tree (renderToString drops
 *  events, so we walk the element tree directly — robust to wrapper changes). */
function findOnClicks(node: unknown, acc: Array<() => void> = []): Array<() => void> {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findOnClicks(child, acc);
    return acc;
  }
  const el = node as { props?: { onClick?: () => void; children?: unknown } };
  if (typeof el.props?.onClick === 'function') acc.push(el.props.onClick);
  if (el.props?.children !== undefined) findOnClicks(el.props.children, acc);
  return acc;
}

function confirmed(overrides: Partial<MisconceptionRow> = {}): MisconceptionRow {
  return {
    id: 'mc_1',
    segment: 'confirmed',
    label: '把导数相乘当链式法则',
    belief: '链式法则是外层导数乘内层导数，不是把两个导数直接相乘',
    status: 'active',
    source: 'hard',
    conf: '高',
    seen: 4,
    evidence: ['evt_x', 'evt_y'],
    ...overrides,
  };
}

function candidate(overrides: Partial<MisconceptionRow> = {}): MisconceptionRow {
  return {
    id: 'prop_1',
    segment: 'candidate',
    label: '混淆顺承与转折',
    belief: '把「而」的顺承用法当成转折',
    status: 'active',
    source: 'soft',
    conf: '低',
    seen: 2,
    evidence: ['evt_z'],
    ...overrides,
  };
}

describe('MisconceptionList', () => {
  it('shows an honest empty state when nothing points here', () => {
    const html = renderToString(
      <MisconceptionList
        items={[]}
        knowledgeId={KNOWLEDGE_ID}
        navigate={vi.fn()}
        onVeto={vi.fn()}
      />,
    );
    expect(html).toContain('目前没有已记录的相关误区');
    expect(html).toContain('这不代表已经排除');
    expect(html).not.toContain('kd-misc-card');
  });

  it('shows a loading state while the read model is in flight (NOT empty)', () => {
    const html = renderToString(
      <MisconceptionList
        items={[]}
        knowledgeId={KNOWLEDGE_ID}
        isLoading
        navigate={vi.fn()}
        onVeto={vi.fn()}
      />,
    );
    expect(html).toContain('正在看有没有指向此点的误区');
    expect(html).not.toContain('没有指向此点的误区 ——'); // 不折叠成业务空态
    expect(html).not.toContain('kd-misc-card');
  });

  it('shows an error + retry on load failure (NOT folded into empty — CodeRabbit)', () => {
    const onRetry = vi.fn();
    const html = renderToString(
      <MisconceptionList
        items={[]}
        knowledgeId={KNOWLEDGE_ID}
        isError
        onRetry={onRetry}
        navigate={vi.fn()}
        onVeto={vi.fn()}
      />,
    );
    expect(html).toContain('指向此点的误区暂不可用');
    expect(html).not.toContain('没有指向此点的误区 ——'); // 不被误折叠成业务空态
    expect(html).not.toContain('kd-misc-card');
    // retry wired
    const clicks = findOnClicks(
      MisconceptionList({
        items: [],
        knowledgeId: KNOWLEDGE_ID,
        isError: true,
        onRetry,
        navigate: vi.fn(),
        onVeto: vi.fn(),
      }),
    );
    expect(clicks).toHaveLength(1);
    clicks[0]();
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders a CONFIRMED misconception with a user-readable evidence source', () => {
    const html = renderToString(
      <MisconceptionList
        items={[confirmed()]}
        knowledgeId={KNOWLEDGE_ID}
        navigate={vi.fn()}
        onVeto={vi.fn()}
      />,
    );
    expect(html).toContain('把导数相乘当链式法则');
    expect(html).toContain('链式法则');
    expect(html).toContain('kd-misc-status');
    expect(html).toContain('复发中'); // active → 复发中
    expect(html).toContain('作答中反复出现');
    expect(html).toContain('band-chip');
    expect(html).toContain('置信 高'); // qualitative band, NOT a probability
    expect(html).toContain('复现 4 次');
    expect(html).not.toContain('猜想 · 候选'); // confirmed never wears the candidate tag
  });

  it('projects a fading confirmed misconception to 消退中', () => {
    const html = renderToString(
      <MisconceptionList
        items={[confirmed({ status: 'fading', conf: '低' })]}
        knowledgeId={KNOWLEDGE_ID}
        navigate={vi.fn()}
        onVeto={vi.fn()}
      />,
    );
    expect(html).toContain('消退中');
    expect(html).toContain('置信 低');
  });

  it('distinguishes a CANDIDATE with a provisional user-readable source', () => {
    const html = renderToString(
      <MisconceptionList
        items={[candidate()]}
        knowledgeId={KNOWLEDGE_ID}
        navigate={vi.fn()}
        onVeto={vi.fn()}
      />,
    );
    expect(html).toContain('猜想 · 候选'); // honest hypothesis label
    expect(html).toContain('kd-misc-tag-candidate');
    expect(html).toContain('kd-misc-card candidate'); // distinct provisional card class
    expect(html).toContain('AI 初步判断');
    expect(html).toContain('置信 低');
    expect(html).toContain('复现 2 次');
    expect(html).not.toContain('复发中'); // a candidate is NOT a tracked confirmed misconception
    expect(html).not.toContain('kd-misc-status'); // no confirmed-lifecycle status badge
  });

  it('只在追溯展开后显示学习记录数量，并隐藏原始事件标识', () => {
    const closed = renderToString(
      <MisconceptionCardView
        mc={confirmed()}
        knowledgeId={KNOWLEDGE_ID}
        trace={false}
        verdict={null}
        navigate={vi.fn()}
        onToggleTrace={vi.fn()}
        onVerdictWrong={vi.fn()}
      />,
    );
    expect(closed).not.toContain('条学习记录');
    expect(closed).not.toContain('evt_x');

    const open = renderToString(
      <MisconceptionCardView
        mc={confirmed()}
        knowledgeId={KNOWLEDGE_ID}
        trace
        verdict={null}
        navigate={vi.fn()}
        onToggleTrace={vi.fn()}
        onVerdictWrong={vi.fn()}
      />,
    );
    expect(open).toContain('2');
    expect(open).toContain('条学习记录');
    expect(open).not.toContain('evt_x');
    expect(open).not.toContain('evt_y');
  });

  it('renders an honest trace note when a row has no event evidence (no fabricated note)', () => {
    const open = renderToString(
      <MisconceptionCardView
        mc={candidate({ evidence: [] })}
        knowledgeId={KNOWLEDGE_ID}
        trace
        verdict={null}
        navigate={vi.fn()}
        onToggleTrace={vi.fn()}
        onVerdictWrong={vi.fn()}
      />,
    );
    expect(open).toContain('目前还没有可回看的学习记录');
  });

  it('renders the optimistic「已纠偏」card once a verdict is set (降权 message)', () => {
    const html = renderToString(
      <MisconceptionCardView
        mc={confirmed()}
        knowledgeId={KNOWLEDGE_ID}
        trace={false}
        verdict="wrong"
        navigate={vi.fn()}
        onToggleTrace={vi.fn()}
        onVerdictWrong={vi.fn()}
      />,
    );
    expect(html).toContain('已纠偏');
    expect(html).toContain('把这条误区降权');
    // the original BELIEF sentence is replaced by the 降权 message (the label still shows in 「…」).
    expect(html).not.toContain('外层导数乘内层导数');
    expect(html).not.toContain('kd-misc-acts'); // no action buttons on the resolved card
  });

  it('wires a CANDIDATE card actions: navigate「针对性练习」/ trace toggle / active 判错了 veto', () => {
    const navigate = vi.fn();
    const onToggleTrace = vi.fn();
    const onVerdictWrong = vi.fn();
    const clicks = findOnClicks(
      MisconceptionCardView({
        // candidate has an ACTIVE 判错了 (live dismiss). Confirmed disables it (see below).
        mc: candidate(),
        knowledgeId: KNOWLEDGE_ID,
        trace: false,
        verdict: null,
        navigate,
        onToggleTrace,
        onVerdictWrong,
      }),
    );
    // 针对性练习 (Btn) + 追溯 + 判错了 = three clickable actions.
    expect(clicks).toHaveLength(3);
    for (const click of clicks) click();
    expect(navigate).toHaveBeenCalledWith(misconceptionPracticeHref(KNOWLEDGE_ID));
    expect(misconceptionPracticeHref(KNOWLEDGE_ID)).toContain('kc%2F');
    expect(onToggleTrace).toHaveBeenCalled();
    expect(onVerdictWrong).toHaveBeenCalled();
  });

  it('C / #609: disables 判错了 on a CONFIRMED card (no live confirmed-archive writer) — only 2 actions', () => {
    const onVerdictWrong = vi.fn();
    const clicks = findOnClicks(
      MisconceptionCardView({
        mc: confirmed(),
        knowledgeId: KNOWLEDGE_ID,
        trace: false,
        verdict: null,
        navigate: vi.fn(),
        onToggleTrace: vi.fn(),
        onVerdictWrong,
      }),
    );
    // navigate + trace toggle only — 判错了 is DISABLED (no onClick) on a confirmed card, so a
    // confirmed misconception can NEVER reach onVeto / a server write (Option A honesty, ⑥).
    expect(clicks).toHaveLength(2);
    for (const click of clicks) click();
    expect(onVerdictWrong).not.toHaveBeenCalled();

    const html = renderToString(
      <MisconceptionList
        items={[confirmed()]}
        knowledgeId={KNOWLEDGE_ID}
        navigate={vi.fn()}
        onVeto={vi.fn()}
      />,
    );
    expect(html).toContain('暂不可否决'); // honest 旁注 instead of a clickable veto
    // the candidate card carries no such deferred note — its veto is live.
    const candidateHtml = renderToString(
      <MisconceptionList
        items={[candidate()]}
        knowledgeId={KNOWLEDGE_ID}
        navigate={vi.fn()}
        onVeto={vi.fn()}
      />,
    );
    expect(candidateHtml).not.toContain('暂不可否决');
  });

  it('#609: applyVeto forwards (id, "candidate") to onVeto + optimistically sets the verdict', async () => {
    const onVeto = vi.fn().mockResolvedValue(undefined);
    const setVerdict = vi.fn();
    const setError = vi.fn();
    await applyVeto(candidate({ id: 'prop_42' }), onVeto, setVerdict, setError);
    // candidate segment routes to the server dismiss with its OWN id (segment, never id alone).
    expect(onVeto).toHaveBeenCalledWith('prop_42', 'candidate');
    expect(setVerdict).toHaveBeenCalledWith('wrong'); // optimistic「已纠偏」
    expect(setError).toHaveBeenCalledWith(null);
    expect(setVerdict).not.toHaveBeenCalledWith(null); // no rollback on success
  });

  it('B / ⑥: applyVeto rolls back the optimistic verdict + surfaces an inline error when the veto rejects', async () => {
    const onVeto = vi.fn().mockRejectedValue(new Error('409 already decided as accept'));
    const setVerdict = vi.fn();
    const setError = vi.fn();
    await applyVeto(candidate(), onVeto, setVerdict, setError);
    expect(setVerdict).toHaveBeenNthCalledWith(1, 'wrong'); // optimistic first
    expect(setVerdict).toHaveBeenLastCalledWith(null); // rolled back (no stuck false「已纠偏」)
    expect(setError).toHaveBeenLastCalledWith('撤销失败，请重试');
  });

  it('B: the card view renders an inline error when a veto rollback set one', () => {
    const html = renderToString(
      <MisconceptionCardView
        mc={candidate()}
        knowledgeId={KNOWLEDGE_ID}
        trace={false}
        verdict={null}
        error="撤销失败，请重试"
        navigate={vi.fn()}
        onToggleTrace={vi.fn()}
        onVerdictWrong={vi.fn()}
      />,
    );
    expect(html).toContain('撤销失败，请重试');
    expect(html).toContain('kd-misc-error');
    expect(html).toContain('role="alert"');
  });

  it('E: 去重学习记录后只显示数量，不显示原始事件标识', () => {
    const open = renderToString(
      <MisconceptionCardView
        mc={confirmed({ evidence: ['evt_dup', 'evt_dup', 'evt_other'] })}
        knowledgeId={KNOWLEDGE_ID}
        trace
        verdict={null}
        navigate={vi.fn()}
        onToggleTrace={vi.fn()}
        onVerdictWrong={vi.fn()}
      />,
    );
    expect(open).toContain('2');
    expect(open).toContain('条学习记录');
    expect(open).not.toContain('evt_dup');
    expect(open).not.toContain('evt_other');
  });

  it('⑥ red line: no bare probability / % leaks through confirmed or candidate cards', () => {
    const html = renderToString(
      <MisconceptionList
        items={[confirmed({ conf: '高', seen: 9 }), candidate({ conf: '低', seen: 5 })]}
        knowledgeId={KNOWLEDGE_ID}
        navigate={vi.fn()}
        onVeto={vi.fn()}
      />,
    );
    expect(html).not.toContain('%');
    // qualitative confidence only — never a 0.xx probability.
    expect(html).not.toMatch(/0\.\d/);
    expect(html).toContain('置信 高');
    expect(html).toContain('置信 低');
  });
});
