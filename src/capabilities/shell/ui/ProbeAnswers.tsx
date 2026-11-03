// YUK-567 slice-2 — 备课台「待你试做」probe 作答区. Lists the ≤3 served-but-unanswered
// probes (from GET /api/prep-desk/probes) and lets the owner answer each — with TEXT
// and/or IMAGE (handwriting/photo) — submitting to the conjecture probe-answer route.
// The judge grades it and the verdict is surfaced gently:
//   retired  (answered right) → the conjecture is falsified: "答对了 —— 这条排除了"
//   evidence_for (first wrong answer) → preliminary within-learner evidence; requires
//             another independent probe and does NOT unlock scoped practice.
//   confirmed (answered wrong) → the predicted misconception is real (constructive,
//             NEVER "你果然不会"): "这块确实卡了 —— 教研团会据此为你备练".
//   inconclusive (wrong for another reason) → consume this probe without changing
//             conjecture evidence or inviting repeated answer fishing.
//
// Anti-guilt (same contract as slice-1): no calibration numbers, no nag; the probe is
// framed as "the question the team is about to ask", never a graded flashcard.
// Image answers reuse the shared uploadAsset/useAssetUrl (→ /api/assets), same as the
// practice answer flow; a photo-only answer is allowed (the route gates it server-side).
//
// YUK-1473 — M3E presentation (docs/design/2026-11-03-coach-m3e.md): ui-next Button /
// SkeletonLines, lucide icons, coach-shared-m3e.css. The composer is wrapped as is; answer state,
// submit, verdict, dismiss and their invalidation are unchanged.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Sparkles, Target } from 'lucide-react';
import { useState } from 'react';
// YUK-1051 — probe 作答区换成通用 EvidenceComposer（文字原文 + 附件证据一个组件；
// 上传失败不丢同批已成功的纪律在组件内）。conjecture 裁决语义不变。
import { EvidenceComposer } from '@/ui/components/response/EvidenceComposer';
import type { EvidenceAttachment } from '@/ui/components/response/response-types';
import {
  invalidateAfterProbeAnswer,
  invalidateAfterProbeVerdictDismissed,
  queryKeys,
} from '@/ui/lib/write-invalidation';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button } from '@/ui-next/public';
import { AreaGate, type AreaStatus } from './AreaGate';
import type { PrepDeskProbeWire, ProbeAnswerVerdict } from './probe-answer-api';
import { useWorkbenchClient } from './workbench-client';
import './coach-shared-m3e.css';

// 链式三元被 OCR flag（项目规则禁嵌套三元）——同一顺序的 if/else：载入 → 出错 → 有数据。
function statefulStatus(loading: boolean, error: boolean): AreaStatus {
  if (loading) return 'loading';
  if (error) return 'error';
  return 'ok';
}

const JUDGE_FAILURE_MESSAGE = '判题失败，请稍后重试';

function VerdictMessage({ verdict }: { verdict: ProbeAnswerVerdict['resolution'] }) {
  if (verdict === 'retired') {
    return (
      <span className="pq-verdict-txt">
        <Check size={16} aria-hidden="true" /> 答对了 —— 这条猜想排除了。
      </span>
    );
  }
  if (verdict === 'evidence_for') {
    return (
      <span className="pq-verdict-txt">
        <Target size={16} aria-hidden="true" /> 这次表现与猜想一致，但还需要独立复验。
      </span>
    );
  }
  if (verdict === 'confirmed') {
    return (
      <span className="pq-verdict-txt">
        <Target size={16} aria-hidden="true" /> 这块确实卡了 —— 教研团会据此为你备练。
      </span>
    );
  }
  if (verdict === 'inconclusive') {
    return (
      <span className="pq-verdict-txt">
        <Check size={16} aria-hidden="true" /> 这次答错了，但不是这条猜想里的错误；不会据此下结论。
      </span>
    );
  }
  return verdict satisfies never;
}

export function ProbeAnswers() {
  const { getActiveProbes } = useWorkbenchClient();
  const q = useQuery({ queryKey: queryKeys.prepDeskProbes, queryFn: getActiveProbes });
  const probes = q.data?.probes ?? [];

  return (
    <div className="pq un-m3e-bridge">
      <AreaGate
        status={statefulStatus(q.isLoading, q.isError)}
        onRetry={() => void q.refetch()}
        errorText="待你试做暂不可用。"
        loading={<SkeletonLines rows={2} label="正在读取待你试做" />}
      >
        {probes.length > 0 && (
          <div className="pq-list">
            {probes.map((p) => (
              <ProbeAnswerCard key={p.probe_question_id} probe={p} />
            ))}
          </div>
        )}
      </AreaGate>
    </div>
  );
}

