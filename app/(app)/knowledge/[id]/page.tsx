'use client';

import { BlockTreeRenderer } from '@/ui/block-tree/BlockTreeRenderer';
import type { BlockTreeDoc } from '@/ui/block-tree/types';
import type {
  ArtifactEmbeddedCheckStatus,
  EmbeddedCheckQuestion,
} from '@/ui/components/ArtifactSections';
import { ApiAuthError, ApiError, apiJson } from '@/ui/lib/api';
import type { SlimSubjectProfile } from '@/ui/lib/subject';
import { formatRelTime } from '@/ui/lib/utils';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import type { LoomIconName } from '@/ui/primitives/LoomIcon';
import { Ring } from '@/ui/primitives/Ring';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { use } from 'react';

interface MeshNeighbor {
  edge_id: string;
  knowledge_id: string;
  name: string;
  relation_type: string;
  direction: 'out' | 'in';
  weight: number;
}

interface PrimaryAtomic {
  id: string;
  owning_learning_item_id: string | null;
  title: string;
  version: number;
  body_blocks: BlockTreeDoc | null;
  generation_status: string;
  verification_status: string;
  embedded_check_status: ArtifactEmbeddedCheckStatus;
  embedded_questions: EmbeddedCheckQuestion[];
}

interface Backlink {
  from_artifact_id: string;
  from_learning_item_id: string | null;
  from_title: string;
  from_type: string;
  from_block_id: string;
}

interface TimelineEntry {
  event_id: string;
  action: string;
  subject_kind: string;
  actor_kind: string;
  outcome: string | null;
  created_at: string;
}

// ADR-0027 multi-note list — the backend now returns every note labeled with
// this node (atomic/hub/long, atomic-first). The legacy page ignored this; the
// loom rewrite surfaces it as the "笔记" section. Shape mirrors NoteSummary.
interface NoteSummary {
  id: string;
  type: 'note_atomic' | 'note_hub' | 'note_long' | string;
  title: string;
  knowledge_ids: string[];
  generation_status: string;
  verification_status: string;
  version: number;
  updated_at: string;
}

interface KnowledgeNodePage {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  parent_name: string | null;
  effective_domain: string | null;
  mastery: number | null;
  evidence_count: number;
  last_evidence_at: string | null;
  subject_profile: SlimSubjectProfile;
  mesh_neighbors: MeshNeighbor[];
  primary_atomic: PrimaryAtomic | null;
  // ADR-0027: full labeled note set (atomic/hub/long). `primary_atomic` stays the
  // inline 节点简介; `notes` powers the multi-note list (deduped against primary).
  notes: NoteSummary[];
  backlinks: Backlink[];
  timeline: TimelineEntry[];
}

// Relation chip labels — mirror the labels used on the /knowledge index drawer.
const RELATION_LABEL: Record<string, string> = {
  prerequisite: '前置',
  related_to: '相关',
  contrasts_with: '对照',
  applied_in: '应用于',
  derived_from: '派生自',
};

function relationLabel(type: string): string {
  if (RELATION_LABEL[type]) return RELATION_LABEL[type];
  return type.startsWith('experimental:') ? type.replace('experimental:', '') : type;
}

const ACTION_LABEL: Record<string, string> = {
  attempt: '作答',
  judge: '归因',
  review: '复习',
  propose: '提议',
  accept: '接受',
  correct: '修正',
  note_generate: '生成笔记',
  generate: '生成',
  refine: '精修',
  suppress: '隐藏',
};

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

// Note-kind metadata for the "笔记" section: row icon + tag class + group label.
// Loom has no dedicated `note` glyph (see LoomIcon vocabulary) — atomic notes
// reuse `doc`; long notes use `book`; hub notes use `items`.
const NOTE_KIND_META: Record<
  string,
  { icon: LoomIconName; tagClass: string; tagLabel: string; groupLabel: string }
