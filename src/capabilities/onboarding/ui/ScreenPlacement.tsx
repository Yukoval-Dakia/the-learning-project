// Placement waits for native evaluation and settlement before the next adaptive selection.
import { useCallback, useMemo, useRef, useState } from 'react';
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
import { type JudgeRunPollingState, useJudgeRunPolling } from '@/ui/hooks/useJudgeRunPolling';
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
import { type StarterOutcome, starterStatus } from './starter-supply-status';
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
// What the current question card lends the exit button: save its draft, and pause or
// resume its autosave while leaving (the old `!leaving` gate).
interface ExitSave {
  save: () => Promise<void>;
  hold: () => void;
  resume: () => void;
}
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
  const [supply, setSupply] = useState<StarterOutcome[] | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [exitFailure, setExitFailure] = useState<{ destination: string; message: string } | null>(
    null,
  );
  // Fixed for the screen's lifetime: re-running the start would open a second session.
  const transport = useRef(client);
  // Read from the URL when the screen attaches (not during render, which may run on a server).
  const goalIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionOpenRef = useRef(false);
  const saveForExit = useRef<ExitSave | null>(null);
  // One start/resume request per screen instance, reused across StrictMode re-attach;
  // `applied` makes sure its result is applied (URL, phase, settle) exactly once.
  const initialRequest = useRef<{
    promise: Promise<PlacementStartResult | 'terminal'>;
    applied: boolean;
  } | null>(null);
  // True while the screen's root is attached: late completions after leaving do nothing.
  const activeRef = useRef(false);
  const finishing = useRef(false);

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
  // The last answer is in (or the session needs no more): end the session once and go
  // to the profile. Called from the events that reveal "done" — never from render.
  const finish = useCallback(() => {
    setQRef(null);
    setPhase('settling');
    if (finishing.current) return;
    finishing.current = true;
    void transition('completed')
      .then(() => {
        if (activeRef.current) navigate(profileDest());
      })
      .catch((error: unknown) => {
        finishing.current = false;
        if (!activeRef.current) return;
        setErrMsg(error instanceof Error ? error.message : String(error));
        setPhase('error');
      });
  }, [navigate, profileDest, transition]);
  const loadNext = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || !sessionOpenRef.current) return;
    const next = await transport.current.placementNext(sid);
    setAnsweredCount(next.answeredCount);
    setSupply(next.starterSupply);
    setRestoreVersion((v) => v + 1);
    if (next.done) {
      finish();
    } else {
      setQRef(next.question);
      setPhase(next.question ? 'answer' : 'sourcing');
    }
  }, [finish]);

  // YUK-1483 — the screen's root owns entering placement: when it attaches it resumes the
  // session named in the URL or starts one, once per screen (the request is reused if
  // React re-attaches the same screen). Detaching only stops applying late results; it
  // never ends a session the server already created.
  const attachScreen = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return undefined;
      activeRef.current = true;
      goalIdRef.current ??= new URLSearchParams(window.location.search).get('goal');
      const goal = goalIdRef.current;
      if (!goal) {
        // Re-attach (a new `finish` after the shell re-renders) leaves the phase as is.
        setPhase((current) => (current === 'nogoal' ? current : 'nogoal'));
        return () => {
          activeRef.current = false;
        };
      }
      let cancelled = false;
      initialRequest.current ??= {
        applied: false,
        promise: (async () => {
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
            return {
              sessionId: existing,
              knowledgeIds: session.scope_knowledge_ids ?? [],
              ...next,
            };
          }
          return transport.current.startPlacement(goal, readSelfReport(window.location.search));
        })(),
      };
      const request = initialRequest.current;
      void request.promise
        .then((res) => {
          if (cancelled || request.applied) return;
          request.applied = true;
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
          setSupply(res.starterSupply);
          if (res.question) {
            setQRef(res.question);
            setPhase('answer');
          } else if (res.sourcingNeeded) {
            setQRef(null);
            setPhase('sourcing');
          } else {
            finish();
          }
        })
        .catch((error: unknown) => {
          if (cancelled || request.applied) return;
          request.applied = true;
          setErrMsg(error instanceof Error ? error.message : String(error));
          setPhase('error');
        });
      return () => {
        cancelled = true;
        activeRef.current = false;
      };
    },
    [finish],
  );

  const leaveProbe = async (destination: string, discard = false) => {
    if (leaving) return;
    setLeaving(true);
    setExitFailure(null);
    // No autosave while leaving — in particular not the edits being discarded.
    const card = saveForExit.current;
    card?.hold();
    try {
      if (!discard) await card?.save();
      await transition('abandoned');
      navigate(destination);
    } catch (error) {
      // Still on the page: the card may autosave again (unless it is in conflict).
      card?.resume();
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
    <PlacementShell
      answeredCount={answeredCount}
      done={phase === 'settling'}
      onExit={shellExit}
      rootRef={attachScreen}
    >
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
          <SupplyStatus
            outcomes={supply}
            checking={checking}
            onRecheck={() => {
              setChecking(true);
              void loadNext()
                .catch((e: unknown) => setErrMsg(e instanceof Error ? e.message : String(e)))
                .finally(() => setChecking(false));
            }}
            onUpload={() => void leaveProbe('/onboarding/upload')}
            onSetGoal={() => void leaveProbe('/welcome')}
          />
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

// No question to show yet: say what the question supply is actually doing (design H5).
function SupplyStatus({
  outcomes,
  checking,
  onRecheck,
  onUpload,
  onSetGoal,
}: {
  outcomes: StarterOutcome[] | undefined;
  checking: boolean;
  onRecheck: () => void;
  onUpload: () => void;
  onSetGoal: () => void;
}) {
  const status = starterStatus(outcomes);
  const upload = (variant: 'primary' | 'secondary') => (
    <Btn variant={variant} icon="record" onClick={onUpload}>
      上传自己的材料
    </Btn>
  );
  const recheck = (variant: 'primary' | 'secondary', label = '再查一次') => (
    <Btn variant={variant} icon="refresh" disabled={checking} onClick={onRecheck}>
      {checking ? '正在查…' : label}
    </Btn>
  );
  return (
    <div role="status" aria-live="polite">
      {supplyBody()}
    </div>
  );
  function supplyBody() {
    switch (status.kind) {
      case 'need_goal':
        return (
          <EmptyState
            icon="target"
            title="还缺学习目标"
            text="先说清这次要学什么，才能为你准备题目。"
            action={
              <Btn variant="primary" icon="target" onClick={onSetGoal}>
                去设定目标
              </Btn>
            }
          />
        );
      case 'preparing':
        return (
          <>
            <EmptyState
              icon="clock"
              title="正在准备题目 · 还不能开始"
              text="准备好后这里会出现第一题。可以先离开，回来再查。"
              action={recheck('primary')}
            />
            {status.lastFailure && (
              <p className="ob-pl-supply-note">
                <span className="badge tone-hard">上次没成功</span>
                {status.lastFailure}，稍后会自动重试。
              </p>
            )}
          </>
        );
      case 'ready':
        return (
          <>
            <EmptyState
              icon="check"
              title="题目准备好了"
              text="加载第一题就可以开始。加载后仍然没有题的话，可以先上传自己的材料。"
              action={recheck('primary', '加载题目')}
            />
            {upload('secondary')}
          </>
        );
      case 'failed':
        return (
          <>
            <EmptyState
              icon="alert"
              title="没能准备好题目"
              text="可以上传自己的材料，从里面出题；也可以稍后再试一次。"
              action={upload('primary')}
            />
            <p className="ob-pl-supply-note">
              <span className="badge tone-hard">原因</span>
              {status.reason}
            </p>
            {recheck('secondary')}
          </>
        );
      case 'unknown':
        return (
          <>
            <EmptyState
              icon="alert"
              title="还不确定题目有没有准备好"
              text={
                status.final
                  ? '这次准备已经停下，不会再自动继续。可以上传自己的材料，从里面出题。'
                  : '再查一次看看最新情况；一直这样的话，可以先上传自己的材料。'
              }
              action={status.final ? upload('primary') : recheck('primary')}
            />
            <p className="ob-pl-supply-note">
              <span className="badge tone-hard">原因</span>
              {status.reason}
            </p>
            {!status.final && upload('secondary')}
          </>
        );
      default:
        return (
          <EmptyState
            icon="clock"
            title="暂时没有可以继续的题"
            text="这个目标现有的题已经用完，目前没有新的题在准备。可以上传自己的材料，从里面出题。"
            action={upload('primary')}
          />
        );
    }
  }
}

function PlacementShell({
  answeredCount,
  done,
  onExit,
  rootRef,
  children,
}: {
  answeredCount: number;
  done?: boolean;
  onExit: () => void;
  rootRef: (node: HTMLDivElement | null) => (() => void) | undefined;
  children: React.ReactNode;
}) {
  const shown = Math.min(done ? answeredCount : answeredCount + 1, CAP);
  return (
    <div className="page ob-pl" ref={rootRef}>
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

// Uploaded attachments as the native group evidence the draft and submission carry.
function nativeGroupEvidence(evidence: readonly EvidenceAttachment[]): GroupEvidenceT[] {
  return evidence.flatMap((item) =>
    item.original
      ? [{ evidence: item.original, target: item.originalTarget ?? { scope: 'all_units' } }]
      : [],
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
  // Set together with `conflict` when a save gets a 409 (async handler, not render), so
  // resume paths that run before the next render still see the conflict.
  const conflictRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(binding.state.draft?.save_epoch ?? 0);
  const shownAt = useRef(Date.now());
  const nativeEvidence = useMemo(() => nativeGroupEvidence(evidence), [evidence]);
  const draftValue = useMemo(
    () => ({ response_set: responses, group_evidence: nativeEvidence }),
    [responses, nativeEvidence],
  );
  // Latest edited draft, written by the edit handlers (not during render) so an exit
  // or commit right after the last keystroke sends that keystroke.
  const currentValue = useRef(draftValue);
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
          if (e instanceof ApiError && e.status === 409) {
            conflictRef.current = true;
            setConflict(true);
          }
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
  // YUK-1483 — autosave runs from the edit events below. Edits are only possible while
  // answering (the fields are disabled otherwise); commit holds autosave and resumes it
  // if the answer was never dispatched.
  const saveDraft = useCallback(
    (value: typeof draftValue, ctx: { keepalive: boolean }) => persist(value, ctx.keepalive),
    [persist],
  );
  // A version conflict stops autosave (only reload or discard leave it), as before.
  const autosave = useResponseDraftAutosave({ save: saveDraft, holdOnConflict: true });
  const { flush: flushDraft, hold: holdDraft, resume: resumeDraft } = autosave;
  const flushOnPagehide = useCallback(() => flushDraft({ keepalive: true }), [flushDraft]);
  const attachPagehide = usePagehideTransition(flushOnPagehide);
  // The card's root owns two things while it is on the page: the keepalive draft flush
  // on pagehide, and the exit-save it lends the parent's exit button. A new card (next
  // question) registers its own; this card only clears the slot if it still owns it.
  const attachCard = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return undefined;
      const detachPagehide = attachPagehide(node);
      const exit: ExitSave = {
        save: async () => {
          if (uploading) throw new Error('附件仍在上传，请等待上传完成。');
          if (conflict) throw new Error('草稿版本冲突，请先重新加载服务端草稿或明确放弃修改。');
          if (status === 'answering') await persist(currentValue.current, false);
        },
        hold: holdDraft,
        resume: () => {
          if (!conflictRef.current) resumeDraft();
        },
      };
      saveForExit.current = exit;
      return () => {
        detachPagehide?.();
        if (saveForExit.current === exit) saveForExit.current = null;
      };
    },
    [attachPagehide, uploading, conflict, status, persist, saveForExit, holdDraft, resumeDraft],
  );
  // The poller reports this run's terminal state once; claim it here.
  const onRunSettled = useCallback(
    (settled: JudgeRunPollingState) => {
      if (settled.status === 'done') {
        setStatus('waiting');
        void onAccepted().catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
          setStatus('uncertain');
        });
      } else {
        setStatus('held');
        setError('作答已接收，暂时无法完成定位评估。请重新查询状态。');
      }
    },
    [onAccepted],
  );
  useJudgeRunPolling({
    runId: pendingRun?.run_id ?? null,
    pollUrl: pendingRun?.poll_url,
    readStatus: client.readJudgeRunStatus,
    enabled: status === 'pending',
    onSettled: onRunSettled,
  });
  // Every edit builds on currentValue (written here, synchronously), not on the render it
  // was captured in: an upload that finishes after an await calls a handler from an older
  // render, and must not hand autosave the pre-upload answer.
  const editDraft = (next: typeof draftValue) => {
    const from = currentValue.current;
    currentValue.current = next;
    autosave.change(next, from);
  };
  const updateResponse = (entry: SlotResponseT) => {
    const latest = currentValue.current;
    const response_set = {
      entries: [...latest.response_set.entries.filter((e) => e.slot_id !== entry.slot_id), entry],
    };
    setResponses(response_set);
    editDraft({ response_set, group_evidence: latest.group_evidence });
  };
  const updateEvidence = (next: EvidenceAttachment[]) => {
    setEvidence(next);
    editDraft({
      response_set: currentValue.current.response_set,
      group_evidence: nativeGroupEvidence(next),
    });
  };
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
    autosave.hold();
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
      // Never dispatched: back to answering, so unsaved edits resume autosaving.
      // A 409 on the pre-submit save is a conflict: stay held.
      if (!dispatched && !conflictRef.current) autosave.resume();
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
    <LoomCard pad padLg className="fade-key" ref={attachCard}>
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
          <SaveStateChip state={conflict ? 'conflict' : autosave.state} onRetry={autosave.retry} />
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
            onAttachmentsChange={updateEvidence}
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
