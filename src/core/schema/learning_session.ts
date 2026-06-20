import { z } from 'zod';

// ====================================================================
// LearningSession 多态 envelope (ADR-0008 + ADR-0005 演化)
// ====================================================================
//
// 6 种 session type。Phase 1c.1 仅实装 ingestion / review / conversation 状态机；
// tutor / explore / create 占位（enum 已固化，行为延后到 Phase 1d/2）。

export const LearningSessionType = z.enum([
  'ingestion',
  'review',
  'tutor',
  'explore',
  'create',
  'conversation',
  'placement',
]);
export type LearningSessionTypeT = z.infer<typeof LearningSessionType>;

// ---------- per-type status enums ----------

// ingestion 状态机（沿用 ADR-0005）：
// uploaded → queued → extracting → extracted | partial | failed → reviewed → imported
export const IngestionStatus = z.enum([
  'uploaded',
  'queued',
  'extracting',
  'extracted',
  'partial',
  'failed',
  'reviewed',
  'imported',
]);
export type IngestionStatusT = z.infer<typeof IngestionStatus>;

// review 状态机：started ⇄ paused → completed | abandoned (↳ reopened → started)
//
// 'paused' 自 YUK-57 起就由 src/server/session/review.ts 写入/读出（pauseReview-
// Session / resumeReviewSession），但本 Zod enum 一直漏了它，导致
// LearningSessionStatusByType.parse({type:'review',status:'paused'}) 抛错。
// U5 (YUK-203) 补齐——paper attempt session 走 review 状态机，practice 列表读时
// 过 Zod 校验，paused 卷会爆。这同时修了既有 YUK-57 drift，非仅 paper 需要。
export const ReviewStatus = z.enum(['started', 'paused', 'completed', 'abandoned']);
export type ReviewStatusT = z.infer<typeof ReviewStatus>;

// conversation 状态机 (ADR-0008 + YUK-14 / docs/design/2026-05-24-teaching-idle-state-machine.md)：
//   active <-> idle  → ended | abandoned
//
// active   : drawer open, recent user/agent activity
// idle     : drawer still open, no user message for ≥ IDLE_MS (5 min default)
// ended    : terminal — explicit close, drawer unmount, pagehide(active)
// abandoned: terminal — pagehide(idle), orphan cron (>6h still active|idle)
export const ConversationStatus = z.enum(['active', 'idle', 'ended', 'abandoned']);
export type ConversationStatusT = z.infer<typeof ConversationStatus>;

// tutor 状态机 (YUK-193 解题陪练 / docs/superpowers/specs/2026-06-01-solve-tutor-design.md §3.1)：
//   active → submitted → judged → ended  (+ abandoned terminal)
// active   : 会话已开，可请求 hint / 提交作答
// submitted: 已收到一次作答提交，判分进行中（瞬态，submit 路由内同事务推进到 judged）
// judged   : 已判分 + 已揭示参考解
// ended    : 终态 —— 正常收尾
// abandoned: 终态 —— 放弃 / orphan
export const TutorStatus = z.enum(['active', 'submitted', 'judged', 'ended', 'abandoned']);
export type TutorStatusT = z.infer<typeof TutorStatus>;

// placement 状态机 (YUK-468 cold-start inc-B / docs/design/2026-06-20-cold-start-day-one-design.md §2 步骤3)：
//   started → completed | abandoned
// 一次性有界第一会话流（每科 ~8 题，cap 防疲劳 + 可选 θ SE 收敛即停）。**没有** paused /
// reopened —— 不同于 review：placement probe 不暂停续答（中断即 abandoned，可重开新一轮）。
// started  : 会话已开，逐题选→判→收紧 θ̂/p(L)。
// completed: 终态 —— 达终止条件（题数 cap 或 SE 收敛），画像落地。
// abandoned: 终态 —— 中途放弃 / orphan cron 扫。
export const PlacementStatus = z.enum(['started', 'completed', 'abandoned']);
export type PlacementStatusT = z.infer<typeof PlacementStatus>;

// explore / create —— 占位 enum，状态待定。**绝不**用 z.string() 兜底，
// 也不留空 enum。Phase 1d/2 第一次实装时再展开。先用 'placeholder' 单值标记，避免
// 误把任意字符串吞进生产数据。
export const ExploreStatus = z.enum(['placeholder']);
export type ExploreStatusT = z.infer<typeof ExploreStatus>;

export const CreateStatus = z.enum(['placeholder']);
export type CreateStatusT = z.infer<typeof CreateStatus>;

// ---------- LearningSessionStatusByType ----------
//
// 按 type discriminator 切分 status 命名空间。这是个标识 schema —— 业务层用
// LearningSessionStatusByType.parse({type, status}) 校验 (type, status) 组合合法。

export const LearningSessionStatusByType = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ingestion'), status: IngestionStatus }),
  z.object({ type: z.literal('review'), status: ReviewStatus }),
  z.object({ type: z.literal('conversation'), status: ConversationStatus }),
  z.object({ type: z.literal('tutor'), status: TutorStatus }),
  z.object({ type: z.literal('placement'), status: PlacementStatus }),
  z.object({ type: z.literal('explore'), status: ExploreStatus }),
  z.object({ type: z.literal('create'), status: CreateStatus }),
]);
export type LearningSessionStatusByTypeT = z.infer<typeof LearningSessionStatusByType>;
