'use client';

import { type CSSProperties, useEffect, useState } from 'react';

import { apiJson } from '@/ui/lib/api';
import {
  type SlimSubjectProfile,
  resolveSubjectRenderModel,
  subjectContentProps,
} from '@/ui/lib/subject';
import { Badge, type BadgeTone } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { type EmbeddedCheckQuestion, EmbeddedCheckSection } from './EmbeddedCheckSection';
import { NoteRenderer } from './NoteRenderer';

export type { EmbeddedCheckQuestion };

export type ArtifactSectionKind = 'definition' | 'mechanism' | 'example' | 'pitfall' | 'check';
export type ArtifactSourceTier = 'llm_only' | 'search_grounded' | 'textbook' | 'user_verified';
export type ArtifactEmbeddedCheckStatus = 'not_required' | 'pending' | 'ready' | 'failed';

export interface ArtifactSection {
  id: string;
  kind: ArtifactSectionKind;
  body_md: string;
  source_tier: ArtifactSourceTier;
  user_verified: boolean;
  embedded_check: { question_ids: string[] } | null;
  version: number;
}

export interface ArtifactSectionEditResponse {
  artifact_id: string;
  artifact_version: number;
  section: ArtifactSection;
  event_id: string;
}

export interface ArtifactSectionEditSnapshot {
  artifactVersion: number;
  sections: ArtifactSection[];
}

export type ArtifactCorrectionStatus =
  | { state: 'active'; correction_event_id: null; replacement_artifact_id: null }
  | { state: 'retracted'; correction_event_id: string; replacement_artifact_id: null }
  | { state: 'marked_wrong'; correction_event_id: string; replacement_artifact_id: null }
  | { state: 'superseded'; correction_event_id: string; replacement_artifact_id: string };

export interface ArtifactCorrectionStateResponse {
  artifact_id: string;
  whole: ArtifactCorrectionStatus;
  sections: Record<string, ArtifactCorrectionStatus>;
}

const ACTIVE_CORRECTION_STATUS: ArtifactCorrectionStatus = {
  state: 'active',
  correction_event_id: null,
  replacement_artifact_id: null,
};

function correctionStatusLabel(status: ArtifactCorrectionStatus): string | null {
  if (status.state === 'active') return null;
  if (status.state === 'marked_wrong') return '已标错';
  if (status.state === 'retracted') return '已撤回';
  return '已替换';
}

function correctionStatusTone(status: ArtifactCorrectionStatus): BadgeTone {
  if (status.state === 'superseded') return 'hard';
  if (status.state === 'retracted' || status.state === 'marked_wrong') return 'again';
  return 'neutral';
}

const SECTION_LABEL: Record<ArtifactSectionKind, string> = {
  definition: '定义',
  mechanism: '机制 / 规则',
  example: '例',
  pitfall: '易错',
  check: '自检',
};

const SOURCE_TIER_LABEL: Record<ArtifactSourceTier, string> = {
  llm_only: 'AI 单 pass',
  search_grounded: 'search-grounded',
  textbook: '教材',
  user_verified: '已核',
};

interface ArtifactSectionsProps {
  artifactId?: string;
  artifactVersion?: number;
  sections: ArtifactSection[];
  subjectProfile: SlimSubjectProfile;
  embeddedQuestions: EmbeddedCheckQuestion[];
  embeddedCheckStatus: ArtifactEmbeddedCheckStatus;
  onSectionSaved?: (result: ArtifactSectionEditResponse) => void;
  initialEditingSectionId?: string;
  initialCorrectionState?: ArtifactCorrectionStateResponse | null;
}

export function getArtifactSectionEditMinHeight(bodyMd: string): number {
  const visualLines = bodyMd.split('\n').reduce((total, line) => {
    return total + Math.max(1, Math.ceil(line.length / 76));
  }, 0);
  return Math.min(360, Math.max(112, visualLines * 24 + 36));
}

