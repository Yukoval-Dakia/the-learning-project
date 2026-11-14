// The hint ladder in the practice hint drawer. Six stops from lightest to the full solution; the
// learner picks how far to look, and each stop is one server call that records what was seen.
//
// H0-H4 are solveHint(question.id, sid, stageIdx); H5 is the question's reference, fetched only when
// asked for. A failed stop can be retried and never moves on by itself. Whether the answer still
// counts as the learner's own is the server's to say, from what it recorded.

import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, CircleAlert, Eye, Layers, RefreshCw, Undo2 } from 'lucide-react';
import { useState } from 'react';

import { MathMarkdown } from '@/ui/lib/math-markdown';

import {
  FULL_STAGE_INDEX,
  HINT_LADDER,
  type HintStage,
  isFullSolutionAvailable,
  nextHintStage,
  positionLabel,
} from './hint-ladder';
import type { HintHistoryResponse, QuestionDetail, SolveHintFallbackHelp } from './practice-api';
import { usePracticeClient } from './practice-client';
import './hint-ladder.css';

// YUK-1409 — 一阶拿到的内容：AI 现生成的提示，或 AI 失败时服务端给的固定帮助（fallback）。
type StageHint = { kind: 'ai'; text: string } | { kind: 'fallback'; help: SolveHintFallbackHelp };
// AI 失败且没有可替代材料（unavailable）：停在该阶，可重试 / 可跳过；不是错误态。
type StageUnavailable = { stage: number; text: string; canSkip: boolean };

