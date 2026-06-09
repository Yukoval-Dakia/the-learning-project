'use client';

// YUK-271 — shared inbox presentational types + leaf helpers + the block_merge
// card, split out of page.tsx so they can be unit-imported. Next.js rejects
// arbitrary named exports from a route `page.tsx` ("not a valid Page export
// field"), and that validation only runs under `pnpm build` (tsc / biome /
// vitest all pass it). A sibling non-reserved module in the same route folder is
// NOT subject to that check, so the testable surface (BlockMergeProposalCard,
// kindLabel, the types) lives here and page.tsx imports it.

import { formatRelTime } from '@/ui/lib/utils';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import Link from 'next/link';

export type ProposalStatus = 'pending' | 'accepted' | 'dismissed' | 'stale';

// Keep this union aligned with `aiProposalKinds` (src/core/schema/proposal.ts).
// It previously omitted `defer` / `goal_scope` / `block_merge` / `image_candidate`,
// so those kinds rendered their raw string as the card title (kindLabel `?? kind`
// fallback) and fell to the `neutral` tone.
export type ProposalKind =
  | 'knowledge_node'
  | 'knowledge_edge'
  | 'knowledge_mutation'
  | 'learning_item'
  | 'note_update'
  | 'variant_question'
  | 'completion'
  | 'relearn'
  | 'defer'
  | 'record_links'
  | 'record_promotion'
  | 'archive'
  | 'judge_retraction'
  | 'goal_scope'
  | 'block_merge'
  | 'image_candidate'
  // ADR-0031 / YUK-304 (lane B) — copilot-authored draft question (accept
  // promotes draft→active + FSRS-enrolls). NOTE: this union is hand-maintained;
  // adding a kind to aiProposalKinds does NOT typecheck-force an entry here —
  // without it the card renders the raw kind string + neutral tone.
  | 'question_draft';

export interface ProposalTarget {
  subject_kind: string;
  subject_id: string | null;
}

export interface ProposalEvidenceRef {
  kind: 'event' | 'question' | 'knowledge' | 'artifact' | 'record';
  id: string;
}

export type RelationType =
  | 'prerequisite'
  | 'related_to'
  | 'contrasts_with'
  | 'applied_in'
  | 'derived_from'
  | `experimental:${string}`;

export interface BaseProposalPayload {
  kind: ProposalKind;
  target: ProposalTarget;
  reason_md: string;
  evidence_refs: ProposalEvidenceRef[];
  proposed_change: Record<string, unknown>;
  rollback_plan?: unknown;
  cooldown_key?: string;
}

export interface KnowledgeNodeProposalPayload extends BaseProposalPayload {
  kind: 'knowledge_node';
  target: { subject_kind: 'knowledge'; subject_id: string | null };
  proposed_change: {
    mutation: 'propose_new';
    name: string;
    parent_id: string;
  };
}

export interface KnowledgeEdgeProposalPayload extends BaseProposalPayload {
  kind: 'knowledge_edge';
  target: { subject_kind: 'knowledge_edge'; subject_id: string | null };
  proposed_change: {
    from_knowledge_id: string;
    to_knowledge_id: string;
    relation_type: RelationType;
    weight: number;
  };
}

// YUK-271 — read-only mirror of src/core/schema/proposal.ts BlockMergeProposalChange.
// The inbox only displays these fields (primary + merge ids + the optional semantic
// continuity_signal / confidence the producer stamped at propose time); the accept
// handler (acceptBlockMergeProposal) is the single execution point and reads the
// authoritative payload server-side, so this shape is presentation-only.
export interface BlockMergeProposalPayload extends BaseProposalPayload {
  kind: 'block_merge';
  proposed_change: {
    primary_block_id: string;
    merge_block_ids: string[];
    ingestion_session_id: string;
    continuity_signal?: 'page_edge' | 'numbering' | 'stem_answer_split' | 'carryover';
    confidence?: number;
  };
}

