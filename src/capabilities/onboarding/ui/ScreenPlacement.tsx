// Placement waits for native evaluation and settlement before the next adaptive selection.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeLatencyMs } from '@/capabilities/practice/ui-public';
import type { GroupEvidenceT, ResponseSetT, SlotResponseT } from '@/core/schema/assessment';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { EvidenceComposer } from '@/ui/components/response/EvidenceComposer';
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import {
  type EvidenceAttachment,
  isSlotResponseAnswered,
  nativeResponseEntry,
  nativeResponseText,
  nativeResponseValue,
} from '@/ui/components/response/response-types';
import { SaveStateChip } from '@/ui/components/response/SaveStateChip';
import { useJudgeRunPolling } from '@/ui/hooks/useJudgeRunPolling';
import { usePagehideTransition } from '@/ui/hooks/usePagehideTransition';
import { useResponseDraftAutosave } from '@/ui/hooks/useResponseDraftAutosave';
import { ApiError } from '@/ui/lib/api';
import { uploadAsset } from '@/ui/lib/assets';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { ErrorState } from '@/ui/primitives/ErrorState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { ObSteps } from './ObSteps';
import type {
  PlacementQuestionRef,
  PlacementSelfReport,
  PlacementStartResult,
} from './placement-api';
import { type PlacementClient, usePlacementClient } from './placement-client';
import './onboarding.css';

const CAP = 8;
const VALID_PACES = ['light', 'medium', 'dense'] as const;
function readSelfReport(search: string): PlacementSelfReport {
  const sp = new URLSearchParams(search);
  return {
    leanings: sp.get('leanings')?.split(',').filter(Boolean) ?? [],
    pace: VALID_PACES.find((p) => p === sp.get('pace')),
  };
}
type Phase = 'loading' | 'answer' | 'sourcing' | 'settling' | 'terminal' | 'nogoal' | 'error';
type ExitSave = () => Promise<void>;
export interface ScreenPlacementProps {
  navigate: (to: string) => void;
}

