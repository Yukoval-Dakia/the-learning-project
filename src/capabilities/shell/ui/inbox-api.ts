// M4-T6 (YUK-319/YUK-318)：收件箱 ui 数据层——统一 /api/proposals 的 wire
// 类型、kind 元数据（aiProposalKinds 全量）与决策 callers。
// 设计基准 docs/design/loom-refresh/project/data.jsx（KIND_META / REL_LABEL）：
// 设计稿只列 12 kind；defer / archive / judge_retraction / image_candidate /
// question_draft / question_edit 按同一 tone 语系补全（hard=节奏类、neutral=归档、
// coral=内容生成/修订类）；icon 是图标名，inbox-look.ts 的 kindIcon 映射成 lucide。

import { acceptSupportedProposalKinds } from '@/core/schema/proposal';
import {
  type ApiOperationJsonResponse,
  type ApiOperationRequestBody,
  apiOperationJson,
} from '@/ui/lib/api';

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
  block_merge: { label: '合并题目', icon: 'merge', tone: 'hard' },
  defer: { label: '延后安排', icon: 'clock', tone: 'hard' },
  archive: { label: '归档建议', icon: 'archive', tone: 'neutral' },
  judge_retraction: { label: '判定撤回', icon: 'undo', tone: 'coral' },
  image_candidate: { label: '图题候选', icon: 'image', tone: 'coral' },
  question_draft: { label: '题目草稿', icon: 'quiz', tone: 'coral' },
  // ADR-0032 D6-B (YUK-203 lane L6) — active 题结构编辑（窄 typed 节点 op）。
  question_edit: { label: '题目修订', icon: 'pencil', tone: 'coral' },
  // YUK-440 / YUK-406 (教研团 Phase 0) — 心智诊断推测（conjecture-with-probe）。
  // 现有通用 ProposalCard 渲染（非备课台）；propose-only，无 Accept CTA。
  conjecture: { label: '诊断推测', icon: 'review', tone: 'coral' },
  cause_category: { label: '错因类目', icon: 'tag', tone: 'coral' },
};

export function kindMeta(kind: string): KindMeta {
  return KIND_META[kind] ?? { label: kind, icon: 'inbox', tone: 'neutral' };
}

// dispatchAccept 对没有 accept applier 的 kind 返回 400 unsupported_proposal_kind；
// 卡片对它们不渲 Accept CTA，只留忽略（dismiss 与 kind 无关）。legacy knowledge 事件
// 可派生出 archive kind 进收件箱，门控不能省。集合真身在 core（acceptSupportedProposalKinds）。
const acceptSupported: ReadonlySet<string> = new Set(acceptSupportedProposalKinds);

export function isAcceptSupported(kind: string): boolean {
  return acceptSupported.has(kind);
}

// 关系类型白话；字段名不给学习者看。
export const REL_LABEL: Record<string, string> = {
  prerequisite: '前置',
  related_to: '相关',
  contrasts_with: '对比',
  applied_in: '应用',
  derived_from: '派生',
};

// The API boundary is generated from the provider-owned manifest. The view
// projection intentionally stays looser than the proposal union: ProposalCard
// renders shared optional fields and supports sparse cached/test rows without
// pretending those rows are valid wire payloads.
type GeneratedProposalPage = ApiOperationJsonResponse<'listProposals'>;
type GeneratedProposalRow = GeneratedProposalPage['rows'][number];
type GeneratedProposalPayload = GeneratedProposalRow['payload'];

