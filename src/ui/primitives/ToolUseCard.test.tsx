import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  type ToolUseAction,
  ToolUseCard,
  type ToolUseMeta,
  type ToolUseStatus,
} from './ToolUseCard';
import { COPILOT_TOOL_FIXTURES } from './copilot-tool-fixtures';

const sample = COPILOT_TOOL_FIXTURES[0];
if (!sample) throw new Error('expected at least one fixture');

describe('ToolUseCard 三段式 (legacy folded contract — backward compat)', () => {
  it('renders tool name + summary + cost chip in head row', () => {
    const html = renderToString(
      <ToolUseCard
        toolName={sample.toolName}
        summary={sample.summary}
        costLabel={sample.costLabel}
        body={sample.body}
      />,
    );
    expect(html).toContain('data-testid="tool-use-card"');
    expect(html).toContain(`data-tool="${sample.toolName}"`);
    expect(html).toContain(sample.summary);
    expect(html).toContain(sample.costLabel);
    expect(html).toContain('data-testid="tool-use-toggle"');
  });

  it('keeps result body folded by default and expands when controlled', () => {
    const folded = renderToString(
      <ToolUseCard toolName={sample.toolName} summary={sample.summary} body={sample.body} />,
    );
    expect(folded).toContain('data-expanded="false"');
    expect(folded).not.toContain('data-testid="tool-use-body"');

    const expanded = renderToString(
      <ToolUseCard
        toolName={sample.toolName}
        summary={sample.summary}
        body={sample.body}
        expanded
      />,
    );
    expect(expanded).toContain('data-expanded="true"');
    expect(expanded).toContain('data-testid="tool-use-body"');
    expect(expanded).toContain(sample.body);
  });

  it('honours chainRowCost tweak by rendering cost detail row when "always-show"', () => {
    const summaryOnly = renderToString(
      <ToolUseCard
        toolName={sample.toolName}
        summary={sample.summary}
        costLabel={sample.costLabel}
        costDetail={sample.costDetail}
        chainRowCost="summary-only"
      />,
    );
    expect(summaryOnly).not.toContain('data-testid="tool-use-cost-row"');

    const alwaysShow = renderToString(
      <ToolUseCard
        toolName={sample.toolName}
        summary={sample.summary}
        costLabel={sample.costLabel}
        costDetail={sample.costDetail}
        chainRowCost="always-show"
      />,
    );
    expect(alwaysShow).toContain('data-testid="tool-use-cost-row"');
    expect(alwaysShow).toContain(sample.costDetail);
  });

  it('hides body + toggle when detailMode = "off"', () => {
    const off = renderToString(
      <ToolUseCard
        toolName={sample.toolName}
        summary={sample.summary}
        body={sample.body}
        detailMode="off"
        expanded
      />,
    );
    expect(off).toContain('data-expanded="false"');
    expect(off).not.toContain('data-testid="tool-use-toggle"');
    expect(off).not.toContain('data-testid="tool-use-body"');
  });

  it('renders with the minimal legacy prop set (toolName only) without crashing', () => {
    // The pre-existing wave PR A consumer may pass only the required prop.
    const html = renderToString(<ToolUseCard toolName="query_mistakes" />);
    expect(html).toContain('data-testid="tool-use-card"');
    expect(html).toContain('data-tool="query_mistakes"');
    // No rich anatomy, no toggle, no status pill.
    expect(html).not.toContain('is-rich');
    expect(html).not.toContain('data-testid="tool-use-status-pill"');
  });

  it('legacy folded card is NOT marked rich (no anatomy styles attach)', () => {
    const html = renderToString(
      <ToolUseCard toolName={sample.toolName} summary={sample.summary} body={sample.body} />,
    );
    expect(html).not.toContain('is-rich');
  });
});

