// M3 知识面 — 图谱页 host（YUK-317）。
// 设计基准 docs/design/loom-refresh/project/screen-knowledge.jsx（ScreenKnowledge）：
// 树/图谱 seg 双视图（「树是骨架（parent/child），mesh 是 5 类 typed 关系。
// 点节点看详情抽屉；图可平移缩放。」）+ AI 提议横幅 + know-node 树行
//（MasteryRing + decay 非颜色 Badge + evidence/mesh 计数）+ NodeDrawer。
// 「新建节点」「集中审批」后端属 M4 工作台/收件箱——占位 toast（M2 先例）。
// wrapper 带 .knowledge-loom：树类（know-node 族）在 globals.css 按该 scope
// 落地（collision scoping），SPA 页复用同一 scope；M5 样式收编时统一。

import { subjectContentPropsForDomain } from '@/ui/lib/subject';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { MasteryRing } from '@/ui/primitives/MasteryRing';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import './knowledge.css';

import { BandChip } from './BandChip';
import { FrontierRail } from './FrontierRail';
import { MeshGraph } from './MeshGraph';
import { NodeDrawer, decayCue } from './NodeDrawer';
import {
  type KnowledgeTreeNode,
  getEdgeProposals,
  getEdges,
  getFrontier,
  getTree,
} from './knowledge-api';

export interface KnowledgePageProps {
  navigate: (to: string) => void;
}