export default function ScreenPlacement({ navigate }: ScreenPlacementProps) {
  const client = usePlacementClient();
  const [phase, setPhase] = useState<Phase>('loading');
  const [qRef, setQRef] = useState<PlacementQuestionRef | null>(null);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [restoreVersion, setRestoreVersion] = useState(0);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [exitFailure, setExitFailure] = useState<{ destination: string; message: string } | null>(
    null,
  );
  // Fixed for the screen's lifetime: re-running the start effect would open a second session.
  const transport = useRef(client);
  const goalIdRef = useRef(new URLSearchParams(window.location.search).get('goal'));
  const sessionIdRef = useRef<string | null>(null);
  const sessionOpenRef = useRef(false);
  const saveForExit = useRef<ExitSave | null>(null);
  const initialRequest = useRef<Promise<PlacementStartResult | 'terminal'> | null>(null);

  const profileDest = useCallback(
    () => (goalIdRef.current ? `/profile?goal=${encodeURIComponent(goalIdRef.current)}` : '/today'),
    [],
  );
  const transition = useCallback(async (status: 'completed' | 'abandoned') => {
    const sid = sessionIdRef.current;
    if (!sid || !sessionOpenRef.current) return;
    await transport.current.placementEnd(sid, status, { keepalive: false });
    sessionOpenRef.current = false;
  }, []);
  const loadNext = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || !sessionOpenRef.current) return;
    const next = await transport.current.placementNext(sid);
    setAnsweredCount(next.answeredCount);
    setRestoreVersion((v) => v + 1);
    if (next.done) {
      setQRef(null);
      setPhase('settling');
    } else {
      setQRef(next.question);
      setPhase(next.question ? 'answer' : 'sourcing');
    }
  }, []);

  useEffect(() => {
    const goal = goalIdRef.current;
    if (!goal) {
      setPhase('nogoal');
      return;
    }
    let cancelled = false;
    initialRequest.current ??= (async () => {
      const existing = new URLSearchParams(window.location.search).get('session');
      if (existing) {
        const session = await transport.current.getPlacementSession(existing);
        if (session.goal_id !== goal) throw new Error('定位练习与当前目标不一致。');
        sessionIdRef.current = existing;
        if (session.status !== 'started') return 'terminal';
        sessionOpenRef.current = true;
        const next = await transport.current.placementNext(existing);
        if (next.done)
          return {
            sessionId: existing,
            knowledgeIds: session.scope_knowledge_ids ?? [],
            answeredCount: next.answeredCount,
            question: null,
            sourcingNeeded: false,
          };
        return { sessionId: existing, knowledgeIds: session.scope_knowledge_ids ?? [], ...next };
      }
      return transport.current.startPlacement(goal, readSelfReport(window.location.search));
    })();
    void initialRequest.current
      .then((res) => {
        if (cancelled) return;
        if (res === 'terminal') {
          setPhase('terminal');
          return;
        }
        sessionIdRef.current = res.sessionId;
        sessionOpenRef.current = true;
        const url = new URL(window.location.href);
        url.searchParams.set('session', res.sessionId);
        window.history.replaceState(
          window.history.state,
          '',
          `${url.pathname}${url.search}${url.hash}`,
        );
        setAnsweredCount(res.answeredCount);
        setQRef(res.question);
        setPhase(res.question ? 'answer' : res.sourcingNeeded ? 'sourcing' : 'settling');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrMsg(error instanceof Error ? error.message : String(error));
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'settling') return;
    let cancelled = false;
    void transition('completed')
      .then(() => {
        if (!cancelled) navigate(profileDest());
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrMsg(error instanceof Error ? error.message : String(error));
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [phase, navigate, profileDest, transition]);

  const leaveProbe = async (destination: string, discard = false) => {
    if (leaving) return;
    setLeaving(true);
    setExitFailure(null);
    try {
      if (!discard) await saveForExit.current?.();
      await transition('abandoned');
      navigate(destination);
    } catch (error) {
      setExitFailure({
        destination,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLeaving(false);
    }
  };
  const exitProbe = () => {
    void leaveProbe('/today');
  };
  const shellExit =
    phase === 'terminal' || phase === 'nogoal' ? () => navigate('/today') : exitProbe;

  return (
    <PlacementShell answeredCount={answeredCount} done={phase === 'settling'} onExit={shellExit}>
      {exitFailure && (
        <LoomCard pad>
          <ErrorState text={`退出前未能确认保存或结束：${exitFailure.message}`} />
          <Btn variant="secondary" onClick={() => void leaveProbe(exitFailure.destination)}>
            重试保存并退出
          </Btn>
          <Btn variant="ghost" onClick={() => void leaveProbe(exitFailure.destination, true)}>
            放弃未保存修改并退出
          </Btn>
        </LoomCard>
      )}
      {phase === 'loading' && (
        <LoomCard pad padLg>
          <SkLines rows={3} />
        </LoomCard>
      )}
      {phase === 'nogoal' && (
        <LoomCard pad padLg>
          <EmptyState
            icon="target"
            title="还没设定目标"
            text="定位练习需要先有一个学习目标来圈定范围。"
            action={
              <Btn variant="primary" onClick={() => navigate('/welcome')}>
                去设定
              </Btn>
            }
          />
        </LoomCard>
      )}
      {phase === 'error' && (
        <LoomCard pad padLg>
          <ErrorState
            text={errMsg ?? '定位练习无法恢复。'}
            onRetry={() => window.location.reload()}
          />
        </LoomCard>
      )}
      {phase === 'terminal' && (
        <LoomCard pad padLg>
          <EmptyState
            icon="check"
            title="这次定位练习已结束"
            text="这次定位练习不会自动重新开始。"
            action={
              <Btn variant="primary" onClick={() => navigate(profileDest())}>
                看档案
              </Btn>
            }
          />
        </LoomCard>
      )}
      {phase === 'sourcing' && (
        <LoomCard pad padLg>
          <EmptyState
            icon="clock"
            title="备题中 · 子图还冷"
            text="这个目标还没有可定位的题。可以上传材料，或稍后回来继续。"
            action={
              <Btn
                variant="primary"
                icon="record"
                onClick={() => void leaveProbe('/onboarding/upload')}
              >
                改为上传材料
              </Btn>
            }
          />
          <Btn
            variant="secondary"
            onClick={() =>
              void loadNext().catch((e: unknown) =>
                setErrMsg(e instanceof Error ? e.message : String(e)),
              )
            }
          >
            重新查询题目
          </Btn>
          {errMsg && <ErrorState text={errMsg} />}
        </LoomCard>
      )}
      {phase === 'settling' && (
        <LoomCard pad padLg>
          <div className="ob-settle">
            <div className="ob-settle-ring" />
            <div className="ob-settle-t serif">正在收紧你的画像…</div>
          </div>
        </LoomCard>
      )}
      {phase === 'answer' && qRef && (
        <>
          <PlacementQuestionCard
            key={`${qRef.assessment.issuance_id}:${restoreVersion}`}
            sessionId={sessionIdRef.current ?? ''}
            qRef={qRef}
            answeredCount={answeredCount}
            onAccepted={loadNext}
            saveForExit={saveForExit}
            leaving={leaving}
            client={transport.current}
          />
          <div className="ob-pl-reassure">
            <LoomIcon name="clock" size={14} />
            最多 {CAP} 题。答完才统一给反馈，先别急着看对错。
          </div>
        </>
      )}
    </PlacementShell>
  );
}

function PlacementShell({
  answeredCount,
  done,
  onExit,
  children,
}: {
  answeredCount: number;
  done?: boolean;
  onExit: () => void;
  children: React.ReactNode;
}) {
  const shown = Math.min(done ? answeredCount : answeredCount + 1, CAP);
  return (
    <div className="page ob-pl">
      <div className="page-head">
        <div className="eyebrow">PLACEMENT · θ̂ · FSRS live</div>
        <ObSteps active="placement" />
        <div className="page-head-row">
          <h1 className="page-title serif">定位练习</h1>
          <Btn variant="ghost" icon="close" onClick={onExit}>
            退出
          </Btn>
        </div>
      </div>
      <div className="ob-pl-bar">
        <div className="ob-pl-prog">
          <div className="ob-pl-prog-h">
            <span className="ob-pl-prog-k">
              第 <b>{shown}</b> / 最多 {CAP} 题
            </span>
            <span className="ob-pl-prog-cap">{done ? '已答完' : '答到 cap 或收敛即止'}</span>
          </div>
          <div className="ob-pl-track">
            {Array.from({ length: CAP }).map((_, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length cap track, index is the stable identity
                key={i}
                className={`ob-pl-seg${
                  i < answeredCount ? ' is-done' : !done && i === answeredCount ? ' is-cur' : ''
                }`}
              />
            ))}
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

function PlacementQuestionCard({
  sessionId,
  qRef,
  answeredCount,
  onAccepted,
  saveForExit,
  leaving,
  client,
}: {
  sessionId: string;
  qRef: PlacementQuestionRef;
  answeredCount: number;
  onAccepted: () => Promise<void>;
  saveForExit: React.MutableRefObject<ExitSave | null>;
  leaving: boolean;
  client: PlacementClient;
}) {
  const binding = qRef.assessment;
  const frozen = binding.state.practice_dto;
  const accepted = binding.state.submissions[0];
  const restored = binding.state.draft ?? accepted;
  const [responses, setResponses] = useState<ResponseSetT>(
    restored?.response_set ?? { entries: [] },
  );
  const [evidence, setEvidence] = useState<EvidenceAttachment[]>(() =>
    (restored?.group_evidence ?? []).map((item) => ({
      asset_id: item.evidence.asset.asset_id,
      original: item.evidence,
      originalTarget: item.target,
      kind: item.evidence.kind === 'plaintext' ? 'text' : item.evidence.kind,
      slot_ids: null,
    })),
  );
  const [status, setStatus] = useState<
    'answering' | 'retry' | 'pending' | 'held' | 'waiting' | 'uncertain'
  >(binding.phase);
  const [pendingRun, setPendingRun] = useState(binding.pending_run);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(binding.state.draft?.save_epoch ?? 0);
  const shownAt = useRef(Date.now());
  const nativeEvidence = useMemo<GroupEvidenceT[]>(
    () =>
      evidence.flatMap((item) =>
        item.original
          ? [{ evidence: item.original, target: item.originalTarget ?? { scope: 'all_units' } }]
          : [],
      ),
    [evidence],
  );
  const draftValue = useMemo(
    () => ({ response_set: responses, group_evidence: nativeEvidence }),
    [responses, nativeEvidence],
  );
  const currentValue = useRef(draftValue);
  currentValue.current = draftValue;
  const savedBytes = useRef(JSON.stringify(draftValue));
  const inFlight = useRef<Promise<void> | null>(null);
  const persist = useCallback(
    async (value: typeof draftValue, keepalive: boolean) => {
      while (inFlight.current) await inFlight.current;
      if (JSON.stringify(value) === savedBytes.current) return;
      const saving = (async () => {
        try {
          const ack = await client.saveResponseDraft(
            binding.issuance_id,
            {
              ...value,
              evaluation_group_ref: binding.evaluation_group_id,
              expected_save_epoch: epoch.current,
            },
            { keepalive },
          );
          epoch.current = ack.save_epoch;
          savedBytes.current = JSON.stringify(value);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) setConflict(true);
          throw e;
        }
      })();
      inFlight.current = saving;
      try {
        await saving;
      } finally {
        if (inFlight.current === saving) inFlight.current = null;
      }
    },
    [binding.issuance_id, binding.evaluation_group_id, client],
  );
  const autosave = useResponseDraftAutosave({
    value: draftValue,
    enabled: !!frozen && status === 'answering' && !submitting && !leaving && !conflict,
    save: (value, ctx) => persist(value, ctx.keepalive),
  });
  usePagehideTransition(() => autosave.flush({ keepalive: true }));
  useEffect(() => {
    const save: ExitSave = async () => {
      if (uploading) throw new Error('附件仍在上传，请等待上传完成。');
      if (conflict) throw new Error('草稿版本冲突，请先重新加载服务端草稿或明确放弃修改。');
      if (status === 'answering') await persist(currentValue.current, false);
    };
    saveForExit.current = save;
    return () => {
      if (saveForExit.current === save) saveForExit.current = null;
    };
  }, [uploading, conflict, status, persist, saveForExit]);
  const poll = useJudgeRunPolling({
    runId: pendingRun?.run_id ?? null,
    pollUrl: pendingRun?.poll_url,
    readStatus: client.readJudgeRunStatus,
    enabled: status === 'pending',
  });
  useEffect(() => {
    if (!pendingRun || !poll.settled) return;
    if (poll.status === 'done') {
      setStatus('waiting');
      void onAccepted().catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('uncertain');
      });
    } else {
      setStatus('held');
      setError('作答已接收，暂时无法完成定位评估。请重新查询状态。');
    }
  }, [pendingRun, poll.settled, poll.status, onAccepted]);
  const updateResponse = (entry: SlotResponseT) =>
    setResponses((previous) => ({
      entries: [...previous.entries.filter((e) => e.slot_id !== entry.slot_id), entry],
    }));
  const unavailable =
    !frozen || frozen.response_spec.slots.some((slot) => !nativeSlotFieldSpec(slot));
  const answered =
    !!frozen &&
    frozen.response_spec.slots
      .filter((slot) => slot.kind !== 'table')
      .every((slot) => {
        const entry = responses.entries.find((entry) => entry.slot_id === slot.slot_id);
        if (isSlotResponseAnswered(nativeResponseValue(entry))) return true;
        const units = frozen.response_requirements?.find(
          (requirement) => requirement.slot_id === slot.slot_id,
        )?.evidence_unit_ids;
        return (
          !!units?.length &&
          units.every((unitId) =>
            nativeEvidence.some(
              (item) =>
                item.target.scope === 'all_units' || item.target.scoring_unit_ids.includes(unitId),
            ),
          )
        );
      });
  const canSubmit =
    !unavailable &&
    answered &&
    !uploading &&
    !submitting &&
    !leaving &&
    !conflict &&
    evidence.every((item) => item.original !== undefined);
  const commit = async () => {
    if (submitting || (status !== 'retry' && !canSubmit)) return;
    setSubmitting(true);
    setError(null);
    let dispatched = false;
    try {
      // Stop queued autosaves; an ordinary save ACK precedes finalization.
      if (!accepted) await persist(currentValue.current, false);
      const responseSet = accepted?.response_set ?? responses;
      const groupEvidence = accepted?.group_evidence ?? nativeEvidence;
      dispatched = true;
      const result = await client.submitProbeAnswer({
        sessionId,
        questionId: qRef.questionId,
        assessment: {
          issuance_id: binding.issuance_id,
          evaluation_group_id: accepted?.evaluation_group_id ?? binding.evaluation_group_id,
          submission_id: accepted?.submission_id ?? binding.submission_id,
          idempotency_key: accepted?.idempotency_key ?? binding.idempotency_key,
          response_set: responseSet,
          group_evidence: groupEvidence,
        },
        responseMd: responseSet.entries
          .map((entry) =>
            nativeResponseText(
              entry,
              frozen?.response_spec.slots.find((slot) => slot.slot_id === entry.slot_id),
            ),
          )
          .join('\n'),
        referencedKnowledgeIds: [],
        answerImageRefs: groupEvidence
          .filter((item) => item.evidence.kind === 'image')
          .map((item) => item.evidence.asset.asset_id),
        latencyMs: accepted ? null : computeLatencyMs(shownAt.current, Date.now()),
      });
      if ('run_id' in result) {
        setPendingRun({ run_id: result.run_id, poll_url: result.backfill.poll_url });
        setStatus('pending');
      } else {
        setStatus('waiting');
        await onAccepted();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(dispatched ? 'uncertain' : 'answering');
    } finally {
      setSubmitting(false);
    }
  };
  const recover = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onAccepted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <LoomCard pad padLg className="fade-key">
      <div className="ob-pl-meta">
        <span className="meta mono">{qRef.questionId.slice(0, 12)}</span>
      </div>
      {frozen?.materials.map((material) => (
        <div key={material.material_id}>
          {material.content_md !== undefined ? (
            <MathMarkdown>{material.content_md}</MathMarkdown>
          ) : (
            <AssetEvidencePreview
              assetId={material.asset_id}
              label={material.caption ?? material.alt_text}
            />
          )}
        </div>
      ))}
      {frozen?.faces.map((face) => (
        <MathMarkdown key={face.part_id} className="ob-pl-stem">
          {face.prompt_md}
        </MathMarkdown>
      ))}
      {unavailable ? (
        <ErrorState text="这道题需要当前页面尚不支持的作答控件。可以退出并保留这次定位练习的记录。" />
      ) : (
        <>
          <SaveStateChip
            state={conflict ? 'conflict' : autosave.state}
            generation={autosave.generation}
            onRetry={autosave.retry}
          />
          {conflict && (
            <Btn variant="secondary" onClick={() => void recover()}>
              重新加载服务端草稿 · 放弃本地修改
            </Btn>
          )}
          {frozen.response_spec.slots.map((slot) => {
            const spec = nativeSlotFieldSpec(slot);
            if (!spec) return null;
            const entry = responses.entries.find((item) => item.slot_id === slot.slot_id);
            return (
              <ResponseSlotField
                key={slot.slot_id}
                spec={spec}
                label={slot.placement?.label}
                ariaLabel={slot.placement?.label ?? '作答'}
                value={nativeResponseValue(entry)}
                onChange={(value) => updateResponse(nativeResponseEntry(slot, value, entry))}
                disabled={status !== 'answering' || submitting || leaving || conflict}
                feedback="none"
              />
            );
          })}
          <EvidenceComposer
            text=""
            onTextChange={() => {}}
            showText={false}
            attachments={evidence}
            onAttachmentsChange={setEvidence}
            disabled={status !== 'answering' || submitting || leaving || conflict}
            upload={uploadAsset}
            uploadErrorMessage="图片上传失败，请重试"
            onUploadingChange={setUploading}
          />
        </>
      )}
      {error && <ErrorState text={error} />}
      <div className="ob-pl-foot">
        {status === 'answering' && (
          <Btn
            variant="primary"
            iconEnd="arrow"
            disabled={!canSubmit}
            onClick={() => void commit()}
          >
            {submitting ? '记录中…' : answeredCount + 1 >= CAP ? '完成定位 · 看档案' : '下一题'}
          </Btn>
        )}
        {status === 'retry' && (
          <Btn variant="primary" disabled={submitting || leaving} onClick={() => void commit()}>
            继续处理已接收作答
          </Btn>
        )}
        {(status === 'pending' || status === 'waiting') && (
          <span role="status">作答已接收 · 等待定位结果</span>
        )}
        {(status === 'held' || status === 'uncertain') && (
          <>
            <span role="status">等待确认作答状态</span>
            <Btn variant="secondary" disabled={submitting} onClick={() => void recover()}>
              重新查询状态
            </Btn>
          </>
        )}
      </div>
    </LoomCard>
  );
}