export type ProposalEvidenceRefWire = GeneratedProposalPayload['evidence_refs'][number];
export interface ProposalPayloadWire {
  kind: string;
  reason_md: string;
  learner_summary?: string;
  evidence_refs: ProposalEvidenceRefWire[];
  confidence?: number;
  proposed_change?: {
    edge_op?: 'create' | 'archive' | 'supersede';
    archive_edge_id?: string;
    from_knowledge_id?: string;
    to_knowledge_id?: string;
    relation_type?: string;
    weight?: number;
    source_url?: string;
    source_title?: string;
    summary_md?: string;
    knowledge_ids?: string[];
    requested_kind?: string;
    confidence?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type ProposalPresentationWire = NonNullable<GeneratedProposalRow['presentation']>;
export type ProposalSummaryItemWire = ProposalPresentationWire['change_summary'][number];
export type ProposalBlockPreviewWire = NonNullable<
  NonNullable<ProposalPresentationWire['block_merge']>['primary']
>;
export type ProposalInboxRow = Omit<GeneratedProposalRow, 'kind' | 'payload' | 'presentation'> & {
  kind: string;
  payload: ProposalPayloadWire;
  /** Optional keeps sparse cached rows forward-compatible in the display layer. */
  presentation?: ProposalPresentationWire | null;
};
export interface ProposalPageWire {
  rows: ProposalInboxRow[];
  next_cursor: string | null;
  /** Effective proposal auto-apply switch, resolved in the API process. */
  auto_apply_enabled: boolean;
}

const DECISION_PAGE_LIMIT = 500;
export const DECISION_MAX_PAGES = 20;
const OBSERVATION_PAGE_LIMIT = 200;

function listProposalPage(
  lane: 'decision' | 'observation',
  limit: number,
  cursor?: string,
): Promise<ProposalPageWire> {
  const query = new URLSearchParams({ lane, limit: String(limit), status: 'pending' });
  if (cursor) query.set('cursor', cursor);
  return apiOperationJson('listProposals', {
    url: `/api/proposals?${query.toString()}`,
    method: 'GET',
  }).then((page) => ({
    // The generated schema validates the full discriminated union. This adapter
    // only widens it into ProposalCard's optional-field display projection.
    rows: page.rows as ProposalInboxRow[],
    next_cursor: page.next_cursor,
    auto_apply_enabled: page.auto_apply_enabled,
  }));
}

/** Fetch exactly one actionable-decision page so the first page can render before the backlog drains. */
export function listDecisionProposalPage(cursor?: string | null): Promise<ProposalPageWire> {
  return listProposalPage('decision', DECISION_PAGE_LIMIT, cursor ?? undefined);
}

/** The C-strength preview is deliberately bounded and independent from actionable decisions. */
export function listObservationProposalPreview(): Promise<ProposalPageWire> {
  return listProposalPage('observation', OBSERVATION_PAGE_LIMIT);
}

/** Stable first-seen merge: later pages may overlap after concurrent decisions, but cards never duplicate. */
export function mergeProposalPages(pages: readonly ProposalPageWire[]): ProposalInboxRow[] {
  const rows = new Map<string, ProposalInboxRow>();
  for (const page of pages) {
    for (const row of page.rows) {
      if (!rows.has(row.id)) rows.set(row.id, row);
    }
  }
  return [...rows.values()];
}

/**
 * TanStack Query v5 continuation policy. Repeated cursors and the defensive page ceiling stop
 * background loading while preserving every already-loaded decision for the learner to act on.
 */
export function getNextDecisionPageParam(
  lastPage: ProposalPageWire,
  allPages: readonly ProposalPageWire[],
  _lastPageParam: string | null,
  allPageParams: readonly (string | null)[],
): string | undefined {
  const next = lastPage.next_cursor;
  if (!next) return undefined;
  if (allPageParams.includes(next)) return undefined;
  if (allPages.length >= DECISION_MAX_PAGES) return undefined;
  return next;
}

export interface DecisionPaginationDiagnostics {
  cursorRepeated: boolean;
  pageLimitReached: boolean;
  incomplete: boolean;
}

/** Explain why a non-null continuation stopped instead of presenting the loaded subset as complete. */
export function decisionPaginationDiagnostics(
  pages: readonly ProposalPageWire[],
  pageParams: readonly (string | null)[],
): DecisionPaginationDiagnostics {
  const next = pages.at(-1)?.next_cursor ?? null;
  const cursorRepeated = next !== null && pageParams.includes(next);
  const pageLimitReached = next !== null && !cursorRepeated && pages.length >= DECISION_MAX_PAGES;
  return {
    cursorRepeated,
    pageLimitReached,
    incomplete: cursorRepeated || pageLimitReached,
  };
}

export type ProposalDecision = 'accept' | 'reverse' | 'change_type' | 'dismiss';

export function proposalDecisionBody(
  decision: ProposalDecision,
  opts: {
    newRelationType?: string;
    userNote?: string;
    correctedClaimMd?: string;
    /** Accept-only: the learner confirmed an irreversible block merge (YUK-1404). */
    confirmLossy?: true;
  } = {},
): ApiOperationRequestBody<'createProposalDecision'> {
  return {
    decision,
    ...(decision === 'accept' && opts.confirmLossy ? { confirm_lossy: true as const } : {}),
    ...(opts.newRelationType ? { new_relation_type: opts.newRelationType } : {}),
    ...(opts.userNote ? { user_note: opts.userNote } : {}),
    // Empty edits reach validation instead of degrading to an uncorrected accept.
    ...(opts.correctedClaimMd !== undefined
      ? { corrected_payload: { claim_md: opts.correctedClaimMd } }
      : {}),
  };
}

export const decideProposal = (
  id: string,
  decision: ProposalDecision,
  opts: Parameters<typeof proposalDecisionBody>[1] = {},
) =>
  apiOperationJson('createProposalDecision', {
    url: `/api/proposals/${encodeURIComponent(id)}/decisions`,
    method: 'POST',
    body: proposalDecisionBody(decision, opts),
  }).then((resource) => resource.result);

export const retractProposal = (id: string) =>
  apiOperationJson('createProposalDecision', {
    url: `/api/proposals/${encodeURIComponent(id)}/decisions`,
    method: 'POST',
    body: { decision: 'retract' },
  }).then((resource) => resource.result);

// ── A4 强度轴 (YUK-521)：A 档 auto-applied 读模型 wire 类型 + caller ──
export type AutoAppliedDigestWire = ApiOperationJsonResponse<'getAutoAppliedProposals'>;
export type AutoAppliedRowWire = AutoAppliedDigestWire['rows'][number];
export type VerdictBreakerWire = AutoAppliedDigestWire['breaker'];

export type AutoAppliedRetractResultWire =
  ApiOperationJsonResponse<'batchRetractAutoAppliedProposals'>;

export const listAutoApplied = (window?: { from: string; to?: string }) => {
  const query = new URLSearchParams(window);
  return apiOperationJson('getAutoAppliedProposals', {
    url: `/api/proposals/auto-applied${window ? `?${query.toString()}` : ''}`,
    method: 'GET',
  });
};

/** Each proposal is tried on its own: part done and part refused is a normal result. */
export const retractAutoApplied = (proposalIds: readonly string[]) =>
  apiOperationJson('batchRetractAutoAppliedProposals', {
    url: '/api/proposals/auto-applied/retract',
    method: 'POST',
    body: { proposal_ids: [...proposalIds] },
  });

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
      return { text: '源自一篇笔记', route: `/notes/${encodeURIComponent(ref.id)}` };
    case 'record':
      return { text: '源自一条学习记录', route: null };
    default:
      return { text: '来源记录', route: null };
  }
}

