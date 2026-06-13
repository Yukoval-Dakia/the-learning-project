// M4-T6 (YUK-319/YUK-318)：收件箱 ui 数据层——统一 /api/proposals 的 wire
// 类型、kind 元数据（17 kind 全量）与决策 callers。
// 设计基准 docs/design/loom-refresh/project/data.jsx（KIND_META / REL_LABEL）：
// 设计稿只列 12 kind；defer / archive / judge_retraction / image_candidate /
// question_draft 5 个按同一 tone 语系补全（hard=节奏类、neutral=归档、
// coral=内容生成类），icon 取自 LoomIcon 既有名。

import { acceptSupportedProposalKinds } from '@/core/schema/proposal';
import { apiJson } from '@/ui/lib/api';

// ── kind 元数据（agency meta.ts 同形态：fallback-safe，绝不 throw） ──
export interface KindMeta {
  label: string;
  icon: string;
  tone: 'info' | 'coral' | 'good' | 'hard' | 'neutral';
}

export const KIND_META: Record<string, KindMeta> = {
  knowledge_node: { label: '知识节点', icon: 'knowledge', tone: 'info' },
  knowledge_edge: { label: '知识关系', icon: 'link', tone: 'info' },
  knowledge_mutation: { label: '知识变更', icon: 'refresh', tone: 'info' },
  learning_item: { label: '学习项', icon: 'items', tone: 'coral' },
  note_update: { label: '笔记更新', icon: 'pencil', tone: 'coral' },
  variant_question: { label: '变体题', icon: 'layers', tone: 'coral' },
  record_promotion: { label: '记录升格', icon: 'record', tone: 'good' },
  record_links: { label: '记录关联', icon: 'link', tone: 'good' },
  completion: { label: '完成判定', icon: 'checkCircle', tone: 'good' },
  relearn: { label: '重学建议', icon: 'review', tone: 'hard' },
  goal_scope: { label: '目标范围', icon: 'target', tone: 'hard' },
  block_merge: { label: '块合并', icon: 'merge', tone: 'hard' },
  defer: { label: '延后安排', icon: 'clock', tone: 'hard' },
  archive: { label: '归档建议', icon: 'archive', tone: 'neutral' },
  judge_retraction: { label: '判定撤回', icon: 'undo', tone: 'coral' },
  image_candidate: { label: '图题候选', icon: 'image', tone: 'coral' },
  question_draft: { label: '题目草稿', icon: 'quiz', tone: 'coral' },
};

export function kindMeta(kind: string): KindMeta {
  return KIND_META[kind] ?? { label: kind, icon: 'inbox', tone: 'neutral' };
}

// M4 review fix (YUK-319, codex P2)：dispatchAccept 对 defer / archive /
// judge_retraction 未实现 accept（400 unsupported_proposal_kind，归 YUK-44）；
// 卡片对这三个 kind 不渲 Accept CTA，只留忽略（dismiss kind-无关，安全）。
// 注意 legacy knowledge 事件可派生出 archive kind 进收件箱，门控不能省。
// 集合真身在 core（acceptSupportedProposalKinds），与 dispatchAccept 的漂移
// 由 inbox-meta.unit.test.ts 分区钉测拦住。
const acceptSupported: ReadonlySet<string> = new Set(acceptSupportedProposalKinds);

export function isAcceptSupported(kind: string): boolean {
  return acceptSupported.has(kind);
}

// 关系类型白话（设计稿 REL_LABEL 原文）。
export const REL_LABEL: Record<string, string> = {
  prerequisite: '前置 prerequisite',
  related_to: '相关 related_to',
  contrasts_with: '对比 contrasts_with',
  applied_in: '应用 applied_in',
  derived_from: '派生 derived_from',
};

// ── wire 类型（server ProposalInboxRow 的 JSON 投影；Date → ISO string） ──
export interface ProposalEvidenceRefWire {
  kind: 'event' | 'question' | 'knowledge' | 'artifact' | 'record';
  id: string;
}

