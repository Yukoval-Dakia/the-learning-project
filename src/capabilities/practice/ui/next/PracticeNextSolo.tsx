// YUK-1473 — the first page in the new design language: one practice question with the
// learning companion beside it. Checkpoint 1 (layout and information hierarchy on real data):
// it reads the same question and issuance as PfSolo (same query keys, so caches are shared)
// and autosaves drafts, so nothing typed is lost. Submission and judging arrive at checkpoint 2.
// Rules: docs/design/2026-10-07-ui-visual-direction.md R1, R3, R4, R7, C1, C2, T1–T5, M1, A1, A2.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ResponseSetT, SlotResponseT } from '@/core/schema/assessment';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { EvidenceComposer } from '@/ui/components/response/EvidenceComposer';
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import {
  type EvidenceAttachment,
  nativeResponseEntry,
  nativeResponseValue,
} from '@/ui/components/response/response-types';
import { SaveStateChip } from '@/ui/components/response/SaveStateChip';
import { useResponseDraftAutosave } from '@/ui/hooks/useResponseDraftAutosave';
import { ApiError } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import {
  BottomSheet,
  Button,
  Chip,
  CompanionPanel,
  type SheetSnap,
  UiNextRoot,
} from '@/ui-next/public';
import { toAttemptTimelineEvents } from '../attempt-timeline-adapter';
import { practiceSourceLabel } from '../PfStream';
import {
  type StreamItem,
  getIssuanceState,
  getQuestionFull,
  issueAssessment,
  saveResponseDraft,
} from '../practice-api';
import './practice-next.css';

export interface PracticeNextSoloProps {
  item: StreamItem;
  pos: number;
  total: number;
  onBack: () => void;
}

const OUTCOME_TEXT = {
  success: { label: '做对了', tone: 'positive' },
  failure: { label: '没做对', tone: 'caution' },
  partial: { label: '部分对', tone: 'caution' },
  pending: { label: '判分中', tone: 'neutral' },
  unsupported: { label: '没法自动判', tone: 'neutral' },
} as const;

