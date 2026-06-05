'use client';

import { ArtifactBlockTree } from '@/ui/block-tree/ArtifactBlockTree';
import type { BlockTreeDoc } from '@/ui/block-tree/types';
import type {
  ArtifactEmbeddedCheckStatus,
  EmbeddedCheckQuestion,
  ArtifactSection as NoteSection,
} from '@/ui/components/ArtifactSections';
import { NoteRenderer, VerificationBadge } from '@/ui/components/NoteRenderer';
import { TeachingDrawer } from '@/ui/components/TeachingDrawer';
import {
  CorrectionStateRenderer,
  type CorrectionStateSnapshot,
} from '@/ui/correction/CorrectionStateRenderer';
import { ItemHealthBar, aggregateHealth } from '@/ui/learning-items/health';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import {
  type SlimSubjectProfile,
  resolveSubjectRenderModel,
  subjectContentProps,
} from '@/ui/lib/subject';
import { openCopilotWith } from '@/ui/lib/use-copilot-dwell';
import { Btn } from '@/ui/primitives/Btn';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { Ring } from '@/ui/primitives/Ring';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { StatusBadge } from '@/ui/primitives/StatusBadge';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

type ItemStatus = 'pending' | 'in_progress' | 'done' | 'resting' | 'dismissed' | 'archived';

interface ChildRow {
  id: string;
  title: string;
  status: ItemStatus;
  knowledge_ids: string[];
}

interface ParentRow {
  id: string;
  title: string;
  status: ItemStatus;
}

type VerificationStatus =
  | 'not_required'
  | 'not_started'
  | 'queued'
  | 'verified'
  | 'needs_review'
  | 'failed';

interface NoteVerificationIssue {
  block_id: string | null;
  severity: 'info' | 'warn' | 'error';
  category: 'factuality' | 'coverage' | 'clarity' | 'subject_fit' | 'format' | 'safety';
  message: string;
  suggested_fix_md?: string;
}

interface NoteVerificationSummary {
  verdict: 'pass' | 'needs_review';
  summary_md: string;
  issues: NoteVerificationIssue[];
  confidence: number;
}

interface PrimaryArtifact {
  id: string;
  type: string;
  version: number;
  body_blocks: BlockTreeDoc | null;
  sections: NoteSection[] | null;
  generation_status: 'pending' | 'ready' | 'failed';
  verification_status: VerificationStatus;
  embedded_check_status: ArtifactEmbeddedCheckStatus;
  embedded_questions: EmbeddedCheckQuestion[];
  verification_summary: NoteVerificationSummary | null;
  verified_by: Record<string, unknown> | null;
}

interface Detail {
  id: string;
  source: string;
  source_ref: string | null;
  source_event: { id: string; correction_state: CorrectionStateSnapshot | null } | null;
  title: string;
  content: string;
  knowledge_ids: string[];
  subject_profile: SlimSubjectProfile;
  status: ItemStatus;
  parent_learning_item_id: string | null;
  primary_artifact_id: string | null;
  primary_artifact: PrimaryArtifact | null;
  parent: ParentRow | null;
  children: ChildRow[];
  completed_at: number | null;
  archived_at: number | null;
  archived_reason: string | null;
  created_at: number;
  updated_at: number;
  version: number;
}

interface CandidateRow {
  id: string;
  title: string;
  status: ItemStatus;
}

interface KnowledgeNode {
  id: string;
  name: string;
  effective_domain: string | null;
  mastery: number | null;
  evidence_count: number;
}

// /api/knowledge/review-due-summary — existing GET endpoint, minimal inline shape.
interface ReviewDueSummary {
  summary: Record<string, { overdue: number; due_soon: number }>;
}

const STATUS_TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  pending: ['in_progress', 'done', 'archived', 'dismissed'],
  in_progress: ['done', 'pending', 'archived'],
  done: ['in_progress', 'resting', 'archived'],
  resting: ['in_progress', 'archived'],
  dismissed: ['pending', 'archived'],
  archived: ['pending'],
};

const STATUS_LABEL: Record<ItemStatus, string> = {
  pending: '待办',
  in_progress: '进行中',
  done: '完成',
  resting: '养护',
  dismissed: '已拒',
  archived: '归档',
};

const STATUS_FLOW: ItemStatus[] = [
  'pending',
  'in_progress',
  'done',
  'resting',
  'dismissed',
  'archived',
];