export function createOptimisticSectionEdit(
  snapshot: ArtifactSectionEditSnapshot,
  sectionId: string,
  nextBodyMd: string,
): { optimistic: ArtifactSectionEditSnapshot; rollback: ArtifactSectionEditSnapshot } {
  const optimisticSections = snapshot.sections.map((section) =>
    section.id === sectionId
      ? { ...section, body_md: nextBodyMd, version: section.version + 1 }
      : section,
  );
  return {
    optimistic: {
      artifactVersion: snapshot.artifactVersion + 1,
      sections: optimisticSections,
    },
    rollback: snapshot,
  };
}

export function ArtifactSections({
  artifactId,
  artifactVersion,
  sections,
  subjectProfile,
  embeddedQuestions,
  embeddedCheckStatus,
  onSectionSaved,
  initialEditingSectionId,
  initialCorrectionState,
}: ArtifactSectionsProps) {
  const subjectModel = resolveSubjectRenderModel(subjectProfile);
  const [localSections, setLocalSections] = useState<ArtifactSection[]>(sections);
  const [localArtifactVersion, setLocalArtifactVersion] = useState(artifactVersion ?? 0);
  const [editingSectionId, setEditingSectionId] = useState<string | null>(
    initialEditingSectionId ?? null,
  );
  const [draftBodyMd, setDraftBodyMd] = useState(
    () => sections.find((section) => section.id === initialEditingSectionId)?.body_md ?? '',
  );
  const [pendingSectionId, setPendingSectionId] = useState<string | null>(null);
  const [errorBySectionId, setErrorBySectionId] = useState<Record<string, string>>({});
  const [correctionState, setCorrectionState] = useState<ArtifactCorrectionStateResponse | null>(
    initialCorrectionState ?? null,
  );
  const [markingWrongSectionId, setMarkingWrongSectionId] = useState<string | null>(null);
  const [markWrongReason, setMarkWrongReason] = useState('');
  const [pendingCorrectionSectionId, setPendingCorrectionSectionId] = useState<string | null>(null);
  const [correctionErrorBySectionId, setCorrectionErrorBySectionId] = useState<
    Record<string, string>
  >({});
  const canEdit = Boolean(artifactId && artifactVersion !== undefined);
  const canCorrect = Boolean(artifactId);

  useEffect(() => {
    setLocalSections(sections);
    setLocalArtifactVersion(artifactVersion ?? 0);
  }, [sections, artifactVersion]);

  useEffect(() => {
    if (!artifactId) {
      setCorrectionState(null);
      return;
    }
    let canceled = false;
    apiJson<ArtifactCorrectionStateResponse>(`/api/artifacts/${artifactId}/correct`)
      .then((state) => {
        if (!canceled) setCorrectionState(state);
      })
      .catch(() => {
        // best-effort; keep last-known state
      });
    return () => {
      canceled = true;
    };
  }, [artifactId]);

  function sectionStatus(sectionId: string): ArtifactCorrectionStatus {
    return correctionState?.sections?.[sectionId] ?? ACTIVE_CORRECTION_STATUS;
  }

  function startEdit(section: ArtifactSection) {
    setEditingSectionId(section.id);
    setDraftBodyMd(section.body_md);
    setErrorBySectionId((current) => {
      const next = { ...current };
      delete next[section.id];
      return next;
    });
  }

  function cancelEdit() {
    setEditingSectionId(null);
    setDraftBodyMd('');
  }

  async function saveEdit(section: ArtifactSection) {
    if (!artifactId) return;
    const nextBodyMd = draftBodyMd;
    const snapshot = {
      artifactVersion: localArtifactVersion,
      sections: localSections,
    };
    const edit = createOptimisticSectionEdit(snapshot, section.id, nextBodyMd);

    setPendingSectionId(section.id);
    setEditingSectionId(null);
    setLocalSections(edit.optimistic.sections);
    setLocalArtifactVersion(edit.optimistic.artifactVersion);
    setErrorBySectionId((current) => {
      const next = { ...current };
      delete next[section.id];
      return next;
    });

    try {
      const result = await apiJson<ArtifactSectionEditResponse>(
        `/api/artifacts/${artifactId}/sections/${section.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            artifact_version: snapshot.artifactVersion,
            section_version: section.version,
            body_md: nextBodyMd,
          }),
        },
      );
      setLocalSections((current) =>
        current.map((candidate) =>
          candidate.id === result.section.id ? result.section : candidate,
        ),
      );
      setLocalArtifactVersion(result.artifact_version);
      onSectionSaved?.(result);
    } catch (err) {
      setLocalSections(edit.rollback.sections);
      setLocalArtifactVersion(edit.rollback.artifactVersion);
      setEditingSectionId(section.id);
      setDraftBodyMd(nextBodyMd);
      setErrorBySectionId((current) => ({
        ...current,
        [section.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setPendingSectionId(null);
    }
  }

  function startMarkWrong(section: ArtifactSection) {
    setMarkingWrongSectionId(section.id);
    setMarkWrongReason('');
    setCorrectionErrorBySectionId((current) => {
      const next = { ...current };
      delete next[section.id];
      return next;
    });
  }

  function cancelMarkWrong() {
    setMarkingWrongSectionId(null);
    setMarkWrongReason('');
  }

  async function submitMarkWrong(section: ArtifactSection) {
    if (!artifactId) return;
    const reason = markWrongReason.trim();
    if (reason.length === 0) {
      setCorrectionErrorBySectionId((current) => ({
        ...current,
        [section.id]: '请填写标错原因',
      }));
      return;
    }
    setPendingCorrectionSectionId(section.id);
    try {
      const result = await apiJson<{ correction_event_id: string }>(
        `/api/artifacts/${artifactId}/correct`,
        {
          method: 'POST',
          body: JSON.stringify({
            correction_kind: 'mark_wrong',
            section_id: section.id,
            reason_md: reason,
          }),
        },
      );
      setCorrectionState((current) => {
        const baseSections = current?.sections ?? {};
        const nextSections: Record<string, ArtifactCorrectionStatus> = {
          ...baseSections,
          [section.id]: {
            state: 'marked_wrong',
            correction_event_id: result.correction_event_id,
            replacement_artifact_id: null,
          },
        };
        return {
          artifact_id: artifactId,
          whole: current?.whole ?? ACTIVE_CORRECTION_STATUS,
          sections: nextSections,
        };
      });
      setMarkingWrongSectionId(null);
      setMarkWrongReason('');
      setCorrectionErrorBySectionId((current) => {
        const next = { ...current };
        delete next[section.id];
        return next;
      });
    } catch (err) {
      setCorrectionErrorBySectionId((current) => ({
        ...current,
        [section.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setPendingCorrectionSectionId(null);
    }
  }

  async function submitRestore(section: ArtifactSection) {
    if (!artifactId) return;
    setPendingCorrectionSectionId(section.id);
    try {
      await apiJson<{ correction_event_id: string }>(`/api/artifacts/${artifactId}/correct`, {
        method: 'POST',
        body: JSON.stringify({
          correction_kind: 'restore',
          section_id: section.id,
          reason_md: '撤销标错',
        }),
      });
      setCorrectionState((current) => {
        const baseSections = current?.sections ?? {};
        const nextSections = { ...baseSections };
        delete nextSections[section.id];
        return {
          artifact_id: artifactId,
          whole: current?.whole ?? ACTIVE_CORRECTION_STATUS,
          sections: nextSections,
        };
      });
      setCorrectionErrorBySectionId((current) => {
        const next = { ...current };
        delete next[section.id];
        return next;
      });
    } catch (err) {
      setCorrectionErrorBySectionId((current) => ({
        ...current,
        [section.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setPendingCorrectionSectionId(null);
    }
  }

  return (
    <div className="artifact-sections">
      {localSections.map((s) => {
        const sectionBodyProps = subjectContentProps(subjectModel, {
          className: 'artifact-section-body',
        });
        const isEditing = editingSectionId === s.id;
        const isPending = pendingSectionId === s.id;
        const status = sectionStatus(s.id);
        const statusLabel = correctionStatusLabel(status);
        const isMarkingWrong = markingWrongSectionId === s.id;
        const isCorrectionPending = pendingCorrectionSectionId === s.id;
        const editSlotStyle = {
          '--artifact-section-min-height': `${getArtifactSectionEditMinHeight(s.body_md)}px`,
        } as CSSProperties;
        return (
          <div key={s.id} className="artifact-section">
            <div className="artifact-section-head">
              <div className="artifact-section-labels">
                <strong>{SECTION_LABEL[s.kind]}</strong>
                <span className="artifact-section-tier">{SOURCE_TIER_LABEL[s.source_tier]}</span>
                {statusLabel && (
                  <Badge tone={correctionStatusTone(status)} dotStatic>
                    {statusLabel}
                  </Badge>
                )}
              </div>
              <div className="artifact-section-head-actions">
                {canCorrect && !isEditing && !isMarkingWrong && status.state === 'active' && (
                  <Button
                    variant="quiet"
                    size="sm"
                    icon="alert"
                    onClick={() => startMarkWrong(s)}
                    disabled={pendingCorrectionSectionId !== null}
                  >
                    标错
                  </Button>
                )}
                {canCorrect && !isEditing && !isMarkingWrong && status.state === 'marked_wrong' && (
                  <Button
                    variant="quiet"
                    size="sm"
                    icon="refresh"
                    onClick={() => submitRestore(s)}
                    disabled={isCorrectionPending}
                  >
                    {isCorrectionPending ? '撤销中...' : '撤销标错'}
                  </Button>
                )}
                {canEdit && !isEditing && !isMarkingWrong && (
                  <Button
                    variant="quiet"
                    size="sm"
                    icon="pen"
                    onClick={() => startEdit(s)}
                    disabled={pendingSectionId !== null}
                  >
                    Edit
                  </Button>
                )}
              </div>
            </div>
            <div className="artifact-section-edit-slot" style={editSlotStyle}>
              {isEditing ? (
                <div className="artifact-section-editor">
                  <textarea
                    className="artifact-section-textarea"
                    value={draftBodyMd}
                    rows={Math.max(5, Math.min(14, draftBodyMd.split('\n').length + 2))}
                    maxLength={50_000}
                    aria-label={`${SECTION_LABEL[s.kind]} section markdown`}
                    onChange={(event) => setDraftBodyMd(event.target.value)}
                  />
                  <div className="artifact-section-edit-actions">
                    <Button variant="ghost" size="sm" icon="x" onClick={cancelEdit}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      icon="check"
                      onClick={() => saveEdit(s)}
                      disabled={isPending || draftBodyMd === s.body_md}
                    >
                      {isPending ? 'Saving...' : 'Save'}
                    </Button>
                  </div>
                </div>
              ) : (
                <NoteRenderer
                  kind="note"
                  notation={
                    (subjectModel.renderConfig.notation ?? undefined) as
                      | 'latex'
                      | 'wenyan'
                      | 'plaintext'
                      | 'code'
                      | undefined
                  }
                  {...sectionBodyProps}
                >
                  {s.body_md}
                </NoteRenderer>
              )}
            </div>
            {isMarkingWrong && (
              <div className="artifact-section-mark-wrong-form">
                <textarea
                  className="artifact-section-textarea"
                  value={markWrongReason}
                  rows={3}
                  maxLength={2000}
                  placeholder="说明这段为什么不对（必填，≤ 2000 字符）"
                  aria-label={`${SECTION_LABEL[s.kind]} mark wrong reason`}
                  onChange={(event) => setMarkWrongReason(event.target.value)}
                />
                <div className="artifact-section-edit-actions">
                  <Button variant="ghost" size="sm" icon="x" onClick={cancelMarkWrong}>
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    icon="alert"
                    onClick={() => submitMarkWrong(s)}
                    disabled={isCorrectionPending || markWrongReason.trim().length === 0}
                  >
                    {isCorrectionPending ? '提交中...' : '提交标错'}
                  </Button>
                </div>
              </div>
            )}
            {errorBySectionId[s.id] && (
              <p className="artifact-section-error">保存失败：{errorBySectionId[s.id]}</p>
            )}
            {correctionErrorBySectionId[s.id] && (
              <p className="artifact-section-error">标错失败：{correctionErrorBySectionId[s.id]}</p>
            )}
            {s.kind === 'check' && (
              <EmbeddedCheckSection
                status={embeddedCheckStatus}
                questions={embeddedQuestions}
                notation={
                  (subjectModel.renderConfig.notation ?? undefined) as
                    | 'latex'
                    | 'wenyan'
                    | 'plaintext'
                    | 'code'
                    | undefined
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
