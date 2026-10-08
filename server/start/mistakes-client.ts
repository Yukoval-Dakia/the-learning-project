import type { listMistakes } from '@/capabilities/ingestion/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartMistakes } from './mistakes-function';

export const listStartMistakes: typeof listMistakes = (input) =>
  getStartMistakes({
    data: { limit: String(input.limit), subject: input.subject },
    fetch: authenticatedStartFetch,
  });
