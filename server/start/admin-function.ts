import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type {
  AdminCostQuery,
  AdminFailuresQuery,
  AdminRunsQuery,
} from '@/capabilities/observability/ui/admin-client';
import type { Db, Tx } from '@/db/client';
import type { createStartAdminReader } from './admin-adapters';
import type { FrontdoorAdapters, FrontdoorContext } from './context';
import { runAuthenticatedStartWorkbench } from './workbench-read';

type AdminStartContext = Pick<FrontdoorContext, 'api'> & {
  adapters: Pick<FrontdoorAdapters, 'admin'>;
};

// Do not create the reader, import domain operations or acquire the DB before auth.
export function runAuthenticatedStartAdmin<T>(
  context: AdminStartContext,
  request: Request,
  operation: (reader: Awaited<ReturnType<typeof createStartAdminReader>>) => Promise<T>,
  options?: { database?: Db | Tx; now?: Date },
): Promise<T> {
  return runAuthenticatedStartWorkbench(context, request, async () => {
    const { createStartAdminReader } = await context.adapters.admin();
    return operation(await createStartAdminReader(options));
  });
}

// Runtime validation belongs after the auth/epoch gate, never in a client validator.
export const getStartAdminRuns = createServerFn({ method: 'GET' })
  .validator((input: AdminRunsQuery) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdmin(context, getRequest(), (reader) => reader.getRuns(data)),
  );
export const getStartAdminRunDetail = createServerFn({ method: 'GET' })
  .validator((input: { id: string }) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdmin(context, getRequest(), (reader) => reader.getRunDetail(data)),
  );
export const getStartAdminCost = createServerFn({ method: 'GET' })
  .validator((input: AdminCostQuery) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdmin(context, getRequest(), (reader) => reader.getCost(data)),
  );
export const getStartAdminFailures = createServerFn({ method: 'GET' })
  .validator((input: AdminFailuresQuery) => input)
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
