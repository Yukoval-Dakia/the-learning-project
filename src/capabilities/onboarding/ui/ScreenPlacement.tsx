// Onboarding ③ · placement probe (YUK-473 Slice 3).
// Ported from docs/design/loom-refresh/project/screen-onboarding.jsx (ScreenPlacement
// + PlacementShell + PlacementAnswer), made real over the inc-B placement backend
// (YUK-468): start → fetch question (GET /api/questions/[id]) → submit answer
// (/api/review/submit, session_id=<probe>, auto_rate → judge + θ̂) → /next → … → /end.
//
// Replaces the Slice-1 PlacementStubPage at /placement. The goalId is threaded from the
// Welcome flow via the `?goal=<id>` query param (Welcome creates the goal; OnboardRecord
// forwards it). The probe scopes to that goal's scope_knowledge_ids server-side.
//
// DESIGN (no per-item verdict): the probe judges each answer (auto_rate) to estimate θ̂
// but does NOT surface correct/wrong mid-probe — "答完才统一给反馈，先别急着看对错"
// (design §). Results land in the profile (Slice 4); for now `done` lands on /today.
//
// COLD TREE: an empty/root-only goal scope → /start 400 or sourcingNeeded → the sourcing
// state ("子图还冷 · 去上传"). Real cold-start end-to-end (upload → auto-populate → probe)
// still needs the cold-start bridge on the upload path (YUK-482); this screen renders all
// states and works fully on a warm tree / post-bridge.

import {
  type QuestionDetail,
  computeLatencyMs,
  getQuestion,
} from '@/capabilities/practice/ui/practice-api';
import { ApiError } from '@/ui/lib/api';
import { uploadAsset } from '@/ui/lib/assets';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { ErrorState } from '@/ui/primitives/ErrorState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ObSteps } from './ObSteps';
import {
  type PlacementQuestionRef,
  placementEnd,
  placementNext,
  startPlacement,
  submitProbeAnswer,
} from './placement-api';
import './onboarding.css';

const CAP = 8; // mirror backend PLACEMENT_DEFAULT_CAP (placement-termination.ts).

type Phase = 'loading' | 'answer' | 'sourcing' | 'settling' | 'judgefail' | 'nogoal' | 'error';

export interface ScreenPlacementProps {
  navigate: (to: string) => void;
}