// 树行排序：父子邻接（DFS），根在前——设计稿树视图按 depth 缩进。
function dfsOrder(nodes: KnowledgeTreeNode[]): Array<KnowledgeTreeNode & { depth: number }> {
  const byParent = new Map<string | null, KnowledgeTreeNode[]>();
  for (const n of nodes) {
    const k = n.parent_id ?? null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)?.push(n);
  }
  const out: Array<KnowledgeTreeNode & { depth: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const n of byParent.get(parentId) ?? []) {
      out.push({ ...n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  // 孤儿（父被归档等）按根级补尾，避免静默丢行。
  const seen = new Set(out.map((n) => n.id));
  for (const n of nodes) if (!seen.has(n.id)) out.push({ ...n, depth: 0 });
  return out;
}

export default function KnowledgePage({ navigate }: KnowledgePageProps) {
  const [view, setView] = useState<'tree' | 'graph'>('tree');
  const [picked, setPicked] = useState<KnowledgeTreeNode | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const treeQ = useQuery({ queryKey: ['knowledge-tree'], queryFn: getTree });
  const edgesQ = useQuery({ queryKey: ['knowledge-edges'], queryFn: getEdges });
  const edgePropsQ = useQuery({
    queryKey: ['knowledge-edge-proposals'],
    queryFn: getEdgeProposals,
  });
  // A5 S2 (YUK-354)：learnable_frontier 横幅读模型。
  const frontierQ = useQuery({ queryKey: ['knowledge-frontier'], queryFn: getFrontier });

  const nodes = useMemo(() => treeQ.data?.rows ?? [], [treeQ.data]);
  const edges = useMemo(() => edgesQ.data?.rows ?? [], [edgesQ.data]);
  // M4-T5 (YUK-318)：服务端已按 kind=knowledge_edge&status=pending 过滤——
  // 已决提议不复返，旧的客户端 decided 集合 + outcome 过滤随换源删除。
  const edgeProposals = edgePropsQ.data?.rows ?? [];
  const frontierItems = frontierQ.data?.rows ?? [];
  const ordered = useMemo(() => dfsOrder(nodes), [nodes]);

  const placeholder = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 5000);
  };

  return (
    <main className="page wide knowledge-loom">
      <div className="page-head">
        <div className="eyebrow">
          KNOWLEDGE · {nodes.length} nodes · {edges.length} edges (mesh)
        </div>
        <div className="page-head-row">
          <h1 className="page-title serif">知识</h1>
          <div className="hero-cta">
            <div className="seg" role="tablist" aria-label="知识视图">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'tree'}
                className={view === 'tree' ? 'on' : ''}
                onClick={() => setView('tree')}
              >
                <LoomIcon name="tree" size={15} />树
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'graph'}
                className={view === 'graph' ? 'on' : ''}
                onClick={() => setView('graph')}
              >
                <LoomIcon name="graph" size={15} />
                图谱
              </button>
            </div>
            <Btn
              variant="primary"
              icon="plus"
              onClick={() =>
                placeholder('新建节点随 M4 工作台/提议链收口——当前节点由录入与 AI 提议生长。')
              }
            >
              新建节点
            </Btn>
          </div>
        </div>
        <p className="page-lead">
          树是骨架（parent/child），mesh 是 5 类 typed 关系。点节点看详情抽屉；图可平移缩放。
        </p>
      </div>

      {/* A5 S2 (YUK-354)：「下一步学什么」learnable_frontier 横幅（建议非必经路）。
          知识网为空时不显（大 EmptyState 已覆盖该态，避免双空态）。 */}
      {nodes.length > 0 && <FrontierRail items={frontierItems} navigate={navigate} />}

      {edgeProposals.length > 0 && (
        <div
          className="card card-pad"
          style={{
            marginBottom: 'var(--s-5)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s-4)',
            flexWrap: 'wrap',
            borderColor: 'var(--coral-line)',
          }}
        >
          <span className="card-icon accent">
            <LoomIcon name="link" size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ fontWeight: 500 }}>AI 提议了 {edgeProposals.length} 条新关系</div>
            <div className="meta">
              来自夜间 Dreaming + Maintenance · 选中节点后在抽屉内 accept / reverse / dismiss
            </div>
          </div>
          <Btn
            size="sm"
            variant="secondary"
            iconEnd="arrow"
            onClick={() => placeholder('集中审批进收件箱——M4 工作台收口后接通。')}
          >
            集中审批
          </Btn>
        </div>
      )}

      {treeQ.isLoading ? (
        <p className="quiet-empty">取知识网…</p>
      ) : treeQ.isError ? (
        <p className="quiet-empty">知识图加载失败：{(treeQ.error as Error).message}</p>
      ) : nodes.length === 0 ? (
        <EmptyState
          icon="knowledge"
          title="知识网为空"
          text="录入材料后，AI 会从中抽取节点并提议关系。"
        />
      ) : view === 'tree' ? (
        <div className="card">
          {ordered.map((n) => {
            const cue = decayCue(n.mastery);
            const meshCount = edges.filter(
              (e) => e.from_knowledge_id === n.id || e.to_knowledge_id === n.id,
            ).length;
            return (
              <button
                type="button"
                key={n.id}
                className={`know-node${cue.tone === 'again' ? ' hot' : ''}`}
                style={{
                  paddingLeft: `calc(var(--s-5) + ${n.depth * 22}px)`,
                  width: '100%',
                  textAlign: 'left',
                  border: 0,
                  background: 'transparent',
                }}
                onClick={() => setPicked(n)}
              >
                {n.depth > 0 && <span className="know-twig">└</span>}
                {/* ⑥治理：树行环去裸 pct（showNumber=false），档由 know-end 的 BandChip 给。 */}
                <MasteryRing mastery={n.mastery} size={30} showNumber={false} />
                {/* subject-driven: serif-CJK only for genuine wenyan nodes */}
                <span
                  {...subjectContentPropsForDomain(n.effective_domain, { className: 'know-title' })}
                >
                  {n.name}
                </span>
                {n.effective_domain && (
                  <span className="chip chip-k mono">{n.effective_domain}</span>
                )}
                <span className={`badge tone-${cue.tone}`}>
                  <LoomIcon name={cue.icon as never} size={11} />
                  {cue.label}
                </span>
                <div className="know-end">
                  {/* A5 S1 (YUK-354) — 离散档 BandChip（设计源 screen-knowledge.jsx:357
                      在 know-end 内）：档 + 区间 + 来源 + 低置信，定性表达 p(L) 轴。前置
                      MasteryRing(tone 色环)保留——tone 颜色与 band 档正交（⑥ + 阶段4 红线）。 */}
                  <BandChip input={n} />
                  <span className="meta mono">{n.evidence_count} ev</span>
                  {meshCount > 0 && (
                    <span className="badge tone-info">
                      <LoomIcon name="link" size={11} />
                      {meshCount}
                    </span>
                  )}
                  <LoomIcon name="arrow" size={15} className="thread-arrow" />
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <MeshGraph nodes={nodes} edges={edges} onPick={setPicked} activeId={picked?.id} />
      )}

      <NodeDrawer
        node={picked}
        nodes={nodes}
        edges={edges}
        edgeProposals={edgeProposals}
        open={!!picked}
        onClose={() => setPicked(null)}
        go={navigate}
      />

      {toast && (
        <div className="pf-toasts" aria-live="polite">
          <div className="pf-toast t-info">
            <LoomIcon name="sparkle" size={15} className="ico" />
            <span>{toast}</span>
          </div>
        </div>
      )}
    </main>
  );
}
