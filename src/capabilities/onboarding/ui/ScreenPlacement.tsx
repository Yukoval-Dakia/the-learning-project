// Placement waits for native evaluation and settlement before the next adaptive selection.
// M3E presentation (YUK-1473, docs/design/2026-11-03-placement-m3e.md): only the markup and
// styles changed; session, autosave, pagehide, judge polling and submit logic are as before.
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clock,
  LoaderCircle,
  RefreshCw,
  Target,
  Upload,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
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
import { computeLatencyMs } from '@/ui/lib/response-latency';
import { subjectDisplayName } from '@/ui/lib/subject';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, Chip, UiNextRoot } from '@/ui-next/public';
import { OnboardingError, OnboardingState } from './OnboardingStatus';
import { OnboardingSteps } from './OnboardingSteps';
import type {
  PlacementHeldExit,
  PlacementNextResult,
  PlacementNoItem,
  PlacementQuestionRef,
  PlacementSelfReport,
  PlacementStartResult,
  PlacementUnresolvedItem,
} from './placement-api';
import { type PlacementClient, usePlacementClient } from './placement-client';
import { type StarterOutcome, starterStatus } from './starter-supply-status';
import './onboarding-m3e.css';

const CAP = 8;
// YUK-1489 — a save waits at most this long for a pending chained (pagehide) save; past it the
// save goes out at the current epoch and the server's epoch check catches any clash.
const CHAIN_WAIT_CAP_MS = 8000;
const VALID_PACES = ['light', 'medium', 'dense'] as const;
function readSelfReport(search: string): PlacementSelfReport {
  const sp = new URLSearchParams(search);
  return {
    leanings: sp.get('leanings')?.split(',').filter(Boolean) ?? [],
    pace: VALID_PACES.find((p) => p === sp.get('pace')),
  };
}
type Phase =
  | 'loading'
  | 'answer'
  | 'sourcing'
  | 'noitem'
  | 'settling'
  | 'ended'
  | 'terminal'
  | 'nogoal'
  | 'needsubject'
  | 'error';