// payload 是 AiProposalPayload 的 UI 投影：各 kind 的 proposed_change 形态
// 不同，这里只钉 UI 实际消费的公共字段，其余经 index signature 透传。
export interface ProposalPayloadWire {
  kind: string;
  reason_md: string;
  evidence_refs: ProposalEvidenceRefWire[];
  confidence?: number;
  proposed_change?: {
    from_knowledge_id?: string;
    to_knowledge_id?: string;
    relation_type?: string;
    weight?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ProposalInboxRow {
  id: string;
  kind: string;
  target: { subject_kind: string; subject_id: string | null };
  payload: ProposalPayloadWire;
  status: string;
  proposed_at: string;
  decided_at: string | null;
  actor_ref: string;
  task_run_id: string | null;
  cost_micro_usd: number | null;
  source_action: string;
  source_subject_kind: string;
  signals: Record<string, unknown> | null;
}

export const listProposals = () =>
  apiJson<{ rows: ProposalInboxRow[]; next_cursor: string | null }>(
    '/api/proposals?status=pending',
  );

export type ProposalDecision = 'accept' | 'reverse' | 'change_type' | 'dismiss';

export const decideProposal = (
  id: string,
  decision: ProposalDecision,
  opts: { newRelationType?: string; userNote?: string } = {},
) =>
  apiJson(`/api/proposals/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    body: JSON.stringify({
      decision,
      ...(opts.newRelationType ? { new_relation_type: opts.newRelationType } : {}),
      ...(opts.userNote ? { user_note: opts.userNote } : {}),
    }),
  });

export const retractProposal = (id: string) =>
  apiJson(`/api/proposals/${encodeURIComponent(id)}/retract`, { method: 'POST' });

// YUK-271 行为恢复（codex 验证轮 P2）：block_merge accept 在目标题块已离开
// draft 时，applier 软拒——返回 200 { stale: true } 且不写 rate event，提议
// 保持 pending。UI 不能把它当已接受；旧 inbox 的 isBlockMergeStale 随旧壳
// 删除，这里随新收件箱恢复。
export interface BlockMergeStaleResult {
  kind: 'block_merge';
  stale: true;
  skip_reason?: string;
}

export function isBlockMergeStale(data: unknown): data is BlockMergeStaleResult {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { kind?: unknown }).kind === 'block_merge' &&
    (data as { stale?: unknown }).stale === true
  );
}

// ── evidence 白话（设计稿 evidenceReadable 的真 wire 适配） ─────────
// 真 ProposalEvidenceRef 无策展 label，按 kind 给白话来源说明；knowledge /
// artifact 有 SPA 详情页可导航，其余 kind（event/question/record）的详情页
// 未迁 SPA，route=null 渲为纯文本。M5 错题本/事件链收编后补导航。
export function evidenceReadable(ref: ProposalEvidenceRefWire): {
  text: string;
  route: string | null;
} {
  switch (ref.kind) {
    case 'event':
      return { text: '源自一次 AI 判定事件', route: null };
    case 'question':
      return { text: '源自一道题目', route: null };
    case 'knowledge':
      return { text: '源自一个知识点', route: `/knowledge/${ref.id}` };
    case 'artifact':
      return { text: '源自一篇笔记', route: `/notes/${ref.id}` };
    case 'record':
      return { text: '源自一条学习记录', route: null };
    default:
      return { text: '来源记录', route: null };
  }
}

// S7 (YUK-335, audit §3.4)：block_merge 卡常带多枚同 kind 的 evidence_refs，
// evidenceReadable 把同 kind 映成同一句白话 → 渲成 N 枚一模一样的灰 disabled
// chip。按 readable 文案分组去重：每组保留首个 ref（route/disabled 逻辑不变）+
// 组内计数，count>1 时由 EvidenceChip 把数量并进文案。
export interface DedupedEvidence {
  ref: ProposalEvidenceRefWire;
  count: number;
}

export function dedupeEvidence(refs: ProposalEvidenceRefWire[]): DedupedEvidence[] {
  const groups = new Map<string, DedupedEvidence>();
  for (const ref of refs) {
    const key = evidenceReadable(ref).text;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, { ref, count: 1 });
    }
  }
  return [...groups.values()];
}

// S7 (YUK-335, audit §3.4 + §2 P3)：block_merge reason_md（9/16 卡）含真
// block-<cuid> 等不透明 ID，正文成 ID 墙，违设计原则「Readable evidence
// (no raw IDs up front)」。把 reason_md 切成 prose 段 + id-token 段（display-
// only，不改 AI 原词、不替换词义），ProposalCard 把 raw 段包进 <code .ev-rawid>
// 视觉去权重。正题（后端 reason 生成应写人话）是 backend follow-up，本切片只 UI 缓解。
//
// 安全正则只命中明显不透明 ID，不碰中文 / 正常英文 prose：
//   block-<12+ 位小写字母数字>（cuid2 = 24 位，留余量到 12）
//   命名空间 ID <小写词>:<8+ 位 [a-z0-9:_-]>（如 synthetic:wenyan:...）
//   裸长串 <20+ 位小写字母数字>（词边界限定，短词不误伤）
const RAW_ID_RE = /(block-[a-z0-9]{12,}|[a-z]+:[a-z0-9:_-]{8,}|\b[a-z0-9]{20,}\b)/g;

export interface ReasonSegment {
  text: string;
  raw: boolean;
}

export function splitReasonIds(md: string): ReasonSegment[] {
  const out: ReasonSegment[] = [];
  let last = 0;
  for (const m of md.matchAll(RAW_ID_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: md.slice(last, start), raw: false });
    out.push({ text: m[0], raw: true });
    last = start + m[0].length;
  }
  if (last < md.length) out.push({ text: md.slice(last), raw: false });
  return out;
}