export default function LearningItemDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();

  const detailQ = useQuery({
    queryKey: ['learning-item', id],
    queryFn: () => apiJson<Detail>(`/api/learning-items/${id}`),
    enabled: !!id,
  });

  const candidatesQ = useQuery({
    queryKey: ['learning-items', 'candidates'],
    queryFn: () => apiJson<{ rows: CandidateRow[] }>('/api/learning-items?limit=200'),
  });

  // D11 health bar inputs — both already-existing GET endpoints (zero new table
  // / write path; audit:schema unaffected).
  const knowledgeQ = useQuery({
    queryKey: ['knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });
  const dueSummaryQ = useQuery({
    queryKey: ['review-due-summary'],
    queryFn: () => apiJson<ReviewDueSummary>('/api/knowledge/review-due-summary'),
  });

  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [contentDraft, setContentDraft] = useState<string | null>(null);
  const [teachOpen, setTeachOpen] = useState(false);
  // YUK-19 — retract CTA state. Mirrors the inbox UI retract pattern: button
  // reveals reason textarea, second click confirms.
  const [retractDraftReason, setRetractDraftReason] = useState<string | null>(null);

  // YUK-19 — retract the originating learning_intent proposal. Reuses
  // /api/proposals/[id]/retract (CC-4 invariant). On success the backend
  // tombstones the materialized hub + atomic learning_items + artifacts,
  // so we invalidate the learning-items caches.
  const retractM = useMutation({
    mutationFn: (vars: { proposalId: string; reason_md: string }) =>
      apiJson<{ kind: 'retracted'; correction_event_id: string }>(
        `/api/proposals/${vars.proposalId}/retract`,
        {
          method: 'POST',
          body: JSON.stringify({ reason_md: vars.reason_md }),
        },
      ),
    onSuccess: () => {
      setRetractDraftReason(null);
      qc.invalidateQueries({ queryKey: ['learning-item', id] });
      qc.invalidateQueries({ queryKey: ['learning-items'] });
    },
  });

  const data = detailQ.data;
  useEffect(() => {
    if (data) {
      setTitleDraft(null);
      setContentDraft(null);
    }
  }, [data]);

  const updateM = useMutation({
    mutationFn: (vars: {
      version: number;
      title?: string;
      content?: string;
      status?: ItemStatus;
      parent_learning_item_id?: string | null;
    }) =>
      apiJson(`/api/learning-items/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['learning-item', id] });
      qc.invalidateQueries({ queryKey: ['learning-items'] });
    },
  });

  const detachChildM = useMutation({
    mutationFn: (vars: { childId: string; version: number }) =>
      apiJson(`/api/learning-items/${vars.childId}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: vars.version, parent_learning_item_id: null }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['learning-item', id] });
    },
  });
  // Surfaces failures from the detach two-step (version round-trip GET +
  // PATCH) — silently swallowing them left the user with no feedback
  // (CodeRabbit, PR #294).
  const [detachError, setDetachError] = useState<string | null>(null);

  if (detailQ.isLoading) {
    return (
      <Shell>
        <LoomCard pad>
          <p className="item-sub">加载中…</p>
        </LoomCard>
      </Shell>
    );
  }
  if (detailQ.isError) {
    const err = detailQ.error;
    return (
      <Shell>
        <LoomCard pad>
          <p className="meta" style={{ color: 'var(--again-ink)' }}>
            {err instanceof ApiAuthError
              ? `${err.message} — 请重新进入页面输入 token`
              : `加载失败：${(err as Error).message}`}
          </p>
        </LoomCard>
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell>
        <LoomCard pad>
          <p className="item-sub">未找到。</p>
        </LoomCard>
      </Shell>
    );
  }

  const currentParent = data.parent;
  const candidates = (candidatesQ.data?.rows ?? []).filter(
    (r) =>
      r.id !== data.id &&
      r.id !== data.parent_learning_item_id &&
      !data.children.some((c) => c.id === r.id),
  );
  const allowedStatusTargets = STATUS_TRANSITIONS[data.status] ?? [];
  const subjectModel = resolveSubjectRenderModel(data.subject_profile);
  const titleInputProps = subjectContentProps(subjectModel, { className: 'title-input serif' });
  const contentTextareaProps = subjectContentProps(subjectModel, {
    className: 'field-input',
    style: contentStyle,
  });
  const knowledgeById = new Map(knowledgeQ.data?.rows.map((n) => [n.id, n]) ?? []);
  const health = aggregateHealth(data.knowledge_ids, knowledgeById, dueSummaryQ.data?.summary);

  return (
    <Shell>
      <Link href="/learning-items" className="back-link">
        <LoomIcon name="arrowL" size={14} />
        学习项
      </Link>

      <div className="page-head">
        <div className="eyebrow">
          LEARNING_ITEM · {data.id} · {currentParent ? 'atomic' : 'hub'}
        </div>
        <div className="page-head-row">
          <input
            {...titleInputProps}
            type="text"
            aria-label="标题"
            value={titleDraft ?? data.title}
            maxLength={200}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              if (titleDraft?.trim() && titleDraft !== data.title) {
                updateM.mutate({ version: data.version, title: titleDraft.trim() });
              } else {
                setTitleDraft(null);
              }
            }}
          />
          <div className="hero-cta">
            {/* AF S4 / YUK-203 U6 — the 「对话教学」 entry is RE-POINTED to the
                global Copilot Dock (the single user-facing conversational agent,
                AF §1.1): clicking it opens the Dock pre-seeded with a teaching
                skill_context instead of the per-page TeachingDrawer. The legacy
                TeachingDrawer import + mount (below) STAY in parallel (R3 — the
                legacy teaching route is not retired in U6; cut-over is a separate
                closeout). The prior RED-LINE ("AF S4 absorbs it") is now executed
                here. */}
            <Btn
              variant="secondary"
              icon="teach"
              onClick={() =>
                openCopilotWith({ skill: 'teaching', ref: { kind: 'learning_item', id: data.id } })
              }
            >
              对话教学
            </Btn>
            {data.status === 'archived' || data.status === 'dismissed' ? (
              // Archived/dismissed items must leave via restore-to-pending —
              // STATUS_TRANSITIONS allows archived→pending and
              // dismissed→pending|archived only; a direct jump to in_progress
              // hits the API's invalid_transition (Codex review, PR #294 + r2).
              <Btn
                variant="secondary"
                icon="undo"
                onClick={() => updateM.mutate({ version: data.version, status: 'pending' })}
                disabled={updateM.isPending}
              >
                {data.status === 'archived' ? '取出归档' : '恢复待办'}
              </Btn>
            ) : (
              <Btn
                variant="primary"
                icon="review"
                onClick={() => updateM.mutate({ version: data.version, status: 'in_progress' })}
                disabled={updateM.isPending || data.status === 'in_progress'}
              >
                {data.status === 'in_progress' ? '进行中' : '开始学'}
              </Btn>
            )}
          </div>
        </div>
      </div>

      {/* YUK-19 — source event block + retract CTA (wiring unchanged). */}
      {data.source_event && (
        <SourceEventBlock
          source={data.source}
          sourceEvent={data.source_event}
          archivedReason={data.archived_reason}
          retractDraftReason={retractDraftReason}
          setRetractDraftReason={setRetractDraftReason}
          onRetract={(reason_md) =>
            data.source_event && retractM.mutate({ proposalId: data.source_event.id, reason_md })
          }
          isPending={retractM.isPending}
          error={retractM.isError ? (retractM.error as Error).message : null}
        />
      )}

      <div className="kd-grid" style={{ marginTop: 'var(--s-5)' }}>
        <div className="kd-main">
          {/* D11 health bar */}
          <ItemHealthBar health={health} />

          {/* content editor */}
          <LoomCard pad style={{ marginTop: 'var(--s-4)' }}>
            <div className="field-label">内容</div>
            <textarea
              {...contentTextareaProps}
              value={contentDraft ?? data.content}
              rows={8}
              maxLength={10_000}
              onChange={(e) => setContentDraft(e.target.value)}
              onBlur={() => {
                if (contentDraft !== null && contentDraft !== data.content) {
                  updateM.mutate({ version: data.version, content: contentDraft });
                } else {
                  setContentDraft(null);
                }
              }}
            />
            {updateM.isError && (
              <p className="meta" style={{ color: 'var(--again-ink)', marginTop: 'var(--s-2)' }}>
                更新失败：{(updateM.error as Error).message}
              </p>
            )}
          </LoomCard>

          {/* YUK-92 P2-basic — primary artifact block-tree note when present */}
          {data.primary_artifact && (
            <ArtifactView
              artifact={data.primary_artifact}
              subjectProfile={data.subject_profile}
              onSectionSaved={() => {
                qc.invalidateQueries({ queryKey: ['learning-item', id] });
                qc.invalidateQueries({ queryKey: ['learning-items'] });
              }}
            />
          )}

          {/* children */}
          {data.children.length > 0 && (
            <>
              <SectionLabel count={data.children.length}>子项</SectionLabel>
              <div className="grid" style={{ display: 'grid', gap: 'var(--s-2)' }}>
                {data.children.map((c) => {
                  const childHealth = aggregateHealth(
                    c.knowledge_ids,
                    knowledgeById,
                    dueSummaryQ.data?.summary,
                  );
                  return (
                    <div key={c.id} className="child-row">
                      <span className="item-ic info" style={{ width: 32, height: 32 }}>
                        <LoomIcon name="review" size={16} />
                      </span>
                      <Link
                        href={`/learning-items/${c.id}`}
                        className="child-title wenyan"
                        style={{ color: 'inherit', textDecoration: 'none' }}
                      >
                        {c.title}
                      </Link>
                      <StatusBadge status={c.status} />
                      {childHealth.avgMastery !== null && !childHealth.lowEvidence && (
                        <Ring percent={childHealth.avgMastery} />
                      )}
                      <Btn
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setDetachError(null);
                          // child version unknown here; round-trip patch fetches it.
                          apiJson<{ version: number }>(`/api/learning-items/${c.id}`)
                            .then((row) =>
                              detachChildM.mutate(
                                { childId: c.id, version: row.version },
                                {
                                  onError: (err) =>
                                    setDetachError(err instanceof Error ? err.message : '解除失败'),
                                },
                              ),
                            )
                            .catch((err) =>
                              setDetachError(err instanceof Error ? err.message : '解除失败'),
                            );
                        }}
                        disabled={detachChildM.isPending}
                      >
                        解除
                      </Btn>
                    </div>
                  );
                })}
              </div>
              {detachError && (
                <p className="meta" style={{ color: 'var(--again)' }}>
                  解除失败：{detachError}
                </p>
              )}
            </>
          )}
        </div>

        <div className="kd-side">
          <SectionLabel>属性</SectionLabel>
          <LoomCard pad>
            <div className="prop-field">
              <div className="field-label">状态</div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--s-2)',
                  flexWrap: 'wrap',
                }}
              >
                <StatusBadge status={data.status} />
                <LoomBadge tone="info">{subjectModel.displayName}</LoomBadge>
              </div>
              <div className="status-flow" style={{ marginTop: 'var(--s-2)' }}>
                {STATUS_FLOW.map((s) => {
                  const reachable = data.status === s || allowedStatusTargets.includes(s);
                  return (
                    <button
                      type="button"
                      key={s}
                      className={`status-step${data.status === s ? ' on' : ''}`}
                      disabled={!reachable || updateM.isPending}
                      onClick={() =>
                        data.status !== s && updateM.mutate({ version: data.version, status: s })
                      }
                    >
                      {STATUS_LABEL[s]}
                    </button>
                  );
                })}
              </div>
            </div>

            {data.knowledge_ids.length > 0 && (
              <div className="prop-field">
                <div className="field-label">知识点</div>
                <div className="chip-set">
                  {data.knowledge_ids.map((kid) => {
                    const node = knowledgeById.get(kid);
                    return (
                      <Link key={kid} href={`/knowledge/${kid}`} className="chip chip-k mono">
                        #{node?.name ?? kid}
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="prop-field">
              <div className="field-label">父节点（hub）</div>
              {currentParent ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--s-2)',
                    flexWrap: 'wrap',
                  }}
                >
                  <Link href={`/learning-items/${currentParent.id}`} className="chip chip-k mono">
                    {currentParent.title}
                  </Link>
                  <StatusBadge status={currentParent.status} />
                  <Btn
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      updateM.mutate({ version: data.version, parent_learning_item_id: null })
                    }
                    disabled={updateM.isPending}
                  >
                    脱离
                  </Btn>
                </div>
              ) : (
                <ParentPicker
                  candidates={candidates}
                  onAttach={(parentId) =>
                    updateM.mutate({ version: data.version, parent_learning_item_id: parentId })
                  }
                  disabled={updateM.isPending}
                />
              )}
            </div>
          </LoomCard>
        </div>
      </div>

      {teachOpen && (
        <TeachingDrawer
          learningItemId={data.id}
          learningItemTitle={data.title}
          subjectProfile={data.subject_profile}
          onClose={() => setTeachOpen(false)}
        />
      )}
    </Shell>
  );
}

