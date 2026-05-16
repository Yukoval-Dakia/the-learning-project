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

// review 状态机：started → completed | abandoned
export const ReviewStatus = z.enum(['started', 'completed', 'abandoned']);
export type ReviewStatusT = z.infer<typeof ReviewStatus>;

// conversation 状态机 (ADR-0008 + ADR-0006 v2)：active → idle → ended
export const ConversationStatus = z.enum(['active', 'idle', 'ended']);
export type ConversationStatusT = z.infer<typeof ConversationStatus>;

// tutor / explore / create —— 占位 enum，状态待定。**绝不**用 z.string() 兜底，
// 也不留空 enum。Phase 1d/2 第一次实装时再展开。先用 'placeholder' 单值标记，避免
// 误把任意字符串吞进生产数据。
export const TutorStatus = z.enum(['placeholder']);
export type TutorStatusT = z.infer<typeof TutorStatus>;

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
  z.object({ type: z.literal('explore'), status: ExploreStatus }),
  z.object({ type: z.literal('create'), status: CreateStatus }),
]);
export type LearningSessionStatusByTypeT = z.infer<typeof LearningSessionStatusByType>;