// The next step after an answer or a released held question: same shape from both routes.
type PlacementSelection =
  | PlacementNextResult
  | Awaited<ReturnType<PlacementClient['releaseHeldPlacement']>>['selection'];
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
  const [noItem, setNoItem] = useState<PlacementNoItem | null>(null);
  // Questions that closed without a verdict, shown on the end and terminal states.
  const [unresolved, setUnresolved] = useState<PlacementUnresolvedItem[]>([]);
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
    promise: Promise<PlacementStartResult | { terminal: PlacementUnresolvedItem[] }>;
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
    if (!sid || !sessionOpenRef.current) return null;
    const result = await transport.current.placementEnd(sid, status, { keepalive: false });
    sessionOpenRef.current = false;
    return result;
  }, []);
  // The last answer is in (or the session needs no more, or the learner chose to end): end
  // the session once and go to the profile. Called from the events that reveal "done" —
  // never from render. Questions that closed without a verdict keep the learner here first,
  // so they see those were not counted.
  const finish = useCallback(() => {
    setQRef(null);
    setNoItem(null);
    setPhase('settling');
    if (finishing.current) return;
    finishing.current = true;
    void transition('completed')
      .then((result) => {
        if (!activeRef.current) return;
        const items = result?.unresolved_items ?? [];
        if (items.length > 0) {
          setUnresolved(items);
          setPhase('ended');
          return;
        }
        navigate(profileDest());
      })
      .catch((error: unknown) => {
        finishing.current = false;
        if (!activeRef.current) return;
        setErrMsg(error instanceof Error ? error.message : String(error));
        setPhase('error');
      });
  }, [navigate, profileDest, transition]);
  const applySelection = useCallback(
    (next: PlacementSelection) => {
      setAnsweredCount(next.answeredCount);
      setSupply(next.starterSupply);
      setRestoreVersion((v) => v + 1);
      if (next.done) {
        finish();
      } else {
        setQRef(next.question);
        setNoItem(next.no_item ?? null);
        setPhase(next.question ? 'answer' : next.no_item ? 'noitem' : 'sourcing');
      }
    },
    [finish],
  );
  const loadNext = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || !sessionOpenRef.current) return;
    applySelection(await transport.current.placementNext(sid));
  }, [applySelection]);
  // YUK-1405 — 「继续」 on a held question: the release answers with the next step, so the
  // page moves straight on. A question that is no longer held (409 not_releasable) means
  // the page is behind: refresh quietly instead of showing an error.
  const releaseHeld = useCallback(
    async (exit: PlacementHeldExit) => {
      try {
        const sid = sessionIdRef.current;
        if (!sid || !sessionOpenRef.current) return;
        const res = await transport.current.releaseHeldPlacement(sid, exit.issuance_id);
        if (!activeRef.current) return;
        if (res.selection) applySelection(res.selection);
        else await loadNext();
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.code === 'not_releasable') {
          await loadNext();
          return;
        }
        throw error;
      }
    },
    [applySelection, loadNext],
  );
  const recheck = () => {
    setChecking(true);
    setErrMsg(null);
    void loadNext()
      .catch((e: unknown) => setErrMsg(e instanceof Error ? e.message : String(e)))
      .finally(() => setChecking(false));
  };

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
            if (session.status !== 'started') return { terminal: session.unresolved_items ?? [] };
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
          if ('terminal' in res) {
            setUnresolved(res.terminal);
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
          } else if (res.no_item) {
            setQRef(null);
            setNoItem(res.no_item);
            setPhase('noitem');
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
          // YUK-1749 — a goal without a concrete subject (none, or one that cannot plant
          // starters such as general) cannot be placed: guide instead of showing the error.
          if (error instanceof ApiError && error.code === 'placement_goal_needs_subject') {
            setPhase('needsubject');
            return;
          }
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
    phase === 'terminal' || phase === 'nogoal' || phase === 'needsubject' || phase === 'ended'
      ? () => navigate('/today')
      : exitProbe;

  return (
    <PlacementShell
      answeredCount={answeredCount}
      done={phase === 'settling' || phase === 'ended'}
      onExit={shellExit}
      rootRef={attachScreen}
    >
      {exitFailure && (
        <section className="un-ob-section un-ob-panel">
          <OnboardingError text={`退出前未能确认保存或结束：${exitFailure.message}`} />
          <div className="un-ob-actions un-ob-actions-start">
            <Button variant="secondary" onClick={() => void leaveProbe(exitFailure.destination)}>
              重试保存并退出
            </Button>
            <Button variant="ghost" onClick={() => void leaveProbe(exitFailure.destination, true)}>
              放弃未保存修改并退出
            </Button>
          </div>
        </section>
      )}
      {phase === 'loading' && (
        <section className="un-ob-section un-ob-panel">
          <SkeletonLines rows={3} label="正在打开定位练习" />
        </section>
      )}
      {phase === 'nogoal' && (
        <section className="un-ob-section un-ob-panel">
          <OnboardingState
            icon={<Target size={24} />}
            title="还没设定目标"
            text="定位练习需要先有一个学习目标来圈定范围。"
            action={
              <Button variant="primary" onClick={() => navigate('/welcome')}>
                去设定
              </Button>
            }
          />
        </section>
      )}
      {phase === 'needsubject' && (
        <section className="un-ob-section un-ob-panel">
          <OnboardingState
            icon={<Target size={24} />}
            title="这个目标还没有选科目"
            text="定位练习按科目出起始题。这个目标没有选具体的科目，所以没法直接定位。新建一个选好科目的目标，就能接着做定位；也可以先上传自己的材料，从里面出题。"
            action={
              <>
                <Button variant="primary" onClick={() => navigate('/welcome')}>
                  新建选好科目的目标
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    const goal = goalIdRef.current;
                    navigate(
                      goal
                        ? `/onboarding/upload?goal=${encodeURIComponent(goal)}`
                        : '/onboarding/upload',
                    );
                  }}
                >
                  上传自己的材料
                </Button>
              </>
            }
          />
        </section>
      )}
      {phase === 'error' && (
        <section className="un-ob-section un-ob-panel">
          <OnboardingError
            text={errMsg ?? '定位练习无法恢复。'}
            onRetry={() => window.location.reload()}
          />
        </section>
      )}
      {phase === 'terminal' && (
        <section className="un-ob-section un-ob-panel">
          <OnboardingState
            icon={<Check size={24} />}
            title="这次定位练习已结束"
            text={
              unresolved.length > 0
                ? `这次定位练习不会自动重新开始。有 ${unresolved.length} 题没有计入结果，它们不算答错。`
                : '这次定位练习不会自动重新开始。'
            }
            action={
              <Button variant="primary" onClick={() => navigate(profileDest())}>
                看档案
              </Button>
            }
          />
          <UnresolvedNote items={unresolved} />
        </section>
      )}
      {phase === 'ended' && (
        <section className="un-ob-section un-ob-panel">
          <OnboardingState
            icon={<Check size={24} />}
            title="定位练习已结束"
            text={`有 ${unresolved.length} 题没有计入结果，下面是原因。它们不算答错。`}
            action={
              <Button variant="primary" onClick={() => navigate(profileDest())}>
                看档案
                <ArrowRight size={18} aria-hidden="true" />
              </Button>
            }
          />
          <UnresolvedNote items={unresolved} />
        </section>
      )}
      {phase === 'noitem' && noItem && (
        <section className="un-ob-section un-ob-panel">
          <NoItemStatus
            noItem={noItem}
            checking={checking}
            onRecheck={recheck}
            onEnd={finish}
            onUpload={() => void leaveProbe('/onboarding/upload')}
          />
          {errMsg && <OnboardingError text={errMsg} onRetry={recheck} />}
        </section>
      )}
      {phase === 'sourcing' && (
        <section className="un-ob-section un-ob-panel">
          <SupplyStatus
            outcomes={supply}
            checking={checking}
            onRecheck={recheck}
            onUpload={() => void leaveProbe('/onboarding/upload')}
            onSetGoal={() => void leaveProbe('/welcome')}
          />
          {errMsg && <OnboardingError text={errMsg} />}
        </section>
      )}
      {phase === 'settling' && (
        <section className="un-ob-section un-ob-panel">
          <div className="un-ob-settle" role="status">
            <LoaderCircle size={28} className="un-ob-spin" aria-hidden="true" />
            <p>正在收紧你的画像…</p>
          </div>
        </section>
      )}
      {phase === 'answer' && qRef && (
        <>
          <PlacementQuestionCard
            key={`${qRef.assessment.issuance_id}:${restoreVersion}`}
            sessionId={sessionIdRef.current ?? ''}
            qRef={qRef}
            answeredCount={answeredCount}
            onAccepted={loadNext}
            onRelease={releaseHeld}
            onEnd={finish}
            saveForExit={saveForExit}
            leaving={leaving}
            client={transport.current}
          />
          <p className="un-ob-hint un-ob-reassure">
            <Clock size={16} aria-hidden="true" />
            最多 {CAP} 题。答完才统一给反馈，先别急着看对错。
          </p>
        </>
      )}
    </PlacementShell>
  );
}

