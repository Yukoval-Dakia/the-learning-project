// M4-T6 (YUK-319/YUK-318)：提议卡（设计稿 screen-mistakes.jsx ProposalCard
// L60-124）。偏差（真 wire 适配，design pre-flight 预批）：
// ①无策展 title——reason_md 即正文，head 收敛为 kind-tag + ai-tag + resolved-stamp；
// ②SubjectTag 不渲——科目轴 M5 随 effective_domain 派生收编；
// ③merge-preview 不渲——block_merge 的 proposed_change 形态未钉死，reason_md 承载；
// ④「改关系」从即点即换改为 inline seg 展开 5 关系再选（真 decide 不可反复试）；
// ⑤evidence 渲多枚——真 evidence_refs 是数组，设计稿演示单枚。
// 裁决在卡内 async（busy per-card），错误经 onError 上抛页级 toast；
// resolved 留痕 map 由 InboxPage 持有（设计稿同构）。

import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { type SuggestionKind, SuggestionKindTag } from '@/ui/primitives/SuggestionKindTag';
import { useState } from 'react';

import {
  type ProposalDecision,
  type ProposalEvidenceRefWire,
  type ProposalInboxRow,
  REL_LABEL,
  decideProposal,
  dedupeEvidence,
  evidenceReadable,
  isAcceptSupported,
  isBlockMergeStale,
  kindMeta,
  splitReasonIds,
} from './inbox-api';

const EV_ICON: Record<string, LoomIconName> = {
  event: 'sparkle',
  question: 'quiz',
  knowledge: 'knowledge',
  artifact: 'doc',
  record: 'record',
};

