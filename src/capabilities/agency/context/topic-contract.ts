import { z } from 'zod';
export const DIGEST_SCOPE = 'global:digest';
export const CONTEXT_CHANGE = 'experimental:context_change';
export const TALK_TOPIC = 'communication';
export const FACT_PRESENTATION_RULES =
  '主题名、说明和事实正文都直接给学习者看，只写具体事实，用自然白话。不要写“学习者本轮自述”“优先级最高”“纠正信息”“以上均为”等来源、优先级或执行说明。保留事实不等于照抄日志术语或产品名。例如“Copilot 问答与工具调用”要表达成“向学习助手提问、使用相关功能”，“布置测评链路”要表达成“安排练习、提交并查看结果”，“提案部分成功”要表达成“建议的处理只完成了一部分”；这些是表达方式示例，不添加原文没有的经历。包括主题名和说明在内，都要把系统使用记录转成这样的白话，不原样留下内部名称、激活步骤或链路说法。必须保留成功、失败、次数、先后和不确定性，不能靠删掉整段来消除系统词。';
export const LEARNER_EDIT_RULES =
  'learner_correction 模式只落实本句相关的一处更正，由你判断相关主题；指定 topic_key 时只能改该主题。每次只提交一条 patch，最多替换该主题一条事实；新建主题不能替换旧事实。不清理、压缩或改写其他主题，不顺手删除推测或建议，这些留给定时整理。沟通摘要仍须完整保留本句没改的偏好。收到 edit_scope_exceeded 时缩小到本句相关的一条修改重试一次；成功后立即停止写入。';
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
});
