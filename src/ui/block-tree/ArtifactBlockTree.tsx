'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import type {
  ArtifactCorrectionStateResponse,
  ArtifactCorrectionStatus,
  ArtifactEmbeddedCheckStatus,
  ArtifactSection,
  EmbeddedCheckQuestion,
} from '@/ui/components/ArtifactSections';
import { ArtifactSections } from '@/ui/components/ArtifactSections';
import { apiJson } from '@/ui/lib/api';
import type { SlimSubjectProfile } from '@/ui/lib/subject';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { BlockTreeRenderer } from './BlockTreeRenderer';
import { coerceBlockTreeDoc } from './pm';
import type { BlockTreeDoc } from './types';

const LazyBlockTreeEditor = dynamic(
  () => import('./BlockTreeEditor').then((mod) => mod.BlockTreeEditor),
  {
    ssr: false,
    loading: () => <div className="block-tree-editor-shell">加载编辑器...</div>,
  },
);

interface ArtifactBodyBlocksSaveResponse {
  artifact_id: string;
  artifact_version: number;
  body_blocks: BlockTreeDoc;
  event_id: string;
}

interface AiChangeRow {
  event_id: string;
  artifact_id: string;
  created_at: string;
  actor_ref: string;
  ops_count: number;
  new_blocks: number;
  previous_artifact_version: number;
  next_artifact_version: number;
  undone: boolean;
}

// YUK-95 P5 Lane-B — one inbound cross-link row, as returned by
// GET /api/artifacts/[id]/backlinks (source already filtered for archived /
// non-ready / retracted-block per XC-5).
interface BacklinkRow {
  from_artifact_id: string;
  // owning learning_item.id for the source artifact; null when unresolved (no
  // non-archived owning learning_item). The row links to /learning-items/<id> by
  // this learning_item.id — NOT from_artifact_id, which 404s (YUK-160). Null →
  // non-link row.
  from_learning_item_id: string | null;
  from_title: string;
  from_type: string;
  from_block_id: string;
  snippet: string | null;
}

interface ArtifactBlockTreeProps {
  artifactId: string;
  artifactVersion: number;
  bodyBlocks: BlockTreeDoc | null;
  sections: ArtifactSection[] | null;
  subjectProfile: SlimSubjectProfile;
  embeddedQuestions: EmbeddedCheckQuestion[];
  embeddedCheckStatus: ArtifactEmbeddedCheckStatus;
  onArtifactSaved?: (result: ArtifactBodyBlocksSaveResponse) => void;
  onSectionSaved?: () => void;
}

const ACTIVE_STATUS: ArtifactCorrectionStatus = {
  state: 'active',
  correction_event_id: null,
  replacement_artifact_id: null,
};