// YUK-1405 — the server has no question it can give right now. Say so plainly, name what is
// still being prepared, and offer the server's own ways out instead of an endless wait.
function NoItemStatus({
  noItem,
  checking,
  onRecheck,
  onEnd,
  onUpload,
}: {
  noItem: PlacementNoItem;
  checking: boolean;
  onRecheck: () => void;
  onEnd: () => void;
  onUpload: () => void;
}) {
  const preparing = [...new Set(noItem.preparing_subjects.map((id) => subjectDisplayName(id)))];
  return (
    <div role="status" aria-live="polite" className="un-ob-status">
      <OnboardingState
        icon={<Clock size={24} />}
        title="暂时没有能出的题"
        text={
          preparing.length > 0
            ? `还在准备${preparing.join('、')}的题。可以过一会儿再检查，也可以先结束定位。`
            : '目前也没有题在准备。可以先结束定位，或者上传自己的材料，从里面出题。'
        }
        action={
          <>
            {noItem.options.includes('recheck') && (
              <Button variant="primary" disabled={checking} onClick={onRecheck}>
                <RefreshCw size={18} aria-hidden="true" />
                {checking ? '正在检查…' : '重新检查'}
              </Button>
            )}
            {noItem.options.includes('end') && (
              <Button variant="secondary" disabled={checking} onClick={onEnd}>
                结束定位
              </Button>
            )}
          </>
        }
      />
      {preparing.length === 0 && (
        <div className="un-ob-actions un-ob-actions-start">
          <Button variant="ghost" disabled={checking} onClick={onUpload}>
            <Upload size={18} aria-hidden="true" />
            上传自己的材料
          </Button>
        </div>
      )}
    </div>
  );
}

