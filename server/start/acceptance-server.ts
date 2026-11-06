// Parent-owned, loopback-only Start acceptance entry. Run only after obtaining
// the runtime lock and explicitly supplying an isolated acceptance DB/token.
// Does not load .env, start workers/listeners for events, recover jobs, or call AI.
import { serve } from '@hono/node-server';
import { capabilities } from '@/capabilities';
import { assertProposalKindsOwned } from '@/kernel/manifest';
import { installSettlementCascadeRevert } from '@/kernel/settlement-cascade-revert';
import { getServerEnv, requireApiInternalToken, resolveApiPort } from '@/server/config/env';
import { orchestrateCascadeRevert } from '@/server/revert/cascade-revert';
import { buildHonoApp } from '../app';
import { assertComposedRoutesDeclared } from '../composed-routes';
import { createFrontdoor } from '../frontdoor';

const env = getServerEnv();
requireApiInternalToken(env);
const port = resolveApiPort(env.API_PORT);
const { installPracticeHost } = await import('@/capabilities/practice/public');
await installPracticeHost();
const { installAgencyHostOperations } = await import('@/capabilities/agency/public');
await installAgencyHostOperations();
installSettlementCascadeRevert(orchestrateCascadeRevert);
const [{ buildAdminConfigRuntimeFacts }, { setAdminConfigRuntimeFacts }] = await Promise.all([
  import('@/server/config/admin-config-facts'),
  import('@/capabilities/observability/public'),
]);
setAdminConfigRuntimeFacts(buildAdminConfigRuntimeFacts);
assertComposedRoutesDeclared(capabilities);
assertProposalKindsOwned(capabilities);
const fetch = await createFrontdoor(buildHonoApp(capabilities));
const server = serve({ fetch, hostname: '127.0.0.1', port });

async function stop() {
  server.close();
  if ('closeAllConnections' in server) server.closeAllConnections();
  const { db } = await import('@/db/client');
  await db.$client.end({ timeout: 3 });
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
