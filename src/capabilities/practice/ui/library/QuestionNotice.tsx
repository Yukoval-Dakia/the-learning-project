import { useQuery } from '@tanstack/react-query';
import { CircleDashed, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { admissionSentence } from '@/ui/lib/admission-words';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { showToast } from '@/ui-next/feedback/toast-store';
import { Button, Expand } from '@/ui-next/public';
import { type QuestionFullDetail, isDeleted, isDraft } from './library-api';
import { useLibraryClient } from './library-client';
import {
  ADMISSION_WORDS,
  VERIFY_WORDS,
  admissionHolding,
  holdKey,
  holdWords,
  verifyOutcomeWords,
} from './library-copy';
import { ServingButton } from './ServingButton';
import { LIBRARY_KEY } from './use-library';
import { useForceEnable, useRestore, useVerifyDraft, writeErrorText } from './use-question-writes';

const MIN_REASON = 2;

function DraftNotice({
  id,
  admission,
}: {
  id: string;
  /** Shown as a fact only. An old draft is still verified by hand whatever this says. */
  admission: QuestionFullDetail['serving']['admission'];
}) {
  const { getDraftDetail } = useLibraryClient();
  const check = useQuery({
    queryKey: [LIBRARY_KEY, 'draft-check', id],
    queryFn: () => getDraftDetail(id),
    retry: false,
  });
  const verify = useVerifyDraft();
  const force = useForceEnable();
  const [forcing, setForcing] = useState(false);
  const [reason, setReason] = useState('');
  const words = check.data ? VERIFY_WORDS[check.data.verify_status] : null;
  const busy = verify.isPending || force.isPending;

  const runVerify = () =>
    verify.mutate(id, {
      onSuccess: (r) =>
        showToast({
          message: r.promoted ? '核验通过，已开始出给你' : verifyOutcomeWords(r.status),
        }),
      onError: (err) => showToast({ message: writeErrorText(err) }),
    });
  const runForce = () =>
    force.mutate(
      { id, reason: reason.trim() },
      {
        onSuccess: (r) =>
          showToast({
            message: r.promoted
              ? '已启用。没有核验，这次的理由记下了。'
              : verifyOutcomeWords(r.status),
          }),
        onError: (err) => showToast({ message: writeErrorText(err) }),
      },
    );

  return (
    <section className="qd-notice" data-tone="accent" aria-label="待审核">
      <p className="qd-notice-title">
        <CircleDashed size={15} aria-hidden="true" />
        这道题还没启用
      </p>
      <p className="qd-notice-text">
        {words ? `${words.word}。` : ''}
        {check.data?.verify_reason
          ? '核验写下的原因：'
          : '核验会检查题目和答案，通过后就开始出给你，可能要等一会儿。'}
      </p>
      {check.data?.verify_reason ? (
        <MathMarkdown className="qd-notice-reason" notation={check.data.notation}>
          {check.data.verify_reason}
        </MathMarkdown>
      ) : null}
      {admission && admission.status !== 'admitted' ? (
        <p className="qd-notice-text">
          {[`自动检查：${ADMISSION_WORDS[admission.status].title}`, admission.reason]
            .filter(Boolean)
            .join('。')}
        </p>
      ) : null}
      <div className="qd-notice-actions">
        <Button size="sm" variant="primary" disabled={busy} onClick={runVerify}>
          {verify.isPending ? '正在核验…' : '核验并启用'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={forcing}
          aria-controls="qd-force"
          onClick={() => setForcing((open) => !open)}
        >
          不核验，直接启用…
        </Button>
      </div>
      <Expand open={forcing} id="qd-force">
        <div className="qd-force">
          <label className="qd-field">
            <span className="qd-field-label">为什么不用核验（会记下来）</span>
            <input
              className="qd-input"
              value={reason}
              placeholder="比如：我核对过答案"
              onChange={(e) => setReason(e.currentTarget.value)}
            />
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || reason.trim().length < MIN_REASON}
            onClick={runForce}
          >
            直接启用
          </Button>
        </div>
      </Expand>
    </section>
  );
}

function DeletedNotice({ id }: { id: string }) {
  const restore = useRestore(id);
  return (
    <section className="qd-notice" data-tone="critical" aria-label="已删除">
      <p className="qd-notice-title">
        <Trash2 size={15} aria-hidden="true" />
        这道题已删除
      </p>
      <p className="qd-notice-text">它不会再出给你。作答和错题记录都还在；恢复后回到待审核。</p>
      <div className="qd-notice-actions">
        <Button
          size="sm"
          variant="primary"
          disabled={restore.isPending}
          onClick={() => restore.mutate()}
        >
          {restore.isPending ? '正在恢复…' : '恢复这道题'}
        </Button>
      </div>
    </section>
  );
}

/** The automatic check owns this question: say where it stands, with nothing to verify by hand. */
function AdmissionNotice({
  admission,
  serving,
}: {
  admission: NonNullable<ReturnType<typeof admissionHolding>>;
  serving: QuestionFullDetail['serving'];
}) {
  const words = ADMISSION_WORDS[admission.status];
  const Icon = admission.status === 'pending' ? CircleDashed : TriangleAlert;
  return (
    <section
      className="qd-notice"
      data-tone={admission.status === 'pending' ? 'accent' : 'caution'}
      aria-label={words.title}
    >
      <p className="qd-notice-title">
        <Icon size={15} aria-hidden="true" />
        {words.title}
      </p>
      <p className="qd-notice-text">
        {serving.admission?.wait || serving.admission?.cause
          ? admissionSentence(serving.admission)
          : (admission.reason ?? words.why)}
      </p>
      {serving.next_action ? (
        <div className="qd-notice-actions">
          <ServingButton serving={serving} variant="primary" />
        </div>
      ) : null}
    </section>
  );
}

/** The one thing this question needs from you, if anything. */
export function QuestionNotice({ detail }: { detail: QuestionFullDetail }) {
  if (isDeleted(detail)) return <DeletedNotice id={detail.id} />;
  if (isDraft(detail) && !detail.admission_owned) {
    return <DraftNotice id={detail.id} admission={detail.serving.admission} />;
  }
  const admission = admissionHolding(detail.serving);
  if (admission) return <AdmissionNotice admission={admission} serving={detail.serving} />;
  if (detail.serving.servable) return null;
  const words = holdWords(holdKey(detail.serving));
  // An undecided check says why (unknown result, or a purpose that bars checking) and, while it
  // waits, when it tries again.
  const checkWords =
    detail.serving.admission && detail.serving.admission.status !== 'admitted'
      ? admissionSentence(detail.serving.admission)
      : null;
  return (
    <section className="qd-notice" data-tone="caution" aria-label="暂不出题">
      <p className="qd-notice-title">
        <TriangleAlert size={15} aria-hidden="true" />
        暂不出题 · {words.title}
      </p>
      <p className="qd-notice-text">{checkWords ?? words.why}</p>
      <div className="qd-notice-actions">
        <ServingButton serving={detail.serving} variant="primary" />
      </div>
    </section>
  );
}
