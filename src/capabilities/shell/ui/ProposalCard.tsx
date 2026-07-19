// M4-T6 (YUK-319/YUK-318)：提议卡（设计稿 screen-mistakes.jsx ProposalCard
// L60-124）。偏差（真 wire 适配，design pre-flight 预批）：
// ①SubjectTag 不渲——科目轴 M5 随 effective_domain 派生收编；
// ②「改关系」从即点即换改为 inline seg 展开 5 关系再选（真 decide 不可反复试）；
// ③evidence 渲多枚——真 evidence_refs 是数组，设计稿演示单枚。
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
  label: curatedLabel,
  navigate,
}: {
  er: ProposalEvidenceRefWire;
  count: number;
  label?: string;
  navigate: (to: string) => void;
}) {
  const { text, route } = evidenceReadable(er);
  // S7 (YUK-335)：去重后 count>1 时把数量并进文案（「源自 N 次 AI 判定事件」式），
  // 单枚保持原句不动。
  const label = curatedLabel ?? (count > 1 ? text.replace('一', String(count)) : text);
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
  const confidence =
    p.kind === 'conjecture'
      ? null
      : typeof p.payload.confidence === 'number'
        ? p.payload.confidence
        : p.kind === 'block_merge' && typeof change?.confidence === 'number'
          ? change.confidence
          : null;
  const learningPlan =
    p.kind === 'learning_item' ? learningItemPlanPreviewOf(p.payload.proposed_change) : null;
  const mergePreview = p.kind === 'block_merge' ? p.presentation?.block_merge : null;
  const mergeBlockLabelById = new Map(
    mergePreview
      ? [mergePreview.primary, ...mergePreview.merged]
          .filter((block) => block !== null)
          .map((block) => [block.id, block.label] as const)
      : [],
  );

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
        {p.presentation?.title && <span className="proposal-title">{p.presentation.title}</span>}
        {resolved && (
          <span className="badge tone-good resolved-stamp" style={{ marginLeft: 'auto' }}>
            <LoomIcon name="check" size={12} />
            {resolved}
          </span>
        )}
      </div>

      {/* YUK-264：reason_md 的不透明 ID 不再露在正文；已加载的题块显示位置身份，
          其他引用折叠为通用标签，原 ID 只保留在 hover title 供追溯。 */}
      <div className="proposal-body">
        {splitReasonIds(p.payload.reason_md).map((seg) =>
          seg.raw ? (
            <button
              type="button"
              key={seg.start}
              className="ev-rawid"
              title={`复制引用 ${seg.text}`}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(seg.text)
                  .catch(() => onError('复制技术引用失败。'));
              }}
            >
              {mergeBlockLabelById.get(seg.text) ?? '技术引用'}
            </button>
          ) : (
            <span key={seg.start}>{seg.text}</span>
          ),
        )}
      </div>

      {p.presentation && p.presentation.change_summary.length > 0 && (
        <dl className="proposal-change-summary">
          {p.presentation.change_summary.map((item) => (
            <div key={`${item.label}:${item.value}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}

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

      {mergePreview?.primary && mergePreview.merged.length > 0 && (
        <div className="merge-preview">
          <div className="merge-block">
            <div className="merge-label">保留 · {mergePreview.primary.label}</div>
            <div className="merge-text">{mergePreview.primary.excerpt}</div>
          </div>
          <div className="merge-join" aria-hidden="true">
            <LoomIcon name="arrow" size={16} />
          </div>
          <div className="merge-block merge-into">
            <div className="merge-label">并入 · {mergePreview.merged.length} 块</div>
            {mergePreview.merged.map((block) => (
              <div className="merge-text merge-text-part" key={block.id}>
                <b>{block.label}</b>
                <span>{block.excerpt}</span>
              </div>
            ))}
          </div>
          {mergePreview.continuity_label && (
            <div className="merge-reason">
              <LoomIcon name="sparkle" size={12} />
              连续依据：{mergePreview.continuity_label}
            </div>
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
          {dedupeEvidence(p.payload.evidence_refs, p.presentation?.evidence_labels).map(
            ({ ref, count }) => (
              <EvidenceChip
                key={`${ref.kind}:${ref.id}`}
                er={ref}
                count={count}
                label={p.presentation?.evidence_labels[`${ref.kind}:${ref.id}`]}
                navigate={navigate}
              />
            ),
          )}
        </div>
      )}

      {p.kind !== 'conjecture' && p.presentation?.technical_details && (
        <details className="proposal-technical-details">
          <summary>技术详情</summary>
          <div className="proposal-technical-head">
            <span>原始变更数据（含引用 ID）</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(p.presentation?.technical_details ?? '')
                  .catch(() => onError('复制技术详情失败。'));
              }}
            >
              复制
            </button>
          </div>
          <pre>{p.presentation.technical_details}</pre>
        </details>
      )}
    </LoomCard>
  );
}