// S7 (YUK-335, audit §3.4)：block_merge 卡常带多枚同 kind 的 evidence_refs，
// evidenceReadable 把同 kind 映成同一句白话 → 渲成 N 枚一模一样的 evidence
// pill。按 readable 文案分组去重：每组保留首个 ref（route/display 语义不变）+
// 组内计数，count>1 时由 EvidenceChip 把数量并进文案。
// F5 (Codex #400)：但 navigable（knowledge/artifact，route≠null）的不同 id 是
// 不同可达目标，按文案折叠会只留首个 ref 的 route，用户看「源自 2 个知识点」却只能
// 打开第一个——故 navigable ref 改按 id 各自成组，保各自的链接；route=null 的 kind
// （event/question/record）仍按文案折叠（S7 原意不变）。
export interface DedupedEvidence {
  ref: ProposalEvidenceRefWire;
  count: number;
}

export function dedupeEvidence(
  refs: ProposalEvidenceRefWire[],
  curatedLabels: Record<string, string> = {},
): DedupedEvidence[] {
  const groups = new Map<string, DedupedEvidence>();
  for (const ref of refs) {
    const { text, route } = evidenceReadable(ref);
    const curatedLabel = curatedLabels[`${ref.kind}:${ref.id}`];
    const key = curatedLabel ? `${curatedLabel}::${ref.id}` : route ? `${text}::${ref.id}` : text;
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
//   命名空间 ID <小写词>:<8+ 位 [a-z0-9:_-]>（如 synthetic:yuwen:...）
//   裸长串 <20+ 位小写字母数字>（词边界限定，短词不误伤）
const WRITTEN_FOR_LEARNER_ID_RE = /(block-[a-z0-9]{12,}|[a-z]+:[a-z0-9:_-]{8,}|\b[a-z0-9]{20,}\b)/g;
// 旧提议的理由是内部文字，还会写：截断的 ID q94c…、evt_assessment_…、字段路径 links.question_id、
// 蛇形字段名 evidence_event_ids（数学写法不算：x_1、a_n、log_10、100…）。全文都在折叠里。
const INTERNAL_REASON_ID_RE =
  /(block-[a-z0-9]{12,}|[a-z]+:[a-z0-9:_-]{8,}|\b(?=[a-z0-9]*[a-z])[a-z0-9]{4,}…|\b[a-z0-9]+_[a-z0-9_]{4,}…|\b[a-z][a-z0-9]*\.[a-z0-9]+(?:_[a-z0-9]+)+|\b[a-z][a-z0-9]{2,}(?:_[0-9]{2,})*_(?=[a-z0-9]*[a-z])[a-z0-9]{2,}(?:_[a-z0-9]{2,})*\b|\b[a-z0-9]{20,}\b)/g;

// Stands in for a removed id, so brackets it leaves empty go too while a blank in a quoted question
// such as （ ） stays.
const REMOVED_ID = '\uE000';
const EMPTIED_BRACKETS = /[（(]\s*\uE000\s*[）)]/g;

/** A reason as the first thing read: ids gone (a known one keeps its name), no stray spaces. */
export function reasonWithoutIds(
  text: string,
  nameOf?: (id: string) => string | undefined,
): string {
  return splitReasonIds(text)
    .map((seg) => (seg.raw ? (nameOf?.(seg.text) ?? REMOVED_ID) : seg.text))
    .join('')
    .replace(EMPTIED_BRACKETS, '')
    .replaceAll(REMOVED_ID, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+(?=[（）「」，。；：、])/g, '')
    .trim();
}

export interface ReasonSegment {
  start: number;
  text: string;
  raw: boolean;
}

/**
 * `learnerSentence`: a sentence that passed the write check. Only the narrow forms fold there,
 * because the wide ones can take words the check allows, such as `attention…`.
 */
export function splitReasonIds(md: string, learnerSentence = false): ReasonSegment[] {
  const out: ReasonSegment[] = [];
  let last = 0;
  for (const m of md.matchAll(
    learnerSentence ? WRITTEN_FOR_LEARNER_ID_RE : INTERNAL_REASON_ID_RE,
  )) {
    const start = m.index ?? 0;
    if (start > last) out.push({ start: last, text: md.slice(last, start), raw: false });
    out.push({ start, text: m[0], raw: true });
    last = start + m[0].length;
  }
  if (last < md.length) out.push({ start: last, text: md.slice(last), raw: false });
  return out;
}
