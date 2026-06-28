// YUK-354 (A2) — 解题会话「6 阶 hint 强度梯」组件。
//
// 形态 PORT 自 docs/design/loom-refresh/project/screen-hint-ladder.jsx（`.ladder-*` 视觉）
// + data-hint-ladder.jsx（阶语义），用项目原语（LoomIcon）+ 真 solve/hint API 重建状态机，
// 不引设计源的 window 全局 / demo 模拟。落在既有 PfCoach 抽屉 body 内（PfSolo.tsx）。
//
// 强度梯映射：H0-H4 = 既有 solveHint(question.id, sid, stageIdx)（hint_index 0-4，单调 +1
// 推进，与旧流 hints.length 递增同序 → 后端行为零变更）；H5 完整解 = question.reference_md
// 的 reveal（逃生口，非 hint 调用）。详见 hint-ladder.ts 头注 + A2 handoff。
//
// 硬约束（handoff §硬功能约束）：① 单调递进不跳级（rail 仅作位置指示、不可点跳；推进只经
// 「再给一阶」+1）；② 逃生口任意阶一步到 H5（「直接看完整解」恒在）；③ H5=非独立，reveal 前
// 必经确认门（中性诚实告知后果，不羞辱）；④ 失败态可重试、不静默吞、不自动跳级；⑤ 完整解未
// 就绪 → H5 显式不可用 + 诚实空态，前几阶仍可起跑；⑥ 会话不计入判分（壳 note 保留）。

import { useEffect, useState } from 'react';

import { LoomIcon } from '@/ui/primitives/LoomIcon';

import {
  FULL_STAGE_INDEX,
  HINT_LADDER,
  type HintStage,
  LADDER_RANGE_LABEL,
  isFullSolutionAvailable,
  nextHintStage,
  positionLabel,
} from './hint-ladder';
import type { QuestionDetail } from './practice-api';
import { solveHint, solveStart } from './practice-api';