// Exported (YUK-707 · [裁决 3]) so the teaching brief can reveal ONE scoped answer card
// in place, reusing the exact same answer flow the queue uses. `onAnswered` fires after a
// verdict is recorded — a symmetry hook for reuse; the brief drives its own in-place
// outcome advance off the ['teaching-brief'] invalidation below, not off this callback.
export function ProbeAnswerCard({
  probe,
  onAnswered,
  onFailed,
}: {
  probe: PrepDeskProbeWire;
  onAnswered?: (resolution: ProbeAnswerVerdict['resolution']) => void;
  // YUK-895 goal lane — a failed judge submit must also surface in the teaching
  // brief's 当前结果 band (the server brief is unchanged on fail-closed 422, so the
  // brief needs a local failure state). Mirrors onAnswered's symmetry hook.
  onFailed?: () => void;
}) {
  const { submitProbeAnswer } = useWorkbenchClient();
  const qc = useQueryClient();
  const [answerMd, setAnswerMd] = useState('');
  const [evidence, setEvidence] = useState<EvidenceAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // YUK-1094 — 图片上传中：提交入口并入 upload-pending，避免提交旧 image refs。
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<ProbeAnswerVerdict['resolution'] | null>(null);

  const imageRefs = evidence.map((a) => a.asset_id);
  // "has any answer" = text OR image (mirrors the route's submit gate).
  const hasAnswer = answerMd.trim().length > 0 || imageRefs.length > 0;

  async function onSubmit() {
    if (!hasAnswer || submitting || uploading) return;
    setSubmitting(true);
    setError(null);
    let resolution: ProbeAnswerVerdict['resolution'] | null = null;
    try {
      const res = await submitProbeAnswer(probe.probe_question_id, answerMd.trim(), imageRefs);
      resolution = res.resolution;
      setVerdict(res.resolution);
      // YUK-707 · [裁决 2] — a recorded verdict re-projects the teaching brief to its
      // outcome state; the probe queue waits for onDismiss.
      void invalidateAfterProbeAnswer(qc);
    } catch {
      // An actually ungradable judge result or network failure stays retryable.
      // A gradable unrelated error returns the recorded `inconclusive` verdict above.
      // YUK-911 — exactly ONE live region carries this failure (the role="alert"
      // .pq-error below); no second polite/status region may double-announce it.
      setError(JUDGE_FAILURE_MESSAGE);
      onFailed?.();
    } finally {
      setSubmitting(false);
    }
    // Fire the consumer callback OUTSIDE the try — a throwing onAnswered must not be
    // caught and mis-surfaced as a submit failure (the verdict is already recorded).
    if (resolution !== null) onAnswered?.(resolution);
  }

  function onDismiss() {
    // The answered probe now has a probe_result → leaves the 待你试做 queue (and drops
    // the entry-point count) on refetch.
    void invalidateAfterProbeVerdictDismissed(qc);
  }

  return (
    <article className="pq-card un-m3e-bridge">
      <div className="pq-probe">
        <p className="cs-kicker">
          <Sparkles size={14} aria-hidden="true" /> 团队问你的一道题
        </p>
        <div className="cs-probe-md">{probe.prompt_md}</div>
      </div>

      {verdict ? (
        <output className="pq-verdict" data-verdict={verdict}>
          <VerdictMessage verdict={verdict} />
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            知道了
          </Button>
        </output>
      ) : (
        <>
          {/* YUK-1051 — 通用文字 + 附件（图片/音频/视频/PDF/文本都走同一 composer；
              probe 的提交契约只吃 image ids，非图片附件在提交时如实剔出并提示。 */}
          <EvidenceComposer
            text={answerMd}
            onTextChange={setAnswerMd}
            attachments={evidence}
            onAttachmentsChange={setEvidence}
            disabled={submitting}
            placeholder="写下你的解答（也可以只拍照 / 传图）"
            ariaLabel="作答"
            accept="image/*"
            onUploadingChange={setUploading}
          />
          <div className="cs-acts">
            <Button
              size="sm"
              variant="primary"
              disabled={!hasAnswer || submitting || uploading}
              onClick={() => void onSubmit()}
            >
              {submitting ? '判分中…' : '提交作答'}
            </Button>
          </div>
          {error && (
            <div className="pq-error" role="alert">
              <CircleAlert size={14} aria-hidden="true" />
              {error}
            </div>
          )}
        </>
      )}
    </article>
  );
}
