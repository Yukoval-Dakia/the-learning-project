import { useMemo } from 'react';
import type { NotePageClient } from '@/capabilities/notes/ui-public';
import {
  EntityCardSlotContext,
  type EntityCardSlotProps,
} from '@/ui/components/blocks/entity-card-slot';
import {
  QuestionRefSlotContext,
  type QuestionRefSlotProps,
} from '@/ui/components/blocks/question-ref-slot';
import type { ConfirmationAssessmentRenderer } from '../confirmation';
import type { QuestionCardRenderer } from '../question-card';
import { conversationReady } from './companion-state';
// The scrolling conversation: today's summary on top (open while the conversation is empty), then
// every turn. The scroller keeps the newest line in view while the reader is at the bottom.

import type { CompanionController } from './companion-controller';
import { EntityCard } from './EntityCard';
import { MessageRow } from './MessageRow';
import { QuestionCard } from './ReplyCards';
import { SummaryCard } from './SummaryCard';
import type { StickToBottom } from './stick-to-bottom';
import { useCompanion } from './use-companion';

export interface MessageStreamProps {
  confirmationRenderer?: ConfirmationAssessmentRenderer;
  questionCardRenderer?: QuestionCardRenderer;
  readNotePage: NotePageClient;
  controller: CompanionController;
  stick: StickToBottom;
  navigate: (to: string) => void;
}

export function MessageStream({
  controller,
  stick,
  navigate,
  confirmationRenderer,
  questionCardRenderer,
  readNotePage,
}: MessageStreamProps) {
  const messages = useCompanion(controller, (s) => s.messages);
  const thinkingByRun = useCompanion(controller, (s) => s.thinkingByRun);
  const sessionId = useCompanion(controller, (s) => s.currentSessionId);
  // One stable component per conversation, so a streamed delta never remounts a card on screen.
  const questionSlot = useMemo(() => {
    const Renderer = questionCardRenderer;
    if (!Renderer || !sessionId) return null;
    return function QuestionSlot(props: QuestionRefSlotProps) {
      return (
        <Renderer
          {...props}
          sessionId={sessionId}
          Frame={QuestionCard}
          onAskAnother={() => void controller.sender.send('换一道题吧')}
        />
      );
    };
  }, [questionCardRenderer, sessionId, controller]);
  const entitySlot = useMemo(
    () =>
      function EntitySlot(props: EntityCardSlotProps) {
        return <EntityCard {...props} navigate={navigate} />;
      },
    [navigate],
  );
  const correctionTurnId = useCompanion(controller, (s) => s.correctionTarget?.turnId ?? null);
  const revertPendingId = useCompanion(controller, (s) => s.revertPendingId);
  const retryPendingRunId = useCompanion(controller, (s) => s.retryPendingRunId);
  const sessionBusy = useCompanion(
    controller,
    (s) =>
      s.pendingTurns.some((t) => t.requestBody.session_id === s.currentSessionId) ||
      s.runs.some(
        (r) =>
          r.sessionId === s.currentSessionId && r.phase !== 'completed' && r.phase !== 'failed',
      ),
  );
  const chipPending = useCompanion(controller, (s) => s.chipPending);
  const chipAcked = useCompanion(controller, (s) => s.chipAcked);
  const disabled = useCompanion(
    controller,
    (s) =>
      !conversationReady(s) ||
      s.derivationPolicy !== 'allow' ||
      !!s.correctionTarget ||
      s.pendingTurns.some((t) => t.requestBody.session_id === s.currentSessionId) ||
      s.runs.some(
        (r) =>
          r.sessionId === s.currentSessionId && r.phase !== 'completed' && r.phase !== 'failed',
      ),
  );
  const firstOccurrence = new Map<string, string>();
  const latestSequence = new Map<string, number>();
  for (const m of messages) {
    const o = m.confirmation?.occurrence;
    if (o) {
      if (!firstOccurrence.has(o.occurrence_id)) firstOccurrence.set(o.occurrence_id, m.id);
      latestSequence.set(
        o.occurrence_id,
        Math.max(latestSequence.get(o.occurrence_id) ?? -1, o.sequence),
      );
    }
  }
  const { actions } = controller;
  // A resend answers the latest question only; a nudge line after it doesn't make it older.
  const lastTurn = messages.findLast((m) => !m.nudge_line);
  let replies = 0;
  // A run's user message carries the run id; a settled reply read back from the server may not.
  let currentRunId: string | undefined;
  return (
    <div className="un-cp-scroll" ref={stick.attach}>
      <QuestionRefSlotContext.Provider value={questionSlot}>
        <EntityCardSlotContext.Provider value={entitySlot}>
          <div className="un-cp-stream">
            <SummaryCard empty={messages.length === 0} navigate={navigate} />
            {messages.map((message) => {
              if (message.role === 'ai' && !message.nudge_line) replies += 1;
              if (message.role === 'user') currentRunId = message.id;
              const questionId = message.skill_turn?.structured_question?.id;
              return (
                <MessageRow
                  key={message.id}
                  message={message}
                  thinkingText={
                    message.role === 'ai' && !message.nudge_line
                      ? thinkingByRun[message.run_id ?? currentRunId ?? '']
                      : undefined
                  }
                  confirmationRenderer={confirmationRenderer}
                  readNotePage={readNotePage}
                  showConfirmation={
                    !!message.confirmation &&
                    firstOccurrence.get(message.confirmation.occurrence.occurrence_id) ===
                      message.id
                  }
                  confirmationDisabled={
                    disabled ||
                    (!!message.confirmation &&
                      message.confirmation.occurrence.sequence !==
                        latestSequence.get(message.confirmation.occurrence.occurrence_id))
                  }
                  onConfirmation={(action) =>
                    message.confirmation
                      ? controller.sender.sendConfirmation(message.confirmation.occurrence, action)
                      : Promise.resolve()
                  }
                  onRefreshConfirmation={() =>
                    void controller.runs.refetchTurns().catch(() =>
                      controller.store.setState({
                        refreshFailed: true,
                        error: '确认题记录读取失败，请重试读取。',
                      }),
                    )
                  }
                  turnNumber={message.role === 'ai' ? replies : undefined}
                  correctionSelected={
                    message.reply_event_id !== undefined &&
                    message.reply_event_id === correctionTurnId
                  }
                  revertPending={
                    message.checkpoint_event_id !== undefined &&
                    message.checkpoint_event_id === revertPendingId
                  }
                  chipPending={questionId !== undefined && questionId === chipPending}
                  chipAcked={questionId !== undefined && questionId === chipAcked}
                  navigate={navigate}
                  onSelectCorrection={actions.selectCorrection}
                  onRevert={actions.revert}
                  retry={
                    message === lastTurn && message.retryable && message.run_id
                      ? {
                          pending: retryPendingRunId === message.run_id,
                          disabled: sessionBusy,
                          onRetry: () => {
                            if (message.run_id && message.session_id) {
                              void actions.retryFailedRun(message.run_id, message.session_id);
                            }
                          },
                        }
                      : undefined
                  }
                  onAcceptCorrective={actions.acceptCorrectiveChip}
                />
              );
            })}
          </div>
        </EntityCardSlotContext.Provider>
      </QuestionRefSlotContext.Provider>
    </div>
  );
}