export function HintLadder({
  open,
  question,
}: {
  open: boolean;
  question: QuestionDetail;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  // 已揭示的最高 hint 阶索引（-1 = 尚未要任何提示）。H0-H4 走 hint，H5 由 revealedFull 单独管。
  const [reached, setReached] = useState(-1);
  // 各阶（0-4）已取的提示正文。stageIdx → text_md。
  const [hints, setHints] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  // 生成失败的阶索引（-1 = 无失败）；当前阶可重试，不自动跳下一阶。
  const [failAt, setFailAt] = useState(-1);
  // 看 H5 完整解前的「非独立」确认门是否展开（reveal 前必经）。
  const [confirmFull, setConfirmFull] = useState(false);
  // 完整解（H5）已 reveal。
  const [revealedFull, setRevealedFull] = useState(false);
  // owner 点了「我自己来 · 交还控制」—— 控制权回到作答。
  const [returned, setReturned] = useState(false);

  // 抽屉关闭时重置整条梯（镜像旧 PfCoach 的 open-reset），下次打开是干净起点。
  useEffect(() => {
    if (!open) {
      setSessionId(null);
      setReached(-1);
      setHints({});
      setLoading(false);
      setFailAt(-1);
      setConfirmFull(false);
      setRevealedFull(false);
      setReturned(false);
    }
  }, [open]);

  const fullAvailable = isFullSolutionAvailable(question.reference_md);
  const next = nextHintStage(reached);

  // 取某一 hint 阶（H0-H4）。session 懒建；空 text_md 视作该阶生成缺失（可重试，非静默 exhaust）。
  const advance = async (targetIdx: number) => {
    if (loading) return;
    setLoading(true);
    setFailAt(-1);
    try {
      let sid = sessionId;
      if (!sid) {
        sid = (await solveStart(question.id)).session_id;
        setSessionId(sid);
      }
      const h = await solveHint(question.id, sid, targetIdx);
      if (h.text_md) {
        setHints((m) => ({ ...m, [targetIdx]: h.text_md }));
        setReached(targetIdx);
      } else {
        setFailAt(targetIdx);
      }
    } catch {
      setFailAt(targetIdx);
    } finally {
      setLoading(false);
    }
  };

  // 逃生口：reveal 完整解（已过非独立确认门）。一步到 H5，跳过中间阶。
  const revealFull = () => {
    setConfirmFull(false);
    setRevealedFull(true);
    setReached(FULL_STAGE_INDEX);
  };

  if (returned) {
    return (
      <div className="ladder">
        <div className="ladder-returned">
          <LoomIcon name="check" size={16} />
          控制交还给你了 —— 回到题面自己作答。需要时再叫我。
        </div>
      </div>
    );
  }

  const atFull = revealedFull;

  return (
    <div className="ladder">
      {/* 自主程度轨 —— 6 阶离散刻度，恒可见（位置可见 + 强度爬升可感知）。
          rail 仅作位置指示，不可点跳：推进只经下方「再给一阶」(+1) / 逃生口，守单调不跳级。 */}
      <div className="ladder-rail">
        <div className="ladder-rail-head">
          <span className="ladder-rail-l">
            <LoomIcon name="layers" size={13} />
            自主程度 · {LADDER_RANGE_LABEL}
          </span>
          <span className="ladder-rail-r">{positionLabel(reached, revealedFull)}</span>
        </div>
        <div className="ladder-stops">
          {HINT_LADDER.map((s, i) => {
            const isReached = atFull ? true : i <= reached;
            const isCurrent = atFull ? s.isFull : i === reached;
            const cls = [
              'ladder-stop',
              isReached ? 'reached' : '',
              isCurrent ? 'current' : '',
              s.isFull ? 'is-full' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <div
                key={s.key}
                className={cls}
                title={`${s.key} · ${s.label} — ${s.gives}`}
                aria-label={`第 ${s.key} 阶（${s.label}）：${s.gives}${isCurrent ? ' · 当前' : ''}`}
              >
                <span className="ladder-dot" />
                <span className="ladder-stop-l">{s.key}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 已揭示的 hint 阶卡（H0-H4，仅到 reached）。 */}
      {HINT_LADDER.map((s, i) =>
        !s.isFull && i <= reached && hints[i] ? (
          <HintStageCard key={s.key} stage={s} body={hints[i]} />
        ) : null,
      )}

      {/* 完整解卡（H5，reveal 后）—— 非独立完成 badge + reference_md 正文。 */}
      {revealedFull && fullAvailable && (
        <div className="ladder-card full">
          <div className="ladder-card-top">
            <span className="ladder-badge">{HINT_LADDER[FULL_STAGE_INDEX].label}</span>
            <span className="ladder-noindep">
              <LoomIcon name="alert" size={12} />
              非独立完成
            </span>
          </div>
          <div className="ladder-body">{question.reference_md}</div>
        </div>
      )}

      {loading && (
        <div className="ladder-loading">
          <span className="ladder-spin" />
          正在想下一阶提示…
        </div>
      )}

      {/* 失败态：当前阶可重试，不静默吞、不自动跳级；另给逃生口 + 交还控制两条出路。 */}
      {failAt >= 0 && !loading && (
        <div className="ladder-fail">
          <div className="ladder-fail-msg">
            <LoomIcon name="alert" size={14} />
            这一阶（{HINT_LADDER[failAt]?.key}）没生成出来 ——
            不是装作好了，是真没成。可以重试，或换条路。
          </div>
          <div className="ladder-fail-acts">
            <button type="button" className="ladder-advance" onClick={() => void advance(failAt)}>
              <LoomIcon name="refresh" size={13} />
              重试这一阶
            </button>
            {fullAvailable && (
              <button
                type="button"
                className="ladder-jump"
                onClick={() => {
                  setFailAt(-1);
                  setConfirmFull(true);
                }}
              >
                <LoomIcon name="eye" size={14} />
                直接看完整解
              </button>
            )}
            <button type="button" className="ladder-escape" onClick={() => setReturned(true)}>
              <LoomIcon name="undo" size={14} />
              我自己来
            </button>
          </div>
        </div>
      )}

      {/* H5 非独立确认门：reveal 完整解前，中性诚实地告知后果，确认后才展示（不羞辱、无惩罚）。 */}
      {confirmFull && (
        <div className="ladder-confirm">
          <div className="ladder-confirm-msg">
            <LoomIcon name="alert" size={14} />
            看完整解 = 这题记为<b>非独立完成</b>。中间阶可以跳过 —— 确认要直接看吗？
          </div>
          <div className="ladder-confirm-acts">
            <button type="button" className="ladder-jump" onClick={() => revealFull()}>
              <LoomIcon name="eye" size={14} />
              确认 · 看完整解
            </button>
            <button
              type="button"
              className="ladder-escape"
              onClick={() => setConfirmFull(false)}
              style={{ marginLeft: 0 }}
            >
              再想想
            </button>
          </div>
        </div>
      )}

      {/* 动作行：再给一阶（+1）· 直接看完整解（逃生口，任意阶一步可达）· 我自己来（交还控制）。 */}
      {!loading && failAt < 0 && !confirmFull && !atFull && (
        <div className="ladder-acts-wrap">
          {next && (
            <p className="ladder-next-note">
              下一阶 · {next.key} {next.label}：{next.gives}
            </p>
          )}
          <div className="ladder-acts">
            {next && (
              <button
                type="button"
                className="ladder-advance"
                onClick={() => void advance(reached + 1)}
              >
                <LoomIcon name="chevronDown" size={14} />
                {reached < 0 ? '给我第一阶' : '再给一阶'} · {next.key} {next.label}
              </button>
            )}
            {fullAvailable ? (
              <button type="button" className="ladder-jump" onClick={() => setConfirmFull(true)}>
                <LoomIcon name="eye" size={14} />
                直接看完整解
              </button>
            ) : (
              <button type="button" className="ladder-jump" disabled aria-disabled="true">
                <LoomIcon name="eye" size={14} />
                完整解暂不可用
              </button>
            )}
            <button type="button" className="ladder-escape" onClick={() => setReturned(true)}>
              <LoomIcon name="undo" size={14} />
              我自己来 · 交还控制
            </button>
          </div>
          {!fullAvailable && (
            <p className="ladder-empty-s">
              这道题暂时没有可展示的完整解（自动生成失败或尚未就绪）。前几阶提示仍可用，或回题面自己作答。
            </p>
          )}
        </div>
      )}

      {/* reveal 完整解后：回作答 + 诚实的「仍不懂」去向（非死路）。 */}
      {!loading && atFull && (
        <div className="ladder-acts-wrap">
          <div className="ladder-acts">
            <button
              type="button"
              className="ladder-escape"
              onClick={() => setReturned(true)}
              style={{ marginLeft: 0 }}
            >
              <LoomIcon name="undo" size={14} />
              回到自己作答
            </button>
          </div>
          <p className="ladder-empty-s">
            看完仍不懂？回到题面把思路写进作答框试一遍，判错会进错题、之后在复习里再遇到它。
          </p>
        </div>
      )}
    </div>
  );
}

function HintStageCard({ stage, body }: { stage: HintStage; body: string }) {
  return (
    <div className="ladder-card">
      <div className="ladder-card-top">
        <span className="ladder-badge">
          {stage.key} · {stage.weight}
        </span>
        <span className="ladder-gives">{stage.label}</span>
      </div>
      <div className="ladder-body">{body}</div>
    </div>
  );
}
