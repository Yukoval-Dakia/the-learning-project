import type { CopilotClient } from '@/capabilities/copilot/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { sendStartCopilotChatFunction } from './copilot-chat-function';

// The function returns only after the 202 acceptance; the Response rebuilds the HTTP shape
// (status + Location + body) so the companion's acceptance reader is unchanged.
export const startCopilotChatClient: CopilotClient['sendChat'] = async (body, idempotencyKey) => {
  const { location, ...accepted }: { location: string; [field: string]: unknown } = JSON.parse(
    await sendStartCopilotChatFunction({
      fetch: authenticatedStartFetch,
      headers: { 'Idempotency-Key': idempotencyKey },
      data: JSON.stringify(body),
    }),
  );
  return new Response(JSON.stringify(accepted), {
    status: 202,
    headers: { Location: location, 'Content-Type': 'application/json' },
  });
};
