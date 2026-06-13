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
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { REL_CUE } from './MeshGraph';
import { humanizeActivity } from './humanize-activity';
import { type KnowledgeNodePage, type NoteSummary, getNodePage } from './knowledge-api';
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

function NoteLinkRow({ note, go }: { note: NoteSummary; go: (to: string) => void }) {
  const verified = note.verification_status === 'verified';
  return (
    <button type="button" className="note-link-row" onClick={() => go(`/notes/${note.id}`)}>
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
  const pageQ = useQuery({ queryKey: ['knowledge-node', id], queryFn: () => getNodePage(id) });

  const placeholder = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 5000);
  };

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
  const pct = node.mastery == null ? null : Math.round(node.mastery * 100);
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

  return (
    <main className="page wide knowledge-loom">
      <div className="page-head">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={() => navigate('/knowledge')}>
          返回知识
        </Btn>
        <div className="page-head-row" style={{ marginTop: 'var(--s-3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-4)' }}>
            <MasteryRing mastery={node.mastery} size={56} />
            <div>
              <h1 className="page-title serif">{node.name}</h1>
              <div className="nowrap-meta" style={{ marginTop: 4 }}>
                <span className="meta mono">{node.effective_domain ?? node.domain ?? '—'}</span>
                {/* S10 (YUK-335 §3.9)：父节点不再做页头内联下划线文字链——层级关系
                    归入下方邻居区的 design-system「层级」drawer-sec 块（parent + children
                    同一处渲染），删去此处非 design-system 的内联链。 */}
                <span className="dot-sep">·</span>
                <span className={`decay-bucket tone-${db.tone}`}>
                  <LoomIcon name={db.icon as never} size={12} />
                  <span>衰减 · {db.label}</span>
                  {pct != null && <span className="decay-retr mono">M {pct}%</span>}
                </span>
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

      <div className="kd-grid">
        <div className="kd-main">
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
                      onClick={() => navigate(`/notes/${primary.id}`)}
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
                    <NoteLinkRow key={nt.id} note={nt} go={navigate} />
                  ))}
                </div>
              ))}
            </>
          )}

          {/* 标注笔记：后端读路径 M3 不存在（pre-flight 偏离③），空态挂账 M4/M5。 */}
          <SectionLabel>标注笔记</SectionLabel>
          <div className="quiet-empty">无标注（标注链路随工作台收口）</div>

          {/* S10 (YUK-335 §3.9)：层级块——parent + children 同处渲染，与下方 typed
              关系块视觉分离（各自 drawer-sec）。设计源 screen-knowledge.jsx L187-200。 */}
          <SectionLabel>层级</SectionLabel>
          <div className="card card-pad">
            <div className="drawer-sec">
              <div className="drawer-sec-h">
                <LoomIcon name="tree" size={14} />
                层级 hierarchy
              </div>
              {node.parent_name ? (
                <button
                  type="button"
                  className="rel-row"
                  onClick={() => node.parent_id && navigate(`/knowledge/${node.parent_id}`)}
                >
                  <span className="rel-kind mono">parent</span>
                  <span className="wenyan">{node.parent_name}</span>
                  <LoomIcon name="arrow" size={13} />
                </button>
              ) : (
                <div className="quiet-empty">根节点（无父）</div>
              )}
              {node.children.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className="rel-row indent"
                  onClick={() => navigate(`/knowledge/${c.id}`)}
                >
                  <span className="rel-kind mono">child</span>
                  <span className="wenyan">{c.name}</span>
                  <MasteryRing mastery={c.mastery} size={24} />
                </button>
              ))}
            </div>
          </div>

          <SectionLabel>邻居 · 按关系分组</SectionLabel>
          <div className="card card-pad">
            {node.mesh_neighbors.length === 0 ? (
              <div className="quiet-empty">无邻居</div>
            ) : (
              <>
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
                          <span className="wenyan">{o.name}</span>
                          <span className="meta mono">{o.direction === 'out' ? '→' : '←'}</span>
                          <LoomIcon name="arrow" size={13} />
                        </button>
                      ))}
                    </div>
                  );
                })}
              </>
            )}
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
                          if (t === 'note') navigate(`/notes/${b.from_artifact_id}`);
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
                            {/* S8 (YUK-335 §2 P3)：event-note 渲人话句；event-head 去掉裸
                                a.action mono 标签（避免 debug-log 味与人话句重复），只留时间。 */}
                            <div className="event-note">{humanizeActivity(a)}</div>
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