function formatDay(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function PracticeNextSolo({ item, pos, total, onBack }: PracticeNextSoloProps) {
  const qQ = useQuery({
    queryKey: ['question-detail', item.ref_id],
    queryFn: () => getQuestionFull(item.ref_id, { surface: 'practice' }),
  });
  const q = qQ.data ?? null;
  const issuanceId = `iss_stream_${item.id}`;
  const frozenQ = useQuery({
    queryKey: ['practice-issuance', issuanceId, 'auto_score'],
    enabled: q !== null,
    retry: false,
    refetchOnMount: 'always',
    queryFn: async () => {
      try {
        return await getIssuanceState(issuanceId);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }
      if (!q) throw new Error('question unavailable');
      await issueAssessment({
        issuance_id: issuanceId,
        group_id: q.parent_question_id ?? q.id,
        ...(q.parent_question_id ? { part_ids: [q.id] } : {}),
        mode: 'auto_score',
      });
      return getIssuanceState(issuanceId);
    },
  });
  const frozen = frozenQ.data?.practice_dto;
  const accepted = frozenQ.data?.submissions[0];

  // Draft state: restore once per issuance, then keep local edits (same rule as PfSolo).
  const [responses, setResponses] = useState<ResponseSetT>({ entries: [] });
  const [evidence, setEvidence] = useState<EvidenceAttachment[]>([]);
  const [restoredId, setRestoredId] = useState<string | null>(null);
  const draftEpoch = useRef<number | undefined>(undefined);
  useEffect(() => {
    const data = frozenQ.data;
    if (!frozenQ.isFetchedAfterMount || frozenQ.isError || !data?.issuance) return;
    if (restoredId === data.issuance.issuance_id) return;
    const restored = data.submissions[0] ?? data.draft;
    setResponses(restored?.response_set ?? { entries: [] });
    setEvidence(
      (restored?.group_evidence ?? []).map((g) => ({
        asset_id: g.evidence.asset.asset_id,
        original: g.evidence,
        originalTarget: g.target,
        slot_ids: null,
      })),
    );
    draftEpoch.current = data.draft?.save_epoch;
    setRestoredId(data.issuance.issuance_id);
  }, [frozenQ.data, frozenQ.isFetchedAfterMount, frozenQ.isError, restoredId]);
  const groupEvidence = useMemo(
    () =>
      evidence.flatMap((a) =>
        a.original
          ? [{ evidence: a.original, target: a.originalTarget ?? { scope: 'all_units' as const } }]
          : [],
      ),
    [evidence],
  );
  const draftValue = useMemo(
    () => ({ response_set: responses, group_evidence: groupEvidence }),
    [responses, groupEvidence],
  );
  const autosave = useResponseDraftAutosave({
    value: draftValue,
    enabled: restoredId === issuanceId && !!frozen && !accepted,
    save: async (value) => {
      const ack = await saveResponseDraft(issuanceId, {
        ...value,
        evaluation_group_ref: accepted?.evaluation_group_id ?? `group_stream_${item.id}`,
        expected_save_epoch: draftEpoch.current,
      });
      draftEpoch.current = ack.save_epoch;
    },
  });
  const setEntry = (entry: SlotResponseT) =>
    setResponses((prev) => ({
      entries: [...prev.entries.filter((e) => e.slot_id !== entry.slot_id), entry],
    }));

  const [sheet, setSheet] = useState<SheetSnap>('peek');
  // Transitional: inside the retained shell its fixed phone tab bar would cover the sheet, so the
  // sheet peeks above whatever bottom bar the shell draws (YUK-1473 checkpoint 1, owner decision).
  const [shellInset, setShellInset] = useState(0);
  useLayoutEffect(() => {
    const bar = document.querySelector<HTMLElement>('.mobile-tabbar');
    if (!bar) return;
    const measure = () =>
      setShellInset(getComputedStyle(bar).display === 'none' ? 0 : bar.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);
  const timeline = q ? toAttemptTimelineEvents(q.timeline) : [];
  const lastAttempt = [...timeline].reverse().find((e) => e.kind === 'attempt');
  const title = item.knowledge_name ?? q?.labels[0]?.name ?? '这道题';
  const notation = q?.notation ?? null;
  const figures = frozen?.materials ?? [];
  const lone = figures.length === 1 && figures[0].content_md === undefined;

  const companionHeader = (
    <div className="un-pn-companion-head">
      <span className="un-pn-companion-name">学习伙伴</span>
      <span className="un-pn-companion-state">在这里</span>
    </div>
  );
  const companionBody = (
    <div className="un-pn-companion-body">
      <p className="un-pn-companion-empty">
        这道题还没有和学习伙伴的对话。对话会在下一版接入；现在问的话，它还看不到这道题的内容。
      </p>
      <div className="un-pn-composer" aria-disabled="true">
        <textarea rows={2} disabled placeholder="问点什么（下一版接入）" aria-label="问学习伙伴" />
      </div>
    </div>
  );

  return (
    <UiNextRoot className="un-pn-root">
      <div className="un-pn">
        <div className="un-pn-main">
          <div className="un-pn-column">
            <header className="un-pn-banner">
              <Button variant="quiet" size="sm" onClick={onBack}>
                ← 返回练习
              </Button>
              <p className="un-pn-eyebrow">
                {practiceSourceLabel(item.source)} · 第 {pos} / {total} 题
                {item.estimated_minutes ? ` · 约 ${item.estimated_minutes} 分钟` : ''}
              </p>
              <h1 className="un-pn-title">{title}</h1>
              <div className="un-pn-chips">
                {q?.labels
                  .filter((l) => l.name !== title)
                  .map((l) => (
                    <Chip key={l.id}>{l.name}</Chip>
                  ))}
                {accepted ? (
                  <Chip tone="accent">已提交</Chip>
                ) : lastAttempt ? (
                  <Chip tone={OUTCOME_TEXT[lastAttempt.outcome].tone}>
                    上次 · {OUTCOME_TEXT[lastAttempt.outcome].label}
                  </Chip>
                ) : (
                  <Chip>第一次做</Chip>
                )}
              </div>
            </header>

            {qQ.isError ? (
              <p className="un-pn-state" role="alert">
                这道题没取到。可以返回练习，过一会儿再试。
              </p>
            ) : !q || frozenQ.isLoading ? (
              <div className="un-pn-skeleton" role="status" aria-busy="true" aria-label="正在取题">
                <span />
                <span />
                <span />
              </div>
            ) : frozenQ.isError || !frozen ? (
              <p className="un-pn-state" role="alert">
                这道题暂时没法在这里作答。可以返回练习，用旧页面继续。
              </p>
            ) : (
              <>
                <section className="un-pn-section" aria-labelledby="un-pn-question">
                  <h2 id="un-pn-question" className="un-pn-h2">
                    题目
                  </h2>
                  <div className={lone ? 'un-pn-stem un-pn-stem-with-figure' : 'un-pn-stem'}>
                    <div className="un-pn-faces">
                      {frozen.faces.map((face) => (
                        <div key={face.part_id} className="un-pn-face">
                          {face.question_no && (
                            <span className="un-pn-face-no">{face.question_no}</span>
                          )}
                          <MathMarkdown notation={notation} className="un-pn-prose">
                            {face.prompt_md}
                          </MathMarkdown>
                        </div>
                      ))}
                    </div>
                    {figures.length > 0 && (
                      <div className="un-pn-figures">
                        {figures.map((m) => (
                          <figure key={m.material_id} className="un-pn-figure">
                            {m.content_md !== undefined ? (
                              <MathMarkdown notation={notation} className="un-pn-prose">
                                {m.content_md}
                              </MathMarkdown>
                            ) : (
                              <AssetEvidencePreview
                                assetId={m.asset_id}
                                label={m.caption ?? m.alt_text}
                              />
                            )}
                            {m.caption && <figcaption>{m.caption}</figcaption>}
                          </figure>
                        ))}
                      </div>
                    )}
                  </div>
                </section>

                <section className="un-pn-section" aria-labelledby="un-pn-answer">
                  <div className="un-pn-section-head">
                    <h2 id="un-pn-answer" className="un-pn-h2">
                      我的作答
                    </h2>
                    <SaveStateChip state={autosave.state} onRetry={autosave.retry} />
                  </div>
                  <div className="un-pn-answer">
                    {frozen.response_spec.slots.map((slot) => {
                      const spec = nativeSlotFieldSpec(slot);
                      if (!spec) return null;
                      const entry = responses.entries.find((e) => e.slot_id === slot.slot_id);
                      return (
                        <ResponseSlotField
                          key={slot.slot_id}
                          spec={spec}
                          value={nativeResponseValue(entry)}
                          label={slot.placement?.label}
                          notation={notation}
                          disabled={!!accepted}
                          onChange={(value) => setEntry(nativeResponseEntry(slot, value, entry))}
                          feedback="none"
                          ariaLabel={slot.placement?.label ?? '作答'}
                        />
                      );
                    })}
                    <EvidenceComposer
                      text=""
                      onTextChange={() => {}}
                      showText={false}
                      attachments={evidence}
                      onAttachmentsChange={setEvidence}
                      disabled={!!accepted}
                    />
                  </div>
                  <p className="un-pn-note">提交与判分在下一版接入；现在写下的内容会自动保存。</p>
                </section>

                {timeline.length > 0 && (
                  <section className="un-pn-section" aria-labelledby="un-pn-history">
                    <h2 id="un-pn-history" className="un-pn-h2">
                      作答记录
                    </h2>
                    <ol className="un-pn-history">
                      {[...timeline].reverse().map((e) => (
                        <li key={e.event_id}>
                          <span className="un-pn-history-day">{formatDay(e.created_at_sec)}</span>
                          {e.kind === 'attempt' ? (
                            <>
                              <Chip tone={OUTCOME_TEXT[e.outcome].tone}>
                                {OUTCOME_TEXT[e.outcome].label}
                              </Chip>
                              {e.cause && (
                                <span className="un-pn-history-cause">
                                  {e.cause.primary_label ?? e.cause.primary}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="un-pn-history-cause">复习 · 按间隔安排</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
        <CompanionPanel open label="学习伙伴" header={companionHeader}>
          {companionBody}
        </CompanionPanel>
      </div>
      <div className="un-pn-phone-sheet">
        <BottomSheet
          label="学习伙伴"
          snap={sheet}
          onSnapChange={setSheet}
          bottomInset={shellInset}
          header={companionHeader}
        >
          {companionBody}
        </BottomSheet>
      </div>
    </UiNextRoot>
  );
}