interface LearningItemPlanPreview {
  hubTitle: string;
  summary: string | null;
  steps: Array<{ title: string; intent: string | null; kind: 'atomic' | 'long' }>;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function learningItemStepOf(
  value: unknown,
  kind: 'atomic' | 'long',
): LearningItemPlanPreview['steps'][number] | null {
  const row = recordOf(value);
  if (!row || typeof row.title !== 'string' || row.title.length === 0) return null;
  return {
    title: row.title,
    intent: typeof row.one_line_intent === 'string' ? row.one_line_intent : null,
    kind,
  };
}

/** Display-only, defensive projection of the free-form learning_item proposed_change. */
export function learningItemPlanPreviewOf(change: unknown): LearningItemPlanPreview | null {
  const plan = recordOf(change);
  const hub = recordOf(plan?.hub);
  if (!hub || typeof hub.title !== 'string' || hub.title.length === 0) return null;
  const atomics = Array.isArray(plan?.atomics) ? plan.atomics : [];
  const longs = Array.isArray(plan?.longs) ? plan.longs : [];
  const steps = [
    ...atomics.map((row) => learningItemStepOf(row, 'atomic')),
    ...longs.map((row) => learningItemStepOf(row, 'long')),
  ].filter((row): row is LearningItemPlanPreview['steps'][number] => row !== null);
  return {
    hubTitle: hub.title,
    summary: typeof hub.summary_md === 'string' ? hub.summary_md : null,
    steps,
  };
}

function EvidenceChip({
  er,
  count,
  navigate,
}: {
  er: ProposalEvidenceRefWire;
  count: number;
  navigate: (to: string) => void;
}) {
  const { text, route } = evidenceReadable(er);
  // S7 (YUK-335)：去重后 count>1 时把数量并进文案（「源自 N 次 AI 判定事件」式），
  // 单枚保持原句不动。
  const label = count > 1 ? text.replace('一', String(count)) : text;
  const content = (
    <>
      <span className="er-ic">
        <LoomIcon name={EV_ICON[er.kind] ?? 'record'} size={13} />
      </span>
      <span className="er-text">{label}</span>
    </>
  );

  // A missing detail route is display-only evidence, not a disabled action.
  if (!route) return <span className="evidence-readable">{content}</span>;

  return (
    <button type="button" className="evidence-readable" onClick={() => navigate(route)}>
      {content}
      <span className="er-go">查看 →</span>
    </button>
  );
}

export interface ProposalCardProps {
  p: ProposalInboxRow;
  index: number;
  /** 裁决留痕文案（如「已接受」）；null = 未裁决。 */
  resolved: string | null;
  nameOf: (id: string) => string;
  navigate: (to: string) => void;
  onResolve: (id: string, label: string) => void;
  onError: (msg: string) => void;
}

export function ProposalCard({
  p,
  index,
  resolved,
  nameOf,
  navigate,
  onResolve,
  onError,
}: ProposalCardProps) {
  const meta = kindMeta(p.kind);
  const [busy, setBusy] = useState(false);
  const [pickingRel, setPickingRel] = useState(false);
  // codex 验证轮 P3：裁决留痕后按钮组整体锁定——卡片留在列表里，再点会
  // 重复请求 / 反向操作直接 409。
  const locked = busy || resolved !== null;

  const decide = async (
    decision: ProposalDecision,
    label: string,
    opts: { newRelationType?: string } = {},
  ) => {
    setBusy(true);
    try {
      const result = await decideProposal(p.id, decision, opts);
      // YUK-271（codex 验证轮 P2）：stale 的 block_merge accept 没写 rate
      // event，提议仍 pending——不标已裁决，经页级 toast 说明后保持可操作。
      if (isBlockMergeStale(result)) {
        onError(
          `该题块合并提议已失效（题块状态已变更：${result.skip_reason ?? 'unknown'}），已跳过。`,
        );
        return;
      }
      onResolve(p.id, label);
    } catch (err) {
      onError(err instanceof Error ? err.message : '裁决失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const isEdge = p.kind === 'knowledge_edge';
  const change = p.payload.proposed_change;
  // ADR-0032 D4-E1 / YUK-332 — legacy proposals have no discriminator and are creates.
  // Archive proposals are destructive and only support accept/dismiss server-side, so their
  // operation, CTA copy, and available controls must not masquerade as create semantics.
  const isArchiveEdge = isEdge && change?.edge_op === 'archive';
  const archiveTargetMissing = isArchiveEdge && !change?.archive_edge_id;
  let cardLabel = meta.label;
  let cardIcon = meta.icon;
  let cardTone = meta.tone;
  let acceptButtonLabel = '接受';
  let acceptedLabel = '已接受';
  let edgeOperationLabel = '将新增';
  if (p.kind === 'block_merge') {
    acceptButtonLabel = '接受合并';
  } else if (isArchiveEdge) {
    cardLabel = '归档知识关系';
    cardIcon = 'archive';
    cardTone = 'hard';
    acceptButtonLabel = '确认归档';
    acceptedLabel = '已归档';
    edgeOperationLabel = archiveTargetMissing ? '归档目标缺失' : '将归档';
  } else if (isEdge) {
    cardLabel = '新增知识关系';
    acceptButtonLabel = '建立关系';
    acceptedLabel = '已建立';
  }
  const edgeFrom = isEdge ? change?.from_knowledge_id : undefined;
  const edgeTo = isEdge ? change?.to_knowledge_id : undefined;
  const rel = change?.relation_type;
  const confidence = typeof p.payload.confidence === 'number' ? p.payload.confidence : null;
  const learningPlan =
    p.kind === 'learning_item' ? learningItemPlanPreviewOf(p.payload.proposed_change) : null;

  return (
    <LoomCard
      pad
      className={`proposal${resolved ? ' resolved' : ''}`}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="proposal-head">
        <span className={`kind-tag tone-chip-${cardTone}`}>
          <LoomIcon name={cardIcon as LoomIconName} size={12} />
          {cardLabel}
        </span>
        <span className="ai-tag">
          <LoomIcon name="sparkle" size={12} />
          AI · {p.actor_ref}
        </span>
        {/* YUK-617 mode-1 — 修正类建议标签（suggestion_kind=corrective 不计接受率）。primitive 内部
            对非 corrective 早返回 null，故 proactive/缺失不渲染。字段已在 wire（BaseProposal 顶层）。 */}
        <SuggestionKindTag kind={p.payload.suggestion_kind as SuggestionKind | undefined} />
        {resolved && (
          <span className="badge tone-good resolved-stamp" style={{ marginLeft: 'auto' }}>
            <LoomIcon name="check" size={12} />
            {resolved}
          </span>
        )}
      </div>

      {/* S7 (YUK-335, audit §3.4)：reason_md 含真 block-<cuid> 等不透明 ID，
          视觉去权重——切成 prose 段 + raw-id 段，raw 段包进 <code .ev-rawid>
          读作「技术引用 chip」而非正文等权（AI 原句逐字保留，display-only）。 */}
      <div className="proposal-body">
        {splitReasonIds(p.payload.reason_md).map((seg, i) =>
          seg.raw ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: 切分段顺序稳定，无重排
            <code key={i} className="ev-rawid">
              {seg.text}
            </code>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: 切分段顺序稳定，无重排
            <span key={i}>{seg.text}</span>
          ),
        )}
      </div>

      {learningPlan && (
        <div className="proposal-learning-plan">
          <div className="proposal-learning-hub">
            <span className="meta">学习主线</span>
            <b className="serif">{learningPlan.hubTitle}</b>
            {learningPlan.summary && <span>{learningPlan.summary}</span>}
          </div>
          {learningPlan.steps.length > 0 && (
            <ol>
              {learningPlan.steps.map((step) => (
                <li key={`${step.kind}:${step.title}:${step.intent ?? ''}`}>
                  <span className={`proposal-plan-dot ${step.kind}`} />
                  <span>
                    <b>{step.title}</b>
                    {step.intent && <small>{step.intent}</small>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {isEdge && edgeFrom && edgeTo && (
        <div className="edge-preview nowrap-meta">
          <span className={`badge ${isArchiveEdge ? 'tone-again' : 'tone-info'}`}>
            <LoomIcon name={isArchiveEdge ? 'archive' : 'link'} size={12} />
            {edgeOperationLabel}
          </span>
          <span className="rel-pill">{(rel && REL_LABEL[rel]) || rel || '关系'}</span>
          <span className="chip chip-k mono">{nameOf(edgeFrom)}</span>
          <LoomIcon name="arrow" size={14} />
          <span className="chip chip-k mono">{nameOf(edgeTo)}</span>
        </div>
      )}

      <div className="proposal-foot">
        <div
          className="proposal-actions"
          style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}
        >
          {/* M4 review fix (codex P2)：defer/archive/judge_retraction 的 accept
              在 dispatchAccept 是 400（unsupported_proposal_kind），不渲 CTA。 */}
          {isAcceptSupported(p.kind) && (
            <Btn
              size="sm"
              variant={isArchiveEdge ? 'again' : 'good'}
              icon={isArchiveEdge ? 'archive' : 'check'}
              disabled={locked || archiveTargetMissing}
              onClick={() => void decide('accept', acceptedLabel)}
            >
              {acceptButtonLabel}
            </Btn>
          )}
          {isEdge && !isArchiveEdge && (
            <>
              <Btn
                size="sm"
                variant="ghost"
                icon="reverse"
                disabled={locked}
                onClick={() => void decide('reverse', '已改方向')}
              >
                改方向
              </Btn>
              <Btn
                size="sm"
                variant="ghost"
                icon="refresh"
                disabled={locked}
                onClick={() => setPickingRel((v) => !v)}
              >
                改关系
              </Btn>
            </>
          )}
          <Btn
            size="sm"
            variant="ghost"
            icon="close"
            disabled={locked}
            onClick={() => void decide('dismiss', isArchiveEdge ? '已保留' : '已忽略')}
          >
            {isArchiveEdge ? '保留关系' : '忽略'}
          </Btn>
        </div>
        <div className="meta-row">
          {confidence !== null && (
            <span className="conf-bar">
              <span className="meta">置信</span>
              <span className="conf-track">
                <span style={{ width: `${Math.round(confidence * 100)}%` }} />
              </span>
              <span className="meta tnum">{Math.round(confidence * 100)}%</span>
            </span>
          )}
          {p.cost_micro_usd != null && (
            <span className="meta">${(p.cost_micro_usd / 1e6).toFixed(4)}</span>
          )}
        </div>
      </div>

      {pickingRel && !resolved && !isArchiveEdge && (
        <div
          className="seg"
          role="tablist"
          aria-label="改为关系类型"
          style={{ marginTop: 'var(--s-2)' }}
        >
          {Object.entries(REL_LABEL).map(([k, label]) => (
            <button
              type="button"
              key={k}
              role="tab"
              aria-selected={rel === k}
              className={rel === k ? 'on' : ''}
              disabled={locked}
              onClick={() => void decide('change_type', '已改关系', { newRelationType: k })}
            >
              {label.split(' ')[0]}
            </button>
          ))}
        </div>
      )}

      {p.payload.evidence_refs.length > 0 && (
        <div className="proposal-evidence">
          {/* S7 (YUK-335)：同 readable 文案去重 + 计数，避免 N 枚一模一样的灰 chip。 */}
          {dedupeEvidence(p.payload.evidence_refs).map(({ ref, count }) => (
            <EvidenceChip
              key={`${ref.kind}:${ref.id}`}
              er={ref}
              count={count}
              navigate={navigate}
            />
          ))}
        </div>
      )}
    </LoomCard>
  );
}