// YUK-1405 — questions that closed without a verdict. They are listed apart and never
// counted as wrong; the reason says what happened to each.
const UNRESOLVED_REASON: Record<PlacementUnresolvedItem['reason'], string> = {
  held_released: '中途放过了',
  awaiting_evaluation: '还在判分',
  unanswered: '没有作答',
};
function UnresolvedNote({ items }: { items: readonly PlacementUnresolvedItem[] }) {
  if (items.length === 0) return null;
  const counts = new Map<PlacementUnresolvedItem['reason'], number>();
  for (const item of items) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return (
    <div className="un-ob-unresolved">
      <h3 className="un-ob-unresolved-title">这几题没有判定</h3>
      <ul>
        {[...counts].map(([reason, n]) => (
          <li key={reason}>
            {UNRESOLVED_REASON[reason]} · {n} 题
          </li>
        ))}
      </ul>
    </div>
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
    <Button variant={variant} onClick={onUpload}>
      <Upload size={18} aria-hidden="true" />
      上传自己的材料
    </Button>
  );
  const recheck = (variant: 'primary' | 'secondary', label = '再查一次') => (
    <Button variant={variant} disabled={checking} onClick={onRecheck}>
      <RefreshCw size={18} aria-hidden="true" />
      {checking ? '正在查…' : label}
    </Button>
  );
  const more = (node: ReactNode) => <div className="un-ob-actions un-ob-actions-start">{node}</div>;
  return (
    <div role="status" aria-live="polite" className="un-ob-status">
      {supplyBody()}
    </div>
  );
  function supplyBody() {
    switch (status.kind) {
      case 'need_goal':
        return (
          <OnboardingState
            icon={<Target size={24} />}
            title="还缺学习目标"
            text="先说清这次要学什么，才能为你准备题目。"
            action={
              <Button variant="primary" onClick={onSetGoal}>
                <Target size={18} aria-hidden="true" />
                去设定目标
              </Button>
            }
          />
        );
      case 'preparing':
        return (
          <>
            <OnboardingState
              icon={<Clock size={24} />}
              title="正在准备题目 · 还不能开始"
              text="准备好后这里会出现第一题。可以先离开，回来再查。"
              action={recheck('primary')}
            />
            {status.lastFailure && (
              <p className="un-ob-supply-note">
                <Chip tone="critical">上次没成功</Chip>
                {status.lastFailure}，稍后会自动重试。
              </p>
            )}
          </>
        );
      case 'ready':
        return (
          <>
            <OnboardingState
              icon={<Check size={24} />}
              title="题目准备好了"
              text="加载第一题就可以开始。加载后仍然没有题的话，可以先上传自己的材料。"
              action={recheck('primary', '加载题目')}
            />
            {more(upload('secondary'))}
          </>
        );
      case 'failed':
        return (
          <>
            <OnboardingState
              icon={<CircleAlert size={24} />}
              title="没能准备好题目"
              text="可以上传自己的材料，从里面出题；也可以稍后再试一次。"
              action={upload('primary')}
            />
            <p className="un-ob-supply-note">
              <Chip tone="critical">原因</Chip>
              {status.reason}
            </p>
            {more(recheck('secondary'))}
          </>
        );
      case 'unknown':
        return (
          <>
            <OnboardingState
              icon={<CircleAlert size={24} />}
              title="还不确定题目有没有准备好"
              text={
                status.final
                  ? '这次准备已经停下，不会再自动继续。可以上传自己的材料，从里面出题。'
                  : '再查一次看看最新情况；一直这样的话，可以先上传自己的材料。'
              }
              action={status.final ? upload('primary') : recheck('primary')}
            />
            <p className="un-ob-supply-note">
              <Chip tone="critical">原因</Chip>
              {status.reason}
            </p>
            {!status.final && more(upload('secondary'))}
          </>
        );
      default:
        return (
          <OnboardingState
            icon={<Clock size={24} />}
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
    <UiNextRoot ref={rootRef} className="un-ob" data-un-m3e="practice-foundation">
      <main className="un-ob-main un-m3e-bridge">
        <OnboardingSteps active="placement" />
        <header className="un-ob-heading">
          <h1>定位练习</h1>
          <Button variant="ghost" onClick={onExit}>
            <X size={18} aria-hidden="true" />
            退出
          </Button>
        </header>
        <div className="un-ob-pl-progress">
          <div className="un-ob-pl-progress-head">
            <span>
              第 <strong>{shown}</strong> / 最多 {CAP} 题
            </span>
            <span className="un-ob-pl-progress-cap">
              {done ? '已答完' : '答满或已经足够判断时就停'}
            </span>
          </div>
          <div className="un-ob-pl-track" aria-hidden="true">
            {Array.from({ length: CAP }).map((_, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length cap track, index is the stable identity
                key={i}
                className="un-ob-pl-seg"
                data-state={segState(i, answeredCount, done)}
              />
            ))}
          </div>
        </div>
        {children}
      </main>
    </UiNextRoot>
  );
}

// OCR #551: no nested ternaries — the segment state as a small function.
function segState(i: number, answeredCount: number, done?: boolean): 'done' | 'current' | 'next' {
  if (i < answeredCount) return 'done';
  if (!done && i === answeredCount) return 'current';
  return 'next';
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
  onRelease,
  onEnd,
  saveForExit,
  leaving,
  client,
}: {
  sessionId: string;
  qRef: PlacementQuestionRef;
  answeredCount: number;
  onAccepted: () => Promise<void>;
  onRelease: (exit: PlacementHeldExit) => Promise<void>;
  onEnd: () => void;
  saveForExit: React.MutableRefObject<ExitSave | null>;
  leaving: boolean;
  client: PlacementClient;
}) {
  const binding = qRef.assessment;
  const frozen = binding.state.practice_dto;
  // YUK-1406 — the subject's render notation from the server; without it formulas show as source.
  const notation = qRef.notation ?? null;
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
  // YUK-1487 — the pagehide save chained past the in-flight one (resolves true once stored):
  // chainedSave is the latest chain since the current request started (409 supersede check);
  // pendingChain is the same chain until it settles (later saves wait for it).
  const chainedSave = useRef<Promise<boolean> | null>(null);
  const pendingChain = useRef<Promise<boolean> | null>(null);
  // YUK-1489 — re-saves the current answer after a chain this card stopped waiting for lands
  // (see persist). Set while the card is mounted (attachCard); null once it is gone.
  const resaveAfterChain = useRef<(() => void) | null>(null);
  const cappedChains = useRef(new WeakSet<Promise<boolean>>());
  const persist = useCallback(
    async (value: typeof draftValue, keepalive: boolean, chained = false) => {
      const draft = { ...value, evaluation_group_ref: binding.evaluation_group_id };
      if (chained) {
        // The page is closing while a save is in flight: send now, not after it, at acked + 1
        // so the older request is the one the server rejects whichever lands first.
        const sent = client
          .saveResponseDraft(
            binding.issuance_id,
            { ...draft, expected_save_epoch: epoch.current + 1 },
            { keepalive },
          )
          .then((ack) => {
            epoch.current = Math.max(epoch.current, ack.save_epoch);
            savedBytes.current = JSON.stringify(value);
          });
        const settled = sent.then(
          () => true,
          () => false,
        );
        chainedSave.current = settled;
        pendingChain.current = settled;
        void settled.then(() => {
          if (pendingChain.current === settled) pendingChain.current = null;
        });
        await sent;
        return;
      }
      // Wait for the earlier save and any pending chain to settle (an earlier failure is that
      // save's own outcome, not this one's), so this request reads the epoch their ACKs left.
      // Sent before the chain's ACK it could land first and then be overwritten by the chain.
      // A chain is only waited for until the cap: a keepalive request that never settles
      // must not hold submit or exit forever (YUK-1489).
      const chainDeadline = Date.now() + CHAIN_WAIT_CAP_MS;
      for (;;) {
        if (inFlight.current) {
          await inFlight.current.then(
            () => undefined,
            () => undefined,
          );
          continue;
        }
        const earlier = pendingChain.current;
        if (!earlier) break;
        const left = chainDeadline - Date.now();
        let settled = false;
        if (left > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          settled = await Promise.race([
            earlier.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), left);
            }),
          ]);
          clearTimeout(timer);
        }
        if (settled) continue;
        // Capped: this save goes out now. If the chain lands after it, the chain's older text
        // is what the server holds; once it reports stored, save the current answer once more
        // (its ACK raised the epoch, so that save passes and the newest answer wins).
        if (!cappedChains.current.has(earlier)) {
          cappedChains.current.add(earlier);
          void earlier.then((stored) => {
            if (stored) resaveAfterChain.current?.();
          });
        }
        break;
      }
      if (JSON.stringify(value) === savedBytes.current) return;
      const saving = (async () => {
        // No chain is pending here (waited above), so only a chain sent during this request
        // can supersede it.
        chainedSave.current = null;
        try {
          const ack = await client.saveResponseDraft(
            binding.issuance_id,
            { ...draft, expected_save_epoch: epoch.current },
            { keepalive },
          );
          epoch.current = Math.max(epoch.current, ack.save_epoch);
          savedBytes.current = JSON.stringify(value);
        } catch (e) {
          // A 409 caused by a chained save that landed first is not a version conflict.
          const superseded = chainedSave.current;
          if (e instanceof ApiError && e.status === 409 && !(superseded && (await superseded))) {
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
    (value: typeof draftValue, ctx: { keepalive: boolean; chained: boolean }) =>
      persist(value, ctx.keepalive, ctx.chained),
    [persist],
  );
  // A version conflict stops autosave (only reload or discard leave it), as before.
  const autosave = useResponseDraftAutosave({ save: saveDraft, holdOnConflict: true });
  const { flush: flushDraft, hold: holdDraft, resume: resumeDraft, isHeld: isDraftHeld } = autosave;
  const flushOnPagehide = useCallback(() => flushDraft({ keepalive: true }), [flushDraft]);
  // YUK-1719 — the same keepalive flush also runs when the page turns hidden.
  const attachPagehide = usePagehideTransition(flushOnPagehide, true, flushOnPagehide);
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
      // Re-save after a capped chain only while answering continues: not once autosave is
      // held (leaving, submitting, or a conflict) and not after the card is gone.
      const resave = () => {
        if (isDraftHeld() || conflictRef.current) return;
        void persist(currentValue.current, false).catch(() => {});
      };
      resaveAfterChain.current = resave;
      return () => {
        detachPagehide?.();
        if (saveForExit.current === exit) saveForExit.current = null;
        if (resaveAfterChain.current === resave) resaveAfterChain.current = null;
      };
    },
    [
      attachPagehide,
      uploading,
      conflict,
      status,
      persist,
      saveForExit,
      holdDraft,
      resumeDraft,
      isDraftHeld,
    ],
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
  // YUK-1405 — a held question's two exits, offered only when the server sent them.
  const heldExit = status === 'held' ? (binding.held_exit ?? null) : null;
  const release = async () => {
    if (submitting || !heldExit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onRelease(heldExit);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
    <div ref={attachCard} className="un-ob-section un-ob-panel un-ob-pl-card">
      {frozen?.materials.map((material) => (
        <div key={material.material_id}>
          {material.content_md !== undefined ? (
            <MathMarkdown notation={notation}>{material.content_md}</MathMarkdown>
          ) : (
            <AssetEvidencePreview
              assetId={material.asset_id}
              label={material.caption ?? material.alt_text}
            />
          )}
        </div>
      ))}
      {frozen?.faces.map((face) => (
        <MathMarkdown key={face.part_id} className="un-ob-pl-stem" notation={notation}>
          {face.prompt_md}
        </MathMarkdown>
      ))}
      {unavailable ? (
        <OnboardingError text="这道题需要当前页面尚不支持的作答控件。可以退出并保留这次定位练习的记录。" />
      ) : (
        <>
          <SaveStateChip state={conflict ? 'conflict' : autosave.state} onRetry={autosave.retry} />
          {conflict && (
            <div className="un-ob-actions un-ob-actions-start">
              <Button variant="secondary" onClick={() => void recover()}>
                重新加载服务端草稿 · 放弃本地修改
              </Button>
            </div>
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
                notation={notation}
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
      {error && (
        <OnboardingError
          text={error}
          onRetry={heldExit && !submitting ? () => void release() : undefined}
        />
      )}
      {heldExit && (
        <p className="un-ob-pl-held-note" role="status">
          这题的作答已经收到，但现在没法判分。可以先放过它继续下一题，它不会算作答错；也可以现在结束定位。
        </p>
      )}
      <div className="un-ob-actions">
        {status === 'answering' && (
          <Button variant="primary" disabled={!canSubmit} onClick={() => void commit()}>
            {submitting ? '记录中…' : answeredCount + 1 >= CAP ? '完成定位 · 看档案' : '下一题'}
            <ArrowRight size={18} aria-hidden="true" />
          </Button>
        )}
        {status === 'retry' && (
          <Button variant="primary" disabled={submitting || leaving} onClick={() => void commit()}>
            继续处理已接收作答
          </Button>
        )}
        {(status === 'pending' || status === 'waiting') && (
          <span role="status" className="un-ob-pl-status">
            作答已接收 · 等待定位结果
          </span>
        )}
        {heldExit && (
          <>
            <Button variant="primary" disabled={submitting} onClick={() => void release()}>
              {submitting ? '正在继续…' : '继续'}
              <ArrowRight size={18} aria-hidden="true" />
            </Button>
            <Button variant="secondary" disabled={submitting} onClick={onEnd}>
              结束定位
            </Button>
          </>
        )}
        {!heldExit && (status === 'held' || status === 'uncertain') && (
          <>
            <span role="status" className="un-ob-pl-status">
              等待确认作答状态
            </span>
            <Button variant="secondary" disabled={submitting} onClick={() => void recover()}>
              重新查询状态
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
