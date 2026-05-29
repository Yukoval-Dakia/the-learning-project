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
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import {
  type SlimSubjectProfile,
  resolveSubjectRenderModel,
  subjectContentProps,
} from '@/ui/lib/subject';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
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

  if (detailQ.isLoading) {
    return (
      <Shell>
        <Card>
          <p style={mutedStyle}>加载中…</p>
        </Card>
      </Shell>
    );
  }
  if (detailQ.isError) {
    const err = detailQ.error;
    return (
      <Shell>
        <Card>
          <p style={errorStyle}>
            {err instanceof ApiAuthError
              ? `${err.message} — 请重新进入页面输入 token`
              : `加载失败：${(err as Error).message}`}
          </p>
        </Card>
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell>
        <Card>
          <p style={mutedStyle}>未找到。</p>
        </Card>
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
  const titleInputProps = subjectContentProps(subjectModel, { style: inputStyle });
  const contentTextareaProps = subjectContentProps(subjectModel, { style: textareaStyle });

  return (
    <Shell>
      <PageHeader title="学习项详情" eyebrow={`/learning-items/${data.id}`} />
      <div style={{ marginTop: 'var(--s-2)' }}>
        <Link href="/learning-items" style={linkStyle}>
          ← 返回列表
        </Link>
        {currentParent && (
          <>
            <span style={{ margin: '0 var(--s-2)', color: 'var(--ink-4)' }}>·</span>
            <Link href={`/learning-items/${currentParent.id}`} style={linkStyle}>
              ↑ 父项：{currentParent.title}
            </Link>
          </>
        )}
        <span style={{ margin: '0 var(--s-2)', color: 'var(--ink-4)' }}>·</span>
        <button
          type="button"
          onClick={() => setTeachOpen(true)}
          style={{
            ...linkStyle,
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          → 对话教学
        </button>
      </div>

      {/* YUK-19 — source event block. Surface origin proposal + correction state
          + retract CTA when the item came from a still-active learning_intent
          proposal. Reuses CorrectionStateRenderer (CC-2) + the existing retract
          route (CC-4). */}
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

      <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
        <Label>标题</Label>
        <input
          {...titleInputProps}
          type="text"
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

        <div
          style={{
            marginTop: 'var(--s-3)',
            display: 'flex',
            gap: 'var(--s-3)',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Label inline>状态</Label>
          <StatusBadge status={data.status as never} />
          <Badge tone="info">{subjectModel.displayName}</Badge>
          {allowedStatusTargets.map((t) => (
            <Button
              key={t}
              variant={t === 'archived' || t === 'dismissed' ? 'ghost' : 'primary'}
              onClick={() => updateM.mutate({ version: data.version, status: t })}
              disabled={updateM.isPending}
            >
              → {STATUS_LABEL[t]}
            </Button>
          ))}
        </div>

        <div style={{ marginTop: 'var(--s-3)' }}>
          <Label>内容</Label>
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
        </div>

        {data.knowledge_ids.length > 0 && (
          <div style={{ marginTop: 'var(--s-3)' }}>
            <Label>知识点</Label>
            <div style={chipRowStyle}>
              {data.knowledge_ids.map((kid) => (
                <Badge key={kid} tone="neutral">
                  {kid}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {updateM.isError && <p style={errorStyle}>更新失败：{(updateM.error as Error).message}</p>}
      </Card>

      {/* Parent linkage */}
      <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
        <Label>父项（hub）</Label>
        {currentParent ? (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', flexWrap: 'wrap' }}
          >
            <Link href={`/learning-items/${currentParent.id}`} style={linkStyle}>
              {currentParent.title}
            </Link>
            <StatusBadge status={currentParent.status as never} />
            <Button
              variant="ghost"
              onClick={() =>
                updateM.mutate({ version: data.version, parent_learning_item_id: null })
              }
              disabled={updateM.isPending}
            >
              脱离父项
            </Button>
          </div>
        ) : (
          <ParentPicker
            candidates={candidates}
            onAttach={(parentId) =>
              updateM.mutate({
                version: data.version,
                parent_learning_item_id: parentId,
              })
            }
            disabled={updateM.isPending}
          />
        )}
      </Card>

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

      {/* Children */}
      <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
        <Label>子项（atomic）</Label>
        {data.children.length === 0 ? (
          <p style={mutedStyle}>暂无子项。</p>
        ) : (
          <ul style={childListStyle}>
            {data.children.map((c) => (
              <li key={c.id} style={childRowStyle}>
                <Link href={`/learning-items/${c.id}`} style={linkStyle}>
                  {c.title}
                </Link>
                <StatusBadge status={c.status as never} />
                <Button
                  variant="ghost"
                  onClick={() => {
                    // child version unknown here; round-trip patch fetches it.
                    apiJson<{ version: number }>(`/api/learning-items/${c.id}`)
                      .then((row) => detachChildM.mutate({ childId: c.id, version: row.version }))
                      .catch(() => {});
                  }}
                  disabled={detachChildM.isPending}
                >
                  解除
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
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
  return (
    <section className="artifact-view">
      <div className="artifact-view-head">
        <Label inline>note · {artifact.type}</Label>
        <div className="artifact-status-row">
          <span className={`artifact-status ${artifact.generation_status}`}>
            {artifact.generation_status === 'pending'
              ? '生成中...'
              : artifact.generation_status === 'failed'
                ? '生成失败'
                : '已就绪'}
          </span>
          <VerificationBadge
            status={artifact.verification_status}
            summary={artifact.verification_summary?.summary_md}
            issues={artifact.verification_summary?.issues ?? []}
          />
        </div>
      </div>
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
    <div>
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="搜索一个学习项作为父项 hub"
        style={inputStyle}
      />
      <div style={chipRowStyle}>
        {filtered.map((c) => (
          <button
            type="button"
            key={c.id}
            onClick={() => onAttach(c.id)}
            disabled={disabled}
            style={attachChipStyle}
          >
            {c.title}
          </button>
        ))}
        {filter && filtered.length === 0 && <span style={mutedStyle}>无匹配</span>}
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
    <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--s-3)',
          flexWrap: 'wrap',
        }}
      >
        <Label inline>source event</Label>
        <Link href={`/events/${sourceEvent.id}`} style={linkStyle}>
          {sourceEvent.id.slice(0, 8)}…
        </Link>
        <CorrectionStateRenderer state={sourceEvent.correction_state} showActive />
        {archivedReason === 'proposal_retracted' && (
          <Badge tone="again">archive 因 proposal 撤回</Badge>
        )}
      </div>

      {canRetract && retractDraftReason === null && (
        <div style={{ marginTop: 'var(--s-3)' }}>
          <Button variant="ghost" onClick={() => setRetractDraftReason('')}>
            撤回此 proposal（连带归档已生成的 hub + atomic）
          </Button>
        </div>
      )}
      {canRetract && retractDraftReason !== null && (
        <div style={{ marginTop: 'var(--s-3)' }}>
          <Label>撤回原因</Label>
          <textarea
            value={retractDraftReason}
            onChange={(e) => setRetractDraftReason(e.target.value)}
            placeholder="例：方向走错了 / 拆分粒度不对 / 重做一遍"
            rows={3}
            maxLength={2000}
            style={{
              ...inputStyle,
              minHeight: 80,
              lineHeight: 'var(--lh-prose)',
              resize: 'vertical',
            }}
          />
          <div
            style={{
              marginTop: 'var(--s-2)',
              display: 'flex',
              gap: 'var(--s-2)',
              justifyContent: 'flex-end',
            }}
          >
            <Button
              variant="ghost"
              onClick={() => setRetractDraftReason(null)}
              disabled={isPending}
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                onRetract(retractDraftReason.trim() || '撤回 learning_intent proposal')
              }
              disabled={isPending}
            >
              {isPending ? '撤回中…' : '确认撤回'}
            </Button>
          </div>
          {error && <p style={errorStyle}>撤回失败：{error}</p>}
        </div>
      )}
    </Card>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '36px 28px',
        maxWidth: 'var(--cap-prose, 780px)',
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </main>
  );
}

function Label({
  children,
  inline,
}: {
  children: React.ReactNode;
  inline?: boolean;
}) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-meta)',
        color: 'var(--ink-4)',
        letterSpacing: 'var(--ls-wide)',
        display: inline ? 'inline-block' : 'block',
        marginBottom: inline ? 0 : 'var(--s-2)',
        marginRight: inline ? 'var(--s-2)' : 0,
      }}
    >
      {children}
    </span>
  );
}

const linkStyle: React.CSSProperties = {
  color: 'var(--coral)',
  textDecoration: 'none',
};

const mutedStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--ink-3)',
};

const errorStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0 0',
  fontSize: 'var(--fs-body)',
  color: 'var(--again-ink)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  fontSize: 'var(--fs-body)',
  background: 'var(--paper-sunk)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-2)',
  outline: 'none',
  boxSizing: 'border-box',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: 140,
  lineHeight: 'var(--lh-prose)',
  resize: 'vertical',
};

const chipRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  marginTop: 'var(--s-2)',
};

const attachChipStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  padding: '4px 10px',
  borderRadius: 'var(--r-pill)',
  border: '1px solid var(--line)',
  background: 'var(--paper-sunk)',
  color: 'var(--ink-2)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  letterSpacing: 'var(--ls-wide)',
};

const childListStyle: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-2)',
};

const childRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-3)',
  padding: '8px 0',
  borderBottom: '1px solid var(--line-soft)',
  flexWrap: 'wrap',
};
