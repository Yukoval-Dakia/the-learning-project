// YUK-1881 — 复盘的 exact evaluation 申诉：对本 slot assessment.issuance_id 读
// getIssuanceState，申诉锚点取 terminal run 的 assessment.effective_evaluation_id
// （缺省回退 candidate_id，与散题一致——二者都是 evaluation id；submission_id、
// judge_event_id、「按题查最新」一律不冒充）。latest_appeal_event_id 接续既有申诉
// 轮询。失败/未知结果保留输入且不自动重试；pending/unavailable 如实显示。
// 只在行展开时挂载（宿主条件渲染 + 按 issuance_id key），mount 不发写。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { Button, Chip } from '@/ui-next/public';

import { getAppealStatus, type AppealStatus } from './practice-api';
import { usePracticeClient } from './practice-client';
import type { PaperSlot } from './practice-api';
import { VERDICT_OF } from './use-practice-submit';

const APPEAL_POLL_MS = 3000;

const STATUS_COPY: Record<AppealStatus['status'], string> = {
  in_progress: '重判进行中',
  changed: '重判已更新结果',
  unchanged: '重判已完成，结果不变',
  unjudgeable: '暂时没法重判',
  failed: '重判没有成功',
};

/** 申诉请求的状态行：in_progress/changed/unchanged/unjudgeable/failed 如实显示。 */
function AppealReadout({ read }: { read: AppealStatus | undefined }) {
  if (!read) return null;
  const afterOutcome = read.after?.coarse_outcome;
  const afterLabel =
    typeof afterOutcome === 'string' && afterOutcome in VERDICT_OF
      ? VERDICT_OF[afterOutcome as keyof typeof VERDICT_OF].label
      : null;
  return (
    <p className="pf-rq-appeal-status" role="status">
      {STATUS_COPY[read.status] ?? '重判状态未知'}
      {read.status === 'changed' && afterLabel ? `：${afterLabel}` : ''}
    </p>
  );
}

export function PaperRetroAppeal({ slot }: { slot: PaperSlot }) {
  const { getIssuanceState, fileAppeal } = usePracticeClient();
  const qc = useQueryClient();
  const issuanceId = slot.assessment?.issuance_id;
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [filedAppealId, setFiledAppealId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 过期目标保护：记住提交时瞄准的 evaluationId；issuance/目标变了，旧回调不写新状态。
  const targetRef = useRef<string | null>(null);

  const targetQ = useQuery({
    queryKey: ['paper-retro-appeal-target', issuanceId],
    enabled: issuanceId !== undefined,
    staleTime: 0,
    retry: 1,
    queryFn: async () => {
      const state = await getIssuanceState(issuanceId ?? '');
      const settled = state.settled;
      if (!settled || settled.kind !== 'terminal') {
        return {
          kind: (settled?.kind === 'pending' ? 'pending' : 'unavailable') as
            | 'pending'
            | 'unavailable',
          evaluationId: null,
          latestAppealId: null,
        };
      }
      // done+null（畸形/legacy 降级）与无锚点都不是申诉坐标。锚点与散题一致：
      // 只有 evaluation 能申诉（effective 或 candidate，二者都是 evaluation id），
      // submission_id/judge_event_id/「拿题查最新」一律不冒充。
      const assessment = settled.run.result?.assessment;
      const evaluationId =
        settled.run.status === 'done'
          ? (assessment?.effective_evaluation_id ?? assessment?.candidate_id ?? null)
          : null;
      return {
        kind: (evaluationId ? 'ready' : 'unavailable') as 'ready' | 'unavailable',
        evaluationId,
        latestAppealId: settled.latest_appeal_event_id,
      };
    },
  });

  const target = !issuanceId
    ? { kind: 'unavailable' as const, evaluationId: null, latestAppealId: null }
    : targetQ.isPending
      ? { kind: 'loading' as const, evaluationId: null, latestAppealId: null }
      : targetQ.isError
        ? { kind: 'unavailable' as const, evaluationId: null, latestAppealId: null }
        : targetQ.data;

  const resumeAppealId = filedAppealId ?? (target.kind === 'ready' ? target.latestAppealId : null);
  const appealQ = useQuery({
    queryKey: ['paper-retro-appeal-status', resumeAppealId],
    enabled: resumeAppealId !== null,
    queryFn: () => getAppealStatus(resumeAppealId ?? ''),
    // in_progress 续轮询直到终态；读失败也停下（不把未知当未受理）。
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === undefined || status === 'in_progress' ? APPEAL_POLL_MS : false;
    },
  });

  async function submitAppeal() {
    const text = reason.trim();
    if (target.kind !== 'ready' || !target.evaluationId || !text || submitting) return;
    const evaluationId = target.evaluationId;
    targetRef.current = evaluationId;
    setSubmitting(true);
    setNotice(null);
    try {
      const filed = await fileAppeal(evaluationId, text, 'evaluation');
      // A stale/changed target's late response must not publish onto the new one.
      if (targetRef.current !== evaluationId) return;
      setFiledAppealId(filed.appeal_event_id);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['paper-retro-appeal-target', issuanceId] });
    } catch (cause) {
      if (targetRef.current !== evaluationId) return;
      // 理由留在输入框：未知/失败结果不得吞掉学习者写的内容，也不自动重发。
      setNotice(
        cause instanceof ApiError && cause.code === 'stale_head'
          ? '这个结果已经更新过了，展开再看最新结果。'
          : '重判没有提交成功，稍后再试。理由先留着。',
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (issuanceId === undefined) {
    // legacy 行无 assessment/issuance：诚实不可用，不伪造申诉坐标。
    return <p className="pf-rq-note">这道题没有可以申诉的判定记录。</p>;
  }
  if (target.kind === 'loading') {
    return (
      <p className="pf-rq-note" role="status">
        正在读取这道题的判定…
      </p>
    );
  }
  if (target.kind === 'pending') {
    return (
      <p className="pf-rq-note">
        这道题的判定还在处理中，判完之后才能申诉。 <Chip>待评</Chip>
      </p>
    );
  }
  if (target.kind !== 'ready') {
    return <p className="pf-rq-note">这道题目前没有可申诉的判定。</p>;
  }

  const alreadyFiled = resumeAppealId !== null;
  return (
    <div className="pf-rq-appeal">
      <AppealReadout read={appealQ.data} />
      {alreadyFiled ? null : (
        <>
          <label className="pf-rq-appeal-field">
            <span className="pf-rq-label">申诉理由</span>
            <textarea
              className="pf-rq-appeal-text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="觉得哪里判得不对，写下来。"
              disabled={submitting}
            />
          </label>
          <div className="pf-rq-appeal-actions">
            <Button
              variant="secondary"
              onClick={() => void submitAppeal()}
              disabled={submitting || reason.trim() === ''}
            >
              {submitting ? '提交中…' : '提交申诉'}
            </Button>
          </div>
        </>
      )}
      {alreadyFiled && appealQ.data === undefined && !appealQ.isPending && !appealQ.isError && (
        <p className="pf-rq-note">申诉已提交，正在读取进度…</p>
      )}
      {alreadyFiled && appealQ.isError && (
        <p className="pf-rq-note">申诉进度暂时读不到，已提交不受影响。</p>
      )}
      {notice && (
        <p className="pf-rq-note" role="alert">
          {notice}
        </p>
      )}
    </div>
  );
}