export function ArtifactBlockTree({
  artifactId,
  artifactVersion,
  bodyBlocks,
  sections,
  subjectProfile,
  embeddedQuestions,
  embeddedCheckStatus,
  onArtifactSaved,
  onSectionSaved,
}: ArtifactBlockTreeProps) {
  const router = useRouter();
  const [localBodyBlocks, setLocalBodyBlocks] = useState<BlockTreeDoc | null>(
    bodyBlocks ? coerceBlockTreeDoc(bodyBlocks) : null,
  );
  const [localVersion, setLocalVersion] = useState(artifactVersion);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [correctionState, setCorrectionState] = useState<ArtifactCorrectionStateResponse | null>(
    null,
  );
  const [markingWrongBlockId, setMarkingWrongBlockId] = useState<string | null>(null);
  const [markWrongReason, setMarkWrongReason] = useState('');
  const [pendingCorrectionBlockId, setPendingCorrectionBlockId] = useState<string | null>(null);
  const [aiChanges, setAiChanges] = useState<AiChangeRow[]>([]);
  const [aiChangesLoading, setAiChangesLoading] = useState(false);
  const [undoingAiChangeId, setUndoingAiChangeId] = useState<string | null>(null);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [backlinks, setBacklinks] = useState<BacklinkRow[] | null>(null);
  const [backlinksLoading, setBacklinksLoading] = useState(false);
  // YUK-95 P5 Lane-D — artifact_ids the user just dismissed from the auto-zone
  // (optimistic client-side hide; server removes the child + the next nightly
  // run honors suppressed_block_refs).
  const [dismissedAutoLinkIds, setDismissedAutoLinkIds] = useState<Set<string>>(new Set());
  const [dismissingAutoLinkId, setDismissingAutoLinkId] = useState<string | null>(null);
  const correctionWriteGenerationRef = useRef(0);

  useEffect(() => {
    setLocalBodyBlocks(bodyBlocks ? coerceBlockTreeDoc(bodyBlocks) : null);
    setLocalVersion(artifactVersion);
  }, [bodyBlocks, artifactVersion]);

  useEffect(() => {
    let canceled = false;
    const startGeneration = correctionWriteGenerationRef.current;
    setCorrectionState(null);
    // Reset the (lazily fetched) backlink panel when switching artifacts.
    setBacklinksOpen(false);
    setBacklinks(null);
    // Reset optimistic auto-link dismissals when switching artifacts.
    setDismissedAutoLinkIds(new Set());
    apiJson<ArtifactCorrectionStateResponse>(`/api/artifacts/${artifactId}/correct`)
      .then((state) => {
        if (canceled) return;
        if (correctionWriteGenerationRef.current !== startGeneration) return;
        setCorrectionState(state);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [artifactId]);

  // Lazy fetch: only hit the read API once the user opens the panel, and only
  // once per artifact (cached in `backlinks`). Mirrors the ai-changes fetch.
  useEffect(() => {
    if (!backlinksOpen || backlinks !== null) return;
    let canceled = false;
    setBacklinksLoading(true);
    apiJson<{ rows: BacklinkRow[] }>(`/api/artifacts/${artifactId}/backlinks`)
      .then((result) => {
        if (!canceled) setBacklinks(result.rows);
      })
      .catch(() => {
        if (!canceled) setBacklinks([]);
      })
      .finally(() => {
        if (!canceled) setBacklinksLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [artifactId, backlinksOpen, backlinks]);

  useEffect(() => {
    let canceled = false;
    if (!localBodyBlocks) {
      setAiChanges([]);
      return () => {
        canceled = true;
      };
    }
    setAiChangesLoading(true);
    apiJson<{ rows: AiChangeRow[] }>(`/api/artifacts/${artifactId}/ai-changes`)
      .then((result) => {
        if (!canceled) setAiChanges(result.rows);
      })
      .catch(() => {
        if (!canceled) setAiChanges([]);
      })
      .finally(() => {
        if (!canceled) setAiChangesLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [artifactId, localBodyBlocks]);

  useEffect(() => {
    if (!editing) return;
    const sendHeartbeat = () => {
      void apiJson('/api/editing-session/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ artifact_id: artifactId, status: 'editing' }),
      }).catch(() => {});
    };
    sendHeartbeat();
    const timer = window.setInterval(sendHeartbeat, 5000);
    return () => {
      window.clearInterval(timer);
      void markEditorIdle();
    };
  }, [artifactId, editing]);

  if (!localBodyBlocks) {
    return (
      <ArtifactSections
        artifactId={artifactId}
        artifactVersion={localVersion}
        sections={sections ?? []}
        subjectProfile={subjectProfile}
        embeddedQuestions={embeddedQuestions}
        embeddedCheckStatus={embeddedCheckStatus}
        onSectionSaved={onSectionSaved}
      />
    );
  }

  async function saveBodyBlocks(next: BlockTreeDoc) {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await apiJson<ArtifactBodyBlocksSaveResponse>(
        `/api/artifacts/${artifactId}/body-blocks`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            artifact_version: localVersion,
            body_blocks: next,
          }),
        },
      );
      setLocalBodyBlocks(result.body_blocks);
      setLocalVersion(result.artifact_version);
      setEditing(false);
      void markEditorIdle();
      onArtifactSaved?.(result);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function markEditorIdle() {
    await apiJson('/api/editing-session/blur', {
      method: 'POST',
      body: JSON.stringify({ artifact_id: artifactId }),
    }).catch(() => {});
  }

  async function undoAiChange(eventId: string) {
    setUndoingAiChangeId(eventId);
    setSaveError(null);
    try {
      await apiJson(`/api/artifacts/${artifactId}/ai-changes/${eventId}/undo`, {
        method: 'POST',
      });
      setAiChanges((current) =>
        current.map((row) => (row.event_id === eventId ? { ...row, undone: true } : row)),
      );
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setUndoingAiChangeId(null);
    }
  }

  async function submitMarkWrong(blockId: string) {
    const reason = markWrongReason.trim();
    if (reason.length === 0) return;
    setPendingCorrectionBlockId(blockId);
    try {
      const result = await apiJson<{ correction_event_id: string }>(
        `/api/artifacts/${artifactId}/correct`,
        {
          method: 'POST',
          body: JSON.stringify({
            correction_kind: 'mark_wrong',
            block_id: blockId,
            reason_md: reason,
          }),
        },
      );
      correctionWriteGenerationRef.current += 1;
      setCorrectionState((current) => ({
        artifact_id: artifactId,
        whole: current?.whole ?? ACTIVE_STATUS,
        blocks: {
          ...(current?.blocks ?? {}),
          [blockId]: {
            state: 'marked_wrong',
            correction_event_id: result.correction_event_id,
            replacement_artifact_id: null,
          },
        },
      }));
      setMarkingWrongBlockId(null);
      setMarkWrongReason('');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingCorrectionBlockId(null);
    }
  }

  async function submitRestore(blockId: string) {
    setPendingCorrectionBlockId(blockId);
    try {
      await apiJson<{ correction_event_id: string }>(`/api/artifacts/${artifactId}/correct`, {
        method: 'POST',
        body: JSON.stringify({
          correction_kind: 'restore',
          block_id: blockId,
          reason_md: '撤销标错',
        }),
      });
      correctionWriteGenerationRef.current += 1;
      setCorrectionState((current) => {
        const blocks = { ...(current?.blocks ?? {}) };
        delete blocks[blockId];
        return {
          artifact_id: artifactId,
          whole: current?.whole ?? ACTIVE_STATUS,
          blocks,
        };
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingCorrectionBlockId(null);
    }
  }

  // YUK-95 P5 Lane-D — dismiss one system-maintained auto-link. Optimistically
  // hide it, then POST to the hub dismiss write-path (appends
  // suppressed_block_refs + writes a suppress event + removes the child). On
  // failure, un-hide and surface the error.
  async function dismissAutoLink(target: { artifact_id: string; relation: string | null }) {
    setDismissingAutoLinkId(target.artifact_id);
    setSaveError(null);
    setDismissedAutoLinkIds((current) => new Set(current).add(target.artifact_id));
    try {
      await apiJson(`/api/hubs/${artifactId}/dismiss-link`, {
        method: 'POST',
        body: JSON.stringify({
          suppressed_artifact_id: target.artifact_id,
          ...(target.relation ? { relation: target.relation } : {}),
        }),
      });
      // Server removed the child + recorded the suppress; refresh to pull the
      // canonical body_blocks (the optimistic hide bridges the gap until then).
      router.refresh();
    } catch (err) {
      setDismissedAutoLinkIds((current) => {
        const next = new Set(current);
        next.delete(target.artifact_id);
        return next;
      });
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setDismissingAutoLinkId(null);
    }
  }

  return (
    <div className="block-tree-panel">
      <div className="block-tree-panel-actions">
        <Button variant="secondary" size="sm" icon="pen" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Read' : 'Edit'}
        </Button>
      </div>
      {editing ? (
        <LazyBlockTreeEditor
          artifactId={artifactId}
          initialContent={localBodyBlocks}
          saving={saving}
          onSave={saveBodyBlocks}
          onCancel={() => {
            void markEditorIdle();
            setEditing(false);
          }}
          onEditorBlur={() => {
            void markEditorIdle();
          }}
        />
      ) : (
        <BlockTreeRenderer
          bodyBlocks={localBodyBlocks}
          subjectProfile={subjectProfile}
          embeddedQuestions={embeddedQuestions}
          embeddedCheckStatus={embeddedCheckStatus}
          correctionBlocks={correctionState?.blocks ?? {}}
          hiddenAutoLinkArtifactIds={dismissedAutoLinkIds}
          renderAutoLinkDismiss={(target) => (
            <Button
              variant="ghost"
              size="sm"
              icon="x"
              className="auto-link-dismiss"
              title="不再自动链接此笔记"
              disabled={dismissingAutoLinkId === target.artifact_id}
              onClick={() => dismissAutoLink(target)}
            >
              {dismissingAutoLinkId === target.artifact_id ? '...' : '移除'}
            </Button>
          )}
          renderBlockActions={({ id, status }) => {
            const isPending = pendingCorrectionBlockId === id;
            if (markingWrongBlockId === id) {
              return (
                <div className="block-tree-mark-wrong-inline">
                  <input
                    value={markWrongReason}
                    maxLength={2000}
                    placeholder="标错原因"
                    onChange={(event) => setMarkWrongReason(event.target.value)}
                  />
                  <Button
                    variant="danger"
                    size="sm"
                    icon="alert"
                    disabled={isPending || markWrongReason.trim().length === 0}
                    onClick={() => submitMarkWrong(id)}
                  >
                    提交
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="x"
                    onClick={() => setMarkingWrongBlockId(null)}
                  >
                    取消
                  </Button>
                </div>
              );
            }
            if (status.state === 'marked_wrong') {
              return (
                <Button
                  variant="quiet"
                  size="sm"
                  icon="refresh"
                  disabled={isPending}
                  onClick={() => submitRestore(id)}
                >
                  {isPending ? '撤销中...' : '撤销标错'}
                </Button>
              );
            }
            return (
              <Button
                variant="quiet"
                size="sm"
                icon="alert"
                disabled={pendingCorrectionBlockId !== null}
                onClick={() => setMarkingWrongBlockId(id)}
              >
                标错
              </Button>
            );
          }}
        />
      )}
      {!editing && (aiChanges.length > 0 || aiChangesLoading) ? (
        <div className="ai-change-panel">
          <div className="ai-change-panel-head">
            <Badge tone="info">AI 改动</Badge>
            <span>{aiChangesLoading ? '加载中...' : `最近 ${aiChanges.length} 条`}</span>
          </div>
          {aiChanges.map((change) => (
            <div key={change.event_id} className="ai-change-row">
              <div>
                <strong>{change.ops_count} ops</strong>
                <span>
                  v{change.previous_artifact_version} → v{change.next_artifact_version} · 新增{' '}
                  {change.new_blocks} block · {formatAiChangeTime(change.created_at)}
                </span>
              </div>
              <Button
                variant={change.undone ? 'quiet' : 'danger'}
                size="sm"
                icon={change.undone ? 'check' : 'refresh'}
                disabled={change.undone || undoingAiChangeId === change.event_id}
                onClick={() => undoAiChange(change.event_id)}
              >
                {change.undone
                  ? '已撤销'
                  : undoingAiChangeId === change.event_id
                    ? '撤销中...'
                    : '撤销'}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {!editing ? (
        <div className="backlink-panel">
          <button
            type="button"
            className="backlink-panel-head"
            aria-expanded={backlinksOpen}
            onClick={() => setBacklinksOpen((v) => !v)}
          >
            <span className="backlink-panel-title">
              <Badge tone="neutral">反向链接</Badge>
              {backlinks !== null ? <span>{backlinks.length}</span> : null}
            </span>
            <span className="backlink-panel-chevron">{backlinksOpen ? '收起' : '展开'}</span>
          </button>
          {backlinksOpen ? (
            <div className="backlink-panel-body">
              {backlinksLoading ? (
                <p className="backlink-empty">加载中...</p>
              ) : backlinks && backlinks.length > 0 ? (
                backlinks.map((row) => {
                  const key = `${row.from_artifact_id}:${row.from_block_id}`;
                  // Link by owning learning_item.id; when unresolved render a
                  // non-link row to avoid a /learning-items/<artifact-id> 404 (YUK-160).
                  return row.from_learning_item_id ? (
                    <Link
                      key={key}
                      href={`/learning-items/${row.from_learning_item_id}`}
                      className="backlink-row"
                    >
                      <BacklinkRowInner row={row} />
                    </Link>
                  ) : (
                    <div key={key} className="backlink-row">
                      <BacklinkRowInner row={row} />
                    </div>
                  );
                })
              ) : (
                <p className="backlink-empty">还没有其它笔记链接到这里。</p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {saveError ? <p className="artifact-section-error">保存失败：{saveError}</p> : null}
    </div>
  );
}

// Shared row content for both the linked + non-linked backlink rows. Extracted
// as a component (mirrors the node page's BacklinkRowInner) so the iterable's
// keys live on the <Link>/<div> wrappers, not on bare JSX. (YUK-160)
function BacklinkRowInner({ row }: { row: BacklinkRow }) {
  return (
    <>
      <span className="backlink-row-head">
        <Badge tone={backlinkTypeTone(row.from_type)}>{backlinkTypeLabel(row.from_type)}</Badge>
        <strong>{row.from_title}</strong>
      </span>
      {row.snippet ? <span className="backlink-row-snippet">{row.snippet}</span> : null}
    </>
  );
}

const BACKLINK_TYPE_LABELS: Record<string, string> = {
  note_atomic: '原子',
  note_hub: 'Hub',
  tool_quiz: '测验',
  // Defensive (ADR-0033): interactive artifacts carry no cross_link sources
  // (body_blocks=null), so this is unreachable today — kept for the widened
  // artifact enum. backlinkTypeTone falls through to neutral, which is right.
  interactive: '互动',
};

function backlinkTypeLabel(type: string): string {
  return BACKLINK_TYPE_LABELS[type] ?? type;
}

function backlinkTypeTone(type: string): 'info' | 'good' | 'neutral' {
  if (type === 'note_hub') return 'good';
  if (type === 'note_atomic') return 'info';
  return 'neutral';
}

function formatAiChangeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
