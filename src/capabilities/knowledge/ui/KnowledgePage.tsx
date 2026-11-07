// M3 知识面 — 图谱页 host（YUK-317）。
// 设计基准 docs/design/loom-refresh/project/screen-knowledge.jsx（ScreenKnowledge）：
// 树/图谱双视图（「树是骨架（parent/child），mesh 是 5 类 typed 关系。
// 点节点看详情抽屉；图可平移缩放。」）+ AI 提议横幅 + 树行
//（MasteryDial + decay 非颜色标签 + evidence/mesh 计数）+ NodeDrawer。
// 「集中审批」进入现有收件箱；没有已交付 write path 的「新建节点」不展示假入口。
// M3E 呈现（YUK-1473）：外壳 UiNextRoot.kn-page + main.un-m3e-bridge，样式在 knowledge-m3e.css，
// 记录见 docs/design/2026-11-03-knowledge-m3e.md。

import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  ChevronRight,
  Layers,
  Link2,
  ListTree,
  Network,
  RotateCcw,
} from 'lucide-react';
import { type CSSProperties, Suspense, lazy, useMemo, useState } from 'react';
import { useSubjects } from '@/ui/hooks/useSubjects';
import {
  type SubjectRowLike,
  listSubjectChoices,
  subjectContentPropsForDomain,
} from '@/ui/lib/subject';
import { queryKeys } from '@/ui/lib/write-invalidation';
import { ToastHost } from '@/ui-next/feedback/ToastHost';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, ChipToggle, Segmented, UiNextRoot } from '@/ui-next/public';
import './knowledge-m3e.css';

import { BandChip } from './BandChip';
import { FrontierRail } from './FrontierRail';
import { deriveGhostEndpoints } from './ghost-endpoints';
import { DecayChip } from './KnowledgeChips';
import { KnowledgeEmpty } from './KnowledgeEmpty';
import {
  type KnowledgeTreeNode,
  getFrontier,
  getReviewDueSummary,
  getTreeForSubject,
} from './knowledge-api';
import { useKnowledgeClient } from './knowledge-client';
import { isKnowledgeContainer } from './knowledge-node-kind';
import { MasteryDial } from './MasteryDial';
import { NodeDrawer, decayCue } from './NodeDrawer';

const LazyMeshGraph = lazy(async () => {
  const { MeshGraph } = await import('./MeshGraph');
  return { default: MeshGraph };
});

export interface KnowledgePageProps {
  navigate: (to: string) => void;
  readTree?: typeof getTreeForSubject;
  readFrontier?: typeof getFrontier;
  readReviewDue?: typeof getReviewDueSummary;
}

export const KNOWLEDGE_INBOX_HREF = '/inbox';

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

const VIEW_OPTIONS = [
  {
    value: 'tree',
    label: (
      <>
        <ListTree size={15} aria-hidden="true" />树
      </>
    ),
  },
  {
    value: 'graph',
    label: (
      <>
        <Network size={15} aria-hidden="true" />
        图谱
      </>
    ),
  },
] as const;

// One sentence of state under the title; blank until the first tree answer arrives.
function countSentence(loaded: boolean, nodeCount: number, edgeCount: number): string {
  if (!loaded) return ' ';
  return `共 ${nodeCount} 个知识点 · ${edgeCount} 条关系`;
}

// Subject filter: one chip per subject plus 全部; a single choice, announced with aria-pressed
// (click-only buttons, same as the old filter tabs).
function SubjectChips({
  value,
  rows,
  onChange,
}: {
  value: string;
  rows?: readonly SubjectRowLike[];
  onChange: (value: string) => void;
}) {
  const options = [{ id: 'all', label: '全部' }, ...listSubjectChoices(rows)];
  return (
    <fieldset className="kn-subjects">
      <legend className="kn-subjects-legend">科目</legend>
      {options.map((option) => (
        <ChipToggle
          key={option.id}
          pressed={value === option.id}
          onPressedChange={() => onChange(option.id)}
        >
          {option.label}
        </ChipToggle>
      ))}
    </fieldset>
  );
}

