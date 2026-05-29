'use client';

import { BlockTreeRenderer } from '@/ui/block-tree/BlockTreeRenderer';
import type { BlockTreeDoc } from '@/ui/block-tree/types';
import type {
  ArtifactEmbeddedCheckStatus,
  EmbeddedCheckQuestion,
} from '@/ui/components/ArtifactSections';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import type { SlimSubjectProfile } from '@/ui/lib/subject';
import { formatRelTime } from '@/ui/lib/utils';
import { Badge } from '@/ui/primitives/Badge';
import { Card } from '@/ui/primitives/Card';
import { MasteryBadge } from '@/ui/primitives/MasteryBadge';
import { PageHeader } from '@/ui/primitives/PageHeader';
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

const BACKLINK_TYPE_LABEL: Record<string, string> = {
  note_atomic: '原子',
  note_hub: 'Hub',
  note_long: '长文',
  tool_quiz: '测验',
};

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

  return (
    <main className="page prose">
      <p style={breadcrumbStyle}>
        <Link href="/knowledge" style={{ color: 'var(--coral)' }}>
          ← 知识图谱
        </Link>
      </p>

      <PageHeader
        title={node?.name ?? '加载中…'}
        eyebrow={`/knowledge/${id.slice(0, 8)}…`}
        sub={node?.effective_domain ? `domain · ${node.effective_domain}` : undefined}
      />

      {nodeQ.isError && (
        <Card pad="lg">
          <p style={errorStyle}>
            {nodeQ.error instanceof ApiAuthError
              ? `${nodeQ.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(nodeQ.error as Error).message}`}
          </p>
        </Card>
      )}

      {node && (
        <>
          {/* 1. metadata + mastery + mesh neighbor chips (ADR-0020 §10) */}
          <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
            <div style={sectionHeaderStyle}>
              <SectionLabel>元信息</SectionLabel>
              <MasteryBadge
                data={{
                  mastery: node.mastery,
                  evidence_count: node.evidence_count,
                  last_evidence_at: node.last_evidence_at,
                }}
              />
            </div>
            <dl style={dlStyle}>
              <Row label="id" value={node.id} mono />
              <Row label="name" value={node.name} />
              <Row label="domain" value={node.domain ?? '(继承)'} />
              <Row
                label="parent"
                value={
                  node.parent_id ? (
                    // parent_name is null when the parent is archived (or otherwise
                    // unresolvable): the /knowledge/[id] endpoint 404s on archived
                    // nodes, so render a non-link placeholder instead of a dead
                    // link. (Codex #193)
                    node.parent_name ? (
                      <Link href={`/knowledge/${node.parent_id}`} style={{ color: 'var(--coral)' }}>
                        {node.parent_name}
                      </Link>
                    ) : (
                      <span style={{ color: 'var(--ink-3)' }}>（父节点不可用）</span>
                    )
                  ) : (
                    '(根节点)'
                  )
                }
              />
              <Row label="effective_domain" value={node.effective_domain ?? '—'} />
            </dl>

            <div style={{ marginTop: 'var(--s-4)' }}>
              <SectionLabel>mesh 邻居（{node.mesh_neighbors.length}）</SectionLabel>
              {node.mesh_neighbors.length === 0 ? (
                <p style={{ ...mutedStyle, margin: 0 }}>暂无横向关系。</p>
              ) : (
                <div style={chipRowStyle}>
                  {node.mesh_neighbors.map((n) => (
                    <Link
                      key={n.edge_id}
                      href={`/knowledge/${n.knowledge_id}`}
                      style={meshChipStyle}
                    >
                      <span style={meshArrowStyle}>{n.direction === 'out' ? '→' : '←'}</span>
                      <span style={meshRelStyle}>{relationLabel(n.relation_type)}</span>
                      <span>{n.name}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* 2. primary atomic body_blocks inline — or placeholder when none */}
          <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
            <SectionLabel>节点简介（atomic）</SectionLabel>
            {node.primary_atomic ? (
              <PrimaryAtomicView atomic={node.primary_atomic} profile={node.subject_profile} />
            ) : (
              <PrimaryAtomicPlaceholder />
            )}
          </Card>

          {/* 3. backlinks panel (reuse listBacklinks via /api/knowledge/[id]) */}
          <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
            <SectionLabel>反向链接（{node.backlinks.length}）</SectionLabel>
            {node.backlinks.length === 0 ? (
              <p style={{ ...mutedStyle, margin: 0 }}>还没有其它笔记链接到这个节点的简介。</p>
            ) : (
              <div style={backlinkListStyle}>
                {node.backlinks.map((b) => {
                  const key = `${b.from_artifact_id}:${b.from_block_id}`;
                  // Link to the owning learning_item (its detail route queries by
                  // learning_item.id, not artifact.id). When unresolved (no
                  // non-archived owning learning_item) render a non-link so we
                  // never emit a 404 href. (Codex #193)
                  return b.from_learning_item_id ? (
                    <Link
                      key={key}
                      href={`/learning-items/${b.from_learning_item_id}`}
                      style={backlinkRowStyle}
                    >
                      <BacklinkRowInner backlink={b} />
                    </Link>
                  ) : (
                    <div key={key} style={backlinkRowStyle}>
                      <BacklinkRowInner backlink={b} />
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* 4. activity timeline (event referenced_knowledge_ids) */}
          <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
            <SectionLabel>最近活动（{node.timeline.length}）</SectionLabel>
            {node.timeline.length === 0 ? (
              <p style={{ ...mutedStyle, margin: 0 }}>暂无与此节点相关的事件。</p>
            ) : (
              <div style={timelineListStyle}>
                {node.timeline.map((t) => (
                  <div key={t.event_id} style={timelineRowStyle}>
                    <span style={timelineMetaStyle}>{formatRelTime(new Date(t.created_at))}</span>
                    <Badge tone={t.actor_kind === 'agent' ? 'info' : 'neutral'}>
                      {t.actor_kind === 'agent'
                        ? 'AI'
                        : t.actor_kind === 'user'
                          ? '用户'
                          : t.actor_kind}
                    </Badge>
                    <span style={{ color: 'var(--ink)' }}>{actionLabel(t.action)}</span>
                    {t.outcome === 'failure' && <Badge tone="again">失败</Badge>}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* D graph 视图 placeholder — ADR-0020 §10: day1 不做，roadmap phase 2+ */}
          <p style={{ ...mutedStyle, marginTop: 'var(--s-5)', textAlign: 'center' }}>
            节点局部关系图（D graph）待 phase 2+ 实现。
          </p>
        </>
      )}
    </main>
  );
}

function PrimaryAtomicView({
  atomic,
  profile,
}: {
  atomic: PrimaryAtomic;
  profile: SlimSubjectProfile;
}) {
  if (atomic.generation_status === 'pending') {
    return <p style={mutedStyle}>NoteGenerateTask 异步生成中（约 30-60s）。刷新本页可见进度。</p>;
  }
  if (atomic.generation_status === 'failed') {
    return <p style={{ ...mutedStyle, color: 'var(--again-ink)' }}>生成失败。</p>;
  }
  if (!atomic.body_blocks) {
    return <p style={mutedStyle}>这条 atomic 暂无内容。</p>;
  }
  return (
    <div style={{ marginTop: 'var(--s-2)' }}>
      {/* Link to the owning learning_item (its detail route queries by
          learning_item.id, not artifact.id). When unresolved (no non-archived
          owning learning_item) render a non-link so we never emit a 404 href —
          mirrors the backlink rows below. (Codex #193 / YUK-161) */}
      {atomic.owning_learning_item_id ? (
        <Link
          href={`/learning-items/${atomic.owning_learning_item_id}`}
          style={{ color: 'var(--coral)' }}
        >
          {atomic.title} →
        </Link>
      ) : (
        <span style={{ color: 'var(--ink)' }}>{atomic.title}</span>
      )}
      <div style={{ marginTop: 'var(--s-3)' }}>
        <BlockTreeRenderer
          bodyBlocks={atomic.body_blocks}
          subjectProfile={profile}
          embeddedQuestions={atomic.embedded_questions}
          embeddedCheckStatus={atomic.embedded_check_status}
        />
      </div>
    </div>
  );
}

// P6/D (W8-1 scope-down) — 无主 atomic 占位卡 + 引导。完整「一键生成」需先建
// artifact stub + learning_item 脚手架（orchestrator scope，超出本 UI lane），
// 故此处引导用户走现有 learning-intent propose 流程；完整 zero-scaffold 生成端点
// 留 follow-up Linear issue。
function PrimaryAtomicPlaceholder() {
  return (
    <div style={{ marginTop: 'var(--s-2)' }}>
      <p style={{ ...mutedStyle, margin: '0 0 var(--s-3)' }}>
        这个节点还没有 atomic 简介笔记。在「学习项」里提议拆分一个学习意图、接受后会异步生成 atomic
        笔记（NoteGenerateTask）。
      </p>
      <Link href="/learning-items" style={generateCtaStyle}>
        去生成节点笔记
      </Link>
    </div>
  );
}

function BacklinkRowInner({ backlink }: { backlink: Backlink }) {
  return (
    <>
      <Badge tone={backlink.from_type === 'note_hub' ? 'good' : 'info'}>
        {BACKLINK_TYPE_LABEL[backlink.from_type] ?? backlink.from_type}
      </Badge>
      <span style={{ color: 'var(--ink)' }}>{backlink.from_title}</span>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-meta)',
        color: 'var(--ink-4)',
        letterSpacing: 'var(--ls-wide)',
        display: 'block',
        marginBottom: 'var(--s-3)',
      }}
    >
      {children}
    </span>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt style={dtStyle}>{label}</dt>
      <dd style={mono ? ddMonoStyle : ddStyle}>{value}</dd>
    </>
  );
}

const breadcrumbStyle: React.CSSProperties = {
  margin: '0 0 var(--s-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  letterSpacing: 'var(--ls-wide)',
};

const errorStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--again-ink)',
};

const mutedStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-3)',
};

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--s-3)',
  marginBottom: 'var(--s-3)',
};

const dlStyle: React.CSSProperties = {
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  rowGap: 'var(--s-2)',
  columnGap: 'var(--s-3)',
};

const dtStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};

const ddStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--ink)',
};

const ddMonoStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-2)',
};

const chipRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--s-2)',
};

const meshChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--s-1, 4px)',
  fontSize: 'var(--fs-meta)',
  padding: '4px 10px',
  borderRadius: 'var(--r-pill)',
  border: '1px solid var(--line)',
  background: 'var(--paper-sunk)',
  color: 'var(--ink-2)',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
};

const meshArrowStyle: React.CSSProperties = {
  color: 'var(--ink-4)',
};

const meshRelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};

const backlinkListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-2)',
};

const backlinkRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
  padding: 'var(--s-2) 0',
  borderTop: '1px solid var(--line-soft)',
  textDecoration: 'none',
};

const timelineListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-2)',
};

const timelineRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
  padding: 'var(--s-2) 0',
  borderTop: '1px solid var(--line-soft)',
  flexWrap: 'wrap',
};

const timelineMetaStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};

const generateCtaStyle: React.CSSProperties = {
  display: 'inline-block',
  fontSize: 'var(--fs-body)',
  padding: '6px 14px',
  borderRadius: 'var(--r-2)',
  border: '1px solid var(--line)',
  background: 'var(--paper-sunk)',
  color: 'var(--coral)',
  textDecoration: 'none',
};