> = {
  note_atomic: {
    icon: 'doc',
    tagClass: 'note-kind-atomic',
    tagLabel: 'note_atomic',
    groupLabel: '其它 atomic 笔记',
  },
  note_hub: {
    icon: 'items',
    tagClass: 'note-kind-hub',
    tagLabel: 'note_hub',
    groupLabel: 'hub 笔记',
  },
  note_long: {
    icon: 'book',
    tagClass: 'note-kind-long',
    tagLabel: 'note_long',
    groupLabel: 'long 长文',
  },
};

// Backlink source-type → group label + icon. Backend only emits note_* and
// tool_quiz (pre-flight §4): render only the groups with data.
const BACKLINK_GROUP_META: Record<string, { icon: LoomIconName; label: string }> = {
  note: { icon: 'doc', label: '笔记' },
  tool_quiz: { icon: 'quiz', label: '测验' },
};

function isVerified(status: string): boolean {
  return status === 'verified';
}

function VerifyBadge({ status }: { status: string }) {
  const verified = isVerified(status);
  return (
    <span className={`verify-badge ${verified ? 'verified' : 'draft'}`}>
      <LoomIcon name={verified ? 'check' : 'sparkle'} size={11} />
      {verified ? '已校验' : '草稿'}
    </span>
  );
}

// Backlink row body (title + source-type meta + thread arrow). Extracted so the
// link / non-link branches share one render without a bare fragment in the map.
function BacklinkRowInner({ backlink }: { backlink: Backlink }) {
  return (
    <>
      <span className="bl-row-main">
        <span className="bl-row-t">{backlink.from_title}</span>
        <span className="bl-row-m meta mono">{backlink.from_type}</span>
      </span>
      <LoomIcon name="arrow" size={12} className="thread-arrow" />
    </>
  );
}

