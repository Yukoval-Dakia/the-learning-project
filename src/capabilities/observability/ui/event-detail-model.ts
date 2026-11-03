import { type LucideIcon, Moon, Sparkles, User, Zap } from 'lucide-react';
import type { z } from 'zod';
import type { EventDetailResponseSchema } from '../api/event-contracts';

// Tone vocabulary of the event and correction labels (was LoomBadgeTone, the old badge's tone
// set; the badge left with Today's move to M3E, YUK-1713). EventDetailPage maps it to ui-next roles.
type LoomBadgeTone = 'neutral' | 'coral' | 'info' | 'good' | 'hard' | 'again';

export type EventDetailResponse = z.infer<typeof EventDetailResponseSchema>;
export type EventDetailRow = EventDetailResponse['event'];
export type EventCorrectionStatus = EventDetailResponse['correction_status'];
export type CorrectionState = EventCorrectionStatus['state'];

const ACTION_LABELS: Record<string, string> = {
  attempt: '作答',
  judge: '判题',
  review: '复习',
  correct: '纠正记录',
  propose: '提出建议',
  accept: '接受建议',
  dismiss: '暂不采用',
  retract: '撤回',
  create: '创建',
  update: '更新',
  delete: '删除',
  generate: '生成内容',
  verify: '核对内容',
  rate: '评价',
};

const OUTCOME_LABELS: Record<string, string> = {
  success: '成功',
  failure: '失败',
  partial: '部分完成',
  skipped: '已跳过',
  pending: '处理中',
};

const SUBJECT_LABELS: Record<string, string> = {
  question: '题目',
  question_part: '题目小问',
  knowledge: '知识点',
  knowledge_edge: '知识关系',
  event: '另一条记录',
  artifact: '笔记',
  note: '笔记',
  record: '学习记录',
  learning_item: '学习项',
  learning_session: '学习会话',
  goal: '学习目标',
  proposal: '建议',
};

const ACTOR_META: Record<string, { label: string; icon: LucideIcon }> = {
  user: { label: '你', icon: User },
  agent: { label: 'AI', icon: Sparkles },
  cron: { label: '定时任务', icon: Moon },
  system: { label: '系统', icon: Zap },
};

const CORRECTION_META: Record<CorrectionState, { label: string; tone: LoomBadgeTone }> = {
  active: { label: '当前有效', tone: 'good' },
  retracted: { label: '已撤回', tone: 'neutral' },
  marked_wrong: { label: '已标记为错误', tone: 'again' },
  superseded: { label: '已由新记录替代', tone: 'info' },
};

export function actionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  if (action.startsWith('experimental:')) return 'AI 分析';
  return '学习记录';
}

export function outcomeLabel(outcome?: string | null): string | null {
  if (!outcome) return null;
  return OUTCOME_LABELS[outcome] ?? '已记录';
}

export function subjectLabel(kind: string): string {
  return SUBJECT_LABELS[kind] ?? '学习对象';
}

export function actorMeta(kind: string): { label: string; icon: LucideIcon } {
  return ACTOR_META[kind] ?? { label: '系统', icon: Zap };
}

export function correctionMeta(state: CorrectionState): { label: string; tone: LoomBadgeTone } {
  return CORRECTION_META[state];
}

export function eventTone(event: Pick<EventDetailRow, 'action' | 'outcome'>): LoomBadgeTone {
  if (event.outcome === 'failure') return 'again';
  if (event.outcome === 'success') return 'good';
  if (event.outcome === 'partial') return 'hard';
  if (event.action === 'propose' || event.action.startsWith('experimental:')) return 'coral';
  return 'info';
}

export function subjectHref(
  event: Pick<EventDetailRow, 'subject_kind' | 'subject_id'>,
): string | null {
  const id = encodeURIComponent(event.subject_id);
  switch (event.subject_kind) {
    case 'question':
      return `/questions/${id}`;
    case 'knowledge':
      return `/knowledge/${id}`;
    case 'artifact':
    case 'note':
      return `/notes/${encodeURIComponent(id)}`;
    case 'event':
      return `/events/${id}`;
    default:
      return null;
  }
}
