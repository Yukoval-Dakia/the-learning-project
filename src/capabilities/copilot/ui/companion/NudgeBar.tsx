// Proactive prompts (off by default on the server): each a headline with 看看 and ×. 看看 marks it
// opened and makes the headline the companion's opening line; × dismisses that kind for the day.

import { Sparkles, X } from 'lucide-react';
import { openCopilotForNudge } from '@/ui/lib/use-copilot-dwell';
import { ChipButton, IconButton } from '@/ui-next/public';
import type { UseCopilotNudgesResult } from '../useCopilotNudges';

export function NudgeBar({ nudges }: { nudges: UseCopilotNudgesResult }) {
  if (nudges.nudges.length === 0) return null;
  return (
    <ul className="un-cp-nudges">
      {nudges.nudges.map((nudge) => (
        <li key={nudge.id} className="un-cp-nudge">
          <Sparkles size={14} aria-hidden="true" className="un-cp-nudge-icon" />
          <p className="un-cp-nudge-text">{nudge.headline}</p>
          <ChipButton
            tone="accent"
            disabled={nudges.isMutating}
            onClick={() => {
              void nudges.markOpened(nudge.id);
              openCopilotForNudge({
                nudge_event_id: nudge.id,
                session_id: nudge.subject_id,
                headline: nudge.headline,
              });
            }}
          >
            看看
          </ChipButton>
          <IconButton
            label="忽略"
            icon={<X size={14} />}
            disabled={nudges.isMutating}
            onClick={() => void nudges.dismiss(nudge.id)}
          />
        </li>
      ))}
    </ul>
  );
}