function ArtifactView({
  artifact,
  subjectProfile,
  onSectionSaved,
}: {
  artifact: PrimaryArtifact;
  subjectProfile: SlimSubjectProfile;
  onSectionSaved: () => void;
}) {
  // W8-1 / read-view DEFECT 5 (削减型) — 状态条只在异常态显形：
  // generation 'ready' 不显示 chip（§5 line 111 of
  // docs/design/2026-05-26-atomic-note-read-view.md，"ready + not_required 隐藏"）。
  const showGenerationStatus = artifact.generation_status !== 'ready';
  // verification chip 同理：仅 pending/queued/needs_review/failed/outdated/not_started
  // 异常或进行态显形；'verified' + 'not_required' 99% 稳态收起。
  const showVerificationStatus =
    artifact.verification_status !== 'verified' && artifact.verification_status !== 'not_required';
  const hasStatusRow = showGenerationStatus || showVerificationStatus;

  return (
    <section className="artifact-view">
      {/* W8-1 / read-view DEFECT 4 (纯删) — `note · note_atomic` eyebrow 技术词移除
          (§5 line 112 of docs/design/2026-05-26-atomic-note-read-view.md,
          "技术词不进 UI")。artifact.type 仍在数据层，只是不渲染给用户。 */}
      {hasStatusRow && (
        <div className="artifact-view-head">
          <div className="artifact-status-row">
            {showGenerationStatus && (
              <span className={`artifact-status ${artifact.generation_status}`}>
                {artifact.generation_status === 'pending' ? '生成中...' : '生成失败'}
              </span>
            )}
            {showVerificationStatus && (
              <VerificationBadge
                status={artifact.verification_status}
                summary={artifact.verification_summary?.summary_md}
                issues={artifact.verification_summary?.issues ?? []}
              />
            )}
          </div>
        </div>
      )}
      {artifact.generation_status === 'pending' && (
        <p className="artifact-stub">
          NoteGenerateTask 异步生成中（每条 atomic 约 30-60s）。刷新本页可见进度。
        </p>
      )}
      {artifact.generation_status === 'failed' && (
        <p className="artifact-stub" style={{ color: 'var(--again-ink)' }}>
          生成失败。可在 pg-boss UI / worker 日志查看错误，或手动 enqueue 重跑。
        </p>
      )}
      {artifact.generation_status === 'ready' && artifact.sections && (
        <>
          <ArtifactBlockTree
            artifactId={artifact.id}
            artifactVersion={artifact.version}
            bodyBlocks={artifact.body_blocks}
            sections={artifact.sections}
            subjectProfile={subjectProfile}
            embeddedQuestions={artifact.embedded_questions}
            embeddedCheckStatus={artifact.embedded_check_status}
            onArtifactSaved={onSectionSaved}
            onSectionSaved={onSectionSaved}
          />
          {artifact.verification_summary && (
            <div className="artifact-verification">
              {/* YUK-52 — summary_md + suggested_fix_md are markdown per
                  NoteVerificationResult zod schema (src/core/schema/business.ts).
                  Render via NoteRenderer with verification variant so the
                  denser sans-font prose style applies; issue.message stays
                  plain text (no _md suffix on schema). */}
              <NoteRenderer
                kind="verification"
                notation={
                  (subjectProfile.renderConfig?.notation ?? undefined) as
                    | 'latex'
                    | 'wenyan'
                    | 'plaintext'
                    | 'code'
                    | undefined
                }
              >
                {artifact.verification_summary.summary_md}
              </NoteRenderer>
              {artifact.verification_summary.issues.length > 0 && (
                <ul>
                  {artifact.verification_summary.issues.map((issue, idx) => (
                    <li key={`${issue.block_id ?? 'global'}-${idx}`}>
                      <strong>{issue.severity}</strong>
                      <span>{issue.category}</span>
                      <p>{issue.message}</p>
                      {issue.suggested_fix_md && (
                        <NoteRenderer
                          kind="verification"
                          notation={
                            (subjectProfile.renderConfig?.notation ?? undefined) as
                              | 'latex'
                              | 'wenyan'
                              | 'plaintext'
                              | 'code'
                              | undefined
                          }
                        >
                          {issue.suggested_fix_md}
                        </NoteRenderer>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ParentPicker({
  candidates,
  onAttach,
  disabled,
}: {
  candidates: CandidateRow[];
  onAttach: (id: string) => void;
  disabled: boolean;
}) {
  const [filter, setFilter] = useState('');
  const filtered = candidates
    .filter((c) => c.title.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 20);
  return (
    <div className="parent-picker">
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="搜索一个学习项作为父项 hub"
        className="field-input"
      />
      <div className="chip-set" style={{ marginTop: 'var(--s-2)' }}>
        {filtered.map((c) => (
          <button
            type="button"
            key={c.id}
            onClick={() => onAttach(c.id)}
            disabled={disabled}
            className="chip"
          >
            {c.title}
          </button>
        ))}
        {filter && filtered.length === 0 && <span className="item-sub">无匹配</span>}
      </div>
    </div>
  );
}

// YUK-19 — source event block. Always shows the origin event link +
// correction state badge. Adds a retract CTA only when source='learning_intent'
// (the producer) and the proposal is still active (not yet retracted /
// superseded). The retract button reveals a reason textarea, confirm dispatches
// /api/proposals/[id]/retract.
function SourceEventBlock({
  source,
  sourceEvent,
  archivedReason,
  retractDraftReason,
  setRetractDraftReason,
  onRetract,
  isPending,
  error,
}: {
  source: string;
  sourceEvent: { id: string; correction_state: CorrectionStateSnapshot | null };
  archivedReason: string | null;
  retractDraftReason: string | null;
  setRetractDraftReason: (value: string | null) => void;
  onRetract: (reason_md: string) => void;
  isPending: boolean;
  error: string | null;
}) {
  const state = sourceEvent.correction_state?.state ?? 'active';
  const canRetract = source === 'learning_intent' && state === 'active';

  return (
    <LoomCard pad className="origin-card" style={{ marginTop: 'var(--s-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
        <span className="ai-tag">
          <LoomIcon name="sparkle" size={12} />
          AI · {source}
        </span>
        <Link href={`/events/${sourceEvent.id}`} className="chip chip-k mono">
          {sourceEvent.id.slice(0, 8)}…
        </Link>
        <CorrectionStateRenderer state={sourceEvent.correction_state} showActive />
        {archivedReason === 'proposal_retracted' && (
          <LoomBadge tone="again">archive 因 proposal 撤回</LoomBadge>
        )}
      </div>

      {canRetract && retractDraftReason === null && (
        <div style={{ marginTop: 'var(--s-3)' }}>
          <Btn variant="ghost" icon="undo" onClick={() => setRetractDraftReason('')}>
            撤回此 proposal（连带归档已生成的 hub + atomic）
          </Btn>
        </div>
      )}
      {canRetract && retractDraftReason !== null && (
        <div style={{ marginTop: 'var(--s-3)' }}>
          <div className="field-label">撤回原因</div>
          <textarea
            value={retractDraftReason}
            onChange={(e) => setRetractDraftReason(e.target.value)}
            placeholder="例：方向走错了 / 拆分粒度不对 / 重做一遍"
            rows={3}
            maxLength={2000}
            className="field-input"
            style={{ minHeight: 80, lineHeight: 'var(--lh-prose)', resize: 'vertical' }}
          />
          <div className="hero-cta" style={{ justifyContent: 'flex-end', marginTop: 'var(--s-2)' }}>
            <Btn variant="ghost" onClick={() => setRetractDraftReason(null)} disabled={isPending}>
              取消
            </Btn>
            <Btn
              variant="primary"
              onClick={() =>
                onRetract(retractDraftReason.trim() || '撤回 learning_intent proposal')
              }
              disabled={isPending}
            >
              {isPending ? '撤回中…' : '确认撤回'}
            </Btn>
          </div>
          {error && (
            <p className="meta" style={{ color: 'var(--again-ink)', marginTop: 'var(--s-2)' }}>
              撤回失败：{error}
            </p>
          )}
        </div>
      )}
    </LoomCard>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      className="page prose items-loom"
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '36px 28px',
        maxWidth: 'var(--cap-wide, 1080px)',
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </main>
  );
}

const contentStyle: React.CSSProperties = {
  minHeight: 140,
  lineHeight: 'var(--lh-prose)',
  resize: 'vertical',
  width: '100%',
};
