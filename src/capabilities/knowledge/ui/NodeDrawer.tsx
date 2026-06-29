// M3 知识面 — 节点详情抽屉（YUK-317）。
// 设计基准 docs/design/loom-refresh/project/screen-knowledge.jsx（NodeDrawer）：
// 头部 MasteryRing + 三指标（掌握度/evidence/decay）、「层级 hierarchy」与
// 「关系 typed edges」视觉分离、AI 边提议四动作（接受/反向/改类型/忽略）、
// EdgeCreateForm、foot 打开节点详情页。decay 用非颜色 cue（icon+label）。

import { subjectContentPropsForDomain } from '@/ui/lib/subject';
import { Btn } from '@/ui/primitives/Btn';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { MasteryRing } from '@/ui/primitives/MasteryRing';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { BandChip } from './BandChip';
import { InteractiveArtifactDiscovery } from './KnowledgeDetailPage';
import { REL_CUE } from './MeshGraph';
import {
  type EdgeProposalInboxRow,
  type KnowledgeEdgeRow,
  type KnowledgeTreeNode,
  createEdge,
  decideEdgeProposal,
  getNodePage,
} from './knowledge-api';

// decay → 非颜色 cue（设计稿 DECAY_META；bucket 与 server 的
// mastery_decay_bucket 不同——树行没有 bucket，按 mastery 粗分代理，
// 节点页有精确 bucket。树侧仅作提示。）
export function decayCue(mastery: number | null): { label: string; icon: string; tone: string } {
  if (mastery == null) return { label: '未训练', icon: 'history', tone: 'neutral' };
  if (mastery >= 0.67) return { label: '稳定', icon: 'check', tone: 'good' };
  if (mastery >= 0.45) return { label: '缓降', icon: 'history', tone: 'hard' };
  return { label: '衰减中', icon: 'alert', tone: 'again' };
}

function EdgeProposalRow({
  e,
  nameOf,
  onDecide,
}: {
  e: EdgeProposalInboxRow;
  nameOf: (id: string | undefined) => string;
  onDecide: (decision: 'accept' | 'reverse' | 'change_type' | 'dismiss') => Promise<void>;
}) {
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rel = e.payload.proposed_change.relation_type ?? 'related_to';
  const cue = REL_CUE[rel] ?? REL_CUE.related_to;
  const act = (decision: 'accept' | 'reverse' | 'change_type' | 'dismiss', label: string) => {
    setBusy(true);
    onDecide(decision)
      .then(() => setDone(label))
      .finally(() => setBusy(false));
  };
  if (done)
    return (
      <div className="edge-prop resolved">
        <span className="badge tone-good">
          <LoomIcon name="check" size={12} />
          {done}
        </span>
      </div>
    );
  return (
    <div className="edge-prop">
      <div className="edge-prop-head">
        <span className={`rel-tag rel-tag-${rel}`}>
          <span className="mono">{cue.glyph}</span>
          {cue.label}
        </span>
        {/* de-wenyan: a from→to edge proposal spans two (possibly different)
            subjects and EdgeProposalRow only has names, not domains — no single
            subject to drive from, so fall to the neutral default font. */}
        <span>
          {nameOf(e.payload.proposed_change.from_knowledge_id)} →{' '}
          {nameOf(e.payload.proposed_change.to_knowledge_id)}
        </span>
        {e.payload.proposed_change.weight != null && (
          <span className="meta mono" style={{ marginLeft: 'auto' }}>
            {Math.round(e.payload.proposed_change.weight * 100)}%
          </span>
        )}
      </div>
      <div className="edge-prop-acts">
        <Btn
          size="sm"
          variant="good"
          icon="check"
          disabled={busy}
          onClick={() => act('accept', '接受')}
        >
          接受
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          icon="reverse"
          disabled={busy}
          onClick={() => act('reverse', '已反向接受')}
        >
          反向
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          icon="close"
          disabled={busy}
          onClick={() => act('dismiss', '已忽略')}
        >
          忽略
        </Btn>
      </div>
    </div>
  );
}

