// M3 知识面 — 节点详情页（YUK-317）。
// 设计基准 docs/design/loom-refresh/project/screen-knowledge-detail.jsx：
// hero（掌握环 + decay bucket + R%）+ 两栏——主栏笔记按 kind
// 分组（「knowledge_id 是笔记上的标签 · 笔记按 note_atomic / note_hub /
// note_long 区分，一条笔记可挂多个知识点」：primary atomic 整篇 inline，
// 其余 link rows）+ 邻居按关系分组（层级先行）；侧栏反链按来源类型分组 +
// 活动时间线。「标注笔记」区后端无读路径——M3 空态挂账（pre-flight 偏离③）。
// 「复习此点」把明确请求交给现有 Copilot；没有已交付 write path 的 AI 起草不展示假入口。
// M3E 呈现（YUK-1473）：外壳 UiNextRoot.kn-page + main.un-m3e-bridge，样式在 knowledge-m3e.css，
// 记录见 docs/design/2026-11-03-knowledge-m3e.md。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronRight,
  FileText,
  Link2,
  List,
  ListTree,
  RotateCcw,
  Sparkles,
  Target,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { openCopilot, setCompanionFocus } from '@/ui/lib/use-copilot-dwell';
import { ToastHost } from '@/ui-next/feedback/ToastHost';
import { FoldList } from '@/ui-next/primitives/FoldList';
import { SectionHead } from '@/ui-next/primitives/SectionHead';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, UiNextRoot } from '@/ui-next/public';
import './knowledge-m3e.css';

import { BandChip } from './BandChip';
import { humanizeActivity } from './humanize-activity';
import { DecayChip, RelTag } from './KnowledgeChips';
import { KnowledgeEmpty } from './KnowledgeEmpty';
import type { KnowledgeNodePage, NoteSummary } from './knowledge-api';
import { useKnowledgeClient } from './knowledge-client';
import { knowledgeNodeQueryOptions } from './knowledge-node-query';
import { MasteryDial } from './MasteryDial';
import { MisconceptionList } from './MisconceptionList';
import { DiagnosticDrill, NodeComposite, TransferList } from './NodeComposite';
import { REL_CUE } from './relation-cue';

const DECAY_BUCKET_META: Record<
  KnowledgeNodePage['mastery_decay_bucket'],
  { label: string; icon: string; tone: string }
> = {
  untrained: { label: '未训练', icon: 'history', tone: 'neutral' },
  fresh: { label: '新鲜', icon: 'check', tone: 'good' },
  mild: { label: '缓降', icon: 'history', tone: 'hard' },
  stale: { label: '衰减中', icon: 'alert', tone: 'again' },
  unknown: { label: '未知', icon: 'history', tone: 'neutral' },
};

const NOTE_KIND_LABEL: Record<string, string> = {
  note_atomic: '短笔记',
  note_hub: '汇总笔记',
  note_long: '长文笔记',
};

function NoteLinkRow({
  note,
  go,
}: {
  note: NoteSummary;
  // S12 (YUK-335 批次乙 review)：go 已带 ?entry=<当前知识节点 id>——本行永远在某
  // 知识节点上下文里跳 note，让 NoteReader 的入口 banner/is-here/「入口」tag 真触发。
  go: (noteId: string) => void;
}) {
  return (
    <button type="button" className="kn-link-row" onClick={() => go(note.id)}>
      <span className="kn-link-row-ic" aria-hidden="true">
        {note.type === 'note_long' ? <FileText size={15} /> : <List size={15} />}
      </span>
      <span className="kn-link-row-title">{note.title}</span>
      <span className="kn-link-row-date un-num">
        {new Date(note.updated_at).toLocaleDateString('zh-CN')}
      </span>
      <ChevronRight size={15} aria-hidden="true" className="kn-row-arrow" />
    </button>
  );
}

