// Answering a question in place. Grading writes nothing to the learner's record: one tap on the
// recommended rating does. Until then the answer and its grading stay on the issuance, so leaving
// and coming back resumes at the same point.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ComponentType, type ReactNode, useCallback, useRef, useState } from 'react';
import type { ResponseSetT } from '@/core/schema/assessment';
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import {
  isSlotResponseAnswered,
  nativeResponseEntry,
  nativeResponseText,
  nativeResponseValue,
} from '@/ui/components/response/response-types';
import { usePagehideTransition } from '@/ui/hooks/usePagehideTransition';
import { useResponseDraftAutosave } from '@/ui/hooks/useResponseDraftAutosave';
import { ApiError } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Button } from '@/ui-next/public';
import { boundSlots, entriesForSubmit } from '../blocks/envelope';
import { PresentationBlocks, parsePresentation } from '../blocks/PresentationBlocks';
import { isSubmitPending } from '../practice-api';
import { VERDICT_OF } from '../use-practice-submit';
import type { FrameProps, QuestionCardClient, QuestionCardRead } from './QuestionCardBlock';

type Question = NonNullable<QuestionCardRead['question']>;
type IssuanceState = Awaited<ReturnType<QuestionCardClient['getIssuanceState']>>;
type Advice = Awaited<ReturnType<QuestionCardClient['getAdvice']>>;
type Graded = Exclude<Advice, { verdict: 'pending' }>;
interface ChatCard {
  session_id: string;
  block_ref: string;
}
interface Shared {
  question: Question;
  chatCard: ChatCard;
  Frame: ComponentType<FrameProps>;
  open: ReactNode;
  face: ReactNode;
  client: QuestionCardClient;
  onAttemptChanged(): void;
}

const RATING_WORDS = { again: '再练', hard: '模糊', good: '会了', easy: '轻松' } as const;
const SOURCE_NOTE = '记入复习，来源是这次对话。';

function Feedback({
  outcome,
  feedbackMd,
  notation,
}: {
  outcome: keyof typeof VERDICT_OF;
  feedbackMd: string;
  notation: string | null;
}) {
  return (
    <>
      <p className="un-cp-block-title">{VERDICT_OF[outcome].label}</p>
      {feedbackMd ? (
        <MathMarkdown className="un-read" notation={notation}>
          {feedbackMd}
        </MathMarkdown>
      ) : null}
    </>
  );
}