// Reopening rechecks authorization before displaying stored bodies. Generation
// remains an explicit action; an unfinished claim cannot trigger another send.
export function HintLadder(
  props: Omit<
    Parameters<typeof HintLadderReady>[0],
    'history' | 'onRefresh' | 'historyUnavailable'
  >,
) {
  const { restoreHints } = usePracticeClient();
  const query = useQuery({
    queryKey: ['issued-hint-history', props.issuanceId, props.question.id],
    queryFn: () => {
      if (!props.issuanceId) throw new Error('Issued coordinate missing');
      return restoreHints(props.question.id, props.issuanceId);
    },
    enabled: !!props.issuanceId,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  if (!props.issuanceId)
    return (
      <div className="un-hl" role="status">
        <p>暂时无法恢复这次作答的提示。没有生成新提示。</p>
        <button className="un-hl-escape un-hit" type="button" onClick={props.onReturnToAnswer}>
          回到作答
        </button>
      </div>
    );
  if (query.isError)
    return (
      <HintLadderReady
        {...props}
        history={{ status: 'empty', hints: [], next_rung: 0 }}
        historyUnavailable
        onRefresh={() => void query.refetch()}
      />
    );
  if (!query.data || query.isFetching)
    return (
      <p className="un-hl-loading" role="status">
        正在恢复已保存的提示…
      </p>
    );
  return (
    <HintLadderReady
      {...props}
      key={`${query.data.status}:${query.data.hints.length}`}
      history={query.data}
      onRefresh={() => void query.refetch()}
    />
  );
}

function HintLadderReady({
  history,
  historyUnavailable = false,
  onRefresh,
  question,
  onReturnToAnswer,
  issuanceId,
  submitted = false,
  onStageReached,
  onFullSolutionRevealed,
  requestFullSolution,
}: {
  history: HintHistoryResponse;
  historyUnavailable?: boolean;
  onRefresh: () => void;
  question: QuestionDetail;
  submitted?: boolean;
  onReturnToAnswer?: () => void;
  // YUK-1051 (D16) — 提示/揭示证据必须绑定 issuance 并在服务端留痕；服务端契约是
  // YUK-1052 lane。接缝：宿主传入 issuanceId + 回调后，每阶提示的抵达与完整解的揭示
  // 都会经回调上报（关闭/刷新不再恢复成「独立完成」）；缺席时保持现有本地态行为，
  // 不伪造持久化。
  issuanceId?: string | null;
  onStageReached?: (stageIndex: number, ctx: { issuanceId: string | null }) => void;
  onFullSolutionRevealed?: (ctx: { issuanceId: string | null }) => void;
  // 完整解按需取得（显式揭示授权后才拉取，不随初始题面 DTO 下载）；缺席时退回
  // question.reference_md（现状行为，题面 DTO 仍带参考的现状由服务端 lane 收口）。
  requestFullSolution?: () => Promise<string | null>;
}) {
  const { solveStart, solveHint } = usePracticeClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  // 已揭示的最高 hint 阶索引（-1 = 尚未要任何提示）。H0-H4 走 hint，H5 由 revealedFull 单独管。
  const [reached, setReached] = useState(history.hints.length - 1);
  // 各阶（0-4）已取的提示。stageIdx → AI 提示正文或固定帮助（fallback）。
  const [hints, setHints] = useState<Record<number, StageHint>>(() =>
    Object.fromEntries(
      history.hints.map((h) => [
        h.index,
        h.kind === 'ai'
          ? { kind: 'ai', text: h.text_md }
          : {
              kind: 'fallback',
              help: {
                kind: 'deterministic_next_step',
                source: 'deterministic',
                text_md: h.text_md,
                generated_on_demand: false,
                disclosure_md: h.disclosure_md ?? undefined,
              },
            },
      ]),
    ),
  );
  const historyBlocked =
    historyUnavailable ||
    history.status === 'outcome_unknown' ||
    history.status === 'legacy_body_unavailable';
  const [unavailable, setUnavailable] = useState<StageUnavailable | null>(null);
  const [loading, setLoading] = useState(false);
  // Failed requests may only refresh persisted results, never resend automatically.
  const [failAt, setFailAt] = useState(-1);
  // 完整解（H5）已 reveal。
  const [revealedFull, setRevealedFull] = useState(false);
  // YUK-1051 — 按需拉取的完整解正文（requestFullSolution 注入时）；null=未取。
  const [fetchedFull, setFetchedFull] = useState<string | null>(null);
  const [fetchingFull, setFetchingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);
  // owner 点了「我自己来」—— 控制权回到作答。
  const [returned, setReturned] = useState(false);

  // YUK-1051 — 注入 requestFullSolution 时完整解按需取：可用性由 seam 决定（null=不可用）；
  // 未注入退回 question.reference_md（现状）。
  const fullAvailable = requestFullSolution
    ? true
    : !historyUnavailable && isFullSolutionAvailable(question.reference_md);
  const fullBody = requestFullSolution ? fetchedFull : (question.reference_md ?? null);
  const next = nextHintStage(reached);

  // 取某一 hint 阶（H0-H4）。session 懒建；空 text_md 视作该阶生成缺失（可重试，非静默 exhaust）。
  const advance = async (targetIdx: number) => {
    if (loading || fetchingFull || historyBlocked || targetIdx !== reached + 1) return;
    setLoading(true);
    setFailAt(-1);
    setUnavailable(null);
    setFullError(null);
    try {
      let sid = sessionId;
      if (!sid) {
        sid = (await solveStart(question.id, issuanceId ?? undefined)).session_id;
        setSessionId(sid);
      }
      const h = await solveHint(
        question.id,
        sid,
        targetIdx,
        issuanceId ?? undefined,
        crypto.randomUUID(),
      );
      // YUK-1409 — unavailable：这一阶没给出任何帮助 → 不算用掉这一阶，停在原位可重试/跳过。
      if ('status' in h && h.status === 'unavailable') {
        setUnavailable({
          stage: targetIdx,
          text: h.text_md,
          canSkip: h.options.includes('skip'),
        });
        return;
      }
      // fallback 也算用掉这一阶：服务端已记下这次求助并给了帮助，阶梯照常前进一格，
      // 否则「再给一阶」会原地重复请求同一阶。
      const entry: StageHint | null =
        'status' in h && h.status === 'fallback'
          ? { kind: 'fallback', help: h.help }
          : h.text_md
            ? { kind: 'ai', text: h.text_md }
            : null;
      if (entry) {
        setHints((m) => ({ ...m, [targetIdx]: entry }));
        setReached((highest) => Math.max(highest, targetIdx));
        // YUK-1051 (D16) — 提示抵达上报（接 seam 时服务端留痕；回调失败不阻梯）。
        try {
          onStageReached?.(targetIdx, { issuanceId: issuanceId ?? null });
        } catch {
          // 留痕失败不阻作答流。
        }
      } else {
        setFailAt(targetIdx);
      }
    } catch {
      setFailAt(targetIdx);
    } finally {
      setLoading(false);
    }
  };

  // reveal 完整解：一步到 H5，跳过中间阶。
  // YUK-1051 — 注入 requestFullSolution 时按需拉取（显式揭示授权后才取），
  // 拉取失败不假装揭示（可重试）；未注入则退回 question.reference_md。
  const revealFull = async () => {
    if (requestFullSolution && fetchedFull === null) {
      if (fetchingFull) return;
      setFetchingFull(true);
      setFullError(null);
      try {
        const full = await requestFullSolution();
        if (full === null) {
          setFullError('这次发题没有封存参考解答，暂不可查看。');
          return;
        }
        setFetchedFull(full);
      } catch {
        setFullError('暂时无法取得参考解答，请重试。');
        return;
      } finally {
        setFetchingFull(false);
      }
    }
    setRevealedFull(true);
    setReached(FULL_STAGE_INDEX);
    try {
      onFullSolutionRevealed?.({ issuanceId: issuanceId ?? null });
    } catch {
      // 留痕失败不阻揭示（用户已看过内容）。
    }
  };

  const returnToAnswer = () => {
    setReturned(true);
    onReturnToAnswer?.();
  };

  if (returned) {
    return (
      <div className="un-hl">
        <div className="un-hl-returned">
          <Check size={18} aria-hidden="true" />
          好，回到题面自己做。需要时再叫我。
        </div>
      </div>
    );
  }

  const atFull = revealedFull;
  const pick = (stage: HintStage, index: number) => {
    if (loading || fetchingFull) return;
    if (stage.isFull) void revealFull();
    else if (!hints[index]) void advance(index);
  };

  return (
    <div className="un-hl">
      {history.hints.length > 0 && (
        <p className="un-hl-next-note">已恢复之前看过的提示；本次作答已计入援助。</p>
      )}
      {historyBlocked && (
        <div className="un-hl-unavail-msg" role="status">
          {historyUnavailable
            ? '暂时无法恢复这次作答的提示。没有生成新提示。'
            : history.status === 'outcome_unknown'
              ? '上次提示的结果尚不确定。不会再次自动生成；可以刷新已存记录或回到作答。'
              : '旧提示只有使用记录，正文无法恢复。不会自动重新生成。'}
          <button className="un-hl-escape un-hit" type="button" onClick={onRefresh}>
            刷新已存记录
          </button>
          <button className="un-hl-escape un-hit" type="button" onClick={onReturnToAnswer}>
            回到作答
          </button>
        </div>
      )}
      {/* Published steps remain readable; only the next unpublished step can generate. */}
      <div className="un-hl-rail">
        <div className="un-hl-rail-head">
          <span className="un-hl-rail-l">
            <Layers size={16} aria-hidden="true" />
            提示从轻到重
          </span>
          <span className="un-hl-rail-r">{positionLabel(reached, revealedFull)}</span>
        </div>
        <div className="un-hl-stops">
          {HINT_LADDER.map((s, i) => {
            // Only what was really looked at reads as seen: stops jumped over stay empty.
            const isReached = s.isFull ? atFull : !!hints[i];
            const isCurrent = atFull ? s.isFull : i === reached;
            const cls = [
              'un-hl-stop',
              isReached ? 'reached' : '',
              isCurrent ? 'current' : '',
              s.isFull ? 'is-full' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                type="button"
                key={s.key}
                className={cls}
                title={`${s.label} — ${s.gives}`}
                aria-label={`第 ${i + 1} 个提示（${s.label}）：${s.gives}`}
                aria-current={isCurrent ? 'step' : undefined}
                aria-disabled={loading || fetchingFull || undefined}
                disabled={
                  atFull ||
                  (s.isFull && !fullAvailable) ||
                  (!s.isFull && (historyBlocked || i > reached + 1))
                }
                onClick={() => pick(s, i)}
              >
                <span className="un-hl-dot" />
                <span className="un-hl-stop-l">{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 已揭示的 hint 阶卡（H0-H4，仅到 reached）。 */}
      {HINT_LADDER.map((s, i) =>
        !s.isFull && i <= reached && hints[i] ? (
          <HintStageCard
            key={s.key}
            stage={s}
            hint={hints[i]}
            notation={question.notation}
            submitted={submitted}
          />
        ) : null,
      )}

      {/* 完整解卡（H5，reveal 后）—— 非独立完成 badge + 参考正文。 */}
      {revealedFull && fullAvailable && fullBody !== null && (
        <div className="un-hl-card full">
          <div className="un-hl-card-top">
            <span className="un-hl-badge">{HINT_LADDER[FULL_STAGE_INDEX].label}</span>
            {!submitted && (
              <span className="un-hl-noindep">
                <CircleAlert size={14} aria-hidden="true" />
                不算独立做的
              </span>
            )}
          </div>
          <div className="un-hl-body">
            {/* YUK-1005 — H5 full solution render through markdown+KaTeX like the rest
                of the question faces；YUK-1051 起正文可来自按需拉取（fetchedFull）。 */}
            <MathMarkdown notation={question.notation}>{fullBody}</MathMarkdown>
          </div>
        </div>
      )}

      {fullError && (
        <p className="un-hl-status" role="status">
          {fullError}
        </p>
      )}
      {loading && (
        <div className="un-hl-loading" role="status">
          <span className="un-hl-spin" />
          正在想下一个提示…
        </div>
      )}

      {/* YUK-1409 — AI 暂时给不出、也没有替代材料：中性说明 + 重试同一阶 / 跳过（不是错误态）。 */}
      {unavailable && !loading && (
        <div className="un-hl-unavail" role="status">
          <p className="un-hl-unavail-msg">{unavailable.text}</p>
          <div className="un-hl-fail-acts">
            <button type="button" className="un-hl-advance un-hit" onClick={onRefresh}>
              <RefreshCw size={18} aria-hidden="true" />
              刷新已存提示
            </button>
            {unavailable.canSkip && (
              <button
                type="button"
                className="un-hl-escape un-hit"
                onClick={() => setUnavailable(null)}
                style={{ marginLeft: 0 }}
              >
                这个提示先不要
              </button>
            )}
          </div>
        </div>
      )}

      {/* Reading stored results never retries the failed generation. */}
      {failAt >= 0 && !loading && (
        <div className="un-hl-fail">
          <div className="un-hl-fail-msg">
            <CircleAlert size={18} aria-hidden="true" />
            尚未确认这条提示的结果。刷新只读取已存提示，不会再次生成。
          </div>
          <div className="un-hl-fail-acts">
            <button type="button" className="un-hl-advance un-hit" onClick={onRefresh}>
              <RefreshCw size={18} aria-hidden="true" />
              刷新已存提示
            </button>
            {fullAvailable && (
              <button
                type="button"
                className="un-hl-jump un-hit"
                disabled={fetchingFull}
                onClick={() => {
                  setFailAt(-1);
                  void revealFull();
                }}
              >
                <Eye size={18} aria-hidden="true" />
                直接看完整解
              </button>
            )}
            <button type="button" className="un-hl-escape un-hit" onClick={returnToAnswer}>
              <Undo2 size={18} aria-hidden="true" />
              我自己来
            </button>
          </div>
        </div>
      )}

      {/* 动作行：下一个提示 · 直接看完整解 · 我自己来。 */}
      {!loading && failAt < 0 && !unavailable && !atFull && (
        <div className="un-hl-acts-wrap">
          {next && !historyBlocked && (
            <p className="un-hl-next-note">
              下一个提示 · {next.label}：{next.gives}
            </p>
          )}
          <div className="un-hl-acts">
            {next && !historyBlocked && (
              <button
                type="button"
                className="un-hl-advance un-hit"
                disabled={fetchingFull}
                onClick={() => void advance(reached + 1)}
              >
                <ChevronDown size={18} aria-hidden="true" />
                {reached < 0 ? '给我第一个提示' : '再给一个提示'} · {next.label}
              </button>
            )}
            {fullAvailable ? (
              <button
                type="button"
                className="un-hl-jump un-hit"
                disabled={fetchingFull}
                onClick={() => void revealFull()}
              >
                <Eye size={18} aria-hidden="true" />
                {fetchingFull ? '正在取完整解…' : '直接看完整解'}
              </button>
            ) : (
              <button type="button" className="un-hl-jump un-hit" disabled aria-disabled="true">
                <Eye size={18} aria-hidden="true" />
                完整解暂不可用
              </button>
            )}
            <button type="button" className="un-hl-escape un-hit" onClick={returnToAnswer}>
              <Undo2 size={18} aria-hidden="true" />
              我自己来
            </button>
          </div>
          {!fullAvailable && !historyBlocked && (
            <p className="un-hl-empty-s">
              这道题暂时没有可展示的完整解（自动生成失败或尚未就绪）。前面的提示仍可用，或回题面自己作答。
            </p>
          )}
        </div>
      )}

      {/* reveal 完整解后：回作答 + 诚实的「仍不懂」去向（非死路）。 */}
      {!loading && atFull && (
        <div className="un-hl-acts-wrap">
          <div className="un-hl-acts">
            <button
              type="button"
              className="un-hl-escape un-hit"
              onClick={returnToAnswer}
              style={{ marginLeft: 0 }}
            >
              <Undo2 size={18} aria-hidden="true" />
              回到自己作答
            </button>
          </div>
          <p className="un-hl-empty-s">
            看完仍不懂？回到题面把思路写进作答框试一遍，判错会进错题、之后在复习里再遇到它。
          </p>
        </div>
      )}
    </div>
  );
}

function HintStageCard({
  stage,
  hint,
  notation,
  submitted,
}: {
  stage: HintStage;
  hint: StageHint;
  notation: string | null;
  submitted: boolean;
}) {
  if (hint.kind === 'fallback') {
    // YUK-1409 — AI 提示没生成出来时的固定帮助：诚实标明是参考解答还是固定的下一步，
    // 不展示失败原因与耗时；服务端附带的说明（disclosure_md）必须展示。
    const isReference = hint.help.kind === 'reference';
    return (
      <div className={isReference ? 'un-hl-card full' : 'un-hl-card'}>
        <div className="un-hl-card-top">
          <span className="un-hl-badge">{isReference ? '参考解答' : '固定的下一步'}</span>
          {isReference && !submitted && (
            <span className="un-hl-noindep">
              <CircleAlert size={14} aria-hidden="true" />
              不算独立做的
            </span>
          )}
        </div>
        <p className="un-hl-fallback-line">
          {isReference
            ? 'AI 提示暂时不可用，先给你这道题的参考解答'
            : 'AI 提示暂时不可用，先给你一个固定的下一步'}
        </p>
        <div className="un-hl-body">
          <MathMarkdown notation={notation}>{hint.help.text_md}</MathMarkdown>
        </div>
        {hint.help.disclosure_md && (
          <div className="un-hl-empty-s">
            <MathMarkdown notation={notation}>{hint.help.disclosure_md}</MathMarkdown>
          </div>
        )}
      </div>
    );
  }
  const body = hint.text;
  return (
    <div className="un-hl-card">
      <div className="un-hl-card-top">
        <span className="un-hl-badge">{stage.weight}</span>
        <span className="un-hl-gives">{stage.label}</span>
      </div>
      <div className="un-hl-body">
        {/* AI-generated hint text can carry the same $…$ notation as the stem. */}
        <MathMarkdown notation={notation}>{body}</MathMarkdown>
      </div>
    </div>
  );
}