// ADR-0033 D5 — interactive artifact discovery section. Pure presentational
// (resolved props only, no queries) so both the node detail page (main column) and
// the graph node drawer (its section) reuse it and it is renderToString-testable
// (AutoEnrolledPanel PanelBody precedent). The interactive artifact reuses
// /notes/{id} as its reader shell (note-page READER_TYPES), so rows link there;
// the 互动 tag distinguishes them from note kinds. Empty → renders nothing (the
// section header carries its own count when shown) — KnowledgeDetailPage gates the
// section on length so no empty block appears on the page either.
export function InteractiveArtifactDiscovery({
  artifacts,
  go,
  entryId,
}: {
  artifacts: NoteSummary[];
  go: (to: string) => void;
  entryId?: string;
}) {
  if (artifacts.length === 0) return null;
  return (
    <>
      {artifacts.map((a) => (
        <button
          type="button"
          key={a.id}
          className="kn-link-row"
          onClick={() =>
            go(
              entryId
                ? `/notes/${encodeURIComponent(a.id)}?entry=${encodeURIComponent(entryId)}`
                : `/notes/${encodeURIComponent(a.id)}`,
            )
          }
        >
          <span className="kn-tag kn-tag-accent">
            <Sparkles size={12} aria-hidden="true" />
            互动
          </span>
          <span className="kn-link-row-title">{a.title}</span>
          <span className="kn-link-row-date un-num">
            {new Date(a.updated_at).toLocaleDateString('zh-CN')}
          </span>
          <ChevronRight size={15} aria-hidden="true" className="kn-row-arrow" />
        </button>
      ))}
    </>
  );
}

const BL_META: Record<string, { label: string; icon: ReactNode }> = {
  note_atomic: { label: '知识笔记', icon: <FileText size={13} aria-hidden="true" /> },
  note_hub: { label: '汇总笔记', icon: <FileText size={13} aria-hidden="true" /> },
  note_long: { label: '长文笔记', icon: <FileText size={13} aria-hidden="true" /> },
  interactive: { label: '互动内容', icon: <Sparkles size={13} aria-hidden="true" /> },
  learning_item: { label: '学习项', icon: <BookOpen size={13} aria-hidden="true" /> },
};

// Timeline dot tone from the event outcome (failure → critical, success → positive, else neutral).
function outcomeTone(outcome: string | null | undefined): 'critical' | 'positive' | 'info' {
  if (outcome === 'failure') return 'critical';
  if (outcome === 'success') return 'positive';
  return 'info';
}

// The detail page's frame: the ui-next scope, the bridged main column, and the toast host.
function DetailFrame({ children }: { children: ReactNode }) {
  return (
    <UiNextRoot className="kn-page">
      <main className="kn-detail-main un-m3e-bridge">{children}</main>
      <ToastHost />
    </UiNextRoot>
  );
}

export function knowledgeBacklinkHref(fromType: string, artifactId: string, entryId: string) {
  return fromType === 'interactive' || fromType.startsWith('note_')
    ? `/notes/${encodeURIComponent(artifactId)}?entry=${encodeURIComponent(entryId)}`
    : null;
}

export function knowledgeReviewRequest(name: string) {
  return `请围绕知识点「${name}」安排一次针对性复习，并先说明你准备怎么做。`;
}

