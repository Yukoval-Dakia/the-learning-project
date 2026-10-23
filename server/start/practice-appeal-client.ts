import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartPracticeAppealFunction } from './practice-appeal-function';

export const startPracticeAppealClient: PracticeClient['fileAppeal'] = async (
  judgeEventId,
  reasonMd,
  anchorKind = 'judge',
) =>
  JSON.parse(
    await createStartPracticeAppealFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify(
        anchorKind === 'evaluation'
          ? { evaluation_id: judgeEventId, reason_md: reasonMd }
          : { judge_event_id: judgeEventId, reason_md: reasonMd },
      ),
    }),
  );
