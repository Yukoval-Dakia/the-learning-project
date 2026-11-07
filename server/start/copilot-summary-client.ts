import { type CopilotClient, httpCopilotClient } from '@/capabilities/copilot/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { startCopilotCancelRunClient } from './copilot-cancel-run-client';
import { startCopilotChatClient } from './copilot-chat-client';
import { startCopilotCheckpointRevertClient } from './copilot-checkpoint-revert-client';
import { getStartEntityCardFunction } from './copilot-entity-card-function';
import {
  dismissStartCopilotNudgeFunction,
  markStartCopilotNudgeOpenedFunction,
} from './copilot-nudge-actions-function';
import { getStartCopilotNudgesFunction } from './copilot-nudges-function';
import { startCopilotCreateSessionClient } from './copilot-session-create-client';
import { startCopilotSessionsClient } from './copilot-sessions-client';
import { getStartCopilotSummaryFunction } from './copilot-summary-function';
import { startCopilotTeachingChipClient } from './copilot-teaching-chip-client';
import { startCopilotTurnsClient } from './copilot-turns-client';

export const startCopilotClient: CopilotClient = {
  ...httpCopilotClient,
  acceptTeachingChip: startCopilotTeachingChipClient,
  sendChat: startCopilotChatClient,
  revertCheckpoint: startCopilotCheckpointRevertClient,
  cancelRun: startCopilotCancelRunClient,
  listTurns: startCopilotTurnsClient,
  getEntityCard: async (kind, id) =>
    JSON.parse(
      await getStartEntityCardFunction({
        fetch: authenticatedStartFetch,
        data: { kind, id },
      }),
    ),
  createSession: startCopilotCreateSessionClient,
  listSessions: startCopilotSessionsClient,
  dismissNudge: async (id) => {
    await dismissStartCopilotNudgeFunction({ fetch: authenticatedStartFetch, data: { id } });
  },
  markNudgeOpened: async (id) => {
    await markStartCopilotNudgeOpenedFunction({ fetch: authenticatedStartFetch, data: { id } });
  },
  getNudges: async () =>
    JSON.parse(await getStartCopilotNudgesFunction({ fetch: authenticatedStartFetch })),
  getSummary: async () =>
    JSON.parse(await getStartCopilotSummaryFunction({ fetch: authenticatedStartFetch })),
};
