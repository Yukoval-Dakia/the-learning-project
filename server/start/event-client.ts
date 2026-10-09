import { z } from 'zod';
import {
  EventCorrectionResponseSchema,
  type EventDetailClient,
  EventDetailResponseSchema,
} from '@/capabilities/observability/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartEventDetail, postStartEventCorrection } from './event-function';

const transport = { fetch: authenticatedStartFetch };
const Receipt = EventCorrectionResponseSchema.extend({
  status: z.literal(201),
  canonicalLocation: z.string(),
});
export const startEventDetailClient: EventDetailClient = {
  getEventDetail: async (id) =>
    EventDetailResponseSchema.parse(
      JSON.parse(await getStartEventDetail({ ...transport, data: { id } })),
    ),
  createEventCorrection: async (id, input) =>
    Receipt.parse(await postStartEventCorrection({ ...transport, data: { id, input } })),
};
