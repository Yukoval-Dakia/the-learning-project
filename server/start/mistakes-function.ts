import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { MistakeListQuery } from '@/capabilities/ingestion/public';
import { readAuthenticatedStartMistakes } from './mistakes-read';

export const getStartMistakes = createServerFn({ method: 'GET' })
  // The shared operation owns query validation, normalization and cursor policy.
  .inputValidator((input: MistakeListQuery) => input)
  .handler(({ data, context }) => readAuthenticatedStartMistakes(context, getRequest(), data));
