import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type {
  AdminCostQuery,
  AdminFailuresQuery,
  AdminRunsQuery,
} from '@/capabilities/observability/ui/admin-client';
import { runAuthenticatedStartAdmin } from './admin-read';

// Runtime validation belongs after the auth/epoch gate, never in a client validator.
export const getStartAdminRuns = createServerFn({ method: 'GET' })
  .inputValidator((input: AdminRunsQuery) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdmin(context, getRequest(), (reader) => reader.getRuns(data)),
  );
export const getStartAdminRunDetail = createServerFn({ method: 'GET' })
  .inputValidator((input: { id: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdmin(context, getRequest(), (reader) => reader.getRunDetail(data)),
  );
export const getStartAdminCost = createServerFn({ method: 'GET' })
  .inputValidator((input: AdminCostQuery) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdmin(context, getRequest(), (reader) => reader.getCost(data)),
  );
export const getStartAdminFailures = createServerFn({ method: 'GET' })
  .inputValidator((input: AdminFailuresQuery) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdmin(context, getRequest(), (reader) => reader.getFailures(data)),
  );
export const getStartAdminCoverage = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartAdmin(context, getRequest(), (reader) => reader.getCoverage()),
);
export const getStartAdminConjectureScores = createServerFn({ method: 'GET' }).handler(
  ({ context }) =>
    runAuthenticatedStartAdmin(context, getRequest(), (reader) => reader.getConjectureScores()),
);