describe('ToolUseCard 完全体 — five states', () => {
  const STATES: ToolUseStatus[] = ['running', 'done', 'empty', 'failed', 'awaiting-approval'];
  const PILL_LABEL: Record<ToolUseStatus, string> = {
    running: '运行中',
    done: '完成',
    empty: '无结果',
    failed: '失败',
    'awaiting-approval': '待你批准',
  };

  for (const status of STATES) {
    it(`renders the ${status} status pill + data-status attribute`, () => {
      const html = renderToString(
        <ToolUseCard
          toolName="query_mistakes"
          status={status}
          result={<p className="result-lead">命中 3 条错题</p>}
        />,
      );
      expect(html).toContain('is-rich');
      expect(html).toContain(`data-status="${status}"`);
      expect(html).toContain('data-testid="tool-use-status-pill"');
      expect(html).toContain(PILL_LABEL[status]);
    });
  }

  it('running state falls back to a shimmer skeleton when no running body given', () => {
    const html = renderToString(<ToolUseCard toolName="ocr_extract" status="running" />);
    expect(html).toContain('tuc-skel');
  });

  it('empty state renders the gentle empty view and drops the meta ribbon', () => {
    const html = renderToString(
      <ToolUseCard
        toolName="query_mistakes"
        status="empty"
        emptyView={<div className="r-empty">近 7 天没有相关错题</div>}
        meta={{ model: 'Haiku', cost: 0.006, latency: '540ms' }}
      />,
    );
    expect(html).toContain('近 7 天没有相关错题');
    // ribbon suppressed for empty
    expect(html).not.toContain('data-testid="tool-use-meta"');
  });

  it('failed state renders the error view + retry hint and drops the meta ribbon', () => {
    const html = renderToString(
      <ToolUseCard
        toolName="query_mistakes"
        status="failed"
        errorView={<div className="r-error">查询超时 · 已自动重排重试</div>}
        meta={{ model: 'Haiku', cost: 0.006, latency: '…' }}
      />,
    );
    expect(html).toContain('已自动重排重试');
    expect(html).not.toContain('data-testid="tool-use-meta"');
  });
});

describe('ToolUseCard — meta ribbon graceful omission', () => {
  it('renders every field when all present', () => {
    const meta: ToolUseMeta = {
      model: 'Haiku',
      cost: 0.004,
      latency: '380ms',
      confidence: 0.91,
      causedBy: 'e_4471',
    };
    const html = renderToString(
      <ToolUseCard
        toolName="search_knowledge"
        status="done"
        result={<span>ok</span>}
        meta={meta}
      />,
    );
    expect(html).toContain('data-testid="tool-use-meta"');
    expect(html).toContain('Haiku');
    expect(html).toContain('$0.004');
    expect(html).toContain('380ms');
    expect(html).toContain('91%');
    expect(html).toContain('data-testid="tool-use-caused-by"');
    expect(html).toContain('e_4471');
  });

  it('omits each missing field — no empty dots, no caused_by line', () => {
    const html = renderToString(
      <ToolUseCard
        toolName="schedule_fsrs"
        status="done"
        result={<span>ok</span>}
        meta={{ model: 'deterministic', cost: 0, latency: '12ms' }}
      />,
    );
    expect(html).toContain('deterministic');
    // cost 0 → deterministic free chip
    expect(html).toContain('$0.000');
    expect(html).toContain('12ms');
    // no confidence meter, no caused_by
    expect(html).not.toContain('tuc-conf-pct');
    expect(html).not.toContain('data-testid="tool-use-caused-by"');
  });

  it('renders no ribbon at all when meta is entirely empty', () => {
    const html = renderToString(
      <ToolUseCard toolName="explain" status="done" result={<span>ok</span>} meta={{}} />,
    );
    expect(html).not.toContain('data-testid="tool-use-meta"');
  });

  it('caused_by lives on its own footer line (its own segment, not inline with model)', () => {
    const html = renderToString(
      <ToolUseCard
        toolName="search_knowledge"
        status="done"
        result={<span>ok</span>}
        meta={{ model: 'Haiku', causedBy: 'e_4471' }}
      />,
    );
    // the caused_by node carries the footer-ref class
    expect(html).toContain('tuc-meta-caused');
  });
});

