// A question the companion placed in a reply. It reads the question's own state; while that says
// checking it reads again, and a question that is not ready never offers answering.
import { useQuery } from '@tanstack/react-query';
import type { ComponentType, ReactNode } from 'react';
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import type { ApiOperationJsonResponse } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Button } from '@/ui-next/public';
import { holdWords } from '../library/library-copy';
import {
  getAdvice,
  getIssuanceState,
  getQuestionCard,
  issueAssessment,
  saveResponseDraft,
  submitReview,
} from '../practice-api';
import type { PracticeClient } from '../practice-client';
import { InlineAnswer } from './InlineAnswer';

const CHECK_AGAIN_MS = 3000;

export type QuestionCardRead = ApiOperationJsonResponse<'getQuestionCard'>;

export type QuestionCardClient = Pick<
  PracticeClient,
  'issueAssessment' | 'getIssuanceState' | 'saveResponseDraft' | 'getAdvice' | 'submitReview'
> & {
  getQuestionCard: (id: string, sessionId: string) => Promise<QuestionCardRead>;
};

const httpClient: QuestionCardClient = {
  getQuestionCard,
  issueAssessment,
  getIssuanceState,
  saveResponseDraft,
  getAdvice,
  submitReview,
};

export interface FrameProps {
  gone?: string;
  status?: { word: string; tone: 'waiting' | 'caution' | 'neutral' };
  note?: string | null;
  actions?: ReactNode;
  children?: ReactNode;
}

export interface QuestionCardBlockProps {
  questionId: string;
  label: string;
  sessionId: string;
  Frame: ComponentType<FrameProps>;
  onAskAnother(): void;
  client?: QuestionCardClient;
}

function QuestionFace({ question }: { question: NonNullable<QuestionCardRead['question']> }) {
  const slots = question.display_response_spec?.slots ?? [];
  return (
    <>
      <MathMarkdown className="un-read" notation={question.notation ?? null}>
        {question.prompt_md}
      </MathMarkdown>
      {slots.length > 0
        ? slots.map((slot) => {
            const spec = nativeSlotFieldSpec(slot);
            return spec ? (
              <ResponseSlotField
                key={slot.slot_id}
                spec={spec}
                value={undefined}
                notation={question.notation ?? null}
                disabled
                hotkeys={false}
                onChange={() => {}}
              />
            ) : null;
          })
        : question.choices_md?.map((choice) => (
            <MathMarkdown key={choice} className="un-read" notation={question.notation ?? null}>
              {choice}
            </MathMarkdown>
          ))}
    </>
  );
}

export function QuestionCardBlock({
  questionId,
  label,
  sessionId,
  Frame,
  onAskAnother,
  client = httpClient,
}: QuestionCardBlockProps) {
  const read = useQuery({
    queryKey: ['question-card', questionId, sessionId],
    queryFn: () => client.getQuestionCard(questionId, sessionId),
    refetchInterval: (query) => (query.state.data?.state === 'checking' ? CHECK_AGAIN_MS : false),
  });
  const card = read.data;
  if (!card) {
    if (read.isError) {
      return (
        <Frame
          note="这道题没取到。"
          actions={
            <Button size="sm" variant="secondary" onClick={() => void read.refetch()}>
              再试一次
            </Button>
          }
        />
      );
    }
    return <Frame status={{ word: '在取题目', tone: 'waiting' }} />;
  }
  if (card.state === 'withdrawn') return <Frame gone="这道题已经撤下了。" />;
  const question = card.question;
  if (!question) return <Frame gone="这道题现在打不开。" />;
  const open = (
    <a className="un-cp-block-open" href={`/questions/${encodeURIComponent(question.id)}`}>
      {label}
    </a>
  );
  const reason = card.serving?.admission?.reason ?? null;
  const face = <QuestionFace question={question} />;
  switch (card.state) {
    case 'checking':
      return (
        <Frame status={{ word: '还在检查', tone: 'waiting' }} note="检查完就能在这里作答。">
          {face}
        </Frame>
      );
    case 'failed':
      return (
        <Frame
          status={{ word: '检查没通过', tone: 'caution' }}
          note={reason}
          actions={
            <Button size="sm" variant="secondary" onClick={onAskAnother}>
              换一道
            </Button>
          }
        >
          {face}
        </Frame>
      );
    case 'unavailable': {
      // Held for a reason of its own: the question still reads, with nothing to wait for.
      const words = holdWords(card.serving?.hold_reason ?? null);
      return (
        <Frame status={{ word: words.title, tone: 'caution' }} note={words.why} actions={open}>
          {face}
        </Frame>
      );
    }
    case 'undecided':
      return (
        <Frame status={{ word: '这次没查出结果', tone: 'caution' }} note={reason}>
          {face}
        </Frame>
      );
    default:
      if (!question.inline_supported || !card.inline_block_ref) {
        return <Frame actions={open}>{face}</Frame>;
      }
      return (
        <InlineAnswer
          key={card.inline_block_ref}
          question={question}
          attempt={card.latest_attempt}
          chatCard={{ session_id: sessionId, block_ref: card.inline_block_ref }}
          Frame={Frame}
          open={open}
          face={face}
          client={client}
          onAttemptChanged={() => void read.refetch()}
        />
      );
  }
}
