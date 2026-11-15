import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { admissionSentence } from '@/ui/lib/admission-words';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Expand } from '@/ui-next/public';
import { PresentationBlocks, parsePresentation } from '../blocks/PresentationBlocks';
import { useLibraryClient } from './library-client';
import { admissionHolding, holdKey, holdWords } from './library-copy';
import { questionKey } from './use-question-writes';

function PublishedContent({ questionId }: { questionId: string }) {
  const { getPublishedQuestionVersion } = useLibraryClient();
  const query = useQuery({
    queryKey: [...questionKey(questionId), 'published-version'],
    queryFn: () => {
      if (!getPublishedQuestionVersion) throw new Error('Published version reader unavailable');
      return getPublishedQuestionVersion(questionId);
    },
    enabled: getPublishedQuestionVersion != null,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (!getPublishedQuestionVersion) {
    return <p className="qd-quiet">当前页面暂不能读取发布版题面。</p>;
  }
  if (query.isPending || query.isFetching) {
    return <SkeletonLines rows={4} label="正在读取当前发布版" />;
  }
  if (query.isError) {
    return <RetryLine message="当前发布版没取到。" onRetry={() => void query.refetch()} />;
  }
  const data = query.data;
  if (!data || data.question_id !== questionId) {
    return <p className="qd-quiet">当前发布版暂不可用。</p>;
  }
  const held = data.serving && !data.serving.servable ? holdWords(holdKey(data.serving)) : null;
  const admission = data.serving && admissionHolding(data.serving);
  const holdMessage = held
    ? admission && data.serving?.admission
      ? admissionSentence(data.serving.admission)
      : `${held.title}。${held.why}`
    : null;
  const presentation =
    data.status === 'available' ? parsePresentation(data.display.presentation) : null;

  return (
    <div className="qd-published-body">
      <p className="qd-quiet">
        这是当前发布的只读题面，可能与以前作答时的版本不同。这里不保存作答。
      </p>
      {data.status !== 'unavailable' && (
        <p className="qd-published-facts">
          <span>第 {data.revision.revision_ordinal} 版</span>
          <time dateTime={data.revision.published_at}>
            发布于 {new Date(data.revision.published_at).toLocaleString('zh-CN')}
          </time>
        </p>
      )}
      {holdMessage && <p className="qd-published-held">{holdMessage}</p>}
      {data.status === 'unavailable' ? (
        <p className="qd-quiet">当前发布版暂不可用。</p>
      ) : data.status === 'no_presentation' || !presentation ? (
        <p className="qd-quiet">当前发布版没有可显示的题面布局，暂时无法展开。</p>
      ) : (
        <PresentationBlocks
          presentation={presentation}
          issued={{
            faces: data.display.faces,
            materials: data.display.materials,
            slots: data.display.response_spec.slots,
          }}
          entries={[]}
          onEntriesChange={() => {}}
          notation={data.notation}
          disabled
        />
      )}
    </div>
  );
}

export function PublishedQuestionVersion({ questionId }: { questionId: string }) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const regionId = useId();

  return (
    <section className="qd-section qd-published" aria-labelledby={headingId}>
      <h2 id={headingId} className="qd-section-title">
        <button
          type="button"
          className="qd-published-toggle ql-text-btn un-hit"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((value) => !value)}
        >
          当前发布版
          <span className="qd-quiet">{open ? '收起' : '展开'}</span>
        </button>
      </h2>
      <Expand open={open} id={regionId}>
        {open && <PublishedContent key={questionId} questionId={questionId} />}
      </Expand>
    </section>
  );
}