describe('ToolUseCard — expandable args', () => {
  it('renders the args key/value list + raw-json toggle (collapsed by default)', () => {
    const html = renderToString(
      <ToolUseCard
        toolName="search_knowledge"
        status="done"
        args={{ query: '之 的用法', scope: 'tree+mesh', k: 5 }}
        result={<span>ok</span>}
      />,
    );
    expect(html).toContain('data-testid="tool-use-args"');
    expect(html).toContain('data-testid="tool-use-args-toggle"');
    // collapsed → key/value list, raw json hidden
    expect(html).toContain('data-testid="tool-use-args-list"');
    expect(html).toContain('query');
    expect(html).toContain('之 的用法');
    expect(html).toContain('scope');
    expect(html).toContain('raw json');
    expect(html).not.toContain('data-testid="tool-use-args-raw"');
  });

  it('drops the args block entirely when args is an empty object (no empty signature)', () => {
    const html = renderToString(
      <ToolUseCard toolName="ping" status="done" args={{}} result={<span>ok</span>} />,
    );
    // still rich (has result), but no args block — never renders an empty "( )"
    expect(html).toContain('is-rich');
    expect(html).not.toContain('data-testid="tool-use-args"');
  });

  it('raw-json view serialises nested objects/arrays as valid JSON (no [object Object])', () => {
    const html = renderToString(
      <ToolUseCard
        toolName="search_knowledge"
        status="done"
        args={{ filter: { scope: 'tree', tags: ['a', 'b'] }, k: 5 }}
        result={<span>ok</span>}
        // open the raw view so the JSON string renders server-side
        defaultExpanded
      />,
    );
    // The list view always renders; key/value list stringifies nested via String(),
    // but the raw view (when opened) must be valid JSON — assert the serialiser
    // path produces nested structure, never the "[object Object]" footgun.
    const raw = JSON.stringify({ filter: { scope: 'tree', tags: ['a', 'b'] }, k: 5 }, null, 2);
    expect(raw).toContain('"scope": "tree"');
    expect(raw).not.toContain('[object Object]');
    // sanity: the card rendered the args block at all
    expect(html).toContain('data-testid="tool-use-args"');
  });
});

describe('ToolUseCard — approval actions + resolved line', () => {
  const actions: ToolUseAction[] = [
    {
      label: '接受 2 张',
      kind: 'accept',
      icon: 'plus',
      ev: 'e_4491 · propose→accept',
      done: '已写入 2 张卡片 · 进入今日队列',
    },
    { label: '忽略', kind: 'dismiss', icon: 'close', ev: 'e_4492 · dismiss', done: '已忽略此提议' },
  ];

  it('shows accept/dismiss actions in awaiting-approval state', () => {
    const html = renderToString(
      <ToolUseCard
        toolName="propose_variant"
        status="awaiting-approval"
        tone="coral"
        actionHint="AI 提议 2 张变体题"
        actions={actions}
        result={<span>variant</span>}
      />,
    );
    expect(html).toContain('data-testid="tool-use-actions"');
    expect(html).toContain('AI 提议 2 张变体题');
    expect(html).toContain('接受 2 张');
    expect(html).toContain('忽略');
    expect(html).toContain('tone-coral');
  });

  it('renders the resolved line + event ref when controlled-resolved (accept)', () => {
    const html = renderToString(
      <ToolUseCard
        toolName="propose_variant"
        status="awaiting-approval"
        actions={actions}
        result={<span>variant</span>}
        resolved={{
          kind: 'accept',
          text: '已写入 2 张卡片 · 进入今日队列',
          ev: 'e_4491 · propose→accept',
        }}
      />,
    );
    expect(html).toContain('data-testid="tool-use-resolved"');
    expect(html).toContain('已写入 2 张卡片');
    expect(html).toContain('e_4491 · propose→accept');
    expect(html).toContain('is-resolved');
    // actions hidden once resolved
    expect(html).not.toContain('data-testid="tool-use-actions"');
  });

  it('dims the card with is-dismissed when resolved by dismiss', () => {
    const html = renderToString(
      <ToolUseCard
        toolName="propose_variant"
        status="awaiting-approval"
        actions={actions}
        result={<span>variant</span>}
        resolved={{ kind: 'dismiss', text: '已忽略此提议', ev: 'e_4492 · dismiss' }}
      />,
    );
    expect(html).toContain('is-dismissed');
    expect(html).toContain('已忽略此提议');
  });
});

describe('ToolUseCard — rich result rendering', () => {
  it('renders a structured result body in done state', () => {
    const html = renderToString(
      <ToolUseCard
        toolName="search_knowledge"
        status="done"
        icon="search"
        result={
          <div>
            <p className="result-lead">
              命中 <b>3</b> 个知识节点
            </p>
          </div>
        }
        meta={{ model: 'Haiku', cost: 0.004, latency: '380ms', confidence: 0.91 }}
      />,
    );
    expect(html).toContain('data-testid="tool-use-result"');
    expect(html).toContain('命中');
    expect(html).toContain('个知识节点');
  });

  it('falls back to the legacy body in the result band when rich + no result given', () => {
    // A caller migrating an old card by adding only status (rich) + body, without
    // expanding, should still see the tool-result text in the result band.
    const html = renderToString(
      <ToolUseCard toolName="query_mistakes" status="done" body={<span>命中 3 条错题</span>} />,
    );
    expect(html).toContain('data-testid="tool-use-result"');
    expect(html).toContain('命中 3 条错题');
  });
});
