// Teaching turns: a check question (prompt + numbered choices) with the 「重做 / 回看前置」 chip, which
// records a teaching event (not a chat turn), and the close-out line when the teaching round ends.

import { DeferredMarkdownRenderer } from '@/ui/lib/deferred-markdown-renderer';
import { ChipButton } from '@/ui-next/primitives/Chip';
import type { ChatMessage } from '../message-projection';

export interface SkillTurnBlockProps {
  message: ChatMessage;
  chipPending: boolean;
  chipAcked: boolean;
  onAcceptCorrective: (sessionId: string, questionId: string, replyEventId?: string) => void;
}

export function SkillTurnBlock({
  message,
  chipPending,
  chipAcked,
  onAcceptCorrective,
}: SkillTurnBlockProps) {
  const turn = message.skill_turn;
  if (turn?.kind === 'end') {
    return <p className="un-cp-skill-end">这轮教学结束了；接着问就回到平常的对话。</p>;
  }
  const question = turn?.kind === 'ask_check' ? turn.structured_question : undefined;
  if (!question) return null;
  const sessionId = message.session_id;
  return (
    <div className="un-cp-card un-cp-skill">
      <p className="un-cp-card-title">检查一下</p>
      <DeferredMarkdownRenderer className="un-cp-md">{question.prompt_md}</DeferredMarkdownRenderer>
      {question.choices_md && question.choices_md.length > 0 ? (
        <ol className="un-cp-skill-choices">
          {question.choices_md.map((choice) => (
            <li key={`${question.id}-${choice}`}>
              <DeferredMarkdownRenderer className="un-cp-md">{choice}</DeferredMarkdownRenderer>
            </li>
          ))}
        </ol>
      ) : null}
      {sessionId ? (
        <div className="un-cp-skill-actions">
          <ChipButton
            tone="accent"
            disabled={chipPending || chipAcked}
            onClick={() => onAcceptCorrective(sessionId, question.id, message.reply_event_id)}
          >
            重做 / 回看前置
          </ChipButton>
          {chipAcked ? <output className="un-cp-quiet">已记下（不算作采纳建议）</output> : null}
        </div>
      ) : null}
    </div>
  );
}
