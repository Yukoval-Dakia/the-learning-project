import { describe, expect, it } from 'vitest';
import { aiTaskLabel, deriveThreads, learnerFailureSummary } from './TodayPage';

function summaryProposalFixture(decisionTotal: number, hasMore: boolean) {
  return {
    proposals: {
      total: 50_000,
      decision_total: decisionTotal,
      by_kind: {},
      has_more: hasMore,
      limit: 50_000,
      status: 'pending',
    },
    kpi: {
      due_count: 0,
      pending_attribution_count: 0,
      knowledge_count: 0,
      goal_count: 0,
    },
    cold_start: {
      is_empty: false,
      evidence: {
        active_goal: false,
        goal_history: false,
        knowledge: false,
        question: false,
        source_material: false,
        artifact: false,
        review_due: false,
        pending_attribution: false,
        practice_stream: false,
        proposal: false,
        learning_session: false,
        user_event: false,
      },
    },
    active_goal: null,
    active_sessions: [],
    week_heat: [],
  } satisfies Parameters<typeof deriveThreads>[0];
}

describe('Today dynamic learner copy', () => {
  it('maps implementation task kinds to stable product labels', () => {
    expect(aiTaskLabel('CoachTask')).toBe('学习辅导');
    expect(aiTaskLabel('quiz_verify')).toBe('判题与核对');
    expect(aiTaskLabel('memory_brief_regen')).toBe('学习摘要');
    expect(aiTaskLabel('brand_new_internal_worker')).toBe('其他 AI 工作');
  });

  it.each([
    [['Claude Code process exited with code 1'], 'AI 运行环境中断，任务没有完成。'],
    [['request timed out after 30000ms'], 'AI 处理超时，任务没有完成。'],
    [['429 too many requests'], 'AI 服务当前繁忙，任务没有完成。'],
    [['401 invalid api key'], 'AI 服务连接配置异常，任务没有完成。'],
    [['fetch failed: ECONNRESET'], 'AI 服务连接中断，任务没有完成。'],
    [['invalid JSON output'], 'AI 返回的内容无法读取，任务没有完成。'],
    [['opaque provider failure'], 'AI 运行失败；技术详情已保留在管理页。'],
  ])('turns raw runtime failures into an actionable learner summary', (messages, expected) => {
    const summary = learnerFailureSummary(messages);
    expect(summary).toBe(expected);
    expect(summary).not.toMatch(/Claude Code|process exited|api key|ECONN|invalid JSON|\b\d{3}\b/i);
  });

  it('keeps the Inbox reachable when the decision count is a truncated lower bound', () => {
    const threads = deriveThreads(summaryProposalFixture(0, true));

    expect(threads).toMatchObject([
      {
        id: 'inbox',
        title: '提议队列需要检查',
        sub: '计数已达扫描上限，可能仍有待裁决项。',
        badge: '待检查',
        route: '/inbox',
      },
    ]);
  });
});