export default function KnowledgeDetailPage({
  id,
  navigate,
  returnToPlan = false,
}: {
  id: string;
  navigate: (to: string) => void;
  returnToPlan?: boolean;
}) {
  const queryClient = useQueryClient();
  const { getMisconceptions, getNodePage, vetoMisconception } = useKnowledgeClient();
  // Keep the full route mount-fresh. The drawer alone owns a short staleTime (YUK-334), so
  // navigating here after any cross-surface mutation still performs the existing refetch.
  const pageQ = useQuery(knowledgeNodeQueryOptions(id, getNodePage));

  // A5 S4 (YUK-531 PR-5) — 「指向此点的误区」per-KC funnel（confirmed RT1 误区 + candidate 猜想/候选）。
  const miscQ = useQuery({
    queryKey: ['knowledge-misconceptions', id],
    queryFn: () => getMisconceptions(id),
  });
  // candidate veto = dismiss pending conjecture（live）。invalidate 后被否决的候选退出 pending 列表。
  const vetoMut = useMutation({
    mutationFn: (mcId: string) => vetoMisconception(mcId),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['knowledge-misconceptions', id] }),
  });

  // S12 (YUK-335 批次乙 review)：凡从本知识节点上下文跳 note，都带 ?entry=<node.id>，
  // 让 NoteReader 读 ?entry（NoteReaderPage:51）后触发入口 banner / strip .is-here /
  // 右栏「入口」tag。consumer 侧已就绪；本页是当前唯一 live 的 kd→note 生产侧 caller。
  const noteHref = (noteId: string) => `/notes/${noteId}?entry=${id}`;
  const knowledgeHref = (knowledgeId: string) =>
    returnToPlan
      ? `/knowledge/${encodeURIComponent(knowledgeId)}?returnTo=learning-plan`
      : `/knowledge/${encodeURIComponent(knowledgeId)}`;
  const backHref = returnToPlan ? '/coach#learning-plan-progress' : '/knowledge';
  const backLabel = returnToPlan ? '返回学习计划' : '返回知识';

  if (pageQ.isLoading)
    return (
      <DetailFrame>
        <SkeletonLines rows={5} label="正在取节点" />
      </DetailFrame>
    );
  const node = pageQ.data;
  if (!node)
    return (
      <DetailFrame>
        <button type="button" className="kn-back" onClick={() => navigate(backHref)}>
          <ArrowLeft size={16} aria-hidden="true" />
          {backLabel}
        </button>
        <KnowledgeEmpty icon={<ListTree size={22} />} title="节点不存在或已归档。" />
      </DetailFrame>
    );

  const db = DECAY_BUCKET_META[node.mastery_decay_bucket];
  const primary = node.primary_atomic;
  const otherNotes = node.notes.filter((n) => n.id !== primary?.id);
  const byKind = new Map<string, NoteSummary[]>();
  for (const n of otherNotes) {
    if (!byKind.has(n.type)) byKind.set(n.type, []);
    byKind.get(n.type)?.push(n);
  }
  const byRel = new Map<string, KnowledgeNodePage['mesh_neighbors']>();
  for (const nb of node.mesh_neighbors) {
    if (!byRel.has(nb.relation_type)) byRel.set(nb.relation_type, []);
    byRel.get(nb.relation_type)?.push(nb);
  }
  const miscRows = miscQ.data?.rows ?? [];

  return (
    <DetailFrame>
      <button type="button" className="kn-back" onClick={() => navigate(backHref)}>
        <ArrowLeft size={16} aria-hidden="true" />
        {backLabel}
      </button>
      <header className="kn-hero">
        {/* ⑥治理：hero 环去裸 pct，档由下方 meta 行的 BandChip 给。 */}
        <MasteryDial mastery={node.mastery} size={56} />
        <div className="kn-hero-text">
          <h1 className="kn-hero-title">{node.name}</h1>
          <div className="kn-hero-meta">
            {/* S10 (YUK-335 §3.9)：父节点不在页头做内联链——层级关系归入下方「邻居 · 按关系分组」
                首个层级块（parent + children 同一处渲染）。 */}
            <DecayChip cue={db} label={`衰减 · ${db.label}`} />
            {/* A5 S1 (YUK-354) — 离散档 BandChip 替代裸 M{pct}%（⑥治理：绝不裸概率）。 */}
            <BandChip input={node} />
            <span className="kn-hero-evidence un-num">{node.evidence_count} 条学习依据</span>
          </div>
        </div>
        <div className="kn-hero-cta">
          <Button
            onClick={() => {
              // The companion shows 「正在看：知识点 · <name>」 and scopes its quiz chip to it.
              setCompanionFocus({ kind: 'knowledge', id: node.id, title: node.name });
              openCopilot(knowledgeReviewRequest(node.name));
            }}
          >
            <RotateCcw size={16} aria-hidden="true" />
            复习此点
          </Button>
          {node.role === 'kc' && (
            <Button onClick={() => navigate(`/practice?kc=${encodeURIComponent(node.id)}`)}>
              <Target size={16} aria-hidden="true" />
              针对此点练习
            </Button>
          )}
        </div>
      </header>

      {/* A5 S3 (YUK-354) — NodeComposite 三维折叠（R · p(L) · difficulty）插在 hero 下方,
          对齐设计源 screen-knowledge-detail.jsx:75 的 <NodeComposite> 位置。三维 RAW 由
          node-page wire 平铺（node.retrievability / node.beta / node.difficulty_anchored /
          node.mastery* ），客户端
          buildNodeThreeDim band 化。三轴正交：纯 READ 展示。 */}
      <NodeComposite
        input={{
          mastery: node,
          beta: node.beta,
          difficultyAnchored: node.difficulty_anchored,
          retrievability: node.retrievability,
          retention: node.retention,
          evidenceCount: node.evidence_count,
        }}
      />

      <div className="kn-detail-grid">
        <div className="kn-detail-col">
          {/* A5 S4 (YUK-531 PR-5) — 「指向此点的误区」funnel 置于主栏首段（误区是一等异构，
              先于迁移/诊断/笔记）。confirmed(RT1 误区) + candidate(猜想/候选) 两段；conf 定性、
              seen 计数，绝不裸概率（⑥）。veto = Option A：candidate「判错了」→ live dismiss pending
              conjecture；confirmed「判错了」→ 仅乐观「已纠偏」本地态（confirmed-archive 延后 + PR-3
              promote flag OFF → confirmed 段 day-one 空）。 */}
          <section className="kn-sec" aria-labelledby="kn-sec-misc">
            <SectionHead
              id="kn-sec-misc"
              title="可能相关的误区"
              aside={miscRows.length > 0 ? <span className="un-num">{miscRows.length}</span> : null}
            />
            <MisconceptionList
              items={miscRows}
              knowledgeId={node.id}
              isLoading={miscQ.isLoading}
              isError={miscQ.isError}
              onRetry={() => void miscQ.refetch()}
              navigate={navigate}
              onVeto={(mcId, segment) => {
                // Option A：仅 candidate 段打服务端 dismiss。返回 mutateAsync 的 Promise 让 card
                // await + 失败回滚乐观 verdict（B / ⑥：失败绝不滞留假「已纠偏」）。confirmed 段 card
                // 的否决钮已 disabled（C，confirmed-archive 是延后 soft-track 后端 slice），此 guard
                // 仍兜底——confirmed 永不打服务端写。
                if (segment === 'candidate') return vetoMut.mutateAsync(mcId);
              }}
            />
          </section>

          {/* A5 S3 (YUK-354) — 迁移 + 诊断下钻：忠于冷启设计的诚实空态（borrowed-θ 软层
              dark-ship / CDM·IRT 无后端），不假造数字。 */}
          <section className="kn-sec" aria-labelledby="kn-sec-transfer">
            <SectionHead id="kn-sec-transfer" title="可能带动它的知识" />
            <TransferList />
            {/* DiagnosticDrill 自带折叠 header（「进一步诊断」），不再叠一个小节标题。 */}
            <DiagnosticDrill />
          </section>

          <section className="kn-sec" aria-labelledby="kn-sec-notes">
            <SectionHead id="kn-sec-notes" title="笔记" />
            <p className="kn-note-hint">
              <Link2 size={13} aria-hidden="true" />
              一篇笔记可以关联多个知识点；从这里打开时，会保留当前知识点作为阅读入口。
            </p>

            {!primary && otherNotes.length === 0 ? (
              <div className="kn-card">
                <p className="kn-quiet">还没有带此标签的笔记。可以在笔记编辑器中关联这个知识点。</p>
              </div>
            ) : (
              <>
                {primary && (
                  <article className="kn-card kn-primary-note" aria-label={primary.title}>
                    <div className="kn-primary-head">
                      <span className="kn-tag kn-tag-accent">
                        <FileText size={12} aria-hidden="true" />
                        主笔记
                      </span>
                      <span className="kn-primary-title">{primary.title}</span>
                    </div>
                    {/* T6 简化渲染：从 semanticBlock 抽 source_markdown；
                        完整块渲染（NoteBlocks）随 T7 阅读器落地后可替换。 */}
                    <div className="kn-primary-body">
                      {(primary.body_blocks?.content ?? [])
                        .filter((b) => b.attrs?.source_markdown)
                        .map((b) => (
                          <p key={b.attrs?.id ?? b.attrs?.source_markdown} className="kn-primary-p">
                            {b.attrs?.source_markdown}
                          </p>
                        ))}
                    </div>
                    <div className="kn-primary-acts">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => navigate(noteHref(primary.id))}
                      >
                        <FileText size={14} aria-hidden="true" />
                        在阅读器中打开
                        <ArrowRight size={14} aria-hidden="true" />
                      </Button>
                    </div>
                  </article>
                )}

                {[...byKind.entries()].map(([kind, arr]) => (
                  <div key={kind} className="kn-note-group">
                    <div className="kn-note-group-h">
                      <span className="kn-tag">{NOTE_KIND_LABEL[kind] ?? '笔记'}</span>
                      <span className="un-num">{arr.length} 篇</span>
                    </div>
                    {arr.map((nt) => (
                      <NoteLinkRow
                        key={nt.id}
                        note={nt}
                        go={(noteId) => navigate(noteHref(noteId))}
                      />
                    ))}
                  </div>
                ))}
              </>
            )}
          </section>

          {/* ADR-0033 D5 — 互动产物 discovery：interactive_artifacts wire 已在
              node-page；空则整块不渲染（gate on length），避免空块。行链到
              /notes/{id}（互动产物复用 NoteReader 作为阅读壳）。 */}
          {node.interactive_artifacts.length > 0 && (
            <section className="kn-sec" aria-labelledby="kn-sec-interactive">
              <SectionHead
                id="kn-sec-interactive"
                title={`互动产物 · ${node.interactive_artifacts.length}`}
              />
              <div className="kn-note-group">
                <InteractiveArtifactDiscovery
                  artifacts={node.interactive_artifacts}
                  go={navigate}
                  entryId={id}
                />
              </div>
            </section>
          )}

          {/* S10 (YUK-335 §3.9 + 批次乙 review)：层级 + typed 关系作为同一张卡里的并列块
              （设计源 screen-knowledge-detail.jsx:152-165）。层级块（上级 + 下级）先行；
              parent + children 都无时单一「无层级邻居」。 */}
          <section className="kn-sec" aria-labelledby="kn-sec-neighbors">
            <SectionHead id="kn-sec-neighbors" title="邻居 · 按关系分组" />
            <div className="kn-card kn-neighbors">
              <div className="kn-rel-block">
                <h3 className="kn-rel-h">
                  <ListTree size={13} aria-hidden="true" />
                  层级
                </h3>
                {node.parent_name && (
                  <button
                    type="button"
                    className="kn-rel-row"
                    onClick={() => node.parent_id && navigate(knowledgeHref(node.parent_id))}
                  >
                    <span className="kn-rel-kind">上级</span>
                    {/* de-wenyan: parent_name carries no domain on the node-page
                        wire (only the page node itself has effective_domain), so
                        fall to the neutral default font rather than hardcode serif. */}
                    <span className="kn-rel-name">{node.parent_name}</span>
                    <ChevronRight size={15} aria-hidden="true" className="kn-row-arrow" />
                  </button>
                )}
                {node.children.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className="kn-rel-row"
                    onClick={() => navigate(knowledgeHref(c.id))}
                  >
                    <span className="kn-rel-kind">下级</span>
                    {/* de-wenyan: NodePageChild carries no domain (see parent note). */}
                    <span className="kn-rel-name">{c.name}</span>
                    {/* ⑥治理：子节点环去裸 pct（保 glance 环弧）。子节点行 BandChip 升级需扩
                        NodePageChild 的 band 字段（mastery_lo/hi/low_confidence/evidence_count），
                        属 follow-up。 */}
                    <MasteryDial mastery={c.mastery} size={22} />
                  </button>
                ))}
                {!node.parent_name && node.children.length === 0 && (
                  <p className="kn-quiet kn-rel-empty">无层级邻居</p>
                )}
              </div>
              {[...byRel.entries()].map(([rel, arr]) => {
                const cue = REL_CUE[rel] ?? REL_CUE.related_to;
                return (
                  <div key={rel} className="kn-rel-block">
                    <h3 className="kn-rel-h">
                      <RelTag rel={rel} cue={cue} />
                    </h3>
                    {arr.map((o) => (
                      <button
                        type="button"
                        key={o.edge_id}
                        className="kn-rel-row"
                        onClick={() => navigate(knowledgeHref(o.knowledge_id))}
                      >
                        {/* de-wenyan: NodePageMeshNeighbor carries no domain. */}
                        <span className="kn-rel-name">{o.name}</span>
                        <span className="kn-glyph kn-rel-dir">
                          {o.direction === 'out' ? '→' : '←'}
                        </span>
                        <ChevronRight size={15} aria-hidden="true" className="kn-row-arrow" />
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <aside className="kn-detail-side" aria-label="关联内容与活动">
          <section className="kn-sec" aria-labelledby="kn-sec-backlinks">
            <SectionHead id="kn-sec-backlinks" title="关联内容 · 按来源分组" />
            <div className="kn-card">
              {node.backlinks.length === 0 ? (
                <p className="kn-quiet">无反向链接</p>
              ) : (
                Object.entries(node.backlinks_by_type)
                  .filter(([, arr]) => arr.length > 0)
                  .map(([t, arr]) => (
                    <div key={t} className="kn-bl-group">
                      <h3 className="kn-bl-kind">
                        {BL_META[t]?.icon ?? <FileText size={13} aria-hidden="true" />}
                        {BL_META[t]?.label ?? t} · {arr.length}
                      </h3>
                      <FoldList
                        as="div"
                        className="kn-bl-list"
                        items={arr}
                        renderItem={(b) => {
                          const href = knowledgeBacklinkHref(t, b.from_artifact_id, id);
                          const rowKey = `${b.from_artifact_id}-${b.from_block_id}`;
                          const body = (
                            <span key={`${rowKey}-body`} className="kn-bl-main">
                              <span className="kn-bl-title">{b.from_title}</span>
                              <span className="kn-bl-sub">
                                {href ? '打开内容' : '当前没有可打开的详情页'}
                              </span>
                            </span>
                          );
                          return href ? (
                            <button
                              type="button"
                              key={rowKey}
                              className="kn-bl-row"
                              onClick={() => navigate(href)}
                            >
                              {body}
                              <ChevronRight size={14} aria-hidden="true" className="kn-row-arrow" />
                            </button>
                          ) : (
                            <div key={rowKey} className="kn-bl-row">
                              {body}
                            </div>
                          );
                        }}
                      />
                    </div>
                  ))
              )}
            </div>
          </section>

          <section className="kn-sec" aria-labelledby="kn-sec-activity">
            <SectionHead id="kn-sec-activity" title="活动" />
            <div className="kn-card">
              {node.timeline.length === 0 ? (
                <p className="kn-quiet">无活动记录</p>
              ) : (
                // 倒序已是最近在前（wire 约定）。默认只露最近 3 条，其余收进「全部 N 条」——
                // 防侧栏被无界时间线撑爆（S8 audit §3.9；owner 2026-10-18 折叠决定，设计 L5）。
                <FoldList
                  as="div"
                  className="kn-events"
                  items={node.timeline}
                  renderItem={(a, i, shownCount) => (
                    <div key={a.event_id} className="kn-event">
                      <span className="kn-event-rail" aria-hidden="true">
                        <span className={`kn-event-dot tone-${outcomeTone(a.outcome)}`} />
                        {i < shownCount - 1 && <span className="kn-event-line" />}
                      </span>
                      <div className="kn-event-body">
                        {/* S8 (YUK-335 §2 P3 + 批次乙 review)：人话句是 event row 主叙事行（强），
                            时间弱于主句；不渲裸 a.action 标签（避免 debug-log 味与人话句重复）。 */}
                        <p className="kn-event-lead">{humanizeActivity(a)}</p>
                        <p className="kn-event-time un-num">
                          {new Date(a.created_at).toLocaleString('zh-CN', {
                            month: 'numeric',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    </div>
                  )}
                />
              )}
            </div>
          </section>
        </aside>
      </div>
    </DetailFrame>
  );
}
