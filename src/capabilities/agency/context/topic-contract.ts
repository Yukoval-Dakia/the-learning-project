import { z } from 'zod';
export const DIGEST_SCOPE = 'global:digest';
export const CONTEXT_CHANGE = 'experimental:context_change';
export const TALK_TOPIC = 'communication';
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
    z.object({ kind: z.enum(['unmergeable', 'correction_protected']), detail: z.string() }),
  ),
});
