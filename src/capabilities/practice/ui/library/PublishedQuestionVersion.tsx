// YUK-1848 — the frozen published face is the bank's main question read.
// QuestionPaper mounts this as its primary surface; the live flat row only
// renders for the explicit legacy/no-publication states. Data is the frozen
// PR2986 DTO (display.faces/materials/response_spec/presentation only — no
// private answer or editing provenance); rendering reuses PresentationBlocks,
// no new renderer. The collapsed 「当前发布版」 section stays as secondary
// history when a live face is showing.

import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { CurrentPublishedQuestionVersion } from '@/kernel/read-models/question-card';
import { admissionSentence } from '@/ui/lib/admission-words';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Expand } from '@/ui-next/public';
import { PresentationBlocks, parsePresentation } from '../blocks/PresentationBlocks';
import { useLibraryClient } from './library-client';
import { admissionHolding, holdKey, holdWords } from './library-copy';
import { questionKey } from './use-question-writes';

export type PublishedQuestionFace =
  | { kind: 'loading' }
  | { kind: 'error'; refetch: () => void }
  | { kind: 'unavailable'; message: string }
  | { kind: 'available'; data: CurrentPublishedQuestionVersion & { status: 'available' } };

/**
 * Reads the frozen public face once. Available/unavailable are distinct; an
 * unavailable kind carries its own honest message and never fabricates a face.
 */
export function usePublishedQuestionFace(questionId: string): PublishedQuestionFace {
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
    return { kind: 'unavailable', message: '当前页面暂不能读取发布版题面。' };
  }
  if (query.isPending || query.isFetching) return { kind: 'loading' };
  if (query.isError) {
    return { kind: 'error', refetch: () => void query.refetch() };
  }
  const data = query.data;
  if (!data || data.question_id !== questionId || data.status !== 'available') {
    const message =
      data?.status === 'no_presentation'
        ? '当前发布版没有可显示的题面布局。'
        : '当前发布版暂不可用。';
    return { kind: 'unavailable', message };
  }
  return { kind: 'available', data };
}

/** The published face body shared by the primary paper view and the folded section. */
function PublishedFaceBody({
  data,
}: {
  data: CurrentPublishedQuestionVersion & { status: 'available' };
}) {
  const held = data.serving && !data.serving.servable ? holdWords(holdKey(data.serving)) : null;
  const admission = data.serving && admissionHolding(data.serving);
  const holdMessage = held
    ? admission && data.serving?.admission
      ? admissionSentence(data.serving.admission)
      : `${held.title}。${held.why}`
    : null;
  const presentation = parsePresentation(data.display.presentation);

  return (
    <div className="qd-published-body">
      <p className="qd-published-facts">
        <span>第 {data.revision.revision_ordinal} 版</span>
        <time dateTime={data.revision.published_at}>
          发布于 {new Date(data.revision.published_at).toLocaleString('zh-CN')}
        </time>
      </p>
      {holdMessage && <p className="qd-published-held">{holdMessage}</p>}
      {!presentation ? (
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

/** The primary read surface: published face inside the paper frame, or one honest line. */
export function PublishedQuestionFace({
  face,
  onEdit,
}: {
  face: PublishedQuestionFace;
  onEdit?: () => void;
}) {
  if (face.kind === 'loading') return <SkeletonLines rows={4} label="正在读取当前发布版" />;
  if (face.kind === 'error') {
    return <RetryLine message="当前发布版没取到。" onRetry={face.refetch} />;
  }
  if (face.kind === 'unavailable') return <p className="qd-quiet">{face.message}</p>;
  return (
    <>
      <PublishedFaceBody data={face.data} />
      {onEdit && (
        <p className="qd-quiet">
          这是当前发布的只读题面，可能与以前作答时的版本不同。
          <button type="button" className="ql-text-btn un-hit" onClick={onEdit}>
            修改
          </button>
        </p>
      )}
    </>
  );
}

/** Secondary history: the published face folded open on demand (legacy surface shown above). */
function PublishedQuestionVersionBody({ questionId }: { questionId: string }) {
  const face = usePublishedQuestionFace(questionId);
  return (
    <>
      <p className="qd-quiet">
        这是当前发布的只读题面，可能与以前作答时的版本不同。这里不保存作答。
      </p>
      <PublishedQuestionFace face={face} />
    </>
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
        {open && <PublishedQuestionVersionBody key={questionId} questionId={questionId} />}
      </Expand>
    </section>
  );
}
