// Node drawer: reads the selected node's public judgment and keeps relationship
// operations separate from the read-only assessment.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeftRight,
  ArrowRight,
  Check,
  ChevronRight,
  Link2,
  ListTree,
  PencilLine,
  Sparkles,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { subjectContentPropsForDomain } from '@/ui/lib/subject';
import { openCopilot, setCompanionFocus } from '@/ui/lib/use-copilot-dwell';
import { invalidateAfterProposalDecision, queryKeys } from '@/ui/lib/write-invalidation';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, ChipToggle, IconButton } from '@/ui-next/public';

import { BandChip } from './BandChip';
import { RelTag } from './KnowledgeChips';
import { InteractiveArtifactDiscovery } from './KnowledgeDetailPage';
import {
  type EdgeProposalInboxRow,
  type KnowledgeEdgeRow,
  type KnowledgeTreeNode,
  edgeProposalOperation,
} from './knowledge-api';
import { useKnowledgeClient } from './knowledge-client';
import { knowledgeNodeDrawerQueryOptions } from './knowledge-node-query';
import { NodeJudgment } from './NodeJudgment';
import { REL_CUE } from './relation-cue';

// decay → 非颜色 cue（设计稿 DECAY_META；bucket 与 server 的
// mastery_decay_bucket 不同——树行没有 bucket，按 mastery 粗分代理，
// 节点页有精确 bucket。树侧仅作提示。）
// SEE ALSO（YUK-551, spec Q3）: 本函数的 0.67/0.45 是 S5/YUK-335 跨三面统一点的第三面（ring
// disc masteryTone + 本 decay pill + legend——本面正是当年漂移出 0.7/0.4 vs 0.67/0.45 分裂的
// 那面,audit §3.8）。阈值语义、与 frontier gate 0.7+evidence-floor(4) 的分工、对齐的三面同步
// 成本见 mastery-tone.ts 顶注与 docs/design/2026-07-03-frontier-gate-spec.md §Q3；任何对齐
// 动作须三面同步,勿单改本函数。
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
  const [failed, setFailed] = useState(false);
  const operation = edgeProposalOperation(e);
  const isArchive = operation === 'archive';
  const retired = operation === 'retired';
  const archiveTargetMissing = isArchive && !e.payload.proposed_change.archive_edge_id;
  let operationLabel = '新增关系';
  if (isArchive) operationLabel = archiveTargetMissing ? '归档目标缺失' : '归档关系';
  if (retired) operationLabel = '替换关系，已不再支持，只能忽略';
  const rel = e.payload.proposed_change.relation_type ?? 'related_to';
  const cue = REL_CUE[rel] ?? REL_CUE.related_to;
  const act = (decision: 'accept' | 'reverse' | 'change_type' | 'dismiss', label: string) => {
    setBusy(true);
    setFailed(false);
    onDecide(decision)
      .then(() => setDone(label))
      // 409/500 → 不再让 promise 静默 reject（未捕获），点亮失败提示；.finally 复位
      // busy 后按钮重新可点即为重试入口（mirror createM.isError 先例）。记 console 便于诊断。
      .catch((err) => {
        console.error('[EdgeProposalRow] decide failed:', err);
        setFailed(true);
      })
      .finally(() => setBusy(false));
  };
  if (done)
    return (
      <li className="kn-prop" data-resolved="">
        <span className="kn-tag kn-tag-positive">
          <Check size={13} aria-hidden="true" />
          {done}
        </span>
      </li>
    );
  return (
    <li className="kn-prop">
      <div className="kn-prop-head">
        <span className={`kn-tag ${isArchive ? 'kn-tag-critical' : 'kn-tag-accent'}`}>
          {isArchive ? (
            <Archive size={13} aria-hidden="true" />
          ) : (
            <Link2 size={13} aria-hidden="true" />
          )}
          {operationLabel}
        </span>
        <RelTag rel={rel} cue={cue} />
        {/* de-wenyan: a from→to edge proposal spans two (possibly different)
            subjects and EdgeProposalRow only has names, not domains — no single
            subject to drive from, so fall to the neutral default font. */}
        <span className="kn-prop-names">
          {nameOf(e.payload.proposed_change.from_knowledge_id)} →{' '}
          {nameOf(e.payload.proposed_change.to_knowledge_id)}
        </span>
      </div>
      <div className="kn-prop-acts">
        {!retired && (
          <Button
            size="sm"
            className={isArchive ? 'kn-btn-critical' : undefined}
            disabled={busy || archiveTargetMissing}
            onClick={() => act('accept', isArchive ? '已归档' : '已建立')}
          >
            {isArchive ? (
              <Archive size={14} aria-hidden="true" />
            ) : (
              <Check size={14} aria-hidden="true" />
            )}
            {isArchive ? '确认归档' : '建立关系'}
          </Button>
        )}
        {!isArchive && !retired && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => act('reverse', '已反向接受')}
          >
            <ArrowLeftRight size={14} aria-hidden="true" />
            反向
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => act('dismiss', isArchive ? '已保留' : '已忽略')}
        >
          <X size={14} aria-hidden="true" />
          {isArchive ? '保留关系' : '忽略'}
        </Button>
      </div>
      {failed && (
        <p className="kn-error-line" role="alert">
          操作失败，请重试。
        </p>
      )}
    </li>
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
  const { createEdge, decideEdgeProposal, getNodePage } = useKnowledgeClient();
  const trapRef = useFocusTrap(open, onClose);
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
      void qc.invalidateQueries({ queryKey: queryKeys.knowledgeEdges });
    },
  });

  // The host only reads tree/edges/proposals. Judgment and artifacts share this
  // node-page response, keyed to the selected node even during a failed refresh.
  const nodePageQ = useQuery({
    ...knowledgeNodeDrawerQueryOptions(node?.id ?? '', getNodePage),
    enabled: open && node != null,
  });
  const nodePage = nodePageQ.data?.id === node?.id ? nodePageQ.data : undefined;
  const interactiveArtifacts = nodePage?.interactive_artifacts ?? [];

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
  const name = nodePage?.name ?? node.name;
  const discussJudgment = () => {
    if (!nodePage) return;
    onClose();
    setCompanionFocus({ kind: 'knowledge', id: nodePage.id, title: nodePage.name });
    openCopilot(
      `关于「${nodePage.name}」的当前判断（评估时点 ${new Date(nodePage.judgment.batch.as_of).toLocaleString('zh-CN')}）：\n\n${nodePage.judgment.judgement}\n\n我的疑问是：`,
      { send: false },
    );
  };

  return (
    <>
      {/* scrim 点击关闭；键盘路径走 focus trap 的 Esc（M2 PfCoach 同形态） */}
      <div
        className={`kn-scrim${open ? ' open' : ''}`}
        onClick={onClose}
        onKeyDown={() => {}}
        role="presentation"
      />
      <aside
        ref={trapRef}
        className={`kn-drawer un-glass${open ? ' open' : ''}`}
        // biome-ignore lint/a11y/useSemanticElements: CSS-class 驱动的 .open 抽屉与
        // native <dialog> imperative API 不兼容（同 CopilotDrawer/PfCoach 先例）
        role="dialog"
        aria-modal={open}
        aria-label={name}
        aria-hidden={!open}
      >
        <div className="kn-drawer-head">
          <h2 className="kn-drawer-title">{name}</h2>
          <IconButton label="关闭" icon={<X size={18} />} onClick={onClose} />
        </div>

        <div className="kn-drawer-body">
          {!nodePage && nodePageQ.isPending && (
            <SkeletonLines rows={4} label="正在读取当前判断与依据" />
          )}
          {nodePageQ.isError && (
            <RetryLine
              message={
                nodePage ? '判断更新失败，以下保留上次读取结果。' : '当前判断与依据读取失败。'
              }
              onRetry={() => void nodePageQ.refetch()}
            />
          )}
          {!nodePage && !nodePageQ.isPending && !nodePageQ.isError && (
            <RetryLine
              message="没有读到当前知识点的判断与依据。"
              onRetry={() => void nodePageQ.refetch()}
            />
          )}
          {nodePage && (
            <>
              {nodePageQ.isFetching && (
                <p className="kn-quiet" role="status">
                  正在更新判断，以下为上次读取结果。
                </p>
              )}
              <NodeJudgment judgment={nodePage.judgment} onDiscussJudgment={discussJudgment} />
              <dl className="kn-metrics">
                {nodePage.role !== 'kc' ? (
                  <div className="kn-metric">
                    <dt>节点类型</dt>
                    <dd>
                      <span className="kn-tag">
                        {nodePage.role === 'goal' ? '学习目标' : '知识容器'}
                      </span>
                    </dd>
                  </div>
                ) : (
                  <>
                    <div className="kn-metric">
                      <dt>掌握读数</dt>
                      <dd>
                        <BandChip input={nodePage} />
                      </dd>
                    </div>
                    <div className="kn-metric">
                      <dt>学习依据</dt>
                      <dd className="un-num">{nodePage.evidence_count}</dd>
                    </div>
                  </>
                )}
              </dl>
            </>
          )}

          {/* 层级块——与 typed 关系视觉分离（设计稿 L187 注释） */}
          <section className="kn-dsec" aria-labelledby="kn-dsec-tree">
            <h3 id="kn-dsec-tree" className="kn-dsec-h">
              <ListTree size={14} aria-hidden="true" />
              层级
            </h3>
            {parent ? (
              <button
                type="button"
                className="kn-rel-row"
                onClick={() => go(`/knowledge/${parent.id}`)}
              >
                <span className="kn-rel-kind">上级</span>
                {/* subject-driven from the neighbour's own effective_domain */}
                <span
                  {...subjectContentPropsForDomain(parent.effective_domain, {
                    className: 'kn-rel-name',
                  })}
                >
                  {parent.name}
                </span>
                <ChevronRight size={15} aria-hidden="true" className="kn-row-arrow" />
              </button>
            ) : (
              <p className="kn-quiet">这是顶层知识点</p>
            )}
            {children.map((c) => (
              <button
                type="button"
                key={c.id}
                className="kn-rel-row is-indent"
                onClick={() => go(`/knowledge/${c.id}`)}
              >
                <span className="kn-rel-kind">下级</span>
                <span
                  {...subjectContentPropsForDomain(c.effective_domain, {
                    className: 'kn-rel-name',
                  })}
                >
                  {c.name}
                </span>
                {/* ⑥治理：抽屉子节点是 KnowledgeTreeNode（已带 band 字段）→ 直接 BandChip 给离散档
                    （设计源 screen-knowledge.jsx:250 子行即 BandChip）。详情页子行是 NodePageChild
                    仅 {id,name,mastery}，那里才需扩字段 follow-up（reviewer minor #2）。 */}
                <BandChip input={c} />
              </button>
            ))}
          </section>

          <section className="kn-dsec" aria-labelledby="kn-dsec-rels">
            <h3 id="kn-dsec-rels" className="kn-dsec-h">
              <Link2 size={14} aria-hidden="true" />
              其他关系
            </h3>
            {rels.length === 0 && <p className="kn-quiet">暂无其他关系。</p>}
            {rels.map((e) => {
              const o = other(e);
              const c = REL_CUE[e.relation_type] ?? REL_CUE.related_to;
              if (!o) return null;
              return (
                <button
                  type="button"
                  key={e.id}
                  className="kn-rel-row"
                  onClick={() => go(`/knowledge/${o.id}`)}
                >
                  <RelTag rel={e.relation_type} cue={c} />
                  <span
                    {...subjectContentPropsForDomain(o.effective_domain, {
                      className: 'kn-rel-name',
                    })}
                  >
                    {o.name}
                  </span>
                  <ChevronRight size={15} aria-hidden="true" className="kn-row-arrow" />
                </button>
              );
            })}
          </section>

          {/* ADR-0033 D5 — 互动产物 discovery（best-effort node-page 取数；空/失败
              整块不渲染）。行链到 /notes/{id}（互动产物复用 NoteReader 阅读壳）。 */}
          {interactiveArtifacts.length > 0 && (
            <section className="kn-dsec" aria-labelledby="kn-dsec-interactive">
              <h3 id="kn-dsec-interactive" className="kn-dsec-h">
                <Sparkles size={14} aria-hidden="true" />
                互动产物 · {interactiveArtifacts.length}
              </h3>
              <InteractiveArtifactDiscovery
                artifacts={interactiveArtifacts}
                go={go}
                entryId={node.id}
              />
            </section>
          )}

          {props.length > 0 && (
            <section className="kn-dsec" aria-labelledby="kn-dsec-props">
              <h3 id="kn-dsec-props" className="kn-dsec-h">
                <Sparkles size={14} aria-hidden="true" />
                AI 提议的关系变更 · {props.length}
              </h3>
              <ul className="kn-props">
                {props.map((p) => (
                  <EdgeProposalRow
                    key={p.id}
                    e={p}
                    nameOf={(kid) => nodes.find((n) => n.id === kid)?.name ?? '未命名知识点'}
                    onDecide={async (decision) => {
                      await decideEdgeProposal(p.id, decision);
                      // M4-T5 (YUK-318)：服务端 pending 过滤生效——刷新后已决行自然退出；
                      // 同时刷新侧栏收件箱计数等裁决影响到的读面。
                      void invalidateAfterProposalDecision(qc, { kind: 'knowledge_edge' });
                    }}
                  />
                ))}
              </ul>
            </section>
          )}

          {/* 手动建边（设计稿 EdgeCreateForm 精简版：关系类型 + 目标节点）。关系类型是一排
              只响应点击的芯片（aria-pressed），不是单选组：方向键不会悄悄改掉要建的类型。 */}
          <section className="kn-dsec" aria-labelledby="kn-dsec-create">
            <h3 id="kn-dsec-create" className="kn-dsec-h">
              <PencilLine size={14} aria-hidden="true" />
              建立关系
            </h3>
            <fieldset className="kn-rel-pick">
              <legend className="un-sr-only">关系类型</legend>
              {Object.entries(REL_CUE).map(([k, c]) => (
                <ChipToggle key={k} pressed={rel === k} onPressedChange={() => setRel(k)}>
                  <span className="kn-glyph" aria-hidden="true">
                    {c.glyph}
                  </span>
                  {c.label}
                </ChipToggle>
              ))}
            </fieldset>
            <select
              className="kn-select"
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
            <div className="kn-create-acts">
              <Button
                size="sm"
                disabled={!target || createM.isPending}
                onClick={() => createM.mutate()}
              >
                <PencilLine size={14} aria-hidden="true" />
                建立「{REL_CUE[rel]?.label}」关系
              </Button>
            </div>
            {createM.isError && <p className="kn-error-line">关系建立失败，请重试。</p>}
          </section>
        </div>

        <div className="kn-drawer-foot">
          <Button
            variant="primary"
            className="kn-btn-block"
            onClick={() => go(`/knowledge/${node.id}`)}
          >
            打开知识点详情
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </div>
      </aside>
    </>
  );
}