export default function ScreenPlacement({ navigate }: ScreenPlacementProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [qRef, setQRef] = useState<PlacementQuestionRef | null>(null);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // Captured at mount from ?goal; reused to land on /profile?goal after the probe.
  const goalIdRef = useRef<string | null>(null);

  // Mount: read ?goal and start the probe. The probe's scope is the goal's
  // scope_knowledge_ids (server-side). 400 = empty scope (cold) → sourcing; 404 =
  // flag off (PLACEMENT_PROBE_ENABLED) → error with a clear message.
  useEffect(() => {
    const goal = new URLSearchParams(window.location.search).get('goal');
    if (!goal) {
      setPhase('nogoal');
      return;
    }
    goalIdRef.current = goal;
    let cancelled = false;
    (async () => {
      try {
        const res = await startPlacement(goal);
        if (cancelled) return;
        setSessionId(res.sessionId);
        if (res.sourcingNeeded || !res.question) {
          setPhase('sourcing');
          return;
        }
        setQRef(res.question);
        setPhase('answer');
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 400) {
          // empty goal scope (cold tree) — no probe to run yet.
          setPhase('sourcing');
          return;
        }
        if (e instanceof ApiError && e.status === 404) {
          setErrMsg('定位探针尚未启用（PLACEMENT_PROBE_ENABLED）。');
          setPhase('error');
          return;
        }
        setErrMsg(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Land on the starter profile (?goal threaded) after the probe; /today fallback.
  const profileDest = () =>
    goalIdRef.current ? `/profile?goal=${encodeURIComponent(goalIdRef.current)}` : '/today';

  // After the probe completes (settling): end it, then navigate to the profile (Slice 4).
  useEffect(() => {
    if (phase !== 'settling' || !sessionId) return;
    let cancelled = false;
    const dest = goalIdRef.current
      ? `/profile?goal=${encodeURIComponent(goalIdRef.current)}`
      : '/today';
    const t = setTimeout(() => {
      if (!cancelled) navigate(dest);
    }, 1700);
    void placementEnd(sessionId, 'completed').catch(() => {});
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [phase, sessionId, navigate]);

  const exitProbe = () => {
    if (sessionId) void placementEnd(sessionId, 'abandoned').catch(() => {});
    navigate('/today');
  };

  // Answer committed for the current question → submit (judge + θ̂) → /next.
  const onAnswered = async (payload: {
    responseMd: string;
    referencedKnowledgeIds: string[];
    answerImageRefs: string[];
    latencyMs: number | null;
  }) => {
    if (!sessionId || !qRef) return;
    try {
      await submitProbeAnswer({ sessionId, questionId: qRef.questionId, ...payload });
      setAnsweredCount((c) => c + 1);
      const nx = await placementNext(sessionId);
      if (nx.done) {
        setPhase('settling');
        return;
      }
      if (nx.sourcingNeeded || !nx.question) {
        setPhase('sourcing');
        return;
      }
      setQRef(nx.question);
    } catch (e) {
      // submit 422 (judge unsupported) or network — the probe can't score this answer.
      // Slice-3 review: abandon the probe so it doesn't dangle in 'started' (the orphan
      // sweep would catch it eventually, but closing it now is cleaner).
      void placementEnd(sessionId, 'abandoned').catch(() => {});
      setErrMsg(e instanceof Error ? e.message : String(e));
      setPhase('judgefail');
    }
  };

  if (phase === 'nogoal') {
    return (
      <PlacementShell answeredCount={0} onExit={() => navigate('/today')}>
        <LoomCard pad padLg>
          <EmptyState
            icon="target"
            title="还没设定目标"
            text="定位练习需要先有一个学习目标来圈定范围。回到设定，用一句话说说你想学什么。"
            action={
              <Btn variant="primary" iconEnd="arrow" onClick={() => navigate('/welcome')}>
                去设定
              </Btn>
            }
          />
        </LoomCard>
      </PlacementShell>
    );
  }

  if (phase === 'error') {
    return (
      <PlacementShell answeredCount={0} onExit={() => navigate('/today')}>
        <LoomCard pad padLg>
          <ErrorState
            text={errMsg ?? '定位练习无法开始。'}
            onRetry={() => window.location.reload()}
          />
        </LoomCard>
      </PlacementShell>
    );
  }

  if (phase === 'loading') {
    return (
      <PlacementShell answeredCount={0} onExit={exitProbe}>
        <LoomCard pad padLg>
          <div className="ob-pl-meta">
            <span className="ob-pl-kind">loading first question</span>
          </div>
          <SkLines rows={3} />
        </LoomCard>
      </PlacementShell>
    );
  }

  if (phase === 'sourcing') {
    return (
      <PlacementShell answeredCount={answeredCount} onExit={exitProbe}>
        <LoomCard pad padLg>
          <EmptyState
            icon="clock"
            title="备题中 · 子图还冷"
            text="这个目标的知识子图还没有可定位的题。先上传一份你的材料，AI 抽出的题就能拿来定位；或稍后再来。"
            action={
              <Btn variant="primary" icon="record" onClick={() => navigate('/onboarding/upload')}>
                改为上传材料
              </Btn>
            }
          />
        </LoomCard>
      </PlacementShell>
    );
  }

  if (phase === 'judgefail') {
    return (
      <PlacementShell answeredCount={answeredCount} done onExit={() => navigate('/today')}>
        <LoomCard pad padLg>
          <ErrorState text="评分管道暂时不可用 · judge 降级。你已答的题会保留，画像稍后补算。" />
          <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 'var(--s-3)' }}>
            <Btn variant="primary" iconEnd="arrow" onClick={() => navigate(profileDest())}>
              先看初步档案
            </Btn>
          </div>
        </LoomCard>
      </PlacementShell>
    );
  }

  if (phase === 'settling') {
    return (
      <PlacementShell answeredCount={answeredCount} done onExit={() => navigate('/today')}>
        <LoomCard pad padLg>
          <div className="ob-settle">
            <div className="ob-settle-ring" />
            <div className="ob-settle-t serif">正在收紧你的画像…</div>
            <div className="ob-settle-s mono">judge · θ̂ · FSRS · 写入 mastery_state</div>
          </div>
        </LoomCard>
      </PlacementShell>
    );
  }

  // phase === 'answer'
  return (
    <PlacementShell answeredCount={answeredCount} onExit={exitProbe}>
      {qRef && (
        <PlacementQuestionCard
          key={qRef.questionId}
          qRef={qRef}
          answeredCount={answeredCount}
          onAnswered={onAnswered}
        />
      )}
      <div className="ob-pl-reassure">
        <LoomIcon name="clock" size={14} />
        这是有界的——最多 {CAP} 题、几分钟就结束。答完才统一给反馈，先别急着看对错。
      </div>
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
  const shown = Math.min(answeredCount + 1, CAP);
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
              第 <b>{done ? CAP : shown}</b> / 最多 {CAP} 题
            </span>
            <span className="ob-pl-prog-cap">{done ? '已答完' : '答到 cap 或收敛即止'}</span>
          </div>
          <div className="ob-pl-track">
            {Array.from({ length: CAP }).map((_, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length cap track, index is the stable identity
                key={i}
                className={`ob-pl-seg${
                  done || i < answeredCount ? ' is-done' : i === answeredCount ? ' is-cur' : ''
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
  qRef,
  answeredCount,
  onAnswered,
}: {
  qRef: PlacementQuestionRef;
  answeredCount: number;
  onAnswered: (payload: {
    responseMd: string;
    referencedKnowledgeIds: string[];
    answerImageRefs: string[];
    latencyMs: number | null;
  }) => Promise<void>;
}) {
  const qQ = useQuery({
    queryKey: ['question', qRef.questionId],
    queryFn: () => getQuestion(qRef.questionId),
  });
  const q = qQ.data ?? null;

  const [sel, setSel] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [imgRefs, setImgRefs] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const shownAtRef = useRef<number | null>(null);

  // Stamp the question-shown time once the row is loaded (per question — the card is
  // keyed by questionId so this remounts each question). Drives latency_ms.
  useLayoutEffect(() => {
    if (q?.id) shownAtRef.current = Date.now();
  }, [q?.id]);

  if (qQ.isLoading) {
    return (
      <LoomCard pad padLg>
        <SkLines rows={3} />
      </LoomCard>
    );
  }
  if (qQ.isError || !q) {
    return (
      <LoomCard pad padLg>
        <ErrorState
          text={`取题失败：${(qQ.error as Error | null)?.message ?? '未知'}`}
          onRetry={() => qQ.refetch()}
        />
      </LoomCard>
    );
  }

  const choices = q.choices_md ?? [];
  const isChoice = choices.length > 0;
  const hasImg = imgRefs.length > 0;
  const answered = isChoice ? sel !== null : text.trim().length > 0 || hasImg;
  const last = answeredCount + 1 >= CAP;

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const asset = await uploadAsset(file);
      setImgRefs((refs) => [...refs, asset.id]);
    } catch {
      // swallow — the user can retry; a failed upload just leaves no image ref.
    } finally {
      setUploading(false);
    }
  };

  const commit = async () => {
    if (!answered || submitting) return;
    setSubmitting(true);
    const responseMd = isChoice && sel !== null ? (choices[sel] ?? '') : text.trim();
    try {
      await onAnswered({
        responseMd,
        referencedKnowledgeIds: q.labels.map((l) => l.id),
        answerImageRefs: imgRefs,
        latencyMs: computeLatencyMs(shownAtRef.current, Date.now()),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <LoomCard pad padLg className="fade-key">
      <div className="ob-pl-meta">
        {q.labels.map((l) => (
          <span key={l.id} className="chip chip-k">
            {l.name}
          </span>
        ))}
        <span className="ob-pl-kind">{q.kind}</span>
        <span className="meta mono">{q.id.slice(0, 12)}</span>
      </div>

      <div className="ob-pl-stem">{q.prompt_md}</div>

      {isChoice ? (
        <div className="ob-opts" role="radiogroup" aria-label="选项">
          {choices.map((c, i) => (
            <button
              type="button"
              key={c}
              className={`ob-opt${sel === i ? ' is-sel' : ''}`}
              // biome-ignore lint/a11y/useSemanticElements: 设计稿卡片式选项（ob-opt 布局）；
              // native <input type="radio"> 无法承载该布局，真 <button> + radiogroup ARIA
              // 模式语义完整（同 PfSolo / PracticeChoiceOptions 先例）。
              role="radio"
              aria-checked={sel === i}
              onClick={() => setSel(i)}
            >
              <span className="ob-opt-k">{String.fromCharCode(65 + i)}</span>
              <span className="ob-opt-t">{c}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="ob-pl-answer">
          <div className="composer answer-composer">
            <textarea
              rows={3}
              value={text}
              placeholder="写下你的作答——也可以拍照上传手写。"
              onChange={(e) => setText(e.target.value)}
              aria-label="作答"
            />
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => void pickImage(e.target.files?.[0])}
          />
          <div className="hero-cta" style={{ marginTop: 'var(--s-3)' }}>
            {hasImg ? (
              <span className="ob-pl-attach">
                <LoomIcon name="check" size={13} />
                已附 {imgRefs.length} 张手写稿
              </span>
            ) : (
              <Btn
                variant="ghost"
                size="sm"
                icon="camera"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? '上传中…' : '拍照上传手写'}
              </Btn>
            )}
          </div>
        </div>
      )}

      <div className="ob-pl-foot">
        <Btn
          variant="primary"
          iconEnd={last ? 'check' : 'arrow'}
          disabled={!answered || submitting}
          onClick={() => void commit()}
        >
          {submitting ? '记录中…' : last ? '完成定位 · 看档案' : '下一题'}
        </Btn>
        {answered && (
          <span className="ob-pl-saved">
            <LoomIcon name="check" size={12} />
            已作答
          </span>
        )}
        <span className="ob-pl-hint">
          {isChoice ? '选择即记录 · 攒到末尾统一判分' : '作答攒到末尾统一判分'}
        </span>
      </div>
    </LoomCard>
  );
}