export default function KnowledgePage({
  navigate,
  readTree = getTreeForSubject,
  readFrontier = getFrontier,
  readReviewDue = getReviewDueSummary,
}: KnowledgePageProps) {
  const { getEdgeProposals, getEdges } = useKnowledgeClient();
  const [view, setView] = useState<'tree' | 'graph'>('tree');
  const [picked, setPicked] = useState<KnowledgeTreeNode | null>(null);
  const [subject, setSubject] = useState('all');
  const { subjects } = useSubjects();
  const subjectQuery = subject === 'all' ? undefined : subject;

  const treeQ = useQuery({
    queryKey: ['knowledge-tree', subjectQuery],
    queryFn: () => readTree(subjectQuery),
  });
  const fullTreeQ = useQuery({
    queryKey: ['knowledge-tree', undefined],
    queryFn: () => readTree(),
    enabled: subjectQuery !== undefined,
  });
  const edgesQ = useQuery({
    queryKey: [...queryKeys.knowledgeEdges, subjectQuery],
    queryFn: () => getEdges(subjectQuery),
  });
  const edgePropsQ = useQuery({
    queryKey: queryKeys.knowledgeEdgeProposals,
    queryFn: getEdgeProposals,
  });
  // A5 S2 (YUK-354)：learnable_frontier 横幅读模型。
  const frontierQ = useQuery({ queryKey: ['knowledge-frontier'], queryFn: readFrontier });
  // YUK-617 mode-1 — per-KC FSRS 到期计数（YUK-142 Slice 2 读模型此前零消费者）。树行出「到期」徽标。
  const dueQ = useQuery({ queryKey: ['knowledge-due-summary'], queryFn: readReviewDue });
  const dueSummary = dueQ.data?.summary ?? {};

  const nodes = useMemo(() => treeQ.data?.rows ?? [], [treeQ.data]);
  const edges = useMemo(() => edgesQ.data?.rows ?? [], [edgesQ.data]);
  const graphModel = useMemo(
    () =>
      subjectQuery === undefined
        ? { nodes, ghostIds: new Set<string>(), crossEdgeIds: new Set<string>() }
        : deriveGhostEndpoints(nodes, fullTreeQ.data?.rows ?? [], edges),
    [edges, fullTreeQ.data, nodes, subjectQuery],
  );
  const graphNodeIds = useMemo(
    () => new Set(graphModel.nodes.map((node) => node.id)),
    [graphModel.nodes],
  );
  const graphEdges = useMemo(
    () =>
      edges.filter(
        (edge) =>
          graphNodeIds.has(edge.from_knowledge_id) && graphNodeIds.has(edge.to_knowledge_id),
      ),
    [edges, graphNodeIds],
  );
  // M4-T5 (YUK-318)：服务端已按 kind=knowledge_edge&status=pending 过滤——
  // 已决提议不复返，旧的客户端 decided 集合 + outcome 过滤随换源删除。
  const edgeProposals = edgePropsQ.data?.rows ?? [];
  const frontierItems = frontierQ.data?.rows ?? [];
  const ordered = useMemo(() => dfsOrder(nodes), [nodes]);

  const treeRow = (n: KnowledgeTreeNode & { depth: number }) => {
    const cue = decayCue(n.mastery);
    const isContainer = isKnowledgeContainer(n);
    const meshCount = edges.filter(
      (e) => e.from_knowledge_id === n.id || e.to_knowledge_id === n.id,
    ).length;
    return (
      <li key={n.id}>
        <button
          type="button"
          className="kn-tree-row"
          data-hot={cue.tone === 'again' && !isContainer ? '' : undefined}
          data-container={isContainer ? '' : undefined}
          style={{ '--kn-depth': n.depth } as CSSProperties}
          onClick={() => setPicked(n)}
        >
          {n.depth > 0 && (
            <span className="kn-twig" aria-hidden="true">
              └
            </span>
          )}
          {isContainer ? (
            <span className="kn-container-ic" aria-hidden="true">
              <Layers size={17} />
            </span>
          ) : (
            <MasteryDial mastery={n.mastery} size={30} />
          )}
          {/* subject-driven: serif-CJK only for genuine yuwen nodes */}
          <span
            {...subjectContentPropsForDomain(n.effective_domain, { className: 'kn-tree-title' })}
          >
            {n.name}
          </span>
          {isContainer ? <span className="kn-tag">学科容器</span> : <DecayChip cue={cue} />}
          <span className="kn-tree-end">
            {/* A5 S1 (YUK-354) — 离散档 BandChip：档 + 区间 + 来源 + 低置信，定性表达 p(L) 轴。
                前置 MasteryDial(tone 色环)保留——tone 颜色与 band 档正交（⑥ + 阶段4 红线）。 */}
            {!isContainer && <BandChip input={n} />}
            {!isContainer && (
              <span className="kn-tree-meta un-num">{n.evidence_count} 条学习依据</span>
            )}
            {/* Fixed slots, so the same column lines up down the list when a row has nothing here. */}
            <span className="kn-tree-slot">
              {meshCount > 0 && (
                <span className="kn-tag un-num" title={`${meshCount} 条关系`}>
                  <Link2 size={12} aria-hidden="true" />
                  {meshCount}
                </span>
              )}
            </span>
            {/* YUK-617 mode-1 — 本 KC 到期复习卡数（overdue，含=now）。有到期才出，红色提醒。 */}
            <span className="kn-tree-slot">
              {!isContainer && (dueSummary[n.id]?.overdue ?? 0) > 0 && (
                <span className="kn-tag kn-tag-critical un-num" title="到期待复习的知识卡数">
                  <RotateCcw size={12} aria-hidden="true" />
                  到期 {dueSummary[n.id]?.overdue}
                </span>
              )}
            </span>
            <ChevronRight size={16} aria-hidden="true" className="kn-row-arrow" />
          </span>
        </button>
      </li>
    );
  };

  // Loading, failed, empty, tree, graph: one at a time, in the same order as before.
  const body = () => {
    if (treeQ.isLoading) return <SkeletonLines rows={6} label="正在取知识网" />;
    if (treeQ.isError)
      return (
        <RetryLine
          message={`知识图加载失败：${(treeQ.error as Error).message}`}
          onRetry={() => void treeQ.refetch()}
        />
      );
    if (nodes.length === 0)
      return (
        <KnowledgeEmpty
          icon={<Network size={22} />}
          title="知识网为空"
          text="录入材料后，AI 会从中抽取节点并提议关系。"
        />
      );
    if (view === 'tree') return <ul className="kn-tree">{ordered.map(treeRow)}</ul>;
    return (
      <Suspense
        fallback={
          <output className="kn-graph-loading" aria-live="polite" aria-busy="true">
            正在打开关系图…
          </output>
        }
      >
        <LazyMeshGraph
          nodes={graphModel.nodes}
          edges={graphEdges}
          onPick={setPicked}
          activeId={picked?.id}
          navigate={navigate}
        />
      </Suspense>
    );
  };

  return (
    <UiNextRoot className="kn-page">
      <main className="kn-main un-m3e-bridge">
        <header className="kn-head">
          <div className="kn-head-row">
            <h1 className="kn-title">知识</h1>
            <Segmented label="知识视图" value={view} options={VIEW_OPTIONS} onChange={setView} />
          </div>
          <p className="kn-sentence un-num">
            {countSentence(!treeQ.isLoading, nodes.length, edges.length)}
          </p>
          <p className="kn-lead">
            按层级或关系图浏览知识点；选择节点可以查看掌握状态、证据和关联内容。
          </p>
          <SubjectChips value={subject} rows={subjects} onChange={setSubject} />
        </header>

        {/* A5 S2 (YUK-354)：「下一步学什么」learnable_frontier 横幅（建议非必经路）。
            知识网为空时不显（空态已覆盖该态，避免双空态）。frontierQ 的 loading/error
            传进去显式分态，不被折叠成「暂无下一步」业务空态（CodeRabbit）。 */}
        {nodes.length > 0 && (
          <FrontierRail
            items={frontierItems}
            isLoading={frontierQ.isLoading}
            isError={frontierQ.isError}
            onRetry={() => void frontierQ.refetch()}
            navigate={navigate}
          />
        )}

        {edgeProposals.length > 0 && (
          <aside className="kn-proposals" aria-label="AI 关系提议">
            <span className="kn-proposals-ic" aria-hidden="true">
              <Link2 size={18} />
            </span>
            <div className="kn-proposals-text">
              <p className="kn-proposals-title">AI 提议了 {edgeProposals.length} 项关系变更</p>
              <p className="kn-proposals-sub">来自夜间整理 · 可在收件箱统一确认或忽略</p>
            </div>
            <Button size="sm" onClick={() => navigate(KNOWLEDGE_INBOX_HREF)}>
              集中审批
              <ArrowRight size={14} aria-hidden="true" />
            </Button>
          </aside>
        )}

        <section className="kn-body" aria-label={view === 'tree' ? '知识树' : '知识关系图'}>
          {body()}
        </section>

        <NodeDrawer
          node={picked}
          nodes={graphModel.nodes}
          edges={edges}
          edgeProposals={edgeProposals}
          open={!!picked}
          onClose={() => setPicked(null)}
          go={navigate}
        />
      </main>
      <ToastHost />
    </UiNextRoot>
  );
}
