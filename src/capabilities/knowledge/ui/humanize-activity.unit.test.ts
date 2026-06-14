// S8 (YUK-335 §2 P3) — humanizeActivity 纯函数单测。无 DB/AI/R2/React 依赖 → unit 分区。
// 守住两条红线：①绝不裸渲 actor_kind/subject_kind/action 原 token；②未知组合给安全可读 fallback。

import { describe, expect, it } from 'vitest';
import { humanizeActivity } from './humanize-activity';
import type { NodePageTimelineEntry } from './knowledge-api';

function ev(over: Partial<NodePageTimelineEntry>): NodePageTimelineEntry {
  return {
    event_id: 'e1',
    action: 'created',
    subject_kind: 'note',
    actor_kind: 'user',
    outcome: null,
    created_at: '2026-06-13T00:00:00.000Z',
    ...over,
  };
}

describe('humanizeActivity', () => {
  it('user + question 三态由 outcome 决定，不点主题名', () => {
    expect(
      humanizeActivity(ev({ actor_kind: 'user', subject_kind: 'question', outcome: 'success' })),
    ).toBe('答对了一道题');
    expect(
      humanizeActivity(ev({ actor_kind: 'user', subject_kind: 'question', outcome: 'failure' })),
    ).toBe('答错了一道题');
    expect(
      humanizeActivity(ev({ actor_kind: 'user', subject_kind: 'question', outcome: null })),
    ).toBe('练了一道题');
  });

  it('ai/agent judge / judge_* → AI 评了一次', () => {
    expect(
      humanizeActivity(ev({ actor_kind: 'ai', action: 'judge', subject_kind: 'question' })),
    ).toBe('AI 评了一次');
    expect(
      humanizeActivity(
        ev({ actor_kind: 'ai', action: 'judge_freetext', subject_kind: 'question' }),
      ),
    ).toBe('AI 评了一次');
    expect(
      humanizeActivity(ev({ actor_kind: 'agent', action: 'judge_mcq', subject_kind: 'question' })),
    ).toBe('AI 评了一次');
  });

  it('note / artifact subject → 笔记句，创建 vs 更新分流', () => {
    expect(humanizeActivity(ev({ subject_kind: 'note', action: 'updated' }))).toBe(
      '更新了一篇笔记',
    );
    expect(humanizeActivity(ev({ subject_kind: 'note', action: 'created' }))).toBe(
      '新建了一篇笔记',
    );
    expect(humanizeActivity(ev({ subject_kind: 'artifact', action: 'generated' }))).toBe(
      '新建了一篇笔记',
    );
    expect(humanizeActivity(ev({ subject_kind: 'artifact', action: 'edited' }))).toBe(
      '更新了一篇笔记',
    );
  });

  it('knowledge subject → 调整了知识结构', () => {
    expect(humanizeActivity(ev({ subject_kind: 'knowledge', action: 'linked' }))).toBe(
      '调整了知识结构',
    );
  });

  it('ai 其它动作 → 标明 AI + 可读动词 + 可读名词', () => {
    expect(
      humanizeActivity(ev({ actor_kind: 'ai', action: 'proposed', subject_kind: 'learning_item' })),
    ).toBe('AI 提议了学习项');
  });

  it('fallback：未知 action/subject 给安全可读句，绝不裸渲原 token', () => {
    const out = humanizeActivity(
      ev({ actor_kind: 'user', action: 'frobnicated', subject_kind: 'widget' }),
    );
    expect(out).toBe('frobnicated了widget');
    // 红线：下划线 token 永不直出原形态。
    const snake = humanizeActivity(
      ev({ actor_kind: 'user', action: 'some_weird_action', subject_kind: 'odd_thing' }),
    );
    expect(snake).toBe('some weird action了odd thing');
    expect(snake).not.toContain('_');
  });

  it('已知动词 token 走中文映射（user updated learning_item）', () => {
    expect(
      humanizeActivity(
        ev({ actor_kind: 'user', action: 'updated', subject_kind: 'learning_item' }),
      ),
    ).toBe('更新了学习项');
  });
});
