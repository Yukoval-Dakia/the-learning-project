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
import { useState } from 'react';

import {
  type ProposalDecision,
  type ProposalEvidenceRefWire,
  type ProposalInboxRow,
  REL_LABEL,
  decideProposal,
  evidenceReadable,
  isAcceptSupported,
  isBlockMergeStale,
  kindMeta,
} from './inbox-api';

const EV_ICON: Record<string, LoomIconName> = {
  event: 'sparkle',
  question: 'quiz',
  knowledge: 'knowledge',
  artifact: 'doc',
  record: 'record',
};

function EvidenceChip({
  er,
  navigate,
}: {
  er: ProposalEvidenceRefWire;
  navigate: (to: string) => void;
}) {
  const { text, route } = evidenceReadable(er);
  return (
    <button
      type="button"
      className="evidence-readable"
      title={`${er.kind}:${er.id}`}
      disabled={!route}
      onClick={route ? () => navigate(route) : undefined}
    >
      <span className="er-ic">
        <LoomIcon name={EV_ICON[er.kind] ?? 'record'} size={13} />
      </span>
      <span className="er-text">{text}</span>
      {route && <span className="er-go">查看 →</span>}
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
  const edgeFrom = isEdge ? change?.from_knowledge_id : undefined;
  const edgeTo = isEdge ? change?.to_knowledge_id : undefined;
  const rel = change?.relation_type;
  const confidence = typeof p.payload.confidence === 'number' ? p.payload.confidence : null;

  return (
    <LoomCard
      pad
      className={`proposal${resolved ? ' resolved' : ''}`}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="proposal-head">
        <span className={`kind-tag tone-chip-${meta.tone}`}>
          <LoomIcon name={meta.icon as LoomIconName} size={12} />
          {meta.label}
        </span>
        <span className="ai-tag">
          <LoomIcon name="sparkle" size={12} />
          AI · {p.actor_ref}
        </span>
        {resolved && (
          <span className="badge tone-good resolved-stamp" style={{ marginLeft: 'auto' }}>
            <LoomIcon name="check" size={12} />
            {resolved}
          </span>
        )}
      </div>

      <div className="proposal-body">{p.payload.reason_md}</div>

      {isEdge && edgeFrom && edgeTo && (
        <div className="edge-preview nowrap-meta">
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
              variant="good"
              icon="check"
              disabled={locked}
              onClick={() => void decide('accept', '已接受')}
            >
              {p.kind === 'block_merge' ? '接受合并' : '接受'}
            </Btn>
          )}
          {isEdge && (
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
            onClick={() => void decide('dismiss', '已忽略')}
          >
            忽略
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

      {pickingRel && !resolved && (
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
          {p.payload.evidence_refs.map((ref) => (
            <EvidenceChip key={`${ref.kind}:${ref.id}`} er={ref} navigate={navigate} />
          ))}
        </div>
      )}
    </LoomCard>
  );
}
