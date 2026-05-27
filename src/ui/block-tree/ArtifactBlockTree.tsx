'use client';

import dynamic from 'next/dynamic';
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
      onArtifactSaved?.(result);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
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
          initialContent={localBodyBlocks}
          saving={saving}
          onSave={saveBodyBlocks}
          onCancel={() => setEditing(false)}
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
      {saveError ? <p className="artifact-section-error">保存失败：{saveError}</p> : null}
    </div>
  );
}
