import type { z } from 'zod';
import { apiJson } from '@/ui/lib/api';
import type {
  EventCorrectionBodySchema,
  EventCorrectionResponseSchema,
} from '../api/event-contracts';
import type { EventDetailResponse } from './event-detail-model';

export type EventCorrectionReceipt = z.infer<typeof EventCorrectionResponseSchema> & {
  status?: 201;
  canonicalLocation?: string;
};
export interface EventDetailClient {
  getEventDetail: (id: string) => Promise<EventDetailResponse>;
  createEventCorrection: (
    id: string,
    input: z.infer<typeof EventCorrectionBodySchema>,
  ) => Promise<EventCorrectionReceipt>;
}

export const httpEventDetailClient: EventDetailClient = {
  getEventDetail: (id) => apiJson(`/api/events/${encodeURIComponent(id)}`),
  createEventCorrection: (id, input) =>
    apiJson(`/api/events/${encodeURIComponent(id)}/corrections`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
