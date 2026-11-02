import type { WorkbenchClient } from '@/capabilities/shell/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { answerStartConjectureProbeFunction } from './probe-answer-function';

export const startProbeAnswerClient: WorkbenchClient['submitProbeAnswer'] = async (
  probeId,
  answerMd,
  answerImageRefs,
) =>
  JSON.parse(
    await answerStartConjectureProbeFunction({
      fetch: authenticatedStartFetch,
      data: {
        probeId,
        body: JSON.stringify({ answer_md: answerMd, answer_image_refs: answerImageRefs }),
      },
    }),
  );
