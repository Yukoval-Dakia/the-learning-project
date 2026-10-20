// Where the learner writes. Quick prompts follow what they are looking at; 「将更正第 N 轮」 shows a
// chosen correction target (× drops it); Enter sends, Shift+Enter breaks the line, and Enter while
// an input method is composing never sends. Sending stays open while a reply is generating: later
// messages queue in the same conversation. 本轮用途 picks 日常学习 or 仅用于本次回答.

import { ArrowUp, X } from 'lucide-react';
import { DerivationPolicy } from '@/core/schema/derivation-policy';
import { useCompanionFocus } from '@/ui/lib/use-copilot-dwell';
import { ChipButton, IconButton, Segmented } from '@/ui-next/public';
import type { CompanionController } from './companion-controller';
import { conversationReady, policySupport } from './companion-state';
import { focusChips } from './focus-chips';
import type { StickToBottom } from './stick-to-bottom';
import { useCompanion } from './use-companion';

const POLICY_NOTES = {
  checking: '正在确认现在能不能用「仅用于本次回答」，内容会保留。',
  unsupported: '现在用不了「仅用于本次回答」，或者暂时确认不了。选了它的消息不会发出，内容会保留。',
  supported:
    '对话和必要的运行记录仍会保存。这一轮不进入长期记忆、学情判断和后续安排，也不会带到下一轮；可以读已有的学习资料来回答，但不会新建练习、笔记或计划。',
} as const;

export function Composer({
  controller,
  stick,
}: {
  controller: CompanionController;
  stick: StickToBottom;
}) {
  const ready = useCompanion(controller, conversationReady);
  const draft = useCompanion(controller, (s) => s.draft);
  const policy = useCompanion(controller, (s) => s.derivationPolicy);
  const support = useCompanion(controller, policySupport);
  const correction = useCompanion(controller, (s) => s.correctionTarget);
  const skillKnowledgeId = useCompanion(controller, (s) => s.skillKnowledgeId);
  const focus = useCompanionFocus();
  const { sender, actions } = controller;
  const chips = focusChips(focus, skillKnowledgeId);
  const blockedByCheck = policy === 'answer_only' && support === 'checking';

  const submit = (text: string) => {
    if (!text.trim()) return;
    stick.stick();
    void sender.send(text);
  };

  return (
    <div className="un-cp-composer">
      <div className="un-cp-chips">
        {correction ? (
          <ChipButton tone="accent" aria-label="取消更正" onClick={actions.clearCorrection}>
            将更正第 <span className="un-num">{correction.turnNumber}</span> 轮
            <X size={12} aria-hidden="true" />
          </ChipButton>
        ) : null}
        {chips.map((chip) => (
          <ChipButton
            key={chip.label}
            disabled={!ready}
            onClick={() => {
              stick.stick();
              if (chip.quiz) sender.sendQuiz(chip.text, chip.quiz.knowledgeId);
              else void sender.send(chip.text);
            }}
          >
            {chip.label}
          </ChipButton>
        ))}
      </div>
      <div className="un-cp-input" data-disabled={ready ? undefined : ''}>
        <textarea
          className="un-cp-textarea"
          rows={2}
          value={draft}
          placeholder={ready ? '问学习伙伴…' : '对话准备好后就能输入'}
          aria-label="给学习伙伴的消息"
          // The landing point of a quote flown in from a page (practice 「引用到学习伙伴」).
          data-companion-composer=""
          disabled={!ready}
          onChange={(event) => actions.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!blockedByCheck) submit(draft);
            }
          }}
        />
        <IconButton
          label="发送"
          className="un-cp-send"
          icon={<ArrowUp size={16} />}
          disabled={!ready || draft.trim().length === 0 || blockedByCheck}
          onClick={() => submit(draft)}
        />
      </div>
      <div className="un-cp-policy">
        <Segmented
          label="本轮用途"
          value={policy}
          options={[
            { value: 'allow', label: '日常学习' },
            {
              value: 'answer_only',
              label: support === 'unsupported' ? '仅用于本次回答（暂不可用）' : '仅用于本次回答',
            },
          ]}
          onChange={(value) => actions.setPolicy(DerivationPolicy.parse(value))}
        />
        <span className="un-cp-policy-hint">Enter 发送 · Shift+Enter 换行</span>
      </div>
      {policy === 'answer_only' ? (
        <p className="un-cp-policy-note" role="status">
          {POLICY_NOTES[support]}
        </p>
      ) : null}
    </div>
  );
}
