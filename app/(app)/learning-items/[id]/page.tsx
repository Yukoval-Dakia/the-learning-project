'use client';

import { TeachingDrawer } from '@/ui/components/TeachingDrawer';
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

interface NoteSection {
  id: string;
  kind: 'definition' | 'mechanism' | 'example' | 'pitfall' | 'check';
  body_md: string;
  source_tier: 'llm_only' | 'search_grounded' | 'textbook' | 'user_verified';
  user_verified: boolean;
  embedded_check: { question_ids: string[] } | null;
  version: number;
}

type VerificationStatus =
  | 'not_required'
  | 'not_started'
  | 'queued'
  | 'verified'
  | 'needs_review'
  | 'failed';

interface NoteVerificationIssue {
  section_id: string | null;
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
  sections: NoteSection[] | null;
  outline_json: Record<string, unknown> | null;
  generation_status: 'pending' | 'ready' | 'failed';
  verification_status: VerificationStatus;
  verification_summary: NoteVerificationSummary | null;
  verified_by: Record<string, unknown> | null;
}

interface Detail {
  id: string;
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

const VERIFICATION_LABEL: Record<VerificationStatus, string> = {
  not_required: '无需验证',
  not_started: '待验证',
  queued: '验证中...',
  verified: '已验证',
  needs_review: '需复核',
  failed: '验证失败',
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

      {/* Phase 2B — primary artifact (note) sections when present */}
      {data.primary_artifact && (
        <ArtifactView artifact={data.primary_artifact} subjectProfile={data.subject_profile} />
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

const SECTION_LABEL: Record<NoteSection['kind'], string> = {
  definition: '定义',
  mechanism: '机制 / 规则',
  example: '例',
  pitfall: '易错',
  check: '自检',
};

const SOURCE_TIER_LABEL: Record<NoteSection['source_tier'], string> = {
  llm_only: 'AI 单 pass',
  search_grounded: 'search-grounded',
  textbook: '教材',
  user_verified: '已核',
};

function ArtifactView({
  artifact,
  subjectProfile,
}: {
  artifact: PrimaryArtifact;
  subjectProfile: SlimSubjectProfile;
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
          <span className={`artifact-status verify-${artifact.verification_status}`}>
            {VERIFICATION_LABEL[artifact.verification_status]}
          </span>
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
          <div className="artifact-sections">
            {artifact.sections.map((s) => {
              const sectionBodyProps = subjectContentProps(subjectProfile, {
                className: 'artifact-section-body',
              });
              return (
                <div key={s.id} className="artifact-section">
                  <div className="artifact-section-head">
                    <strong>{SECTION_LABEL[s.kind]}</strong>
                    <span className="artifact-section-tier">
                      {SOURCE_TIER_LABEL[s.source_tier]}
                    </span>
                  </div>
                  <pre {...sectionBodyProps}>{s.body_md}</pre>
                  {s.kind === 'check' && s.embedded_check && (
                    <p className="artifact-section-stub">
                      embedded check · {s.embedded_check.question_ids.length} 题（Phase 3 启用 quiz
                      引擎）
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {artifact.verification_summary && (
            <div className="artifact-verification">
              <p>{artifact.verification_summary.summary_md}</p>
              {artifact.verification_summary.issues.length > 0 && (
                <ul>
                  {artifact.verification_summary.issues.map((issue, idx) => (
                    <li key={`${issue.section_id ?? 'global'}-${idx}`}>
                      <strong>{issue.severity}</strong>
                      <span>{issue.category}</span>
                      <p>{issue.message}</p>
                      {issue.suggested_fix_md && <pre>{issue.suggested_fix_md}</pre>}
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
