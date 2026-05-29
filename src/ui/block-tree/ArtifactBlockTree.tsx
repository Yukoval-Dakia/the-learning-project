'use client';

import dynamic from 'next/dynamic';
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
  const correctionWriteGenerationRef = useRef(0);

  useEffect(() => {
    setLocalBodyBlocks(bodyBlocks ? coerceBlockTreeDoc(bodyBlocks) : null);
    setLocalVersion(artifactVersion);
  }, [bodyBlocks, artifactVersion]);

  useEffect(() => {
    let canceled = false;
    const startGeneration = correctionWriteGenerationRef.current;
    setCorrectionState(null);
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
      {saveError ? <p className="artifact-section-error">保存失败：{saveError}</p> : null}
    </div>
  );
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
