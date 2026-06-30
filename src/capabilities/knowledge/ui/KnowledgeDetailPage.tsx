// M3 知识面 — 节点详情页（YUK-317）。
// 设计基准 docs/design/loom-refresh/project/screen-knowledge-detail.jsx：
// hero（MasteryRing + decay bucket + R%）+ kd-grid 两栏——主栏笔记按 kind
// 分组（「knowledge_id 是笔记上的标签 · 笔记按 note_atomic / note_hub /
// note_long 区分，一条笔记可挂多个知识点」：primary atomic 整篇 inline，
// 其余 link rows）+ 邻居按关系分组（层级先行）；侧栏反链按来源类型分组 +
// 活动时间线。「标注笔记」区后端无读路径——M3 空态挂账（pre-flight 偏离③）。
// 「复习此点」「AI 起草」属 M4 点播链——占位 toast。

import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { MasteryRing } from '@/ui/primitives/MasteryRing';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { BandChip } from './BandChip';
import { REL_CUE } from './MeshGraph';
import { MisconceptionList } from './MisconceptionList';
import { DiagnosticDrill, NodeComposite, TransferList } from './NodeComposite';
import { humanizeActivity } from './humanize-activity';
import {
  type KnowledgeNodePage,
  type NoteSummary,
  getMisconceptions,
  getNodePage,
  vetoMisconception,
} from './knowledge-api';
import './knowledge.css';

// S8 (YUK-335 audit §3.9)：活动时间线默认只渲前 N 条，其余折叠 —— 防 kd-side
// 被 30 条无界 event 撑爆（设计源 screen-item-detail 侧栏无长时间线处理，
// 故按任务用更可控的 count-cap + 查看更多，而非 max-height 渐隐）。
const TIMELINE_COLLAPSED = 6;

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
  note_atomic: '其它 atomic 笔记',
  note_hub: 'hub 笔记',
  note_long: 'long 长文',
};

function noteKindShort(type: string): string {
  return type.replace(/^note_/, '');
}

function NoteLinkRow({
  note,
  go,
}: {
  note: NoteSummary;
  // S12 (YUK-335 批次乙 review)：go 已带 ?entry=<当前知识节点 id>——本行永远在某
  // 知识节点上下文里跳 note，让 NoteReader 的入口 banner/is-here/「入口」tag 真触发。
  go: (noteId: string) => void;
}) {
  const verified = note.verification_status === 'verified';
  return (
    <button type="button" className="note-link-row" onClick={() => go(note.id)}>
      <LoomIcon name={note.type === 'note_long' ? 'doc' : 'list'} size={15} />
      <span className="note-link-title">{note.title}</span>
      <span className={`verify-badge ${verified ? 'verified' : 'draft'}`} style={{ flex: 'none' }}>
        <LoomIcon name={verified ? 'check' : 'sparkle'} size={10} />
        {verified ? '已校验' : '草稿'}
      </span>
      <span className="meta">{new Date(note.updated_at).toLocaleDateString('zh-CN')}</span>
      <LoomIcon name="arrow" size={13} className="thread-arrow" />
    </button>
  );
}

// ADR-0033 D5 — interactive artifact discovery section. Pure presentational
// (resolved props only, no queries) so both the node detail page (.kd-main) and
// the graph node drawer (.drawer-sec) reuse it and it is renderToString-testable
// (AutoEnrolledPanel PanelBody precedent). The interactive artifact reuses
// /notes/{id} as its reader shell (note-page READER_TYPES), so rows link there;
// the .note-kind-interactive tag distinguishes them from note kinds. Empty →
// renders nothing in the drawer-sec form (the section header carries its own
// count when shown) — KnowledgeDetailPage gates the SectionLabel on length so no
// empty block appears on the page either.
export function InteractiveArtifactDiscovery({
  artifacts,
  go,
}: {
  artifacts: NoteSummary[];
  go: (to: string) => void;
}) {
  if (artifacts.length === 0) return null;
  return (
    <>
      {artifacts.map((a) => (
        <button
          type="button"
          key={a.id}
          className="note-link-row"
          onClick={() => go(`/notes/${a.id}`)}
        >
          <span className="note-kind-tag note-kind-interactive">
            <LoomIcon name="sparkle" size={12} />
            互动
          </span>
          <span className="note-link-title">{a.title}</span>
          <span className="meta">{new Date(a.updated_at).toLocaleDateString('zh-CN')}</span>
          <LoomIcon name="arrow" size={13} className="thread-arrow" />
        </button>
      ))}
    </>
  );
}

