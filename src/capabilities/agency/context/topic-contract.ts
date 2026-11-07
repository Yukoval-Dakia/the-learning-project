import { z } from 'zod';
export const DIGEST_SCOPE = 'global:digest';
export const CONTEXT_CHANGE = 'experimental:context_change';
export const TALK_TOPIC = 'communication';
export const EDIT_MAX_PATCHES = 3;
export const EDIT_MAX_REPLACEMENTS = 3;
export const FACT_PRESENTATION_RULES =
  '主题名、说明和事实正文都直接给学习者看，只写具体事实，用自然白话。不要写来源、优先级或执行说明；直接陈述事实，不在正文复述是谁说的、哪一轮说的或是否属于纠正。原话未提及的情况不能变成新事实，也不要用“尚未说明”一类措辞自行补出这些情况。内部组件名、服务名和日志字段要转成学习者能理解的实际行为或结果，不照抄内部名称。无法确认含义时如实保留不确定性，不编造细节。必须保留具体经历、成功、失败、次数和先后，不能靠删掉整段来消除系统词。';
export const LEARNER_EDIT_RULES =
  '落实这句话涉及的全部更正，可以涉及多个主题或同主题多条事实，不要只挑一处。同主题独立事实分别提交 patch。由你判断相关主题；含义不能可靠关联到具体旧事实时，只保留本句明确陈述，或把需要澄清的要求列入 remaining_changes，不替学习者推翻既有事实。整体感受不证明具体能力或经历发生变化。指定 topic_key 时固定该主题。一次调用完整提交这些 patch，新建主题不能替换旧事实。不清理、压缩或改写无关事实。沟通摘要完整保留本句没改的偏好。若工具返回 edit_scope_exceeded 或 unmergeable，按提示缩小范围或把不能合并的事实分成独立 patch，重试一次，未能保存的要求逐项放进 remaining_changes，不能静默舍弃或说全部完成；即使尚未遇到范围错误，知道只完成一部分也必须填写 remaining_changes。只有逐项确认本句全部要求都被这些 patch 覆盖且没有剩余时才设置 request_complete=true，否则为 false。成功提交后停止写入。';
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
export const ChangeIssues = z.array(
  z.object({
    kind: z.enum(['unmergeable', 'correction_protected', 'edit_scope_exceeded']),
    detail: z.string(),
  }),
);
export const ChangeResult = z.object({
  status: z.enum(['changed', 'unchanged', 'issue']),
  change_id: z.string().nullable(),
  version: z.number().int(),
  before: z.array(Topic),
  after: z.array(Topic),
  issues: ChangeIssues,
  remaining_changes: z.array(z.string()).default([]),
  request_complete: z.boolean().default(false),
});
export type ChangeResultT = z.infer<typeof ChangeResult>;
/**
 * What a context write tool tells the model (YUK-1984). The full before/after
 * snapshot has one owner — the `context_change` event ledger — and the learner
 * HTTP responses that read it. Echoing it into the tool result put the whole
 * digest into the prompt a second and third time on every write turn; this
 * carries only the outcome, the version the next CAS write needs, repair
 * issues, and the facts this write actually added or replaced.
 */
export const ChangeReceipt = z.object({
  status: z.enum(['changed', 'unchanged', 'issue']),
  version: z.number().int(),
  issues: ChangeIssues,
  remaining_changes: z.array(z.string()).default([]),
  request_complete: z.boolean().default(false),
  changed_topics: z
    .array(
      z.object({
        key: z.string(),
        name: z.string(),
        /** Facts in the topic after this write. */
        facts: z.number().int(),
        added: z.array(z.object({ id: z.string(), body: z.string() })),
        /** Fact ids this write superseded or dropped. */
        replaced: z.array(z.string()),
      }),
    )
    .default([]),
});
export type ChangeReceiptT = z.infer<typeof ChangeReceipt>;

/** Only a committed change lists written topics; rejected batches wrote nothing. */
export function changeReceipt(change: ChangeResultT): ChangeReceiptT {
  const receipt: ChangeReceiptT = {
    status: change.status,
    version: change.version,
    issues: change.issues,
    remaining_changes: change.remaining_changes,
    request_complete: change.request_complete,
    changed_topics: [],
  };
  if (change.status !== 'changed') return receipt;
  const before = new Map(change.before.map((topic) => [topic.key, topic]));
  for (const topic of change.after) {
    const old = before.get(topic.key);
    before.delete(topic.key);
    const oldBodies = new Map((old?.facts ?? []).map((fact) => [fact.id, fact.body]));
    const bodies = new Map(topic.facts.map((fact) => [fact.id, fact.body]));
    const added = topic.facts
      .filter((fact) => oldBodies.get(fact.id) !== fact.body)
      .map((fact) => ({ id: fact.id, body: fact.body }));
    const replaced = (old?.facts ?? [])
      .filter((fact) => bodies.get(fact.id) !== fact.body)
      .map((fact) => fact.id);
    const metadataChanged =
      old !== undefined &&
      (old.name !== topic.name ||
        old.description !== topic.description ||
        old.scope_key !== topic.scope_key);
    if (old === undefined || added.length > 0 || replaced.length > 0 || metadataChanged)
      receipt.changed_topics.push({
        key: topic.key,
        name: topic.name,
        facts: topic.facts.length,
        added,
        replaced,
      });
  }
  for (const topic of before.values())
    receipt.changed_topics.push({
      key: topic.key,
      name: topic.name,
      facts: 0,
      added: [],
      replaced: topic.facts.map((fact) => fact.id),
    });
  return receipt;
}
