// Context 模块共享类型（YUK-1794 B1：companion view 落地片）。

import type { ContextViewName } from '@/ai/task-spec';
import type { KnowledgeFailureStreak } from '@/kernel/read-models/learner-activity';

export type { ContextViewName };

/** 稳态段读数：memory brief 的 global scope（B1 读现成的，不生成）。 */
export interface SteadySection {
  /** global brief 的 recent_week_md，原文不改写；行不存在或非现行用途时为 null。 */
  portraitMd: string | null;
  /** Δ 段高水位 = brief 覆盖到的最新证据时间（无证据时间退 refreshed_at）。 */
  asOf: Date | null;
}

export interface DeltaEventLine {
  at: Date;
  label: string;
}

/** Δ 段读数：稳态段 as_of 之后的增量 + 今日到期 + 连错 + 最近活动。 */
export interface DeltaSection {
  asOf: Date | null;
  counts: {
    answers: number;
    reviews: number;
    captures: number;
    decisions: number;
    steering: number;
    messages: number;
  };
  recent: DeltaEventLine[];
  reviewDueCount: number;
  failureStreak: KnowledgeFailureStreak | null;
  lastActivityAt: Date | null;
}

/** 契约段读数：确定性读模型的白话档。 */
export interface ContractSection {
  steeringMd: string | null;
  masteryMd: string | null;
  causesMd: string | null;
  signalsMd: string[];
  overnightMd: string | null;
}

/** `loadLearnerContext` 的返回值：渲染好的启动段 + 验收用的元数据。 */
export interface LearnerContextAssembly {
  view: ContextViewName;
  markdown: string;
  estimatedTokens: number;
  asOf: string | null;
}
