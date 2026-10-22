import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { showToast } from '@/ui-next/feedback/toast-store';
import { Button, Expand } from '@/ui-next/public';
import { getDraftDetail } from '../practice-api';
import { type QuestionFullDetail, isDeleted, isDraft } from './library-api';
import { VERIFY_WORDS, holdWords, verifyReasonWords } from './library-copy';
import { ServingButton } from './ServingButton';
import { LIBRARY_KEY } from './use-library';
import { useForceEnable, useRestore, useVerifyDraft, writeErrorText } from './use-question-writes';

const MIN_REASON = 2;

function DraftNotice({ id }: { id: string }) {
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
          message: r.promoted ? '核验通过，已开始出给你' : `没通过：${verifyReasonWords(r.reason)}`,
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
              : `没能启用：${verifyReasonWords(r.reason)}`,
          }),
        onError: (err) => showToast({ message: writeErrorText(err) }),
      },
    );

  return (
    <section className="qd-notice" data-tone="accent" aria-label="待审核">
      <p className="qd-notice-title">这道题还没启用</p>
      <p className="qd-notice-text">
        {words ? `${words.word}。` : ''}
        {check.data?.verify_reason
          ? `上次没通过的原因：${verifyReasonWords(check.data.verify_reason)}`
          : '核验会检查题目和答案，通过后就开始出给你，可能要等一会儿。'}
      </p>
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
      <p className="qd-notice-title">这道题已删除</p>
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

/** The one thing this question needs from you, if anything. */
export function QuestionNotice({ detail }: { detail: QuestionFullDetail }) {
  if (isDeleted(detail)) return <DeletedNotice id={detail.id} />;
  if (isDraft(detail)) return <DraftNotice id={detail.id} />;
  if (detail.serving.servable) return null;
  const words = holdWords(detail.serving.hold_reason);
  return (
    <section className="qd-notice" data-tone="caution" aria-label="暂不出题">
      <p className="qd-notice-title">暂不出题 · {words.title}</p>
      <p className="qd-notice-text">{words.why}</p>
      <div className="qd-notice-actions">
        <ServingButton serving={detail.serving} variant="primary" />
      </div>
    </section>
  );
}