export function NodeDrawer({
  node,
  nodes,
  edges,
  edgeProposals,
  open,
  onClose,
  go,
}: {
  node: KnowledgeTreeNode | null;
  nodes: KnowledgeTreeNode[];
  edges: KnowledgeEdgeRow[];
  edgeProposals: EdgeProposalInboxRow[];
  open: boolean;
  onClose: () => void;
  go: (to: string) => void;
}) {
  const qc = useQueryClient();
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(open, onClose, panelRef);
  const [rel, setRel] = useState<string>('related_to');
  const [target, setTarget] = useState('');

  const createM = useMutation({
    mutationFn: () =>
      createEdge({
        from_knowledge_id: node?.id ?? '',
        to_knowledge_id: target,
        relation_type: rel,
      }),
    onSuccess: () => {
      setTarget('');
      void qc.invalidateQueries({ queryKey: ['knowledge-edges'] });
    },
  });

  // ADR-0033 D5 — interactive artifact discovery in the drawer. The drawer host
  // (KnowledgePage) only fetches the tree/edges/proposals, not per-node pages, so
  // the drawer fetches the node page itself for the picked node to read
  // interactive_artifacts. Best-effort: enabled only while open; on error/empty
  // the section renders nothing (InteractiveArtifactDiscovery gates on length).
  const nodePageQ = useQuery({
    queryKey: ['knowledge-node', node?.id],
    queryFn: () => getNodePage(node?.id ?? ''),
    enabled: open && node != null,
  });
  const interactiveArtifacts = nodePageQ.data?.interactive_artifacts ?? [];

  if (!node) return null;
  const parent = nodes.find((n) => n.id === node.parent_id) ?? null;
  const children = nodes.filter((n) => n.parent_id === node.id);
  const rels = edges.filter(
    (e) => e.from_knowledge_id === node.id || e.to_knowledge_id === node.id,
  );
  const other = (e: KnowledgeEdgeRow) =>
    nodes.find(
      (n) => n.id === (e.from_knowledge_id === node.id ? e.to_knowledge_id : e.from_knowledge_id),
    );
  const props = edgeProposals.filter(
    (p) =>
      p.payload.proposed_change.from_knowledge_id === node.id ||
      p.payload.proposed_change.to_knowledge_id === node.id,
  );
  const cue = decayCue(node.mastery);

  return (
    <>
      {/* scrim 点击关闭；键盘路径走 focus trap 的 Esc（M2 PfCoach 同形态） */}
      <div
        className={`scrim${open ? ' open' : ''}`}
        onClick={onClose}
        onKeyDown={() => {}}
        role="presentation"
      />
      <aside
        ref={panelRef as never}
        className={`drawer${open ? ' open' : ''}`}
        // biome-ignore lint/a11y/useSemanticElements: CSS-class 驱动的 .open 抽屉与
        // native <dialog> imperative API 不兼容（同 CopilotDrawer/PfCoach 先例）
        role="dialog"
        aria-modal={open}
        aria-label={node.name}
        aria-hidden={!open}
      >
        <div className="drawer-head">
          {/* ⑥治理：头环去裸 pct，档由下方 node-metrics 的 BandChip 给。 */}
          <MasteryRing mastery={node.mastery} size={40} showNumber={false} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="drawer-title serif">{node.name}</div>
            <div className="meta mono">{node.effective_domain ?? node.domain ?? '—'}</div>
          </div>
          <IconBtn icon="close" size={16} title="关闭" onClick={onClose} />
        </div>

        <div className="drawer-body">
          <div className="node-metrics">
            <div className="nm">
              {/* A5 S1 (YUK-354) — 离散档 BandChip 替代裸 {pct}%（⑥治理：绝不裸概率）。 */}
              <div className="nm-n">
                <BandChip input={node} />
              </div>
              <div className="nm-l meta">掌握度</div>
            </div>
            <div className="nm">
              <div className="nm-n serif">{node.evidence_count}</div>
              <div className="nm-l meta">evidence</div>
            </div>
            <div className="nm">
              <div className="nm-n">
                <span className={`badge tone-${cue.tone}`}>
                  <LoomIcon name={cue.icon as never} size={12} />
                  {cue.label}
                </span>
              </div>
              <div className="nm-l meta">decay</div>
            </div>
          </div>

          {/* 层级块——与 typed 关系视觉分离（设计稿 L187 注释） */}
          <div className="drawer-sec">
            <div className="drawer-sec-h">
              <LoomIcon name="tree" size={14} />
              层级 hierarchy
            </div>
            {parent ? (
              <button
                type="button"
                className="rel-row"
                onClick={() => go(`/knowledge/${parent.id}`)}
              >
                <span className="rel-kind mono">parent</span>
                {/* subject-driven from the neighbour's own effective_domain */}
                <span {...subjectContentPropsForDomain(parent.effective_domain)}>
                  {parent.name}
                </span>
                <LoomIcon name="arrow" size={13} />
              </button>
            ) : (
              <div className="quiet-empty">根节点（无父）</div>
            )}
            {children.map((c) => (
              <button
                type="button"
                key={c.id}
                className="rel-row indent"
                onClick={() => go(`/knowledge/${c.id}`)}
              >
                <span className="rel-kind mono">child</span>
                <span {...subjectContentPropsForDomain(c.effective_domain)}>{c.name}</span>
                {/* ⑥治理：抽屉子节点是 KnowledgeTreeNode（已带 band 字段）→ 直接 BandChip 给离散档
                    （设计源 screen-knowledge.jsx:250 子行即 BandChip）。详情页子行是 NodePageChild
                    仅 {id,name,mastery}，那里才需扩字段 follow-up（reviewer minor #2）。 */}
                <BandChip input={c} />
              </button>
            ))}
          </div>

          <div className="drawer-sec">
            <div className="drawer-sec-h">
              <LoomIcon name="link" size={14} />
              关系 typed edges
            </div>
            {rels.length === 0 && <div className="quiet-empty">暂无 typed 关系。</div>}
            {rels.map((e) => {
              const o = other(e);
              const c = REL_CUE[e.relation_type] ?? REL_CUE.related_to;
              if (!o) return null;
              return (
                <button
                  type="button"
                  key={e.id}
                  className="rel-row"
                  onClick={() => go(`/knowledge/${o.id}`)}
                >
                  <span className={`rel-tag rel-tag-${e.relation_type}`}>
                    <span className="mono">{c.glyph}</span>
                    {c.label}
                  </span>
                  <span {...subjectContentPropsForDomain(o.effective_domain)}>{o.name}</span>
                  <LoomIcon name="arrow" size={13} />
                </button>
              );
            })}
          </div>

          {/* ADR-0033 D5 — 互动产物 discovery（best-effort node-page 取数；空/失败
              整块不渲染）。行链到 /notes/{id}（互动产物复用 NoteReader 阅读壳）。 */}
          {interactiveArtifacts.length > 0 && (
            <div className="drawer-sec">
              <div className="drawer-sec-h">
                <LoomIcon name="sparkle" size={14} />
                互动产物 · {interactiveArtifacts.length}
              </div>
              <InteractiveArtifactDiscovery artifacts={interactiveArtifacts} go={go} />
            </div>
          )}

          {props.length > 0 && (
            <div className="drawer-sec">
              <div className="drawer-sec-h">
                <LoomIcon name="sparkle" size={14} />
                AI 提议的边 · {props.length}
              </div>
              {props.map((p) => (
                <EdgeProposalRow
                  key={p.id}
                  e={p}
                  nameOf={(kid) => nodes.find((n) => n.id === kid)?.name ?? kid ?? '?'}
                  onDecide={async (decision) => {
                    await decideEdgeProposal(p.id, decision);
                    // M4-T5 (YUK-318)：服务端 pending 过滤生效——invalidate 后
                    // 已决行自然退出，无需向宿主上报 decided 集合。
                    void qc.invalidateQueries({ queryKey: ['knowledge-edges'] });
                    void qc.invalidateQueries({ queryKey: ['knowledge-edge-proposals'] });
                  }}
                />
              ))}
            </div>
          )}

          {/* 手动建边（设计稿 EdgeCreateForm 精简版：关系类型 + 目标节点） */}
          <div className="drawer-sec">
            <div className="drawer-sec-h">
              <LoomIcon name="pencil" size={14} />
              建立关系
            </div>
            <div className="seg seg-sm" role="tablist" aria-label="关系类型">
              {Object.entries(REL_CUE).map(([k, c]) => (
                <button
                  type="button"
                  key={k}
                  role="tab"
                  aria-selected={rel === k}
                  className={rel === k ? 'on' : ''}
                  onClick={() => setRel(k)}
                >
                  <span className="mono">{c.glyph}</span>
                  {c.label}
                </button>
              ))}
            </div>
            <select
              className="input"
              style={{ marginTop: 'var(--s-2)', width: '100%' }}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-label="目标节点"
            >
              <option value="">选择目标节点…</option>
              {nodes
                .filter((n) => n.id !== node.id)
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
            </select>
            <Btn
              variant="primary"
              size="sm"
              icon="pencil"
              disabled={!target || createM.isPending}
              style={{ marginTop: 'var(--s-3)' }}
              onClick={() => createM.mutate()}
            >
              建立 {REL_CUE[rel]?.label} 边
            </Btn>
            {createM.isError && (
              <div className="meta" style={{ color: 'var(--again-ink)', marginTop: 4 }}>
                {(createM.error as Error).message}
              </div>
            )}
          </div>
        </div>

        <div className="drawer-foot">
          <Btn variant="primary" block iconEnd="arrow" onClick={() => go(`/knowledge/${node.id}`)}>
            打开节点详情页
          </Btn>
        </div>
      </aside>
    </>
  );
}