export default function KnowledgeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const nodeQ = useQuery({
    queryKey: ['knowledge-node', id],
    queryFn: () => apiJson<KnowledgeNodePage>(`/api/knowledge/${id}`),
    enabled: !!id,
  });

  const node = nodeQ.data;

  // loading / error / not-found share the loom back-link + page-head shell with a
  // Stateful body (skeleton / error retry / empty), matching the slice-1 NoteReader.
  if (nodeQ.isLoading || nodeQ.isError || !node) {
    // A 404 means the node is unknown / archived — route it to the friendly
    // not-found empty state rather than a raw "加载失败：404" error.
    const isNotFound = nodeQ.error instanceof ApiError && nodeQ.error.status === 404;
    const status = nodeQ.isLoading
      ? 'loading'
      : isNotFound
        ? 'empty'
        : nodeQ.isError
          ? 'error'
          : 'empty';
    const errorText =
      nodeQ.error instanceof ApiAuthError
        ? `${nodeQ.error.message} — 请重新进入页面输入 token`
        : nodeQ.isError
          ? `加载失败：${(nodeQ.error as Error).message}`
          : '知识点加载失败。';
    return (
      <div className="page">
        <Link href="/knowledge" className="back-link">
          <LoomIcon name="arrowL" size={14} />
          知识网
        </Link>
        <div className="page-head">
          <div className="eyebrow meta mono">KNOWLEDGE · {id.slice(0, 8)}…</div>
          <h1 className="page-title serif">{nodeQ.isLoading ? '加载中…' : '知识点'}</h1>
        </div>
        <Stateful
          status={status}
          skeleton={<SkLines rows={6} />}
          errorText={errorText}
          onRetry={() => nodeQ.refetch()}
          empty={
            <EmptyState icon="knowledge" title="知识点不存在" text="该节点可能已被归档或删除。" />
          }
        >
          <div />
        </Stateful>
      </div>
    );
  }

  // Group the ADR-0027 notes client-side. `primary_atomic` is the inline 节点简介
  // (newest atomic) — exclude its id from the atomic list so it isn't shown twice
  // (pre-flight §6 dedupe). hub/long are listed as compact link rows.
  const primaryId = node.primary_atomic?.id ?? null;
  const atomicOthers = node.notes.filter((n) => n.type === 'note_atomic' && n.id !== primaryId);
  const hubNotes = node.notes.filter((n) => n.type === 'note_hub');
  const longNotes = node.notes.filter((n) => n.type === 'note_long');
  const hasAnyNote = Boolean(node.primary_atomic) || node.notes.length > 0;
  const noteGroups: Array<[string, NoteSummary[]]> = [
    ['note_atomic', atomicOthers],
    ['note_hub', hubNotes],
    ['note_long', longNotes],
  ];

  // Mesh neighbors grouped by relation_type (typed-relation blocks in loom).
  const byRelation = new Map<string, MeshNeighbor[]>();
  for (const n of node.mesh_neighbors) {
    const list = byRelation.get(n.relation_type);
    if (list) list.push(n);
    else byRelation.set(n.relation_type, [n]);
  }

  // Backlinks grouped: note_atomic/hub/long → 笔记; tool_quiz → 测验 (pre-flight §4).
  const noteBacklinks = node.backlinks.filter((b) => b.from_type.startsWith('note_'));
  const quizBacklinks = node.backlinks.filter((b) => b.from_type === 'tool_quiz');
  const backlinkGroups: Array<['note' | 'tool_quiz', Backlink[]]> = [
    ['note', noteBacklinks],
    ['tool_quiz', quizBacklinks],
  ];
  const hasAnyBacklink = noteBacklinks.length > 0 || quizBacklinks.length > 0;

  // Mastery guard — reuse MasteryBadge semantics (evidence_count thresholds): a
  // ring % is misleading below 3 evidence, so render a label instead. (pre-flight §6.)
  const masteryPct = Math.round((node.mastery ?? 0) * 100);
  const masteryLabel =
    node.evidence_count === 0
      ? '未练习'
      : node.evidence_count < 3
        ? `证据不足 · n=${node.evidence_count}`
        : null;
  const noteFrom = `from=knowledge:${node.id}`;

  return (
    <div className="page">
      <Link href="/knowledge" className="back-link">
        <LoomIcon name="arrowL" size={14} />
        知识网
      </Link>

      {/* header — eyebrow + mastery ring + serif title + metrics + 复习 CTA */}
      <div className="page-head">
        <div className="eyebrow meta mono">KNOWLEDGE · {node.id.slice(0, 8)}…</div>
        <div className="kd-head">
          {masteryLabel ? (
            <span
              className="mastery mastery-low-evidence"
              title={`evidence_count=${node.evidence_count}`}
            >
              <LoomIcon name="target" size={14} />
              {masteryLabel}
            </span>
          ) : (
            <Ring percent={masteryPct} />
          )}
          <div style={{ minWidth: 0 }}>
            <h1 className="page-title serif">{node.name}</h1>
            <div className="kd-metrics nowrap-meta">
              <span className="meta mono">{node.evidence_count} evidence</span>
              {node.effective_domain && (
                <>
                  <span className="dot-sep">·</span>
                  <span className="meta">{node.effective_domain}</span>
                </>
              )}
            </div>
          </div>
          <div className="hero-cta" style={{ marginLeft: 'auto' }}>
            <Link href="/review" className="btn btn-secondary">
              <LoomIcon name="review" size={17} />
              复习此点
            </Link>
          </div>
        </div>
      </div>

      <div className="kd-grid">
        <div className="kd-main">
          {/* 笔记 — primary atomic inline + grouped link rows (ADR-0027) */}
          <SectionLabel>笔记</SectionLabel>
          <div className="kd-note-hint meta">
            <LoomIcon name="link" size={12} />
            knowledge_id 是笔记上的标签 · 笔记按 note_atomic / note_hub / note_long
            区分，一条笔记可挂多个知识点
          </div>

          {!hasAnyNote ? (
            <LoomCard pad>
              <EmptyState
                icon="doc"
                title="还没有带此标签的笔记"
                text="在「学习项」里提议拆分一个学习意图、接受后会异步生成 atomic 笔记（NoteGenerateTask）。"
                action={
                  <Link href="/learning-items" className="btn btn-primary btn-sm">
                    <LoomIcon name="items" size={15} />
                    去生成节点笔记
                  </Link>
                }
              />
            </LoomCard>
          ) : (
            <>
              {node.primary_atomic && (
                <PrimaryNoteCard
                  atomic={node.primary_atomic}
                  profile={node.subject_profile}
                  from={noteFrom}
                />
              )}

              {noteGroups
                .filter(([, arr]) => arr.length > 0)
                .map(([kind, arr]) => {
                  const meta = NOTE_KIND_META[kind];
                  return (
                    <div key={kind} className="kd-note-group">
                      <div className="kd-note-group-h">
                        <span className={`note-kind-tag ${meta.tagClass}`}>{meta.tagLabel}</span>
                        {meta.groupLabel} · {arr.length}
                      </div>
                      {arr.map((nt) => (
                        <Link
                          key={nt.id}
                          href={`/notes/${nt.id}?${noteFrom}`}
                          className="note-link-row"
                        >
                          <LoomIcon name={meta.icon} size={15} />
                          <span className="note-link-title">{nt.title}</span>
                          <VerifyBadge status={nt.verification_status} />
                          <span className="meta">{formatRelTime(new Date(nt.updated_at))}</span>
                          <LoomIcon name="arrow" size={13} className="thread-arrow" />
                        </Link>
                      ))}
                    </div>
                  );
                })}
            </>
          )}

          {/* 邻居 · 按关系分组 — parent (层级) + typed mesh relations */}
          <SectionLabel>邻居 · 按关系分组</SectionLabel>
          <LoomCard pad>
            <div className="kd-rel-block">
              <div className="kd-rel-h">
                <LoomIcon name="tree" size={13} />
                层级
              </div>
              {node.parent_id ? (
                node.parent_name ? (
                  <Link href={`/knowledge/${node.parent_id}`} className="rel-row">
                    <span className="rel-kind mono">parent</span>
                    <span className="wenyan">{node.parent_name}</span>
                    <LoomIcon name="arrow" size={13} className="thread-arrow" />
                  </Link>
                ) : (
                  // archived/unresolvable parent → non-link placeholder (the endpoint
                  // 404s on archived nodes; avoid a dead link). (Codex #193)
                  <div className="rel-row" style={{ cursor: 'default' }}>
                    <span className="rel-kind mono">parent</span>
                    <span className="wenyan" style={{ color: 'var(--ink-3)' }}>
                      （父节点不可用）
                    </span>
                  </div>
                )
              ) : (
                <div className="quiet-empty">根节点 · 无父级</div>
              )}
            </div>

            {byRelation.size === 0 ? (
              <div className="kd-rel-block">
                <div className="quiet-empty">暂无横向关系</div>
              </div>
            ) : (
              Array.from(byRelation.entries()).map(([rel, neighbors]) => (
                <div key={rel} className="kd-rel-block">
                  <div className="kd-rel-h">
                    <span className={`rel-tag rel-tag-${rel}`}>{relationLabel(rel)}</span>
                  </div>
                  {neighbors.map((nb) => (
                    <Link
                      key={nb.edge_id}
                      href={`/knowledge/${nb.knowledge_id}`}
                      className="rel-row"
                    >
                      <span className="rel-kind mono">{nb.direction === 'out' ? '→' : '←'}</span>
                      <span className="wenyan">{nb.name}</span>
                      <LoomIcon name="arrow" size={13} className="thread-arrow" />
                    </Link>
                  ))}
                </div>
              ))
            )}
          </LoomCard>
        </div>

        <div className="kd-side">
          {/* 反向链接 · 按来源类型 — only groups with data (note / tool_quiz) */}
          <SectionLabel>反向链接 · 按来源类型</SectionLabel>
          <LoomCard pad>
            {!hasAnyBacklink ? (
              <div className="quiet-empty">无反向链接</div>
            ) : (
              backlinkGroups
                .filter(([, arr]) => arr.length > 0)
                .map(([type, arr]) => {
                  const meta = BACKLINK_GROUP_META[type];
                  return (
                    <div key={type} className="bl-group">
                      <div className="bl-kind mono">
                        <LoomIcon name={meta.icon} size={12} />
                        {meta.label} · {arr.length}
                      </div>
                      {arr.map((b) => {
                        const key = `${b.from_artifact_id}:${b.from_block_id}`;
                        // note backlinks → NoteReader; others → owning learning_item
                        // when resolvable (artifact id ≠ learning_item id; Codex #193).
                        const href =
                          type === 'note'
                            ? `/notes/${b.from_artifact_id}?${noteFrom}`
                            : b.from_learning_item_id
                              ? `/learning-items/${b.from_learning_item_id}`
                              : null;
                        return href ? (
                          <Link key={key} href={href} className="bl-row">
                            <BacklinkRowInner backlink={b} />
                          </Link>
                        ) : (
                          <div key={key} className="bl-row" style={{ cursor: 'default' }}>
                            <BacklinkRowInner backlink={b} />
                          </div>
                        );
                      })}
                    </div>
                  );
                })
            )}
          </LoomCard>

          {/* 活动 — event-chain timeline (label / relTime / outcome tone) */}
          <SectionLabel>活动</SectionLabel>
          <LoomCard pad>
            {node.timeline.length === 0 ? (
              <div className="quiet-empty">无活动记录</div>
            ) : (
              <div className="event-chain">
                {node.timeline.map((t, i) => {
                  const tone = t.outcome === 'failure' ? 'again' : 'neutral';
                  return (
                    <div key={t.event_id} className="event-row">
                      <span className="event-rail">
                        <span
                          className={`event-dot tone-${tone}`}
                          style={{
                            background: tone === 'again' ? 'var(--again)' : 'var(--ink-4)',
                          }}
                        />
                        {i < node.timeline.length - 1 && <span className="event-line" />}
                      </span>
                      <div className="event-body">
                        <div className="event-head nowrap-meta">
                          <span className="mono event-label">{actionLabel(t.action)}</span>
                          <span className="meta">{formatRelTime(new Date(t.created_at))}</span>
                          {t.actor_kind === 'agent' && (
                            <span className="meta mono">
                              <LoomIcon name="sparkle" size={11} /> AI
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </LoomCard>
        </div>
      </div>
    </div>
  );
}

// primary atomic 节点简介 — full reading body inline (BlockTreeRenderer, NOT the
// loom NoteEditor). Handles pending/failed/empty generation states.
function PrimaryNoteCard({
  atomic,
  profile,
  from,
}: {
  atomic: PrimaryAtomic;
  profile: SlimSubjectProfile;
  from: string;
}) {
  let body: React.ReactNode;
  if (atomic.generation_status === 'pending') {
    body = (
      <p className="quiet-empty">NoteGenerateTask 异步生成中（约 30-60s）。刷新本页可见进度。</p>
    );
  } else if (atomic.generation_status === 'failed') {
    body = (
      <p className="quiet-empty" style={{ color: 'var(--again-ink)' }}>
        生成失败。
      </p>
    );
  } else if (!atomic.body_blocks) {
    body = <p className="quiet-empty">这条 atomic 暂无内容。</p>;
  } else {
    body = (
      <BlockTreeRenderer
        bodyBlocks={atomic.body_blocks}
        subjectProfile={profile}
        embeddedQuestions={atomic.embedded_questions}
        embeddedCheckStatus={atomic.embedded_check_status}
      />
    );
  }

  return (
    <LoomCard pad className="kd-primary-note">
      <div className="kd-primary-head">
        <span className="note-kind-tag note-kind-atomic">
          <LoomIcon name="doc" size={12} />
          primary · note_atomic
        </span>
        <span className="kd-primary-title serif">{atomic.title}</span>
        <VerifyBadge status={atomic.verification_status} />
      </div>
      <div className="kd-primary-body">{body}</div>
      <div
        className="note-ref-acts"
        style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s-3)' }}
      >
        <Link href={`/notes/${atomic.id}?${from}`} className="btn btn-primary btn-sm">
          <LoomIcon name="doc" size={15} />
          在阅读器中打开
          <LoomIcon name="arrow" size={15} />
        </Link>
      </div>
    </LoomCard>
  );
}
