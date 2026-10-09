import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import {
  runAuthenticatedStartEventCorrection,
  runAuthenticatedStartEventDetail,
} from './event-read';

// Identity leaves unknown input parsing after token and active epoch authorization.
// JSON protects arbitrary payload/passthrough keys from Seroval object reconstruction.
export const getStartEventDetail = createServerFn({ method: 'GET' })
  .inputValidator((input: unknown) => input)
  .handler(async ({ context, data }) =>
    JSON.stringify(await runAuthenticatedStartEventDetail(context, getRequest(), data)),
  );

export const postStartEventCorrection = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartEventCorrection(context, getRequest(), data),
  );
