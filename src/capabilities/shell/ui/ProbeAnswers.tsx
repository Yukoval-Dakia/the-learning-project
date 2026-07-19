// YUK-567 slice-2 — 备课台「待你试做」probe 作答区. Lists the ≤3 served-but-unanswered
// probes (from GET /api/prep-desk/probes) and lets the owner answer each — with TEXT
// and/or IMAGE (handwriting/photo) — submitting to the conjecture probe-answer route.
// The judge grades it and the verdict is surfaced gently:
//   retired  (answered right) → the conjecture is falsified: "答对了 —— 这条排除了"
//   confirmed (answered wrong) → the predicted misconception is real (constructive,
//             NEVER "你果然不会"): "这块确实卡了 —— 教研团会据此为你备练".
//
// Anti-guilt (same contract as slice-1): no calibration numbers, no nag; the probe is
// framed as "the question the team is about to ask", never a graded flashcard.
// Image answers reuse the shared uploadAsset/useAssetUrl (→ /api/assets), same as the
// practice answer flow; a photo-only answer is allowed (the route gates it server-side).

import { uploadAsset, useAssetUrl } from '@/ui/lib/assets';
import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  type PrepDeskProbeWire,
  type ProbeAnswerVerdict,
  getActiveProbes,
  submitProbeAnswer,
} from './probe-answer-api';

function statefulStatus(loading: boolean, error: boolean): StatefulStatus {
  return loading ? 'loading' : error ? 'error' : 'ok';
}

export function ProbeAnswers() {
  const q = useQuery({ queryKey: ['prep-desk-probes'], queryFn: getActiveProbes });
  const probes = q.data?.probes ?? [];

  return (
    <div className="probe-answers">
      <Stateful
        status={statefulStatus(q.isLoading, q.isError)}
        onRetry={() => void q.refetch()}
        errorText="待你试做暂不可用。"
        skeleton={<SkLines rows={2} />}
      >
        {probes.length > 0 && (
          <div className="pa-list">
            {probes.map((p) => (
              <ProbeAnswerCard key={p.probe_question_id} probe={p} />
            ))}
          </div>
        )}
      </Stateful>
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
}: {
  probe: PrepDeskProbeWire;
  onAnswered?: (resolution: ProbeAnswerVerdict['resolution']) => void;
}) {
  const qc = useQueryClient();
  const [answerMd, setAnswerMd] = useState('');
  const [imageRefs, setImageRefs] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<ProbeAnswerVerdict['resolution'] | null>(null);

  // "has any answer" = text OR image (mirrors the route's submit gate).
  const hasAnswer = answerMd.trim().length > 0 || imageRefs.length > 0;

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    // allSettled (not all): a single failed upload must NOT discard the images that
    // already succeeded in the same batch (CodeRabbit review-784).
    const results = await Promise.allSettled(Array.from(files).map((f) => uploadAsset(f)));
    const uploadedIds = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.id] : []));
    if (uploadedIds.length > 0) setImageRefs((refs) => [...refs, ...uploadedIds]);
    if (uploadedIds.length < results.length) setError('部分图片上传失败，请重试');
    setUploading(false);
  }

  async function onSubmit() {
    if (!hasAnswer || submitting) return;
    setSubmitting(true);
    setError(null);
    let resolution: ProbeAnswerVerdict['resolution'] | null = null;
    try {
      const res = await submitProbeAnswer(probe.probe_question_id, answerMd.trim(), imageRefs);
      resolution = res.resolution;
      setVerdict(res.resolution);
      // YUK-707 · [裁决 2] — a recorded verdict re-projects the teaching brief to its
      // outcome state. Invalidate it so a mounted brief advances in place; no-op when the
      // brief isn't on screen. (['prep-desk-probes'] stays on onDismiss, unchanged.)
      void qc.invalidateQueries({ queryKey: ['teaching-brief'] });
    } catch {
      // 422 (judge couldn't grade cleanly) or network — fail-closed: the probe stays
      // served and re-answerable, so surface a retry, not a lost answer.
      setError('这次没判清 —— 换个说法再答一次');
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
    void qc.invalidateQueries({ queryKey: ['prep-desk-probes'] });
  }

  return (
    <LoomCard pad className="pa-card">
      <div className="pa-probe">
        <div className="pa-probe-lbl">
          <LoomIcon name="sparkle" size={13} /> 团队问你的一道题
        </div>
        <div className="pa-probe-md">{probe.prompt_md}</div>
      </div>

      {verdict ? (
        <output className={`pa-verdict pa-verdict-${verdict}`}>
          {verdict === 'retired' ? (
            <span className="pa-verdict-txt">
              <LoomIcon name="check" size={14} /> 答对了 —— 这条猜想排除了。
            </span>
          ) : (
            <span className="pa-verdict-txt">
              <LoomIcon name="target" size={14} /> 这块确实卡了 —— 教研团会据此为你备练。
            </span>
          )}
          <Btn size="sm" variant="ghost" onClick={onDismiss}>
            知道了
          </Btn>
        </output>
      ) : (
        <>
          <textarea
            className="pa-answer"
            value={answerMd}
            onChange={(e) => setAnswerMd(e.target.value)}
            placeholder="写下你的解答（也可以只拍照 / 传图）"
            rows={3}
          />
          {imageRefs.length > 0 && (
            <div className="pa-thumbs">
              {imageRefs.map((id, i) => (
                <ProbeThumb
                  key={id}
                  id={id}
                  onRemove={() => setImageRefs((refs) => refs.filter((_, j) => j !== i))}
                />
              ))}
            </div>
          )}
          <div className="pa-actions">
            <label className="pa-upload">
              {/* Visually hidden but kept in the a11y tree + tab order (NOT `hidden`),
                  so keyboard users can focus it (via the label) and open the picker
                  with Space/Enter (CodeRabbit review-784 a11y). */}
              <input
                type="file"
                accept="image/*"
                multiple
                className="pa-file-input"
                onChange={(e) => {
                  void onFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <LoomIcon name="image" size={14} /> {uploading ? '上传中…' : '传图'}
            </label>
            <Btn
              size="sm"
              variant="primary"
              disabled={!hasAnswer || submitting || uploading}
              onClick={() => void onSubmit()}
            >
              提交作答
            </Btn>
            {error && (
              <span className="pa-error" role="alert">
                {error}
              </span>
            )}
          </div>
        </>
      )}
    </LoomCard>
  );
}

function ProbeThumb({ id, onRemove }: { id: string; onRemove: () => void }) {
  const { url } = useAssetUrl(id);
  return (
    <span className="pa-thumb">
      {url ? <img src={url} alt="作答图" /> : <span className="pa-thumb-sk" />}
      <button type="button" className="pa-thumb-x" onClick={onRemove} aria-label="移除图片">
        <LoomIcon name="close" size={11} />
      </button>
    </span>
  );
}