export type ProposalPayload =
  | KnowledgeNodeProposalPayload
  | KnowledgeEdgeProposalPayload
  | BlockMergeProposalPayload
  | BaseProposalPayload;

export interface ProposalInboxRow {
  id: string;
  kind: ProposalKind;
  target: ProposalTarget;
  payload: ProposalPayload;
  status: ProposalStatus;
  proposed_at: string;
  decided_at: string | null;
  actor_ref: string;
  task_run_id: string | null;
  cost_micro_usd: number | null;
  source_action: string;
  source_subject_kind: string;
}

const KIND_LABELS: Record<ProposalKind, string> = {
  knowledge_node: '新知识节点',
  knowledge_edge: '知识关系',
  knowledge_mutation: '知识结构调整',
  learning_item: '学习项',
  note_update: '笔记更新',
  variant_question: '变式题',
  completion: '完成状态',
  relearn: '重学安排',
  defer: '延后',
  record_links: '记录链接',
  record_promotion: '记录升级',
  archive: '归档',
  judge_retraction: '判题撤回',
  goal_scope: '目标范围',
  block_merge: '题块合并',
  image_candidate: '图片来源',
  // ADR-0031 / YUK-304 (lane B) — copilot 拟题草稿.
  question_draft: 'AI 拟题',
};

export function kindLabel(kind: ProposalKind): string {
  return KIND_LABELS[kind] ?? kind;
}

export function kindTone(kind: ProposalKind): 'info' | 'good' | 'hard' | 'coral' | 'neutral' {
  switch (kind) {
    case 'knowledge_node':
    // YUK-271 — block_merge is a review-class proposal; tint it `info` (the same
    // bucket today/page assigns the merge-review surface) rather than the neutral
    // default the missing case fell through to.
    case 'block_merge':
      return 'info';
    case 'knowledge_edge':
    case 'knowledge_mutation':
      return 'coral';
    case 'learning_item':
    case 'completion':
    case 'record_links':
    case 'record_promotion':
    // ADR-0031 / YUK-304 (lane B) — accepting a question_draft grows the bank
    // (a constructive/“good” action, same bucket as record_promotion).
    case 'question_draft':
      return 'good';
    case 'judge_retraction':
      return 'hard';
    case 'variant_question':
      return 'coral';
    default:
      return 'neutral';
  }
}

export function targetLabel(target: ProposalTarget): string {
  return target.subject_id ? `${target.subject_kind}:${target.subject_id}` : target.subject_kind;
}

export function proposalMeta(proposal: ProposalInboxRow): string {
  const parts = [
    proposal.actor_ref,
    proposal.task_run_id ? proposal.task_run_id.slice(0, 12) : null,
    typeof proposal.cost_micro_usd === 'number' && proposal.cost_micro_usd > 0
      ? `$${(proposal.cost_micro_usd / 1_000_000).toFixed(4)}`
      : null,
    formatRelTime(proposal.proposed_at),
  ].filter(Boolean);
  return parts.join(' · ');
}

// YUK-15 — clickable backlinks for evidence_refs. `event` jumps to the
// event-chain detail page (existing route). `record` jumps to the record
// list focused on the cited id. `question` is currently uninked — there's
// no per-question detail route yet (Linear follow-up if/when one lands).
export function EvidenceRefChip({ ref }: { ref: ProposalEvidenceRef }) {
  const label = `${ref.kind}:${ref.id.slice(0, 8)}…`;
  const key = `${ref.kind}:${ref.id}`;
  if (ref.kind === 'event') {
    return (
      <Link href={`/events/${ref.id}`} key={key}>
        {label}
      </Link>
    );
  }
  if (ref.kind === 'record') {
    return (
      <Link href={`/record?focus=${encodeURIComponent(ref.id)}`} key={key}>
        {label}
      </Link>
    );
  }
  return <span key={key}>{label}</span>;
}

