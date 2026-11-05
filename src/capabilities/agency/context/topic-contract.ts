import { z } from 'zod';
export const DIGEST_SCOPE = 'global:digest';
export const CONTEXT_CHANGE = 'experimental:context_change';
export const TALK_TOPIC = 'communication';
export const EDIT_MAX_PATCHES = 3;
export const EDIT_MAX_REPLACEMENTS = 3;
export const FACT_PRESENTATION_RULES =
  '主题名、说明和事实正文都直接给学习者看，只写具体事实，用自然白话。不要写来源、优先级或执行说明。内部组件名、服务名和日志字段要转成学习者能理解的实际行为或结果，不照抄内部名称。无法确认含义时如实保留不确定性，不编造细节。必须保留具体经历、成功、失败、次数和先后，不能靠删掉整段来消除系统词。';
export const LEARNER_EDIT_RULES =
  '落实这句话涉及的全部更正，可以涉及多个主题或同主题多条事实，不要只挑一处。同主题独立事实分别提交 patch。由你判断相关主题；指定 topic_key 时固定该主题。一次调用完整提交这些 patch，新建主题不能替换旧事实。不清理、压缩或改写无关事实。沟通摘要完整保留本句没改的偏好。若工具返回 edit_scope_exceeded，按返回的范围缩小重试一次，未能保存的要求逐项放进 remaining_changes，不能静默舍弃或说全部完成；即使尚未遇到范围错误，知道只完成一部分也必须填写 remaining_changes。只有逐项确认本句全部要求都被这些 patch 覆盖且没有剩余时才设置 request_complete=true，否则为 false。成功提交后停止写入。';
export const COMMUNICATION_RULES =
  '称呼、语气、偏好、persona 放在常驻主题 communication（怎么和我说话），只保存学习者表达的事实和偏好，不替学习者决定学习安排。该主题每次写入完整的沟通摘要（不超过四百字），合并既有仍有效的偏好与本轮新原话，不丢旧偏好；服务端以新版本替换旧摘要。';
const Fact = z.object({
  id: z.string(),
  body: z.string().min(1).max(400),
  kind: z.enum(['fact', 'correction']),
  memory_kind: z.enum(['preference', 'habit', 'weakness', 'event']),
  written_by: z.enum(['companion', 'curator', 'learner']),
  evidence_ids: z.array(z.string()),
  as_of: z.string(),
  supersedes: z.array(z.string()),
  knowledge_ids: z.array(z.string()).default([]),
});
export const Topic = z.object({
  key: z.string().min(1).max(100),
  scope_key: z.string().min(1).default('global'),
  name: z.string().min(1).max(80),
  description: z.string().max(160),
  facts: z.array(Fact),
  updated_at: z.string(),
});
export const Digest = z.object({
  format: z.literal(1),
  topics: z.array(Topic),
  as_of: z.string().nullable(),
  overnight: z.string().nullable(),
  legacy_global_version: z.number().int().nullable().default(null),
  withdrawals: z
    .array(
      z.object({
        key: z.string(),
        at: z.string(),
        evidence_ids: z.array(z.string()).default([]),
        retained_fact_ids: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});
export type DigestT = z.infer<typeof Digest>;
export type TopicT = z.infer<typeof Topic>;
export type FactT = z.infer<typeof Fact>;
export const TopicPatch = z.object({
  key: z.string().min(1).max(100),
  scope_key: z.string().min(1).default('global'),
  name: z.string().min(1).max(80),
  description: z.string().max(160),
  body: z.string().min(1).max(400),
  memory_kind: z.enum(['preference', 'habit', 'weakness', 'event']),
  replaces: z.array(z.string()).default([]),
  knowledge_ids: z.array(z.string()).default([]),
});
export type TopicPatchT = z.infer<typeof TopicPatch>;
export const ChangeResult = z.object({
  status: z.enum(['changed', 'unchanged', 'issue']),
  change_id: z.string().nullable(),
  version: z.number().int(),
  before: z.array(Topic),
  after: z.array(Topic),
  issues: z.array(
    z.object({
      kind: z.enum(['unmergeable', 'correction_protected', 'edit_scope_exceeded']),
      detail: z.string(),
    }),
  ),
  remaining_changes: z.array(z.string()).default([]),
  request_complete: z.boolean().default(false),
});
