// S8 (YUK-335 audit §2 P3) — 活动时间线 event 行人话化。
// 本模块抽成无 React 依赖的纯函数，便于就近 unit 测（见 humanize-activity.unit.test.ts）。
// 上下文：本页（/knowledge/$id）即该知识节点，timeline 已按 referenced_knowledge_ids
// 过滤到本节点，且 wire 字段无主题名 —— 故人话句不点名主题（「这道题」即可），
// 绝不 fabricate 主题名，绝不裸渲 actor_kind / subject_kind 原 token。

import type { NodePageTimelineEntry } from './knowledge-api';

// action 下划线 token → 可读动词（fallback 路径用）。未命中走通用下划线转空格。
const ACTION_VERB: Record<string, string> = {
  created: '创建',
  updated: '更新',
  deleted: '删除',
  reviewed: '复习',
  practiced: '练习',
  answered: '作答',
  judged: '评判',
  graded: '评分',
  proposed: '提议',
  accepted: '采纳',
  rejected: '驳回',
  retracted: '撤回',
  generated: '生成',
  verified: '校验',
  linked: '关联',
  unlinked: '解除关联',
  merged: '合并',
  split: '拆分',
};

// subject_kind token → 可读名（fallback 路径用）。
const SUBJECT_NOUN: Record<string, string> = {
  question: '题目',
  note: '笔记',
  artifact: '笔记',
  knowledge: '知识结构',
  learning_item: '学习项',
  mistake: '错题',
  session: '会话',
  review: '复习',
  proposal: '提议',
};

function readableAction(action: string): string {
  const key = action.toLowerCase();
  if (ACTION_VERB[key]) return ACTION_VERB[key];
  // 已知动词前缀（如 judge_question / judge_freetext）取首段映射。
  const head = key.split('_')[0];
  if (ACTION_VERB[head]) return ACTION_VERB[head];
  // 兜底：下划线转空格，绝不裸渲原 token 的下划线形态。
  return action.replace(/_/g, ' ');
}

function readableSubject(subjectKind: string): string {
  return SUBJECT_NOUN[subjectKind] ?? subjectKind.replace(/_/g, ' ');
}

/**
 * 把一条活动 event 映射成中文人话句。本页即该知识节点，句子不点主题名。
 * 映射优先级：先按高频组合（用户练题 / AI 评判 / 笔记 / 知识结构）给定型句，
 * 其余落 fallback「<动词>了<名词>」，对未知 action/subject 始终安全可读。
 */
export function humanizeActivity(a: NodePageTimelineEntry): string {
  const actor = a.actor_kind;
  const subject = a.subject_kind;
  const action = a.action.toLowerCase();
  const isAi = actor === 'ai' || actor === 'agent';

  // 用户在题目上的练习 —— 三态由 outcome 决定。
  if (actor === 'user' && subject === 'question') {
    if (a.outcome === 'success') return '答对了一道题';
    if (a.outcome === 'failure') return '答错了一道题';
    return '练了一道题';
  }

  // AI / agent 评判（judge / judge_* 等）。
  if (isAi && action.startsWith('judge')) return 'AI 评了一次';

  // 笔记 / artifact 更新。
  if (subject === 'note' || subject === 'artifact') {
    if (action.startsWith('creat') || action.startsWith('generat')) return '新建了一篇笔记';
    return '更新了一篇笔记';
  }

  // 知识结构调整。
  if (subject === 'knowledge') return '调整了知识结构';

  // AI 其它动作 —— 按 action 给可读句，标明是 AI。
  if (isAi) return `AI ${readableAction(action)}了${readableSubject(subject)}`;

  // 通用 fallback：<动词>了<名词>，永不裸渲原 token。
  return `${readableAction(action)}了${readableSubject(subject)}`;
}