const BL_META: Record<string, { label: string; icon: string }> = {
  question: { label: '题目', icon: 'quiz' },
  note: { label: '笔记', icon: 'doc' },
  learning_item: { label: '学习项', icon: 'items' },
  mistake: { label: '错题', icon: 'mistakes' },
  session: { label: '会话', icon: 'history' },
};

export default function KnowledgeDetailPage({
  id,
  navigate,
}: {
  id: string;
  navigate: (to: string) => void;
}) {
  const [toast, setToast] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const queryClient = useQueryClient();
  const pageQ = useQuery({ queryKey: ['knowledge-node', id], queryFn: () => getNodePage(id) });

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

  const placeholder = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 5000);
  };

  // S12 (YUK-335 批次乙 review)：凡从本知识节点上下文跳 note，都带 ?entry=<node.id>，
  // 让 NoteReader 读 ?entry（NoteReaderPage:51）后触发入口 banner / strip .is-here /
  // 右栏「入口」tag。consumer 侧已就绪；本页是当前唯一 live 的 kd→note 生产侧 caller。
  const noteHref = (noteId: string) => `/notes/${noteId}?entry=${id}`;

  if (pageQ.isLoading)
    return (
      <main className="page wide knowledge-loom">
        <p className="quiet-empty">取节点…</p>
      </main>
    );
  const node = pageQ.data;
  if (!node)
    return (
      <main className="page wide knowledge-loom">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={() => navigate('/knowledge')}>
          返回知识
        </Btn>
        <p className="quiet-empty">节点不存在或已归档。</p>
      </main>
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
    <main className="page wide knowledge-loom">
      <div className="page-head">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={() => navigate('/knowledge')}>
          返回知识
        </Btn>
        <div className="page-head-row" style={{ marginTop: 'var(--s-3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-4)' }}>
            {/* ⑥治理：hero 环去裸 pct，档由下方 meta 行的 BandChip 给。 */}
            <MasteryRing mastery={node.mastery} size={56} showNumber={false} />
            <div>
              <h1 className="page-title serif">{node.name}</h1>
              <div className="nowrap-meta" style={{ marginTop: 4 }}>
                <span className="meta mono">{node.effective_domain ?? node.domain ?? '—'}</span>
                {/* S10 (YUK-335 §3.9)：父节点不再做页头内联下划线文字链——层级关系
                    归入下方「邻居 · 按关系分组」Card 内首个 kd-rel-block（parent + children
                    同一处渲染），删去此处非 design-system 的内联链。 */}
                <span className="dot-sep">·</span>
                <span className={`decay-bucket tone-${db.tone}`}>
                  <LoomIcon name={db.icon as never} size={12} />
                  <span>衰减 · {db.label}</span>
                </span>
                <span className="dot-sep">·</span>
                {/* A5 S1 (YUK-354) — 离散档 BandChip 替代裸 M{pct}%（⑥治理：绝不裸概率）。 */}
                <BandChip input={node} />
                <span className="dot-sep">·</span>
                <span className="meta mono">{node.evidence_count} evidence</span>
              </div>
            </div>
          </div>
          <div className="hero-cta" style={{ marginLeft: 'auto' }}>
            <Btn
              variant="secondary"
              icon="review"
              onClick={() =>
                placeholder('点播复习进流——M4 点播 quiz-gen 链收口后接通，先在练习面等今日流。')
              }
            >
              复习此点
            </Btn>
          </div>
        </div>
      </div>

      {/* A5 S3 (YUK-354) — NodeComposite 三维折叠（R · p(L) · difficulty）插在 hero 下方,
          对齐设计源 screen-knowledge-detail.jsx:75 的 <NodeComposite> 位置。三维 RAW 由
          node-page wire 平铺（node.retrievability / node.beta / node.mastery* ），客户端
          buildNodeThreeDim band 化。三轴正交：纯 READ 展示。 */}
      <NodeComposite
        input={{
          mastery: node,
          beta: node.beta,
          retrievability: node.retrievability,
          evidenceCount: node.evidence_count,
        }}
      />

      <div className="kd-grid">
        <div className="kd-main">
          {/* A5 S4 (YUK-531 PR-5) — 「指向此点的误区」funnel 置于 .kd-main 首子（误区是一等异构，
              先于迁移/诊断/笔记）。confirmed(RT1 误区) + candidate(猜想/候选) 两段；conf 定性、
              seen 计数，绝不裸概率（⑥）。veto = Option A：candidate「判错了」→ live dismiss pending
              conjecture；confirmed「判错了」→ 仅乐观「已纠偏」本地态（confirmed-archive 延后 + PR-3
              promote flag OFF → confirmed 段 day-one 空）。 */}
          <SectionLabel count={miscRows.length || null}>
            指向此点的误区 · misconception
          </SectionLabel>
          <MisconceptionList
            items={miscRows}
            isLoading={miscQ.isLoading}
            isError={miscQ.isError}
            onRetry={() => void miscQ.refetch()}
            navigate={navigate}
            onVeto={(mcId, segment) => {
              // Option A：仅 candidate 段打服务端 dismiss；confirmed 段是 no-op（card 已渲乐观
              // 「已纠偏」本地态，confirmed-archive 是延后 soft-track 后端 slice）。
              if (segment === 'candidate') vetoMut.mutate(mcId);
            }}
          />

          {/* A5 S3 (YUK-354) — 迁移 + 诊断下钻：忠于冷启设计的诚实空态（borrowed-θ 软层
              dark-ship / CDM·IRT 无后端），不假造数字。 */}
          <SectionLabel>迁移而来的掉握 · transfer credit</SectionLabel>
          <TransferList />

          {/* DiagnosticDrill 自带折叠 header（「诊断下钻 · CDM/IRT」），不再叠 SectionLabel（OCR 双 header）。 */}
          <DiagnosticDrill />

          <SectionLabel>笔记</SectionLabel>
          <div className="kd-note-hint meta">
            <LoomIcon name="link" size={12} />
            knowledge_id 是笔记上的标签 · 笔记按 note_atomic / note_hub / note_long
            区分，一条笔记可挂多个知识点
          </div>

          {!primary && otherNotes.length === 0 ? (
            <div className="card card-pad">
              <EmptyState
                icon="doc"
                title="还没有带此标签的笔记"
                text="撰写一条笔记并打上该知识点标签，或让 AI 从相关 evidence 起草。"
                action={
                  <Btn
                    size="sm"
                    variant="primary"
                    icon="sparkle"
                    onClick={() => placeholder('AI 起草随 M4 点播链接通。')}
                  >
                    AI 起草
                  </Btn>
                }
              />
            </div>
          ) : (
            <>
              {primary && (
                <div className="card card-pad kd-primary-note">
                  <div className="kd-primary-head">
                    <span className="note-kind-tag note-kind-atomic">
                      <LoomIcon name="doc" size={12} />
                      primary · note_atomic
                    </span>
                    <span className="kd-primary-title serif">{primary.title}</span>
                    <span
                      className={`verify-badge ${primary.verification_status === 'verified' ? 'verified' : 'draft'}`}
                    >
                      <LoomIcon
                        name={primary.verification_status === 'verified' ? 'check' : 'sparkle'}
                        size={11}
                      />
                      {primary.verification_status === 'verified' ? '已校验' : '草稿'}
                    </span>
                  </div>
                  {/* T6 简化渲染：从 semanticBlock 抽 source_markdown；
                      完整块渲染（NoteBlocks）随 T7 阅读器落地后可替换。 */}
                  <div className="kd-primary-body">
                    {(primary.body_blocks?.content ?? [])
                      .filter((b) => b.attrs?.source_markdown)
                      .map((b) => (
                        <div
                          key={b.attrs?.id ?? b.attrs?.source_markdown}
                          className="nb-p"
                          style={{ whiteSpace: 'pre-wrap' }}
                        >
                          {b.attrs?.source_markdown}
                        </div>
                      ))}
                  </div>
                  <div
                    className="note-ref-acts"
                    style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s-3)' }}
                  >
                    <Btn
                      size="sm"
                      variant="primary"
                      icon="doc"
                      iconEnd="arrow"
                      onClick={() => navigate(noteHref(primary.id))}
                    >
                      在阅读器中打开
                    </Btn>
                  </div>
                </div>
              )}

              {[...byKind.entries()].map(([kind, arr]) => (
                <div key={kind} className="kd-note-group">
                  <div className="kd-note-group-h">
                    <span className={`note-kind-tag note-kind-${noteKindShort(kind)}`}>
                      {noteKindShort(kind)}
                    </span>
                    {NOTE_KIND_LABEL[kind] ?? kind} · {arr.length}
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

          {/* ADR-0033 D5 — 互动产物 discovery：interactive_artifacts wire 已在
              node-page；空则整块不渲染（gate on length），避免空块。行链到
              /notes/{id}（互动产物复用 NoteReader 作为阅读壳）。 */}
          {node.interactive_artifacts.length > 0 && (
            <>
              <SectionLabel>互动产物 · {node.interactive_artifacts.length}</SectionLabel>
              <div className="kd-note-group">
                <InteractiveArtifactDiscovery
                  artifacts={node.interactive_artifacts}
                  go={navigate}
                />
              </div>
            </>
          )}

          {/* 标注笔记：后端读路径 M3 不存在（pre-flight 偏离③），空态挂账 M4/M5。 */}
          <SectionLabel>标注笔记</SectionLabel>
          <div className="quiet-empty">无标注（标注链路随工作台收口）</div>

          {/* S10 (YUK-335 §3.9 + 批次乙 review)：层级 + typed 关系作为 sibling
              kd-rel-block 并入同一个 Card（设计源 screen-knowledge-detail.jsx:152-165，
              非图谱侧抽屉 screen-knowledge.jsx 的 drawer-sec）。层级块用 kd-rel-h
              header（tree icon + 「层级」），与同卡内 typed 关系块 header 风格一致——
              消除原 drawer-sec-h 与 kd-rel-h 同页打架。children 走普通 rel-row（设计源
              无 .indent），MasteryRing size=22 对齐设计源；parent + children 都无时
              单一「无层级邻居」quiet-empty。 */}
          <SectionLabel>邻居 · 按关系分组</SectionLabel>
          <div className="card card-pad">
            <div className="kd-rel-block">
              <div className="kd-rel-h">
                <LoomIcon name="tree" size={13} />
                层级
              </div>
              {node.parent_name && (
                <button
                  type="button"
                  className="rel-row"
                  onClick={() => node.parent_id && navigate(`/knowledge/${node.parent_id}`)}
                >
                  <span className="rel-kind mono">parent</span>
                  {/* de-wenyan: parent_name carries no domain on the node-page
                      wire (only the page node itself has effective_domain), so
                      fall to the neutral default font rather than hardcode serif. */}
                  <span>{node.parent_name}</span>
                  <LoomIcon name="arrow" size={13} />
                </button>
              )}
              {node.children.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className="rel-row"
                  onClick={() => navigate(`/knowledge/${c.id}`)}
                >
                  <span className="rel-kind mono">child</span>
                  {/* de-wenyan: NodePageChild carries no domain (see parent note). */}
                  <span>{c.name}</span>
                  {/* ⑥治理：子节点环去裸 pct（保 glance 环弧）。子节点行 BandChip 升级需扩
                      NodePageChild 的 band 字段（mastery_lo/hi/low_confidence/evidence_count），
                      属 follow-up。 */}
                  <MasteryRing mastery={c.mastery} size={22} showNumber={false} />
                </button>
              ))}
              {!node.parent_name && node.children.length === 0 && (
                <div className="quiet-empty">无层级邻居</div>
              )}
            </div>
            {[...byRel.entries()].map(([rel, arr]) => {
              const cue = REL_CUE[rel] ?? REL_CUE.related_to;
              return (
                <div key={rel} className="kd-rel-block">
                  <div className="kd-rel-h">
                    <span className={`rel-tag rel-tag-${rel}`}>
                      <span className="mono">{cue.glyph}</span>
                      {cue.label}
                    </span>
                  </div>
                  {arr.map((o) => (
                    <button
                      type="button"
                      key={o.edge_id}
                      className="rel-row"
                      onClick={() => navigate(`/knowledge/${o.knowledge_id}`)}
                    >
                      {/* de-wenyan: NodePageMeshNeighbor carries no domain. */}
                      <span>{o.name}</span>
                      <span className="meta mono">{o.direction === 'out' ? '→' : '←'}</span>
                      <LoomIcon name="arrow" size={13} />
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className="kd-side">
          <SectionLabel>反向链接 · 按来源类型</SectionLabel>
          <div className="card card-pad">
            {node.backlinks.length === 0 ? (
              <div className="quiet-empty">无反向链接</div>
            ) : (
              Object.entries(node.backlinks_by_type)
                .filter(([, arr]) => arr.length > 0)
                .map(([t, arr]) => (
                  <div key={t} className="bl-group">
                    <div className="bl-kind mono">
                      <LoomIcon name={(BL_META[t]?.icon ?? 'note') as never} size={12} />
                      {BL_META[t]?.label ?? t} · {arr.length}
                    </div>
                    {arr.map((b) => (
                      <button
                        type="button"
                        key={`${b.from_artifact_id}-${b.from_block_id}`}
                        className="bl-row"
                        onClick={() => {
                          if (t === 'note') navigate(noteHref(b.from_artifact_id));
                          else
                            placeholder('该来源的 surface 还在旧栈/后续里程碑——M5 收口后可跳转。');
                        }}
                      >
                        <span className="bl-row-main">
                          <span className="bl-row-t">{b.from_title}</span>
                          <span className="bl-row-m meta mono">{b.from_type}</span>
                        </span>
                        <LoomIcon name="arrow" size={12} className="thread-arrow" />
                      </button>
                    ))}
                  </div>
                ))
            )}
          </div>

          <SectionLabel>活动</SectionLabel>
          <div className="card card-pad">
            {node.timeline.length === 0 ? (
              <div className="quiet-empty">无活动记录</div>
            ) : (
              (() => {
                // 倒序已是最近在前（wire 约定）。默认只渲前 TIMELINE_COLLAPSED 条，
                // 展开后渲全部 —— 防 kd-side 被无界时间线撑爆（S8 audit §3.9）。
                const shown =
                  timelineOpen || node.timeline.length <= TIMELINE_COLLAPSED
                    ? node.timeline
                    : node.timeline.slice(0, TIMELINE_COLLAPSED);
                return (
                  <>
                    <div className="event-chain">
                      {shown.map((a, i) => (
                        <div key={a.event_id} className="event-row">
                          <span className="event-rail">
                            <span
                              className="event-dot"
                              style={{
                                background: `var(--${a.outcome === 'failure' ? 'again' : a.outcome === 'success' ? 'good' : 'info'})`,
                              }}
                            />
                            {i < shown.length - 1 && <span className="event-line" />}
                          </span>
                          <div className="event-body">
                            {/* S8 (YUK-335 §2 P3 + 批次乙 review)：人话句是 event row 主叙事行，
                                走 .kd-event-lead（fs-meta + ink-2，= 设计源 .event-label 权重）
                                而非 globals .event-note 最弱档；event-head 去掉裸 a.action mono
                                标签（避免 debug-log 味与人话句重复），只留时间（meta/ink-3，弱于主句）。 */}
                            <div className="kd-event-lead">{humanizeActivity(a)}</div>
                            <div className="event-head nowrap-meta">
                              <span className="meta">
                                {new Date(a.created_at).toLocaleString('zh-CN', {
                                  month: 'numeric',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {node.timeline.length > TIMELINE_COLLAPSED && (
                      <button
                        type="button"
                        className="kd-timeline-more"
                        onClick={() => setTimelineOpen((o) => !o)}
                      >
                        {timelineOpen ? (
                          <>
                            收起
                            <LoomIcon name="arrow" size={12} className="kd-timeline-more-up" />
                          </>
                        ) : (
                          <>
                            查看全部 {node.timeline.length} 条
                            <LoomIcon name="arrow" size={12} className="kd-timeline-more-down" />
                          </>
                        )}
                      </button>
                    )}
                  </>
                );
              })()
            )}
          </div>
        </div>
      </div>

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