export function InlineAnswer({
  attempt,
  ...shared
}: Shared & { attempt: QuestionCardRead['latest_attempt'] }) {
  const { question, chatCard, Frame, face, client } = shared;
  const [startedId, setStartedId] = useState<string | null>(null);
  const [readCount, setReadCount] = useState(0);
  const issuanceId = attempt?.issuance_id ?? startedId;
  const start = useMutation({
    mutationFn: () =>
      client.issueAssessment({
        chat_card: chatCard,
        group_id: question.group_id,
        part_ids: question.part_ids,
        mode: 'auto_score',
      }),
    onSuccess: (issued) => setStartedId(issued.issuance.issuance_id),
  });
  const state = useQuery({
    queryKey: ['question-card-issuance', issuanceId],
    enabled: issuanceId !== null,
    queryFn: () => client.getIssuanceState(issuanceId ?? ''),
    // The answer area starts from this read once. A cached one could be older than the last saved
    // draft, and handing that in would delete the draft, so each entry reads the server again.
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (issuanceId === null) {
    // Trying again would be refused the same way, so the way on is the question itself.
    const refused = start.error instanceof ApiError && start.error.status === 409;
    if (refused) {
      return (
        <Frame note="这道题现在不能在这里作答，可以打开题目做。" actions={shared.open}>
          {face}
        </Frame>
      );
    }
    return (
      <Frame
        note={start.isError ? '这道题现在开始不了，可以再试一次。' : null}
        actions={
          <>
            <Button size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
              {start.isPending ? '正在准备' : '开始作答'}
            </Button>
            {start.isError ? shared.open : null}
          </>
        }
      >
        {face}
      </Frame>
    );
  }
  if (!state.data) {
    return (
      <Frame
        status={state.isError ? undefined : { word: '在取题目', tone: 'waiting' }}
        note={state.isError ? '作答记录没取到。' : null}
        actions={
          state.isError ? (
            <Button size="sm" variant="secondary" onClick={() => void state.refetch()}>
              再试一次
            </Button>
          ) : undefined
        }
      >
        {face}
      </Frame>
    );
  }
  return (
    <AnswerArea
      key={`${issuanceId}:${readCount}`}
      onLoadLatest={async () => {
        const latest = await state.refetch();
        if (!latest.isError && latest.data) setReadCount((count) => count + 1);
      }}
      {...shared}
      issuanceId={issuanceId}
      restored={state.data}
      resumeGraded={attempt?.status === 'graded_unconfirmed'}
      submitted={attempt?.status === 'submitted'}
    />
  );
}

function AnswerArea({
  question,
  Frame,
  open,
  face,
  client,
  onAttemptChanged,
  issuanceId,
  onLoadLatest,
  restored,
  resumeGraded,
  submitted,
}: Shared & {
  issuanceId: string;
  /** Read the server's answer again and start over from it. */
  onLoadLatest(): Promise<void>;
  restored: IssuanceState;
  resumeGraded: boolean;
  submitted: boolean;
}) {
  const notation = question.notation ?? null;
  const accepted = restored.submissions[0];
  const dto = restored.practice_dto;
  const slots = dto?.response_spec.slots ?? [];
  const presentation = parsePresentation(dto?.presentation);
  const [responses, setResponses] = useState<ResponseSetT>(
    () => accepted?.response_set ?? restored.draft?.response_set ?? { entries: [] },
  );
  const [judged, setJudged] = useState<Graded | null>(null);
  const [stillGrading, setStillGrading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notRecorded, setNotRecorded] = useState(false);

  const ackedEpoch = useRef(restored.draft?.save_epoch ?? 0);
  const saveDraft = useCallback(
    async (value: ResponseSetT, ctx: { keepalive: boolean; chained: boolean }) => {
      const acked = ackedEpoch.current;
      const ack = await client.saveResponseDraft(
        issuanceId,
        {
          response_set: value,
          group_evidence: [],
          evaluation_group_ref: accepted?.evaluation_group_id ?? `group_${issuanceId}`,
          expected_save_epoch: ctx.chained ? acked + 1 : acked,
        },
        { keepalive: ctx.keepalive },
      );
      ackedEpoch.current = Math.max(ackedEpoch.current, ack.save_epoch);
    },
    [client, issuanceId, accepted?.evaluation_group_id],
  );
  const autosave = useResponseDraftAutosave({
    save: saveDraft,
    holdOnConflict: true,
    onConflict: () => setConflict(true),
  });
  const { flush } = autosave;
  const flushOnLeave = useCallback(() => flush({ keepalive: true }), [flush]);
  const attachFlush = usePagehideTransition(flushOnLeave, true, flushOnLeave);

  // A handler from an older render must build on the newest answer, not its render's copy.
  const editingFrozen = useRef(false);
  const latest = useRef(responses);
  const edit = (update: (entries: ResponseSetT['entries']) => ResponseSetT['entries']) => {
    if (editingFrozen.current || autosave.isHeld()) return;
    const previous = latest.current;
    const next = { entries: update(previous.entries) };
    latest.current = next;
    setResponses(next);
    autosave.change(next, previous);
  };

  const assessment = () => ({
    issuance_id: issuanceId,
    evaluation_group_id: accepted?.evaluation_group_id ?? `group_${issuanceId}`,
    submission_id: accepted?.submission_id ?? `submission_${issuanceId}`,
    idempotency_key: accepted?.idempotency_key ?? `submit_${issuanceId}`,
    // Once accepted, the stored answer is the one to repeat: any difference is refused as a change.
    response_set:
      accepted?.response_set ??
      (presentation
        ? { entries: entriesForSubmit(presentation, slots, latest.current.entries) }
        : latest.current),
    group_evidence: [],
    expected_save_epoch: ackedEpoch.current,
  });
  const answerMd = responses.entries
    .map((entry) =>
      nativeResponseText(
        entry,
        slots.find((slot) => slot.slot_id === entry.slot_id),
      ),
    )
    .join('\n');
  const holdStaleDraft = (error: unknown) => {
    if (!(error instanceof ApiError) || error.code !== 'stale_draft') return false;
    autosave.hold();
    setConflict(true);
    return true;
  };
  const readAdvice = async () => {
    try {
      return await client.getAdvice(question.id, answerMd, [], assessment());
    } catch (error) {
      holdStaleDraft(error);
      throw error;
    }
  };

  // Coming back to a graded answer reads the same candidate again; nothing is graded twice.
  const resume = useQuery({
    queryKey: ['question-card-advice', issuanceId],
    enabled: resumeGraded && !judged && !confirmed && !conflict,
    queryFn: readAdvice,
    retry: false,
  });
  const grade = useMutation({
    // Leaving during grading must not lose the last edit: it is saved before saving stops, and the
    // fields are locked from the moment this starts.
    mutationFn: async () => {
      editingFrozen.current = true;
      if (!(await flush())) {
        if (autosave.isHeld()) return null;
        throw new Error('the answer was not saved');
      }
      autosave.hold();
      return readAdvice();
    },
    onSuccess: (advice) => {
      if (advice === null) {
        editingFrozen.current = false;
        return;
      }
      if (isSubmitPending(advice)) {
        setStillGrading(true);
        return;
      }
      setStillGrading(false);
      setJudged(advice);
      onAttemptChanged();
    },
    onError: (error) => {
      if (!holdStaleDraft(error)) {
        editingFrozen.current = false;
        autosave.resume();
      }
    },
  });
  const resumed = resume.data && !isSubmitPending(resume.data) ? resume.data : null;
  const graded = judged ?? resumed;
  const confirm = useMutation({
    mutationFn: (current: Graded) => {
      const rating = current.judge.suggested_rating;
      if (!rating) throw new Error('no recommended rating');
      return client.submitReview({
        question_id: question.id,
        assessment: assessment(),
        activation_intent: current.activation_intent,
        rating,
        response_md: answerMd,
        referenced_knowledge_ids: [],
      });
    },
    onSuccess: (result) => {
      onAttemptChanged();
      if (isSubmitPending(result) || ('status' in result && result.status === 'review_required')) {
        setNotRecorded(true);
        return;
      }
      setConfirmed(true);
    },
    onError: (error) => {
      if (holdStaleDraft(error)) return;
      if (!(error instanceof ApiError) || error.status !== 409) return;
      // The question moved on after this answer was started, and no retry can record this result.
      if (error.code === 'stale_admission') {
        setNotRecorded(true);
        return;
      }
      // Someone else moved the result on: read it again so the next tap names the current one.
      grade.mutate();
    },
  });

  const bound = presentation ? boundSlots(presentation) : [];
  const blankable = new Set(
    bound
      .filter((b) => b.response_class === 'blank' || b.response_class === 'select')
      .map((b) => b.slot_id),
  );
  const answered = (slotId: string) =>
    isSlotResponseAnswered(
      nativeResponseValue(responses.entries.find((entry) => entry.slot_id === slotId)),
    );
  const canGrade =
    slots.length > 0 &&
    !conflict &&
    (!presentation || slots.some((slot) => answered(slot.slot_id))) &&
    slots
      // A table only lays out its cells; answers belong to the cell slots.
      .filter((slot) => slot.kind !== 'table')
      .every((slot) => answered(slot.slot_id) || blankable.has(slot.slot_id));
  const finished = submitted || confirmed;
  const locked = finished || !!graded || grade.isPending || !!accepted;

  const fields =
    dto &&
    (presentation ? (
      <PresentationBlocks
        presentation={presentation}
        issued={{ faces: dto.faces, materials: dto.materials, slots }}
        entries={responses.entries}
        notation={notation}
        disabled={locked}
        submitting={grade.isPending}
        submitted={!!accepted}
        onEntriesChange={edit}
        onUploadingChange={() => {}}
        unreceipted={{}}
        onUnreceiptedChange={() => {}}
      />
    ) : (
      <>
        {dto.faces.map((part) => (
          <MathMarkdown key={part.part_id} className="un-read" notation={notation}>
            {part.prompt_md}
          </MathMarkdown>
        ))}
        {slots.map((slot) => {
          const spec = nativeSlotFieldSpec(slot);
          if (!spec) return null;
          const entry = responses.entries.find((item) => item.slot_id === slot.slot_id);
          return (
            <ResponseSlotField
              key={slot.slot_id}
              spec={spec}
              value={nativeResponseValue(entry)}
              notation={notation}
              disabled={locked}
              label={slot.placement?.label}
              hotkeys={false}
              onChange={(value) =>
                edit((entries) => [
                  ...entries.filter((item) => item.slot_id !== slot.slot_id),
                  nativeResponseEntry(
                    slot,
                    value,
                    entries.find((item) => item.slot_id === slot.slot_id),
                  ),
                ])
              }
            />
          );
        })}
      </>
    ));

  if (restored.unavailable_reason && !accepted) {
    return (
      <Frame status={{ word: '现在不能作答', tone: 'caution' }} actions={open}>
        {face}
      </Frame>
    );
  }

  if (finished) {
    const run = restored.settled?.kind === 'terminal' ? restored.settled.run : null;
    const result = graded?.judge ?? run?.result;
    const outcome = result?.coarse_outcome;
    return (
      <Frame status={{ word: '已提交', tone: 'neutral' }} note={SOURCE_NOTE} actions={open}>
        {fields}
        {typeof outcome === 'string' && outcome in VERDICT_OF ? (
          <Feedback
            outcome={outcome as keyof typeof VERDICT_OF}
            feedbackMd={typeof result?.feedback_md === 'string' ? result.feedback_md : ''}
            notation={notation}
          />
        ) : null}
      </Frame>
    );
  }

  if (graded && !conflict) {
    const rating = graded.judge.suggested_rating;
    return (
      <Frame
        status={notRecorded ? undefined : { word: '等你确认', tone: 'neutral' }}
        note={
          notRecorded
            ? '答案保存了，但这次没法自动记下，可以打开题目看看。'
            : confirm.isError
              ? '没记上，可以再点一次。'
              : rating
                ? `确认后${SOURCE_NOTE}`
                : '这次判不了，可以打开题目接着做。'
        }
        actions={
          rating && !notRecorded ? (
            <Button
              size="sm"
              disabled={confirm.isPending || grade.isPending}
              onClick={() => confirm.mutate(graded)}
            >
              {confirm.isPending ? '正在记下' : `记为「${RATING_WORDS[rating]}」`}
            </Button>
          ) : (
            open
          )
        }
      >
        {fields}
        <Feedback
          outcome={graded.judge.coarse_outcome}
          feedbackMd={graded.judge.feedback_md}
          notation={notation}
        />
      </Frame>
    );
  }

  const gradeNote = conflict
    ? '这道题在别处改过了，这里的答案不是最新的。'
    : stillGrading
      ? '还在判，过一会儿再看一次。'
      : grade.isError || resume.isError
        ? '这次没判成，答案还在，可以再试一次。'
        : null;
  return (
    <div ref={attachFlush}>
      <Frame
        note={gradeNote}
        actions={
          conflict ? (
            <Button size="sm" variant="secondary" onClick={() => void onLoadLatest()}>
              用最新的答案
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!canGrade || grade.isPending}
              onClick={() => grade.mutate()}
            >
              {grade.isPending ? '正在判' : stillGrading ? '再看一次' : '提交'}
            </Button>
          )
        }
      >
        {fields}
      </Frame>
    </div>
  );
}
