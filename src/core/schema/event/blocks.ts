import { z } from 'zod';
import { CauseCategoryId, CauseSchema as CauseSchemaBase } from '../cause';

// ---------- ActorKind ----------
//
// 谁触发了这个 event。ADR-0006 v2 / 0007 — 单用户 actor='self'；agent / cron / system
// 由后端写入路径填。

export const ActorKind = z.enum(['user', 'agent', 'cron', 'system']);
export type ActorKindT = z.infer<typeof ActorKind>;

// ---------- SubjectKind ----------
//
// event 落在哪种 material / 元事件上。ADR-0006 v2 + 0010 (knowledge_edge) + 0011
// (chip / query)。注意：'event' 表自我引用（judge / rate 作用在 prior event 上）。

export const SubjectKind = z.enum([
  'question',
  'knowledge',
  'knowledge_edge',
  'artifact',
  'source_document',
  'record',
  'memory_brief',
  'event',
  'chip',
  'query',
]);
export type SubjectKindT = z.infer<typeof SubjectKind>;

// ---------- MaterialRef ----------
//
// 一个 polymorphic 指针，用于 payload 内部交叉引用 material。kind discriminant 锁
// 引用类型；id 是被引 material 的主键。

export const MaterialRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('question'), id: z.string() }),
  z.object({ kind: z.literal('knowledge'), id: z.string() }),
  z.object({ kind: z.literal('knowledge_edge'), id: z.string() }),
  z.object({ kind: z.literal('artifact'), id: z.string() }),
  z.object({ kind: z.literal('source_document'), id: z.string() }),
  z.object({ kind: z.literal('record'), id: z.string() }),
  z.object({ kind: z.literal('memory_brief'), id: z.string() }),
]);
export type MaterialRefT = z.infer<typeof MaterialRef>;

// ---------- CauseSchema ----------
//
// ADR-0006 v2 原 10 类 cause + analysis_md + confidence(0-1)。
// 与 src/core/schema/business.ts 的 Cause 等价但更紧 —— 这里用于 event.payload，
// 走 jsonb roundtrip，字段命名按 v2 spec 对齐（analysis_md / confidence 顶级）。

export const CauseCategory = CauseCategoryId;
export const CauseSchema = CauseSchemaBase;
export type CauseCategoryT = z.infer<typeof CauseCategory>;
export type CauseSchemaT = z.infer<typeof CauseSchema>;

// ---------- FsrsStateSchema ----------
//
// ts-fsrs v5 Card 的 JSON dump。jsonb roundtrip 安全 —— z.coerce.date() 把 ISO 串
// 自动转回 Date。elapsed_days 在 ts-fsrs v6 deprecated，保 optional 以便 forward
// compatibility。

export const FsrsCardState = z.enum(['new', 'learning', 'review', 'relearning']);
export type FsrsCardStateT = z.infer<typeof FsrsCardState>;

export const FsrsStateSchema = z.object({
  due: z.coerce.date(),
  stability: z.number(),
  difficulty: z.number(),
  elapsed_days: z.number().optional(),
  scheduled_days: z.number(),
  learning_steps: z.number(),
  reps: z.number().int(),
  lapses: z.number().int(),
  state: FsrsCardState,
  last_review: z.coerce.date().nullable(),
});
export type FsrsStateSchemaT = z.infer<typeof FsrsStateSchema>;

// ---------- RelationTypeSchema ----------
//
// ADR-0010 — 5 个核心 relation_type + experimental:* 命名空间逃逸阀。新关系按 ADR-0006
// v2 Option 折中规则：experimental:* 先跑稳，再 promote 到核心 enum。

export const CoreRelationType = z.enum([
  'prerequisite',
  'related_to',
  'contrasts_with',
  'applied_in',
  'derived_from',
]);
export type CoreRelationTypeT = z.infer<typeof CoreRelationType>;

export const ExperimentalRelationType = z.string().refine((s) => s.startsWith('experimental:'), {
  message: 'experimental relation_type must start with "experimental:"',
});

export const RelationTypeSchema = z.union([CoreRelationType, ExperimentalRelationType]);
export type RelationTypeSchemaT = z.infer<typeof RelationTypeSchema>;
