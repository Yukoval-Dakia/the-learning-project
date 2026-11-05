// Context 模块共享类型（YUK-1794 B1：companion view 落地片）。

import type { ContextViewName } from '@/ai/task-spec';
import type { KnowledgeFailureStreak } from '@/kernel/read-models/learner-activity';

export type { ContextViewName };

/** 稳态段读数：memory brief 的 global scope（B1 读现成的，不生成）。 */
export interface SteadySection {
  communicationMd: string | null;
  overnightMd: string | null;
  /** global brief 的 recent_week_md，原文不改写；行不存在或非现行用途时为 null。 */
  portraitMd: string | null;
  /** Δ 段高水位：最近一次成功 Dreaming 固化时间；无固化记录时为固定回看窗下界。 */
  asOf: Date;
  /** 'dreaming' = 真实固化水位；'lookback' = 尚无 Dreaming，退回固定回看窗。 */
  asOfBasis: 'dreaming' | 'lookback';
}

export interface DeltaEventLine {
  at: Date;
  label: string;
}

/** 「今日待复习」明细一行：题干摘要 + 学习者可见知识点名。 */
export interface DueItemLine {
  stem: string;
  knowledgeNames: string[];
}

/** Δ 段读数：稳态段 as_of 之后的增量 + 今日到期 + 连错 + 最近活动。 */
export interface DeltaSection {
  asOf: Date;
  asOfBasis: 'dreaming' | 'lookback';
  counts: {
    answers: number;
    reviews: number;
    captures: number;
    decisions: number;
    steering: number;
    messages: number;
  };
  countsWindowLimited?: boolean;
  recent: DeltaEventLine[];
  /** 到期读数（上限 REVIEW_DUE_DISPLAY_CAP）；达到上限时 reviewDueOverCap=true，渲染「50+」。 */
  reviewDueCount: number;
  reviewDueOverCap: boolean;
  /** 到期队列前几条明细（题干摘要 + 知识点名），够回答「今天做什么」。 */
  dueItems: DueItemLine[];
  failureStreak: KnowledgeFailureStreak | null;
  lastActivityAt: Date | null;
}

/** 契约段读数：确定性读模型的白话档。 */
export interface ContractSection {
  steeringMd: string | null;
  masteryMd: string | null;
  causesMd: string | null;
  /** 最近失败逐条原因（可裁明细，独立于聚合错因行单独成 unit）。 */
  failureDetailsMd: string | null;
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