export function ProposalStatusRow({ proposal }: { proposal: ProposalInboxRow }) {
  return (
    <div className="proposal-status-row">
      <span>{proposal.source_action}</span>
      <span>{proposal.source_subject_kind}</span>
      <span>{targetLabel(proposal.target)}</span>
      {proposal.task_run_id && <span>{proposal.task_run_id.slice(0, 12)}</span>}
      {typeof proposal.cost_micro_usd === 'number' && proposal.cost_micro_usd > 0 && (
        <span>${(proposal.cost_micro_usd / 1_000_000).toFixed(4)}</span>
      )}
    </div>
  );
}

// YUK-271 — minimal-enable card for block_merge. Reuses GenericProposalCard's
// JSON-preview layout + existing proposal-* classes (no new CSS); the ONLY
// functional change vs the generic card is that the 接受 button is live and wired
// to acceptMutation instead of the disabled「待接入」placeholder. The accept
// itself reuses the YUK-195 mergeQuestions primitive server-side
// (acceptBlockMergeProposal, design 2026-06-02 §4). Confidence sorting /
// continuity_signal badge / rich merge-block preview stay deferred to the
// YUK-169 redraw slice (design 2026-06-02 §6).
//
// 撤回 semantics note: for block_merge, /retract only writes an audit event — it
// does NOT un-merge (the merge is lossy; there is no block_merge branch in
// retractAiProposal). The button records retraction intent, consistent with the
// other kinds' minimal retract.
export function BlockMergeProposalCard({
  proposal,
  pending,
  onAccept,
  onDismiss,
  onRetract,
}: {
  proposal: ProposalInboxRow & { payload: BlockMergeProposalPayload };
  pending: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onRetract: () => void;
}) {
  const change = proposal.payload.proposed_change;
  return (
    <article className="proposal proposal-generic">
      <div className="proposal-head">
        <Badge tone="info">{kindLabel('block_merge')}</Badge>
        <span className="title">{targetLabel(proposal.target)}</span>
        <span className="inbox-card-meta">{proposalMeta(proposal)}</span>
      </div>
      <div className="body">{proposal.payload.reason_md || '无连续性说明'}</div>
      <ProposalStatusRow proposal={proposal} />
      <div className="proposal-summary">
        <strong>proposed_change</strong>
        <pre className="proposal-json">{JSON.stringify(change, null, 2)}</pre>
      </div>
      {proposal.payload.evidence_refs.length > 0 && (
        <div className="artifact-ref-row">
          {proposal.payload.evidence_refs.slice(0, 5).map((ref) => (
            <EvidenceRefChip ref={ref} key={`${ref.kind}:${ref.id}`} />
          ))}
        </div>
      )}
      <div className="proposal-actions">
        <Button variant="good" size="sm" icon="check" disabled={pending} onClick={onAccept}>
          接受
        </Button>
        <Button variant="ghost" size="sm" icon="x" disabled={pending} onClick={onDismiss}>
          忽略
        </Button>
        <Button
          variant="danger"
          size="sm"
          icon="trash"
          className="proposal-retract"
          disabled={pending}
          onClick={onRetract}
        >
          撤回
        </Button>
        <Link href={`/events/${proposal.id}`} className="inbox-inline-link">
          事件链
        </Link>
      </div>
    </article>
  );
}

// YUK-271 — the accept route returns acceptAiProposal's discriminated result
// verbatim. The inbox only needs to react to the block_merge variant's `stale`
// flag (mergeQuestions soft-rejected → no rate event, proposal stays pending);
// every other accept result is treated as plain success (refresh + move on), so
// this stays a loose shape rather than a full mirror of BlockMergeAcceptResult.
interface BlockMergeAcceptResponse {
  kind: 'block_merge';
  stale?: boolean;
  skip_reason?: string;
}

export function isBlockMergeStale(data: unknown): data is BlockMergeAcceptResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { kind?: unknown }).kind === 'block_merge' &&
    (data as { stale?: unknown }).stale === true
  );
}

export function isBlockMergeProposal(
  row: ProposalInboxRow,
): row is ProposalInboxRow & { payload: BlockMergeProposalPayload } {
  return row.kind === 'block_merge';
}
